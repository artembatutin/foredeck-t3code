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
import { drainFactory, verifyCommands, withProject } from "./testkit/deliveryHarness.ts";

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
const bootSweep = Effect.flatMap(Factory.FactoryWorker.FactoryWorker, (worker) =>
  worker.postUnfinishedComments.pipe(Effect.orDie),
).pipe(Effect.andThen(drainFactory));

describe("Factory comments a crash left unfinished, on a Markdown item past its comment bound", () => {
  it.live("posts the one never sent exactly once and never posts again the one the item took", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const work = yield* WorkService.WorkService;
        const store = yield* FactoryWorkCommentStore.FactoryWorkCommentStore;
        const ref = world.itemRef;

        // 55 notes: every ordinary read shows the oldest 50 and says it left some out.
        for (let note = 1; note <= 55; note += 1) {
          yield* work.addComment(member, { ref, body: `Team note ${note}.` }).pipe(Effect.orDie);
        }
        const item = yield* work.getItem(member, { ref }).pipe(Effect.orDie);
        assert.strictEqual(item.comments.length, 50);
        assert.isTrue(item.commentsTruncated);
        const taskFile = path.join(world.root, item.locator ?? "");
        const occurrences = (text: string) =>
          fileSystem
            .readFileString(taskFile)
            .pipe(Effect.map((content) => content.split(text).length - 1));
        const attempts = () =>
          world.commentCalls.filter(({ actor }) => actor.id === factory.id).length;

        yield* Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
          deliveries.insert({
            deliveryId,
            projectId: world.projectId,
            itemRef: ref,
            state: queuedDeliveryState({ branch: "work/fd-crashed", baseRef: "HEAD" }),
          }),
        );

        // The first comment: claimed and taken by the item, the 56th note, before the crash.
        const accepted = yield* store.record({
          deliveryId,
          comment: { status: "blocked", body: blocked },
        });
        yield* store.claim(accepted);
        yield* work
          .addComment(factory, { ref, body: `${blocked} ${reference(1)}` })
          .pipe(Effect.orDie);

        for (let boot = 1; boot <= 3; boot += 1) yield* bootSweep;
        assert.strictEqual(yield* occurrences(reference(1)), 1);
        assert.strictEqual(attempts(), 1);

        // The second: claimed, and the process died before sending it.
        const unsent = yield* store.record({
          deliveryId,
          comment: { status: "blocked", body: blocked },
        });
        yield* store.claim(unsent);
        assert.strictEqual(yield* occurrences(reference(2)), 0);

        for (let boot = 1; boot <= 3; boot += 1) yield* bootSweep;
        assert.strictEqual(yield* occurrences(reference(2)), 1);
        assert.strictEqual(yield* occurrences(reference(1)), 1);
        assert.strictEqual(attempts(), 2);
        assert.deepStrictEqual(yield* store.listUnfinished(), []);

        // Still past the bound: neither reference shows in an ordinary read.
        const after = yield* work.getItem(member, { ref }).pipe(Effect.orDie);
        assert.isTrue(after.commentsTruncated);
        assert.isFalse(after.comments.some(({ body }) => body.includes("Factory delivery")));
      }).pipe(Effect.orDie),
    ),
  );
});
