import { copilotUsageReader } from "../fd/copilot-usage/index.ts";
import {
  officialAcpRegistryIconUrlForAgentId,
  ProviderDriverKind,
  resolveOfficialAcpRegistryIconUrl,
  TextGenerationError,
  type AcpRegistryOperationError,
  type ServerProvider,
  type ServerProviderModel,
  type ProviderInstanceEnvironment,
} from "@t3tools/contracts";
import { AcpRegistrySettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { AcpRegistryAdapterV2Driver, type AcpRegistryAdapterV2DriverEnv } from "./adapter.ts";
import type { ProviderAdapterDriver } from "@t3tools/provider-core/server/adapterDriver";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { providerModelsFromSettings } from "@t3tools/provider-core/server/snapshotProbe";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import {
  type AcpRegistryAvailableCommands,
  type AcpRegistryConfigurationProbe,
  type AcpRegistryConfigurationProbeResult,
  type AcpRegistryLiveConfiguration,
  deleteAcpRegistrySession,
  disableAcpRegistryProvider,
  listAcpRegistrySessions,
  listAcpRegistryProviders,
  logoutAcpRegistry,
  probeAcpRegistryConfiguration,
  setAcpRegistryProvider,
} from "./probe.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpRegistryAuth from "./auth.ts";
import * as AcpRegistryAuthenticationState from "./authenticationState.ts";

const DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
// How long a successful discovery probe stays valid. Periodic health
// refreshes reuse it instead of spawning a fresh disposable ACP session;
// failed or unauthenticated probes are never cached so a completed sign-in
// is detected on the next refresh.
const PROBE_SUCCESS_TTL_MS = 15 * 60 * 1_000;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

const makeUnsupportedTextGeneration = (): ProviderTextGeneration => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "ACP Registry instances do not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
  };
};

function modelsFromDiscovery(
  discovery:
    | Pick<AcpRegistryLiveConfiguration, "models" | "currentModelId" | "configOptions">
    | undefined,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  const discovered = discovery?.models ?? [];
  // Discovered session config options and modes ride on every model so the
  // composer's generic option controls can drive them per thread.
  const capabilities =
    discovery === undefined || discovery.configOptions.length === 0
      ? EMPTY_CAPABILITIES
      : createModelCapabilities({ optionDescriptors: discovery.configOptions });
  const builtInModels: ReadonlyArray<ServerProviderModel> =
    discovered.length === 0
      ? [
          {
            slug: "default",
            name: "Default",
            isCustom: false,
            isDefault: true,
            capabilities,
          },
        ]
      : discovered.map((model) => ({
          slug: model.id,
          name: model.name,
          ...(model.supportsImages === undefined ? {} : { supportsImages: model.supportsImages }),
          isCustom: false,
          ...(model.id === discovery?.currentModelId ? { isDefault: true } : {}),
          capabilities,
        }));
  return providerModelsFromSettings(builtInModels, customModels, capabilities);
}

export function acpRegistrySnapshotReadiness(
  inspection:
    | AcpRegistrySupport.AcpRegistryInspection
    | { readonly status: "failed"; readonly message: string },
): Pick<ServerProvider, "installed" | "version" | "status" | "message"> {
  switch (inspection.status) {
    case "ready":
      return { installed: true, version: inspection.version, status: "ready" };
    case "unconfigured":
      return {
        installed: false,
        version: null,
        status: "warning",
        message:
          "Select an ACP Registry agent or configure a local ACP executable before starting a thread.",
      };
    case "not_found":
      return {
        installed: false,
        version: null,
        status: "error",
        message: `ACP Registry does not contain agent '${inspection.agentId}'.`,
      };
    case "unsupported":
      return {
        installed: false,
        version: inspection.version,
        status: "error",
        message: `ACP Registry agent '${inspection.agentId}' has no compatible distribution for this environment.`,
      };
    case "missing_runner":
      return {
        installed: false,
        version: inspection.version,
        status: "error",
        message:
          inspection.distribution === "local"
            ? "Local ACP executable is not available on this environment's PATH."
            : `ACP executable '${inspection.runner}' is not available on this environment's PATH.`,
      };
    case "unprepared":
      return {
        installed: false,
        version: inspection.version,
        status: "warning",
        message: `ACP Registry agent '${inspection.agentId}' has not been prepared on this environment.`,
      };
    case "failed":
      return {
        installed: false,
        version: null,
        status: "error",
        message: inspection.message,
      };
  }
}

