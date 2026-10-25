import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  FactoryPlan,
  FactoryProjectSettings,
  FactoryTaskId,
} from "@t3tools/contracts/fd/factory";
import {
  type WorkItemDetail,
  WorkItemId,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { WorkService } from "../work-management/index.ts";
import * as FactoryPlanning from "./FactoryPlanning.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import type { StoredFactoryDelivery } from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import { advance } from "./pipeline/engine.ts";
import { type FactoryEvent, queuedDeliveryState } from "./pipeline/state.ts";
import * as FactoryEvidence from "./verify/FactoryEvidence.ts";

const projectId = ProjectId.make("project-alpha");
const deliveryId = FactoryDeliveryId.make("delivery-parent");
const itemRef = {
  sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
  itemId: WorkItemId.make("fd-aaaaaa"),
};
const branch = "work/fd-aaaaaa";
// The id Factory derives for the parent's first launch effect.
const planner = ThreadId.make(`factory-thread:${deliveryId}:1`);
const planRun = RunId.make("run-plan");

const model = (name: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: name,
});

const item = {
  ref: itemRef,
  key: "fd-aaaaaa",
  title: "Ship table exports",
  url: null,
  locator: "tasks/fd-aaaaaa.md",
  body: "Users can export tables as CSV and JSON.",
  bodyTruncated: false,
};

/** What the fakes recorded, and what the planner thread's projection holds. */
interface World {
  readonly launches: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly links: Array<{
    readonly ref: unknown;
    readonly threadId: ThreadId;
    readonly origin: string;
  }>;
  readonly sends: Array<ThreadManagement.ThreadManagementSendInput>;
  readonly messages: Array<{ readonly text: string }>;
  workspaceRoot: string;
  worktreePath: string | null;
  projectModel: ModelSelection | null;
}

// Factory reads only these fields of the launch result, the thread records and the send result.
const fakes = (world: World) =>
  Layer.mergeAll(
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          world.launches.push(input);
          return {
            threadId: input.threadId,
            projection: {
              runs: [
                {
                  id: planRun,
                  userMessageId: input.initialMessage?.messageId,
                  status: "preparing",
                },
              ],
            },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult;
        }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      sendToThread: (input) =>
        Effect.sync(() => {
          world.sends.push(input);
          return {
            run: { id: RunId.make("run-plan-retry") },
            message: { attachments: [] },
          } as unknown as ThreadManagement.ThreadManagementSendResult;
        }),
      getThreadEventSequence: () => Effect.succeed(0),
      streamStoredEventsFrom: () => Stream.empty,
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: ((threadId: ThreadId) =>
        Effect.sync(() => ({
          thread: { id: threadId, worktreePath: world.worktreePath, deletedAt: null },
          runs: [{ id: planRun, status: "running" }],
          messages: world.messages,
        }))) as unknown as ProjectionStore.ProjectionStoreV2["Service"]["getThreadRecords"],
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (id) =>
        Effect.sync(() =>
          Option.some({
            projectId: id,
            title: "Alpha",
            workspaceRoot: world.workspaceRoot,
            defaultModelSelection: world.projectModel,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: "2026-10-24T00:00:00.000Z",
            updatedAt: "2026-10-24T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
    Layer.mock(WorkService.WorkService)({
      getItem: () => Effect.succeed(item as unknown as WorkItemDetail),
      linkLaunch: (input, launch) =>
        Effect.sync(() => world.links.push(input)).pipe(Effect.andThen(launch)),
    }),
    // No provider advertises its runtime modes here, so a launch asks for its bound.
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: () => Effect.succeed(undefined),
    }),
  );

/** The real thread effects and plan judging over the fakes, in-memory SQLite and real git. */
const makeLayer = (world: World) =>
  Layer.mergeAll(FactoryThreadEffects.layer, FactoryPlanning.layer).pipe(
    Layer.provide(fakes(world)),
    Layer.provide(ProviderRegistryMock.layer()),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provideMerge(FactoryEvidence.layer),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-planning-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const withWorld = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const world: World = {
      launches: [],
      links: [],
      sends: [],
      messages: [],
      workspaceRoot: "/nowhere",
      worktreePath: null,
      projectModel: null,
    };
    return body(world).pipe(Effect.provide(makeLayer(world)));
  }).pipe(Effect.scoped);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) =>
    driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 }),
  ).pipe(Effect.map((result) => result.stdout.trim()));

