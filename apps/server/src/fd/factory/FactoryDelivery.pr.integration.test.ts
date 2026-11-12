import { assert, describe, it } from "@effect/vitest";
import type { RunId, ThreadId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { readOutgoingCommits, readPushTarget } from "./git/branchFacts.ts";
import { evaluatePublication, evaluateSavedPullRequest } from "./git/settle.ts";
import * as Factory from "./index.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  ended,
  fakePullRequest,
  git,
  runReached,
  stateOf,
  verifyCommands,
  withProject,
} from "./testkit/deliveryHarness.ts";
import { reviewPasses } from "./testkit/followThrough.ts";
import { appendingRemoteUrls } from "./testkit/gitProcesses.ts";

/** What the reviewer first finds wrong with the author's commit. */
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

const authorReply = "Fixed no-header-row: the export writes the header row before any record.";

/** The run the delivery awaits, on the thread it names. */
const awaitedRun = (deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const { awaiting } = yield* stateOf(deliveryId);
    if (awaiting?.type !== "run") return assert.fail("The delivery awaits no run.");
    return { threadId: awaiting.threadId, runId: awaiting.runId };
  });

/** Waits until the run's provider turn has started, so the test can answer and end it. */
const turnStarted = (runId: RunId) =>
  Effect.gen(function* () {
    assert.strictEqual(yield* runReached(runId, ["starting", ...ended]), "starting");
    yield* drainOrchestration;
  });

const submitReview = (threadId: ThreadId, review: unknown) =>
  Effect.flatMap(Factory.FactoryService.FactoryService, (service) =>
    service.submitReview({ threadId, review }),
  ).pipe(Effect.orDie);

