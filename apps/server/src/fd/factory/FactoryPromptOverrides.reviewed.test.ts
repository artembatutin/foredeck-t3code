import { assert, describe, it } from "@effect/vitest";
import type { RunId } from "@t3tools/contracts";
import type {
  FactoryDeliveryId,
  FactoryPromptName,
  FactoryReviewedExecution,
} from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as Factory from "./index.ts";
import type { FactoryDeliveryState } from "./pipeline/state.ts";
import { reviewedContentHash } from "./reviewedExecution.ts";
import {
  authorCommits,
  drainFactory,
  git,
  type Services,
  stateOf,
  verifyCommands,
  type World,
  withProject,
} from "./testkit/deliveryHarness.ts";
import { awaitedRun, passingReview } from "./testkit/followThrough.ts";
import { failsUntilFixed, offeredModels, reviewNow, setSettings } from "./testkit/reviewed.ts";

/**
 * The rule files a project overrides, for a delivery whose owner reviewed them: bound by hash from
 * the canonical checkout, compared before each launch or turn that reads one. Every prompt, under
 * every way its file can differ, between two stages and across a restart.
 */

const factoryService = Factory.FactoryService.FactoryService;
const identity = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];
const rules = (name: string) => `Project ${name} rules\n\nKeep this exact whitespace.\n`;

const overrideFile = (root: string, name: FactoryPromptName) =>
  Effect.map(Path.Path, (path) => path.join(root, ".foredeck", "factory", "prompts", `${name}.md`));

const writeOverride = (world: World, name: FactoryPromptName, text: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* overrideFile(world.root, name);
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(file, text);
  }).pipe(Effect.orDie);

const removeOverride = (world: World, name: FactoryPromptName) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.remove(yield* overrideFile(world.root, name));
  }).pipe(Effect.orDie);

const turnOf = (world: World, runId: RunId) =>
  world.provider.started.find((turn) => turn.runId === runId) ?? assert.fail("No provider turn.");

const startReviewed = (world: World, settings: object, kind?: "parent") =>
  Effect.gen(function* () {
    yield* setSettings(world, settings);
    const reviewed = yield* reviewNow(world);
    const { deliveryId } = yield* Effect.flatMap(factoryService, (factory) =>
      factory.start({
        itemRef: world.itemRef,
        reviewedExecution: reviewed,
        ...(kind === undefined ? {} : { kind }),
      }),
    );
    return { root: deliveryId, reviewed };
  }).pipe(Effect.orDie);

/**
 * Refused before anything ran, with text naming only the prompt and what to do about it: the
 * effect it blocked on started no provider turn.
 */
const assertDrifted = (world: World, deliveryId: FactoryDeliveryId, prompt: FactoryPromptName) =>
  Effect.gen(function* () {
    const state = yield* stateOf(deliveryId);
    assert.strictEqual(state.status, "blocked");
    assert.strictEqual(state.block?.reason, "effect_failed");
    if (state.block?.reason !== "effect_failed") return;
    assert.include(state.block.detail, `The ${prompt} prompt override is not the one reviewed`);
    assert.include(state.block.detail, "Restore it exactly or review the delivery again.");
    // Nothing of what the file holds, or where it lies.
    assert.notInclude(state.block.detail, "Project");
    assert.notInclude(state.block.detail, ".foredeck");
    const suffix = `:${deliveryId}:${state.block.effect.id}`;
    assert.isFalse(world.provider.started.some((turn) => turn.message.messageId.endsWith(suffix)));
  });

const onePlan = {
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

const blockingReview = {
  ...passingReview(),
  verdict: "changes-required",
  findings: [
    {
      id: "empty",
      severity: "high",
      required: true,
      file: "export.ts",
      line: 1,
      detail: "Empty input crashes.",
    },
  ],
};

/** Everything here fails only with tagged errors; a test ends on any. */
type Failure = { readonly _tag: string };
type Step = Effect.Effect<unknown, Failure, Services>;

const dirtyWorktree = (worktreePath: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.writeFileString(`${worktreePath}/export.ts`, "uncommitted\n"),
  );

const worktreeOf = (deliveryId: FactoryDeliveryId) =>
  Effect.map(
    stateOf(deliveryId),
    ({ worktreePath }) => worktreePath ?? assert.fail("No worktree."),
  );

/** The reviewer the delivery awaits blocks the commit; its run has not ended. */
const reviewerBlocks = (deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const review = yield* awaitedRun(deliveryId);
    yield* Effect.flatMap(factoryService, (factory) =>
      factory.submitReview({ threadId: review.threadId, review: blockingReview }),
    );
    return review;
  });

