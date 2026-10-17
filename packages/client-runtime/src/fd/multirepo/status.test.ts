import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  type VcsStatusStreamEvent,
  type VcsStatusSubscriptionInput,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { loadRepositoryStatuses } from "./status.ts";

class MissingCheckout extends Data.TaggedError("MissingCheckout")<{ readonly message: string }> {}

it.effect(
  "bounds passive snapshots, closes subscriptions and keeps failed checkouts separate",
  () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const active = yield* Ref.make(0);
      const maximum = yield* Ref.make(0);
      const calls: VcsStatusSubscriptionInput[] = [];
      const repositories = [0, 1, 2].map((id) => ({
        id: String(id),
        name: `Repo ${id}`,
        rootPath: `/projects/${id}`,
      }));
      const target = {
        type: "thread" as const,
        threadId: ThreadId.make("saved-thread"),
        repositoryId: "0",
      };
      const subscribe = (input: VcsStatusSubscriptionInput) =>
        Stream.fromEffect(
          Effect.gen(function* () {
            calls.push(input);
            const count = yield* Ref.updateAndGet(active, (value) => value + 1);
            yield* Ref.update(maximum, (value) => Math.max(value, count));
            if (count === 2) yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(gate);
            if (input.repositoryTarget?.repositoryId === "1")
              return yield* Effect.fail(new MissingCheckout({ message: "Checkout missing" }));
            return {
              _tag: "snapshot",
              local: {
                isRepo: true,
                hasPrimaryRemote: false,
                isDefaultRef: false,
                refName: `branch-${input.repositoryTarget?.repositoryId}`,
                hasWorkingTreeChanges: true,
                workingTree: {
                  files: [{ path: "src/index.ts", insertions: 1, deletions: 0 }],
                  insertions: 1,
                  deletions: 0,
                },
              },
              remote: null,
            } satisfies VcsStatusStreamEvent;
          }),
        ).pipe(Stream.ensuring(Ref.update(active, (value) => value - 1)));
      const fiber = yield* loadRepositoryStatuses({ repositories, target }, subscribe).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      assert.equal(calls.length, 2);
      yield* Deferred.succeed(gate, undefined);
      const rows = yield* Fiber.join(fiber);
      assert.deepEqual(
        rows.map((row) => row.repository.id),
        ["0", "1", "2"],
      );
      assert.equal(rows[0]?.status?.branch, "branch-0");
      assert.equal(rows[1]?.error, "Checkout missing");
      assert.equal(rows[2]?.status?.branch, "branch-2");
      assert.equal(yield* Ref.get(maximum), 2);
      assert.equal(yield* Ref.get(active), 0);
      for (const [index, call] of calls.entries()) {
        assert.equal(call.includeRemote, false);
        assert.deepEqual(call.repositoryTarget, { ...target, repositoryId: String(index) });
        assert.equal(call.cwd, repositories[index]?.rootPath);
      }
    }),
);
