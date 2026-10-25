import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  type FactoryReviewSummary,
  type FactoryVerifyReceipt,
} from "@t3tools/contracts/fd/factory";
import {
  type WorkItemRef,
  WorkItemId,
  type WorkSource,
  type WorkSourceConfig,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
import { type WorkDomainError, WorkService } from "../../work-management/index.ts";
import * as FactoryPullRequest from "../FactoryPullRequest.ts";
import * as FactoryRecord from "../FactoryRecord.ts";
import * as FactoryReview from "../FactoryReview.ts";
import * as FactoryService from "../FactoryService.ts";
import * as FactorySettings from "../FactorySettings.ts";
import * as FactoryThreadEffects from "../FactoryThreadEffects.ts";
import * as FactoryWorkComments from "../FactoryWorkComments.ts";
import * as FactoryWorker from "../FactoryWorker.ts";
import * as Factory from "../index.ts";
import { FactoryStoreError } from "../persistence/errors.ts";
import * as FactoryDeliveryStore from "../persistence/FactoryDeliveryStore.ts";
import { type FactoryDeliveryState, queuedDeliveryState } from "../pipeline/state.ts";
import { toFactoryDelivery } from "../snapshot.ts";
import * as FactoryEvidence from "../verify/FactoryEvidence.ts";
import * as FactoryVerifyRunner from "../verify/FactoryVerifyRunner.ts";
import { toolLayer } from "./handlers.ts";
import { FactoryToolkit } from "./tools.ts";

/** The project of `liveThreadShell`, so a thread caller resolves keys among these sources. */
const projectId = ProjectId.make("project:mcp-test");
const otherProject = ProjectId.make("project-other");

const source = (n: number, config: WorkSourceConfig, project = projectId): WorkSource => ({
  sourceId: WorkSourceId.make(`00000000-0000-4000-8000-00000000000${n}`),
  projectId: project,
  kind: config.kind,
  identity: String(n),
  label: `Source ${n}`,
  config,
  state: "active",
  version: 1,
  credential: { configured: false },
  capabilities: {
    create: true,
    statuses: [],
    fields: [],
    comments: "add",
    transitions: false,
    people: false,
  },
  health: { status: "ok" },
  updatedAt: "2026-10-21T09:00:00.000Z",
});
const markdown = source(1, { kind: "markdown", directory: ".foredeck/work", autoStart: true });
const github = source(2, { kind: "github", host: "github.com", owner: "Acme", name: "App" });
// Another project's Markdown source: a key resolves only among the caller's project's sources.
const elsewhere = source(
  3,
  { kind: "markdown", directory: ".foredeck/work", autoStart: true },
  otherProject,
);
const sources = [markdown, github, elsewhere];

const markdownItem: WorkItemRef = {
  sourceId: markdown.sourceId,
  itemId: WorkItemId.make("fd-aaaaaa"),
};
const githubItem: WorkItemRef = { sourceId: github.sourceId, itemId: WorkItemId.make("7") };

/** Work's source list and spelling, as the Markdown source spells its ids (lower case). */
const workFake = Layer.mock(WorkService.WorkService)({
  listSources: (_actor, input) =>
    Effect.succeed({ sources: sources.filter((entry) => entry.projectId === input.projectId) }),
  canonicalRef: (ref) =>
    Effect.succeed(
      sources.some((entry) => entry.sourceId === ref.sourceId && entry.kind === "markdown")
        ? { sourceId: ref.sourceId, itemId: WorkItemId.make(ref.itemId.toLowerCase()) }
        : ref,
    ),
});

const reader = ThreadId.make("thread-reader");
const planner = ThreadId.make("thread-planner");
const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([
  [reader, liveThreadShell(reader)],
  [planner, liveThreadShell(planner, { interactionMode: "plan" })],
]);

/**
 * FactoryService as the server builds it, on in-memory SQLite, with Work's sources faked. A
 * status read issues no effect, so the services that perform effects are stubs.
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
    ),
  ),
  Layer.provideMerge(workFake),
  Layer.provideMerge(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
    }),
  ),
  Layer.provideMerge(FactorySettings.layer),
  Layer.provideMerge(Factory.layerPersistence),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-status-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

type Caller =
  | { readonly thread: ThreadId }
  | { readonly client: "read-only" | "full-access"; readonly thread?: undefined };
const readOnlyClient: Caller = { client: "read-only" };

const scopeOf = (caller: Caller): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "session",
  thread:
    caller.thread === undefined
      ? undefined
      : {
          threadId: caller.thread,
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
  client:
    caller.thread === undefined
      ? { sessionId: "client-session", label: "Outside client", access: caller.client }
      : undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration" as const]),
});

/** `factory_status` as `caller` calls it, decoded from its parameters like over MCP. */
const status = (caller: Caller, params: Record<string, string>) =>
  Effect.gen(function* () {
    const toolkit = yield* FactoryToolkit;
    return yield* toolkit.handle("factory_status", params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((results) => results.at(-1)!),
    );
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scopeOf(caller)),
    Effect.provide(McpToolAccess.HandlersLayer.layer(toolLayer)),
  );

const headSha = "a".repeat(40);
const tree = "b".repeat(40);
const logPath = "/t3/userdata/fd-factory/delivery-reviewed/verify-1.log";
const evidencePath = "/t3/userdata/fd-factory/delivery-reviewed/review-1.json";
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
  settingsHash: "settings-hash-1",
  platform: "darwin-arm64",
  logPath,
  outputHash: "output-hash-1",
};
const summary: FactoryReviewSummary = {
  headSha,
  verdict: "changes-required",
  blocking: true,
  findings: { high: 1, medium: 0, low: 2 },
  reviewedAt: "2026-10-24T10:05:00.000Z",
};

