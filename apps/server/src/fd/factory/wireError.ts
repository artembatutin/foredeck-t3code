import { FACTORY_REPLAN_NOTE_MAX_LENGTH, FactoryError } from "@t3tools/contracts/fd/factory";

import type * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import type * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import type * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import type * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import type { WorkDomainError } from "../work-management/index.ts";
import type * as FactoryService from "./FactoryService.ts";
import type * as FactorySettings from "./FactorySettings.ts";
import type * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import type { FactoryBranchUnavailableError } from "./git/freshBranch.ts";
import type { FactoryStoreError } from "./persistence/errors.ts";
import type * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";

/** What the Factory services fail with, as the RPC and MCP handlers meet them. */
export type FactoryServiceError =
  | WorkDomainError
  | FactorySettings.FactorySettingsStorageError
  | FactorySettings.FactoryUnknownPipelineError
  | FactorySettings.FactoryVerifyCommandMissingError
  | FactoryService.FactoryParentSourceUnsupportedError
  | FactoryService.FactoryDeliveryIdError
  | FactoryService.FactoryDeliveryIdConflictError
  | FactoryService.FactoryDeliveryNotFoundError
  | FactoryService.FactoryStopRefusedError
  | FactoryService.FactoryResumeRefusedError
  | FactoryService.FactoryPullRequestUnknownError
  | FactoryService.FactoryCancelRefusedError
  | FactoryService.FactoryPlanGateRefusedError
  | FactoryService.FactoryChildItemUncreatableError
  | FactoryService.FactoryPlanEditInvalidError
  | FactoryService.FactoryReplanNoteInvalidError
  | FactoryDeliveryStore.FactoryDeliveryActive
  | FactoryThreadEffects.FactoryProjectMissingError
  | FactoryBranchUnavailableError
  | FactoryStoreError
  | ThreadLaunch.ThreadLaunchBaseRefError
  | ProjectStore.ProjectStoreV2Error
  | ProjectionStore.ProjectionStoreV2Error
  | ServerRuntimeStartup.ServerRuntimeStartupError;

const STORAGE_FAILED = "Factory could not read or save its records. Try again.";

/**
 * The wire error for one service error: Factory's fixed text and bounded attributes, never a
 * cause. Work's errors get fixed text too: their messages can carry what a tracker answered.
 */
