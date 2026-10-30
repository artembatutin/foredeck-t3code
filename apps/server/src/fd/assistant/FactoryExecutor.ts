import { type ProjectId, type ProviderInteractionMode, type RuntimeMode } from "@t3tools/contracts";
import { workItemRefString } from "@t3tools/contracts/fd/work-management";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as HandoffAdmission from "./HandoffAdmission.ts";
import * as HandoffBackend from "./handoffBackend.ts";
import * as Portfolio from "./portfolio.ts";
import * as PortfolioStore from "./PortfolioStore.ts";
import * as WorkCaptureStore from "./WorkCaptureStore.ts";

/** Refused with the text the owner reads; nothing was written unless the text says otherwise. */
export class FactoryExecutorRefusal extends Schema.TaggedError<FactoryExecutorRefusal>()(
  "FactoryExecutorRefusal",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const refusal = (reason: string) => new FactoryExecutorRefusal({ reason });

/** A root's refusal, as a notice's "because <reason>" and a refused control's text say it. */
const REFUSED_BECAUSE: Readonly<Record<HandoffAdmission.BlockedReason, string>> = {
  revoked: "its authorization, capture, manager or project changed",
  scope_changed: "its Work item changed after it was captured",
  unreadable: "its Work item could not be read",
  item_closed: "its Work item is done or cancelled",
};

const NOT_CONFIGURED = "the project has no Factory verify command";

const NEVER_STARTED_STOP = "Not started; cancel removes it from the queue";
const PENDING_RESUME_STOP =
  "Waiting for a project assistant slot to resume; nothing runs until then. Cancel ends it.";
const RESUME_KEEPS_ID = "Resume keeps this assignment's delivery; a retry would replace it.";

/** The note a queued orphan's cancel leaves when its authority no longer holds (D4). */
const orphanNotice = (root: string, because: string) =>
  `Factory delivery ${root} was cancelled before it started because ${because}. Authorize the brief again and retry the assignment for a new delivery.`;

/** The states with something of a root to look after; the rest wait for a control. */
const RECONCILED: ReadonlySet<Portfolio.AssignmentState> = new Set([
  "queued",
  "launching",
  "launch-uncertain",
  "running",
  "needs-input",
  "stopping",
  "stopped",
]);

const isEnded = (status: HandoffBackend.HandoffDelivery["status"]) =>
  status === "done" || status === "cancelled";

/** What a claim's dispatch found, settled once its admission has been marked dispatched. */
type Launch =
  | { readonly type: "refused"; readonly because: string }
  | { readonly type: "started"; readonly delivery: HandoffBackend.HandoffDelivery }
  /** Factory refused the start before writing a row. */
  | { readonly type: "start_refused"; readonly because: string }
  /** The start or a read failed, and whether a row exists is unknown until it is read. */
  | { readonly type: "uncertain" };

type Claim = NonNullable<HandoffAdmission.FactoryAssignment["claim"]>;

/**
 * What a Factory assignment's enqueue found: the link it writes, from its capture, confirmed by a
 * fresh read of the item.
 */
interface Authorized {
  readonly captureId: string;
  readonly item: HandoffBackend.HandoffItemRef;
  readonly kind: "single" | "parent";
  readonly scopeHash: string;
  readonly itemFingerprint: string;
  readonly runtimeMode: RuntimeMode;
}

/**
 * The project assistant's Factory executor (note 6.8 and 6.11): what its enqueue checks, its claim's
 * launch, its reconciliation before a delivery runs and its controls. Everything here but the fresh
 * read `readCaptured` runs under the assistant's lock, which a claim holds from its commit through
 * its start call, so a control never lands between the two: an intent is persisted first, and a
 * strict read of the delivery after it then decides, with no start in flight. Factory stays
 * authoritative: nothing here advances a delivery but `start`, `stop`, `resume` and `cancel` by its
 * own id, and a queued row is never handed to `stop` or `resume`, which refuse it.
 */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* PortfolioStore.PortfolioStore;
  const captures = yield* WorkCaptureStore.WorkCaptureStore;
  const admission = yield* HandoffAdmission.HandoffAdmission;
  const work = yield* HandoffBackend.HandoffBackend;
  const factory = yield* HandoffBackend.HandoffFactory;

  const move = (assignmentId: string, event: Portfolio.AssignmentEvent) =>
    store.transitionAssignment({ assignmentId, event });

  /** The fresh read of an item; a failed or invalid read is a result, never an error. */
  const readWork = (item: HandoffAdmission.ItemRef) =>
    work.read(item).pipe(
      Effect.map((read): HandoffAdmission.WorkRead =>
        read.invalid
          ? { type: "unreadable" }
          : { type: "read", fingerprint: read.fingerprint, status: read.status },
      ),
      Effect.catchTags({
        HandoffBackendError: () =>
          Effect.succeed<HandoffAdmission.WorkRead>({ type: "unreadable" }),
      }),
    );

  /** Why the claim's recheck refuses (F, then the verify command), or undefined when it holds. */
  const recheck = (assignment: HandoffAdmission.FactoryAssignment, projectId: ProjectId) =>
    Effect.gen(function* () {
      const fresh = yield* readWork(assignment.item);
      const category = yield* admission.authority(assignment.assignmentId, fresh);
      if (category !== undefined) return REFUSED_BECAUSE[category];
      return (yield* factory.verifyConfigured(projectId)) ? undefined : NOT_CONFIGURED;
    });

  const uncertain = (assignmentId: string, note: string) =>
    Effect.gen(function* () {
      const current = yield* store.getAssignment(assignmentId);
      if (Option.isSome(current) && current.value.state === "launching") {
        yield* move(assignmentId, { type: "uncertain", note });
      }
    });

  const LAUNCH_UNKNOWN =
    "The Factory delivery's state could not be read; its slot stays held and the next pass reads it again.";

  /** The delivery exists and runs: the assignment names it. */
  const adopt = (
    assignment: HandoffAdmission.FactoryAssignment,
    root: string,
    delivery: HandoffBackend.HandoffDelivery,
  ) =>
    delivery.status === "queued"
      ? Effect.void
      : move(assignment.assignmentId, {
          type: "start",
          workerRefs: [
            { kind: "factory-delivery", id: root },
            { kind: "work-item", id: workItemRefString(assignment.item) },
          ],
          note: `Factory delivery ${root} accepted the assignment.`,
        }).pipe(Effect.asVoid);

  /** No delivery row exists, and none can: the assignment fails, and its root retires. */
  const retireFailed = (
    assignment: HandoffAdmission.FactoryAssignment,
    root: string,
    claim: Pick<Claim, "admissionId" | "entrySeq"> | null,
    because: string,
  ) =>
    Effect.gen(function* () {
      const note = `Factory delivery ${root} was not started because ${because}.`;
      const outcome =
        claim === null
          ? ("contended" as const)
          : yield* admission.retirePreDelivery({
              root,
              reason: "failed",
              shape: { type: "claim", admissionId: claim.admissionId, entrySeq: claim.entrySeq },
              note,
            });
      if (outcome === "contended") yield* uncertain(assignment.assignmentId, note);
    });

  /**
   * A queued orphan whose authority no longer holds (D4): its own row is cancelled, keeping the
   * claim's slot and admission until the family is quiescent. Never failed while a row exists.
   */
  const cancelOrphan = (
    assignment: HandoffAdmission.FactoryAssignment,
    root: string,
    because: string,
  ) =>
    Effect.gen(function* () {
      const cancelled = yield* Effect.result(factory.cancel(root));
      if (
        Result.isFailure(cancelled) &&
        !(
          cancelled.failure._tag === "HandoffFactoryRefused" && cancelled.failure.reason === "ended"
        )
      ) {
        return yield* uncertain(assignment.assignmentId, LAUNCH_UNKNOWN);
      }
      yield* move(assignment.assignmentId, {
        type: "mirror",
        to: "stopping",
        note: orphanNotice(root, because),
      });
    });

  /** A strict read of the delivery, for a refusal of a claim that may already have a row. */
  const settleRefused = (
    assignment: HandoffAdmission.FactoryAssignment,
    root: string,
    claim: Pick<Claim, "admissionId" | "entrySeq"> | null,
    because: string,
  ) =>
    Effect.gen(function* () {
      const read = yield* Effect.exit(factory.get(root));
      if (Exit.isFailure(read)) return yield* uncertain(assignment.assignmentId, LAUNCH_UNKNOWN);
      if (Option.isNone(read.value)) return yield* retireFailed(assignment, root, claim, because);
      if (read.value.value.status === "queued") {
        return yield* cancelOrphan(assignment, root, because);
      }
      return yield* adopt(assignment, root, read.value.value);
    });

  /** The claim's start, under the id and ceiling it was queued with. */
  const callStart = (assignment: HandoffAdmission.FactoryAssignment, root: string) =>
    factory
      .start({
        deliveryId: root,
        item: assignment.item,
        kind: assignment.kind,
        runtimeModeCeiling: assignment.runtimeMode,
      })
      .pipe(
        Effect.map((delivery): Launch => ({ type: "started", delivery })),
        Effect.catchTags({
          HandoffFactoryRefused: (refused) =>
            Effect.succeed<Launch>({ type: "start_refused", because: refused.message }),
          HandoffFactoryError: () => Effect.succeed<Launch>({ type: "uncertain" }),
        }),
      );

  /** Acts on what a start found, once its admission has been marked dispatched. */
  const settle = (
    assignment: HandoffAdmission.FactoryAssignment,
    root: string,
    claim: Pick<Claim, "admissionId" | "entrySeq">,
    first: boolean,
    launch: Launch,
  ) =>
    Effect.gen(function* () {
      switch (launch.type) {
        case "started":
          return yield* adopt(assignment, root, launch.delivery);
        case "refused":
          // A first claim's start has never been called, so its delivery cannot exist.
          return first
            ? yield* retireFailed(assignment, root, claim, launch.because)
            : yield* settleRefused(assignment, root, claim, launch.because);
        case "start_refused": {
          const read = yield* Effect.exit(factory.get(root));
          if (Exit.isFailure(read)) {
            return yield* uncertain(assignment.assignmentId, LAUNCH_UNKNOWN);
          }
          return Option.isNone(read.value)
            ? yield* retireFailed(assignment, root, claim, launch.because)
            : yield* adopt(assignment, root, read.value.value);
        }
        case "uncertain": {
          const read = yield* Effect.exit(factory.get(root));
          return Exit.isSuccess(read) && Option.isSome(read.value)
            ? yield* adopt(assignment, root, read.value.value)
            : yield* uncertain(
                assignment.assignmentId,
                "The Factory start did not confirm; the next pass reads its delivery and starts it under the same id.",
              );
        }
      }
    });

  /**
   * Claims the queued assignment at the fair head: a first claim mints its intended id, a pending
   * resume's re-claim keeps its own. After the commit, the recheck, then the start under that id;
   * the claim's admission is marked dispatched when they return, however they end, and only then
   * is what they found acted on. False when it was not at the head after all.
   */
  const launch = (projectId: ProjectId, assignmentId: string, pendingRoot: string | null) =>
    Effect.gen(function* () {
      const deliveryId = pendingRoot === null ? yield* randomUuidV4 : undefined;
      const { decision, value } = yield* admission.dispatchAdmitted(
        admission.claim({ assignmentId, ...(deliveryId === undefined ? {} : { deliveryId }) }),
        (admitted) =>
          Effect.gen(function* () {
            const assignment = yield* admission.factoryAssignment(assignmentId);
            if (assignment === undefined) return { type: "uncertain" } as const;
            const because = yield* recheck(assignment, projectId);
            if (because !== undefined) return { type: "refused", because } as const;
            return yield* callStart(assignment, admitted.root);
          }).pipe(
            // An interrupted claim has no result to act on; the next instance reconciles it.
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.succeed<Launch>({ type: "uncertain" }),
            ),
          ),
        { interruptible: true },
      );
      if (decision.type !== "claimed" || Option.isNone(value)) return false;
      const assignment = yield* admission.factoryAssignment(assignmentId);
      if (assignment !== undefined) {
        yield* settle(assignment, decision.root, decision.admitted, decision.first, value.value);
      }
      return true;
    });

  const STOP_WAITS =
    "The stop is held until this assignment's claim can be released; its slot stays held and the next pass tries again.";

  /**
   * Parks a root stopped before its first start, if its claim's protection allows it now.
   * Anything else that holds the root keeps the claim, and the next pass tries again.
   */
  const park = (assignmentId: string, root: string, claim: Claim | null) =>
    Effect.gen(function* () {
      const outcome =
        claim === null
          ? ("contended" as const)
          : yield* admission.parkPreStart({
              root,
              admissionId: claim.admissionId,
              entrySeq: claim.entrySeq,
            });
      if (outcome === "contended") yield* uncertain(assignmentId, STOP_WAITS);
    });

  /** The strict read a reconciliation decides on: none when it failed, decided nothing. */
  const readDelivery = (root: string) =>
    factory
      .get(root)
      .pipe(
        Effect.map(Option.some),
        Effect.catchTags({ HandoffFactoryError: () => Effect.succeedNone }),
      );

  /** An ended delivery's retirement, once nothing of its root holds a slot (note 6.9). */
  const retireEnded = (root: string, status: HandoffBackend.HandoffDelivery["status"]) =>
    admission
      .retire({
        root,
        reason: status === "done" ? "completed" : "cancelled",
        release: Effect.void,
        observe: factory.activity(root),
      })
      .pipe(Effect.asVoid);

  /**
   * A parked or pending-resume root whose cancel is persisted, so no claim can be granted: absent,
   * it retires abandoned; a queued row is cancelled by its own id, recreating no slot, and retires
   * cancelled; one that ended retires with its reason. A failed read or cancel changes nothing,
   * and the next pass tries again.
   */
  const parkedCancel = (
    assignmentId: string,
    root: string,
    delivery: Option.Option<HandoffBackend.HandoffDelivery>,
  ) =>
    Effect.gen(function* () {
      if (Option.isNone(delivery)) {
        return yield* admission
          .retirePreDelivery({ root, reason: "abandoned", shape: { type: "parked" } })
          .pipe(Effect.asVoid);
      }
      const { status } = delivery.value;
      if (isEnded(status)) return yield* retireEnded(root, status);
      const cancelled = yield* Effect.result(factory.cancel(root));
      if (Result.isFailure(cancelled)) return;
      yield* move(assignmentId, {
        type: "mirror",
        to: "stopping",
        note: `Cancelling Factory delivery ${root}.`,
      });
      if (isEnded(cancelled.success.status)) {
        yield* retireEnded(root, cancelled.success.status);
      }
    });

  /**
   * A claim that has committed and is not being dispatched: the persisted intent first, then a
   * strict read of the delivery. Start is called only with no intent set, and only for a row that
   * is absent or queued; a dead instance's claim row counts as dispatched.
   */
  const reconcileClaim = (
    current: Portfolio.Assignment,
    assignment: HandoffAdmission.FactoryAssignment,
    root: string,
  ) =>
    Effect.gen(function* () {
      const { claim, control } = assignment;
      if (assignment.root?.state !== "active") return;
      // This instance's own dispatch still runs; its end acts on what it finds.
      if (claim?.state === "dispatching" && claim.mine) {
        return control === "none" ? undefined : yield* uncertain(current.assignmentId, STOP_WAITS);
      }
      const read = yield* Effect.exit(factory.get(root));
      if (Exit.isFailure(read)) return yield* uncertain(current.assignmentId, LAUNCH_UNKNOWN);
      const delivery = Option.getOrUndefined(read.value);
      const honored = () =>
        claim?.state === "dispatching" ? admission.markDispatched(claim) : Effect.void;

      if (delivery !== undefined && isEnded(delivery.status)) {
        yield* honored();
        return yield* adopt(assignment, root, delivery);
      }
      if (control === "stop" && (delivery === undefined || delivery.status === "queued")) {
        yield* honored();
        return yield* park(current.assignmentId, root, claim);
      }
      if (control === "stop") {
        yield* honored();
        const stopped = yield* Effect.result(factory.stop(root));
        if (Result.isFailure(stopped)) return yield* adopt(assignment, root, delivery!);
        return yield* move(current.assignmentId, {
          type: "mirror",
          to: "stopping",
          note: `Stopping Factory delivery ${root} after its step.`,
        }).pipe(Effect.asVoid);
      }
      if (control === "cancel" && delivery === undefined) {
        yield* honored();
        if (claim === null) return;
        return yield* admission
          .retirePreDelivery({
            root,
            reason: "abandoned",
            shape: { type: "claim", admissionId: claim.admissionId, entrySeq: claim.entrySeq },
          })
          .pipe(Effect.asVoid);
      }
      if (control === "cancel") {
        yield* honored();
        const cancelled = yield* Effect.result(factory.cancel(root));
        if (Result.isFailure(cancelled)) {
          return yield* uncertain(current.assignmentId, LAUNCH_UNKNOWN);
        }
        return yield* move(current.assignmentId, {
          type: "mirror",
          to: "stopping",
          note: `Cancelling Factory delivery ${root}.`,
        }).pipe(Effect.asVoid);
      }
      if (delivery !== undefined && delivery.status !== "queued") {
        yield* honored();
        return yield* adopt(assignment, root, delivery);
      }
      // No intent, and nothing has started it: the recheck, then the start under the same id.
      if (claim === null || assignment.slot === null) return;
      const because = yield* Effect.exit(recheck(assignment, current.projectId));
      if (Exit.isFailure(because)) return yield* uncertain(current.assignmentId, LAUNCH_UNKNOWN);
      if (because.value !== undefined) {
        yield* honored();
        return delivery === undefined
          ? yield* retireFailed(assignment, root, claim, because.value)
          : yield* cancelOrphan(assignment, root, because.value);
      }
      const started = yield* callStart(assignment, root).pipe(
        Effect.ensuring(honored().pipe(Effect.ignore)),
      );
      yield* settle(assignment, root, claim, false, started);
    });

  /** Cancels a delivery past queued by its own id; it shows stopping until retired. */
  const cancelDelivery = (current: Portfolio.Assignment, root: string) =>
    Effect.gen(function* () {
      yield* factory.cancel(root);
      return current.state === "stopping"
        ? current
        : yield* move(current.assignmentId, {
            type: "mirror",
            to: "stopping",
            note: `Cancelling Factory delivery ${root}.`,
          });
    });

  /** A root parked or pending a resume, each pass: its cancel, or a delivery that ended. */
  const reconcileParked = (
    current: Portfolio.Assignment,
    assignment: HandoffAdmission.FactoryAssignment,
    root: string,
  ) =>
    Effect.gen(function* () {
      if (assignment.root?.state === "retired" || assignment.slot !== null) return;
      const read = yield* readDelivery(root);
      if (Option.isNone(read)) return;
      const delivery = read.value;
      if (assignment.control === "cancel") {
        return yield* parkedCancel(current.assignmentId, root, delivery);
      }
      if (Option.isSome(delivery) && isEnded(delivery.value.status)) {
        yield* retireEnded(root, delivery.value.status);
      }
    });

  /** One Factory assignment, each tick and after each control. */
  const reconcile = (current: Portfolio.Assignment) =>
    Effect.gen(function* () {
      if (!RECONCILED.has(current.state)) return;
      const assignment = yield* admission.factoryAssignment(current.assignmentId);
      const root = assignment?.deliveryId ?? null;
      if (assignment === undefined || root === null) return;
      switch (current.state) {
        case "launching":
        case "launch-uncertain":
          return yield* reconcileClaim(current, assignment, root);
        case "queued":
        case "stopped":
          return yield* reconcileParked(current, assignment, root);
        case "running":
        case "needs-input":
        case "stopping": {
          if (assignment.root?.state === "retired") return;
          const read = yield* readDelivery(root);
          if (Option.isNone(read) || Option.isNone(read.value)) return;
          const { status } = read.value.value;
          // Cancelling a parked root's queued row left nothing held to wait for.
          if (isEnded(status)) {
            return assignment.slot === null ? yield* retireEnded(root, status) : undefined;
          }
          // A cancel Factory did not take is asked for again.
          if (assignment.control === "cancel") {
            yield* cancelDelivery(current, root).pipe(Effect.ignore);
          }
          return;
        }
        default:
          return;
      }
    });

  const currentState = (assignmentId: string) =>
    store.getAssignment(assignmentId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(refusal("Assignment not found.")),
          onSome: Effect.succeed,
        }),
      ),
    );

  /** Persists the intent, then lets the strict read after it decide. */
  const withIntent = (current: Portfolio.Assignment, control: "stop" | "cancel") =>
    Effect.gen(function* () {
      yield* admission.setControl(current.assignmentId, control);
      yield* reconcile(current).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("A Factory assignment's control was deferred", cause),
        ),
      );
      return yield* currentState(current.assignmentId);
    });

  const stop = (
    current: Portfolio.Assignment,
    assignment: HandoffAdmission.FactoryAssignment,
    root: string,
  ) =>
    Effect.gen(function* () {
      switch (current.state) {
        case "queued":
          return yield* refusal(PENDING_RESUME_STOP);
        case "launching":
        case "launch-uncertain":
          return yield* withIntent(current, "stop");
        case "stopped":
        case "stopping":
          return current;
        case "running":
        case "needs-input":
          yield* factory.stop(root);
          return yield* move(assignment.assignmentId, {
            type: "mirror",
            to: "stopping",
            note: `Stopping Factory delivery ${root} after its step.`,
          });
        default:
          return yield* refusal(`This assignment is ${current.state}, so it cannot stop.`);
      }
    });

  const cancel = (
    current: Portfolio.Assignment,
    assignment: HandoffAdmission.FactoryAssignment,
    root: string,
  ) =>
    Effect.gen(function* () {
      switch (current.state) {
        case "queued":
        case "launching":
        case "launch-uncertain":
        case "stopped":
          return yield* withIntent(current, "cancel");
        case "running":
        case "needs-input":
        case "stopping":
          yield* admission.setControl(assignment.assignmentId, "cancel");
          return yield* cancelDelivery(current, root);
        default:
          return yield* move(assignment.assignmentId, { type: "cancel" });
      }
    });

  const resume = (
    current: Portfolio.Assignment,
    assignment: HandoffAdmission.FactoryAssignment,
    root: string,
  ) =>
    Effect.gen(function* () {
      switch (current.state) {
        case "queued":
          return yield* refusal(PENDING_RESUME_STOP);
        case "launching":
        case "launch-uncertain":
          // The claim goes on under its slot; the next pass starts it.
          if (assignment.control === "none") {
            return yield* refusal("This assignment is already launching.");
          }
          yield* admission.setControl(assignment.assignmentId, "none");
          return current;
        case "stopped":
        case "running":
        case "needs-input":
        case "stopping":
          break;
        default:
          return yield* refusal(`This assignment is ${current.state}, so it cannot resume.`);
      }
      const read = yield* Effect.exit(factory.get(root));
      if (Exit.isFailure(read)) {
        return yield* refusal(
          "The Factory delivery could not be read, so nothing was resumed. Try again.",
        );
      }
      const delivery = Option.getOrUndefined(read.value);
      const fresh = yield* readWork(assignment.item);
      const verified = yield* Effect.exit(factory.verifyConfigured(current.projectId));
      if (Exit.isFailure(verified)) {
        return yield* refusal(
          "Factory's settings could not be read, so nothing was resumed. Try again.",
        );
      }
      if (!verified.value) return yield* refusal(`Not resumed: ${NOT_CONFIGURED}.`);
      if (delivery === undefined || delivery.status === "queued") {
        // A root parked before its first start waits in the queue again. Only a fair grant
        // re-claims it, and that claim's recheck starts this same id.
        if (current.state !== "stopped") {
          return yield* refusal("This assignment's Factory delivery has not started.");
        }
        const entered = yield* admission.resumeReentry({ root, work: fresh });
        switch (entered.type) {
          case "queued":
            return yield* currentState(assignment.assignmentId);
          case "refused":
            return yield* refusal(`Not resumed: ${REFUSED_BECAUSE[entered.category]}.`);
          case "contended":
            return yield* refusal("This assignment changed meanwhile, so nothing was resumed.");
        }
      }
      if (!["stopping", "stopped", "blocked"].includes(delivery.status)) {
        return yield* refusal(
          `Factory delivery ${root} is ${delivery.status}, so it cannot resume.`,
        );
      }
      const category = yield* admission.authority(assignment.assignmentId, fresh);
      if (category !== undefined) {
        return yield* refusal(`Not resumed: ${REFUSED_BECAUSE[category]}.`);
      }
      yield* factory.resume(root);
      yield* admission.setControl(assignment.assignmentId, "none");
      if (current.state === "running") return current;
      return yield* move(assignment.assignmentId, {
        type: "mirror",
        to: "running",
        note: `Resumed Factory delivery ${root}.`,
      });
    });

  const retry = (current: Portfolio.Assignment, assignment: HandoffAdmission.FactoryAssignment) =>
    Effect.gen(function* () {
      if (
        (current.state !== "failed" && current.state !== "cancelled") ||
        assignment.root?.state !== "retired"
      ) {
        return yield* refusal(RESUME_KEEPS_ID);
      }
      const entered = yield* admission.retryReentry({
        assignmentId: assignment.assignmentId,
        work: yield* readWork(assignment.item),
      });
      switch (entered.type) {
        case "queued":
          return yield* currentState(assignment.assignmentId);
        case "refused":
          return yield* refusal(`Not retried: ${REFUSED_BECAUSE[entered.category]}.`);
        case "contended":
          return yield* refusal(
            "Another assignment uses this capture, or this one has not ended, so nothing was retried.",
          );
      }
    });

  return {
    launch,
    reconcile,

    /** The captured item's fresh read, for an enqueue, taken before the assistant's lock. */
    readCaptured: (projectId: ProjectId, ideaId: string) =>
      Effect.gen(function* () {
        const capture = yield* captures.get(projectId, ideaId);
        if (Option.isNone(capture) || capture.value.itemId === null) return undefined;
        return yield* work.read({
          sourceId: capture.value.sourceId,
          itemId: capture.value.itemId,
        });
      }).pipe(
        Effect.catchTags({ HandoffBackendError: () => Effect.succeed("unreadable" as const) }),
      ),

    /**
     * Whether the idea's capture may be queued (note 6.2, F). Refuses for a thread in plan mode, a
     * capture that does not exist or was never confirmed, a brief or item that moved on from it, a
     * closed or unreadable item, a project with no verify command, and a capture another
     * assignment that has not ended uses.
     */
    authorize: (input: {
      readonly projectId: ProjectId;
      readonly ideaId: string;
      readonly brief: Portfolio.ProjectBrief;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly looperConfig: string | null;
      readonly read: HandoffBackend.HandoffItem | "unreadable" | undefined;
    }) =>
      Effect.gen(function* () {
        if (input.looperConfig !== null) {
          return yield* refusal(
            "A Factory assignment runs through Factory, so it takes no Looper configuration.",
          );
        }
        if (input.interactionMode === "plan") {
          return yield* refusal(
            "A thread in plan mode can only read, so it cannot queue Factory work.",
          );
        }
        const captured = Option.getOrUndefined(yield* captures.get(input.projectId, input.ideaId));
        if (captured?.state !== "captured" || captured.itemId === null) {
          return yield* refusal(
            "Capture this idea as a Work item with assistant_capture_work first, and have the owner review it in Work.",
          );
        }
        if (captured.itemFingerprint === null) {
          return yield* refusal(
            "No read has confirmed what the captured Work item says. Capture the idea again, and have the owner review it in Work.",
          );
        }
        if (captured.scopeHash !== Portfolio.briefScopeHash(input.brief)) {
          return yield* refusal(
            "The brief changed after this idea was captured. Capture it again, and have the owner review the item in Work.",
          );
        }
        if (input.read === undefined || input.read === "unreadable" || input.read.invalid) {
          return yield* refusal(
            "The captured Work item could not be read, so nothing was queued. Try again once its source can be read.",
          );
        }
        if (input.read.fingerprint !== captured.itemFingerprint) {
          return yield* refusal(
            "The captured Work item changed after it was captured. Show the owner what changed in Work, and capture the idea again.",
          );
        }
        if (input.read.status === "done" || input.read.status === "cancelled") {
          return yield* refusal(
            "The captured Work item is done or cancelled, so nothing was queued.",
          );
        }
        const verified = yield* factory.verifyConfigured(input.projectId);
        if (!verified) {
          return yield* refusal(
            "Set a verify command in the project's Factory settings before queuing a delivery.",
          );
        }
        if (yield* admission.captureInUse({ captureId: captured.captureId })) {
          return yield* refusal(
            "Another assignment that has not ended already delivers this capture.",
          );
        }
        return {
          captureId: captured.captureId,
          item: { sourceId: captured.sourceId, itemId: captured.itemId },
          kind: captured.kind,
          scopeHash: captured.scopeHash,
          itemFingerprint: captured.itemFingerprint,
          runtimeMode: input.runtimeMode,
        } satisfies Authorized;
      }),

    /** The link and queue position of a Factory assignment, in its enqueue's transaction. */
    enterAuthorized: (assignmentId: string, authorized: Authorized) =>
      Effect.gen(function* () {
        yield* admission.createLink({ assignmentId, ...authorized });
        yield* admission.enterQueue(assignmentId);
      }),

    /** A control of a Factory assignment (note 6.8), under the assistant's lock. */
    control: (current: Portfolio.Assignment, action: "stop" | "resume" | "retry" | "cancel") =>
      Effect.gen(function* () {
        const assignment = yield* admission.factoryAssignment(current.assignmentId);
        if (assignment === undefined) return yield* refusal("Assignment not found.");
        const root = assignment.deliveryId;
        if (root === null) {
          // Queued and never claimed: nothing of it exists outside the queue.
          switch (action) {
            case "stop":
              return yield* refusal(NEVER_STARTED_STOP);
            case "cancel":
              return yield* sql.withTransaction(
                Effect.gen(function* () {
                  const cancelled = yield* move(current.assignmentId, { type: "cancel" });
                  yield* admission.leaveQueue(current.assignmentId);
                  return cancelled;
                }),
              );
            case "resume":
            case "retry":
              return yield* refusal(NEVER_STARTED_STOP);
          }
        }
        switch (action) {
          case "stop":
            return yield* stop(current, assignment, root);
          case "cancel":
            return yield* cancel(current, assignment, root);
          case "resume":
            return yield* resume(current, assignment, root);
          case "retry":
            return yield* retry(current, assignment);
        }
      }).pipe(
        Effect.catchTags({
          HandoffFactoryRefused: (refused) => Effect.fail(refusal(refused.message)),
        }),
      ),
  };
});
