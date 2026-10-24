import {
  AuthWorkReadScope,
  CommandId,
  type GitManagerServiceError,
  type GitRunStackedActionResult,
} from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import { linkCreatedPullRequest } from "../../git/linkCreatedPullRequest.ts";
import type * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import type * as ProjectService from "../../project/ProjectService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { type WorkActor, type WorkDomainError, WorkService } from "../work-management/index.ts";
import { FactoryBranchReadError, type FactoryWorktreeMissingError } from "./git/branchFacts.ts";
import { readWorktreeState } from "./git/worktreeState.ts";
import type { FactoryStoreError } from "./persistence/errors.ts";
import type { StoredFactoryDelivery } from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import { acceptedReview, receiptFailed } from "./pipeline/state.ts";
import type { FactoryEffect, FactoryOpenedPullRequest } from "./pipeline/state.ts";
import {
  pullRequestTextProblems,
  renderPullRequestBody,
  renderPullRequestTitle,
} from "./prompts/prBody.ts";

/**
 * The delivery records nothing to open a pull request for: no worktree or author thread, no
 * passing last receipt and review, or no one task approved for the commit they cover.
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

export type FactoryPullRequestError =
  | FactoryPullRequestBasisMissingError
  | FactoryPullRequestUnapprovedError
  | FactoryPullRequestNotOpenedError
  | FactoryPullRequestTextRefusedError
  | FactoryPullRequestPublishedUnapprovedError
  | FactoryWorktreeMissingError
  | FactoryBranchReadError
  | FactoryStoreError
  | WorkDomainError
  | GitManagerServiceError;

/**
 * The PR stage's work. Opens the delivery's pull request from its worktree through the stacked
 * Git action (`create_pr`) with the item's title and a body listing the accepted task and its
 * evidence, then links it to the author thread. Text that names an AI agent, model or provider or
 * carries attribution is never published. The action runs only while the worktree holds the
 * approved commit on a clean tree, and pushes that exact commit, so a commit made meanwhile never
 * reaches the remote. An open pull request for the branch is reported as it is, unchanged.
 */
export class FactoryPullRequest extends Context.Service<
  FactoryPullRequest,
  {
    readonly open: (
      delivery: StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "open_pr" }>,
    ) => Effect.Effect<FactoryOpenedPullRequest, FactoryPullRequestError>;
  }
>()("t3/fd/factory/FactoryPullRequest") {}

/** Factory reads its delivery's item and writes nothing to Work under this actor. */
const itemReader = (deliveryId: FactoryDeliveryId): WorkActor => ({
  id: `factory:${deliveryId}`,
  grants: [AuthWorkReadScope],
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

const make = Effect.gen(function* () {
  const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const work = yield* WorkService.WorkService;
  const tasks = yield* FactoryTaskStore.FactoryTaskStore;
  const context = yield* Effect.context<
    | FileSystem.FileSystem
    | GitVcsDriver.GitVcsDriver
    | Orchestrator.OrchestratorV2
    | ProjectService.ProjectService
  >();

  /** The approved task and what its approval rests on. */
  const basisOf = Effect.fn("FactoryPullRequest.basis")(function* (
    delivery: StoredFactoryDelivery,
  ) {
    const { deliveryId, state } = delivery;
    const receipt = state.receipts.at(-1);
    const review = acceptedReview(state);
    const stored = yield* tasks.listByDelivery(deliveryId);
    const [task] = stored;
    if (
      state.worktreePath === null ||
      state.threads.author === undefined ||
      receipt === undefined ||
      receiptFailed(receipt) ||
      review === undefined ||
      review.summary.blocking ||
      task === undefined ||
      stored.length > 1 ||
      task.lastReviewedSha !== receipt.headSha
    ) {
      return yield* new FactoryPullRequestBasisMissingError({ deliveryId });
    }
    return {
      worktreePath: state.worktreePath,
      author: state.threads.author,
      approvedSha: task.lastReviewedSha,
      task: { title: task.plan?.title, receipt, review },
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
      const basis = yield* basisOf(delivery);
      const item = yield* work.getItem(itemReader(deliveryId), { ref: delivery.itemRef });
      const { task } = basis;
      const prTitle = renderPullRequestTitle(item);
      const prBody = renderPullRequestBody({
        item,
        tasks: [
          {
            title: task.title ?? item.title,
            receipt: task.receipt,
            review: { round: task.review.round, summary: task.review.summary },
          },
        ],
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

  return FactoryPullRequest.of({ open });
});

export const layer = Layer.effect(FactoryPullRequest, make);
