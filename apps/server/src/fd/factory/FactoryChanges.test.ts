import { assert, describe, it } from "@effect/vitest";
import type { FactoryCommand } from "@t3tools/contracts/fd/factory";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as FactoryChanges from "./FactoryChanges.ts";
import * as Factory from "./index.ts";
import type { StoredFactoryDelivery } from "./persistence/FactoryDeliveryStore.ts";
import { acceptedReview } from "./pipeline/state.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  ended,
  runReached,
  verifyCommands,
  withProject,
} from "./testkit/deliveryHarness.ts";

const passingReview = {
  verdict: "pass",
  findings: [],
  acceptance: [
    {
      criterion: 1,
      status: "verified",
      evidence: "The export module is committed.",
      paths: ["export.ts"],
    },
  ],
  missing_evidence: [],
};

/** What a client read when it refetched on one epoch value. */
interface Read {
  readonly epoch: number;
  readonly delivery: StoredFactoryDelivery | undefined;
  readonly verifyCommand: FactoryCommand | null;
}

const awaitedRun = (delivery: StoredFactoryDelivery | undefined) => {
  const awaiting = delivery?.state.awaiting;
  return awaiting?.type === "run" ? awaiting : undefined;
};

describe("Factory delivery changes", () => {
  it.live("move the epoch after each stored delivery or settings write, never for a refusal", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const service = yield* Factory.FactoryService.FactoryService;
        const settings = yield* Factory.FactorySettings.FactorySettings;
        /** The epoch now: a new subscription's first value. */
        const current = service.subscribe.pipe(Stream.runHead, Effect.map(Option.getOrThrow));

        // A client: on every value, it refetches the project's newest delivery and its settings.
        const reads = yield* Queue.unbounded<Read>();
        yield* service.subscribe.pipe(
          Stream.runForEach((epoch) =>
            Effect.gen(function* () {
              const [newest] = yield* service.list({ projectId: world.projectId });
              const delivery =
                newest === undefined ? undefined : yield* service.get(newest.deliveryId);
              const { verifyCommand } = yield* settings.get(world.projectId);
              yield* Queue.offer(reads, {
                epoch,
                delivery: delivery === undefined ? undefined : Option.getOrUndefined(delivery),
                verifyCommand,
              });
            }),
          ),
          Effect.orDie,
          Effect.forkChild,
        );
        /** The client's reads through the value `epoch`, in order, once it has seen it. */
        const readsThrough = (epoch: number) =>
          Effect.gen(function* () {
            const taken: Array<Read> = [];
            let read: Read;
            do {
              read = yield* Queue.take(reads);
              taken.push(read);
            } while (read.epoch < epoch);
            assert.strictEqual(read.epoch, epoch);
            return taken;
          });
        // Subscribed before this test writes anything; the project's setup set its settings.
        const configured = yield* settings.get(world.projectId);
        const initial = yield* current;
        assert.deepStrictEqual(yield* readsThrough(initial), [
          { epoch: initial, delivery: undefined, verifyCommand: configured.verifyCommand },
        ]);

        // A settings write moves it, and the client's refetch reads the stored settings.
        yield* settings.set(world.projectId, { ...configured, verifyCommand: null });
        assert.strictEqual(yield* current, initial + 1);
        assert.isNull((yield* readsThrough(initial + 1))[0]?.verifyCommand);
        // A start refused for the missing verify command, and a refused settings write, move nothing.
        const noVerify = yield* Effect.flip(service.start({ itemRef: world.itemRef }));
        assert.strictEqual(noVerify._tag, "FactoryVerifyCommandMissingError");
        const noPipeline = yield* Effect.flip(
          settings.set(world.projectId, { ...configured, pipelineId: "unknown" }),
        );
        assert.strictEqual(noPipeline._tag, "FactoryUnknownPipelineError");
        assert.strictEqual(yield* current, initial + 1);
        yield* settings.set(world.projectId, configured);
        const configuredAgain = initial + 2;
        assert.strictEqual(yield* current, configuredAgain);
        assert.deepStrictEqual(
          (yield* readsThrough(configuredAgain))[0]?.verifyCommand,
          configured.verifyCommand,
        );

        // The queued row, the running state and the author launch's result are three commits.
        const author = yield* world.start;
        const launched = configuredAgain + 3;
        assert.strictEqual(yield* current, launched);
        const started = yield* readsThrough(launched);
        assert.deepStrictEqual(
          started.map(({ epoch }) => epoch),
          [configuredAgain + 1, configuredAgain + 2, launched],
        );
        // Every refetch finds the delivery, the first one included.
        for (const { delivery } of started) {
          assert.strictEqual(delivery?.deliveryId, author.deliveryId);
        }
        assert.strictEqual(started.at(-1)?.delivery?.state.status, "running");
        assert.strictEqual(awaitedRun(started.at(-1)?.delivery)?.runId, author.runId);

        // The author's run ends; the step that takes it, and each one after it, moves the epoch.
        yield* authorCommits(author.worktreePath, "feat: add the export button");
        assert.strictEqual(yield* current, launched);
        assert.strictEqual(yield* world.endRun(author.runId, "completed"), "completed");
        const reviewing = yield* current;
        assert.isAbove(reviewing, launched);
        const verified = yield* readsThrough(reviewing);
        assert.strictEqual(verified[0]?.epoch, launched + 1);
        for (const { delivery } of verified) {
          assert.notStrictEqual(awaitedRun(delivery)?.runId, author.runId);
        }
        const review = verified.at(-1)?.delivery;
        assert.strictEqual(review?.state.status, "running");
        assert.strictEqual(review?.state.stage, "review");
        const reviewer = awaitedRun(review);
        if (reviewer === undefined) return assert.fail("The reviewer is not running.");
        assert.strictEqual(yield* runReached(reviewer.runId, ["starting", ...ended]), "starting");
        yield* drainOrchestration;
        assert.strictEqual(yield* current, reviewing);

        // A second start of the active item is refused inside the insert's transaction.
        const active = yield* Effect.flip(service.start({ itemRef: world.itemRef }));
        assert.strictEqual(active._tag, "FactoryDeliveryActive");
        assert.strictEqual(yield* current, reviewing);

        /** Runs one control and returns the one read its write moved the epoch to. */
        const control = (run: Effect.Effect<StoredFactoryDelivery, { readonly _tag: string }>) =>
          Effect.gen(function* () {
            const before = yield* current;
            const stored = yield* run;
            assert.strictEqual(yield* current, before + 1);
            const [read] = yield* readsThrough(before + 1);
            assert.deepStrictEqual(read?.delivery, stored);
            return stored;
          });

        assert.strictEqual(
          (yield* control(service.stop(author.deliveryId))).state.status,
          "stopping",
        );
        assert.strictEqual(
          (yield* control(service.resume(author.deliveryId))).state.status,
          "running",
        );
        // A review submission is a delivery write like any step.
        const submitted = yield* control(
          service
            .submitReview({ threadId: reviewer.threadId, review: passingReview })
            .pipe(
              Effect.flatMap(({ deliveryId }) =>
                service.get(deliveryId).pipe(Effect.map(Option.getOrThrow)),
              ),
            ),
        );
        assert.isDefined(acceptedReview(submitted.state));
        const cancelled = yield* control(service.cancel(author.deliveryId));
        assert.strictEqual(cancelled.state.status, "cancelled");

        // The reviewer's run, interrupted by the cancel, ends without changing the delivery.
        yield* drainOrchestration;
        assert.include(ended, yield* world.endRun(reviewer.runId, "completed"));
        yield* drainFactory;
        const settled = yield* current;

        // Refused controls of the cancelled delivery move nothing.
        assert.strictEqual(
          (yield* Effect.flip(service.stop(author.deliveryId)))._tag,
          "FactoryStopRefusedError",
        );
        assert.strictEqual(
          (yield* Effect.flip(service.resume(author.deliveryId)))._tag,
          "FactoryResumeRefusedError",
        );
        assert.strictEqual(
          (yield* Effect.flip(service.cancel(author.deliveryId)))._tag,
          "FactoryCancelRefusedError",
        );
        assert.strictEqual(yield* current, settled);
        assert.deepStrictEqual(
          Option.getOrUndefined(yield* service.get(author.deliveryId)),
          cancelled,
        );
      }),
    ).pipe(Effect.orDie),
  );
});

