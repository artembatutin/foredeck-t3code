import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../../baseSchemas.ts";
import { ModelSelection } from "../../modelSelection.ts";
import { WorkItemRef, WorkItemTitle } from "../work-management/index.ts";

/**
 * Factory contracts. Like Work's, nothing here imports `environment.ts`, `project.ts` or
 * `orchestrationV2.ts`: core contract modules import fd entries (as `environment.ts` imports
 * Work's), so a reverse import can close an ESM cycle that fails at module load.
 * `imports.test.ts` locks that. Factory reaches Work only through its entry; Work never imports
 * Factory.
 */

/** A short id that is also safe as an evidence file or folder name. */
const FactorySlug = Schema.String.check(
  Schema.isBetweenLength(1, 64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
);

/** Server-minted; also names the delivery's evidence folder under T3 home. */
export const FactoryDeliveryId = FactorySlug.pipe(Schema.brand("FactoryDeliveryId"));
export type FactoryDeliveryId = typeof FactoryDeliveryId.Type;

/** A task's id, unique within its delivery; names the task's approval evidence. */
export const FactoryTaskId = FactorySlug.pipe(Schema.brand("FactoryTaskId"));
export type FactoryTaskId = typeof FactoryTaskId.Type;

const FACTORY_DELIVERY_STATUSES = [
  "queued",
  "running",
  "waiting",
  "blocked",
  "stopping",
  "stopped",
  "approved",
  "pr_open",
  "done",
  "cancelled",
] as const;
const FACTORY_STAGE_NAMES = [
  "plan",
  "approve_plan",
  "author",
  "verify",
  "review",
  "repair",
  "record",
  "integrate",
  "pr",
  "follow_through",
] as const;
const FACTORY_STAGE_KINDS = ["agent", "command", "gate", "integrate", "pr"] as const;

export const FactoryDeliveryStatus = Schema.Literals(FACTORY_DELIVERY_STATUSES);
export type FactoryDeliveryStatus = typeof FactoryDeliveryStatus.Type;

export const FactoryStageName = Schema.Literals(FACTORY_STAGE_NAMES);
export type FactoryStageName = typeof FactoryStageName.Type;

export const FactoryStageKind = Schema.Literals(FACTORY_STAGE_KINDS);
export type FactoryStageKind = typeof FactoryStageKind.Type;

/** The roles a delivery runs threads for. */
export const FactoryRole = Schema.Literals(["planner", "author", "reviewer"]);
export type FactoryRole = typeof FactoryRole.Type;

/** Nonblank prose an agent or the owner writes, bounded so plans and reviews stay small. */
const FactoryText = (maxLength: number) =>
  TrimmedNonEmptyString.check(Schema.isMaxLength(maxLength));

/**
 * A normalized repository-relative POSIX path. Shape only: the server still resolves it inside
 * the worktree (realpath, no escape) before trusting it as evidence.
 */
const FactoryRepoPath = Schema.String.check(
  Schema.isBetweenLength(1, 1024),
  Schema.makeFilter((value: string) => {
    if (/[\\\p{Cc}]/u.test(value)) return "Use forward slashes and no control characters.";
    if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
      return "Use a path relative to the repository root.";
    }
    for (const segment of value.split("/")) {
      if (segment === "" || segment === "." || segment === "..") {
        return "Use a normalized path without empty, '.' or '..' segments.";
      }
      if (segment.toLowerCase() === ".git") return "Choose a path outside Git metadata.";
    }
    return true;
  }),
);
const FactoryRepoPaths = Schema.Array(FactoryRepoPath).check(Schema.isMaxLength(100));

/** A command the server runs in the worktree: an executable and its arguments, not a shell line. */
export const FactoryCommand = Schema.Struct({
  executable: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  args: Schema.Array(Schema.String.check(Schema.isMaxLength(8192))).check(Schema.isMaxLength(256)),
});
export type FactoryCommand = typeof FactoryCommand.Type;

export const FactoryPlanTaskKind = Schema.Literals([
  "feature",
  "fix",
  "refactor",
  "tests",
  "migration",
  "docs",
  "chore",
]);
export type FactoryPlanTaskKind = typeof FactoryPlanTaskKind.Type;

export const FactoryTaskRisk = Schema.Literals(["normal", "high"]);
export type FactoryTaskRisk = typeof FactoryTaskRisk.Type;

const FactoryTestPlanEntry = Schema.Struct({
  /** 1-based position of the acceptance criterion this check proves. */
  criterion: PositiveInt,
  check: FactoryText(2000),
  paths: FactoryRepoPaths,
});

