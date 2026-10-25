import { assert, describe, it } from "@effect/vitest";
import { AuthWorkReadScope, AuthWorkWriteScope } from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { type WorkActor, WorkService } from "../work-management/index.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryWorkCommentStore from "./persistence/FactoryWorkCommentStore.ts";
import { queuedDeliveryState } from "./pipeline/state.ts";
import {
  drainFactory,
  verifyCommands,
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";

const member: WorkActor = {
  id: "session:owner",
  grants: [AuthWorkReadScope, AuthWorkWriteScope],
  label: "owner",
};
const deliveryId = FactoryDeliveryId.make("delivery-crashed");
const factory: WorkActor = {
  id: `factory:${deliveryId}`,
  grants: [AuthWorkReadScope, AuthWorkWriteScope],
  label: "Factory",
};
const blocked =
  "Factory is blocked on this item and needs you. Verify failed with no fix round left. Resume or cancel the delivery in Foredeck.";
const reference = (transition: number) => `Factory delivery ${deliveryId}, update ${transition}.`;

/** What every server boot does first: post the comments a previous process left unfinished. */
const bootSweeps = (times: number) =>
  Effect.forEach(
    Array.from({ length: times }),
    () =>
      Effect.flatMap(Factory.FactoryWorker.FactoryWorker, (worker) =>
        worker.postUnfinishedComments.pipe(Effect.orDie),
      ).pipe(Effect.andThen(drainFactory)),
    { discard: true },
  );

/**
 * The world's item with 55 notes, so every ordinary read shows the oldest 50 and says it left
 * some out, and a delivery of it. Returns what a crashed process's comments look like on it.
 */
const crashedOnLongItem = (world: World) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const work = yield* WorkService.WorkService;
    const store = yield* FactoryWorkCommentStore.FactoryWorkCommentStore;
    const ref = world.itemRef;
    for (let note = 1; note <= 55; note += 1) {
      yield* work.addComment(member, { ref, body: `Team note ${note}.` });
    }
    const item = yield* work.getItem(member, { ref });
    assert.strictEqual(item.comments.length, 50);
    assert.isTrue(item.commentsTruncated);
    const taskFile = path.join(world.root, item.locator ?? "");
    yield* Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
      deliveries.insert({
        deliveryId,
        projectId: world.projectId,
        itemRef: ref,
        state: queuedDeliveryState({ branch: "work/fd-crashed", baseRef: "HEAD" }),
      }),
    );
    const claimed = Effect.gen(function* () {
      const recorded = yield* store.record({
        deliveryId,
        comment: { status: "blocked", body: blocked },
      });
      yield* store.claim(recorded);
      return recorded;
    });
    return {
      work,
      store,
      ref,
      taskFile,
      /** A comment claimed and taken by the item, before the process died. */
      accepted: claimed.pipe(
        Effect.tap((recorded) =>
          work.addComment(factory, { ref, body: `${blocked} ${reference(recorded.transition)}` }),
        ),
      ),
      /** A comment claimed, and the process died before sending it. */
      unsent: claimed,
      occurrences: (text: string) =>
        fileSystem
          .readFileString(taskFile)
          .pipe(Effect.map((content) => content.split(text).length - 1)),
      attempts: () => world.commentCalls.filter(({ actor }) => actor.id === factory.id).length,
    };
  });

describe("Factory comments a crash left unfinished, on a Markdown item past its comment bound", () => {
  it.live("posts the one never sent exactly once and never posts again the one the item took", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const item = yield* crashedOnLongItem(world);

        yield* item.accepted;
        yield* bootSweeps(3);
        assert.strictEqual(yield* item.occurrences(reference(1)), 1);
        assert.strictEqual(item.attempts(), 1);

        yield* item.unsent;
        assert.strictEqual(yield* item.occurrences(reference(2)), 0);
        yield* bootSweeps(3);
        assert.strictEqual(yield* item.occurrences(reference(2)), 1);
        assert.strictEqual(yield* item.occurrences(reference(1)), 1);
        assert.strictEqual(item.attempts(), 2);
        assert.deepStrictEqual(yield* item.store.listUnfinished(), []);

        // Still past the bound: neither reference shows in an ordinary read.
        const after = yield* item.work.getItem(member, { ref: item.ref });
        assert.isTrue(after.commentsTruncated);
        assert.isFalse(after.comments.some(({ body }) => body.includes("Factory delivery")));
      }).pipe(Effect.orDie),
    ),
  );

  it.live(
    "posts nothing while the item's file does not decode, and settles both once it is repaired",
    () =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const item = yield* crashedOnLongItem(world);
          yield* item.accepted;
          yield* item.unsent;

          // The file loses its title: its notes are intact, but it no longer reads as an item.
          const intact = yield* fileSystem.readFileString(item.taskFile);
          const broken = intact.replace(/^title: .*\n/m, "");
          assert.notStrictEqual(broken, intact);
          yield* fileSystem.writeFileString(item.taskFile, broken);

          yield* bootSweeps(2);
          assert.strictEqual(item.attempts(), 1);
          assert.strictEqual(yield* fileSystem.readFileString(item.taskFile), broken);
          assert.strictEqual((yield* item.store.listUnfinished()).length, 2);

          // Repaired: the one the item took is found and finished, the other posted once.
          yield* fileSystem.writeFileString(item.taskFile, intact);
          yield* bootSweeps(3);
          assert.strictEqual(yield* item.occurrences(reference(1)), 1);
          assert.strictEqual(yield* item.occurrences(reference(2)), 1);
          assert.strictEqual(item.attempts(), 2);
          assert.deepStrictEqual(yield* item.store.listUnfinished(), []);
        }).pipe(Effect.orDie),
      ),
  );
});
