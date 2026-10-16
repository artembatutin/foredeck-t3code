import { IsoDateTime, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import * as Portfolio from "./portfolio.ts";

class PortfolioStoreError extends Schema.TaggedError<PortfolioStoreError>()("PortfolioStoreError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Assistant portfolio operation '${this.operation}' failed.`;
  }
}

class AssignmentNotFound extends Schema.TaggedError<AssignmentNotFound>()("AssignmentNotFound", {
  assignmentId: Schema.String,
}) {
  override get message(): string {
    return `Assignment ${this.assignmentId} does not exist.`;
  }
}

const StringList = Schema.fromJsonString(Schema.Array(Schema.String));

const BriefDbRow = Schema.Struct({
  projectId: ProjectId,
  goal: Schema.String,
  acceptanceCriteria: StringList,
  constraints: StringList,
  priorityRank: Schema.NullOr(Schema.Int),
  priorityReason: Schema.NullOr(Schema.String),
  openQuestions: StringList,
  executionAuthorized: Schema.BooleanFromBit,
  revision: Schema.Int,
  updatedAt: IsoDateTime,
});
type BriefDbRow = typeof BriefDbRow.Type;

const RevisionDbRow = Schema.Struct({
  ...Portfolio.BriefRevision.fields,
  changes: Schema.fromJsonString(Schema.Array(Portfolio.BriefChange)),
});

const AssignmentDbRow = Schema.Struct({
  ...Portfolio.Assignment.fields,
  workerRefs: Schema.fromJsonString(Schema.Array(Portfolio.WorkerRef)),
  progress: Schema.fromJsonString(Schema.Array(Portfolio.ProgressNote)),
  evidence: StringList,
});

const toBrief = ({ priorityRank, priorityReason, ...row }: BriefDbRow): Portfolio.ProjectBrief => ({
  ...row,
  priority: priorityRank === null ? null : { rank: priorityRank, reason: priorityReason ?? "" },
});

const toBriefRow = ({ priority, ...brief }: Portfolio.ProjectBrief): BriefDbRow => ({
  ...brief,
  priorityRank: priority?.rank ?? null,
  priorityReason: priority?.reason ?? null,
});

/**
 * The assistant's durable, environment-local portfolio: one agreed brief per project, its
 * revision history, and assignments with their lifecycle. Lifecycle rules live in
 * `portfolio.ts`; this service applies them atomically against stored state.
 */
export class PortfolioStore extends Context.Service<
  PortfolioStore,
  {
    readonly getBrief: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<Portfolio.ProjectBrief>, PortfolioStoreError>;
    /** Briefs in priority order; unranked projects last. */
    readonly listBriefs: () => Effect.Effect<
      ReadonlyArray<Portfolio.ProjectBrief>,
      PortfolioStoreError
    >;
    /**
     * Record the changed fields as one revision, creating the brief if needed. An unchanged
     * patch returns the stored brief and records nothing.
     */
    readonly reviseBrief: (input: {
      readonly projectId: ProjectId;
      readonly patch: Portfolio.BriefPatch;
      readonly reason?: string | null;
    }) => Effect.Effect<Portfolio.ProjectBrief, PortfolioStoreError>;
    /** Revisions oldest first, each with the previous and next value of every changed field. */
    readonly listRevisions: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<Portfolio.BriefRevision>, PortfolioStoreError>;
    /**
     * Create a draft assignment. The caller's id is the idempotency key: reusing it returns
     * the stored assignment unchanged, so a retried request cannot add a duplicate.
     */
    readonly createAssignment: (input: {
      readonly assignmentId: string;
      readonly projectId: ProjectId;
      readonly executor: Portfolio.ExecutorKind;
    }) => Effect.Effect<Portfolio.Assignment, PortfolioStoreError>;
    readonly getAssignment: (
      assignmentId: string,
    ) => Effect.Effect<Option.Option<Portfolio.Assignment>, PortfolioStoreError>;
    /** Assignments in creation order, optionally for one project or in given states. */
    readonly listAssignments: (filter?: {
      readonly projectId?: ProjectId;
      readonly states?: ReadonlyArray<Portfolio.AssignmentState>;
    }) => Effect.Effect<ReadonlyArray<Portfolio.Assignment>, PortfolioStoreError>;
    /** Apply one lifecycle event against the project's current authorization, atomically. */
    readonly transitionAssignment: (input: {
      readonly assignmentId: string;
      readonly event: Portfolio.AssignmentEvent;
    }) => Effect.Effect<
      Portfolio.Assignment,
      PortfolioStoreError | AssignmentNotFound | Portfolio.AssignmentTransitionRejected
    >;
  }
