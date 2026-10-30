import {
  type ProjectId,
  type ProviderInteractionMode,
  RuntimeRequestId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { workItemRefString } from "@t3tools/contracts/fd/work-management";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { isTerminalRunStatus } from "../../orchestration-v2/ThreadManagementService.ts";
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

const staleEffectNotice = (root: string) =>
  `Factory delivery ${root} lost its place waiting for a project assistant slot, so it blocked. Resume it to go on, or cancel it.`;

const revokedNotice = (root: string, because: string) =>
  `Factory delivery ${root} is being stopped because ${because}, and it starts nothing new. Restore exactly what was authorized and resume it, or cancel it.`;

/** What a waiting automatic turn is called in its notice. */
const WAITING_TURN: Readonly<Record<Exclude<HandoffAdmission.DemandKind, "effect">, string>> = {
  pull_request_wake: "Pull request feedback",
  usage_limit_resume: "A usage-limit resume",
  delegated_question: "A delegated agent's question",
  delegated_completion: "A delegated agent's result",
  background_wake: "Background work",
};

/** The notice saying what a demand waits for, and why, in the owner's terms. */
const demandNotice = (demand: HandoffAdmission.Demand) => {
  if (demand.kind === "effect") {
    return `Factory delivery ${demand.deliveryId} is waiting for a project assistant slot for its next step.`;
  }
  const turn = `${WAITING_TURN[demand.kind]} on ${demand.threadId}`;
  if (demand.blockedReason !== null) {
    return `${turn} is blocked because ${REFUSED_BECAUSE[demand.blockedReason]}. It goes on once that is restored; cancel the assignment to drop it.`;
  }
  const answer =
    demand.childThreadId === null ? "" : ` You can answer it in thread ${demand.childThreadId}.`;
  return demand.provenance === "unknown"
    ? `${turn} is waiting for a project assistant slot. T3 cannot tell whether it came from the delivery or from your own turn, so it counts as the delivery's.${answer}`
    : `${turn} is waiting for a project assistant slot.${answer}`;
};

/** An observation that says nothing is known, for a read that failed. */
const UNOBSERVED: HandoffAdmission.Observation = {
  phase: "terminal",
  busy: false,
  deferred: false,
  unknown: true,
};

const encodeQuestions = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Keeps going past a step that failed, so one failure holds up nothing else of a tick. */
const deferred =
  (step: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | undefined, never, R> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.as(
              Effect.logWarning(`A Factory assignment's ${step} was deferred`, cause),
              undefined,
            ),
      ),
    );

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

const isResumable = (status: HandoffBackend.HandoffDelivery["status"]) =>
  status === "stopping" || status === "stopped" || status === "blocked";

/**
 * Where a delivery past queued puts its assignment (note 6.8), with the note saying so: Factory is
 * authoritative, so nothing here is decided but what it says. A parent waits as the child it awaits
 * does. A cancel stays stopping until Factory has ended and the family is quiescent.
 */
const mirrorOf = (
  root: string,
  control: HandoffAdmission.FactoryAssignment["control"],
  follow: HandoffBackend.HandoffFollow,
): { readonly to: Portfolio.MirroredState; readonly note: string } => {
  if (control === "cancel") {
    return { to: "stopping", note: `Cancelling Factory delivery ${root}.` };
  }
  const { child } = follow;
  if (child?.status === "blocked") {
    return {
      to: "needs-input",
      note: `Factory delivery ${child.deliveryId}, a task of ${root}, is blocked: ${child.reason ?? "open it in Work to see why"} Resume it once that is fixed, or cancel.`,
    };
  }
  if (child?.status === "stopping") {
    return {
      to: "stopping",
      note: `Factory delivery ${child.deliveryId}, a task of ${root}, is stopping after its step.`,
    };
  }
  if (child?.status === "stopped") {
    return {
      to: "stopped",
      note: `Factory delivery ${child.deliveryId}, a task of ${root}, stopped after its step. Resume it, or cancel.`,
    };
  }
  switch (follow.status) {
    case "queued":
    case "running":
    case "approved":
      return { to: "running", note: `Factory delivery ${root} is running.` };
    case "pr_open":
      return follow.awaiting === null && follow.pullRequest !== null
        ? { to: "needs-input", note: `PR ${follow.pullRequest.url} open; review and merge.` }
        : {
            to: "running",
            note: `Factory delivery ${root} is following up on PR ${follow.pullRequest?.url ?? "its pull request"}.`,
          };
    case "stopping":
      return { to: "stopping", note: `Stopping Factory delivery ${root} after its step.` };
    case "stopped":
      return {
        to: "stopped",
        note: `Factory delivery ${root} stopped after its step. Resume it, or cancel.`,
      };
    case "waiting":
      return {
        to: "needs-input",
        note: `${follow.reason ?? "A plan awaits your approval."} Approve, edit or replan it in the item's Factory section in Work.`,
      };
    case "blocked":
      return {
        to: "needs-input",
        note: `Factory delivery ${root} is blocked: ${follow.reason ?? "open it in Work to see why."} Resume it once that is fixed, or cancel.`,
      };
    case "done":
    case "cancelled":
      // Never mirrored: an ended delivery's assignment ends only through its retirement.
      return { to: "stopping", note: `Factory delivery ${root} has ended.` };
  }
};

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
 * What a Factory assignment's enqueue found: the link it writes, from its capture, and the fresh
 * read of the item that confirmed it, which the enqueue's transaction judges once more.
 */
