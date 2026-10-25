import { PositiveInt, ThreadId } from "@t3tools/contracts";
import {
  FactoryDeliveryId,
  FactoryIntegrateReview,
  type FactoryPlanTask,
  FactoryReview as FactoryReviewSchema,
  FactoryReviewSummary,
  FactoryTaskId,
  type FactoryVerifyReceipt,
} from "@t3tools/contracts/fd/factory";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import type * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as FactorySettings from "./FactorySettings.ts";
import type { FactoryBranchReadError, FactoryWorktreeMissingError } from "./git/branchFacts.ts";
import { readWorktreeState } from "./git/worktreeState.ts";
import type { StoredFactoryDelivery } from "./persistence/FactoryDeliveryStore.ts";
import { failureFingerprint } from "./pipeline/fingerprint.ts";
import type {
  FactoryEffect,
  FactoryReceiptRefusal,
  FactoryReviewJudgment,
  FactoryReviewSource,
} from "./pipeline/state.ts";
import { integrateCriteria } from "./prompts/integrate.ts";
import { reviewDetails } from "./review/details.ts";
import { type FactoryEvidencePathError, validateReviewInWorktree } from "./review/evidencePaths.ts";
import { parseFencedReview } from "./review/fencedJson.ts";
import { findingsToFix } from "./review/validate.ts";
import * as FactoryEvidence from "./verify/FactoryEvidence.ts";

/**
 * The delivery records nothing to review: no worktree, task baseline or receipt, or for an
 * integrate review no approved task.
 */
export class FactoryReviewBasisMissingError extends Schema.TaggedError<FactoryReviewBasisMissingError>()(
  "FactoryReviewBasisMissingError",
  { deliveryId: FactoryDeliveryId },
) {
  override get message(): string {
    return `Factory delivery ${this.deliveryId} records nothing to review.`;
  }
}

export type FactoryReviewJudgeError =
  | FactoryReviewBasisMissingError
  | FactoryWorktreeMissingError
  | FactoryBranchReadError
  | FactoryEvidencePathError
  | FactorySettings.FactorySettingsStorageError
  | FactoryEvidence.FactoryEvidenceError;

/**
 * What the current review round judges: the worktree's commit that `receipt` verified, with the
 * task `baseline` its commits follow. A parent's integrate review judges its whole branch, from
 * where it started, by the criteria of every approved task.
 */
interface FactoryReviewBasis {
  readonly round: number;
  readonly worktreePath: string;
  readonly baseline: string;
  /** The passing receipt the review stage started from: the last one. */
  readonly receipt: FactoryVerifyReceipt;
  /** An integrate review's approved tasks, in plan order; null for a task's own review. */
  readonly tasks: ReadonlyArray<FactoryPlanTask> | null;
}

export const reviewBasis = (
  delivery: StoredFactoryDelivery,
): Effect.Effect<FactoryReviewBasis, FactoryReviewBasisMissingError> => {
  const {
    reviewRound: round,
    worktreePath,
    baseline,
    receipts,
    stage,
    planApproved,
    plan,
  } = delivery.state;
  const receipt = receipts.at(-1);
  // Approval froze the plan's tasks: they are the parent's tasks, its children's to deliver.
  const tasks = stage !== "integrate" ? null : planApproved ? (plan?.tasks ?? []) : [];
  return round < 1 ||
    worktreePath === null ||
    baseline === null ||
    receipt === undefined ||
    tasks?.length === 0
    ? Effect.fail(new FactoryReviewBasisMissingError({ deliveryId: delivery.deliveryId }))
    : Effect.succeed({ round, worktreePath, baseline, receipt, tasks });
};

/** `review-<n>.json`: the review as submitted and the server's judgment of it. */
const FactoryReviewEvidence = Schema.Struct({
  version: PositiveInt,
  deliveryId: FactoryDeliveryId,
  round: PositiveInt,
  source: Schema.Literals(["mcp", "fallback"]),
  threadId: ThreadId,
  /** The tree of `summary.headSha`, the commit the review judged. */
  tree: Schema.String,
  summary: FactoryReviewSummary,
  /** Why the review blocks the commit; empty when it passes. */
  blockingReasons: Schema.Array(Schema.Struct({ rule: Schema.String, description: Schema.String })),
  /** The widest shape, an integrate review's, so either kind of review is kept as submitted. */
  review: FactoryIntegrateReview,
  /**
   * The criteria an integrate review was judged by, numbered as it was asked to answer them: the
   * approved tasks', which the planner's `plan.json` may not show after an owner's edit. Absent
   * for a task's own review.
   */
  criteria: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ criterion: PositiveInt, taskId: FactoryTaskId, text: Schema.String }),
    ),
  ),
});
const REVIEW_EVIDENCE_VERSION = 1;
const encodeEvidence = Schema.encodeEffect(Schema.fromJsonString(FactoryReviewEvidence));
const decodeEvidence = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryReviewEvidence));

