import {
  MessageId,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Effect from "effect/Effect";

import {
  type AutomaticTurn,
  AutomaticTurnDecisionError,
  notNow,
  ran,
} from "../../orchestration-v2/AutomaticTurnGate.ts";
import * as DelegatedTaskQuestionReactor from "../../orchestration-v2/DelegatedTaskQuestionReactor.ts";
import { HandoffAdmission, HandoffBackend } from "../assistant/index.ts";
import { FactoryAdmission } from "../factory/index.ts";

type Port = typeof FactoryAdmission.FactoryAdmission.Service;

/** The fresh read of a root's item a decision asked for; a failed or invalid read is a result. */
const readWorkWith =
  (backend: typeof HandoffBackend.HandoffBackend.Service) => (item: HandoffAdmission.ItemRef) =>
    backend.read(item).pipe(
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

/**
 * Factory's admission port over the project assistant's admission of the roots it manages (see
 * `HandoffAdmission`). Each Factory delivery's root is the assistant's managed root of the same id,
 * which names its assignment; a root the assistant never claimed is unmanaged, as Factory's
 * default port sees every root. A decision that would admit and needs the root's Work item read
 * again stops short and names the item: its read is taken here, outside any SQL transaction, and
 * the decision is made again with it. Admitted turns run inline in their producer's fiber, under
 * their admission; a native wake that waits is kept for its grant. Whatever the assistant cannot
 * decide fails as Factory and core's producers expect, deciding nothing.
 */
export const make = Effect.gen(function* () {
  const admission = yield* HandoffAdmission.HandoffAdmission;
  const backend = yield* HandoffBackend.HandoffBackend;

  const readWork = readWorkWith(backend);

  /** Runs `decide` once, and again with a fresh read when it asked for one. */
  const withWork = <X extends { readonly decision: { readonly type: string } }, E, R>(
    decide: (work: HandoffAdmission.WorkRead | undefined) => Effect.Effect<X, E, R>,
  ) =>
    Effect.gen(function* () {
      const first = yield* decide(undefined);
      if (!HandoffAdmission.needsWork(first.decision)) return first;
      return yield* decide(yield* readWork(first.decision.item));
    });

  const readFailed = (root: string) => (cause: HandoffAdmission.HandoffAdmissionError) =>
    new FactoryAdmission.FactoryAdmissionReadError({ root: root as never, cause });

  /** Never-managed roots never become managed: a root is claimed before its delivery exists. */
  const managed = (root: string) =>
    Effect.map(admission.management(root), (management) => management !== "never");

  const management: Port["management"] = (root) =>
    admission.management(root).pipe(
      // Factory routes an ending root as a retired one; the assistant decides from its own row.
      Effect.map((state) => (state === "ending" ? "retired" : state)),
      Effect.mapError(readFailed(root)),
    );

  const enter: Port["enter"] = (entry) =>
    Effect.gen(function* () {
      if (!(yield* managed(entry.root))) return { type: "proceed" } as const;
      // The effect's job is counted in Factory's activity before it asks, so its admission is
      // dispatched once the decision returns.
      const { decision } = yield* withWork((work) =>
        admission.dispatchAdmitted(
          admission.enter(
            {
              root: entry.root,
              deliveryId: entry.deliveryId,
              effectId: entry.effectId,
              fresh: entry.fresh,
            },
            work,
          ),
          () => Effect.void,
        ),
      );
      switch (decision.type) {
        case "proceed":
          return { type: "proceed" } as const;
        case "defer":
          return { type: "defer" } as const;
        case "refuse":
          return { type: "refuse", category: decision.category } as const;
        case "needs_work":
          return { type: "refuse", category: "unreadable" } as const;
      }
    }).pipe(Effect.mapError(readFailed(entry.root)));

  const authorizeOpening: Port["authorizeOpening"] = (opening) =>
    Effect.gen(function* () {
      if (!(yield* managed(opening.root))) return { type: "allow" } as const;
      const { decision } = yield* withWork((work) =>
        Effect.map(
          admission.authorizeOpening({
            root: opening.root,
            fingerprint: opening.fingerprint,
            status: opening.status,
            ...(opening.childScopeMatches === undefined
              ? {}
              : { childScopeMatches: opening.childScopeMatches }),
            ...(work === undefined ? {} : { work }),
          }),
          (decided) => ({ decision: decided }),
        ),
      );
      return decision.type === "allow"
        ? ({ type: "allow" } as const)
        : ({
            type: "refuse",
            category: decision.type === "refuse" ? decision.category : "unreadable",
          } as const);
    }).pipe(Effect.mapError(readFailed(opening.root)));

  const deferredDemand: Port["deferredDemand"] = (effect) =>
    admission.deferredDemand(effect).pipe(Effect.mapError(readFailed(effect.root)));

  const automaticTurn: Port["automaticTurn"] = (turn) => {
    const undecided = (cause: HandoffAdmission.HandoffAdmissionError) =>
      new AutomaticTurnDecisionError({
        kind: turn.turn.kind,
        thread: turn.turn.threadId,
        stage: "admission",
        cause,
      });
    const presented: AutomaticTurn = turn.turn;
    // A native wake that waits is kept, its failures logged, since nothing waits for it.
    const kept =
      turn.via === "hand"
        ? {
            dispatch: turn.dispatch.pipe(
              Effect.asVoid,
              Effect.catchCause((cause) =>
                Effect.logWarning("a kept native wake's dispatch failed", cause),
              ),
            ),
            ...(turn.drop === undefined ? {} : { drop: turn.drop }),
          }
        : undefined;
    return Effect.gen(function* () {
      const { decision, value } = yield* withWork((work) =>
        admission.dispatchAdmitted(
          admission
            .decideTurn({
              root: turn.root,
              provenance: turn.provenance,
              turn: presented,
              ...(work === undefined ? {} : { work }),
              ...(kept === undefined ? {} : { kept }),
            })
            .pipe(Effect.mapError(undecided)),
          () => turn.dispatch,
        ),
      );
      switch (decision.type) {
        case "admitted":
          if (value._tag === "Some") return ran(value.value);
          return yield* undecided(
            new HandoffAdmission.HandoffAdmissionError({
              operation: "dispatched",
              root: turn.root,
              cause: "The admitted turn returned nothing.",
            }),
          );
        case "unmanaged":
          return ran(yield* turn.dispatch);
        case "demand":
        case "blocked":
        case "needs_work":
        // Its dispatch already in flight runs it; this presentation runs nothing more.
        case "in_flight":
          return notNow("deferred");
        case "declined":
          // Only an offer that can be cleared is.
          if (decision.clear && turn.via === "hand" && turn.drop !== undefined) yield* turn.drop;
          return notNow("declined");
      }
    });
  };

  return FactoryAdmission.FactoryAdmission.of({
    management,
    enter,
    deferredDemand,
    authorizeOpening,
    automaticTurn,
  });
});

/**
 * The assistant's redelivery of reserved automatic turns (see `HandoffRedelivery`): a question
 * through the question reactor, a completion on the continuation worker's shared queue, a native
 * wake through the dispatch the assistant's admission kept.
 */
export const makeRedelivery = Effect.gen(function* () {
  const admission = yield* HandoffAdmission.HandoffAdmission;
  const readWork = readWorkWith(yield* HandoffBackend.HandoffBackend);
  const questions = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
  const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;

  const redeliver: (typeof HandoffBackend.HandoffRedelivery.Service)["redeliver"] = (demand) => {
    const failedAs =
      (kind: HandoffBackend.HandoffRedeliveryError["kind"]) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.mapError((cause) => new HandoffBackend.HandoffRedeliveryError({ kind, cause })),
        );
    switch (demand.kind) {
      case "delegated_question":
        if (demand.childThreadId === null || demand.requestId === null) {
          return admission.moot(demand.id).pipe(Effect.as("moot" as const), failedAs(demand.kind));
        }
        return questions
          .redeliver({
            childThreadId: ThreadId.make(demand.childThreadId),
            requestId: RuntimeRequestId.make(demand.requestId),
          })
          .pipe(
            Effect.flatMap((outcome) =>
              outcome === "moot"
                ? Effect.as(admission.moot(demand.id), "moot" as const)
                : Effect.succeed(outcome),
            ),
            failedAs(demand.kind),
          );
      case "delegated_completion":
        if (
          demand.threadId === null ||
          demand.providerThreadId === null ||
          demand.driver === null ||
          demand.parentRunId === null ||
          demand.generation === null ||
          demand.messageId === null
        ) {
          return admission.moot(demand.id).pipe(Effect.as("moot" as const), failedAs(demand.kind));
        }
        // The worker reads the cohort again before it dispatches, under the thread's lock.
        return requests
          .offer({
            threadId: ThreadId.make(demand.threadId),
            providerThreadId: ProviderThreadId.make(demand.providerThreadId),
            driver: ProviderDriverKind.make(demand.driver),
            detail: null,
            delegatedCompletion: {
              parentRunId: RunId.make(demand.parentRunId),
              generation: demand.generation,
              messageId: MessageId.make(demand.messageId),
            },
            delivery: "message_text",
          })
          .pipe(Effect.as("offered" as const));
      case "background_wake":
        // Admitted only once the root's authority and a fresh read of its item confirm it.
        return Effect.gen(function* () {
          const first = yield* admission.redeliverNative(demand.id);
          const outcome =
            first.type === "needs_work"
              ? yield* admission.redeliverNative(demand.id, yield* readWork(first.item))
              : first;
          switch (outcome.type) {
            case "dispatched":
            case "lost":
            case "blocked":
              return outcome.type;
            case "stale":
            case "needs_work":
              return "none" as const;
          }
        }).pipe(failedAs(demand.kind));
      case "pull_request_wake":
      case "usage_limit_resume":
      case "effect":
        return Effect.succeed("none" as const);
    }
  };

  return HandoffBackend.HandoffRedelivery.of({ redeliver });
});
