import { EnvironmentRpcUnavailableError, requestGuarded, runStreamGuarded } from "../rpc/client.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { RpcSession } from "../rpc/session.ts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthWorkWriteScope,
  EnvironmentAuthorizationError,
  ThreadId,
  EnvironmentId,
  ProjectId,
  ScheduledTaskId,
  WS_METHODS,
  type AuthSessionState,
  type ServerConfig,
} from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createFactoryEnvironmentAtoms } from "../fd/factory/index.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { type AtomCommandResult, createEnvironmentRpcCommand } from "./runtime.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");
const other = EnvironmentId.make("other");
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);
const permissions = createCommandPermissions(runtime, WS_METHODS.scheduledTasksDelete);
const factorySettings = Schema.decodeSync(FactoryProjectSettings)({});
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const setup = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return registry;
});

describe("command permissions", () => {
  it.effect("requires settings and conversation permissions on the repository destination", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const membership = createCommandPermissions(runtime, WS_METHODS.projectsSetRepositories);
        for (const scopes of [[AuthSettingsWriteScope], [AuthOrchestrationOperateScope]]) {
          registry.set(
            sessions(env),
            AsyncResult.success({ ...grant(true), scopes, permissions: scopes }),
          );
          expect(registry.get(membership.permissionAtom(env))).toBe(false);
          expect((yield* membership.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
        }
        const scopes = [AuthSettingsWriteScope, AuthOrchestrationOperateScope];
        registry.set(
          sessions(env),
          AsyncResult.success({ ...grant(true), scopes, permissions: scopes }),
        );
        expect(registry.get(membership.permissionAtom(env))).toBe(true);
        yield* membership.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(membership.permissionAtom(other))).toBe(false);
      }),
    ),
  );
  it.effect("requires the destination settings grant to run storage cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const cleanup = createCommandPermissions(runtime, WS_METHODS.serverRunStorageCleanup);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(cleanup.permissionAtom(env))).toBe(false);
        expect((yield* cleanup.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(cleanup.permissionAtom(env))).toBe(true);
        yield* cleanup.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(cleanup.permissionAtom(other))).toBe(false);
      }),
    ),
  );

  it.effect("requires the destination settings grant to check OTLP endpoints", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const check = createCommandPermissions(runtime, WS_METHODS.serverCheckOtlpEndpoint);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(check.permissionAtom(env))).toBe(false);
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(check.permissionAtom(env))).toBe(true);
        yield* check.authorize(registry, env);
      }),
    ),
  );

  it.effect("uses the target grant for both availability and execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(permissions.permissionAtom(env))).toBe(true);
        expect(permissions.permissionAtom(env)).toBe(permissions.permissionAtom(env));
        yield* permissions.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(permissions.permissionAtom(other))).toBe(false);
        const denied = yield* permissions.authorize(registry, other).pipe(Effect.flip);
        expect(denied._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
  it.effect("waits for an initial grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions.authorize(registry, env).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        yield* Fiber.join(fiber);
      }),
    ),
  );
  it.effect("bounds a session that never loads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions
          .authorize(registry, env)
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("6 seconds");
        expect((yield* Fiber.join(fiber))._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
  it.effect(
    "denies failed and unauthenticated sessions, but accepts a cached refreshing grant",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          registry.set(sessions(env), AsyncResult.failure(Cause.fail("offline")));
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(
            sessions(env),
            AsyncResult.success({ ...grant(true), authenticated: false }),
          );
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(sessions(env), AsyncResult.waiting(AsyncResult.success(grant(true))));
          yield* permissions.authorize(registry, env);
        }),
      ),
  );
  it("rechecks permission after waiting in a serial command lane", async () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(sessions(env));
    registry.set(sessions(env), AsyncResult.success(grant(true)));
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const command = createEnvironmentRpcCommand(runtime, {
      label: "test.delete",
      tag: WS_METHODS.scheduledTasksDelete,
      concurrency: { mode: "serial", key: () => "target" },
      execute: () =>
        Effect.promise(async () => {
          calls++;
          started();
          await gate;
          return { id: ScheduledTaskId.make("task") };
        }),
    });
    const target = { environmentId: env, input: { id: ScheduledTaskId.make("task") } };
    try {
      const first = command.run(registry, target);
      await entered;
      const second = command.run(registry, target);
      registry.set(sessions(env), AsyncResult.success(grant(false)));
      release();
      expect((await first)._tag).toBe("Success");
      expect((await second)._tag).toBe("Failure");
      expect(calls).toBe(1);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

it.effect(
  "requires source control alone for git, and both grants when attaching a worktree to a thread",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
        expect((yield* git.authorize(registry, env).pipe(Effect.flip)).requiredPermission).toBe(
          AuthSourceControlWriteScope,
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSourceControlWriteScope],
            permissions: [AuthSourceControlWriteScope],
          }),
        );
        yield* git.authorize(registry, env);
        const prepare = createCommandPermissions(runtime, WS_METHODS.gitPreparePullRequestThread);
        const input = {
          cwd: "/repo",
          reference: "123",
          mode: "worktree",
          threadId: ThreadId.make("thread"),
        };
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(false);
        expect(
          (yield* prepare.authorize(registry, env, input).pipe(Effect.flip)).requiredScope,
        ).toBe(AuthOrchestrationOperateScope);
        yield* prepare.authorize(registry, env, { ...input, threadId: undefined });
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
            permissions: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
          }),
        );
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(true);
        yield* prepare.authorize(registry, env, input);
      }),
    ),
);