describe("Factory single-item delivery to its pull request", () => {
  it.live("authors, verifies, reviews, repairs, reviews again, records and opens the PR", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const author = yield* world.start;
        const { deliveryId, worktreePath } = author;
        const evidence = world.evidenceDir(deliveryId);
        const turnOf = (runId: RunId) =>
          world.provider.started.find((turn) => turn.runId === runId) ??
          assert.fail(`No provider turn started run ${runId}.`);

        // Author: the first commit settles and passes verify, so a fresh reviewer starts.
        yield* authorCommits(worktreePath, "feat: add the export button");
        yield* world.endRun(author.runId, "completed");
        const firstReview = yield* stateOf(deliveryId);
        assert.strictEqual(firstReview.status, "running");
        assert.strictEqual(firstReview.stage, "review");
        assert.strictEqual(firstReview.reviewRound, 1);
        assert.strictEqual(firstReview.receipts.at(-1)?.code, 0);
        const reviewer = yield* awaitedRun(deliveryId);
        assert.notStrictEqual(reviewer.threadId, author.threadId);
        assert.strictEqual(firstReview.threads.reviewer, reviewer.threadId);
        yield* turnStarted(reviewer.runId);
        assert.strictEqual(turnOf(reviewer.runId).runtimePolicy.interactionMode, "plan");

        // Review round 1 blocks: the author thread gets a fix-review turn with the finding.
        const blocking = yield* submitReview(reviewer.threadId, blockingReview);
        assert.isTrue(blocking.review.summary.blocking);
        yield* world.endRun(reviewer.runId, "completed");
        const repairing = yield* stateOf(deliveryId);
        assert.strictEqual(repairing.status, "running");
        assert.strictEqual(repairing.stage, "repair");
        assert.deepStrictEqual(repairing.rounds, { fix: 0, review: 1 });
        const repair = yield* awaitedRun(deliveryId);
        assert.strictEqual(repair.threadId, author.threadId);
        yield* turnStarted(repair.runId);
        assert.include(turnOf(repair.runId).message.text, "`no-header-row` (high, required)");

        // The author fixes it and replies; the repaired commit settles and passes verify, and
        // the next round is a follow-up turn on the same reviewer thread.
        yield* world.provider.say(turnOf(repair.runId), authorReply);
        yield* authorCommits(
          worktreePath,
          "fix: write the header row first",
          "export const header = 'id,name';\n",
        );
        yield* world.endRun(repair.runId, "completed");
        const secondReview = yield* stateOf(deliveryId);
        assert.strictEqual(secondReview.status, "running");
        assert.strictEqual(secondReview.stage, "review");
        assert.strictEqual(secondReview.reviewRound, 2);
        assert.strictEqual(secondReview.receipts.length, 2);
        const followUp = yield* awaitedRun(deliveryId);
        assert.strictEqual(followUp.threadId, reviewer.threadId);
        assert.strictEqual(secondReview.threads.reviewer, reviewer.threadId);
        yield* turnStarted(followUp.runId);
        const followUpText = turnOf(followUp.runId).message.text;
        assert.include(followUpText, "Factory review round 2.");
        assert.include(followUpText, "These are claims to check against the code, not evidence:");
        assert.include(followUpText, authorReply);
        assert.deepStrictEqual(
          world.provider.started.map((turn) => turn.threadId),
          [author.threadId, reviewer.threadId, author.threadId, reviewer.threadId],
        );

        // Review round 2 passes: record approves the repaired commit and the PR opens.
        const passing = yield* submitReview(reviewer.threadId, passingReview);
        assert.isFalse(passing.review.summary.blocking);
        yield* world.endRun(followUp.runId, "completed");

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "pr_open");
        assert.strictEqual(state.stage, "pr");
        assert.isNull(state.awaiting);
        assert.isNull(state.block);
        assert.deepStrictEqual(state.pullRequest, { ...fakePullRequest, headBranch: state.branch });
        const verified = state.receipts.at(-1);
        assert.strictEqual(verified?.headSha, yield* git(worktreePath, ["rev-parse", "HEAD"]));

        // One stacked action, from the delivery worktree, linked to the author thread.
        assert.strictEqual(world.pullRequestCalls.length, 1);
        const [call] = world.pullRequestCalls;
        assert.strictEqual(call?.input.action, "create_pr");
        assert.strictEqual(call?.input.cwd, worktreePath);
        assert.strictEqual(call?.input.threadId, author.threadId);
        // Published by its id, whatever the branch holds while the action runs.
        assert.strictEqual(call?.input.expectedHeadSha, verified?.headSha);
        // Typed from the settled commits: the feature first, whatever repaired it after.
        assert.strictEqual(call?.input.prTitle, `feat: ${world.itemKey} ${world.itemTitle}`);
        const body = call?.input.prBody ?? "";
        assert.include(body, `Work item ${world.itemKey}: ${world.itemTitle}`);
        assert.include(body, `   - Verified commit: \`${verified?.headSha}\``);
        assert.include(body, "   - Review: pass in round 2, with 0 high, 0 medium and 0 low");
        assert.strictEqual(call?.branch, state.branch);

        // Opened from the commit the approval covers: verified in round 2 and reviewed.
        const approval = JSON.parse(
          yield* fileSystem.readFileString(path.join(evidence, "approval-item.json")),
        );
        assert.strictEqual(approval.headSha, call?.head);
        assert.strictEqual(approval.headSha, verified?.headSha);
        assert.strictEqual(approval.tree, verified?.tree);
        assert.strictEqual(approval.receiptPath, path.join(evidence, "verify-2.json"));
        assert.strictEqual(approval.reviewPath, path.join(evidence, "review-2.json"));
        // And the branch the pull request merges from holds that commit.
        const published = yield* git(worktreePath, [
          "ls-remote",
          "origin",
          `refs/heads/${state.branch}`,
        ]);
        assert.strictEqual(published.split("\t")[0], approval.headSha);

        // The author thread shows the pull request as one it created.
        const shell = yield* Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
          orchestrator.getThreadShell(author.threadId),
        );
        assert.deepStrictEqual(
          (shell?.pullRequests ?? []).map(({ number, url, source }) => ({ number, url, source })),
          [{ ...fakePullRequest, source: "created" }],
        );

        const attempts = yield* Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
          runs.listByDelivery(deliveryId),
        );
        assert.deepStrictEqual(
          attempts.map(({ stage, outcome }) => [stage, outcome]),
          [
            ["author", "passed"],
            ["verify", "passed"],
            ["review", "failed"],
            ["repair", "passed"],
            ["verify", "passed"],
            ["review", "passed"],
            ["record", "passed"],
            ["pr", "passed"],
          ],
        );
        assert.strictEqual(
          yield* git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]),
          "",
        );
      }),
    ),
  );

  // The title a preserved run generated, as the item its Markdown source would hold.
  const longTitle =
    "Add an exported formatDuration(minutes) function in src/format-duration.js using built-in JavaScript only, with behavior tests and a concise README example. Keep the change small.";

  it.live("publishes a long item title with no manual correction and no attribution", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          const { deliveryId, worktreePath } = author;
          yield* authorCommits(worktreePath, "feat(format): add the duration formatter");
          yield* world.endRun(author.runId, "completed");
          const reviewer = yield* awaitedRun(deliveryId);
          yield* turnStarted(reviewer.runId);
          yield* submitReview(reviewer.threadId, passingReview);
          yield* world.endRun(reviewer.runId, "completed");

          const state = yield* stateOf(deliveryId);
          assert.strictEqual(state.status, "pr_open");
          assert.isNull(state.block);
          assert.match(
            state.branch,
            /^feature\/fd-[a-z0-9]+-add-an-exported-formatduration-minutes/,
          );
          assert.isAtMost(state.branch.length, "feature/".length + world.itemKey.length + 41);

          assert.strictEqual(world.pullRequestCalls.length, 1);
          const { input } = world.pullRequestCalls[0] ?? assert.fail("No pull request step ran.");
          const title = input.prTitle ?? assert.fail("No title.");
          const body = input.prBody ?? assert.fail("No body.");
          assert.strictEqual(input.action, "create_pr");
          assert.strictEqual(
            title,
            `feat(format): ${world.itemKey} Add an exported formatDuration(minutes) function`,
          );
          assert.isAtMost(title.length, 72);
          assert.notInclude(title, "\n");
          // The whole request stays in the body and the item; only the title is short.
          assert.include(body, `Work item ${world.itemKey}: ${longTitle}`);

          // What was published passes the gate as it stands, and nothing was added to it.
          const headSha = state.receipts.at(-1)?.headSha ?? assert.fail("No receipt.");
          // Where the driver pushes it: the branch under its own name, on the remote it went to.
          const target = yield* readPushTarget({ worktreePath, branch: state.branch });
          const origin = yield* git(worktreePath, ["remote", "get-url", "--push", "origin"]);
          assert.deepStrictEqual(target, {
            remoteName: "origin",
            branch: state.branch,
            pushUrls: [origin],
          });
          const facts = {
            branch: state.branch,
            baselineIsAncestor: true,
            target,
            // Read from the remote now: the push left nothing else to go out.
            ancestry: yield* readOutgoingCommits({
              worktreePath,
              target: target ?? assert.fail("No push target."),
              headSha,
            }),
            commits: [
              {
                sha: headSha,
                subject: "feat(format): add the duration formatter",
                body: "",
                authorName: "Ada Lovelace",
                authorEmail: "ada@example.com",
                committerName: "Ada Lovelace",
                committerEmail: "ada@example.com",
              },
            ],
          };
          assert.deepStrictEqual(
            evaluatePublication({
              facts,
              expectedBranch: state.branch,
              text: { title, body, key: world.itemKey },
            }),
            [],
          );
          assert.deepStrictEqual(facts.ancestry, []);
          assert.deepStrictEqual(
            evaluateSavedPullRequest({
              saved: { title, body, headBranch: state.branch },
              expectedHead: state.branch,
              key: world.itemKey,
              sent: { title, body },
            }),
            [],
          );
          assert.notMatch(body, /co-authored|generated|assisted-by|signed-off/i);
          assert.strictEqual(
            yield* git(worktreePath, ["log", "-1", "--format=%B"]),
            "feat(format): add the duration formatter",
          );
        }),
      { itemTitle: longTitle },
    ),
  );

  it.live("opens nothing once where its push goes changes after the gate, until restored", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, runId, worktreePath } = yield* world.start;
        const origin = yield* git(worktreePath, ["remote", "get-url", "origin"]);
        const elsewhere = `${origin.slice(0, -"origin.git".length)}elsewhere.git`;
        yield* git(worktreePath, ["init", "--bare", elsewhere]);
        const remote = yield* git(worktreePath, ["ls-remote", "origin"]);

        // The action pushes through Git's own push, bound to what the gate judged. Inside it, after
        // the gate read origin, the push URL moves: the remote and branch stay.
        world.publishing.throughDriver = true;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        world.publishHooks.push(
          git(worktreePath, ["remote", "set-url", "--push", "origin", elsewhere]).pipe(
            Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.orDie,
            Effect.asVoid,
          ),
        );
        yield* authorCommits(worktreePath, "feat: add the export button", "export const x = 1;\n");
        const approved = yield* git(worktreePath, ["rev-parse", "HEAD"]);
        yield* world.endRun(runId, "completed");
        yield* reviewPasses(world, deliveryId);

        const blocked = yield* stateOf(deliveryId);
        assert.strictEqual(blocked.status, "blocked");
        assert.strictEqual(blocked.stage, "pr");
        assert.isNull(blocked.pullRequest);
        assert.deepStrictEqual(blocked.block, {
          reason: "effect_failed",
          effect: { id: blocked.effectsIssued, type: "open_pr" },
          detail:
            "Factory could not open the pull request. Factory published nothing it had not judged: where a push of its branch goes, its remote, upstream or push URLs, changed after Factory judged what the push would add there. Factory pushes only where it judged, and goes no further once that changes: keep or restore the remote, upstream and push URLs its branch should publish to, then Resume, which judges that destination again before pushing.",
        });
        // Asked once, and nothing went out: no branch on either repository and no pull request.
        assert.deepStrictEqual(
          world.pullRequestCalls.map(({ input }) => input.action),
          ["create_pr"],
        );
        assert.strictEqual(yield* git(worktreePath, ["ls-remote", elsewhere]), "");
        assert.strictEqual(yield* git(worktreePath, ["ls-remote", "origin"]), remote);
        assert.strictEqual(yield* git(worktreePath, ["rev-parse", "HEAD"]), approved);

        // Restored, a resume judges origin again and opens the approved commit's pull request.
        yield* git(worktreePath, ["config", "--unset", "remote.origin.pushurl"]);
        yield* Effect.flatMap(Factory.FactoryService.FactoryService, (factory) =>
          factory.resume(deliveryId),
        ).pipe(Effect.orDie);
        yield* drainFactory;
        const open = yield* stateOf(deliveryId);
        assert.strictEqual(open.status, "pr_open");
        assert.strictEqual(open.pullRequest?.number, fakePullRequest.number);
        assert.strictEqual(
          yield* git(worktreePath, ["ls-remote", "origin", `refs/heads/${open.branch}`]),
          `${approved}\trefs/heads/${open.branch}`,
        );
        assert.strictEqual(yield* git(worktreePath, ["ls-remote", elsewhere]), "");
      }),
    ),
  );

  it.live("opens nothing where Git cannot hold its push to the URLs judged, until it can", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const { deliveryId, runId, worktreePath } = yield* world.start;
        const origin = yield* git(worktreePath, ["remote", "get-url", "origin"]);
        const before = yield* Effect.all([
          git(worktreePath, ["ls-remote", "origin"]),
          git(worktreePath, ["config", "--list", "--local"]),
        ]);

        // The action pushes through Git's own push, bound to what the gate judged, on a Git that
        // takes per-command settings, so the gate reads origin as ever, but cannot clear a remote's
        // URLs, so the push cannot be held to the ones the gate judged.
        world.publishing.throughDriver = true;
        world.gitProcesses.before = appendingRemoteUrls;
        yield* authorCommits(worktreePath, "feat: add the export button", "export const x = 1;\n");
        const approved = yield* git(worktreePath, ["rev-parse", "HEAD"]);
        yield* world.endRun(runId, "completed");
        yield* reviewPasses(world, deliveryId);

        const blocked = yield* stateOf(deliveryId);
        assert.strictEqual(blocked.status, "blocked");
        assert.strictEqual(blocked.stage, "pr");
        assert.isNull(blocked.pullRequest);
        assert.deepStrictEqual(blocked.block, {
          reason: "effect_failed",
          effect: { id: blocked.effectsIssued, type: "open_pr" },
          detail:
            "Factory could not open the pull request. Factory published nothing: the Git that runs this project cannot hold a push to only the push URLs Factory judged. Factory pushes only where it can hold Git to what it judged: update Git on the environment that runs this project to 2.46 or later, then Resume, which judges the destination again before pushing.",
        });
        // Only that fixed text: no Git output, URL or spelling the push was pinned with.
        const shown = JSON.stringify(blocked.block);
        for (const hidden of [origin, "fd-pinned-url", "fd-test-empty-remote-url", "GitCommand"]) {
          assert.notInclude(shown, hidden);
        }
        // Asked once, and nothing went out: no branch, upstream or pull request.
        assert.deepStrictEqual(
          world.pullRequestCalls.map(({ input }) => input.action),
          ["create_pr"],
        );
        assert.deepStrictEqual(
          yield* Effect.all([
            git(worktreePath, ["ls-remote", "origin"]),
            git(worktreePath, ["config", "--list", "--local"]),
          ]),
          before,
        );
        assert.strictEqual(yield* git(worktreePath, ["rev-parse", "HEAD"]), approved);

        // On a Git that can, a resume judges origin again and opens the approved commit's pull
        // request.
        world.gitProcesses.before = undefined;
        yield* Effect.flatMap(Factory.FactoryService.FactoryService, (factory) =>
          factory.resume(deliveryId),
        ).pipe(Effect.orDie);
        yield* drainFactory;
        const open = yield* stateOf(deliveryId);
        assert.strictEqual(open.status, "pr_open");
        assert.strictEqual(open.pullRequest?.number, fakePullRequest.number);
        assert.strictEqual(
          yield* git(worktreePath, ["ls-remote", "origin", `refs/heads/${open.branch}`]),
          `${approved}\trefs/heads/${open.branch}`,
        );
      }),
    ),
  );
});
