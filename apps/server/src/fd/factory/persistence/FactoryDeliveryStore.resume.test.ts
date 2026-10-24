import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

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
  unrecordedAuthorRunEnded: false,
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

  it.effect("keeps the author launch and the checkpoint a replayed launch settles for", () =>
    Effect.gen(function* () {
      // The author launch's result was lost; a resume replays it after its run had ended.
      const lost = fold(
        queuedDeliveryState({ branch: "fd/item-a", baseRef: "main" }),
        { type: "start" },
        { type: "effect.failed", effectId: 1, detail: "No." },
      );
      const replaying = fold(lost, {
        type: "resume",
        check: { deletedThreads: [], unrecordedAuthorRunEnded: true, worktree: null },
      });
      const launch = {
        id: 1,
        type: "launch_thread",
        role: "author",
        workspace: { type: "worktree", branch: "fd/item-a", baseRef: "main" },
      } as const;
      assert.deepStrictEqual(replaying.authorLaunch, launch);
      assert.deepStrictEqual(replaying.awaiting, {
        type: "effect",
        effect: { ...launch, resumeCheckpoint: "author" },
      });
      assert.deepStrictEqual(yield* roundTrip(replaying), replaying);

      const settling = fold(replaying, {
        type: "thread.launched",
        effectId: 1,
        threadId: author,
        runId: authorRun,
        worktreePath: "/worktrees/item-a",
        baseline: "b".repeat(40),
      });
      assert.deepStrictEqual(settling.awaiting, {
        type: "effect",
        effect: {
          id: 2,
          type: "check_settle",
          threadId: author,
          runId: authorRun,
          checkpoint: "author",
        },
      });
      assert.deepStrictEqual(yield* roundTrip(settling), settling);
    }),
  );

  it.effect("loads a row stored before author launches were recorded", () =>
    Effect.gen(function* () {
      const { authorLaunch: _absent, ...before } = stopped;
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      yield* store.insert({ deliveryId, projectId, itemRef, state: stopped });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE fd_factory_deliveries SET state_json = ${JSON.stringify(before)}`;
      const loaded = Option.getOrThrow(yield* store.get(deliveryId)).state;
      assert.deepStrictEqual(loaded, { ...stopped, authorLaunch: null });
    }).pipe(Effect.provide(persistence)),
  );
});
