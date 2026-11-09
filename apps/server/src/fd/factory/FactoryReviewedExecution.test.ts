import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type ModelSelection,
  type ProviderOptionDescriptor,
  type RunId,
  type RuntimeMode,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import type { FactoryDeliveryId, FactoryReviewedExecution } from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { HandoffAdmission, HandoffBackend } from "../assistant/index.ts";
import * as Factory from "./index.ts";
import {
  authorCommits,
  drainFactory,
  fakePullRequest,
  git,
  stateOf,
  threadProjection,
  verifyCommands,
  type World,
  type Services,
  withProject,
} from "./testkit/deliveryHarness.ts";
import {
  delegateFrom,
  firstRun,
  providerThreadOf,
  providerTurnRunning,
} from "./testkit/familyThreads.ts";
import {
  awaitedRun,
  linkOf,
  passingReview,
  runStarted,
  watchPullRequest,
} from "./testkit/followThrough.ts";
import {
  agreeAndCapture,
  assignToFactory,
  consult,
  consultRunning,
  decisionWatch,
  demandsOf,
  driver,
  fill,
  nativeOffers,
  offerNative,
  release,
  rootIdOf,
  runOfMessage,
  runsOf,
  runsOfMessage,
  slotOf,
  startAssistantThread,
  tick,
  turns,
  wakeThroughGate,
  writtenRows,
} from "./testkit/handoff.ts";
import { withEndpoint } from "./testkit/mcpEndpoint.ts";
import {
  attachReceipt,
  failsUntilFixed,
  markerWritten,
  offeredModels,
  overrideProject,
  reviewNow,
  selection,
  setSettings,
  storeSettings,
  writesMarker,
} from "./testkit/reviewed.ts";
import { verifySettingsHash } from "./verify/FactoryVerifyRunner.ts";

/**
 * A reviewed delivery on the server's real stack, through the assistant's claim: every setting an
 * owner reviews, changed after the review, while it queues, between its stages and after a stop
 * and a rebuild, and whether the reviewed value ran or nothing did.
 */

const factoryService = Factory.FactoryService.FactoryService;
const idea = "export";
const identity = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];

interface Settings {
  readonly verifyCommand: FactoryReviewedExecution["verifyCommand"];
  readonly setupCommand: FactoryReviewedExecution["setupCommand"];
  readonly roles: {
    readonly planner: ModelSelection | null;
    readonly author: ModelSelection | null;
    readonly reviewer: ModelSelection | null;
  };
  readonly limits: {
    readonly maxFixRounds: number;
    readonly maxReviewRounds: number;
    readonly verifyTimeoutMinutes: number;
  };
  readonly blockingSeverities: ReadonlyArray<string>;
  readonly highRiskEffort: string;
  readonly pipelineId: string;
}

/** What the owner reviews in every case, unless a row's `initial` changes part of it. */
const reviewedSettings = (world: World) =>
  Effect.map(writesMarker(world, "reviewed-setup"), (setupCommand): Settings => ({
    verifyCommand: failsUntilFixed,
    setupCommand,
    roles: {
      planner: selection("planner-model", "low"),
      author: selection("author-model", "medium"),
      reviewer: selection("reviewer-model", "low"),
    },
    limits: { maxFixRounds: 2, maxReviewRounds: 2, verifyTimeoutMinutes: 7 },
    blockingSeverities: ["high"],
    highRiskEffort: "high",
    pipelineId: "standard",
  }));

/** A review with a medium finding, which blocks only if medium severities do. */
const reviewWithMediumFinding = {
  ...passingReview(),
  findings: [
    {
      id: "naming",
      severity: "medium",
      required: false,
      file: "export.ts",
      line: 1,
      detail: "A name could be clearer.",
    },
  ],
};

/** Its fix-review turn lists only what the reviewed severities block, so not its medium finding. */
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
      detail: "Empty input crashes the export.",
    },
    {
      id: "wording",
      severity: "medium",
      required: false,
      file: "export.ts",
      line: 1,
      detail: "Prefer a shorter name.",
    },
  ],
};

const atEffort = (selected: ModelSelection, value: string): ModelSelection => ({
  ...selected,
  options: [
    ...(selected.options ?? []).filter(({ id }) => id !== "effort"),
    { id: "effort", value },
  ],
});

/** Commits the file `failsUntilFixed` waits for. */
const commitFixed = (worktreePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFileString(path.join(worktreePath, "fixed.ts"), "export {};\n");
    yield* git(worktreePath, ["add", "-A"]);
    yield* git(worktreePath, [...identity, "commit", "--no-verify", "-m", "fix: add the export"]);
  });

const worktreeOf = (root: FactoryDeliveryId) =>
  Effect.map(
    stateOf(root),
    ({ worktreePath }) => worktreePath ?? assert.fail("The delivery recorded no worktree."),
  );

/**
 * A delivery that just failed its first verify, on to its open pull request: two fix rounds, the
 * second escalated, then a review round that blocks, its fix-review answer, and a later review
 * round whose medium finding passes under the reviewed severities.
 */
const repairAndReview = (world: World, root: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const factory = yield* factoryService;
    const worktreePath = yield* worktreeOf(root);
    const firstFix = yield* awaitedRun(root);
    yield* authorCommits(worktreePath, "fix: try the export again", "export const x = 2;\n");
    yield* world.endRun(firstFix.runId, "completed");
    const secondFix = yield* awaitedRun(root);
    yield* commitFixed(worktreePath);
    yield* world.endRun(secondFix.runId, "completed");
    const review = yield* awaitedRun(root);
    yield* factory.submitReview({ threadId: review.threadId, review: blockingReview });
    yield* world.endRun(review.runId, "completed");
    const answer = yield* awaitedRun(root);
    yield* authorCommits(worktreePath, "fix: handle empty input", "export const x = 3;\n");
    yield* world.endRun(answer.runId, "completed");
    const followUp = yield* awaitedRun(root);
    yield* factory.submitReview({ threadId: followUp.threadId, review: reviewWithMediumFinding });
    yield* world.endRun(followUp.runId, "completed");
    yield* drainFactory;
  }).pipe(Effect.orDie);

/** What the run should have done under the review, read from what actually ran. */
const assertRanAsReviewed = (
  world: World,
  root: FactoryDeliveryId,
  reviewed: FactoryReviewedExecution,
) =>
  Effect.gen(function* () {
    const state = yield* stateOf(root);
    assert.strictEqual(state.status, "pr_open");
    assert.deepStrictEqual(state.reviewedExecution, reviewed);
    assert.deepStrictEqual(state.limits, {
      maxFixRounds: reviewed.limits.maxFixRounds,
      maxReviewRounds: reviewed.limits.maxReviewRounds,
    });
    assert.deepStrictEqual(state.rounds, { fix: 2, review: 1 });
    const turns = world.provider.started.filter(({ threadId }) =>
      Object.values(state.threads).includes(threadId),
    );
    const { author, reviewer } = reviewed.roles;
    assert.deepStrictEqual(
      turns.map(({ modelSelection }) => modelSelection),
      [
        author,
        author,
        atEffort(author, reviewed.highRiskEffort),
        reviewer,
        author,
        atEffort(reviewer, reviewed.highRiskEffort),
      ],
    );
    for (const turn of turns) {
      assert.strictEqual(turn.runtimePolicy.runtimeMode, reviewed.runtimeCeiling);
    }
    for (const receipt of state.receipts) {
      assert.deepStrictEqual(receipt.command, reviewed.verifyCommand);
      assert.strictEqual(receipt.settingsHash, verifySettingsHash(reviewed));
    }
    assert.isTrue(yield* markerWritten(world, "reviewed-setup"));
    assert.isFalse(yield* markerWritten(world, "changed-setup"));
    const fixReview = turns[4]?.message.text ?? assert.fail("No fix-review turn.");
    assert.include(fixReview, "Empty input crashes the export.");
    assert.notInclude(fixReview, "Prefer a shorter name.");
    // A medium finding did not block the last review, whatever the settings say now.
    assert.strictEqual(state.reviews.at(-1)?.summary.blocking, false);
    assert.strictEqual(state.reviews.at(-1)?.summary.findings.medium, 1);
  });

