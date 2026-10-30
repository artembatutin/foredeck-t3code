// @effect-diagnostics nodeBuiltinImport:off -- the test hashes the brief as the assistant does.
import * as NodeCrypto from "node:crypto";

import { assert } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  type ProviderThreadId,
  type RunId,
  RuntimeRequestId,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AutomaticTurnGate from "../../../orchestration-v2/AutomaticTurnGate.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import { HandoffAdmission, HandoffBackend, ProjectAssistant } from "../../assistant/index.ts";
import { drainOrchestration, threadProjection, type World } from "./deliveryHarness.ts";

/**
 * Factory deliveries the project assistant manages, on the delivery harness built with its
 * admission (`handoff`): rows seeded as the assistant's enqueue and claim write them, and
 * automatic turns presented to the gate the way core's producers present them.
 */

export const driver = ProviderDriverKind.make("codex");

const at = "2026-10-29T12:00:00.000Z";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeProgress = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ text: Schema.String }))),
);

let managers = 0;

/** What a managed root was seeded with. */
export interface Managed {
  readonly root: FactoryDeliveryId;
  readonly assignmentId: string;
  readonly ideaId: string;
  readonly manager: ThreadId;
  /** The item's fingerprint the assistant authorized, as the root's link freezes it. */
  readonly fingerprint: string;
}

const takeSeq = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly next_seq: number }>`
    SELECT next_seq FROM fd_assistant_scheduler WHERE id = 1`;
  const seq = row?.next_seq ?? 1;
  yield* sql`UPDATE fd_assistant_scheduler SET next_seq = ${seq + 1} WHERE id = 1`;
  return seq;
});

