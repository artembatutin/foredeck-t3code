import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  ForwardCompatibleOptional,
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
const FACTORY_STAGE_OUTCOMES = ["passed", "failed", "blocked", "cancelled"] as const;

export const FactoryDeliveryStatus = Schema.Literals(FACTORY_DELIVERY_STATUSES);
export type FactoryDeliveryStatus = typeof FactoryDeliveryStatus.Type;

export const FactoryStageName = Schema.Literals(FACTORY_STAGE_NAMES);
export type FactoryStageName = typeof FactoryStageName.Type;

export const FactoryStageKind = Schema.Literals(FACTORY_STAGE_KINDS);
export type FactoryStageKind = typeof FactoryStageKind.Type;

/** How a stage attempt ended. */
export const FactoryStageOutcome = Schema.Literals(FACTORY_STAGE_OUTCOMES);
export type FactoryStageOutcome = typeof FactoryStageOutcome.Type;

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

/** A plan holds at most this many tasks, each with at most this many acceptance criteria. */
export const FACTORY_PLAN_TASKS_MAX = 50;
export const FACTORY_TASK_CRITERIA_MAX = 50;

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
  acceptance: Schema.Array(FactoryText(2000)).check(
    Schema.isBetweenLength(1, FACTORY_TASK_CRITERIA_MAX),
  ),
  testPlan: Schema.Array(FactoryTestPlanEntry).check(Schema.isMaxLength(FACTORY_TASK_CRITERIA_MAX)),
  likelyPaths: FactoryRepoPaths,
  risk: FactoryTaskRisk,
});
export type FactoryPlanTask = typeof FactoryPlanTask.Type;

