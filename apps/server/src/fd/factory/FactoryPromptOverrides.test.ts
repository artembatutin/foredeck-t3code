import { assert, describe, it } from "@effect/vitest";
import { AuthWorkReadScope, type RunId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { WorkService } from "../work-management/index.ts";
import * as Factory from "./index.ts";
import { renderAuthorPrompt } from "./prompts/author.ts";
import { renderReviewPrompt } from "./prompts/review.ts";
import { type FactoryPromptName, MAX_PROMPT_OVERRIDE_BYTES } from "./prompts/overrides.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  ended,
  git,
  runReached,
  stateOf,
  verifyCommands,
  type World,
  withProject,
} from "./testkit/deliveryHarness.ts";

const reader = { id: "session:owner", grants: [AuthWorkReadScope], label: "owner" };
const identity = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];
const rules = (name: string) => `Project ${name} rules\n\nKeep this exact whitespace.\n`;
const overridePath = (root: string, name: FactoryPromptName) =>
  Effect.map(Path.Path, (path) => path.join(root, ".foredeck", "factory", "prompts", `${name}.md`));
const writeOverride = (root: string, name: FactoryPromptName, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* overridePath(root, name);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, text);
    return file;
  });
const awaitedRun = (deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const { awaiting } = yield* stateOf(deliveryId);
    if (awaiting?.type !== "run") return assert.fail("The delivery awaits no run.");
    assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
    yield* drainOrchestration;
    return awaiting;
  }).pipe(Effect.orDie);
const turnOf = (world: World, runId: RunId) =>
  world.provider.started.find((turn) => turn.runId === runId) ?? assert.fail("No provider turn.");
const passingReview = {
  verdict: "pass",
  findings: [],
  acceptance: [
    {
      criterion: 1,
      status: "verified",
      evidence: "The export is committed.",
      paths: ["export.ts"],
    },
  ],
  missing_evidence: [],
};
const blockingReview = {
  ...passingReview,
  verdict: "changes-required",
  findings: [
    {
      id: "empty-export",
      severity: "high",
      required: true,
      file: "export.ts",
      line: 1,
      detail: "Empty input crashes the export.",
    },
  ],
};
const plan = {
  tasks: [
    {
      id: "export",
      title: "Export rows",
      kind: "feature",
      summary: "Export the current rows.",
      acceptance: ["Rows export."],
      testPlan: [{ criterion: 1, check: "Export two rows.", paths: ["export.ts"] }],
      likelyPaths: ["export.ts"],
      risk: "normal",
    },
  ],
};

