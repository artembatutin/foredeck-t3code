import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { type FactoryDeliveryId, FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";

// Loaded before the MCP modules, as the core toolkit tests do, so their import cycle resolves.
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import { workBranchName, WorkService } from "../../work-management/index.ts";
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
import {
  drainFactory,
  drainOrchestration,
  git,
  stateOf,
  threadProjection,
  verifyCommands,
  type World,
  withProject,
} from "../testkit/deliveryHarness.ts";
import * as FactoryVerifyRunner from "../verify/FactoryVerifyRunner.ts";
import { toolLayer } from "./handlers.ts";
import { FactoryToolkit } from "./tools.ts";

/** A thread calling the tool, as the access gate reads its shell, or a client from outside T3. */
type Caller =
  | { readonly thread: OrchestrationV2ThreadShell }
  | { readonly client: "read-only" | "full-access" };

const callerThread = ThreadId.make("thread-caller");

/** A thread of the project in the middle of a turn, in `modes`. */
const threadIn = (
  projectId: ProjectId,
  modes: Parameters<typeof liveThreadShell>[1] = {},
): Caller => ({ thread: { ...liveThreadShell(callerThread, modes), projectId } });

const scopeOf = (caller: Caller): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "session",
  thread:
    "thread" in caller
      ? {
          threadId: caller.thread.id,
          providerSessionId: "session",
          providerInstanceId: caller.thread.providerInstanceId,
        }
      : undefined,
  client:
    "client" in caller
      ? { sessionId: "client-session", label: "Outside client", access: caller.client }
      : undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration" as const]),
});

interface DeliverParams {
  readonly item: string;
  readonly sourceId?: string;
  readonly projectId?: string;
  readonly kind?: "single" | "parent";
}

/**
 * `factory_deliver` as `caller` calls it, decoded from its parameters like over MCP. The access
 * gate reads a thread caller's shell from thread management, so the caller's shell is answered
 * there; every other thread is the server's.
 */
const deliver = (caller: Caller, params: DeliverParams) =>
  Effect.gen(function* () {
    const toolkit = yield* FactoryToolkit;
    return yield* toolkit.handle("factory_deliver", params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((results) => results.at(-1)!),
    );
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scopeOf(caller)),
    Effect.provide(McpToolAccess.HandlersLayer.layer(toolLayer)),
    (call) =>
      Effect.flatMap(ThreadManagement.ThreadManagementService, (threads) =>
        Effect.provideService(call, ThreadManagement.ThreadManagementService, {
          ...threads,
          getThreadShell: (threadId) =>
            "thread" in caller && threadId === caller.thread.id
              ? Effect.succeed(caller.thread)
              : threads.getThreadShell(threadId),
        }),
      ),
  );

/** The started delivery's snapshot, failing the test with the tool's failure otherwise. */
const deliveredId = (result: { readonly isFailure: boolean; readonly result: unknown }) => {
  assert.isFalse(result.isFailure, JSON.stringify(result.result));
  const { delivery } = result.result as {
    readonly delivery: { readonly deliveryId: FactoryDeliveryId; readonly status: string };
  };
  assert.strictEqual(delivery.status, "running");
  return delivery.deliveryId;
};

/** The failure as the agent receives it: exactly its tag, code and message. */
const assertFailure = (
  result: { readonly isFailure: boolean; readonly encodedResult: unknown },
  failure: { readonly _tag: string; readonly code: string; readonly message?: string },
) => {
  assert.isTrue(result.isFailure);
  const encoded = result.encodedResult as Record<string, unknown>;
  expect(Object.keys(encoded).toSorted()).toStrictEqual(["_tag", "code", "message"]);
  assert.deepInclude(encoded, failure);
  return encoded as { readonly message: string };
};

const deliveriesOf = (world: World) =>
  Effect.flatMap(FactoryService.FactoryService, (service) =>
    service.listByItem(world.itemRef),
  ).pipe(Effect.map(({ deliveries }) => deliveries));