it.effect("honors exact empty permissions and preserves legacy parent grants", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
      registry.set(sessions(env), AsyncResult.success({ ...grant(true), permissions: [] }));
      expect(registry.get(git.permissionAtom(env))).toBe(false);
      const denied = yield* git.authorize(registry, env).pipe(Effect.flip);
      expect(denied).toMatchObject({
        requiredPermission: AuthSourceControlWriteScope,
        requiredScope: AuthOrchestrationOperateScope,
      });
      const { permissions: _exact, ...legacy } = grant(true);
      registry.set(sessions(env), AsyncResult.success(legacy));
      expect(registry.get(git.permissionAtom(env))).toBe(true);
      yield* git.authorize(registry, env);
    }),
  ),
);

it.effect("rejects protected unary and streamed RPCs outside a guarded command", () =>
  Effect.gen(function* () {
    let writes = 0;
    const session = {
      client: {
        [WS_METHODS.scheduledTasksDelete]: () =>
          Effect.sync(() => {
            writes++;
            return { id: ScheduledTaskId.make("task") };
          }),
        [WS_METHODS.gitRunStackedAction]: () =>
          Stream.fromEffect(
            Effect.sync(() => {
              writes++;
            }),
          ),
      },
    } as unknown as RpcSession;
    const supervisor = {
      target: { environmentId: env, label: "target" },
      session: yield* SubscriptionRef.make(Option.some(session)),
    } as unknown as EnvironmentSupervisor["Service"];
    const unary = yield* requestGuarded(WS_METHODS.scheduledTasksDelete, {
      id: ScheduledTaskId.make("task"),
    }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(unary._tag).toBe("EnvironmentAuthorizationError");
    const streamed = yield* runStreamGuarded(WS_METHODS.gitRunStackedAction, {
      actionId: "test-action",
      cwd: "/repo",
      action: "commit",
    }).pipe(Stream.runDrain, Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(streamed._tag).toBe("EnvironmentAuthorizationError");
    expect(writes).toBe(0);
  }),
);

it.effect("Work writes, source saves and thread starts need their own destination grants", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const update = createCommandPermissions(runtime, WS_METHODS.workItemsUpdate);
      const save = createCommandPermissions(runtime, WS_METHODS.workSourcesSave);
      const start = createCommandPermissions(runtime, WS_METHODS.workThreadsStart);
      // orchestration:operate alone starts threads but neither writes items nor saves sources.
      registry.set(sessions(env), AsyncResult.success(grant(true)));
      expect(registry.get(start.permissionAtom(env))).toBe(true);
      expect(registry.get(update.permissionAtom(env))).toBe(false);
      expect(registry.get(save.permissionAtom(env))).toBe(false);
      expect((yield* update.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
        "EnvironmentAuthorizationError",
      );
      const scopes = [AuthWorkWriteScope, AuthSettingsWriteScope];
      registry.set(
        sessions(env),
        AsyncResult.success({ ...grant(false), scopes, permissions: scopes }),
      );
      expect(registry.get(update.permissionAtom(env))).toBe(true);
      expect(registry.get(save.permissionAtom(env))).toBe(true);
      expect(registry.get(start.permissionAtom(env))).toBe(false);
      yield* update.authorize(registry, env);
      registry.set(sessions(env), AsyncResult.success(grant(false)));
      expect(registry.get(update.permissionAtom(env))).toBe(false);
    }),
  ),
);

it.effect("assistant controls recheck the destination grant after it is revoked", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const assistant = createCommandPermissions(runtime, WS_METHODS.assistantControl);
      registry.set(sessions(env), AsyncResult.success(grant(true)));
      expect(registry.get(assistant.permissionAtom(env))).toBe(true);
      yield* assistant.authorize(registry, env);
      registry.set(sessions(env), AsyncResult.success(grant(false)));
      expect(registry.get(assistant.permissionAtom(env))).toBe(false);
      expect((yield* assistant.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
        "EnvironmentAuthorizationError",
      );
    }),
  ),
);