/** Reads the `review-<n>.json` an accepted review wrote, for the turns that act on it. */
export const readReviewEvidence = Effect.fn("FactoryReview.readEvidence")(function* (
  evidencePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(evidencePath).pipe(
    Effect.flatMap(decodeEvidence),
    Effect.mapError(
      (cause) =>
        new FactoryEvidence.FactoryEvidenceError({ operation: "read", path: evidencePath, cause }),
    ),
  );
});
// Every issue at once, like the fenced fallback: the reviewer gets one corrected retry.
const decodeReview = Schema.decodeUnknownResult(FactoryReviewSchema, { errors: "all" });
const decodeIntegrateReview = Schema.decodeUnknownResult(FactoryIntegrateReview, {
  errors: "all",
});

const MAX_PROBLEM = 1000;
const bounded = (text: string) =>
  text.length > MAX_PROBLEM ? `${text.slice(0, MAX_PROBLEM - 1)}…` : text;

const NO_FENCED_REVIEW =
  "Your final message has no fenced ```json block holding the review. End your final message with the review as JSON in one fenced ```json block.";

/** A submission before it is judged: a review to validate, or why there is none. */
type FactoryReviewCandidate =
  | { readonly type: "review"; readonly review: FactoryReviewSchema }
  | { readonly type: "invalid"; readonly problems: ReadonlyArray<string> };

/**
 * Judges review submissions for a delivery's current round (port of Looper's `validateReview`),
 * by either path: the `factory_submit_review` tool, or the fenced JSON of the reviewer run's
 * last assistant message. A worktree whose HEAD or tree moved from the verified receipt, or that
 * is not clean, refuses any review. Otherwise the review must decode and pass the validation
 * port, evidence paths included; a valid one, blocking or not, is written to the delivery's
 * evidence as `review-<n>.json` and accepted with the bounded details clients see, a blocking one
 * with its failure fingerprint (its findings to fix and the reviewed tree). An integrate review
 * of a parent's whole branch has an acceptance entry for each criterion of every approved task,
 * numbered across them in plan order (see `renderIntegratePrompt`): one out of that range is
 * invalid, and one missing blocks. Judging records nothing on the delivery; the engine does, from
 * the judgment.
 */
export class FactoryReview extends Context.Service<
  FactoryReview,
  {
    readonly judge: (
      delivery: StoredFactoryDelivery,
      submission: {
        readonly source: FactoryReviewSource;
        readonly threadId: ThreadId;
        readonly review: unknown;
      },
    ) => Effect.Effect<FactoryReviewJudgment, FactoryReviewJudgeError>;
    /** Judges the fenced review of the effect's run; a run without one is an invalid submission. */
    readonly judgeFallback: (
      delivery: StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "read_fallback_review" }>,
    ) => Effect.Effect<
      FactoryReviewJudgment,
      FactoryReviewJudgeError | ProjectionStore.ProjectionStoreV2Error
    >;
  }