describe("Factory canonical project prompt overrides", () => {
  it.live("with no override directory launches exactly the built-in author and review text", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const work = yield* WorkService.WorkService;
        const item = yield* work.getItem(reader, { ref: world.itemRef });
        const author = yield* world.start;
        const initial = yield* stateOf(author.deliveryId);
        assert.strictEqual(
          turnOf(world, author.runId).message.text,
          renderAuthorPrompt({ item, branch: initial.branch }),
        );
        yield* authorCommits(author.worktreePath, "feat: export rows");
        yield* world.endRun(author.runId, "completed");
        const review = yield* awaitedRun(author.deliveryId);
        const state = yield* stateOf(author.deliveryId);
        assert.strictEqual(
          turnOf(world, review.runId).message.text,
          renderReviewPrompt({
            item,
            branch: state.branch,
            baseline: state.baseline ?? assert.fail("No baseline."),
            receipt: state.receipts[0] ?? assert.fail("No receipt."),
          }),
        );
      }),
    ),
  );

  it.live(
    "reads plan and integrate independently, and ignores an author override committed only in the delivery worktree",
    () =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const factory = yield* Factory.FactoryService.FactoryService;
          yield* writeOverride(world.root, "plan", rules("plan"));
          yield* writeOverride(world.root, "review", rules("review"));
          yield* writeOverride(world.root, "integrate", rules("integrate"));
          const planner = yield* world.startWith({ kind: "parent" });
          assert.include(turnOf(world, planner.runId).message.text, rules("plan"));
          assert.notInclude(turnOf(world, planner.runId).message.text, "Inspect only:");
          yield* writeOverride(planner.worktreePath, "author", rules("worktree-only"));
          yield* git(planner.worktreePath, ["add", ".foredeck"]);
          yield* git(planner.worktreePath, [
            ...identity,
            "commit",
            "--no-verify",
            "-m",
            "chore: add project rules",
          ]);
          yield* factory.submitPlan({ threadId: planner.threadId, plan });
          yield* world.endRun(planner.runId, "completed");
          yield* factory.approvePlan(planner.deliveryId);
          yield* drainFactory;
          const childId =
            (yield* stateOf(planner.deliveryId)).children[0] ?? assert.fail("No child.");
          const author = yield* world.launched(childId);
          assert.strictEqual(author.worktreePath, planner.worktreePath);
          const text = turnOf(world, author.runId).message.text;
          assert.notInclude(text, rules("worktree-only"));
          assert.include(text, "Implement only this task;");
          yield* authorCommits(author.worktreePath, "feat: export rows");
          yield* world.endRun(author.runId, "completed");
          const review = yield* awaitedRun(childId);
          assert.include(turnOf(world, review.runId).message.text, rules("review"));
          assert.notInclude(turnOf(world, review.runId).message.text, rules("integrate"));
          yield* factory.submitReview({ threadId: review.threadId, review: passingReview });
          yield* world.endRun(review.runId, "completed");
          const integrate = yield* awaitedRun(planner.deliveryId);
          assert.include(turnOf(world, integrate.runId).message.text, rules("integrate"));
          assert.notInclude(turnOf(world, integrate.runId).message.text, rules("review"));
          assert.include(turnOf(world, integrate.runId).message.text, "Criterion 1: Rows export.");
          assert.include(turnOf(world, integrate.runId).message.text, "factory_submit_review");
          yield* writeOverride(world.root, "integrate", rules("integrate-correction"));
          yield* world.endRun(integrate.runId, "completed");
          const correction = yield* awaitedRun(planner.deliveryId);
          assert.include(
            turnOf(world, correction.runId).message.text,
            rules("integrate-correction"),
          );
          assert.notInclude(turnOf(world, correction.runId).message.text, rules("review"));
          assert.include(
            turnOf(world, correction.runId).message.text,
            "Factory could not accept your review:",
          );
        }),
      ),
  );

  it.live(
    "rereads author, fix-review and review rules from the canonical checkout, including later review rounds",
    () =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const factory = yield* Factory.FactoryService.FactoryService;
          yield* writeOverride(world.root, "author", rules("author"));
          const author = yield* world.start;
          assert.include(turnOf(world, author.runId).message.text, rules("author"));
          assert.notInclude(turnOf(world, author.runId).message.text, "Implement only this task;");
          yield* writeOverride(world.root, "review", rules("review-first"));
          yield* authorCommits(author.worktreePath, "feat: export rows");
          yield* world.endRun(author.runId, "completed");
          const review = yield* awaitedRun(author.deliveryId);
          assert.include(turnOf(world, review.runId).message.text, rules("review-first"));
          yield* writeOverride(world.root, "fix-review", rules("fix-review"));
          yield* factory.submitReview({ threadId: review.threadId, review: blockingReview });
          yield* world.endRun(review.runId, "completed");
          const repair = yield* awaitedRun(author.deliveryId);
          assert.include(turnOf(world, repair.runId).message.text, rules("fix-review"));
          assert.include(
            turnOf(world, repair.runId).message.text,
            "Empty input crashes the export.",
          );
          yield* writeOverride(world.root, "review", rules("review-second"));
          yield* authorCommits(
            author.worktreePath,
            "fix: handle empty rows",
            "export const x = 2;\n",
          );
          yield* world.endRun(repair.runId, "completed");
          const followUp = yield* awaitedRun(author.deliveryId);
          assert.strictEqual(followUp.threadId, review.threadId);
          assert.include(turnOf(world, followUp.runId).message.text, rules("review-second"));
          assert.notInclude(turnOf(world, followUp.runId).message.text, rules("review-first"));
          assert.notInclude(
            turnOf(world, followUp.runId).message.text,
            "Review independently and read-only:",
          );
          assert.include(turnOf(world, followUp.runId).message.text, "empty-export");
          assert.include(turnOf(world, followUp.runId).message.text, "The review's fields:");
        }),
      ),
  );

  it.live(
    "rereads a changed canonical fix-verify file on the next repair turn without restarting the delivery",
    () =>
      withProject(verifyCommands.fails, (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          yield* writeOverride(world.root, "fix-verify", rules("verify-first"));
          yield* authorCommits(author.worktreePath, "feat: export rows");
          yield* world.endRun(author.runId, "completed");
          const first = yield* awaitedRun(author.deliveryId);
          assert.include(turnOf(world, first.runId).message.text, rules("verify-first"));
          yield* writeOverride(world.root, "fix-verify", rules("verify-second"));
          yield* authorCommits(
            author.worktreePath,
            "fix: handle empty rows",
            "export const x = 2;\n",
          );
          yield* world.endRun(first.runId, "completed");
          const second = yield* awaitedRun(author.deliveryId);
          assert.strictEqual(second.threadId, author.threadId);
          assert.include(turnOf(world, second.runId).message.text, rules("verify-second"));
          assert.notInclude(turnOf(world, second.runId).message.text, rules("verify-first"));
          assert.notInclude(turnOf(world, second.runId).message.text, "Reassess the root cause");
          assert.include(turnOf(world, second.runId).message.text, "one check failed");
        }),
      ),
  );

  it.live(
    "rereads plan rules for correction and owner replan turns without losing their facts",
    () =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const factory = yield* Factory.FactoryService.FactoryService;
          yield* writeOverride(world.root, "plan", rules("initial-plan"));
          const planner = yield* world.startWith({ kind: "parent" });
          yield* writeOverride(world.root, "plan", rules("correct-plan"));
          // No structured submission: the completed planner gets its one correction turn.
          yield* world.endRun(planner.runId, "completed");
          const correction = yield* awaitedRun(planner.deliveryId);
          assert.include(turnOf(world, correction.runId).message.text, rules("correct-plan"));
          assert.include(
            turnOf(world, correction.runId).message.text,
            "Factory could not accept your plan:",
          );
          assert.include(turnOf(world, correction.runId).message.text, "factory_submit_plan");
          yield* factory.submitPlan({ threadId: correction.threadId, plan });
          yield* world.endRun(correction.runId, "completed");
          yield* writeOverride(world.root, "plan", rules("replan"));
          yield* factory.replan({
            deliveryId: planner.deliveryId,
            note: "Keep this exact owner note.",
          });
          yield* drainFactory;
          const replanning = yield* awaitedRun(planner.deliveryId);
          assert.include(turnOf(world, replanning.runId).message.text, rules("replan"));
          assert.include(
            turnOf(world, replanning.runId).message.text,
            "> Keep this exact owner note.",
          );
          assert.include(turnOf(world, replanning.runId).message.text, "factory_submit_plan");
        }),
      ),
  );

  it.live("rereads review rules for correction turns while retaining the submission problems", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const author = yield* world.start;
        yield* authorCommits(author.worktreePath, "feat: export rows");
        yield* world.endRun(author.runId, "completed");
        const reviewer = yield* awaitedRun(author.deliveryId);
        yield* writeOverride(world.root, "review", rules("correct-review"));
        yield* world.endRun(reviewer.runId, "completed");
        const correction = yield* awaitedRun(author.deliveryId);
        assert.include(turnOf(world, correction.runId).message.text, rules("correct-review"));
        assert.include(
          turnOf(world, correction.runId).message.text,
          "Factory could not accept your review:",
        );
        assert.include(turnOf(world, correction.runId).message.text, "factory_submit_review");
      }),
    ),
  );

  it.live(
    "uses canonical fix-commit rules while retaining the mechanical problems and baseline",
    () =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const author = yield* world.start;
          yield* writeOverride(world.root, "fix-commit", rules("fix-commit"));
          yield* fs.writeFileString(
            path.join(author.worktreePath, "export.ts"),
            "uncommitted work",
          );
          yield* world.endRun(author.runId, "completed");
          const repair = yield* awaitedRun(author.deliveryId);
          const state = yield* stateOf(author.deliveryId);
          const text = turnOf(world, repair.runId).message.text;
          assert.include(text, rules("fix-commit"));
          assert.notInclude(text, "Fix only these problems, then stop:");
          assert.include(text, "Worktree has uncommitted or untracked changes.");
          assert.include(text, `commits after ${state.baseline}`);
        }),
      ),
  );

  it.live.each([
    "directory",
    "escape",
    "dangling",
    "invalid-utf8",
    "blank",
    "oversize",
    "parent-escape",
    "parent-dangling",
  ] as const)(
    "a present %s override blocks with fixed prompt-only text, and public resume sends the turn after repair",
    (kind) =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const factory = yield* Factory.FactoryService.FactoryService;
          const secret = "PRIVATE-OVERRIDE-CONTENT";
          const file = yield* writeOverride(world.root, "author", secret);
          if (kind === "directory") {
            yield* fs.remove(file);
            yield* fs.makeDirectory(file);
          } else if (kind === "escape" || kind === "dangling") {
            const outside = path.join(world.t3Home, "outside.md");
            if (kind === "escape") yield* fs.writeFileString(outside, secret);
            yield* fs.remove(file);
            yield* fs.symlink(outside, file);
          } else if (kind === "parent-escape" || kind === "parent-dangling") {
            const directory = path.dirname(file);
            yield* fs.remove(directory, { recursive: true });
            const outside = path.join(world.t3Home, "outside-prompts");
            if (kind === "parent-escape") yield* fs.makeDirectory(outside);
            // The outside directory need not have author.md: its presence must not become a fallback.
            yield* fs.symlink(outside, directory);
          } else if (kind === "invalid-utf8") {
            yield* fs.writeFile(file, new Uint8Array([0xc3, 0x28]));
          } else {
            yield* fs.writeFileString(
              file,
              kind === "blank" ? " \n\t" : secret.repeat(MAX_PROMPT_OVERRIDE_BYTES),
            );
          }
          const { deliveryId } = yield* factory.start({ itemRef: world.itemRef });
          yield* drainFactory;
          const blocked = yield* stateOf(deliveryId);
          assert.strictEqual(blocked.status, "blocked");
          assert.deepStrictEqual(blocked.block, {
            reason: "effect_failed",
            effect: {
              type: "launch_thread",
              id: 1,
              role: "author",
              workspace: { type: "worktree", baseRef: blocked.baseRef, branch: blocked.branch },
            },
            detail:
              "Factory could not launch the author thread. Factory cannot use the author prompt override. Fix or remove the override file and resume.",
          });
          assert.notInclude(JSON.stringify(blocked), secret);
          assert.strictEqual(world.provider.started.length, 0);
          assert.deepStrictEqual(blocked.threads, {});
          if (kind === "parent-escape" || kind === "parent-dangling") {
            yield* fs.remove(path.dirname(file));
          } else {
            yield* fs.remove(file, { recursive: true });
          }
          yield* writeOverride(world.root, "author", rules("fixed-author"));
          yield* factory.resume(deliveryId);
          const resumed = yield* world.launched(deliveryId);
          assert.include(turnOf(world, resumed.runId).message.text, rules("fixed-author"));
          assert.isNull((yield* stateOf(deliveryId)).block);
          assert.strictEqual(world.provider.started.length, 1);
        }),
      ),
  );

  it.live(
    "an unusable turn override blocks before sending, and resume rereads the repaired file",
    () =>
      withProject(verifyCommands.fails, (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const factory = yield* Factory.FactoryService.FactoryService;
          const author = yield* world.start;
          const file = yield* writeOverride(world.root, "fix-verify", " \n");
          yield* authorCommits(author.worktreePath, "feat: export rows");
          yield* world.endRun(author.runId, "completed");
          const blocked = yield* stateOf(author.deliveryId);
          assert.strictEqual(blocked.status, "blocked");
          assert.strictEqual(
            blocked.block?.reason === "effect_failed" ? blocked.block.detail : null,
            "Factory could not send the fix-verify turn. Factory cannot use the fix-verify prompt override. Fix or remove the override file and resume.",
          );
          assert.strictEqual(world.provider.started.length, 1);
          yield* fs.writeFileString(file, rules("fixed-verify"));
          yield* factory.resume(author.deliveryId);
          yield* drainFactory;
          const repair = yield* awaitedRun(author.deliveryId);
          assert.include(turnOf(world, repair.runId).message.text, rules("fixed-verify"));
          assert.strictEqual(repair.threadId, author.threadId);
          assert.strictEqual(world.provider.started.length, 2);
        }),
      ),
  );

  it.live(
    "accepts an internal symlink and the byte limit, and ignores an absent file in an existing prompt directory",
    () =>
      withProject(verifyCommands.passes, (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const text = "é".repeat(MAX_PROMPT_OVERRIDE_BYTES / 2);
          const target = path.join(world.root, "project-rules.md");
          yield* fs.writeFileString(target, text);
          const file = yield* writeOverride(world.root, "author", "placeholder");
          yield* fs.remove(file);
          yield* fs.symlink(target, file);
          const author = yield* world.start;
          assert.include(turnOf(world, author.runId).message.text, text);
          yield* authorCommits(author.worktreePath, "feat: export rows");
          yield* world.endRun(author.runId, "completed");
          const review = yield* awaitedRun(author.deliveryId);
          assert.include(
            turnOf(world, review.runId).message.text,
            "Review independently and read-only:",
          );
        }),
      ),
  );
});
