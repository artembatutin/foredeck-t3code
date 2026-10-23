import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import { FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as Factory from "./index.ts";
import { FactoryStoreError } from "./persistence/errors.ts";
import * as FactorySettingsStore from "./persistence/FactorySettingsStore.ts";

const { FactorySettings } = Factory;

const live = FactorySettings.layer.pipe(
  Layer.provideMerge(Factory.layerPersistence),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const alpha = ProjectId.make("project-alpha");

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);
const verifiable = decodeSettings({
  verifyCommand: { executable: "vp", args: ["test", "run"] },
  setupCommand: { executable: "vp", args: ["i"] },
  roles: { reviewer: { instanceId: "codex", model: "gpt-6-astra" } },
  limits: { maxFixRounds: 3, maxReviewRounds: 1, verifyTimeoutMinutes: 45 },
  blockingSeverities: ["high", "medium"],
  highRiskEffort: "high",
});
const withoutVerify = decodeSettings({ setupCommand: { executable: "vp", args: ["i"] } });

const settingsRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM fd_factory_settings
  `;
  return rows[0]?.count;
});

describe("FactorySettings", () => {
  it.effect("returns the defaults without writing, then the stored settings", () =>
    Effect.gen(function* () {
      const settings = yield* FactorySettings.FactorySettings;
      assert.deepStrictEqual(yield* settings.get(alpha), {
        verifyCommand: null,
        setupCommand: null,
        roles: { planner: null, author: null, reviewer: null },
        limits: { maxFixRounds: 2, maxReviewRounds: 2, verifyTimeoutMinutes: 30 },
        blockingSeverities: ["high"],
        highRiskEffort: "xhigh",
        pipelineId: "standard",
      });
      assert.strictEqual(yield* settingsRows, 0);

      const store = yield* FactorySettingsStore.FactorySettingsStore;
      yield* store.set(alpha, verifiable);
      assert.deepStrictEqual(yield* settings.get(alpha), verifiable);
    }).pipe(Effect.provide(live)),
  );

  it.effect("replaces settings and refuses a pipeline this server does not ship", () =>
    Effect.gen(function* () {
      const settings = yield* FactorySettings.FactorySettings;
      yield* settings.set(alpha, withoutVerify);
      yield* settings.set(alpha, verifiable);
      assert.deepStrictEqual(yield* settings.get(alpha), verifiable);

      const error = yield* Effect.flip(
        settings.set(alpha, { ...withoutVerify, pipelineId: "custom" }),
      );
      assert.strictEqual(error._tag, "FactoryUnknownPipelineError");
      assert.include(error.message, "'custom'");
      assert.deepStrictEqual(yield* settings.get(alpha), verifiable);
    }).pipe(Effect.provide(live)),
  );

  it.effect("requires a verify command before a delivery", () =>
    Effect.gen(function* () {
      const settings = yield* FactorySettings.FactorySettings;
      const expectMissing = Effect.gen(function* () {
        const error = yield* Effect.flip(settings.requireDeliverySettings(alpha));
        assert.strictEqual(error._tag, "FactoryVerifyCommandMissingError");
        assert.match(error.message, /^Set a verify command/);
      });

      yield* expectMissing;
      yield* settings.set(alpha, withoutVerify);
      yield* expectMissing;

      yield* settings.set(alpha, verifiable);
      assert.deepStrictEqual(yield* settings.requireDeliverySettings(alpha), verifiable);
    }).pipe(Effect.provide(live)),
  );

  it.effect("reports store failures without the cause's text", () => {
    const secret = "disk I/O error at /private/secret-path";
    const failing = Layer.succeed(
      FactorySettingsStore.FactorySettingsStore,
      FactorySettingsStore.FactorySettingsStore.of({
        get: () =>
          Effect.fail(
            new FactoryStoreError({ operation: "settings.get", cause: new Error(secret) }),
          ),
        set: () =>
          Effect.fail(
            new FactoryStoreError({ operation: "settings.set", cause: new Error(secret) }),
          ),
      }),
    );
    return Effect.gen(function* () {
      const settings = yield* FactorySettings.FactorySettings;
      const failures = [
        yield* Effect.flip(settings.get(alpha)),
        yield* Effect.flip(settings.requireDeliverySettings(alpha)),
        yield* Effect.flip(settings.set(alpha, verifiable)),
      ];
      for (const error of failures) {
        assert.strictEqual(error._tag, "FactorySettingsStorageError");
        assert.include(error.message, alpha);
        assert.notInclude(error.message, secret);
      }
      assert.deepStrictEqual(
        failures.map((error) =>
          error._tag === "FactorySettingsStorageError" ? error.operation : null,
        ),
        ["get", "get", "set"],
      );
    }).pipe(Effect.provide(FactorySettings.layer.pipe(Layer.provide(failing))));
  });
});
