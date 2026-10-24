import { AuthWorkReadScope, ThreadId } from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  FactoryDeliveryStatus,
  FactoryTaskId,
} from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import type * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import {
  type WorkActor,
  type WorkDomainError,
  WorkService,
  workBranchName,
} from "../work-management/index.ts";
import * as FactoryReview from "./FactoryReview.ts";
import * as FactorySettings from "./FactorySettings.ts";
import { FactoryProjectMissingError } from "./FactoryThreadEffects.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import { type FactoryBranchUnavailableError, freshBranchName } from "./git/freshBranch.ts";
import { FactoryStoreError } from "./persistence/errors.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import {
  acceptedReview,
  type FactoryAcceptedReview,
  type FactoryEvent,
  isTerminal,
  queuedDeliveryState,
  runsStages,
} from "./pipeline/state.ts";

const FactoryReceiptRefusal = Schema.Literals(["head_changed", "tree_dirty"]);

/** A review submission refused before it was judged: nothing was recorded. */
export class FactoryReviewRefusedError extends Schema.TaggedError<FactoryReviewRefusedError>()(
  "FactoryReviewRefusedError",
  {
    threadId: ThreadId,
    /**
     * `not_reviewer`: no active delivery has this thread as its reviewer. `review_not_active`:
     * its delivery is not running the review stage, or not this thread's run. `already_accepted`:
     * this round's review is already accepted.
     */
    reason: Schema.Literals(["not_reviewer", "review_not_active", "already_accepted"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_reviewer":
        return `Thread ${this.threadId} is not the reviewer of an active Factory delivery.`;
      case "review_not_active":
        return `The Factory review of thread ${this.threadId} is not waiting for a submission.`;
      case "already_accepted":
        return `Factory already accepted this round's review from thread ${this.threadId}.`;
    }
  }
}

/** The submitted review is invalid. The first is the reviewer's to correct; a second blocks. */
export class FactoryReviewInvalidError extends Schema.TaggedError<FactoryReviewInvalidError>()(
  "FactoryReviewInvalidError",
  {
    deliveryId: FactoryDeliveryId,
    /** Bounded descriptions of what to correct. */
    problems: Schema.Array(Schema.String),
    /** The delivery blocked on this submission: no further one is taken. */
    blocked: Schema.Boolean,
  },
) {
  override get message(): string {
    const problems = this.problems.join(" ");
    return this.blocked
      ? `The review is invalid again, so Factory blocked the delivery: ${problems}`
      : `The review is invalid. Correct these problems and submit the whole review again: ${problems}`;
  }
}

/** The worktree no longer holds the verified commit, clean; the delivery blocked. */
export class FactoryReviewCodeChangedError extends Schema.TaggedError<FactoryReviewCodeChangedError>()(
  "FactoryReviewCodeChangedError",
  { deliveryId: FactoryDeliveryId, changes: Schema.Array(FactoryReceiptRefusal) },
) {
  override get message(): string {
    return `The code changed during review (${this.changes.join(", ")}), so Factory blocked the delivery.`;
  }
}

/** Why a review submission was not accepted. Refusals and judging failures record nothing. */
type FactorySubmitReviewError =
  | FactoryReviewRefusedError
  | FactoryReviewInvalidError
  | FactoryReviewCodeChangedError
  | FactoryReview.FactoryReviewJudgeError
  | FactoryStoreError;

/** No delivery id could be minted; nothing was written. */
export class FactoryDeliveryIdError extends Schema.TaggedError<FactoryDeliveryIdError>()(
  "FactoryDeliveryIdError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Factory could not mint a delivery id.";
  }
}

/** No delivery has this id. */
export class FactoryDeliveryNotFoundError extends Schema.TaggedError<FactoryDeliveryNotFoundError>()(
  "FactoryDeliveryNotFoundError",
  { deliveryId: FactoryDeliveryId },
) {
  override get message(): string {
    return `Factory delivery ${this.deliveryId} does not exist.`;
  }
}

