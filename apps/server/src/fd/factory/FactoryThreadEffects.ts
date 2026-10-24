import {
  AuthWorkReadScope,
  CommandId,
  MessageId,
  type ModelSelection,
  ProjectId,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryRole } from "@t3tools/contracts/fd/factory";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../../orchestration-v2/ThreadMessageIntake.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { getAutoBootstrapThreadModelSelection } from "../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { type WorkActor, WorkService } from "../work-management/index.ts";
import { readReviewEvidence, reviewBasis } from "./FactoryReview.ts";
import * as FactorySettings from "./FactorySettings.ts";
import type { StoredFactoryDelivery } from "./persistence/FactoryDeliveryStore.ts";
import { escalateEffort } from "./pipeline/effort.ts";
import {
  type FactoryEffect,
  type FactoryEvent,
  type FactoryTerminalRunStatus,
  isTerminalRunStatus,
} from "./pipeline/state.ts";
import { authorThreadTitle, renderAuthorPrompt } from "./prompts/author.ts";
import { renderFixCommitPrompt } from "./prompts/fixCommit.ts";
import { renderFixReviewPrompt } from "./prompts/fixReview.ts";
import { renderFixVerifyPrompt } from "./prompts/fixVerify.ts";
import {
  renderReviewPrompt,
  renderReviewRetryPrompt,
  reviewThreadTitle,
} from "./prompts/review.ts";
import { renderReviewFollowUpPrompt } from "./prompts/reviewFollowUp.ts";
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

/** Only the author and reviewer roles have prompts in this phase. */
export class FactoryRoleUnsupportedError extends Schema.TaggedError<FactoryRoleUnsupportedError>()(
  "FactoryRoleUnsupportedError",
  { role: FactoryRole },
) {
  override get message(): string {
    return `Factory cannot launch a ${this.role} thread yet.`;
  }
}

/** The ref does not name a commit in the directory, or git could not read it. */
export class FactoryBaselineError extends Schema.TaggedError<FactoryBaselineError>()(
  "FactoryBaselineError",
  { path: Schema.String, ref: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Factory could not resolve ${this.ref} to a commit in ${this.path}.`;
  }
}

/** Neither the branch's reflog nor an unmoved HEAD tells which commit a new worktree started at. */
export class FactoryBranchStartError extends Schema.TaggedError<FactoryBranchStartError>()(
  "FactoryBranchStartError",
  { path: Schema.String, branch: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Factory could not tell which commit branch ${this.branch} started at in ${this.path}.`;
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

/** Whether a thread exists, was deleted, or has no record at all. */
type FactoryThreadState = "present" | "deleted" | "missing";

/**
 * The thread a delivery's launch effect creates. Derived from the effect, like the launch's
 * command and message ids, so a launch issued again replays its thread instead of starting one.
 */
export const launchThreadId = (deliveryId: FactoryDeliveryId, effectId: number) =>
  ThreadId.make(`factory-thread:${deliveryId}:${effectId}`);

/** The first message of a launch's thread, which starts the launch's run. */
const launchMessageId = (deliveryId: FactoryDeliveryId, effectId: number) =>
  MessageId.make(`factory-launch-message:${deliveryId}:${effectId}`);

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
     * then).
     */
    readonly launchThread: (
      delivery: StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "launch_thread" }>,
    ) => Effect.Effect<FactoryThreadLaunch, FactoryThreadEffectFailure>;
    /** Sends the turn and reports the run it started on the effect's thread. */
    readonly sendFixCommitTurn: (
      delivery: StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "send_fix_commit_turn" }>,
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
    /** What became of the launch effect's thread and its first run. */
    readonly launchState: (
      delivery: StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "launch_thread" }>,
    ) => Effect.Effect<FactoryLaunchState, ProjectionStore.ProjectionStoreV2Error>;
    /** Whether the thread exists, was deleted, or has no record at all. */
    readonly threadState: (
      threadId: ThreadId,
    ) => Effect.Effect<FactoryThreadState, ProjectionStore.ProjectionStoreV2Error>;
    /** The run's status once it has ended; none while it has not. */
    readonly runEnded: (
      threadId: ThreadId,
      runId: RunId,
    ) => Effect.Effect<Option.Option<FactoryTerminalRunStatus>, FactoryThreadEffectFailure>;
    /**
     * Asks a run of the thread to stop, as the thread's own Stop does, for a delivery that was
     * cancelled: `runId`, or without one the thread's latest active run. A run that already
     * ended, a thread running nothing and a deleted thread are left as they are.
     */
    readonly interruptRun: (
      delivery: StoredFactoryDelivery,
      run: { readonly threadId: ThreadId; readonly runId?: RunId },
    ) => Effect.Effect<void, FactoryThreadEffectFailure>;
  }
