import { IsoDateTime, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as Portfolio from "./portfolio.ts";

class PortfolioStoreError extends Schema.TaggedError<PortfolioStoreError>()("PortfolioStoreError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Assistant portfolio operation '${this.operation}' failed.`;
  }
}

/** A revise named a revision the brief has moved on from; nothing was written. */
export class BriefRevisionStale extends Schema.TaggedError<BriefRevisionStale>()(
  "BriefRevisionStale",
  { expected: Schema.Int, current: Schema.Int },
) {
  override get message(): string {
    return "This idea changed since you opened it, so your edit was not saved. Review what it says now and edit again.";
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
  ideaId: Schema.String,
  title: Schema.NullOr(Schema.String),
  conversationNotes: Schema.NullOr(StringList),
  decisions: StringList,
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

const toBrief = ({
  priorityRank,
  priorityReason,
  title,
  conversationNotes,
  ...row
}: BriefDbRow): Portfolio.ProjectBrief => ({
  ...row,
  ...(title === null ? {} : { title }),
  ...(conversationNotes === null ? {} : { conversationNotes }),
  priority: priorityRank === null ? null : { rank: priorityRank, reason: priorityReason ?? "" },
});

const toBriefRow = ({ priority, ...brief }: Portfolio.ProjectBrief): BriefDbRow => ({
  ...brief,
  title: brief.title ?? null,
  conversationNotes: brief.conversationNotes ?? null,
  ideaId: brief.ideaId ?? "legacy",
  decisions: brief.decisions ?? [],
  priorityRank: priority?.rank ?? null,
  priorityReason: priority?.reason ?? null,
});

/**
 * The assistant's durable, environment-local portfolio: independent idea briefs in each project, their
 * revision history, and assignments with their lifecycle. Lifecycle rules live in
 * `portfolio.ts`; this service applies them atomically against stored state.
 */
export class PortfolioStore extends Context.Service<
  PortfolioStore,
  {
    readonly getBrief: (
      projectId: ProjectId,
      ideaId?: string,
    ) => Effect.Effect<Option.Option<Portfolio.ProjectBrief>, PortfolioStoreError>;
    /**
     * A counter that rises once a revised brief's priority has committed: its value now, then each
     * move. It starts over with each server process, for whoever shows a queue rank to follow.
     */
    readonly priorityChanges: Stream.Stream<number>;
    /** Briefs in priority order; unranked projects last. */
    readonly listBriefs: () => Effect.Effect<
      ReadonlyArray<Portfolio.ProjectBrief>,
      PortfolioStoreError
    >;
    /**
     * Record the changed fields as one revision, creating the brief if needed. An unchanged
     * patch returns the stored brief and records nothing. With `expectedRevision`, a brief at any
     * other revision is refused and left as it is; a brief not yet saved stands at revision 0.
     */
    readonly reviseBrief: (input: {
      readonly projectId: ProjectId;
      readonly ideaId?: string;
      readonly patch: Portfolio.BriefPatch;
      readonly reason?: string | null;
      readonly expectedRevision?: number;
    }) => Effect.Effect<Portfolio.ProjectBrief, PortfolioStoreError | BriefRevisionStale>;
    /** Revisions oldest first, each with the previous and next value of every changed field. */
    readonly listRevisions: (
      projectId: ProjectId,
      ideaId?: string,
    ) => Effect.Effect<ReadonlyArray<Portfolio.BriefRevision>, PortfolioStoreError>;
    /**
     * Create a draft assignment. The caller's id is the idempotency key: reusing it returns
     * the stored assignment unchanged, so a retried request cannot add a duplicate.
     */
    readonly createAssignment: (input: {
      readonly assignmentId: string;
      readonly projectId: ProjectId;
      readonly ideaId?: string;
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
  const priorityEpoch = yield* SubscriptionRef.make(0);

  const mapError =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new PortfolioStoreError({ operation, cause })));

  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const selectBriefs = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: Schema.optional(ProjectId),
      ideaId: Schema.optional(Schema.String),
    }),
    Result: BriefDbRow,
    execute: ({ projectId, ideaId }) => sql`
      SELECT
        b.project_id AS "projectId",
        b.idea_id AS "ideaId",
        d.title,
        d.conversation_notes_json AS "conversationNotes",
        b.decisions_json AS decisions,
        b.goal,
        b.acceptance_criteria_json AS "acceptanceCriteria",
        b.constraints_json AS "constraints",
        b.priority_rank AS "priorityRank",
        b.priority_reason AS "priorityReason",
        b.open_questions_json AS "openQuestions",
        b.execution_authorized AS "executionAuthorized",
        b.revision,
        b.updated_at AS "updatedAt"
      FROM fd_assistant_project_briefs b
      LEFT JOIN fd_assistant_brief_details d
        ON d.project_id = b.project_id AND d.idea_id = b.idea_id
      WHERE ${sql.and([...(projectId === undefined ? [] : [sql`b.project_id = ${projectId}`]), ...(ideaId === undefined ? [] : [sql`b.idea_id = ${ideaId}`])])}
      ORDER BY b.priority_rank IS NULL, b.priority_rank, b.project_id
    `,
  });

  const upsertBrief = SqlSchema.void({
    Request: BriefDbRow,
    execute: (row) => sql`
      INSERT INTO fd_assistant_project_briefs (
        project_id,
        idea_id,
        decisions_json,
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
        ${row.ideaId},
        ${row.decisions},
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
      ON CONFLICT (project_id, idea_id) DO UPDATE SET
        decisions_json = excluded.decisions_json,
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

  /** Kept apart from the brief's row, whose table belongs to core's migrations. */
  const upsertDetails = SqlSchema.void({
    Request: BriefDbRow,
    execute: (row) => sql`
      INSERT INTO fd_assistant_brief_details (
        project_id,
        idea_id,
        title,
        conversation_notes_json
      )
      VALUES (${row.projectId}, ${row.ideaId}, ${row.title}, ${row.conversationNotes})
      ON CONFLICT (project_id, idea_id) DO UPDATE SET
        title = excluded.title,
        conversation_notes_json = excluded.conversation_notes_json
    `,
  });

  const selectRevisions = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId, ideaId: Schema.String }),
    Result: RevisionDbRow,
    execute: ({ projectId, ideaId }) => sql`
      SELECT
        project_id AS "projectId",
        idea_id AS "ideaId",
        revision,
        changes_json AS "changes",
        reason,
        recorded_at AS "recordedAt"
      FROM fd_assistant_brief_revisions
      WHERE project_id = ${projectId} AND idea_id = ${ideaId}
      ORDER BY revision ASC
    `,
  });

  const insertRevision = SqlSchema.void({
    Request: RevisionDbRow,
    execute: (row) => sql`
      INSERT INTO fd_assistant_brief_revisions (
        project_id,
        idea_id,
        revision,
        changes_json,
        reason,
        recorded_at
      )
      VALUES (${row.projectId}, ${row.ideaId ?? "legacy"}, ${row.revision}, ${row.changes}, ${row.reason}, ${row.recordedAt})
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
        idea_id AS "ideaId",
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
        idea_id,
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
        ${row.ideaId ?? "legacy"},
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

  const readBrief = (projectId: ProjectId, ideaId = "legacy") =>
    selectBriefs({ projectId, ideaId }).pipe(
      Effect.map((rows) => Option.map(Option.fromUndefinedOr(rows[0]), toBrief)),
    );

  const readAssignment = (assignmentId: string) =>
    selectAssignments({ assignmentId }).pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0])));

  // Each write runs as one immediate transaction, so a read-decide-write cannot interleave
  // with another writer, in this process or another.
  const reviseBrief: PortfolioStore["Service"]["reviseBrief"] = (input) =>
    // Committing and moving run together, as `FactoryChanges.transact` does, so an interrupt during
    // the commit cannot leave a rank that changed unannounced.
    Effect.uninterruptibleMask((restore) =>
      Effect.onExit(
        sql.withTransaction(
          restore(
            Effect.gen(function* () {
              const at = yield* now;
              const current = yield* readBrief(input.projectId, input.ideaId);
              const stored = Option.match(current, {
                onNone: () => 0,
                onSome: (brief) => brief.revision,
              });
              if (input.expectedRevision !== undefined && input.expectedRevision !== stored) {
                return yield* new BriefRevisionStale({
                  expected: input.expectedRevision,
                  current: stored,
                });
              }
              const { brief, revision } = Portfolio.reviseBrief(Option.getOrUndefined(current), {
                projectId: input.projectId,
                ideaId: input.ideaId ?? "legacy",
                patch: input.patch,
                reason: input.reason ?? null,
                at,
              });
              if (revision === undefined) return { brief, reranked: false };
              yield* upsertBrief(toBriefRow(brief));
              if (
                revision.changes.some(
                  ({ field }) => field === "title" || field === "conversationNotes",
                )
              ) {
                yield* upsertDetails(toBriefRow(brief));
              }
              yield* insertRevision(revision);
              return {
                brief,
                reranked: revision.changes.some(({ field }) => field === "priority"),
              };
            }),
          ),
        ),
        (exit) =>
          Exit.isSuccess(exit) && exit.value.reranked
            ? SubscriptionRef.update(priorityEpoch, (value) => value + 1)
            : Effect.void,
      ),
    ).pipe(
      Effect.map(({ brief }) => brief),
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.fail(new PortfolioStoreError({ operation: "reviseBrief", cause })),
        SchemaError: (cause) =>
          Effect.fail(new PortfolioStoreError({ operation: "reviseBrief", cause })),
      }),
    );

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
      const brief = yield* readBrief(current.value.projectId, current.value.ideaId);
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
    getBrief: (projectId, ideaId) => readBrief(projectId, ideaId).pipe(mapError("getBrief")),
    listBriefs: () =>
      selectBriefs({}).pipe(
        Effect.map((rows) => rows.map(toBrief)),
        mapError("listBriefs"),
      ),
    reviseBrief,
    priorityChanges: SubscriptionRef.changes(priorityEpoch),
    listRevisions: (projectId, ideaId = "legacy") =>
      selectRevisions({ projectId, ideaId }).pipe(mapError("listRevisions")),
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
