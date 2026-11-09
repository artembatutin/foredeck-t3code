import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  RunId,
} from "../../baseSchemas.ts";
import { ProviderOptionSelectionValue } from "../../model.ts";
import { ProviderInstanceId } from "../../providerInstance.ts";
import { RuntimeMode } from "../../providerPolicy.ts";
import {
  FactoryCommand,
  FactoryDelivery,
  FactoryFindingSeverity,
  FactoryPendingActions,
  FactoryPromptName,
  FactoryStageRunSummary,
} from "../factory/index.ts";
import { WorkItemId, WorkSourceId, WorkSourceKind, WorkStatus } from "../work-management/index.ts";

export class AssistantOperationError extends Schema.TaggedError<AssistantOperationError>()(
  "AssistantOperationError",
  { message: Schema.String },
) {}

/** A Work item as its capture recorded it; `key` and `url` are null once a capture replaced it. */
const AssistantWorkItem = Schema.Struct({
  sourceId: WorkSourceId,
  itemId: WorkItemId,
  key: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
});

/**
 * A Factory assignment's delivery, bounded however much work waits on it. `status` and `stage` are
 * the child a parent awaits while that child is what stopped or blocked it, otherwise the root's;
 * `status` is null while no delivery row exists, and `unknown` when it could not be read or this
 * build does not know it.
 */
const AssistantFactoryDelivery = Schema.Struct({
  deliveryId: Schema.String,
  status: Schema.NullOr(FactoryDelivery.fields.status),
  stage: Schema.NullOr(FactoryStageRunSummary.fields.stage),
  /** Why it waits on its owner, at the plan gate or blocked. */
  needsYou: Schema.NullOr(Schema.String),
  /** An awaited effect is marked as waiting for a project assistant slot. */
  capacityWait: Schema.Boolean,
  /** Automatic follow-ups of the delivery's threads that have not run. */
  automaticWaits: Schema.Struct({ waiting: NonNegativeInt, blocked: NonNegativeInt }),
  /** Automatic follow-ups declined after the delivery ended, or lost on a restart. */
  endedDispositions: NonNegativeInt,
  /** The newest of those waits and dispositions in their notices' words, a few of each. */
  notices: Schema.Array(Schema.String),
  pullRequestUrl: Schema.NullOr(Schema.String),
  /** How its pull request left `open`, once the delivery took that. */
  pullRequestOutcome: Schema.optionalKey(Schema.Literals(["merged", "closed"])),
  /** Something of it is under way now, rather than it resting on its owner or pull request. */
  proceeding: Schema.optionalKey(Schema.Boolean),
  /** The thread it awaits, or else its latest author's. */
  threadId: Schema.NullOr(ThreadId),
  /** What it waits on someone for, read as the overview reads and writing nothing. */
  pendingActions: Schema.optionalKey(FactoryPendingActions),
});

/**
 * What a captured item's Work source says now. The assistant and Factory only read these: a queue
 * priority or a delivery's status never rewrites a tracker field, and absent means it was not read.
 */
const AssistantWorkFacts = Schema.Struct({
  title: Schema.String,
  status: WorkStatus,
  /** The source's own name for the status, where it has one. */
  statusName: Schema.NullOr(Schema.String),
  /** The human the source assigns it to, never the agents that work on it. */
  assignee: Schema.NullOr(Schema.String),
});

/**
 * What the assistant's panel shows. Everything past the original fields is optional: an older
 * server sends none of it, and an older client drops it.
 */
export const AssistantOverview = Schema.Struct({
  ideas: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      ideaId: Schema.String,
      goal: Schema.String,
      brief: Schema.String,
      authorized: Schema.Boolean,
      priority: Schema.NullOr(Schema.Int),
      priorityReason: Schema.String,
      /** The idea's Work capture; `item` stays null until a capture has named one. */
      capture: Schema.optionalKey(
        Schema.Struct({ state: Schema.String, item: Schema.NullOr(AssistantWorkItem) }),
      ),
      /** Its captured item's short title, or else the brief's. The goal stays whole in `goal`. */
      title: Schema.optionalKey(Schema.String),
      source: Schema.optionalKey(AssistantWorkFacts),
    }),
  ),
  assignments: Schema.Array(
    Schema.Struct({
      assignmentId: Schema.String,
      projectId: ProjectId,
      ideaId: Schema.String,
      state: Schema.String,
      attempt: Schema.Int,
      goal: Schema.String,
      brief: Schema.String,
      threadId: Schema.NullOr(ThreadId),
      runId: Schema.NullOr(RunId),
      evidence: Schema.Array(Schema.String),
      notice: Schema.String,
      executor: Schema.optionalKey(Schema.String),
      /** Absent until a Factory assignment is claimed, and after a retry clears its delivery. */
      factory: Schema.optionalKey(AssistantFactoryDelivery),
      workItem: Schema.optionalKey(AssistantWorkItem),
      /** Its current attempt runs under the owner's review receipt; absent or false otherwise. */
      reviewed: Schema.optionalKey(Schema.Boolean),
      /** Its Work item's short title, or else the brief's. The goal stays whole in `goal`. */
      title: Schema.optionalKey(Schema.String),
      /** The assistant's rank for its idea, which is not the Work item's own priority. */
      priority: Schema.optionalKey(Schema.NullOr(Schema.Int)),
      source: Schema.optionalKey(AssistantWorkFacts),
    }),
  ),
});
export type AssistantOverview = typeof AssistantOverview.Type;
export const SpokenReply = Schema.NullOr(Schema.Struct({ runId: RunId, text: Schema.String }));

