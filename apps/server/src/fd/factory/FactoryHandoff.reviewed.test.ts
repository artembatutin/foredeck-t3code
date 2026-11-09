import { assert, describe, it } from "@effect/vitest";
import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  AuthSettingsWriteScope,
  AuthWorkReadScope,
  AuthWorkWriteScope,
  CommandId,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { FactoryDeliveryId, FactoryReviewedExecution } from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import {
  HandoffAdmission,
  HandoffBackend,
  ProjectAssistant,
  WorkCapture,
} from "../assistant/index.ts";
import { type WorkDomainError, WorkService } from "../work-management/index.ts";
import * as Factory from "./index.ts";
import { isFactoryReviewedExecutionRefusedError } from "./reviewedExecution.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  fakePullRequest,
  git,
  stateOf,
  verifyCommands,
  type World,
  type Services,
  withProject,
} from "./testkit/deliveryHarness.ts";
import {
  awaitedRun,
  linkOf as pullRequestLinkOf,
  passingReview,
  syncPullRequest,
  twoTaskPlan,
} from "./testkit/followThrough.ts";
import {
  agree,
  agreeAndCapture,
  assignmentOf,
  assignToFactory,
  assistantCaller,
  assistantThread,
  controlAssignment,
  FakeWorkUnavailable,
  handoffRows,
  itemCount,
  noticesOf,
  rootIdOf,
  runToPullRequest,
  spyOnFactoryPort,
  startAssistantThread,
  tick,
  writtenRows,
} from "./testkit/handoff.ts";
import {
  attachReceipt,
  failsUntilFixed,
  offeredModels,
  reviewNow,
  selection,
  setSettings,
} from "./testkit/reviewed.ts";

/**
 * A review receipt through the assistant's real claim, on the server's real stack: what it binds
 * while it queues, what still revokes it, and the one attempt it authorizes.
 */

const factoryService = Factory.FactoryService.FactoryService;
const idea = "export";

const reviewedOptions = (providers = offeredModels(), modes?: Array<RuntimeMode>) => ({
  handoff: {},
  automaticTurnGate: true,
  providers,
  ...(modes === undefined ? {} : { supportedRuntimeModes: modes }),
});

const settings = {
  verifyCommand: verifyCommands.passes,
  roles: {
    planner: selection("planner-model", "low"),
    author: selection("author-model", "high"),
    reviewer: selection("reviewer-model", "low"),
  },
};

/** An idea captured, authorized and reviewed, its assignment queued and bound to the receipt. */
const queuedReview = (
  world: World,
  runtimeCeiling: RuntimeMode = "full-access",
  amend: (reviewed: FactoryReviewedExecution) => FactoryReviewedExecution = (same) => same,
) =>
  Effect.gen(function* () {
    yield* setSettings(world, settings);
    yield* startAssistantThread(world);
    yield* agreeAndCapture(world, idea);
    const reviewed = amend(yield* reviewNow(world, { runtimeCeiling }));
    yield* assignToFactory(world, idea);
    assert.strictEqual(yield* attachReceipt(idea, reviewed), "attached");
    return reviewed;
  });

const claimedReview = (world: World) =>
  Effect.gen(function* () {
    const reviewed = yield* queuedReview(world);
    yield* tick;
    const root = yield* rootIdOf(idea);
    const author = yield* world.launched(root);
    return { reviewed, root, author };
  });

const receiptOf = (assignmentId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{
      readonly receipt_id: string;
      readonly attempt: number;
      readonly review_version: number;
      readonly execution_json: string;
    }>`SELECT receipt_id, attempt, review_version, execution_json
      FROM fd_assistant_review_receipts WHERE assignment_id = ${assignmentId}`,
  ).pipe(Effect.orDie);

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("a review receipt while its assignment queues", () => {
  it.live("is copied exactly onto the delivery, though the settings were removed meanwhile", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const reviewed = yield* queuedReview(world);
          // No verify command any more: a start reading the settings would refuse.
          yield* setSettings(world, {});
          const assignment = yield* Effect.flatMap(HandoffAdmission.HandoffAdmission, (admission) =>
            admission.factoryAssignment(idea),
          );
          assert.strictEqual(assignment?.reviewed?.receiptId, reviewed.receiptId);

          yield* tick;

          const root = yield* rootIdOf(idea);
          const author = yield* world.launched(root);
          const state = yield* stateOf(root);
          assert.deepStrictEqual(state.reviewedExecution, reviewed);
          assert.strictEqual(state.runtimeModeCeiling, reviewed.runtimeCeiling);
          const [receipt] = yield* receiptOf(idea);
          assert.strictEqual(receipt?.receipt_id, reviewed.receiptId);
          assert.strictEqual(receipt?.attempt, 1);
          assert.deepStrictEqual(
            decodeJson(receipt?.execution_json),
            decodeJson(encodeJson(reviewed)),
          );
          assert.strictEqual((yield* assignmentOf(idea)).state, "running");

          // Nor does the resume ask for what the review already carries.
          yield* controlAssignment(idea, "stop");
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          assert.strictEqual((yield* stateOf(root)).status, "stopped");
          yield* tick;
          yield* controlAssignment(idea, "resume");
          yield* drainFactory;
          assert.deepStrictEqual(
            (yield* stateOf(root)).receipts.at(-1)?.command,
            reviewed.verifyCommand,
          );
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("carries a ceiling narrower than the assignment's mode, never a broader one", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* queuedReview(world, "auto-accept-edits");
          yield* tick;
          const root = yield* rootIdOf(idea);
          const author = yield* world.launched(root);
          assert.strictEqual((yield* stateOf(root)).runtimeModeCeiling, "auto-accept-edits");
          const turn = world.provider.started.find(({ runId }) => runId === author.runId);
          assert.strictEqual(turn?.runtimePolicy.runtimeMode, "auto-accept-edits");
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("is bound once to a queued assignment, one attempt to one receipt", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const reviewed = yield* queuedReview(world);
          const before = yield* receiptOf(idea);

          // The same receipt again, and another for the same attempt, change nothing.
          assert.strictEqual(yield* attachReceipt(idea, reviewed), "refused");
          assert.strictEqual(
            yield* attachReceipt(idea, { ...reviewed, receiptId: "receipt-2" }),
            "refused",
          );
          assert.deepStrictEqual(yield* receiptOf(idea), before);

          // Nor can it authorize another assignment.
          yield* agreeAndCapture(world, "other");
          yield* assignToFactory(world, "other");
          assert.strictEqual(yield* attachReceipt("other", reviewed), "refused");
          assert.deepStrictEqual(yield* receiptOf("other"), []);

          // Nor one already claimed, whatever receipt it brings.
          yield* tick;
          assert.notStrictEqual((yield* assignmentOf("other")).state, "queued");
          assert.strictEqual(
            yield* attachReceipt("other", { ...reviewed, receiptId: "receipt-3" }),
            "refused",
          );
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("starts nothing from a receipt that no longer parses, and fails its assignment", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* setSettings(world, settings);
          yield* startAssistantThread(world);
          yield* agreeAndCapture(world, idea);
          yield* assignToFactory(world, idea);
          yield* sql`INSERT INTO fd_assistant_review_receipts ${sql.insert({
            receipt_id: "receipt-broken",
            assignment_id: idea,
            attempt: 1,
            review_version: 1,
            execution_json: "{not json",
            created_at: "2026-10-31T10:00:00.000Z",
          })}`;
          yield* sql`UPDATE fd_assistant_factory_links SET receipt_id = 'receipt-broken'
            WHERE assignment_id = ${idea}`;

          yield* tick;
          yield* drainFactory;

          const root = yield* rootIdOf(idea);
          assert.strictEqual((yield* assignmentOf(idea)).state, "failed");
          assert.isTrue(
            (yield* noticesOf(idea)).some((note) => note.includes("needs a fresh review")),
          );
          const found = yield* Effect.flatMap(factoryService, (factory) => factory.get(root));
          assert.strictEqual(found._tag, "None");
          assert.deepStrictEqual(
            world.provider.started.filter(({ threadId }) => threadId !== assistantThread),
            [],
          );
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );
});

interface Revocation {
  readonly name: string;
  readonly revoke: (
    world: World,
    root: FactoryDeliveryId,
  ) => Effect.Effect<unknown, { readonly _tag: string }, Services>;
  /** What the block says, or that it names the thread deleted with its project. */
  readonly text: string | "thread_deleted";
}

/** The fixed text of a revoked root's refused effect. */
const REVOKED = "no longer authorizes";

const PUBLISHES = "where it publishes is not what was reviewed";

const REVOCATIONS: ReadonlyArray<Revocation> = [
  {
    name: "the brief's authorization",
    revoke: (world) =>
      Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistant) =>
        assistant.revise({
          projectId: world.projectId,
          ideaId: idea,
          patch: { executionAuthorized: false },
        }),
      ),
    text: REVOKED,
  },
  {
    name: "the brief's scope",
    revoke: (world) =>
      Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistant) =>
        assistant.revise({
          projectId: world.projectId,
          ideaId: idea,
          patch: { goal: "Deliver something else" },
        }),
      ),
    text: REVOKED,
  },
  {
    name: "the capture",
    revoke: (world) =>
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql`DELETE FROM fd_assistant_work_captures
          WHERE project_id = ${world.projectId} AND idea_id = ${idea}`,
      ),
    text: REVOKED,
  },
  {
    name: "the manager thread",
    revoke: () =>
      Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
        orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive-manager"),
          threadId: assistantThread,
        }),
      ),
    text: REVOKED,
  },
  {
    name: "the manager's mode",
    revoke: () =>
      Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
        orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("narrow-manager"),
          threadId: assistantThread,
          runtimeMode: "approval-required",
        }),
      ),
    text: REVOKED,
  },
  {
    name: "the project",
    revoke: (world) =>
      Effect.flatMap(ProjectService.ProjectService, (projects) =>
        projects.delete({
          commandId: CommandId.make("delete-project"),
          projectId: world.projectId,
          force: true,
        }),
      ),
    text: "thread_deleted",
  },
  {
    name: "the project's checkout",
    revoke: (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const moved = path.join(path.dirname(world.root), "moved");
        yield* fileSystem.makeDirectory(moved, { recursive: true });
        const projects = yield* ProjectService.ProjectService;
        yield* projects.update({
          commandId: CommandId.make("move-project"),
          projectId: world.projectId,
          workspaceRoot: moved,
        });
      }),
    text: PUBLISHES,
  },
  {
    name: "the repository's remote",
    revoke: (world) => git(world.root, ["remote", "set-url", "origin", "/nonexistent/other.git"]),
    text: PUBLISHES,
  },
  {
    name: "the remote's push URL, its fetch URL unchanged",
    revoke: (world) =>
      git(world.root, ["config", "--add", "remote.origin.pushurl", "/nonexistent/other.git"]),
    text: PUBLISHES,
  },
  {
    name: "the push default",
    revoke: (world) =>
      git(world.root, ["remote", "add", "other", "/nonexistent/other.git"]).pipe(
        Effect.andThen(git(world.root, ["config", "remote.pushDefault", "other"])),
      ),
    text: PUBLISHES,
  },
  {
    name: "the branch's upstream remote",
    revoke: (world, root) =>
      Effect.gen(function* () {
        const { branch } = yield* stateOf(root);
        yield* git(world.root, ["remote", "add", "other", "/nonexistent/other.git"]);
        yield* git(world.root, ["config", `branch.${branch}.remote`, "other"]);
      }),
    text: PUBLISHES,
  },
  {
    name: "the branch's push remote",
    revoke: (world, root) =>
      Effect.gen(function* () {
        const { branch } = yield* stateOf(root);
        yield* git(world.root, ["remote", "add", "other", "/nonexistent/other.git"]);
        yield* git(world.root, ["config", `branch.${branch}.pushRemote`, "other"]);
      }),
    text: PUBLISHES,
  },
];