/**
 * A project checkout and the delivery's worktree of it, on the delivery branch created from
 * `main` the way a launch's preparation creates it, so the launch finds its workspace prepared.
 */
const makeProject = (world: World) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-plan-root-" });
    const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-plan-wt-" });
    yield* git(root, ["init", "-b", "main"]);
    yield* git(root, [
      "-c",
      "user.name=Ada Lovelace",
      "-c",
      "user.email=ada@example.com",
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "--allow-empty",
      "-m",
      "chore: root",
    ]);
    const worktree = path.join(parent, "fd-aaaaaa");
    yield* git(root, ["worktree", "add", "-b", branch, worktree, "main"]);
    world.workspaceRoot = root;
    world.worktreePath = worktree;
    return { worktree };
  });

/** The parent as its start left it, and the planner launch the start issued. */
const started = (options: { readonly runtimeModeCeiling?: "approval-required" } = {}) => {
  const queued = queuedDeliveryState({ kind: "parent", branch, baseRef: "main", ...options });
  const { delivery: state, effects } = advance(queued, { type: "start" });
  const [launch] = effects;
  if (launch?.type !== "launch_thread") return assert.fail("The start issued no launch.");
  const delivery: StoredFactoryDelivery = {
    deliveryId,
    projectId,
    itemRef,
    parentId: null,
    state,
    createdAt: "2026-10-25T10:00:00.000Z",
    updatedAt: "2026-10-25T10:00:00.000Z",
  };
  return { delivery, launch };
};

/** The parent once its planner launched: the plan stage awaits the planner's run. */
const planning = () => {
  const { delivery } = started();
  const launched: FactoryEvent = {
    type: "thread.launched",
    effectId: 1,
    threadId: planner,
    runId: planRun,
    worktreePath: "/worktrees/fd-aaaaaa",
    baseline: "b".repeat(40),
  };
  return { ...delivery, state: advance(delivery.state, launched).delivery };
};

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);
const decodePlan = Schema.decodeUnknownSync(FactoryPlan);
const useRoles = (roles: { readonly planner?: ModelSelection; readonly author?: ModelSelection }) =>
  Effect.flatMap(FactorySettings.FactorySettings, (settings) =>
    settings.set(projectId, decodeSettings({ roles })),
  );

const launchPlanner = (options: { readonly runtimeModeCeiling?: "approval-required" } = {}) =>
  Effect.flatMap(FactoryThreadEffects.FactoryThreadEffects, (threads) => {
    const { delivery, launch } = started(options);
    return threads.launchThread(delivery, launch);
  });