>()("t3/fd/factory/FactoryThreadEffects") {}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Factory reads its delivery's item and writes nothing to Work under this actor. */
const itemReader = (deliveryId: FactoryDeliveryId): WorkActor => ({
  id: `factory:${deliveryId}`,
  grants: [AuthWorkReadScope],
  label: "Factory",
});

const make = Effect.gen(function* () {
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const factorySettings = yield* FactorySettings.FactorySettings;
  const work = yield* WorkService.WorkService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const intakeContext = yield* Effect.context<
    ThreadManagement.ThreadManagementService | ServerConfig.ServerConfig | FileSystem.FileSystem
  >();

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

  /**
   * The model selection for a turn of `round` on a thread: the one the thread runs with, so a
   * model the owner switched it to stays, escalated. None when that leaves it as it is.
   */
  const turnSelection = (delivery: StoredFactoryDelivery, threadId: ThreadId, round: number) =>
    Effect.gen(function* () {
      const { thread } = yield* projections.getThreadRecords(threadId, []);
      const { highRiskEffort } = yield* factorySettings.get(delivery.projectId);
      const selection = yield* escalated(delivery, thread.modelSelection, round, highRiskEffort);
      return selection === thread.modelSelection ? undefined : selection;
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
      const reflog = yield* git
        .execute({
          operation: "FactoryThreadEffects.branchStart",
          cwd: worktreePath,
          args: ["reflog", "show", "--format=%H%x00%gs", `refs/heads/${branch}`, "--"],
          allowNonZeroExit: true,
          timeoutMs: 30_000,
          maxOutputBytes: 1_000_000,
        })
        .pipe(
          Effect.catchTags({
            GitCommandError: (cause) =>
              Effect.fail(new FactoryBranchStartError({ path: worktreePath, branch, cause })),
          }),
        );
      // Newest first: the oldest entry is the branch's creation.
      const [sha = "", subject = ""] = (reflog.stdout.trim().split("\n").at(-1) ?? "").split("\0");
      if (
        reflog.exitCode === 0 &&
        !reflog.stdoutTruncated &&
        OBJECT_ID.test(sha) &&
        subject.startsWith("branch: Created from ")
      ) {
        return sha;
      }
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

  const launchThread: FactoryThreadEffects["Service"]["launchThread"] = (delivery, effect) =>
    Effect.gen(function* () {
      const { role } = effect;
      if (role === "planner") return yield* new FactoryRoleUnsupportedError({ role });
      const { deliveryId, projectId, state } = delivery;
      // A review starts from the verified commit; without one, nothing is launched.
      const basis = role === "reviewer" ? yield* reviewBasis(delivery) : null;
      const project = Option.getOrUndefined(yield* projects.get(projectId));
      if (project === undefined) return yield* new FactoryProjectMissingError({ projectId });
      const resolved = resolveProjectSettings(
        yield* serverSettings.getSettings,
        project.projectId,
        project,
      ).settings;
      const { roles, highRiskEffort } = yield* factorySettings.get(projectId);
      const item = yield* work.getItem(itemReader(deliveryId), { ref: delivery.itemRef });

      const { workspace } = effect;
      // Read before anything is dispatched, so a base ref that names no commit launches nothing.
      // A later thread's baseline is its worktree's HEAD now, before its first turn.
      const before =
        workspace.type === "worktree"
          ? yield* resolveCommit(project.workspaceRoot, workspace.baseRef)
          : yield* resolveCommit(workspace.worktreePath, "HEAD");

      // The order Work's thread starts use, with the role's profile as the explicit choice. A
      // reviewer without a profile of its own uses the author's. A launch starts a first round,
      // so only a high-risk task escalates it.
      const modelSelection = yield* escalated(
        delivery,
        (role === "reviewer" ? (roles.reviewer ?? roles.author) : roles.author) ??
          resolved.defaultModelSelection ??
          getAutoBootstrapThreadModelSelection(),
        1,
        highRiskEffort,
      );
      // Reviewers work in plan mode: they read and judge, and never change the worktree.
      const opening =
        basis === null
          ? {
              title: authorThreadTitle(item),
              text: renderAuthorPrompt({ item, branch: state.branch }),
              interactionMode: "default" as const,
            }
          : {
              title: reviewThreadTitle(item),
              text: renderReviewPrompt({
                item,
                branch: state.branch,
                baseline: basis.baseline,
                receipt: basis.receipt,
              }),
              interactionMode: "plan" as const,
            };
      // Derived from the effect, so a retried launch replays its receipt instead of starting a
      // second thread, and finds its Work link already stored.
      const commandId = CommandId.make(`factory-launch:${deliveryId}:${effect.id}`);
      const messageId = launchMessageId(deliveryId, effect.id);
      const threadId = launchThreadId(deliveryId, effect.id);
      // Work links the thread to the delivery's item before the launch runs, so a run that ends
      // before the launch returns is recorded on the link; a launch that creates no thread leaves
      // no link.
      const launch = launches.launch({
        commandId,
        threadId,
        projectId,
        title: opening.title,
        modelSelection,
        runtimeMode: resolved.defaultRuntimeMode,
        interactionMode: opening.interactionMode,
        workspaceStrategy:
          workspace.type === "worktree"
            ? { type: "worktree", baseRef: workspace.baseRef, branch: workspace.branch }
            : { type: "existing_worktree", worktreePath: workspace.worktreePath },
        initialMessage: { messageId, text: opening.text, attachments: [] },
        createdBy: "system",
        creationSource: "server",
      });
      const launched = yield* work.linkLaunch(
        { ref: delivery.itemRef, threadId, origin: "factory" },
        launch,
      );
      const run = launched.projection.runs.find(
        (candidate) => candidate.userMessageId === messageId,
      );
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
    kind: "fix-commit" | "review-retry" | "fix-verify" | "fix-review" | "review-follow-up",
    text: string,
    modelSelection?: ModelSelection,
  ) =>
    ThreadMessageIntake.sendToThread({
      projectId: delivery.projectId,
      commandId: CommandId.make(`factory-${kind}:${delivery.deliveryId}:${effect.id}`),
      threadId: effect.threadId,
      messageId: MessageId.make(`factory-${kind}-message:${delivery.deliveryId}:${effect.id}`),
      text,
      attachments: [],
      ...(modelSelection === undefined ? {} : { modelSelection }),
      // After whatever the thread is still doing; never steering or interrupting it.
      mode: "queue",
      createdBy: "system",
      creationSource: "server",
    }).pipe(
      Effect.map((sent) => ({ runId: sent.run.id })),
      Effect.provideContext(intakeContext),
    );

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
      if (effect.kind === "fix-verify") {
        const receipt = state.receipts.at(-1);
        if (receipt === undefined) return yield* missing;
        const tail = yield* readLogTail(receipt.logPath);
        return renderFixVerifyPrompt({
          receipt,
          tail,
          branch: state.branch,
          round: effect.round,
        });
      }
      const accepted = state.reviews.at(-1);
      if (accepted === undefined) return yield* missing;
      const evidence = yield* readReviewEvidence(accepted.evidencePath);
      const { blockingSeverities } = yield* factorySettings.get(delivery.projectId);
      return renderFixReviewPrompt({
        headSha: accepted.summary.headSha,
        findings: findingsToFix(evidence.review, blockingSeverities),
        // The findings are listed in full above.
        otherReasons: evidence.blockingReasons
          .filter(({ rule }) => rule !== "changes_required" && rule !== "blocking_finding")
          .map(({ description }) => description),
        branch: state.branch,
        round: effect.round,
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
        round: basis.round,
        branch: state.branch,
        baseline: basis.baseline,
        receipt: basis.receipt,
        previous: { headSha: previous.summary.headSha, findings: evidence.review.findings },
        authorResponse:
          response === null ? null : yield* lastAssistantText(response.threadId, response.runId),
      });
    }).pipe(Effect.provideContext(intakeContext));

  return FactoryThreadEffects.of({
    launchThread,
    sendFixCommitTurn: (delivery, effect) =>
      sendTurn(
        delivery,
        effect,
        "fix-commit",
        renderFixCommitPrompt({
          problems: effect.problems,
          branch: delivery.state.branch,
          baseline: delivery.state.baseline,
          checkpoint: effect.checkpoint ?? null,
        }),
      ),
    sendReviewRetryTurn: (delivery, effect) =>
      sendTurn(
        delivery,
        effect,
        "review-retry",
        renderReviewRetryPrompt({ problems: effect.problems }),
      ),
    sendRepairTurn: (delivery, effect) =>
      Effect.gen(function* () {
        const text = yield* repairText(delivery, effect);
        const selection = yield* turnSelection(delivery, effect.threadId, effect.round);
        return yield* sendTurn(delivery, effect, effect.kind, text, selection);
      }),
    sendReviewFollowUpTurn: (delivery, effect) =>
      Effect.gen(function* () {
        const text = yield* followUpText(delivery);
        const selection = yield* turnSelection(delivery, effect.threadId, effect.round);
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
    runEnded: (threadId, runId) =>
      readThreadRun(threadId, runId).pipe(
        Effect.map(({ status }) =>
          isTerminalRunStatus(status) ? Option.some(status) : Option.none(),
        ),
      ),
    interruptRun: (delivery, { threadId, runId }) =>
      threads
        .interruptThread({
          projectId: delivery.projectId,
          // One interrupt per run or thread of the delivery, however often it is asked.
          commandId: CommandId.make(`factory-cancel:${delivery.deliveryId}:${runId ?? threadId}`),
          threadId,
          ...(runId === undefined ? {} : { runId }),
          reason: "Factory delivery cancelled",
        })
        .pipe(
          Effect.asVoid,
          Effect.catchTags({ ThreadManagementThreadNotFoundError: () => Effect.void }),
        ),
  });
});

export const layer = Layer.effect(FactoryThreadEffects, make);
