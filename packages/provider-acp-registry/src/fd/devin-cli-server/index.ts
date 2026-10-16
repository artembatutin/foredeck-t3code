import { readCommandOutput } from "./commandOutput.ts";
import type {
  OrchestrationV2ProviderCapabilities,
  ProviderInstanceEnvironment,
  ServerProvider,
} from "@t3tools/contracts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { DEVIN_DRIVER_KIND, DEFAULT_DEVIN_SETTINGS, DevinSettings } from "../devin/index.ts";
import {
  makeAcpRegistryAdapterDriver,
  type AcpRegistryAdapterV2DriverEnv,
} from "../../server/adapter.ts";
import { makeAcpRegistryDriver, type AcpRegistryDriverEnv } from "../../server/driver.ts";
import {
  extractDevinSubagentUpdate,
  normalizeDevinSessionUpdate,
  normalizeDevinToolCall,
} from "../../server/devinAcp.ts";
import { readDevinModels } from "./models.ts";
import { normalizeDevinUsage, registerDevinUsage } from "./usage.ts";
import { devinUsageReader } from "./history.ts";
import { devinCompaction } from "./compaction.ts";
import { makeDevinTextGeneration, readDevinTextGenerationSupport } from "./textGeneration.ts";
import {
  devinModelSupportsImages,
  normalizeDevinCommands,
  prepareDevinWorkspacePrompt,
  readDevinWorkspaceSkills,
} from "./commands.ts";

const DevinProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

/** An instance uses its configured API key or native sign-in, never the host's ambient key. */
export const prepareDevinEnvironment = (
  environment: NodeJS.ProcessEnv,
  configured: ProviderInstanceEnvironment,
): NodeJS.ProcessEnv =>
  configured.some((variable) => variable.name === "WINDSURF_API_KEY")
    ? environment
    : { ...environment, WINDSURF_API_KEY: undefined };

export const DevinAdapterV2Driver = makeAcpRegistryAdapterDriver({
  driverKind: DEVIN_DRIVER_KIND,
  configSchema: DevinSettings,
  defaultConfig: () => DEFAULT_DEVIN_SETTINGS,
  clientTerminals: true,
  normalizeCommands: normalizeDevinCommands,
  authenticateOnAuthRequired: false,
  prepareProcessEnvironment: prepareDevinEnvironment,
  flavor: (settings, environment) => ({
    capabilities: DevinProviderCapabilitiesV2,
    ...devinCompaction,
    normalizeUsage: normalizeDevinUsage,
    registerExtensions: (context) =>
      devinCompaction.registerExtensions!(context).pipe(
        Effect.andThen(registerDevinUsage(context)),
      ),
    supportsCompaction: true,
    requireAdvertisedCompaction: true,
    preparePrompt: prepareDevinWorkspacePrompt(settings, environment),
    modelSupportsImages: devinModelSupportsImages,
    commandPromptsAreVerbatim: true,
    deferFinalizeForBackgroundWork: true,
    clientCapabilitiesMeta: {
      "cognition.ai/subagentSupport": true,
      "cognition.ai/messageGrouping": true,
    },
    normalizeSessionUpdate: normalizeDevinSessionUpdate,
    normalizeToolCall: normalizeDevinToolCall,
    extractSubagentUpdate: extractDevinSubagentUpdate,
  }),
});
export type DevinAdapterV2DriverEnv = AcpRegistryAdapterV2DriverEnv;

const presentDevinSnapshot = (snapshot: ServerProvider): ServerProvider => ({
  ...snapshot,
  displayName: snapshot.displayName ?? "Devin CLI",
  showInteractionModeToggle: snapshot.models.some((model) =>
    model.capabilities?.optionDescriptors?.some(
      (option) => option.type === "select" && option.options.some((choice) => choice.id === "plan"),
    ),
  ),
  ...(snapshot.message === "Checking ACP authentication, models, and commands in the background..."
    ? { message: "Refresh this provider to discover commands and native sessions." }
    : {}),
  setup: {
    canInstall: false,
    ...snapshot.setup,
    canAuthenticate: snapshot.installed && snapshot.enabled,
    documentationUrl: "https://docs.devin.ai/cli/reference/commands",
  },
});

/** ACP reports an internal agent version; the CLI's version command identifies the installed build. */
export const readDevinVersion = Effect.fn("DevinDriver.readVersion")(function* (
  settings: DevinSettings,
  environment: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* readCommandOutput(
    spawner,
    ChildProcess.make(settings.commandPath, ["version"], {
      env: environment,
    }),
  ).pipe(
    Effect.timeoutOption("5 seconds"),
    Effect.orElseSucceed(() => undefined),
  );
  if (output === undefined || output._tag === "None") return null;
  return /\bdevin\s+(\d+\.\d+\.\d+(?:-[\w.-]+)?)/i.exec(output.value)?.[1] ?? null;
});

export const DevinDriver = {
  ...makeAcpRegistryDriver({
    driverKind: DEVIN_DRIVER_KIND,
    displayName: "Devin CLI",
    configSchema: DevinSettings,
    defaultConfig: () => DEFAULT_DEVIN_SETTINGS,
    adapterDriver: DevinAdapterV2Driver,
    presentSnapshot: presentDevinSnapshot,
    prepareProcessEnvironment: prepareDevinEnvironment,
    backgroundSessionProbe: false,
    readVersion: readDevinVersion,
    readModels: readDevinModels,
    normalizeCommands: normalizeDevinCommands,
    workspaceSnapshot: readDevinWorkspaceSkills,
    makeTextGeneration: makeDevinTextGeneration,
    readTextGenerationSupport: readDevinTextGenerationSupport,
  }),
  usage: devinUsageReader,
};
export type DevinDriverEnv = AcpRegistryDriverEnv;
