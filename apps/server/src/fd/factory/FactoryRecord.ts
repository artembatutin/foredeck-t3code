import { IsoDateTime, NonNegativeInt, PositiveInt } from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryTaskId } from "@t3tools/contracts/fd/factory";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { taskOfChild } from "./FactoryChildren.ts";
import type { FactoryBranchReadError, FactoryWorktreeMissingError } from "./git/branchFacts.ts";
import { readWorktreeState } from "./git/worktreeState.ts";
import type { FactoryStoreError } from "./persistence/errors.ts";
import type { StoredFactoryDelivery } from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import { acceptedReview, receiptFailed } from "./pipeline/state.ts";
import type { FactoryRecordDifference, FactoryRecordOutcome } from "./pipeline/state.ts";
import * as FactoryEvidence from "./verify/FactoryEvidence.ts";

/**
 * The delivery records no commit to approve: no worktree, no passing last receipt with its
 * evidence, or no passing review accepted in the current round.
 */
export class FactoryRecordBasisMissingError extends Schema.TaggedError<FactoryRecordBasisMissingError>()(
  "FactoryRecordBasisMissingError",
  { deliveryId: FactoryDeliveryId },
) {
  override get message(): string {
    return `Factory delivery ${this.deliveryId} records no verified, reviewed commit to approve.`;
  }
}

/**
 * Record approves the one task of a delivery, or a child's task in its parent; this delivery has
 * none, or several.
 */
export class FactoryRecordTaskError extends Schema.TaggedError<FactoryRecordTaskError>()(
  "FactoryRecordTaskError",
  { deliveryId: FactoryDeliveryId, tasks: NonNegativeInt },
) {
  override get message(): string {
    return `Factory delivery ${this.deliveryId} has ${this.tasks} tasks; record approves a delivery with one.`;
  }
}

export type FactoryRecordError =
  | FactoryRecordBasisMissingError
  | FactoryRecordTaskError
  | FactoryWorktreeMissingError
  | FactoryBranchReadError
  | FactoryEvidence.FactoryEvidenceError
  | FactoryStoreError;

/**
 * `approval-<taskId>.json`: the commit the task was approved for and the evidence behind it. A
 * parent's `approval.json` names no task: it approves the whole branch, by its integrate verify
 * and review.
 */
const FactoryApprovalEvidence = Schema.Struct({
  version: PositiveInt,
  deliveryId: FactoryDeliveryId,
  taskId: Schema.optionalKey(FactoryTaskId),
  headSha: Schema.String,
  tree: Schema.String,
  /** The passing receipt's `verify-<n>.json`. */
  receiptPath: Schema.String,
  /** The accepted review's `review-<n>.json`. */
  reviewPath: Schema.String,
  approvedAt: IsoDateTime,
});
const APPROVAL_EVIDENCE_VERSION = 1;
const ApprovalJson = Schema.fromJsonString(FactoryApprovalEvidence);
const encodeEvidence = Schema.encodeEffect(ApprovalJson);
const decodeEvidence = Schema.decodeEffect(ApprovalJson);

/**
 * The parent's `approval.json`, which its record wrote for the commit its whole branch was
 * approved for; none before any was written. One that cannot be read or decoded fails rather than
 * count as none.
 */
export const readBranchApproval = Effect.fn("FactoryRecord.readBranchApproval")(function* (
  deliveryId: FactoryDeliveryId,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const evidence = yield* FactoryEvidence.FactoryEvidence;
  const file = yield* evidence.approvalFile(deliveryId, null);
  const failed = (cause: unknown) =>
    new FactoryEvidence.FactoryEvidenceError({ operation: "read", path: file, cause });
  if (!(yield* fileSystem.exists(file).pipe(Effect.mapError(failed)))) return Option.none();
  return Option.some(
    yield* fileSystem
      .readFileString(file)
      .pipe(Effect.flatMap(decodeEvidence), Effect.mapError(failed)),
  );
});

/**
 * The record gate, which passes without the owner. It approves the delivery's task for the
 * worktree's commit only when HEAD and its tree are the ones the last receipt verified, HEAD is
 * the commit the round's accepted review judged, and the worktree is clean. An approval writes
 * `approval-<taskId>.json` to the delivery's evidence, then sets the task's `lastReviewedSha`; a
 * later approval of the task replaces both. A child's task is its parent's task it was created
 * for, whose `lastReviewedSha` the parent's next child starts from. A parent records its whole
 * branch after its integrate verify and review: it writes `approval.json`, which its pull request
 * reads, and leaves the approvals its children recorded on its tasks as they are. Any difference
 * writes nothing: the outcome names the expected and actual commit and what differed, and the
 * engine blocks on it.
 */
