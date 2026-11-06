// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous hash keeps this module pure.
import * as NodeCrypto from "node:crypto";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";

/** Lower ranks run first. A brief without a priority is unranked and sorts last. */
const Priority = Schema.Struct({
  rank: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  reason: Schema.String,
});
export type Priority = typeof Priority.Type;

/** The agreed, environment-local brief for one project. */
export const ProjectBrief = Schema.Struct({
  projectId: ProjectId,
  ideaId: Schema.optionalKey(Schema.String),
  goal: Schema.String,
  acceptanceCriteria: Schema.Array(Schema.String),
  constraints: Schema.Array(Schema.String),
  decisions: Schema.optionalKey(Schema.Array(Schema.String)),
  priority: Schema.NullOr(Priority),
  openQuestions: Schema.Array(Schema.String),
  executionAuthorized: Schema.Boolean,
  revision: Schema.Int,
  updatedAt: IsoDateTime,
});
export type ProjectBrief = typeof ProjectBrief.Type;

/** Fields to change. Absent keys keep their value; `priority: null` makes the project unranked. */
export const BriefPatch = Schema.Struct({
  goal: Schema.optionalKey(Schema.String),
  acceptanceCriteria: Schema.optionalKey(Schema.Array(Schema.String)),
  constraints: Schema.optionalKey(Schema.Array(Schema.String)),
  decisions: Schema.optionalKey(Schema.Array(Schema.String)),
  priority: Schema.optionalKey(Schema.NullOr(Priority)),
  openQuestions: Schema.optionalKey(Schema.Array(Schema.String)),
  executionAuthorized: Schema.optionalKey(Schema.Boolean),
});
export type BriefPatch = typeof BriefPatch.Type;

const listChange = <const Field extends string>(field: Field) =>
  Schema.Struct({
    field: Schema.Literal(field),
    previous: Schema.Array(Schema.String),
    next: Schema.Array(Schema.String),
  });

export const BriefChange = Schema.Union([
  Schema.Struct({ field: Schema.Literal("goal"), previous: Schema.String, next: Schema.String }),
  listChange("acceptanceCriteria"),
  listChange("constraints"),
  listChange("decisions"),
  listChange("openQuestions"),
  Schema.Struct({
    field: Schema.Literal("priority"),
    previous: Schema.NullOr(Priority),
    next: Schema.NullOr(Priority),
  }),
  Schema.Struct({
    field: Schema.Literal("executionAuthorized"),
    previous: Schema.Boolean,
    next: Schema.Boolean,
  }),
]);
export type BriefChange = typeof BriefChange.Type;

/** One recorded correction. A priority change keeps the previous rank and both reasons. */
export const BriefRevision = Schema.Struct({
  projectId: ProjectId,
  ideaId: Schema.optionalKey(Schema.String),
  revision: Schema.Int,
  changes: Schema.Array(BriefChange),
  reason: Schema.NullOr(Schema.String),
  recordedAt: IsoDateTime,
});
export type BriefRevision = typeof BriefRevision.Type;

const normalizeList = (items: ReadonlyArray<string>) =>
  items.map((item) => item.trim()).filter((item) => item.length > 0);

const sameList = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((item, index) => item === right[index]);

const samePriority = (left: Priority | null, right: Priority | null) =>
  left === null || right === null
    ? left === right
    : left.rank === right.rank && left.reason === right.reason;

/**
 * Apply a patch to the current brief, or to an empty brief when the project has none yet.
 * An existing brief that would not change comes back without a revision, so repeating a
 * correction records nothing.
 */