/** The branch Work's thread starts name for the harness's item. */
const itemBranch = (world: World) =>
  workBranchName({ kind: "markdown", ref: world.itemRef, title: world.itemTitle });

describe("factory_deliver declaration", () => {
  it("changes the environment and takes an object with the item", () => {
    const tool = FactoryToolkit.tools.factory_deliver;
    assert.isFalse(Context.get(tool.annotations, Tool.Readonly));
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: string;
      readonly required?: ReadonlyArray<string>;
    };
    assert.strictEqual(schema.type, "object");
    assert.deepStrictEqual(schema.required, ["item"]);
  });
});

describe("factory_deliver from a live thread", () => {
  it.live("starts the item under the caller's runtime mode on a fresh worktree", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const caller = threadIn(world.projectId, { runtimeMode: "auto-accept-edits" });

        const deliveryId = deliveredId(yield* deliver(caller, { item: world.itemKey }));
        const author = yield* world.launched(deliveryId);

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.status, "running");
        assert.strictEqual(state.stage, "author");
        assert.strictEqual(state.runtimeModeCeiling, "auto-accept-edits");
        assert.strictEqual(state.branch, itemBranch(world));
        // The author runs in a new worktree of the delivery's branch, in the caller's mode.
        const { thread } = yield* threadProjection(author.threadId);
        assert.strictEqual(thread.branch, state.branch);
        assert.strictEqual(thread.worktreePath, author.worktreePath);
        assert.notStrictEqual(author.worktreePath, world.root);
        assert.strictEqual(
          yield* git(author.worktreePath, ["branch", "--show-current"]),
          state.branch,
        );
        const turn = world.provider.started.find((started) => started.runId === author.runId);
        assert.strictEqual(turn?.runtimePolicy.runtimeMode, "auto-accept-edits");
        assert.lengthOf(yield* deliveriesOf(world), 1);
      }),
    ),
  );
});

interface CallerRefusal {
  readonly name: string;
  readonly caller: (world: World) => Caller;
  readonly failure: { readonly _tag: string; readonly code: string };
}

describe("factory_deliver callers that may not start threads", () => {
  it.live.each<CallerRefusal>([
    {
      name: "a read-only client",
      caller: () => ({ client: "read-only" }),
      failure: { _tag: "OrchestratorMcpFailure", code: "capability_denied" },
    },
    {
      name: "a plan-mode thread",
      caller: (world) => threadIn(world.projectId, { interactionMode: "plan" }),
      failure: { _tag: "FactoryMcpFailure", code: "forbidden" },
    },
    {
      name: "a thread whose run is not live",
      caller: (world) => threadIn(world.projectId, { activeRunId: null }),
      failure: { _tag: "OrchestratorMcpFailure", code: "parent_not_active" },
    },
  ])("refuses $name before anything is written", ({ caller, failure }) =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const result = yield* deliver(caller(world), {
          item: world.itemKey,
          projectId: world.projectId,
        });

        assertFailure(result, failure);
        yield* drainFactory;
        yield* drainOrchestration;
        assert.deepStrictEqual(yield* deliveriesOf(world), []);
        assert.deepStrictEqual(world.provider.started, []);
      }),
    ),
  );
});