export class FactoryRecord extends Context.Service<
  FactoryRecord,
  {
    readonly record: (
      delivery: StoredFactoryDelivery,
    ) => Effect.Effect<FactoryRecordOutcome, FactoryRecordError>;
  }
>()("t3/fd/factory/FactoryRecord") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const evidence = yield* FactoryEvidence.FactoryEvidence;
  const tasks = yield* FactoryTaskStore.FactoryTaskStore;
  const stageRuns = yield* FactoryStageRunStore.FactoryStageRunStore;
  const gitContext = yield* Effect.context<FileSystem.FileSystem | GitVcsDriver.GitVcsDriver>();

  /** What the approval covers: the verified commit, its receipt's and review's evidence. */
  const basisOf = Effect.fn("FactoryRecord.basis")(function* (delivery: StoredFactoryDelivery) {
    const { deliveryId, state } = delivery;
    const receipt = state.receipts.at(-1);
    const review = acceptedReview(state);
    // The receipt's JSON is on the verify attempt that recorded it, the delivery's last one.
    const verify = (yield* stageRuns.listByDelivery(deliveryId)).findLast(
      (run) => run.stage === "verify",
    );
    if (
      state.worktreePath === null ||
      receipt === undefined ||
      receiptFailed(receipt) ||
      review === undefined ||
      review.summary.blocking ||
      verify?.outcome !== "passed" ||
      verify.evidencePath === null
    ) {
      return yield* new FactoryRecordBasisMissingError({ deliveryId });
    }
    return {
      worktreePath: state.worktreePath,
      receipt,
      receiptPath: verify.evidencePath,
      review,
    };
  });

  /** The task the delivery's record approves: its one task, or a child's in its parent. */
  const taskOf = Effect.fn("FactoryRecord.task")(function* (delivery: StoredFactoryDelivery) {
    const { deliveryId, parentId } = delivery;
    if (parentId !== null) {
      const task = taskOfChild(parentId, yield* tasks.listByDelivery(parentId), deliveryId);
      return task ?? (yield* new FactoryRecordTaskError({ deliveryId, tasks: 0 }));
    }
    const stored = yield* tasks.listByDelivery(deliveryId);
    const [task] = stored;
    if (task === undefined || stored.length > 1) {
      return yield* new FactoryRecordTaskError({ deliveryId, tasks: stored.length });
    }
    return task;
  });

  const record: FactoryRecord["Service"]["record"] = Effect.fn("FactoryRecord.record")(
    function* (delivery) {
      const { deliveryId } = delivery;
      const basis = yield* basisOf(delivery);
      // A parent's tasks are its children's; it approves its branch, not one of them.
      const task = delivery.state.kind === "parent" ? null : yield* taskOf(delivery);

      const current = yield* readWorktreeState(basis.worktreePath).pipe(
        Effect.provideContext(gitContext),
      );
      const { receipt } = basis;
      const differences: Array<FactoryRecordDifference> = [];
      if (current.headSha !== receipt.headSha) differences.push("head_changed");
      if (current.tree !== receipt.tree) differences.push("tree_changed");
      if (current.headSha !== basis.review.summary.headSha) differences.push("not_reviewed");
      if (!current.clean) differences.push("tree_dirty");
      if (differences.length > 0) {
        return {
          type: "mismatch",
          expected: { headSha: receipt.headSha, tree: receipt.tree },
          actual: { headSha: current.headSha, tree: current.tree, clean: current.clean },
          differences,
        } satisfies FactoryRecordOutcome;
      }

      const file = yield* evidence.approvalFile(deliveryId, task?.taskId ?? null);
      yield* encodeEvidence({
        version: APPROVAL_EVIDENCE_VERSION,
        deliveryId,
        ...(task === null ? {} : { taskId: task.taskId }),
        headSha: current.headSha,
        tree: current.tree,
        receiptPath: basis.receiptPath,
        reviewPath: basis.review.evidencePath,
        approvedAt: DateTime.formatIso(yield* DateTime.now),
      }).pipe(
        Effect.flatMap((json) => fileSystem.writeFileString(file, json)),
        Effect.mapError(
          (cause) =>
            new FactoryEvidence.FactoryEvidenceError({ operation: "write", path: file, cause }),
        ),
      );
      if (task === null) {
        return { type: "approved", evidencePath: file } satisfies FactoryRecordOutcome;
      }
      const updated = yield* tasks.setLastReviewedSha({
        deliveryId: task.deliveryId,
        taskId: task.taskId,
        sha: current.headSha,
      });
      if (Option.isNone(updated)) {
        return yield* new FactoryRecordTaskError({ deliveryId, tasks: 0 });
      }
      return { type: "approved", evidencePath: file } satisfies FactoryRecordOutcome;
    },
  );

  return FactoryRecord.of({ record });
});

export const layer = Layer.effect(FactoryRecord, make);
