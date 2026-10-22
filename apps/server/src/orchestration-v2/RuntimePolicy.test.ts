import { RepositorySet } from "../fd/multirepo/index.ts";
import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

// Grok's instance offers no Auto-accept edits; the Codex instance advertises no
// restriction.
const grokInstanceId = ProviderInstanceId.make("grok");
const cloudInstanceId = ProviderInstanceId.make("cloud-runtime-policy");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
  [cloudInstanceId, ["full-access"]],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    instanceId,
    orchestrationAdapter: {
      instanceId,
      driver: ProviderDriverKind.make("test"),
      planSelectionTransition: () => Effect.die("unused transition"),
      openSession: () => Effect.die("unused open"),
      getCapabilities: () =>
        Effect.succeed({
          ...CodexProviderCapabilitiesV2,
          ...(instanceId === providerInstanceId ? {} : { multiRepository: undefined }),
        }),
    } satisfies ProviderInstance["orchestrationAdapter"],
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
  }) as unknown as ProviderInstance;

const layerTest = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(
    Layer.mock(RepositorySet.RepositorySet)({ validate: (binding) => Effect.succeed(binding) }),
  ),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeed(
          Option.some({
            projectId,
            title: "Project",
            workspaceRoot: "/project-root",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
  ),
);

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect(
    "uses the immutable repository binding across resume and rejects an unsupported provider switch",
    () =>
      Effect.gen(function* () {
        const policy = yield* RuntimePolicy.RuntimePolicyV2;
        const now = yield* DateTime.now;
        const binding = {
          version: 1 as const,
          defaultCwd: "/saved-primary/packages/app",
          repositories: [
            { id: "a", name: "Client", rootPath: "/saved-primary" },
            { id: "b", name: "Service", rootPath: "/another-parent/service" },
          ],
        };
        const thread = { ...makeThread({ now, worktreePath: null }), workspaceBinding: binding };
        for (let resume = 0; resume < 2; resume++) {
          const resolved = yield* policy.resolve({ thread, modelSelection });
          assert.equal(resolved.cwd, binding.defaultCwd);
          assert.deepEqual(resolved.repositories, binding.repositories);
        }
        const error = yield* policy
          .resolve({ thread, modelSelection: { ...modelSelection, instanceId: grokInstanceId } })
          .pipe(Effect.flip);
        assert.match(error.message, /does not support multi-repository/);
        const worktree = yield* policy
          .resolve({ thread: { ...thread, worktreePath: "/worktree" }, modelSelection })
          .pipe(Effect.flip);
        assert.match(worktree.message, /Worktree creation/);
        const override = yield* RuntimePolicy.RuntimePolicyV2.pipe(
          Effect.provide(RuntimePolicy.layerWithOverride({ cwd: "/elsewhere" })),
        );
        assert.match(
          (yield* override.resolve({ thread, modelSelection }).pipe(Effect.flip)).message,
          /cannot be overridden/,
        );
      }),
  );

  it.effect("uses the project root for local-checkout threads", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-root");
    }),
  );

  it.effect("prefers a provisioned worktree over the project root", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/project-worktree" }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-worktree");
    }),
  );

  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      // A provider that advertises no restriction runs every mode as stored.
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );

  it.effect(
    "uses a provider's sole runtime mode for threads created with a different stored mode",
    () =>
      Effect.gen(function* () {
        const policy = yield* RuntimePolicy.RuntimePolicyV2;
        const now = yield* DateTime.now;
        const selection = { instanceId: cloudInstanceId, model: "default" };
        const resolved = yield* policy.resolve({
          thread: {
            ...makeThread({ now, worktreePath: null, runtimeMode: "approval-required" }),
            providerInstanceId: cloudInstanceId,
            modelSelection: selection,
          },
          modelSelection: selection,
        });
        assert.equal(resolved.runtimeMode, "full-access");
        assert.equal(resolved.cwd, "/project-root");
      }),
  );
});
