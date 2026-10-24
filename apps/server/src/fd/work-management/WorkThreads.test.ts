import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthWorkReadScope,
  AuthWorkWriteScope,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { WorkItemId } from "@t3tools/contracts/fd/work-management";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import { getAutoBootstrapThreadModelSelection } from "../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../serverSettings.ts";
import type { WorkActor } from "./authority.ts";
import * as WorkLinkStore from "./persistence/WorkLinkStore.ts";
import {
  fakeAdapter,
  makeHarness,
  markdownConfig,
  owner,
  projectRow,
  threadShell,
} from "./testkit/fakes.ts";
import * as WorkService from "./WorkService.ts";
import * as WorkSyncReactor from "./sync/WorkSyncReactor.ts";
import * as WorkThreads from "./WorkThreads.ts";

const projectId = ProjectId.make("project-alpha");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

const starter: WorkActor = {
  id: "session:owner",
  grants: [AuthWorkReadScope, AuthWorkWriteScope, AuthOrchestrationOperateScope],
  label: "owner",
};

interface LaunchControl {
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  /** Whether the item's link already existed when each launch ran. */
  readonly linkedBeforeLaunch: Array<boolean>;
  gate: Deferred.Deferred<void> | null;
  entered: Deferred.Deferred<void> | null;
  failNext: boolean;
  /** The next launch dies with a defect instead of a typed failure. */
  dieNext: boolean;
}

const setup = (
  options: {
    readonly threadEnvMode?: "worktree";
    readonly noProjectModel?: boolean;
    readonly kind?: "markdown" | "github";
  } = {},
) =>
  Effect.sync(() => {
    const kind = options.kind ?? "markdown";
    const markdown = fakeAdapter(kind, kind === "github" ? { mintId: String } : {});
    const harness = makeHarness([markdown.adapter]);
    harness.projects.set(projectId, {
      ...projectRow(projectId, "/projects/alpha"),
      defaultModelSelection: options.noProjectModel === true ? null : modelSelection,
      defaultThreadEnvMode: options.threadEnvMode ?? null,
    });
    const control: LaunchControl = {
      launched: [],
      linkedBeforeLaunch: [],
      gate: null,
      entered: null,
      failNext: false,
      dieNext: false,
    };
    const launches = Layer.effect(
      ThreadLaunch.ThreadLaunchService,
      Effect.gen(function* () {
        const links = yield* WorkLinkStore.WorkLinkStore;
        return ThreadLaunch.ThreadLaunchService.of({
          checkWorktreeBase: () => Effect.void,
          launch: (input: ThreadLaunch.ThreadLaunchInput) =>
            Effect.gen(function* () {
              const linked = yield* links.listByThread(input.threadId!).pipe(Effect.orDie);
              control.linkedBeforeLaunch.push(linked.length > 0);
              control.launched.push(input);
              if (control.entered !== null) yield* Deferred.succeed(control.entered, undefined);
              if (control.gate !== null) yield* Deferred.await(control.gate);
              if (control.dieNext) {
                control.dieNext = false;
                return yield* Effect.die("launch defect");
              }
              if (control.failNext) {
                control.failNext = false;
                return yield* new ThreadLaunch.ThreadLaunchError({
                  operation: "create-thread",
                  commandId: input.commandId,
                  projectId: input.projectId,
                  cause: "boom",
                });
              }
              harness.threads.set(input.threadId!, threadShell(input.threadId!, projectId));
              return {
                threadId: input.threadId!,
                resumed: false,
              } as ThreadLaunch.ThreadLaunchResult;
            }),
        } as unknown as ThreadLaunch.ThreadLaunchService["Service"]);
      }),
    );
    // The sync reactor beside it, with quiet event tails, for sweeps during a launch.
    const reactor = WorkSyncReactor.layer.pipe(
      Layer.provide(
        Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
          latestApplicationSequence: Effect.succeed(0),
          streamProjectedApplicationEvents: () => Stream.never,
        }),
      ),
      Layer.provide(Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never })),
    );
    const layer = Layer.mergeAll(WorkThreads.layer, reactor).pipe(
      Layer.provide(launches),
      Layer.provideMerge(harness.layer),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(NodeServices.layer),
    );
    return { markdown, harness, control, layer };
  });