const CHANGE_POINTS = [
  "after review",
  "while queued",
  "between stages",
  "after stop and rebuild",
] as const;
type ChangePoint = (typeof CHANGE_POINTS)[number];

interface Row {
  readonly name: string;
  /** What the settings hold when the owner reviews them, over `reviewedSettings`. */
  readonly initial?: (settings: Settings) => Settings;
  /** What else stands when the owner reviews. */
  readonly before?: (world: World) => ReturnType<typeof overrideProject>;
  readonly change: (world: World, settings: Settings) => Effect.Effect<unknown, never, Services>;
}

const ROWS: ReadonlyArray<Row> = [
  {
    name: "verify command",
    change: (world, settings) =>
      setSettings(world, { ...settings, verifyCommand: verifyCommands.fails }),
  },
  {
    name: "setup command",
    change: (world, settings) =>
      Effect.flatMap(writesMarker(world, "changed-setup"), (setupCommand) =>
        setSettings(world, { ...settings, setupCommand }),
      ),
  },
  {
    name: "author model and options",
    change: (world, settings) =>
      setSettings(world, {
        ...settings,
        roles: { ...settings.roles, author: selection("other-model", "xhigh") },
      }),
  },
  {
    name: "planner model and options",
    change: (world, settings) =>
      setSettings(world, {
        ...settings,
        roles: { ...settings.roles, planner: selection("other-model", "xhigh") },
      }),
  },
  {
    name: "reviewer model and options",
    change: (world, settings) =>
      setSettings(world, {
        ...settings,
        roles: { ...settings.roles, reviewer: selection("other-model", "xhigh") },
      }),
  },
  {
    name: "fix round limit",
    change: (world, settings) =>
      setSettings(world, { ...settings, limits: { ...settings.limits, maxFixRounds: 0 } }),
  },
  {
    name: "review round limit",
    change: (world, settings) =>
      setSettings(world, { ...settings, limits: { ...settings.limits, maxReviewRounds: 0 } }),
  },
  {
    name: "verify timeout",
    change: (world, settings) =>
      setSettings(world, { ...settings, limits: { ...settings.limits, verifyTimeoutMinutes: 1 } }),
  },
  {
    name: "blocking severities",
    change: (world, settings) =>
      setSettings(world, { ...settings, blockingSeverities: ["high", "medium", "low"] }),
  },
  {
    name: "high-risk effort",
    change: (world, settings) => setSettings(world, { ...settings, highRiskEffort: "xhigh" }),
  },
  {
    name: "pipeline id",
    // Only a row another build stored can name a pipeline this server does not ship.
    change: (world, settings) => storeSettings(world, { ...settings, pipelineId: "another" }),
  },
  {
    name: "project default model",
    initial: (settings) => ({
      ...settings,
      roles: { planner: null, author: null, reviewer: null },
    }),
    before: (world) =>
      overrideProject(world, { defaultModelSelection: selection("default-model", "medium") }),
    change: (world) =>
      overrideProject(world, { defaultModelSelection: selection("other-model", "xhigh") }),
  },
  {
    name: "project default runtime mode, widened",
    before: (world) => overrideProject(world, { defaultRuntimeMode: "auto" }),
    change: (world) => overrideProject(world, { defaultRuntimeMode: "full-access" }),
  },
];

/**
 * A delivery of the row's settings through the assistant's claim, with its author's first turn
 * running: the owner reviews, and the change lands at `point`, if that comes before then.
 */
const claimedReview = (world: World, row: Row, point: ChangePoint) =>
  Effect.gen(function* () {
    const settings = (row.initial ?? ((same) => same))(yield* reviewedSettings(world));
    yield* setSettings(world, settings);
    if (row.before !== undefined) yield* row.before(world);
    yield* startAssistantThread(world);
    yield* agreeAndCapture(world, idea);
    const reviewed = yield* reviewNow(world);
    const change = row.change(world, settings);
    if (point === "after review") yield* change;
    yield* assignToFactory(world, idea);
    assert.strictEqual(yield* attachReceipt(idea, reviewed), "attached");
    if (point === "while queued") yield* change;
    yield* tick;
    const root = yield* rootIdOf(idea);
    return { root, reviewed, change };
  });

const CASES = CHANGE_POINTS.flatMap((point) => ROWS.map((row) => ({ name: row.name, point, row })));

describe("what a review stores for a role with no profile of its own", () => {
  it.live("stores the author's selection for a planner and reviewer that default to it", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const author = selection("author-model", "high");
          yield* setSettings(world, {
            verifyCommand: verifyCommands.passes,
            roles: { author },
          });
          const reviewed = yield* reviewNow(world);
          assert.deepStrictEqual(reviewed.roles, { planner: author, author, reviewer: author });

          const { deliveryId } = yield* Effect.flatMap(factoryService, (factory) =>
            factory.start({ itemRef: world.itemRef, reviewedExecution: reviewed }),
          );
          assert.deepStrictEqual((yield* stateOf(deliveryId)).reviewedExecution?.roles, {
            planner: author,
            author,
            reviewer: author,
          });
        }).pipe(Effect.orDie),
      { providers: offeredModels() },
    ),
  );

  it.live("stores the project's default for every role when none has a profile", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const fallback = selection("default-model", "medium");
          yield* overrideProject(world, { defaultModelSelection: fallback });
          yield* setSettings(world, {
            verifyCommand: verifyCommands.passes,
            roles: { planner: null, author: null, reviewer: null },
          });
          const reviewed = yield* reviewNow(world);
          assert.deepStrictEqual(reviewed.roles, {
            planner: fallback,
            author: fallback,
            reviewer: fallback,
          });
        }).pipe(Effect.orDie),
      { providers: offeredModels() },
    ),
  );
});

describe("a reviewed delivery's settings, changed at each point", () => {
  it.live.each(CASES)("runs the reviewed $name when it changes $point", ({ point, row }) =>
    withProject(
      failsUntilFixed,
      (world) =>
        Effect.gen(function* () {
          const { root, reviewed, change } = yield* claimedReview(world, row, point);
          const author = yield* world.launched(root);
          assert.deepStrictEqual((yield* stateOf(root)).reviewedExecution, reviewed);
          if (point === "between stages") yield* change;
          if (point !== "after stop and rebuild") {
            yield* authorCommits(author.worktreePath, "feat: add the export button");
            yield* world.endRun(author.runId, "completed");
            yield* repairAndReview(world, root);
            return yield* assertRanAsReviewed(world, root, reviewed);
          }
          const factory = yield* factoryService;
          yield* factory.stop(root);
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          assert.strictEqual((yield* stateOf(root)).status, "stopped");
          // Inside the rebuild: the harness's server settings do not outlive one.
          yield* world.rebuild(
            Effect.gen(function* () {
              yield* change;
              yield* Effect.flatMap(factoryService, (rebuilt) => rebuilt.resume(root));
              yield* drainFactory;
              yield* repairAndReview(world, root);
              yield* assertRanAsReviewed(world, root, reviewed);
            }),
            { orchestration: true },
          );
        }).pipe(Effect.orDie),
      { handoff: {}, automaticTurnGate: true, providers: offeredModels() },
    ),
  );
});

