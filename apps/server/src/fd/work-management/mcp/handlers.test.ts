import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  type ProviderInteractionMode,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";

// Loaded before the MCP modules, as the core toolkit tests do, so their import cycle resolves.
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { fakeAdapter, makeHarness, markdownConfig, owner, projectRow } from "../testkit/fakes.ts";
import * as WorkService from "../WorkService.ts";
import * as WorkThreads from "../WorkThreads.ts";
import { toolLayer } from "./handlers.ts";
import { WorkToolkit } from "./tools.ts";

const projectId = ProjectId.make("project:mcp-test");
const refOf = (item: { readonly ref: { readonly sourceId: string; readonly itemId: string } }) =>
  `${item.ref.sourceId}:${item.ref.itemId}`;
const callerId = ThreadId.make("caller-thread");

const setup = (modes: {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}) =>
  Effect.gen(function* () {
    const markdown = fakeAdapter("markdown");
    const harness = makeHarness([markdown.adapter]);
    harness.projects.set(projectId, projectRow(projectId, "/projects/mcp"));
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const caller = liveThreadShell(callerId, modes);
    const dependencies = Layer.mergeAll(
      WorkThreads.layer.pipe(
        Layer.provide(
          Layer.mock(ThreadLaunch.ThreadLaunchService)({
            checkWorktreeBase: () => Effect.void,
            launch: (input) => {
              launched.push(input);
              return Effect.succeed({
                threadId: input.threadId!,
                resumed: false,
              } as ThreadLaunch.ThreadLaunchResult);
            },
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(NodeServices.layer),
        Layer.provideMerge(harness.layer),
      ),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: callerId,
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.succeed(threadId === callerId ? caller : null),
      }),
    );
    // One build, so the tools and the setup share the same in-memory database.
    const context = yield* Layer.build(dependencies);
    const toolkit = yield* WorkToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(toolLayer).pipe(
          Layer.provide(Layer.succeedContext(context)),
        ),
      ),
    );
    const call = <Name extends keyof typeof WorkToolkit.tools>(
      name: Name,
      params: Parameters<typeof toolkit.handle<Name>>[1],
    ) =>
      toolkit.handle(name, params).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((chunk) => chunk.at(-1)!),
        Effect.provide(context),
      );
    const item = yield* Effect.gen(function* () {
      const work = yield* WorkService.WorkService;
      const source = yield* work.saveSource(owner, {
        projectId,
        label: "Tasks",
        config: markdownConfig("tasks"),
      });
      return yield* work.createItem(owner, { sourceId: source.sourceId, title: "Ship it" });
    }).pipe(Effect.provide(context));
    return { call, item, launched, markdown };
  });

describe("work MCP tools", () => {
  it("publishes reference-free object-root inputs under unique names", () => {
    const names = Object.values(WorkToolkit.tools).map((tool) => tool.name);
    assert.deepStrictEqual(new Set(names).size, names.length);
    assert.deepStrictEqual(names.sort(), [
      "work_comment",
      "work_create",
      "work_link_thread",
      "work_list",
      "work_read",
      "work_set_status",
      "work_start_thread",
      "work_update",
    ]);
    for (const tool of Object.values(WorkToolkit.tools)) {
      const schema = Tool.getJsonSchema(tool);
      assert.strictEqual((schema as { type?: string }).type, "object", tool.name);
      assert.notInclude(JSON.stringify(schema), '"$ref"', tool.name);
    }
  });

  it.effect("lets a plan-mode caller read but not write", () =>
    Effect.gen(function* () {
      const { call, item } = yield* setup({ runtimeMode: "full-access", interactionMode: "plan" });
      const read = yield* call("work_read", { item: refOf(item) });
      assert.isFalse(read.isFailure, JSON.stringify(read.result));
      assert.strictEqual((read.result as { title: string }).title, "Ship it");

      const update = yield* call("work_update", { item: refOf(item), priority: "high" });
      assert.isTrue(update.isFailure);
      assert.deepInclude(update.result as object, { _tag: "WorkMcpFailure", code: "forbidden" });
    }).pipe(Effect.scoped),
  );

  it.effect("starts a thread in the caller's own modes, never broader", () =>
    Effect.gen(function* () {
      const { call, item, launched } = yield* setup({ runtimeMode: "approval-required" });
      const started = yield* call("work_start_thread", { item: refOf(item), mode: "plan" });
      assert.isFalse(started.isFailure, JSON.stringify(started.result));
      assert.strictEqual(launched.length, 1);
      assert.strictEqual(launched[0]!.runtimeMode, "approval-required");
      assert.strictEqual(launched[0]!.interactionMode, "default");
      assert.strictEqual(launched[0]!.createdBy, "agent");
      assert.strictEqual(launched[0]!.creationSource, "mcp");
      // No project default model: the caller's model is used.
      assert.deepStrictEqual(launched[0]!.modelSelection, liveThreadShell(callerId).modelSelection);
    }).pipe(Effect.scoped),
  );

  it.effect("signs agent comments and disarms bot handles", () =>
    Effect.gen(function* () {
      const { call, item, markdown } = yield* setup({ runtimeMode: "full-access" });
      const result = yield* call("work_comment", {
        item: refOf(item),
        body: "Done; @copilot please review",
      });
      assert.isFalse(result.isFailure, JSON.stringify(result.result));
      const [comment] = markdown.comments;
      assert.include(comment!.body, "`@copilot`");
      assert.include(comment!.body, `— posted by codex via Foredeck (thread ${callerId})`);
      assert.strictEqual(comment!.actorId, `thread:${callerId}`);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a reference it cannot read", () =>
    Effect.gen(function* () {
      const { call } = yield* setup({ runtimeMode: "full-access" });
      const result = yield* call("work_read", { item: "not a reference" });
      assert.isTrue(result.isFailure);
      assert.deepInclude(result.result as object, { code: "invalid_request" });
    }).pipe(Effect.scoped),
  );
});
