import { type MessageId, type RunId, ThreadId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { AutomaticTurn } from "../../orchestration-v2/AutomaticTurnGate.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as FactoryAdmission from "./FactoryAdmission.ts";
import * as FactoryOwnership from "./FactoryOwnership.ts";
import { launchThreadId } from "./FactoryThreadEffects.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import { type RunCreated, runCreated, WATCH_SYNC_COMMAND, wakeOf } from "./followThrough.ts";
import type { FactoryStoreError } from "./persistence/errors.ts";
import * as FactoryAutomaticTurnStore from "./persistence/FactoryAutomaticTurnStore.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import {
  type FactoryDeliveryState,
  followedThread,
  isProceeding,
  isTerminal,
  isTerminalRunStatus,
  ownsWake,
} from "./pipeline/state.ts";

/** Factory could not read whose work a thread carries, so nothing was decided for it. */
export class FactoryOwnershipReadError extends Schema.TaggedError<FactoryOwnershipReadError>()(
  "FactoryOwnershipReadError",
  { threadId: ThreadId, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Factory could not read whose work thread ${this.threadId} carries.`;
  }
}

/**
 * Where a root delivery's family is, as releasing its capacity and retiring it judge: `proceeding`
 * while Factory moves it on by itself, `parked` while it waits for its owner or its pull request,
 * `terminal` once done or cancelled, `missing` for an unknown delivery.
 */
export type FactoryActivityPhase = "proceeding" | "parked" | "terminal" | "missing";

/**
 * What a root delivery's family is doing. `busy`: a job of this process runs for it, or work on
 * its threads is under way or about to start that Factory cannot show to be the owner's. Threads
 * are read only once it is parked or terminal, the phases where that decides anything, so before
 * then `busy` counts jobs alone. `deferred`: an effect waits for admission with no job.
 * `backgroundWaits`: work its runs wait for that ends in an automatic turn (background tasks still
 * open, delegated cohorts not delivered), which is no work of the family's until that turn is
 * admitted. `unknown`: something could not be read, so the report says nothing is idle.
 */
export interface FactoryActivityReport {
  readonly phase: FactoryActivityPhase;
  readonly busy: boolean;
  readonly deferred: boolean;
  readonly backgroundWaits: number;
  readonly unknown: boolean;
}

/**
 * Reads whose work Factory's family threads carry (see `FactoryOwnership`), and what a root's
 * family is doing, from core's records, Factory's deliveries and the automatic turns Factory
 * recorded. Every read is strict and read-only: a failure fails a decision, and makes a report
 * `unknown`.
 */
export class FactoryActivity extends Context.Service<
  FactoryActivity,
  {
    /** The thread's family (see `FactoryOwnership.familyOf`); null for a thread of none. */
    readonly family: (
      threadId: ThreadId,
    ) => Effect.Effect<FactoryOwnership.FactoryFamily | null, FactoryOwnershipReadError>;
    /** The automatic turn's class on a family thread of `root`, from its exact source. */
    readonly classify: (
      turn: AutomaticTurn,
      root: FactoryDeliveryId,
    ) => Effect.Effect<FactoryOwnership.FactoryProvenance, FactoryOwnershipReadError>;
    /**
     * What the root's family is doing, read-only (see `FactoryActivityReport`). Fails only when
     * Factory's own deliveries cannot be read.
     */
    readonly activity: (
      root: FactoryDeliveryId,
    ) => Effect.Effect<FactoryActivityReport, FactoryStoreError>;
  }
>()("t3/fd/factory/FactoryActivity") {}

type ReadFailure =
  | ProjectionStore.ProjectionStoreV2Error
  | EventStore.EventStoreV2Error
  | CommandReceiptStore.CommandReceiptStoreV2Error
  | EffectOutbox.EffectOutboxError
  | FactoryStoreError
  | FactoryAdmission.FactoryAdmissionReadError;

/** `read`, keeping each key's result, so one decision or report reads each record once. */
const memoized = <K, A, E>(keyOf: (key: K) => string, read: (key: K) => Effect.Effect<A, E>) => {
  const results = new Map<string, { readonly value: A }>();
  return (key: K) =>
    Effect.suspend(() => {
      const id = keyOf(key);
      const kept = results.get(id);
      return kept === undefined
        ? Effect.tap(read(key), (value) => Effect.sync(() => results.set(id, { value })))
        : Effect.succeed(kept.value);
    });
};

/** A run whose provider turn may still start or go on: queued, held included, or under way. */
const isOpenRun = (status: string) => !isTerminalRunStatus(status);

/** Whose work a class names: anything not shown to be someone's own on purpose counts. */
const counts = (provenance: FactoryOwnership.FactoryProvenance) => provenance.class !== "explicit";

const idleReport = (phase: FactoryActivityPhase): FactoryActivityReport => ({
  phase,
  busy: false,
  deferred: false,
  backgroundWaits: 0,
  unknown: false,
});

/** Where the delivery itself is, by its own state; see `FactoryActivityPhase`. */
const ownPhase = (state: FactoryDeliveryState): FactoryActivityPhase => {
  if (isTerminal(state)) return "terminal";
  // Only a start moves a queued delivery on, and nothing waits on its owner before then.
  return state.status === "queued" || isProceeding(state) ? "proceeding" : "parked";
};

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* EventStore.EventStoreV2;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
  const turns = yield* FactoryAutomaticTurnStore.FactoryAutomaticTurnStore;
  const worker = yield* FactoryWorker.FactoryWorker;
  const admission = yield* FactoryAdmission.FactoryAdmission;

  /** A fresh set of strict reads for one decision or report. */
  const makeReads = () => {
    const delivery = memoized(String, (deliveryId: FactoryDeliveryId) =>
      deliveries.get(deliveryId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.map((stored) =>
          stored === undefined ? undefined : { parentId: stored.parentId, state: stored.state },
        ),
      ),
    );
    const lineage = memoized(String, (threadId: ThreadId) =>
      projections.getThreadRecords(threadId, []).pipe(
        Effect.map(({ thread }) => thread.lineage),
        Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.undefined }),
      ),
    );
    const thread = memoized(String, (threadId: ThreadId) =>
      projections
        .getThreadRecords(threadId, ["runs", "subagents", "providerThreads", "contextTransfers"])
        .pipe(
          Effect.map(
            ({
              thread: shell,
              runs,
              subagents,
              providerThreads,
              contextTransfers,
            }): FactoryOwnership.FamilyThread => ({
              lineage: shell.lineage,
              forkedFrom: shell.forkedFrom,
              contextTransfers,
              runs,
              subagents,
              providerThreads,
            }),
          ),
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.undefined }),
        ),
    );
    const message = memoized(
      ([threadId, messageId]: readonly [ThreadId, MessageId]) => `${threadId}\u0000${messageId}`,
      ([threadId, messageId]) =>
        projections.getThreadRecords(threadId, ["messages"], { messageIds: [messageId] }).pipe(
          Effect.map(({ messages }) => messages.find((candidate) => candidate.id === messageId)),
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.undefined }),
        ),
    );
    /** Each run's creation in the thread's log, which names the command that created it. */
    const runCreations = memoized(String, (threadId: ThreadId) =>
      events.read({ threadId, eventType: "run.created" }).pipe(
        Stream.runCollect,
        Effect.map(
          (stored) =>
            new Map<RunId, RunCreated>(
              stored.flatMap((event) => {
                const created = runCreated(event);
                return created === undefined ? [] : [[created.runId, created] as const];
              }),
            ),
        ),
      ),
    );
    const wake = (threadId: ThreadId, runId: RunId) =>
      Effect.gen(function* () {
        const created = (yield* runCreations(threadId)).get(runId);
        if (created === undefined) return undefined;
        const receipt = Option.getOrUndefined(yield* receipts.getByCommandId(created.commandId));
        if (receipt?.status !== "accepted" || receipt.commandType !== WATCH_SYNC_COMMAND) {
          return undefined;
        }
        const committed = yield* events
          .readByCommandId({ commandId: created.commandId })
          .pipe(Stream.runCollect);
        return wakeOf(created, receipt.commandType, committed);
      });
    const recorded = (threadId: ThreadId, messageId: MessageId) =>
      turns.get({ threadId, messageId }).pipe(
        Effect.map(
          Option.match({
            onNone: () => undefined,
            onSome: (decision): FactoryOwnership.FactoryProvenance =>
              decision.class === "factory"
                ? { class: "factory", root: decision.root }
                : { class: decision.class },
          }),
        ),
      );
    const management = memoized(String, (root: FactoryDeliveryId) => admission.management(root));
    const reads: FactoryOwnership.OwnershipReads<ReadFailure> = {
      delivery,
      lineage,
      thread,
      message: (threadId, messageId) => message([threadId, messageId]),
      wake,
      recorded,
      management,
    };
    return { ...reads, runCreations };
  };

  const readFailed = (threadId: ThreadId) => (cause: unknown) =>
    new FactoryOwnershipReadError({ threadId, cause });

  /**
   * Whether work on the family's threads is under way or about to start, and what its runs wait
   * for: every thread a family delivery's launch made (named by the launch's effect, numbered up
   * to the effects it issued) and every thread delegated from one, to `MAX_FAMILY_DEPTH` levels.
   */
  const probeThreads = (
    root: FactoryDeliveryId,
    owner: FactoryDeliveryState,
    family: ReadonlyArray<FactoryDeliveryStore.StoredFactoryDelivery>,
  ) =>
    Effect.gen(function* () {
      const reads = makeReads();
      const classes = FactoryOwnership.classifier(reads, root);
      let busy = false;
      let backgroundWaits = 0;
      const pending: Array<{
        readonly threadId: ThreadId;
        readonly parent: ThreadId | null;
        readonly depth: number;
      }> = family.flatMap(({ deliveryId, state }) =>
        Array.from({ length: state.effectsIssued }, (_, index) => ({
          threadId: launchThreadId(deliveryId, index + 1),
          parent: null,
          depth: 0,
        })),
      );
      const seen = new Set<ThreadId>();
      for (const { threadId, parent, depth } of pending) {
        if (seen.has(threadId)) continue;
        seen.add(threadId);
        const thread = yield* reads.thread(threadId);
        if (thread === undefined) continue;
        // A task's thread belongs to the family only as its lineage child.
        if (
          parent !== null &&
          (thread.lineage.relationshipToParent !== "subagent" ||
            thread.lineage.parentThreadId !== parent)
        ) {
          continue;
        }
        for (const task of thread.subagents) {
          if (task.childThreadId === null) continue;
          if (depth === FactoryOwnership.MAX_FAMILY_DEPTH) {
            return yield* new FactoryOwnership.FactoryFamilyDepthError({
              threadId: task.childThreadId,
            });
          }
          pending.push({ threadId: task.childThreadId, parent: threadId, depth: depth + 1 });
        }
        for (const run of thread.runs) {
          if (isOpenRun(run.status) && counts(yield* classes.run(threadId, run.id))) busy = true;
          if (
            run.delegatedCompletion?.disposition === "open" &&
            counts(yield* classes.run(threadId, run.id))
          ) {
            backgroundWaits += 1;
          }
        }
        // A restart cut the thread's latest run, and its continuation has yet to run or decline.
        const latest = thread.runs.reduce<(typeof thread.runs)[number] | undefined>(
          (last, run) => (last === undefined || run.ordinal > last.ordinal ? run : last),
          undefined,
        );
        if (
          latest !== undefined &&
          !isOpenRun(latest.status) &&
          counts(yield* classes.run(threadId, latest.id))
        ) {
          const continuation = yield* outbox.get(`effect:restart-continuation:${latest.id}`);
          if (
            Option.exists(
              continuation,
              (effect) => effect.status === "pending" || effect.status === "running",
            )
          ) {
            busy = true;
          }
        }
        for (const providerThread of thread.providerThreads) {
          if (
            (providerThread.pendingBackgroundTasks?.length ?? 0) > 0 &&
            counts(yield* classes.providerThread(threadId, providerThread.id))
          ) {
            backgroundWaits += 1;
          }
        }
      }
      // A wake of the root's own pull request that it has not taken yet: Factory takes it as a
      // round (or, cancelled, to stop it), whether its run still goes on or has already ended.
      const followed = followedThread(owner);
      const { followThrough } = owner;
      if (followed !== undefined && followThrough !== undefined) {
        for (const created of (yield* reads.runCreations(followed)).values()) {
          if (
            created.sequence <= followThrough.watchedAfter ||
            followThrough.runs.includes(created.runId)
          ) {
            continue;
          }
          const wake = yield* reads.wake(followed, created.runId);
          if (wake !== undefined && ownsWake(owner, wake)) busy = true;
        }
      }
      return { busy, backgroundWaits };
    });

  const activity: FactoryActivity["Service"]["activity"] = Effect.fn("FactoryActivity.activity")(
    function* (root) {
      const rootDelivery = Option.getOrUndefined(yield* deliveries.get(root));
      if (rootDelivery === undefined) return idleReport("missing");
      const children = yield* Effect.forEach(rootDelivery.state.children, (childId) =>
        deliveries.get(childId),
      );
      const family = [rootDelivery, ...children.flatMap(Option.toArray)];
      // A child the root names that is not stored: what it does cannot be read.
      const unreadChild = children.some(Option.isNone);
      const { awaiting } = rootDelivery.state;
      // A parent awaiting a child proceeds exactly when the child does. An approved or ended
      // child hands its parent its approval or its cancel by itself, so the parent proceeds then.
      const awaited =
        awaiting?.type === "child"
          ? family.find(({ deliveryId }) => deliveryId === awaiting.deliveryId)
          : undefined;
      const phase =
        awaited === undefined || isTerminal(rootDelivery.state)
          ? ownPhase(rootDelivery.state)
          : isTerminal(awaited.state) || awaited.state.status === "approved"
            ? "proceeding"
            : ownPhase(awaited.state);
      const jobs = yield* Effect.forEach(family, ({ deliveryId }) =>
        worker.jobsInFlight(deliveryId),
      );
      const deferred = family.some(({ state }, index) => {
        const effect = state.awaiting?.type === "effect" ? state.awaiting.effect : undefined;
        return (
          effect !== undefined && state.admissionWait?.effectId === effect.id && jobs[index] === 0
        );
      });
      const report: FactoryActivityReport = {
        phase,
        busy: jobs.some((count) => count > 0),
        deferred,
        backgroundWaits: 0,
        unknown: unreadChild || (awaiting?.type === "child" && awaited === undefined),
      };
      if (phase !== "parked" && phase !== "terminal") return report;
      return yield* probeThreads(rootDelivery.parentId ?? root, rootDelivery.state, family).pipe(
        Effect.map(({ busy, backgroundWaits }) => ({
          ...report,
          busy: report.busy || busy,
          backgroundWaits,
        })),
        Effect.orElseSucceed(() => ({ ...report, unknown: true })),
      );
    },
  );

  return FactoryActivity.of({
    family: (threadId) =>
      FactoryOwnership.familyOf(makeReads(), threadId).pipe(Effect.mapError(readFailed(threadId))),
    classify: (turn, root) =>
      FactoryOwnership.classifier(makeReads(), root)
        .turn(turn)
        .pipe(Effect.mapError(readFailed(turn.threadId))),
    activity,
  });
});

/** The service over the readers of core's records its context holds. */
export const layerOverReaders = Layer.effect(FactoryActivity, make);

/**
 * The service over its own readers of core's projections, event log, command receipts and effect
 * outbox, on the server's SQL client, so it needs nothing of the orchestration runtime.
 */
export const layer = layerOverReaders.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectionStore.layer,
      EventStore.layer,
      CommandReceiptStore.layer,
      EffectOutbox.layer,
    ),
  ),
);