/**
 * A settings row's change, from the review to where it must not reach. Only a parent runs a planner
 * and an author's setup after a change between its stages, since a single item's one setup comes
 * before them, so only a parent can show either kept to what was reviewed.
 */
const PARENT_ROWS: ReadonlyArray<Row> = [
  {
    name: "planner model and options",
    change: (world, settings) =>
      setSettings(world, {
        ...settings,
        roles: { ...settings.roles, planner: selection("other-model", "xhigh") },
      }),
  },
  {
    name: "setup command",
    change: (world, settings) =>
      Effect.flatMap(writesMarker(world, "changed-setup"), (setupCommand) =>
        setSettings(world, { ...settings, setupCommand }),
      ),
  },
];

const PARENT_CASES = CHANGE_POINTS.flatMap((point) =>
  PARENT_ROWS.map((row) => ({ name: row.name, point, row })),
);

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

/** From a plan at its gate: a replan, its new plan, the approval and the child's author. */
const replanAndApprove = (
  world: World,
  root: FactoryDeliveryId,
  reviewed: FactoryReviewedExecution,
) =>
  Effect.gen(function* () {
    const factory = yield* factoryService;
    assert.isFalse(yield* markerWritten(world, "reviewed-setup"), "No author has launched yet.");
    yield* factory.replan({ deliveryId: root, note: "Keep it to one task." });
    yield* drainFactory;
    const replanned = yield* awaitedRun(root);
    yield* factory.submitPlan({ threadId: replanned.threadId, plan: onePlan });
    yield* world.endRun(replanned.runId, "completed");
    yield* factory.approvePlan(root);
    yield* drainFactory;
    const childId = (yield* stateOf(root)).children[0] ?? assert.fail("No child.");
    const child = yield* world.launched(childId);

    assert.deepStrictEqual(
      providerTurnsOf(world, replanned.threadId).map(({ modelSelection }) => modelSelection),
      [reviewed.roles.planner, reviewed.roles.planner],
    );
    assert.deepStrictEqual(
      providerTurnsOf(world, child.threadId)[0]?.modelSelection,
      reviewed.roles.author,
    );
    assert.deepStrictEqual((yield* stateOf(childId)).reviewedExecution, reviewed);
    // The setup ran after the change, as its owner reviewed it.
    assert.isTrue(yield* markerWritten(world, "reviewed-setup"));
    assert.isFalse(yield* markerWritten(world, "changed-setup"));
  }).pipe(Effect.orDie);

describe("a reviewed parent's planner and later setup, changed at each point", () => {
  it.live.each(PARENT_CASES)("runs the reviewed $name when it changes $point", ({ point, row }) =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* factoryService;
          const settings: Settings = {
            ...(yield* reviewedSettings(world)),
            verifyCommand: verifyCommands.passes,
          };
          yield* setSettings(world, settings);
          yield* startAssistantThread(world);
          yield* agreeAndCapture(world, idea, "parent");
          const reviewed = yield* reviewNow(world);
          const change = row.change(world, settings);
          if (point === "after review") yield* change;
          yield* assignToFactory(world, idea);
          assert.strictEqual(yield* attachReceipt(idea, reviewed), "attached");
          if (point === "while queued") yield* change;
          yield* tick;
          const root = yield* rootIdOf(idea);
          const planner = yield* world.launched(root);
          if (point === "between stages") yield* change;
          if (point === "after stop and rebuild") yield* factory.stop(root);
          yield* factory.submitPlan({ threadId: planner.threadId, plan: onePlan });
          yield* world.endRun(planner.runId, "completed");
          if (point !== "after stop and rebuild") {
            return yield* replanAndApprove(world, root, reviewed);
          }
          assert.strictEqual((yield* stateOf(root)).status, "stopped");
          yield* world.rebuild(
            Effect.gen(function* () {
              yield* change;
              yield* Effect.flatMap(factoryService, (rebuilt) => rebuilt.resume(root));
              yield* drainFactory;
              yield* replanAndApprove(world, root, reviewed);
            }),
            { orchestration: true },
          );
        }).pipe(Effect.orDie),
      { handoff: {}, automaticTurnGate: true, providers: offeredModels() },
    ),
  );
});

describe("a reviewed delivery's fix-commit allowance, changed around at each point", () => {
  /**
   * No setting names this count, so nothing can change it directly; every limit that can change
   * does. It runs what the review approved, two turns where the fixed default is one, then blocks.
   */
  const reviewedForTwo = (world: World) =>
    Effect.gen(function* () {
      const settings: Settings = {
        ...(yield* reviewedSettings(world)),
        verifyCommand: verifyCommands.passes,
      };
      yield* setSettings(world, settings);
      const resolved = yield* reviewNow(world);
      const reviewed: FactoryReviewedExecution = {
        ...resolved,
        limits: { ...resolved.limits, maxFixCommitTurns: 2 },
      };
      return { settings, reviewed };
    });

  const uncommitted = (worktreePath: string) =>
    Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
      fileSystem.writeFileString(`${worktreePath}/export.ts`, "uncommitted\n"),
    );

  /** Two mechanical turns that leave the branch dirty, and no third. */
  const spendsTwo = (world: World, root: FactoryDeliveryId, firstEnds?: RunId) =>
    Effect.gen(function* () {
      if (firstEnds !== undefined) yield* world.endRun(firstEnds, "completed");
      const first = yield* awaitedRun(root);
      assert.strictEqual((yield* stateOf(root)).fixCommitTurns, 1);
      yield* world.endRun(first.runId, "completed");
      const second = yield* awaitedRun(root);
      assert.strictEqual((yield* stateOf(root)).fixCommitTurns, 2);
      const turns = world.provider.started.length;
      yield* world.endRun(second.runId, "completed");
      const state = yield* stateOf(root);
      assert.strictEqual(state.status, "blocked");
      assert.deepInclude(state.block, {
        reason: "allowance_exhausted",
        allowance: "fix_commit",
        used: 2,
        approved: 2,
      });
      assert.lengthOf(world.provider.started, turns);
    }).pipe(Effect.orDie);

  it.live.each(CHANGE_POINTS)("spends what was reviewed when the limits change %s", (point) =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* factoryService;
          const { settings, reviewed } = yield* reviewedForTwo(world);
          const change = setSettings(world, {
            ...settings,
            limits: { maxFixRounds: 0, maxReviewRounds: 0, verifyTimeoutMinutes: 1 },
          });
          yield* startAssistantThread(world);
          yield* agreeAndCapture(world, idea);
          if (point === "after review") yield* change;
          yield* assignToFactory(world, idea);
          assert.strictEqual(yield* attachReceipt(idea, reviewed), "attached");
          if (point === "while queued") yield* change;
          yield* tick;
          const root = yield* rootIdOf(idea);
          const author = yield* world.launched(root);
          if (point !== "after stop and rebuild") {
            if (point === "between stages") yield* change;
            yield* uncommitted(author.worktreePath);
            return yield* spendsTwo(world, root, author.runId);
          }
          // A settle check's turn is work inside a stage, so only a settled branch can stop.
          yield* factory.stop(root);
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          assert.strictEqual((yield* stateOf(root)).status, "stopped");
          yield* world.rebuild(
            Effect.gen(function* () {
              yield* change;
              yield* uncommitted(author.worktreePath);
              yield* Effect.flatMap(factoryService, (rebuilt) => rebuilt.resume(root));
              yield* drainFactory;
              yield* spendsTwo(world, root);
            }),
            { orchestration: true },
          );
        }).pipe(Effect.orDie),
      { handoff: {}, automaticTurnGate: true, providers: offeredModels() },
    ),
  );
});

const providerTurnsOf = (world: World, threadId: ThreadId) =>
  world.provider.started.filter((turn) => turn.threadId === threadId);