describe("factory_deliver kinds", () => {
  it.live("delivers a Markdown item as a parent by launching its planner first", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const caller = threadIn(world.projectId, { runtimeMode: "auto-accept-edits" });

        const deliveryId = deliveredId(
          yield* deliver(caller, { item: world.itemKey, kind: "parent" }),
        );
        const planner = yield* world.launched(deliveryId);

        const state = yield* stateOf(deliveryId);
        assert.strictEqual(state.kind, "parent");
        assert.strictEqual(state.stage, "plan");
        assert.strictEqual(state.threads.planner, planner.threadId);
        assert.isUndefined(state.threads.author);
        const turn = world.provider.started.find((started) => started.runId === planner.runId);
        assert.strictEqual(turn?.runtimePolicy.interactionMode, "plan");
        assert.strictEqual(turn?.runtimePolicy.runtimeMode, "auto-accept-edits");
      }),
    ),
  );

  it.live("delivers the item itself for kind single and when kind is omitted", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const factory = yield* FactoryService.FactoryService;
        const caller = threadIn(world.projectId);

        const single = deliveredId(yield* deliver(caller, { item: world.itemKey, kind: "single" }));
        yield* world.launched(single);
        yield* factory.cancel(single);
        yield* drainFactory;
        const omitted = deliveredId(yield* deliver(caller, { item: world.itemKey }));
        yield* world.launched(omitted);

        // Both are single-item deliveries; the second starts over on a branch of its own.
        const branch = itemBranch(world);
        const deliveries = yield* deliveriesOf(world);
        assert.deepStrictEqual(
          deliveries.map(({ deliveryId, parentId, state }) => ({
            deliveryId,
            parentId,
            status: state.status,
            branch: state.branch,
          })),
          [
            { deliveryId: omitted, parentId: null, status: "running", branch: `${branch}-2` },
            { deliveryId: single, parentId: null, status: "cancelled", branch },
          ],
        );
      }),
    ),
  );
});

/** What the tests below run with: the harness's server layers and the platform. */
type HarnessServices = Effect.Services<World["start"]>;

interface StartRefusal {
  readonly name: string;
  /** Brings about the refusal before the call. */
  readonly prepare: (world: World) => Effect.Effect<void, never, HarnessServices>;
  /** The service error underneath, whose text must not reach the agent. */
  readonly cause: string;
  readonly code: string;
  readonly message: string;
}

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);

/** Every name a new delivery of the item could take, held by a branch of the repository. */
const takeEveryBranchName = (world: World) =>
  Effect.gen(function* () {
    const head = yield* git(world.root, ["rev-parse", "HEAD"]);
    const names = Array.from({ length: 100 }, (_, index) =>
      index === 0 ? itemBranch(world) : `${itemBranch(world)}-${index + 1}`,
    );
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "test.refs",
      cwd: world.root,
      args: ["update-ref", "--stdin"],
      stdin: names.map((name) => `create refs/heads/${name} ${head}\n`).join(""),
      timeoutMs: 30_000,
    });
  }).pipe(Effect.orDie);

/**
 * A Work source whose project the environment no longer has: Work still resolves the item, and
 * nothing past the project check is reached, so the services behind it are stubs.
 */
const missingProject = (() => {
  const projectId = ProjectId.make("project-gone");
  const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
  const itemRef = { sourceId, itemId: WorkItemId.make("fd-aaaaaa") };
  const layer = FactoryService.layer.pipe(
    Layer.provideMerge(FactoryWorker.layer),
    // Transition comments are posted in FactoryWorkComments.test.ts; none is posted here.
    Layer.provide(Layer.mock(FactoryWorkComments.FactoryWorkComments)({ post: () => Effect.void })),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeedNone }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(FactoryThreadEffects.FactoryThreadEffects)({}),
        Layer.mock(FactoryVerifyRunner.FactoryVerifyRunner)({}),
        Layer.mock(FactoryReview.FactoryReview)({}),
        Layer.mock(FactoryPlanning.FactoryPlanning)({}),
        Layer.mock(FactoryRecord.FactoryRecord)({}),
        Layer.mock(FactoryPullRequest.FactoryPullRequest)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      ),
    ),
    Layer.provideMerge(
      Layer.mock(WorkService.WorkService)({
        canonicalRef: Effect.succeed,
        resolveSource: () =>
          Effect.succeed({
            stored: { sourceId, projectId },
          } as unknown as WorkService.ResolvedSource),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(null),
      }),
    ),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
  );
  return { projectId, itemRef, layer };
})();

