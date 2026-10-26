import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  FactoryTaskId,
  type FactoryVerifyReceipt,
} from "@t3tools/contracts/fd/factory";
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
const itemRef = { sourceId, itemId: WorkItemId.make("fd-parent") };
const deliveryId = FactoryDeliveryId.make("delivery-parent");
const child = FactoryDeliveryId.make("delivery-parent-child");
const planner = ThreadId.make("thread-planner");
const reviewer = ThreadId.make("thread-integrate");
// The child's author thread, which the parent's pull request is linked to.
const childAuthor = ThreadId.make("thread-child-author");
const planRun = RunId.make("run-plan");
const reviewRun = RunId.make("run-integrate");
const wakeRun = RunId.make("run-wake");
const worktreePath = "/worktrees/fd-parent";

const receipt: FactoryVerifyReceipt = {
  version: 1,
  headSha: "c".repeat(40),
  tree: "d".repeat(40),
  startedAt: "2026-10-26T10:00:00.000Z",
  finishedAt: "2026-10-26T10:01:00.000Z",
  code: 0,
  timedOut: false,
  durationMs: 60_000,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath: "/t3/userdata/fd-factory/delivery-parent/verify-1.log",
  outputHash: "output-1",
};
const pullRequest = {
  number: 7,
  url: "https://github.com/acme/alpha/pull/7",
  headBranch: "work/fd-parent",
};

const fold = (state: FactoryDeliveryState, ...events: ReadonlyArray<FactoryEvent>) =>
  events.reduce((current, event) => advance(current, event).delivery, state);

/** A one-child parent whose integrate review passed and whose branch is approved: PR (effect 7). */
const opening = fold(
  queuedDeliveryState({ kind: "parent", branch: "work/fd-parent", baseRef: "HEAD" }),
  { type: "start" },
  {
    type: "thread.launched",
    effectId: 1,
    threadId: planner,
    runId: planRun,
    worktreePath,
    baseline: "a".repeat(40),
  },
  {
    type: "plan.submitted",
    round: 1,
    threadId: planner,
    runId: planRun,
    judgment: {
      type: "accepted",
      plan: {
        tasks: [
          {
            id: FactoryTaskId.make("export-csv"),
            title: "Export the table as CSV",
            kind: "feature",
            summary: "Add a CSV export.",
            acceptance: ["The export downloads the rows."],
            testPlan: [{ criterion: 1, check: "Export two rows.", paths: ["export.test.ts"] }],
            likelyPaths: ["export.ts"],
            risk: "normal",
          },
        ],
        source: "mcp",
        evidencePath: "/t3/plan.json",
      },
    },
  },
  { type: "run.finished", threadId: planner, runId: planRun, status: "completed" },
  { type: "plan.approved" },
  { type: "children.created", effectId: 2, children: [child] },
  { type: "child.started", effectId: 3 },
  { type: "child.approved", deliveryId: child },
  { type: "command.finished", effectId: 4, outcome: { type: "receipt", receipt } },
  {
    type: "thread.launched",
    effectId: 5,
    threadId: reviewer,
    runId: reviewRun,
    worktreePath,
    baseline: receipt.headSha,
  },
  {
    type: "review.submitted",
    round: 1,
    threadId: reviewer,
    runId: reviewRun,
    judgment: {
      type: "accepted",
      review: {
        source: "mcp",
        summary: {
          headSha: receipt.headSha,
          verdict: "pass",
          blocking: false,
          findings: { high: 0, medium: 0, low: 0 },
          reviewedAt: "2026-10-26T10:05:00.000Z",
        },
        evidencePath: "/t3/review-1.json",
      },
    },
  },
  { type: "run.finished", threadId: reviewer, runId: reviewRun, status: "completed" },
  {
    type: "approval.recorded",
    effectId: 6,
    outcome: { type: "approved", evidencePath: "/t3/approval.json" },
  },
);