export function reviseBrief(
  current: ProjectBrief | undefined,
  input: {
    readonly projectId: ProjectId;
    readonly ideaId?: string;
    readonly patch: BriefPatch;
    readonly reason: string | null;
    readonly at: string;
  },
): { readonly brief: ProjectBrief; readonly revision?: BriefRevision } {
  const base: ProjectBrief = current ?? {
    projectId: input.projectId,
    ideaId: input.ideaId ?? "legacy",
    goal: "",
    acceptanceCriteria: [],
    constraints: [],
    decisions: [],
    priority: null,
    openQuestions: [],
    executionAuthorized: false,
    revision: 0,
    updatedAt: input.at,
  };
  const { patch } = input;
  const changes: Array<BriefChange> = [];
  const next: Mutable<ProjectBrief> = { ...base };

  const goal = patch.goal?.trim();
  if (goal !== undefined && goal !== base.goal) {
    next.goal = goal;
    changes.push({ field: "goal", previous: base.goal, next: goal });
  }
  for (const field of [
    "acceptanceCriteria",
    "constraints",
    "openQuestions",
    "decisions",
  ] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    const normalized = normalizeList(value);
    if (sameList(normalized, base[field] ?? [])) continue;
    next[field] = normalized;
    changes.push({ field, previous: base[field] ?? [], next: normalized });
  }
  if (patch.priority !== undefined) {
    const priority =
      patch.priority === null
        ? null
        : { rank: patch.priority.rank, reason: patch.priority.reason.trim() };
    if (!samePriority(priority, base.priority)) {
      next.priority = priority;
      changes.push({ field: "priority", previous: base.priority, next: priority });
    }
  }
  const scopeChanged = changes.some((change) =>
    ["goal", "acceptanceCriteria", "constraints", "decisions"].includes(change.field),
  );
  const authorized = patch.executionAuthorized ?? (scopeChanged ? false : undefined);
  if (authorized !== undefined && authorized !== base.executionAuthorized) {
    next.executionAuthorized = authorized;
    changes.push({
      field: "executionAuthorized",
      previous: base.executionAuthorized,
      next: authorized,
    });
  }

  if (current !== undefined && changes.length === 0) return { brief: current };
  const revision = base.revision + 1;
  return {
    brief: { ...next, revision, updatedAt: input.at },
    revision: {
      projectId: input.projectId,
      ideaId: input.ideaId ?? "legacy",
      revision,
      changes,
      reason: input.reason?.trim() || null,
      recordedAt: input.at,
    },
  };
}

export const AssignmentState = Schema.Literals([
  "draft",
  "queued",
  "launching",
  "launch-uncertain",
  "running",
  "awaiting-verification",
  "needs-input",
  "stopping",
  "stopped",
  "failed",
  "completed",
  "cancelled",
]);
export type AssignmentState = typeof AssignmentState.Type;

export const ExecutorKind = Schema.Literals(["foredeck", "looper", "factory"]);
export type ExecutorKind = typeof ExecutorKind.Type;

/** An exact identifier the executor returned for this attempt. */
export const WorkerRef = Schema.Struct({
  kind: Schema.Literals(["thread", "run", "looper-run", "factory-delivery", "work-item"]),
  id: TrimmedNonEmptyString,
});
export type WorkerRef = typeof WorkerRef.Type;

export const ProgressNote = Schema.Struct({ at: IsoDateTime, text: Schema.String });
export type ProgressNote = typeof ProgressNote.Type;