/** The reviewed effect that narrowed authority refused: blocked, naming why, nothing more ran. */
const assertRefused = (
  world: World,
  root: FactoryDeliveryId,
  ran: { readonly turns: number; readonly receipts: number },
  text: string,
) =>
  Effect.gen(function* () {
    const state = yield* stateOf(root);
    assert.strictEqual(state.status, "blocked");
    assert.strictEqual(state.block?.reason, "effect_failed");
    if (state.block?.reason === "effect_failed") assert.include(state.block.detail, text);
    assert.lengthOf(state.receipts, ran.receipts);
    const threads = Object.values(state.threads);
    assert.lengthOf(
      world.provider.started.filter(({ threadId }) => threads.includes(threadId)),
      ran.turns,
    );
  });

describe("a reviewed delivery under a narrower project default", () => {
  const narrow = (world: World) =>
    overrideProject(world, { defaultRuntimeMode: "approval-required" });
  const widen = (world: World) => overrideProject(world, { defaultRuntimeMode: "auto" });
  const row: Row = { name: "default", before: widen, change: narrow };
  const options = { handoff: {}, automaticTurnGate: true, providers: offeredModels() };
  const NARROWER = "narrower than auto";

  it.live.each(["after review", "while queued"] as const)(
    "launches nothing when it narrows %s, and goes on once restored",
    (point) =>
      withProject(
        failsUntilFixed,
        (world) =>
          Effect.gen(function* () {
            const { root } = yield* claimedReview(world, row, point);
            yield* drainFactory;
            yield* assertRefused(world, root, { turns: 0, receipts: 0 }, NARROWER);
            assert.deepStrictEqual((yield* stateOf(root)).threads, {});

            yield* widen(world);
            yield* Effect.flatMap(factoryService, (factory) => factory.resume(root));
            const author = yield* world.launched(root);
            assert.strictEqual(
              providerTurnsOf(world, author.threadId)[0]?.runtimePolicy.runtimeMode,
              "auto",
            );
          }).pipe(Effect.orDie),
        options,
      ),
  );

  it.live("starts no verify when it narrows between stages", () =>
    withProject(
      failsUntilFixed,
      (world) =>
        Effect.gen(function* () {
          const { root } = yield* claimedReview(world, row, "between stages");
          const author = yield* world.launched(root);
          yield* narrow(world);
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          yield* assertRefused(world, root, { turns: 1, receipts: 0 }, NARROWER);
        }).pipe(Effect.orDie),
      options,
    ),
  );

  it.live("starts no verify when it narrows after a stop and a rebuild", () =>
    withProject(
      failsUntilFixed,
      (world) =>
        Effect.gen(function* () {
          const { root } = yield* claimedReview(world, row, "after stop and rebuild");
          const author = yield* world.launched(root);
          yield* Effect.flatMap(factoryService, (factory) => factory.stop(root));
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          yield* world.rebuild(
            Effect.gen(function* () {
              yield* narrow(world);
              yield* Effect.flatMap(factoryService, (factory) => factory.resume(root));
              yield* drainFactory;
              yield* assertRefused(world, root, { turns: 1, receipts: 0 }, NARROWER);
            }),
            { orchestration: true },
          );
        }).pipe(Effect.orDie),
      options,
    ),
  );
});

/** A reviewed delivery of the world's own item, started directly under the review. */
const startReviewed = (world: World, settings: object) =>
  Effect.gen(function* () {
    yield* setSettings(world, settings);
    const reviewed = yield* reviewNow(world);
    const factory = yield* factoryService;
    const started = yield* factory.start({ itemRef: world.itemRef, reviewedExecution: reviewed });
    return { root: started.deliveryId, reviewed };
  }).pipe(Effect.orDie);

const pipelineSettings = {
  verifyCommand: failsUntilFixed,
  roles: {
    planner: selection("planner-model", "low"),
    author: selection("author-model", "high"),
    reviewer: selection("reviewer-model", "low"),
  },
  highRiskEffort: "xhigh",
};

const threadSelection = (threadId: ThreadId, modelSelection: ModelSelection, label: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make(`owner-selection:${label}`),
      threadId,
      modelSelection,
    }),
  ).pipe(Effect.orDie);