/**
 * A delivery blocked after its last review round: one receipt, one accepted blocking review and
 * a thread of each agent role, so every snapshot field has something to show.
 */
const reviewedState: FactoryDeliveryState = {
  ...queuedDeliveryState({ branch: "feature/item-a", baseRef: "main" }),
  status: "blocked",
  stage: "review",
  worktreePath: "/work/worktrees/item-a",
  baseline: "c".repeat(40),
  threads: { author: ThreadId.make("thread-author"), reviewer: ThreadId.make("thread-reviewer") },
  receipts: [receipt],
  reviewRound: 1,
  reviews: [{ round: 1, source: "mcp", summary, evidencePath, fingerprint: "fingerprint-1" }],
  rounds: { fix: 1, review: 0 },
  fingerprints: ["fingerprint-1"],
  block: { reason: "review_changes_required", summary },
};

const insert = (
  deliveryId: string,
  itemRef: WorkItemRef,
  state: FactoryDeliveryState = queuedDeliveryState({ branch: "feature/item", baseRef: "main" }),
) =>
  Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
    deliveries.insert({
      deliveryId: FactoryDeliveryId.make(deliveryId),
      projectId,
      itemRef,
      state,
    }),
  );

/**
 * The Markdown item's two deliveries, the older cancelled and the newer running, then one of the
 * GitHub item. Ids sort opposite to creation, so only creation order puts them newest first.
 */
const seedItems = Effect.gen(function* () {
  yield* insert("delivery-z-older", markdownItem, {
    ...queuedDeliveryState({ branch: "feature/item-a", baseRef: "main" }),
    status: "cancelled",
    stage: "verify",
  });
  yield* TestClock.adjust("1 minute");
  yield* insert("delivery-a-newer", markdownItem, {
    ...queuedDeliveryState({ branch: "feature/item-a-2", baseRef: "main" }),
    status: "running",
    stage: "author",
  });
  yield* TestClock.adjust("1 minute");
  yield* insert("delivery-github", githubItem);
});

const allRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT * FROM fd_factory_deliveries ORDER BY delivery_id`;
});

const resultOf = (result: { readonly isFailure: boolean; readonly result: unknown }) => {
  assert.isFalse(result.isFailure, JSON.stringify(result.result));
  return result.result as {
    readonly delivery?: unknown;
    readonly item?: string;
    readonly deliveries?: ReadonlyArray<{ readonly deliveryId: string }>;
  };
};

describe("factory_status declaration", () => {
  it("is a read-only tool with an object-root input", () => {
    const tool = FactoryToolkit.tools.factory_status;
    assert.isTrue(Context.get(tool.annotations, Tool.Readonly));
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: string;
      readonly required?: ReadonlyArray<string>;
    };
    assert.strictEqual(schema.type, "object");
    assert.isUndefined(schema.required);
    assert.notInclude(JSON.stringify(schema), '"$ref"');
  });
});

describe("factory_status by delivery", () => {
  it.effect("returns the delivery's snapshot without its logs or evidence paths", () =>
    Effect.gen(function* () {
      const stored = yield* insert("delivery-reviewed", markdownItem, reviewedState);

      const result = resultOf(yield* status(readOnlyClient, { delivery: "delivery-reviewed" }));

      assert.deepStrictEqual(result, { delivery: toFactoryDelivery({ ...stored, stageRuns: [] }) });
      assert.deepInclude(result.delivery as object, {
        status: "blocked",
        stage: { name: "review", kind: "agent" },
        rounds: { fix: 1, review: 0 },
        branch: "feature/item-a",
        threads: { author: "thread-author", reviewer: "thread-reviewer" },
        // Numbered by their evidence, which itself stays out of the result.
        reviews: [{ ...summary, number: 1 }],
        needsYou:
          "The review requires changes with no review round left (1 high, 0 medium, 2 low).",
      });
      assert.deepStrictEqual((result.delivery as { receipts: unknown }).receipts, [
        {
          headSha,
          tree,
          startedAt: receipt.startedAt,
          finishedAt: receipt.finishedAt,
          code: 0,
          timedOut: false,
          durationMs: 65_000,
          number: 1,
        },
      ]);
      const text = JSON.stringify(result);
      for (const hidden of [logPath, evidencePath, "fd-factory", "settings-hash-1", "fingerprint"])
        assert.notInclude(text, hidden);
    }).pipe(Effect.provide(layer)),
  );
});

describe("factory_status by item", () => {
  it.effect.each([
    { name: "its canonical ref", item: `${markdownItem.sourceId}:fd-aaaaaa` },
    { name: "its ref in another spelling", item: `${markdownItem.sourceId}:FD-AAAAAA` },
    { name: "its key", item: "fd-aaaaaa" },
    { name: "its key in upper case", item: "FD-AAAAAA" },
  ])("resolves the Markdown item by $name, newest delivery first", ({ item }) =>
    Effect.gen(function* () {
      yield* seedItems;

      const result = resultOf(yield* status({ thread: reader }, { item }));

      assert.strictEqual(result.item, `${markdownItem.sourceId}:fd-aaaaaa`);
      assert.deepStrictEqual(
        result.deliveries?.map((delivery) => delivery.deliveryId),
        ["delivery-a-newer", "delivery-z-older"],
      );
      const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      const expected = yield* store.listByItem(markdownItem);
      assert.deepStrictEqual(
        result.deliveries,
        expected.toReversed().map((stored) => toFactoryDelivery({ ...stored, stageRuns: [] })),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("resolves an item by its URL", () =>
    Effect.gen(function* () {
      yield* seedItems;

      const result = resultOf(
        yield* status({ thread: reader }, { item: "https://github.com/acme/app/issues/7" }),
      );

      assert.strictEqual(result.item, `${github.sourceId}:7`);
      assert.deepStrictEqual(
        result.deliveries?.map((delivery) => delivery.deliveryId),
        ["delivery-github"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("resolves a key in the project a client names", () =>
    Effect.gen(function* () {
      yield* seedItems;

      const result = resultOf(
        yield* status(readOnlyClient, {
          item: "fd-aaaaaa",
          projectId,
          sourceId: markdown.sourceId,
        }),
      );

      assert.strictEqual(result.deliveries?.length, 2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("returns an empty list for an item without deliveries", () =>
    Effect.gen(function* () {
      yield* seedItems;

      const byRef = resultOf(
        yield* status({ thread: reader }, { item: `${markdown.sourceId}:fd-bbbbbb` }),
      );
      const byKey = resultOf(yield* status({ thread: reader }, { item: "fd-bbbbbb" }));

      assert.deepStrictEqual(byRef, { item: `${markdown.sourceId}:fd-bbbbbb`, deliveries: [] });
      assert.deepStrictEqual(byKey, byRef);
    }).pipe(Effect.provide(layer)),
  );
});

describe("factory_status callers", () => {
  it.effect.each([
    { name: "a read-only client", caller: readOnlyClient },
    { name: "a plan-mode thread", caller: { thread: planner } },
    { name: "a full-access client", caller: { client: "full-access" } },
  ] satisfies ReadonlyArray<{ readonly name: string; readonly caller: Caller }>)(
    "lets $name read a delivery and an item",
    ({ caller }) =>
      Effect.gen(function* () {
        yield* seedItems;

        const one = resultOf(yield* status(caller, { delivery: "delivery-github" }));
        const many = resultOf(
          yield* status(caller, { item: `${markdownItem.sourceId}:fd-aaaaaa` }),
        );

        assert.strictEqual(
          (one.delivery as { deliveryId: string } | undefined)?.deliveryId,
          "delivery-github",
        );
        assert.strictEqual(many.deliveries?.length, 2);
      }).pipe(Effect.provide(layer)),
  );
});

interface FailureCase {
  readonly name: string;
  readonly caller: Caller;
  readonly params: Record<string, string>;
  readonly failure: { readonly _tag: string; readonly code: string; readonly message: string };
}

describe("factory_status failures", () => {
  it.effect.each<FailureCase>([
    {
      name: "an unknown delivery id",
      caller: readOnlyClient,
      params: { delivery: "delivery-missing" },
      failure: {
        _tag: "FactoryMcpFailure",
        code: "not_found",
        message: "No Factory delivery has that id.",
      },
    },
    {
      name: "a malformed delivery id",
      caller: readOnlyClient,
      params: { delivery: "not a delivery!" },
      failure: {
        _tag: "FactoryMcpFailure",
        code: "not_found",
        message: "No Factory delivery has that id.",
      },
    },
    {
      name: "an unparseable item",
      caller: { thread: reader },
      params: { item: "the export task" },
      failure: {
        _tag: "FactoryMcpFailure",
        code: "invalid_request",
        message:
          "Name the item as <sourceId>:<itemId>, a key such as fd-7k3qa2, #123 or PROJ-12, or its URL.",
      },
    },
    {
      name: "an item no source of the project holds",
      caller: { thread: reader },
      params: { item: "PROJ-12" },
      failure: {
        _tag: "FactoryMcpFailure",
        code: "not_found",
        message:
          "No single active Work source of the project holds that item. Pass sourceId, or name the item as <sourceId>:<itemId>.",
      },
    },
    {
      name: "a sourceId that is not a source id",
      caller: { thread: reader },
      params: { item: "fd-aaaaaa", sourceId: "markdown" },
      failure: {
        _tag: "FactoryMcpFailure",
        code: "invalid_request",
        message: "sourceId is not a Work source id.",
      },
    },
    {
      name: "a key from a client that names no project",
      caller: readOnlyClient,
      params: { item: "fd-aaaaaa" },
      failure: {
        _tag: "OrchestratorMcpFailure",
        code: "target_required",
        message: "Pass projectId: this MCP client is not running inside a T3 thread.",
      },
    },
    {
      name: "both a delivery and an item",
      caller: readOnlyClient,
      params: { delivery: "delivery-github", item: `${githubItem.sourceId}:7` },
      failure: {
        _tag: "FactoryMcpFailure",
        code: "invalid_request",
        message: "Pass exactly one of delivery and item.",
      },
    },
    {
      name: "neither a delivery nor an item",
      caller: readOnlyClient,
      params: {},
      failure: {
        _tag: "FactoryMcpFailure",
        code: "invalid_request",
        message: "Pass exactly one of delivery and item.",
      },
    },
  ])("answers $name with fixed text and writes nothing", ({ caller, params, failure }) =>
    Effect.gen(function* () {
      yield* seedItems;
      const before = yield* allRows;
      // A write now would move updated_at.
      yield* TestClock.adjust("1 minute");

      const result = yield* status(caller, params);

      assert.isTrue(result.isFailure);
      assert.deepInclude(result.result as object, failure);
      assert.deepStrictEqual(yield* allRows, before);
      assert.strictEqual(before.length, 3);
    }).pipe(Effect.provide(layer)),
  );
});

describe("factory_status storage and Work failures", () => {
  const secret = "SQLITE_IOERR: disk I/O error in /home/owner/.t3/userdata/state.sqlite";
  const storeFailure = new FactoryStoreError({ operation: "deliveries.get", cause: secret });
  // Work's error classes are private to Work; the handler sees only the tag and the text.
  const workFailure = Object.assign(new Error(`Work sources could not be read: ${secret}`), {
    _tag: "WorkUnavailable",
  }) as unknown as WorkDomainError;
  const failingLayer = Layer.mergeAll(
    Layer.mock(FactoryService.FactoryService)({
      get: () => Effect.fail(storeFailure),
      listByItem: () => Effect.fail(storeFailure),
    }),
    Layer.mock(WorkService.WorkService)({ listSources: () => Effect.fail(workFailure) }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
    }),
  );

  it.effect.each<FailureCase>([
    {
      name: "a delivery the store cannot read",
      caller: readOnlyClient,
      params: { delivery: "delivery-1" },
      failure: {
        _tag: "FactoryMcpFailure",
        code: "unavailable",
        message: "Factory could not read its deliveries. Try again.",
      },
    },
    {
      name: "an item's deliveries the store cannot read",
      caller: readOnlyClient,
      params: { item: `${markdownItem.sourceId}:fd-aaaaaa` },
      failure: {
        _tag: "FactoryMcpFailure",
        code: "unavailable",
        message: "Factory could not read its deliveries. Try again.",
      },
    },
    {
      name: "sources Work cannot list",
      caller: { thread: reader },
      params: { item: "fd-aaaaaa" },
      failure: {
        _tag: "FactoryMcpFailure",
        code: "unavailable",
        message: "Factory could not read the project's Work sources. Try again.",
      },
    },
  ])("answers $name with fixed text", ({ caller, params, failure }) =>
    Effect.gen(function* () {
      const result = yield* status(caller, params);

      assert.isTrue(result.isFailure);
      assert.deepInclude(result.result as object, failure);
      assert.notInclude((result.result as { message: string }).message, "SQLITE");
    }).pipe(Effect.provide(failingLayer)),
  );
});