interface Authorized {
  readonly captureId: string;
  readonly item: HandoffBackend.HandoffItemRef;
  readonly kind: "single" | "parent";
  readonly scopeHash: string;
  readonly itemFingerprint: string;
  readonly runtimeMode: RuntimeMode;
  readonly work: HandoffAdmission.WorkRead;
}

/**
 * The project assistant's Factory executor (note 6.8 and 6.11): what its enqueue checks, its claim's
 * launch, its reconciliation before a delivery runs and its controls. Everything here but the fresh
 * read `readCaptured` runs under the assistant's lock, which a claim holds from its commit through
 * its start call, so a control never lands between the two: an intent is persisted first, and a
 * strict read of the delivery after it then decides, with no start in flight. Factory stays
 * authoritative: nothing here advances a delivery but `start`, `stop`, `resume` and `cancel` by its
 * own id, and a queued row is never handed to `stop` or `resume`, which refuse it.
 *
 * Each tick `reconcile` mirrors its delivery once it runs (note 6.8), releases its slot on evidence
 * (note 6.4) and retires an ended root through the admission fence (note 6.9); `maintain` looks
 * after waiting demands (note 6.3), and `grant` hands the fair head's demand its slot.
 */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* PortfolioStore.PortfolioStore;
  const captures = yield* WorkCaptureStore.WorkCaptureStore;
  const admission = yield* HandoffAdmission.HandoffAdmission;
  const work = yield* HandoffBackend.HandoffBackend;
  const factory = yield* HandoffBackend.HandoffFactory;
  const redelivery = yield* HandoffBackend.HandoffRedelivery;
  /** An instance's first tick redelivers what the instance before it had reserved. */
  let firstTickDone = false;

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
    note = `Factory delivery ${root} accepted the assignment.`,
  ) =>
    delivery.status === "queued"
      ? Effect.void
      : move(assignment.assignmentId, {
          type: "start",
          workerRefs: [
            { kind: "factory-delivery", id: root },
            { kind: "work-item", id: workItemRefString(assignment.item) },
          ],
          note,
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

  /** Records `note` unless the assignment's recent notes already hold it. */
  const noteOnce = (assignmentId: string, note: string) =>
    Effect.gen(function* () {
      const current = yield* store.getAssignment(assignmentId);
      if (Option.isNone(current) || current.value.progress.some(({ text }) => text === note)) {
        return;
      }
      yield* move(assignmentId, { type: "record-notice", note });
    });

  /**
   * The release pass (note 6.4): the slot's `entry_seq` and the root's admissions read first, then
   * what the family is doing, and the slot goes only by compare-and-delete at that `entry_seq`, only
   * for a parked or terminal family with nothing busy, deferred or unknown. A queued or missing
   * delivery is neither, so a pre-start claim's slot never leaves here.
   */
  const releasePass = (assignmentId: string, root: string) =>
    Effect.gen(function* () {
      const settled = yield* admission.settleAdmissions(root, factory.runStateOf);
      if (settled.entrySeq === null) return;
      const report = yield* factory.activity(root);
      if (report.phase !== "parked" && report.phase !== "terminal") return;
      if (settled.unknown || report.unknown) {
        return yield* noteOnce(
          assignmentId,
          `What Factory delivery ${root}'s threads are doing could not be read, so its project assistant slot stays held and the next pass reads it again.`,
        );
      }
      if (settled.busy || report.busy) {
        return report.phase === "parked"
          ? yield* noteOnce(
              assignmentId,
              `Work on Factory delivery ${root}'s threads is still running, so its project assistant slot stays held until it ends.`,
            )
          : undefined;
      }
      if (report.deferred) return;
      yield* admission.release(root, settled.entrySeq);
    });

  /**
   * An ended delivery's retirement (note 6.9): the release pass, a fresh observation, then the
   * attempt, which fences the root and retires it only once nothing of it holds a slot. A
   * reservation goes by compare-and-delete, a reservation that became an admission stays and
   * counted, and anything else keeps the assignment as it is, with a note, until a later pass.
   */
  const retireEnded = (
    assignmentId: string,
    root: string,
    status: HandoffBackend.HandoffDelivery["status"],
    pullRequest: HandoffBackend.HandoffFollow["pullRequest"] = null,
  ) =>
    Effect.gen(function* () {
      const reason = status === "done" ? ("completed" as const) : ("cancelled" as const);
      let seen: HandoffAdmission.Observation = UNOBSERVED;
      const attempt = admission.retire({
        root,
        reason,
        release: releasePass(assignmentId, root).pipe(deferred("release")),
        observe: factory.activity(root).pipe(
          Effect.orElseSucceed(() => UNOBSERVED),
          Effect.tap((observation) =>
            Effect.sync(() => {
              seen = observation;
            }),
          ),
        ),
        ...(reason === "completed"
          ? {
              evidence: [
                `Factory delivery ${root} is done: its pull request merged and its close-out finished.`,
                ...(pullRequest === null ? [] : [`Pull request ${pullRequest.url} merged.`]),
              ],
            }
          : pullRequest?.outcome === "closed"
            ? {
                note: `Factory delivery ${root} was cancelled: pull request ${pullRequest.url} closed without merging.`,
              }
            : {}),
      });
      let outcome = yield* attempt;
      if (outcome === "retired") return;
      const fenced = yield* admission.factoryAssignment(assignmentId);
      const reserved = fenced?.slot?.state === "reserved" ? fenced.slot.reservedDemandId : null;
      if (
        reserved !== null &&
        (yield* admission.dropFencedReservation({ root, demandId: reserved })) === "dropped"
      ) {
        outcome = yield* attempt;
      }
      if (outcome === "retired") return;
      yield* noteOnce(
        assignmentId,
        seen.unknown
          ? `Factory delivery ${root} has ended, but what its threads are doing could not be read. This assignment finishes once it can be.`
          : seen.busy && reason === "cancelled"
            ? `Factory delivery ${root} is cancelled, but work on its threads is still running. Stop it in the thread to finish cancelling.`
            : `Factory delivery ${root} has ended, and this assignment finishes once the work still counted on its threads has ended.`,
      );
    });

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
      if (isEnded(status)) return yield* retireEnded(assignmentId, root, status);
      const cancelled = yield* Effect.result(factory.cancel(root));
      if (Result.isFailure(cancelled)) return;
      yield* move(assignmentId, {
        type: "mirror",
        to: "stopping",
        note: `Cancelling Factory delivery ${root}.`,
      });
      if (isEnded(cancelled.success.status)) {
        yield* retireEnded(assignmentId, root, cancelled.success.status);
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
      if (control === "stop") {
        yield* honored();
        if (delivery === undefined || delivery.status === "queued") {
          return yield* park(current.assignmentId, root, claim);
        }
        const stopped = yield* Effect.result(factory.stop(root));
        if (Result.isSuccess(stopped)) {
          return yield* move(current.assignmentId, {
            type: "mirror",
            to: "stopping",
            note: `Stopping Factory delivery ${root} after its step.`,
          }).pipe(Effect.asVoid);
        }
        // Factory refusing a row that runs no stage spends the stop. Any other failure says
        // nothing about the row, so the stop stays persisted and the next pass asks again.
        if (
          stopped.failure._tag !== "HandoffFactoryRefused" ||
          stopped.failure.reason !== "not_stoppable"
        ) {
          return yield* uncertain(current.assignmentId, LAUNCH_UNKNOWN);
        }
        return yield* sql.withTransaction(
          Effect.andThen(
            admission.setControl(current.assignmentId, "none"),
            adopt(
              assignment,
              root,
              delivery,
              `Factory delivery ${root} cannot stop after its step while it runs no stage, so the stop was dropped.`,
            ),
          ),
        );
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
        yield* retireEnded(current.assignmentId, root, delivery.value.status);
      }
    });

  /**
   * Effect demands against what Factory says (note 6.3, G3 and G4): a demand for an effect its
   * delivery still awaits stays, marked again if the mark was lost; one no longer awaited goes, with
   * a notice naming Resume. A marked effect with no demand gets one, and one whose root holds its
   * slot now runs in that holding.
   */
  const reconcileEffects = (
    assignment: HandoffAdmission.FactoryAssignment,
    root: string,
    follow: HandoffBackend.HandoffFollow,
    demands: ReadonlyArray<HandoffAdmission.Demand>,
  ) =>
    Effect.gen(function* () {
      for (const demand of demands) {
        if (demand.kind !== "effect" || demand.deliveryId === null || demand.effectId === null) {
          continue;
        }
        const marked = yield* factory.ensureDeferred(demand.deliveryId, demand.effectId);
        if (marked === "stale") {
          yield* admission.dropStaleEffect({
            demandId: demand.id,
            note: staleEffectNotice(root),
          });
        }
      }
      if (assignment.slot?.state === "reserved") return;
      for (const mark of follow.marked) {
        if (assignment.slot?.state === "held") {
          yield* factory.redispatch(mark.deliveryId, mark.effectId);
        } else {
          yield* admission.ensureEffectDemand({ root, ...mark });
        }
      }
    });

  /** What the owner can do about each request pending on the family's threads. */
  const requestNotices = (assignmentId: string, root: string) =>
    Effect.gen(function* () {
      for (const request of yield* factory.requests(root)) {
        if (request.run?.class === "explicit") continue;
        yield* noteOnce(
          assignmentId,
          request.kind !== "user_input"
            ? `Thread ${request.threadId} needs a permission decision. Open that thread's approval UI; question tools cannot grant permission.`
            : request.capability === "live" && request.run?.class === "factory"
              ? `Owner question from thread ${request.threadId}: ${encodeQuestions(request.questions).slice(0, 4000)}. Reply through assistant_answer with its exact request ID ${request.requestId}.`
              : `A question on thread ${request.threadId} waits for an answer. Answer it in that thread.`,
        );
      }
    });

  /**
   * A delivery past queued, each pass: an ended one retires; otherwise a persisted cancel is asked
   * for again, a revoked root is asked to stop, the assignment mirrors the delivery, its demands are
   * looked after and its slot released on evidence. A read that fails decides nothing.
   */
  const followRoot = (
    current: Portfolio.Assignment,
    assignment: HandoffAdmission.FactoryAssignment,
    root: string,
  ) =>
    Effect.gen(function* () {
      if (assignment.root?.state === "retired") return;
      const read = yield* factory
        .follow(root)
        .pipe(
          Effect.map(Option.some),
          Effect.catchTags({ HandoffFactoryError: () => Effect.succeedNone }),
        );
      if (Option.isNone(read)) return;
      if (Option.isNone(read.value)) {
        return yield* noteOnce(
          current.assignmentId,
          `Factory delivery ${root} could not be found. Its project assistant slot stays held; cancel the assignment if it is gone for good.`,
        );
      }
      let follow = read.value.value;
      if (isEnded(follow.status)) {
        return yield* retireEnded(current.assignmentId, root, follow.status, follow.pullRequest);
      }
      // A cancel this pass asked for has moved the assignment already.
      let shown = current;
      if (assignment.control === "cancel") {
        shown = (yield* cancelDelivery(current, root).pipe(deferred("cancel"))) ?? current;
      } else {
        const revoked = yield* admission.revocation(current.assignmentId);
        if (revoked !== undefined) {
          yield* noteOnce(current.assignmentId, revokedNotice(root, REFUSED_BECAUSE[revoked]));
          if (follow.status === "running") {
            const stopped = yield* factory.stop(root).pipe(Effect.option);
            if (Option.isSome(stopped)) follow = { ...follow, status: stopped.value.status };
          }
        }
      }
      if (follow.status === "queued") return;
      const { to, note } = mirrorOf(root, assignment.control, follow);
      const refs: ReadonlyArray<Portfolio.WorkerRef> = [
        { kind: "factory-delivery", id: root },
        { kind: "work-item", id: workItemRefString(assignment.item) },
        ...(follow.threadId === null ? [] : [{ kind: "thread" as const, id: follow.threadId }]),
        ...(follow.child?.threadId == null
          ? []
          : [{ kind: "thread" as const, id: follow.child.threadId }]),
      ];
      const newRefs = refs.filter(
        (ref) => !shown.workerRefs.some(({ kind, id }) => kind === ref.kind && id === ref.id),
      );
      if (shown.state !== to) {
        yield* move(current.assignmentId, { type: "mirror", to, note, workerRefs: newRefs });
      } else {
        if (newRefs.length > 0) {
          yield* move(current.assignmentId, { type: "mirror", to, workerRefs: newRefs });
        }
        if (to !== "running") yield* noteOnce(current.assignmentId, note);
      }
      const demands = yield* admission.demands(root);
      yield* reconcileEffects(assignment, root, follow, demands).pipe(deferred("demand check"));
      for (const demand of demands) yield* noteOnce(current.assignmentId, demandNotice(demand));
      yield* requestNotices(current.assignmentId, root).pipe(deferred("question notice"));
      yield* releasePass(current.assignmentId, root).pipe(deferred("release"));
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
          return yield* reconcileParked(current, assignment, root);
        case "stopped": {
          // Parked before its first start, or stopped by Factory: only the row tells them apart.
          const read = yield* readDelivery(root);
          if (Option.isNone(read)) return;
          const row = read.value;
          return Option.isNone(row) || row.value.status === "queued"
            ? yield* reconcileParked(current, assignment, root)
            : yield* followRoot(current, assignment, root);
        }
        case "running":
        case "needs-input":
        case "stopping":
          return yield* followRoot(current, assignment, root);
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
          // Saved, the cancel stands: one Factory failed to take is the next pass's to ask again.
          return yield* cancelDelivery(current, root).pipe(
            Effect.catchTags({ HandoffFactoryError: () => Effect.succeed(current) }),
          );
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
      // A parent waits on the child it awaits, which alone can be resumed then.
      const awaited =
        delivery.status === "running" || delivery.status === "stopping"
          ? yield* factory.follow(root).pipe(
              Effect.map((follow) => Option.getOrUndefined(follow)?.child),
              Effect.catchTags({
                HandoffFactoryError: () =>
                  Effect.fail(
                    refusal(
                      "The Factory delivery could not be read, so nothing was resumed. Try again.",
                    ),
                  ),
              }),
            )
          : undefined;
      const target =
        awaited !== null && awaited !== undefined && isResumable(awaited.status)
          ? awaited.deliveryId
          : isResumable(delivery.status)
            ? root
            : undefined;
      if (target === undefined) {
        return yield* refusal(
          `Factory delivery ${root} is ${delivery.status}, so it cannot resume.`,
        );
      }
      const category = yield* admission.authority(assignment.assignmentId, fresh);
      if (category !== undefined) {
        return yield* refusal(`Not resumed: ${REFUSED_BECAUSE[category]}.`);
      }
      // The full recheck: what it restored enters the fair order again, at a fresh position.
      yield* admission.recheckBlocked({ root, work: fresh, force: true });
      yield* factory.resume(target);
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

  /** The demand's fresh read of its root's item, reserving its slot, then its redelivery. */
  const grantTurn = (demand: HandoffAdmission.Demand) =>
    Effect.gen(function* () {
      const assignment = yield* admission.factoryAssignment(demand.assignmentId);
      if (assignment === undefined) return false;
      const reserved = yield* admission.reserve(demand.id, yield* readWork(assignment.item));
      if (reserved.type === "stale") return false;
      if (reserved.type === "blocked") return true;
      yield* redelivery.redeliver(reserved.demand).pipe(deferred("redelivery"));
      return true;
    });

  /** The marked effect's own grant: a held slot and its admission, then its redispatch. */
  const grantEffect = (demand: HandoffAdmission.Demand) =>
    Effect.gen(function* () {
      const { deliveryId, effectId } = demand;
      if (deliveryId === null || effectId === null) return false;
      const marked = yield* factory.ensureDeferred(deliveryId, effectId);
      if (marked === "running") return false;
      if (marked === "stale") {
        yield* admission.dropStaleEffect({
          demandId: demand.id,
          note: staleEffectNotice(demand.root),
        });
        return true;
      }
      const { decision } = yield* admission.dispatchAdmitted(admission.grantEffect(demand.id), () =>
        factory.redispatch(deliveryId, effectId),
      );
      // Asked again, a revoked root's delivery refuses the effect itself and blocks.
      if (decision.type === "refused") {
        yield* factory.redispatch(deliveryId, effectId);
        return false;
      }
      return decision.type === "granted";
    });

  /**
   * Grants the waiting demand at the free fair head (note 6.3): true when the next candidate can be
   * asked, false when this tick should stop granting.
   */
  const grant = (demand: HandoffAdmission.Demand) =>
    (demand.kind === "effect" ? grantEffect(demand) : grantTurn(demand)).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.as(Effect.logWarning("A project assistant grant was deferred", cause), false),
      ),
    );

  /**
   * What each tick keeps straight of waiting work (note 6.3), before it grants anything: an
   * instance's first tick takes over what the one before it reserved, leases that ran out end, a
   * revoked root's waiting work stops being eligible, a root's blocked demands are checked again
   * when due, and a kept native wake whose demand is gone is dropped.
   */
  const maintain = Effect.gen(function* () {
    yield* Effect.gen(function* () {
      if (firstTickDone) return;
      const taken = yield* admission.firstTick;
      firstTickDone = true;
      for (const demand of taken) {
        yield* redelivery.redeliver(demand).pipe(deferred("redelivery"));
      }
    }).pipe(deferred("first tick"));
    yield* admission.expireLeases(redelivery.currency).pipe(deferred("lease check"));
    yield* Effect.gen(function* () {
      for (const { demand } of yield* admission.blockRevoked) {
        // Asked again, its delivery refuses the effect and blocks.
        if (demand.deliveryId !== null && demand.effectId !== null) {
          yield* factory.redispatch(demand.deliveryId, demand.effectId);
        }
      }
    }).pipe(deferred("revocation"));
    yield* Effect.gen(function* () {
      for (const root of yield* admission.blockedRoots()) {
        const [demand] = yield* admission.demands(root);
        const assignment =
          demand === undefined
            ? undefined
            : yield* admission.factoryAssignment(demand.assignmentId);
        if (assignment === undefined) continue;
        yield* admission.recheckBlocked({ root, work: yield* readWork(assignment.item) });
      }
    }).pipe(deferred("blocked check"));
    yield* admission.pruneKept.pipe(deferred("kept wake check"));
  });

  /**
   * The thread a question of the assignment is answered on, only for a pending live question of a
   * run of Factory's own that has not ended: answering any other could start a turn, or answer for
   * the owner. Refused with where to answer it.
   */
  const questionThread = (current: Portfolio.Assignment, requestId: RuntimeRequestId) =>
    Effect.gen(function* () {
      const assignment = yield* admission.factoryAssignment(current.assignmentId);
      const root = assignment?.deliveryId ?? null;
      if (root === null) {
        return yield* refusal("This assignment's Factory delivery has not started.");
      }
      const requests = yield* factory.requests(root).pipe(
        Effect.catchTags({
          HandoffFactoryError: () =>
            Effect.fail(refusal("The delivery's requests could not be read. Try again.")),
        }),
      );
      const request = requests.find((candidate) => candidate.requestId === requestId);
      if (request === undefined) {
        return yield* refusal(
          "This is not a pending question of this assignment. Permission approvals must use the thread's approval UI.",
        );
      }
      if (request.kind !== "user_input") {
        return yield* refusal(
          `Thread ${request.threadId} is asking for a permission decision. Open that thread's approval UI; question tools cannot grant permission.`,
        );
      }
      if (
        request.capability !== "live" ||
        request.run?.class !== "factory" ||
        isTerminalRunStatus(request.run.status)
      ) {
        return yield* refusal(
          `Only a live question of Factory's own running agent can be answered from here. Answer this one in thread ${request.threadId}.`,
        );
      }
      return request.threadId;
    });

  return {
    launch,
    reconcile,
    maintain,
    grant,
    questionThread,

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
     * assignment that has not ended uses. Reads that outlast these checks are answered by
     * `enterAuthorized`.
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
          work: { type: "read", fingerprint: input.read.fingerprint, status: input.read.status },
        } satisfies Authorized;
      }),

    /**
     * The link and queue position of a Factory assignment, in its enqueue's transaction, which
     * then judges the root's authority as a claim's does: the manager, brief, capture and project
     * as they stand now, with the read taken before it. Any of them can have changed while the
     * reads ran; failing here rolls back every row the enqueue wrote.
     */
    enterAuthorized: (assignmentId: string, { work, ...link }: Authorized) =>
      Effect.gen(function* () {
        yield* admission.createLink({ assignmentId, ...link });
        yield* admission.enterQueue(assignmentId);
        const category = yield* admission.authority(assignmentId, work);
        if (category !== undefined) {
          return yield* refusal(`Not queued: ${REFUSED_BECAUSE[category]}.`);
        }
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