const insertAssignment = (assignmentId: string, projectId: string, ideaId: string, state: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO fd_assistant_assignments ${sql.insert({
      assignment_id: assignmentId,
      project_id: projectId,
      idea_id: ideaId,
      executor: "foredeck",
      attempt: 1,
      state,
      worker_refs_json: "[]",
      progress_json: "[]",
      evidence_json: "[]",
      created_at: at,
      updated_at: at,
    })}`;
  });

/**
 * Makes the assistant manage the delivery `root` of the world's item: an authorized brief, the
 * item captured as it reads now, an assignment running under a manager thread of the owner's, its
 * link and its active managed root, holding a slot when `holding`.
 */
export const manage = (
  world: World,
  root: FactoryDeliveryId,
  options: {
    readonly holding?: boolean;
    readonly ideaId?: string;
    readonly state?: string;
    /** Queued at a fresh position and never claimed: no root and no delivery yet. */
    readonly unclaimed?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    managers += 1;
    const sql = yield* SqlClient.SqlClient;
    const assistant = yield* ProjectAssistant.ProjectAssistant;
    const backend = yield* HandoffBackend.HandoffBackend;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const ideaId = options.ideaId ?? `idea-${managers}`;
    const assignmentId = `assignment-${managers}`;
    yield* assistant.revise({
      projectId: world.projectId,
      ideaId,
      patch: {
        goal: world.itemTitle,
        acceptanceCriteria: ["The export button exports the visible rows."],
        executionAuthorized: true,
      },
    });
    const { workerBrief, briefs } = yield* assistant.inspect(world.projectId, ideaId);
    const scopeHash = NodeCrypto.createHash("sha256")
      .update(workerBrief ?? assert.fail("The brief was not saved."))
      .digest("hex");
    const item = yield* backend.read(world.itemRef);
    const folder = path.join(path.dirname(world.root), `manager-${managers}`);
    yield* fileSystem.makeDirectory(folder, { recursive: true });
    const manager = yield* world.ownerThreadAt(folder, "Plan the export with me.");
    const unclaimed = options.unclaimed === true;
    yield* insertAssignment(
      assignmentId,
      world.projectId,
      ideaId,
      unclaimed ? "queued" : (options.state ?? "running"),
    );
    yield* sql`INSERT INTO fd_assistant_work_captures ${sql.insert({
      project_id: world.projectId,
      idea_id: ideaId,
      capture_id: `cap-${managers}`,
      source_id: world.itemRef.sourceId,
      kind: "single",
      state: "captured",
      writer_instance_id: "writer",
      item_id: world.itemRef.itemId,
      item_key: world.itemKey,
      item_url: null,
      item_fingerprint: item.fingerprint,
      content_hash: "content",
      scope_hash: scopeHash,
      brief_revision: 1,
      updated_at: at,
    })}`;
    // The whole dispatch the assistant's enqueue stores, which its tick reads back.
    yield* sql`INSERT INTO fd_assistant_dispatches (assignment_id, payload_json)
      VALUES (${assignmentId}, ${encodeJson({
        assignmentId,
        managerThreadId: manager.threadId,
        brief: briefs[0] ?? assert.fail("The brief was not saved."),
        modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        threadId: `assignment-thread-${managers}`,
        commandId: `assignment:${managers}`,
        messageId: `assignment:${managers}`,
        runId: null,
        cancelRequested: false,
        resumeWorkspace: null,
        answeredRequestIds: [],
        lastProgress: "",
        lastNotice: "",
        looper: null,
        looperRunId: null,
        previousLooperRunId: null,
        history: [],
        looperConfig: null,
      })})`;
    yield* sql`INSERT INTO fd_assistant_factory_links ${sql.insert({
      assignment_id: assignmentId,
      capture_id: `cap-${managers}`,
      source_id: world.itemRef.sourceId,
      item_id: world.itemRef.itemId,
      kind: "single",
      scope_hash: scopeHash,
      item_fingerprint: item.fingerprint,
      runtime_mode: "full-access",
      delivery_id: unclaimed ? null : root,
      control: "none",
      created_at: at,
      updated_at: at,
    })}`;
    if (unclaimed) {
      yield* sql`INSERT INTO fd_assistant_queue_positions (assignment_id, seq, overtaken)
        VALUES (${assignmentId}, ${yield* takeSeq}, 0)`;
    } else {
      yield* sql`INSERT INTO fd_assistant_managed_roots ${sql.insert({
        root_delivery_id: root,
        assignment_id: assignmentId,
        attempt: 1,
        state: "active",
        created_at: at,
      })}`;
    }
    if (options.holding === true) {
      yield* sql`INSERT INTO fd_assistant_slots
        (root_delivery_id, assignment_id, state, entry_seq, granted_at)
        VALUES (${root}, ${assignmentId}, 'held', ${yield* takeSeq}, ${at})`;
    }
    return {
      root,
      assignmentId,
      ideaId,
      manager: manager.threadId,
      fingerprint: item.fingerprint,
    } satisfies Managed;
  }).pipe(Effect.orDie);

let fillers = 0;

/**
 * `count` other managed roots of the world's project, each holding a slot, so capacity is full
 * at two. Returns their roots.
 */
export const fill = (world: World, count: number) =>
  Effect.forEach(Array.from({ length: count }), () =>
    Effect.gen(function* () {
      fillers += 1;
      const sql = yield* SqlClient.SqlClient;
      const assignmentId = `filler-${fillers}`;
      const root = `root-filler-${fillers}`;
      yield* insertAssignment(assignmentId, world.projectId, assignmentId, "running");
      // A Factory assignment, counted by its slot alone.
      yield* sql`INSERT INTO fd_assistant_factory_links ${sql.insert({
        assignment_id: assignmentId,
        capture_id: `cap-${assignmentId}`,
        source_id: world.itemRef.sourceId,
        item_id: `item-${assignmentId}`,
        kind: "single",
        scope_hash: "filler",
        item_fingerprint: "filler",
        runtime_mode: "full-access",
        delivery_id: root,
        control: "none",
        created_at: at,
        updated_at: at,
      })}`;
      yield* sql`INSERT INTO fd_assistant_managed_roots ${sql.insert({
        root_delivery_id: root,
        assignment_id: assignmentId,
        attempt: 1,
        state: "active",
        created_at: at,
      })}`;
      yield* sql`INSERT INTO fd_assistant_slots
        (root_delivery_id, assignment_id, state, entry_seq, granted_at)
        VALUES (${root}, ${assignmentId}, 'held', ${yield* takeSeq}, ${at})`;
      return root;
    }).pipe(Effect.orDie),
  );

/** Releases a root's held slot at its current entry, as the release pass would once it idles. */
export const release = (root: string) =>
  Effect.gen(function* () {
    const admission = yield* HandoffAdmission.HandoffAdmission;
    const slot = yield* slotOf(root);
    if (slot === undefined) return assert.fail(`Root ${root} holds no slot.`);
    yield* admission.settleAdmissions(root, () => Effect.succeed("ended" as const));
    return yield* admission.release(root, slot.entry_seq);
  }).pipe(Effect.orDie);

/** Moves a root's management on, as a fence and a retirement do. */
export const endManagement = (root: string, state: "ending" | "retired") =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    state === "ending"
      ? sql`UPDATE fd_assistant_managed_roots SET state = 'ending', reason = 'cancelled',
          ending_at = ${at} WHERE root_delivery_id = ${root}`
      : sql`UPDATE fd_assistant_managed_roots SET state = 'retired', reason = 'cancelled',
          retired_at = ${at} WHERE root_delivery_id = ${root}`,
  ).pipe(Effect.orDie, Effect.asVoid);

export const slotOf = (root: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{
      readonly state: string;
      readonly entry_seq: number;
      readonly reserved_demand_id: number | null;
    }>`SELECT state, entry_seq, reserved_demand_id FROM fd_assistant_slots
      WHERE root_delivery_id = ${root}`,
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => rows[0]),
  );

export const admissionsOf = (root: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{
      readonly admission_id: string;
      readonly kind: string;
      readonly state: string;
    }>`SELECT admission_id, kind, state FROM fd_assistant_admissions
      WHERE root_delivery_id = ${root} ORDER BY created_at, admission_id`,
  ).pipe(Effect.orDie);

export const demandsOf = (root: string) =>
  Effect.flatMap(HandoffAdmission.HandoffAdmission, (admission) => admission.demands(root)).pipe(
    Effect.orDie,
  );

export const dispositionsOf = (root: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{
      readonly kind: string;
      readonly wake_key: string;
      readonly thread_id: string;
      readonly class: string;
      readonly outcome: string;
      readonly adapter_clear: string | null;
    }>`SELECT kind, wake_key, thread_id, class, outcome, adapter_clear FROM fd_assistant_dispositions
      WHERE root_delivery_id = ${root} ORDER BY kind, wake_key`,
  ).pipe(Effect.orDie);

/** The notices recorded on the assignment's progress. */
export const noticesOf = (assignmentId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{
        readonly progress_json: string;
      }>`SELECT progress_json FROM fd_assistant_assignments WHERE assignment_id = ${assignmentId}`,
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => decodeProgress(rows[0]?.progress_json ?? "[]").map(({ text }) => text)),
  );

/** Every handoff row, to compare steps that must change nothing. */
export const handoffRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables: Record<string, ReadonlyArray<unknown>> = {};
  for (const table of [
    "fd_assistant_managed_roots",
    "fd_assistant_admission_demands",
    "fd_assistant_slots",
    "fd_assistant_admissions",
    "fd_assistant_dispositions",
    "fd_assistant_grant_history",
  ])
    tables[table] = yield* sql`SELECT * FROM ${sql(table)} ORDER BY rowid`;
  return tables;
}).pipe(Effect.orDie);

/** The fresh read of the world's item a decision asks for, as the bridge takes it. */
export const freshRead = (world: World) =>
  Effect.flatMap(HandoffBackend.HandoffBackend, (backend) => backend.read(world.itemRef)).pipe(
    Effect.map((item): HandoffAdmission.WorkRead => ({
      type: "read",
      fingerprint: item.fingerprint,
      status: item.status,
    })),
    Effect.orElseSucceed((): HandoffAdmission.WorkRead => ({ type: "unreadable" })),
  );

let presented = 0;
const fresh = (prefix: string) => `${prefix}-${(presented += 1)}`;

/** Each producer's turn, as it presents it to the gate. */
export const turns = {
  restartContinuation: (
    threadId: ThreadId,
    sourceRunId: RunId,
  ): AutomaticTurnGate.RestartContinuationTurn => ({
    kind: "restart_continuation",
    threadId,
    messageId: MessageId.make(`message:restart-continuation:${sourceRunId}`),
    key: sourceRunId,
    sourceRunId,
    settled: false,
  }),
  usageLimitResume: (threadId: ThreadId, runId: RunId): AutomaticTurnGate.UsageLimitResumeTurn => {
    const id = `limit-resume:${runId}:${fresh("reset")}`;
    return {
      kind: "usage_limit_resume",
      threadId,
      messageId: MessageId.make(id),
      key: id,
      usageLimitContinuationOfRunId: runId,
    };
  },
  delegatedQuestion: (
    threadId: ThreadId,
    task: { readonly childThreadId: ThreadId; readonly taskId: NodeId },
    delegatingRunId: RunId | null,
  ): AutomaticTurnGate.DelegatedQuestionTurn => {
    const requestId = RuntimeRequestId.make(fresh("request"));
    return {
      kind: "delegated_question",
      threadId,
      messageId: MessageId.make(`message:delegated-task-question:${threadId}:${requestId}`),
      key: `${task.childThreadId}:${requestId}`,
      childThreadId: task.childThreadId,
      requestId,
      taskId: task.taskId,
      delegatingRunId,
    };
  },
  delegatedCompletion: (
    threadId: ThreadId,
    parentRunId: RunId,
    providerThreadId: ProviderThreadId,
  ): AutomaticTurnGate.DelegatedCompletionTurn => {
    const messageId = MessageId.make(fresh("delegated-completion"));
    return {
      kind: "delegated_completion",
      threadId,
      messageId,
      key: `${parentRunId}:1:${messageId}`,
      parentRunId,
      generation: 1,
      providerThreadId,
      driver,
      origin: "offer",
    };
  },
  backgroundWake: (
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    clearable = false,
  ): AutomaticTurnGate.BackgroundWakeTurn => {
    const messageId = MessageId.make(fresh("native-wake"));
    return {
      kind: "background_wake",
      threadId,
      messageId,
      key: messageId,
      providerThreadId,
      driver,
      clearable,
    };
  },
};

/** A task node named by the questions presented in these tests. */
export const questionTask = NodeId.make("node:delegated-task:asking");

/**
 * Presents the turn to the gate core's producers consult, with a dispatch that records it ran, and
 * a native wake's drop recording it was cleared.
 */
export const consult = (
  turn: AutomaticTurnGate.AutomaticTurn,
  record: { readonly ran: Array<string>; readonly dropped?: Array<string> },
) =>
  Effect.gen(function* () {
    const gate = yield* AutomaticTurnGate.AutomaticTurnGate;
    const dispatch = Effect.sync(() => void record.ran.push(turn.messageId));
    return turn.kind === "background_wake"
      ? yield* gate.hand(
          turn,
          dispatch,
          turn.clearable
            ? { drop: Effect.sync(() => void record.dropped?.push(turn.messageId)) }
            : {},
        )
      : yield* gate.admit(turn, dispatch);
  });

/**
 * Wakes the thread about its watched pull request as core's watch reactor does, through the
 * gate: one `thread.pull-request-watch.sync` recording failed checks and queuing the wake, which
 * runs only if the gate runs it. Returns the outcome and the wake's run when it ran.
 */
export const wakeThroughGate = (threadId: ThreadId, link: ThreadPullRequestLink) =>
  Effect.gen(function* () {
    const watch = link.watch ?? assert.fail(`Pull request #${link.number} is not watched.`);
    const messageId = MessageId.make(`message:pr-watch:${fresh("wake")}`);
    const turn: AutomaticTurnGate.PullRequestWakeTurn = {
      kind: "pull_request_wake",
      threadId,
      messageId,
      key: link.url,
      pullRequest: {
        host: link.host,
        repository: link.repository,
        number: link.number,
        url: link.url,
      },
      watchStartedAt: watch.startedAt,
      ending: null,
    };
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const gate = yield* AutomaticTurnGate.AutomaticTurnGate;
    const outcome = yield* gate.admit(
      turn,
      orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make(`server:pr-watch:${threadId}:${messageId}`),
        threadId,
        host: link.host,
        repository: link.repository,
        number: link.number,
        startedAt: watch.startedAt,
        watch: { ...watch, failedChecks: [...watch.failedChecks, `ci-${messageId}`] },
        wake: {
          messageId,
          text: `Update on pull request #${link.number} (${link.url}): checks failed.`,
          notification: {
            source: { kind: "monitor" },
            outcome: "failed",
            summary: `#${link.number}: checks failed`,
          },
        },
      }),
    );
    const runId =
      outcome._tag === "Ran"
        ? outcome.value.storedEvents.flatMap(({ event }) =>
            event.type === "run.created" ? [event.payload.id] : [],
          )[0]
        : undefined;
    yield* drainOrchestration;
    return { turn, outcome, runId };
  }).pipe(Effect.orDie);

/** The thread's runs, as the projection holds them. */
export const runsOf = (threadId: ThreadId) =>
  threadProjection(threadId).pipe(
    Effect.map(({ runs }) => runs),
    Effect.orDie,
  );