/** A parent's planner that has submitted its plan, its run not ended. */
const plannerSubmitted = (world: World, root: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const planner = yield* world.launched(root);
    yield* Effect.flatMap(factoryService, (factory) =>
      factory.submitPlan({ threadId: planner.threadId, plan: onePlan }),
    );
    return planner;
  });

/**
 * One prompt's way to the effect that reads it. `arrive` runs up to a step: `end`, which ends the
 * run under way, and `next`, what then leads to the read. Between stages the file changes before
 * `end`. Across a restart the delivery stops at `end`, and the file changes while it is down, before
 * the resume and `nextAfterRestart`.
 */
interface Scenario {
  readonly prompt: FactoryPromptName;
  readonly settings: object;
  readonly kind?: "parent";
  readonly arrive: (
    world: World,
    root: FactoryDeliveryId,
    restarting: boolean,
  ) => Effect.Effect<
    { readonly end: Step; readonly next?: Step; readonly nextAfterRestart?: Step },
    Failure,
    Services
  >;
  /** The delivery the read blocks: the parent's child, for an author's launch. */
  readonly blocked?: (root: FactoryDeliveryId) => Effect.Effect<FactoryDeliveryId, never, Services>;
  /** Once restored and resumed, what still leads to the read, and the run that made it. */
  readonly recover: (
    world: World,
    deliveryId: FactoryDeliveryId,
  ) => Effect.Effect<{ readonly runId: RunId }, Failure, Services>;
  /** The count the read's turn would charge, when a review approves one for it. */
  readonly charged?: (state: FactoryDeliveryState) => number;
}

const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    prompt: "plan",
    settings: { verifyCommand: verifyCommands.passes },
    kind: "parent",
    arrive: (world, root) =>
      Effect.map(plannerSubmitted(world, root), (planner) => ({
        end: world.endRun(planner.runId, "completed"),
        next: Effect.flatMap(factoryService, (factory) =>
          factory.replan({ deliveryId: root, note: "Split it." }),
        ),
      })),
    recover: (_world, root) => awaitedRun(root),
  },
  {
    prompt: "author",
    settings: { verifyCommand: verifyCommands.passes },
    kind: "parent",
    arrive: (world, root) =>
      Effect.map(plannerSubmitted(world, root), (planner) => ({
        end: world.endRun(planner.runId, "completed"),
        next: Effect.flatMap(factoryService, (factory) => factory.approvePlan(root)),
      })),
    blocked: (root) =>
      Effect.map(
        stateOf(root),
        ({ children }) => children[0] ?? assert.fail("The approval made no child."),
      ).pipe(Effect.orDie),
    recover: (_world, child) => awaitedRun(child),
  },
  {
    prompt: "review",
    settings: { verifyCommand: verifyCommands.passes },
    arrive: (world, root) =>
      Effect.gen(function* () {
        const author = yield* world.launched(root);
        yield* authorCommits(author.worktreePath, "feat: add the export button");
        return { end: world.endRun(author.runId, "completed") };
      }),
    recover: (_world, root) => awaitedRun(root),
  },
  {
    prompt: "fix-verify",
    // Its one fix round, which a refused turn must not spend.
    settings: { verifyCommand: failsUntilFixed, limits: { maxFixRounds: 1 } },
    arrive: (world, root) =>
      Effect.gen(function* () {
        const author = yield* world.launched(root);
        yield* authorCommits(author.worktreePath, "feat: add the export button");
        return { end: world.endRun(author.runId, "completed") };
      }),
    recover: (_world, root) => awaitedRun(root),
    charged: ({ rounds }) => rounds.fix,
  },
  {
    prompt: "fix-review",
    settings: { verifyCommand: verifyCommands.passes, limits: { maxReviewRounds: 1 } },
    arrive: (world, root) =>
      Effect.gen(function* () {
        const author = yield* world.launched(root);
        yield* authorCommits(author.worktreePath, "feat: add the export button");
        yield* world.endRun(author.runId, "completed");
        const review = yield* reviewerBlocks(root);
        return {
          end: world.endRun(review.runId, "completed"),
          // Stopped where the repair would begin, its resume verifies and reviews afresh first.
          nextAfterRestart: Effect.gen(function* () {
            const again = yield* reviewerBlocks(root);
            yield* world.endRun(again.runId, "completed");
          }),
        };
      }),
    recover: (world, root) =>
      Effect.gen(function* () {
        const review = yield* reviewerBlocks(root);
        yield* world.endRun(review.runId, "completed");
        return yield* awaitedRun(root);
      }),
    charged: ({ rounds }) => rounds.review,
  },
  {
    prompt: "fix-commit",
    // The one fix-commit turn a review approves, which a refused turn must not spend.
    settings: { verifyCommand: verifyCommands.passes },
    arrive: (world, root, restarting) =>
      Effect.gen(function* () {
        const author = yield* world.launched(root);
        // A settle check's turn is work inside a stage, so only a settled branch can stop; the
        // restart's resume then finds the worktree dirty.
        if (restarting) {
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          return {
            end: world.endRun(author.runId, "completed"),
            nextAfterRestart: Effect.void,
          };
        }
        yield* dirtyWorktree(author.worktreePath);
        return { end: world.endRun(author.runId, "completed") };
      }),
    recover: (_world, root) => awaitedRun(root),
    charged: ({ fixCommitTurns }) => fixCommitTurns,
  },
  {
    prompt: "integrate",
    settings: { verifyCommand: verifyCommands.passes },
    kind: "parent",
    arrive: (world, root) =>
      Effect.gen(function* () {
        const factory = yield* factoryService;
        const planner = yield* plannerSubmitted(world, root);
        yield* world.endRun(planner.runId, "completed");
        yield* factory.approvePlan(root);
        yield* drainFactory;
        const childId = (yield* stateOf(root)).children[0] ?? assert.fail("No child.");
        const author = yield* world.launched(childId);
        yield* authorCommits(author.worktreePath, "feat: export rows");
        yield* world.endRun(author.runId, "completed");
        const review = yield* awaitedRun(childId);
        yield* factory.submitReview({ threadId: review.threadId, review: passingReview() });
        return { end: world.endRun(review.runId, "completed") };
      }),
    recover: (_world, root) => awaitedRun(root),
  },
];

