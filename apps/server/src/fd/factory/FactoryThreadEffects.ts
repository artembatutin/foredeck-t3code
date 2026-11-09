import {
  AuthWorkReadScope,
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type RunId,
  RuntimeMode,
  type ServerProvider,
  ThreadId,
  type VcsListRefsResult,
  type WorktreeSetupSnapshot,
  providerRuntimeModeRestriction,
} from "@t3tools/contracts";
import {
  type FactoryDeliveryExecution,
  FactoryDeliveryId,
  type FactoryPromptName,
  type FactoryReviewedExecution,
  FactoryRole,
  type FactoryRoleExecution,
} from "@t3tools/contracts/fd/factory";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  RUNTIME_MODE_CHOICE_TEXT,
  runtimeModeRefusal,
  runtimeModeRefusalText,
} from "@t3tools/shared/fd/approvals";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { getProviderOptionCurrentValue, modelSelectionsEqual } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as ServerConfig from "../../config.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as RuntimePolicy from "../../orchestration-v2/RuntimePolicy.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../../orchestration-v2/ThreadMessageIntake.ts";
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { getAutoBootstrapThreadModelSelection } from "../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { type WorkActor, WorkService, workItemScopeFingerprint } from "../work-management/index.ts";
import * as FactoryAdmission from "./FactoryAdmission.ts";
import { taskOfChild } from "./FactoryChildren.ts";
import {
  FactoryReviewBasisMissingError,
  readReviewEvidence,
  reviewBasis,
} from "./FactoryReview.ts";
import { FactoryBranchStartError, readBranchCreation } from "./git/branchStart.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import type { StoredFactoryDelivery } from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import * as FactoryTurnSelectionStore from "./persistence/FactoryTurnSelectionStore.ts";
import { escalateEffort, mechanicalEffort } from "./pipeline/effort.ts";
import {
  adoptedRuns,
  type FactoryEffect,
  type FactoryEvent,
  type FactoryLaunchEffect,
  type FactoryTerminalRunStatus,
  FIX_COMMIT_TURNS,
  isTerminalRunStatus,
  isTurnEffect,
  unrecordedAuthorLaunch,
  unrecordedPlannerLaunch,
} from "./pipeline/state.ts";
import { childItemFingerprint } from "./plan/childItem.ts";
import { authorThreadTitle, renderAuthorPrompt } from "./prompts/author.ts";
import { renderFixCommitPrompt } from "./prompts/fixCommit.ts";
import { renderFixReviewPrompt } from "./prompts/fixReview.ts";
import { renderFixVerifyPrompt } from "./prompts/fixVerify.ts";
import { integrateThreadTitle, renderIntegratePrompt } from "./prompts/integrate.ts";
import { FactoryPromptOverrideError, MAX_PROMPT_OVERRIDE_BYTES } from "./prompts/overrides.ts";
import {
  planThreadTitle,
  renderPlanPrompt,
  renderPlanRetryPrompt,
  renderReplanPrompt,
} from "./prompts/plan.ts";
import {
  renderReviewPrompt,
  renderReviewRetryPrompt,
  reviewThreadTitle,
} from "./prompts/review.ts";
import { renderReviewFollowUpPrompt } from "./prompts/reviewFollowUp.ts";
import { pipelines } from "./pipeline/definitions.ts";
import {
  FactoryReviewedExecutionRefusedError,
  type FactoryReviewedPreview,
  publicationTargetUnbound,
  reviewedContentHash,
  sameReviewedExecution,
  reviewedRoleOf,
} from "./reviewedExecution.ts";
import { findingsToFix } from "./review/validate.ts";
import { readLogTail } from "./verify/logTail.ts";

export class FactoryProjectMissingError extends Schema.TaggedError<FactoryProjectMissingError>()(
  "FactoryProjectMissingError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} is not available on this environment.`;
  }
}

/**
 * The provider offers no runtime mode within the broadest the delivery's launch may use (the
 * narrower of its ceiling and the project's default); nothing was launched.
 */
export class FactoryRuntimeModeUnavailableError extends Schema.TaggedError<FactoryRuntimeModeUnavailableError>()(
  "FactoryRuntimeModeUnavailableError",
  { role: FactoryRole, instanceId: ProviderInstanceId, runtimeMode: RuntimeMode },
) {
  override get message(): string {
    return `Provider ${this.instanceId} offers no runtime mode within ${this.runtimeMode}, the broadest this delivery's ${this.role} may launch with.`;
  }
}

/**
 * The provider's host policy is known to refuse the mode a role would run in, so nothing ran and no
 * mode changed: another mode is for the owner to choose, never for Factory to step to.
 */
export class FactoryRuntimeModeRefusedError extends Schema.TaggedError<FactoryRuntimeModeRefusedError>()(
  "FactoryRuntimeModeRefusedError",
  {
    /** The role whose thread it is; a delegated thread has none. */
    role: Schema.optional(FactoryRole),
    instanceId: ProviderInstanceId,
    runtimeMode: RuntimeMode,
    provider: Schema.String,
    driver: Schema.String,
    alternatives: Schema.Array(RuntimeMode),
    detail: Schema.optional(Schema.String),
    /** How the owner chooses another: a reviewed delivery's mode changes only by a new review. */
    choose: Schema.Literals(["resume", "thread", "automatic_turn", "review", "before_review"]),
    /** The thread whose turn it refused; a launch's has none yet. */
    threadId: Schema.optional(ThreadId),
  },
) {
  // A delivery's reason is cut to a sentence or two, so what the policy allows stays with the rest
  // of the refusal on the block, and this keeps to what the owner has to do.
  override get message(): string {
    const { summary } = runtimeModeRefusalText({
      provider: this.provider,
      mode: this.runtimeMode,
      alternatives: this.alternatives,
    });
    return `${summary} Nothing ran and no mode changed. ${RUNTIME_MODE_CHOICE_TEXT[this.choose]}`;
  }
}

export const isFactoryRuntimeModeRefusedError = Schema.is(FactoryRuntimeModeRefusedError);

/** The ref does not name a commit in the directory, or git could not read it. */
export class FactoryBaselineError extends Schema.TaggedError<FactoryBaselineError>()(
  "FactoryBaselineError",
  { path: Schema.String, ref: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Factory could not resolve ${this.ref} to a commit in ${this.path}.`;
  }
}

/** The launch reported no run for the author prompt it was given. */
export class FactoryLaunchRunMissingError extends Schema.TaggedError<FactoryLaunchRunMissingError>()(
  "FactoryLaunchRunMissingError",
  { deliveryId: FactoryDeliveryId, threadId: ThreadId },
) {
  override get message(): string {
    return `Factory launched thread ${this.threadId} for delivery ${this.deliveryId} without a run.`;
  }
}

/** The thread's event stream ended before its launch recorded a worktree or ended its run. */
export class FactoryLaunchWatchEndedError extends Schema.TaggedError<FactoryLaunchWatchEndedError>()(
  "FactoryLaunchWatchEndedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Factory stopped watching thread ${this.threadId} before its workspace was prepared.`;
  }
}

/**
 * A launch made without its opening message ended its workspace preparation without a worktree, or
 * its thread was deleted first; nothing was run in it and no opening turn was sent.
 */
export class FactoryWorkspacePreparationError extends Schema.TaggedError<FactoryWorkspacePreparationError>()(
  "FactoryWorkspacePreparationError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Factory could not prepare the workspace of thread ${this.threadId}.`;
  }
}

/** The delivery records nothing for the turn to act on: no failed receipt, accepted review or baseline. */
export class FactoryTurnBasisMissingError extends Schema.TaggedError<FactoryTurnBasisMissingError>()(
  "FactoryTurnBasisMissingError",
  {
    deliveryId: FactoryDeliveryId,
    turn: Schema.Literals(["fix-verify", "fix-review", "review-follow-up"]),
  },
) {
  override get message(): string {
    return `Factory delivery ${this.deliveryId} records nothing for its ${this.turn} turn to act on.`;
  }
}

/** A native inherited effort must be known before a temporary override can be sent safely. */
export class FactoryMechanicalEffortUnavailableError extends Schema.TaggedError<FactoryMechanicalEffortUnavailableError>()(
  "FactoryMechanicalEffortUnavailableError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Factory could not read the current effort of thread ${this.threadId}.`;
  }
}

/** Whether a thread exists, was deleted, or has no record at all. */
type FactoryThreadState = "present" | "deleted" | "missing";

/**
 * The thread a delivery's launch effect creates. Derived from the effect, like the launch's
 * command and message ids, so a launch issued again replays its thread instead of starting one.
 */
export const launchThreadId = (deliveryId: FactoryDeliveryId, effectId: number) =>
  ThreadId.make(`factory-thread:${deliveryId}:${effectId}`);

const LAUNCH_THREAD = /^factory-thread:(.+):\d+$/;

/** The delivery whose launch made the thread (see `launchThreadId`); none for any other thread. */
export const launchDeliveryId = (threadId: ThreadId) => {
  const deliveryId = LAUNCH_THREAD.exec(threadId)?.[1];
  return deliveryId === undefined ? undefined : FactoryDeliveryId.make(deliveryId);
};

/** The first message of a launch's thread, which starts the launch's run. */
const launchMessageId = (deliveryId: FactoryDeliveryId, effectId: number) =>
  MessageId.make(`factory-launch-message:${deliveryId}:${effectId}`);

/** The message of a follow-up turn an effect sends; its id derives from the effect. */
const turnMessageId = (kind: string, deliveryId: FactoryDeliveryId, effectId: number) =>
  MessageId.make(`factory-${kind}-message:${deliveryId}:${effectId}`);

/** Every message Factory sends: a launch's first message, or a turn's (see `sendTurn`). */
const FACTORY_MESSAGE = /^factory-[a-z-]+-message:/;

const FACTORY_MESSAGE_DELIVERY = /^factory-[a-z-]+-message:(.+):\d+$/;

/**
 * The delivery that sent the message, when Factory sent it: each id names the delivery and the
 * effect it was sent for. None for any other message.
 */
export const factoryMessageDeliveryId = (messageId: MessageId) => {
  const deliveryId = FACTORY_MESSAGE_DELIVERY.exec(messageId)?.[1];
  return deliveryId === undefined ? undefined : FactoryDeliveryId.make(deliveryId);
};

/**
 * What became of a launch: it made no thread, made one that was deleted since, or made one whose
 * run is unfinished (or not created yet) or has ended.
 */
type FactoryLaunchState = "missing" | "deleted" | "unfinished" | "ended";

/** A launched thread, as `thread.launched` records it. */
type FactoryThreadLaunch = Omit<
  Extract<FactoryEvent, { readonly type: "thread.launched" }>,
  "type" | "effectId"
>;

/** A failed thread effect. Only its tag reaches the delivery's block, never its message. */
interface FactoryThreadEffectFailure {
  readonly _tag: string;
}

/** What keeps a project from a reviewed delivery, in its error's own fixed words. */
const reviewRefusalText = (failure: FactoryThreadEffectFailure) =>
  "message" in failure && typeof failure.message === "string"
    ? failure.message
    : "This project cannot run a reviewed delivery right now.";

/**
 * Carries out the thread effects for `FactoryWorker`: launching a role's thread and sending a
 * follow-up turn on a thread, and interrupting the runs of a cancelled delivery; a resume reads
 * here whether the delivery's threads still exist. Each effect receives the delivery as stored
 * with it. The worker feeds what they report back as `thread.launched` / `turn.started`, and a
 * failure as `effect.failed`. Checks run before
 * anything is dispatched, so a refused launch leaves no thread behind; a read that fails after the
 * launch still fails the effect, and the delivery records none of its result.
 */
