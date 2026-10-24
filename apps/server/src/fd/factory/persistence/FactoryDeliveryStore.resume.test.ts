import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as Factory from "../index.ts";
import { advance } from "../pipeline/engine.ts";
import { queuedDeliveryState } from "../pipeline/state.ts";
import type { FactoryDeliveryState, FactoryEvent } from "../pipeline/state.ts";
import * as FactoryDeliveryStore from "./FactoryDeliveryStore.ts";

const persistence = Factory.layerPersistence.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const projectId = ProjectId.make("project-alpha");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const itemRef = { sourceId, itemId: WorkItemId.make("fd-aaaaaa") };
const deliveryId = FactoryDeliveryId.make("delivery-resume");
const author = ThreadId.make("thread-author");
const authorRun = RunId.make("run-author");
const problems = ["Worktree has uncommitted or untracked changes."];

const fold = (state: FactoryDeliveryState, ...events: ReadonlyArray<FactoryEvent>) =>
  events.reduce((current, event) => advance(current, event).delivery, state);

/** Stopped at verify once its author's branch settled. */
const stopped = fold(
  queuedDeliveryState({ branch: "fd/item-a", baseRef: "main" }),
  { type: "start" },
  {
    type: "thread.launched",
    effectId: 1,
    threadId: author,
    runId: authorRun,
    worktreePath: "/worktrees/item-a",
    baseline: "b".repeat(40),
  },
  { type: "stop" },
  { type: "run.finished", threadId: author, runId: authorRun, status: "completed" },
  { type: "settle.checked", effectId: 2, result: { status: "settled" } },
);
const dirtyCheck = {
  deletedThreads: [],
  worktree: {
    settle: { status: "repairable", problems },
    commit: { headSha: "a".repeat(40), tree: "c".repeat(40) },
    approvedSha: null,
  },
} as const;

const roundTrip = (state: FactoryDeliveryState) =>
  Effect.gen(function* () {
    const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    yield* store.insert({ deliveryId, projectId, itemRef, state });
    return Option.getOrThrow(yield* store.get(deliveryId)).state;
  }).pipe(Effect.provide(persistence));

describe("FactoryDeliveryStore after resume", () => {
  it.effect("keeps the checkpoint a resume's fix-commit turn names", () =>
    Effect.gen(function* () {
      const resumed = fold(stopped, { type: "resume", check: dirtyCheck });
      assert.deepStrictEqual(resumed.awaiting, {
        type: "effect",
        effect: {
          id: 3,
          type: "send_fix_commit_turn",
          threadId: author,
          problems,
          checkpoint: "verify",
        },
      });
      assert.deepStrictEqual(yield* roundTrip(resumed), resumed);
    }),
  );

  it.effect("keeps the checkpoint of a delivery a resume blocked before it moved on", () =>
    Effect.gen(function* () {
      const blocked = fold(stopped, {
        type: "resume",
        check: { ...dirtyCheck, deletedThreads: [author] },
      });
      assert.strictEqual(blocked.status, "blocked");
      assert.strictEqual(blocked.checkpoint, "verify");
      assert.deepStrictEqual(yield* roundTrip(blocked), blocked);
    }),
  );
});