const MUTATIONS: ReadonlyArray<{
  readonly mutation: string;
  /** Whether the file exists when the owner reviews. */
  readonly present: boolean;
  readonly mutate: (
    world: World,
    prompt: FactoryPromptName,
  ) => Effect.Effect<void, never, Services>;
}> = [
  {
    mutation: "an edit",
    present: true,
    mutate: (world, prompt) => writeOverride(world, prompt, rules("edited")),
  },
  {
    mutation: "an addition",
    present: false,
    mutate: (world, prompt) => writeOverride(world, prompt, rules("added")),
  },
  { mutation: "a removal", present: true, mutate: removeOverride },
  {
    mutation: "a file that became unusable",
    present: true,
    mutate: (world, prompt) => writeOverride(world, prompt, "   \n"),
  },
];

const CASES = SCENARIOS.flatMap((scenario) =>
  MUTATIONS.map((mutation) => ({ ...mutation, scenario, prompt: scenario.prompt })),
);

/** Back to what the owner reviewed, to the byte. */
const restoreOf = (world: World, prompt: FactoryPromptName, present: boolean) =>
  present ? writeOverride(world, prompt, rules(prompt)) : removeOverride(world, prompt);

/**
 * Restored exactly, a resume goes on and the turn runs under the very text reviewed, and only now
 * spends what it would have charged.
 */
const assertRecovers = (
  world: World,
  scenario: Scenario,
  blocked: FactoryDeliveryId,
  present: boolean,
) =>
  Effect.gen(function* () {
    const refused = yield* stateOf(blocked);
    if (scenario.charged !== undefined) assert.strictEqual(scenario.charged(refused), 0);
    yield* restoreOf(world, scenario.prompt, present);
    yield* Effect.flatMap(factoryService, (factory) => factory.resume(blocked));
    yield* drainFactory;
    const { runId } = yield* scenario.recover(world, blocked);
    const text = turnOf(world, runId).message.text;
    if (present) assert.include(text, rules(scenario.prompt));
    else assert.notInclude(text, "rules\n\nKeep this exact whitespace.");
    if (scenario.charged !== undefined) {
      assert.strictEqual(scenario.charged(yield* stateOf(blocked)), 1);
    }
  });

