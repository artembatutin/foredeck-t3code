import {
  AuthWorkReadScope,
  AuthWorkWriteScope,
  CommandId,
  type GitCommandError,
  type GitManagerServiceError,
  type GitRunStackedActionResult,
} from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import { linkCreatedPullRequest } from "../../git/linkCreatedPullRequest.ts";
import type * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import type * as ProjectService from "../../project/ProjectService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { type WorkActor, type WorkDomainError, WorkService } from "../work-management/index.ts";
import { taskOfChild } from "./FactoryChildren.ts";
import { readBranchApproval } from "./FactoryRecord.ts";
import { FactoryBranchReadError, type FactoryWorktreeMissingError } from "./git/branchFacts.ts";
import { readWorktreeState } from "./git/worktreeState.ts";
import type { FactoryStoreError } from "./persistence/errors.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import { acceptedReview, receiptFailed } from "./pipeline/state.ts";
import type {
  FactoryDeliveryState,
  FactoryEffect,
  FactoryOpenedPullRequest,
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
 * The PR stages' work. Opens the delivery's pull request from its worktree through the stacked
 * Git action (`create_pr`) with the item's title and a body listing the accepted task and its
 * evidence, then links it to the author thread. A parent's is its one pull request: its body lists
 * its whole branch's verify and integrate review, then each child item in plan order with its
 * own, and it is linked to the last child's author thread, since a parent has none. A child opens
 * none. Text that names an AI agent, model or provider or carries attribution is never published.
 * The action runs only while the worktree holds the approved commit on a clean tree, and pushes
 * that exact commit, so a commit made meanwhile never reaches the remote. An open pull request for
 * the branch is reported as it is, unchanged. Once someone merged it, closes the delivery out.
 */
export class FactoryPullRequest extends Context.Service<
  FactoryPullRequest,
  {
    readonly open: (
      delivery: FactoryDeliveryStore.StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "open_pr" }>,
    ) => Effect.Effect<FactoryOpenedPullRequest, FactoryPullRequestError>;
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
     * Follow-through once the delivery's pull request merged, second part: removes the delivery's
     * worktree through the Git workflow when it is clean and no thread works in it. The branch
     * always stays, and so does a worktree with changes, one a thread is working in, one already
     * gone and the project's primary checkout. The worker calls this only under the delivery's
     * lock, while the delivery still awaits its close-out, so a cancel never loses its checkout.
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

const make = Effect.gen(function* () {
  const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
  const git = yield* GitVcsDriver.GitVcsDriver;
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

  const open: FactoryPullRequest["Service"]["open"] = Effect.fn("FactoryPullRequest.open")(
    function* (delivery, effect) {
      const { deliveryId, projectId } = delivery;
      const reader = itemReader(deliveryId);
      const basis =
        delivery.state.kind === "parent"
          ? yield* parentBasisOf(delivery)
          : yield* basisOf(delivery);
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

      // Record checked the worktree, but a commit or edit could land since; read last, right
      // before the action, so an action that would fail on a moved HEAD never starts.
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

      // Derived from the effect, so progress and the thread link name this attempt.
      const actionId = `factory-pr:${deliveryId}:${effect.id}`;
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
        commandId: Effect.succeed(CommandId.make(`factory-pr-link:${deliveryId}:${effect.id}`)),
      }).pipe(Effect.provideContext(context));
      // The action published the approved commit; read back, so a pull request on any other
      // commit is never recorded as the delivery's.
      const publishedSha = yield* publishedCommit(basis.worktreePath);
      if (publishedSha !== basis.approvedSha) {
        return yield* new FactoryPullRequestPublishedUnapprovedError({
          deliveryId,
          approvedSha: basis.approvedSha,
          publishedSha,
        });
      }
      return opened;
    },
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

  return FactoryPullRequest.of({ open, closeOutItems, closeOutWorktree });
});

export const layer = Layer.effect(FactoryPullRequest, make);