const createItem = Effect.gen(function* () {
  const work = yield* WorkService.WorkService;
  const source = yield* work.saveSource(owner, {
    projectId,
    label: "Tasks",
    config: markdownConfig("tasks"),
  });
  return yield* work.createItem(owner, { sourceId: source.sourceId, title: "Add Jira sync" });
});

const startInput = (ref: { readonly sourceId: string; readonly itemId: string }) =>
  ({
    ref: ref as never,
    creationSource: "web",
    mode: "implement",
    force: false,
  }) as const;

describe("WorkThreads.start", () => {
  it.effect("launches one thread for concurrent starts of one item", () =>
    Effect.gen(function* () {
      const { control, layer } = yield* setup();
      yield* Effect.gen(function* () {
        const threads = yield* WorkThreads.WorkThreads;
        const item = yield* createItem;
        control.gate = yield* Deferred.make<void>();
        control.entered = yield* Deferred.make<void>();
        const input = {
          ref: item.ref,
          creationSource: "web",
          mode: "implement",
          force: false,
        } as const;
        const first = yield* Effect.forkChild(threads.start(starter, input));
        yield* Deferred.await(control.entered);
        const second = yield* Effect.forkChild(threads.start(starter, input));
        yield* Deferred.succeed(control.gate, undefined);
        const [a, b] = [yield* Fiber.join(first), yield* Fiber.join(second)];

        assert.strictEqual(control.launched.length, 1);
        assert.deepStrictEqual(control.linkedBeforeLaunch, [true]);
        assert.strictEqual(a.resumed, false);
        assert.deepStrictEqual(b, { threadId: a.threadId, resumed: true });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("builds the launch from the item and moves a todo Markdown item to in progress", () =>
    Effect.gen(function* () {
      const { control, layer } = yield* setup({ threadEnvMode: "worktree" });
      yield* Effect.gen(function* () {
        const threads = yield* WorkThreads.WorkThreads;
        const work = yield* WorkService.WorkService;
        const links = yield* WorkLinkStore.WorkLinkStore;
        const item = yield* createItem;
        const threadId = ThreadId.make("client-thread");
        yield* threads.start(starter, {
          ref: item.ref,
          threadId,
          creationSource: "mobile",
          mode: "scope",
          prompt: "Focus on ADF.",
          force: false,
        });

        const launch = control.launched[0]!;
        assert.strictEqual(launch.threadId, threadId);
        assert.strictEqual(
          launch.commandId,
          `work-start:${item.ref.sourceId}:${item.ref.itemId}:${threadId}`,
        );
        assert.strictEqual(launch.title, `${item.key}: Add Jira sync`);
        assert.deepStrictEqual(launch.modelSelection, modelSelection);
        assert.strictEqual(launch.createdBy, "user");
        assert.strictEqual(launch.creationSource, "mobile");
        assert.deepStrictEqual(launch.workspaceStrategy, {
          type: "worktree",
          baseRef: "HEAD",
          branch: `work/${item.ref.itemId}-add-jira-sync`,
          startFromOrigin: false,
        });
        assert.include(launch.initialMessage?.text ?? "", "Change no files");
        assert.include(launch.initialMessage?.text ?? "", "Focus on ADF.");

        const detail = yield* work.getItem(owner, { ref: item.ref });
        assert.strictEqual(detail.status, "in_progress");
        const [link] = yield* links.listByThread(threadId);
        assert.strictEqual(link?.source, "started");
        assert.strictEqual(link?.snapshot.autoStarted, true);
        assert.strictEqual(link?.snapshot.mode, "scope");
        // Work's own starts carry no origin, so clients keep offering the reverse prompts.
        assert.isNull(link?.origin);
        assert.notProperty(detail.links[0], "origin");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("returns an open linked thread unless forced", () =>
    Effect.gen(function* () {
      const { control, layer } = yield* setup();
      yield* Effect.gen(function* () {
        const threads = yield* WorkThreads.WorkThreads;
        const item = yield* createItem;
        const input = {
          ref: item.ref,
          creationSource: "web",
          mode: "implement",
          force: false,
        } as const;
        const first = yield* threads.start(starter, input);
        assert.deepStrictEqual(yield* threads.start(starter, input), {
          threadId: first.threadId,
          resumed: true,
        });
        const forced = yield* threads.start(starter, { ...input, force: true });
        assert.notStrictEqual(forced.threadId, first.threadId);
        assert.strictEqual(control.launched.length, 2);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("removes the link when the launch fails", () =>
    Effect.gen(function* () {
      const { control, layer } = yield* setup();
      yield* Effect.gen(function* () {
        const threads = yield* WorkThreads.WorkThreads;
        const links = yield* WorkLinkStore.WorkLinkStore;
        const item = yield* createItem;
        control.failNext = true;
        const exit = yield* Effect.exit(
          threads.start(starter, {
            ref: item.ref,
            creationSource: "web",
            mode: "implement",
            force: false,
          }),
        );
        assert.isTrue(Exit.isFailure(exit));
        assert.deepStrictEqual(yield* links.listByItem(item.ref.sourceId, item.ref.itemId), []);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("needs thread control as well as Work reads", () =>
    Effect.gen(function* () {
      const { control, layer } = yield* setup();
      yield* Effect.gen(function* () {
        const threads = yield* WorkThreads.WorkThreads;
        const item = yield* createItem;
        const error = yield* Effect.flip(
          threads.start(owner, {
            ref: item.ref,
            creationSource: "web",
            mode: "implement",
            force: false,
          }),
        );
        assert.strictEqual(error._tag, "WorkPermissionDenied");
        assert.strictEqual(control.launched.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("falls back to the automatic model when nothing names one", () =>
    Effect.gen(function* () {
      const { control, layer } = yield* setup({ noProjectModel: true });
      yield* Effect.gen(function* () {
        const threads = yield* WorkThreads.WorkThreads;
        const item = yield* createItem;
        yield* threads.start(starter, {
          ref: item.ref,
          creationSource: "web",
          mode: "scope",
          force: false,
        });
        assert.deepStrictEqual(
          control.launched[0]?.modelSelection,
          getAutoBootstrapThreadModelSelection(),
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("treats equivalent spellings of one item as one item", () =>
    Effect.gen(function* () {
      const { control, layer } = yield* setup({ kind: "github" });
      yield* Effect.gen(function* () {
        const threads = yield* WorkThreads.WorkThreads;
        const work = yield* WorkService.WorkService;
        const links = yield* WorkLinkStore.WorkLinkStore;
        const source = yield* work.saveSource(owner, {
          projectId,
          label: "Issues",
          config: { kind: "github", host: "github.com", owner: "acme", name: "app" },
        });
        const item = yield* work.createItem(owner, { sourceId: source.sourceId, title: "Fix" });
        assert.strictEqual(item.ref.itemId, "1");
        control.gate = yield* Deferred.make<void>();
        control.entered = yield* Deferred.make<void>();

        const padded = { sourceId: item.ref.sourceId, itemId: WorkItemId.make("01") };
        const first = yield* Effect.forkChild(threads.start(starter, startInput(padded)));
        yield* Deferred.await(control.entered);
        const second = yield* Effect.forkChild(threads.start(starter, startInput(item.ref)));
        yield* Deferred.succeed(control.gate, undefined);
        const [a, b] = [yield* Fiber.join(first), yield* Fiber.join(second)];

        assert.strictEqual(control.launched.length, 1);
        assert.deepStrictEqual(b, { threadId: a.threadId, resumed: true });
        // The link is stored under the canonical id, so either spelling finds it.
        assert.deepStrictEqual(
          (yield* links.listByThread(a.threadId)).map((link) => link.itemId),
          ["1"],
        );
        assert.strictEqual((yield* work.listLinks(owner, { ref: padded })).links.length, 1);

        // A spelling that only `Number` reads as 1 is not that issue, so it cannot start a
        // second thread for it.
        const exponent = { sourceId: item.ref.sourceId, itemId: WorkItemId.make("1e0") };
        const refused = yield* Effect.flip(threads.start(starter, startInput(exponent)));
        assert.strictEqual(refused._tag, "WorkItemNotFound");
        assert.strictEqual(control.launched.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("keeps one thread when a launch outlasts any grace period and the sweep runs", () =>
    Effect.gen(function* () {
      const { control, layer } = yield* setup();
      yield* Effect.gen(function* () {
        const threads = yield* WorkThreads.WorkThreads;
        const work = yield* WorkService.WorkService;
        const links = yield* WorkLinkStore.WorkLinkStore;
        const reactor = yield* WorkSyncReactor.WorkSyncReactor;
        const item = yield* createItem;
        control.gate = yield* Deferred.make<void>();
        control.entered = yield* Deferred.make<void>();

        const first = yield* Effect.forkChild(threads.start(starter, startInput(item.ref)));
        yield* Deferred.await(control.entered);
        const launching = control.launched[0]!.threadId!;
        // The launch is still running long after the old 60-second grace, and the link sweep
        // runs meanwhile: the reservation keeps the link.
        yield* TestClock.adjust("5 minutes");
        yield* reactor.sweepLinks;
        yield* reactor.drain;
        assert.isTrue(yield* work.isLaunching(launching));
        assert.deepStrictEqual(
          (yield* links.listByItem(item.ref.sourceId, item.ref.itemId)).map(
            (link) => link.threadId,
          ),
          [launching],
        );

        const second = yield* Effect.forkChild(threads.start(starter, startInput(item.ref)));
        yield* Deferred.succeed(control.gate, undefined);
        const [a, b] = [yield* Fiber.join(first), yield* Fiber.join(second)];
        assert.strictEqual(control.launched.length, 1);
        assert.deepStrictEqual(b, { threadId: a.threadId, resumed: true });
        assert.isFalse(yield* work.isLaunching(launching));
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("removes the reservation when the launch dies or its caller goes away", () =>
    Effect.gen(function* () {
      const { control, layer } = yield* setup();
      yield* Effect.gen(function* () {
        const threads = yield* WorkThreads.WorkThreads;
        const work = yield* WorkService.WorkService;
        const links = yield* WorkLinkStore.WorkLinkStore;
        const item = yield* createItem;
        const linked = links
          .listByItem(item.ref.sourceId, item.ref.itemId)
          .pipe(Effect.map((rows) => rows.map((link) => link.threadId)));

        // A defect in the launch.
        control.dieNext = true;
        const died = yield* Effect.exit(threads.start(starter, startInput(item.ref)));
        assert.isTrue(Exit.isFailure(died));
        assert.deepStrictEqual(yield* linked, []);

        // The caller is interrupted while the launch runs.
        control.gate = yield* Deferred.make<void>();
        control.entered = yield* Deferred.make<void>();
        const pending = yield* Effect.forkChild(threads.start(starter, startInput(item.ref)));
        yield* Deferred.await(control.entered);
        const abandoned = control.launched[1]!.threadId!;
        assert.deepStrictEqual(yield* linked, [abandoned]);
        yield* Fiber.interrupt(pending);
        assert.deepStrictEqual(yield* linked, []);
        assert.isFalse(yield* work.isLaunching(abandoned));

        // A retry launches a real thread instead of resuming one that does not exist.
        control.gate = null;
        control.entered = null;
        const retried = yield* threads.start(starter, startInput(item.ref));
        assert.strictEqual(retried.resumed, false);
        assert.notStrictEqual(retried.threadId, abandoned);
        assert.strictEqual(control.launched.length, 3);
        assert.deepStrictEqual(yield* linked, [retried.threadId]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not reopen an item someone changed while its thread launched", () =>
    Effect.gen(function* () {
      const { control, layer } = yield* setup();
      yield* Effect.gen(function* () {
        const threads = yield* WorkThreads.WorkThreads;
        const work = yield* WorkService.WorkService;
        const links = yield* WorkLinkStore.WorkLinkStore;
        const item = yield* createItem;
        control.gate = yield* Deferred.make<void>();
        control.entered = yield* Deferred.make<void>();

        const pending = yield* Effect.forkChild(threads.start(starter, startInput(item.ref)));
        yield* Deferred.await(control.entered);
        // Someone finishes the item during the launch.
        yield* work.setStatus(owner, { ref: item.ref, status: "done" });
        yield* Deferred.succeed(control.gate, undefined);
        const started = yield* Fiber.join(pending);

        assert.strictEqual((yield* work.getItem(owner, { ref: item.ref })).status, "done");
        const [link] = yield* links.listByThread(started.threadId);
        assert.isFalse(link?.snapshot.autoStarted);
      }).pipe(Effect.provide(layer));
    }),
  );
});