export const Assignment = Schema.Struct({
  assignmentId: TrimmedNonEmptyString,
  projectId: ProjectId,
  ideaId: Schema.optionalKey(Schema.String),
  executor: ExecutorKind,
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  state: AssignmentState,
  workerRefs: Schema.Array(WorkerRef),
  progress: Schema.Array(ProgressNote),
  evidence: Schema.Array(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Assignment = typeof Assignment.Type;

/** Progress is a recent window; older notes fall off so manager context stays bounded. */
export const MAX_PROGRESS_NOTES = 20;

export function newAssignment(input: {
  readonly assignmentId: string;
  readonly projectId: ProjectId;
  readonly executor: ExecutorKind;
  readonly ideaId?: string;
  readonly at: string;
}): Assignment {
  return {
    assignmentId: input.assignmentId,
    projectId: input.projectId,
    ideaId: input.ideaId ?? "legacy",
    executor: input.executor,
    attempt: 1,
    state: "draft",
    workerRefs: [],
    progress: [],
    evidence: [],
    createdAt: input.at,
    updatedAt: input.at,
  };
}

/** Every event may carry a progress note recorded with the move. */
export type AssignmentEvent = { readonly note?: string } & (
  | { readonly type: "record-notice" }
  | { readonly type: "queue" }
  | { readonly type: "claim" }
  | { readonly type: "uncertain" }
  | { readonly type: "finish" }
  | { readonly type: "start"; readonly workerRefs: ReadonlyArray<WorkerRef> }
  | { readonly type: "request-input" }
  | { readonly type: "provide-input" }
  | {
      readonly type: "record-progress";
      readonly workerRefs?: ReadonlyArray<WorkerRef>;
      readonly evidence?: ReadonlyArray<string>;
    }
  | { readonly type: "stop" }
  | { readonly type: "confirm-stopped" }
  | { readonly type: "resume" }
  | { readonly type: "fail" }
  | { readonly type: "retry" }
  | { readonly type: "retry-delivery" }
  | { readonly type: "complete"; readonly evidence: ReadonlyArray<string> }
  | { readonly type: "cancel" }
  | {
      readonly type: "mirror";
      readonly to: MirroredState;
      readonly evidence?: ReadonlyArray<string>;
      readonly workerRefs?: ReadonlyArray<WorkerRef>;
    }
);

/**
 * The states a Factory delivery's assignment shows, which `mirror` moves it into. Its assignment
 * is a projection of the delivery Factory runs, so it moves where the delivery is rather than by
 * the moves an ordinary worker's assignment takes; only the project assistant's admission of a
 * managed root writes it.
 */
export const MIRRORED_STATES = [
  "running",
  "needs-input",
  "stopping",
  "stopped",
  "failed",
  "completed",
  "cancelled",
] as const satisfies ReadonlyArray<AssignmentState>;
export type MirroredState = (typeof MIRRORED_STATES)[number];
export type AssignmentEventType = AssignmentEvent["type"];

const AssignmentRejectionReason = Schema.Literals([
  "invalid-transition",
  "not-authorized",
  "missing-worker-reference",
  "missing-evidence",
]);
export type AssignmentRejectionReason = typeof AssignmentRejectionReason.Type;

const rejectionText: Record<AssignmentRejectionReason, string> = {
  "invalid-transition": "that move is not valid from this state",
  "not-authorized": "the project brief is not authorized for execution",
  "missing-worker-reference": "no exact worker reference was recorded",
  "missing-evidence": "no completion evidence was recorded",
};

export class AssignmentTransitionRejected extends Schema.TaggedError<AssignmentTransitionRejected>()(
  "AssignmentTransitionRejected",
  {
    assignmentId: Schema.String,
    from: AssignmentState,
    event: Schema.String,
    reason: AssignmentRejectionReason,
  },
) {
  override get message(): string {
    return `Assignment ${this.assignmentId} cannot ${this.event} while ${this.from}: ${rejectionText[this.reason]}.`;
  }
}

// `to` absent keeps the state. Stopping active work is its own explicit event; cancel only
// applies to work that is not running.
const MOVES: {
  readonly [Type in AssignmentEventType]: {
    readonly from: ReadonlyArray<AssignmentState>;
    readonly to?: AssignmentState;
    readonly requiresAuthorization?: true;
  };
} = {
  "record-notice": { from: AssignmentState.literals },
  queue: { from: ["draft"], to: "queued", requiresAuthorization: true },
  claim: { from: ["queued"], to: "launching", requiresAuthorization: true },
  uncertain: { from: ["launching"], to: "launch-uncertain" },
  finish: { from: ["running"], to: "awaiting-verification" },
  start: {
    from: ["queued", "launching", "launch-uncertain"],
    to: "running",
    requiresAuthorization: true,
  },
  "request-input": { from: ["running"], to: "needs-input" },
  "provide-input": { from: ["needs-input"], to: "running" },
  "record-progress": {
    from: [
      "running",
      "needs-input",
      "stopping",
      "launching",
      "launch-uncertain",
      "awaiting-verification",
    ],
  },
  stop: { from: ["running", "needs-input"], to: "stopping" },
  "confirm-stopped": { from: ["stopping"], to: "stopped" },
  resume: { from: ["stopped"], to: "queued", requiresAuthorization: true },
  fail: {
    from: ["queued", "launching", "running", "needs-input", "stopping", "awaiting-verification"],
    to: "failed",
  },
  retry: { from: ["failed"], to: "queued", requiresAuthorization: true },
  // A Factory assignment's retry, for a new delivery once its root has ended; an ordinary worker's
  // cancelled assignment stays cancelled.
  "retry-delivery": { from: ["failed", "cancelled"], to: "queued", requiresAuthorization: true },
  complete: { from: ["running", "stopping", "awaiting-verification"], to: "completed" },
  cancel: {
    from: ["draft", "queued", "stopped", "failed", "awaiting-verification"],
    to: "cancelled",
  },
  // `to` is the event's own, for a Factory delivery's assignment that has not ended.
  mirror: {
    from: [
      "queued",
      "launching",
      "launch-uncertain",
      "running",
      "needs-input",
      "stopping",
      "stopped",
    ],
  },
};

function appendNote(progress: ReadonlyArray<ProgressNote>, note: string | undefined, at: string) {
  const text = note?.trim();
  if (!text) return progress;
  return [...progress, { at, text }].slice(-MAX_PROGRESS_NOTES);
}

function uniqueRefs(refs: ReadonlyArray<WorkerRef>): ReadonlyArray<WorkerRef> {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.id}`;
    if (ref.id.trim() === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Decide one lifecycle move. Dispatch (queue, start, resume, retry) requires the project's
 * current execution authorization, start requires the executor's exact reference, and
 * completion requires evidence from the current attempt. Retry starts a new attempt without
 * the failed attempt's references or evidence.
 */
export function transitionAssignment(
  assignment: Assignment,
  event: AssignmentEvent,
  context: { readonly executionAuthorized: boolean; readonly at: string },
): Result.Result<Assignment, AssignmentTransitionRejected> {
  const move = MOVES[event.type];
  const reject = (reason: AssignmentRejectionReason) =>
    Result.fail(
      new AssignmentTransitionRejected({
        assignmentId: assignment.assignmentId,
        from: assignment.state,
        event: event.type,
        reason,
      }),
    );
  if (!move.from.includes(assignment.state)) return reject("invalid-transition");
  if (
    move.requiresAuthorization &&
    !context.executionAuthorized &&
    !(event.type === "start" && ["launching", "launch-uncertain"].includes(assignment.state))
  )
    return reject("not-authorized");

  const next: Assignment = {
    ...assignment,
    state: event.type === "mirror" ? event.to : (move.to ?? assignment.state),
    progress: appendNote(assignment.progress, event.note, context.at),
    updatedAt: context.at,
  };
  switch (event.type) {
    case "start": {
      const workerRefs = uniqueRefs(event.workerRefs);
      if (workerRefs.length === 0) return reject("missing-worker-reference");
      return Result.succeed({ ...next, workerRefs });
    }
    case "record-progress":
      return Result.succeed({
        ...next,
        evidence: [...assignment.evidence, ...normalizeList(event.evidence ?? [])],
        workerRefs: uniqueRefs([...assignment.workerRefs, ...(event.workerRefs ?? [])]),
      });
    case "complete": {
      const evidence = [...assignment.evidence, ...normalizeList(event.evidence)];
      if (evidence.length === 0) return reject("missing-evidence");
      return Result.succeed({ ...next, evidence });
    }
    case "mirror": {
      const evidence = [...assignment.evidence, ...normalizeList(event.evidence ?? [])];
      if (event.to === "completed" && evidence.length === 0) return reject("missing-evidence");
      return Result.succeed({
        ...next,
        evidence,
        workerRefs: uniqueRefs([...assignment.workerRefs, ...(event.workerRefs ?? [])]),
      });
    }
    case "resume":
    case "retry":
    case "retry-delivery":
      return Result.succeed({
        ...next,
        attempt: assignment.attempt + 1,
        workerRefs: [],
        evidence: [],
      });
    default:
      return Result.succeed(next);
  }
}

const renderList = (
  title: string,
  items: ReadonlyArray<string>,
  marker: (index: number) => string,
) =>
  `${title}:\n${
    items.length === 0
      ? "(none recorded)"
      : items.map((item, index) => `${marker(index)} ${item}`).join("\n")
  }`;

/**
 * The text a worker receives: one project's agreed goal, acceptance criteria, constraints and
 * open questions. Priority and its reason are portfolio-relative and often mention other
 * projects, so they stay with the manager.
 */
export function renderAssignmentBrief(brief: ProjectBrief): string {
  return [
    `Project brief for ${brief.projectId}, idea ${brief.ideaId ?? "legacy"}. This is the complete agreed scope for this assignment.`,
    `Goal:\n${brief.goal || "(none recorded)"}`,
    renderList("Acceptance criteria", brief.acceptanceCriteria, (index) => `${index + 1}.`),
    renderList("Constraints", brief.constraints, () => "-"),
    renderList("Decisions", brief.decisions ?? [], () => "-"),
    ...(brief.openQuestions.length === 0
      ? []
      : [renderList("Open questions (ask instead of assuming)", brief.openQuestions, () => "-")]),
  ].join("\n\n");
}

/**
 * The hash a capture records of the brief it was made from: of what a worker is told, so a change
 * of priority or authorization alone never changes it.
 */
export const briefScopeHash = (brief: ProjectBrief): string =>
  NodeCrypto.createHash("sha256").update(renderAssignmentBrief(brief)).digest("hex");

export const MANAGER_SUMMARY_LIMITS = { projects: 8, charactersPerProject: 600 } as const;

const TERMINAL_STATES: ReadonlySet<AssignmentState> = new Set(["completed", "cancelled"]);

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = Math.max(0, limit - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

function summarizeAssignment(assignment: Assignment): string {
  const refs = assignment.workerRefs.map((ref) => `${ref.kind}:${ref.id}`).join(", ");
  const latest = assignment.progress.at(-1)?.text;
  const detail = [assignment.executor, `attempt ${assignment.attempt}`, ...(refs ? [refs] : [])];
  return [
    `${assignment.assignmentId} ${assignment.state} (${detail.join(", ")})`,
    ...(latest ? [`latest: ${oneLine(latest)}`] : []),
  ].join(" — ");
}

function summarizeProject(brief: ProjectBrief, assignments: ReadonlyArray<Assignment>): string {
  const recent = assignments
    .toSorted(
      (left, right) =>
        Number(TERMINAL_STATES.has(left.state)) - Number(TERMINAL_STATES.has(right.state)) ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, 3);
  const priority =
    brief.priority === null
      ? "unranked"
      : [brief.priority.rank, ...(brief.priority.reason ? [oneLine(brief.priority.reason)] : [])]
          .map(String)
          .join(" — ");
  return [
    `## ${brief.projectId} / ${brief.ideaId ?? "legacy"}`,
    `Priority: ${priority}`,
    `Execution: ${brief.executionAuthorized ? "authorized" : "not authorized"}`,
    `Goal: ${oneLine(brief.goal) || "(not agreed yet)"}`,
    ...(brief.openQuestions.length === 0
      ? []
      : [
          `Open questions (${brief.openQuestions.length}): ${brief.openQuestions.map(oneLine).join("; ")}`,
        ]),
    ...(recent.length === 0 ? [] : [`Assignments: ${recent.map(summarizeAssignment).join("; ")}`]),
  ].join("\n");
}

/**
 * Bounded per-project summaries for the manager's context. Projects waiting on input lead,
 * then priority order. Each project is cut to a fixed size and at most a fixed number of
 * projects appear; the rest are counted so the manager can ask for them by id.
 */
export function renderManagerSummary(
  briefs: ReadonlyArray<ProjectBrief>,
  assignments: ReadonlyArray<Assignment>,
  limits: {
    readonly projects: number;
    readonly charactersPerProject: number;
  } = MANAGER_SUMMARY_LIMITS,
): string {
  const byProject = new Map<string, Array<Assignment>>();
  for (const assignment of assignments) {
    const list = byProject.get(assignment.projectId) ?? [];
    list.push(assignment);
    byProject.set(assignment.projectId, list);
  }
  const needsInput = (brief: ProjectBrief) =>
    byProject.get(brief.projectId)?.some((assignment) => assignment.state === "needs-input") ===
    true;
  const unranked = Number.MAX_SAFE_INTEGER;
  const ordered = briefs.toSorted(
    (left, right) =>
      Number(needsInput(right)) - Number(needsInput(left)) ||
      (left.priority?.rank ?? unranked) - (right.priority?.rank ?? unranked) ||
      left.projectId.localeCompare(right.projectId),
  );
  const shown = ordered.slice(0, Math.max(0, limits.projects));
  const sections = shown.map((brief) =>
    truncate(
      summarizeProject(
        brief,
        (byProject.get(brief.projectId) ?? []).filter(
          (a) => (a.ideaId ?? "legacy") === (brief.ideaId ?? "legacy"),
        ),
      ),
      limits.charactersPerProject,
    ),
  );
  const omitted = ordered.length - shown.length;
  if (omitted > 0) {
    sections.push(`(${omitted} more ${omitted === 1 ? "project" : "projects"} not shown.)`);
  }
  return sections.join("\n\n");
}
