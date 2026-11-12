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
import * as SecureRandom from "effect/crypto/SecureRandom";
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
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
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
import {
  FactoryBranchReadError,
  type FactoryWorktreeMissingError,
  readBranchFacts,
  readOutgoingCommits,
  readPushTarget,
} from "./git/branchFacts.ts";
import {
  evaluatePublication,
  evaluateSavedPullRequest,
  FactoryPublicationProblem,
} from "./git/settle.ts";
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

const MAX_NAMED_PROBLEMS = 3;

const isChangedDestination = ({ target, rule }: FactoryPublicationProblem) =>
  target === "destination" && rule === "changed";

const quoteBranch = (branch: string) =>
  JSON.stringify(branch.length > 72 ? `${branch.slice(0, 72)}…` : branch);

const COMMIT_RULE_WORDS = {
  non_conventional_subject: "has a subject that is not a Conventional Commit",
  ai_name_in_subject: "names an AI agent, model or provider in its subject",
  ai_name_in_body: "names an AI agent, model or provider in its message",
  ai_attribution: "carries generated or assisted attribution",
  ai_identity: "has an author or committer identity naming an AI agent, model or provider",
} as const;

const REMOTE_BRANCH_RULE_WORDS = {
  branch_prefix: "has no feature/, bugfix/, chore/ or docs/ prefix",
  ai_name_in_branch: "names an AI agent, model or provider",
  ai_attribution_in_branch: "carries generated or assisted attribution",
} as const;

/** One problem in words: which part and which rule, never the text that broke it. */
const describeProblem = (problem: FactoryPublicationProblem, branch: string) => {
  const named = quoteBranch(branch);
  switch (problem.target) {
    case "branch":
      return {
        wrong_branch: `its worktree is not on its branch ${named}`,
        branch_prefix: `its branch ${named} has no feature/, bugfix/, chore/ or docs/ prefix`,
        ai_name_in_branch: `its branch ${named} names an AI agent, model or provider`,
        ai_attribution_in_branch: `its branch ${named} carries generated or assisted attribution`,
      }[problem.rule];
    case "commits":
      return {
        baseline_missing: "the delivery records no commit its branch started from",
        baseline_not_ancestor: "the commit its branch started from is no longer in its history",
        no_new_commit: "its branch holds no commit of its own",
      }[problem.rule];
    case "commit":
      return `commit ${problem.commit} ${COMMIT_RULE_WORDS[problem.rule]}`;
    case "ancestor":
      return `commit ${problem.commit}, from before this delivery and not yet on its remote, ${COMMIT_RULE_WORDS[problem.rule]}`;
    case "remote_branch":
      return `a push of its branch would land on ${quoteBranch(problem.remote)}'s branch ${quoteBranch(problem.branch)}, which ${REMOTE_BRANCH_RULE_WORDS[problem.rule]}`;
    case "destination":
      return {
        unreadable:
          "Factory could not read what its remote holds, so it cannot tell which commits a push would add",
        changed:
          "where a push of its branch goes, its remote, upstream or push URLs, changed after Factory judged what the push would add there",
        unpinnable:
          "the Git that runs this project cannot hold a push to only the push URLs Factory judged",
      }[problem.rule];
    case "saved_head":
      return "its head branch on the host is not the remote branch its pushes land on";
    case "saved_pull_request":
      return "Factory could not read its saved title, body and head branch from the host";
    default: {
      const part = problem.target.replace("_", " ");
      return {
        malformed_title: `its ${part} is not one short Conventional line keeping the item's key`,
        ai_name: `its ${part} names an AI agent, model or provider`,
        ai_attribution: `its ${part} carries generated or assisted attribution`,
        differs: `its ${part} is not what Factory sent`,
      }[problem.rule];
    }
  }
};