interface SnapshotIdentity {
  readonly driverKind?: ProviderDriverKind;
  readonly instanceId: ProviderInstance["instanceId"];
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly continuationKey: string;
}

function baseSnapshot(
  input: SnapshotIdentity & {
    readonly settings: AcpRegistrySettings;
    readonly checkedAt: string;
    readonly installed: boolean;
    readonly version: string | null;
    readonly status: ServerProvider["status"];
    readonly auth: ServerProvider["auth"];
    readonly documentationUrl?: string;
    readonly message?: string;
    readonly probe?: AcpRegistryConfigurationProbeResult;
    readonly probeError?: AcpRegistryOperationError;
  },
): ServerProvider {
  const iconUrl =
    input.settings.source === "local"
      ? null
      : (resolveOfficialAcpRegistryIconUrl(input.probe?.probe.icon) ??
        officialAcpRegistryIconUrlForAgentId(input.settings.agentId));
  return {
    instanceId: input.instanceId,
    driver: input.driverKind ?? DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    continuation: { groupKey: input.continuationKey },
    // The registry driver rejects every application text-generation operation,
    // so selectors must not offer these instances for commit, PR, branch, or
    // title generation.
    supportsTextGeneration: false,
    enabled: input.settings.enabled,
    installed: input.installed,
    version: input.version,
    status: input.settings.enabled ? input.status : "disabled",
    auth: { ...input.auth, canLogout: input.auth.canLogout ?? false },
    checkedAt: input.checkedAt,
    setup: {
      canInstall: false,
      ...(input.documentationUrl ? { documentationUrl: input.documentationUrl } : {}),
      canAuthenticate:
        input.installed &&
        (input.probe
          ? input.probe.probe.authMethods.length > 0
          : input.settings.source === "local"
            ? (input.probeError?.authMethods?.length ?? 0) > 0
            : input.settings.agentId.length > 0),
    },
    ...(input.message ? { message: input.message } : {}),
    models: modelsFromDiscovery(input.probe?.probe, input.settings.customModels),
    ...(input.probe === undefined
      ? {}
      : {
          nativeSessions: {
            canList: input.probe.probe.sessionManagement.canList,
            canLoad: input.probe.probe.sessionManagement.canLoad,
            canResume: input.probe.probe.sessionManagement.canResume,
            canDelete: input.probe.probe.sessionManagement.canDelete,
          },
          configurableProviders: input.probe.probe.sessionManagement.canConfigureProviders,
        }),
    slashCommands: input.probe?.slashCommands ?? [],
    skills: input.probe?.skills ?? [],
  };
}

export function applyAcpRegistryAvailableCommands(
  provider: ServerProvider,
  commands: Option.Option<AcpRegistryAvailableCommands>,
): ServerProvider {
  return Option.match(commands, {
    onNone: () => provider,
    onSome: ({ slashCommands, skills }) => ({ ...provider, slashCommands, skills }),
  });
}

export function applyAcpRegistryLiveConfiguration(
  provider: ServerProvider,
  configuration: AcpRegistryLiveConfiguration,
  customModels: ReadonlyArray<string>,
): ServerProvider {
  const { message: _staleProbeMessage, ...snapshot } = provider;
  return {
    ...snapshot,
    status: provider.enabled ? "ready" : provider.status,
    models: modelsFromDiscovery(configuration, customModels),
  };
}

function applyAcpRegistryUrlAuthAction(
  provider: ServerProvider,
  action: Option.Option<NonNullable<ServerProvider["auth"]["action"]>>,
): ServerProvider {
  const { action: _previousAction, ...auth } = provider.auth;
  return {
    ...provider,
    auth: Option.match(action, {
      onNone: () => auth,
      onSome: (nextAction) => ({ ...auth, action: nextAction }),
    }),
  };
}

const buildInitialAcpRegistrySnapshot = Effect.fn("AcpRegistryDriver.buildInitialSnapshot")(
  function* (input: SnapshotIdentity & { readonly settings: AcpRegistrySettings }) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return baseSnapshot({
      ...input,
      checkedAt,
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: input.settings.enabled
        ? "Checking ACP Registry agent readiness..."
        : "ACP Registry is disabled in T3 Code settings.",
    });
  },
);