export class FactoryThreadEffects extends Context.Service<
  FactoryThreadEffects,
  {
    /**
     * Launches the thread with its first turn, linked to the delivery's Work item, and reports
     * it once the launch has recorded the worktree, or has ended the run trying (the path is null
     * then). With `beforeOpening` (an author's setup), it runs in the worktree before that turn:
     * an existing worktree's before the launch, a new one's once core has prepared it for a thread
     * launched without the turn, which is then sent under the launch's own ids. A launch replayed
     * after its turn was sent runs nothing again and reports that turn's run, whatever
     * `beforeOpening` it is given; one replayed before takes the new worktree as its preparation
     * left it (see `recoverWorktree`) and launches into it. A failure of `beforeOpening` fails
     * the launch. For a root something manages (see `FactoryAdmission`), a new worktree is always
     * launched without the turn, and the manager is asked about what the turn renders last before
     * it is sent, as before an existing worktree's launch; a refusal sends none and fails the
     * launch with `FactoryOpeningRefusedError`.
     */
    readonly launchThread: (
      delivery: StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "launch_thread" }>,
      beforeOpening?: (worktreePath: string) => Effect.Effect<void, FactoryThreadEffectFailure>,
    ) => Effect.Effect<FactoryThreadLaunch, FactoryThreadEffectFailure>;
    /** Sends the turn and reports the run it started on the effect's thread. */
    readonly sendFixCommitTurn: (
      delivery: StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "send_fix_commit_turn" }>,
    ) => Effect.Effect<{ readonly runId: RunId }, FactoryThreadEffectFailure>;
    /**
     * Sends the planner's turn asking for its whole plan again and reports the run it started on
     * the effect's thread.
     */
    readonly sendPlanRetryTurn: (
      delivery: StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "send_plan_retry_turn" }>,
    ) => Effect.Effect<{ readonly runId: RunId }, FactoryThreadEffectFailure>;
    /**
     * Sends the owner's replan note to the planner thread, queued behind whatever the thread is
     * doing, and reports the run it started on the effect's thread.
     */
    readonly sendReplanTurn: (
      delivery: StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "send_replan_turn" }>,
    ) => Effect.Effect<{ readonly runId: RunId }, FactoryThreadEffectFailure>;
    /** Sends the reviewer's retry turn and reports the run it started on the effect's thread. */
    readonly sendReviewRetryTurn: (
      delivery: StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "send_review_retry_turn" }>,
    ) => Effect.Effect<{ readonly runId: RunId }, FactoryThreadEffectFailure>;
    /**
     * Sends a repair turn on the author thread and reports its run: fix-verify names the end of
     * the delivery's last receipt's log, fix-review the findings of its last accepted review.
     */
    readonly sendRepairTurn: (
      delivery: StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "send_repair_turn" }>,
    ) => Effect.Effect<{ readonly runId: RunId }, FactoryThreadEffectFailure>;
    /**
     * Sends a later review round on the reviewer thread and reports its run: the delivery's last
     * receipt, the previous round's findings and the author's fix-review reply as claims.
     */
    readonly sendReviewFollowUpTurn: (
      delivery: StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "send_review_follow_up_turn" }>,
    ) => Effect.Effect<{ readonly runId: RunId }, FactoryThreadEffectFailure>;
    /**
     * Whether a reviewed delivery may run `effect`, as everything it depends on stands now, for
     * the worker to ask right before running it; nothing to judge for an unreviewed delivery. A
     * review is a ceiling, never a grant: a repository or publication target other than the one
     * reviewed, a pipeline gone from this server, a project default narrower than the reviewed
     * mode, or a provider of a role it uses no longer offering that mode refuses any effect, and a
     * launch or turn is also refused for a model or option its provider no longer offers, or a
     * thread broader than the reviewed mode.
     */
    readonly checkReviewed: (
      delivery: StoredFactoryDelivery,
      effect: FactoryEffect,
    ) => Effect.Effect<void, FactoryThreadEffectFailure>;
    /**
     * Whether the durable record shows that a turn whose count a review charges (a repair or
     * fix-commit turn) started a run. Any other effect, and a read that fails, counts as sent, so
     * doubt never gives a count back.
     */
    readonly chargedTurnSent: (
      delivery: StoredFactoryDelivery,
      effect: FactoryEffect,
    ) => Effect.Effect<boolean>;
    /**
     * What an owner would review for a delivery of the project under `runtimeCeiling`, as the
     * settings and prompt overrides stand now, to store on a review receipt: each role's selection
     * as it resolves, and the ceiling narrowed to the project's default and to what the roles'
     * providers offer. Refused without a verify command, with an unusable prompt override, when a
     * role's provider offers no mode within the ceiling, or when the source control provider cannot
     * name the repository its pull request would target.
     */
    readonly resolveReviewedExecution: (input: {
      readonly projectId: ProjectId;
      readonly receiptId: FactoryReviewedExecution["receiptId"];
      readonly reviewVersion: number;
      readonly runtimeCeiling: RuntimeMode;
    }) => Effect.Effect<FactoryReviewedExecution, FactoryThreadEffectFailure>;
    /**
     * What an owner reviewing the project sees now: the settings, every role as it resolves with
     * whether its provider offers its model and options, and what a start would bind, or the text
     * saying why nothing could be, so a project that cannot run yet can still be shown. Writes
     * nothing. Fails only for a project this environment does not have or settings it cannot read.
     */
    readonly previewReviewedExecution: (input: {
      readonly projectId: ProjectId;
      readonly runtimeCeiling: RuntimeMode;
    }) => Effect.Effect<FactoryReviewedPreview, FactoryThreadEffectFailure>;
    /**
     * What each role the delivery launches runs on, as a client shows it: what its latest turn asked
     * for, as core recorded it on the run, or with no thread yet what `launchSelection` would ask,
     * beside what a review bound and whatever its provider reported for that thread. A parent launches
     * no author, so each child's own delivery says that. An ended delivery launches nothing more, so
     * it lists only the threads it ran. Writes nothing.
     */
    readonly deliveryExecution: (
      delivery: StoredFactoryDelivery,
    ) => Effect.Effect<FactoryDeliveryExecution, FactoryThreadEffectFailure>;
    /**
     * Whether the review still says what `resolveReviewedExecution` would bind now, reading only the
     * database and files beside it, so a transaction can ask with nothing slower than a read held
     * open: everything but where publication goes, which takes asking Git and the source control
     * provider. A read that fails, or a project that cannot run, is no longer what was reviewed.
     */
    readonly reviewedExecutionHolds: (input: {
      readonly projectId: ProjectId;
      /** What the review was resolved under, before the project and providers narrowed it. */
      readonly runtimeCeiling: RuntimeMode;
      readonly execution: FactoryReviewedExecution;
    }) => Effect.Effect<boolean>;
    /**
     * Whether a reviewed delivery's review still allows new work on `threadId`, a thread of the
     * family `launchedBy` made it part of: `checkReviewed`'s judgment of the delivery, then of the
     * thread by the role its launch made it for, a current role's or a replaced reviewer's. A
     * delegated thread has no role, and stays under the reviewed mode as its own provider offers
     * it. Nothing to judge for a delivery without a review.
     */
    readonly checkReviewedThread: (
      threadId: ThreadId,
      launchedBy: FactoryDeliveryId,
    ) => Effect.Effect<void, FactoryThreadEffectFailure>;
    /**
     * Refuses a turn nobody sent just now on `threadId`, with `FactoryRuntimeModeRefusedError`, when
     * the host's policy refuses the mode it would run in, on the provider it would run on. Any
     * delivery's or none's, reviewed or not, since a refused turn is doomed whoever's it is: an
     * automatic turn's gate asks, and a managed agent's delegation. It only reads, and leaves both
     * as they are; a thread that no longer exists is left for the dispatch to report.
     */
    readonly checkThreadHostPolicy: (
      threadId: ThreadId,
      launchedBy: FactoryDeliveryId | null,
    ) => Effect.Effect<void, FactoryThreadEffectFailure>;
    /**
     * Prepares an automatic turn about to run on `threadId`: `checkReviewedThread`'s judgment, then
     * a role's thread's selection set back to the reviewed one, since core runs such a turn with the
     * thread's selection. The review names no selection for a delegated thread. Refused, changing
     * nothing, as `checkReviewedThread` refuses.
     */
    readonly prepareReviewedTurn: (
      threadId: ThreadId,
      launchedBy: FactoryDeliveryId,
    ) => Effect.Effect<void, FactoryThreadEffectFailure>;
    /** What became of the launch effect's thread and its first run. */
    readonly launchState: (
      delivery: StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "launch_thread" }>,
    ) => Effect.Effect<FactoryLaunchState, ProjectionStore.ProjectionStoreV2Error>;
    /** Whether the thread exists, was deleted, or has no record at all. */
    readonly threadState: (
      threadId: ThreadId,
    ) => Effect.Effect<FactoryThreadState, ProjectionStore.ProjectionStoreV2Error>;
    /**
     * The run the thread is live in now, read from its shell as the MCP access gate reads it;
     * null when it runs nothing, or was deleted or archived.
     */
    readonly liveRun: (
      threadId: ThreadId,
    ) => Effect.Effect<RunId | null, ProjectionStore.ProjectionStoreV2Error>;
    /**
     * Whether the thread is open as Work counts a linked thread: it exists and is not deleted,
     * settled or archived, whether it works, waits for input or is idle.
     */
    readonly openThread: (
      threadId: ThreadId,
    ) => Effect.Effect<boolean, ProjectionStore.ProjectionStoreV2Error>;
    /**
     * Whether the run carries on a turn Factory sent on the thread: the run's own message is
     * Factory's, or it is one of `adopted` (pull request wakes the delivery took as its
     * follow-through rounds), or the run continues, through a server restart's continuations, a
     * run that is. A turn the owner sent on the thread, and its continuations, are not.
     */
    readonly carriesFactoryTurn: (
      threadId: ThreadId,
      runId: RunId,
      adopted: ReadonlyArray<RunId>,
    ) => Effect.Effect<boolean, ProjectionStore.ProjectionStoreV2Error>;
    /**
     * The run each of the threads is live in now, archived or not; a thread running nothing, or
     * deleted, has none.
     */
    readonly liveRunsOn: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly threadId: ThreadId; readonly runId: RunId }>,
      ProjectionStore.ProjectionStoreV2Error
    >;
    /**
     * `liveRunsOn` every thread a Factory launch made, among the threads core recovery keeps
     * track of (any with an unfinished run).
     */
    readonly launchedLiveRuns: Effect.Effect<
      ReadonlyArray<{ readonly threadId: ThreadId; readonly runId: RunId }>,
      ProjectionStore.ProjectionStoreV2Error
    >;
    /** The run's status once it has ended; none while it has not. */
    readonly runEnded: (
      threadId: ThreadId,
      runId: RunId,
    ) => Effect.Effect<Option.Option<FactoryTerminalRunStatus>, FactoryThreadEffectFailure>;
    /**
     * Asks a run of the thread to stop, as the thread's own Stop does, for a delivery that was
     * cancelled: `runId`, or without one the run the thread is live in, only while it carries on
     * a turn Factory sent or a wake the delivery took as its own (see `carriesFactoryTurn`): a
     * turn the owner sent on the thread is theirs. A run that already ended, a thread running
     * nothing and a deleted thread are left as they are.
     */
    readonly interruptRun: (
      delivery: StoredFactoryDelivery,
      run: { readonly threadId: ThreadId; readonly runId?: RunId },
    ) => Effect.Effect<void, FactoryThreadEffectFailure>;
  }
>()("t3/fd/factory/FactoryThreadEffects") {}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const decodeNativeThinking = Schema.decodeUnknownEffect(
  Schema.Struct({
    nativeThreadId: Schema.String,
    thinkingLevel: Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  }),
);

/** Runtime modes from the narrowest to the broadest. */
const runtimeModeRank: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

/**
 * The runtime mode a launch under `bound` asks of a provider offering `offered`: `bound` when it
 * offers it (or advertises nothing, and so runs what it is given), else the broadest mode it
 * offers below it; none when it offers nothing within. A provider runs a mode it does not offer as
 * one it does, which can be broader (see `RuntimePolicy`), so a bounded launch only asks for one
 * it offers.
 */
const offeredWithin = (bound: RuntimeMode, offered: ReadonlyArray<RuntimeMode> | undefined) =>
  offered === undefined || offered.length === 0 || offered.includes(bound)
    ? bound
    : offered
        .filter((mode) => runtimeModeRank[mode] < runtimeModeRank[bound])
        .toSorted((left, right) => runtimeModeRank[right] - runtimeModeRank[left])[0];

/** A thread's own record, as a turn reads it. */
type ThreadRead = Effect.Effect<
  ProjectionStore.ProjectionRecords<never>,
  ProjectionStore.ProjectionStoreV2Error
>;

/** Whose thread each kind of follow-up turn goes to. */
const TURN_ROLES = {
  "fix-commit": "author",
  "fix-verify": "author",
  "fix-review": "author",
  "plan-retry": "planner",
  replan: "planner",
  "review-retry": "reviewer",
  "review-follow-up": "reviewer",
} as const satisfies Record<string, FactoryRole>;

/** Factory reads its delivery's item and writes nothing to Work under this actor. */
const itemReader = (deliveryId: FactoryDeliveryId): WorkActor => ({
  id: `factory:${deliveryId}`,
  grants: [AuthWorkReadScope],
  label: "Factory",
});

/** Remove only the temporary effort, preserving any other options the owner changed. */
const restoreMechanicalSelection = (
  current: ModelSelection,
  saved: { readonly before: ModelSelection; readonly mechanical: ModelSelection | null },
): ModelSelection => {
  const { before, mechanical } = saved;
  if (
    mechanical === null ||
    current.instanceId !== mechanical.instanceId ||
    current.model !== mechanical.model
  )
    return current;
  if (modelSelectionsEqual(current, mechanical)) return before;
  // mechanicalEffort changes exactly one option. Its absence in `before` means the default.
  const changed = mechanical.options?.find(
    (option) => before.options?.find(({ id }) => id === option.id)?.value !== option.value,
  );
  if (
    changed === undefined ||
    current.options?.find(({ id }) => id === changed.id)?.value !== changed.value
  )
    return current;
  const original = before.options?.find(({ id }) => id === changed.id);
  return {
    ...current,
    options: [
      ...(current.options ?? []).filter(({ id }) => id !== changed.id),
      ...(original === undefined ? [] : [original]),
    ],
  };
};

/**
 * A role's selection in the order Work's thread starts use, with the role's profile as the explicit
 * choice. A planner or reviewer without a profile of its own uses the author's.
 */
const roleSelection = (
  roles: { readonly [role in FactoryRole]: ModelSelection | null },
  role: FactoryRole,
  projectDefault: ModelSelection | null | undefined,
): ModelSelection =>
  (role === "author" ? roles.author : (roles[role] ?? roles.author)) ??
  projectDefault ??
  getAutoBootstrapThreadModelSelection();

/**
 * Whether a model's descriptors offer each option a selection names, with a value of its type. A
 * model that lists no descriptors offers none: an option it cannot represent would not run as
 * reviewed.
 */