describe("factory_deliver start refusals", () => {
  it.live.each<StartRefusal>([
    {
      name: "a project without a verify command",
      prepare: (world) =>
        Effect.flatMap(FactorySettings.FactorySettings, (settings) =>
          settings.set(world.projectId, decodeSettings({})),
        ).pipe(Effect.orDie),
      cause: "FactoryVerifyCommandMissingError",
      code: "not_configured",
      message: "Set a verify command in the project's Factory settings before starting a delivery.",
    },
    {
      name: "an item that already has an active delivery",
      prepare: (world) => Effect.asVoid(world.start),
      cause: "FactoryDeliveryActive",
      code: "delivery_active",
      message: "This Work item already has a Factory delivery that is not done or cancelled.",
    },
    {
      name: "an empty repository",
      prepare: (world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fileSystem.remove(path.join(world.root, ".git"), { recursive: true });
          yield* git(world.root, ["init", "-b", "main"]);
        }).pipe(Effect.orDie),
      cause: "ThreadLaunchBaseRefError",
      code: "no_base_commit",
      message: "The project's checkout has no commit to start the delivery's worktree from.",
    },
    {
      name: "an item whose every branch name is taken",
      prepare: takeEveryBranchName,
      cause: "FactoryBranchUnavailableError",
      code: "no_free_branch",
      message: "Factory found no free branch name for a new delivery of this item.",
    },
  ])("refuses $name with Factory's fixed text", ({ prepare, cause, code, message }) =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        yield* prepare(world);
        const before = yield* deliveriesOf(world);
        const turns = world.provider.started.length;

        const result = yield* deliver(threadIn(world.projectId), { item: world.itemKey });

        const failure = assertFailure(result, { _tag: "FactoryMcpFailure", code, message });
        // The service's own text names the project, checkout, branch or delivery; none of it, nor
        // the item's title from the tracker, reaches the agent.
        const factory = yield* FactoryService.FactoryService;
        const refused = yield* Effect.flip(factory.start({ itemRef: world.itemRef }));
        assert.strictEqual(refused._tag, cause);
        assert.notInclude(failure.message, refused.message);
        for (const hidden of [world.projectId, world.root, world.itemTitle, itemBranch(world)])
          assert.notInclude(failure.message, hidden);
        yield* drainFactory;
        yield* drainOrchestration;
        assert.deepStrictEqual(yield* deliveriesOf(world), before);
        assert.lengthOf(world.provider.started, turns);
      }),
    ),
  );

  // Over the real stack Work refuses an item whose project is gone before Factory looks, so
  // Factory's own check is reached only when the project goes in between; Work is faked here.
  it.effect("refuses an item whose project is not on this environment", () =>
    Effect.gen(function* () {
      const settings = yield* FactorySettings.FactorySettings;
      yield* settings.set(
        missingProject.projectId,
        decodeSettings({ verifyCommand: verifyCommands.passes }),
      );

      const result = yield* deliver(threadIn(missingProject.projectId), {
        item: `${missingProject.itemRef.sourceId}:${missingProject.itemRef.itemId}`,
      });

      const failure = assertFailure(result, {
        _tag: "FactoryMcpFailure",
        code: "project_missing",
        message: "The item's project is not on this environment.",
      });
      const factory = yield* FactoryService.FactoryService;
      const refused = yield* Effect.flip(factory.start({ itemRef: missingProject.itemRef }));
      assert.strictEqual(refused._tag, "FactoryProjectMissingError");
      assert.notInclude(failure.message, refused.message);
      assert.notInclude(failure.message, missingProject.projectId);
      const sql = yield* SqlClient.SqlClient;
      const [rows] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM fd_factory_deliveries
      `;
      assert.strictEqual(rows?.count, 0);
    }).pipe(Effect.provide(missingProject.layer)),
  );
});