/** A database whose COMMIT starts only once `release` is done, after announcing `committing`. */
const heldCommit = (gate: {
  readonly committing: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const database = yield* SqlClient.SqlClient;
      return yield* SqlClient.make({
        acquirer: database.reserve,
        compiler: Statement.makeCompilerSqlite(),
        spanAttributes: [],
        commit: (connection) =>
          Deferred.succeed(gate.committing, undefined).pipe(
            Effect.andThen(Deferred.await(gate.release)),
            Effect.andThen(connection.executeUnprepared("COMMIT", [], undefined)),
            Effect.asVoid,
          ),
      });
    }),
  ).pipe(Layer.provide(Reactivity.layer), Layer.provide(SqlitePersistence.layerMemory));

const withDatabase = <A, E>(
  body: (database: {
    readonly sql: SqlClient.SqlClient;
    readonly changes: FactoryChanges.FactoryChanges["Service"];
    readonly epoch: Effect.Effect<number>;
    readonly rows: Effect.Effect<number | undefined, SqlError.SqlError>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changes = yield* FactoryChanges.FactoryChanges;
    yield* sql`CREATE TABLE fd_writes (id INTEGER NOT NULL)`;
    return yield* body({
      sql,
      changes,
      epoch: changes.changes.pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
      rows: sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM fd_writes`.pipe(
        Effect.map(([row]) => row?.count),
      ),
    });
  });

describe("FactoryChanges.transact", () => {
  const memory = FactoryChanges.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

  it.effect("moves the epoch once the write has committed, and only for a stored write", () =>
    withDatabase(({ sql, changes, epoch, rows }) =>
      Effect.gen(function* () {
        // Written but not yet committed: a client refetching now would not find the row.
        const whileOpen = yield* changes.transact(
          sql`INSERT INTO fd_writes (id) VALUES (1)`.pipe(Effect.andThen(epoch)),
        );
        assert.strictEqual(whileOpen, 0);
        assert.strictEqual(yield* epoch, 1);
        assert.strictEqual(yield* rows, 1);

        // A write that fails rolls back and moves nothing.
        const refused = yield* Effect.flip(
          changes.transact(
            sql`INSERT INTO fd_writes (id) VALUES (2)`.pipe(
              Effect.andThen(Effect.fail("refused" as const)),
            ),
          ),
        );
        assert.strictEqual(refused, "refused");
        assert.strictEqual(yield* rows, 1);
        assert.strictEqual(yield* epoch, 1);

        // A committed transaction that stored nothing moves nothing either.
        yield* changes.transact(Effect.succeedNone, Option.isSome);
        assert.strictEqual(yield* epoch, 1);
      }),
    ).pipe(Effect.provide(memory)),
  );

  it.effect("rolls back a write interrupted before its commit and moves nothing", () =>
    withDatabase(({ sql, changes, epoch, rows }) =>
      Effect.gen(function* () {
        const written = yield* Deferred.make<void>();
        const writing = yield* changes
          .transact(
            sql`INSERT INTO fd_writes (id) VALUES (1)`.pipe(
              Effect.andThen(Deferred.succeed(written, undefined)),
              Effect.andThen(Effect.never),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(written);
        // The write itself stays interruptible.
        yield* Fiber.interrupt(writing);
        assert.strictEqual(yield* rows, 0);
        assert.strictEqual(yield* epoch, 0);
      }),
    ).pipe(Effect.provide(memory)),
  );

  it.effect("announces a write whose commit an interrupt arrived during", () =>
    Effect.gen(function* () {
      const gate = {
        committing: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      return yield* withDatabase(({ sql, changes, epoch, rows }) =>
        Effect.gen(function* () {
          const writing = yield* changes
            .transact(sql`INSERT INTO fd_writes (id) VALUES (1)`)
            .pipe(Effect.forkChild);
          yield* Deferred.await(gate.committing);
          // The interrupt lands while COMMIT runs, which it cannot cut short.
          const interrupting = yield* Fiber.interrupt(writing).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.succeed(gate.release, undefined);
          yield* Fiber.join(interrupting);

          // The caller is still interrupted, but the write committed and the epoch moved for it.
          const exit = yield* Fiber.await(writing);
          assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
          assert.strictEqual(yield* rows, 1);
          assert.strictEqual(yield* epoch, 1);
        }),
      ).pipe(Effect.provide(FactoryChanges.layer.pipe(Layer.provideMerge(heldCommit(gate)))));
    }),
  );
});