const twoTaskPlan = {
  tasks: [
    {
      id: "export-csv",
      title: "Export the current table as CSV",
      kind: "feature",
      summary: "Add a CSV export of the visible rows.",
      acceptance: ["The export downloads the visible rows as CSV."],
      testPlan: [{ criterion: 1, check: "Export two rows.", paths: ["src/export.test.ts"] }],
      likelyPaths: ["src/export.ts"],
      risk: "normal",
    },
    {
      id: "export-json",
      title: "Export the current table as JSON",
      kind: "feature",
      summary: "Add a JSON export beside the CSV one.",
      acceptance: ["The export downloads the visible rows as JSON."],
      testPlan: [{ criterion: 1, check: "Export two rows.", paths: ["src/export.test.ts"] }],
      likelyPaths: ["src/export.ts"],
      risk: "high",
    },
  ],
};
const fenced = (value: unknown) =>
  `Here is the plan.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

/** The delivery's `plan.json` under T3 home, and whether it exists. */
const planFile = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const file = path.join(config.stateDir, "fd-factory", deliveryId, "plan.json");
  const exists = yield* fileSystem.exists(file);
  return {
    file,
    exists,
    read: fileSystem.readFileString(file).pipe(Effect.map((json) => JSON.parse(json))),
  };
});

const judgeFallback = Effect.flatMap(FactoryPlanning.FactoryPlanning, (plans) =>
  plans.judgeFallback(planning(), {
    type: "read_fallback_plan",
    id: 2,
    threadId: planner,
    runId: planRun,
  }),
);

describe("FactoryThreadEffects planner launch", () => {
  it.effect("launches the planner in plan mode with the plan prompt, linked to the item", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* makeProject(world);
        world.projectModel = model("project-model");
        yield* useRoles({ planner: model("planner-model"), author: model("author-model") });

        const launched = yield* launchPlanner({ runtimeModeCeiling: "approval-required" });

        assert.strictEqual(launched.threadId, planner);
        assert.strictEqual(launched.runId, planRun);
        assert.strictEqual(world.launches.length, 1);
        const [launch] = world.launches;
        assert.strictEqual(launch?.interactionMode, "plan");
        assert.deepStrictEqual(launch?.modelSelection, model("planner-model"));
        // The ceiling is narrower than the project's default, and the provider runs any mode.
        assert.strictEqual(launch?.runtimeMode, "approval-required");
        assert.strictEqual(launch?.title, "Plan fd-aaaaaa: Ship table exports");
        assert.deepStrictEqual(launch?.workspaceStrategy, {
          type: "worktree",
          baseRef: "main",
          branch,
        });
        assert.include(
          launch?.initialMessage?.text ?? "",
          "Factory plan for Work item fd-aaaaaa: Ship table exports",
        );
        assert.include(launch?.initialMessage?.text ?? "", "`factory_submit_plan`");
        assert.deepStrictEqual(world.links, [
          { ref: itemRef, threadId: planner, origin: "factory" },
        ]);
      }),
    ),
  );

  it.effect.each([
    {
      name: "the author's profile when the planner has none",
      roles: { author: model("author-model") },
      project: model("project-model"),
      expected: model("author-model"),
    },
    {
      name: "the project's default when neither role has a profile",
      roles: {},
      project: model("project-model"),
      expected: model("project-model"),
    },
  ])("falls back to $name", ({ roles, project, expected }) =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* makeProject(world);
        world.projectModel = project;
        yield* useRoles(roles);

        yield* launchPlanner();

        assert.deepStrictEqual(world.launches[0]?.modelSelection, expected);
        assert.strictEqual(world.launches[0]?.interactionMode, "plan");
      }),
    ),
  );
});

describe("FactoryThreadEffects plan retry turn", () => {
  it.effect("asks the planner thread for its whole plan again, naming the problems", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const threads = yield* FactoryThreadEffects.FactoryThreadEffects;

        const sent = yield* threads.sendPlanRetryTurn(planning(), {
          type: "send_plan_retry_turn",
          id: 3,
          threadId: planner,
          problems: ["Your final message has no fenced ```json block holding the plan."],
        });

        assert.strictEqual(sent.runId, RunId.make("run-plan-retry"));
        const [send] = world.sends;
        assert.strictEqual(send?.threadId, planner);
        assert.strictEqual(send?.commandId, `factory-plan-retry:${deliveryId}:3`);
        assert.strictEqual(
          send?.text,
          [
            "Factory could not accept your plan:\n- Your final message has no fenced ```json block holding the plan.",
            "Correct these problems and submit the whole plan again: call the `factory_submit_plan` tool, and end your final message with the same plan as JSON in one fenced ```json block. Change no file. This is the last attempt before the delivery blocks.",
          ].join("\n\n"),
        );
      }),
    ),
  );

  it.effect("names the checkpoint on a resume, without a last-attempt warning", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const threads = yield* FactoryThreadEffects.FactoryThreadEffects;

        yield* threads.sendPlanRetryTurn(planning(), {
          type: "send_plan_retry_turn",
          id: 4,
          threadId: planner,
          problems: [],
          checkpoint: "plan",
        });

        const text = world.sends[0]?.text ?? "";
        assert.include(
          text,
          "Factory is resuming this delivery from its `plan` checkpoint and needs your plan again.",
        );
        assert.include(text, "call the `factory_submit_plan` tool");
        assert.notInclude(text, "had these problems");
        assert.notInclude(text, "last attempt");
      }),
    ),
  );
});

