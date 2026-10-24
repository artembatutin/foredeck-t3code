import { type FactoryDeliveryId, FactoryStageName } from "@t3tools/contracts/fd/factory";
import { type DrainableWorker, makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as TxRef from "effect/TxRef";

import type * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import { readBranchFacts } from "./git/branchFacts.ts";
import { evaluateSettle } from "./git/settle.ts";
import { FactoryStoreError } from "./persistence/errors.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import { advance } from "./pipeline/engine.ts";
import type {
  FactoryDeliveryState,
  FactoryEffect,
  FactoryEvent,
  FactorySettleResult,
} from "./pipeline/state.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";

/** The delivery has nothing to run for the stage: only verify has a command, run in the worktree. */
class FactoryStageCommandError extends Schema.TaggedError<FactoryStageCommandError>()(
  "FactoryStageCommandError",
  { stage: FactoryStageName },
) {
  override get message(): string {
    return `Factory has no command to run for stage ${this.stage} of this delivery.`;
  }
}

/**
 * Drives deliveries through the pure engine. A step folds one event into the stored delivery,
 * stores the new state with its stage attempts, then queues the effects the engine returned;
 * each effect's result (or failure) is fed back as the delivery's next step.
 */
export class FactoryWorker extends Context.Service<
  FactoryWorker,
  {
    /**
     * Folds `event` into the stored delivery and queues the returned effects once the result is
     * stored. Steps of one delivery run one at a time. An event the delivery does not await
     * writes nothing; an unknown delivery returns none and nothing runs.
     */
    readonly step: (
      deliveryId: FactoryDeliveryId,
      event: FactoryEvent,
    ) => Effect.Effect<
      Option.Option<FactoryDeliveryStore.StoredFactoryDelivery>,
      FactoryStoreError
    >;
    /** Resolves once every queued effect and every step its result fed back have finished. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/fd/factory/FactoryWorker") {}

/** An effect to carry out, with the delivery as stored when it was issued. */
interface Job {
  readonly delivery: FactoryDeliveryStore.StoredFactoryDelivery;
  readonly effect: FactoryEffect;
}

const describeEffect = (effect: FactoryEffect) => {
  switch (effect.type) {
    case "launch_thread":
      return `launch the ${effect.role} thread`;
    case "send_fix_commit_turn":
      return "send the fix-commit turn";
    case "check_settle":
      return "check the branch";
    case "run_command":
      return `run the ${effect.stage} command`;
  }
};

const SAFE_TAG = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/**
 * The `effect.failed` detail: what failed and the failure's tag. Never its message or cause,
 * which can carry command output or provider text.
 */
const failureDetail = (effect: FactoryEffect, cause: Cause.Cause<unknown>) => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  const tag = typeof error === "object" && error !== null && "_tag" in error ? error._tag : null;
  const kind = typeof tag === "string" && SAFE_TAG.test(tag) ? tag : "unexpected error";
  return `Factory could not ${describeEffect(effect)} (${kind}).`;
};

/** A branch that cannot be read never settles; the problem names only the path and operation. */
const unreadable = (problem: string): FactorySettleResult => ({
  status: "unrepairable",
  problems: [problem],
});

/** How an attempt ends when its delivery stops running in `state`. */
const outcomeOf = (state: FactoryDeliveryState): FactoryStageRunStore.FactoryStageOutcome => {
  if (state.status === "blocked") {
    return state.block?.reason === "verify_failed" ? "failed" : "blocked";
  }
  return state.status === "cancelled" ? "cancelled" : "passed";
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
  const stageRuns = yield* FactoryStageRunStore.FactoryStageRunStore;
  const settings = yield* FactorySettings.FactorySettings;
  const verifyRunner = yield* FactoryVerifyRunner.FactoryVerifyRunner;
  const threads = yield* FactoryThreadEffects.FactoryThreadEffects;
  const gitContext = yield* Effect.context<FileSystem.FileSystem | GitVcsDriver.GitVcsDriver>();
  const scope = yield* Effect.scope;
  const locks = yield* KeyedLock.make<FactoryDeliveryId>();
  // One drainable worker per delivery: a delivery's effects run in order, and one delivery's
  // long verify command never holds up another's. Lanes are tiny and bounded by the deliveries
  // stepped since the server started.
  const lanes = new Map<FactoryDeliveryId, DrainableWorker<Job>>();
  // Effects queued or running on any lane, each counted until the step its result fed back has
  // finished. That step queues its follow-ups first, so a chain never reads as idle midway, and
  // a delivery stepped while a drain waits is counted too.
  const outstanding = yield* TxRef.make(0);
  // Runs after every lane's finalizer: effects dropped at shutdown never finish, and a drain
  // must not wait for them.
  yield* Effect.addFinalizer(() => TxRef.set(outstanding, 0));

  const checkSettle = (state: FactoryDeliveryState): Effect.Effect<FactorySettleResult> => {
    const { worktreePath, baseline } = state;
    if (worktreePath === null || baseline === null) {
      return Effect.succeed(unreadable("The delivery has no recorded worktree and baseline."));
    }
    return readBranchFacts({ worktreePath, baselineSha: baseline }).pipe(
      Effect.map((facts): FactorySettleResult => {
        const evaluation = evaluateSettle(facts, state.branch);
        return evaluation.status === "settled"
          ? evaluation
          : {
              status: evaluation.status,
              problems: evaluation.problems.map((problem) => problem.description),
            };
      }),
      Effect.catchTags({
        FactoryWorktreeMissingError: (error) => Effect.succeed(unreadable(error.message)),
        FactoryBranchReadError: (error) => Effect.succeed(unreadable(error.message)),
      }),
      Effect.provideContext(gitContext),
    );
  };

  const runCommand = (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
    stage: FactoryStageName,
  ) =>
    Effect.gen(function* () {
      const { worktreePath } = delivery.state;
      if (stage !== "verify" || worktreePath === null) {
        return yield* new FactoryStageCommandError({ stage });
      }
      // Read when the command runs, not when the delivery started: a verify command removed
      // since then fails the effect before anything runs.
      const runSettings = yield* settings.requireDeliverySettings(delivery.projectId);
      return yield* verifyRunner.run({
        deliveryId: delivery.deliveryId,
        worktreePath,
        settings: runSettings,
      });
    });

  /** Carries out one effect and returns the event that answers it. Every failure is tagged. */
  const execute = ({
    delivery,
    effect,
  }: Job): Effect.Effect<FactoryEvent, { readonly _tag: string }> => {
    switch (effect.type) {
      case "launch_thread":
        return threads.launchThread(delivery, effect).pipe(
          Effect.map((launch): FactoryEvent => ({
            type: "thread.launched",
            effectId: effect.id,
            ...launch,
          })),
        );
      case "send_fix_commit_turn":
        return threads.sendFixCommitTurn(delivery, effect).pipe(
          Effect.map(({ runId }): FactoryEvent => ({
            type: "turn.started",
            effectId: effect.id,
            runId,
          })),
        );
      case "check_settle":
        return checkSettle(delivery.state).pipe(
          Effect.map((result): FactoryEvent => ({
            type: "settle.checked",
            effectId: effect.id,
            result,
          })),
        );
      case "run_command":
        return runCommand(delivery, effect.stage).pipe(
          Effect.map((outcome): FactoryEvent => ({
            type: "command.finished",
            effectId: effect.id,
            outcome,
          })),
        );
    }
  };

  /**
   * Records the stage attempts a step implies. Leaving a stage finishes its active attempt:
   * passed when the delivery advanced, otherwise by how it stopped running. Entering one
   * appends the next attempt, and the attempt carries the run the delivery now awaits.
   */
  const recordAttempts = Effect.fn("FactoryWorker.recordAttempts")(function* (
    deliveryId: FactoryDeliveryId,
    before: FactoryDeliveryState,
    after: FactoryDeliveryState,
    evidencePath: string | undefined,
  ) {
    const stopped = after.status !== "running";
    const advanced = after.stage !== before.stage;
    let active = (yield* stageRuns.listByDelivery(deliveryId)).findLast(
      (run) => run.outcome === null && run.stage === before.stage,
    );
    const attemptOf = (run: FactoryStageRunStore.StoredFactoryStageRun) => ({
      deliveryId,
      stage: run.stage,
      attempt: run.attempt,
    });

    if (active !== undefined && before.status === "running" && (advanced || stopped)) {
      yield* stageRuns.finish({
        ...attemptOf(active),
        outcome: advanced ? "passed" : outcomeOf(after),
        ...(evidencePath === undefined ? {} : { evidencePath }),
      });
      active = undefined;
    }
    if (after.stage !== null && advanced) {
      active = yield* stageRuns.append({ deliveryId, stage: after.stage });
      if (stopped) {
        yield* stageRuns.finish({ ...attemptOf(active), outcome: outcomeOf(after) });
        active = undefined;
      }
    }
    const { awaiting } = after;
    if (
      active !== undefined &&
      awaiting?.type === "run" &&
      (before.awaiting?.type !== "run" || before.awaiting.runId !== awaiting.runId)
    ) {
      yield* stageRuns.assignRun({
        ...attemptOf(active),
        threadId: awaiting.threadId,
        runId: awaiting.runId,
      });
    }
  });

  const stepLocked = Effect.fn("FactoryWorker.step")(function* (
    deliveryId: FactoryDeliveryId,
    event: FactoryEvent,
  ) {
    const current = yield* deliveries.get(deliveryId);
    if (Option.isNone(current)) return current;
    const before = current.value.state;
    const next = advance(before, event);
    // The engine hands back the very same state for an event the delivery does not await.
    if (next.delivery === before && next.effects.length === 0) return current;

    const evidencePath = event.type === "command.finished" ? event.outcome.evidencePath : undefined;
    const stored = yield* deliveries.update(deliveryId, next.delivery).pipe(
      Effect.tap((updated) =>
        Option.isSome(updated)
          ? recordAttempts(deliveryId, before, next.delivery, evidencePath)
          : Effect.void,
      ),
      sql.withTransaction,
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.fail(new FactoryStoreError({ operation: "worker.step", cause })),
      }),
    );
    // Queued only now: an effect never starts before the state that issued it is stored.
    if (Option.isSome(stored) && next.effects.length > 0) {
      const lane = yield* laneFor(deliveryId);
      for (const effect of next.effects) {
        yield* TxRef.update(outstanding, (count) => count + 1);
        yield* lane.enqueue({ delivery: stored.value, effect });
      }
    }
    return stored;
  });

  const step: FactoryWorker["Service"]["step"] = (deliveryId, event) =>
    locks.withLock(deliveryId, stepLocked(deliveryId, event));

  /**
   * Runs an effect and feeds its result back. Suspended, so an executor that throws while
   * building its effect fails the effect like any other failure. Interruption (shutdown) feeds
   * nothing.
   */
  const runJob = (job: Job) =>
    Effect.suspend(() => execute(job)).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.succeed<FactoryEvent>({
              type: "effect.failed",
              effectId: job.effect.id,
              detail: failureDetail(job.effect, cause),
            }),
      ),
      Effect.flatMap((event) => step(job.delivery.deliveryId, event)),
      Effect.ensuring(TxRef.update(outstanding, (count) => count - 1)),
    );

  // Called only under the delivery's lock, so a delivery never gets two lanes.
  const laneFor = (deliveryId: FactoryDeliveryId) =>
    Effect.suspend(() => {
      const existing = lanes.get(deliveryId);
      if (existing !== undefined) return Effect.succeed(existing);
      return makeDrainableWorker(runJob).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.tap((lane) => Effect.sync(() => lanes.set(deliveryId, lane))),
      );
    });

  return FactoryWorker.of({
    step,
    drain: TxRef.get(outstanding).pipe(
      Effect.flatMap((count) => (count > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    ),
  });
});

export const layer = Layer.effect(FactoryWorker, make);
