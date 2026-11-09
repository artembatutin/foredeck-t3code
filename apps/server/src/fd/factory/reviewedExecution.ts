// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous hash binds a prompt's text.
import * as NodeCrypto from "node:crypto";

import {
  type ModelSelection,
  type ProviderOptionSelectionValue,
  ProviderInstanceId,
  RuntimeMode,
} from "@t3tools/contracts";
import {
  type FactoryCommand,
  FactoryDeliveryId,
  type FactoryFindingSeverity,
  FactoryPromptName,
  FactoryReviewedExecution,
  FactoryRole,
} from "@t3tools/contracts/fd/factory";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { pipelines } from "./pipeline/definitions.ts";
import type { FactoryEffect } from "./pipeline/state.ts";

/** A reviewed start's input is not a complete review of this delivery; nothing was written. */
export class FactoryReviewedExecutionInvalidError extends Schema.TaggedError<FactoryReviewedExecutionInvalidError>()(
  "FactoryReviewedExecutionInvalidError",
  {
    reason: Schema.Literals(["malformed", "pipeline", "project", "repository", "runtime_ceiling"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "malformed":
        return "The reviewed execution of this delivery is incomplete or invalid.";
      case "pipeline":
        return "The reviewed execution names a pipeline this server does not ship.";
      case "project":
        return "The reviewed execution names another project than this Work item's.";
      case "repository":
        return "The reviewed execution names another repository than this project's.";
      case "runtime_ceiling":
        return "The reviewed execution names a runtime ceiling broader than this start.";
    }
  }
}

export const isFactoryReviewedExecutionInvalid = Schema.is(FactoryReviewedExecutionInvalidError);

/**
 * What a reviewed delivery's next effect would run differs from what its owner reviewed, or what
 * was reviewed is no longer allowed; nothing was run. The message is fixed text, safe to show.
 */
export class FactoryReviewedExecutionRefusedError extends Schema.TaggedError<FactoryReviewedExecutionRefusedError>()(
  "FactoryReviewedExecutionRefusedError",
  {
    reason: Schema.Literals([
      "repository",
      "publication_target",
      "pipeline",
      "project_default",
      "model",
      "options",
      "provider_mode",
      "thread_mode",
      "host_policy",
      "prompt",
    ]),
    role: Schema.optional(FactoryRole),
    instanceId: Schema.optional(ProviderInstanceId),
    model: Schema.optional(Schema.String),
    runtimeMode: Schema.optional(RuntimeMode),
    prompt: Schema.optional(FactoryPromptName),
    provider: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const reviewAgain = "Restore it or review the delivery again.";
    switch (this.reason) {
      case "repository":
        return `The project's repository or where it publishes is not what was reviewed for this delivery. ${reviewAgain}`;
      case "publication_target":
        return `Reviewed deliveries are not supported on ${this.provider}: it does not name the repository a pull request would target, so nothing could hold publication to what was reviewed. Use a repository on a provider that names its target, or deliver without a review.`;
      case "pipeline":
        return "This server no longer ships the pipeline reviewed for this delivery. Review the delivery again.";
      case "project_default":
        return `The project's default runtime mode is narrower than ${this.runtimeMode}, the mode reviewed for this delivery. ${reviewAgain}`;
      case "model":
        return `Provider ${this.instanceId} no longer offers ${this.model}, the ${this.role} model reviewed for this delivery, and Factory substitutes none. ${reviewAgain}`;
      case "options":
        return `Provider ${this.instanceId} does not offer the ${this.role} options reviewed for this delivery. ${reviewAgain}`;
      case "provider_mode":
        return `Provider ${this.instanceId} no longer offers ${this.runtimeMode}, the runtime mode the ${this.role ?? "delegated thread"} would run in. ${reviewAgain}`;
      case "thread_mode":
        return `The ${this.role ?? "delegated"} thread runs broader than ${this.runtimeMode}, the mode reviewed for this delivery. Narrow it or review the delivery again.`;
      case "host_policy":
        return `${this.provider}'s host policy refuses ${this.runtimeMode}, the mode this thread runs in, so it did not run and no mode changed. Review the delivery again to choose another.`;
      case "prompt":
        return `The ${this.prompt} prompt override is not the one reviewed for this delivery. Restore it exactly or review the delivery again.`;
    }
  }
}

export const isFactoryReviewedExecutionRefusedError = Schema.is(
  FactoryReviewedExecutionRefusedError,
);

/**
 * A fresh review's allowances could not replace a delivery's: nothing changed. `not_reviewed`: the
 * delivery was started without a review. `ended`: it is done or cancelled. `same_receipt`: another
 * allowance needs a receipt of its own. `reused_receipt`: an earlier review of it stood under this
 * receipt. `stale_version`: a later review already stands. `lower_allowance`: an amendment only
 * raises what was approved.
 */
export class FactoryReviewedAmendmentRefusedError extends Schema.TaggedError<FactoryReviewedAmendmentRefusedError>()(
  "FactoryReviewedAmendmentRefusedError",
  {
    deliveryId: FactoryDeliveryId,
    reason: Schema.Literals([
      "not_reviewed",
      "ended",
      "same_receipt",
      "reused_receipt",
      "stale_version",
      "lower_allowance",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_reviewed":
        return `Factory delivery ${this.deliveryId} was started without a review, so it has no reviewed allowance.`;
      case "ended":
        return `Factory delivery ${this.deliveryId} has ended, so its allowance cannot change.`;
      case "same_receipt":
        return `A changed allowance for Factory delivery ${this.deliveryId} needs a new review receipt.`;
      case "reused_receipt":
        return `An earlier review of Factory delivery ${this.deliveryId} stood under this receipt, so it authorizes nothing more.`;
      case "stale_version":
        return `A later review of Factory delivery ${this.deliveryId} already stands.`;
      case "lower_allowance":
        return `A new review can only raise the allowance of Factory delivery ${this.deliveryId}.`;
    }
  }
}

/**
 * A fresh review could not rebind a delivery: nothing changed. `not_reviewed`: it was started without
 * a review. `ended`: it is done or cancelled. `not_at_rest`: it has work under way, or ran on since
 * the review was confirmed. `project`: the
 * review names another project or checkout. `reused_receipt`: an earlier review of it stood under this
 * receipt. `stale_version`: a later review already stands.
 */
export class FactoryReviewedRebindRefusedError extends Schema.TaggedError<FactoryReviewedRebindRefusedError>()(
  "FactoryReviewedRebindRefusedError",
  {
    deliveryId: FactoryDeliveryId,
    reason: Schema.Literals([
      "not_reviewed",
      "ended",
      "not_at_rest",
      "project",
      "reused_receipt",
      "stale_version",
    ]),
  },
) {
  override get message(): string {
    return `A fresh review could not be applied to Factory delivery ${this.deliveryId} (${this.reason}).`;
  }
}

/** What an owner reviewing a project sees; see `FactoryThreadEffects.previewReviewedExecution`. */
export interface FactoryReviewedPreview {
  readonly roles: {
    readonly [role in FactoryRole]: {
      readonly selection: ModelSelection;
      readonly offered: boolean;
      readonly options: ReadonlyArray<{
        readonly id: string;
        readonly value: ProviderOptionSelectionValue;
        readonly supported: boolean;
      }>;
    };
  };
  readonly verifyCommand: FactoryCommand | null;
  readonly setupCommand: FactoryCommand | null;
  readonly limits: {
    readonly maxFixRounds: number;
    readonly maxReviewRounds: number;
    readonly verifyTimeoutMinutes: number;
  };
  readonly blockingSeverities: ReadonlyArray<FactoryFindingSeverity>;
  readonly highRiskEffort: string;
  readonly pipelineId: string;
  /** What a start would bind; none when `refusal` says why nothing could be. */
  readonly execution: FactoryReviewedExecution | null;
  readonly refusal: string | null;
}

/**
 * Whether a source control provider could open a pull request without saying against which
 * repository. Its CLI may choose one from configuration no binding can see, so a hash of Git's
 * settings proves nothing about it. A repository no provider hosts has no pull request to misdirect.
 */
export const publicationTargetUnbound = (publication: {
  readonly provider: string;
  readonly repository: string | null;
}) => publication.provider !== "unknown" && publication.repository === null;

const decodeReviewed = Schema.decodeUnknownOption(FactoryReviewedExecution);

/** A reviewed start's input as a review, or why it is none. */
export const parseReviewedExecution = (
  input: unknown,
): FactoryReviewedExecution | FactoryReviewedExecutionInvalidError => {
  const decoded = decodeReviewed(input);
  if (Option.isNone(decoded) || publicationTargetUnbound(decoded.value.repository.publication)) {
    return new FactoryReviewedExecutionInvalidError({ reason: "malformed" });
  }
  return pipelines.has(decoded.value.pipelineId)
    ? decoded.value
    : new FactoryReviewedExecutionInvalidError({ reason: "pipeline" });
};

/** Whether two starts of one id carry the same review; none on either side matches only none. */
export const sameReviewedExecution = (
  left: FactoryReviewedExecution | undefined,
  right: FactoryReviewedExecution | undefined,
) =>
  left === undefined || right === undefined
    ? left === right
    : Schema.toEquivalence(FactoryReviewedExecution)(left, right);

/** Text as its review binds it: a prompt override's, or Git's remote settings. */
export const reviewedContentHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

/** Whose reviewed selection an effect's turn or launch runs; none for an effect that runs none. */
export const reviewedRoleOf = (effect: FactoryEffect): FactoryRole | undefined => {
  switch (effect.type) {
    case "launch_thread":
      return effect.role;
    case "send_fix_commit_turn":
    case "send_repair_turn":
      return "author";
    case "send_plan_retry_turn":
    case "send_replan_turn":
      return "planner";
    case "send_review_retry_turn":
    case "send_review_follow_up_turn":
      return "reviewer";
    default:
      return undefined;
  }
};