const factoryServer = (capabilities: object) =>
  ({ environment: { capabilities } }) as unknown as ServerConfig;
const FACTORY_SERVER = factoryServer({ factory: { version: 1 } });
const isUnavailable = Schema.is(EnvironmentRpcUnavailableError);

/**
 * Factory's commands against a fake destination that records each method reaching it. Its server
 * advertises Factory, in this client's view and in its session's config, until changed.
 */
const makeFactoryCommands = Effect.fn("TestFactoryCommands.make")(function* (
  registry: AtomRegistry.AtomRegistry,
) {
  const sent: Array<string> = [];
  // While set, a resume waits after reaching the server, holding its delivery's lane.
  let hold:
    | { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
    | undefined;
  const reply = (method: string) => () =>
    Effect.gen(function* () {
      sent.push(method);
      if (method === WS_METHODS.factoryDeliveriesResume && hold !== undefined) {
        yield* Deferred.succeed(hold.entered, undefined);
        yield* Deferred.await(hold.release);
      }
      return {};
    });
  const methods = [
    WS_METHODS.factoryDeliveriesStart,
    WS_METHODS.factoryDeliveriesStop,
    WS_METHODS.factoryDeliveriesResume,
    WS_METHODS.factoryDeliveriesCancel,
    WS_METHODS.factorySettingsSet,
  ];
  const client = Object.fromEntries(methods.map((method) => [method, reply(method)]));
  const sessionTo = (serverConfig: ServerConfig) =>
    ({ client, initialConfig: Effect.succeed(serverConfig) }) as unknown as RpcSession;
  const session = yield* SubscriptionRef.make(Option.some(sessionTo(FACTORY_SERVER)));
  const supervisor = {
    target: { environmentId: env, label: "target" },
    session,
  } as unknown as EnvironmentSupervisor["Service"];
  const serverConfigs = Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(
    new Map([[env, FACTORY_SERVER]]),
  ).pipe(Atom.keepAlive);
  const factory = createFactoryEnvironmentAtoms(
    Atom.runtime(
      Layer.succeed(EnvironmentRegistry, {
        run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) =>
          Effect.provideService(effect, EnvironmentSupervisor, supervisor),
      } as unknown as EnvironmentRegistry["Service"]),
    ),
    serverConfigs,
  );
  const ref = { deliveryId: FactoryDeliveryId.make("d1") };
  const itemRef = {
    sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
    itemId: WorkItemId.make("fd-7k3qa2"),
  };
  const commands = {
    start: {
      permission: factory.start.permissionAtom(env),
      run: () => factory.start.run(registry, { environmentId: env, input: { itemRef } }),
    },
    stop: {
      permission: factory.stop.permissionAtom(env),
      run: () => factory.stop.run(registry, { environmentId: env, input: ref }),
    },
    resume: {
      permission: factory.resume.permissionAtom(env),
      run: () => factory.resume.run(registry, { environmentId: env, input: ref }),
    },
    cancel: {
      permission: factory.cancel.permissionAtom(env),
      run: () => factory.cancel.run(registry, { environmentId: env, input: ref }),
    },
    setSettings: {
      permission: factory.setSettings.permissionAtom(env),
      run: () =>
        factory.setSettings.run(registry, {
          environmentId: env,
          input: { projectId: ProjectId.make("p1"), settings: factorySettings },
        }),
    },
  };
  const outcome = (result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Success") return "sent";
    const failure = Cause.squash(result.cause);
    return isAuthorizationError(failure)
      ? "denied"
      : isUnavailable(failure)
        ? "unsupported"
        : "failed";
  };
  return {
    sent,
    methods,
    commands,
    controls: [commands.start, commands.stop, commands.resume, commands.cancel],
    outcome,
    runAll: (
      selected: ReadonlyArray<{ readonly run: () => Promise<AtomCommandResult<unknown, unknown>> }>,
    ) =>
      Effect.forEach(selected, (command) => Effect.promise(command.run).pipe(Effect.map(outcome))),
    permitted: (selected: ReadonlyArray<{ readonly permission: Atom.Atom<boolean> }>) =>
      selected.map((command) => registry.get(command.permission)),
    allow: (
      scopes: ReadonlyArray<typeof AuthOrchestrationOperateScope | typeof AuthSettingsWriteScope>,
    ) =>
      registry.set(
        sessions(env),
        AsyncResult.success({ ...grant(false), scopes: [...scopes], permissions: [...scopes] }),
      ),
    /** This client's view of the destination's config; undefined before it arrives. */
    viewConfig: (serverConfig: ServerConfig | undefined) =>
      registry.set(
        serverConfigs,
        new Map(serverConfig === undefined ? [] : [[env, serverConfig] as const]),
      ),
    reconnect: (serverConfig: ServerConfig) =>
      SubscriptionRef.set(session, Option.some(sessionTo(serverConfig))),
    /** Holds the next resume on the server until the returned release runs. */
    holdResume: Effect.gen(function* () {
      const held = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
      hold = held;
      return held;
    }),
  };
});

