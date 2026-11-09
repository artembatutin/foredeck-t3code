import {
  type ModelSelection,
  type ProjectSettingsOverrides,
  type ProviderOptionDescriptor,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  type FactoryCommand,
  FactoryProjectSettings,
  type FactoryReviewedExecution,
} from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../../../serverSettings.ts";
import { HandoffAdmission } from "../../assistant/index.ts";
import * as Factory from "../index.ts";
import * as FactorySettingsStore from "../persistence/FactorySettingsStore.ts";
import { instanceId, type World } from "./deliveryHarness.ts";

/**
 * What a reviewed delivery runs on: a project whose settings an owner could review, a provider
 * offering what they name, and the review itself, as the owner's flow will store it.
 */

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);

/** Offered by every model below, lowest first. */
const effort: ProviderOptionDescriptor = {
  id: "effort",
  label: "Effort",
  type: "select",
  options: ["low", "medium", "high", "xhigh"].map((id) => ({
    id,
    label: id,
    isDefault: id === "low",
  })),
};

export const selection = (model: string, value?: string): ModelSelection => ({
  instanceId,
  model,
  ...(value === undefined ? {} : { options: [{ id: "effort", value }] }),
});

/**
 * A provider catalog the test can change while the server runs: the harness's registry reads this
 * very array, so emptying it is the provider no longer offering these models.
 */
export const offeredModels = (
  models: ReadonlyArray<string> = [
    "author-model",
    "planner-model",
    "reviewer-model",
    "other-model",
    "default-model",
    "test-model",
  ],
): Array<ServerProvider> => [
  {
    instanceId,
    models: models.map((slug) => ({ slug, capabilities: { optionDescriptors: [effort] } })),
  } as unknown as ServerProvider,
];

/** A command that fails until the author has committed `fixed.ts`, leaving the tree as it was. */
export const failsUntilFixed: FactoryCommand = {
  executable: process.execPath,
  args: ["-e", "process.exit(require('node:fs').existsSync('fixed.ts') ? 0 : 3)"],
};

/** A command that writes `marker` beside the project, outside the worktree it runs in. */
export const writesMarker = (world: World, marker: string) =>
  Effect.map(Path.Path, (path): FactoryCommand => ({
    executable: process.execPath,
    args: [
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], 'ran')",
      path.join(path.dirname(world.root), marker),
    ],
  }));

export const markerWritten = (world: World, marker: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fileSystem
      .exists(path.join(path.dirname(world.root), marker))
      .pipe(Effect.orElseSucceed(() => false));
  });

/** The settings given, the rest at their defaults, with the author on a model the catalog offers. */
const settingsOf = (settings: object) =>
  decodeSettings({ roles: { author: selection("test-model") }, ...settings });

/** Replaces the project's settings. */
export const setSettings = (world: World, settings: object) =>
  Effect.flatMap(Factory.FactorySettings.FactorySettings, (service) =>
    service.set(world.projectId, settingsOf(settings)),
  ).pipe(Effect.orDie);

/** Stores settings the service would refuse, as a later build's row could read. */
export const storeSettings = (world: World, settings: object) =>
  Effect.flatMap(FactorySettingsStore.FactorySettingsStore, (store) =>
    store.set(world.projectId, settingsOf(settings)),
  ).pipe(Effect.orDie);

export const overrideProject = (world: World, overrides: ProjectSettingsOverrides) =>
  Effect.flatMap(ServerSettings.ServerSettingsService, (settings) =>
    settings.updateSettings({ projectSettingsOverrides: { [world.projectId]: overrides } }),
  ).pipe(Effect.orDie);

/** What the owner reviews right now, as their flow will resolve it. */
export const reviewNow = (
  world: World,
  input: {
    readonly receiptId?: string;
    readonly reviewVersion?: number;
    readonly runtimeCeiling?: FactoryReviewedExecution["runtimeCeiling"];
  } = {},
) =>
  Effect.flatMap(Factory.FactoryService.FactoryService, (factory) =>
    factory.resolveReviewedExecution({
      projectId: world.projectId,
      receiptId: input.receiptId ?? "receipt-1",
      reviewVersion: input.reviewVersion ?? 1,
      runtimeCeiling: input.runtimeCeiling ?? "full-access",
    }),
  ).pipe(Effect.orDie);

/** Binds a queued assignment to the review, as the owner's confirmation will. */
export const attachReceipt = (assignmentId: string, execution: FactoryReviewedExecution) =>
  Effect.flatMap(HandoffAdmission.HandoffAdmission, (admission) =>
    admission.attachReviewReceipt({ assignmentId, execution }),
  ).pipe(Effect.orDie);
