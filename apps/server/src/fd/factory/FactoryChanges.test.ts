import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
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
}

const awaitedRun = (delivery: StoredFactoryDelivery | undefined) => {
  const awaiting = delivery?.state.awaiting;
  return awaiting?.type === "run" ? awaiting : undefined;
};

describe("Factory delivery changes", () => {
  it.live("move the epoch after each stored delivery write, and never for a refusal", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const service = yield* Factory.FactoryService.FactoryService;
        const settings = yield* Factory.FactorySettings.FactorySettings;
        /** The epoch now: a new subscription's first value. */
        const current = service.subscribe.pipe(Stream.runHead, Effect.map(Option.getOrThrow));

        // A client: on every value, it refetches the project's newest delivery.
        const reads = yield* Queue.unbounded<Read>();
        yield* service.subscribe.pipe(
          Stream.runForEach((epoch) =>
            Effect.gen(function* () {
              const [newest] = yield* service.list({ projectId: world.projectId });
              const delivery =
                newest === undefined ? undefined : yield* service.get(newest.deliveryId);
              yield* Queue.offer(reads, {
                epoch,
                delivery: delivery === undefined ? undefined : Option.getOrUndefined(delivery),
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
        // Subscribed before anything is written.
        assert.deepStrictEqual(yield* readsThrough(0), [{ epoch: 0, delivery: undefined }]);

        // A start refused for a missing verify command writes nothing and moves nothing.
        const configured = yield* settings.get(world.projectId);
        yield* settings.set(world.projectId, { ...configured, verifyCommand: null });
        const noVerify = yield* Effect.flip(service.start({ itemRef: world.itemRef }));
        assert.strictEqual(noVerify._tag, "FactoryVerifyCommandMissingError");
        assert.strictEqual(yield* current, 0);
        yield* settings.set(world.projectId, configured);

        // The queued row, the running state and the author launch's result are three commits.
        const author = yield* world.start;
        assert.strictEqual(yield* current, 3);
        const started = yield* readsThrough(3);
        assert.deepStrictEqual(
          started.map(({ epoch }) => epoch),
          [1, 2, 3],
        );
        // Every refetch finds the delivery, the first one included.
        for (const { delivery } of started) {
          assert.strictEqual(delivery?.deliveryId, author.deliveryId);
        }
        assert.strictEqual(started.at(-1)?.delivery?.state.status, "running");
        assert.strictEqual(awaitedRun(started.at(-1)?.delivery)?.runId, author.runId);

        // The author's run ends; the step that takes it, and each one after it, moves the epoch.
        yield* authorCommits(author.worktreePath, "feat: add the export button");
        assert.strictEqual(yield* current, 3);
        assert.strictEqual(yield* world.endRun(author.runId, "completed"), "completed");
        const reviewing = yield* current;
        assert.isAbove(reviewing, 3);
        const verified = yield* readsThrough(reviewing);
        assert.strictEqual(verified[0]?.epoch, 4);
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

describe("FactoryChanges.afterCommit", () => {
  it.effect("moves the epoch once the transaction has committed, and only for a stored write", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const changes = yield* FactoryChanges.FactoryChanges;
      const epoch = changes.changes.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      const rows = sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM fd_writes`.pipe(
        Effect.map(([row]) => row?.count),
      );
      yield* sql`CREATE TABLE fd_writes (id INTEGER NOT NULL)`;

      // Written but not yet committed: a client refetching now would not find the row.
      const whileOpen = yield* changes.afterCommit(
        sql`INSERT INTO fd_writes (id) VALUES (1)`.pipe(Effect.andThen(epoch), sql.withTransaction),
      );
      assert.strictEqual(whileOpen, 0);
      assert.strictEqual(yield* epoch, 1);
      assert.strictEqual(yield* rows, 1);

      // A transaction that fails rolls its write back and moves nothing.
      const refused = yield* Effect.flip(
        changes.afterCommit(
          sql`INSERT INTO fd_writes (id) VALUES (2)`.pipe(
            Effect.andThen(Effect.fail("refused" as const)),
            sql.withTransaction,
          ),
        ),
      );
      assert.strictEqual(refused, "refused");
      assert.strictEqual(yield* rows, 1);
      assert.strictEqual(yield* epoch, 1);

      // A committed transaction that stored nothing moves nothing either.
      yield* changes.afterCommit(sql.withTransaction(Effect.succeedNone), Option.isSome);
      assert.strictEqual(yield* epoch, 1);
    }).pipe(Effect.provide(Layer.mergeAll(FactoryChanges.layer, SqlitePersistence.layerMemory))),
  );
});
