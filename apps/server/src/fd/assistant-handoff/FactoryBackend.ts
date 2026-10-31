import { type MessageId, ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { HandoffBackend } from "../assistant/index.ts";
import { FactoryService, FactorySettings, needsYou } from "../factory/index.ts";

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
    start: ({ deliveryId, item, kind, runtimeModeCeiling }) =>
      factory
        .start({
          deliveryId: FactoryDeliveryId.make(deliveryId),
          itemRef: item,
          kind,
          runtimeModeCeiling,
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
    resume: (deliveryId) =>
      factory.resume(FactoryDeliveryId.make(deliveryId)).pipe(
        Effect.map(deliveryOf),
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
      ),
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
        Effect.map((requests) =>
          requests.map((request) => ({
            threadId: request.threadId,
            requestId: request.requestId,
            kind: request.kind,
            capability: request.capability,
            run: request.run,
            questions: request.questions,
          })),
        ),
        Effect.mapError(failed("requests")),
      ),
  });
});