/** Nothing ran after the author's first turn, though the review still names the wider value. */
const assertNothingMore = (world: World, root: FactoryDeliveryId, text: Revocation["text"]) =>
  Effect.gen(function* () {
    const state = yield* stateOf(root);
    assert.strictEqual(state.status, "blocked");
    if (text === "thread_deleted") {
      assert.strictEqual(state.block?.reason, "thread_deleted");
    } else {
      assert.strictEqual(state.block?.reason, "effect_failed");
      if (state.block?.reason === "effect_failed") assert.include(state.block.detail, text);
    }
    assert.deepStrictEqual(state.receipts, []);
    assert.isUndefined(state.threads.reviewer);
    assert.isDefined(state.reviewedExecution);
    const threads = Object.values(state.threads);
    assert.lengthOf(
      world.provider.started.filter(({ threadId }) => threads.includes(threadId)),
      1,
    );
  });

describe("a review is a ceiling, never a grant", () => {
  it.live.each(REVOCATIONS)(
    "refuses the next effect once $name is revoked between stages",
    ({ revoke, text }) =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root, author } = yield* claimedReview(world);
            yield* authorCommits(author.worktreePath, "feat: add the export button");
            yield* revoke(world, root).pipe(Effect.orDie);
            yield* world.endRun(author.runId, "completed");
            yield* drainFactory;
            yield* assertNothingMore(world, root, text);
          }).pipe(Effect.orDie),
        reviewedOptions(),
      ),
  );

  it.live.each(REVOCATIONS)(
    "refuses the next effect once $name is revoked across a stop and a rebuild",
    ({ revoke, text }) =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root, author } = yield* claimedReview(world);
            yield* Effect.flatMap(factoryService, (factory) => factory.stop(root));
            yield* authorCommits(author.worktreePath, "feat: add the export button");
            yield* world.endRun(author.runId, "completed");
            assert.strictEqual((yield* stateOf(root)).status, "stopped");
            yield* world.rebuild(
              Effect.gen(function* () {
                yield* revoke(world, root).pipe(Effect.orDie);
                yield* Effect.flatMap(factoryService, (factory) => factory.resume(root));
                yield* drainFactory;
                yield* assertNothingMore(world, root, text);
              }),
              { orchestration: true },
            );
          }).pipe(Effect.orDie),
        reviewedOptions(),
      ),
  );

  it.live("launches nothing once the repository's remote changed while it queued", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* queuedReview(world);
          yield* git(world.root, ["remote", "set-url", "origin", "/nonexistent/other.git"]);
          yield* tick;
          const root = yield* rootIdOf(idea);
          yield* drainFactory;

          const state = yield* stateOf(root);
          assert.strictEqual(state.status, "blocked");
          assert.deepStrictEqual(state.threads, {});
          assert.strictEqual(state.block?.reason, "effect_failed");
          if (state.block?.reason === "effect_failed") {
            assert.include(state.block.detail, "where it publishes is not what was reviewed");
          }
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live.each([
    { name: "remote", change: ["remote", "set-url", "origin", "/nonexistent/other.git"] },
    {
      name: "push URL",
      change: ["config", "--add", "remote.origin.pushurl", "/nonexistent/other.git"],
    },
  ])("publishes nothing once the repository's $name changed during the review", ({ change }) =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* factoryService;
          const { root, author } = yield* claimedReview(world);
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          const review = yield* awaitedRun(root);
          yield* factory.submitReview({ threadId: review.threadId, review: passingReview() });
          yield* git(world.root, change);
          yield* world.endRun(review.runId, "completed");
          yield* drainFactory;

          const state = yield* stateOf(root);
          assert.strictEqual(state.status, "blocked");
          assert.isNull(state.pullRequest);
          assert.deepStrictEqual(world.pullRequestCalls, []);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("publishes as usual while its destination is the one reviewed, a pushed branch too", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* factoryService;
          const { root, author } = yield* claimedReview(world);
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          const review = yield* awaitedRun(root);
          yield* factory.submitReview({ threadId: review.threadId, review: passingReview() });
          yield* world.endRun(review.runId, "completed");
          yield* drainFactory;
          assert.strictEqual((yield* stateOf(root)).status, "pr_open");
          assert.lengthOf(world.pullRequestCalls, 1);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );
});

const assertRefusedAs = (root: FactoryDeliveryId) =>
  Effect.gen(function* () {
    yield* drainFactory;
    const state = yield* stateOf(root);
    assert.strictEqual(state.status, "blocked");
    assert.strictEqual(state.block?.reason, "effect_failed");
    if (state.block?.reason === "effect_failed") assert.include(state.block.detail, PUBLISHES);
    return state;
  });

