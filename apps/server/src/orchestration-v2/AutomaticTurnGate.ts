import {
  type MessageId,
  type NodeId,
  type ProviderDriverKind,
  type ProviderThreadId,
  type RunId,
  type RuntimeRequestId,
  ThreadId,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

const AUTOMATIC_TURN_KINDS = [
  "pull_request_wake",
  "restart_continuation",
  "usage_limit_resume",
  "delegated_question",
  "delegated_completion",
  "background_wake",
] as const;

interface Presentation {
  readonly threadId: ThreadId;
  /** The message the turn starts from. A producer presents one turn under one id, retries included. */
  readonly messageId: MessageId;
  /** Tells this turn apart from others of its kind; each kind says what it is. */
  readonly key: string;
}

/** A pull request watch's wake. Keyed by the pull request's URL. */
export interface PullRequestWakeTurn extends Presentation {
  readonly kind: "pull_request_wake";
  readonly pullRequest: ThreadPullRequestKey & { readonly url: string };
  /** When the watch whose sync carries the wake started. */
  readonly watchStartedAt: string;
  /** Why the wake's sync would end the watch, or null when watching goes on. */
  readonly ending: "unreadable" | "closed" | "comment-limit" | null;
}

/** A restart's continuation of the run it cut. Keyed by that run. */
export interface RestartContinuationTurn extends Presentation {
  readonly kind: "restart_continuation";
  readonly sourceRunId: RunId;
  /** The source settled before the restart and is woken only for awaited work it lost. */
  readonly settled: boolean;
}

/** A usage-limit resume. Keyed by its command id. */
export interface UsageLimitResumeTurn extends Presentation {
  readonly kind: "usage_limit_resume";
  readonly usageLimitContinuationOfRunId: RunId;
}

/** A wake telling a delegating thread its child asked a question. Keyed `child:request`. */
export interface DelegatedQuestionTurn extends Presentation {
  readonly kind: "delegated_question";
  readonly childThreadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly taskId: NodeId;
  /** The run that delegated the task, when the task records one. */
  readonly delegatingRunId: RunId | null;
}

/** A delegated cohort's result delivery. Keyed `parentRun:generation:message`. */
export interface DelegatedCompletionTurn extends Presentation {
  readonly kind: "delegated_completion";
  readonly parentRunId: RunId;
  readonly generation: number;
  readonly providerThreadId: ProviderThreadId;
  readonly driver: ProviderDriverKind;
  /** A continuation offer, or a steer whose target turn completed first. */
  readonly origin: "offer" | "steer";
}

/** A provider-native background wake. Keyed by its message id. */
export interface BackgroundWakeTurn extends Presentation {
  readonly kind: "background_wake";
  readonly providerThreadId: ProviderThreadId;
  readonly driver: ProviderDriverKind;
  /** The adapter's offer can be cleared, so a declined wake can drop it. */
  readonly clearable: boolean;
}

/**
 * A run core would start on its own: no person or agent sent it now. Each kind carries the
 * exact source it continues, never a guess from neighbouring runs or timestamps.
 */
export type AutomaticTurn =
  | PullRequestWakeTurn
  | RestartContinuationTurn
  | UsageLimitResumeTurn
  | DelegatedQuestionTurn
  | DelegatedCompletionTurn
  | BackgroundWakeTurn;

/**
 * What became of a consult. `Ran` dispatched it and holds the dispatch's result. `NotNow` ran
 * nothing: `deferred` may run later through the turn's producer, `declined` never will.
 */
export type AutomaticTurnOutcome<A> =
  | { readonly _tag: "Ran"; readonly value: A }
  | { readonly _tag: "NotNow"; readonly reason: "deferred" | "declined" };

export const ran = <A>(value: A): AutomaticTurnOutcome<A> => ({ _tag: "Ran", value });

export const notNow = (reason: "deferred" | "declined"): AutomaticTurnOutcome<never> => ({
  _tag: "NotNow",
  reason,
});

/**
 * The gate could not decide whether the turn may run, so nothing was dispatched. Its producer
 * asks again by its own means: the next sweep, an outbox retry or a re-offer.
 */
export class AutomaticTurnDecisionError extends Schema.TaggedError<AutomaticTurnDecisionError>()(
  "AutomaticTurnDecisionError",
  {
    kind: Schema.Literals(AUTOMATIC_TURN_KINDS),
    thread: ThreadId,
    stage: Schema.Literals(["read", "record", "admission"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not decide whether the ${this.kind} on thread ${this.thread} may run (${this.stage}).`;
  }
}

/**
 * Where every automatic turn asks before it runs. A producer hands over the dispatch that
 * starts the turn: `admit` runs it inline when admitted and otherwise runs nothing; `hand`,
 * for native wakes, whose provider output exists only in memory, also lets the gate keep the
 * dispatch to run later, or to `drop`, which clears the adapter's offer and exists only when the
 * offer can be cleared. A kept dispatch is fully provided and checks on its own that its thread
 * and offer are still current when it runs.
 *
 * The default runs every turn inline, as core does without the gate.
 */
export class AutomaticTurnGate extends Context.Reference<{
  readonly admit: <A, E, R>(
    turn: Exclude<AutomaticTurn, BackgroundWakeTurn>,
    dispatch: Effect.Effect<A, E, R>,
  ) => Effect.Effect<AutomaticTurnOutcome<A>, E | AutomaticTurnDecisionError, R>;
  readonly hand: <A, E>(
    turn: BackgroundWakeTurn,
    dispatch: Effect.Effect<A, E>,
    options: { readonly drop?: Effect.Effect<void> },
  ) => Effect.Effect<AutomaticTurnOutcome<A>, E | AutomaticTurnDecisionError>;
}>("t3/orchestration-v2/AutomaticTurnGate", {
  defaultValue: () => ({
    admit: (_turn, dispatch) => Effect.map(dispatch, ran),
    hand: (_turn, dispatch) => Effect.map(dispatch, ran),
  }),
}) {}

/** Installs the implementation behind `layerInstallable`'s gate. */
export class AutomaticTurnGateInstaller extends Context.Service<
  AutomaticTurnGateInstaller,
  {
    /**
     * Routes every consult to `gate` until the scope closes. The latest install wins; once it
     * is uninstalled, consults wait for the next.
     */
    readonly install: (
      gate: typeof AutomaticTurnGate.Service,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/orchestration-v2/AutomaticTurnGate/AutomaticTurnGateInstaller") {}

/**
 * One gate for producers built before its implementation: consults wait until something
 * installs one, and wait again once it is uninstalled, so no turn runs ungoverned meanwhile.
 */
export const layerInstallable = Layer.effectContext(
  Effect.gen(function* () {
    const installed = yield* Ref.make(yield* Deferred.make<typeof AutomaticTurnGate.Service>());
    const current = Effect.flatMap(Ref.get(installed), Deferred.await);
    const gate = AutomaticTurnGate.of({
      admit: (turn, dispatch) => Effect.flatMap(current, (impl) => impl.admit(turn, dispatch)),
      hand: (turn, dispatch, options) =>
        Effect.flatMap(current, (impl) => impl.hand(turn, dispatch, options)),
    });
    const install: AutomaticTurnGateInstaller["Service"]["install"] = (impl) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const waiting = yield* Ref.get(installed);
          if (yield* Deferred.succeed(waiting, impl)) return waiting;
          const replacement = yield* Deferred.make<typeof AutomaticTurnGate.Service>();
          yield* Deferred.succeed(replacement, impl);
          yield* Ref.set(installed, replacement);
          return replacement;
        }),
        (mine) =>
          Effect.flatMap(Deferred.make<typeof AutomaticTurnGate.Service>(), (next) =>
            Ref.update(installed, (holder) => (holder === mine ? next : holder)),
          ),
      ).pipe(Effect.asVoid);
    return Context.make(AutomaticTurnGate, gate).pipe(
      Context.add(AutomaticTurnGateInstaller, AutomaticTurnGateInstaller.of({ install })),
    );
  }),
);