describe("a reviewed delivery's stages", () => {
  it.live("gives verify and setup the reviewed per-command timeout, whatever is set later", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const setupCommand = yield* writesMarker(world, "reviewed-setup");
          const settings = {
            ...pipelineSettings,
            verifyCommand: verifyCommands.passes,
            setupCommand,
            limits: { verifyTimeoutMinutes: 7 },
          };
          yield* setSettings(world, settings);
          const reviewed = yield* reviewNow(world);
          yield* setSettings(world, { ...settings, limits: { verifyTimeoutMinutes: 1 } });

          const timeouts: Array<number> = [];
          world.processes.around = (input, run) => {
            if (input.command === process.execPath) {
              timeouts.push(Duration.toMinutes(Duration.fromInputUnsafe(input.timeout ?? 0)));
            }
            return run(input);
          };
          const { deliveryId } = yield* Effect.flatMap(factoryService, (factory) =>
            factory.start({ itemRef: world.itemRef, reviewedExecution: reviewed }),
          );
          const author = yield* world.launched(deliveryId);
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          yield* awaitedRun(deliveryId);

          // The setup, then the verify: each its own command under the reviewed minutes.
          assert.deepStrictEqual(timeouts, [7, 7]);
        }).pipe(Effect.orDie),
      { providers: offeredModels() },
    ),
  );

  it.live("refuses a reviewer whose model is no longer offered, and substitutes none", () => {
    const providers = offeredModels();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { root, reviewed } = yield* startReviewed(world, {
            ...pipelineSettings,
            verifyCommand: verifyCommands.passes,
          });
          const author = yield* world.launched(root);
          providers[0] = offeredModels(["author-model"])[0]!;
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");

          yield* assertRefused(
            world,
            root,
            { turns: 1, receipts: 1 },
            "no longer offers reviewer-model",
          );
          assert.isUndefined((yield* stateOf(root)).threads.reviewer);

          // Offered again, a resume verifies afresh and the reviewer runs what was reviewed.
          providers[0] = offeredModels()[0]!;
          yield* Effect.flatMap(factoryService, (factory) => factory.resume(root));
          yield* drainFactory;
          const reviewer = yield* awaitedRun(root);
          assert.deepStrictEqual(
            providerTurnsOf(world, reviewer.threadId)[0]?.modelSelection,
            reviewed.roles.reviewer,
          );
        }).pipe(Effect.orDie),
      { providers },
    );
  });

  /** The provider as offered, with `model`'s descriptors replaced; `undefined` lists none. */
  const offeredWith = (
    model: string,
    optionDescriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
  ) => {
    const [provider] = offeredModels();
    return {
      ...provider,
      models: provider!.models.map((offered) =>
        offered.slug !== model
          ? offered
          : {
              slug: model,
              ...(optionDescriptors === undefined ? {} : { capabilities: { optionDescriptors } }),
            },
      ),
    } as unknown as ServerProvider;
  };

  const booleanEffort: ProviderOptionDescriptor = {
    id: "effort",
    label: "Effort",
    type: "boolean",
  };
  const fewerEfforts: ProviderOptionDescriptor = {
    id: "effort",
    label: "Effort",
    type: "select",
    // Neither role's reviewed effort.
    options: [{ id: "medium", label: "medium", isDefault: true }],
  };

  const OPTION_CHANGES = [
    { name: "its model lists no descriptors", descriptors: undefined },
    { name: "its model lists an empty set of descriptors", descriptors: [] },
    { name: "the option became a boolean", descriptors: [booleanEffort] },
    { name: "its value is no longer among the choices", descriptors: [fewerEfforts] },
  ] as const;

  it.live.each(OPTION_CHANGES)(
    "launches no author whose reviewed option stopped being offered: $name",
    ({ descriptors }) => {
      const providers = offeredModels();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* setSettings(world, pipelineSettings);
            const reviewed = yield* reviewNow(world);
            providers[0] = offeredWith("author-model", descriptors);
            const { deliveryId } = yield* Effect.flatMap(factoryService, (factory) =>
              factory.start({ itemRef: world.itemRef, reviewedExecution: reviewed }),
            );
            yield* drainFactory;
            yield* assertRefused(world, deliveryId, { turns: 0, receipts: 0 }, "author options");
            assert.deepStrictEqual(world.provider.started, []);
            assert.deepStrictEqual((yield* stateOf(deliveryId)).threads, {});
          }).pipe(Effect.orDie),
        { providers },
      );
    },
  );

  it.live.each(OPTION_CHANGES)(
    "launches no reviewer across a restart once its option stopped being offered: $name",
    ({ descriptors }) => {
      const providers = offeredModels();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root } = yield* startReviewed(world, {
              ...pipelineSettings,
              verifyCommand: verifyCommands.passes,
            });
            const author = yield* world.launched(root);
            yield* Effect.flatMap(factoryService, (factory) => factory.stop(root));
            yield* authorCommits(author.worktreePath, "feat: add the export button");
            yield* world.endRun(author.runId, "completed");
            assert.strictEqual((yield* stateOf(root)).status, "stopped");

            yield* world.rebuild(
              Effect.gen(function* () {
                providers[0] = offeredWith("reviewer-model", descriptors);
                yield* Effect.flatMap(factoryService, (factory) => factory.resume(root));
                yield* drainFactory;
                // Verify comes first and judges nothing of a reviewer's model.
                yield* assertRefused(world, root, { turns: 1, receipts: 1 }, "reviewer options");
                assert.isUndefined((yield* stateOf(root)).threads.reviewer);
              }),
              { orchestration: true },
            );
          }).pipe(Effect.orDie),
        { providers },
      );
    },
  );

  it.live(
    "refuses a boolean's reviewed value that became a choice, and takes one still boolean",
    () => {
      const fastMode = { id: "fastMode", label: "Fast", type: "boolean" } as const;
      const fastChoice: ProviderOptionDescriptor = {
        id: "fastMode",
        label: "Fast",
        type: "select",
        options: [{ id: "true", label: "true", isDefault: true }],
      };
      const providers = [offeredWith("author-model", [fastMode])];
      const settings = {
        verifyCommand: verifyCommands.passes,
        roles: {
          author: {
            ...selection("author-model"),
            options: [{ id: "fastMode", value: true }],
          },
        },
      };
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* setSettings(world, settings);
            const reviewed = yield* reviewNow(world);
            providers[0] = offeredWith("author-model", [fastChoice]);
            const { deliveryId } = yield* Effect.flatMap(factoryService, (factory) =>
              factory.start({ itemRef: world.itemRef, reviewedExecution: reviewed }),
            );
            yield* drainFactory;
            yield* assertRefused(world, deliveryId, { turns: 0, receipts: 0 }, "author options");

            // Offered as reviewed again, the same launch runs, with its boolean as it was.
            providers[0] = offeredWith("author-model", [fastMode]);
            yield* Effect.flatMap(factoryService, (factory) => factory.resume(deliveryId));
            const author = yield* world.launched(deliveryId);
            assert.deepStrictEqual(
              providerTurnsOf(world, author.threadId)[0]?.modelSelection,
              reviewed.roles.author,
            );
          }).pipe(Effect.orDie),
        { providers },
      );
    },
  );

  it.live("runs a reviewed selection with no options on a model listing no descriptors", () => {
    const providers = [offeredWith("author-model", undefined)];
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* setSettings(world, {
            verifyCommand: verifyCommands.passes,
            roles: { author: selection("author-model") },
          });
          const reviewed = yield* reviewNow(world);
          const { deliveryId } = yield* Effect.flatMap(factoryService, (factory) =>
            factory.start({ itemRef: world.itemRef, reviewedExecution: reviewed }),
          );
          const author = yield* world.launched(deliveryId);
          assert.deepStrictEqual(
            providerTurnsOf(world, author.threadId)[0]?.modelSelection,
            selection("author-model"),
          );
        }).pipe(Effect.orDie),
      { providers },
    );
  });

  it.live("runs the reviewed selection on a thread whose selection drifted", () =>
    withProject(
      failsUntilFixed,
      (world) =>
        Effect.gen(function* () {
          const { root, reviewed } = yield* startReviewed(world, pipelineSettings);
          const author = yield* world.launched(root);
          yield* threadSelection(author.threadId, selection("other-model", "low"), "drift");
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          const fix = yield* awaitedRun(root);
          assert.strictEqual(fix.threadId, author.threadId);
          assert.deepStrictEqual(
            providerTurnsOf(world, author.threadId).at(-1)?.modelSelection,
            reviewed.roles.author,
          );
        }).pipe(Effect.orDie),
      { providers: offeredModels() },
    ),
  );

  it.live(
    "keeps the mechanical fix-commit effort to its turn, and escalates only as reviewed",
    () =>
      withProject(
        failsUntilFixed,
        (world) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const { root, reviewed } = yield* startReviewed(world, pipelineSettings);
            const author = yield* world.launched(root);
            // Uncommitted work: a repairable settle problem, which gets the mechanical turn.
            yield* fileSystem.writeFileString(`${author.worktreePath}/export.ts`, "uncommitted\n");
            yield* world.endRun(author.runId, "completed");
            const mechanical = yield* awaitedRun(root);
            assert.deepStrictEqual(
              providerTurnsOf(world, author.threadId).at(-1)?.modelSelection,
              atEffort(reviewed.roles.author, "medium"),
            );
            // It commits; verify fails, and the repair turn is back on the reviewed effort.
            yield* git(author.worktreePath, ["add", "-A"]);
            yield* git(author.worktreePath, [
              ...identity,
              "commit",
              "--no-verify",
              "-m",
              "feat: go",
            ]);
            yield* world.endRun(mechanical.runId, "completed");
            const firstFix = yield* awaitedRun(root);
            assert.deepStrictEqual(
              providerTurnsOf(world, author.threadId).at(-1)?.modelSelection,
              reviewed.roles.author,
            );
            // The second round escalates to the reviewed effort, though the settings now say low.
            yield* setSettings(world, { ...pipelineSettings, highRiskEffort: "low" });
            yield* authorCommits(author.worktreePath, "fix: again", "export const x = 2;\n");
            yield* world.endRun(firstFix.runId, "completed");
            yield* awaitedRun(root);
            assert.deepStrictEqual(
              providerTurnsOf(world, author.threadId).at(-1)?.modelSelection,
              atEffort(reviewed.roles.author, "xhigh"),
            );
          }).pipe(Effect.orDie),
        { providers: offeredModels() },
      ),
  );

  it.live("runs a parent's planner, children and integrate reviewer under its one review", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* factoryService;
          const settings = { ...pipelineSettings, verifyCommand: verifyCommands.passes };
          yield* setSettings(world, settings);
          const reviewed = yield* reviewNow(world);
          const started = yield* factory.start({
            itemRef: world.itemRef,
            kind: "parent",
            reviewedExecution: reviewed,
          });
          const root = started.deliveryId;
          const planner = yield* world.launched(root);
          assert.deepStrictEqual(
            providerTurnsOf(world, planner.threadId)[0]?.modelSelection,
            reviewed.roles.planner,
          );
          yield* factory.submitPlan({
            threadId: planner.threadId,
            plan: {
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
            },
          });
          yield* world.endRun(planner.runId, "completed");
          // Changed while the plan waits for its owner: the children run what was reviewed.
          yield* setSettings(world, {
            ...settings,
            verifyCommand: verifyCommands.fails,
            roles: { ...settings.roles, author: selection("other-model", "low") },
          });
          yield* factory.approvePlan(root);
          yield* drainFactory;
          const childId = (yield* stateOf(root)).children[0] ?? assert.fail("No child.");
          assert.deepStrictEqual((yield* stateOf(childId)).reviewedExecution, reviewed);
          const childAuthor = yield* world.launched(childId);
          assert.deepStrictEqual(
            providerTurnsOf(world, childAuthor.threadId)[0]?.modelSelection,
            reviewed.roles.author,
          );
          yield* authorCommits(childAuthor.worktreePath, "feat: export rows");
          yield* world.endRun(childAuthor.runId, "completed");
          const childReview = yield* awaitedRun(childId);
          assert.deepStrictEqual(
            providerTurnsOf(world, childReview.threadId)[0]?.modelSelection,
            reviewed.roles.reviewer,
          );
          yield* factory.submitReview({ threadId: childReview.threadId, review: passingReview() });
          yield* world.endRun(childReview.runId, "completed");
          const integrate = yield* awaitedRun(root);
          assert.deepStrictEqual(
            providerTurnsOf(world, integrate.threadId)[0]?.modelSelection,
            reviewed.roles.reviewer,
          );
          assert.deepStrictEqual(
            (yield* stateOf(root)).receipts.at(-1)?.command,
            reviewed.verifyCommand,
          );
        }).pipe(Effect.orDie),
      { providers: offeredModels() },
    ),
  );
});

