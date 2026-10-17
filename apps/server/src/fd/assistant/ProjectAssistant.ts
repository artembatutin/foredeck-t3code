import * as ServerActivation from "../../serverActivation.ts";
import * as Clock from "effect/Clock";
import * as ProcessRunner from "../../processRunner.ts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import {
  CommandId,
  MessageId,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  type ProviderUserInputAnswers,
  type AssistantOverview,
  type SpokenReply,
} from "@t3tools/contracts";
import { isAssistantThread } from "@t3tools/shared/fd/assistant";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Launches from "../../orchestration-v2/ThreadLaunchService.ts";
import {
  DispatchModeLimit,
  exceededDispatchModeLimit,
} from "../../orchestration-v2/DispatchModeLimit.ts";
import * as Projects from "../../project/ProjectService.ts";
import * as Git from "../../vcs/GitVcsDriver.ts";
import * as Looper from "./Looper.ts";
import * as PortfolioStore from "./PortfolioStore.ts";
import * as Portfolio from "./portfolio.ts";
import { Dispatch, OCCUPIED_STATES } from "./dispatch.ts";

export class AssistantError extends Schema.TaggedError<AssistantError>()("AssistantError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.reason;
  }
}

export class ProjectAssistant extends Context.Service<
  ProjectAssistant,
  {
    readonly revise: (input: {
      projectId: ProjectId;
      ideaId?: string;
      patch: Portfolio.BriefPatch;
      reason?: string;
    }) => Effect.Effect<Portfolio.ProjectBrief, AssistantError>;
    readonly inspect: (
      projectId?: ProjectId,
      ideaId?: string,
    ) => Effect.Effect<
      {
        summary: string;
        workerBrief: string | null;
        briefs: ReadonlyArray<Portfolio.ProjectBrief>;
        assignments: ReadonlyArray<Portfolio.Assignment>;
        dispatches: ReadonlyArray<Dispatch>;
      },
      AssistantError
    >;
    readonly enqueue: (
      input: Omit<
        Dispatch,
        | "brief"
        | "threadId"
        | "commandId"
        | "messageId"
        | "runId"
        | "cancelRequested"
        | "lastNotice"
        | "lastProgress"
        | "answeredRequestIds"
        | "looper"
        | "looperRunId"
        | "previousLooperRunId"
        | "history"
        | "resumeWorkspace"
      > & { projectId: ProjectId; ideaId?: string },
    ) => Effect.Effect<Portfolio.Assignment, AssistantError>;
    readonly control: (input: {
      assignmentId: string;
      managerThreadId: ThreadId;
      action: "stop" | "resume" | "retry" | "cancel";
    }) => Effect.Effect<Portfolio.Assignment, AssistantError>;
    readonly answer: (input: {
      assignmentId: string;
      managerThreadId: ThreadId;
      requestId: RuntimeRequestId;
      answers: ProviderUserInputAnswers;
    }) => Effect.Effect<void, AssistantError>;
    readonly verify: (input: {
      assignmentId: string;
      managerThreadId: ThreadId;
      evidence: ReadonlyArray<string>;
    }) => Effect.Effect<Portfolio.Assignment, AssistantError>;
    readonly overview: Effect.Effect<AssistantOverview, AssistantError>;
    readonly saveSpeech: (threadId: ThreadId, text: string) => Effect.Effect<void, AssistantError>;
    readonly speech: (threadId: ThreadId) => Effect.Effect<typeof SpokenReply.Type, AssistantError>;
    readonly tick: Effect.Effect<void, AssistantError>;
  }
>()("t3/fd/assistant/ProjectAssistant") {}

const isAssistantError = Schema.is(AssistantError);
const encodeQuestions = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const failure = (reason: string) => new AssistantError({ reason });
const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      isAssistantError(cause)
        ? cause
        : new AssistantError({
            reason:
              "The assistant operation could not be completed; inspect the assignment before retrying.",
            cause,
          }),
    ),
  );