describe("FactoryPlanning", () => {
  it.effect("accepts the fenced plan of the planner's last message and writes plan.json", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        world.messages.push({ text: "Reading the item." }, { text: fenced(twoTaskPlan) });

        const judgment = yield* judgeFallback;

        const evidence = yield* planFile;
        assert.deepStrictEqual(judgment, {
          type: "accepted",
          plan: {
            tasks: decodePlan(twoTaskPlan).tasks,
            source: "fallback",
            evidencePath: evidence.file,
          },
        });
        assert.isTrue(evidence.exists);
        assert.deepInclude(yield* evidence.read, {
          version: 1,
          deliveryId,
          round: 1,
          source: "fallback",
          threadId: planner,
        });
      }),
    ),
  );

  it.effect("accepts an empty plan with its note", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        world.messages.push({ text: fenced({ tasks: [], note: "Nothing to build." }) });

        const judgment = yield* judgeFallback;

        assert.strictEqual(judgment.type, "accepted");
        if (judgment.type !== "accepted") return;
        assert.deepStrictEqual(judgment.plan.tasks, []);
        assert.strictEqual(judgment.plan.note, "Nothing to build.");
        assert.deepInclude((yield* (yield* planFile).read).plan, {
          tasks: [],
          note: "Nothing to build.",
        });
      }),
    ),
  );

  it.effect.each([
    {
      name: "a message without a fenced block",
      messages: [{ text: "I could not finish the plan." }],
      problem: "Your final message has no fenced ```json block holding the plan.",
    },
    {
      name: "a run without any message",
      messages: [],
      problem: "Your final message has no fenced ```json block holding the plan.",
    },
    {
      name: "a plan whose criterion has no test plan entry",
      messages: [{ text: fenced({ tasks: [{ ...twoTaskPlan.tasks[0], testPlan: [] }] }) }],
      problem: 'Task "export-csv": acceptance criterion 1 has no test plan entry',
    },
  ])("judges $name invalid and writes nothing", ({ messages, problem }) =>
    withWorld((world) =>
      Effect.gen(function* () {
        world.messages.push(...messages);

        const judgment = yield* judgeFallback;

        assert.strictEqual(judgment.type, "invalid");
        if (judgment.type !== "invalid") return;
        assert.isTrue(
          judgment.problems.some((described) => described.startsWith(problem)),
          JSON.stringify(judgment.problems),
        );
        assert.isFalse((yield* planFile).exists);
      }),
    ),
  );

  it.effect("refuses task ids the delivery already uses, by either path", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const delivery = planning();
        yield* Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
          deliveries.insert({ deliveryId, projectId, itemRef, state: delivery.state }),
        );
        yield* Effect.flatMap(FactoryTaskStore.FactoryTaskStore, (tasks) =>
          tasks.insert({ deliveryId, taskId: FactoryTaskId.make("export-json") }),
        );
        const plans = yield* FactoryPlanning.FactoryPlanning;
        const used =
          'Task id "export-json" is already used in this delivery; choose an id it has not used.';

        const submitted = yield* plans.judge(delivery, {
          source: "mcp",
          threadId: planner,
          plan: twoTaskPlan,
        });
        world.messages.push({ text: fenced(twoTaskPlan) });
        const read = yield* judgeFallback;

        assert.deepStrictEqual(submitted, { type: "invalid", problems: [used] });
        assert.deepStrictEqual(read, { type: "invalid", problems: [used] });
        assert.isFalse((yield* planFile).exists);
      }),
    ),
  );
});
