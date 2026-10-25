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
import { FactoryDeliveryId, FactoryPlan, FactoryTaskId } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
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
import * as ProviderInstanceRegistry from "../../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistryMock from "../../../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import { WorkService } from "../../work-management/index.ts";
import * as FactoryChildren from "../FactoryChildren.ts";
import * as FactoryPlanning from "../FactoryPlanning.ts";
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
import * as FactoryTaskStore from "../persistence/FactoryTaskStore.ts";
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
const deliveryId = FactoryDeliveryId.make("delivery-parent");
const itemRef = {
  sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
  itemId: WorkItemId.make("fd-aaaaaa"),
};
const planner = ThreadId.make("thread-planner");
const planRun = RunId.make("run-plan");
/** A later turn of the planner thread, queued behind the planner's run. */
const nextRun = RunId.make("run-plan-next");
const reviewer = ThreadId.make("thread-reviewer");
const unrelated = ThreadId.make("thread-unrelated");

/** The run the planner thread is live in; each test's seed sets it. */
const live: { planner: RunId } = { planner: planRun };

/**
 * The calling threads as the server reads them, each live in a turn; planners and reviewers work
 * in plan mode. The MCP access gate and Factory read the same shells, as both read the projection.
 */
const shellOf = (threadId: ThreadId): OrchestrationV2ThreadShell | null => {
  switch (threadId) {
    case planner:
      return liveThreadShell(planner, { interactionMode: "plan", activeRunId: live.planner });
    case reviewer:
      return liveThreadShell(reviewer, { interactionMode: "plan" });
    case unrelated:
      return liveThreadShell(unrelated);
    default:
      return null;
  }
};

/**
 * FactoryService, the worker, plan judging and the thread effects as the server builds them, on
 * in-memory SQLite with the evidence folder under a temp T3 home. A submission issues no effect,
 * so the services that perform effects are stubs, and of the projection only shells are read.
 */
const layer = FactoryService.layer.pipe(
  Layer.provideMerge(FactoryWorker.layer),
  // Transition comments are posted in FactoryWorkComments.test.ts; none is posted here.
  Layer.provide(Layer.mock(FactoryWorkComments.FactoryWorkComments)({ post: () => Effect.void })),
  Layer.provide(FactoryPlanning.layer),
  Layer.provide(FactoryThreadEffects.layer),
  Layer.provide(FactoryEvidence.layer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(FactoryVerifyRunner.FactoryVerifyRunner)({}),
      Layer.mock(FactoryReview.FactoryReview)({}),
      Layer.mock(FactoryRecord.FactoryRecord)({}),
      Layer.mock(FactoryChildren.FactoryChildren)({}),
      Layer.mock(FactoryPullRequest.FactoryPullRequest)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: (threadId) => Effect.sync(() => shellOf(threadId)),
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({}),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(WorkService.WorkService)({}),
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
      ProviderRegistryMock.layer(),
      ServerSettings.layerTest(),
    ),
  ),
  Layer.provideMerge(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.sync(() => shellOf(threadId)),
    }),
  ),
  Layer.provideMerge(FactorySettings.layer),
  Layer.provideMerge(Factory.layerPersistence),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-plan-mcp-" })),
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

/** `factory_submit_plan` as `threadId` calls it, decoded from its parameters like over MCP. */
const submit = (threadId: ThreadId | undefined, plan: unknown) =>
  Effect.gen(function* () {
    const toolkit = yield* FactoryToolkit;
    return yield* toolkit.handle("factory_submit_plan", { plan }).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((results) => results.at(-1)!),
    );
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scopeOf(threadId)),
    Effect.provide(McpToolAccess.HandlersLayer.layer(toolLayer)),
  );

