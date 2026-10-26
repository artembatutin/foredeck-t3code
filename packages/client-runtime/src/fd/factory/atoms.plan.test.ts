import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  EnvironmentId,
  type ServerConfig,
  WS_METHODS,
} from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryTaskId } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { EnvironmentRegistry } from "../../connection/registry.ts";
import { EnvironmentSupervisor } from "../../connection/supervisor.ts";
import { EnvironmentRpcUnavailableError } from "../../rpc/client.ts";
import type { RpcSession } from "../../rpc/session.ts";
import type { AtomCommandResult } from "../../state/runtime.ts";
import { createFactoryEnvironmentAtoms } from "./index.ts";

// The destination's grants, read by every command's permission check.
vi.mock("../../state/session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: () => grants }),
}));
const grants = Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(
  AsyncResult.initial(),
).pipe(Atom.keepAlive);
const grant = (scopes: ReadonlyArray<typeof AuthOrchestrationOperateScope>): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [...scopes],
  permissions: [...scopes],
});

const env = EnvironmentId.make("target");
const server = (capabilities: object) =>
  ({ environment: { capabilities } }) as unknown as ServerConfig;
/** A version-1 server from before planning, and one that plans. */
const BEFORE_PLANNING = server({ factory: { version: 1 } });
const PLANNING = server({ factory: { version: 1, planning: true } });
const PLANNING_UNSUPPORTED =
  "target does not offer Factory planning. Update its server to plan deliveries.";

const deliveryId = FactoryDeliveryId.make("d1");
const itemRef = {
  sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
  itemId: WorkItemId.make("fd-7k3qa2"),
};
const plan = {
  tasks: [
    {
      id: FactoryTaskId.make("export-csv"),
      title: "Export CSV",
      kind: "feature",
      summary: "Adds the export.",
      acceptance: ["It exports."],
      testPlan: [{ criterion: 1, check: "A test exports.", paths: ["src/export.test.ts"] }],
      likelyPaths: ["src/export.ts"],
      risk: "normal",
    },
  ],
};

const isUnavailable = Schema.is(EnvironmentRpcUnavailableError);
const isAuthorization = (failure: unknown) =>
  typeof failure === "object" &&
  failure !== null &&
  (failure as { readonly _tag?: unknown })._tag === "EnvironmentAuthorizationError";

/**
 * Factory's plan commands and starts against a fake destination that records each request
 * reaching it as `[method, payload]`. The client's view of the server's config and the config of
 * the session carrying requests are set apart, as a reconnect sets them apart.
 */