export function buildCheckedAcpRegistrySnapshot(
  input: SnapshotIdentity & {
    readonly settings: AcpRegistrySettings;
    readonly checkedAt: string;
    readonly inspection:
      | AcpRegistrySupport.AcpRegistryInspection
      | { readonly status: "failed"; readonly message: string };
    readonly probe?: AcpRegistryConfigurationProbeResult;
    readonly probeError?: AcpRegistryOperationError;
  },
): ServerProvider {
  const readiness = acpRegistrySnapshotReadiness(input.inspection);
  const probeFailed = input.probeError !== undefined;
  const advertisedAuthMethod =
    input.probeError?.reason === "authentication_failed"
      ? (input.probeError.authMethods?.find(
          (method) => method.id === input.settings.authMethodId,
        ) ?? input.probeError.authMethods?.[0])
      : undefined;
  const authenticationMessage = advertisedAuthMethod
    ? advertisedAuthMethod.type === "terminal" && advertisedAuthMethod.command
      ? `Sign in in provider settings using "${advertisedAuthMethod.name}". The login terminal runs on this environment.`
      : advertisedAuthMethod.type === "env_var" &&
          (advertisedAuthMethod.envVarNames?.length ?? 0) > 0
        ? `Set ${advertisedAuthMethod.envVarNames!.join(", ")} under this instance's environment variables in provider settings. T3 Code will detect it on the next provider refresh.`
        : `Sign in in provider settings using "${advertisedAuthMethod.name}".`
    : undefined;
  return baseSnapshot({
    ...input,
    ...(input.inspection.status === "ready" && input.inspection.documentationUrl
      ? { documentationUrl: input.inspection.documentationUrl }
      : {}),
    installed: readiness.installed,
    version: readiness.version,
    // A failed discovery probe on a ready installation is a warning, not an
    // outage: the agent binary is present and a real turn may still work
    // (for example after the user completes authentication).
    status: probeFailed ? "warning" : readiness.status,
    auth: input.probe
      ? {
          // Discovery sessions and an empty auth-method list do not prove sign-in.
          status: "unknown",
          canLogout: input.probe.probe.sessionManagement.canLogout,
        }
      : input.probeError?.reason === "authentication_failed"
        ? {
            status: "unauthenticated",
            ...(advertisedAuthMethod
              ? { type: advertisedAuthMethod.type, label: advertisedAuthMethod.name }
              : {}),
            ...(input.probeError.authAction === undefined
              ? {}
              : { action: input.probeError.authAction }),
          }
        : { status: "unknown" },
    ...(input.probeError
      ? { message: authenticationMessage ?? input.probeError.message }
      : readiness.message
        ? { message: readiness.message }
        : {}),
  });
}

export const checkAcpRegistryProviderStatus = Effect.fn("AcpRegistryDriver.checkProviderStatus")(
  function* <Requirements>(
    input: SnapshotIdentity & {
      readonly settings: AcpRegistrySettings;
      readonly cwd: string;
      readonly environment: NodeJS.ProcessEnv;
    },
    probeConfiguration: AcpRegistryConfigurationProbe<Requirements>,
  ): Effect.fn.Return<ServerProvider, never, AcpRegistrySupport.AcpRegistryCatalog | Requirements> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!input.settings.enabled) {
      return yield* buildInitialAcpRegistrySnapshot(input);
    }
    const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
    const inspected = yield* Effect.result(catalog.inspect(input.settings, input.environment));
    if (Result.isFailure(inspected)) {
      return buildCheckedAcpRegistrySnapshot({
        ...input,
        checkedAt,
        inspection: {
          status: "failed",
          message: `Could not inspect ACP Registry agent: ${inspected.failure.message}`,
        },
      });
    }
    if (inspected.success.status !== "ready") {
      return buildCheckedAcpRegistrySnapshot({
        ...input,
        checkedAt,
        inspection: inspected.success,
      });
    }
    const probed = yield* Effect.result(
      probeConfiguration({
        instanceId: input.instanceId,
        settings: input.settings,
        cwd: input.cwd,
        environment: input.environment,
      }),
    );
    return Result.isFailure(probed)
      ? buildCheckedAcpRegistrySnapshot({
          ...input,
          checkedAt,
          inspection: inspected.success,
          probeError: probed.failure,
        })
      : buildCheckedAcpRegistrySnapshot({
          ...input,
          checkedAt,
          inspection: inspected.success,
          probe: probed.success,
        });
  },
);

