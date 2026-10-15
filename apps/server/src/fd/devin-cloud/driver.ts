import { TextGenerationError, type ServerProvider } from "@t3tools/contracts";
import {
  DEFAULT_DEVIN_CLOUD_SETTINGS,
  DevinCloudSettings,
} from "@t3tools/provider-acp-registry/fd/devin-cloud";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";

import { DEVIN_CLOUD_DRIVER_KIND, makeDevinCloudAdapterV2 } from "./adapter.ts";
import { makeDevinCloudClient } from "./api.ts";

export type DevinCloudDriverEnv =
  | IdAllocator.IdAllocatorV2
  | ProviderHost.ProviderHost
  | HttpClient.HttpClient;

const unsupportedGeneration = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail:
        "Devin Cloud does not support local text generation. Choose a local provider for this action.",
    }),
  );
const textGeneration: ProviderTextGeneration = {
  generateCommitMessage: () => unsupportedGeneration("generateCommitMessage"),
  generatePrContent: () => unsupportedGeneration("generatePrContent"),
  generateBranchName: () => unsupportedGeneration("generateBranchName"),
  generateThreadTitle: () => unsupportedGeneration("generateThreadTitle"),
  generateReviewGuide: () => unsupportedGeneration("generateReviewGuide"),
};

export const DevinCloudDriver: ProviderDriver<DevinCloudSettings, DevinCloudDriverEnv> = {
  driverKind: DEVIN_CLOUD_DRIVER_KIND,
  metadata: {
    displayName: "Devin Cloud",
    supportsMultipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: DevinCloudSettings,
  defaultConfig: () => DEFAULT_DEVIN_CLOUD_SETTINGS,
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const apiKey = (
        environment.findLast((variable) => variable.name === "DEVIN_API_KEY" && variable.sensitive)
          ?.value ?? ""
      ).trim();
      const settings = { ...config, enabled };
      const api = yield* makeDevinCloudClient({ apiKey, organizationId: settings.organizationId });
      const continuationIdentity = {
        driverKind: DEVIN_CLOUD_DRIVER_KIND,
        continuationKey: `${DEVIN_CLOUD_DRIVER_KIND}:instance:${instanceId}:organization:${settings.organizationId}`,
      };
      const baseSnapshot = Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        return {
          instanceId,
          driver: DEVIN_CLOUD_DRIVER_KIND,
          displayName: displayName ?? "Devin Cloud",
          ...(accentColor ? { accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
          enabled,
          installed: true,
          version: null,
          checkedAt,
          status: enabled ? "warning" : "disabled",
          auth: { status: "unknown" },
          message: !enabled
            ? "Devin Cloud is disabled."
            : !settings.organizationId
              ? "Configure the Devin Cloud organization ID."
              : !apiKey
                ? "Configure DEVIN_API_KEY in the provider environment."
                : "Checking Devin Cloud authentication…",
          models: [
            {
              slug: "default",
              name: "Devin Cloud",
              isCustom: false,
              isDefault: true,
              capabilities: createModelCapabilities({ optionDescriptors: [] }),
            },
          ],
          slashCommands: [],
          skills: [],
          supportsTextGeneration: false,
          showInteractionModeToggle: false,
          supportsConversationRollback: false,
          supportedRuntimeModes: ["full-access"],
          setup: {
            canAuthenticate: false,
            canInstall: false,
            documentationUrl:
              "https://docs.devin.ai/api-reference/getting-started/teams-quickstart",
          },
        } satisfies ServerProvider;
      });
      const checkProvider = Effect.gen(function* () {
        const snapshot = yield* baseSnapshot;
        if (!enabled || !settings.organizationId || !apiKey) return snapshot;
        const checked = yield* api.authenticate().pipe(Effect.result);
        if (checked._tag === "Failure")
          return {
            ...snapshot,
            status: "error" as const,
            auth: {
              status:
                checked.failure.category === "authentication"
                  ? ("unauthenticated" as const)
                  : ("unknown" as const),
            },
            message: checked.failure.message,
          };
        const organization = yield* api.checkOrganization().pipe(Effect.result);
        if (organization._tag === "Failure")
          return {
            ...snapshot,
            status: "error" as const,
            auth: {
              status:
                organization.failure.category === "authentication"
                  ? ("unauthenticated" as const)
                  : ("authenticated" as const),
              type: "api_key" as const,
            },
            message: organization.failure.message,
          };
        return {
          ...snapshot,
          status: "ready" as const,
          auth: {
            status: "authenticated" as const,
            type: "api_key" as const,
            workspaceId: settings.organizationId,
            label: "Devin Cloud API key",
          },
          message:
            "Devin Cloud runs in a remote workspace. Local files are not uploaded or checkpointed.",
        };
      });
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(settings);
      const snapshot = yield* makeManagedServerProvider({
        ...snapshotSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () => baseSnapshot,
        checkProvider,
        resolveMaintenance: () =>
          Effect.succeed({ provider: DEVIN_CLOUD_DRIVER_KIND, packageName: null, update: null }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DEVIN_CLOUD_DRIVER_KIND,
              instanceId,
              detail: "Failed to build the Cloud provider snapshot.",
              cause,
            }),
        ),
      );
      const orchestrationAdapter = yield* makeDevinCloudAdapterV2({ instanceId, settings, apiKey });
      return {
        instanceId,
        driverKind: DEVIN_CLOUD_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration,
      };
    }),
};
