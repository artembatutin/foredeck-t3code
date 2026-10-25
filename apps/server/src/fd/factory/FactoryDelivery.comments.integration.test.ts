import { assert, describe, it } from "@effect/vitest";
import { AuthWorkReadScope, type RunId, type ThreadId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";

import { type WorkActor, WorkService } from "../work-management/index.ts";
import * as Factory from "./index.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  ended,
  fakePullRequest,
  runReached,
  stateOf,
  verifyCommands,
  withProject,
} from "./testkit/deliveryHarness.ts";

/** The first round's review of the author's commit, which requires a change. */
const blockingReview = {
  verdict: "changes-required",
  findings: [
    {
      id: "no-header-row",
      severity: "high",
      required: true,
      file: "export.ts",
      line: 1,
      detail: "The export writes no header row, so spreadsheets read the first record as names.",
    },
  ],
  acceptance: [
    {
      criterion: 1,
      status: "failed",
      evidence: "The exported file starts with a data row.",
      paths: ["export.ts"],
    },
  ],
  missing_evidence: [],
};

/** The second round's review of the repaired commit. */
const passingReview = {
  verdict: "pass",
  findings: [],
  acceptance: [
    {
      criterion: 1,
      status: "verified",
      evidence: "The export now writes its header row first.",
      paths: ["export.ts"],
    },
  ],
  missing_evidence: [],
};

const reader: WorkActor = { id: "session:owner", grants: [AuthWorkReadScope], label: "owner" };

const service = Factory.FactoryService.FactoryService;

/** The run the delivery awaits, once its provider turn has started. */
const awaitedTurn = (deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const { awaiting } = yield* stateOf(deliveryId);
    if (awaiting?.type !== "run") return assert.fail("The delivery awaits no run.");
    assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
    yield* drainOrchestration;
    return { threadId: awaiting.threadId, runId: awaiting.runId };
  });

const submitReview = (threadId: ThreadId, review: unknown) =>
  Effect.flatMap(service, (factory) => factory.submitReview({ threadId, review })).pipe(
    Effect.orDie,
  );

describe("Factory's Work comments on a single-item delivery", () => {
  it.live("comments once on approval and once on the open pull request, and on nothing else", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* service;
        const author = yield* world.start;
        const { deliveryId, worktreePath } = author;
        const turnOf = (runId: RunId) =>
          world.provider.started.find((turn) => turn.runId === runId) ??
          assert.fail(`No provider turn started run ${runId}.`);

        // Stopped after the author's turn, where verify would begin, then resumed.
        yield* factory.stop(deliveryId).pipe(Effect.orDie);
        assert.strictEqual((yield* stateOf(deliveryId)).status, "stopping");
        yield* authorCommits(worktreePath, "feat: add the export button");
        yield* world.endRun(author.runId, "completed");
        const stopped = yield* stateOf(deliveryId);
        assert.strictEqual(stopped.status, "stopped");
        assert.strictEqual(stopped.checkpoint, "verify");
        yield* factory.resume(deliveryId).pipe(Effect.orDie);
        yield* drainFactory;

        // Review round 1 requires a change; the author repairs it on its thread.
        const reviewer = yield* awaitedTurn(deliveryId);
        yield* submitReview(reviewer.threadId, blockingReview);
        yield* world.endRun(reviewer.runId, "completed");
        const repair = yield* awaitedTurn(deliveryId);
        assert.strictEqual(repair.threadId, author.threadId);
        yield* world.provider.say(turnOf(repair.runId), "Fixed no-header-row.");
        yield* authorCommits(
          worktreePath,
          "fix: write the header row first",
          "export const header = 'id,name';\n",
        );
        yield* world.endRun(repair.runId, "completed");
        // Running, stopping and stopped, through every stage so far: nothing to announce.
        assert.deepStrictEqual(world.commentCalls, []);

        // Review round 2 passes: record approves the commit and the PR stage opens its PR.
        const followUp = yield* awaitedTurn(deliveryId);
        assert.strictEqual(followUp.threadId, reviewer.threadId);
        yield* submitReview(followUp.threadId, passingReview);
        yield* world.endRun(followUp.runId, "completed");

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "pr_open");
        const approved = state.receipts.at(-1)?.headSha;
        assert.isDefined(approved);
        // Each ends with its reference, which a restart looks for on the item.
        const expected = [
          `Factory approved commit ${approved} for this item after verify and review, and is opening its pull request. Factory delivery ${deliveryId}, update 1.`,
          `Factory opened pull request #${fakePullRequest.number} for this item. ${fakePullRequest.url} Factory delivery ${deliveryId}, update 2.`,
        ];
        assert.deepStrictEqual(
          world.commentCalls.map(({ input }) => input.body),
          expected,
        );
        for (const { actor, input } of world.commentCalls) {
          assert.strictEqual(actor.id, `factory:${deliveryId}`);
          assert.deepStrictEqual(input.ref, world.itemRef);
        }
        const [approval, opened] = world.commentCalls.map(({ input }) => input.clientRequestId);
        assert.isDefined(approval);
        assert.notStrictEqual(approval, opened);

        // The item's Markdown source holds both, as written, under Factory's name.
        const item = yield* Effect.flatMap(WorkService.WorkService, (work) =>
          work.getItem(reader, { ref: world.itemRef }),
        ).pipe(Effect.orDie);
        assert.deepStrictEqual(
          item.comments.map(({ author: commenter, body }) => [commenter?.label, body]),
          expected.map((body) => ["Factory", body]),
        );
      }),
    ),
  );
});