const stored = Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
  deliveries.get(deliveryId),
).pipe(Effect.map((delivery) => Option.getOrThrow(delivery).state));
const rawRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT * FROM fd_factory_deliveries WHERE delivery_id = ${deliveryId}`;
});

/** The delivery's `plan.json` under T3 home. */
const planFile = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.stateDir, "fd-factory", deliveryId, "plan.json");
});
const planFileExists = Effect.flatMap(planFile, (file) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.exists(file)),
);

/** A two-task plan, its second task depending on the first. */
const twoTaskPlan = {
  tasks: [
    {
      id: "export-csv",
      title: "Export the current table as CSV",
      kind: "feature",
      summary: "Add a CSV export of the visible rows.",
      acceptance: ["The export downloads the visible rows as CSV."],
      testPlan: [
        { criterion: 1, check: "Export two rows and read back the CSV.", paths: ["src/a.test.ts"] },
      ],
      likelyPaths: ["src/export.ts"],
      risk: "normal",
    },
    {
      id: "export-json",
      title: "Export the current table as JSON",
      kind: "feature",
      summary: "Add a JSON export beside the CSV one.",
      acceptance: ["The export downloads the visible rows as JSON.", "Empty tables export []."],
      testPlan: [
        { criterion: 1, check: "Export two rows as JSON.", paths: ["src/b.test.ts"] },
        { criterion: 2, check: "Export an empty table.", paths: ["src/b.test.ts"] },
      ],
      likelyPaths: ["src/export.ts"],
      risk: "high",
    },
  ],
};
const decodePlan = Schema.decodeUnknownSync(FactoryPlan);

/** Two tasks under one id, and a criterion without a test plan entry. */
const invalidPlan = {
  tasks: [
    { ...twoTaskPlan.tasks[0], id: "export" },
    { ...twoTaskPlan.tasks[1], id: "export", testPlan: [twoTaskPlan.tasks[1]!.testPlan[0]] },
  ],
};

/**
 * Stores the parent as its planner launch left it: the plan stage awaiting the planner's run,
 * the run the planner thread is live in. `after` events follow, as later steps would have left it.
 */
const seedPlanning = (...after: ReadonlyArray<FactoryEvent>) =>
  Effect.gen(function* () {
    live.planner = planRun;
    const events: ReadonlyArray<FactoryEvent> = [
      { type: "start" },
      {
        type: "thread.launched",
        effectId: 1,
        threadId: planner,
        runId: planRun,
        worktreePath: "/worktrees/fd-aaaaaa",
        baseline: "b".repeat(40),
      },
      ...after,
    ];
    const state = events.reduce<FactoryDeliveryState>(
      (current, event) => advance(current, event).delivery,
      queuedDeliveryState({ kind: "parent", branch: "work/fd-aaaaaa", baseRef: "HEAD" }),
    );
    yield* Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
      deliveries.insert({ deliveryId, projectId, itemRef, state }),
    );
  });

describe("factory_submit_plan declaration", () => {
  it("publishes factory_submit_plan with a reference-free object-root input", () => {
    const schema = Tool.getJsonSchema(FactoryToolkit.tools.factory_submit_plan);
    assert.strictEqual((schema as { type?: string }).type, "object");
    assert.deepStrictEqual((schema as { required?: ReadonlyArray<string> }).required, ["plan"]);
    assert.notInclude(JSON.stringify(schema), '"$ref"');
  });
});

describe("factory_submit_plan from the planner", () => {
  it.effect("records the plan-mode planner's plan and writes plan.json under T3 home", () =>
    Effect.gen(function* () {
      yield* seedPlanning();

      const result = yield* submit(planner, twoTaskPlan);

      assert.isFalse(result.isFailure, JSON.stringify(result.result));
      assert.deepStrictEqual(result.result, {
        deliveryId,
        round: 1,
        taskIds: ["export-csv", "export-json"],
      });
      const state = yield* stored;
      const file = yield* planFile;
      assert.strictEqual(state.plan?.source, "mcp");
      assert.strictEqual(state.plan?.round, 1);
      assert.strictEqual(state.plan?.evidencePath, file);
      assert.deepStrictEqual(
        state.plan?.tasks.map(({ id, risk }) => [id, risk]),
        [
          ["export-csv", "normal"],
          ["export-json", "high"],
        ],
      );
      // Recorded, not acted on: the planner's run goes on.
      assert.strictEqual(state.status, "running");
      assert.strictEqual(state.stage, "plan");
      assert.deepStrictEqual(state.awaiting, { type: "run", threadId: planner, runId: planRun });

      const evidence = JSON.parse(
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.readFileString(file),
        ),
      );
      assert.deepInclude(evidence, { deliveryId, round: 1, source: "mcp", threadId: planner });
      assert.deepStrictEqual(
        evidence.plan.tasks.map((task: { readonly id: string }) => task.id),
        ["export-csv", "export-json"],
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("parses a plan sent as a JSON string", () =>
    Effect.gen(function* () {
      yield* seedPlanning();

      const result = yield* submit(planner, JSON.stringify(twoTaskPlan));

      assert.isFalse(result.isFailure, JSON.stringify(result.result));
      assert.strictEqual((yield* stored).plan?.tasks.length, 2);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("takes an empty plan with the planner's note", () =>
    Effect.gen(function* () {
      yield* seedPlanning();

      const result = yield* submit(planner, { tasks: [], note: "The item is already done." });

      assert.isFalse(result.isFailure, JSON.stringify(result.result));
      assert.deepStrictEqual(result.result, { deliveryId, round: 1, taskIds: [] });
      const state = yield* stored;
      assert.deepStrictEqual(state.plan?.tasks, []);
      assert.strictEqual(state.plan?.note, "The item is already done.");
      assert.isTrue(yield* planFileExists);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("answers an invalid plan with its problems, then blocks on a second", () =>
    Effect.gen(function* () {
      yield* seedPlanning();

      const first = yield* submit(planner, invalidPlan);

      assert.isTrue(first.isFailure);
      assert.deepInclude(first.result as object, {
        _tag: "FactoryMcpFailure",
        code: "invalid_plan",
      });
      const message = (first.result as { message: string }).message;
      assert.include(message, 'Task id "export" is used 2 times; give each task its own id.');
      assert.include(message, "acceptance criterion 2 has no test plan entry");
      const counted = yield* stored;
      assert.strictEqual(counted.status, "running");
      assert.strictEqual(counted.invalidSubmissions, 1);
      assert.isNull(counted.plan);
      assert.isFalse(yield* planFileExists);

      const second = yield* submit(planner, { tasks: "none" });

      assert.isTrue(second.isFailure);
      assert.deepInclude(second.result as object, {
        _tag: "FactoryMcpFailure",
        code: "delivery_blocked",
      });
      assert.match((second.result as { message: string }).message, /blocked the delivery/);
      const state = yield* stored;
      assert.strictEqual(state.status, "blocked");
      assert.strictEqual(state.block?.reason, "invalid_submission");
      assert.isNull(state.plan);
      assert.isFalse(yield* planFileExists);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("answers a task id the delivery already uses as a problem to correct", () =>
    Effect.gen(function* () {
      yield* seedPlanning();
      yield* Effect.flatMap(FactoryTaskStore.FactoryTaskStore, (tasks) =>
        tasks.insert({ deliveryId, taskId: FactoryTaskId.make("export-csv") }),
      );

      const result = yield* submit(planner, twoTaskPlan);

      assert.isTrue(result.isFailure);
      assert.deepInclude(result.result as object, {
        _tag: "FactoryMcpFailure",
        code: "invalid_plan",
      });
      assert.include(
        (result.result as { message: string }).message,
        'Task id "export-csv" is already used in this delivery; choose an id it has not used.',
      );
      assert.isNull((yield* stored).plan);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});

describe("factory_submit_plan from a later turn of the planner thread", () => {
  // The owner queued a turn behind the planner's run: it ran once that run completed, while the
  // run's end still waited to reach the delivery, which therefore still awaits the run before it.
  it.effect("refuses it, recording nothing, so its plan never stands as the awaited run's", () =>
    Effect.gen(function* () {
      yield* seedPlanning();
      live.planner = nextRun;
      const before = yield* rawRow;
      // A write now would move updated_at.
      yield* TestClock.adjust("1 minute");

      const valid = yield* submit(planner, twoTaskPlan);
      const invalid = yield* submit(planner, invalidPlan);

      for (const result of [valid, invalid]) {
        assert.isTrue(result.isFailure);
        assert.deepInclude(result.result as object, {
          _tag: "FactoryMcpFailure",
          code: "plan_not_active",
        });
      }
      // Neither the plan nor the invalid submission counts for the awaited run's round.
      assert.deepStrictEqual(yield* rawRow, before);
      const state = yield* stored;
      assert.isNull(state.plan);
      assert.strictEqual(state.invalidSubmissions, 0);
      assert.deepStrictEqual(state.awaiting, { type: "run", threadId: planner, runId: planRun });
      assert.isFalse(yield* planFileExists);

      // The awaited run itself is still heard.
      live.planner = planRun;
      const accepted = yield* submit(planner, twoTaskPlan);
      assert.isFalse(accepted.isFailure, JSON.stringify(accepted.result));
      assert.strictEqual((yield* stored).plan?.source, "mcp");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});

describe("factory_submit_plan refusals", () => {
  const accepted: FactoryEvent = {
    type: "plan.submitted",
    round: 1,
    threadId: planner,
    runId: planRun,
    judgment: {
      type: "accepted",
      plan: { ...decodePlan(twoTaskPlan), source: "mcp", evidencePath: "/elsewhere/plan.json" },
    },
  };
  it.effect.each([
    {
      name: "an unrelated thread",
      caller: unrelated,
      after: [],
      refusal: { _tag: "FactoryMcpFailure", code: "not_planner" },
    },
    {
      name: "a plan-mode thread that is not the planner",
      caller: reviewer,
      after: [],
      refusal: { _tag: "FactoryMcpFailure", code: "not_planner" },
    },
    {
      name: "the planner once its run completed and its fenced plan is being read",
      caller: planner,
      after: [{ type: "run.finished", threadId: planner, runId: planRun, status: "completed" }],
      refusal: { _tag: "FactoryMcpFailure", code: "plan_not_active" },
    },
    {
      name: "the planner after its delivery blocked",
      caller: planner,
      after: [{ type: "run.finished", threadId: planner, runId: planRun, status: "failed" }],
      refusal: { _tag: "FactoryMcpFailure", code: "plan_not_active" },
    },
    {
      name: "the planner once the round's plan is accepted",
      caller: planner,
      after: [accepted],
      refusal: { _tag: "FactoryMcpFailure", code: "already_accepted" },
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
      yield* seedPlanning(...after);
      const before = yield* rawRow;
      // A write now would move updated_at.
      yield* TestClock.adjust("1 minute");

      const result = yield* submit(caller, twoTaskPlan);

      assert.isTrue(result.isFailure);
      assert.deepInclude(result.result as object, refusal);
      assert.deepStrictEqual(yield* rawRow, before);
      assert.isFalse(yield* planFileExists);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