/** A planner's submission. No tasks ends planning with the note, never an implied success. */
export const FactoryPlan = Schema.Struct({
  tasks: Schema.Array(FactoryPlanTask).check(Schema.isMaxLength(FACTORY_PLAN_TASKS_MAX)),
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

/**
 * An integrate reviewer's submission, a review of a parent's whole branch: `FactoryReview` with
 * room for one acceptance entry per criterion of the largest plan, its criteria numbered across
 * the approved tasks in plan order. Its type is the review's.
 */
export const FactoryIntegrateReview = Schema.Struct({
  ...FactoryReview.fields,
  acceptance: Schema.Array(FactoryAcceptanceCheck).check(
    Schema.isMaxLength(FACTORY_PLAN_TASKS_MAX * FACTORY_TASK_CRITERIA_MAX),
  ),
});

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

/**
 * The number Factory's evidence folder gave a delivery's verify run or accepted review
 * (`verify-<n>`, `review-<n>`): from 1, never reused within the delivery, and never a path.
 */
const FactoryEvidenceNumber = PositiveInt;

/** What clients see of a verify run: never the log, its path or the command line. */
export const FactoryVerifyReceiptSummary = Schema.Struct({
  ...verifyReceiptSummaryFields,
  /** The run's number, named by the stage attempt that produced it; older servers send none. */
  number: Schema.optionalKey(FactoryEvidenceNumber),
});
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

/**
 * A review summary lists at most this many entries of each detail list, and cuts each text to
 * this length. Stored delivery state decodes with these bounds, so they never shrink; raising
 * them makes older clients leave out the reviews that use the room.
 */
export const FACTORY_REVIEW_DETAILS_MAX = 20;
export const FACTORY_REVIEW_DETAIL_MAX_LENGTH = 500;

const FactoryReviewDetailText = FactoryText(FACTORY_REVIEW_DETAIL_MAX_LENGTH);
const reviewDetailsMax = Schema.isMaxLength(FACTORY_REVIEW_DETAILS_MAX);

/** One finding as clients see it. */
const FactoryReviewFindingDetail = Schema.Struct({
  id: FactorySlug,
  severity: FactoryFindingSeverity,
  required: Schema.Boolean,
  /** Whether its severity was one the project blocks on when the review was judged. */
  blocking: Schema.Boolean,
  file: FactoryRepoPath,
  /** Null when the finding concerns the whole file. */
  line: Schema.NullOr(PositiveInt),
  detail: FactoryReviewDetailText,
});

/** A criterion the reviewer found failed or could not test; each blocks the review. */
const FactoryReviewCriterionDetail = Schema.Struct({
  criterion: PositiveInt,
  status: Schema.Literals(["failed", "untested"]),
  /** The reviewer's account of it, without its paths. */
  detail: FactoryReviewDetailText,
});

/**
 * What a review raised, bounded for clients: its findings, the criteria it did not verify and the
 * evidence it found missing (each of the last two blocks the review). The full review stays in the
 * delivery's evidence; entries past a list's cap are counted in `omitted`, not sent.
 */
export const FactoryReviewDetails = Schema.Struct({
  findings: Schema.Array(FactoryReviewFindingDetail).check(reviewDetailsMax),
  criteria: Schema.Array(FactoryReviewCriterionDetail).check(reviewDetailsMax),
  missingEvidence: Schema.Array(FactoryReviewDetailText).check(reviewDetailsMax),
  omitted: Schema.Struct({
    findings: NonNegativeInt,
    criteria: NonNegativeInt,
    missingEvidence: NonNegativeInt,
  }),
});
export type FactoryReviewDetails = typeof FactoryReviewDetails.Type;

/** What clients see of a review round: the verdict and counts, and what it raised, bounded. */
export const FactoryReviewSummary = Schema.Struct({
  headSha: FactoryGitObjectId,
  verdict: FactoryReviewVerdict,
  blocking: Schema.Boolean,
  findings: Schema.Struct({ high: NonNegativeInt, medium: NonNegativeInt, low: NonNegativeInt }),
  reviewedAt: IsoDateTime,
  /** The review's number, named by the stage attempt that accepted it; older servers send none. */
  number: Schema.optionalKey(FactoryEvidenceNumber),
  /** Absent from older servers, and for reviews accepted before servers kept details. */
  details: Schema.optionalKey(FactoryReviewDetails),
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

/**
 * A server→client list a newer server may send entries of that this build cannot read: each
 * entry is decoded and encoded on its own, and one that fails is left out. Plain values on the
 * wire, unlike `ForwardCompatibleArray`: an RPC result, or a list holding the delivery, first
 * checks the raw value against its schema's encoded form, which keeps each entry's checks but not
 * that array's fallback, so one unreadable receipt, review or attempt would fail the whole
 * delivery or response.
 */
const ForwardCompatibleList = <A, I>(entry: Schema.Codec<A, I>) => {
  const decodeEntry = Schema.decodeUnknownOption(entry);
  const encodeEntry = Schema.encodeOption(entry);
  return Schema.Array(Schema.Unknown).pipe(
    Schema.decodeTo(
      Schema.Array(Schema.toType(entry)),
      SchemaTransformation.transform<ReadonlyArray<A>, ReadonlyArray<unknown>>({
        decode: (values) => values.flatMap((value) => Option.toArray(decodeEntry(value))),
        encode: (entries) => entries.flatMap((value) => Option.toArray(encodeEntry(value))),
      }),
    ),
  );
};

const FactoryDeliveryStage = Schema.Struct({
  name: literalsOr([...FACTORY_STAGE_NAMES, "unknown"], "unknown"),
  kind: literalsOr([...FACTORY_STAGE_KINDS, "unknown"], "unknown"),
});

/** A snapshot carries at most this many stage attempts: the delivery's newest. */
export const FACTORY_SNAPSHOT_STAGE_RUNS_MAX = 50;

/**
 * One attempt of one stage as clients see it: never its evidence path, failure fingerprint or
 * log. From a newer server, a stage or outcome this build does not know decodes as `unknown`.
 */
export const FactoryStageRunSummary = Schema.Struct({
  stage: literalsOr([...FACTORY_STAGE_NAMES, "unknown"], "unknown"),
  /** 1-based, counted per stage of the delivery. */
  attempt: PositiveInt,
  /** Null while the attempt is active. */
  outcome: Schema.NullOr(literalsOr([...FACTORY_STAGE_OUTCOMES, "unknown"], "unknown")),
  /** The thread doing the attempt's work, for agent stages once it is launched. */
  threadId: Schema.optionalKey(ThreadId),
  startedAt: IsoDateTime,
  /** Absent while the attempt is active. */
  finishedAt: Schema.optionalKey(IsoDateTime),
  /**
   * The `number` of the receipt the attempt's command produced, or of the review the attempt
   * accepted. Absent when it produced none (a refused run, a failure before any, a stop or cancel
   * first, or an attempt still active) and from older servers: clients attach a receipt or review
   * to an attempt only by these, never by its times.
   */
  receiptNumber: Schema.optionalKey(FactoryEvidenceNumber),
  reviewNumber: Schema.optionalKey(FactoryEvidenceNumber),
});
export type FactoryStageRunSummary = typeof FactoryStageRunSummary.Type;

/**
 * A delivery as clients see it; receipts, reviews and stage attempts are summaries, never logs.
 * From a newer server, a status, stage name, stage kind or attempt outcome this build does not
 * know decodes as `unknown` (show it read-only, offer no controls), unknown fields are dropped,
 * and a receipt, review summary or attempt this build cannot read is left out instead of failing
 * the snapshot.
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
  receipts: ForwardCompatibleList(FactoryVerifyReceiptSummary),
  reviews: ForwardCompatibleList(FactoryReviewSummary),
  /**
   * The newest stage attempts, at most `FACTORY_SNAPSHOT_STAGE_RUNS_MAX`, in the order they
   * started. Older servers send none.
   */
  stageRuns: ForwardCompatibleList(FactoryStageRunSummary).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /**
   * The plan of the delivery's current plan round while one is recorded: its tasks and the
   * planner's note, never its evidence. A parent waiting at the plan gate waits on this one, which
   * the owner edits, rejects or replans. Absent from servers from before planning; from a newer
   * server, a plan this build cannot read is left out instead of failing the snapshot.
   */
  plan: ForwardCompatibleOptional(FactoryPlan),
  /** Why the delivery waits on the owner, at a gate or blocked; absent when it does not. */
  needsYou: Schema.optionalKey(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FactoryDelivery = typeof FactoryDelivery.Type;

export const FactorySettingsGetInput = Schema.Struct({ projectId: ProjectId });
export type FactorySettingsGetInput = typeof FactorySettingsGetInput.Type;

/** Replaces the project's settings; absent keys take the defaults. */
export const FactorySettingsSetInput = Schema.Struct({
  projectId: ProjectId,
  settings: FactoryProjectSettings,
});
export type FactorySettingsSetInput = typeof FactorySettingsSetInput.Type;

export const FactoryDeliveryStartInput = Schema.Struct({
  itemRef: WorkItemRef,
  /**
   * Absent means `single`. `parent` plans the item's children first, and only a Markdown source
   * can hold them. A server from before planning fails to decode `parent` rather than deliver
   * the item as a single one.
   */
  kind: Schema.optionalKey(Schema.Literals(["single", "parent"])),
});
export type FactoryDeliveryStartInput = typeof FactoryDeliveryStartInput.Type;

/** Names one delivery, for stop, resume, cancel and get. */
export const FactoryDeliveryRefInput = Schema.Struct({ deliveryId: FactoryDeliveryId });
export type FactoryDeliveryRefInput = typeof FactoryDeliveryRefInput.Type;

/**
 * The owner's edit of the plan a delivery waits on at the plan gate: the whole plan as it should
 * stand, encoded as `FactoryPlan` encodes it. It may change the tasks' titles, summaries,
 * acceptance criteria and test plans, reorder the tasks and leave some out; ids, kinds, likely
 * paths, risk and the note stay the planner's. The wire takes any value here: the server judges
 * it with the planner's plan validator and the edit rules, so a plan that breaks them, malformed
 * or not, is refused as `invalid_request` rather than failing the request's decoding.
 */
export const FactoryPlanUpdateInput = Schema.Struct({
  deliveryId: FactoryDeliveryId,
  plan: Schema.Unknown,
});
export type FactoryPlanUpdateInput = typeof FactoryPlanUpdateInput.Type;

export const FACTORY_REPLAN_NOTE_MAX_LENGTH = 8000;

/**
 * What the owner asks the planner to change, as the server takes it; the planner thread gets it
 * as a follow-up turn. Clients can check a note against it before sending.
 */
export const FactoryReplanNote = FactoryText(FACTORY_REPLAN_NOTE_MAX_LENGTH);

/**
 * The wire takes any string as the note: the server trims it and refuses one that is blank or
 * past `FACTORY_REPLAN_NOTE_MAX_LENGTH` as `invalid_request` (see `FactoryReplanNote`), rather
 * than failing the request's decoding.
 */
export const FactoryPlanReplanInput = Schema.Struct({
  deliveryId: FactoryDeliveryId,
  note: Schema.String,
});
export type FactoryPlanReplanInput = typeof FactoryPlanReplanInput.Type;

/** Every delivery on the environment, or one project's. */
export const FactoryDeliveryListInput = Schema.Struct({ projectId: Schema.optionalKey(ProjectId) });
export type FactoryDeliveryListInput = typeof FactoryDeliveryListInput.Type;

/** Newest first. A delivery this build cannot read is left out instead of failing the list. */
export const FactoryDeliveryList = Schema.Struct({
  deliveries: ForwardCompatibleList(FactoryDelivery),
});
export type FactoryDeliveryList = typeof FactoryDeliveryList.Type;

const FACTORY_ERROR_REASONS = [
  "invalid_request",
  "not_found",
  "not_configured",
  "conflict",
  "refused",
  "unsupported_source",
  "unavailable",
] as const;

/**
 * `invalid_request`: the request is not one Factory takes, such as a plan edit that changes what
 * the owner may not change. `not_configured`: the project's Factory settings lack what the request
 * needs (a verify command). `conflict`: the item already has a delivery that is not done or
 * cancelled. `refused`: the delivery's status, or the project's checkout, does not allow the
 * request now.
 * `unsupported_source`: the item's Work source cannot hold what the request needs (a parent's
 * children, which only a Markdown source can). `unavailable`: storage or the server failed, or a
 * reason this build does not know (a newer server's reasons decode here rather than failing).
 */
export const FactoryErrorReason = literalsOr(FACTORY_ERROR_REASONS, "unavailable");
export type FactoryErrorReason = typeof FactoryErrorReason.Type;

/**
 * How the `factory.*` methods fail. The message is Factory's fixed text, never a storage cause,
 * command output or what a Work source answered.
 */
export class FactoryError extends Schema.TaggedError<FactoryError>()("FactoryError", {
  reason: FactoryErrorReason,
  message: Schema.String,
  /** The missing or refused delivery, or for `conflict` the item's active one. */
  deliveryId: Schema.optionalKey(FactoryDeliveryId),
}) {}
