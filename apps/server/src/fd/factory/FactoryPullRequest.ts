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
import type * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { type WorkActor, type WorkDomainError, WorkService } from "../work-management/index.ts";
import type { FactoryBranchReadError, FactoryWorktreeMissingError } from "./git/branchFacts.ts";
import { readWorktreeState } from "./git/worktreeState.ts";
import type { FactoryStoreError } from "./persistence/errors.ts";
import type { StoredFactoryDelivery } from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import { acceptedReview, receiptFailed } from "./pipeline/state.ts";
import type { FactoryEffect, FactoryOpenedPullRequest } from "./pipeline/state.ts";
import { renderPullRequestBody, renderPullRequestTitle } from "./prompts/prBody.ts";

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
  | FactoryWorktreeMissingError
  | FactoryBranchReadError
  | FactoryStoreError
  | WorkDomainError
  | GitManagerServiceError;

/**
 * The PR stage's work. Opens the delivery's pull request from its worktree through the stacked
 * Git action (`create_pr`, which pushes the branch first when needed) with the item's title and a
 * body listing the accepted task and its evidence, then links it to the author thread. Only the
 * approved commit, on a clean tree, is pushed; anything else fails before the action runs. An
 * open pull request for the branch is reported as it is, unchanged.
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

  const open: FactoryPullRequest["Service"]["open"] = Effect.fn("FactoryPullRequest.open")(
    function* (delivery, effect) {
      const { deliveryId, projectId } = delivery;
      const basis = yield* basisOf(delivery);
      // Record checked the worktree, but a commit or edit could land before this runs; the push
      // must carry only what was approved.
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

      const item = yield* work.getItem(itemReader(deliveryId), { ref: delivery.itemRef });
      const { task } = basis;
      // Derived from the effect, so progress and the thread link name this attempt.
      const actionId = `factory-pr:${deliveryId}:${effect.id}`;
      const result = yield* gitWorkflow.runStackedAction(
        {
          actionId,
          cwd: basis.worktreePath,
          action: "create_pr",
          threadId: basis.author,
          projectId,
          prTitle: renderPullRequestTitle(item),
          prBody: renderPullRequestBody({
            item,
            tasks: [
              {
                title: task.title ?? item.title,
                receipt: task.receipt,
                review: { round: task.review.round, summary: task.review.summary },
              },
            ],
          }),
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
      // logged and dropped, since the pull request is open either way.
      yield* linkCreatedPullRequest({
        threadId: basis.author,
        result,
        commandId: Effect.succeed(CommandId.make(`factory-pr-link:${deliveryId}:${effect.id}`)),
      }).pipe(Effect.provideContext(context));
      return opened;
    },
  );

  return FactoryPullRequest.of({ open });
});

export const layer = Layer.effect(FactoryPullRequest, make);