/** Only a running delivery can stop after its step; nothing changed. */
export class FactoryStopRefusedError extends Schema.TaggedError<FactoryStopRefusedError>()(
  "FactoryStopRefusedError",
  { deliveryId: FactoryDeliveryId, status: FactoryDeliveryStatus },
) {
  override get message(): string {
    return `Factory delivery ${this.deliveryId} is ${this.status}; only a running delivery can stop after its step.`;
  }
}

/** A done or cancelled delivery cannot be cancelled; nothing changed. */
export class FactoryCancelRefusedError extends Schema.TaggedError<FactoryCancelRefusedError>()(
  "FactoryCancelRefusedError",
  { deliveryId: FactoryDeliveryId, status: FactoryDeliveryStatus },
) {
  override get message(): string {
    return `Factory delivery ${this.deliveryId} is already ${this.status}, so it cannot be cancelled.`;
  }
}

/** Why a start was refused. Every refusal comes before the delivery's row is written. */
type FactoryStartError =
  | WorkDomainError
  | FactorySettings.FactorySettingsStorageError
  | FactorySettings.FactoryVerifyCommandMissingError
  | ProjectStore.ProjectStoreV2Error
  | FactoryProjectMissingError
  | ThreadLaunch.ThreadLaunchBaseRefError
  | FactoryBranchUnavailableError
  | FactoryDeliveryIdError
  | FactoryDeliveryStore.FactoryDeliveryActive
  | FactoryStoreError;

/** Factory's deliveries for transports, MCP tools and scheduled tasks. */
export class FactoryService extends Context.Service<
  FactoryService,
  {
    /**
     * Starts a delivery of a single Work item. The author works on a new worktree of the branch
     * Work's thread starts would name, created from the canonical checkout's HEAD; when an earlier
     * delivery of the item or any ref already holds that name, the first free one of `-2`, `-3`,
     * … after it (see `freshBranchName`), so an earlier delivery keeps its work. The delivery
     * is stored queued with the item as its one task, then started, so its author launch is
     * queued once the running state is stored. Refused, with nothing written: an item Work
     * cannot read, a project without a verify command or not on this environment, a base the
     * worktree cannot start from, or an item that already has a delivery that is not done or
     * cancelled.
     */
    readonly start: (input: {
      readonly itemRef: WorkItemRef;
    }) => Effect.Effect<FactoryDeliveryStore.StoredFactoryDelivery, FactoryStartError>;
    readonly get: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<
      Option.Option<FactoryDeliveryStore.StoredFactoryDelivery>,
      FactoryStoreError
    >;
    /**
     * Stops a running delivery after its current step. It is stored `stopping`, and the turn or
     * effect under way is not interrupted: it finishes the work of its stage and becomes
     * `stopped` where it would begin the next one, with that stage as its checkpoint (see
     * `advance`). Stopping already, nothing changes. Refused, with nothing changed, in any other
     * status.
     */
    readonly stop: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<
      FactoryDeliveryStore.StoredFactoryDelivery,
      FactoryStopRefusedError | FactoryDeliveryNotFoundError | FactoryStoreError
    >;
    /**
     * Cancels a delivery that is not done or cancelled. It ends at once and issues nothing more,
     * and the run its agent works on is interrupted; the worktree, branch and commits stay. No
     * later run end, effect result or review submission changes it, and its item can be
     * delivered again. Refused, with nothing changed, once done or cancelled.
     */
    readonly cancel: (
      deliveryId: FactoryDeliveryId,
    ) => Effect.Effect<
      FactoryDeliveryStore.StoredFactoryDelivery,
      FactoryCancelRefusedError | FactoryDeliveryNotFoundError | FactoryStoreError
    >;
    /**
     * A reviewer's `factory_submit_review`. Taken only from the thread an active delivery
     * registered as its reviewer, while the review stage awaits that thread's run and before
     * the round has an accepted review; any other call is refused with nothing changed. The
     * review is judged (see `FactoryReview`) and the judgment recorded on the delivery: an
     * accepted review is acted on once the reviewer's run completes, an invalid one fails with
     * its problems (the second in a round blocks the delivery), and changed code blocks it.
     */
    readonly submitReview: (input: {
      readonly threadId: ThreadId;
      readonly review: unknown;
    }) => Effect.Effect<
      { readonly deliveryId: FactoryDeliveryId; readonly review: FactoryAcceptedReview },
      FactorySubmitReviewError
    >;
  }
