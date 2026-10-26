import {
  AuthWorkReadScope,
  AuthWorkWriteScope,
  CommandId,
  type GitCommandError,
  type GitManagerServiceError,
  type GitRunStackedActionResult,
  type OrchestrationV2StoredEvent,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import { createdPullRequestKey, linkCreatedPullRequest } from "../../git/linkCreatedPullRequest.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { type WorkActor, type WorkDomainError, WorkService } from "../work-management/index.ts";
import { taskOfChild } from "./FactoryChildren.ts";
import {
  type FactoryPullRequestKey,
  type FactoryWakeEvent,
  runCreated,
  wakeOf,
  watchEndIn,
  watchStartedBy,
} from "./followThrough.ts";
import { readBranchApproval } from "./FactoryRecord.ts";
import { FactoryBranchReadError, type FactoryWorktreeMissingError } from "./git/branchFacts.ts";
import { readWorktreeState } from "./git/worktreeState.ts";
import type { FactoryStoreError } from "./persistence/errors.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import { acceptedReview, followedThread, receiptFailed } from "./pipeline/state.ts";
import type {
  FactoryDeliveryState,
  FactoryEffect,
  FactoryOpenedPullRequest,
  FactoryPullRequestOutcome,
  FactoryWatchState,
} from "./pipeline/state.ts";
import {
  type FactoryPullRequestEvidence,
  pullRequestTextProblems,
  renderPullRequestBody,
  renderPullRequestTitle,
} from "./prompts/prBody.ts";
import * as FactoryEvidence from "./verify/FactoryEvidence.ts";

/**
 * The delivery records nothing to open a pull request for: no worktree or author thread, no
 * passing last receipt and review, or no one task approved for the commit they cover. For a
 * parent: no approval of its branch for that commit, or a child that is not approved for its
 * own verified, reviewed commit, or a last child without an author thread.
 */
export class FactoryPullRequestBasisMissingError extends Schema.TaggedError<FactoryPullRequestBasisMissingError>()(
  "FactoryPullRequestBasisMissingError",
  { deliveryId: FactoryDeliveryId },
) {
  override get message(): string {
    return `Factory delivery ${this.deliveryId} records no approved commit to open a pull request for.`;
  }
}

/** The worktree no longer holds the approved commit on a clean tree; nothing was pushed. */
export class FactoryPullRequestUnapprovedError extends Schema.TaggedError<FactoryPullRequestUnapprovedError>()(
  "FactoryPullRequestUnapprovedError",
  {
    deliveryId: FactoryDeliveryId,
    approvedSha: Schema.String,
    headSha: Schema.String,
    clean: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Factory delivery ${this.deliveryId} was approved for ${this.approvedSha}, but its worktree holds ${this.headSha}${this.clean ? "" : " with uncommitted changes"}.`;
  }
}

/**
 * The rendered title or body names an AI agent, model or provider, or carries attribution: the
 * item's text or the verify command brought it in. Nothing was pushed or published.
 */
export class FactoryPullRequestTextRefusedError extends Schema.TaggedError<FactoryPullRequestTextRefusedError>()(
  "FactoryPullRequestTextRefusedError",
  {
    deliveryId: FactoryDeliveryId,
    problems: Schema.Array(
      Schema.Struct({
        field: Schema.Literals(["title", "body"]),
        rule: Schema.Literals(["ai_name", "ai_attribution"]),
      }),
    ),
  },
) {
  override get message(): string {
    const problems = this.problems.map(({ field, rule }) =>
      rule === "ai_name"
        ? `its ${field} names an AI agent, model or provider`
        : `its ${field} carries generated or assisted attribution`,
    );
    return `Factory will not publish the pull request for delivery ${this.deliveryId}: ${problems.join("; ")}.`;
  }
}

/**
 * The branch the stacked action published does not hold the approved commit (or Factory could
 * not read it), so the pull request it opened carries code no approval covers.
 */
export class FactoryPullRequestPublishedUnapprovedError extends Schema.TaggedError<FactoryPullRequestPublishedUnapprovedError>()(
  "FactoryPullRequestPublishedUnapprovedError",
  {
    deliveryId: FactoryDeliveryId,
    approvedSha: Schema.String,
    publishedSha: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `The pull request for Factory delivery ${this.deliveryId} was published from ${this.publishedSha ?? "an unreadable commit"}, not the approved ${this.approvedSha}.`;
  }
}

/** The stacked action ended without reporting a pull request Factory can record. */
export class FactoryPullRequestNotOpenedError extends Schema.TaggedError<FactoryPullRequestNotOpenedError>()(
  "FactoryPullRequestNotOpenedError",
  {
    deliveryId: FactoryDeliveryId,
    status: Schema.Literals(["created", "opened_existing", "skipped_not_requested"]),
  },
) {
  override get message(): string {
    return `The pull request step for Factory delivery ${this.deliveryId} ended ${this.status} without a number and URL.`;
  }
}

/**
 * Factory cannot tell which repository the delivery's pull request belongs to, from its URL or the
 * project of the thread it is linked to, so it cannot watch it there.
 */
export class FactoryPullRequestUnwatchableError extends Schema.TaggedError<FactoryPullRequestUnwatchableError>()(
  "FactoryPullRequestUnwatchableError",
  { deliveryId: FactoryDeliveryId },
) {
  override get message(): string {
    return `Factory cannot tell which repository the pull request of delivery ${this.deliveryId} belongs to, so it cannot watch it.`;
  }
}

/** A parent's child delivery is not stored, so its Work item is unknown; no item was set done. */
export class FactoryCloseOutChildMissingError extends Schema.TaggedError<FactoryCloseOutChildMissingError>()(
  "FactoryCloseOutChildMissingError",
  { deliveryId: FactoryDeliveryId, childId: FactoryDeliveryId },
) {
  override get message(): string {
    return `Factory delivery ${this.deliveryId} cannot find its child delivery ${this.childId} to finish its item.`;
  }
}

export type FactoryCloseOutItemsError =
  | FactoryCloseOutChildMissingError
  | FactoryStoreError
  | WorkDomainError;

export type FactoryCloseOutWorktreeError =
  | FactoryBranchReadError
  | ProjectStore.ProjectStoreV2Error
  | ProjectionStore.ProjectionStoreV2Error
  | GitCommandError;

export type FactoryPullRequestWatchError =
  | FactoryPullRequestUnwatchableError
  | Orchestrator.OrchestratorV2Error
  | CommandReceiptStore.CommandReceiptStoreV2Error
  | EventStore.EventStoreV2Error
  | PlatformError
  | ProjectService.ProjectOperationError;

/**
 * What `recover` found of a PR stage whose result a restart lost: nothing proves it published
 * (core accepted no watch command of it), it published a pull request the records cannot name,
 * or what it published: the pull request, the thread it is linked to, the watch there as the
 * stage would have reported it, the wakes core committed since the delivery's first watch command,
 * and how the pull request left `open` if it did.
 */
export type FactoryPullRequestRecovery =
  | { readonly type: "none" }
  | { readonly type: "unknown" }
  | {
      readonly type: "recovered";
      readonly pullRequest: FactoryOpenedPullRequest;
      readonly threadId: ThreadId;
      readonly watch: FactoryWatchState;
      readonly wakes: ReadonlyArray<FactoryWakeEvent>;
      readonly outcome?: FactoryPullRequestOutcome;
    };

export type FactoryPullRequestError =
  | FactoryPullRequestBasisMissingError
  | FactoryPullRequestUnapprovedError
  | FactoryPullRequestNotOpenedError
  | FactoryPullRequestTextRefusedError
  | FactoryPullRequestPublishedUnapprovedError
  | FactoryWorktreeMissingError
  | FactoryBranchReadError
  | FactoryEvidence.FactoryEvidenceError
  | FactoryStoreError
  | WorkDomainError
  | GitManagerServiceError;

/**
 * What the PR stage published: the delivery's pull request and the thread it is linked to, where
 * core's watch wakes with its feedback. A parent has no author thread, so its pull request is
 * linked to its last child's author thread.
 */
interface FactoryPublishedPullRequest {
  readonly pullRequest: FactoryOpenedPullRequest;
  readonly threadId: ThreadId;
}

/**
 * The PR stages' work. Opens the delivery's pull request from its worktree through the stacked
 * Git action (`create_pr`) with the item's title and a body listing the accepted task and its
 * evidence, then links it to the author thread. A parent's is its one pull request: its body lists
 * its whole branch's verify and integrate review, then each child item in plan order with its
 * own, and it is linked to the last child's author thread, since a parent has none. A child opens
 * none. Text that names an AI agent, model or provider or carries attribution is never published.
 * The action runs only while the worktree holds the approved commit on a clean tree, and pushes
 * that exact commit, so a commit made meanwhile never reaches the remote. An open pull request for
 * the branch is reported as it is, unchanged. A delivery that recorded its pull request already,
 * in a follow-through round, only pushes its newly approved commit to that pull request's branch.
 * The pull request is then watched on the thread it is linked to, so its feedback wakes that
 * thread. Once someone merged it, closes the delivery out.
 */
export class FactoryPullRequest extends Context.Service<
  FactoryPullRequest,
  {
    readonly open: (
      delivery: FactoryDeliveryStore.StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "open_pr" }>,
    ) => Effect.Effect<FactoryPublishedPullRequest, FactoryPullRequestError>;
    /**
     * Has core watch the pull request on `threadId`, the thread `open` linked it to (a single
     * item's author thread, a parent's last child's author thread), and reports what that left
     * (see `FactoryWatchState`) with the wakes core committed there since the delivery's
     * first watch command, in order, which the worker steps after the result. It first reads the
     * pull request's watch, then those wakes, and starts a watch only when none is on and no end
     * core committed is among wakes the delivery has not taken: core can end only a watch that
     * is on, so none ends between that read and the command, and a watch core ended is never
     * started again here. The command links the pull request first when it is not linked; its id
     * derives from the delivery and the effect, so an effect carried out again starts no second
     * watch. Which watch is Factory's is read from its watch commands' own records and the watch
     * the delivery already holds (see `isFactorys`), so a result that was never stored loses
     * nothing. None for a child, which opens no pull request.
     */
    readonly watch: (
      delivery: FactoryDeliveryStore.StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "open_pr" }>,
      pullRequest: FactoryOpenedPullRequest,
      threadId: ThreadId,
    ) => Effect.Effect<
      Option.Option<{
        readonly watch: FactoryWatchState;
        readonly wakes: ReadonlyArray<FactoryWakeEvent>;
      }>,
      FactoryPullRequestWatchError
    >;
    /**
     * What a PR stage whose result a restart lost after its watch command did, read from that
     * command's records (see `FactoryPullRequestRecovery`). Core accepting the command proves the
     * stage published and linked its pull request: the command runs only after that. Which pull
     * request it was is read apart from whose watch is on it, from the event the command
     * committed: the link a watch the command started is on, else the one link watched once the
     * command had run, narrowed when the thread watches several to the link the stage's own link
     * command added. A watch the command kept is someone else's, never Factory's. Reads only.
     */
    readonly recover: (
      delivery: FactoryDeliveryStore.StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "open_pr" }>,
    ) => Effect.Effect<FactoryPullRequestRecovery, FactoryPullRequestWatchError>;
    /**
     * Ends Factory's watch on the delivery's pull request (see `isFactorys`), as a cancel asks,
     * only while it is that very watch: core checks its start under the thread's lock, so a watch
     * the owner started meanwhile stays. Reports that watch (the one on, else the latest Factory
     * started) and its pull request, where it ended (by this or before), where the delivery's first
     * watch command was, and the wakes core committed since, which the worker steps so the
     * cancelled delivery stops what its watch set off. Read on the thread the delivery records its
     * pull request linked to (see `followedThread`), or for a parent whose PR stage result was lost
     * before it recorded one, on the thread its watch commands name, which it reports. None when
     * Factory started or holds no watch there. Fails only when the watch is still on and could not
     * be ended.
     */
    readonly release: (delivery: FactoryDeliveryStore.StoredFactoryDelivery) => Effect.Effect<
      Option.Option<{
        readonly threadId: ThreadId;
        readonly startedAt: string;
        readonly pullRequest: FactoryPullRequestKey;
        readonly at: number | null;
        readonly firstAt: number;
        readonly wakes: ReadonlyArray<FactoryWakeEvent>;
      }>,
      FactoryPullRequestWatchError
    >;
    /**
     * Follow-through once the delivery's pull request merged, first part: sets each child item
     * done in plan order for a parent, then the delivery's own item, through Work under a Factory
     * actor. An item the source reads as done already, after Work's reads are refreshed, is left
     * as it is, so a retry after some of them were set, or an item someone else finished, writes
     * nothing again: a source such as Jira refuses to move a done issue to done. An item the
     * source cannot read in full is never taken as done, and a read or write that fails fails
     * the close-out.
     */
    readonly closeOutItems: (
      delivery: FactoryDeliveryStore.StoredFactoryDelivery,
    ) => Effect.Effect<void, FactoryCloseOutItemsError>;
    /**
     * Follow-through once the delivery's pull request merged, second part: ends the watch the PR
     * stage started on it, as core's watch would end on a merged pull request (a watch counts as
     * a thread's background work, which keeps a worktree), then removes the delivery's worktree
     * through the Git workflow when it is clean and no thread works in it. The branch always
     * stays, and so does a worktree with changes, one a thread is working in, one already gone and
     * the project's primary checkout. The worker calls this only under the delivery's lock, while
     * the delivery still awaits its close-out, so a cancel never loses its checkout.
     */
    readonly closeOutWorktree: (
      delivery: FactoryDeliveryStore.StoredFactoryDelivery,
    ) => Effect.Effect<void, FactoryCloseOutWorktreeError>;
  }
>()("t3/fd/factory/FactoryPullRequest") {}

/** Factory reads its delivery's item and writes nothing to Work under this actor. */
const itemReader = (deliveryId: FactoryDeliveryId): WorkActor => ({
  id: `factory:${deliveryId}`,
  grants: [AuthWorkReadScope],
  label: "Factory",
});

/** Factory sets its delivery's items done under this actor; it is not an agent's. */
const itemWriter = (deliveryId: FactoryDeliveryId): WorkActor => ({
  id: `factory:${deliveryId}`,
  grants: [AuthWorkReadScope, AuthWorkWriteScope],
  label: "Factory",
});

/** The pull request a stacked action's result reports, when it has one Factory can record. */
const openedPullRequest = ({ pr }: GitRunStackedActionResult) =>
  (pr.status === "created" || pr.status === "opened_existing") &&
  pr.number !== undefined &&
  pr.url !== undefined &&
  pr.url.length > 0 &&
  pr.headBranch !== undefined
    ? ({ number: pr.number, url: pr.url, headBranch: pr.headBranch } as const)
    : undefined;

/**
 * A delivery's last receipt and the review accepted in its current round, when that receipt passed
 * and that review does not block; record checked that it judged the receipt's commit.
 */
const passingEvidence = (state: FactoryDeliveryState) => {
  const receipt = state.receipts.at(-1);
  const review = acceptedReview(state);
  return receipt === undefined ||
    receiptFailed(receipt) ||
    review === undefined ||
    review.summary.blocking
    ? undefined
    : ({
        receipt,
        review: { round: review.round, summary: review.summary },
      } satisfies FactoryPullRequestEvidence);
};

/**
 * Whether the watch that started at `startedAt` on the pull request is Factory's: one its watch
 * commands started (see `watchCommands`), or the one the delivery holds, judged so when those
 * commands' events were read, which compaction may since have dropped.
 */
const isFactorys = (
  state: FactoryDeliveryState,
  started: ReadonlyArray<{ readonly startedAt: string; readonly link: ThreadPullRequestLink }>,
  pullRequest: FactoryPullRequestKey,
  startedAt: string | null,
) =>
  startedAt !== null &&
  (startedAt === state.followThrough?.watchStartedAt ||
    started.some(
      (watch) =>
        watch.startedAt === startedAt &&
        watch.link.number === pullRequest.number &&
        watch.link.url === pullRequest.url,
    ));

/** The watch command a PR stage's effect sends; derived, so its record can be found again. */
const watchCommandId = (deliveryId: FactoryDeliveryId, effectId: number) =>
  CommandId.make(`factory-pr-watch:${deliveryId}:${effectId}`);

/** The command a PR stage's effect links its pull request with; derived, like `watchCommandId`. */
const linkCommandId = (deliveryId: FactoryDeliveryId, effectId: number) =>
  CommandId.make(`factory-pr-link:${deliveryId}:${effectId}`);

const make = Effect.gen(function* () {
  const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const events = yield* EventStore.EventStoreV2;
  const crypto = yield* Crypto.Crypto;
  const projectService = yield* ProjectService.ProjectService;
  const work = yield* WorkService.WorkService;
  const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
  const tasks = yield* FactoryTaskStore.FactoryTaskStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<
    | FileSystem.FileSystem
    | GitVcsDriver.GitVcsDriver
    | Orchestrator.OrchestratorV2
    | ProjectService.ProjectService
    | FactoryEvidence.FactoryEvidence
  >();

  /** A single item's approved task and what its approval rests on. */
  const basisOf = Effect.fn("FactoryPullRequest.basis")(function* (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
  ) {
    const { deliveryId, state } = delivery;
    const evidence = passingEvidence(state);
    const stored = yield* tasks.listByDelivery(deliveryId);
    const [task] = stored;
    if (
      state.kind !== "single" ||
      state.worktreePath === null ||
      state.threads.author === undefined ||
      evidence === undefined ||
      task === undefined ||
      stored.length > 1 ||
      task.lastReviewedSha !== evidence.receipt.headSha
    ) {
      return yield* new FactoryPullRequestBasisMissingError({ deliveryId });
    }
    return {
      type: "single" as const,
      worktreePath: state.worktreePath,
      author: state.threads.author,
      approvedSha: task.lastReviewedSha,
      task: { title: task.plan?.title, ...evidence },
    };
  });

  /**
   * A parent's approved branch and what its approval rests on: its `approval.json` for the commit
   * its last receipt verified and its integrate review passed, and each child, in plan order,
   * approved for the commit its own last receipt verified and its review passed.
   */
  const parentBasisOf = Effect.fn("FactoryPullRequest.parentBasis")(function* (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
  ) {
    const { deliveryId, state } = delivery;
    const missing = new FactoryPullRequestBasisMissingError({ deliveryId });
    const branch = passingEvidence(state);
    if (state.worktreePath === null || branch === undefined || state.children.length === 0) {
      return yield* missing;
    }
    const approval = Option.getOrUndefined(
      yield* readBranchApproval(deliveryId).pipe(Effect.provideContext(context)),
    );
    if (approval?.headSha !== branch.receipt.headSha || approval.tree !== branch.receipt.tree) {
      return yield* missing;
    }
    const stored = yield* tasks.listByDelivery(deliveryId);
    const children = yield* Effect.forEach(state.children, (childId) =>
      Effect.gen(function* () {
        const child = Option.getOrUndefined(yield* deliveries.get(childId));
        const task = taskOfChild(deliveryId, stored, childId);
        const evidence = child === undefined ? undefined : passingEvidence(child.state);
        if (
          child?.parentId !== deliveryId ||
          child.state.status !== "approved" ||
          evidence === undefined ||
          task === undefined ||
          task.childItemId === null ||
          task.lastReviewedSha !== evidence.receipt.headSha
        ) {
          return yield* missing;
        }
        const ref: WorkItemRef = { sourceId: delivery.itemRef.sourceId, itemId: task.childItemId };
        return { ref, author: child.state.threads.author, ...evidence };
      }),
    );
    const author = children.at(-1)?.author;
    if (author === undefined) return yield* missing;
    return {
      type: "parent" as const,
      worktreePath: state.worktreePath,
      author,
      approvedSha: approval.headSha,
      branch,
      children,
    };
  });

  /**
   * The commit the branch's upstream holds: every stacked action that opens a pull request leaves
   * the branch tracking the ref it published, and pushing updates that tracking ref. Null when the
   * branch tracks nothing.
   */
  const publishedCommit = (worktreePath: string) =>
    git
      .execute({
        operation: "FactoryPullRequest.published",
        cwd: worktreePath,
        args: ["rev-parse", "--verify", "--quiet", "@{upstream}^{commit}"],
        allowNonZeroExit: true,
        timeoutMs: 30_000,
      })
      .pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
        Effect.catchTags({
          GitCommandError: (cause) =>
            Effect.fail(
              new FactoryBranchReadError({ operation: "upstream", path: worktreePath, cause }),
            ),
        }),
      );

  /**
   * Fails unless the worktree holds the approved commit on a clean tree. Record checked it, but a
   * commit or edit could land since, so this is read last, right before an action that publishes.
   */
  const requireApproved = (
    deliveryId: FactoryDeliveryId,
    basis: { readonly worktreePath: string; readonly approvedSha: string },
  ) =>
    Effect.gen(function* () {
      const current = yield* readWorktreeState(basis.worktreePath).pipe(
        Effect.provideContext(context),
      );
      if (current.headSha !== basis.approvedSha || !current.clean) {
        return yield* new FactoryPullRequestUnapprovedError({
          deliveryId,
          approvedSha: basis.approvedSha,
          headSha: current.headSha,
          clean: current.clean,
        });
      }
    });

  /** Fails unless the branch's upstream holds the approved commit after the action. */
  const requirePublished = (
    deliveryId: FactoryDeliveryId,
    basis: { readonly worktreePath: string; readonly approvedSha: string },
  ) =>
    Effect.gen(function* () {
      const publishedSha = yield* publishedCommit(basis.worktreePath);
      if (publishedSha !== basis.approvedSha) {
        return yield* new FactoryPullRequestPublishedUnapprovedError({
          deliveryId,
          approvedSha: basis.approvedSha,
          publishedSha,
        });
      }
    });

  const open: FactoryPullRequest["Service"]["open"] = Effect.fn("FactoryPullRequest.open")(
    function* (delivery, effect) {
      const { deliveryId, projectId } = delivery;
      const reader = itemReader(deliveryId);
      const basis =
        delivery.state.kind === "parent"
          ? yield* parentBasisOf(delivery)
          : yield* basisOf(delivery);
      // Derived from the effect, so progress and the thread link name this attempt.
      const actionId = `factory-pr:${deliveryId}:${effect.id}`;

      // A follow-through round publishes its approved commit to the pull request it opened: a
      // push alone, by the commit's id. Asking for a pull request again would open a second one
      // when the first merged or closed before core's sync stored it.
      const recorded = delivery.state.pullRequest;
      if (recorded !== null && recorded.outcome === undefined) {
        yield* requireApproved(deliveryId, basis);
        yield* gitWorkflow.runStackedAction(
          {
            actionId,
            cwd: basis.worktreePath,
            action: "push",
            threadId: basis.author,
            projectId,
            expectedHeadSha: basis.approvedSha,
          },
          { actionId },
        );
        yield* requirePublished(deliveryId, basis);
        return {
          pullRequest: {
            number: recorded.number,
            url: recorded.url,
            headBranch: recorded.headBranch,
          },
          threadId: basis.author,
        };
      }

      const item = yield* work.getItem(reader, { ref: delivery.itemRef });
      const prTitle = renderPullRequestTitle(item);
      const prBody =
        basis.type === "single"
          ? renderPullRequestBody({
              item,
              tasks: [{ ...basis.task, title: basis.task.title ?? item.title }],
            })
          : renderPullRequestBody({
              item,
              branch: basis.branch,
              // Each child as its item reads now, under its key, as the parent's title is.
              tasks: yield* Effect.forEach(basis.children, ({ ref, receipt, review }) =>
                work.getItem(reader, { ref }).pipe(
                  Effect.map((child) => ({
                    title: `${child.key}: ${child.title}`,
                    receipt,
                    review,
                  })),
                ),
              ),
            });
      const problems = pullRequestTextProblems({ title: prTitle, body: prBody });
      if (problems.length > 0) {
        return yield* new FactoryPullRequestTextRefusedError({ deliveryId, problems });
      }

      // Read last, so an action that would fail on a moved HEAD never starts.
      yield* requireApproved(deliveryId, basis);

      const result = yield* gitWorkflow.runStackedAction(
        {
          actionId,
          cwd: basis.worktreePath,
          action: "create_pr",
          threadId: basis.author,
          projectId,
          prTitle,
          prBody,
          // Pushed by its id, whatever HEAD becomes while the action runs.
          expectedHeadSha: basis.approvedSha,
        },
        { actionId },
      );
      const opened = openedPullRequest(result);
      if (opened === undefined) {
        return yield* new FactoryPullRequestNotOpenedError({
          deliveryId,
          status: result.pr.status,
        });
      }
      // As the stacked action's RPC does for its caller's thread; a link that cannot be made is
      // logged and dropped. The pull request is open either way, and linked even if it were to
      // hold another commit, so the owner finds it.
      yield* linkCreatedPullRequest({
        threadId: basis.author,
        result,
        commandId: Effect.succeed(linkCommandId(deliveryId, effect.id)),
      }).pipe(Effect.provideContext(context));
      // The action published the approved commit; read back, so a pull request on any other
      // commit is never recorded as the delivery's.
      yield* requirePublished(deliveryId, basis);
      return { pullRequest: opened, threadId: basis.author };
    },
  );

  /**
   * The identity the pull request is linked under on the thread: from its URL, or the thread's
   * project for one its URL cannot name, as `linkCreatedPullRequest` reads it. Null when neither
   * names it.
   */
  const pullRequestKey = (threadId: ThreadId, pullRequest: FactoryOpenedPullRequest) =>
    Effect.gen(function* () {
      const thread = yield* orchestrator.getThreadShell(threadId);
      const project =
        thread === null
          ? undefined
          : Option.getOrUndefined(yield* projectService.getShell(thread.projectId));
      return createdPullRequestKey(
        { pr: { status: "opened_existing", number: pullRequest.number, url: pullRequest.url } },
        project && { ...project, repositories: thread?.workspaceBinding?.repositories ?? [] },
      );
    });

  /** The thread's link to the pull request as the projection has it; none when unlinked. */
  const linkOf = (threadId: ThreadId, pullRequest: FactoryPullRequestKey) =>
    orchestrator
      .getThreadShell(threadId)
      .pipe(
        Effect.map((shell) =>
          shell?.pullRequests?.find(
            (candidate) =>
              candidate.source !== "stack-dismissed" &&
              candidate.number === pullRequest.number &&
              candidate.url === pullRequest.url,
          ),
        ),
      );

  /** The thread's stored events after `after`, through its latest: a finite read of the log. */
  const threadEvents = (threadId: ThreadId, after: number) =>
    Effect.gen(function* () {
      const through = yield* events.latestSequence({ threadId });
      if (through <= after) return [];
      return Array.from(
        yield* events
          .read({ threadId, afterSequence: after, throughSequence: through })
          .pipe(Stream.runCollect),
      );
    });

  /**
   * The wakes among the thread's events, in order: each run whose command was a watch's sync
   * that stored it as the wake, as `wakeOf` judges it. Of the pull request only.
   */
  const wakesIn = (
    log: ReadonlyArray<OrchestrationV2StoredEvent>,
    pullRequest: FactoryPullRequestKey,
  ) =>
    Effect.gen(function* () {
      const wakes: Array<FactoryWakeEvent> = [];
      for (const stored of log) {
        const run = runCreated(stored);
        if (run === undefined) continue;
        const receipt = Option.getOrUndefined(yield* receipts.getByCommandId(run.commandId));
        const wake =
          receipt?.status === "accepted" ? wakeOf(run, receipt.commandType, log) : undefined;
        if (wake?.number === pullRequest.number && wake.url === pullRequest.url) wakes.push(wake);
      }
      return wakes;
    });

  /**
   * The delivery's own watch commands on the thread, read from their records so a command whose
   * result was never stored still counts: where each committed, oldest first, and the watches
   * they started, each with the link it is on (see `watchStartedBy`). Their ids derive from the
   * delivery and an effect, so every effect the delivery issued is looked up. A watch starts only
   * in a `thread.pull-request-synced` event, so the thread's events of that type through the last
   * command tell a watch a command started from one it kept. A command whose event the log no
   * longer holds proves nothing, and counts as starting none.
   */
  const watchCommands = (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
    threadId: ThreadId,
  ) =>
    Effect.gen(function* () {
      const positions: Array<number> = [];
      for (let effectId = 1; effectId <= delivery.state.effectsIssued; effectId += 1) {
        const receipt = Option.getOrUndefined(
          yield* receipts.getByCommandId(watchCommandId(delivery.deliveryId, effectId)),
        );
        if (receipt?.status === "accepted" && receipt.threadId === threadId) {
          positions.push(receipt.resultSequence);
        }
      }
      positions.sort((a, b) => a - b);
      const last = positions.at(-1);
      if (last === undefined) return { positions, started: [] };
      const synced = Array.from(
        yield* events
          .read({
            threadId,
            throughSequence: last,
            eventType: "thread.pull-request-synced",
          })
          .pipe(Stream.runCollect),
      );
      const started: Array<{
        readonly at: number;
        readonly startedAt: string;
        readonly link: ThreadPullRequestLink;
      }> = [];
      for (const at of positions) {
        const index = synced.findIndex((stored) => stored.sequence === at);
        const event = synced[index];
        const watch =
          event === undefined ? undefined : watchStartedBy(event, synced.slice(0, index));
        if (watch !== undefined) started.push({ at, ...watch });
      }
      return { positions, started };
    });

  /**
   * The thread the delivery's watch commands watched its pull request on, from the first one core
   * accepted; none when core accepted none. Every PR stage of a delivery links its pull request to
   * the same thread, so this is where a PR stage whose result was lost linked it.
   */
  const watchedThread = (delivery: FactoryDeliveryStore.StoredFactoryDelivery) =>
    Effect.gen(function* () {
      for (let effectId = 1; effectId <= delivery.state.effectsIssued; effectId += 1) {
        const receipt = Option.getOrUndefined(
          yield* receipts.getByCommandId(watchCommandId(delivery.deliveryId, effectId)),
        );
        if (receipt?.status === "accepted") return receipt.threadId;
      }
      return undefined;
    });

  /**
   * The pull request's watch on the thread as it is now, read only: its link, the start of the
   * watch on it (null when none is on) and whether that watch is Factory's (`held`, see
   * `isFactorys`), where the delivery's first watch command committed, the log's end, the wakes
   * core committed since that first command, and whether an end of the watch the delivery has not
   * taken is among them.
   */
  const readWatch = (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
    pullRequest: FactoryPullRequestKey,
    threadId: ThreadId,
  ) =>
    Effect.gen(function* () {
      const { state } = delivery;
      const { followThrough } = state;
      // The watch on the pull request first: core can only end one that is on.
      const link = yield* linkOf(threadId, pullRequest);
      const current = link?.watch?.startedAt ?? null;
      const commands = yield* watchCommands(delivery, threadId);
      const from = followThrough?.watchedAfter ?? commands.positions[0];
      const latest = yield* events.latestSequence({ threadId });
      const wakes =
        from === undefined ? [] : yield* wakesIn(yield* threadEvents(threadId, from), pullRequest);
      const taken = followThrough?.runs ?? [];
      const ended =
        followThrough?.watchEnded === true ||
        wakes.some((wake) => wake.kind === "ended" && !taken.includes(wake.runId));
      const held = isFactorys(state, commands.started, pullRequest, current) ? current : null;
      return { link, current, from, latest, wakes, ended, held };
    });

  const watch: FactoryPullRequest["Service"]["watch"] = Effect.fn("FactoryPullRequest.watch")(
    function* (delivery, effect, pullRequest, threadId) {
      const { deliveryId, state } = delivery;
      if (state.kind === "child") return Option.none();
      const key = yield* pullRequestKey(threadId, pullRequest);
      if (key === null) return yield* new FactoryPullRequestUnwatchableError({ deliveryId });
      const { current, from, latest, wakes, ended, held } = yield* readWatch(
        delivery,
        pullRequest,
        threadId,
      );
      if (ended || current !== null) {
        return Option.some({
          watch: { firstAt: from ?? latest, at: latest, armed: false, held },
          wakes,
        });
      }
      const { url, ...identity } = key;
      const armed = yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: watchCommandId(deliveryId, effect.id),
        threadId,
        ...identity,
        watching: true,
        link: { url, source: "created" },
      });
      const now = (yield* linkOf(threadId, pullRequest))?.watch?.startedAt ?? null;
      return Option.some({
        watch: {
          firstAt: from ?? armed.sequence,
          at: armed.sequence,
          armed: true,
          held: isFactorys(
            state,
            (yield* watchCommands(delivery, threadId)).started,
            pullRequest,
            now,
          )
            ? now
            : null,
        },
        wakes,
      });
    },
  );

  /** The thread's visible links as the `thread.pull-request-synced` event at `sequence` has. */
  const linksAt = (threadId: ThreadId, sequence: number) =>
    events
      .read({
        threadId,
        afterSequence: sequence - 1,
        throughSequence: sequence,
        eventType: "thread.pull-request-synced",
      })
      .pipe(
        Stream.runCollect,
        Effect.map((read) => {
          const [stored] = Array.from(read);
          return stored?.event.type === "thread.pull-request-synced"
            ? (stored.event.payload.pullRequests ?? []).filter(
                (link) => link.source !== "stack-dismissed",
              )
            : undefined;
        }),
      );

  /**
   * The link of the pull request a PR stage published, read from the event its watch command
   * committed at `at`: that command leaves the pull request it names watched, so it is the one
   * link watched then. When the thread watches several, the link the stage's own link command
   * added picks it, if that command added one (a link the thread had already is unchanged). None
   * when neither tells which, or compaction dropped the events that would.
   */
  const publishedLink = (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
    effect: Extract<FactoryEffect, { readonly type: "open_pr" }>,
    threadId: ThreadId,
    at: number,
  ) =>
    Effect.gen(function* () {
      const watched = ((yield* linksAt(threadId, at)) ?? []).filter(
        (link) => link.watch !== undefined,
      );
      if (watched.length <= 1) return watched[0];
      const linked = Option.getOrUndefined(
        yield* receipts.getByCommandId(linkCommandId(delivery.deliveryId, effect.id)),
      );
      if (linked?.status !== "accepted" || linked.threadId !== threadId) return undefined;
      const after = (yield* linksAt(threadId, linked.resultSequence)) ?? [];
      const previous = Array.from(
        yield* events
          .read({
            threadId,
            throughSequence: linked.resultSequence - 1,
            eventType: "thread.pull-request-synced",
          })
          .pipe(Stream.runCollect),
      ).at(-1)?.event;
      const before =
        previous?.type === "thread.pull-request-synced"
          ? (previous.payload.pullRequests ?? [])
          : [];
      const same = (a: ThreadPullRequestLink) => (b: ThreadPullRequestLink) =>
        a.host === b.host && a.repository === b.repository && a.number === b.number;
      const added = after.filter((link) => !before.some(same(link)));
      const picked = watched.filter((link) => added.some(same(link)));
      return picked.length === 1 ? picked[0] : undefined;
    });

  const recover: FactoryPullRequest["Service"]["recover"] = Effect.fn("FactoryPullRequest.recover")(
    function* (delivery, effect) {
      const receipt = Option.getOrUndefined(
        yield* receipts.getByCommandId(watchCommandId(delivery.deliveryId, effect.id)),
      );
      if (receipt?.status !== "accepted") return { type: "none" };
      const { threadId } = receipt;
      const { started } = yield* watchCommands(delivery, threadId);
      const link =
        started.find(({ at }) => at === receipt.resultSequence)?.link ??
        (yield* publishedLink(delivery, effect, threadId, receipt.resultSequence));
      if (link === undefined) return { type: "unknown" };
      const pullRequest = {
        number: link.number,
        url: link.url,
        // As the host names it once synced; `create_pr` publishes the delivery's branch by name.
        headBranch: link.snapshot?.headBranch ?? delivery.state.branch,
      };
      const now = yield* readWatch(delivery, pullRequest, threadId);
      const state = now.link?.snapshot?.state;
      return {
        type: "recovered",
        pullRequest,
        threadId,
        watch: {
          firstAt: now.from ?? receipt.resultSequence,
          at: now.latest,
          armed: false,
          held: now.held,
        },
        wakes: now.wakes,
        ...(state === "merged" || state === "closed" ? { outcome: state } : {}),
      };
    },
  );

  /**
   * Ends the watch that started at `startedAt` only if it is still the pull request's watch:
   * core's watch sync without a wake removes the watch under the thread's lock, and refuses one
   * that started at any other time. Returns the position of that removal; null when the watch
   * was already gone or replaced. Fails when it is still on and the command failed.
   */
  const endWatchStartedAt = (
    threadId: ThreadId,
    link: Pick<ThreadPullRequestLink, "host" | "repository" | "number" | "url">,
    startedAt: string,
  ) =>
    Effect.gen(function* () {
      const id = yield* crypto.randomUUIDv4();
      const ended = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.pull-request-watch.sync",
          // Each attempt is a command of its own: a refused one stays refused.
          commandId: CommandId.make(`factory-pr-unwatch:${id}`),
          threadId,
          host: link.host,
          repository: link.repository,
          number: link.number,
          startedAt,
          watch: null,
        }),
      );
      if (Exit.isSuccess(ended)) return ended.value.sequence;
      if (Cause.hasInterruptsOnly(ended.cause)) return yield* Effect.interrupt;
      // Refused because that watch is no longer on, or the command failed; only the first is done.
      const still = (yield* linkOf(threadId, link))?.watch?.startedAt === startedAt;
      return still ? yield* Effect.failCause(ended.cause) : null;
    });

  const release: FactoryPullRequest["Service"]["release"] = Effect.fn("FactoryPullRequest.release")(
    function* (delivery) {
      const { state } = delivery;
      const threadId = followedThread(state) ?? (yield* watchedThread(delivery));
      if (threadId === undefined) return Option.none();
      const { followThrough } = state;
      const { positions, started } = yield* watchCommands(delivery, threadId);
      const latest = started.at(-1);
      const held = followThrough?.watchStartedAt ?? null;
      // The pull request Factory's latest watch command started a watch on, else the one recorded.
      const recorded = latest?.link ?? state.pullRequest;
      const first = followThrough?.watchedAfter ?? positions[0];
      if (recorded === null || recorded === undefined || first === undefined) return Option.none();
      const pullRequest = { number: recorded.number, url: recorded.url };
      const link = yield* linkOf(threadId, pullRequest);
      const current = link?.watch?.startedAt ?? null;
      // A link has one watch: Factory's while it is on, else the latest one Factory started.
      const startedAt = isFactorys(state, started, pullRequest, current)
        ? current
        : (latest?.startedAt ?? held);
      if (startedAt === null) return Option.none();
      const ended =
        (held === startedAt ? (followThrough?.heldUntil ?? null) : null) ??
        (link !== undefined && current === startedAt
          ? yield* endWatchStartedAt(threadId, link, startedAt)
          : null);
      // Read after the end, so the log holds it: every wake core committed since the delivery's
      // first watch command, and where that watch stopped being the pull request's.
      const read = yield* threadEvents(threadId, first);
      const startedHere = latest?.startedAt === startedAt ? latest.at : undefined;
      const at =
        ended ??
        watchEndIn(
          read.filter((stored) => stored.sequence > (startedHere ?? first)),
          pullRequest,
          startedAt,
          startedHere !== undefined,
        ) ??
        null;
      return Option.some({
        threadId,
        startedAt,
        pullRequest,
        at,
        firstAt: Math.min(first, positions[0] ?? first),
        wakes: yield* wakesIn(read, pullRequest),
      });
    },
  );

  /**
   * Ends the watch on a merged pull request, as core's watch would on its next pass, only while
   * it is the watch read here: a watch counts as a thread's background work, which keeps the
   * worktree. A failure is logged, and the worktree stays.
   */
  const endMergedWatch = (delivery: FactoryDeliveryStore.StoredFactoryDelivery) =>
    Effect.gen(function* () {
      const threadId = followedThread(delivery.state);
      const { pullRequest, followThrough } = delivery.state;
      if (followThrough === undefined || threadId === undefined || pullRequest === null) return;
      const link = yield* linkOf(threadId, pullRequest);
      if (link?.watch === undefined) return;
      yield* endWatchStartedAt(threadId, link, link.watch.startedAt);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("factory could not end a merged pull request's watch", cause),
      ),
    );

  /** A merged delivery's items: a parent's children in plan order, then the delivery's own. */
  const finishedItems = (delivery: FactoryDeliveryStore.StoredFactoryDelivery) =>
    Effect.forEach(delivery.state.children, (childId) =>
      deliveries.get(childId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new FactoryCloseOutChildMissingError({
                  deliveryId: delivery.deliveryId,
                  childId,
                }),
              ),
            onSome: (child) => Effect.succeed(child.itemRef),
          }),
        ),
      ),
    ).pipe(Effect.map((children) => [...children, delivery.itemRef]));

  /** The path with its links resolved; as given when it cannot be resolved. */
  const resolved = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));

  /**
   * Whether a thread is working in the checkout at `root` (resolved): one with a run, run
   * activity or background tasks whose checkout is `root` or inside it. That checkout is its
   * worktree, the repositories it is bound to, or else its project's root, where its turns run.
   * Core's checkout coordination applies this rule only before changing a shared checkout, which
   * a delivery's own worktree is not, so Factory applies it here, to settled threads too: a
   * thread settles with a background command still running, and its provider stops only after.
   */
  const inUse = (root: string) =>
    Effect.gen(function* () {
      const snapshot = yield* projections.getShellSnapshot();
      const projectRoots = new Map(
        (yield* projects.list({ includeDeleted: true })).map(
          (project) => [project.projectId, project.workspaceRoot] as const,
        ),
      );
      for (const thread of [...snapshot.threads, ...snapshot.archivedThreads]) {
        if (
          thread.activeRunId === null &&
          thread.activityRunStatus == null &&
          (thread.pendingBackgroundTasks?.length ?? 0) === 0
        ) {
          continue;
        }
        const projectRoot = projectRoots.get(thread.projectId);
        const checkouts =
          thread.worktreePath !== null
            ? [thread.worktreePath]
            : thread.workspaceBinding !== undefined
              ? thread.workspaceBinding.repositories.map(({ rootPath }) => rootPath)
              : projectRoot === undefined
                ? []
                : [projectRoot];
        for (const checkout of checkouts) {
          const relative = path.relative(root, yield* resolved(checkout));
          if (
            relative === "" ||
            (relative !== ".." &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative))
          ) {
            return true;
          }
        }
      }
      return false;
    });

  const closeOutWorktree: FactoryPullRequest["Service"]["closeOutWorktree"] = Effect.fn(
    "FactoryPullRequest.closeOutWorktree",
  )(function* (delivery) {
    yield* endMergedWatch(delivery);
    const { worktreePath } = delivery.state;
    if (worktreePath === null) return;
    const project = Option.getOrUndefined(
      yield* projects.get(delivery.projectId, { includeDeleted: true }),
    );
    const kept = (reason: string) =>
      Effect.logInfo(`factory kept a merged delivery's worktree: ${reason}`).pipe(
        Effect.annotateLogs({ deliveryId: delivery.deliveryId }),
      );
    if (project === undefined) return yield* kept("its project is not stored");
    const current = yield* readWorktreeState(worktreePath).pipe(
      Effect.asSome,
      Effect.catchTags({ FactoryWorktreeMissingError: () => Effect.succeedNone }),
      Effect.provideContext(context),
    );
    if (Option.isNone(current)) return;
    const root = yield* resolved(worktreePath);
    if (root === (yield* resolved(project.workspaceRoot))) return;
    if (!current.value.clean) return yield* kept("it has changes");
    // A thread that has not written anything yet still works there: its run is left alone.
    if (yield* inUse(root)) return yield* kept("a thread is working in it");
    // Not forced: Git refuses a worktree that changed since it was read, and the effect fails.
    yield* gitWorkflow.removeWorktree({ cwd: project.workspaceRoot, path: worktreePath });
  });

  const closeOutItems: FactoryPullRequest["Service"]["closeOutItems"] = Effect.fn(
    "FactoryPullRequest.closeOutItems",
  )(function* (delivery) {
    const writer = itemWriter(delivery.deliveryId);
    // Every item is found before any is set, so a missing child sets none.
    const items = yield* finishedItems(delivery);
    // Work keeps what it read for a while, and a tracker's own changes do not reach that: the
    // item read below must be the source's now, or a done one reopened since would stay open.
    yield* work.refresh(writer, { sourceId: delivery.itemRef.sourceId });
    for (const ref of items) {
      // An item it cannot read in full is not taken as done.
      const item = yield* work.getItem(writer, { ref });
      if (item.status === "done" && item.invalid === null) continue;
      yield* work.setStatus(writer, { ref, status: "done" });
    }
  });

  return FactoryPullRequest.of({
    open,
    watch,
    recover,
    release,
    closeOutItems,
    closeOutWorktree,
  });
});

/**
 * The PR stages' work, reading command records and stored events from the database every
 * orchestration store shares, to find the watches Factory's own commands started and the wakes
 * core committed.
 */
export const layer = Layer.effect(FactoryPullRequest, make).pipe(
  Layer.provide(Layer.mergeAll(CommandReceiptStore.layer, EventStore.layer)),
);
