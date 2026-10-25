import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  FACTORY_WS_METHODS,
  FactoryError,
  FactoryProjectSettings,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

// Loaded before the MCP modules, as the core toolkit tests do, so their import cycle resolves.
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ServerRuntimeStartup from "../../../serverRuntimeStartup.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import { WorkService } from "../../work-management/index.ts";
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
import { wsHandlers } from "../rpc/handlers.ts";
import * as FactoryVerifyRunner from "../verify/FactoryVerifyRunner.ts";
import { toolLayer } from "./handlers.ts";
import { FactoryToolkit } from "./tools.ts";

const projectId = ProjectId.make("project-alpha");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const itemRef = { sourceId, itemId: WorkItemId.make("12") };
const caller = ThreadId.make("thread-caller");

const MESSAGE =
  "Factory plans a parent item only from a Markdown Work source, which can hold its child items. Deliver it as a single item instead.";

/**
 * An item of a GitHub Issues source in a project this environment does not have. A parent start
 * stops at the source check, so the services past it are stubs; a single start passes the check
 * and stops at the project.
 */
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
      Layer.mock(FactoryPlanning.FactoryPlanning)({}),
      Layer.mock(FactoryReview.FactoryReview)({}),
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
          stored: { sourceId, projectId, kind: "github" },
        } as unknown as WorkService.ResolvedSource),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      // The access gate reads the calling thread's shell: live, in its project.
      getThreadShell: (threadId) =>
        Effect.succeed(threadId === caller ? { ...liveThreadShell(caller), projectId } : null),
    }),
  ),
  Layer.provideMerge(FactorySettings.layer),
  Layer.provideMerge(Factory.layerPersistence),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);
const encodeError = Schema.encodeSync(FactoryError);
/** A project ready to deliver from, so only the source can refuse a parent. */
const configure = Effect.flatMap(FactorySettings.FactorySettings, (settings) =>
  settings.set(
    projectId,
    decodeSettings({ verifyCommand: { executable: "vp", args: ["test", "run"] } }),
  ),
);

const deliveryRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM fd_factory_deliveries
  `;
  return row?.count;
});

/** `factory_deliver` as a live thread of the project calls it. */
const deliver = (params: { readonly item: string; readonly kind?: "single" | "parent" }) =>
  Effect.gen(function* () {
    const toolkit = yield* FactoryToolkit;
    return yield* toolkit.handle("factory_deliver", params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((results) => results.at(-1)!),
    );
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "session",
      thread: {
        threadId: caller,
        providerSessionId: "session",
        providerInstanceId: liveThreadShell(caller).providerInstanceId,
      },
      client: undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Effect.provide(McpToolAccess.HandlersLayer.layer(toolLayer)),
  );

describe("a parent start of an item outside Markdown", () => {
  it.effect("is refused by the service before anything is written", () =>
    Effect.gen(function* () {
      yield* configure;
      const factory = yield* FactoryService.FactoryService;

      const refused = yield* Effect.flip(factory.start({ itemRef, kind: "parent" }));

      assert.strictEqual(refused._tag, "FactoryParentSourceUnsupportedError");
      assert.deepInclude(refused, { sourceId, sourceKind: "github" });
      assert.strictEqual(yield* deliveryRows, 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails the RPC start with its own reason and fixed text", () =>
    Effect.gen(function* () {
      yield* configure;
      const handlers = wsHandlers({
        factory: yield* FactoryService.FactoryService,
        settings: yield* FactorySettings.FactorySettings,
        startup: ServerRuntimeStartup.ServerRuntimeStartup.of({
          awaitCommandReady: Effect.void,
          markHttpListening: Effect.void,
          enqueueCommand: (effect) => effect,
        }),
      });

      const error = yield* Effect.flip(
        handlers[FACTORY_WS_METHODS.factoryDeliveriesStart]({ itemRef, kind: "parent" }),
      );

      assert.deepStrictEqual(encodeError(error as FactoryError), {
        _tag: "FactoryError",
        reason: "unsupported_source",
        message: MESSAGE,
      });
      assert.strictEqual(yield* deliveryRows, 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails factory_deliver with its own code and fixed text", () =>
    Effect.gen(function* () {
      yield* configure;

      const result = yield* deliver({ item: `${sourceId}:${itemRef.itemId}`, kind: "parent" });

      assert.isTrue(result.isFailure);
      assert.deepStrictEqual(result.encodedResult, {
        _tag: "FactoryMcpFailure",
        code: "unsupported_source",
        message: MESSAGE,
      });
      assert.notInclude(MESSAGE, sourceId);
      assert.strictEqual(yield* deliveryRows, 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("leaves a start without a kind to the single item's checks", () =>
    Effect.gen(function* () {
      yield* configure;
      const factory = yield* FactoryService.FactoryService;

      // Past the source check, the next refusal is the project this environment lacks.
      const refused = yield* Effect.flip(factory.start({ itemRef }));
      assert.strictEqual(refused._tag, "FactoryProjectMissingError");
      const single = yield* Effect.flip(factory.start({ itemRef, kind: "single" }));
      assert.strictEqual(single._tag, "FactoryProjectMissingError");
      const result = yield* deliver({ item: `${sourceId}:${itemRef.itemId}` });
      assert.deepInclude(result.encodedResult as object, { code: "project_missing" });
      assert.strictEqual(yield* deliveryRows, 0);
    }).pipe(Effect.provide(layer)),
  );
});
