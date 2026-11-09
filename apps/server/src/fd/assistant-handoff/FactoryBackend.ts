import { type MessageId, ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { HandoffBackend } from "../assistant/index.ts";
import type { FactoryActivity } from "../factory/index.ts";
import {
  FactoryService,
  FactorySettings,
  isAdvancing,
  needsYou,
  ownerPendingActions,
  withRefusedTurns,
} from "../factory/index.ts";

type Refused = HandoffBackend.HandoffFactoryRefused;

const refused = (
  operation: Refused["operation"],
  reason: Refused["reason"],
  activeDeliveryId?: string,
) =>
  new HandoffBackend.HandoffFactoryRefused({
    operation,
    reason,
    ...(activeDeliveryId === undefined ? {} : { activeDeliveryId }),
  });

const failed = (operation: HandoffBackend.HandoffFactoryError["operation"]) => (cause: unknown) =>
  new HandoffBackend.HandoffFactoryError({ operation, cause });

/**
 * A start Factory refused before writing a row, and one whose outcome only a read of the id can
 * tell. Work failing for now is the latter: nothing was written, and the next pass asks again.
 */
const startFailure = (error: FactoryService.FactoryStartError) => {
  switch (error._tag) {
    case "FactoryDeliveryActive":
      return refused("start", "active", error.deliveryId);
    case "FactoryVerifyCommandMissingError":
      return refused("start", "not_configured");
    case "FactoryProjectMissingError":
      return refused("start", "project_missing");
    case "ThreadLaunchBaseRefError":
      return refused("start", "no_base_commit");
    case "FactoryBranchUnavailableError":
      return refused("start", "no_free_branch");
    case "FactoryParentSourceUnsupportedError":
      return refused("start", "unsupported_source");
    case "FactoryReviewedExecutionInvalidError":
      return refused("start", "reviewed_invalid");
    case "WorkItemNotFound":
    case "WorkSourceNotFound":
    case "WorkPermissionDenied":
    case "WorkInvalid":
    case "WorkUnsupported":
      return refused("start", "item_unavailable");
    default:
      return failed("start")(error);
  }
};

const deliveryOf = ({ deliveryId, state }: FactoryService.FactoryDeliveryWithRuns) => ({
  deliveryId,
  status: state.status,
});

/** The thread a delivery awaits, or else its latest author's. */
const openThread = ({ state }: FactoryService.FactoryDeliveryWithRuns) =>
  state.awaiting?.type === "run" ? state.awaiting.threadId : (state.threads.author ?? null);

/** The effect a delivery awaits, while it is marked waiting for admission. */
const markedEffect = ({ deliveryId, state }: FactoryService.FactoryDeliveryWithRuns) =>
  state.awaiting?.type === "effect" && state.admissionWait?.effectId === state.awaiting.effect.id
    ? [{ deliveryId, effectId: state.awaiting.effect.id }]
    : [];

const handoffRequest = (
  request: FactoryActivity.FactoryFamilyRequest,
): HandoffBackend.HandoffRequest => ({
  threadId: request.threadId,
  requestId: request.requestId,
  kind: request.kind,
  capability: request.capability,
  run: request.run,
  questions: request.questions,
  projectId: request.projectId,
  runtimeMode: request.runtimeMode,
  ...(request.reason === undefined ? {} : { reason: request.reason }),
});

/** The owner's review over Factory's service; see `HandoffReview`. */
export const makeReview = Effect.gen(function* () {
  const factory = yield* FactoryService.FactoryService;

  return HandoffBackend.HandoffReview.of({
    preview: (input) =>
      factory.previewReviewedExecution(input).pipe(Effect.mapError(failed("review"))),
    holds: (input) => factory.reviewedExecutionHolds(input),
    // As the assistant's resume picks it: the child a parent still running waits on, or else the root.
    atRest: (root) =>
      Effect.gen(function* () {
        const found = yield* factory.get(FactoryDeliveryId.make(root));
        if (Option.isNone(found)) return null;
        const { state } = found.value;
        const { awaiting } = state;
        const awaited =
          awaiting?.type === "child" && (state.status === "running" || state.status === "stopping")
            ? Option.getOrUndefined(yield* factory.get(awaiting.deliveryId))
            : undefined;
        const resumable = (status: string) =>
          status === "stopping" || status === "stopped" || status === "blocked";
        const picked =
          awaited !== undefined && resumable(awaited.state.status)
            ? awaited
            : resumable(state.status)
              ? found.value
              : undefined;
        if (picked === undefined) return null;
        const { status, effectsIssued } = picked.state;
        return status === "stopped" || status === "blocked"
          ? { deliveryId: picked.deliveryId, status, effectsIssued }
          : null;
      }).pipe(Effect.mapError(failed("review"))),
    // A parent's children hold copies, and it takes each one's next stage only once it stands under
    // the review; one approved or ended keeps what it ran under. The delivery to resume goes last,
    // so the resume it then owes means the whole family stands under the review. Which that is was
    // decided when the owner confirmed: judged again here, a repeat could hand the resume on.
    rebind: ({ root, execution, resume }) =>
      Effect.gen(function* () {
        const deliveryId = FactoryDeliveryId.make(root);
        const found = yield* factory.get(deliveryId);
        if (Option.isNone(found)) return yield* refused("rebind", "not_found");
        const children = (yield* Effect.forEach(found.value.state.children, factory.get)).flatMap(
          Option.toArray,
        );
        const resuming = FactoryDeliveryId.make(resume.deliveryId);
        const rebindOne = (target: FactoryDeliveryId) =>
          factory
            .rebindReviewed({
              deliveryId: target,
              execution,
              ...(target === resuming ? { resume: { effectsIssued: resume.effectsIssued } } : {}),
            })
            .pipe(
              // It stood before a later review replaced it: this asks for nothing it did not get.
              Effect.catchTags({
                FactoryReviewedRebindRefusedError: (error) =>
                  error.reason === "reused_receipt" ? Effect.void : Effect.fail(error),
              }),
            );
        for (const child of children) {
          const { status } = child.state;
          if (child.deliveryId === resuming) continue;
          if (status === "approved" || status === "done" || status === "cancelled") continue;
          yield* rebindOne(child.deliveryId);
        }
        if (deliveryId !== resuming) yield* rebindOne(deliveryId);
        yield* rebindOne(resuming);
      }).pipe(
        Effect.mapError((error) => {
          switch (error._tag) {
            case "HandoffFactoryRefused":
              return error;
            case "FactoryReviewedRebindRefusedError":
              return refused("rebind", "rebind_refused");
            case "FactoryDeliveryNotFoundError":
              return refused("rebind", "not_found");
            default:
              return failed("review")(error);
          }
        }),
      ),
    resumeOwed: ({ deliveryId, receiptId }) =>
      factory
        .get(FactoryDeliveryId.make(deliveryId))
        .pipe(
          Effect.map(
            Option.exists(
              ({ state }) =>
                state.reviewResumeOwed === receiptId &&
                state.status !== "done" &&
                state.status !== "cancelled",
            ),
          ),
          Effect.mapError(failed("review")),
        ),
  });
});

/** The assistant's Factory port over Factory's service; see `HandoffFactory`. */
export const make = Effect.gen(function* () {
  const factory = yield* FactoryService.FactoryService;
  const settings = yield* FactorySettings.FactorySettings;

  return HandoffBackend.HandoffFactory.of({
    verifyConfigured: (projectId) =>
      settings.requireDeliverySettings(projectId).pipe(
        Effect.as(true),
        Effect.catchTags({
          FactoryVerifyCommandMissingError: () => Effect.succeed(false),
          FactorySettingsStorageError: (cause) => Effect.fail(failed("verify")(cause)),
        }),
      ),
    get: (deliveryId) =>
      factory
        .get(FactoryDeliveryId.make(deliveryId))
        .pipe(Effect.map(Option.map(deliveryOf)), Effect.mapError(failed("get"))),
    start: ({ deliveryId, item, kind, runtimeModeCeiling, reviewedExecution }) =>
      factory
        .start({
          deliveryId: FactoryDeliveryId.make(deliveryId),
          itemRef: item,
          kind,
          runtimeModeCeiling,
          ...(reviewedExecution === undefined ? {} : { reviewedExecution }),
        })
        .pipe(Effect.map(deliveryOf), Effect.mapError(startFailure)),
    stop: (deliveryId) =>
      factory.stop(FactoryDeliveryId.make(deliveryId)).pipe(
        Effect.map(deliveryOf),
        Effect.mapError((error) => {
          switch (error._tag) {
            case "FactoryStopRefusedError":
              return refused("stop", "not_stoppable");
            case "FactoryDeliveryNotFoundError":
              return refused("stop", "not_found");
            default:
              return failed("stop")(error);
          }
        }),
      ),
    resume: (deliveryId, options) => {
      const id = FactoryDeliveryId.make(deliveryId);
      return (
        options?.owedBy === undefined
          ? factory.resume(id)
          : factory.resumeOwedByReview(id, options.owedBy)
      ).pipe(
        Effect.mapError((error) => {
          switch (error._tag) {
            case "FactoryResumeRefusedError":
              return refused("resume", "not_resumable");
            case "FactoryPullRequestUnknownError":
              return refused("resume", "pull_request_unknown");
            case "FactoryDeliveryNotFoundError":
              return refused("resume", "not_found");
            default:
              return failed("resume")(error);
          }
        }),
        Effect.flatMap((resumed) =>
          resumed === null
            ? Effect.fail(refused("resume", "not_owed"))
            : Effect.succeed(deliveryOf(resumed)),
        ),
      );
    },
    cancel: (deliveryId) =>
      factory.cancel(FactoryDeliveryId.make(deliveryId)).pipe(
        Effect.map(deliveryOf),
        Effect.mapError((error) => {
          switch (error._tag) {
            case "FactoryCancelRefusedError":
              return refused("cancel", "ended");
            case "FactoryDeliveryNotFoundError":
              return refused("cancel", "not_found");
            default:
              return failed("cancel")(error);
          }
        }),
      ),
    activity: (root) =>
      factory.activity(FactoryDeliveryId.make(root)).pipe(
        Effect.map(({ phase, busy, deferred, unknown }) => ({ phase, busy, deferred, unknown })),
        Effect.mapError(failed("activity")),
      ),
    follow: (root) =>
      Effect.gen(function* () {
        const found = yield* factory.get(FactoryDeliveryId.make(root));
        if (Option.isNone(found)) return Option.none();
        const delivery = found.value;
        const { state } = delivery;
        const children = (yield* Effect.forEach(state.children, factory.get)).flatMap(
          Option.toArray,
        );
        const { awaiting } = state;
        const child =
          awaiting?.type === "child"
            ? children.find(({ deliveryId }) => deliveryId === awaiting.deliveryId)
            : undefined;
        return Option.some({
          ...deliveryOf(delivery),
          stage: state.stage,
          awaiting: awaiting?.type ?? null,
          pullRequest:
            state.pullRequest === null
              ? null
              : { url: state.pullRequest.url, outcome: state.pullRequest.outcome ?? null },
          reason: needsYou(state) ?? null,
          proceeding: isAdvancing(state),
          threadId: openThread(delivery),
          child:
            child === undefined
              ? null
              : {
                  ...deliveryOf(child),
                  stage: child.state.stage,
                  reason: needsYou(child.state) ?? null,
                  threadId: openThread(child),
                },
          marked: [delivery, ...children].flatMap(markedEffect),
          // A parent blocked on its child's refused launch is that child's to show, and a turn the
          // host refused on the family's threads is the family's.
          ownerActions: withRefusedTurns(
            [delivery, ...(child === undefined ? [] : [child])].flatMap(ownerPendingActions),
            yield* factory.refusedTurnActions(delivery),
          ),
        });
      }).pipe(Effect.mapError(failed("follow"))),
    ensureDeferred: (deliveryId, effectId) =>
      factory
        .ensureDeferred(FactoryDeliveryId.make(deliveryId), effectId)
        .pipe(Effect.mapError(failed("deferral"))),
    redispatch: (deliveryId, effectId) =>
      factory
        .redispatch(FactoryDeliveryId.make(deliveryId), effectId)
        .pipe(Effect.mapError(failed("deferral"))),
    runStateOf: ({ threadId, messageId }) =>
      factory
        .turnRunState({ threadId: ThreadId.make(threadId), messageId: messageId as MessageId })
        .pipe(Effect.mapError(failed("runState"))),
    requests: (root) =>
      factory.familyRequests(FactoryDeliveryId.make(root)).pipe(
        Effect.map((requests) => requests.map(handoffRequest)),
        Effect.mapError(failed("requests")),
      ),
    pendingRequests: factory.pendingRequests.pipe(
      Effect.map(({ byDelivery, complete }) => ({
        byRoot: new Map(
          [...byDelivery].map(([root, requests]) => [root, requests.map(handoffRequest)]),
        ),
        complete,
      })),
      Effect.mapError(failed("requests")),
    ),
  });
});
