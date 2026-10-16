import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { DEFAULT_DEVIN_SETTINGS, DevinSettings } from "../devin/index.ts";
import * as AcpRegistrySupport from "../../server/AcpRegistrySupport.ts";
import { AcpRegistryDriver } from "../../server/driver.ts";
import { AcpRegistryAdapterV2Driver } from "../../server/adapter.ts";
import { DevinDriver, prepareDevinEnvironment, readDevinVersion } from "./index.ts";
import { readDevinModels } from "./models.ts";

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
      inspect: () =>
        Effect.succeed({ status: "missing_runner", version: null, distribution: "local" } as const),
      resolve: () => Effect.die("A disabled provider must not resolve an ACP launch"),
    }),
  ),
);

describe("Devin CLI configuration", () => {
  it("leaves the generic registry's schema defaults unchanged", () => {
    expect(AcpRegistryAdapterV2Driver.defaultConfig()).toEqual({
      source: "registry",
      commandArgs: [],
      enabled: true,
      agentId: "",
      commandPath: "",
      authMethodId: "",
      distribution: "auto",
      customModels: [],
    });
    expect(AcpRegistryDriver.defaultConfig()).toEqual(AcpRegistryAdapterV2Driver.defaultConfig());
    expect(AcpRegistryDriver.driverKind).toBe("acpRegistry");
  });
  it("launches the documented ACP subcommand and rejects generic agent overrides", () => {
    const decode = Schema.decodeUnknownSync(DevinSettings);
    expect(DEFAULT_DEVIN_SETTINGS).toMatchObject({
      source: "local",
      agentId: "devin",
      commandPath: "devin",
      commandArgs: ["acp"],
    });
    expect(decode({ commandPath: "/opt/devin", authMethodId: "api-key" }).commandPath).toBe(
      "/opt/devin",
    );
    expect(() => decode({ source: "registry" })).toThrow();
    expect(() => decode({ agentId: "another-agent" })).toThrow();
    expect(() => decode({ commandArgs: ["--cloud"] })).toThrow();
  });

  it("blocks ambient API keys while retaining explicitly configured credentials", () => {
    expect(
      prepareDevinEnvironment({ WINDSURF_API_KEY: "ambient-credential", PATH: "/bin" }, []),
    ).toEqual({ WINDSURF_API_KEY: undefined, PATH: "/bin" });
    const explicit = [{ name: "WINDSURF_API_KEY", value: "instance-credential", sensitive: true }];
    const environment = { WINDSURF_API_KEY: "instance-credential" };
    expect(prepareDevinEnvironment(environment, explicit)).toBe(environment);
  });
});