/** The delivery of a claimed review with its pull request open and its slot free. */
const openReviewedPullRequest = (world: World) =>
  Effect.gen(function* () {
    const factory = yield* factoryService;
    yield* setSettings(world, { ...pipelineSettings, verifyCommand: verifyCommands.passes });
    yield* startAssistantThread(world);
    const ref = yield* agreeAndCapture(world, idea);
    const reviewed = yield* reviewNow(world);
    yield* assignToFactory(world, idea);
    assert.strictEqual(yield* attachReceipt(idea, reviewed), "attached");
    yield* tick;
    const root = yield* rootIdOf(idea);
    const author = yield* world.launched(root);
    yield* authorCommits(author.worktreePath, "feat: add the export button");
    yield* world.endRun(author.runId, "completed");
    const review = yield* awaitedRun(root);
    yield* factory.submitReview({ threadId: review.threadId, review: passingReview() });
    yield* world.endRun(review.runId, "completed");
    assert.strictEqual((yield* stateOf(root)).status, "pr_open");
    yield* tick;
    const thread = author.threadId;
    yield* watchPullRequest(thread, yield* linkOf(thread, fakePullRequest.number));
    return { root, reviewed, thread, ref, authorRun: author.runId };
  });

describe("a reviewed delivery's pull request feedback", () => {
  it.live("runs a wake under the reviewed selection, whatever the thread drifted to", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { root, reviewed, thread } = yield* openReviewedPullRequest(world);
          yield* threadSelection(thread, selection("other-model", "low"), "drift");
          yield* setSettings(world, {
            ...pipelineSettings,
            verifyCommand: verifyCommands.fails,
            highRiskEffort: "low",
          });

          const wake = yield* wakeThroughGate(
            thread,
            yield* linkOf(thread, fakePullRequest.number),
          );
          assert.strictEqual(wake.outcome._tag, "Ran");
          yield* drainFactory;
          assert.deepStrictEqual(
            providerTurnsOf(world, thread).at(-1)?.modelSelection,
            reviewed.roles.author,
          );

          // The round's verify and fresh reviewer run what was reviewed too.
          yield* world.endRun(wake.runId!, "completed");
          const reviewer = yield* awaitedRun(root);
          const state = yield* stateOf(root);
          assert.deepStrictEqual(state.receipts.at(-1)?.command, reviewed.verifyCommand);
          assert.deepStrictEqual(
            providerTurnsOf(world, reviewer.threadId)[0]?.modelSelection,
            reviewed.roles.reviewer,
          );
        }).pipe(Effect.orDie),
      { handoff: {}, automaticTurnGate: true, providers: offeredModels() },
    ),
  );

  it.live("runs no wake once the reviewed model is gone, and blocks saying so", () => {
    const providers = offeredModels();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { root, thread } = yield* openReviewedPullRequest(world);
          const runs = (yield* runsOf(thread)).length;
          providers[0] = offeredModels(["reviewer-model"])[0]!;

          const consult = yield* Effect.exit(
            wakeThroughGate(thread, yield* linkOf(thread, fakePullRequest.number)),
          );
          assert.isTrue(Exit.isFailure(consult));
          assert.lengthOf(yield* runsOf(thread), runs);
          const state = yield* stateOf(root);
          assert.strictEqual(state.status, "blocked");
          assert.strictEqual(state.block?.reason, "reviewed_refused");
          if (state.block?.reason === "reviewed_refused") {
            assert.include(state.block.detail, "no longer offers author-model");
          }
        }).pipe(Effect.orDie),
      { handoff: {}, automaticTurnGate: true, providers },
    );
  });
});