>()("t3/fd/factory/FactoryService") {}

/** Factory reads the item to start and writes nothing to Work under this actor. */
const itemReader: WorkActor = { id: "factory", grants: [AuthWorkReadScope], label: "Factory" };

/** A single item is its delivery's one task; its approval is `approval-item.json`. */
const SINGLE_ITEM_TASK = FactoryTaskId.make("item");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const work = yield* WorkService.WorkService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const settings = yield* FactorySettings.FactorySettings;
  const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
  const tasks = yield* FactoryTaskStore.FactoryTaskStore;
  const worker = yield* FactoryWorker.FactoryWorker;
  const reviews = yield* FactoryReview.FactoryReview;
  const crypto = yield* Crypto.Crypto;
  const gitContext = yield* Effect.context<GitVcsDriver.GitVcsDriver>();

  const start: FactoryService["Service"]["start"] = Effect.fn("FactoryService.start")(
    function* (input) {
      // The active-item index keys on Work's spelling, so another spelling of the item cannot
      // hold a second delivery.
      const itemRef = yield* work.canonicalRef(input.itemRef);
      const { projectId } = (yield* work.resolveSource(itemRef.sourceId)).stored;
      const { limits } = yield* settings.requireDeliverySettings(projectId);
      const project = Option.getOrUndefined(yield* projects.get(projectId));
      if (project === undefined) return yield* new FactoryProjectMissingError({ projectId });
      const item = yield* work.getItem(itemReader, { ref: itemRef });

      // A new delivery starts over: a cancelled or finished one keeps its branch and worktree.
      const earlier = yield* deliveries.listByItem(itemRef);
      const branch = yield* freshBranchName({
        cwd: project.workspaceRoot,
        base: workBranchName(item),
        taken: earlier.map(({ state }) => state.branch),
      }).pipe(Effect.provideContext(gitContext));
      // The workspace the author's launch asks for (see `agentStage`), checked before any row
      // exists: the launch itself would accept a base with no commit and fail inside the thread.
      const workspace = { type: "worktree", baseRef: "HEAD", branch } as const;
      yield* launches.checkWorktreeBase({ projectId, workspaceStrategy: workspace });

      const deliveryId = FactoryDeliveryId.make(
        yield* crypto
          .randomUUIDv4()
          .pipe(Effect.mapError((cause) => new FactoryDeliveryIdError({ cause }))),
      );
      // The insert refuses an item with an active delivery inside its transaction, so of two
      // concurrent starts only one is stored. The item's task row is written in the same
      // transaction: a refused start adds none, and no stored delivery lacks it.
      const queued = yield* deliveries
        .insert({
          deliveryId,
          projectId,
          itemRef,
          // The round limits stay those the delivery started with.
          state: queuedDeliveryState({
            branch: workspace.branch,
            baseRef: workspace.baseRef,
            limits: { maxFixRounds: limits.maxFixRounds, maxReviewRounds: limits.maxReviewRounds },
          }),
        })
        .pipe(
          Effect.tap(() => tasks.insert({ deliveryId, taskId: SINGLE_ITEM_TASK })),
          sql.withTransaction,
          Effect.catchTags({
            SqlError: (cause) =>
              Effect.fail(new FactoryStoreError({ operation: "service.start", cause })),
          }),
        );
      // A storage failure here leaves the delivery queued with nothing launched.
      const started = yield* worker.step(deliveryId, { type: "start" });
      return Option.getOrElse(started, () => queued);
    },
  );

  const submitReview: FactoryService["Service"]["submitReview"] = Effect.fn(
    "FactoryService.submitReview",
  )(function* ({ threadId, review }) {
    const refuse = (reason: FactoryReviewRefusedError["reason"]) =>
      Effect.fail(new FactoryReviewRefusedError({ threadId, reason }));
    // A reviewer thread belongs to the one delivery that launched it.
    const owner = (yield* deliveries.listActive()).find(
      ({ state }) => state.threads.reviewer === threadId,
    );
    if (owner === undefined) return yield* refuse("not_reviewer");
    const { deliveryId } = owner;

    // Judged and recorded under the delivery's lock, so the run cannot end in between: the
    // engine then takes the judgment exactly when these checks pass.
    const stepped = yield* worker.stepWith(deliveryId, (current) =>
      Effect.gen(function* () {
        const { state } = current;
        const { awaiting } = state;
        if (state.threads.reviewer !== threadId) return yield* refuse("not_reviewer");
        // A stopping delivery still finishes its review round.
        if (
          !runsStages(state) ||
          state.stage !== "review" ||
          awaiting?.type !== "run" ||
          awaiting.threadId !== threadId
        ) {
          return yield* refuse("review_not_active");
        }
        if (acceptedReview(state) !== undefined) return yield* refuse("already_accepted");
        const judgment = yield* reviews.judge(current, { source: "mcp", threadId, review });
        const event: FactoryEvent = {
          type: "review.submitted",
          round: state.reviewRound,
          threadId,
          runId: awaiting.runId,
          judgment,
        };
        return { event, value: { judgment, round: state.reviewRound } };
      }),
    );
    // Deliveries are never deleted, so this one is still stored.
    if (Option.isNone(stepped)) return yield* refuse("not_reviewer");
    const { delivery, value } = stepped.value;
    const { judgment } = value;
    switch (judgment.type) {
      case "accepted":
        return { deliveryId, review: { ...judgment.review, round: value.round } };
      case "invalid":
        return yield* new FactoryReviewInvalidError({
          deliveryId,
          problems: judgment.problems,
          blocked: delivery.state.status === "blocked",
        });
      case "code_changed":
        return yield* new FactoryReviewCodeChangedError({ deliveryId, changes: judgment.changes });
    }
  });

  // Both decide and step under the delivery's lock, so no run end or effect result lands between
  // the status they check and the step.
  const stop: FactoryService["Service"]["stop"] = Effect.fn("FactoryService.stop")(
    function* (deliveryId) {
      const stepped = yield* worker.stepWith(deliveryId, ({ state }) =>
        runsStages(state)
          ? Effect.succeed({ event: { type: "stop" } as const, value: undefined })
          : Effect.fail(new FactoryStopRefusedError({ deliveryId, status: state.status })),
      );
      if (Option.isNone(stepped)) return yield* new FactoryDeliveryNotFoundError({ deliveryId });
      return stepped.value.delivery;
    },
  );

  const cancel: FactoryService["Service"]["cancel"] = Effect.fn("FactoryService.cancel")(
    function* (deliveryId) {
      const stepped = yield* worker.stepWith(deliveryId, ({ state }) =>
        isTerminal(state)
          ? Effect.fail(new FactoryCancelRefusedError({ deliveryId, status: state.status }))
          : Effect.succeed({ event: { type: "cancel" } as const, value: undefined }),
      );
      if (Option.isNone(stepped)) return yield* new FactoryDeliveryNotFoundError({ deliveryId });
      return stepped.value.delivery;
    },
  );

  return FactoryService.of({ start, get: deliveries.get, stop, cancel, submitReview });
});

export const layer = Layer.effect(FactoryService, make);
