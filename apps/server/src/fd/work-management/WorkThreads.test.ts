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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
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
}

const setup = (options: { readonly threadEnvMode?: "worktree" } = {}) =>
  Effect.sync(() => {
    const markdown = fakeAdapter("markdown");
    const harness = makeHarness([markdown.adapter]);
    harness.projects.set(projectId, {
      ...projectRow(projectId, "/projects/alpha"),
      defaultModelSelection: modelSelection,
      defaultThreadEnvMode: options.threadEnvMode ?? null,
    });
    const control: LaunchControl = {
      launched: [],
      linkedBeforeLaunch: [],
      gate: null,
      entered: null,
      failNext: false,
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
    const layer = WorkThreads.layer.pipe(
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
});
