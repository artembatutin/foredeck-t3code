import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { FactoryDeliveryId, type FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Tool } from "effect/ai";

// Loaded before the MCP modules, as the core toolkit tests do, so their import cycle resolves.
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import { WorkService } from "../../work-management/index.ts";
import * as FactoryPullRequest from "../FactoryPullRequest.ts";
import * as FactoryRecord from "../FactoryRecord.ts";
import * as FactoryReview from "../FactoryReview.ts";
import * as FactoryService from "../FactoryService.ts";
import * as FactorySettings from "../FactorySettings.ts";
import * as FactoryThreadEffects from "../FactoryThreadEffects.ts";
import * as FactoryWorkComments from "../FactoryWorkComments.ts";
import * as FactoryWorker from "../FactoryWorker.ts";
import * as Factory from "../index.ts";
import * as FactoryDeliveryStore from "../persistence/FactoryDeliveryStore.ts";
import { advance } from "../pipeline/engine.ts";
import {
  type FactoryDeliveryState,
  type FactoryEvent,
  queuedDeliveryState,
} from "../pipeline/state.ts";
import * as FactoryEvidence from "../verify/FactoryEvidence.ts";
import * as FactoryVerifyRunner from "../verify/FactoryVerifyRunner.ts";
import { toolLayer } from "./handlers.ts";
import { FactoryToolkit } from "./tools.ts";

const projectId = ProjectId.make("project-alpha");
const deliveryId = FactoryDeliveryId.make("delivery-1");
const itemRef = {
  sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
  itemId: WorkItemId.make("fd-aaaaaa"),
};
const branch = "feature/item-7";
const author = ThreadId.make("thread-author");
const authorRun = RunId.make("run-author");
const reviewer = ThreadId.make("thread-reviewer");
const reviewRun = RunId.make("run-review");
const unrelated = ThreadId.make("thread-unrelated");

/** The calling threads, each live in its turn; the reviewer works in plan mode, as Factory runs it. */
const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([
  [author, liveThreadShell(author)],
  [reviewer, liveThreadShell(reviewer, { interactionMode: "plan" })],
  [unrelated, liveThreadShell(unrelated)],
]);

/**
 * FactoryService, the worker and review judging as the server builds them, on in-memory SQLite,
 * real git and an evidence folder under a temp T3 home. A submission issues no effect, so the
 * services that perform effects are stubs.
 */
const layer = FactoryService.layer.pipe(
  Layer.provideMerge(FactoryWorker.layer),
  // Transition comments are posted in FactoryWorkComments.test.ts; none is posted here.
  Layer.provide(Layer.mock(FactoryWorkComments.FactoryWorkComments)({ post: () => Effect.void })),
  Layer.provide(FactoryReview.layer),
  Layer.provide(FactoryEvidence.layer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(FactoryThreadEffects.FactoryThreadEffects)({}),
      Layer.mock(FactoryVerifyRunner.FactoryVerifyRunner)({}),
      Layer.mock(FactoryRecord.FactoryRecord)({}),
      Layer.mock(FactoryPullRequest.FactoryPullRequest)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
      Layer.mock(ProjectStore.ProjectStoreV2)({}),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(WorkService.WorkService)({}),
    ),
  ),
  Layer.provideMerge(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
    }),
  ),
  Layer.provideMerge(FactorySettings.layer),
  Layer.provideMerge(Factory.layerPersistence),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-mcp-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

/** A provider session T3 launched for `threadId`, or an MCP client signed in from outside T3. */
const scopeOf = (threadId: ThreadId | undefined): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "session",
  thread:
    threadId === undefined
      ? undefined
      : {
          threadId,
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
  client:
    threadId === undefined
      ? { sessionId: "client-session", label: "Outside client", access: "full-access" }
      : undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration" as const]),
});

/** `factory_submit_review` as `threadId` calls it, decoded from its parameters like over MCP. */
const submit = (threadId: ThreadId | undefined, review: unknown) =>
  Effect.gen(function* () {
    const toolkit = yield* FactoryToolkit;
    return yield* toolkit.handle("factory_submit_review", { review }).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((results) => results.at(-1)!),
    );
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scopeOf(threadId)),
    Effect.provide(McpToolAccess.HandlersLayer.layer(toolLayer)),
  );

