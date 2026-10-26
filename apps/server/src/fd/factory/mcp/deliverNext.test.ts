import { assert, describe, expect, it } from "@effect/vitest";
import {
  AuthWorkReadScope,
  AuthWorkWriteScope,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";

// Loaded before the MCP modules, as the core toolkit tests do, so their import cycle resolves.
import "../../../orchestration-v2/ThreadLaunchService.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { type WorkActor, WorkService } from "../../work-management/index.ts";
import * as FactoryService from "../FactoryService.ts";
import {
  drainFactory,
  drainOrchestration,
  stateOf,
  verifyCommands,
  type World,
  withProject,
} from "../testkit/deliveryHarness.ts";
import { toolLayer } from "./handlers.ts";
import { FactoryToolkit } from "./tools.ts";

/** A thread calling the tool, as the access gate reads its shell, or a client from outside T3. */
type Caller =
  | { readonly thread: OrchestrationV2ThreadShell }
  | { readonly client: "read-only" | "full-access" };

const callerThread = ThreadId.make("thread-caller");

const owner: WorkActor = {
  id: "session:owner",
  grants: [AuthWorkReadScope, AuthWorkWriteScope],
  label: "owner",
};

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
  readonly item?: string;
  readonly next?: boolean;
  readonly label?: string;
  readonly sourceId?: string;
  readonly projectId?: string;
  readonly kind?: "single" | "parent";
}

/** `factory_deliver` as `caller` calls it, decoded from its parameters like over MCP. */
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

/** The failure as the agent receives it: exactly its tag, code and message. */
const assertFailure = (
  result: { readonly isFailure: boolean; readonly encodedResult: unknown },
  failure: { readonly _tag: string; readonly code: string; readonly message?: string },
) => {
  assert.isTrue(result.isFailure, JSON.stringify(result.encodedResult));
  const encoded = result.encodedResult as Record<string, unknown>;
  expect(Object.keys(encoded).toSorted()).toStrictEqual(["_tag", "code", "message"]);
  assert.deepInclude(encoded, failure);
};

const deliveriesOf = (world: World) =>
  Effect.flatMap(FactoryService.FactoryService, (service) =>
    service.list({ projectId: world.projectId }),
  );

/** Nothing was written and no agent started. */
const assertNothingStarted = (world: World) =>
  Effect.gen(function* () {
    yield* drainFactory;
    yield* drainOrchestration;
    assert.deepStrictEqual(yield* deliveriesOf(world), []);
    assert.deepStrictEqual(world.provider.started, []);
  });

describe("factory_deliver declaration", () => {
  it("takes an item or next, with an optional label for next", () => {
    const schema = Tool.getJsonSchema(FactoryToolkit.tools.factory_deliver) as {
      readonly required?: ReadonlyArray<string>;
      readonly properties?: Record<string, unknown>;
    };
    assert.deepStrictEqual(schema.required ?? [], []);
    for (const name of ["item", "next", "label", "projectId"]) {
      assert.property(schema.properties, name);
    }
  });
});