/** The longest explicit or derived short title of a brief. */
export const ASSISTANT_TITLE_MAX = 80;

export const AssistantBriefTitle = Schema.String.check(Schema.isMaxLength(ASSISTANT_TITLE_MAX));

/** One way to deliver the idea: as a single item, or a parent Factory plans into tasks. */
export const AssistantReviewKind = Schema.Literals(["single", "parent"]);
export type AssistantReviewKind = typeof AssistantReviewKind.Type;

/** A review answers with what it was asked about, whole, so that much stays short. */
const AssistantReviewIdeaId = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));

/** Which idea the owner reviews, and how they would have it delivered. */
const AssistantReviewTarget = {
  projectId: ProjectId.check(Schema.isMaxLength(1024)),
  ideaId: AssistantReviewIdeaId,
  /** The assistant thread whose panel asks: the attempt's manager, whose permissions cap it. */
  managerThreadId: ThreadId,
  kind: AssistantReviewKind,
  /** Needed only while the project has several Work sources. */
  sourceId: Schema.optionalKey(WorkSourceId),
};

export const AssistantReviewGetInput = Schema.Struct(AssistantReviewTarget);
export type AssistantReviewGetInput = typeof AssistantReviewGetInput.Type;

/** What the review surface can change of a brief. Authorization is not among them. */
export const AssistantReviewEdit = Schema.Struct({
  /** Blank removes it, so the title derives from the goal again. */
  title: Schema.optionalKey(AssistantBriefTitle),
  goal: Schema.optionalKey(Schema.String),
  acceptanceCriteria: Schema.optionalKey(Schema.Array(Schema.String)),
  constraints: Schema.optionalKey(Schema.Array(Schema.String)),
  decisions: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const AssistantReviewReviseInput = Schema.Struct({
  projectId: ProjectId,
  ideaId: AssistantReviewIdeaId,
  /** The revision the owner edited; another one is refused, overwriting nothing. */
  expectedRevision: NonNegativeInt,
  patch: AssistantReviewEdit,
});
export type AssistantReviewReviseInput = typeof AssistantReviewReviseInput.Type;

export const AssistantReviewStartInput = Schema.Struct({
  ...AssistantReviewTarget,
  /** The snapshot's `reviewVersion`: exactly what the owner saw. */
  reviewVersion: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  /** One per confirmation; repeating it converges on what it started. */
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type AssistantReviewStartInput = typeof AssistantReviewStartInput.Type;

export const AssistantReviewStarted = Schema.Struct({
  assignmentId: Schema.String,
  receiptId: Schema.String,
  attempt: PositiveInt,
  /** `amended`: a delivery at rest took the review and resumed, keeping what it used. */
  outcome: Schema.Literals(["queued", "amended"]),
  /** This request had started it already, and this call changed nothing. */
  replayed: Schema.Boolean,
});
export type AssistantReviewStarted = typeof AssistantReviewStarted.Type;

const AssistantReviewSource = Schema.Struct({
  sourceId: WorkSourceId,
  kind: WorkSourceKind,
  label: Schema.String,
  /** Where it writes: its directory, repository or project. */
  identity: Schema.String,
});

const AssistantReviewRole = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: Schema.String,
  /** The provider offers this model now. */
  offered: Schema.Boolean,
  /** Saved options, a model's unsupported ones included and flagged. */
  options: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      value: ProviderOptionSelectionValue,
      supported: Schema.Boolean,
    }),
  ),
  /** Saved options past the ones listed; any stops a start, since they could not be read here. */
  optionsOmitted: NonNegativeInt,
  /** A provider confirms what it runs only once it runs, and none has yet. */
  acknowledgement: Schema.Literals(["not_reported"]),
});