const offersOptions = (
  selection: ModelSelection,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
) =>
  (selection.options ?? []).every(({ id, value }) => {
    const descriptor = descriptors?.find((candidate) => candidate.id === id);
    if (descriptor === undefined) return false;
    return descriptor.type === "select"
      ? descriptor.options.some((option) => option.id === value)
      : typeof value === "boolean";
  });

/** Whether two sorted lists of remote URLs name the same targets. */
const sameUrls = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((url, index) => url === right[index]);

const make = Effect.gen(function* () {
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const factorySettings = yield* FactorySettings.FactorySettings;
  const turnSelections = yield* FactoryTurnSelectionStore.FactoryTurnSelectionStore;
  const events = yield* EventStore.EventStoreV2;
  const work = yield* WorkService.WorkService;
  const admission = yield* FactoryAdmission.FactoryAdmission;
  const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
  const tasks = yield* FactoryTaskStore.FactoryTaskStore;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  // Core owns this manager. A missing runtime capability fails only a turn that needs it.
  const sessions = yield* Effect.serviceOption(ProviderSessionManager.ProviderSessionManagerV2);
  const runtimePolicy = yield* Effect.serviceOption(RuntimePolicy.RuntimePolicyV2);
  // Where core reports a launch's workspace preparation when it has no run to report it on. The
  // server always provides it; without it a launch waits on the recorded worktree alone.
  const setupTracker = yield* Effect.serviceOption(WorktreeSetupTracker.WorktreeSetupTracker);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const exists = (path: string) => fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
  const realPath = (path: string) =>
    fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));
  const intakeContext = yield* Effect.context<
    ThreadManagement.ThreadManagementService | ServerConfig.ServerConfig | FileSystem.FileSystem
  >();

  /** Read only the canonical checkout, on every send; absence alone selects the built-in rules. */
  const readOverride = (root: string, prompt: FactoryPromptName) =>
    Effect.gen(function* () {
      const invalid = new FactoryPromptOverrideError({ prompt });
      const segments = [".foredeck", "factory", "prompts", `${prompt}.md`];
      let current = root;
      let canonicalRoot: string | undefined;
      for (const segment of segments) {
        // A directory entry distinguishes absence from a present but dangling symlink. Once
        // present, resolution/read failures must not fall back to the built-in prompt.
        const entries = yield* fileSystem.readDirectory(current).pipe(
          Effect.catchTags({
            PlatformError: (cause) =>
              current === root && cause.reason._tag === "NotFound"
                ? Effect.succeed<Array<string>>([])
                : Effect.fail(cause),
          }),
        );
        if (!entries.includes(segment)) return undefined;
        canonicalRoot ??= yield* fileSystem.realPath(root);
        current = yield* fileSystem.realPath(path.join(current, segment));
        const relative = path.relative(canonicalRoot, current);
        if (
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          return yield* invalid;
        }
      }
      // Refuse directories and special files before opening (in particular a FIFO must not wait).
      const info = yield* fileSystem.stat(current);
      if (info.type !== "File" || info.size > MAX_PROMPT_OVERRIDE_BYTES) return yield* invalid;
      const file = yield* fileSystem.open(current, { noFollow: platform !== "win32" });
      const opened = yield* file.stat;
      if (opened.type !== "File" || opened.size > MAX_PROMPT_OVERRIDE_BYTES) return yield* invalid;
      const buffer = new Uint8Array(MAX_PROMPT_OVERRIDE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const bytesRead = yield* file.read(buffer.subarray(length));
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_PROMPT_OVERRIDE_BYTES) return yield* invalid;
      const text = yield* Effect.try({
        try: () =>
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            buffer.subarray(0, length),
          ),
        catch: (cause) => new FactoryPromptOverrideError({ prompt, cause }),
      });
      if (text.trim().length === 0) return yield* invalid;
      return text;
    }).pipe(
      Effect.scoped,
      Effect.catchTags({
        PlatformError: (cause) => Effect.fail(new FactoryPromptOverrideError({ prompt, cause })),
      }),
    );

  /**
   * The rules of `prompt` for the delivery's next launch or turn: the override as it reads now, or
   * for a reviewed delivery only the very text its owner reviewed. A file edited, added, removed or
   * unusable since is refused naming only the prompt, so restoring its exact bytes lets a resume
   * go on. What is hashed is what renders, read once, and only these seven files are ever bound.
   */
  const overrideOf = (delivery: StoredFactoryDelivery, root: string, prompt: FactoryPromptName) =>
    Effect.gen(function* () {
      const { reviewedExecution: reviewed } = delivery.state;
      if (reviewed === undefined) return yield* readOverride(root, prompt);
      const refuse = (cause?: unknown) =>
        new FactoryReviewedExecutionRefusedError({
          reason: "prompt",
          prompt,
          ...(cause === undefined ? {} : { cause }),
        });
      const text = yield* readOverride(root, prompt).pipe(Effect.mapError(refuse));
      const hash = text === undefined ? "absent" : reviewedContentHash(text);
      return hash === reviewed.promptOverrides[prompt] ? text : yield* refuse();
    });

  const projectOverride = (delivery: StoredFactoryDelivery, prompt: FactoryPromptName) =>
    Effect.gen(function* () {
      const { projectId } = delivery;
      const project = Option.getOrUndefined(yield* projects.get(projectId));
      if (project === undefined) return yield* new FactoryProjectMissingError({ projectId });
      return yield* overrideOf(delivery, project.workspaceRoot, prompt);
    });

  /**
   * `selection` for a turn of `round`, with its effort raised when the task's risk or the round
   * calls for it and the selected model's options offer the project's `highRiskEffort`.
   */
  const escalated = (
    delivery: StoredFactoryDelivery,
    selection: ModelSelection,
    round: number,
    highRiskEffort: string,
  ) =>
    providers.getProviders.pipe(
      Effect.map((available) =>
        escalateEffort({
          selection,
          descriptors: available
            .find((provider) => provider.instanceId === selection.instanceId)
            ?.models.find((model) => model.slug === selection.model)?.capabilities
            ?.optionDescriptors,
          round,
          risk: delivery.state.risk,
          highRiskEffort,
        }),
      ),
    );

  // Queued runs persist their selection on the thread. Medium belongs only to the mechanical
  // turn: use its saved baseline while that selection is still on the thread. An owner change
  // takes precedence. The store is keyed by thread too, for a parent's last-child follow-through.
  const beforeMechanical = (threadId: ThreadId, current: ModelSelection) =>
    Effect.gen(function* () {
      const selections = yield* turnSelections.list(threadId);
      if (selections.length === 0) return current;
      const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
      const throughSequence = yield* events.latestSequence({ threadId });
      // Core applies selection on entering `starting`, before provider startup sets startedAt.
      // Its persisted transition distinguishes a startup failure from a never-dequeued cancel.
      const selectionApplied = (run: OrchestrationV2Run, afterSequence: number) =>
        Effect.gen(function* () {
          if (run.startedAt !== null) return true;
          for (const eventType of ["run.created", "run.updated"] as const) {
            const starting = yield* events
              .read({
                threadId,
                afterSequence,
                throughSequence,
                eventType,
              })
              .pipe(
                Stream.filter(
                  ({ event }) =>
                    (event.type === "run.created" || event.type === "run.updated") &&
                    event.payload.id === run.id &&
                    event.payload.status === "starting",
                ),
                Stream.runHead,
              );
            if (Option.isSome(starting)) return true;
          }
          return false;
        });
      // A refused, never-dequeued or selection-free intent cannot hide an older applied override.
      for (const saved of selections) {
        if (saved.mechanical === null) continue;
        const messageId = `factory-fix-commit-message:${saved.deliveryId}:${saved.effectId}`;
        const fixed = runs.findIndex((run) => run.userMessageId === messageId);
        if (fixed < 0) continue;
        const mechanicalCommandId = CommandId.make(
          `factory-fix-commit:${saved.deliveryId}:${saved.effectId}`,
        );
        const sent = yield* events
          .readByCommandId({
            commandId: mechanicalCommandId,
          })
          .pipe(Stream.runCollect);
        const afterSequence = (sent[0]?.sequence ?? 1) - 1;
        if (!(yield* selectionApplied(runs[fixed]!, afterSequence))) continue;
        // A later Factory turn that applied selection spends this override, even if startup fails.
        for (const run of runs.slice(fixed + 1)) {
          if (
            FACTORY_MESSAGE.test(run.userMessageId ?? "") &&
            !selections.some(
              (later) =>
                later.mechanical === null &&
                run.userMessageId ===
                  `factory-fix-commit-message:${later.deliveryId}:${later.effectId}`,
            ) &&
            (yield* selectionApplied(run, afterSequence))
          )
            return current;
        }
        // Keep the preceding selection, including system writes: choosing medium while a
        // mechanical turn is queued changes effort, but editing another option at medium
        // after it starts does not. Only command-bearing changes express owner intent.
        const changes = [...(yield* turnSelections.legacyHistory({ threadId, throughSequence }))];
        for (const eventType of [
          "thread.created",
          "thread.model-selection-updated",
          "thread.provider-switched",
        ] as const) {
          const history = yield* events
            .read({ threadId, throughSequence, eventType })
            .pipe(Stream.runCollect);
          for (const { event, commandId, sequence } of history) {
            if (
              event.type === "thread.created" ||
              event.type === "thread.model-selection-updated" ||
              event.type === "thread.provider-switched"
            )
              changes.push({ selection: event.payload.modelSelection, commandId, sequence });
          }
        }
        changes.sort((left, right) => left.sequence - right.sequence);
        const effortId = saved.mechanical?.options?.find(
          (option) =>
            saved.before.options?.find(({ id }) => id === option.id)?.value !== option.value,
        )?.id;
        let preceding = saved.before;
        let ownerSelection: ModelSelection | undefined;
        let ownerEffort = false;
        for (const { selection, commandId, sequence } of changes) {
          if (
            sequence > (sent.at(-1)?.sequence ?? 0) &&
            commandId !== null &&
            commandId !== mechanicalCommandId
          ) {
            ownerSelection = selection;
            if (
              selection.instanceId !== preceding.instanceId ||
              selection.model !== preceding.model ||
              selection.options?.find(({ id }) => id === effortId)?.value !==
                preceding.options?.find(({ id }) => id === effortId)?.value
            )
              ownerEffort = true;
          }
          preceding = selection;
        }
        return ownerSelection === undefined
          ? restoreMechanicalSelection(current, saved)
          : ownerEffort
            ? ownerSelection
            : restoreMechanicalSelection(ownerSelection, saved);
      }
      return current;
    });

  /**
   * The selection a reviewed role's thread goes back to after any drift: what its owner reviewed,
   * with the native effort a mechanical turn on that thread found the review inheriting. A provider
   * that keeps an omitted effort would otherwise stay on the mechanical turn's after the review's
   * selection is sent again.
   */
  const reviewedSelection = (
    reviewed: FactoryReviewedExecution,
    role: FactoryRole,
    threadId: ThreadId,
  ) =>
    Effect.map(turnSelections.list(threadId), (saved): ModelSelection => {
      const selection = reviewed.roles[role];
      const inherited = saved
        .filter(
          ({ before, mechanical }) =>
            mechanical !== null &&
            before.instanceId === selection.instanceId &&
            before.model === selection.model,
        )
        .flatMap(({ before }) => before.options ?? [])
        .filter(({ id }) => !selection.options?.some((option) => option.id === id));
      return inherited.length === 0
        ? selection
        : { ...selection, options: [...(selection.options ?? []), ...inherited] };
    });

  /**
   * The selection of a turn of `role` on its thread in `round`. A reviewed delivery sends its
   * role's reviewed selection however the thread drifted, escalated only to the reviewed effort;
   * an unreviewed one sends a selection only when the turn changes the thread's.
   */
  const turnSelection = (
    delivery: StoredFactoryDelivery,
    role: FactoryRole,
    threadId: ThreadId,
    round: number,
  ) =>
    Effect.gen(function* () {
      const { reviewedExecution: reviewed } = delivery.state;
      if (reviewed !== undefined) {
        return yield* escalated(
          delivery,
          yield* reviewedSelection(reviewed, role, threadId),
          round,
          reviewed.highRiskEffort,
        );
      }
      const { thread } = yield* projections.getThreadRecords(threadId, []);
      const before = yield* beforeMechanical(threadId, thread.modelSelection);
      const { highRiskEffort } = yield* factorySettings.get(delivery.projectId);
      const selection = yield* escalated(delivery, before, round, highRiskEffort);
      return selection === thread.modelSelection ? undefined : selection;
    });

  /**
   * What a role's launch asks for. A launch starts a first round, so only a high-risk task escalates
   * it. A review's roles hold what they resolved to.
   */
  const launchSelection = (
    delivery: StoredFactoryDelivery,
    role: FactoryRole,
    projectDefault: ModelSelection | null | undefined,
  ) =>
    Effect.gen(function* () {
      const { roles, highRiskEffort } =
        delivery.state.reviewedExecution ?? (yield* factorySettings.get(delivery.projectId));
      return yield* escalated(
        delivery,
        roleSelection(roles, role, projectDefault),
        1,
        highRiskEffort,
      );
    });

  /**
   * The selection of a retry or replan turn: a reviewed delivery's as `turnSelection` says for the
   * round it retries, and none otherwise, so the turn runs on the thread's own.
   */
  const retrySelection = (
    delivery: StoredFactoryDelivery,
    role: FactoryRole,
    threadId: ThreadId,
    round: number,
  ) =>
    delivery.state.reviewedExecution === undefined
      ? Effect.void
      : turnSelection(delivery, role, threadId, round);

  const nativeThinking = Effect.fnUntraced(function* (threadId: ThreadId, before: ModelSelection) {
    if (Option.isNone(sessions) || Option.isNone(runtimePolicy))
      return yield* new FactoryMechanicalEffortUnavailableError({ threadId });
    const context = yield* projections.getThreadProviderContext(threadId, before.instanceId);
    const providerThread = context.providerThreads.find(
      (candidate) =>
        candidate.appThreadId === threadId &&
        candidate.providerInstanceId === before.instanceId &&
        candidate.ownerNodeId === null &&
        candidate.id === context.thread.activeProviderThreadId,
    );
    if (
      context.thread.deletedAt !== null ||
      providerThread === undefined ||
      providerThread.providerSessionId === null
    )
      return yield* new FactoryMechanicalEffortUnavailableError({ threadId });
    const policy = yield* runtimePolicy.value.resolve({
      thread: context.thread,
      modelSelection: before,
    });
    const live = yield* sessions.value.get(providerThread.providerSessionId);
    const existingSession = context.providerSessions.find(
      ({ id }) => id === providerThread.providerSessionId,
    );
    const session = Option.isSome(live)
      ? live.value
      : yield* sessions.value.open({
          threadId,
          providerSessionId: providerThread.providerSessionId,
          modelSelection: before,
          runtimePolicy: policy,
          ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
          ...(providerThread.nativeThreadRef?.nativeId == null
            ? {}
            : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
          ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
            ? {}
            : {
                initialProviderItemIdentityVersion:
                  providerThread.nativeMetadata.itemIdentityVersion,
              }),
        });
    // An active bound thread already hosts the native session. Re-registering it can fail
    // when an owner changed selection since loading it. Inactive runtimes still need loading.
    const loaded =
      Option.isSome(live) &&
      providerThread.status === "active" &&
      providerThread.nativeThreadRef !== null
        ? providerThread
        : providerThread.nativeThreadRef === null
          ? yield* session.ensureThread({
              threadId,
              modelSelection: before,
              runtimePolicy: policy,
              providerSessionId: providerThread.providerSessionId,
              existingProviderThread: providerThread,
            })
          : yield* session.resumeThread({
              threadId,
              providerThread,
              modelSelection: before,
              runtimePolicy: policy,
            });
    if (
      loaded.id !== providerThread.id ||
      loaded.appThreadId !== threadId ||
      loaded.providerSessionId !== providerThread.providerSessionId ||
      loaded.providerInstanceId !== before.instanceId ||
      (providerThread.nativeThreadRef !== null &&
        loaded.nativeThreadRef?.nativeId !== providerThread.nativeThreadRef.nativeId)
    )
      return yield* new FactoryMechanicalEffortUnavailableError({ threadId });
    const snapshot = yield* session.readThreadSnapshot({ providerThread: loaded });
    const payload = yield* decodeNativeThinking(snapshot.providerPayload).pipe(
      Effect.mapError((cause) => new FactoryMechanicalEffortUnavailableError({ threadId, cause })),
    );
    if (
      snapshot.providerThread.id !== loaded.id ||
      snapshot.providerThread.appThreadId !== threadId ||
      snapshot.providerThread.providerSessionId !== providerThread.providerSessionId ||
      snapshot.providerThread.providerInstanceId !== before.instanceId ||
      payload.nativeThreadId !== loaded.nativeThreadRef?.nativeId
    )
      return yield* new FactoryMechanicalEffortUnavailableError({ threadId });
    return payload.thinkingLevel;
  });

  const fixCommitSelection = (
    delivery: StoredFactoryDelivery,
    effect: { readonly id: number; readonly threadId: ThreadId },
    threadRead: ThreadRead,
  ) =>
    Effect.gen(function* () {
      const key = { deliveryId: delivery.deliveryId, effectId: effect.id };
      const { reviewedExecution: reviewed } = delivery.state;
      // A reviewed turn never runs on the thread's own selection, which may have drifted.
      const sent = (selection: {
        readonly before: ModelSelection;
        readonly mechanical: ModelSelection | null;
      }) => selection.mechanical ?? (reviewed === undefined ? undefined : selection.before);
      const saved = yield* turnSelections.get(key);
      if (Option.isSome(saved)) return sent(saved.value);
      const before =
        reviewed !== undefined
          ? yield* reviewedSelection(reviewed, "author", effect.threadId)
          : yield* beforeMechanical(effect.threadId, (yield* threadRead).thread.modelSelection);
      const available = yield* providers.getProviders;
      const provider = available.find((provider) => provider.instanceId === before.instanceId);
      const descriptors = provider?.models.find((model) => model.slug === before.model)
        ?.capabilities?.optionDescriptors;
      const mechanical = mechanicalEffort({ selection: before, descriptors });
      const inherited = descriptors?.find(
        (option) =>
          option.type === "select" &&
          mechanical !== before &&
          mechanical.options?.some(({ id, value }) => id === option.id && value === "medium") &&
          !before.options?.some(({ id }) => id === option.id),
      );
      const defaultValue =
        provider?.driver === "pi" && inherited?.id === "thinking"
          ? yield* nativeThinking(effect.threadId, before)
          : getProviderOptionCurrentValue(inherited);
      // Pi retains omitted thinking on concrete models. Its catalog default cannot tell us
      // the native session's current level; persist that level before imposing medium.
      const effectiveBefore =
        inherited !== undefined && typeof defaultValue === "string"
          ? {
              ...before,
              options: [...(before.options ?? []), { id: inherited.id, value: defaultValue }],
            }
          : before;
      yield* turnSelections.record({
        ...key,
        threadId: effect.threadId,
        before: effectiveBefore,
        mechanical: mechanical === before ? null : mechanical,
      });
      // Read back the winner if the same effect was dispatched concurrently.
      return sent((yield* turnSelections.get(key)).pipe(Option.getOrThrow));
    });

  /** A provider instance's snapshot, read where a run's runtime policy reads it. */
  const instanceSnapshot = (instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      const instance = yield* providerInstances.getInstance(instanceId);
      return instance === undefined ? undefined : yield* instance.snapshot.getSnapshot;
    });

  /** The modes a provider instance advertises. */
  const offeredModes = (instanceId: ProviderInstanceId) =>
    Effect.map(instanceSnapshot(instanceId), (snapshot) => snapshot?.supportedRuntimeModes);

  /**
   * Fails when `snapshot`, the provider's as its caller already read it, says its host policy
   * refuses the mode `role` would run in, before anything is dispatched. Only what the provider read
   * counts, so an unknown policy launches as it always has; and it only refuses, since stepping to
   * another mode is what nobody chose.
   */
  const refuseHostDisallowed = (
    snapshot: ServerProvider | undefined,
    role: FactoryRole | undefined,
    instanceId: ProviderInstanceId,
    runtimeMode: RuntimeMode,
    choose: FactoryRuntimeModeRefusedError["choose"],
    options: { readonly ceiling?: RuntimeMode; readonly threadId?: ThreadId } = {},
  ) =>
    Effect.gen(function* () {
      const { ceiling, threadId } = options;
      if (snapshot === undefined) return;
      const refusal = runtimeModeRefusal(snapshot, runtimeMode);
      if (refusal === null) return;
      const { detail } = providerRuntimeModeRestriction(snapshot, runtimeMode);
      return yield* new FactoryRuntimeModeRefusedError({
        ...(role === undefined ? {} : { role }),
        instanceId,
        runtimeMode,
        provider: snapshot.displayName ?? snapshot.driver,
        driver: snapshot.driver,
        // A delivery capped by its starter cannot be raised by a project default.
        alternatives: refusal.alternatives
          .map(({ mode }) => mode)
          .filter(
            (mode) => ceiling === undefined || runtimeModeRank[mode] <= runtimeModeRank[ceiling],
          ),
        ...(detail === undefined ? {} : { detail }),
        choose,
        ...(threadId === undefined ? {} : { threadId }),
      });
    });

  /**
   * The runtime mode a launch of `role` on `instanceId` asks for. Without a ceiling, the project's
   * default, as for any thread. With one, the narrower of the two, stepped down to a mode the
   * provider offers, so the run is never broader than either; a provider offering none within
   * fails the launch before anything is dispatched. A reviewed delivery launches in the very mode
   * its owner reviewed: `checkReviewed` refuses it when that no longer holds.
   */
  const launchRuntimeMode = (
    delivery: StoredFactoryDelivery,
    role: FactoryRole,
    instanceId: ProviderInstanceId,
    projectDefault: RuntimeMode,
  ) =>
    Effect.gen(function* () {
      if (delivery.state.reviewedExecution !== undefined) {
        return delivery.state.reviewedExecution.runtimeCeiling;
      }
      const ceiling = delivery.state.runtimeModeCeiling;
      if (ceiling === undefined) return projectDefault;
      const bound =
        runtimeModeRank[ceiling] < runtimeModeRank[projectDefault] ? ceiling : projectDefault;
      const mode = offeredWithin(bound, yield* offeredModes(instanceId));
      return (
        mode ??
        (yield* new FactoryRuntimeModeUnavailableError({ role, instanceId, runtimeMode: bound }))
      );
    });

  /** The full object id `ref` names in `cwd`. */
  const resolveCommit = (cwd: string, ref: string) =>
    Effect.gen(function* () {
      // A leading dash would reach git as an option.
      if (ref.startsWith("-")) return yield* new FactoryBaselineError({ path: cwd, ref });
      const result = yield* git
        .execute({
          operation: "FactoryThreadEffects.baseline",
          cwd,
          args: ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
          allowNonZeroExit: true,
          timeoutMs: 30_000,
        })
        .pipe(
          Effect.catchTags({
            GitCommandError: (cause) =>
              Effect.fail(new FactoryBaselineError({ path: cwd, ref, cause })),
          }),
        );
      const sha = result.stdout.trim();
      return result.exitCode === 0 && OBJECT_ID.test(sha)
        ? sha
        : yield* new FactoryBaselineError({ path: cwd, ref });
    });

  /**
   * The commit a new worktree's branch started at. Preparation creates the worktree after
   * `launch` returns, from whatever the base ref names by then, so the commit resolved before the
   * launch can be stale. The branch's reflog records where `worktree add -b` created it; without
   * one (reflogs turned off), the earlier commit stands only while HEAD has not moved from it.
   */
  const branchStart = (worktreePath: string, branch: string, resolved: string) =>
    Effect.gen(function* () {
      const created = yield* readBranchCreation(worktreePath, branch).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, git),
      );
      if (Option.isSome(created)) return created.value;
      const head = yield* resolveCommit(worktreePath, "HEAD");
      return head === resolved
        ? head
        : yield* new FactoryBranchStartError({ path: worktreePath, branch });
    });

  const readThreadRun = (threadId: ThreadId, runId: RunId) =>
    projections.getThreadRecords(threadId, ["runs"], { runIds: [runId] }).pipe(
      Effect.map(({ thread, runs }) => ({
        worktreePath: thread.worktreePath,
        deleted: thread.deletedAt !== null,
        status: runs.find((run) => run.id === runId)?.status,
      })),
    );
  // A new worktree is created after `launch` returns, and recorded before the run leaves
  // preparation. A run that left it without one failed or was cancelled while preparing.
  const prepared = (read: Effect.Success<ReturnType<typeof readThreadRun>>) =>
    read.worktreePath !== null || read.deleted || read.status !== "preparing";

  /**
   * The thread's worktree path once its launch has prepared the workspace. Re-reads the
   * projection on each of the thread's events from before the first read, so an update between
   * the read and the subscription is not missed.
   */
  const awaitWorkspace = (threadId: ThreadId, runId: RunId) =>
    Effect.gen(function* () {
      const afterSequence = yield* threads.getThreadEventSequence(threadId);
      const first = yield* readThreadRun(threadId, runId);
      if (prepared(first)) return first.worktreePath;
      const next = yield* threads.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "thread.metadata-updated" ||
            event.type === "run.updated" ||
            event.type === "thread.deleted",
        ),
        Stream.mapEffect(() => readThreadRun(threadId, runId)),
        Stream.filter(prepared),
        Stream.runHead,
      );
      if (Option.isNone(next)) return yield* new FactoryLaunchWatchEndedError({ threadId });
      return next.value.worktreePath;
    });

  /** Whether core's preparation got as far as it starts an opening turn's run from. */
  const releasable = (snapshot: WorktreeSetupSnapshot) =>
    snapshot.phase === "done" ||
    snapshot.stages.some(
      ({ id, status }) => id === "agent" && (status === "running" || status === "done"),
    );

  // The tracker first: a preparation it shows past the worktree recorded that worktree before.
  const readRunlessPreparation = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const snapshot = Option.isSome(setupTracker) ? yield* setupTracker.value.get(threadId) : null;
      const { thread } = yield* projections.getThreadRecords(threadId, []);
      return { snapshot, worktreePath: thread.worktreePath, deleted: thread.deletedAt !== null };
    });

  /**
   * The first of `decide`'s answers to what the thread and its preparation show, read again on
   * each of the thread's events and each change the setup tracker reports, from before the first
   * read, so nothing in between is missed.
   */
  const awaitPreparation = <A>(
    threadId: ThreadId,
    decide: (read: Effect.Success<ReturnType<typeof readRunlessPreparation>>) => A | undefined,
  ) =>
    Effect.gen(function* () {
      const afterSequence = yield* threads.getThreadEventSequence(threadId);
      const first = decide(yield* readRunlessPreparation(threadId));
      if (first !== undefined) return first;
      const next = yield* Stream.merge(
        threads.streamStoredEventsFrom({ threadId, afterSequence }),
        Option.isSome(setupTracker) ? setupTracker.value.stream(threadId) : Stream.empty,
      ).pipe(
        Stream.mapEffect(() => readRunlessPreparation(threadId)),
        Stream.map(decide),
        Stream.filter((decision) => decision !== undefined),
        Stream.runHead,
      );
      return Option.isSome(next)
        ? next.value
        : yield* new FactoryLaunchWatchEndedError({ threadId });
    });

  /**
   * The new worktree of a thread just launched without a message, once core's preparation got as
   * far as it would have before starting that message's run: past the project's own setup script,
   * which clients follow on the setup tracker, as no run reports it. A preparation that ended
   * without a worktree, and a deleted thread, fail.
   */
  const awaitRunlessWorkspace = (threadId: ThreadId) =>
    awaitPreparation(threadId, ({ snapshot, worktreePath, deleted }) => {
      if (deleted) return { prepared: false } as const;
      if (snapshot !== null && !releasable(snapshot)) {
        return snapshot.phase === "running" ? undefined : ({ prepared: false } as const);
      }
      if (worktreePath !== null) return { prepared: true, worktreePath } as const;
      // Waits only for a preparation that has not begun yet.
      return snapshot !== null ? ({ prepared: false } as const) : undefined;
    }).pipe(
      Effect.flatMap((decision) =>
        decision.prepared
          ? Effect.succeed(decision.worktreePath)
          : Effect.fail(new FactoryWorkspacePreparationError({ threadId })),
      ),
    );

  /** Where Git has `branch` checked out from the project's checkout at `root`; none when nowhere. */
  const branchWorktree = (root: string, branch: string) =>
    Effect.gen(function* () {
      // The query matches by substring, so the branch itself can be on any page.
      for (let cursor: number | null = 0; cursor !== null;) {
        const page: VcsListRefsResult = yield* git.listRefs({
          cwd: root,
          query: branch,
          refKind: "local",
          refresh: cursor === 0,
          cursor,
          limit: 200,
        });
        const ref = page.refs.find(({ name, isRemote }) => !isRemote && name === branch);
        if (ref !== undefined) return { exists: true, worktreePath: ref.worktreePath } as const;
        cursor = page.nextCursor;
      }
      return { exists: false, worktreePath: null } as const;
    });

  /**
   * The new worktree of a replayed launch that sent no opening turn, as what ran of its
   * preparation left it, reconciled with Git and recorded on the thread. A replay schedules no
   * preparation, and one a restart cut short can leave the delivery's branch with or without its
   * worktree and the thread recording neither (core's cleanup of an interrupted preparation removes
   * the worktree and keeps the branch), so asking core again would only collide with that branch.
   * An existing recorded worktree must match Git's checkout of the original branch, never the
   * project's own checkout. Without one, reuse Git's checkout, attach the retained branch, or
   * create from the base ref as the preparation would have. Each comes from the settings core's
   * preparation uses, and the thread records it only while its workspace is still as read here.
   */
  const recoverWorktree = (input: {
    readonly threadId: ThreadId;
    readonly root: string;
    readonly branch: string;
    readonly baseRef: string;
    /** The worktree settings core's preparation creates a worktree with. */
    readonly options: GitVcsDriver.CreateWorktreeOptions;
    readonly commandId: CommandId;
  }) =>
    Effect.gen(function* () {
      const { threadId, root, branch } = input;
      const afterSequence = yield* threads.getThreadEventSequence(threadId);
      const { thread, runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
      if (
        thread.deletedAt !== null ||
        runs.length > 0 ||
        (yield* projections.getMessageCount(threadId)) > 0
      )
        return yield* new FactoryWorkspacePreparationError({ threadId });
      const recorded = thread.worktreePath;
      // Core checks actual message count and runs atomically, including messages outside a
      // bounded projection. Refuse owner-used threads before any checkout mutation or setup.
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`${input.commandId}:recover:${afterSequence}`),
        threadId,
        expectedEmpty: true,
        expectedWorktreePath: recorded,
      });
      const checkedOut = yield* branchWorktree(root, branch);
      const recordedExists = recorded !== null && (yield* exists(recorded));
      if (
        checkedOut.worktreePath !== null &&
        (yield* realPath(checkedOut.worktreePath)) === (yield* realPath(root))
      ) {
        return yield* new FactoryWorkspacePreparationError({ threadId });
      }
      if (
        recordedExists &&
        (checkedOut.worktreePath === null ||
          (yield* realPath(recorded)) !== (yield* realPath(checkedOut.worktreePath)))
      ) {
        return yield* new FactoryWorkspacePreparationError({ threadId });
      }
      const worktreePath =
        (recordedExists ? recorded : checkedOut.worktreePath) ??
        (yield* git.createWorktree(
          checkedOut.exists
            ? { cwd: root, refName: branch, path: null }
            : {
                cwd: root,
                refName: input.baseRef,
                newRefName: branch,
                baseRefName: input.baseRef,
                path: null,
              },
          input.options,
        )).worktree.path;
      if (worktreePath !== recorded) {
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`${input.commandId}:worktree:${afterSequence}`),
          threadId,
          branch,
          worktreePath,
          expectedWorktreePath: recorded,
          expectedEmpty: true,
        });
      }
      return worktreePath;
    });

  /** Whether an existing thread has its opening turn; undefined when no thread exists yet. */
  const openingSent = (threadId: ThreadId, messageId: MessageId) =>
    projections.getThreadRecords(threadId, ["runs"]).pipe(
      Effect.map(({ runs }) => runs.some((run) => run.userMessageId === messageId)),
      Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.void }),
    );

  /**
   * The tasks a parent's plan approval froze, as their rows store them, in plan order; a row
   * without its plan, or none at all, leaves nothing to review.
   */
  const frozenTasks = (deliveryId: FactoryDeliveryId) =>
    tasks.listByDelivery(deliveryId).pipe(
      Effect.flatMap((rows) => {
        const plans = rows.flatMap(({ plan }) => (plan === null ? [] : [plan]));
        return plans.length === 0 || plans.length !== rows.length
          ? Effect.fail(new FactoryReviewBasisMissingError({ deliveryId }))
          : Effect.succeed(plans);
      }),
    );

  /**
   * Whether a child's item still says what Factory wrote for its task: `fingerprint`, its read's,
   * equals that of `childItemInput` rendered from the parent's frozen task row. A parent or task
   * row that cannot be found proves nothing, so it does not match.
   */
  const childScopeMatches = (
    parentId: FactoryDeliveryId,
    childId: FactoryDeliveryId,
    fingerprint: string,
  ) =>
    Effect.gen(function* () {
      const parent = Option.getOrUndefined(yield* deliveries.get(parentId));
      if (parent === undefined) return false;
      const task = taskOfChild(parentId, yield* tasks.listByDelivery(parentId), childId);
      if (task === undefined || task.plan === null) return false;
      return (
        childItemFingerprint({ parent: parent.itemRef, deliveryId: parentId, task: task.plan }) ===
        fingerprint
      );
    });

  const launchThread: FactoryThreadEffects["Service"]["launchThread"] = (
    delivery,
    effect,
    beforeOpening,
  ) =>
    Effect.gen(function* () {
      const { role } = effect;
      const { deliveryId, projectId, state } = delivery;
      const root = delivery.parentId ?? deliveryId;
      // A managed root's launches send their opening, the one message that renders the item,
      // only once its manager allows what that message renders (see `authorizeOpening` below); a
      // root nothing manages launches as it always has.
      const governed = (yield* admission.management(root)) !== "never";
      // A review starts from the verified commit; without one, nothing is launched.
      const basis = role === "reviewer" ? yield* reviewBasis(delivery) : null;
      const project = Option.getOrUndefined(yield* projects.get(projectId));
      if (project === undefined) return yield* new FactoryProjectMissingError({ projectId });
      const rulesOverride = yield* overrideOf(
        delivery,
        project.workspaceRoot,
        role === "reviewer"
          ? basis?.tasks === null
            ? "review"
            : "integrate"
          : role === "planner"
            ? "plan"
            : "author",
      );
      const resolved = resolveProjectSettings(
        yield* serverSettings.getSettings,
        project.projectId,
        project,
      ).settings;
      const item = yield* work.getItem(itemReader(deliveryId), { ref: delivery.itemRef });
      // What the manager is asked about: this very read, which the opening renders. A child's
      // launch also says whether its item still says what its parent's frozen task does.
      const fingerprint = workItemScopeFingerprint(item);
      const scope: FactoryAdmission.FactoryOpening | null = governed
        ? {
            root,
            deliveryId,
            role,
            fingerprint,
            status: item.status,
            ...(delivery.parentId === null
              ? {}
              : {
                  childScopeMatches: yield* childScopeMatches(
                    delivery.parentId,
                    deliveryId,
                    fingerprint,
                  ),
                }),
          }
        : null;
      // A managed parent's integrate reviewer judges the tasks its approval froze, as their rows
      // store them.
      const reviewed =
        governed && basis !== null && basis.tasks !== null
          ? { ...basis, tasks: yield* frozenTasks(deliveryId) }
          : basis;

      const { workspace } = effect;
      // Read before anything is dispatched, so a base ref that names no commit launches nothing.
      // A later thread's baseline is its worktree's HEAD now, before its first turn.
      const before =
        workspace.type === "worktree"
          ? yield* resolveCommit(project.workspaceRoot, workspace.baseRef)
          : yield* resolveCommit(workspace.worktreePath, "HEAD");

      const modelSelection = yield* launchSelection(delivery, role, resolved.defaultModelSelection);
      const runtimeMode = yield* launchRuntimeMode(
        delivery,
        role,
        modelSelection.instanceId,
        resolved.defaultRuntimeMode,
      );
      // The snapshot clients read, so a composer and a launch agree. Every launch reads it already,
      // for its effort, and an uncapped one reads nothing else of its provider.
      yield* refuseHostDisallowed(
        (yield* providers.getProviders).find(
          (provider) => provider.instanceId === modelSelection.instanceId,
        ),
        role,
        modelSelection.instanceId,
        runtimeMode,
        state.reviewedExecution === undefined ? "resume" : "review",
        state.reviewedExecution === undefined && state.runtimeModeCeiling !== undefined
          ? { ceiling: state.runtimeModeCeiling }
          : {},
      );
      // A task's reviewer judges its commits; a parent's integrate reviewer its whole branch, by
      // every approved task's criteria.
      const reviewOpening = ({ baseline, receipt, tasks }: NonNullable<typeof basis>) =>
        tasks === null
          ? {
              title: reviewThreadTitle(item),
              text: renderReviewPrompt(
                { item, branch: state.branch, baseline, receipt },
                rulesOverride,
              ),
            }
          : {
              title: integrateThreadTitle(item),
              text: renderIntegratePrompt({
                item,
                branch: state.branch,
                baseRef: state.baseRef,
                base: baseline,
                receipt,
                tasks,
                rulesOverride,
              }),
            };
      // Planners and reviewers work in plan mode: they read and judge, and never change the
      // worktree.
      const opening =
        reviewed !== null
          ? { ...reviewOpening(reviewed), interactionMode: "plan" as const }
          : role === "planner"
            ? {
                title: planThreadTitle(item),
                text: renderPlanPrompt({ item, branch: state.branch, rulesOverride }),
                interactionMode: "plan" as const,
              }
            : {
                title: authorThreadTitle(item),
                text: renderAuthorPrompt({ item, branch: state.branch, rulesOverride }),
                interactionMode: "default" as const,
              };
      // Derived from the effect, so a retried launch replays its receipt instead of starting a
      // second thread, and finds its Work link already stored.
      const commandId = CommandId.make(`factory-launch:${deliveryId}:${effect.id}`);
      const messageId = launchMessageId(deliveryId, effect.id);
      const threadId = launchThreadId(deliveryId, effect.id);
      const openingMessage = { messageId, text: opening.text, attachments: [] };
      const launchInput = {
        commandId,
        threadId,
        projectId,
        title: opening.title,
        modelSelection,
        // The default as it is now, so a narrowed one narrows later launches too; a raised one
        // never takes a launch past the ceiling the delivery started with.
        runtimeMode,
        interactionMode: opening.interactionMode,
        workspaceStrategy:
          workspace.type === "worktree"
            ? { type: "worktree", baseRef: workspace.baseRef, branch: workspace.branch }
            : { type: "existing_worktree", worktreePath: workspace.worktreePath },
        createdBy: "system",
        creationSource: "server",
      } satisfies ThreadLaunch.ThreadLaunchInput;
      // Asked last before the opening goes out, after whatever preparation, setup, recovery or
      // replay came first, so a refusal sends none; the launch fails, and a resume that replays it
      // asks again. Nothing to ask for a root nothing manages.
      const authorizeOpening =
        scope === null
          ? Effect.void
          : admission.authorizeOpening(scope).pipe(
              Effect.flatMap((decision) =>
                decision.type === "allow"
                  ? Effect.void
                  : Effect.fail(
                      new FactoryAdmission.FactoryOpeningRefusedError({
                        deliveryId,
                        role,
                        category: decision.category,
                      }),
                    ),
              ),
            );
      // Core starts the opening turn's run once it has prepared the workspace, and fails that run
      // when it cannot. An existing worktree is there already, so it gets `beforeOpening` first,
      // unless a replay finds the turn sent, and is launched as any other, with the opening: a
      // managed root's manager is asked between the two. A new one exists only once the launch
      // prepared it, so that launch leaves the turn for Factory to send after.
      if (
        (beforeOpening !== undefined || scope !== null) &&
        workspace.type === "existing_worktree" &&
        !(yield* openingSent(threadId, messageId))
      ) {
        if (beforeOpening !== undefined) yield* beforeOpening(workspace.worktreePath);
        yield* authorizeOpening;
      }
      // An existing thread without its opening still needs recovery if setup was cleared since
      // the runless launch. A fresh unconfigured launch keeps core's with-message path, unless a
      // manager has to allow its opening once the worktree is ready: core would send it then.
      const runless =
        workspace.type === "worktree" &&
        (scope !== null ||
          beforeOpening !== undefined ||
          (yield* openingSent(threadId, messageId)) === false)
          ? { workspace, setup: beforeOpening }
          : undefined;
      // Work links the thread to the delivery's item before the launch runs, so a run that ends
      // before the launch returns is recorded on the link; a launch that creates no thread leaves
      // no link.
      const launched = yield* work.linkLaunch(
        { ref: delivery.itemRef, threadId, origin: "factory" },
        launches.launch(
          runless === undefined ? { ...launchInput, initialMessage: openingMessage } : launchInput,
        ),
      );
      // Under the command core's own launch sends it with, so a launch replayed without setup
      // (its command since cleared) replays this turn instead of queuing a second.
      const sendOpening = ThreadMessageIntake.sendToThread({
        projectId,
        commandId: CommandId.make(`${commandId}:initial-message`),
        threadId,
        ...openingMessage,
        modelSelection,
        // After a turn the owner may have sent meanwhile; never steering it.
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      }).pipe(Effect.provideContext(intakeContext));
      // A replay after the opening turn was sent finds its run, and runs nothing before it again.
      const run =
        launched.projection.runs.find((candidate) => candidate.userMessageId === messageId) ??
        (runless === undefined
          ? undefined
          : !launched.resumed
            ? yield* Effect.gen(function* () {
                const worktreePath = yield* awaitRunlessWorkspace(threadId);
                if (runless.setup !== undefined) yield* runless.setup(worktreePath);
                yield* authorizeOpening;
                return (yield* sendOpening).run;
              })
            : // A replay without the turn takes the worktree as the preparation left it, runs
              // setup there and launches into it as into any existing worktree, so core starts
              // the turn once it has prepared the workspace. A preparation already at readiness
              // has handed off the workspace, even while it observes async setup completion.
              yield* Effect.gen(function* () {
                const prepared = yield* awaitPreparation(threadId, ({ snapshot }) =>
                  snapshot?.phase === "running" && !releasable(snapshot)
                    ? undefined
                    : snapshot !== null && releasable(snapshot),
                );
                const { branch, baseRef } = runless.workspace;
                const worktreePath = yield* recoverWorktree({
                  threadId,
                  root: project.workspaceRoot,
                  branch,
                  baseRef,
                  options: {
                    worktreesDirectory: resolved.worktreesDirectory,
                    submodules: resolved.worktreeSubmodules,
                  },
                  commandId,
                });
                if (runless.setup !== undefined) yield* runless.setup(worktreePath);
                yield* authorizeOpening;
                // Releasing through the same still-running core preparation would leave the new
                // run waiting behind its async observer. It already handed off this workspace.
                if (prepared) return (yield* sendOpening).run;
                const relaunched = yield* launches.launch({
                  ...launchInput,
                  workspaceStrategy: { type: "existing_worktree", worktreePath, branch },
                  initialMessage: openingMessage,
                });
                return relaunched.projection.runs.find(
                  (candidate) => candidate.userMessageId === messageId,
                );
              }));
      if (run === undefined) {
        return yield* new FactoryLaunchRunMissingError({ deliveryId, threadId });
      }
      const worktreePath = yield* awaitWorkspace(threadId, run.id);
      // A launch that recorded no new worktree ended its run before anything ran.
      const baseline =
        workspace.type === "worktree" && worktreePath !== null
          ? yield* branchStart(worktreePath, workspace.branch, before)
          : before;
      return { threadId, runId: run.id, worktreePath, baseline };
    });

  /**
   * Sends a follow-up turn on the effect's thread, with the thread's own model unless
   * `modelSelection` is given. Its ids derive from the effect, so a retried send replays its
   * receipt instead of sending twice.
   */
  const sendTurn = (
    delivery: StoredFactoryDelivery,
    effect: { readonly id: number; readonly threadId: ThreadId },
    kind: keyof typeof TURN_ROLES,
    text: string,
    modelSelection?: ModelSelection | void,
    threadRead: ThreadRead = projections.getThreadRecords(effect.threadId, []),
  ) =>
    Effect.gen(function* () {
      let selection = modelSelection ?? undefined;
      const { thread } = yield* threadRead;
      if (selection === undefined && kind !== "fix-commit") {
        const restored = yield* beforeMechanical(effect.threadId, thread.modelSelection);
        if (restored !== thread.modelSelection) selection = restored;
      }
      // The provider this turn would run on and the mode it would run in, as its run would resolve
      // them; refusing here leaves both as they are, and queues nothing.
      const { instanceId } = selection ?? thread.modelSelection;
      const snapshot = (yield* providers.getProviders).find(
        (provider) => provider.instanceId === instanceId,
      );
      yield* refuseHostDisallowed(
        snapshot,
        TURN_ROLES[kind],
        instanceId,
        RuntimePolicy.providerRuntimeMode(thread.runtimeMode, snapshot?.supportedRuntimeModes),
        delivery.state.reviewedExecution === undefined ? "thread" : "review",
        { threadId: effect.threadId },
      );
      return yield* ThreadMessageIntake.sendToThread({
        projectId: delivery.projectId,
        commandId: CommandId.make(`factory-${kind}:${delivery.deliveryId}:${effect.id}`),
        threadId: effect.threadId,
        messageId: turnMessageId(kind, delivery.deliveryId, effect.id),
        text,
        attachments: [],
        ...(selection === undefined ? {} : { modelSelection: selection }),
        // After whatever the thread is still doing; never steering or interrupting it.
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      }).pipe(
        Effect.map((sent) => ({ runId: sent.run.id })),
        Effect.provideContext(intakeContext),
      );
    });

  /** The text of the run's last assistant message that has any; null when it has none. */
  const lastAssistantText = (threadId: ThreadId, runId: RunId) =>
    projections
      .getThreadRecords(threadId, ["messages"], {
        messageRunIds: [runId],
        messageRoles: ["assistant"],
      })
      .pipe(
        Effect.map(
          ({ messages }) =>
            messages.findLast((message) => message.text.trim().length > 0)?.text ?? null,
        ),
      );

  const repairText = (
    delivery: StoredFactoryDelivery,
    effect: Extract<FactoryEffect, { readonly type: "send_repair_turn" }>,
  ) =>
    Effect.gen(function* () {
      const { deliveryId, state } = delivery;
      const missing = new FactoryTurnBasisMissingError({ deliveryId, turn: effect.kind });
      const rulesOverride = yield* projectOverride(delivery, effect.kind);
      if (effect.kind === "fix-verify") {
        const receipt = state.receipts.at(-1);
        if (receipt === undefined) return yield* missing;
        const tail = yield* readLogTail(receipt.logPath);
        return renderFixVerifyPrompt({
          receipt,
          tail,
          branch: state.branch,
          round: effect.round,
          rulesOverride,
        });
      }
      const accepted = state.reviews.at(-1);
      if (accepted === undefined) return yield* missing;
      const evidence = yield* readReviewEvidence(accepted.evidencePath);
      const { blockingSeverities } =
        state.reviewedExecution ?? (yield* factorySettings.get(delivery.projectId));
      return renderFixReviewPrompt({
        headSha: accepted.summary.headSha,
        findings: findingsToFix(evidence.review, blockingSeverities),
        // The findings are listed in full above.
        otherReasons: evidence.blockingReasons
          .filter(({ rule }) => rule !== "changes_required" && rule !== "blocking_finding")
          .map(({ description }) => description),
        branch: state.branch,
        round: effect.round,
        rulesOverride,
      });
    }).pipe(Effect.provideContext(intakeContext));

  const followUpText = (delivery: StoredFactoryDelivery) =>
    Effect.gen(function* () {
      const { deliveryId, state } = delivery;
      const basis = yield* reviewBasis(delivery);
      const previous = state.reviews.at(-1);
      if (previous === undefined) {
        return yield* new FactoryTurnBasisMissingError({ deliveryId, turn: "review-follow-up" });
      }
      const evidence = yield* readReviewEvidence(previous.evidencePath);
      const response = state.reviewResponse;
      return renderReviewFollowUpPrompt({
        rulesOverride: yield* projectOverride(delivery, "review"),
        round: basis.round,
        branch: state.branch,
        baseline: basis.baseline,
        receipt: basis.receipt,
        previous: { headSha: previous.summary.headSha, findings: evidence.review.findings },
        authorResponse:
          response === null ? null : yield* lastAssistantText(response.threadId, response.runId),
      });
    }).pipe(Effect.provideContext(intakeContext));

  const carriesFactoryTurn: FactoryThreadEffects["Service"]["carriesFactoryTurn"] = (
    threadId,
    runId,
    adopted,
  ) =>
    projections.getThreadRecords(threadId, ["runs"]).pipe(
      Effect.map(({ runs }) => {
        let run = runs.find((candidate) => candidate.id === runId);
        // Each continuation names the run it continues; a chain is never longer than the runs.
        for (let hops = 0; run !== undefined && hops <= runs.length; hops += 1) {
          if (FACTORY_MESSAGE.test(run.userMessageId) || adopted.includes(run.id)) return true;
          const continued = run.restartContinuationOfRunId;
          run =
            continued === undefined
              ? undefined
              : runs.find((candidate) => candidate.id === continued);
        }
        return false;
      }),
    );

  /**
   * The run the thread is live in, when it carries on a turn Factory sent or a wake the delivery
   * took as its own; none when it runs nothing, or runs the owner's turn.
   */
  const factoryLiveRun = (delivery: StoredFactoryDelivery, threadId: ThreadId) =>
    Effect.gen(function* () {
      const [live] = yield* liveRunsOn([threadId]);
      if (live === undefined) return undefined;
      const factory = yield* carriesFactoryTurn(threadId, live.runId, adoptedRuns(delivery.state));
      return factory ? live.runId : undefined;
    });

  const liveRunsOn: FactoryThreadEffects["Service"]["liveRunsOn"] = (threadIds) =>
    Effect.forEach(threadIds, (threadId) =>
      projections
        .getThreadShell(threadId)
        .pipe(
          Effect.map((shell) =>
            shell === null || shell.deletedAt !== null || shell.activeRunId === null
              ? []
              : [{ threadId, runId: shell.activeRunId }],
          ),
        ),
    ).pipe(Effect.map((runs) => runs.flat()));

  /**
   * Where a publication from `cwd` would go now, each destination by its role (see
   * `FactoryReviewedExecution`), asked of what publishes rather than worked out here: Git's driver
   * for the remote a push picks, the provider for the repository its pull request targets. Whatever
   * else may choose a remote reads `remoteConfig`, which is why all of it is bound. `tracked` is the
   * same of the branch's upstream remote once it has one, since a push can go there instead and the
   * pull request's head is read from it.
   */
  const publicationOf = (cwd: string, branch: string | null) =>
    Effect.gen(function* () {
      const lines = (args: ReadonlyArray<string>) =>
        git
          .execute({
            operation: "FactoryThreadEffects.publicationOf",
            cwd,
            args: [...args],
            allowNonZeroExit: true,
            timeoutMs: 30_000,
          })
          .pipe(
            Effect.map(({ exitCode, stdout }) =>
              exitCode === 0 ? stdout.split("\n").filter((line) => line.length > 0) : [],
            ),
          );
      const urls = (remote: string | null, flags: ReadonlyArray<string>) =>
        remote === null
          ? Effect.succeed<ReadonlyArray<string>>([])
          : Effect.map(lines(["remote", "get-url", ...flags, "--", remote]), (found) =>
              [...new Set(found)].toSorted(),
            );
      const picked = yield* git.resolvePushRemoteName(cwd, branch);
      const upstream =
        branch === null ? null : yield* git.readConfigValue(cwd, `branch.${branch}.remote`);
      const { provider } = yield* sourceControl.resolveHandle({ cwd });
      return {
        push: yield* urls(picked, ["--push", "--all"]),
        head: yield* urls(picked, ["--all"]),
        provider: provider.kind,
        repository:
          provider.resolveChangeRequestRepository === undefined
            ? null
            : yield* provider.resolveChangeRequestRepository({ cwd }),
        remoteConfig: reviewedContentHash(
          (yield* lines(["config", "--get-regexp", "^(remote|url)\\."])).join("\n"),
        ),
        tracked:
          upstream === null || upstream === "."
            ? null
            : {
                push: yield* urls(upstream, ["--push", "--all"]),
                head: yield* urls(upstream, ["--all"]),
              },
      };
    });

  /** The project's default runtime mode as a new thread of it takes it now. */
  const projectDefaults = (
    project: { readonly projectId: ProjectId } & Parameters<typeof resolveProjectSettings>[2],
  ) =>
    Effect.map(
      serverSettings.getSettings,
      (settings) => resolveProjectSettings(settings, project.projectId, project).settings,
    );

  /**
   * Refuses what any effect of the delivery depends on: its repository and publication target, its
   * pipeline, the project's default mode and what the providers of the roles it uses offer. It reads
   * where publication runs, its worktree once it has one; a target that cannot be read, or that its
   * provider cannot name, is refused.
   */
  const checkReviewedDelivery = (
    { projectId, state }: StoredFactoryDelivery,
    reviewed: FactoryReviewedExecution,
  ) =>
    Effect.gen(function* () {
      const project = Option.getOrUndefined(yield* projects.get(projectId));
      const { repository } = reviewed;
      const refuse = (reason: "repository" | "pipeline") =>
        new FactoryReviewedExecutionRefusedError({ reason });
      if (
        project === undefined ||
        repository.projectId !== projectId ||
        repository.workspaceRoot !== project.workspaceRoot
      ) {
        return yield* refuse("repository");
      }
      const publication = yield* publicationOf(
        state.worktreePath ?? project.workspaceRoot,
        state.branch,
      ).pipe(Effect.orElseSucceed(() => undefined));
      if (publication !== undefined && publicationTargetUnbound(publication)) {
        return yield* new FactoryReviewedExecutionRefusedError({
          reason: "publication_target",
          provider: publication.provider,
        });
      }
      const bound = repository.publication;
      if (
        publication === undefined ||
        !sameUrls(publication.push, bound.push) ||
        !sameUrls(publication.head, bound.head) ||
        publication.provider !== bound.provider ||
        publication.repository !== bound.repository ||
        publication.remoteConfig !== bound.remoteConfig ||
        (publication.tracked !== null &&
          (!sameUrls(publication.tracked.push, bound.push) ||
            !sameUrls(publication.tracked.head, bound.head)))
      ) {
        return yield* refuse("repository");
      }
      if (!pipelines.has(reviewed.pipelineId)) return yield* refuse("pipeline");
      const { defaultRuntimeMode } = yield* projectDefaults(project);
      if (runtimeModeRank[defaultRuntimeMode] < runtimeModeRank[reviewed.runtimeCeiling]) {
        return yield* new FactoryReviewedExecutionRefusedError({
          reason: "project_default",
          runtimeMode: reviewed.runtimeCeiling,
        });
      }
      // A parent plans; every delivery's later turns are an author's and a reviewer's.
      const used =
        state.kind === "parent" ? FactoryRole.literals : (["author", "reviewer"] as const);
      for (const role of used) {
        yield* checkOfferedMode(reviewed.roles[role].instanceId, reviewed.runtimeCeiling, role);
      }
    });

  /**
   * Refuses a mode the provider no longer offers, which it would run as another, for a role's
   * thread or, with none, a delegated one.
   */
  const checkOfferedMode = (
    instanceId: ProviderInstanceId,
    runtimeMode: RuntimeMode,
    role: FactoryRole | undefined,
  ) =>
    Effect.gen(function* () {
      const modes = yield* offeredModes(instanceId);
      if (modes !== undefined && modes.length > 0 && !modes.includes(runtimeMode)) {
        return yield* new FactoryReviewedExecutionRefusedError({
          reason: "provider_mode",
          ...(role === undefined ? {} : { role }),
          instanceId,
          runtimeMode,
        });
      }
    });

  /** Refuses a role's selection its provider no longer offers, or a mode it would not run in. */
  const checkReviewedRole = (
    reviewed: FactoryReviewedExecution,
    role: FactoryRole,
    runtimeMode: RuntimeMode,
  ) =>
    Effect.gen(function* () {
      const { instanceId, model } = reviewed.roles[role];
      const offered = (yield* providers.getProviders)
        .find((provider) => provider.instanceId === instanceId)
        ?.models.find(({ slug }) => slug === model);
      if (offered === undefined) {
        return yield* new FactoryReviewedExecutionRefusedError({
          reason: "model",
          role,
          instanceId,
          model,
        });
      }
      if (!offersOptions(reviewed.roles[role], offered.capabilities?.optionDescriptors)) {
        return yield* new FactoryReviewedExecutionRefusedError({
          reason: "options",
          role,
          instanceId,
        });
      }
      yield* checkOfferedMode(instanceId, runtimeMode, role);
    });

  /**
   * The mode a turn would run in on the thread, refusing one broader than the review, for a role's
   * thread or, with none, a delegated one.
   */
  const reviewedThreadMode = (
    reviewed: FactoryReviewedExecution,
    role: FactoryRole | undefined,
    threadId: ThreadId,
  ) =>
    Effect.gen(function* () {
      const { runtimeMode } = (yield* projections.getThreadRecords(threadId, [])).thread;
      if (runtimeModeRank[runtimeMode] > runtimeModeRank[reviewed.runtimeCeiling]) {
        return yield* new FactoryReviewedExecutionRefusedError({
          reason: "thread_mode",
          ...(role === undefined ? {} : { role }),
          runtimeMode: reviewed.runtimeCeiling,
        });
      }
      return runtimeMode;
    });

  /** Refuses an automatic turn or a delegation of a reviewed delivery in a mode its host refuses. */
  const refuseReviewedHostDisallowed = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
    Effect.gen(function* () {
      const snapshot = yield* instanceSnapshot(instanceId);
      if (snapshot === undefined || runtimeModeRefusal(snapshot, runtimeMode) === null) return;
      return yield* new FactoryReviewedExecutionRefusedError({
        reason: "host_policy",
        instanceId,
        runtimeMode,
        provider: snapshot.displayName ?? snapshot.driver,
      });
    });

  /**
   * The role this delivery's launch made the thread for. An author's or a planner's launch is
   * recorded as it is issued and never replaced, so any other launch of the delivery is a
   * reviewer's, which a later review's launch leaves in no role. None for a thread no launch of the
   * delivery made, which is a delegated one.
   */
  const launchedRole = (
    { deliveryId, state }: StoredFactoryDelivery,
    threadId: ThreadId,
  ): FactoryRole | undefined => {
    const current = FactoryRole.literals.find((role) => state.threads[role] === threadId);
    if (current !== undefined) return current;
    if (launchDeliveryId(threadId) !== deliveryId) return undefined;
    const madeBy = (launch: FactoryLaunchEffect | undefined) =>
      launch !== undefined && launchThreadId(deliveryId, launch.id) === threadId;
    if (madeBy(unrecordedAuthorLaunch(state))) return "author";
    if (madeBy(unrecordedPlannerLaunch(state))) return "planner";
    return "reviewer";
  };

  /** Refuses what the review no longer allows on the thread; returns the role it judged it by. */
  const judgeReviewedThread = (
    delivery: StoredFactoryDelivery,
    reviewed: FactoryReviewedExecution,
    threadId: ThreadId,
  ) =>
    Effect.gen(function* () {
      yield* checkReviewedDelivery(delivery, reviewed);
      const role = launchedRole(delivery, threadId);
      const runtimeMode = yield* reviewedThreadMode(reviewed, role, threadId);
      const { thread } = yield* projections.getThreadRecords(threadId, []);
      yield* refuseReviewedHostDisallowed(
        role === undefined ? thread.modelSelection.instanceId : reviewed.roles[role].instanceId,
        runtimeMode,
      );
      if (role !== undefined) {
        yield* checkReviewedRole(reviewed, role, runtimeMode);
        return role;
      }
      yield* checkOfferedMode(thread.modelSelection.instanceId, runtimeMode, undefined);
      return undefined;
    });

  const checkReviewed: FactoryThreadEffects["Service"]["checkReviewed"] = (delivery, effect) =>
    Effect.gen(function* () {
      const { reviewedExecution: reviewed } = delivery.state;
      if (reviewed === undefined) return;
      yield* checkReviewedDelivery(delivery, reviewed);
      const role = reviewedRoleOf(effect);
      if (role === undefined) return;
      yield* checkReviewedRole(
        reviewed,
        role,
        isTurnEffect(effect)
          ? yield* reviewedThreadMode(reviewed, role, effect.threadId)
          : reviewed.runtimeCeiling,
      );
    });

  const checkThreadHostPolicy: FactoryThreadEffects["Service"]["checkThreadHostPolicy"] = (
    threadId,
    launchedBy,
  ) =>
    Effect.gen(function* () {
      const { thread } = yield* projections.getThreadRecords(threadId, []);
      const delivery =
        launchedBy === null ? undefined : Option.getOrUndefined(yield* deliveries.get(launchedBy));
      const { instanceId } = thread.modelSelection;
      const snapshot = (yield* providers.getProviders).find(
        (provider) => provider.instanceId === instanceId,
      );
      yield* refuseHostDisallowed(
        snapshot,
        delivery === undefined ? undefined : launchedRole(delivery, threadId),
        instanceId,
        RuntimePolicy.providerRuntimeMode(thread.runtimeMode, snapshot?.supportedRuntimeModes),
        delivery?.state.reviewedExecution === undefined ? "automatic_turn" : "review",
        { threadId },
      );
    }).pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.void }));

  const checkReviewedThread: FactoryThreadEffects["Service"]["checkReviewedThread"] = (
    threadId,
    launchedBy,
  ) =>
    Effect.gen(function* () {
      const delivery = Option.getOrUndefined(yield* deliveries.get(launchedBy));
      const reviewed = delivery?.state.reviewedExecution;
      if (delivery === undefined || reviewed === undefined) return;
      yield* judgeReviewedThread(delivery, reviewed, threadId);
    });

  const prepareReviewedTurn: FactoryThreadEffects["Service"]["prepareReviewedTurn"] = (
    threadId,
    launchedBy,
  ) =>
    Effect.gen(function* () {
      const delivery = Option.getOrUndefined(yield* deliveries.get(launchedBy));
      const reviewed = delivery?.state.reviewedExecution;
      if (delivery === undefined || reviewed === undefined) return;
      const role = yield* judgeReviewedThread(delivery, reviewed, threadId);
      if (role === undefined) return;
      const { thread } = yield* projections.getThreadRecords(threadId, []);
      const selection = yield* reviewedSelection(reviewed, role, threadId);
      if (modelSelectionsEqual(thread.modelSelection, selection)) return;
      yield* threads.dispatch({
        type: "thread.model-selection.set",
        // Per thread position, so a repeat replays and a later drift is set back again.
        commandId: CommandId.make(
          `factory-reviewed-selection:${threadId}:${yield* threads.getThreadEventSequence(threadId)}`,
        ),
        threadId,
        modelSelection: selection,
      });
    });

  /**
   * What a review binds of the settings given, all but where publication goes. Each caller passes
   * the one read of them it judges, so what it shows and what it binds can never differ.
   */
  const reviewedValues = (
    project: { readonly workspaceRoot: string },
    settings: FactorySettings.FactoryDeliverySettings,
    defaults: {
      readonly defaultModelSelection: ModelSelection | null | undefined;
      readonly defaultRuntimeMode: RuntimeMode;
    },
    runtimeCeiling: RuntimeMode,
  ) =>
    Effect.gen(function* () {
      const roles = {
        planner: roleSelection(settings.roles, "planner", defaults.defaultModelSelection),
        author: roleSelection(settings.roles, "author", defaults.defaultModelSelection),
        reviewer: roleSelection(settings.roles, "reviewer", defaults.defaultModelSelection),
      };
      let ceiling =
        runtimeModeRank[runtimeCeiling] < runtimeModeRank[defaults.defaultRuntimeMode]
          ? runtimeCeiling
          : defaults.defaultRuntimeMode;
      for (const role of FactoryRole.literals) {
        const { instanceId } = roles[role];
        const mode = offeredWithin(ceiling, yield* offeredModes(instanceId));
        if (mode === undefined) {
          return yield* new FactoryRuntimeModeUnavailableError({
            role,
            instanceId,
            runtimeMode: ceiling,
          });
        }
        ceiling = mode;
      }
      // What a review would run is one it can never launch: said now, rather than after the start.
      // Read as the modes above are, since this also runs inside a start's transaction.
      for (const role of FactoryRole.literals) {
        const { instanceId } = roles[role];
        yield* refuseHostDisallowed(
          yield* instanceSnapshot(instanceId),
          role,
          instanceId,
          ceiling,
          "before_review",
        );
      }
      const override = (prompt: FactoryPromptName) =>
        readOverride(project.workspaceRoot, prompt).pipe(
          Effect.map((text) =>
            text === undefined ? ("absent" as const) : reviewedContentHash(text),
          ),
        );
      return {
        roles,
        verifyCommand: settings.verifyCommand,
        setupCommand: settings.setupCommand,
        limits: {
          maxFixRounds: settings.limits.maxFixRounds,
          maxReviewRounds: settings.limits.maxReviewRounds,
          maxFixCommitTurns: FIX_COMMIT_TURNS,
          verifyTimeoutMinutes: settings.limits.verifyTimeoutMinutes,
        },
        blockingSeverities: settings.blockingSeverities,
        highRiskEffort: settings.highRiskEffort,
        pipelineId: settings.pipelineId,
        runtimeCeiling: ceiling,
        promptOverrides: {
          plan: yield* override("plan"),
          author: yield* override("author"),
          review: yield* override("review"),
          "fix-verify": yield* override("fix-verify"),
          "fix-review": yield* override("fix-review"),
          "fix-commit": yield* override("fix-commit"),
          integrate: yield* override("integrate"),
        },
      };
    });

  /** The whole of a review of the settings given, with where publication goes as asked now. */
  const reviewedExecutionOf = (
    project: { readonly projectId: ProjectId; readonly workspaceRoot: string },
    settings: FactorySettings.FactoryDeliverySettings,
    defaults: {
      readonly defaultModelSelection: ModelSelection | null | undefined;
      readonly defaultRuntimeMode: RuntimeMode;
    },
    input: {
      readonly receiptId: FactoryReviewedExecution["receiptId"];
      readonly reviewVersion: number;
      readonly runtimeCeiling: RuntimeMode;
    },
  ) =>
    Effect.gen(function* () {
      // Named by no branch yet: only the delivery's start names it.
      const { tracked: _tracked, ...publication } = yield* publicationOf(
        project.workspaceRoot,
        null,
      );
      if (publicationTargetUnbound(publication)) {
        return yield* new FactoryReviewedExecutionRefusedError({
          reason: "publication_target",
          provider: publication.provider,
        });
      }
      const values = yield* reviewedValues(project, settings, defaults, input.runtimeCeiling);
      return {
        receiptId: input.receiptId,
        reviewVersion: input.reviewVersion,
        ...values,
        repository: {
          projectId: project.projectId,
          workspaceRoot: project.workspaceRoot,
          publication,
        },
      } satisfies FactoryReviewedExecution;
    });

  const resolveReviewedExecution: FactoryThreadEffects["Service"]["resolveReviewedExecution"] = ({
    projectId,
    receiptId,
    reviewVersion,
    runtimeCeiling,
  }) =>
    Effect.gen(function* () {
      const settings = yield* factorySettings.requireDeliverySettings(projectId);
      const project = Option.getOrUndefined(yield* projects.get(projectId));
      if (project === undefined) return yield* new FactoryProjectMissingError({ projectId });
      return yield* reviewedExecutionOf(project, settings, yield* projectDefaults(project), {
        receiptId,
        reviewVersion,
        runtimeCeiling,
      });
    });

  const previewReviewedExecution: FactoryThreadEffects["Service"]["previewReviewedExecution"] = ({
    projectId,
    runtimeCeiling,
  }) =>
    Effect.gen(function* () {
      const project = Option.getOrUndefined(yield* projects.get(projectId));
      if (project === undefined) return yield* new FactoryProjectMissingError({ projectId });
      const settings = yield* factorySettings.get(projectId);
      const defaults = yield* projectDefaults(project);
      const available = yield* providers.getProviders;
      const describe = (role: FactoryRole) => {
        const selection = roleSelection(settings.roles, role, defaults.defaultModelSelection);
        const model = available
          .find((provider) => provider.instanceId === selection.instanceId)
          ?.models.find(({ slug }) => slug === selection.model);
        return {
          selection,
          offered: model !== undefined,
          options: (selection.options ?? []).map((option) => ({
            id: option.id,
            value: option.value,
            supported: offersOptions(
              { ...selection, options: [option] },
              model?.capabilities?.optionDescriptors,
            ),
          })),
        };
      };
      const { verifyCommand } = settings;
      const resolved = yield* Effect.result(
        Effect.gen(function* () {
          if (verifyCommand === null) {
            return yield* new FactorySettings.FactoryVerifyCommandMissingError({ projectId });
          }
          return yield* reviewedExecutionOf(project, { ...settings, verifyCommand }, defaults, {
            // A start replaces both with its own.
            receiptId: "preview",
            reviewVersion: 1,
            runtimeCeiling,
          });
        }),
      );
      return {
        roles: {
          planner: describe("planner"),
          author: describe("author"),
          reviewer: describe("reviewer"),
        },
        verifyCommand: settings.verifyCommand,
        setupCommand: settings.setupCommand,
        limits: settings.limits,
        blockingSeverities: settings.blockingSeverities,
        highRiskEffort: settings.highRiskEffort,
        pipelineId: settings.pipelineId,
        execution: Result.isSuccess(resolved) ? resolved.success : null,
        refusal: Result.isSuccess(resolved) ? null : reviewRefusalText(resolved.failure),
      };
    });

  const deliveryExecution: FactoryThreadEffects["Service"]["deliveryExecution"] = (delivery) =>
    Effect.gen(function* () {
      const { state, projectId } = delivery;
      const reviewed = state.reviewedExecution;
      const ended = state.status === "done" || state.status === "cancelled";
      const used: ReadonlyArray<FactoryRole> =
        state.kind === "parent" ? ["planner", "reviewer"] : ["author", "reviewer"];
      const roles: Array<FactoryRoleExecution> = [];
      for (const role of used) {
        const threadId = state.threads[role];
        const records =
          threadId === undefined
            ? undefined
            : yield* projections.getThreadRecords(threadId, ["providerThreads", "runs"]).pipe(
                Effect.catchTags({
                  ProjectionStoreThreadNotFoundError: () => Effect.succeed(undefined),
                }),
              );
        if (records === undefined && ended) continue;
        const bound = {
          role,
          binding: reviewed === undefined ? ("read_now" as const) : ("reviewed" as const),
          ...(reviewed === undefined ? {} : { reviewed: reviewed.roles[role] }),
        };
        if (records === undefined) {
          const project = Option.getOrUndefined(yield* projects.get(projectId));
          if (project === undefined) return yield* new FactoryProjectMissingError({ projectId });
          const defaults = yield* projectDefaults(project);
          roles.push({
            ...bound,
            selection: yield* launchSelection(delivery, role, defaults.defaultModelSelection),
          });
          continue;
        }
        // Only the active provider thread's report is about this thread as it runs now.
        const acknowledged = records.providerThreads.find(
          (candidate) =>
            candidate.id === records.thread.activeProviderThreadId &&
            candidate.providerInstanceId === records.thread.modelSelection.instanceId,
        )?.nativeMetadata?.modelSelection;
        const latest = records.runs.reduce<(typeof records.runs)[number] | undefined>(
          (newest, run) => (newest === undefined || run.ordinal > newest.ordinal ? run : newest),
          undefined,
        );
        roles.push({
          ...bound,
          selection: latest?.modelSelection ?? records.thread.modelSelection,
          ...(acknowledged === undefined ? {} : { acknowledged }),
        });
      }
      return { roles };
    });

  const reviewedExecutionHolds: FactoryThreadEffects["Service"]["reviewedExecutionHolds"] = ({
    projectId,
    runtimeCeiling,
    execution,
  }) =>
    Effect.gen(function* () {
      const project = Option.getOrUndefined(yield* projects.get(projectId));
      if (project === undefined) return false;
      const settings = yield* factorySettings.get(projectId);
      const { verifyCommand } = settings;
      if (verifyCommand === null) return false;
      const values = yield* reviewedValues(
        project,
        { ...settings, verifyCommand },
        yield* projectDefaults(project),
        runtimeCeiling,
      );
      return sameReviewedExecution(execution, {
        ...execution,
        ...values,
        repository: { ...execution.repository, workspaceRoot: project.workspaceRoot },
      });
    }).pipe(Effect.orElseSucceed(() => false));

  const chargedTurnSent: FactoryThreadEffects["Service"]["chargedTurnSent"] = (
    { deliveryId },
    effect,
  ) => {
    if (effect.type !== "send_fix_commit_turn" && effect.type !== "send_repair_turn") {
      return Effect.succeed(true);
    }
    const kind = effect.type === "send_repair_turn" ? effect.kind : "fix-commit";
    const messageId = turnMessageId(kind, deliveryId, effect.id);
    return projections.getThreadRecords(effect.threadId, ["runs"]).pipe(
      Effect.map(({ runs }) => runs.some((run) => run.userMessageId === messageId)),
      Effect.orElseSucceed(() => true),
    );
  };

  return FactoryThreadEffects.of({
    launchThread,
    checkReviewed,
    previewReviewedExecution,
    deliveryExecution,
    reviewedExecutionHolds,
    chargedTurnSent,
    checkThreadHostPolicy,
    checkReviewedThread,
    prepareReviewedTurn,
    resolveReviewedExecution,
    sendFixCommitTurn: (delivery, effect) =>
      Effect.gen(function* () {
        const rulesOverride = yield* projectOverride(delivery, "fix-commit");
        // One read of the thread, for its selection and the mode this turn would run in.
        const threadRead = yield* Effect.cached(projections.getThreadRecords(effect.threadId, []));
        const selection = yield* fixCommitSelection(delivery, effect, threadRead);
        return yield* sendTurn(
          delivery,
          effect,
          "fix-commit",
          renderFixCommitPrompt({
            problems: effect.problems,
            branch: delivery.state.branch,
            baseline: delivery.state.baseline,
            checkpoint: effect.checkpoint ?? null,
            rulesOverride,
          }),
          selection,
          threadRead,
        );
      }),
    sendPlanRetryTurn: (delivery, effect) =>
      Effect.gen(function* () {
        const rulesOverride = yield* projectOverride(delivery, "plan");
        return yield* sendTurn(
          delivery,
          effect,
          "plan-retry",
          renderPlanRetryPrompt({
            problems: effect.problems,
            checkpoint: effect.checkpoint ?? null,
            rulesOverride,
          }),
          yield* retrySelection(delivery, "planner", effect.threadId, 1),
        );
      }),
    sendReplanTurn: (delivery, effect) =>
      Effect.gen(function* () {
        const rulesOverride = yield* projectOverride(delivery, "plan");
        return yield* sendTurn(
          delivery,
          effect,
          "replan",
          renderReplanPrompt({ note: effect.note, rulesOverride }),
          yield* retrySelection(delivery, "planner", effect.threadId, 1),
        );
      }),
    sendReviewRetryTurn: (delivery, effect) =>
      Effect.gen(function* () {
        const rulesOverride = yield* projectOverride(
          delivery,
          delivery.state.stage === "integrate" ? "integrate" : "review",
        );
        return yield* sendTurn(
          delivery,
          effect,
          "review-retry",
          renderReviewRetryPrompt({ problems: effect.problems, rulesOverride }),
          yield* retrySelection(delivery, "reviewer", effect.threadId, delivery.state.reviewRound),
        );
      }),
    sendRepairTurn: (delivery, effect) =>
      Effect.gen(function* () {
        const text = yield* repairText(delivery, effect);
        const selection = yield* turnSelection(delivery, "author", effect.threadId, effect.round);
        return yield* sendTurn(delivery, effect, effect.kind, text, selection);
      }),
    sendReviewFollowUpTurn: (delivery, effect) =>
      Effect.gen(function* () {
        const text = yield* followUpText(delivery);
        const selection = yield* turnSelection(delivery, "reviewer", effect.threadId, effect.round);
        return yield* sendTurn(delivery, effect, "review-follow-up", text, selection);
      }),
    launchState: ({ deliveryId }, effect) => {
      const messageId = launchMessageId(deliveryId, effect.id);
      return projections.getThreadRecords(launchThreadId(deliveryId, effect.id), ["runs"]).pipe(
        Effect.map(({ thread, runs }): FactoryLaunchState => {
          if (thread.deletedAt !== null) return "deleted";
          const run = runs.find((candidate) => candidate.userMessageId === messageId);
          return run !== undefined && isTerminalRunStatus(run.status) ? "ended" : "unfinished";
        }),
        Effect.catchTags({
          ProjectionStoreThreadNotFoundError: () => Effect.succeed<FactoryLaunchState>("missing"),
        }),
      );
    },
    threadState: (threadId) =>
      projections.getThreadRecords(threadId, []).pipe(
        Effect.map(({ thread }): FactoryThreadState =>
          thread.deletedAt === null ? "present" : "deleted",
        ),
        Effect.catchTags({
          ProjectionStoreThreadNotFoundError: () => Effect.succeed<FactoryThreadState>("missing"),
        }),
      ),
    liveRun: (threadId) =>
      projections
        .getThreadShell(threadId)
        .pipe(
          Effect.map((shell) =>
            shell === null || shell.deletedAt !== null || shell.archivedAt !== null
              ? null
              : shell.activeRunId,
          ),
        ),
    openThread: (threadId) =>
      projections
        .getThreadShell(threadId)
        .pipe(
          Effect.map(
            (shell) =>
              shell !== null &&
              shell.deletedAt === null &&
              shell.settledAt === null &&
              shell.archivedAt === null,
          ),
        ),
    carriesFactoryTurn,
    liveRunsOn,
    launchedLiveRuns: projections
      .getRecoveryThreadIds("runtime")
      .pipe(
        Effect.flatMap((threadIds) =>
          liveRunsOn(threadIds.filter((threadId) => launchDeliveryId(threadId) !== undefined)),
        ),
      ),
    runEnded: (threadId, runId) =>
      readThreadRun(threadId, runId).pipe(
        Effect.map(({ status }) =>
          isTerminalRunStatus(status) ? Option.some(status) : Option.none(),
        ),
      ),
    interruptRun: (delivery, { threadId, runId }) =>
      Effect.gen(function* () {
        const target = runId ?? (yield* factoryLiveRun(delivery, threadId));
        if (target === undefined) return;
        yield* threads.interruptThread({
          projectId: delivery.projectId,
          // One interrupt per run of the delivery, however often it is asked.
          commandId: CommandId.make(`factory-cancel:${delivery.deliveryId}:${target}`),
          threadId,
          runId: target,
          reason: "Factory delivery cancelled",
        });
      }).pipe(Effect.catchTags({ ThreadManagementThreadNotFoundError: () => Effect.void })),
  });
});

export const layer = Layer.effect(FactoryThreadEffects, make).pipe(Layer.provide(EventStore.layer));
