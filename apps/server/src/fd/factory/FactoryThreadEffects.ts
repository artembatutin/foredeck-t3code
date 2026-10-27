import {
  AuthWorkReadScope,
  CommandId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  type RunId,
  RuntimeMode,
  ThreadId,
  type VcsListRefsResult,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryRole } from "@t3tools/contracts/fd/factory";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as ServerConfig from "../../config.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../../orchestration-v2/ThreadMessageIntake.ts";
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { getAutoBootstrapThreadModelSelection } from "../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { type WorkActor, WorkService } from "../work-management/index.ts";
import { readReviewEvidence, reviewBasis } from "./FactoryReview.ts";
import { FactoryBranchStartError, readBranchCreation } from "./git/branchStart.ts";
import * as FactorySettings from "./FactorySettings.ts";
import type { StoredFactoryDelivery } from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryTurnSelectionStore from "./persistence/FactoryTurnSelectionStore.ts";
import { escalateEffort, mechanicalEffort } from "./pipeline/effort.ts";
import {
  adoptedRuns,
  type FactoryEffect,
  type FactoryEvent,
  type FactoryTerminalRunStatus,
  isTerminalRunStatus,
} from "./pipeline/state.ts";
import { authorThreadTitle, renderAuthorPrompt } from "./prompts/author.ts";
import { renderFixCommitPrompt } from "./prompts/fixCommit.ts";
import { renderFixReviewPrompt } from "./prompts/fixReview.ts";
import { renderFixVerifyPrompt } from "./prompts/fixVerify.ts";
import { integrateThreadTitle, renderIntegratePrompt } from "./prompts/integrate.ts";
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