>()("t3/fd/assistant/PortfolioStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const mapError =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new PortfolioStoreError({ operation, cause })));

  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const selectBriefs = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: Schema.optional(ProjectId) }),
    Result: BriefDbRow,
    execute: ({ projectId }) => sql`
      SELECT
        project_id AS "projectId",
        goal,
        acceptance_criteria_json AS "acceptanceCriteria",
        constraints_json AS "constraints",
        priority_rank AS "priorityRank",
        priority_reason AS "priorityReason",
        open_questions_json AS "openQuestions",
        execution_authorized AS "executionAuthorized",
        revision,
        updated_at AS "updatedAt"
      FROM fd_assistant_project_briefs
      WHERE ${sql.and(projectId === undefined ? [] : [sql`project_id = ${projectId}`])}
      ORDER BY priority_rank IS NULL, priority_rank, project_id
    `,
  });

  const upsertBrief = SqlSchema.void({
    Request: BriefDbRow,
    execute: (row) => sql`
      INSERT INTO fd_assistant_project_briefs (
        project_id,
        goal,
        acceptance_criteria_json,
        constraints_json,
        priority_rank,
        priority_reason,
        open_questions_json,
        execution_authorized,
        revision,
        updated_at
      )
      VALUES (
        ${row.projectId},
        ${row.goal},
        ${row.acceptanceCriteria},
        ${row.constraints},
        ${row.priorityRank},
        ${row.priorityReason},
        ${row.openQuestions},
        ${row.executionAuthorized},
        ${row.revision},
        ${row.updatedAt}
      )
      ON CONFLICT (project_id) DO UPDATE SET
        goal = excluded.goal,
        acceptance_criteria_json = excluded.acceptance_criteria_json,
        constraints_json = excluded.constraints_json,
        priority_rank = excluded.priority_rank,
        priority_reason = excluded.priority_reason,
        open_questions_json = excluded.open_questions_json,
        execution_authorized = excluded.execution_authorized,
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `,
  });

  const selectRevisions = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId }),
    Result: RevisionDbRow,
    execute: ({ projectId }) => sql`
      SELECT
        project_id AS "projectId",
        revision,
        changes_json AS "changes",
        reason,
        recorded_at AS "recordedAt"
      FROM fd_assistant_brief_revisions
      WHERE project_id = ${projectId}
      ORDER BY revision ASC
    `,
  });

  const insertRevision = SqlSchema.void({
    Request: RevisionDbRow,
    execute: (row) => sql`
      INSERT INTO fd_assistant_brief_revisions (
        project_id,
        revision,
        changes_json,
        reason,
        recorded_at
      )
      VALUES (${row.projectId}, ${row.revision}, ${row.changes}, ${row.reason}, ${row.recordedAt})
    `,
  });

  const selectAssignments = SqlSchema.findAll({
    Request: Schema.Struct({
      assignmentId: Schema.optional(Schema.String),
      projectId: Schema.optional(ProjectId),
      states: Schema.optional(Schema.Array(Portfolio.AssignmentState)),
    }),
    Result: AssignmentDbRow,
    execute: (request) => sql`
      SELECT
        assignment_id AS "assignmentId",
        project_id AS "projectId",
        executor,
        attempt,
        state,
        worker_refs_json AS "workerRefs",
        progress_json AS "progress",
        evidence_json AS "evidence",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM fd_assistant_assignments
      WHERE ${sql.and([
        ...(request.assignmentId === undefined
          ? []
          : [sql`assignment_id = ${request.assignmentId}`]),
        ...(request.projectId === undefined ? [] : [sql`project_id = ${request.projectId}`]),
        ...(request.states === undefined ? [] : [sql.in("state", request.states)]),
      ])}
      ORDER BY created_at ASC, assignment_id ASC
    `,
  });

  const insertAssignment = SqlSchema.void({
    Request: AssignmentDbRow,
    execute: (row) => sql`
      INSERT INTO fd_assistant_assignments (
        assignment_id,
        project_id,
        executor,
        attempt,
        state,
        worker_refs_json,
        progress_json,
        evidence_json,
        created_at,
        updated_at
      )
      VALUES (
        ${row.assignmentId},
        ${row.projectId},
        ${row.executor},
        ${row.attempt},
        ${row.state},
        ${row.workerRefs},
        ${row.progress},
        ${row.evidence},
        ${row.createdAt},
        ${row.updatedAt}
      )
    `,
  });

  const updateAssignment = SqlSchema.void({
    Request: AssignmentDbRow,
    execute: (row) => sql`
      UPDATE fd_assistant_assignments SET
        attempt = ${row.attempt},
        state = ${row.state},
        worker_refs_json = ${row.workerRefs},
        progress_json = ${row.progress},
        evidence_json = ${row.evidence},
        updated_at = ${row.updatedAt}
      WHERE assignment_id = ${row.assignmentId}
    `,
  });

  const readBrief = (projectId: ProjectId) =>
    selectBriefs({ projectId }).pipe(
      Effect.map((rows) => Option.map(Option.fromUndefinedOr(rows[0]), toBrief)),
    );

  const readAssignment = (assignmentId: string) =>
    selectAssignments({ assignmentId }).pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0])));

  // Each write runs as one immediate transaction, so a read-decide-write cannot interleave
  // with another writer, in this process or another.
  const reviseBrief: PortfolioStore["Service"]["reviseBrief"] = (input) =>
    Effect.gen(function* () {
      const at = yield* now;
      const current = yield* readBrief(input.projectId);
      const { brief, revision } = Portfolio.reviseBrief(Option.getOrUndefined(current), {
        projectId: input.projectId,
        patch: input.patch,
        reason: input.reason ?? null,
        at,
      });
      if (revision === undefined) return brief;
      yield* upsertBrief(toBriefRow(brief));
      yield* insertRevision(revision);
      return brief;
    }).pipe(sql.withTransaction, mapError("reviseBrief"));

  const createAssignment: PortfolioStore["Service"]["createAssignment"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* readAssignment(input.assignmentId);
      if (Option.isSome(existing)) return existing.value;
      const at = yield* now;
      const assignment = Portfolio.newAssignment({ ...input, at });
      yield* insertAssignment(assignment);
      return assignment;
    }).pipe(sql.withTransaction, mapError("createAssignment"));

  const transitionAssignment: PortfolioStore["Service"]["transitionAssignment"] = (input) =>
    Effect.gen(function* () {
      const current = yield* readAssignment(input.assignmentId);
      if (Option.isNone(current)) {
        return yield* new AssignmentNotFound({ assignmentId: input.assignmentId });
      }
      const brief = yield* readBrief(current.value.projectId);
      const at = yield* now;
      const next = yield* Effect.fromResult(
        Portfolio.transitionAssignment(current.value, input.event, {
          executionAuthorized: Option.exists(brief, (value) => value.executionAuthorized),
          at,
        }),
      );
      yield* updateAssignment(next);
      return next;
    }).pipe(
      sql.withTransaction,
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.fail(new PortfolioStoreError({ operation: "transitionAssignment", cause })),
        SchemaError: (cause) =>
          Effect.fail(new PortfolioStoreError({ operation: "transitionAssignment", cause })),
      }),
    );

  return PortfolioStore.of({
    getBrief: (projectId) => readBrief(projectId).pipe(mapError("getBrief")),
    listBriefs: () =>
      selectBriefs({}).pipe(
        Effect.map((rows) => rows.map(toBrief)),
        mapError("listBriefs"),
      ),
    reviseBrief,
    listRevisions: (projectId) => selectRevisions({ projectId }).pipe(mapError("listRevisions")),
    createAssignment,
    getAssignment: (assignmentId) => readAssignment(assignmentId).pipe(mapError("getAssignment")),
    listAssignments: (filter) =>
      filter?.states?.length === 0
        ? Effect.succeed([])
        : selectAssignments({
            ...(filter?.projectId === undefined ? {} : { projectId: filter.projectId }),
            ...(filter?.states === undefined ? {} : { states: filter.states }),
          }).pipe(mapError("listAssignments")),
    transitionAssignment,
  });
});

export const layer = Layer.effect(PortfolioStore, make);