const ada = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];
const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 });
    return result.stdout.trim();
  });
const commit = (cwd: string, message: string) =>
  git(cwd, [...ada, "commit", "--no-verify", "--no-gpg-sign", "--allow-empty", "-m", message]);

const stored = Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
  deliveries.get(deliveryId),
).pipe(Effect.map((delivery) => Option.getOrThrow(delivery).state));
const rawRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT * FROM fd_factory_deliveries WHERE delivery_id = ${deliveryId}`;
});

/**
 * Stores the delivery as the reviewer's launch left it: the author's commit verified on a real
 * worktree, and the review stage awaiting the reviewer's run. `after` events follow, as later
 * steps would have left it.
 */
const seedReview = (...after: ReadonlyArray<FactoryEvent>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-mcp-wt-" });
    yield* git(cwd, ["init", "-b", "main"]);
    yield* commit(cwd, "chore: root");
    const baseline = yield* git(cwd, ["rev-parse", "HEAD"]);
    yield* git(cwd, ["switch", "-c", branch]);
    yield* fileSystem.makeDirectory(path.join(cwd, "src"));
    yield* fileSystem.writeFileString(
      path.join(cwd, "src", "export.ts"),
      "export const csv = 1;\n",
    );
    yield* fileSystem.writeFileString(path.join(cwd, "src", "export.test.ts"), "// covers csv\n");
    yield* git(cwd, ["add", "-A"]);
    yield* commit(cwd, "feat: export the table as CSV");
    const [headSha = "", tree = ""] = (yield* git(cwd, ["rev-parse", "HEAD", "HEAD^{tree}"])).split(
      "\n",
    );
    const receipt: FactoryVerifyReceipt = {
      version: 1,
      headSha,
      tree,
      startedAt: "2026-10-24T10:00:00.000Z",
      finishedAt: "2026-10-24T10:01:05.000Z",
      code: 0,
      timedOut: false,
      durationMs: 65_000,
      command: { executable: "vp", args: ["test", "run"] },
      settingsHash: "settings-1",
      platform: "darwin-arm64",
      logPath: "/t3/userdata/fd-factory/delivery-1/verify-1.log",
      outputHash: "output-1",
    };
    const events: ReadonlyArray<FactoryEvent> = [
      { type: "start" },
      {
        type: "thread.launched",
        effectId: 1,
        threadId: author,
        runId: authorRun,
        worktreePath: cwd,
        baseline,
      },
      { type: "run.finished", threadId: author, runId: authorRun, status: "completed" },
      { type: "settle.checked", effectId: 2, result: { status: "settled" } },
      { type: "command.finished", effectId: 3, outcome: { type: "receipt", receipt } },
      // A reviewer's launch reports its worktree's HEAD, the commit it reviews.
      {
        type: "thread.launched",
        effectId: 4,
        threadId: reviewer,
        runId: reviewRun,
        worktreePath: cwd,
        baseline: headSha,
      },
      ...after,
    ];
    const state = events.reduce<FactoryDeliveryState>(
      (current, event) => advance(current, event).delivery,
      queuedDeliveryState({ branch, baseRef: "main" }),
    );
    yield* Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
      deliveries.insert({ deliveryId, projectId, itemRef, state }),
    );
    return { headSha };
  });

/** A passing review: a low finding, and criterion 1 verified by the export's test. */
const passingReview = {
  verdict: "pass",
  findings: [
    {
      id: "export-name",
      severity: "low",
      required: false,
      file: "src/export.ts",
      line: 1,
      detail: "The export is named for its format only, so a second format will need a rename.",
    },
  ],
  acceptance: [
    {
      criterion: 1,
      status: "verified",
      evidence: "The export test covers CSV output.",
      paths: ["src/export.test.ts"],
    },
  ],
  missing_evidence: [],
};
const duplicatedFinding = {
  ...passingReview,
  findings: [passingReview.findings[0], passingReview.findings[0]],
};

describe("factory MCP tools", () => {
  it("publishes factory_submit_review with a reference-free object-root input", () => {
    assert.deepStrictEqual(
      Object.values(FactoryToolkit.tools).map((tool) => tool.name),
      ["factory_submit_review", "factory_status", "factory_deliver"],
    );
    const schema = Tool.getJsonSchema(FactoryToolkit.tools.factory_submit_review);
    assert.strictEqual((schema as { type?: string }).type, "object");
    assert.deepStrictEqual((schema as { required?: ReadonlyArray<string> }).required, ["review"]);
    assert.notInclude(JSON.stringify(schema), '"$ref"');
  });
});

describe("factory_submit_review from the reviewer", () => {
  it.effect("records the plan-mode reviewer's review from the tool and returns its summary", () =>
    Effect.gen(function* () {
      const { headSha } = yield* seedReview();

      const result = yield* submit(reviewer, passingReview);

      assert.isFalse(result.isFailure, JSON.stringify(result.result));
      const state = yield* stored;
      assert.strictEqual(state.reviews.length, 1);
      const [recorded] = state.reviews;
      assert.strictEqual(recorded?.source, "mcp");
      assert.strictEqual(recorded?.summary.headSha, headSha);
      assert.deepStrictEqual(result.result, {
        deliveryId,
        round: 1,
        summary: recorded?.summary,
      });
      // Recorded, not acted on: the reviewer's run goes on.
      assert.strictEqual(state.status, "running");
      assert.strictEqual(state.stage, "review");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("parses a review sent as a JSON string", () =>
    Effect.gen(function* () {
      yield* seedReview();

      const result = yield* submit(reviewer, JSON.stringify(passingReview));

      assert.isFalse(result.isFailure, JSON.stringify(result.result));
      assert.strictEqual((yield* stored).reviews[0]?.source, "mcp");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("answers an invalid review with its problems, then blocks on a second", () =>
    Effect.gen(function* () {
      yield* seedReview();

      const first = yield* submit(reviewer, duplicatedFinding);

      assert.isTrue(first.isFailure);
      assert.deepInclude(first.result as object, {
        _tag: "FactoryMcpFailure",
        code: "invalid_review",
      });
      assert.include(
        (first.result as { message: string }).message,
        'Finding id "export-name" is used 2 times; give each finding its own id.',
      );
      const counted = yield* stored;
      assert.strictEqual(counted.status, "running");
      assert.strictEqual(counted.invalidSubmissions, 1);
      assert.deepStrictEqual(counted.reviews, []);

      const second = yield* submit(reviewer, { verdict: "maybe" });

      assert.isTrue(second.isFailure);
      assert.deepInclude(second.result as object, {
        _tag: "FactoryMcpFailure",
        code: "delivery_blocked",
      });
      assert.match((second.result as { message: string }).message, /The review is not valid: /);
      assert.strictEqual((yield* stored).status, "blocked");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});

describe("factory_submit_review refusals", () => {
  it.effect.each([
    {
      name: "the author thread",
      caller: author,
      after: [],
      refusal: { _tag: "FactoryMcpFailure", code: "not_reviewer" },
    },
    {
      name: "an unrelated thread",
      caller: unrelated,
      after: [],
      refusal: { _tag: "FactoryMcpFailure", code: "not_reviewer" },
    },
    {
      name: "the reviewer after its delivery blocked",
      caller: reviewer,
      after: [{ type: "run.finished", threadId: reviewer, runId: reviewRun, status: "failed" }],
      refusal: { _tag: "FactoryMcpFailure", code: "review_not_active" },
    },
    {
      name: "a client signed in outside any thread",
      caller: undefined,
      after: [],
      refusal: { _tag: "OrchestratorMcpFailure", code: "thread_credential_required" },
    },
  ] satisfies ReadonlyArray<{
    readonly name: string;
    readonly caller: ThreadId | undefined;
    readonly after: ReadonlyArray<FactoryEvent>;
    readonly refusal: { readonly _tag: string; readonly code: string };
  }>)("refuses $name and changes no delivery state", ({ caller, after, refusal }) =>
    Effect.gen(function* () {
      yield* seedReview(...after);
      const before = yield* rawRow;
      // A write now would move updated_at.
      yield* TestClock.adjust("1 minute");

      const result = yield* submit(caller, passingReview);

      assert.isTrue(result.isFailure);
      assert.deepInclude(result.result as object, refusal);
      assert.deepStrictEqual(yield* rawRow, before);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