describe("a review of the repository GitHub would open the pull request against", () => {
  const fork = "https://github.com/owner/fork.git";
  const base = "https://github.com/maintainer/base.git";

  /**
   * `origin` is the owner's fork and `upstream` its parent, with the fork marked as this checkout's
   * base, as `gh repo set-default` leaves it. Pushes still reach the bare remote, so nothing here
   * needs GitHub.
   */
  const forkMarkedAsBase = (world: World) =>
    Effect.gen(function* () {
      const bare = yield* git(world.root, ["remote", "get-url", "origin"]);
      yield* git(world.root, ["remote", "set-url", "origin", fork]);
      yield* git(world.root, ["remote", "set-url", "--push", "origin", bare]);
      yield* git(world.root, ["remote", "add", "upstream", base]);
      yield* markFork(world);
      return bare;
    });
  const markFork = (world: World) =>
    git(world.root, ["config", "remote.origin.gh-resolved", "base"]);
  /** Publication's remotes are untouched, and GitHub would now target the parent. */
  const removeMark = (world: World) =>
    git(world.root, ["config", "--unset", "remote.origin.gh-resolved"]);

  it.live("binds what the provider answers, which follows its mark and not origin", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const bare = yield* forkMarkedAsBase(world);
          yield* setSettings(world, settings);
          const marked = yield* reviewNow(world);
          assert.strictEqual(marked.repository.publication.provider, "github");
          assert.strictEqual(marked.repository.publication.repository, "github.com/owner/fork");
          assert.deepStrictEqual(marked.repository.publication.push, [bare]);
          assert.deepStrictEqual(marked.repository.publication.head, [fork]);

          yield* removeMark(world);
          const unmarked = yield* reviewNow(world);
          assert.strictEqual(
            unmarked.repository.publication.repository,
            "github.com/maintainer/base",
          );
          assert.deepStrictEqual(unmarked.repository.publication.push, [bare]);
          assert.deepStrictEqual(unmarked.repository.publication.head, [fork]);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("launches nothing once the target moved while it queued", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* forkMarkedAsBase(world);
          yield* queuedReview(world);
          yield* removeMark(world);
          yield* tick;

          const state = yield* assertRefusedAs(yield* rootIdOf(idea));
          assert.deepStrictEqual(state.threads, {});
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("runs no verify once the target moved between stages", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* forkMarkedAsBase(world);
          const { root, author } = yield* claimedReview(world);
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* removeMark(world);
          yield* world.endRun(author.runId, "completed");

          const state = yield* assertRefusedAs(root);
          assert.deepStrictEqual(state.receipts, []);
          assert.isUndefined(state.threads.reviewer);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("runs no verify once the target moved across a restart", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* forkMarkedAsBase(world);
          const { root, author } = yield* claimedReview(world);
          yield* Effect.flatMap(factoryService, (factory) => factory.stop(root));
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          assert.strictEqual((yield* stateOf(root)).status, "stopped");

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* removeMark(world);
              yield* Effect.flatMap(factoryService, (factory) => factory.resume(root));
              const state = yield* assertRefusedAs(root);
              assert.deepStrictEqual(state.receipts, []);
            }),
            { orchestration: true },
          );
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("publishes nothing once the target moved during the review", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* factoryService;
          yield* forkMarkedAsBase(world);
          const { root, author } = yield* claimedReview(world);
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          const review = yield* awaitedRun(root);
          yield* factory.submitReview({ threadId: review.threadId, review: passingReview() });
          yield* removeMark(world);
          yield* world.endRun(review.runId, "completed");

          const state = yield* assertRefusedAs(root);
          assert.isNull(state.pullRequest);
          assert.deepStrictEqual(world.pullRequestCalls, []);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("runs no verify when what publishes can no longer be asked", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* forkMarkedAsBase(world);
          const { root, author } = yield* claimedReview(world);
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* fileSystem.remove(author.worktreePath, { recursive: true });
          yield* world.endRun(author.runId, "completed");

          const state = yield* assertRefusedAs(root);
          assert.deepStrictEqual(state.receipts, []);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("refuses GH_REPO naming another repository after a restart, in no Git setting", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* forkMarkedAsBase(world);
          const { root, author } = yield* claimedReview(world);
          yield* Effect.flatMap(factoryService, (factory) => factory.stop(root));
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");

          world.hostEnvironment.GH_REPO = "someone/else";
          yield* world.rebuild(
            Effect.gen(function* () {
              yield* Effect.flatMap(factoryService, (factory) => factory.resume(root));
              const state = yield* assertRefusedAs(root);
              assert.deepStrictEqual(state.receipts, []);
            }),
            { orchestration: true },
          );
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("publishes while the target is the one reviewed, and goes on once it is restored", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* factoryService;
          yield* forkMarkedAsBase(world);
          const { root, author } = yield* claimedReview(world);
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* removeMark(world);
          yield* world.endRun(author.runId, "completed");
          yield* assertRefusedAs(root);

          yield* markFork(world);
          yield* factory.resume(root);
          yield* drainFactory;
          const review = yield* awaitedRun(root);
          yield* factory.submitReview({ threadId: review.threadId, review: passingReview() });
          yield* world.endRun(review.runId, "completed");
          yield* drainFactory;
          assert.strictEqual((yield* stateOf(root)).status, "pr_open");
          assert.lengthOf(world.pullRequestCalls, 1);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );
});

describe("a review of where publication goes, with a push default apart from origin", () => {
  const otherUrl = "/nonexistent/other.git";

  /** `origin` is what the pull request targets, and `other` where a push goes. */
  const pushesElsewhere = (world: World) =>
    Effect.gen(function* () {
      yield* git(world.root, ["remote", "add", "other", otherUrl]);
      yield* git(world.root, ["config", "remote.pushDefault", "other"]);
      return yield* git(world.root, ["remote", "get-url", "origin"]);
    });

  /** The two remotes exchange URLs: the same URLs in all, with each role's destination changed. */
  const exchangeRemotes = (world: World, originUrl: string) =>
    git(world.root, ["remote", "set-url", "origin", otherUrl]).pipe(
      Effect.andThen(git(world.root, ["remote", "set-url", "other", originUrl])),
    );

  it.live("binds the push destination, the pull request's head and its target apart", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* pushesElsewhere(world);
          yield* setSettings(world, settings);
          const reviewed = yield* reviewNow(world);
          assert.deepStrictEqual(reviewed.repository.publication.push, [otherUrl]);
          assert.deepStrictEqual(reviewed.repository.publication.head, [otherUrl]);
          // A local path is hosted by no provider, which leaves its target to the settings bound.
          assert.strictEqual(reviewed.repository.publication.provider, "unknown");
          assert.isNull(reviewed.repository.publication.repository);

          // A remote's own push URL is its role's alone.
          yield* git(world.root, ["config", "--add", "remote.other.pushurl", "/nonexistent/x.git"]);
          const separate = yield* reviewNow(world);
          assert.deepStrictEqual(separate.repository.publication.push, ["/nonexistent/x.git"]);
          assert.deepStrictEqual(separate.repository.publication.head, [otherUrl]);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("launches nothing once the remotes exchanged URLs while it queued", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const originUrl = yield* pushesElsewhere(world);
          yield* queuedReview(world);
          yield* exchangeRemotes(world, originUrl);
          yield* tick;

          const state = yield* assertRefusedAs(yield* rootIdOf(idea));
          assert.deepStrictEqual(state.threads, {});
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("runs no verify once the remotes exchanged URLs between stages", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const originUrl = yield* pushesElsewhere(world);
          const { root, author } = yield* claimedReview(world);
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* exchangeRemotes(world, originUrl);
          yield* world.endRun(author.runId, "completed");

          const state = yield* assertRefusedAs(root);
          assert.deepStrictEqual(state.receipts, []);
          assert.isUndefined(state.threads.reviewer);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("runs no verify once the remotes exchanged URLs across a restart", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const originUrl = yield* pushesElsewhere(world);
          const { root, author } = yield* claimedReview(world);
          yield* Effect.flatMap(factoryService, (factory) => factory.stop(root));
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          assert.strictEqual((yield* stateOf(root)).status, "stopped");

          yield* world.rebuild(
            Effect.gen(function* () {
              yield* exchangeRemotes(world, originUrl);
              yield* Effect.flatMap(factoryService, (factory) => factory.resume(root));
              const state = yield* assertRefusedAs(root);
              assert.deepStrictEqual(state.receipts, []);
            }),
            { orchestration: true },
          );
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("publishes nothing once the remotes exchanged URLs during the review", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* factoryService;
          const originUrl = yield* pushesElsewhere(world);
          const { root, author } = yield* claimedReview(world);
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          const review = yield* awaitedRun(root);
          yield* factory.submitReview({ threadId: review.threadId, review: passingReview() });
          yield* exchangeRemotes(world, originUrl);
          yield* world.endRun(review.runId, "completed");

          const state = yield* assertRefusedAs(root);
          assert.isNull(state.pullRequest);
          assert.deepStrictEqual(world.pullRequestCalls, []);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("refuses a pull request target that moved though the push stayed put", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* pushesElsewhere(world);
          const { root, author } = yield* claimedReview(world);
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* git(world.root, ["remote", "set-url", "origin", "/nonexistent/moved.git"]);
          yield* world.endRun(author.runId, "completed");
          const state = yield* assertRefusedAs(root);
          assert.deepStrictEqual(state.receipts, []);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live(
    "refuses a Git setting only some provider's CLI reads, since the hash holds them all",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* pushesElsewhere(world);
            yield* queuedReview(world);
            yield* git(world.root, ["config", "remote.origin.glab-resolved", "base"]);
            yield* tick;

            const state = yield* assertRefusedAs(yield* rootIdOf(idea));
            assert.deepStrictEqual(state.threads, {});
          }).pipe(Effect.orDie),
        reviewedOptions(),
      ),
  );

  it.live("goes on while each role's destination is the one reviewed, a tracked branch too", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* pushesElsewhere(world);
          const { root, author } = yield* claimedReview(world);
          const { branch } = yield* stateOf(root);
          // What a first push records: the branch now tracks the very remote a push picks.
          yield* git(world.root, ["config", `branch.${branch}.remote`, "other"]);
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          yield* awaitedRun(root);
          const state = yield* stateOf(root);
          assert.strictEqual(state.status, "running");
          assert.lengthOf(state.receipts, 1);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );
});

/** What a retry must leave as it was. */
const retryRefused = (world: World, root: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const rows = yield* handoffRows;
    const before = yield* assignmentOf(idea);
    const turns = world.provider.started.length;
    const deliveries = (yield* Effect.flatMap(factoryService, (factory) =>
      factory.list({ projectId: world.projectId }),
    )).length;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refused = yield* Effect.flip(controlAssignment(idea, "retry"));
      assert.include(refused.message, "fresh owner review");
    }
    const admission = yield* HandoffAdmission.HandoffAdmission;
    assert.deepStrictEqual(
      yield* admission.retryReentry({
        assignmentId: idea,
        work: { type: "read", fingerprint: "any", status: "todo" },
      }),
      { type: "review_required" },
    );
    yield* tick;
    yield* drainFactory;

    assert.deepStrictEqual(yield* assignmentOf(idea), before);
    assert.deepStrictEqual(yield* handoffRows, rows);
    assert.lengthOf(world.provider.started, turns);
    assert.lengthOf(
      yield* Effect.flatMap(factoryService, (factory) =>
        factory.list({ projectId: world.projectId }),
      ),
      deliveries,
    );
    assert.strictEqual(yield* rootIdOf(idea), root);
  });

describe("a receipt-backed assignment's retry", () => {
  it.live("is refused once cancelled, however often and across a restart", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { root, author } = yield* claimedReview(world);
          yield* controlAssignment(idea, "cancel");
          yield* drainFactory;
          yield* world.endRun(author.runId, "cancelled");
          yield* tick;
          assert.strictEqual((yield* assignmentOf(idea)).state, "cancelled");

          yield* retryRefused(world, root);
          yield* world.rebuild(retryRefused(world, root), { orchestration: true });
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live(
    "is refused once failed before anything started, however often and across a restart",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            // Reviewed for another checkout of the project, so Factory refuses the start.
            yield* queuedReview(world, "full-access", (reviewed) => ({
              ...reviewed,
              repository: { ...reviewed.repository, workspaceRoot: "/elsewhere" },
            }));
            yield* tick;
            assert.strictEqual((yield* assignmentOf(idea)).state, "failed");

            const root = yield* rootIdOf(idea);
            yield* retryRefused(world, root);
            yield* world.rebuild(retryRefused(world, root), { orchestration: true });
          }).pipe(Effect.orDie),
        reviewedOptions(),
      ),
  );
});

/** The assistant's own rows of an attempt, whole, which a refused assignment must leave as they are. */
const assignmentRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables: Record<string, ReadonlyArray<unknown>> = {};
  for (const table of [
    "fd_assistant_assignments",
    "fd_assistant_dispatches",
    "fd_assistant_factory_links",
    "fd_assistant_queue_positions",
    "fd_assistant_review_receipts",
  ]) {
    tables[table] = yield* sql`SELECT * FROM ${sql(table)} ORDER BY rowid`;
  }
  return tables;
}).pipe(Effect.orDie);

describe("an idea that ran under a review", () => {
  /** `assistant_assign` under the id given, by Factory or with the executor left out. */
  const assignBy = (world: World, assignmentId: string, executor?: "factory") =>
    Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistant) =>
      assistant.enqueue({
        assignmentId,
        projectId: world.projectId,
        ideaId: idea,
        ...(executor === undefined ? {} : { executor }),
        managerThreadId: assistantThread,
        modelSelection: settings.roles.author,
        runtimeMode: "full-access",
        interactionMode: "default",
        looperConfig: null,
      }),
    );

  /**
   * Fresh ids are refused by every route, repeated and with the idea authorized again, and neither
   * the assistant, Factory nor the provider holds anything more or spends anything less for them.
   */
  const freshRefused = (world: World) =>
    Effect.gen(function* () {
      const rows = yield* assignmentRows;
      const written = yield* writtenRows;
      const turns = world.provider.started.length;
      const factory = yield* factoryService;
      const deliveries = yield* factory.list({ projectId: world.projectId });
      const assistant = yield* ProjectAssistant.ProjectAssistant;
      yield* assistant.revise({
        projectId: world.projectId,
        ideaId: idea,
        patch: { executionAuthorized: true },
      });

      for (const assignmentId of ["fresh", "fresh", "fresher"]) {
        for (const executor of ["factory", undefined] as const) {
          const refused = yield* Effect.flip(assignBy(world, assignmentId, executor));
          assert.include(refused.message, "fresh owner review");
        }
      }
      yield* tick;
      yield* drainFactory;

      assert.deepStrictEqual(yield* assignmentRows, rows);
      assert.deepStrictEqual(yield* writtenRows, written);
      assert.lengthOf(world.provider.started, turns);
      assert.deepStrictEqual(yield* factory.list({ projectId: world.projectId }), deliveries);
    });

  const cancelled = (world: World) =>
    Effect.gen(function* () {
      const { root, author } = yield* claimedReview(world);
      yield* controlAssignment(idea, "cancel");
      yield* drainFactory;
      yield* world.endRun(author.runId, "cancelled");
      yield* tick;
      assert.strictEqual((yield* assignmentOf(idea)).state, "cancelled");
      return root;
    });

  it.live("refuses fresh assignment ids once its attempt was cancelled, across a restart", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* cancelled(world);
          yield* freshRefused(world);
          yield* world.rebuild(freshRefused(world), { orchestration: true });
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("refuses fresh assignment ids once its attempt failed before anything started", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          // Reviewed for another checkout of the project, so Factory refuses the start.
          yield* queuedReview(world, "full-access", (reviewed) => ({
            ...reviewed,
            repository: { ...reviewed.repository, workspaceRoot: "/elsewhere" },
          }));
          yield* tick;
          assert.strictEqual((yield* assignmentOf(idea)).state, "failed");

          yield* freshRefused(world);
          yield* world.rebuild(freshRefused(world), { orchestration: true });
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("refuses fresh assignment ids once its attempt completed", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { root } = yield* claimedReview(world);
          const opened = yield* runToPullRequest(world, root);
          yield* syncPullRequest(
            opened.threadId,
            yield* pullRequestLinkOf(opened.threadId, fakePullRequest.number),
            "merged",
          );
          yield* drainFactory;
          yield* tick;
          assert.strictEqual((yield* assignmentOf(idea)).state, "completed");

          yield* freshRefused(world);
          yield* world.rebuild(freshRefused(world), { orchestration: true });
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("refuses them after its capture was abandoned and made anew, under a new id", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* cancelled(world);
          const captures = yield* WorkCapture.WorkCapture;
          const scope = { caller: assistantCaller, projectId: world.projectId, ideaId: idea };
          const abandoned = yield* captures.abandon(scope);
          const recaptured = yield* captures.capture({ ...scope, kind: "single" });
          assert.notStrictEqual(recaptured.captureId, abandoned.captureId);

          yield* freshRefused(world);
          yield* world.rebuild(freshRefused(world), { orchestration: true });
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("refuses an earlier receipt-less assignment's retry, which keeps its history", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* setSettings(world, settings);
          yield* startAssistantThread(world);
          yield* agreeAndCapture(world, idea);
          yield* assignBy(world, "older", "factory");
          yield* tick;
          const older = yield* rootIdOf("older");
          const first = yield* world.launched(older);
          yield* controlAssignment("older", "cancel");
          yield* drainFactory;
          yield* world.endRun(first.runId, "cancelled");
          yield* tick;
          assert.strictEqual((yield* assignmentOf("older")).state, "cancelled");

          yield* assignBy(world, "reviewed", "factory");
          assert.strictEqual(yield* attachReceipt("reviewed", yield* reviewNow(world)), "attached");
          yield* tick;
          const reviewedRoot = yield* rootIdOf("reviewed");
          const second = yield* world.launched(reviewedRoot);
          yield* controlAssignment("reviewed", "cancel");
          yield* drainFactory;
          yield* world.endRun(second.runId, "cancelled");
          yield* tick;
          assert.strictEqual((yield* assignmentOf("reviewed")).state, "cancelled");

          const refusedRetry = Effect.gen(function* () {
            const rows = yield* assignmentRows;
            const written = yield* writtenRows;
            const refused = yield* Effect.flip(controlAssignment("older", "retry"));
            assert.include(refused.message, "fresh owner review");
            const admission = yield* HandoffAdmission.HandoffAdmission;
            assert.deepStrictEqual(
              yield* admission.retryReentry({
                assignmentId: "older",
                work: { type: "read", fingerprint: "any", status: "todo" },
              }),
              { type: "review_required" },
            );
            yield* tick;
            yield* drainFactory;
            assert.deepStrictEqual(yield* assignmentRows, rows);
            assert.deepStrictEqual(yield* writtenRows, written);
            assert.strictEqual(yield* rootIdOf("older"), older);
          });
          yield* refusedRetry;
          yield* world.rebuild(refusedRetry, { orchestration: true });
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );
});

describe("a review on a provider that cannot name its pull request's target", () => {
  /** `origin` on the host given; pushes still reach the bare remote, so no host is ever asked. */
  const hostedOn = (world: World, url: string) =>
    Effect.gen(function* () {
      const bare = yield* git(world.root, ["remote", "get-url", "origin"]);
      yield* git(world.root, ["remote", "set-url", "origin", url]);
      yield* git(world.root, ["remote", "set-url", "--push", "origin", bare]);
    });

  const assertUnsupported = (root: FactoryDeliveryId, provider: string) =>
    Effect.gen(function* () {
      yield* drainFactory;
      const state = yield* stateOf(root);
      assert.strictEqual(state.status, "blocked");
      assert.strictEqual(state.block?.reason, "effect_failed");
      if (state.block?.reason === "effect_failed") {
        assert.include(state.block.detail, `Reviewed deliveries are not supported on ${provider}`);
      }
      return state;
    });

  const github = "https://github.com/owner/repo.git";
  const gitlab = "https://gitlab.com/acme/web.git";

  it.live.each([
    { provider: "gitlab", url: gitlab },
    { provider: "azure-devops", url: "https://dev.azure.com/acme/web/_git/web" },
    { provider: "forgejo", url: "https://codeberg.org/acme/web.git" },
    { provider: "bitbucket", url: "https://bitbucket.org/acme/web.git" },
    { provider: "gitcafe", url: "https://git.cafe/acme/web.git" },
  ])("refuses the review itself on $provider, naming what it lacks", ({ provider, url }) =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* hostedOn(world, url);
          yield* setSettings(world, settings);
          const factory = yield* factoryService;
          const refused = yield* Effect.flip(
            factory.resolveReviewedExecution({
              projectId: world.projectId,
              receiptId: "receipt-1",
              reviewVersion: 1,
              runtimeCeiling: "full-access",
            }),
          );
          if (!isFactoryReviewedExecutionRefusedError(refused)) {
            return assert.fail(`Refused by ${refused._tag}, not by the review.`);
          }
          assert.strictEqual(refused.reason, "publication_target");
          assert.strictEqual(refused.provider, provider);
          assert.include(refused.message, "does not name the repository");
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("binds GitHub's answer, the control, and publishes to it", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* hostedOn(world, github);
          const factory = yield* factoryService;
          const reviewed = yield* queuedReview(world);
          assert.strictEqual(reviewed.repository.publication.repository, "github.com/owner/repo");
          yield* tick;
          const root = yield* rootIdOf(idea);
          const author = yield* world.launched(root);
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          const review = yield* awaitedRun(root);
          yield* factory.submitReview({ threadId: review.threadId, review: passingReview() });
          yield* world.endRun(review.runId, "completed");
          yield* drainFactory;
          assert.strictEqual((yield* stateOf(root)).status, "pr_open");
          assert.lengthOf(world.pullRequestCalls, 1);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("launches nothing once its project moved to one, across a restart", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* hostedOn(world, github);
          yield* queuedReview(world);
          yield* git(world.root, ["remote", "set-url", "origin", gitlab]);
          // The rebuilt registry detects the provider anew, as a restarted server does.
          yield* world.rebuild(
            Effect.gen(function* () {
              yield* tick;
              const state = yield* assertUnsupported(yield* rootIdOf(idea), "gitlab");
              assert.deepStrictEqual(state.threads, {});
              assert.deepStrictEqual(world.pullRequestCalls, []);
            }),
            { orchestration: true },
          );
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("runs no verify and publishes nothing once its project moved to one mid-delivery", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* hostedOn(world, github);
          const { root, author } = yield* claimedReview(world);
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* git(world.root, ["remote", "set-url", "origin", gitlab]);
          yield* world.endRun(author.runId, "completed");

          const state = yield* assertUnsupported(root, "gitlab");
          assert.deepStrictEqual(state.receipts, []);
          assert.isNull(state.pullRequest);
          assert.deepStrictEqual(world.pullRequestCalls, []);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("leaves a delivery without a review to run there as it always did", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* hostedOn(world, gitlab);
          yield* setSettings(world, settings);
          yield* startAssistantThread(world);
          yield* agreeAndCapture(world, idea);
          yield* assignToFactory(world, idea);
          yield* tick;
          const root = yield* rootIdOf(idea);
          yield* world.launched(root);
          const state = yield* stateOf(root);
          assert.isUndefined(state.reviewedExecution);
          assert.strictEqual(state.status, "running");
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );
});

describe("an owner's review and start", () => {
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
  const review = (world: World) =>
    Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistant) =>
      assistant.review(target(world)),
    );
  const start = (world: World, reviewVersion: string, requestId: string) =>
    Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistant) =>
      assistant.startReview({ ...target(world), reviewVersion, requestId, owner }),
    );
  /** The idea agreed, with nothing captured or authorized, and the assistant's thread open. */
  const agreed = (world: World, values: object = settings) =>
    Effect.gen(function* () {
      yield* setSettings(world, values);
      yield* startAssistantThread(world);
      yield* agree(world, idea);
      return yield* review(world);
    });
  const deliveriesOf = (world: World) =>
    Effect.flatMap(factoryService, (factory) => factory.list({ projectId: world.projectId }));
  const reviewRows = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const counted = (table: string) =>
      sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM ${sql(table)}`.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
      );
    return {
      receipts: yield* counted("fd_assistant_review_receipts"),
      starts: yield* counted("fd_assistant_review_starts"),
      assignments: yield* counted("fd_assistant_assignments"),
    };
  }).pipe(Effect.orDie);
  /** One item, one receipt, one assignment and, once claimed, one delivery. */
  const assertOneOfEach = (world: World, deliveries: number) =>
    Effect.gen(function* () {
      // The fixture's own item, and the capture's.
      assert.strictEqual(yield* itemCount(world), 2);
      assert.deepStrictEqual(yield* reviewRows, { receipts: 1, starts: 1, assignments: 1 });
      assert.lengthOf(yield* deliveriesOf(world), deliveries);
    });

  it.live("runs one delivery on what was reviewed, with no agent's capture or go-ahead", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const snapshot = yield* agreed(world);
          assert.strictEqual(snapshot.start.mode, "new_attempt");
          assert.deepStrictEqual(snapshot.start.blockers, []);
          assert.strictEqual(snapshot.roles.author.model, "author-model");
          const started = yield* start(world, snapshot.reviewVersion, "request-1");
          assert.strictEqual(started.outcome, "queued");

          // Only the claim runs anything, on the review, whatever the settings say by then.
          yield* setSettings(world, {});
          yield* tick;
          const root = yield* rootIdOf(started.assignmentId);
          const author = yield* world.launched(root);
          const state = yield* stateOf(root);
          assert.strictEqual(state.reviewedExecution?.receiptId, started.receiptId);
          assert.deepStrictEqual(state.reviewedExecution?.verifyCommand, snapshot.verifyCommand);
          assert.strictEqual(
            state.reviewedExecution?.roles.author.model,
            snapshot.roles.author.model,
          );
          const turn = world.provider.started.find(({ runId }) => runId === author.runId);
          assert.strictEqual(turn?.runtimePolicy.runtimeMode, snapshot.runtime.ceiling);
          yield* assertOneOfEach(world, 1);

          const { assignments } = yield* Effect.flatMap(
            ProjectAssistant.ProjectAssistant,
            (assistant) => assistant.overview,
          );
          assert.strictEqual(assignments[0]?.reviewed, true);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("converges however often it is confirmed, at once or in turn", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const snapshot = yield* agreed(world);
          const confirmations = yield* Effect.all(
            Array.from({ length: 3 }, () => start(world, snapshot.reviewVersion, "request-1")),
            { concurrency: "unbounded" },
          );
          assert.lengthOf(new Set(confirmations.map(({ receiptId }) => receiptId)), 1);
          assert.lengthOf(new Set(confirmations.map(({ assignmentId }) => assignmentId)), 1);
          assert.lengthOf(
            confirmations.filter(({ replayed }) => !replayed),
            1,
          );
          const again = yield* start(world, snapshot.reviewVersion, "request-1");
          assert.isTrue(again.replayed);
          yield* tick;
          yield* tick;
          yield* assertOneOfEach(world, 1);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("takes its version only once, under any other request id", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const snapshot = yield* agreed(world);
          yield* start(world, snapshot.reviewVersion, "request-1");
          const refused = yield* Effect.flip(start(world, snapshot.reviewVersion, "request-2"));
          assert.include(refused.message, "nothing was authorized or started");
          // A request id names one review, never another's version.
          const foreign = yield* Effect.flip(start(world, "another-version", "request-1"));
          assert.include(foreign.message, "belongs to another review");
          yield* assertOneOfEach(world, 0);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("converges from a source that stored its write and answered with a failure", () => {
    const failing = { on: false };
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const snapshot = yield* agreed(world);
          failing.on = true;
          yield* Effect.flip(start(world, snapshot.reviewVersion, "request-1"));
          assert.deepStrictEqual(yield* reviewRows, { receipts: 0, starts: 0, assignments: 0 });

          failing.on = false;
          yield* world.rebuild(
            Effect.gen(function* () {
              const started = yield* start(world, snapshot.reviewVersion, "request-1");
              assert.isFalse(started.replayed);
              yield* tick;
              yield* assertOneOfEach(world, 1);
            }),
            { orchestration: true },
          );
        }).pipe(Effect.orDie),
      {
        ...reviewedOptions(),
        work: (service) => ({
          ...service,
          createItem: (actor, input) =>
            failing.on
              ? service.createItem(actor, input).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new FakeWorkUnavailable({
                        detail: "The answer was lost.",
                      }) as unknown as WorkDomainError,
                    ),
                  ),
                )
              : service.createItem(actor, input),
        }),
      },
    );
  });

  it.live("converges from a failure of the recording transaction, across a restart", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const snapshot = yield* agreed(world);
          yield* sql`CREATE TRIGGER review_start_fails BEFORE INSERT ON fd_assistant_review_starts
            BEGIN SELECT RAISE(ABORT, 'held by the test'); END`;
          yield* Effect.flip(start(world, snapshot.reviewVersion, "request-1"));
          // The capture stays, and every row of the transaction went with it, authorization too.
          assert.strictEqual(yield* itemCount(world), 2);
          assert.deepStrictEqual(yield* reviewRows, { receipts: 0, starts: 0, assignments: 0 });
          const [brief] = (yield* Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistant) =>
            assistant.inspect(world.projectId, idea),
          )).briefs;
          assert.isFalse(brief?.executionAuthorized);
          yield* sql`DROP TRIGGER review_start_fails`;

          yield* world.rebuild(
            Effect.gen(function* () {
              const started = yield* start(world, snapshot.reviewVersion, "request-1");
              assert.strictEqual(started.outcome, "queued");
              yield* tick;
              yield* assertOneOfEach(world, 1);
            }),
            { orchestration: true },
          );
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("converges across a restart after it committed, before and after its claim", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const snapshot = yield* agreed(world);
          const started = yield* start(world, snapshot.reviewVersion, "request-1");
          yield* world.rebuild(
            Effect.gen(function* () {
              const replayed = yield* start(world, snapshot.reviewVersion, "request-1");
              assert.deepStrictEqual(replayed, { ...started, replayed: true });
              yield* assertOneOfEach(world, 0);
              yield* tick;
              yield* assertOneOfEach(world, 1);
            }),
            { orchestration: true },
          );
          yield* world.rebuild(
            Effect.gen(function* () {
              const replayed = yield* start(world, snapshot.reviewVersion, "request-1");
              assert.deepStrictEqual(replayed, { ...started, replayed: true });
              yield* tick;
              yield* drainFactory;
              yield* assertOneOfEach(world, 1);
            }),
            { orchestration: true },
          );
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live.each([
    {
      name: "no verify command",
      arrange: (_world: World) => Effect.void,
      values: {},
      text: "verify command",
    },
    {
      name: "a provider that cannot name its target",
      arrange: (world: World) =>
        Effect.gen(function* () {
          const bare = yield* git(world.root, ["remote", "get-url", "origin"]);
          yield* git(world.root, [
            "remote",
            "set-url",
            "origin",
            "https://gitlab.com/acme/web.git",
          ]);
          yield* git(world.root, ["remote", "set-url", "--push", "origin", bare]);
        }),
      values: settings,
      text: "not supported on gitlab",
    },
  ])("starts nothing on $name, and says why", ({ arrange, values, text }) =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          yield* arrange(world).pipe(Effect.orDie);
          yield* world.rebuild(
            Effect.gen(function* () {
              const snapshot = yield* agreed(world, values);
              assert.strictEqual(snapshot.start.mode, "none");
              assert.include(snapshot.start.blockers[0]?.message ?? "", text);
              const refused = yield* Effect.flip(start(world, snapshot.reviewVersion, "request-1"));
              assert.include(refused.message, text);
              yield* tick;
              // The fixture's own item, with no capture written.
              assert.strictEqual(yield* itemCount(world), 1);
              assert.deepStrictEqual(yield* reviewRows, {
                receipts: 0,
                starts: 0,
                assignments: 0,
              });
            }),
            { orchestration: true },
          );
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  const runningAttempt = (world: World) =>
    Effect.gen(function* () {
      const snapshot = yield* agreed(world);
      const started = yield* start(world, snapshot.reviewVersion, "request-1");
      yield* tick;
      const root = yield* rootIdOf(started.assignmentId);
      return { snapshot, started, root, author: yield* world.launched(root) };
    });

  const assertFreshReviewStarts = (
    world: World,
    previous: {
      readonly snapshot: { readonly reviewVersion: string };
      readonly started: { readonly assignmentId: string; readonly receiptId: string };
    },
    deliveries: number,
  ) =>
    Effect.gen(function* () {
      // The old request finds only what it did, and the old version under a new one nothing.
      const replayed = yield* start(world, previous.snapshot.reviewVersion, "request-1");
      assert.isTrue(replayed.replayed);
      assert.strictEqual(replayed.attempt, 1);
      const stale = yield* Effect.flip(start(world, previous.snapshot.reviewVersion, "request-2"));
      assert.include(stale.message, "nothing was authorized or started");
      yield* tick;
      assert.lengthOf(yield* deliveriesOf(world), deliveries);
      assert.strictEqual((yield* assignmentOf(previous.started.assignmentId)).attempt, 1);

      const fresh = yield* review(world);
      assert.strictEqual(fresh.start.mode, "new_attempt");
      assert.notStrictEqual(fresh.reviewVersion, previous.snapshot.reviewVersion);
      const again = yield* start(world, fresh.reviewVersion, "request-3");
      assert.strictEqual(again.assignmentId, previous.started.assignmentId);
      assert.notStrictEqual(again.receiptId, previous.started.receiptId);
      assert.strictEqual(again.attempt, 2);
      assert.isFalse(again.replayed);

      // Confirmed twice and across a restart, the one attempt stays one.
      const twice = yield* start(world, fresh.reviewVersion, "request-3");
      assert.deepStrictEqual(twice, { ...again, replayed: true });
      const other = yield* Effect.flip(start(world, fresh.reviewVersion, "request-4"));
      assert.include(other.message, "nothing was authorized or started");
      yield* world.rebuild(
        Effect.gen(function* () {
          const replayedAgain = yield* start(world, fresh.reviewVersion, "request-3");
          assert.deepStrictEqual(replayedAgain, { ...again, replayed: true });
          yield* tick;
          const root = yield* rootIdOf(again.assignmentId);
          const author = yield* world.launched(root);
          const state = yield* stateOf(root);
          assert.strictEqual(state.reviewedExecution?.receiptId, again.receiptId);
          assert.isDefined(author);
          const counts = yield* reviewRows;
          assert.strictEqual(counts.receipts, 2);
          assert.strictEqual(counts.assignments, 1);
          assert.lengthOf(yield* deliveriesOf(world), deliveries + 1);
          assert.strictEqual((yield* assignmentOf(again.assignmentId)).attempt, 2);
        }),
        { orchestration: true },
      );
    });

  it.live("authorizes one new attempt after a cancel, only under a fresh review", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const attempt = yield* runningAttempt(world);
          const assignmentId = attempt.started.assignmentId;
          // While it runs, a review has nothing to start.
          const busy = yield* review(world);
          assert.strictEqual(busy.start.mode, "none");
          assert.strictEqual(busy.start.blockers[0]?.code, "attempt_running");

          yield* controlAssignment(assignmentId, "cancel");
          yield* drainFactory;
          yield* world.endRun(attempt.author.runId, "cancelled");
          yield* tick;
          assert.strictEqual((yield* assignmentOf(assignmentId)).state, "cancelled");
          yield* assertFreshReviewStarts(world, attempt, 1);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("authorizes one new attempt after one failed before anything started", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const failed = yield* queuedReview(world, "full-access", (reviewed) => ({
            ...reviewed,
            repository: { ...reviewed.repository, workspaceRoot: "/elsewhere" },
          }));
          yield* tick;
          assert.strictEqual((yield* assignmentOf(idea)).state, "failed");

          const fresh = yield* review(world);
          assert.deepStrictEqual(fresh.start.blockers, []);
          const again = yield* start(world, fresh.reviewVersion, "request-1");
          assert.strictEqual(again.assignmentId, idea);
          assert.strictEqual(again.attempt, 2);
          assert.notStrictEqual(again.receiptId, failed.receiptId);

          // Nothing else of the idea gets in beside it.
          const refused = yield* Effect.flip(
            Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistant) =>
              assistant.enqueue({
                assignmentId: "beside",
                projectId: world.projectId,
                ideaId: idea,
                executor: "factory",
                managerThreadId: assistantThread,
                modelSelection: settings.roles.author,
                runtimeMode: "full-access",
                interactionMode: "default",
                looperConfig: null,
              }),
            ),
          );
          assert.include(refused.message, "fresh owner review");

          yield* tick;
          const root = yield* rootIdOf(idea);
          yield* world.launched(root);
          assert.strictEqual((yield* stateOf(root)).reviewedExecution?.receiptId, again.receiptId);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  const limited = (maxFixRounds: number) => ({
    ...settings,
    verifyCommand: failsUntilFixed,
    limits: { maxFixRounds, maxReviewRounds: 1, verifyTimeoutMinutes: 30 },
  });

  it.live("raises a spent allowance only under a new receipt, keeping what it used", () =>
    withProject(
      failsUntilFixed,
      (world) =>
        Effect.gen(function* () {
          const snapshot = yield* agreed(world, limited(1));
          const started = yield* start(world, snapshot.reviewVersion, "request-1");
          yield* tick;
          const root = yield* rootIdOf(started.assignmentId);
          const author = yield* world.launched(root);
          const turnsOf = () =>
            world.provider.started.filter(({ threadId }) => threadId === author.threadId).length;

          // Its one fix round goes and comes back failing, with nothing left to spend.
          yield* authorCommits(author.worktreePath, "feat: add the export");
          yield* world.endRun(author.runId, "completed");
          const fix = yield* awaitedRun(root);
          yield* authorCommits(author.worktreePath, "fix: try again", "export const x = 2;\n");
          yield* world.endRun(fix.runId, "completed");
          yield* drainFactory;
          const exhausted = yield* stateOf(root);
          assert.strictEqual(exhausted.block?.reason, "allowance_exhausted");
          assert.deepStrictEqual(exhausted.rounds, { fix: 1, review: 0 });
          yield* tick;
          const turns = turnsOf();

          // A review with nothing raised is honest about it, and adds nothing.
          yield* setSettings(world, limited(2));
          const fresh = yield* review(world);
          assert.strictEqual(fresh.start.mode, "amend");
          assert.strictEqual(fresh.limits.maxFixRounds, 2);
          const raised = yield* start(world, fresh.reviewVersion, "request-2");
          assert.strictEqual(raised.outcome, "amended");
          assert.notStrictEqual(raised.receiptId, started.receiptId);
          assert.strictEqual(raised.attempt, 1);

          // The new round is the only new work, and the old one stays counted.
          yield* drainFactory;
          yield* awaitedRun(root);
          yield* drainOrchestration;
          const resumed = yield* stateOf(root);
          assert.strictEqual(resumed.reviewedExecution?.receiptId, raised.receiptId);
          assert.strictEqual(resumed.reviewedExecution?.limits.maxFixRounds, 2);
          assert.deepInclude(resumed.supersededReceipts ?? [], started.receiptId);
          assert.deepStrictEqual(resumed.rounds, { fix: 2, review: 0 });
          assert.strictEqual(turnsOf(), turns + 1);

          // Repeating the confirmation mints nothing.
          const repeated = yield* start(world, fresh.reviewVersion, "request-2");
          assert.deepStrictEqual(repeated, { ...raised, replayed: true });
          yield* drainFactory;
          yield* drainOrchestration;
          assert.deepStrictEqual((yield* stateOf(root)).rounds, { fix: 2, review: 0 });
          assert.strictEqual(turnsOf(), turns + 1);
          assert.lengthOf(yield* deliveriesOf(world), 1);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("rebinds a delivery blocked on drift under a new receipt, keeping what it used", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const attempt = yield* runningAttempt(world);
          const { root, author } = attempt;
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* git(world.root, [
            "config",
            "--add",
            "remote.origin.pushurl",
            "/nonexistent/o.git",
          ]);
          yield* world.endRun(author.runId, "completed");
          const blocked = yield* assertRefusedAs(root);
          assert.deepStrictEqual(blocked.receipts, []);
          yield* tick;

          // Resuming alone changes nothing: only a review can take the new target.
          const factory = yield* factoryService;
          yield* factory.resume(root);
          const again = yield* assertRefusedAs(root);
          assert.deepStrictEqual(again.rounds, blocked.rounds);
          yield* tick;

          const fresh = yield* review(world);
          assert.strictEqual(fresh.start.mode, "amend");
          const rebound = yield* start(world, fresh.reviewVersion, "request-2");
          assert.strictEqual(rebound.outcome, "amended");
          yield* drainFactory;
          const state = yield* stateOf(root);
          assert.strictEqual(state.reviewedExecution?.receiptId, rebound.receiptId);
          assert.deepStrictEqual(state.reviewedExecution?.repository.publication.push, [
            "/nonexistent/o.git",
          ]);
          assert.deepInclude(state.supersededReceipts ?? [], attempt.started.receiptId);
          assert.deepStrictEqual(state.rounds, blocked.rounds);
          // It went on from where it blocked, on the very review just taken.
          assert.lengthOf(state.receipts, 1);
          assert.strictEqual(state.status, "running");

          // An earlier receipt authorizes nothing again, and one a later review passed neither.
          const refused = yield* Effect.flip(
            factory.rebindReviewed({
              deliveryId: root,
              execution: {
                ...state.reviewedExecution!,
                receiptId: attempt.started.receiptId,
                reviewVersion: 99,
              },
            }),
          );
          assert.strictEqual(refused._tag, "FactoryReviewedRebindRefusedError");
          if (refused._tag === "FactoryReviewedRebindRefusedError") {
            assert.strictEqual(refused.reason, "reused_receipt");
          }
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("refuses to carry on an attempt whose scope moved, leaving it to be cancelled", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { root, author } = yield* runningAttempt(world);
          yield* Effect.flatMap(factoryService, (factory) => factory.stop(root));
          yield* authorCommits(author.worktreePath, "feat: add the export button");
          yield* world.endRun(author.runId, "completed");
          yield* tick;
          assert.strictEqual((yield* stateOf(root)).status, "stopped");

          const assistant = yield* ProjectAssistant.ProjectAssistant;
          yield* assistant.revise({
            projectId: world.projectId,
            ideaId: idea,
            patch: { goal: "Deliver something else" },
          });
          const fresh = yield* review(world);
          assert.strictEqual(fresh.start.mode, "none");
          assert.strictEqual(fresh.start.blockers[0]?.code, "attempt_scope_changed");
          const refused = yield* Effect.flip(start(world, fresh.reviewVersion, "request-2"));
          assert.include(refused.message, "Cancel it");
          assert.strictEqual((yield* stateOf(root)).status, "stopped");
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  /** The owner's own reach into Work, with the grants their client has. */
  const workOwner = {
    id: "session:owner",
    grants: [AuthWorkReadScope, AuthWorkWriteScope, AuthSettingsWriteScope],
    label: "owner",
  };

  /** Someone renaming the captured item in Work, ready to run at any moment. */
  const renameCaptured = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const work = yield* WorkService.WorkService;
    return Effect.gen(function* () {
      const [capture] = yield* sql<{
        readonly source_id: string;
        readonly item_id: string;
      }>`SELECT source_id, item_id FROM fd_assistant_work_captures WHERE idea_id = ${idea}`;
      if (capture === undefined) return assert.fail("Nothing was captured.");
      const ref = {
        sourceId: capture.source_id as WorkItemRef["sourceId"],
        itemId: capture.item_id as WorkItemRef["itemId"],
      };
      const item = yield* work.getItem(workOwner, { ref });
      yield* work.updateItem(workOwner, {
        ref,
        expectedRevision: item.revision,
        title: "Someone renamed this in Work",
        body: item.body,
      });
    }).pipe(Effect.orDie);
  });

  /** Runs an edit during the providers' read of the nth preview from when it was armed. */
  const duringPreview = () => {
    const armed: { count: number; nth: number; edit: Effect.Effect<void> | undefined } = {
      count: 0,
      nth: 0,
      edit: undefined,
    };
    return {
      armed,
      arm: (nth: number, edit: Effect.Effect<void>) =>
        Effect.sync(() => {
          armed.count = 0;
          armed.nth = nth;
          armed.edit = edit;
        }),
      wrapProviders: (
        service: ProviderRegistry.ProviderRegistry["Service"],
      ): ProviderRegistry.ProviderRegistry["Service"] => ({
        ...service,
        getProviders: Effect.suspend(() => {
          armed.count += 1;
          const edit = armed.count === armed.nth ? armed.edit : undefined;
          if (edit !== undefined) armed.edit = undefined;
          return Effect.andThen(edit ?? Effect.void, service.getProviders);
        }),
      }),
    };
  };

  describe("what it shows and what it binds", () => {
    const edited = {
      ...settings,
      verifyCommand: { executable: "unseen-command", args: [] },
      limits: { maxFixRounds: 9, maxReviewRounds: 9, verifyTimeoutMinutes: 9 },
      blockingSeverities: ["low"],
      highRiskEffort: "low",
      roles: { ...settings.roles, author: selection("other-model") },
    };

    /** One settings edit, landing during the read of the providers that follows reading them. */
    const editOnRead: { on: Effect.Effect<void> | undefined } = { on: undefined };
    const wrapProviders = (
      service: ProviderRegistry.ProviderRegistry["Service"],
    ): ProviderRegistry.ProviderRegistry["Service"] => ({
      ...service,
      getProviders: Effect.suspend(() => {
        const edit = editOnRead.on;
        editOnRead.on = undefined;
        return Effect.andThen(edit ?? Effect.void, service.getProviders);
      }),
    });

    it.live("come from one read of the settings, whatever lands in between", () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* setSettings(world, settings);
            const factory = yield* factoryService;
            const service = yield* Factory.FactorySettings.FactorySettings;
            const stored = yield* service.get(world.projectId);
            editOnRead.on = service
              .set(world.projectId, {
                ...stored,
                ...(edited as unknown as Partial<typeof stored>),
              })
              .pipe(Effect.orDie);

            const preview = yield* factory.previewReviewedExecution({
              projectId: world.projectId,
              runtimeCeiling: "full-access",
            });
            assert.isUndefined(editOnRead.on);
            const bound = preview.execution ?? assert.fail(preview.refusal ?? "Nothing was bound.");
            assert.deepStrictEqual(preview.verifyCommand, bound.verifyCommand);
            assert.deepStrictEqual(preview.setupCommand, bound.setupCommand);
            assert.deepStrictEqual(preview.blockingSeverities, bound.blockingSeverities);
            assert.strictEqual(preview.highRiskEffort, bound.highRiskEffort);
            assert.strictEqual(preview.limits.maxFixRounds, bound.limits.maxFixRounds);
            assert.strictEqual(preview.roles.author.selection.model, bound.roles.author.model);
            // Both are what stood before the edit; the next review sees the edit.
            assert.deepStrictEqual(bound.verifyCommand, settings.verifyCommand);
            const next = yield* factory.previewReviewedExecution({
              projectId: world.projectId,
              runtimeCeiling: "full-access",
            });
            assert.strictEqual(next.verifyCommand?.executable, "unseen-command");
          }).pipe(Effect.orDie),
        { ...reviewedOptions(), wrapProviders },
      ),
    );

    const held = (world: World, reviewed: FactoryReviewedExecution) =>
      Effect.flatMap(factoryService, (factory) =>
        factory.reviewedExecutionHolds({
          projectId: world.projectId,
          runtimeCeiling: "full-access",
          execution: reviewed,
        }),
      );

    const writeOverride = (world: World, prompt: string, text: string) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const folder = path.join(world.root, ".foredeck", "factory", "prompts");
        yield* fileSystem.makeDirectory(folder, { recursive: true });
        yield* fileSystem.writeFileString(path.join(folder, `${prompt}.md`), text);
      }).pipe(Effect.orDie);

    it.live.each([
      {
        name: "the verify command",
        move: (world: World) =>
          setSettings(world, { ...settings, verifyCommand: { executable: "other", args: [] } }),
      },
      {
        name: "a role's model",
        move: (world: World) =>
          setSettings(world, {
            ...settings,
            roles: { ...settings.roles, reviewer: selection("other-model") },
          }),
      },
      {
        name: "a limit",
        move: (world: World) =>
          setSettings(world, {
            ...settings,
            limits: { maxFixRounds: 9, maxReviewRounds: 3, verifyTimeoutMinutes: 30 },
          }),
      },
      {
        name: "the blocking severities",
        move: (world: World) => setSettings(world, { ...settings, blockingSeverities: ["low"] }),
      },
      {
        name: "the verify command's removal",
        move: (world: World) => setSettings(world, { roles: settings.roles }),
      },
      {
        name: "a prompt override",
        move: (world: World) => writeOverride(world, "review", "Be stricter."),
      },
    ])("find a review no longer holds once $name moved", ({ move }) =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            yield* setSettings(world, settings);
            const reviewed = yield* reviewNow(world);
            assert.isTrue(yield* held(world, reviewed));
            yield* move(world);
            assert.isFalse(yield* held(world, reviewed));
          }).pipe(Effect.orDie),
        reviewedOptions(),
      ),
    );
  });

  describe("an amendment's one resume", () => {
    const spy = spyOnFactoryPort();
    const options = () => ({ ...reviewedOptions(), assistantFactory: spy.wrap });

    /** A delivery blocked on a target moved since it was reviewed, with a review of what is now. */
    const blockedOnDrift = (world: World) =>
      Effect.gen(function* () {
        spy.calls.length = 0;
        const attempt = yield* runningAttempt(world);
        const { root, author } = attempt;
        yield* authorCommits(author.worktreePath, "feat: add the export button");
        yield* git(world.root, ["config", "--add", "remote.origin.pushurl", "/nonexistent/o.git"]);
        yield* world.endRun(author.runId, "completed");
        yield* assertRefusedAs(root);
        yield* tick;
        const fresh = yield* review(world);
        assert.strictEqual(fresh.start.mode, "amend");
        return { ...attempt, fresh };
      });

    /** A later stop: the reviewer's turn the resume started ends with the delivery stopped. */
    const laterStop = (world: World, root: FactoryDeliveryId) =>
      Effect.gen(function* () {
        const factory = yield* factoryService;
        yield* drainFactory;
        const run = yield* awaitedRun(root);
        yield* factory.stop(root);
        yield* factory.submitReview({ threadId: run.threadId, review: passingReview() });
        yield* world.endRun(run.runId, "completed");
        yield* drainFactory;
        yield* tick;
      });

    const resumes = () => spy.count("resume");

    it.live("resumes nothing more when repeated after a later stop, across a restart", () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root, fresh } = yield* blockedOnDrift(world);
            const amended = yield* start(world, fresh.reviewVersion, "request-2");
            assert.strictEqual(amended.outcome, "amended");
            yield* drainFactory;
            assert.strictEqual(resumes(), 1);
            assert.strictEqual((yield* stateOf(root)).status, "running");
            assert.isUndefined((yield* stateOf(root)).reviewResumeOwed);

            yield* laterStop(world, root);
            const stopped = yield* stateOf(root);
            assert.strictEqual(stopped.status, "stopped");

            const replayed = yield* start(world, fresh.reviewVersion, "request-2");
            assert.deepStrictEqual(replayed, { ...amended, replayed: true });
            yield* drainFactory;
            assert.strictEqual(resumes(), 1);
            assert.deepStrictEqual(yield* stateOf(root), stopped);

            yield* world.rebuild(
              Effect.gen(function* () {
                const again = yield* start(world, fresh.reviewVersion, "request-2");
                assert.deepStrictEqual(again, { ...amended, replayed: true });
                yield* drainFactory;
                assert.strictEqual(resumes(), 1);
                assert.deepStrictEqual(yield* stateOf(root), stopped);
              }),
              { orchestration: true },
            );
          }).pipe(Effect.orDie),
        options(),
      ),
    );

    it.live("finishes a rebind a failure cut short, resuming once, across a restart", () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const { root, fresh, started } = yield* blockedOnDrift(world);
            yield* sql`CREATE TRIGGER rebind_fails BEFORE UPDATE ON fd_factory_deliveries
              BEGIN SELECT RAISE(ABORT, 'held by the test'); END`;
            yield* Effect.flip(start(world, fresh.reviewVersion, "request-2"));
            yield* sql`DROP TRIGGER rebind_fails`;
            // The confirmation stands, and nothing of it reached the delivery.
            assert.strictEqual(
              (yield* stateOf(root)).reviewedExecution?.receiptId,
              started.receiptId,
            );
            assert.strictEqual(resumes(), 0);

            yield* world.rebuild(
              Effect.gen(function* () {
                const replayed = yield* start(world, fresh.reviewVersion, "request-2");
                assert.isTrue(replayed.replayed);
                yield* drainFactory;
                const state = yield* stateOf(root);
                assert.strictEqual(state.reviewedExecution?.receiptId, replayed.receiptId);
                assert.strictEqual(state.status, "running");
                assert.isUndefined(state.reviewResumeOwed);
                assert.strictEqual(resumes(), 1);

                yield* laterStop(world, root);
                yield* start(world, fresh.reviewVersion, "request-2");
                assert.strictEqual(resumes(), 1);
                assert.strictEqual((yield* stateOf(root)).status, "stopped");
              }),
              { orchestration: true },
            );
          }).pipe(Effect.orDie),
        options(),
      ),
    );

    it.live("finishes a resume cut short before Factory took it, across a restart, and once", () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root, fresh } = yield* blockedOnDrift(world);
            spy.control.failResume = "before";
            yield* Effect.flip(start(world, fresh.reviewVersion, "request-2"));
            yield* drainFactory;
            const cut = yield* stateOf(root);
            assert.strictEqual(cut.status, "blocked");
            assert.strictEqual(cut.reviewResumeOwed, cut.reviewedExecution?.receiptId);
            assert.strictEqual(resumes(), 1);

            yield* world.rebuild(
              Effect.gen(function* () {
                yield* start(world, fresh.reviewVersion, "request-2");
                yield* drainFactory;
                const resumed = yield* stateOf(root);
                assert.strictEqual(resumed.status, "running");
                assert.isUndefined(resumed.reviewResumeOwed);
                assert.strictEqual(resumes(), 2);

                yield* laterStop(world, root);
                yield* start(world, fresh.reviewVersion, "request-2");
                assert.strictEqual(resumes(), 2);
                assert.strictEqual((yield* stateOf(root)).status, "stopped");
              }),
              { orchestration: true },
            );
          }).pipe(Effect.orDie),
        options(),
      ),
    );

    it.live("takes no second resume when Factory took the first and its answer was lost", () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root, fresh } = yield* blockedOnDrift(world);
            spy.control.failResume = "after";
            yield* Effect.flip(start(world, fresh.reviewVersion, "request-2"));
            yield* drainFactory;
            const cut = yield* stateOf(root);
            assert.strictEqual(cut.status, "running");
            assert.isUndefined(cut.reviewResumeOwed);
            assert.strictEqual(resumes(), 1);

            // Repeated with it under way, and again once it stopped: the resume stays taken.
            yield* start(world, fresh.reviewVersion, "request-2");
            assert.strictEqual(resumes(), 1);
            yield* laterStop(world, root);
            yield* start(world, fresh.reviewVersion, "request-2");
            assert.strictEqual(resumes(), 1);
            assert.strictEqual((yield* stateOf(root)).status, "stopped");

            yield* world.rebuild(
              Effect.gen(function* () {
                yield* start(world, fresh.reviewVersion, "request-2");
                assert.strictEqual(resumes(), 1);
                assert.strictEqual((yield* stateOf(root)).status, "stopped");
              }),
              { orchestration: true },
            );
          }).pipe(Effect.orDie),
        options(),
      ),
    );

    it.live("records nothing once the item is edited during its final read of settings", () => {
      const during = duringPreview();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root, fresh } = yield* blockedOnDrift(world);
            const before = yield* stateOf(root);
            const rows = yield* reviewRows;
            // Its first preview, then the last.
            yield* during.arm(2, yield* renameCaptured);

            const refused = yield* Effect.flip(start(world, fresh.reviewVersion, "request-2"));
            assert.include(refused.message, "nothing was authorized or started");
            assert.isUndefined(during.armed.edit);
            assert.deepStrictEqual(yield* reviewRows, rows);
            assert.strictEqual(resumes(), 0);
            yield* drainFactory;
            assert.deepStrictEqual(yield* stateOf(root), before);
          }).pipe(Effect.orDie),
        { ...options(), wrapProviders: during.wrapProviders },
      );
    });

    it.live("takes no resume someone else took while it read Work, after they stopped it", () => {
      // Held at the first read of the item for the assistant once the obligation stands: the
      // confirmation has seen it, and its resume is reading Work before it acts.
      const holding: {
        check: Effect.Effect<boolean> | undefined;
        entered: Deferred.Deferred<void>;
        go: Deferred.Deferred<void>;
      } = { check: undefined, entered: Deferred.makeUnsafe(), go: Deferred.makeUnsafe() };
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* factoryService;
            const { root, fresh } = yield* blockedOnDrift(world);
            holding.check = factory.get(root).pipe(
              Effect.map(Option.exists(({ state }) => state.reviewResumeOwed !== undefined)),
              Effect.orElseSucceed(() => false),
            );
            const running = yield* Effect.forkChild(start(world, fresh.reviewVersion, "request-2"));
            yield* Deferred.await(holding.entered);
            assert.strictEqual(resumes(), 0);

            // The owner resumes it directly, which takes the obligation, and stops it again.
            yield* factory.resume(root);
            yield* drainFactory;
            const run = yield* awaitedRun(root);
            yield* factory.stop(root);
            yield* factory.submitReview({ threadId: run.threadId, review: passingReview() });
            yield* world.endRun(run.runId, "completed");
            yield* drainFactory;
            const stopped = yield* stateOf(root);
            assert.strictEqual(stopped.status, "stopped");
            assert.isUndefined(stopped.reviewResumeOwed);

            yield* Deferred.succeed(holding.go, undefined);
            const amended = yield* Fiber.join(running);
            assert.strictEqual(amended.outcome, "amended");
            yield* drainFactory;
            assert.deepStrictEqual(yield* stateOf(root), stopped);

            // Repeating it later finds nothing left to take either.
            const replayed = yield* start(world, fresh.reviewVersion, "request-2");
            assert.isTrue(replayed.replayed);
            yield* drainFactory;
            assert.deepStrictEqual(yield* stateOf(root), stopped);
          }).pipe(Effect.orDie),
        {
          ...options(),
          work: (service) => ({
            ...service,
            getItem: (actor, input) =>
              Effect.gen(function* () {
                if (actor.id === "assistant:handoff" && holding.check !== undefined) {
                  if (yield* holding.check) {
                    holding.check = undefined;
                    yield* Deferred.succeed(holding.entered, undefined);
                    yield* Deferred.await(holding.go);
                  }
                }
                return yield* service.getItem(actor, input);
              }),
          }),
        },
      );
    });

    it.live("still answers once the delivery ended, or a later review replaced it", () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root, fresh } = yield* blockedOnDrift(world);
            const amended = yield* start(world, fresh.reviewVersion, "request-2");
            yield* laterStop(world, root);

            // A second review replaces the first amendment's receipt.
            yield* setSettings(world, {
              ...settings,
              limits: { maxFixRounds: 9, maxReviewRounds: 9, verifyTimeoutMinutes: 30 },
            });
            const second = yield* review(world);
            assert.strictEqual(second.start.mode, "amend");
            const replaced = yield* start(world, second.reviewVersion, "request-3");
            assert.notStrictEqual(replaced.receiptId, amended.receiptId);
            yield* drainFactory;
            const resumed = resumes();

            const old = yield* start(world, fresh.reviewVersion, "request-2");
            assert.deepStrictEqual(old, { ...amended, replayed: true });
            assert.strictEqual(resumes(), resumed);
            assert.strictEqual(
              (yield* stateOf(root)).reviewedExecution?.receiptId,
              replaced.receiptId,
            );

            // Ended, each confirmation still finds what it did, and starts nothing.
            yield* controlAssignment(replaced.assignmentId, "cancel");
            yield* drainFactory;
            const ended = yield* stateOf(root);
            assert.strictEqual(ended.status, "cancelled");
            assert.isTrue((yield* start(world, second.reviewVersion, "request-3")).replayed);
            assert.isTrue((yield* start(world, fresh.reviewVersion, "request-2")).replayed);
            assert.strictEqual(resumes(), resumed);
            assert.deepStrictEqual(yield* stateOf(root), ended);
          }).pipe(Effect.orDie),
        options(),
      ),
    );
  });

  describe("a parent's amendment", () => {
    const spy = spyOnFactoryPort();
    const raised = {
      ...settings,
      limits: { maxFixRounds: 9, maxReviewRounds: 9, verifyTimeoutMinutes: 30 },
    };
    const reviewAs = (world: World, kind: "single" | "parent") =>
      Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistant) =>
        assistant.review({ ...target(world), kind }),
      );
    const startAs = (
      world: World,
      kind: "single" | "parent",
      reviewVersion: string,
      requestId: string,
    ) =>
      Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistant) =>
        assistant.startReview({ ...target(world), kind, reviewVersion, requestId, owner }),
      );

    /** A reviewed parent waiting on its first child, stopped, with a fresh review of it read. */
    const childAtRest = (world: World) =>
      Effect.gen(function* () {
        const factory = yield* factoryService;
        spy.calls.length = 0;
        yield* setSettings(world, settings);
        yield* startAssistantThread(world);
        yield* agree(world, idea);
        const first = yield* reviewAs(world, "parent");
        const started = yield* startAs(world, "parent", first.reviewVersion, "request-1");
        yield* tick;
        const root = yield* rootIdOf(started.assignmentId);
        const planner = yield* world.launched(root);
        yield* factory.submitPlan({ threadId: planner.threadId, plan: twoTaskPlan });
        yield* world.endRun(planner.runId, "completed");
        assert.strictEqual((yield* stateOf(root)).status, "waiting");
        yield* tick;
        yield* factory.approvePlan(root);
        yield* drainFactory;
        yield* tick;
        yield* drainFactory;
        const { children } = yield* stateOf(root);
        const [child, sibling] = children;
        if (child === undefined || sibling === undefined) return assert.fail("No children.");
        const author = yield* world.launched(child);
        yield* factory.stop(child);
        yield* authorCommits(author.worktreePath, "feat: task one", "one\n");
        yield* world.endRun(author.runId, "completed");
        yield* drainFactory;
        assert.strictEqual((yield* stateOf(child)).status, "stopped");
        assert.strictEqual((yield* stateOf(root)).status, "running");
        yield* tick;
        yield* setSettings(world, raised);
        // Asked as a single item, it still reads as the parent it is, and the planner counts.
        const fresh = yield* reviewAs(world, "single");
        assert.strictEqual(fresh.target.kind, "parent");
        assert.isTrue(fresh.target.kindFixed);
        assert.strictEqual(fresh.start.mode, "amend");
        return { root, child, sibling, started, fresh };
      });

    const laterChildStop = (world: World, child: FactoryDeliveryId) =>
      Effect.gen(function* () {
        const factory = yield* factoryService;
        yield* drainFactory;
        const run = yield* awaitedRun(child);
        yield* factory.stop(child);
        yield* factory.submitReview({ threadId: run.threadId, review: passingReview() });
        yield* world.endRun(run.runId, "completed");
        yield* drainFactory;
        yield* tick;
        assert.strictEqual((yield* stateOf(child)).status, "stopped");
      });

    const resumesOf = (delivery: string) =>
      spy.calls.filter((call) => call === `resume:${delivery}`).length;
    const allResumes = () => spy.count("resume");

    const assertNoneOwed = (...deliveries: ReadonlyArray<FactoryDeliveryId>) =>
      Effect.forEach(deliveries, (delivery) =>
        Effect.map(stateOf(delivery), ({ reviewResumeOwed }) =>
          assert.isUndefined(reviewResumeOwed, delivery),
        ),
      );

    const failUpdatesOf = (delivery: FactoryDeliveryId) =>
      // A trigger takes no bound parameters.
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.unsafe(`CREATE TRIGGER rebind_fails BEFORE UPDATE ON fd_factory_deliveries
          WHEN OLD.delivery_id = '${delivery}'
          BEGIN SELECT RAISE(ABORT, 'held by the test'); END`),
      ).pipe(Effect.orDie);
    const restoreUpdates = Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`DROP TRIGGER rebind_fails`,
    ).pipe(Effect.orDie);

    it.live("resumes the child once, and a repeat after its later stop resumes nothing", () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root, child, sibling, fresh, started } = yield* childAtRest(world);
            const amended = yield* startAs(world, "parent", fresh.reviewVersion, "request-2");
            assert.strictEqual(amended.outcome, "amended");
            yield* drainFactory;
            assert.strictEqual(resumesOf(child), 1);
            assert.strictEqual(allResumes(), 1);
            // Every delivery that still has work stands under the review, and none owes more.
            for (const delivery of [root, child, sibling]) {
              const state = yield* stateOf(delivery);
              assert.strictEqual(state.reviewedExecution?.receiptId, amended.receiptId);
              assert.deepInclude(state.supersededReceipts ?? [], started.receiptId);
            }
            yield* assertNoneOwed(root, child, sibling);

            yield* laterChildStop(world, child);
            const stopped = yield* stateOf(child);
            const replayed = yield* startAs(world, "parent", fresh.reviewVersion, "request-2");
            assert.deepStrictEqual(replayed, { ...amended, replayed: true });
            assert.strictEqual(allResumes(), 1);
            assert.deepStrictEqual(yield* stateOf(child), stopped);
            yield* assertNoneOwed(root, child, sibling);
          }).pipe(Effect.orDie),
        { ...reviewedOptions(), assistantFactory: spy.wrap },
      ),
    );

    it.live(
      "never hands the resume on: a repeat after the child was resumed by hand adds none",
      () =>
        withProject(
          verifyCommands.passes,
          (world) =>
            Effect.gen(function* () {
              const factory = yield* factoryService;
              const { root, child, sibling, fresh, started } = yield* childAtRest(world);

              // Its parent's step fails: nothing of the review reaches the child, and none is owed.
              yield* failUpdatesOf(root);
              yield* Effect.flip(startAs(world, "parent", fresh.reviewVersion, "request-2"));
              yield* restoreUpdates;
              assert.strictEqual(
                (yield* stateOf(child)).reviewedExecution?.receiptId,
                started.receiptId,
              );
              yield* assertNoneOwed(root, child, sibling);
              assert.strictEqual(allResumes(), 0);

              // The owner resumes the child themselves.
              yield* factory.resume(child);
              yield* drainFactory;

              // Repeated with it running, then once it has stopped: the review no longer describes it.
              const whileRunning = yield* Effect.flip(
                startAs(world, "parent", fresh.reviewVersion, "request-2"),
              );
              assert.include(whileRunning.message, "moved on");
              yield* assertNoneOwed(root, child, sibling);
              yield* laterChildStop(world, child);
              const stopped = yield* stateOf(child);
              const afterStop = yield* Effect.flip(
                startAs(world, "parent", fresh.reviewVersion, "request-2"),
              );
              assert.include(afterStop.message, "moved on");
              assert.strictEqual(allResumes(), 0);
              assert.deepStrictEqual(yield* stateOf(child), stopped);
              yield* assertNoneOwed(root, child, sibling);
            }).pipe(Effect.orDie),
          { ...reviewedOptions(), assistantFactory: spy.wrap },
        ),
    );

    it.live("takes up its one resume when the child's own step was what failed", () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { root, child, sibling, fresh, started } = yield* childAtRest(world);
            yield* failUpdatesOf(child);
            yield* Effect.flip(startAs(world, "parent", fresh.reviewVersion, "request-2"));
            yield* restoreUpdates;
            // All the rest stand under the review; the child does not, and owes nothing yet.
            const parent = yield* stateOf(root);
            assert.notStrictEqual(parent.reviewedExecution?.receiptId, started.receiptId);
            assert.strictEqual(
              (yield* stateOf(child)).reviewedExecution?.receiptId,
              started.receiptId,
            );
            yield* assertNoneOwed(root, child, sibling);

            yield* world.rebuild(
              Effect.gen(function* () {
                const replayed = yield* startAs(world, "parent", fresh.reviewVersion, "request-2");
                assert.isTrue(replayed.replayed);
                yield* drainFactory;
                assert.strictEqual(resumesOf(child), 1);
                assert.strictEqual(
                  (yield* stateOf(child)).reviewedExecution?.receiptId,
                  replayed.receiptId,
                );
                yield* assertNoneOwed(root, child, sibling);
              }),
              { orchestration: true },
            );
          }).pipe(Effect.orDie),
        { ...reviewedOptions(), assistantFactory: spy.wrap },
      ),
    );

    it.live(
      "keeps a resume a failure cut short on the child, for the owner or a repeat alone",
      () =>
        withProject(
          verifyCommands.passes,
          (world) =>
            Effect.gen(function* () {
              const factory = yield* factoryService;
              const { root, child, sibling, fresh } = yield* childAtRest(world);
              spy.control.failResume = "before";
              const cut = yield* Effect.flip(
                startAs(world, "parent", fresh.reviewVersion, "request-2"),
              );
              assert.strictEqual(cut._tag, "AssistantError");
              const owing = yield* stateOf(child);
              assert.strictEqual(owing.reviewResumeOwed, owing.reviewedExecution?.receiptId);
              yield* assertNoneOwed(root, sibling);
              assert.strictEqual(allResumes(), 1);

              // The owner takes it up themselves, and it never moves to the parent.
              yield* factory.resume(child);
              yield* drainFactory;
              yield* assertNoneOwed(root, child, sibling);
              const replayed = yield* startAs(world, "parent", fresh.reviewVersion, "request-2");
              assert.isTrue(replayed.replayed);
              yield* assertNoneOwed(root, child, sibling);

              yield* laterChildStop(world, child);
              const stopped = yield* stateOf(child);
              yield* startAs(world, "parent", fresh.reviewVersion, "request-2");
              assert.strictEqual(allResumes(), 1);
              assert.deepStrictEqual(yield* stateOf(child), stopped);
              yield* assertNoneOwed(root, child, sibling);
            }).pipe(Effect.orDie),
          { ...reviewedOptions(), assistantFactory: spy.wrap },
        ),
    );

    it.live("refuses a confirmation asking for a single item, recording nothing", () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { child, fresh } = yield* childAtRest(world);
            const before = yield* reviewRows;
            const refused = yield* Effect.flip(
              startAs(world, "single", fresh.reviewVersion, "request-2"),
            );
            assert.include(refused.message, "runs as it started");
            assert.deepStrictEqual(yield* reviewRows, before);
            assert.strictEqual(allResumes(), 0);
            assert.strictEqual((yield* stateOf(child)).status, "stopped");
          }).pipe(Effect.orDie),
        { ...reviewedOptions(), assistantFactory: spy.wrap },
      ),
    );
  });

  it.live(
    "stays short with a long history and oversized saved settings, until they are fixed",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const work = yield* WorkService.WorkService;
            const oversized = {
              ...settings,
              roles: {
                ...settings.roles,
                author: {
                  ...settings.roles.author,
                  options: Array.from({ length: 200 }, (_, index) => ({
                    id: `${index}-${"o".repeat(100_000)}`,
                    value: "v".repeat(100_000),
                  })),
                },
              },
            };
            const ordinary = yield* agreed(world);
            const source = ordinary.target.source ?? assert.fail("No source was chosen.");
            const config = { kind: "markdown", directory: "tasks", autoStart: false } as const;
            yield* setSettings(world, oversized);
            yield* work.saveSource(workOwner, {
              sourceId: source.sourceId,
              projectId: world.projectId,
              label: "l".repeat(100_000),
              config,
            });
            const sql = yield* SqlClient.SqlClient;
            for (let index = 0; index < 201; index += 1) {
              const assignmentId = `old-${String(index).padStart(4, "0")}`;
              yield* sql`INSERT INTO fd_assistant_assignments (
                  assignment_id, project_id, idea_id, executor, attempt, state,
                  worker_refs_json, progress_json, evidence_json, created_at, updated_at
                ) VALUES (
                  ${assignmentId}, ${world.projectId}, ${idea}, 'factory', 1, 'cancelled',
                  '[]', '[]', '[]', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'
                )`;
            }

            const snapshot = yield* review(world);
            // The options and reasons it lists at their longest, and little else.
            assert.isAtMost(JSON.stringify(snapshot).length, 100_000);
            assert.lengthOf(snapshot.attempts, 20);
            assert.strictEqual(snapshot.attemptsOmitted, 181);
            assert.isAtMost(snapshot.target.source?.label.length ?? 0, 1_024);
            assert.lengthOf(snapshot.roles.author.options, 32);
            assert.strictEqual(snapshot.roles.author.optionsOmitted, 168);
            assert.isTrue(snapshot.truncated);
            assert.isFalse(snapshot.briefTruncated);
            assert.strictEqual(snapshot.start.mode, "none");
            assert.include(
              snapshot.start.blockers.map(({ code }) => code),
              "details_too_long",
            );
            yield* Effect.flip(start(world, snapshot.reviewVersion, "request-1"));
            assert.deepStrictEqual(yield* reviewRows, { receipts: 0, starts: 0, assignments: 201 });

            // Fixing what was too long is all it takes: the history alone stops nothing.
            yield* setSettings(world, settings);
            yield* work.saveSource(workOwner, {
              sourceId: source.sourceId,
              projectId: world.projectId,
              label: source.label,
              config,
            });
            const fixed = yield* review(world);
            assert.strictEqual(fixed.attemptsOmitted, 181);
            assert.deepStrictEqual(fixed.start.blockers, []);
            assert.strictEqual(
              (yield* start(world, fixed.reviewVersion, "request-2")).outcome,
              "queued",
            );
          }).pipe(Effect.orDie),
        reviewedOptions(),
      ),
  );

  const TITLE_ONLY = [
    { name: "naming the title it already has", first: {}, edit: `Deliver ${idea}` },
    { name: "clearing the title it was captured under", first: { title: "Named" }, edit: "" },
  ];

  /** An idea captured, then edited in a way that leaves its item saying just what it says. */
  const capturedThenTitled = (world: World, first: object, edit: string) =>
    Effect.gen(function* () {
      const assistant = yield* ProjectAssistant.ProjectAssistant;
      const work = yield* WorkService.WorkService;
      yield* setSettings(world, settings);
      yield* startAssistantThread(world);
      yield* assistant.revise({ projectId: world.projectId, ideaId: idea, patch: first });
      const ref = yield* agreeAndCapture(world, idea);
      const item = yield* work.getItem(workOwner, { ref });
      yield* assistant.revise({
        projectId: world.projectId,
        ideaId: idea,
        patch: { title: edit },
      });
      return { ref, item, work, assistant };
    });

  it.live.each(TITLE_ONLY)(
    "starts an idea after $name, rewriting nothing in Work",
    ({ first, edit }) =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { ref, item, work } = yield* capturedThenTitled(world, first, edit);
            const fresh = yield* review(world);
            assert.strictEqual(fresh.start.mode, "new_attempt");
            assert.deepStrictEqual(fresh.start.blockers, []);

            const started = yield* start(world, fresh.reviewVersion, "request-1");
            assert.strictEqual(started.outcome, "queued");
            const after = yield* work.getItem(workOwner, { ref });
            assert.strictEqual(after.revision, item.revision);
            assert.strictEqual(after.title, item.title);
            yield* tick;
            yield* assertOneOfEach(world, 1);
          }).pipe(Effect.orDie),
        reviewedOptions(),
      ),
  );

  it.live.each(TITLE_ONLY)("queues an agent's assignment after $name", ({ first, edit }) =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { ref, item, work, assistant } = yield* capturedThenTitled(world, first, edit);
          const captures = yield* WorkCapture.WorkCapture;
          const recaptured = yield* captures.capture({
            caller: assistantCaller,
            projectId: world.projectId,
            ideaId: idea,
            kind: "single",
          });
          assert.strictEqual(recaptured.outcome, "unchanged");
          yield* assistant.revise({
            projectId: world.projectId,
            ideaId: idea,
            patch: { executionAuthorized: true },
          });
          yield* assignToFactory(world, idea);
          assert.strictEqual((yield* work.getItem(workOwner, { ref })).revision, item.revision);
          yield* tick;
          assert.lengthOf(yield* deliveriesOf(world), 1);
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live("refuses a review of a Work source that has moved since, keeping its id and label", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const work = yield* WorkService.WorkService;
          const snapshot = yield* agreed(world);
          const before = snapshot.target.source ?? assert.fail("No source was chosen.");
          assert.strictEqual(before.identity, "tasks");

          const moved = yield* work.saveSource(workOwner, {
            sourceId: before.sourceId,
            projectId: world.projectId,
            label: before.label,
            config: { kind: "markdown", directory: "elsewhere", autoStart: false },
          });
          assert.strictEqual(moved.sourceId, before.sourceId);
          assert.strictEqual(moved.label, before.label);

          // Before anything is captured, there or anywhere.
          const items = yield* itemCount(world);
          const refused = yield* Effect.flip(start(world, snapshot.reviewVersion, "request-1"));
          assert.include(refused.message, "nothing was authorized or started");
          assert.strictEqual(yield* itemCount(world), items);
          assert.deepStrictEqual(yield* reviewRows, { receipts: 0, starts: 0, assignments: 0 });

          // Reading it again shows where it goes now, and only that can start.
          const fresh = yield* review(world);
          assert.strictEqual(fresh.target.source?.identity, "elsewhere");
          assert.notStrictEqual(fresh.reviewVersion, snapshot.reviewVersion);
          assert.strictEqual(
            (yield* start(world, fresh.reviewVersion, "request-2")).outcome,
            "queued",
          );
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );

  it.live(
    "records nothing once the item is edited during the start's final read of settings",
    () => {
      const during = duringPreview();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const snapshot = yield* agreed(world);
            // Its preview before capturing, one after, then the last.
            yield* during.arm(3, yield* renameCaptured);

            const refused = yield* Effect.flip(start(world, snapshot.reviewVersion, "request-1"));
            assert.include(refused.message, "nothing was authorized or started");
            assert.isUndefined(during.armed.edit);
            assert.deepStrictEqual(yield* reviewRows, { receipts: 0, starts: 0, assignments: 0 });
            const { briefs } = yield* Effect.flatMap(
              ProjectAssistant.ProjectAssistant,
              (assistant) => assistant.inspect(world.projectId, idea),
            );
            assert.isFalse(briefs[0]?.executionAuthorized);
            yield* tick;
            assert.lengthOf(yield* deliveriesOf(world), 0);
          }).pipe(Effect.orDie),
        { ...reviewedOptions(), wrapProviders: during.wrapProviders },
      );
    },
  );

  it.live("refuses a version whose scope changed and came back before it was confirmed", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const snapshot = yield* agreed(world);
          const assistant = yield* ProjectAssistant.ProjectAssistant;
          const change = (goal: string) =>
            assistant.revise({ projectId: world.projectId, ideaId: idea, patch: { goal } });
          yield* change("Deliver something else");
          yield* change(snapshot.goal);
          const refused = yield* Effect.flip(start(world, snapshot.reviewVersion, "request-1"));
          assert.include(refused.message, "nothing was authorized or started");
          assert.deepStrictEqual(yield* reviewRows, { receipts: 0, starts: 0, assignments: 0 });
          // Reading it again is what makes it reviewed.
          const again = yield* review(world);
          assert.strictEqual(again.goal, snapshot.goal);
          assert.strictEqual(
            (yield* start(world, again.reviewVersion, "request-2")).outcome,
            "queued",
          );
        }).pipe(Effect.orDie),
      reviewedOptions(),
    ),
  );
});