const make = Effect.gen(function* () {
  const store = yield* PortfolioStore.PortfolioStore;
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* Threads.ThreadManagementService;
  const launches = yield* Launches.ThreadLaunchService;
  const projects = yield* Projects.ProjectService;
  const git = yield* Git.GitVcsDriver;
  const looper = yield* Looper.Looper;
  const mutex = yield* Semaphore.make(1);
  const readDispatches = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ payload: Schema.fromJsonString(Dispatch) }),
    execute: () =>
      sql`SELECT payload_json AS payload FROM fd_assistant_dispatches ORDER BY assignment_id`,
  });
  const save = SqlSchema.void({
    Request: Schema.Struct({ payload: Schema.fromJsonString(Dispatch) }),
    execute: ({ payload }) => sql`INSERT INTO fd_assistant_dispatches (assignment_id, payload_json)
      VALUES (json_extract(${payload}, '$.assignmentId'), ${payload})
      ON CONFLICT (assignment_id) DO UPDATE SET payload_json = excluded.payload_json`,
  });
  const dispatches = () =>
    readDispatches(undefined).pipe(Effect.map((rows) => rows.map((row) => row.payload)));
  const assignment = Effect.fn(function* (id: string) {
    const value = yield* store.getAssignment(id);
    if (Option.isNone(value)) return yield* failure("Assignment not found.");
    return value.value;
  });
  const owned = Effect.fn(function* (id: string, manager: ThreadId) {
    const record = (yield* dispatches()).find((row) => row.assignmentId === id);
    if (!record || record.managerThreadId !== manager || !isAssistantThread(manager))
      return yield* failure("Only the assignment's project assistant can control this work.");
    const caller = yield* threads.getThreadShell(manager);
    if (!caller || exceededDispatchModeLimit(caller, record))
      return yield* failure("The assistant's current permissions do not cover this assignment.");
    return record;
  });
  const currentBrief = Effect.fn(function* (id: ProjectId, ideaId = "legacy") {
    const brief = yield* store.getBrief(id, ideaId);
    if (Option.isNone(brief)) return yield* failure("Agree and save a project brief first.");
    return brief.value;
  });
  const move = (id: string, event: Portfolio.AssignmentEvent) =>
    store.transitionAssignment({ assignmentId: id, event });
  const withLimits = <A, E, R>(record: Dispatch, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const callerLimit = yield* DispatchModeLimit;
      const limit =
        callerLimit === undefined
          ? record
          : {
              runtimeMode:
                exceededDispatchModeLimit(
                  { ...callerLimit, interactionMode: record.interactionMode },
                  record,
                ) === "runtime"
                  ? callerLimit.runtimeMode
                  : record.runtimeMode,
              interactionMode:
                callerLimit.interactionMode === "plan" || record.interactionMode === "plan"
                  ? ("plan" as const)
                  : ("default" as const),
              ...(callerLimit.refused ? { refused: callerLimit.refused } : {}),
            };
      return yield* effect.pipe(Effect.provideService(DispatchModeLimit, limit));
    });

  const notice = Effect.fn(function* (record: Dispatch, key: string, text: string) {
    if (record.lastNotice === key) return record;
    // A durable inbox is read on the owner's next turn and by the work panel. Never
    // inject a synthetic user message or start a manager turn for routine progress.
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* move(record.assignmentId, { type: "record-notice", note: text });
        const next = { ...record, lastNotice: key };
        yield* save({ payload: next });
        return next;
      }),
    );
  });

  const reconcile = Effect.fn(function* (initial: Dispatch) {
    let record = initial;
    let work = yield* assignment(record.assignmentId);
    if (
      ![
        ...OCCUPIED_STATES,
        "awaiting-verification",
        "failed",
        "stopped",
        "completed",
        "cancelled",
      ].includes(work.state)
    )
      return;
    if (
      ["awaiting-verification", "failed", "stopped", "completed", "cancelled"].includes(work.state)
    ) {
      yield* notice(
        record,
        `${work.state}:${work.attempt}`,
        `${work.state}. ${work.progress.at(-1)?.text ?? ""} Read this project's portfolio for worker references and evidence.`,
      );
      return;
    }
    if (record.looper) {
      const status = yield* looper.inspect(record.looper);
      if (!status || status.runId === record.previousLooperRunId) {
        if (work.state === "launching")
          work = yield* move(work.assignmentId, {
            type: "uncertain",
            note: "Looper launch not acknowledged. Inspect this runtime before retrying.",
          });
        yield* notice(
          record,
          `uncertain:${work.attempt}`,
          "Looper launch outcome is uncertain. Its slot remains occupied; inspect the saved runtime before taking action.",
        );
        return;
      }
      if (record.looperRunId && record.looperRunId !== status.runId)
        return yield* failure(
          "Looper run identity changed outside this assignment; inspect before continuing.",
        );
      if (!record.looperRunId) {
        record = { ...record, looperRunId: status.runId };
        yield* save({ payload: record });
      }
      if (work.state === "launching" || work.state === "launch-uncertain")
        work = yield* move(work.assignmentId, {
          type: "start",
          workerRefs: [{ kind: "looper-run", id: status.runId }],
        });
      const progress = `${status.runId}:${status.status}:${status.stage}:${status.lastError ?? ""}`;
      if (record.lastProgress !== progress) {
        yield* move(work.assignmentId, {
          type: "record-progress",
          note: `Looper ${status.status}, stage ${status.stage}. ${status.lastError ?? ""}`,
        });
        record = { ...record, lastProgress: progress };
        yield* save({ payload: record });
      }
      if (
        work.state === "stopping" &&
        !["completed", "blocked", "stopped", "error"].includes(status.status)
      )
        yield* looper.stop(record.looper!, status.runId);
      if (["completed", "blocked", "stopped", "error"].includes(status.status)) {
        if (work.state === "stopping") {
          work = yield* move(work.assignmentId, {
            type: "confirm-stopped",
            note: `Looper recorded ${status.status}.`,
          });
          if (record.cancelRequested) work = yield* move(work.assignmentId, { type: "cancel" });
        } else if (work.state === "running") {
          work = yield* move(
            work.assignmentId,
            status.status === "completed"
              ? {
                  type: "finish",
                  note: `Looper ended; inspect ${status.runDir} and task acceptance. Iterations completed does not mean the goal is complete.`,
                }
              : {
                  type: "fail",
                  note: `Looper recorded ${status.status}; inspect ${status.runDir}.`,
                },
          );
        }
      }
      const stale =
        (yield* Clock.currentTimeMillis) - Date.parse(status.updatedAt) > 60_000 &&
        work.state === "running";
      yield* notice(
        record,
        `${stale ? "stale" : work.state}:${work.attempt}`,
        stale
          ? "Looper heartbeat is stale. The assignment still holds its slot; no replacement was launched."
          : `Looper ${work.state}, exact run ${status.runId}. Inspect ${status.runDir} for verification and review evidence.`,
      );
      return;
    }
    const shell = yield* threads.getThreadShell(record.threadId);
    if (shell === null) {
      if (work.state === "launching")
        work = yield* move(work.assignmentId, {
          type: "uncertain",
          note: "Launch outcome is unknown. No automatic relaunch.",
        });
      if (work.state === "launch-uncertain")
        yield* notice(
          record,
          `uncertain:${work.attempt}`,
          "Launch outcome is uncertain. Inspect the recorded thread and receipt before taking action.",
        );
      return;
    }
    const projection = yield* threads.getThreadRecords(
      record.threadId,
      ["runs", "runtimeRequests", "turnItems", "nodes"],
      { turnItemTypes: ["user_input_request", "approval_request"] },
    );
    const original = record.runId
      ? projection.runs.find((run) => run.id === record.runId)
      : projection.runs.find((run) => run.userMessageId === record.messageId);
    if (!original) {
      if (work.state === "launching")
        yield* move(work.assignmentId, {
          type: "uncertain",
          note: "Thread exists, but acceptance of the initial message is unconfirmed.",
        });
      return;
    }
    // Follow only server-recorded restart continuations, never an unrelated user run.
    let run = original;
    for (const candidate of projection.runs.toSorted((a, b) => a.ordinal - b.ordinal)) {
      if (
        candidate.restartContinuationOfRunId === run.id ||
        (candidate.ordinal > run.ordinal &&
          record.answeredRequestIds.some((id) => candidate.userMessageId === `async-answer:${id}`))
      )
        run = candidate;
    }
    if (record.runId !== run.id) {
      record = { ...record, runId: run.id };
      yield* save({ payload: record });
    }
    if (
      ["running", "needs-input", "stopping"].includes(work.state) &&
      record.lastProgress !== `${run.id}:${run.status}`
    ) {
      yield* move(work.assignmentId, {
        type: "record-progress",
        note: `Worker run ${run.id}: ${run.status}.`,
        workerRefs: [{ kind: "run", id: run.id }],
      });
      record = { ...record, lastProgress: `${run.id}:${run.status}` };
      yield* save({ payload: record });
    }
    if (work.state === "launching" || work.state === "launch-uncertain") {
      work = yield* move(work.assignmentId, {
        type: "start",
        workerRefs: [
          { kind: "thread", id: record.threadId },
          { kind: "run", id: run.id },
        ],
        note: "Worker accepted the assignment.",
      });
    }
    if (work.state === "stopping" && !Threads.isTerminalRunStatus(run.status))
      yield* withLimits(
        record,
        threads.interruptThread({
          projectId: work.projectId,
          commandId: CommandId.make(`stop:${record.commandId}`),
          threadId: record.threadId,
          runId: run.id,
        }),
      );
    const pending = projection.runtimeRequests.filter(
      (request) =>
        request.status === "pending" &&
        projection.nodes.some((node) => node.id === request.nodeId && node.runId === run.id),
    );
    if (pending.length && (work.state === "running" || work.state === "needs-input")) {
      if (work.state === "running")
        work = yield* move(work.assignmentId, {
          type: "request-input",
          note: "Worker is waiting for owner input or permission.",
        });
      const question = projection.turnItems.find(
        (item) =>
          item.type === "user_input_request" &&
          pending.some((request) => request.id === item.requestId),
      );
      yield* notice(
        record,
        `question:${pending.map((request) => request.id).join(":")}`,
        question?.type === "user_input_request"
          ? `Owner question from thread ${record.threadId}: ${(yield* encodeQuestions(question.questions)).slice(0, 4000)}. Reply through assistant_answer with its exact request ID ${question.requestId}.`
          : `Worker ${record.threadId} needs a permission decision. Open that worker's approval UI; question tools cannot grant permission.`,
      );
      return;
    }
    if (work.state === "needs-input")
      work = yield* move(work.assignmentId, { type: "provide-input" });
    if (run.status === "completed" && work.state === "running") {
      work = yield* move(work.assignmentId, {
        type: "finish",
        note: "Worker turn completed. Inspect its final response and verify acceptance criteria before marking complete.",
      });
    } else if (
      Threads.isTerminalRunStatus(run.status) &&
      (work.state === "running" || work.state === "stopping")
    ) {
      if (work.state === "stopping") {
        work = yield* move(work.assignmentId, {
          type: "confirm-stopped",
          note: `Executor confirmed ${run.status}.`,
        });
        if (record.cancelRequested) work = yield* move(work.assignmentId, { type: "cancel" });
      } else {
        work = yield* move(work.assignmentId, {
          type: "fail",
          note: `Worker run ${run.id} ended ${run.status}; inspect before retrying.`,
        });
      }
    }
    if (
      ["awaiting-verification", "failed", "stopped", "completed", "cancelled"].includes(work.state)
    )
      yield* notice(
        record,
        `${work.state}:${work.attempt}`,
        `${work.state}; thread ${record.threadId}, run ${run.id}. Completion of a turn is not proof of testing, integration, or deployment.`,
      );
  });

  const launch = Effect.fn(function* (record: Dispatch) {
    const manager = yield* threads.getThreadShell(record.managerThreadId);
    if (
      !manager ||
      manager.deletedAt ||
      manager.archivedAt ||
      exceededDispatchModeLimit(manager, record)
    )
      return yield* failure(
        "The manager is unavailable or its permissions changed. Reauthorize before retrying.",
      );
    if (record.looper) {
      const runId = yield* looper.start(record.looper, record.previousLooperRunId !== null);
      yield* save({ payload: { ...record, looperRunId: runId } });
      return;
    }
    const project = yield* projects.getById(record.brief.projectId);
    if (Option.isNone(project) || project.value.deletedAt !== null)
      return yield* failure("The destination project is unavailable.");
    if ((project.value.repositories?.length ?? 0) > 1)
      return yield* failure(
        "Multi-repository projects currently cannot create isolated worktrees. Keep this assignment queued until an isolated workspace is available.",
      );
    const probe = yield* git.execute({
      operation: "assistant-workspace",
      cwd: project.value.workspaceRoot,
      args: ["rev-parse", "--is-inside-work-tree"],
      allowNonZeroExit: true,
    });
    if (probe.exitCode !== 0 && !probe.stderr.includes("not a git repository"))
      return yield* failure(
        "Cannot determine the project’s Git workspace. Resolve the Git error before retrying.",
      );
    const strategy: Launches.ThreadLaunchWorkspaceStrategy = record.resumeWorkspace
      ? {
          type: "existing_worktree",
          worktreePath: record.resumeWorkspace.worktreePath,
          ...(record.resumeWorkspace.branch ? { branch: record.resumeWorkspace.branch } : {}),
        }
      : probe.exitCode === 0
        ? {
            type: "worktree",
            baseRef: "HEAD",
            branch: `feature/assignment-${record.threadId.slice(-12)}`,
            startFromOrigin: false,
          }
        : { type: "root" };
    if (strategy.type === "worktree")
      yield* launches.checkWorktreeBase({
        projectId: project.value.id,
        workspaceStrategy: strategy,
      });
    return yield* withLimits(
      record,
      launches.launch({
        commandId: record.commandId,
        threadId: record.threadId,
        projectId: record.brief.projectId,
        title: record.brief.goal.slice(0, 100),
        modelSelection: record.modelSelection,
        runtimeMode: record.runtimeMode,
        interactionMode: record.interactionMode,
        workspaceStrategy: strategy,
        createdBy: "agent",
        creationSource: "mcp",
        initialMessage: {
          messageId: record.messageId,
          text:
            Portfolio.renderAssignmentBrief(record.brief) +
            (record.history.length
              ? `\n\nThis continues your project's previous attempt (${record.history.at(-1)!.threadId}), which ended ${record.history.at(-1)!.state}. Inspect retained changes before continuing. Previous evidence: ${record.history.at(-1)!.evidence.join("; ").slice(0, 2000)}`
              : "") +
            "\n\nWork only on this brief. Ask focused questions when blocked. Preserve permissions. Finish with acceptance-criterion evidence, commands and results, and remaining limitations. Distinguish implemented, tested, integrated and deployed. Do not launch other project assignments.",
          attachments: [],
        },
      }),
    );
  });

  const tick = protect(
    mutex.withPermit(
      Effect.gen(function* () {
        for (const record of yield* dispatches())
          yield* reconcile(record).pipe(
            Effect.catch((cause) => Effect.logWarning("Assistant reconciliation deferred", cause)),
          );

        while (true) {
          // Capacity and the claim commit together before any external launch. Unknown outcomes keep a slot.
          const next = yield* sql.withTransaction(
            Effect.gen(function* () {
              const active = yield* store.listAssignments({ states: OCCUPIED_STATES });
              if (active.length >= 2) return undefined;
              const records = yield* dispatches();
              const briefs = yield* store.listBriefs();
              const queued = yield* store.listAssignments({ states: ["queued"] });
              for (const brief of briefs) {
                if (
                  !brief.executionAuthorized ||
                  active.some(
                    (work) =>
                      work.projectId === brief.projectId &&
                      (work.ideaId ?? "legacy") === (brief.ideaId ?? "legacy"),
                  )
                )
                  continue;
                const work = queued.find(
                  (item) =>
                    item.projectId === brief.projectId &&
                    (item.ideaId ?? "legacy") === (brief.ideaId ?? "legacy"),
                );
                if (!work) continue;
                const record = records.find((item) => item.assignmentId === work.assignmentId);
                if (!record) continue;
                if (
                  Portfolio.renderAssignmentBrief(brief) !==
                  Portfolio.renderAssignmentBrief(record.brief)
                ) {
                  yield* move(work.assignmentId, {
                    type: "fail",
                    note: "The agreed scope changed after queuing. Authorize a new assignment with the updated brief.",
                  });
                  continue;
                }
                yield* move(work.assignmentId, { type: "claim" });
                return record;
              }
              return undefined;
            }),
          );
          if (!next) break;
          yield* launch(next).pipe(
            Effect.matchEffect({
              onFailure: (cause) =>
                isAssistantError(cause)
                  ? move(next.assignmentId, { type: "fail", note: cause.message }).pipe(
                      Effect.asVoid,
                    )
                  : move(next.assignmentId, {
                      type: "uncertain",
                      note: "Launch response failed. Reconcile the saved identity; do not blindly retry.",
                    }).pipe(Effect.asVoid),
              onSuccess: () => reconcile(next),
            }),
          );
        }
      }),
    ),
  );

  return ProjectAssistant.of({
    tick,
    overview: protect(
      Effect.gen(function* () {
        const briefs = yield* store.listBriefs();
        const records = yield* dispatches();
        const work = yield* store.listAssignments();
        return {
          ideas: briefs.map((brief) => ({
            projectId: brief.projectId,
            ideaId: brief.ideaId ?? "legacy",
            goal: brief.goal,
            brief: Portfolio.renderAssignmentBrief(brief),
            authorized: brief.executionAuthorized,
            priority: brief.priority?.rank ?? null,
            priorityReason: brief.priority?.reason ?? "",
          })),
          assignments: work.map((item) => {
            const record = records.find((r) => r.assignmentId === item.assignmentId);
            return {
              assignmentId: item.assignmentId,
              projectId: item.projectId,
              ideaId: item.ideaId ?? "legacy",
              state: item.state,
              attempt: item.attempt,
              goal: record?.brief.goal ?? item.assignmentId,
              brief: record
                ? Portfolio.renderAssignmentBrief(record.brief)
                : "Legacy assignment; inspect saved project history.",
              threadId: record && !record.looper ? record.threadId : null,
              runId: record?.runId ?? null,
              evidence: item.evidence,
              notice: item.progress.at(-1)?.text ?? "",
            };
          }),
        };
      }),
    ),
    saveSpeech: (threadId, text) =>
      protect(
        Effect.gen(function* () {
          const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
          const run = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
          if (!run || run.status !== "running")
            return yield* failure("No active run for this spoken answer.");
          yield* sql`INSERT INTO fd_assistant_spoken_replies (thread_id, run_id, text)
        VALUES (${threadId}, ${run.id}, ${text}) ON CONFLICT(thread_id, run_id) DO UPDATE SET text = excluded.text`;
        }),
      ),
    speech: (threadId) =>
      protect(
        Effect.gen(function* () {
          const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
          const run = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
          if (!run || run.status !== "completed") return null;
          const rows = yield* sql<{ text: string }>`SELECT text FROM fd_assistant_spoken_replies
        WHERE thread_id = ${threadId} AND run_id = ${run.id}`;
          return rows[0] ? { runId: run.id, text: rows[0].text } : null;
        }),
      ),
    inspect: (projectId, ideaId) =>
      protect(
        Effect.gen(function* () {
          const briefs = (yield* store.listBriefs()).filter(
            (brief) =>
              (!projectId || brief.projectId === projectId) &&
              (!ideaId || (brief.ideaId ?? "legacy") === ideaId),
          );
          const assignments = yield* store.listAssignments(projectId ? { projectId } : undefined);
          return {
            summary: Portfolio.renderManagerSummary(briefs, assignments),
            workerBrief: briefs.length === 1 ? Portfolio.renderAssignmentBrief(briefs[0]!) : null,
            briefs: projectId ? briefs : [],
            assignments: projectId
              ? assignments.filter((a) => !ideaId || (a.ideaId ?? "legacy") === ideaId)
              : [],
            dispatches: projectId
              ? (yield* dispatches()).filter(
                  (row) =>
                    row.brief.projectId === projectId &&
                    (!ideaId || (row.brief.ideaId ?? "legacy") === ideaId),
                )
              : [],
          };
        }),
      ),
    revise: (input) =>
      protect(
        Effect.gen(function* () {
          const project = yield* projects.getById(input.projectId);
          if (Option.isNone(project) || project.value.deletedAt !== null)
            return yield* failure("Choose a registered project before saving an idea.");
          return yield* store.reviseBrief(input);
        }),
      ),
    enqueue: (input) =>
      protect(
        mutex.withPermit(
          Effect.gen(function* () {
            const existing = yield* store.getAssignment(input.assignmentId);
            if (Option.isSome(existing)) {
              yield* owned(input.assignmentId, input.managerThreadId);
              if (
                existing.value.projectId !== input.projectId ||
                (existing.value.ideaId ?? "legacy") !== (input.ideaId ?? "legacy")
              )
                return yield* failure("This assignment ID belongs to another project.");
              return existing.value;
            }
            if (!isAssistantThread(input.managerThreadId))
              return yield* failure("Dispatch requires the project assistant.");
            const brief = yield* currentBrief(input.projectId, input.ideaId);
            if (
              !brief.executionAuthorized ||
              !brief.goal.trim() ||
              brief.acceptanceCriteria.length === 0
            )
              return yield* failure(
                "Save an agreed goal, acceptance criteria, and explicit execution authorization first.",
              );
            const project = yield* projects.getById(input.projectId);
            if (Option.isNone(project) || project.value.deletedAt !== null)
              return yield* failure("The destination project is unavailable.");
            if ((project.value.repositories?.length ?? 0) > 1)
              return yield* failure(
                "Multi-repository projects cannot currently create isolated worktrees. No worker was launched.",
              );
            if (
              input.looperConfig &&
              (input.runtimeMode !== "full-access" || input.interactionMode !== "default")
            )
              return yield* failure(
                "Looper's CLI requires explicit full-access execution; it cannot preserve supervised Foredeck permissions.",
              );
            const prepared = input.looperConfig
              ? yield* looper.prepare(
                  input.looperConfig,
                  project.value.workspaceRoot,
                  Portfolio.renderAssignmentBrief(brief),
                )
              : null;
            if (
              prepared &&
              (yield* dispatches()).some(
                (row) =>
                  row.looper?.runtimeDir === prepared.runtimeDir ||
                  row.looper?.worktree === prepared.worktree,
              )
            )
              return yield* failure(
                "This Looper runtime or worktree already belongs to an assignment.",
              );
            const threadId = ThreadId.make(yield* randomUuidV4);
            const record: Dispatch = {
              ...input,
              brief,
              threadId,
              commandId: CommandId.make(`assignment:${threadId}`),
              messageId: MessageId.make(`assignment:${threadId}`),
              runId: null,
              cancelRequested: false,
              lastNotice: "",
              lastProgress: "",
              answeredRequestIds: [],
              resumeWorkspace: null,
              looper: prepared,
              looperRunId: null,
              previousLooperRunId: null,
              history: [],
            };
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* store.createAssignment({
                  assignmentId: input.assignmentId,
                  projectId: input.projectId,
                  ideaId: input.ideaId ?? "legacy",
                  executor: input.looperConfig ? "looper" : "foredeck",
                });
                yield* save({ payload: record });
                return yield* move(input.assignmentId, { type: "queue" });
              }),
            );
          }),
        ),
      ),
    control: (input) =>
      protect(
        mutex.withPermit(
          Effect.gen(function* () {
            const record = yield* owned(input.assignmentId, input.managerThreadId);
            let work = yield* assignment(input.assignmentId);
            if (input.action === "stop" || input.action === "cancel") {
              if (
                input.action === "cancel" &&
                ["draft", "queued", "stopped", "failed", "awaiting-verification"].includes(
                  work.state,
                )
              )
                return yield* move(input.assignmentId, { type: "cancel" });
              if (work.state !== "stopping")
                work = yield* move(input.assignmentId, { type: "stop" });
              yield* save({ payload: { ...record, cancelRequested: input.action === "cancel" } });
              if (record.looper && record.looperRunId)
                yield* looper.stop(record.looper, record.looperRunId);
              else
                yield* withLimits(
                  record,
                  threads.interruptThread({
                    projectId: work.projectId,
                    commandId: CommandId.make(`stop:${record.commandId}`),
                    threadId: record.threadId,
                    ...(record.runId ? { runId: record.runId } : {}),
                  }),
                );
              return work;
            }
            // Resume/retry is a new attempt with a fresh context; previous attempt evidence stays in its thread.
            const previousThread = record.looper
              ? null
              : yield* threads.getThreadShell(record.threadId);
            const resumeWorkspace = previousThread?.worktreePath
              ? { worktreePath: previousThread.worktreePath, branch: previousThread.branch }
              : null;
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                const brief = yield* currentBrief(work.projectId, work.ideaId);
                if (
                  record.looper &&
                  Portfolio.renderAssignmentBrief(brief) !==
                    Portfolio.renderAssignmentBrief(record.brief)
                )
                  return yield* failure(
                    "Changed Looper scope needs a new configuration and assignment.",
                  );
                const next = yield* move(input.assignmentId, { type: input.action });
                const id = yield* randomUuidV4;
                yield* save({
                  payload: {
                    ...record,
                    brief,
                    threadId: ThreadId.make(id),
                    commandId: CommandId.make(`assignment:${id}`),
                    messageId: MessageId.make(`assignment:${id}`),
                    runId: null,
                    cancelRequested: false,
                    lastNotice: "",
                    lastProgress: "",
                    answeredRequestIds: [],
                    resumeWorkspace,
                    looperRunId: null,
                    previousLooperRunId: record.looperRunId,
                    history: [
                      ...record.history,
                      {
                        threadId: record.threadId,
                        runId: record.runId,
                        looperRunId: record.looperRunId,
                        brief: record.brief,
                        state: work.state,
                        attempt: work.attempt,
                        evidence: work.evidence,
                      },
                    ],
                  },
                });
                return next;
              }),
            );
          }),
        ),
      ),
    answer: (input) =>
      protect(
        mutex.withPermit(
          Effect.gen(function* () {
            const record = yield* owned(input.assignmentId, input.managerThreadId);
            const { runtimeRequests, nodes } = yield* threads.getThreadRecords(record.threadId, [
              "runtimeRequests",
              "nodes",
            ]);
            const request = runtimeRequests.find(
              (item) =>
                item.id === input.requestId &&
                nodes.some((node) => node.id === item.nodeId && node.runId === record.runId) &&
                item.kind === "user_input" &&
                (item.status === "pending" || item.status === "resolved"),
            );
            if (!request)
              return yield* failure(
                "This is not a pending question from this assignment. Permission approvals must use the worker approval UI.",
              );
            yield* save({
              payload: {
                ...record,
                answeredRequestIds: [...new Set([...record.answeredRequestIds, input.requestId])],
              },
            });
            yield* withLimits(
              record,
              threads.dispatch({
                type: "runtime-request.respond",
                threadId: record.threadId,
                requestId: input.requestId,
                commandId: CommandId.make(`answer:${input.requestId}`),
                answers: input.answers,
              }),
            );
          }),
        ),
      ),
    verify: (input) =>
      protect(
        mutex.withPermit(
          Effect.gen(function* () {
            yield* owned(input.assignmentId, input.managerThreadId);
            const work = yield* assignment(input.assignmentId);
            if (work.state !== "awaiting-verification")
              return yield* failure("Only a completed worker turn can be verified.");
            if (!input.evidence.length || input.evidence.some((item) => !item.trim()))
              return yield* failure(
                "Record evidence for the acceptance criteria before completing the assignment.",
              );
            return yield* move(input.assignmentId, { type: "complete", evidence: input.evidence });
          }),
        ),
      ),
  });
});

export const layer = Layer.effect(ProjectAssistant, make).pipe(Layer.provide(PortfolioStore.layer));
export const layerLive = layer.pipe(
  Layer.provide(Looper.layer.pipe(Layer.provide(ProcessRunner.layer))),
);
export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const assistant = yield* ProjectAssistant;
    yield* assistant.tick.pipe(
      Effect.catch((cause) => Effect.logWarning(cause.message)),
      Effect.repeat(Schedule.spaced("2 seconds")),
      ServerActivation.forkParked,
    );
  }),
);
