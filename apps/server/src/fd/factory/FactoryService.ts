import { AuthWorkReadScope } from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import {
  type WorkActor,
  type WorkDomainError,
  WorkService,
  workBranchName,
} from "../work-management/index.ts";
import * as FactorySettings from "./FactorySettings.ts";
import { FactoryProjectMissingError } from "./FactoryThreadEffects.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import type { FactoryStoreError } from "./persistence/errors.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import { queuedDeliveryState } from "./pipeline/state.ts";

/** No delivery id could be minted; nothing was written. */
export class FactoryDeliveryIdError extends Schema.TaggedError<FactoryDeliveryIdError>()(
  "FactoryDeliveryIdError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Factory could not mint a delivery id.";
  }
}

/** Why a start was refused. Every refusal comes before the delivery's row is written. */
type FactoryStartError =
  | WorkDomainError
  | FactorySettings.FactorySettingsStorageError
  | FactorySettings.FactoryVerifyCommandMissingError
  | ProjectStore.ProjectStoreV2Error
  | FactoryProjectMissingError
  | ThreadLaunch.ThreadLaunchBaseRefError
  | FactoryDeliveryIdError
  | FactoryDeliveryStore.FactoryDeliveryActive
  | FactoryStoreError;

/** Factory's deliveries for transports, MCP tools and scheduled tasks. */
export class FactoryService extends Context.Service<
  FactoryService,
  {
    /**
     * Starts a delivery of a single Work item. The author works on a new worktree of the branch
     * Work's thread starts would name, created from the canonical checkout's HEAD. The delivery
     * is stored queued, then started, so its author launch is queued once the running state is
     * stored. Refused, with nothing written: an item Work cannot read, a project without a
     * verify command or not on this environment, a base the worktree cannot start from, or an
     * item that already has a delivery that is not done or cancelled.
     */
    readonly start: (input: {
      readonly itemRef: WorkItemRef;
    }) => Effect.Effect<FactoryDeliveryStore.StoredFactoryDelivery, FactoryStartError>;
    readonly get: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<
      Option.Option<FactoryDeliveryStore.StoredFactoryDelivery>,
      FactoryStoreError
    >;
  }
>()("t3/fd/factory/FactoryService") {}

/** Factory reads the item to start and writes nothing to Work under this actor. */
const itemReader: WorkActor = { id: "factory", grants: [AuthWorkReadScope], label: "Factory" };

const make = Effect.gen(function* () {
  const work = yield* WorkService.WorkService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const settings = yield* FactorySettings.FactorySettings;
  const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
  const worker = yield* FactoryWorker.FactoryWorker;
  const crypto = yield* Crypto.Crypto;

  const start: FactoryService["Service"]["start"] = Effect.fn("FactoryService.start")(
    function* (input) {
      // The active-item index keys on Work's spelling, so another spelling of the item cannot
      // hold a second delivery.
      const itemRef = yield* work.canonicalRef(input.itemRef);
      const { projectId } = (yield* work.resolveSource(itemRef.sourceId)).stored;
      yield* settings.requireDeliverySettings(projectId);
      if (Option.isNone(yield* projects.get(projectId))) {
        return yield* new FactoryProjectMissingError({ projectId });
      }
      const item = yield* work.getItem(itemReader, { ref: itemRef });

      // The workspace the author's launch asks for (see `agentStage`), checked before any row
      // exists: the launch itself would accept a base with no commit and fail inside the thread.
      const workspace = {
        type: "worktree",
        baseRef: "HEAD",
        branch: workBranchName(item),
      } as const;
      yield* launches.checkWorktreeBase({ projectId, workspaceStrategy: workspace });

      const deliveryId = FactoryDeliveryId.make(
        yield* crypto
          .randomUUIDv4()
          .pipe(Effect.mapError((cause) => new FactoryDeliveryIdError({ cause }))),
      );
      // The insert refuses an item with an active delivery inside its transaction, so of two
      // concurrent starts only one is stored.
      const queued = yield* deliveries.insert({
        deliveryId,
        projectId,
        itemRef,
        state: queuedDeliveryState({ branch: workspace.branch, baseRef: workspace.baseRef }),
      });
      // A storage failure here leaves the delivery queued with nothing launched.
      const started = yield* worker.step(deliveryId, { type: "start" });
      return Option.getOrElse(started, () => queued);
    },
  );

  return FactoryService.of({ start, get: deliveries.get });
});

export const layer = Layer.effect(FactoryService, make);