const makeDestination = Effect.fn("TestFactoryPlanCommands.make")(function* () {
  const registry = AtomRegistry.make();
  registry.mount(grants);
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  registry.set(grants, AsyncResult.success(grant([AuthOrchestrationOperateScope])));

  const sent: Array<readonly [string, unknown]> = [];
  // While set for a method, its next request waits after reaching the server, holding its lane.
  const holds = new Map<
    string,
    { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
  >();
  const reply = (method: string) => (payload: unknown) =>
    Effect.gen(function* () {
      sent.push([method, payload]);
      const hold = holds.get(method);
      if (hold !== undefined) {
        holds.delete(method);
        yield* Deferred.succeed(hold.entered, undefined);
        yield* Deferred.await(hold.release);
      }
      return {};
    });
  const client = Object.fromEntries(
    [
      WS_METHODS.factoryDeliveriesStart,
      WS_METHODS.factoryPlanUpdate,
      WS_METHODS.factoryPlanApprove,
      WS_METHODS.factoryPlanReject,
      WS_METHODS.factoryPlanReplan,
    ].map((method) => [method, reply(method)]),
  );
  const sessionTo = (serverConfig: ServerConfig) =>
    ({ client, initialConfig: Effect.succeed(serverConfig) }) as unknown as RpcSession;
  const session = yield* SubscriptionRef.make(Option.some(sessionTo(PLANNING)));
  const supervisor = {
    target: { environmentId: env, label: "target" },
    session,
  } as unknown as EnvironmentSupervisor["Service"];
  const serverConfigs = Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(
    new Map([[env, PLANNING]]),
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
  const ref = { deliveryId };
  const run =
    <I, A, E>(command: {
      readonly run: (
        registry: AtomRegistry.AtomRegistry,
        target: { readonly environmentId: EnvironmentId; readonly input: I },
      ) => Promise<AtomCommandResult<A, E>>;
    }) =>
    (input: I) =>
    () =>
      command.run(registry, { environmentId: env, input });
  const commands = {
    parentStart: run(factory.start)({ itemRef, kind: "parent" }),
    updatePlan: run(factory.updatePlan)({ deliveryId, plan }),
    approvePlan: run(factory.approvePlan)(ref),
    rejectPlan: run(factory.rejectPlan)(ref),
    replan: run(factory.replan)({ deliveryId, note: "Split the export." }),
  };
  /** What a command came to: sent, denied its grant, or refused unsent as unsupported. */
  const outcome = (result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Success") return "sent";
    const failure = Cause.squash(result.cause);
    if (isAuthorization(failure)) return "denied";
    if (!isUnavailable(failure)) return "failed";
    expect(failure.message).toBe(PLANNING_UNSUPPORTED);
    return "unsupported";
  };
  return {
    factory,
    registry,
    sent,
    commands,
    singleStart: run(factory.start)({ itemRef }),
    outcome,
    runAll: (selected: ReadonlyArray<() => Promise<AtomCommandResult<unknown, unknown>>>) =>
      Effect.forEach(selected, (command) => Effect.promise(command).pipe(Effect.map(outcome))),
    /** Whether each plan command and the planning view are offered now. */
    offered: () => [
      registry.get(factory.planning(env)),
      ...[factory.updatePlan, factory.approvePlan, factory.rejectPlan, factory.replan].map(
        (command) => registry.get(command.permissionAtom(env)),
      ),
    ],
    /** This client's view of the destination's config. */
    view: (serverConfig: ServerConfig) =>
      registry.set(serverConfigs, new Map([[env, serverConfig]])),
    reconnect: (serverConfig: ServerConfig) =>
      SubscriptionRef.set(session, Option.some(sessionTo(serverConfig))),
    allow: (scopes: ReadonlyArray<typeof AuthOrchestrationOperateScope>) =>
      registry.set(grants, AsyncResult.success(grant(scopes))),
    /** Holds the next request of `method` on the server until released. */
    hold: (method: string) =>
      Effect.gen(function* () {
        const held = {
          entered: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        holds.set(method, held);
        return held;
      }),
  };
});

describe("Factory planning commands", () => {
  it.effect("send the parent start and each plan action once where planning is served", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const destination = yield* makeDestination();
        expect(destination.offered()).toEqual([true, true, true, true, true]);
        expect(yield* destination.runAll(Object.values(destination.commands))).toEqual(
          Array(5).fill("sent"),
        );
        expect(destination.sent).toEqual([
          [WS_METHODS.factoryDeliveriesStart, { itemRef, kind: "parent" }],
          [WS_METHODS.factoryPlanUpdate, { deliveryId, plan }],
          [WS_METHODS.factoryPlanApprove, { deliveryId }],
          [WS_METHODS.factoryPlanReject, { deliveryId }],
          [WS_METHODS.factoryPlanReplan, { deliveryId, note: "Split the export." }],
        ]);
      }),
    ),
  );

  it.effect(
    "fail unsent on a version-1 server without planning, where a single start still goes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const destination = yield* makeDestination();
          destination.view(BEFORE_PLANNING);
          yield* destination.reconnect(BEFORE_PLANNING);
          expect(destination.offered()).toEqual([false, false, false, false, false]);
          expect(destination.registry.get(destination.factory.supported(env))).toBe(true);
          expect(destination.registry.get(destination.factory.start.permissionAtom(env))).toBe(
            true,
          );
          expect(yield* destination.runAll(Object.values(destination.commands))).toEqual(
            Array(5).fill("unsupported"),
          );
          expect(destination.sent).toEqual([]);

          expect(yield* destination.runAll([destination.singleStart])).toEqual(["sent"]);
          expect(destination.sent).toEqual([[WS_METHODS.factoryDeliveriesStart, { itemRef }]]);
        }),
      ),
  );

  it.effect("fail unsent over a session to an older server while the view still plans", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const destination = yield* makeDestination();
        // Reconnected to a server from before planning, before its config replaces this view's.
        yield* destination.reconnect(BEFORE_PLANNING);
        expect(destination.offered()).toEqual([true, true, true, true, true]);
        expect(yield* destination.runAll(Object.values(destination.commands))).toEqual(
          Array(5).fill("unsupported"),
        );
        expect(destination.sent).toEqual([]);
        expect(yield* destination.runAll([destination.singleStart])).toEqual(["sent"]);

        destination.sent.length = 0;
        yield* destination.reconnect(PLANNING);
        expect(yield* destination.runAll([destination.commands.approvePlan])).toEqual(["sent"]);
        expect(destination.sent).toEqual([[WS_METHODS.factoryPlanApprove, { deliveryId }]]);
      }),
    ),
  );

  it.effect("check planning again when a queued command's turn comes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const destination = yield* makeDestination();
        const { commands } = destination;

        // Plan actions queued behind an edit of the same delivery, then planning withdrawn.
        const editing = yield* destination.hold(WS_METHODS.factoryPlanUpdate);
        const edited = commands.updatePlan();
        yield* Deferred.await(editing.entered);
        const queued = [commands.approvePlan(), commands.rejectPlan(), commands.replan()];
        destination.view(BEFORE_PLANNING);
        expect(destination.offered()).toEqual([false, false, false, false, false]);
        yield* Deferred.succeed(editing.release, undefined);
        expect(destination.outcome(yield* Effect.promise(() => edited))).toBe("sent");
        const outcomes = yield* Effect.promise(() => Promise.all(queued));
        expect(outcomes.map(destination.outcome)).toEqual(Array(3).fill("unsupported"));
        expect(destination.sent.map(([method]) => method)).toEqual([WS_METHODS.factoryPlanUpdate]);

        // A parent start queued behind a single start of the item, then a reconnect to an older
        // server: the parent start never goes out, as a parent or as a single start.
        destination.sent.length = 0;
        destination.view(PLANNING);
        const starting = yield* destination.hold(WS_METHODS.factoryDeliveriesStart);
        const single = destination.singleStart();
        yield* Deferred.await(starting.entered);
        const parent = commands.parentStart();
        yield* destination.reconnect(BEFORE_PLANNING);
        yield* Deferred.succeed(starting.release, undefined);
        expect(destination.outcome(yield* Effect.promise(() => single))).toBe("sent");
        expect(destination.outcome(yield* Effect.promise(() => parent))).toBe("unsupported");
        expect(destination.sent).toEqual([[WS_METHODS.factoryDeliveriesStart, { itemRef }]]);
      }),
    ),
  );

  it.effect("need the operate grant, checked when they run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const destination = yield* makeDestination();
        destination.allow([]);
        expect(destination.offered()).toEqual([true, false, false, false, false]);
        expect(yield* destination.runAll(Object.values(destination.commands))).toEqual(
          Array(5).fill("denied"),
        );
        expect(destination.sent).toEqual([]);
      }),
    ),
  );
});
