import { assert, describe, it } from "@effect/vitest";
import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  AuthWorkReadScope,
  AuthWorkWriteScope,
  type ThreadId,
} from "@t3tools/contracts";

import { workItemScopeChanged } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { type HandoffBackend, ProjectAssistant } from "../assistant/index.ts";
import { WorkService } from "../work-management/index.ts";
import * as Factory from "./index.ts";
import {
  authorCommits,
  drainFactory,
  fakePullRequest,
  stateOf,
  verifyCommands,
  type World,
  withProject,
} from "./testkit/deliveryHarness.ts";
import { awaitedRun, passingReview } from "./testkit/followThrough.ts";
import {
  agree,
  assignmentOf,
  assistantThread,
  captureIdea,
  controlAssignment,
  itemCount,
  rootIdOf,
  startAssistantThread,
  tick,
} from "./testkit/handoff.ts";
import { offeredModels, selection, setSettings } from "./testkit/reviewed.ts";

/**
 * One idea from the owner's discussion to a pull request waiting on them, on the server's real
 * stores and effect worker: a capture that starts nothing, the owner's review and start, the
 * author, server verify, an independent reviewer, a repair of its blocking finding, the
 * publication gate and the pull request, with a stop and two restarts on the way that launch
 * nothing twice.
 */

const idea = "export";
const factoryService = Factory.FactoryService.FactoryService;
const scopes: ReadonlyArray<AuthEnvironmentScope> = [
  AuthWorkReadScope,
  AuthWorkWriteScope,
  AuthOrchestrationOperateScope,
];
const owner: HandoffBackend.HandoffOwner = {
  sessionId: AuthSessionId.make("owner-session"),
  scopes,
  current: Effect.succeed(scopes),
};
const target = (world: World) => ({
  projectId: world.projectId,
  ideaId: idea,
  managerThreadId: assistantThread,
  kind: "single" as const,
});
const settings = {
  verifyCommand: verifyCommands.passes,
  roles: {
    planner: selection("planner-model", "low"),
    author: selection("author-model", "high"),
    reviewer: selection("reviewer-model", "low"),
  },
};
const workOwner = { id: "session:owner", grants: [AuthWorkReadScope], label: "owner" };

const blockingReview = {
  ...passingReview(),
  verdict: "changes-required",
  findings: [
    {
      id: "empty-export",
      severity: "high",
      required: true,
      file: "export.ts",
      line: 1,
      detail: "An empty export writes no header row.",
    },
  ],
};

const deliveryRows = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM fd_factory_deliveries`,
).pipe(
  Effect.orDie,
  Effect.map((rows) => rows[0]?.count ?? 0),
);
const assignmentRows = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM fd_assistant_assignments`,
).pipe(
  Effect.orDie,
  Effect.map((rows) => rows[0]?.count ?? 0),
);

/** The threads the provider ran a turn on, other than the assistant's own, in launch order. */
const workerThreads = (world: World): ReadonlyArray<ThreadId> => [
  ...new Set(
    world.provider.started
      .map(({ threadId }) => threadId)
      .filter((threadId) => threadId !== assistantThread),
  ),
];
const turnsOn = (world: World, threadId: ThreadId | undefined) =>
  world.provider.started.filter((turn) => turn.threadId === threadId).length;

/** Nothing but the assistant's own thread has run: no delivery, assignment or worker. */
const assertNoWorker = (world: World) =>
  Effect.gen(function* () {
    assert.deepStrictEqual(workerThreads(world), []);
    assert.strictEqual(yield* deliveryRows, 0);
    assert.strictEqual(yield* assignmentRows, 0);
    assert.deepStrictEqual(world.pullRequestCalls, []);
  });

