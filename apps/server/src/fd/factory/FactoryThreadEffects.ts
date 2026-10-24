import {
  AuthWorkReadScope,
  CommandId,
  MessageId,
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
import { getAutoBootstrapThreadModelSelection } from "../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { type WorkActor, WorkService } from "../work-management/index.ts";
import * as FactorySettings from "./FactorySettings.ts";
import type { StoredFactoryDelivery } from "./persistence/FactoryDeliveryStore.ts";
import type { FactoryEffect, FactoryEvent, FactoryTerminalRunStatus } from "./pipeline/state.ts";
import { authorThreadTitle, renderAuthorPrompt } from "./prompts/author.ts";
import { renderFixCommitPrompt } from "./prompts/fixCommit.ts";

export class FactoryProjectMissingError extends Schema.TaggedError<FactoryProjectMissingError>()(
  "FactoryProjectMissingError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} is not available on this environment.`;
  }
}

/** Only the author role has a prompt in this phase. */
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
 * Carries out the thread effects for `FactoryWorker`: launching a role's thread and sending the
 * fix-commit turn on a thread. Each receives the delivery as stored with the effect. The worker
 * feeds what they report back as `thread.launched` / `turn.started`, and a failure as
 * `effect.failed`. Checks run before anything is dispatched, so a refused launch leaves no thread
 * behind; a read that fails after the launch still fails the effect, and the delivery records
 * none of its result.
 */
export class FactoryThreadEffects extends Context.Service<
  FactoryThreadEffects,
  {
    /**
     * Launches the thread with its first turn and reports it once the launch has recorded the
     * worktree, or has ended the run trying (the path is null then).
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
    /** The run's status once it has ended; none while it has not. */
    readonly runEnded: (
      threadId: ThreadId,
      runId: RunId,
    ) => Effect.Effect<Option.Option<FactoryTerminalRunStatus>, FactoryThreadEffectFailure>;
  }
>()("t3/fd/factory/FactoryThreadEffects") {}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set<FactoryTerminalRunStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);
const isTerminal = (status: string | undefined): status is FactoryTerminalRunStatus =>
  status !== undefined && TERMINAL_STATUSES.has(status);

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
  const intakeContext = yield* Effect.context<
    ThreadManagement.ThreadManagementService | ServerConfig.ServerConfig | FileSystem.FileSystem
  >();

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
      if (effect.role !== "author") {
        return yield* new FactoryRoleUnsupportedError({ role: effect.role });
      }
      const { deliveryId, projectId, state } = delivery;
      const project = Option.getOrUndefined(yield* projects.get(projectId));
      if (project === undefined) return yield* new FactoryProjectMissingError({ projectId });
      const resolved = resolveProjectSettings(
        yield* serverSettings.getSettings,
        project.projectId,
        project,
      ).settings;
      const { roles } = yield* factorySettings.get(projectId);
      const item = yield* work.getItem(itemReader(deliveryId), { ref: delivery.itemRef });

      const { workspace } = effect;
      // Read before anything is dispatched, so a base ref that names no commit launches nothing.
      // A later thread's baseline is its worktree's HEAD now, before its first turn.
      const before =
        workspace.type === "worktree"
          ? yield* resolveCommit(project.workspaceRoot, workspace.baseRef)
          : yield* resolveCommit(workspace.worktreePath, "HEAD");

      // The order Work's thread starts use, with the role's profile as the explicit choice.
      const modelSelection =
        roles[effect.role] ??
        resolved.defaultModelSelection ??
        getAutoBootstrapThreadModelSelection();
      // Derived from the effect, so a retried launch replays its receipt instead of starting a
      // second thread.
      const commandId = CommandId.make(`factory-launch:${deliveryId}:${effect.id}`);
      const messageId = MessageId.make(`factory-launch-message:${deliveryId}:${effect.id}`);
      const launched = yield* launches.launch({
        commandId,
        projectId,
        title: authorThreadTitle(item),
        modelSelection,
        runtimeMode: resolved.defaultRuntimeMode,
        interactionMode: "default",
        workspaceStrategy:
          workspace.type === "worktree"
            ? { type: "worktree", baseRef: workspace.baseRef, branch: workspace.branch }
            : { type: "existing_worktree", worktreePath: workspace.worktreePath },
        initialMessage: {
          messageId,
          text: renderAuthorPrompt({ item, branch: state.branch }),
          attachments: [],
        },
        createdBy: "system",
        creationSource: "server",
      });
      const { threadId } = launched;
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

  const sendFixCommitTurn: FactoryThreadEffects["Service"]["sendFixCommitTurn"] = (
    delivery,
    effect,
  ) => {
    const { deliveryId, state } = delivery;
    return ThreadMessageIntake.sendToThread({
      projectId: delivery.projectId,
      commandId: CommandId.make(`factory-fix-commit:${deliveryId}:${effect.id}`),
      threadId: effect.threadId,
      messageId: MessageId.make(`factory-fix-commit-message:${deliveryId}:${effect.id}`),
      text: renderFixCommitPrompt({
        problems: effect.problems,
        branch: state.branch,
        baseline: state.baseline,
      }),
      attachments: [],
      // After whatever the thread is still doing; never steering or interrupting it.
      mode: "queue",
      createdBy: "system",
      creationSource: "server",
    }).pipe(
      Effect.map((sent) => ({ runId: sent.run.id })),
      Effect.provideContext(intakeContext),
    );
  };

  return FactoryThreadEffects.of({
    launchThread,
    sendFixCommitTurn,
    runEnded: (threadId, runId) =>
      readThreadRun(threadId, runId).pipe(
        Effect.map(({ status }) => (isTerminal(status) ? Option.some(status) : Option.none())),
      ),
  });
});

export const layer = Layer.effect(FactoryThreadEffects, make);