describe("a reviewed delivery's native wakes", () => {
  /** Capacity full, a provider's background work offered and kept for its own grant. */
  const keptWake = (world: World, watch: ReturnType<typeof decisionWatch>) =>
    Effect.gen(function* () {
      const opened = yield* openReviewedPullRequest(world);
      const fillers = yield* fill(world, 2);
      const providerThread = yield* providerThreadOf(opened.thread, opened.authorRun);
      const wake = yield* offerNative(opened.thread, providerThread, "plain", nativeOffers());
      yield* watch.decided("background_wake", "demand");
      return { ...opened, fillers, providerThread, wake };
    });

  const stack = (watch: ReturnType<typeof decisionWatch>, providers = offeredModels()) => ({
    handoff: { admission: watch.admission },
    automaticTurnGate: true,
    providers,
  });

  const recheck = (root: string, ref: WorkItemRef) =>
    Effect.gen(function* () {
      const admission = yield* HandoffAdmission.HandoffAdmission;
      const backend = yield* HandoffBackend.HandoffBackend;
      const read = yield* backend.read(ref);
      yield* admission.recheckBlocked({
        root,
        work: { type: "read", fingerprint: read.fingerprint, status: read.status },
        force: true,
      });
    }).pipe(Effect.orDie);

  it.live("runs one kept while the thread drifted under the reviewed selection", () => {
    const watch = decisionWatch();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { reviewed, thread, fillers, wake } = yield* keptWake(world, watch);
          yield* threadSelection(thread, selection("other-model", "low"), "drift");

          yield* release(fillers[0]!);
          yield* tick;
          yield* runStarted(yield* runOfMessage(wake));
          yield* drainFactory;
          assert.deepStrictEqual(
            providerTurnsOf(world, thread).at(-1)?.modelSelection,
            reviewed.roles.author,
          );
        }).pipe(Effect.orDie),
      stack(watch),
    );
  });

  const NARROWINGS: ReadonlyArray<{
    readonly name: string;
    readonly narrow: (
      world: World,
      providers: Array<ServerProvider>,
    ) => Effect.Effect<unknown, { readonly _tag: string }, Services>;
    readonly restore: (
      world: World,
      providers: Array<ServerProvider>,
    ) => Effect.Effect<unknown, { readonly _tag: string }, Services>;
    readonly text: string;
  }> = [
    {
      name: "the reviewed model is no longer offered",
      narrow: (_world, providers) =>
        Effect.sync(() => {
          providers[0] = offeredModels(["reviewer-model"])[0]!;
        }),
      restore: (_world, providers) =>
        Effect.sync(() => {
          providers[0] = offeredModels()[0]!;
        }),
      text: "no longer offers author-model",
    },
    {
      name: "the remote's push URL changed",
      narrow: (world) =>
        git(world.root, ["config", "--add", "remote.origin.pushurl", "/nonexistent/other.git"]),
      restore: (world) => git(world.root, ["config", "--unset-all", "remote.origin.pushurl"]),
      text: "where it publishes is not what was reviewed",
    },
    {
      name: "the project's default narrowed",
      narrow: (world) => overrideProject(world, { defaultRuntimeMode: "approval-required" }),
      restore: (world) => overrideProject(world, { defaultRuntimeMode: "full-access" }),
      text: "is narrower than full-access",
    },
  ];

  it.live.each(NARROWINGS)(
    "keeps one blocked with nothing run once $name, and runs it once restored",
    ({ narrow, restore, text }) => {
      const watch = decisionWatch();
      const providers = offeredModels();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root, thread, fillers, wake, ref } = yield* keptWake(world, watch);
            const runs = (yield* runsOf(thread)).length;
            yield* narrow(world, providers);

            yield* release(fillers[0]!);
            yield* tick;

            assert.deepStrictEqual(yield* runsOfMessage(thread, wake), []);
            assert.lengthOf(yield* runsOf(thread), runs);
            assert.deepStrictEqual(
              (yield* demandsOf(root)).map(({ kind, blockedReason }) => [kind, blockedReason]),
              [["background_wake", "revoked"]],
            );
            // It held no slot for what it could not run.
            assert.isUndefined(yield* slotOf(root));
            const state = yield* stateOf(root);
            assert.strictEqual(state.status, "blocked");
            assert.strictEqual(state.block?.reason, "reviewed_refused");
            if (state.block?.reason === "reviewed_refused") {
              assert.include(state.block.detail, text);
            }

            yield* restore(world, providers);
            yield* recheck(root, ref);
            yield* tick;
            yield* runStarted(yield* runOfMessage(wake));
            assert.lengthOf(yield* runsOfMessage(thread, wake), 1);
          }).pipe(Effect.orDie),
        stack(watch, providers),
      );
    },
  );

  it.live("runs none it was handed with a slot free once the review no longer holds", () => {
    const providers = offeredModels();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { thread, authorRun } = yield* openReviewedPullRequest(world);
          const providerThread = yield* providerThreadOf(thread, authorRun);
          const runs = (yield* runsOf(thread)).length;
          providers[0] = offeredModels(["reviewer-model"])[0]!;

          const consult = yield* Effect.exit(
            consultRunning(world, turns.backgroundWake(thread, providerThread)),
          );

          assert.isTrue(Exit.isFailure(consult));
          assert.lengthOf(yield* runsOf(thread), runs);
        }).pipe(Effect.orDie),
      { handoff: {}, automaticTurnGate: true, providers },
    );
  });
});