/**
 * One bounded review of an idea: what a start would capture and run, as it stands now. Everything
 * in it is read at this moment, not frozen: only a start freezes it, and `reviewVersion` is what
 * that start compares, always of the whole however little of it this shows. Every cut is marked
 * where it falls, by a mark in the text or a count of what is left out, and `truncated` says there
 * is one. A cut stops a start only where it hides what the start commits to, which `start.blockers`
 * then says: an idea with a long history starts like any other.
 */
export const AssistantReviewSnapshot = Schema.Struct({
  reviewVersion: Schema.String,
  projectId: ProjectId,
  ideaId: Schema.String,
  /** What an edit names as its expected revision. */
  briefRevision: NonNegativeInt,
  title: Schema.Struct({
    text: Schema.String,
    /** Set on the brief, kept from the item already captured, or derived from the goal. */
    origin: Schema.Literals(["explicit", "stored", "derived"]),
  }),
  goal: Schema.String,
  acceptanceCriteria: Schema.Array(Schema.String),
  constraints: Schema.Array(Schema.String),
  decisions: Schema.Array(Schema.String),
  openQuestions: Schema.Array(Schema.String),
  /** Conversation-stage notes, which no Work item and no worker ever receives. */
  conversationNotes: Schema.Struct({
    items: Schema.Array(Schema.String),
    delivered: Schema.Literal(false),
  }),
  /** Null until the idea has a capture. */
  scopeChanges: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        field: Schema.String,
        previous: Schema.Array(Schema.String),
        next: Schema.Array(Schema.String),
      }),
    ),
  ),
  target: Schema.Struct({
    /** Where a pull request would go; null when that could not be resolved. */
    repository: Schema.NullOr(
      Schema.Struct({
        workspaceRoot: Schema.String,
        provider: Schema.String,
        repository: Schema.NullOr(Schema.String),
      }),
    ),
    /** How it would be delivered: as the attempt under way started, if there is one. */
    kind: AssistantReviewKind,
    /** An attempt under way keeps its kind, whatever a review asks for. */
    kindFixed: Schema.Boolean,
    source: Schema.NullOr(AssistantReviewSource),
    /** The project's active Work sources, to choose from, and how many more it has. */
    sources: Schema.Array(AssistantReviewSource),
    sourcesOmitted: NonNegativeInt,
    /** Null until a capture has named one. */
    item: Schema.NullOr(AssistantWorkItem),
  }),
  roles: Schema.Struct({
    planner: AssistantReviewRole,
    author: AssistantReviewRole,
    reviewer: AssistantReviewRole,
  }),
  verifyCommand: Schema.NullOr(FactoryCommand),
  setupCommand: Schema.NullOr(FactoryCommand),
  limits: Schema.Struct({
    maxFixRounds: NonNegativeInt,
    maxReviewRounds: NonNegativeInt,
    /** Null until the review resolves, as it does once the project can run a delivery. */
    maxFixCommitTurns: Schema.NullOr(NonNegativeInt),
    verifyTimeoutMinutes: PositiveInt,
    /** The timeout limits each command, and nothing limits a delivery's total time. */
    verifyTimeoutScope: Schema.Literal("per_command"),
    totalTime: Schema.Literal("unsupported"),
  }),
  blockingSeverities: Schema.Array(FactoryFindingSeverity),
  highRiskEffort: Schema.String,
  pipelineId: Schema.String,
  runtime: Schema.Struct({
    /** The manager's own mode, which caps the review. */
    requested: Schema.NullOr(RuntimeMode),
    /** What the delivery would run in, within what the project and the role providers allow. */
    ceiling: Schema.NullOr(RuntimeMode),
  }),
  overrides: Schema.Array(
    Schema.Struct({
      prompt: FactoryPromptName,
      state: Schema.Literals(["absent", "present", "unknown"]),
    }),
  ),
  /** The idea's latest attempts, newest last, and how many came before them. */
  attempts: Schema.Array(
    Schema.Struct({
      assignmentId: Schema.String,
      attempt: PositiveInt,
      state: Schema.String,
      reviewed: Schema.Boolean,
    }),
  ),
  attemptsOmitted: NonNegativeInt,
  start: Schema.Struct({
    /**
     * `new_attempt` queues one, `amend` hands a delivery at rest this review and resumes it, and
     * `none` starts nothing, for the reasons in `blockers`.
     */
    mode: Schema.Literals(["new_attempt", "amend", "none"]),
    blockers: Schema.Array(Schema.Struct({ code: Schema.String, message: Schema.String })),
  }),
  /** The brief's own text is cut, so saving it from here would lose the rest. */
  briefTruncated: Schema.Boolean,
  truncated: Schema.Boolean,
});
export type AssistantReviewSnapshot = typeof AssistantReviewSnapshot.Type;