describe("a reviewed idea, from discussion to the owner's pull request review", () => {
  it.live(
    "runs every stage once, through a stop and restarts, and leaves the merge to the owner",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* setSettings(world, settings);
            yield* startAssistantThread(world);

            // Discussing and capturing the idea starts no worker.
            yield* agree(world, idea);
            yield* assertNoWorker(world);
            yield* captureIdea(world, idea).pipe(Effect.orDie);
            yield* tick;
            yield* assertNoWorker(world);
            // The fixture's own item, and the capture.
            assert.strictEqual(yield* itemCount(world), 2);

            // The owner reviews what starting would run, and starts it.
            const assistant = yield* ProjectAssistant.ProjectAssistant;
            const snapshot = yield* assistant.review(target(world)).pipe(Effect.orDie);
            assert.deepStrictEqual(snapshot.start.blockers, []);
            yield* assertNoWorker(world);
            const started = yield* assistant
              .startReview({
                ...target(world),
                reviewVersion: snapshot.reviewVersion,
                requestId: "owner-start-1",
                owner,
              })
              .pipe(Effect.orDie);
            assert.strictEqual(started.outcome, "queued");
            assert.strictEqual(yield* itemCount(world), 2);

            // The claim launches the author on what was reviewed.
            yield* tick;
            const root = yield* rootIdOf(started.assignmentId);
            const author = yield* world.launched(root);
            const claimed = yield* stateOf(root);
            assert.strictEqual(claimed.reviewedExecution?.receiptId, started.receiptId);
            assert.deepStrictEqual(workerThreads(world), [author.threadId]);
            assert.strictEqual(turnsOn(world, author.threadId), 1);

            // A stop lets the author's turn finish and rests before verify.
            yield* controlAssignment(started.assignmentId, "stop").pipe(Effect.orDie);
            yield* authorCommits(author.worktreePath, "feat: add the export button");
            yield* world.endRun(author.runId, "completed");
            assert.strictEqual((yield* stateOf(root)).status, "stopped");
            yield* tick;

            yield* world.rebuild(
              Effect.gen(function* () {
                // After a restart, the resume verifies on the server and an independent reviewer
                // judges the commit, without a second author launch.
                yield* controlAssignment(started.assignmentId, "resume").pipe(Effect.orDie);
                yield* tick;
                yield* drainFactory;
                const firstReview = yield* awaitedRun(root);
                assert.notStrictEqual(firstReview.threadId, author.threadId);
                const verified = yield* stateOf(root);
                assert.strictEqual(verified.stage, "review");
                assert.strictEqual(verified.receipts.at(-1)?.code, 0);
                assert.deepStrictEqual(
                  verified.receipts.at(-1)?.command,
                  claimed.reviewedExecution?.verifyCommand,
                );
                assert.strictEqual(turnsOn(world, author.threadId), 1);

                // A blocking finding goes back to the same author as a repair turn.
                const factory = yield* factoryService;
                yield* factory
                  .submitReview({ threadId: firstReview.threadId, review: blockingReview })
                  .pipe(Effect.orDie);
                yield* world.endRun(firstReview.runId, "completed");
                const repair = yield* awaitedRun(root);
                assert.strictEqual(repair.threadId, author.threadId);
                assert.strictEqual((yield* stateOf(root)).stage, "repair");
                yield* authorCommits(
                  author.worktreePath,
                  "fix: write the header row for an empty export",
                  "export const x = 2;\n",
                );
                yield* world.endRun(repair.runId, "completed");

                // Verify again, then the next round on the same reviewer thread, which passes.
                const secondReview = yield* awaitedRun(root);
                assert.strictEqual(secondReview.threadId, firstReview.threadId);
                yield* factory
                  .submitReview({ threadId: secondReview.threadId, review: passingReview() })
                  .pipe(Effect.orDie);
                yield* world.endRun(secondReview.runId, "completed");

                // The publication gate passes the reviewed branch, and one pull request opens.
                const opened = yield* stateOf(root);
                assert.strictEqual(opened.status, "pr_open");
                assert.deepStrictEqual(opened.rounds, { fix: 0, review: 1 });
                // Verified twice: the author's commit, then the repair, which the pull request
                // publishes by its id from a compliant branch with a compliant title.
                assert.lengthOf(opened.receipts, 2);
                const repaired = opened.receipts.at(-1)?.headSha;
                assert.lengthOf(world.pullRequestCalls, 1);
                const [call] = world.pullRequestCalls;
                assert.strictEqual(call?.input.action, "create_pr");
                assert.strictEqual(call?.input.expectedHeadSha, repaired);
                assert.strictEqual(call?.head, repaired);
                assert.strictEqual(call?.branch, opened.branch);
                assert.match(opened.branch ?? "", /^feature\//);
                assert.match(call?.input.prTitle ?? "", /^feat: /);
                assert.strictEqual(opened.pullRequest?.url, fakePullRequest.url);
                assert.deepStrictEqual(workerThreads(world), [
                  author.threadId,
                  firstReview.threadId,
                ]);

                // Ready for the owner's review: nothing merges, and the item stays as it was.
                yield* tick;
                assert.strictEqual(
                  (yield* assignmentOf(started.assignmentId)).state,
                  "needs-input",
                );
                const stored = Option.getOrThrow(yield* factory.get(root));
                const work = yield* WorkService.WorkService;
                const item = yield* work
                  .getItem(workOwner, { ref: stored.itemRef })
                  .pipe(Effect.orDie);
                assert.strictEqual(item.status, "todo");
                // Factory's own progress comments are no change of requirements on any link.
                assert.isAbove(item.links.length, 0);
                for (const link of item.links) assert.isFalse(workItemScopeChanged(link, item));

                const turns = world.provider.started.length;
                yield* world.rebuild(
                  Effect.gen(function* () {
                    // Another restart takes up the open pull request and launches nothing.
                    yield* tick;
                    yield* drainFactory;
                    const after = yield* stateOf(root);
                    assert.strictEqual(after.status, "pr_open");
                    assert.strictEqual(after.pullRequest?.url, fakePullRequest.url);
                    assert.strictEqual(world.provider.started.length, turns);
                    assert.lengthOf(world.pullRequestCalls, 1);
                    assert.strictEqual(
                      (yield* assignmentOf(started.assignmentId)).state,
                      "needs-input",
                    );
                    assert.strictEqual(yield* deliveryRows, 1);
                  }),
                  { orchestration: true },
                );
              }),
              { orchestration: true },
            );
          }).pipe(Effect.orDie),
        {
          handoff: {},
          automaticTurnGate: true,
          providers: offeredModels(),
        },
      ),
  );
});
