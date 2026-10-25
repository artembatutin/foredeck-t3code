import { assert, describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { FactoryDelivery, FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as Factory from "../index.ts";
import type { FactoryAcceptedReview, FactoryDeliveryState } from "../pipeline/state.ts";
import { toFactoryDelivery } from "../snapshot.ts";
import * as FactoryDeliveryStore from "./FactoryDeliveryStore.ts";

const persistence = Factory.layerPersistence.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const projectId = ProjectId.make("project-alpha");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const itemRef = { sourceId, itemId: WorkItemId.make("fd-aaaaaa") };
const deliveryId = FactoryDeliveryId.make("delivery-gate-2");
const author = ThreadId.make("thread-author");
const reviewer = ThreadId.make("thread-reviewer");
const evidence = "/t3/userdata/fd-factory/delivery-gate-2";
const headSha = "a".repeat(40);

const summary = (round: number) => ({
  headSha,
  verdict: "changes-required",
  blocking: true,
  findings: { high: 1, medium: round, low: 0 },
  reviewedAt: `2026-10-24T10:0${round}:00.000Z`,
});

/**
 * A row as a server stored it before reviews kept details: blocked after its second review, with
 * two accepted reviews that carry counts only.
 */
const reviews = [1, 2].map((round) => ({
  round,
  source: round === 1 ? "mcp" : "fallback",
  summary: summary(round),
  evidencePath: `${evidence}/review-${round}.json`,
  fingerprint: `fingerprint-review-${round}`,
}));
const storedStateJson = JSON.stringify({
  status: "blocked",
  stage: "review",
  branch: "work/fd-aaaaaa-add-the-export-button",
  baseRef: "HEAD",
  worktreePath: "/t3/worktrees/alpha/work-fd-aaaaaa",
  baseline: "b".repeat(40),
  threads: { author, reviewer },
  authorLaunch: null,
  awaiting: null,
  fixCommitTurns: 0,
  effectsIssued: 9,
  receipts: [
    {
      version: 1,
      headSha,
      tree: "c".repeat(40),
      startedAt: "2026-10-24T09:58:00.000Z",
      finishedAt: "2026-10-24T09:59:00.000Z",
      code: 0,
      timedOut: false,
      durationMs: 60_000,
      command: { executable: "vp", args: ["test", "run"] },
      settingsHash: "settings-1",
      platform: "darwin-arm64",
      logPath: `${evidence}/verify-1.log`,
      outputHash: "output-1",
    },
  ],
  reviewRound: 2,
  invalidSubmissions: 0,
  reviews,
  limits: { maxFixRounds: 2, maxReviewRounds: 1 },
  risk: "normal",
  rounds: { fix: 0, review: 1 },
  fingerprints: ["fingerprint-review-1", "fingerprint-review-2"],
  reviewResponse: null,
  pullRequest: null,
  block: { reason: "review_changes_required", summary: summary(2) },
  checkpoint: null,
});

const insertRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO fd_factory_deliveries (
      delivery_id, project_id, source_id, item_id, parent_id, status, state_json,
      created_at, updated_at
    )
    VALUES (
      ${deliveryId}, ${projectId}, ${sourceId}, ${itemRef.itemId}, NULL, 'blocked',
      ${storedStateJson}, '2026-10-24T10:03:00.000Z', '2026-10-24T10:03:00.000Z'
    )
  `;
});

const storedJson = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly state: string }>`
    SELECT state_json AS state FROM fd_factory_deliveries WHERE delivery_id = ${deliveryId}
  `;
  return row?.state ?? assert.fail("The row is gone.");
});

const load = Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (store) =>
  store.get(deliveryId).pipe(Effect.map(Option.getOrThrow)),
);

const encodeDelivery = Schema.encodeSync(FactoryDelivery);
const decodeDelivery = Schema.decodeUnknownSync(FactoryDelivery);

describe("FactoryDeliveryStore with reviews accepted before details", () => {
  it.effect("loads the row as stored, its reviews without details", () =>
    Effect.gen(function* () {
      yield* insertRow;
      const loaded = yield* load;
      assert.deepStrictEqual(loaded.state, {
        ...JSON.parse(storedStateJson),
        // The planning fields came later: the row is a single item that never planned.
        kind: "single",
        plannerLaunch: null,
        planRound: 0,
        plan: null,
        planApproved: false,
        children: [],
        approvedChildren: [],
      });
      for (const review of loaded.state.reviews) expect(review).not.toHaveProperty("details");
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("shows the reviews' counts in its snapshot, with no details", () =>
    Effect.gen(function* () {
      yield* insertRow;
      const snapshot = toFactoryDelivery({ ...(yield* load), stageRuns: [] });
      expect(snapshot.reviews).toEqual([
        { ...summary(1), number: 1 },
        { ...summary(2), number: 2 },
      ]);
      const wire = decodeDelivery(encodeDelivery(snapshot));
      for (const review of [...snapshot.reviews, ...wire.reviews]) {
        expect(review).not.toHaveProperty("details");
      }
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("writes no details back when the state is stored again", () =>
    Effect.gen(function* () {
      yield* insertRow;
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      const loaded = yield* load;

      yield* store.update(deliveryId, { ...loaded.state, status: "stopped" });

      const written = JSON.parse(yield* storedJson);
      assert.deepStrictEqual(written.reviews, reviews);
      assert.notInclude(yield* storedJson, '"details"');
    }).pipe(Effect.provide(persistence)),
  );

  it.effect("round-trips a review accepted with details beside one without", () =>
    Effect.gen(function* () {
      yield* insertRow;
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      const loaded = yield* load;
      const withDetails: FactoryAcceptedReview = {
        ...loaded.state.reviews[1]!,
        details: {
          findings: [
            {
              id: "no-header",
              severity: "high",
              required: true,
              blocking: true,
              file: "export.ts",
              line: null,
              detail: "The export writes no header row.",
            },
          ],
          criteria: [{ criterion: 2, status: "failed", detail: "A comma splits the row." }],
          missingEvidence: ["A test that exports an empty table."],
          omitted: { findings: 3, criteria: 0, missingEvidence: 0 },
        },
      };
      const state: FactoryDeliveryState = {
        ...loaded.state,
        reviews: [loaded.state.reviews[0]!, withDetails],
      };

      yield* store.update(deliveryId, state);

      const reloaded = yield* load;
      assert.deepStrictEqual(reloaded.state, state);
      const snapshot = toFactoryDelivery({ ...reloaded, stageRuns: [] });
      expect(snapshot.reviews.map((review) => review.details)).toEqual([
        undefined,
        withDetails.details,
      ]);
    }).pipe(Effect.provide(persistence)),
  );
});