describe("factory_deliver next", () => {
  it.live("starts the project's next Ready item under the caller's runtime mode", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const result = yield* deliver(
          threadIn(world.projectId, { runtimeMode: "auto-accept-edits" }),
          { next: true, projectId: world.projectId },
        );
        assert.isFalse(result.isFailure, JSON.stringify(result.result));
        const { delivery } = result.result as {
          readonly delivery: {
            readonly deliveryId: FactoryDeliveryId;
            readonly status: string;
            readonly itemRef: unknown;
          };
        };
        assert.strictEqual(delivery.status, "running");
        assert.deepStrictEqual(delivery.itemRef, world.itemRef);
        const author = yield* world.launched(delivery.deliveryId);
        const state = yield* stateOf(delivery.deliveryId);
        assert.strictEqual(state.kind, "single");
        assert.strictEqual(state.runtimeModeCeiling, "auto-accept-edits");
        const turn = world.provider.started.find(({ runId }) => runId === author.runId);
        assert.strictEqual(turn?.runtimePolicy.runtimeMode, "auto-accept-edits");

        // Its one item now has a delivery: the next call starts nothing, and says so.
        const again = yield* deliver(threadIn(world.projectId), {
          next: true,
          projectId: world.projectId,
        });
        assert.isFalse(again.isFailure, JSON.stringify(again.result));
        assert.deepStrictEqual(again.result, {
          nothingReady: true,
          incomplete: false,
          message: "No Work item of the project is Ready, so nothing was started.",
        });
        assert.lengthOf(yield* deliveriesOf(world), 1);
      }),
    ),
  );

  it.live("considers only items with the label", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const work = yield* WorkService.WorkService;
        yield* work.updateItem(owner, {
          ref: world.itemRef,
          labels: { add: ["autopilot"], remove: [] },
        });

        const other = yield* deliver(threadIn(world.projectId), {
          next: true,
          projectId: world.projectId,
          label: "later",
        });
        assert.isFalse(other.isFailure, JSON.stringify(other.result));
        assert.deepInclude(other.result, { nothingReady: true, incomplete: false });
        yield* assertNothingStarted(world);

        // The label is trimmed like Work's own labels.
        const labelled = yield* deliver(threadIn(world.projectId), {
          next: true,
          projectId: world.projectId,
          label: " autopilot ",
        });
        assert.isFalse(labelled.isFailure, JSON.stringify(labelled.result));
        const { delivery } = labelled.result as {
          readonly delivery: { readonly deliveryId: FactoryDeliveryId; readonly itemRef: unknown };
        };
        assert.deepStrictEqual(delivery.itemRef, world.itemRef);
        yield* world.launched(delivery.deliveryId);
      }),
    ),
  );
});

interface InvalidCall {
  readonly name: string;
  readonly params: (world: World) => DeliverParams;
  readonly message: string;
}

const exactlyOne = "Pass exactly one of item and next: true.";

describe("factory_deliver requests that name no single target", () => {
  it.live.each<InvalidCall>([
    {
      name: "both an item and next",
      params: (world) => ({ item: world.itemKey, next: true, projectId: world.projectId }),
      message: exactlyOne,
    },
    {
      name: "neither an item nor next",
      params: (world) => ({ projectId: world.projectId }),
      message: exactlyOne,
    },
    {
      name: "next false and no item",
      params: (world) => ({ next: false, projectId: world.projectId }),
      message: exactlyOne,
    },
    {
      name: "next without projectId",
      params: () => ({ next: true }),
      message: "next needs projectId, the project to deliver from.",
    },
    {
      name: "next with a source",
      params: (world) => ({
        next: true,
        projectId: world.projectId,
        sourceId: world.itemRef.sourceId,
      }),
      message:
        "next delivers a single item from any of the project's sources; pass only projectId and label.",
    },
    {
      name: "next as a parent",
      params: (world) => ({ next: true, projectId: world.projectId, kind: "parent" }),
      message:
        "next delivers a single item from any of the project's sources; pass only projectId and label.",
    },
    {
      name: "a label with an item",
      params: (world) => ({ item: world.itemKey, label: "auto" }),
      message: "label applies only with next.",
    },
  ])("refuses $name as invalid_request before anything is written", ({ params, message }) =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const result = yield* deliver(threadIn(world.projectId), params(world));
        assertFailure(result, { _tag: "FactoryMcpFailure", code: "invalid_request", message });
        yield* assertNothingStarted(world);
      }),
    ),
  );
});

interface Refusal {
  readonly name: string;
  readonly caller: (world: World) => Caller;
  readonly projectId?: string;
  readonly failure: { readonly _tag: string; readonly code: string; readonly message?: string };
}

describe("factory_deliver next refusals", () => {
  it.live.each<Refusal>([
    {
      name: "a plan-mode thread",
      caller: (world) => threadIn(world.projectId, { interactionMode: "plan" }),
      failure: { _tag: "FactoryMcpFailure", code: "forbidden" },
    },
    {
      name: "a read-only client",
      caller: () => ({ client: "read-only" }),
      failure: { _tag: "OrchestratorMcpFailure", code: "capability_denied" },
    },
    {
      name: "a project not on this environment",
      caller: (world) => threadIn(world.projectId),
      projectId: "project-gone",
      failure: {
        _tag: "FactoryMcpFailure",
        code: "project_missing",
        message: "The project is not on this environment.",
      },
    },
  ])("refuses $name before anything is written", ({ caller, projectId, failure }) =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const result = yield* deliver(caller(world), {
          next: true,
          projectId: projectId ?? world.projectId,
        });
        assertFailure(result, failure);
        yield* assertNothingStarted(world);
      }),
    ),
  );
});