it.layer(layerTest)("DevinDriver", (it) => {
  it.effect("discovers priced reasoning variants before opening an ACP session", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "local-agent-models-" });
      const commandPath = writeFakeCli({
        directory,
        name: "devin",
        source: `
          const args = process.argv.slice(2).join(' ');
          if (args === 'version') { process.stdout.write('devin 3000.6.14'); }
          else if (args === 'models list --format json') {
            if (process.env.WINDSURF_API_KEY) process.exit(13);
            process.stdout.write(JSON.stringify({families:[{variants:[
              {model_uid:'native-low',label:'Native Low Thinking',cost_summary:'3 credits / message',max_context_tokens:200000,max_output_tokens:64000},
              {model_uid:'native-high',label:'Native High Thinking',cost_summary:'8 credits / message',is_new:true},
              {model_uid:'native-high',label:'Duplicate'},
              {model_uid:' bad-id ',label:'Invalid'}
            ]}]}));
          } else { process.exit(12); }
        `,
      });
      const instance = yield* DevinDriver.create({
        instanceId: ProviderInstanceId.make("native-catalog-test"),
        enabled: true,
        displayName: undefined,
        accentColor: undefined,
        environment: [],
        config: { ...DEFAULT_DEVIN_SETTINGS, commandPath },
      }).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          AcpRegistrySupport.AcpRegistryCatalog.of({
            ...(yield* AcpRegistrySupport.AcpRegistryCatalog),
            inspect: () =>
              Effect.succeed({
                status: "ready",
                agentId: "devin",
                version: null,
                distribution: "local",
              } as const),
          }),
        ),
      );
      const snapshot = yield* instance.snapshot.getSnapshot;
      expect(snapshot.models.map(({ slug, name }) => ({ slug, name }))).toEqual([
        { slug: "native-low", name: "Native Low Thinking" },
        { slug: "native-high", name: "Native High Thinking" },
        { slug: "default", name: "Default" },
      ]);
      expect(snapshot.models[0]).toMatchObject({
        costSummary: "3 credits / message",
        contextWindow: 200000,
        maxOutputTokens: 64000,
      });
      expect(snapshot.models[1]?.badge).toBe("new");
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("3000.6.14");
    }).pipe(Effect.scoped),
  );

  it.effect("tolerates old CLI commands and invalid or empty catalog output", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "local-agent-model-fallback-",
      });
      for (const source of [
        "process.stderr.write('unsupported command'); process.exit(2)",
        "process.stdout.write('not json')",
        "process.stdout.write(JSON.stringify({families:[{variants:[{model_uid:'partial',label:'Partial'}]}]})); process.exit(2)",

        "process.stdout.write(JSON.stringify({families:[{variants:[{model_uid:42,label:'bad'}]}]}))",
      ]) {
        const commandPath = writeFakeCli({ directory, name: "devin", source });
        expect(
          yield* readDevinModels({ ...DEFAULT_DEVIN_SETTINGS, commandPath }, process.env),
        ).toBeNull();
      }
      const empty = writeFakeCli({
        directory,
        name: "devin",
        source: "process.stdout.write(JSON.stringify({families:[]}))",
      });
      expect(
        yield* readDevinModels({ ...DEFAULT_DEVIN_SETTINGS, commandPath: empty }, process.env),
      ).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "reads the installed build with the read-only version command and tolerates unknown output",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "local-agent-version-" });
        const commandPath = writeFakeCli({
          directory,
          name: "devin",
          source:
            "if (process.argv.slice(2).join(' ') !== 'version') process.exit(12); process.stdout.write('devin 3000.6.14 (18033302)\\n');",
        });
        expect(
          yield* readDevinVersion({ ...DEFAULT_DEVIN_SETTINGS, commandPath }, process.env),
        ).toBe("3000.6.14");
        writeFakeCli({
          directory,
          name: "devin",
          source: "process.stdout.write('unknown build');",
        });
        expect(
          yield* readDevinVersion({ ...DEFAULT_DEVIN_SETTINGS, commandPath }, process.env),
        ).toBeNull();
      }).pipe(Effect.scoped),
  );

  it.effect(
    "retains dedicated identity, account management, and opt-in behavior without launching a process",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("devin-personal");
        const instance = yield* DevinDriver.create({
          instanceId,
          displayName: "Personal local agent",
          accentColor: "#9c6512",
          enabled: false,
          environment: [],
          config: DEFAULT_DEVIN_SETTINGS,
        });
        const snapshot = yield* instance.snapshot.getSnapshot;
        expect(DevinDriver.metadata.hasDefaultInstance).toBe(false);
        expect(instance.driverKind).toBe("devin");
        expect(instance.orchestrationAdapter?.driver).toBe("devin");
        if (instance.orchestrationAdapter) {
          expect(
            (yield* instance.orchestrationAdapter.getCapabilities()).subagents.supportsSubagents,
          ).toBe(true);
        }
        expect(instance.auth).toBeDefined();
        expect(instance.acpSessionManagement).toBeDefined();
        expect(snapshot).toMatchObject({
          instanceId,
          driver: "devin",
          displayName: "Personal local agent",
          accentColor: "#9c6512",
          enabled: false,
          status: "disabled",
          showInteractionModeToggle: false,
          supportsTextGeneration: false,
          continuation: { groupKey: "devin:instance:devin-personal" },
          models: [{ slug: "default", isDefault: true }],
        });
        expect((yield* instance.snapshot.resolveMaintenance()).provider).toBe("devin");
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("A disabled provider must not spawn")),
        ),
        Effect.scoped,
      ),
  );
});