/**
 * One planned task (port of a Looper `plan.json` task). Shape only: unique ids, a test plan entry
 * per criterion and ids unused in the delivery are the server's plan validation.
 */
export const FactoryPlanTask = Schema.Struct({
  id: FactoryTaskId,
  /** Becomes the child Work item's title on approval. */
  title: WorkItemTitle,
  kind: FactoryPlanTaskKind,
  summary: FactoryText(8000),
  acceptance: Schema.Array(FactoryText(2000)).check(Schema.isBetweenLength(1, 50)),
  testPlan: Schema.Array(FactoryTestPlanEntry).check(Schema.isMaxLength(50)),
  likelyPaths: FactoryRepoPaths,
  risk: FactoryTaskRisk,
});
export type FactoryPlanTask = typeof FactoryPlanTask.Type;

/** A planner's submission. No tasks ends planning with the note, never an implied success. */
export const FactoryPlan = Schema.Struct({
  tasks: Schema.Array(FactoryPlanTask).check(Schema.isMaxLength(50)),
  note: Schema.optionalKey(FactoryText(8000)),
});
export type FactoryPlan = typeof FactoryPlan.Type;

export const FactoryReviewVerdict = Schema.Literals(["pass", "changes-required"]);
export type FactoryReviewVerdict = typeof FactoryReviewVerdict.Type;

export const FactoryFindingSeverity = Schema.Literals(["high", "medium", "low"]);
export type FactoryFindingSeverity = typeof FactoryFindingSeverity.Type;

export const FactoryAcceptanceStatus = Schema.Literals(["verified", "failed", "untested"]);
export type FactoryAcceptanceStatus = typeof FactoryAcceptanceStatus.Type;

const FactoryReviewFinding = Schema.Struct({
  /** Stable across rounds, so a later round can say which findings it rechecked. */
  id: FactorySlug,
  severity: FactoryFindingSeverity,
  required: Schema.Boolean,
  file: FactoryRepoPath,
  /** Null when the finding concerns the whole file. */
  line: Schema.NullOr(PositiveInt),
  /** The cause and its consequence, not only the symptom. */
  detail: FactoryText(4000),
});

const FactoryAcceptanceCheck = Schema.Struct({
  criterion: PositiveInt,
  status: FactoryAcceptanceStatus,
  evidence: FactoryText(4000),
  paths: FactoryRepoPaths,
});

/**
 * A reviewer's submission (port of Looper's `findings.json`, keeping its `missing_evidence` key).
 * Shape only: the server decides whether it blocks (blocking severities, criteria not verified,
 * missing evidence).
 */
export const FactoryReview = Schema.Struct({
  verdict: FactoryReviewVerdict,
  findings: Schema.Array(FactoryReviewFinding).check(Schema.isMaxLength(100)),
  acceptance: Schema.Array(FactoryAcceptanceCheck).check(Schema.isMaxLength(50)),
  missing_evidence: Schema.Array(FactoryText(2000)).check(Schema.isMaxLength(50)),
});
export type FactoryReview = typeof FactoryReview.Type;

const RoleProfile = Schema.NullOr(ModelSelection).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
);

const RoundLimit = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 }));

/**
 * A project's Factory settings, stored in Factory's own table. Absent keys decode to the
 * defaults, so a row saved by an older server keeps loading. A delivery refuses to start while
 * `verifyCommand` is null.
 */
export const FactoryProjectSettings = Schema.Struct({
  verifyCommand: Schema.NullOr(FactoryCommand).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Runs before the verify command when set. */
  setupCommand: Schema.NullOr(FactoryCommand).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** The model for each role's threads; null uses the default (the reviewer's is the author's). */
  roles: Schema.Struct({
    planner: RoleProfile,
    author: RoleProfile,
    reviewer: RoleProfile,
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  limits: Schema.Struct({
    maxFixRounds: RoundLimit.pipe(Schema.withDecodingDefault(Effect.succeed(2))),
    maxReviewRounds: RoundLimit.pipe(Schema.withDecodingDefault(Effect.succeed(2))),
    verifyTimeoutMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1440 })).pipe(
      Schema.withDecodingDefault(Effect.succeed(30)),
    ),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /** Review findings at these severities block the delivery. */
  blockingSeverities: Schema.Array(FactoryFindingSeverity).pipe(
    Schema.withDecodingDefault(Effect.succeed(["high"] as const)),
  ),
  /** The effort option value high-risk tasks and later rounds use where the provider offers it. */
  highRiskEffort: TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
    Schema.withDecodingDefault(Effect.succeed("xhigh")),
  ),
  pipelineId: FactorySlug.pipe(Schema.withDecodingDefault(Effect.succeed("standard"))),
});
export type FactoryProjectSettings = typeof FactoryProjectSettings.Type;

