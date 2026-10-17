import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { ProviderAdapterCapabilitiesError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { withRepositoryCapability } from "./providerSnapshot.ts";

const snapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("test"),
  driver: ProviderDriverKind.make("test"),
  status: "ready",
  enabled: true,
  installed: true,
  auth: { status: "unknown" },
  checkedAt: "2026-10-16T00:00:00.000Z",
  version: null,
  models: [],
  slashCommands: [],
  skills: [],
};
it.effect(
  "advertises the current adapter and removes cached support after settings change or discovery failure",
  () =>
    Effect.gen(function* () {
      const supported = yield* withRepositoryCapability(
        {
          orchestrationAdapter: {
            getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          },
        },
        snapshot,
      );
      assert.deepEqual(supported.multiRepository, CodexProviderCapabilitiesV2.multiRepository);
      const unsupported = yield* withRepositoryCapability(
        {
          orchestrationAdapter: {
            getCapabilities: () =>
              Effect.succeed({ ...CodexProviderCapabilitiesV2, multiRepository: undefined }),
          },
        },
        supported,
      );
      assert.deepEqual(unsupported, snapshot);
      const failed = yield* withRepositoryCapability(
        {
          orchestrationAdapter: {
            getCapabilities: () =>
              Effect.fail(new ProviderAdapterCapabilitiesError({ driver: snapshot.driver })),
          },
        },
        supported,
      );
      assert.deepEqual(failed, snapshot);
    }),
);