const describeProblems = (problems: ReadonlyArray<FactoryPublicationProblem>, branch: string) => {
  const named = problems.slice(0, MAX_NAMED_PROBLEMS).map((p) => describeProblem(p, branch));
  const more = problems.length - named.length;
  return `${named.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
};

/**
 * What the owner can do about what stopped a publication, the hardest first. Factory renames,
 * rewrites and edits nothing, so a branch that cannot publish takes a new delivery, which starts on
 * a compliant one.
 */
const nextAction = (problems: ReadonlyArray<FactoryPublicationProblem>) => {
  const has = (...targets: ReadonlyArray<FactoryPublicationProblem["target"]>) =>
    problems.some(({ target, rule }) => targets.includes(target) && rule !== "wrong_branch");
  if (has("branch")) {
    return "Factory renames nothing, and any branch, pull request and commits it published stay as they are: cancel this delivery and deliver the item again, which publishes from a compliant branch.";
  }
  if (has("ancestor")) {
    return "Factory changes no commit: correct it on the branch this delivery started from, or put the project's checkout on a commit its remote already holds, then cancel this delivery and deliver the item again.";
  }
  if (has("commit", "commits")) {
    return "Factory changes no commit: correct them on the branch or cancel and deliver the item again, then Resume.";
  }
  if (has("remote_branch")) {
    return "Factory changes no remote, upstream or branch: set up the repository so a push of its branch lands on a branch of the same name, such as by renaming a remote whose name starts the branch's or removing an upstream that renames it, then Resume.";
  }
  if (problems.some(isChangedDestination)) {
    return "Factory pushes only where it judged, and goes no further once that changes: keep or restore the remote, upstream and push URLs its branch should publish to, then Resume, which judges that destination again before pushing.";
  }
  if (problems.some(({ target, rule }) => target === "destination" && rule === "unpinnable")) {
    return "Factory pushes only where it can hold Git to what it judged: update Git on the environment that runs this project to 2.46 or later, then Resume, which judges the destination again before pushing.";
  }
  if (has("destination")) {
    return "Check that its branch has a remote and that Factory can reach it, then Resume.";
  }
  if (has("saved_title", "saved_body", "saved_head")) {
    return "Factory edits nothing on the host: correct the pull request there, then Resume.";
  }
  if (has("saved_pull_request")) {
    return "Check its title, body and head branch on the host and that Factory can reach it, then Resume to read it again.";
  }
  if (problems.some(({ target, rule }) => target === "title" && rule === "malformed_title")) {
    return "Factory cuts a title only between words: change the item so its key and the first word of its title fit on one short line, then Resume.";
  }
  if (has("title", "body")) return "Change the item or the verify command, then Resume.";
  return "Put the worktree back on its branch, then Resume.";
};

/**
 * The publication gate refused: nothing was published, but for a changed destination, whose push
 * may have reached where the gate judged and nowhere else before it stopped. Its message is fixed
 * text naming what broke which rule and what to do next, safe to show, since it quotes no text but
 * the branch.
 */
export class FactoryPublicationRefusedError extends Schema.TaggedError<FactoryPublicationRefusedError>()(
  "FactoryPublicationRefusedError",
  {
    deliveryId: FactoryDeliveryId,
    branch: Schema.String,
    problems: Schema.Array(FactoryPublicationProblem),
  },
) {
  override get message(): string {
    const published = this.problems.some(isChangedDestination)
      ? "Factory published nothing it had not judged"
      : "Factory published nothing";
    return `${published}: ${describeProblems(this.problems, this.branch)}. ${nextAction(this.problems)}`;
  }
}

export const isFactoryPublicationRefusedError = Schema.is(FactoryPublicationRefusedError);

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
 * What `recover` found of a PR stage whose result a restart lost: nothing proves it published,
 * it published a pull request the records cannot name, or what it published, with its thread,
 * watch, the wakes since the first watch command and how it left `open` if it did.
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
  | FactoryPublicationRefusedError
  | FactoryPullRequestPublishedUnapprovedError
  | FactoryWorktreeMissingError
  | FactoryBranchReadError
  | FactoryEvidence.FactoryEvidenceError
  | FactoryStoreError
  | WorkDomainError
  | GitManagerServiceError;

/**
 * The delivery's published pull request and the thread core's watch wakes (a parent's last
 * child's author thread). `publicationFailure`, safe to show, says why what the host saved is not
 * compliant: the pull request is still recorded, but the delivery blocks rather than watch it.
 */
interface FactoryPublishedPullRequest {
  readonly pullRequest: FactoryOpenedPullRequest;
  readonly threadId: ThreadId;
  readonly publicationFailure?: string;
}

/**
 * The PR stages' work: opens (or, in a follow-through round, pushes to) the delivery's pull
 * request via `create_pr`, watches it on its linked thread, and closes the delivery out once
 * merged. Every push first passes `evaluatePublication` and pushes the exact approved commit from a
 * clean tree; nothing here renames or rewrites. A child opens none.
 */
export class FactoryPullRequest extends Context.Service<
  FactoryPullRequest,
  {
    readonly open: (
      delivery: FactoryDeliveryStore.StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "open_pr" }>,
    ) => Effect.Effect<FactoryPublishedPullRequest, FactoryPullRequestError>;
    /**
     * Has core watch the pull request on `threadId` and reports the watch with the wakes since the
     * first watch command, for the worker to step. Starts one only when none is on and no untaken
     * wake ended one, so a watch core ended never restarts; command ids derive from the delivery
     * and effect, so a retry starts no second watch. None for a child.
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
     * Reads what a PR stage whose result a restart lost did, from its watch command's records (see
     * `FactoryPullRequestRecovery`): an accepted command proves it published and linked. The pull
     * request is found from the event that command committed (see `publishedLink`); a watch the
     * command kept is someone else's. Reads only.
     */
    readonly recover: (
      delivery: FactoryDeliveryStore.StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "open_pr" }>,
    ) => Effect.Effect<FactoryPullRequestRecovery, FactoryPullRequestWatchError>;
    /**
     * Ends Factory's watch (see `isFactorys`) for a cancel, only while core still sees that very
     * watch, so one the owner started stays. Reports it with where it ended and the wakes since,
     * for the worker to step. None when Factory holds no watch; fails only when it is still on and
     * could not be ended.
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
     * After the merge, sets a parent's child items then the delivery's own item done through Work.
     * Items the source (freshly read) already shows done are skipped, since Jira refuses done to
     * done; one it cannot read in full is never taken as done. A failed read or write fails it.
     */
    readonly closeOutItems: (
      delivery: FactoryDeliveryStore.StoredFactoryDelivery,
    ) => Effect.Effect<void, FactoryCloseOutItemsError>;
    /**
     * After the merge, ends the PR stage's watch (it counts as background work that keeps the
     * worktree), then removes the worktree if clean, unused and not the primary checkout; the branch
     * stays. Call only under the delivery's lock while it awaits close-out, so a cancel keeps it.
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
  const crypto = yield* SecureRandom.SecureRandom;
  const projectService = yield* ProjectService.ProjectService;
  const pullRequestDetails = yield* PullRequestService.PullRequestService;
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
  const requireApproved = Effect.fn("FactoryPullRequest.requireApproved")(function* (
    deliveryId: FactoryDeliveryId,
    basis: { readonly worktreePath: string; readonly approvedSha: string },
  ) {
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
  const requirePublished = Effect.fn("FactoryPullRequest.requirePublished")(function* (
    deliveryId: FactoryDeliveryId,
    basis: { readonly worktreePath: string; readonly approvedSha: string },
  ) {
    const publishedSha = yield* publishedCommit(basis.worktreePath);
    if (publishedSha !== basis.approvedSha) {
      return yield* new FactoryPullRequestPublishedUnapprovedError({
        deliveryId,
        approvedSha: basis.approvedSha,
        publishedSha,
      });
    }
  });

  /**
   * The branch, its push target, and, read now by commit id, the delivery's commits up to the
   * approved one plus every other commit the push would newly publish. The gate reads both sets:
   * the range alone misses an unpushed base, the outgoing alone skips already-pushed own commits.
   */
  const publicationFacts = Effect.fn("FactoryPullRequest.publicationFacts")(function* (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
    basis: { readonly worktreePath: string; readonly approvedSha: string },
  ) {
    const { deliveryId, state } = delivery;
    if (state.baseline === null) {
      return yield* new FactoryPublicationRefusedError({
        deliveryId,
        branch: state.branch,
        problems: [{ target: "commits", rule: "baseline_missing" }],
      });
    }
    const facts = yield* readBranchFacts({
      worktreePath: basis.worktreePath,
      baselineSha: state.baseline,
      headSha: basis.approvedSha,
    }).pipe(Effect.provideContext(context));
    const target = yield* readPushTarget({
      worktreePath: basis.worktreePath,
      branch: state.branch,
    }).pipe(Effect.provideContext(context));
    const outgoing =
      target === null
        ? null
        : yield* readOutgoingCommits({
            worktreePath: basis.worktreePath,
            target,
            headSha: basis.approvedSha,
          }).pipe(Effect.provideContext(context));
    const own = new Set(facts.commits.map(({ sha }) => sha));
    return {
      ...facts,
      target,
      ancestry: outgoing === null ? null : outgoing.filter(({ sha }) => !own.has(sha)),
    };
  });

  /**
   * The remote branch and push URLs the gate judged, which the action's push is bound to: it goes to
   * those URLs alone, so a remote, upstream, push URL or URL rewrite changed after the gate cannot
   * send it elsewhere. The gate refuses a push that names none, as a destination it cannot read.
   */
  const checkedTarget = (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
    facts: { readonly target: GitVcsDriver.GitCheckedPushTarget | null },
  ) =>
    facts.target === null
      ? Effect.fail(
          new FactoryPublicationRefusedError({
            deliveryId: delivery.deliveryId,
            branch: delivery.state.branch,
            problems: [{ target: "destination", rule: "unreadable" }],
          }),
        )
      : Effect.succeed(facts.target);

  /**
   * Maps a push that would leave the target the gate judged, or a Git that cannot be held to its
   * URLs, to a gate-style refusal with fixed, showable text. Any other Git failure stays one whose
   * text is never shown.
   */
  const refusedOffTarget = <A, R>(
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
    action: Effect.Effect<A, GitManagerServiceError, R>,
  ) =>
    action.pipe(
      Effect.catchTags({
        GitCommandError: (error) => {
          const rule =
            error.reason === "push_target_changed"
              ? "changed"
              : error.reason === "push_target_unpinnable"
                ? "unpinnable"
                : null;
          return Effect.fail(
            rule === null
              ? error
              : new FactoryPublicationRefusedError({
                  deliveryId: delivery.deliveryId,
                  branch: delivery.state.branch,
                  problems: [{ target: "destination", rule }],
                }),
          );
        },
      }),
    );

  /** Fails unless the gate found nothing wrong. */
  const requirePublishable = (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
    problems: ReadonlyArray<FactoryPublicationProblem>,
  ) =>
    problems.length === 0
      ? Effect.void
      : Effect.fail(
          new FactoryPublicationRefusedError({
            deliveryId: delivery.deliveryId,
            branch: delivery.state.branch,
            problems,
          }),
        );

  /**
   * The pull request as its host holds it now, not as a client's read left it in the cache. Null
   * when it cannot be read, whatever the reason: a host Factory cannot read, or a pull request that
   * cannot be named, has not been shown to comply.
   */
  const readSaved = Effect.fn("FactoryPullRequest.readSaved")(
    function* (
      delivery: FactoryDeliveryStore.StoredFactoryDelivery,
      pullRequest: FactoryOpenedPullRequest,
      threadId: ThreadId,
    ) {
      const key = yield* pullRequestKey(threadId, pullRequest);
      if (key === null) return null;
      const reference = {
        projectId: delivery.projectId,
        host: key.host,
        repository: key.repository,
        number: pullRequest.number,
      };
      yield* pullRequestDetails.invalidate({ reference });
      return yield* pullRequestDetails.detail(reference);
    },
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("factory could not read a saved pull request", cause).pipe(
            Effect.as(null),
          ),
    ),
  );

  const open: FactoryPullRequest["Service"]["open"] = Effect.fn("FactoryPullRequest.open")(
    function* (delivery, effect) {
      const { deliveryId, projectId, state } = delivery;
      const reader = itemReader(deliveryId);
      const basis =
        state.kind === "parent" ? yield* parentBasisOf(delivery) : yield* basisOf(delivery);
      // Derived from the effect, so progress and the thread link name this attempt.
      const actionId = `factory-pr:${deliveryId}:${effect.id}`;
      const expectedBranch = state.branch;

      // A follow-through round only pushes the approved commit by id: asking for a pull request
      // again could open a second one if the first merged before core's sync stored it. The gate
      // judges the host's saved pull request, its head held to the push target. Local checks run
      // before the slow tracker and host reads, then again after them.
      const recorded = state.pullRequest;
      if (recorded !== null && recorded.outcome === undefined) {
        const requireLocal = publicationFacts(delivery, basis).pipe(
          Effect.tap((facts) =>
            requirePublishable(delivery, evaluatePublication({ facts, expectedBranch })),
          ),
          Effect.flatMap((facts) => checkedTarget(delivery, facts)),
        );
        yield* requireLocal;
        const { key } = yield* work.getItem(reader, { ref: delivery.itemRef });
        const saved = yield* readSaved(delivery, recorded, basis.author);
        const target = yield* requireLocal;
        yield* requirePublishable(
          delivery,
          saved === null
            ? [{ target: "saved_pull_request", rule: "unreadable" }]
            : evaluateSavedPullRequest({ saved, expectedHead: target.branch, key }),
        );
        yield* requireApproved(deliveryId, basis);
        yield* refusedOffTarget(
          delivery,
          gitWorkflow.runStackedAction(
            {
              actionId,
              cwd: basis.worktreePath,
              action: "push",
              threadId: basis.author,
              projectId,
              expectedHeadSha: basis.approvedSha,
            },
            { actionId, expectedPushTarget: target },
          ),
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
      // Each child as its item reads now, under its key, as the parent's title is.
      const children =
        basis.type === "parent"
          ? yield* Effect.forEach(basis.children, ({ ref, receipt, review }) =>
              work.getItem(reader, { ref }).pipe(
                Effect.map((child) => ({
                  title: `${child.key}: ${child.title}`,
                  receipt,
                  review,
                })),
              ),
            )
          : [];
      // After the item reads, which can take long: these are what the action publishes.
      const facts = yield* publicationFacts(delivery, basis);
      const prTitle = renderPullRequestTitle(item, facts.commits);
      const prBody =
        basis.type === "single"
          ? renderPullRequestBody({
              item,
              tasks: [{ ...basis.task, title: basis.task.title ?? item.title }],
            })
          : renderPullRequestBody({ item, branch: basis.branch, tasks: children });
      yield* requirePublishable(
        delivery,
        evaluatePublication({
          facts,
          expectedBranch,
          text: { title: prTitle, body: prBody, key: item.key },
        }),
      );
      const target = yield* checkedTarget(delivery, facts);

      // Read last, so an action that would fail on a moved HEAD never starts.
      yield* requireApproved(deliveryId, basis);

      const result = yield* refusedOffTarget(
        delivery,
        gitWorkflow.runStackedAction(
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
          // And only to the remote branch and URLs the gate judged.
          { actionId, expectedPushTarget: target },
        ),
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

      // What the host saved, not what it was asked to save: a host or its automation can change
      // it, and one already open was written by someone else. Published either way, so a problem
      // here is reported with the pull request, which the delivery records as it blocks. Nothing
      // is edited: only the owner decides what a pull request says.
      const saved = yield* readSaved(delivery, opened, basis.author);
      const problems: ReadonlyArray<FactoryPublicationProblem> =
        saved === null
          ? [{ target: "saved_pull_request", rule: "unreadable" }]
          : evaluateSavedPullRequest({
              saved,
              expectedHead: target.branch,
              key: item.key,
              ...(result.pr.status === "created" ? { sent: { title: prTitle, body: prBody } } : {}),
            });
      return {
        pullRequest: opened,
        threadId: basis.author,
        ...(problems.length === 0
          ? {}
          : {
              publicationFailure: `Factory opened pull request #${opened.number}, but ${describeProblems(problems, expectedBranch)}. ${nextAction(problems)}`,
            }),
      };
    },
  );

  /**
   * The identity the pull request is linked under on the thread: from its URL, or the thread's
   * project for one its URL cannot name, as `linkCreatedPullRequest` reads it. Null when neither
   * names it.
   */
  const pullRequestKey = Effect.fn("FactoryPullRequest.pullRequestKey")(function* (
    threadId: ThreadId,
    pullRequest: FactoryOpenedPullRequest,
  ) {
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
  const threadEvents = Effect.fn("FactoryPullRequest.threadEvents")(function* (
    threadId: ThreadId,
    after: number,
  ) {
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
  const wakesIn = Effect.fn("FactoryPullRequest.wakesIn")(function* (
    log: ReadonlyArray<OrchestrationV2StoredEvent>,
    pullRequest: FactoryPullRequestKey,
  ) {
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
   * The delivery's own watch commands on the thread, from their records (so an unstored result
   * still counts), oldest first, with the watches they started (see `watchStartedBy`). Only a
   * `thread.pull-request-synced` event starts a watch, which tells started from kept. A command
   * whose event the log no longer holds counts as starting none.
   */
  const watchCommands = Effect.fn("FactoryPullRequest.watchCommands")(function* (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
    threadId: ThreadId,
  ) {
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
      const watch = event === undefined ? undefined : watchStartedBy(event, synced.slice(0, index));
      if (watch !== undefined) started.push({ at, ...watch });
    }
    return { positions, started };
  });

  /**
   * The thread the delivery's watch commands watched its pull request on, from the first one core
   * accepted; none when core accepted none. Every PR stage of a delivery links its pull request to
   * the same thread, so this is where a PR stage whose result was lost linked it.
   */
  const watchedThread = Effect.fn("FactoryPullRequest.watchedThread")(function* (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
  ) {
    for (let effectId = 1; effectId <= delivery.state.effectsIssued; effectId += 1) {
      const receipt = Option.getOrUndefined(
        yield* receipts.getByCommandId(watchCommandId(delivery.deliveryId, effectId)),
      );
      if (receipt?.status === "accepted") return receipt.threadId;
    }
    return undefined;
  });

  /**
   * The pull request's watch on the thread now, read only: its link, its start (null when off),
   * whether it is Factory's (`held`), the first watch command's position, the log's end, the wakes
   * since that command, and whether an untaken watch end is among them.
   */
  const readWatch = Effect.fn("FactoryPullRequest.readWatch")(function* (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
    pullRequest: FactoryPullRequestKey,
    threadId: ThreadId,
  ) {
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
   * The link a PR stage published, from the event its watch command committed at `at`: the one
   * link watched then, or, when several are, the one the stage's own link command added. None
   * when neither tells, or compaction dropped the events.
   */
  const publishedLink = Effect.fn("FactoryPullRequest.publishedLink")(function* (
    delivery: FactoryDeliveryStore.StoredFactoryDelivery,
    effect: Extract<FactoryEffect, { readonly type: "open_pr" }>,
    threadId: ThreadId,
    at: number,
  ) {
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
      previous?.type === "thread.pull-request-synced" ? (previous.payload.pullRequests ?? []) : [];
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
  const endWatchStartedAt = Effect.fn("FactoryPullRequest.endWatchStartedAt")(function* (
    threadId: ThreadId,
    link: Pick<ThreadPullRequestLink, "host" | "repository" | "number" | "url">,
    startedAt: string,
  ) {
    const id = yield* crypto.uuidV4();
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
  const endMergedWatch = Effect.fn("FactoryPullRequest.endMergedWatch")(
    function* (delivery: FactoryDeliveryStore.StoredFactoryDelivery) {
      const threadId = followedThread(delivery.state);
      const { pullRequest, followThrough } = delivery.state;
      if (followThrough === undefined || threadId === undefined || pullRequest === null) return;
      const link = yield* linkOf(threadId, pullRequest);
      if (link?.watch === undefined) return;
      yield* endWatchStartedAt(threadId, link, link.watch.startedAt);
    },
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
   * Whether a thread has a run, run activity or background tasks in the checkout at `root`
   * (resolved) or inside it. Core checks this only for shared checkouts, so Factory checks its own
   * worktree here, settled threads included: a background command can outlive the settle.
   */
  const inUse = Effect.fn("FactoryPullRequest.inUse")(function* (root: string) {
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
          (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
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