/** A parent's pull request as a server stored it before parents recorded the linked thread. */
const storedBefore = fold(opening, { type: "pr.opened", effectId: 7, pullRequest });
const storedBeforeJson = JSON.stringify(storedBefore);

/** The parent with the thread recorded and its pull request watched there. */
const watchedOpen = fold(opening, {
  type: "pr.opened",
  effectId: 7,
  pullRequest,
  pullRequestThread: childAuthor,
  watch: { firstAt: 100, at: 100, armed: true, held: "2026-10-26T10:06:00.000Z" },
});
const wake: FactoryEvent = {
  type: "pr.feedback",
  kind: "feedback",
  threadId: childAuthor,
  runId: wakeRun,
  number: pullRequest.number,
  url: pullRequest.url,
  sequence: 105,
  watchStartedAt: "2026-10-26T10:06:00.000Z",
  linkSequence: 104,
};

/** States with the linked thread the stored schema has to carry. */
const linkedStates: ReadonlyArray<readonly [string, FactoryDeliveryState]> = [
  ["with its pull request open and watched", watchedOpen],
  ["in a follow-through round, awaiting the wake's run", fold(watchedOpen, wake)],
  [
    "blocked on a round's failed run",
    fold(watchedOpen, wake, {
      type: "run.finished",
      threadId: childAuthor,
      runId: wakeRun,
      status: "failed",
    }),
  ],
  ["cancelled, its watch to be released", fold(watchedOpen, wake, { type: "cancel" })],
];

const insertStoredBeforeRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO fd_factory_deliveries (
      delivery_id, project_id, source_id, item_id, parent_id, status, state_json,
      created_at, updated_at
    )
    VALUES (
      ${deliveryId}, ${projectId}, ${sourceId}, ${itemRef.itemId}, NULL, 'pr_open',
      ${storedBeforeJson}, '2026-10-26T10:07:00.000Z', '2026-10-26T10:07:00.000Z'
    )
  `;
});

const storedJson = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly state: string }>`
    SELECT state_json AS state FROM fd_factory_deliveries WHERE delivery_id = ${deliveryId}
  `;
  return JSON.parse(rows[0]?.state ?? "null");
});

describe("FactoryDeliveryStore with a parent's linked pull request thread", () => {
  it("covers the states it names", () => {
    assert.strictEqual(storedBefore.status, "pr_open");
    assert.notProperty(JSON.parse(storedBeforeJson), "pullRequestThread");
    assert.deepStrictEqual(
      linkedStates.map(([, state]) => [
        state.status,
        state.pullRequestThread,
        state.awaiting?.type,
      ]),
      [
        ["pr_open", childAuthor, undefined],
        ["running", childAuthor, "run"],
        ["blocked", childAuthor, undefined],
        ["cancelled", childAuthor, undefined],
      ],
    );
  });

  it.effect("loads a parent stored without the thread as it was, and round-trips it", () =>
    Effect.gen(function* () {
      yield* insertStoredBeforeRow;
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;

      const loaded = Option.getOrThrow(yield* store.get(deliveryId));
      assert.deepStrictEqual(loaded.state, JSON.parse(storedBeforeJson));
      assert.notProperty(loaded.state, "pullRequestThread");
      // With no thread recorded, no wake is the parent's.
      const step = advance(loaded.state, wake);
      assert.strictEqual(step.delivery, loaded.state);

      yield* store.update(deliveryId, loaded.state);
      assert.deepStrictEqual(Option.getOrThrow(yield* store.get(deliveryId)).state, loaded.state);
      assert.notProperty(yield* storedJson, "pullRequestThread");
    }).pipe(Effect.provide(persistence)),
  );

  it.effect.each(linkedStates)("round-trips a parent %s", ([, state]) =>
    Effect.gen(function* () {
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      yield* store.insert({ deliveryId, projectId, itemRef, state });
      assert.deepStrictEqual(Option.getOrThrow(yield* store.get(deliveryId)).state, state);
      assert.strictEqual((yield* storedJson).pullRequestThread, childAuthor);
    }).pipe(Effect.provide(persistence)),
  );
});