/** A full Git object id (SHA-1 or SHA-256). */
const FactoryGitObjectId = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/));

const verifyReceiptSummaryFields = {
  headSha: FactoryGitObjectId,
  tree: FactoryGitObjectId,
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime,
  /** Null when the process ended without an exit code (killed on timeout or by a signal). */
  code: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
  durationMs: NonNegativeInt,
};

/** What clients see of a verify run: never the log, its path or the command line. */
export const FactoryVerifyReceiptSummary = Schema.Struct(verifyReceiptSummaryFields);
export type FactoryVerifyReceiptSummary = typeof FactoryVerifyReceiptSummary.Type;

/**
 * The server's record of one verify command run against one commit and tree (port of Looper's
 * receipt). Kept in the delivery's evidence folder under T3 home.
 */
export const FactoryVerifyReceipt = Schema.Struct({
  version: PositiveInt,
  ...verifyReceiptSummaryFields,
  command: FactoryCommand,
  settingsHash: TrimmedNonEmptyString,
  platform: TrimmedNonEmptyString,
  logPath: TrimmedNonEmptyString,
  outputHash: TrimmedNonEmptyString,
});
export type FactoryVerifyReceipt = typeof FactoryVerifyReceipt.Type;

/** What clients see of a review round: the verdict and counts, not the findings' text. */
export const FactoryReviewSummary = Schema.Struct({
  headSha: FactoryGitObjectId,
  verdict: FactoryReviewVerdict,
  blocking: Schema.Boolean,
  findings: Schema.Struct({ high: NonNegativeInt, medium: NonNegativeInt, low: NonNegativeInt }),
  reviewedAt: IsoDateTime,
});
export type FactoryReviewSummary = typeof FactoryReviewSummary.Type;

/**
 * A literal set a newer server may grow: a value this build does not know decodes as
 * `fallback` instead of failing the payload around it. Encoding is unchanged.
 */
const literalsOr = <const L extends ReadonlyArray<string>>(literals: L, fallback: L[number]) => {
  const known = Schema.is(Schema.Literals(literals));
  return Schema.String.pipe(
    Schema.decodeTo(
      Schema.Literals(literals),
      SchemaTransformation.transform<L[number], string>({
        decode: (value) => (known(value) ? value : fallback),
        encode: (value) => value,
      }),
    ),
  );
};

const FactoryDeliveryStage = Schema.Struct({
  name: literalsOr([...FACTORY_STAGE_NAMES, "unknown"], "unknown"),
  kind: literalsOr([...FACTORY_STAGE_KINDS, "unknown"], "unknown"),
});

/**
 * A delivery as clients see it; receipts and reviews are summaries, never logs. From a newer
 * server, a status, stage name or stage kind this build does not know decodes as `unknown`
 * (show it read-only, offer no controls), unknown fields are dropped, and a receipt or review
 * summary this build cannot read is left out instead of failing the snapshot.
 */
export const FactoryDelivery = Schema.Struct({
  deliveryId: FactoryDeliveryId,
  projectId: ProjectId,
  itemRef: WorkItemRef,
  /** Set on a planned child. */
  parentId: Schema.optionalKey(FactoryDeliveryId),
  /** A parent's child deliveries in plan order, once its plan is approved. */
  childIds: Schema.Array(FactoryDeliveryId),
  status: literalsOr([...FACTORY_DELIVERY_STATUSES, "unknown"], "unknown"),
  /** Absent before the first stage starts. */
  stage: Schema.optionalKey(FactoryDeliveryStage),
  /** Repair rounds spent on the current task, counted against the project's limits. */
  rounds: Schema.Struct({ fix: NonNegativeInt, review: NonNegativeInt }),
  branch: Schema.optionalKey(Schema.String),
  worktreePath: Schema.optionalKey(Schema.String),
  /** The latest thread of each role. */
  threads: Schema.Struct({
    planner: Schema.optionalKey(ThreadId),
    author: Schema.optionalKey(ThreadId),
    reviewer: Schema.optionalKey(ThreadId),
  }),
  receipts: ForwardCompatibleArray(FactoryVerifyReceiptSummary),
  reviews: ForwardCompatibleArray(FactoryReviewSummary),
  /** Why the delivery waits on the owner, at a gate or blocked; absent when it does not. */
  needsYou: Schema.optionalKey(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryDelivery = typeof FactoryDelivery.Type;