/** Every message Factory sends: a launch's first message, or a turn's (see `sendTurn`). */
const FACTORY_MESSAGE = /^factory-[a-z-]+-message:/;

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
     * then). With `beforeOpening` (an author's setup), it runs in the worktree before that turn:
     * an existing worktree's before the launch, a new one's once core has prepared it for a thread
     * launched without the turn, which is then sent under the launch's own ids. A launch replayed
     * after its turn was sent runs nothing again and reports that turn's run, whatever
     * `beforeOpening` it is given; one replayed before takes the new worktree as its preparation
     * left it (see `recoverWorktree`) and launches into it. A failure of `beforeOpening` fails
     * the launch.
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
  const git = yield* GitVcsDriver.GitVcsDriver;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  // Where core reports a launch's workspace preparation when it has no run to report it on. The
  // server always provides it; without it a launch waits on the recorded worktree alone.
  const setupTracker = yield* Effect.serviceOption(WorktreeSetupTracker.WorktreeSetupTracker);
  const fileSystem = yield* FileSystem.FileSystem;
  const exists = (path: string) => fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
  const realPath = (path: string) =>
    fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));
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

  // Queued runs persist their selection on the thread. Medium belongs only to the mechanical
  // turn: use its saved baseline while that selection is still on the thread. An owner change
  // takes precedence. The store is keyed by thread too, for a parent's last-child follow-through.
  const beforeMechanical = (threadId: ThreadId, current: ModelSelection) =>
    Effect.gen(function* () {
      const saved = yield* turnSelections.latest(threadId);
      if (Option.isNone(saved)) return current;
      const restored = restoreMechanicalSelection(current, saved.value);
      if (restored === current) return current;
      const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
      const messageId = `factory-fix-commit-message:${saved.value.deliveryId}:${saved.value.effectId}`;
      const fixed = runs.findIndex((run) => run.userMessageId === messageId);
      // A recorded selection alone proves no change: dispatch may have failed or still be queued.
      if (fixed < 0 || runs[fixed]?.status === "queued") return current;
      // Once a later Factory turn has started, this temporary selection is spent. If the owner
      // subsequently chooses medium themselves, an old fix-commit must not undo that choice.
      if (
        runs
          .slice(fixed + 1)
          .some((run) => run.status !== "queued" && FACTORY_MESSAGE.test(run.userMessageId ?? ""))
      )
        return current;
      // Equality alone loses an owner's change away from and back to medium. Selection events
      // after this send retain that intent; unrelated option edits still restore only effort.
      const sent = yield* events
        .readByCommandId({
          commandId: CommandId.make(
            `factory-fix-commit:${saved.value.deliveryId}:${saved.value.effectId}`,
          ),
        })
        .pipe(Stream.runLast);
      const throughSequence = yield* events.latestSequence({ threadId });
      for (const eventType of [
        "thread.model-selection-updated",
        "thread.provider-switched",
      ] as const) {
        const changed = yield* events
          .read({
            threadId,
            afterSequence: Option.isSome(sent) ? sent.value.sequence : 0,
            throughSequence,
            eventType,
          })
          .pipe(
            Stream.filter(
              ({ event }) =>
                (event.type === "thread.model-selection-updated" ||
                  event.type === "thread.provider-switched") &&
                restoreMechanicalSelection(event.payload.modelSelection, saved.value) ===
                  event.payload.modelSelection,
            ),
            Stream.runHead,
          );
        if (Option.isSome(changed)) return current;
      }
      return restored;
    });

  const turnSelection = (delivery: StoredFactoryDelivery, threadId: ThreadId, round: number) =>
    Effect.gen(function* () {
      const { thread } = yield* projections.getThreadRecords(threadId, []);
      const before = yield* beforeMechanical(threadId, thread.modelSelection);
      const { highRiskEffort } = yield* factorySettings.get(delivery.projectId);
      const selection = yield* escalated(delivery, before, round, highRiskEffort);
      return selection === thread.modelSelection ? undefined : selection;
    });

  const fixCommitSelection = (
    delivery: StoredFactoryDelivery,
    effect: { readonly id: number; readonly threadId: ThreadId },
  ) =>
    Effect.gen(function* () {
      const key = { deliveryId: delivery.deliveryId, effectId: effect.id };
      const saved = yield* turnSelections.get(key);
      if (Option.isSome(saved)) return saved.value.mechanical ?? undefined;
      const { thread } = yield* projections.getThreadRecords(effect.threadId, []);
      const before = yield* beforeMechanical(effect.threadId, thread.modelSelection);
      const available = yield* providers.getProviders;
      const mechanical = mechanicalEffort({
        selection: before,
        descriptors: available
          .find((provider) => provider.instanceId === before.instanceId)
          ?.models.find((model) => model.slug === before.model)?.capabilities?.optionDescriptors,
      });
      yield* turnSelections.record({
        ...key,
        threadId: effect.threadId,
        before,
        mechanical: mechanical === before ? null : mechanical,
      });
      // Read back the winner if the same effect was dispatched concurrently.
      return (yield* turnSelections.get(key)).pipe(Option.getOrThrow).mechanical ?? undefined;
    });

  /**
   * The runtime mode a launch of `role` on `instanceId` asks for. Without a ceiling, the project's
   * default, as for any thread. With one, the narrower of the two, stepped down to a mode the
   * provider offers, so the run is never broader than either; a provider offering none within
   * fails the launch before anything is dispatched.
   */
  const launchRuntimeMode = (
    delivery: StoredFactoryDelivery,
    role: FactoryRole,
    instanceId: ProviderInstanceId,
    projectDefault: RuntimeMode,
  ) =>
    Effect.gen(function* () {
      const ceiling = delivery.state.runtimeModeCeiling;
      if (ceiling === undefined) return projectDefault;
      const bound =
        runtimeModeRank[ceiling] < runtimeModeRank[projectDefault] ? ceiling : projectDefault;
      // Read where the run's runtime policy reads it when the provider starts the turn.
      const instance = yield* providerInstances.getInstance(instanceId);
      const offered =
        instance === undefined
          ? undefined
          : (yield* instance.snapshot.getSnapshot).supportedRuntimeModes;
      const mode = offeredWithin(bound, offered);
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

  const launchThread: FactoryThreadEffects["Service"]["launchThread"] = (
    delivery,
    effect,
    beforeOpening,
  ) =>
    Effect.gen(function* () {
      const { role } = effect;
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
      // planner or reviewer without a profile of its own uses the author's. A launch starts a
      // first round, so only a high-risk task escalates it.
      const modelSelection = yield* escalated(
        delivery,
        (role === "author" ? roles.author : (roles[role] ?? roles.author)) ??
          resolved.defaultModelSelection ??
          getAutoBootstrapThreadModelSelection(),
        1,
        highRiskEffort,
      );
      const runtimeMode = yield* launchRuntimeMode(
        delivery,
        role,
        modelSelection.instanceId,
        resolved.defaultRuntimeMode,
      );
      // A task's reviewer judges its commits; a parent's integrate reviewer its whole branch, by
      // every approved task's criteria.
      const reviewOpening = ({ baseline, receipt, tasks }: NonNullable<typeof basis>) =>
        tasks === null
          ? {
              title: reviewThreadTitle(item),
              text: renderReviewPrompt({ item, branch: state.branch, baseline, receipt }),
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
              }),
            };
      // Planners and reviewers work in plan mode: they read and judge, and never change the
      // worktree.
      const opening =
        basis !== null
          ? { ...reviewOpening(basis), interactionMode: "plan" as const }
          : role === "planner"
            ? {
                title: planThreadTitle(item),
                text: renderPlanPrompt({ item, branch: state.branch }),
                interactionMode: "plan" as const,
              }
            : {
                title: authorThreadTitle(item),
                text: renderAuthorPrompt({ item, branch: state.branch }),
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
      // Core starts the opening turn's run once it has prepared the workspace, and fails that run
      // when it cannot. An existing worktree is there already, so it gets `beforeOpening` first,
      // unless a replay finds the turn sent, and is launched as any other. A new one exists only
      // once the launch prepared it, so that launch leaves the turn for Factory to send after.
      if (
        beforeOpening !== undefined &&
        workspace.type === "existing_worktree" &&
        !(yield* openingSent(threadId, messageId))
      ) {
        yield* beforeOpening(workspace.worktreePath);
      }
      // An existing thread without its opening still needs recovery if setup was cleared since
      // the runless launch. A fresh unconfigured launch keeps core's with-message path.
      const runless =
        workspace.type === "worktree" &&
        (beforeOpening !== undefined || (yield* openingSent(threadId, messageId)) === false)
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
    kind:
      | "fix-commit"
      | "plan-retry"
      | "replan"
      | "review-retry"
      | "fix-verify"
      | "fix-review"
      | "review-follow-up",
    text: string,
    modelSelection?: ModelSelection,
  ) =>
    Effect.gen(function* () {
      let selection = modelSelection;
      if (selection === undefined && kind !== "fix-commit") {
        const saved = yield* turnSelections.latest(effect.threadId);
        if (Option.isSome(saved) && saved.value.mechanical !== null) {
          const { thread } = yield* projections.getThreadRecords(effect.threadId, []);
          const restored = yield* beforeMechanical(effect.threadId, thread.modelSelection);
          if (restored !== thread.modelSelection) selection = restored;
        }
      }
      return yield* ThreadMessageIntake.sendToThread({
        projectId: delivery.projectId,
        commandId: CommandId.make(`factory-${kind}:${delivery.deliveryId}:${effect.id}`),
        threadId: effect.threadId,
        messageId: MessageId.make(`factory-${kind}-message:${delivery.deliveryId}:${effect.id}`),
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

  return FactoryThreadEffects.of({
    launchThread,
    sendFixCommitTurn: (delivery, effect) =>
      Effect.gen(function* () {
        const selection = yield* fixCommitSelection(delivery, effect);
        return yield* sendTurn(
          delivery,
          effect,
          "fix-commit",
          renderFixCommitPrompt({
            problems: effect.problems,
            branch: delivery.state.branch,
            baseline: delivery.state.baseline,
            checkpoint: effect.checkpoint ?? null,
          }),
          selection,
        );
      }),
    sendPlanRetryTurn: (delivery, effect) =>
      sendTurn(
        delivery,
        effect,
        "plan-retry",
        renderPlanRetryPrompt({ problems: effect.problems, checkpoint: effect.checkpoint ?? null }),
      ),
    sendReplanTurn: (delivery, effect) =>
      sendTurn(delivery, effect, "replan", renderReplanPrompt({ note: effect.note })),
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