describe("a reviewed delivery's prompt overrides", () => {
  it.live.each(CASES)(
    "holds back $prompt on $mutation between stages, until it is restored",
    ({ scenario, prompt, present, mutate }) =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            if (present) yield* writeOverride(world, prompt, rules(prompt));
            const { root } = yield* startReviewed(world, scenario.settings, scenario.kind);
            const { end, next } = yield* scenario.arrive(world, root, false);
            yield* mutate(world, prompt);
            yield* end;
            if (next !== undefined) yield* next;
            yield* drainFactory;
            const blocked = yield* (scenario.blocked ?? Effect.succeed)(root);
            yield* assertDrifted(world, blocked, prompt);

            // Refused again while it differs.
            yield* Effect.flatMap(factoryService, (factory) => factory.resume(blocked));
            yield* drainFactory;
            if (prompt !== "fix-review") yield* assertDrifted(world, blocked, prompt);
            else {
              const again = yield* reviewerBlocks(blocked);
              yield* world.endRun(again.runId, "completed");
              yield* assertDrifted(world, blocked, prompt);
            }
            yield* assertRecovers(world, scenario, blocked, present);
          }).pipe(Effect.orDie),
        { providers: offeredModels() },
      ),
  );

  it.live.each(CASES)(
    "holds back $prompt on $mutation made while a restart was down, until it is restored",
    ({ scenario, prompt, present, mutate }) =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            if (present) yield* writeOverride(world, prompt, rules(prompt));
            const { root } = yield* startReviewed(world, scenario.settings, scenario.kind);
            const { end, next, nextAfterRestart } = yield* scenario.arrive(world, root, true);
            yield* Effect.flatMap(factoryService, (factory) => factory.stop(root));
            yield* end;
            assert.strictEqual((yield* stateOf(root)).status, "stopped");

            yield* world.rebuild(
              Effect.gen(function* () {
                yield* mutate(world, prompt);
                if (prompt === "fix-commit") {
                  yield* dirtyWorktree(yield* worktreeOf(root));
                }
                yield* Effect.flatMap(factoryService, (factory) => factory.resume(root));
                yield* drainFactory;
                const lead = nextAfterRestart ?? next;
                if (lead !== undefined) yield* lead;
                yield* drainFactory;
                const blocked = yield* (scenario.blocked ?? Effect.succeed)(root);
                yield* assertDrifted(world, blocked, prompt);
                yield* assertRecovers(world, scenario, blocked, present);
              }),
              { orchestration: true },
            );
          }).pipe(Effect.orDie),
        { providers: offeredModels() },
      ),
  );

  it.live("binds each prompt's hash, and an absent marker for those without a file", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* writeOverride(world, "review", rules("review"));
          yield* setSettings(world, { verifyCommand: verifyCommands.passes });
          const reviewed: FactoryReviewedExecution = yield* reviewNow(world);
          assert.deepStrictEqual(reviewed.promptOverrides, {
            plan: "absent",
            author: "absent",
            review: reviewedContentHash(rules("review")),
            "fix-verify": "absent",
            "fix-review": "absent",
            "fix-commit": "absent",
            integrate: "absent",
          });
        }).pipe(Effect.orDie),
      { providers: offeredModels() },
    ),
  );

  it.live("holds back a first launch when its prompt changed before the start", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* setSettings(world, { verifyCommand: verifyCommands.passes });
          const reviewed = yield* reviewNow(world);
          yield* writeOverride(world, "author", rules("added"));
          const { deliveryId } = yield* Effect.flatMap(factoryService, (factory) =>
            factory.start({ itemRef: world.itemRef, reviewedExecution: reviewed }),
          );
          yield* drainFactory;
          yield* assertDrifted(world, deliveryId, "author");
          assert.deepStrictEqual(world.provider.started, []);
        }).pipe(Effect.orDie),
      { providers: offeredModels() },
    ),
  );

  it.live("spends the allowance of a turn that was sent, whatever became of its prompt after", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { root } = yield* startReviewed(world, { verifyCommand: verifyCommands.passes });
          const author = yield* world.launched(root);
          yield* dirtyWorktree(author.worktreePath);
          yield* world.endRun(author.runId, "completed");
          const mechanical = yield* awaitedRun(root);
          assert.strictEqual((yield* stateOf(root)).fixCommitTurns, 1);
          // Its turn ran, and left the branch dirty: only that turn's allowance is gone.
          yield* writeOverride(world, "fix-commit", rules("added"));
          yield* world.endRun(mechanical.runId, "completed");
          const state = yield* stateOf(root);
          assert.deepInclude(state.block, {
            reason: "allowance_exhausted",
            allowance: "fix_commit",
            used: 1,
            approved: 1,
          });
          yield* git(author.worktreePath, ["add", "-A"]);
          yield* git(author.worktreePath, [...identity, "commit", "--no-verify", "-m", "feat: go"]);
        }).pipe(Effect.orDie),
      { providers: offeredModels() },
    ),
  );

  it.live("binds neither AGENTS.md nor any other repository file", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* writeOverride(world, "review", rules("review"));
          yield* fileSystem.writeFileString(path.join(world.root, "AGENTS.md"), "Be careful.\n");
          const { root } = yield* startReviewed(world, { verifyCommand: verifyCommands.passes });
          const author = yield* world.launched(root);
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* fileSystem.writeFileString(path.join(world.root, "AGENTS.md"), "Be quick.\n");
          yield* fileSystem.writeFileString(path.join(world.root, "README.md"), "# Changed\n");
          yield* world.endRun(author.runId, "completed");
          const reviewer = yield* awaitedRun(root);
          assert.include(turnOf(world, reviewer.runId).message.text, rules("review"));
        }).pipe(Effect.orDie),
      { providers: offeredModels() },
    ),
  );
});