it.effect(
  "Factory delivery controls and settings writes need their grants, rechecked when they run",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const factory = yield* makeFactoryCommands(registry);
        const all = Object.values(factory.commands);

        factory.allow([]);
        expect(factory.permitted(all)).toEqual([false, false, false, false, false]);
        expect(yield* factory.runAll(all)).toEqual(Array(5).fill("denied"));
        expect(factory.sent).toEqual([]);

        // orchestration:operate runs the delivery controls but does not write settings.
        factory.allow([AuthOrchestrationOperateScope]);
        expect(factory.permitted(factory.controls)).toEqual([true, true, true, true]);
        expect(factory.permitted([factory.commands.setSettings])).toEqual([false]);
        expect(yield* factory.runAll([...factory.controls, factory.commands.setSettings])).toEqual([
          "sent",
          "sent",
          "sent",
          "sent",
          "denied",
        ]);
        expect(factory.sent).toEqual(factory.methods.slice(0, 4));

        // settings:write saves settings but does not run the controls.
        factory.sent.length = 0;
        factory.allow([AuthSettingsWriteScope]);
        expect(factory.permitted([factory.commands.setSettings, factory.commands.stop])).toEqual([
          true,
          false,
        ]);
        expect(
          yield* factory.runAll([factory.commands.setSettings, factory.commands.stop]),
        ).toEqual(["sent", "denied"]);
        expect(factory.sent).toEqual([WS_METHODS.factorySettingsSet]);

        // A cancel queued behind a resume of the same delivery is rechecked when its turn comes.
        factory.sent.length = 0;
        factory.allow([AuthOrchestrationOperateScope, AuthSettingsWriteScope]);
        const held = yield* factory.holdResume;
        const resumed = factory.commands.resume.run();
        yield* Deferred.await(held.entered);
        const cancelled = factory.commands.cancel.run();
        expect(factory.permitted([factory.commands.cancel])).toEqual([true]);
        factory.allow([]);
        expect(factory.permitted([factory.commands.cancel])).toEqual([false]);
        yield* Deferred.succeed(held.release, undefined);
        expect(factory.outcome(yield* Effect.promise(() => resumed))).toBe("sent");
        expect(factory.outcome(yield* Effect.promise(() => cancelled))).toBe("denied");
        expect(factory.sent).toEqual([WS_METHODS.factoryDeliveriesResume]);
      }),
    ),
);

it.effect(
  "Factory commands send nothing where the destination does not advertise Factory, grants held",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const factory = yield* makeFactoryCommands(registry);
        const all = Object.values(factory.commands);
        factory.allow([AuthOrchestrationOperateScope, AuthSettingsWriteScope]);
        expect(factory.permitted(all)).toEqual([true, true, true, true, true]);

        // Before the destination's config arrives, and from a server that predates Factory.
        for (const viewed of [undefined, factoryServer({})]) {
          factory.viewConfig(viewed);
          expect(factory.permitted(all)).toEqual([false, false, false, false, false]);
          expect(yield* factory.runAll(all)).toEqual(Array(5).fill("unsupported"));
        }
        expect(factory.sent).toEqual([]);

        // A cancel queued behind a resume of the same delivery is checked again when it runs.
        factory.viewConfig(FACTORY_SERVER);
        const held = yield* factory.holdResume;
        const resumed = factory.commands.resume.run();
        yield* Deferred.await(held.entered);
        const cancelled = factory.commands.cancel.run();
        factory.viewConfig(factoryServer({}));
        expect(factory.permitted([factory.commands.cancel])).toEqual([false]);
        yield* Deferred.succeed(held.release, undefined);
        expect(factory.outcome(yield* Effect.promise(() => resumed))).toBe("sent");
        expect(factory.outcome(yield* Effect.promise(() => cancelled))).toBe("unsupported");
        expect(factory.sent).toEqual([WS_METHODS.factoryDeliveriesResume]);

        // Reconnected to an older server, before its config replaces the one this client holds.
        factory.sent.length = 0;
        factory.viewConfig(FACTORY_SERVER);
        yield* factory.reconnect(factoryServer({}));
        expect(yield* factory.runAll(all)).toEqual(Array(5).fill("unsupported"));
        expect(factory.sent).toEqual([]);
        yield* factory.reconnect(FACTORY_SERVER);
        expect(yield* factory.runAll([factory.commands.stop])).toEqual(["sent"]);
      }),
    ),
);