describe("a reviewed delivery's threads no role names", () => {
  /** A reviewed delivery of the idea, its author's first turn running. */
  const reviewedAuthor = (world: World, runtimeCeiling: RuntimeMode = "full-access") =>
    Effect.gen(function* () {
      yield* setSettings(world, { ...pipelineSettings, verifyCommand: verifyCommands.passes });
      yield* startAssistantThread(world);
      yield* agreeAndCapture(world, idea);
      const reviewed = yield* reviewNow(world, { runtimeCeiling });
      yield* assignToFactory(world, idea);
      assert.strictEqual(yield* attachReceipt(idea, reviewed), "attached");
      yield* tick;
      const root = yield* rootIdOf(idea);
      const author = yield* world.launched(root);
      yield* providerTurnRunning(author.threadId);
      return { root, reviewed, author };
    });

  /** The review the delivery awaits passes and its run ends, reaching its pull request. */
  const reviewPassed = (world: World, root: FactoryDeliveryId) =>
    Effect.gen(function* () {
      const factory = yield* factoryService;
      const review = yield* awaitedRun(root);
      yield* factory.submitReview({ threadId: review.threadId, review: passingReview() });
      yield* world.endRun(review.runId, "completed");
      assert.strictEqual((yield* stateOf(root)).status, "pr_open");
    });

  /** A thread delegated from the author's running turn: in the family, in no role. */
  const delegatedThread = (world: World) =>
    Effect.gen(function* () {
      const { root, reviewed, author } = yield* reviewedAuthor(world);
      const child = yield* delegateFrom(author.threadId, author.runId);
      return {
        root,
        reviewed,
        thread: child.childThreadId,
        run: child.runId,
        // At rest with its slot free, so nothing but the review keeps a wake from running.
        park: Effect.gen(function* () {
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          yield* reviewPassed(world, root);
          yield* world.endRun(child.runId, "completed");
          yield* tick;
        }),
      };
    });

  /** The reviewer a feedback round's fresh reviewer replaced: launched as one, now in no role. */
  const replacedReviewer = (world: World) =>
    Effect.gen(function* () {
      const { root, reviewed, thread } = yield* openReviewedPullRequest(world);
      const replaced = (yield* stateOf(root)).threads.reviewer ?? assert.fail("No reviewer.");
      const wake = yield* wakeThroughGate(thread, yield* linkOf(thread, fakePullRequest.number));
      yield* world.endRun(wake.runId!, "completed");
      const round = yield* awaitedRun(root);
      assert.notStrictEqual(round.threadId, replaced);
      assert.strictEqual((yield* stateOf(root)).threads.reviewer, round.threadId);
      return {
        root,
        reviewed,
        thread: replaced,
        run: yield* firstRun(replaced),
        park: reviewPassed(world, root).pipe(Effect.andThen(tick)),
      };
    });

  const THREADS = [
    { kind: "a delegated thread", open: delegatedThread },
    { kind: "a reviewer a later review replaced", open: replacedReviewer },
  ];

  const allModes = (): Array<RuntimeMode> => [
    "approval-required",
    "auto-accept-edits",
    "full-access",
  ];

  const NARROWINGS: ReadonlyArray<{
    readonly name: string;
    readonly narrow: (
      world: World,
      modes: Array<RuntimeMode>,
    ) => Effect.Effect<unknown, { readonly _tag: string }, Services>;
    readonly text: string;
  }> = [
    {
      name: "the remote's push URL changed",
      narrow: (world) =>
        git(world.root, ["config", "--add", "remote.origin.pushurl", "/nonexistent/other.git"]),
      text: "where it publishes is not what was reviewed",
    },
    {
      name: "the project's default narrowed",
      narrow: (world) => overrideProject(world, { defaultRuntimeMode: "approval-required" }),
      text: "is narrower than full-access",
    },
    {
      name: "the provider stopped offering the reviewed mode",
      narrow: (_world, modes) => Effect.sync(() => void modes.splice(0, modes.length, "auto")),
      text: "no longer offers full-access",
    },
  ];

  const options = (modes: Array<RuntimeMode>, providers = offeredModels()) => ({
    handoff: {},
    automaticTurnGate: true,
    providers,
    supportedRuntimeModes: modes,
  });

  /** The gate refuses the turn: no dispatch ran, no run exists, and the review says why. */
  const refusedAtTheGate = (turn: Parameters<typeof consult>[0], text: string) =>
    Effect.gen(function* () {
      const record = { ran: [] as Array<string> };
      const runs = (yield* runsOf(turn.threadId)).length;
      const decided = yield* Effect.exit(consult(turn, record));
      assert.isTrue(Exit.isFailure(decided));
      assert.deepStrictEqual(record.ran, []);
      assert.lengthOf(yield* runsOf(turn.threadId), runs);
      const factory = yield* factoryService;
      assert.include((yield* factory.reviewedRefusal(turn.threadId)) ?? "", text);
    });

  describe.each(THREADS)("as $kind", ({ open }) => {
    it.live.each(NARROWINGS)(
      "runs no continuation once $name, live or after a restart",
      ({ narrow, text }) => {
        const modes = allModes();
        return withProject(
          verifyCommands.passes,
          (world) =>
            Effect.gen(function* () {
              const { thread, run } = yield* open(world);
              yield* narrow(world, modes);
              const continuation = turns.restartContinuation(thread, run);

              yield* refusedAtTheGate(continuation, text);
              // Test settings live in the layer a rebuild replaces; a real server's are on disk.
              yield* world.rebuild(
                narrow(world, modes).pipe(Effect.andThen(refusedAtTheGate(continuation, text))),
                { orchestration: true },
              );
            }).pipe(Effect.orDie),
          options(modes),
        );
      },
    );

    it.live.each(NARROWINGS)(
      "runs no native wake with its slot free once $name",
      ({ narrow, text }) => {
        const modes = allModes();
        return withProject(
          verifyCommands.passes,
          (world) =>
            Effect.gen(function* () {
              const { root, thread, run, park } = yield* open(world);
              const providerThread = yield* providerThreadOf(thread, run);
              yield* park;
              assert.isUndefined(yield* slotOf(root));
              yield* narrow(world, modes);

              yield* refusedAtTheGate(turns.backgroundWake(thread, providerThread), text);
            }).pipe(Effect.orDie),
          options(modes),
        );
      },
    );

    it.live("runs a native wake with its slot free while the review holds", () => {
      const modes = allModes();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root, thread, run, park } = yield* open(world);
            const providerThread = yield* providerThreadOf(thread, run);
            yield* park;
            assert.isUndefined(yield* slotOf(root));

            const record = { ran: [] as Array<string> };
            const wake = turns.backgroundWake(thread, providerThread);
            yield* consult(wake, record);
            assert.deepStrictEqual(record.ran, [wake.messageId]);
          }).pipe(Effect.orDie),
        options(modes),
      );
    });

    it.live("runs a continuation while the review holds", () => {
      const modes = allModes();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { thread, run } = yield* open(world);
            const factory = yield* factoryService;
            assert.isUndefined(yield* factory.reviewedRefusal(thread));
            const record = { ran: [] as Array<string> };
            const continuation = turns.restartContinuation(thread, run);
            yield* consult(continuation, record);
            assert.deepStrictEqual(record.ran, [continuation.messageId]);
          }).pipe(Effect.orDie),
        options(modes),
      );
    });
  });

  it.live("holds a replaced reviewer to its role: its model, and its selection set back", () => {
    const modes = allModes();
    const providers = offeredModels();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { reviewed, thread, run } = yield* replacedReviewer(world);
          const continuation = turns.restartContinuation(thread, run);

          yield* threadSelection(thread, selection("other-model", "low"), "replaced-drift");
          const record = { ran: [] as Array<string> };
          yield* consult(continuation, record);
          assert.deepStrictEqual(record.ran, [continuation.messageId]);
          assert.deepStrictEqual(
            (yield* threadProjection(thread)).thread.modelSelection,
            reviewed.roles.reviewer,
          );

          providers[0] = offeredModels(["author-model"])[0]!;
          const later = turns.usageLimitResume(thread, run);
          yield* refusedAtTheGate(later, "no longer offers reviewer-model");
          yield* world.rebuild(refusedAtTheGate(later, "no longer offers reviewer-model"), {
            orchestration: true,
          });
        }).pipe(Effect.orDie),
      options(modes, providers),
    );
  });

  it.live("leaves a delegated thread's selection to it, which the review does not name", () => {
    const modes = allModes();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { thread, run } = yield* delegatedThread(world);
          const chosen = selection("other-model", "low");
          yield* threadSelection(thread, chosen, "delegated-choice");
          const record = { ran: [] as Array<string> };
          const continuation = turns.restartContinuation(thread, run);
          yield* consult(continuation, record);
          assert.deepStrictEqual(record.ran, [continuation.messageId]);
          assert.deepStrictEqual((yield* threadProjection(thread)).thread.modelSelection, chosen);
        }).pipe(Effect.orDie),
      options(modes),
    );
  });

  it.live("refuses a delegated thread raised above the reviewed mode", () => {
    const modes = allModes();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { author } = yield* reviewedAuthor(world, "auto-accept-edits");
          const child = yield* delegateFrom(author.threadId, author.runId);
          yield* Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
            orchestrator.dispatch({
              type: "thread.runtime-mode.set",
              commandId: CommandId.make("owner-raises-delegated"),
              threadId: child.childThreadId,
              runtimeMode: "full-access",
            }),
          );
          yield* refusedAtTheGate(
            turns.restartContinuation(child.childThreadId, child.runId),
            "The delegated thread runs broader than auto-accept-edits",
          );
        }).pipe(Effect.orDie),
      options(modes),
    );
  });

  it.live("leaves a delegated thread of a delivery with no review as it was", () => {
    const modes = allModes();
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* setSettings(world, { ...pipelineSettings, verifyCommand: verifyCommands.passes });
          yield* startAssistantThread(world);
          yield* agreeAndCapture(world, idea);
          yield* assignToFactory(world, idea);
          yield* tick;
          const root = yield* rootIdOf(idea);
          const author = yield* world.launched(root);
          yield* providerTurnRunning(author.threadId);
          const child = yield* delegateFrom(author.threadId, author.runId);
          yield* overrideProject(world, { defaultRuntimeMode: "approval-required" });

          const record = { ran: [] as Array<string> };
          const continuation = turns.restartContinuation(child.childThreadId, child.runId);
          yield* consult(continuation, record);
          assert.deepStrictEqual(record.ran, [continuation.messageId]);
          const factory = yield* factoryService;
          assert.isUndefined(yield* factory.reviewedRefusal(child.childThreadId));
        }).pipe(Effect.orDie),
      options(modes),
    );
  });

  describe("delegate_task from a reviewed delivery's thread", () => {
    it.live.each(NARROWINGS)("is refused, writing nothing, once $name", ({ narrow, text }) => {
      const modes = allModes();
      return withProject(
        verifyCommands.passes,
        (world) =>
          withEndpoint(driver, (endpoint) =>
            Effect.gen(function* () {
              const { author } = yield* reviewedAuthor(world);
              const agent = yield* endpoint.callerOn(author.threadId);
              yield* narrow(world, modes);
              const written = yield* writtenRows;

              const refused = yield* agent.call("delegate_task", { task: "Check the export." });

              assert.isTrue(refused.isError);
              assert.include(refused.text, "This delivery cannot delegate now.");
              assert.include(refused.text, text);
              yield* drainFactory;
              assert.deepStrictEqual(yield* writtenRows, written);
              assert.deepStrictEqual((yield* threadProjection(author.threadId)).subagents, []);
            }),
          ).pipe(Effect.orDie),
        options(modes),
      );
    });

    it.live("still delegates while the review holds", () => {
      const modes = allModes();
      return withProject(
        verifyCommands.passes,
        (world) =>
          withEndpoint(driver, (endpoint) =>
            Effect.gen(function* () {
              const { author } = yield* reviewedAuthor(world);
              const agent = yield* endpoint.callerOn(author.threadId);
              const answered = yield* agent.call("delegate_task", { task: "Check the export." });
              assert.isFalse(answered.isError, answered.text);
              yield* drainFactory;
              assert.lengthOf((yield* threadProjection(author.threadId)).subagents, 1);
            }),
          ).pipe(Effect.orDie),
        options(modes),
      );
    });
  });
});