export const toFactoryError = (error: FactoryServiceError): FactoryError => {
  switch (error._tag) {
    case "FactoryVerifyCommandMissingError":
      return new FactoryError({
        reason: "not_configured",
        message:
          "Set a verify command in the project's Factory settings before starting a delivery.",
      });
    case "FactoryDeliveryActive":
      return new FactoryError({
        reason: "conflict",
        message: "This Work item already has a Factory delivery that is not done or cancelled.",
        deliveryId: error.deliveryId,
      });
    case "FactoryDeliveryIdConflictError":
      return new FactoryError({
        reason: "conflict",
        message: "This Factory delivery id already names a delivery of something else.",
        deliveryId: error.deliveryId,
      });
    case "FactoryDeliveryNotFoundError":
      return new FactoryError({
        reason: "not_found",
        message: "This Factory delivery does not exist.",
        deliveryId: error.deliveryId,
      });
    case "FactoryStopRefusedError":
      return new FactoryError({
        reason: "refused",
        message: `Only a running delivery can stop after its step; this one is ${error.status}.`,
        deliveryId: error.deliveryId,
      });
    case "FactoryResumeRefusedError":
      return new FactoryError({
        reason: "refused",
        message: `Only a stopping, stopped or blocked delivery can resume; this one is ${error.status}.`,
        deliveryId: error.deliveryId,
      });
    case "FactoryPullRequestUnknownError":
      return new FactoryError({
        reason: "refused",
        message:
          "This delivery published a pull request that a server restart lost track of, so resuming could open a second one. Cancel the delivery to keep its work and start over.",
        deliveryId: error.deliveryId,
      });
    case "FactoryCancelRefusedError":
      return new FactoryError({
        reason: "refused",
        message: `This delivery is already ${error.status}, so it cannot be cancelled.`,
        deliveryId: error.deliveryId,
      });
    case "FactoryPlanGateRefusedError":
      return new FactoryError({
        reason: "refused",
        message: `Only a delivery waiting at the plan gate can have its plan approved, edited, rejected or replanned; this one is ${error.status}.`,
        deliveryId: error.deliveryId,
      });
    case "FactoryChildItemUncreatableError":
      return new FactoryError({
        reason: "invalid_request",
        message:
          "Factory cannot approve this plan: the parent's Work source cannot hold a task's child item as written, because it is longer than a Work item holds or its title or text holds characters the source's files cannot store. Factory does not cut or change a task's text. Edit the plan, then approve it.",
        deliveryId: error.deliveryId,
        fields: error.taskIds.map((taskId) => ({ taskId })),
      });
    case "FactoryPlanEditInvalidError":
      return new FactoryError({
        reason: "invalid_request",
        message:
          "Factory refused the edited plan. An edited plan follows the planner's rules: nonblank text within its bounds, and a test plan entry for every criterion. An edit can change task titles, summaries, acceptance criteria and test plans, reorder tasks and remove some; it cannot add tasks, empty the plan, or change task ids, kinds, likely paths, risk or the planner's note.",
        deliveryId: error.deliveryId,
        // Where the problems are, never their descriptions: those quote the owner's text.
        ...(error.fields.length === 0 ? {} : { fields: error.fields }),
      });
    case "FactoryReplanNoteInvalidError":
      return new FactoryError({
        reason: "invalid_request",
        message: `Write a note of at most ${FACTORY_REPLAN_NOTE_MAX_LENGTH} characters telling the planner what to change.`,
        deliveryId: error.deliveryId,
      });
    case "FactoryParentSourceUnsupportedError":
      return new FactoryError({
        reason: "unsupported_source",
        message:
          "Factory plans a parent item only from a Markdown Work source, which can hold its child items. Deliver it as a single item instead.",
      });
    case "FactoryProjectMissingError":
      return new FactoryError({
        reason: "not_found",
        message: "The item's project is not on this environment.",
      });
    case "ThreadLaunchBaseRefError":
      return new FactoryError({
        reason: "refused",
        message: "The project's checkout has no commit to start the delivery's worktree from.",
      });
    case "FactoryBranchUnavailableError":
      return new FactoryError({
        reason: "refused",
        message: "Factory found no free branch name for a new delivery of this item.",
      });
    case "FactoryUnknownPipelineError":
      return new FactoryError({
        reason: "invalid_request",
        message: "This server does not have the selected Factory pipeline.",
      });
    case "FactoryDeliveryIdError":
      return new FactoryError({
        reason: "unavailable",
        message: "Factory could not start the delivery. Try again.",
      });
    case "ServerRuntimeStartupError":
      return new FactoryError({
        reason: "unavailable",
        message: "The server failed to start, so Factory cannot run deliveries.",
      });
    case "FactoryStoreError":
    case "FactorySettingsStorageError":
    case "ProjectStoreV2Error":
    case "ProjectionStoreSetupError":
    case "ProjectionStoreApplyEventError":
    case "ProjectionStoreThreadNotFoundError":
    case "ProjectionStoreReadError":
      return new FactoryError({ reason: "unavailable", message: STORAGE_FAILED });
    case "WorkSourceNotFound":
      return new FactoryError({
        reason: "not_found",
        message: "The item's Work source does not exist on this environment.",
      });
    case "WorkItemNotFound":
      return new FactoryError({ reason: "not_found", message: "Work could not find this item." });
    case "WorkInvalid":
      return new FactoryError({
        reason: "invalid_request",
        message: "The item's Work source refused the request for this item.",
      });
    case "WorkUnauthenticated":
      return new FactoryError({
        reason: "unavailable",
        message: "The item's Work source refused its credential. Reconnect the source in Work.",
      });
    case "WorkPermissionDenied":
    case "WorkForbidden":
      return new FactoryError({
        reason: "unavailable",
        message: "The item's Work source does not allow reading this item.",
      });
    case "WorkRateLimited":
      return new FactoryError({
        reason: "unavailable",
        message: "The item's Work source is limiting requests. Try again later.",
      });
    case "WorkStale":
    case "WorkSourceStale":
    case "WorkConflict":
    case "WorkUnsupported":
    case "WorkUnavailable":
      return new FactoryError({
        reason: "unavailable",
        message: "Work could not read this item right now. Try again.",
      });
  }
};
