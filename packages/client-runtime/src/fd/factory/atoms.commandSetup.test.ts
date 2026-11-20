import { describe, expect, it } from "@effect/vitest";
import {
  AuthSettingsWriteScope,
  type AuthSessionState,
  EnvironmentId,
  ProjectId,
  type ServerConfig,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { EnvironmentRegistry } from "../../connection/registry.ts";
import { EnvironmentSupervisor } from "../../connection/supervisor.ts";
import type { RpcSession } from "../../rpc/session.ts";
import { createFactoryEnvironmentAtoms } from "./index.ts";

// The destination's grants, read by every command's permission check.
vi.mock("../../state/session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: () => grants }),
}));
const grants = Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(
  AsyncResult.initial(),
).pipe(Atom.keepAlive);
const held = (scopes: ReadonlyArray<typeof AuthSettingsWriteScope>): AuthSessionState => ({
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
const projectId = ProjectId.make("project-alpha");
const command = { executable: "pnpm", args: ["run", "test"] };
const server = (factory: object) =>
  ({ environment: { capabilities: { factory } } }) as unknown as ServerConfig;
const SERVED = server({ version: 1, planning: true, commandSetup: true });
const OLDER = server({ version: 1, planning: true });

/** The commands against a fake destination recording each request reaching it. */
const destination = (config: ServerConfig, scopes: ReadonlyArray<typeof AuthSettingsWriteScope>) =>
  Effect.gen(function* () {
    const registry = AtomRegistry.make();
    registry.mount(grants);
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
    registry.set(grants, AsyncResult.success(held(scopes)));
    const sent: Array<readonly [string, unknown]> = [];
    const reply = (method: string) => (payload: unknown) =>
      Effect.sync(() => {
        sent.push([method, payload]);
        return {};
      });
    const client = Object.fromEntries(
      [WS_METHODS.factoryCommandsDiscover, WS_METHODS.factoryCommandsValidate].map((method) => [
        method,
        reply(method),
      ]),
    );
    const session = yield* SubscriptionRef.make(
      Option.some({ client, initialConfig: Effect.succeed(config) } as unknown as RpcSession),
    );
    const supervisor = {
      target: { environmentId: env, label: "target" },
      session,
    } as unknown as EnvironmentSupervisor["Service"];
    const factory = createFactoryEnvironmentAtoms(
      Atom.runtime(
        Layer.succeed(EnvironmentRegistry, {
          run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) =>
            Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        } as unknown as EnvironmentRegistry["Service"]),
      ),
      Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(new Map([[env, config]])).pipe(
        Atom.keepAlive,
      ),
    );
    return {
      sent,
      offered: () => [
        registry.get(factory.discoverCommands.permissionAtom(env)),
        registry.get(factory.validateCommand.permissionAtom(env)),
      ],
      runAll: Effect.all(
        [
          Effect.exit(
            factory.discoverCommands.run(registry, { environmentId: env, input: { projectId } }),
          ),
          Effect.exit(
            factory.validateCommand.run(registry, {
              environmentId: env,
              input: { projectId, command },
            }),
          ),
        ],
        { concurrency: "unbounded" },
      ),
    };
  });

describe("Factory command setup commands", () => {
  it.effect("reach a server that serves them, for a session holding settings:write", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const target = yield* destination(SERVED, [AuthSettingsWriteScope]);
        expect(target.offered()).toEqual([true, true]);
        const results = yield* target.runAll;
        expect(results.map(({ _tag }) => _tag)).toEqual(["Success", "Success"]);
        expect(target.sent).toEqual([
          [WS_METHODS.factoryCommandsDiscover, { projectId }],
          [WS_METHODS.factoryCommandsValidate, { projectId, command }],
        ]);
      }),
    ),
  );

  it.effect("are not offered, and fail unsent, on a server from before them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const target = yield* destination(OLDER, [AuthSettingsWriteScope]);
        expect(target.offered()).toEqual([false, false]);
        const results = yield* target.runAll;
        expect(target.sent).toEqual([]);
        for (const result of results) {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(String(Cause.squash(result.cause))).toContain(
              "target does not offer Factory command setup",
            );
          }
        }
      }),
    ),
  );

  it.effect("are not offered, and never sent, without the settings grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const target = yield* destination(SERVED, []);
        expect(target.offered()).toEqual([false, false]);
        const results = yield* target.runAll;
        expect(results.map(({ _tag }) => _tag)).toEqual(["Failure", "Failure"]);
        expect(target.sent).toEqual([]);
      }),
    ),
  );
});