>()("t3/fd/factory/FactoryReview") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const settings = yield* FactorySettings.FactorySettings;
  const evidence = yield* FactoryEvidence.FactoryEvidence;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | GitVcsDriver.GitVcsDriver
  >();

  /** How the worktree differs from the verified commit, clean; empty when it does not. */
  const codeChanges = Effect.fn("FactoryReview.codeChanges")(function* (basis: FactoryReviewBasis) {
    const current = yield* readWorktreeState(basis.worktreePath);
    const changes: Array<FactoryReceiptRefusal> = [];
    if (current.headSha !== basis.receipt.headSha || current.tree !== basis.receipt.tree) {
      changes.push("head_changed");
    }
    if (!current.clean) changes.push("tree_dirty");
    return changes;
  });

  const writeEvidence = Effect.fn("FactoryReview.writeEvidence")(function* (
    record: typeof FactoryReviewEvidence.Type,
  ) {
    const file = (yield* evidence.nextRun(record.deliveryId, "review")).file("json");
    yield* encodeEvidence(record).pipe(
      // `wx`: evidence is never overwritten, even by a concurrent judgment that picked the number.
      Effect.flatMap((json) => fileSystem.writeFileString(file, json, { flag: "wx" })),
      Effect.mapError(
        (cause) =>
          new FactoryEvidence.FactoryEvidenceError({ operation: "write", path: file, cause }),
      ),
    );
    return file;
  });

  const judgeCandidate = Effect.fn("FactoryReview.judge")(function* (
    delivery: StoredFactoryDelivery,
    basis: FactoryReviewBasis,
    source: FactoryReviewSource,
    threadId: ThreadId,
    candidate: FactoryReviewCandidate,
  ) {
    // First: no review of a commit other than the verified one counts, however well formed.
    const changes = yield* codeChanges(basis).pipe(Effect.provideContext(context));
    if (changes.length > 0) {
      return { type: "code_changed", changes } satisfies FactoryReviewJudgment;
    }
    if (candidate.type === "invalid") return candidate satisfies FactoryReviewJudgment;

    const { review } = candidate;
    const { blockingSeverities } = yield* settings.get(delivery.projectId);
    const criteria = basis.tasks === null ? null : integrateCriteria(basis.tasks);
    // A single item has no planned criteria; a planned child's count arrives with planning.
    const validation = yield* validateReviewInWorktree(basis.worktreePath, review, {
      criteriaCount: criteria?.length ?? null,
      blockingSeverities,
    }).pipe(Effect.provideContext(context));
    if (validation.status === "invalid") {
      return {
        type: "invalid",
        problems: validation.problems.map((problem) => problem.description),
      } satisfies FactoryReviewJudgment;
    }
    const blocking = validation.status === "blocking";
    const summary: FactoryReviewSummary = {
      headSha: basis.receipt.headSha,
      verdict: review.verdict,
      blocking,
      findings: validation.findings,
      reviewedAt: DateTime.formatIso(yield* DateTime.now),
    };
    const evidencePath = yield* writeEvidence({
      version: REVIEW_EVIDENCE_VERSION,
      deliveryId: delivery.deliveryId,
      round: basis.round,
      source,
      threadId,
      tree: basis.receipt.tree,
      summary,
      blockingReasons: validation.status === "blocking" ? validation.reasons : [],
      review,
      ...(criteria === null ? {} : { criteria }),
    });
    const details = reviewDetails(review, blockingSeverities);
    if (!blocking) {
      return {
        type: "accepted",
        review: { source, summary, evidencePath, details },
      } satisfies FactoryReviewJudgment;
    }
    const fingerprint = failureFingerprint({
      stage: "review",
      findings: findingsToFix(review, blockingSeverities),
      tree: basis.receipt.tree,
    });
    return {
      type: "accepted",
      review: { source, summary, evidencePath, fingerprint, details },
    } satisfies FactoryReviewJudgment;
  });

  const judge: FactoryReview["Service"]["judge"] = (delivery, submission) =>
    Effect.gen(function* () {
      const basis = yield* reviewBasis(delivery);
      const decoded = (basis.tasks === null ? decodeReview : decodeIntegrateReview)(
        submission.review,
      );
      return yield* judgeCandidate(
        delivery,
        basis,
        submission.source,
        submission.threadId,
        Result.isSuccess(decoded)
          ? { type: "review", review: decoded.success }
          : {
              type: "invalid",
              problems: [bounded(`The review is not valid: ${decoded.failure.message}`)],
            },
      );
    });

  /** The text of the run's last assistant message that has any; none when it has none. */
  const lastAssistantText = (
    effect: Extract<FactoryEffect, { readonly type: "read_fallback_review" }>,
  ) =>
    projections
      .getThreadRecords(effect.threadId, ["messages"], {
        messageRunIds: [effect.runId],
        messageRoles: ["assistant"],
      })
      .pipe(
        Effect.map(
          ({ messages }) =>
            messages.findLast((message) => message.text.trim().length > 0)?.text ?? null,
        ),
      );

  const judgeFallback: FactoryReview["Service"]["judgeFallback"] = (delivery, effect) =>
    Effect.gen(function* () {
      const basis = yield* reviewBasis(delivery);
      const text = yield* lastAssistantText(effect);
      const parsed =
        text === null
          ? ({ status: "none" } as const)
          : parseFencedReview(text, basis.tasks === null ? "review" : "integrate");
      const candidate: FactoryReviewCandidate =
        parsed.status === "decoded"
          ? { type: "review", review: parsed.review }
          : {
              type: "invalid",
              problems: [parsed.status === "none" ? NO_FENCED_REVIEW : parsed.message],
            };
      return yield* judgeCandidate(delivery, basis, "fallback", effect.threadId, candidate);
    });

  return FactoryReview.of({ judge, judgeFallback });
});

export const layer = Layer.effect(FactoryReview, make);