/** Publishes local executable readiness without starting an ACP process. */
export const checkAcpRegistryProviderReadiness = Effect.fn(
  "AcpRegistryDriver.checkProviderReadiness",
)(function* (
  input: SnapshotIdentity & {
    readonly settings: AcpRegistrySettings;
    readonly environment: NodeJS.ProcessEnv;
  },
): Effect.fn.Return<ServerProvider, never, AcpRegistrySupport.AcpRegistryCatalog> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!input.settings.enabled) {
    return yield* buildInitialAcpRegistrySnapshot(input);
  }
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const inspected = yield* Effect.result(catalog.inspect(input.settings, input.environment));
  const snapshot = buildCheckedAcpRegistrySnapshot({
    ...input,
    checkedAt,
    inspection: Result.isFailure(inspected)
      ? {
          status: "failed",
          message: `Could not inspect ACP Registry agent: ${inspected.failure.message}`,
        }
      : inspected.success,
  });
  return inspected._tag === "Success" && inspected.success.status === "ready"
    ? {
        ...snapshot,
        message: "Checking ACP authentication, models, and commands in the background...",
      }
    : snapshot;
});

export type AcpRegistryDriverEnv = AcpRegistryAdapterV2DriverEnv | ProviderHost.ProviderHost;

/** Canonical provider-instance wrapper for ACP Registry orchestration adapters. */
export const makeAcpRegistryDriver = <Settings extends AcpRegistrySettings>(options: {
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly configSchema: Schema.Codec<Settings, unknown>;
  readonly defaultConfig: () => Settings;
  readonly adapterDriver: ProviderAdapterDriver<Settings, AcpRegistryAdapterV2DriverEnv>;
  readonly presentSnapshot?: (snapshot: ServerProvider) => ServerProvider;
  readonly prepareProcessEnvironment?: (
    environment: NodeJS.ProcessEnv,
    configured: ProviderInstanceEnvironment,
  ) => NodeJS.ProcessEnv;
  /** Dedicated drivers can reserve session-creating discovery for the user's Refresh action. */
  readonly backgroundSessionProbe?: boolean;
  readonly workspaceSnapshot?: (
    settings: Settings,
    environment: NodeJS.ProcessEnv,
    cwd: string,
    provider: ServerProvider,
  ) => Effect.Effect<
    ServerProvider & { readonly slashCommandsPending?: boolean },
    never,
    ChildProcessSpawner.ChildProcessSpawner | import("effect/FileSystem").FileSystem
  >;
  readonly normalizeCommands?: typeof import("./probe.ts").normalizeAcpRegistryCommands;
  readonly readTextGenerationSupport?: (
    settings: Settings,
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner>;
  readonly makeTextGeneration?: (
    settings: Settings,
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<
    ProviderTextGeneration,
    never,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | import("effect/FileSystem").FileSystem
  >;
  readonly readVersion?: (
    settings: Settings,
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<string | null, never, ChildProcessSpawner.ChildProcessSpawner>;
  /** Read-only native discovery avoids creating disposable ACP sessions at startup. */
  readonly readModels?: (
    settings: Settings,
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<
    ReadonlyArray<ServerProviderModel> | null,
    never,
    ChildProcessSpawner.ChildProcessSpawner
  >;
}): ProviderDriver<Settings, AcpRegistryDriverEnv> => ({
  driverKind: options.driverKind,
  metadata: {
    displayName: options.displayName,
    supportsMultipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: options.configSchema,
  defaultConfig: options.defaultConfig,
  create: ({
    instanceId,
    displayName,
    accentColor,
    environment: configuredEnvironment,
    enabled,
    config,
  }) =>
    Effect.gen(function* () {
      const DRIVER_KIND = options.driverKind;
      const environment = configuredEnvironment;
      const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });
      const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
      const runtimeCoordinator = yield* Effect.serviceOption(
        AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
      );
      if (Option.isSome(runtimeCoordinator)) {
        yield* runtimeCoordinator.value.clearAvailableCommands(instanceId);
        yield* runtimeCoordinator.value.clearLiveConfiguration(instanceId);
        yield* Effect.addFinalizer(() =>
          runtimeCoordinator.value
            .clearAvailableCommands(instanceId)
            .pipe(Effect.andThen(runtimeCoordinator.value.clearLiveConfiguration(instanceId))),
        );
      }
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const hostEnvironment = yield* HostProcess.Environment;
      const host = yield* ProviderHost.ProviderHost;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const identity = {
        driverKind: DRIVER_KIND,
        instanceId,
        displayName,
        accentColor,
        continuationKey: continuationIdentity.continuationKey,
      };
      const effectiveConfig = { ...config, enabled } satisfies AcpRegistrySettings;
      const mergedEnvironment = yield* mergeProviderInstanceEnvironment(
        environment,
        hostEnvironment,
      );
      const processEnvironment =
        options.prepareProcessEnvironment?.(mergedEnvironment, environment) ?? mergedEnvironment;
      const [readModels, invalidateModels] = yield* Effect.cachedInvalidateWithTTL(
        options.readModels
          ? options
              .readModels(config, processEnvironment)
              .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
          : Effect.succeed(null),
        (exit) => (Exit.isSuccess(exit) && exit.value !== null ? PROBE_SUCCESS_TTL_MS : 0),
      );
      const withNativeModels = (provider: ServerProvider) =>
        Effect.gen(function* () {
          if (!provider.enabled || !provider.installed || !options.readModels) return provider;
          const catalog = yield* readModels;
          if (catalog === null)
            return provider.models.some((model) => model.slug !== "default" && !model.isCustom)
              ? provider
              : {
                  ...provider,
                  status: provider.status === "ready" ? ("warning" as const) : provider.status,
                  message:
                    provider.message ??
                    "Native model discovery is unavailable. Refresh after signing in or updating the CLI; the native default and custom selections remain available.",
                };
          const current = new Map(provider.models.map((model) => [model.slug, model]));
          const nativeIds = new Set(catalog.map((model) => model.slug));
          return {
            ...provider,
            models: [
              ...catalog.map((model) => ({
                ...model,
                ...(current.get(model.slug)?.isCustom
                  ? { isCustom: true, name: current.get(model.slug)!.name }
                  : {}),
                ...(current.get(model.slug)?.supportsImages === undefined
                  ? {}
                  : { supportsImages: current.get(model.slug)!.supportsImages }),
                capabilities:
                  current.get(model.slug)?.capabilities ??
                  provider.models[0]?.capabilities ??
                  model.capabilities,
                ...(current.get(model.slug)?.isDefault ? { isDefault: true } : {}),
              })),
              ...provider.models.filter(
                (model) =>
                  !nativeIds.has(model.slug) && (model.isCustom || model.slug === "default"),
              ),
            ],
          };
        });
      const textGeneration = options.makeTextGeneration
        ? yield* options.makeTextGeneration(config, processEnvironment)
        : makeUnsupportedTextGeneration();
      const orchestrationAdapter = yield* options.adapterDriver
        .create({
          instanceId,
          displayName,
          accentColor,
          environment,
          enabled,
          config,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: "Failed to build ACP Registry orchestration adapter.",
                cause,
              }),
          ),
        );
      const readinessInput = {
        ...identity,
        settings: effectiveConfig,
        environment: processEnvironment,
      };
      const confirmedAuthentication =
        yield* AcpRegistryAuthenticationState.makeAcpRegistryAuthenticationState({
          cacheDir: host.paths.providerStatusCacheDir,
          instanceId,
          settings: effectiveConfig,
          environment,
          processEnvironment,
        });
      const withLiveRuntimeState = (input: ServerProvider) =>
        Effect.gen(function* () {
          if (input.auth.status === "unauthenticated") yield* confirmedAuthentication.set(false);
          const provider =
            input.enabled &&
            input.installed &&
            input.auth.status === "unknown" &&
            (yield* confirmedAuthentication.get)
              ? { ...input, auth: { ...input.auth, status: "authenticated" as const } }
              : input;
          return yield* Option.isNone(runtimeCoordinator)
            ? Effect.succeed(provider)
            : Effect.all({
                commands: runtimeCoordinator.value.getAvailableCommands(instanceId),
                configuration: runtimeCoordinator.value.getLiveConfiguration(instanceId),
                authAction: runtimeCoordinator.value.getUrlAuthAction(instanceId),
              }).pipe(
                Effect.map(({ commands, configuration, authAction }) => {
                  const withCommands = applyAcpRegistryAvailableCommands(provider, commands);
                  const withConfiguration = Option.match(configuration, {
                    onNone: () => withCommands,
                    onSome: (liveConfiguration) =>
                      applyAcpRegistryLiveConfiguration(
                        withCommands,
                        liveConfiguration,
                        effectiveConfig.customModels,
                      ),
                  });
                  return applyAcpRegistryUrlAuthAction(withConfiguration, authAction);
                }),
              );
        }).pipe(
          Effect.flatMap(withNativeModels),
          Effect.map(options.presentSnapshot ?? ((snapshot) => snapshot)),
        );
      const withVersion = (snapshot: ServerProvider) =>
        Effect.gen(function* () {
          const version =
            options.readVersion && snapshot.installed
              ? yield* options
                  .readVersion(config, processEnvironment)
                  .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
              : snapshot.version;
          const supportsTextGeneration =
            options.readTextGenerationSupport && snapshot.installed && snapshot.enabled
              ? yield* options
                  .readTextGenerationSupport(config, processEnvironment)
                  .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
              : false;
          return {
            ...snapshot,
            version,
            ...(options.readTextGenerationSupport ? { supportsTextGeneration } : {}),
          };
        });
      const checkProvider = checkAcpRegistryProviderReadiness(readinessInput).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
        Effect.flatMap(withVersion),
        Effect.flatMap((readiness) =>
          options.backgroundSessionProbe === false && readiness.installed && readiness.enabled
            ? Ref.get(enrichmentCache).pipe(
                Effect.map(({ entry }) =>
                  entry === null || entry.provider.version !== readiness.version
                    ? readiness
                    : { ...entry.provider, checkedAt: readiness.checkedAt },
                ),
              )
            : Effect.succeed(readiness),
        ),
        Effect.flatMap(withLiveRuntimeState),
      );
      const enrichProvider = checkAcpRegistryProviderStatus(
        {
          ...readinessInput,
          cwd: host.paths.cwd,
        },
        (input) =>
          probeAcpRegistryConfiguration({
            ...input,
            ...(options.normalizeCommands ? { normalizeCommands: options.normalizeCommands } : {}),
          }),
      ).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.flatMap(withVersion),
      );
      const enrichmentCache = yield* Ref.make<{
        readonly generation: number;
        readonly entry: {
          readonly provider: ServerProvider;
          readonly expiresAt: number;
        } | null;
      }>({ generation: 0, entry: null });
      const liveSnapshotSemaphore = yield* Semaphore.make(1);
      const invalidateEnrichmentCache = Ref.update(enrichmentCache, (current) => ({
        generation: current.generation + 1,
        entry: null,
      }));
      const enrichProviderCached = (baseSnapshot: ServerProvider) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const cacheState = yield* Ref.get(enrichmentCache);
          const cached = cacheState.entry;
          if (
            cached !== null &&
            cached.expiresAt > now &&
            cached.provider.version === baseSnapshot.version
          ) {
            return {
              provider: { ...cached.provider, checkedAt: baseSnapshot.checkedAt },
              generation: cacheState.generation,
            };
          }
          const enriched = yield* enrichProvider;
          if (enriched.status === "ready") {
            yield* Ref.update(enrichmentCache, (current) =>
              current.generation === cacheState.generation
                ? {
                    ...current,
                    entry: {
                      provider: enriched,
                      expiresAt: now + PROBE_SUCCESS_TTL_MS,
                    },
                  }
                : current,
            );
          }
          return { provider: enriched, generation: cacheState.generation };
        });
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<AcpRegistrySettings>
      >({
        resolveMaintenance: () => Effect.succeed(maintenance),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () => checkProvider,
        checkProvider,
        enrichSnapshot: ({ snapshot, getSnapshot, publishSnapshot }) => {
          if (!snapshot.installed) return Effect.void;
          const discovery = (
            Option.isSome(runtimeCoordinator)
              ? runtimeCoordinator.value.runBackgroundProbe(
                  effectiveConfig.source === "local"
                    ? `local:${instanceId}`
                    : effectiveConfig.agentId,
                  enrichProviderCached(snapshot),
                )
              : enrichProviderCached(snapshot).pipe(Effect.map(Option.some))
          ).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: ({ provider, generation }) =>
                  liveSnapshotSemaphore.withPermit(
                    Ref.get(enrichmentCache).pipe(
                      Effect.flatMap((current) =>
                        current.generation === generation
                          ? withLiveRuntimeState(provider).pipe(Effect.flatMap(publishSnapshot))
                          : Effect.void,
                      ),
                    ),
                  ),
              }),
            ),
          );
          const publishEnrichment =
            options.backgroundSessionProbe === false ? Effect.void : discovery;
          if (Option.isNone(runtimeCoordinator)) return publishEnrichment;

          const publishLiveCommands = runtimeCoordinator.value.watchAvailableCommands(
            instanceId,
            ({ slashCommands, skills }) =>
              liveSnapshotSemaphore.withPermit(
                getSnapshot.pipe(
                  Effect.flatMap((current) =>
                    publishSnapshot({
                      ...current,
                      slashCommands,
                      skills,
                    }),
                  ),
                ),
              ),
          );
          const publishLiveConfiguration = runtimeCoordinator.value.watchLiveConfiguration(
            instanceId,
            (configuration) =>
              liveSnapshotSemaphore.withPermit(
                getSnapshot.pipe(
                  Effect.flatMap((current) =>
                    withNativeModels(
                      applyAcpRegistryLiveConfiguration(
                        current,
                        configuration,
                        effectiveConfig.customModels,
                      ),
                    ).pipe(
                      Effect.map(options.presentSnapshot ?? ((provider) => provider)),
                      Effect.flatMap(publishSnapshot),
                    ),
                  ),
                ),
              ),
          );
          const publishUrlAuthAction = runtimeCoordinator.value.watchUrlAuthAction(
            instanceId,
            (action) =>
              liveSnapshotSemaphore.withPermit(
                getSnapshot.pipe(
                  Effect.flatMap((current) =>
                    publishSnapshot(
                      applyAcpRegistryUrlAuthAction(current, Option.fromNullishOr(action)),
                    ),
                  ),
                ),
              ),
          );
          return Effect.all(
            [
              publishEnrichment,
              publishLiveCommands,
              publishLiveConfiguration,
              publishUrlAuthAction,
            ],
            {
              concurrency: "unbounded",
              discard: true,
            },
          );
        },
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build the ACP Registry provider snapshot.",
              cause,
            }),
        ),
      );

      const refreshProvider =
        options.backgroundSessionProbe === false
          ? Effect.gen(function* () {
              const discovered = yield* Option.isSome(runtimeCoordinator)
                ? runtimeCoordinator.value.runBackgroundProbe(`local:${instanceId}`, enrichProvider)
                : enrichProvider.pipe(Effect.map(Option.some));
              if (Option.isSome(discovered)) {
                const now = yield* Clock.currentTimeMillis;
                yield* Ref.update(enrichmentCache, (current) => ({
                  ...current,
                  entry: { provider: discovered.value, expiresAt: now + PROBE_SUCCESS_TTL_MS },
                }));
              }
              return yield* snapshot.refresh;
            })
          : snapshot.refresh;

      // The management probes read the coordinator via serviceOption, so it is
      // provided only when this driver instance actually has one.
      const provideAcpManagementServices = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          | AcpRegistrySupport.AcpRegistryCatalog
          | ChildProcessSpawner.ChildProcessSpawner
          | Crypto.Crypto
        >,
      ): Effect.Effect<A, E> => {
        const provided = effect.pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(Crypto.Crypto, crypto),
        );
        return Option.isSome(runtimeCoordinator)
          ? provided.pipe(
              Effect.provideService(
                AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
                runtimeCoordinator.value,
              ),
            )
          : provided;
      };

      const clearLiveState = Option.isSome(runtimeCoordinator)
        ? runtimeCoordinator.value
            .clearLiveConfiguration(instanceId)
            .pipe(Effect.andThen(runtimeCoordinator.value.clearAvailableCommands(instanceId)))
        : Effect.void;
      const controller = yield* AcpRegistryAuth.makeAcpRegistryAuth({
        instanceId,
        settings: effectiveConfig,
        cwd: host.paths.cwd,
        environment: processEnvironment,
        onChanged: (authenticated) =>
          confirmedAuthentication
            .set(authenticated)
            .pipe(
              Effect.andThen(authenticated ? Effect.void : clearLiveState),
              Effect.andThen(invalidateModels),
              Effect.andThen(liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache)),
              Effect.andThen(refreshProvider),
              Effect.asVoid,
            ),
      }).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, crypto),
      );
      const auth = {
        ...controller,
        invalidate: (controller.invalidate ?? Effect.void).pipe(
          Effect.andThen(confirmedAuthentication.set(false)),
          Effect.andThen(clearLiveState),
          Effect.andThen(invalidateModels),
          Effect.andThen(liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache)),
          Effect.andThen(refreshProvider),
          Effect.asVoid,
        ),
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        auth,
        snapshot: {
          ...snapshot,
          refresh: invalidateModels.pipe(
            Effect.andThen(clearLiveState),
            Effect.andThen(refreshProvider),
            Effect.tap(() => controller.refreshMethods ?? Effect.void),
          ),
        },
        ...(options.workspaceSnapshot
          ? {
              snapshotForCwd: (cwd: string) =>
                snapshot.getSnapshot.pipe(
                  Effect.flatMap((provider) =>
                    provider.installed && provider.enabled
                      ? options.workspaceSnapshot!(config, processEnvironment, cwd, provider).pipe(
                          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                          Effect.provideService(FileSystem.FileSystem, fileSystem),
                        )
                      : Effect.succeed(provider),
                  ),
                ),
            }
          : {}),
        orchestrationAdapter,
        textGeneration,
        acpSessionManagement: {
          listSessions: ({ cwd, cursor }) =>
            provideAcpManagementServices(
              listAcpRegistrySessions({
                instanceId,
                settings: effectiveConfig,
                cwd,
                environment: processEnvironment,
                ...(cursor === undefined ? {} : { cursor }),
              }),
            ),
          deleteSession: ({ cwd, sessionId }) =>
            provideAcpManagementServices(
              deleteAcpRegistrySession({
                instanceId,
                settings: effectiveConfig,
                cwd,
                environment: processEnvironment,
                sessionId,
              }),
            ),
          listProviders: (cwd) =>
            provideAcpManagementServices(
              listAcpRegistryProviders({
                instanceId,
                settings: effectiveConfig,
                cwd,
                environment: processEnvironment,
              }),
            ),
          setProvider: ({ cwd, providerId, apiType, baseUrl, headers }) =>
            provideAcpManagementServices(
              setAcpRegistryProvider({
                instanceId,
                settings: effectiveConfig,
                cwd,
                environment: processEnvironment,
                providerId,
                apiType,
                baseUrl,
                ...(headers === undefined ? {} : { headers }),
              }),
            ).pipe(Effect.tap(() => liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache))),
          disableProvider: ({ cwd, providerId }) =>
            provideAcpManagementServices(
              disableAcpRegistryProvider({
                instanceId,
                settings: effectiveConfig,
                cwd,
                environment: processEnvironment,
                providerId,
              }),
            ).pipe(Effect.tap(() => liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache))),
          logout: (cwd) => {
            const logout = logoutAcpRegistry({
              instanceId,
              settings: effectiveConfig,
              cwd,
              environment: processEnvironment,
            }).pipe(
              Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.tap(() => confirmedAuthentication.set(false)),
              Effect.tap(() => invalidateModels),
              Effect.tap(() =>
                liveSnapshotSemaphore.withPermit(
                  invalidateEnrichmentCache.pipe(
                    Effect.andThen(
                      Option.isSome(runtimeCoordinator)
                        ? Effect.all(
                            [
                              runtimeCoordinator.value.clearAvailableCommands(instanceId),
                              runtimeCoordinator.value.clearLiveConfiguration(instanceId),
                            ],
                            { concurrency: "unbounded", discard: true },
                          )
                        : Effect.void,
                    ),
                  ),
                ),
              ),
            );
            return Option.isSome(runtimeCoordinator)
              ? logout.pipe(
                  Effect.provideService(
                    AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
                    runtimeCoordinator.value,
                  ),
                )
              : logout;
          },
        },
      } satisfies ProviderInstance;
    }),
});

export const AcpRegistryDriver = {
  ...makeAcpRegistryDriver({
    driverKind: DRIVER_KIND,
    displayName: "ACP Registry",
    configSchema: AcpRegistrySettings,
    defaultConfig: () => decodeSettings({}),
    adapterDriver: AcpRegistryAdapterV2Driver,
  }),
  usage: copilotUsageReader,
};
