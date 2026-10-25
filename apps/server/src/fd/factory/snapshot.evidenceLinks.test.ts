import { assert, describe, expect, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import {
  FACTORY_SNAPSHOT_STAGE_RUNS_MAX,
  FactoryDelivery,
  FactoryDeliveryId,
  type FactoryDeliveryStatus,
  type FactoryReviewSummary,
  type FactoryStageName,
  type FactoryStageOutcome,
  type FactoryVerifyReceipt,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as FactoryService from "./FactoryService.ts";
import type { StoredFactoryStageRun } from "./persistence/FactoryStageRunStore.ts";
import {
  type FactoryAcceptedReview,
  type FactoryDeliveryState,
  queuedDeliveryState,
} from "./pipeline/state.ts";
import { toFactoryDelivery } from "./snapshot.ts";
import {
  authorCommits,
  drainOrchestration,
  ended,
  runReached,
  verifyCommands,
  withProject,
} from "./testkit/deliveryHarness.ts";

const deliveryId = FactoryDeliveryId.make("delivery-links");
const evidence = "/home/owner/.t3/userdata/fd-factory/delivery-links";
const author = ThreadId.make("thread-author");
const reviewer = ThreadId.make("thread-reviewer");
const headSha = "a".repeat(40);
const tree = "b".repeat(40);
const at = (minute: number) => `2026-10-25T09:${String(minute).padStart(2, "0")}:00.000Z`;

/** The receipt of verify run `number`, as the runner records it: its log is `verify-<n>.log`. */
const receipt = (number: number, code: number): FactoryVerifyReceipt => ({
  version: 1,
  headSha,
  tree,
  startedAt: at(number),
  finishedAt: at(number),
  code,
  timedOut: false,
  durationMs: 1_000,
  command: { executable: "secret-verify-tool", args: ["--token", "hunter2"] },
  settingsHash: "settings-hash-0123",
  platform: "darwin-arm64",
  logPath: `${evidence}/verify-${number}.log`,
  outputHash: "output-hash-4567",
});

const summary = (blocking: boolean, minute: number): FactoryReviewSummary => ({
  headSha,
  verdict: blocking ? "changes-required" : "pass",
  blocking,
  findings: { high: blocking ? 1 : 0, medium: 0, low: 0 },
  reviewedAt: at(minute),
});

/** The review accepted in `round`, kept as `review-<number>.json`. */
const accepted = (round: number, number: number, blocking: boolean): FactoryAcceptedReview => ({
  round,
  source: "mcp",
  summary: summary(blocking, 30 + number),
  evidencePath: `${evidence}/review-${number}.json`,
  ...(blocking ? { fingerprint: `fingerprint-review-${number}` } : {}),
});

/** One stored attempt; `evidenceFile` names the evidence the worker recorded on it, if any. */
const attempt = (
  stage: FactoryStageName,
  number: number,
  outcome: FactoryStageOutcome | null,
  evidenceFile: string | null,
  minute: number,
): StoredFactoryStageRun => ({
  deliveryId,
  stage,
  attempt: number,
  threadId: stage === "review" ? reviewer : stage === "verify" ? null : author,
  runId: stage === "verify" ? null : RunId.make(`run-${stage}-${number}`),
  outcome,
  evidencePath: evidenceFile === null ? null : `${evidence}/${evidenceFile}`,
  fingerprint: outcome === "failed" ? `fingerprint-${stage}-${number}` : null,
  startedAt: at(minute),
  finishedAt: outcome === null ? null : at(minute + 1),
});

const stored = (
  status: FactoryDeliveryStatus,
  state: Partial<FactoryDeliveryState>,
  stageRuns: ReadonlyArray<StoredFactoryStageRun>,
): FactoryService.FactoryDeliveryWithRuns => ({
  deliveryId,
  projectId: ProjectId.make("project-alpha"),
  itemRef: {
    sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
    itemId: WorkItemId.make("fd-aaaaaa"),
  },
  parentId: null,
  state: {
    ...queuedDeliveryState({ branch: "work/fd-aaaaaa", baseRef: "HEAD" }),
    worktreePath: "/worktrees/fd-aaaaaa",
    threads: { author, reviewer },
    ...state,
    status,
  },
  stageRuns,
  createdAt: at(0),
  updatedAt: at(59),
});

/** Each attempt as `[stage, attempt, receiptNumber, reviewNumber]`. */
const linksOf = (snapshot: FactoryDelivery) =>
  snapshot.stageRuns.map(({ stage, attempt, receiptNumber, reviewNumber }) => [
    stage,
    attempt,
    receiptNumber,
    reviewNumber,
  ]);

const encodeDelivery = Schema.encodeSync(FactoryDelivery);
const decodeDelivery = Schema.decodeUnknownSync(FactoryDelivery);

describe("evidence links of stored attempts", () => {
  it("names the receipt each verify produced and the review each review attempt accepted", () => {
    const snapshot = toFactoryDelivery(
      stored(
        "running",
        {
          stage: "review",
          receipts: [receipt(1, 1), receipt(3, 0), receipt(4, 0), receipt(5, 0)],
          // The second review was accepted in the active attempt, whose run is still going.
          reviews: [accepted(1, 1, true), accepted(3, 2, false)],
          reviewRound: 3,
        },
        [
          attempt("author", 1, "passed", null, 1),
          attempt("verify", 1, "failed", "verify-1.json", 2),
          attempt("repair", 1, "passed", null, 3),
          // The command moved HEAD: its log stays, but no receipt was made.
          attempt("verify", 2, "blocked", "verify-2.log", 4),
          attempt("verify", 3, "passed", "verify-3.json", 5),
          attempt("review", 1, "failed", "review-1.json", 6),
          attempt("repair", 2, "passed", null, 7),
          // The verify effect failed before a run was numbered.
          attempt("verify", 4, "blocked", null, 8),
          attempt("verify", 5, "passed", "verify-4.json", 9),
          // The code changed before the reviewer submitted.
          attempt("review", 2, "blocked", null, 10),
          attempt("verify", 6, "passed", "verify-5.json", 11),
          attempt("review", 3, null, null, 12),
        ],
      ),
    );

    expect(linksOf(snapshot)).toEqual([
      ["author", 1, undefined, undefined],
      ["verify", 1, 1, undefined],
      ["repair", 1, undefined, undefined],
      ["verify", 2, undefined, undefined],
      ["verify", 3, 3, undefined],
      ["review", 1, undefined, 1],
      ["repair", 2, undefined, undefined],
      ["verify", 4, undefined, undefined],
      ["verify", 5, 4, undefined],
      ["review", 2, undefined, undefined],
      ["verify", 6, 5, undefined],
      ["review", 3, undefined, undefined],
    ]);
    expect(snapshot.receipts.map(({ number }) => number)).toEqual([1, 3, 4, 5]);
    expect(snapshot.reviews.map(({ number }) => number)).toEqual([1, 2]);
    // An attempt that named nothing carries no key for it at all.
    expect(snapshot.stageRuns[3]).not.toHaveProperty("receiptNumber");
    expect(snapshot.stageRuns.at(-1)).not.toHaveProperty("reviewNumber");

    const wire = encodeDelivery(snapshot);
    expect(decodeDelivery(wire)).toEqual(snapshot);
    const text = JSON.stringify(wire);
    for (const hidden of [
      "fd-factory",
      "verify-",
      "review-",
      ".log",
      ".json",
      "fingerprint",
      "secret-verify-tool",
      "hunter2",
      "evidencePath",
      "logPath",
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("names nothing for attempts cancelled or blocked before they produced evidence", () => {
    const snapshot = toFactoryDelivery(
      stored(
        "cancelled",
        { stage: "review", receipts: [receipt(1, 0), receipt(2, 0)], reviews: [], reviewRound: 2 },
        [
          attempt("author", 1, "passed", null, 1),
          attempt("verify", 1, "passed", "verify-1.json", 2),
          // The reviewer's run failed before it submitted.
          attempt("review", 1, "blocked", null, 3),
          attempt("verify", 2, "passed", "verify-2.json", 4),
          // Cancelled while the reviewer was still working.
          attempt("review", 2, "cancelled", null, 5),
        ],
      ),
    );
    expect(linksOf(snapshot)).toEqual([
      ["author", 1, undefined, undefined],
      ["verify", 1, 1, undefined],
      ["review", 1, undefined, undefined],
      ["verify", 2, 2, undefined],
      ["review", 2, undefined, undefined],
    ]);
    expect(snapshot.reviews).toEqual([]);
  });

  it("names a review accepted before a stop or cancel ended its attempt", () => {
    const snapshot = toFactoryDelivery(
      stored(
        "stopped",
        {
          stage: "review",
          checkpoint: "record",
          receipts: [receipt(1, 0)],
          reviews: [accepted(1, 1, false)],
          reviewRound: 1,
        },
        [
          attempt("verify", 1, "passed", "verify-1.json", 1),
          attempt("review", 1, "passed", "review-1.json", 2),
        ],
      ),
    );
    expect(linksOf(snapshot)).toEqual([
      ["verify", 1, 1, undefined],
      ["review", 1, undefined, 1],
    ]);
  });

  it("names only receipts and reviews the snapshot carries", () => {
    const snapshot = toFactoryDelivery(
      stored(
        "approved",
        {
          stage: "pr",
          receipts: [receipt(1, 0), { ...receipt(2, 0), logPath: `${evidence}/custom.log` }],
          reviews: [accepted(1, 1, false)],
          reviewRound: 1,
        },
        [
          // Evidence of runs the delivery does not hold, and evidence that is no receipt or review.
          attempt("verify", 1, "passed", "verify-9.json", 1),
          attempt("review", 1, "passed", "review-7.json", 2),
          attempt("verify", 2, "passed", "verify-0.json", 3),
          attempt("record", 1, "passed", "approval-item.json", 4),
          attempt("pr", 1, null, null, 5),
        ],
      ),
    );
    expect(linksOf(snapshot)).toEqual([
      ["verify", 1, undefined, undefined],
      ["review", 1, undefined, undefined],
      ["verify", 2, undefined, undefined],
      ["record", 1, undefined, undefined],
      ["pr", 1, undefined, undefined],
    ]);
    // A receipt whose log is not a numbered verify log has no number to be named by.
    expect(snapshot.receipts.map(({ number }) => number)).toEqual([1, undefined]);
    expect(snapshot.receipts[1]).not.toHaveProperty("number");
  });

  it("keeps the number of a receipt whose attempt fell off the snapshot's cap", () => {
    const filler = Array.from({ length: FACTORY_SNAPSHOT_STAGE_RUNS_MAX }, (_, index) =>
      attempt("repair", index + 1, "passed", null, 2),
    );
    const snapshot = toFactoryDelivery(
      stored("running", { stage: "repair", receipts: [receipt(1, 1)] }, [
        attempt("verify", 1, "failed", "verify-1.json", 1),
        ...filler,
      ]),
    );
    expect(snapshot.stageRuns).toHaveLength(FACTORY_SNAPSHOT_STAGE_RUNS_MAX);
    expect(snapshot.stageRuns.some(({ receiptNumber }) => receiptNumber !== undefined)).toBe(false);
    expect(snapshot.receipts.map(({ number }) => number)).toEqual([1]);
  });
});

describe("evidence links of a delivery that ran", () => {
  const read = (id: FactoryDeliveryId) =>
    Effect.flatMap(FactoryService.FactoryService, (factory) =>
      factory.get(id).pipe(Effect.map(Option.getOrThrow), Effect.orDie),
    );

  it.live("names each failed verify's own receipt across a repair round", () =>
    withProject(
      verifyCommands.fails,
      (world) =>
        Effect.gen(function* () {
          const started = yield* world.start;
          yield* authorCommits(started.worktreePath, "feat: add the export button");
          yield* world.endRun(started.runId, "completed");

          // Verify failed: the repair turn runs on the author thread.
          const repairing = yield* read(started.deliveryId);
          const { awaiting } = repairing.state;
          if (awaiting?.type !== "run") return assert.fail("The repair turn started no run.");
          assert.strictEqual(repairing.state.stage, "repair");
          assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
          yield* drainOrchestration;
          yield* authorCommits(
            started.worktreePath,
            "fix: export every column",
            "export const x = 2;\n",
          );
          yield* world.endRun(awaiting.runId, "completed");

          const blocked = yield* read(started.deliveryId);
          assert.strictEqual(blocked.state.status, "blocked");
          assert.deepStrictEqual(blocked.state.block, { reason: "verify_failed" });
          const path = yield* Path.Path;
          const folder = world.evidenceDir(started.deliveryId);
          expect(blocked.stageRuns.map(({ stage, evidencePath }) => [stage, evidencePath])).toEqual(
            [
              ["author", null],
              ["verify", path.join(folder, "verify-1.json")],
              ["repair", null],
              ["verify", path.join(folder, "verify-2.json")],
            ],
          );

          const snapshot = toFactoryDelivery(blocked);
          expect(linksOf(snapshot)).toEqual([
            ["author", 1, undefined, undefined],
            ["verify", 1, 1, undefined],
            ["repair", 1, undefined, undefined],
            ["verify", 2, 2, undefined],
          ]);
          expect(snapshot.receipts.map(({ number, code }) => [number, code])).toEqual([
            [1, 3],
            [2, 3],
          ]);
          expect(JSON.stringify(encodeDelivery(snapshot))).not.toContain(folder);
        }),
      { limits: { maxFixRounds: 1 } },
    ),
  );

  it.live("names no receipt for a verify the server refused", () =>
    withProject(verifyCommands.dirties, (world) =>
      Effect.gen(function* () {
        const started = yield* world.start;
        yield* authorCommits(started.worktreePath, "feat: add the export button");
        yield* world.endRun(started.runId, "completed");

        const blocked = yield* read(started.deliveryId);
        assert.strictEqual(blocked.state.block?.reason, "receipt_refused");
        // The refused run's log is the attempt's evidence, and it is no receipt.
        const path = yield* Path.Path;
        expect(blocked.stageRuns.at(-1)?.evidencePath).toBe(
          path.join(world.evidenceDir(started.deliveryId), "verify-1.log"),
        );
        const snapshot = toFactoryDelivery(blocked);
        expect(snapshot.receipts).toEqual([]);
        expect(linksOf(snapshot)).toEqual([
          ["author", 1, undefined, undefined],
          ["verify", 1, undefined, undefined],
        ]);
      }),
    ),
  );
});
