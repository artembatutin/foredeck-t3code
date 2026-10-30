// @effect-diagnostics nodeBuiltinImport:off -- the test hashes the brief as the assistant does.
import * as NodeCrypto from "node:crypto";

import { assert } from "@effect/vitest";
import {
  AuthWorkReadScope,
  AuthWorkWriteScope,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderThreadId,
  type RunId,
  RuntimeRequestId,
  ThreadId,
  type ThreadPullRequestLink,
  TurnItemId,
} from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import type { Caller } from "../../../mcp/threadAccess.ts";
import * as AutomaticTurnGate from "../../../orchestration-v2/AutomaticTurnGate.ts";
import * as DelegatedTaskQuestionReactor from "../../../orchestration-v2/DelegatedTaskQuestionReactor.ts";
import * as EventSink from "../../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerActivation from "../../../serverActivation.ts";
import {
  HandoffAdmission,
  HandoffBackend,
  ProjectAssistant,
  WorkCapture,
} from "../../assistant/index.ts";
import { type WorkActor, type WorkDomainError, WorkService } from "../../work-management/index.ts";
import * as Factory from "../index.ts";
// After Factory's entry: core's runtime cannot be the first module of its import cycle to load.
import * as UsageLimitRecoveryWorker from "../../../orchestration-v2/UsageLimitRecoveryWorker.ts";
import * as Scheduler from "../../../scheduling/Scheduler.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import {
  authorCommits,
  drainOrchestration,
  ended,
  runReached,
  stateOf,
  threadProjection,
  type World,
} from "./deliveryHarness.ts";
import { delegateFrom } from "./familyThreads.ts";
import { reviewPasses } from "./followThrough.ts";

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
  /** The thread the assignment's stored dispatch names, which the assistant's tick reads. */
  readonly dispatchThread: string;
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
      executor: "factory",
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
      dispatchThread: `assignment-thread-${managers}`,
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

/**
 * How many rows each record an agent's tool could write holds: every event and command core
 * committed, its queued effects, threads, messages, runs, tasks and requests, schedules,
 * Factory's deliveries, Work's links and the assistant's spoken replies, with every handoff row.
 * Equal before and after shows a call wrote nothing.
 */
export const writtenRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const counts: Record<string, number> = {};
  for (const table of [
    "orchestration_v2_events",
    "orchestration_v2_command_receipts",
    "orchestration_v2_effect_outbox",
    "orchestration_v2_projection_threads",
    "orchestration_v2_projection_messages",
    "orchestration_v2_projection_runs",
    "orchestration_v2_projection_subagents",
    "orchestration_v2_projection_runtime_requests",
    "scheduled_tasks",
    "fd_factory_deliveries",
    "fd_work_thread_links",
    "fd_assistant_spoken_replies",
  ]) {
    const [row] = yield* sql<{
      readonly count: number;
    }>`SELECT COUNT(*) AS count FROM ${sql(table)}`;
    counts[table] = row?.count ?? 0;
  }
  return { counts, handoff: yield* handoffRows };
}).pipe(Effect.orDie);

/**
 * Agent MCP messages sent from a family thread of the root, and asynchronous answers anywhere:
 * what a governed caller's refused tools would have left behind. A delegation's own prompt to its
 * child, which core names `message:delegated-task:<command>`, is the counted route, not a send.
 */
export const governedMessages = (root: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const factory = yield* Factory.FactoryService.FactoryService;
    const rows = yield* sql<{
      readonly message_id: string;
      readonly sender: string | null;
      readonly created_by: string | null;
      readonly source: string | null;
    }>`SELECT message_id, json_extract(payload_json, '$.senderThreadId') AS sender,
        json_extract(payload_json, '$.createdBy') AS created_by,
        json_extract(payload_json, '$.creationSource') AS source
      FROM orchestration_v2_projection_messages`;
    const found: Array<string> = [];
    for (const row of rows) {
      if (row.message_id.startsWith("async-answer:")) found.push(row.message_id);
      else if (row.message_id.startsWith("message:delegated-task:")) continue;
      else if (row.created_by === "agent" && row.source === "mcp" && row.sender !== null) {
        if ((yield* factory.familyRoot(row.sender as ThreadId)) === root)
          found.push(row.message_id);
      }
    }
    return found;
  }).pipe(Effect.orDie);

/** The project assistant's thread, which alone can queue and control its assignments. */
export const assistantThread = ThreadId.make("fd-assistant-owner");

/** The assistant thread's MCP caller, as `readCaller` builds it; only its scope and limits count. */
export const assistantCaller: Caller = {
  scope: {
    environmentId: EnvironmentId.make("environment"),
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
    requestNamespace: "test",
    thread: {
      threadId: assistantThread,
      providerSessionId: "session",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
  },
  threads: {} as Caller["threads"],
  caller: undefined,
  limits: { runtimeMode: "full-access", interactionMode: "default" },
};

/** Starts the project assistant's own thread, which an assignment's authority reads. */
export const startAssistantThread = (world: World) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = path.join(path.dirname(world.root), "assistant");
    yield* fileSystem.makeDirectory(folder, { recursive: true });
    return yield* world.ownerThreadAt(folder, "Plan with me.", assistantThread);
  }).pipe(Effect.orDie);

/**
 * An idea agreed, captured as a Work item through the assistant's real capture, and authorized,
 * as the owner does in that order. Returns the item.
 */
export const agreeAndCapture = (world: World, idea: string, kind: "single" | "parent" = "single") =>
  Effect.gen(function* () {
    const assistant = yield* ProjectAssistant.ProjectAssistant;
    const captures = yield* WorkCapture.WorkCapture;
    yield* assistant.revise({
      projectId: world.projectId,
      ideaId: idea,
      patch: {
        goal: `Deliver ${idea}`,
        acceptanceCriteria: [`Check ${idea}`],
      },
    });
    const { item } = yield* captures.capture({
      caller: assistantCaller,
      projectId: world.projectId,
      ideaId: idea,
      kind,
    });
    yield* assistant.revise({
      projectId: world.projectId,
      ideaId: idea,
      patch: { executionAuthorized: true },
    });
    return { sourceId: item.sourceId, itemId: item.itemId } satisfies WorkItemRef;
  }).pipe(Effect.orDie);

/** Queues the captured idea as a Factory assignment named after it. */
export const assignToFactory = (world: World, idea: string) =>
  Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistant) =>
    assistant.enqueue({
      assignmentId: idea,
      projectId: world.projectId,
      ideaId: idea,
      executor: "factory",
      managerThreadId: assistantThread,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      looperConfig: null,
    }),
  );

/** The assistant's control of an assignment, as its thread asks for it. */
export const controlAssignment = (
  assignmentId: string,
  action: "stop" | "resume" | "retry" | "cancel",
) =>
  Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistant) =>
    assistant.control({ assignmentId, managerThreadId: assistantThread, action }),
  );

export const tick = Effect.flatMap(
  ProjectAssistant.ProjectAssistant,
  (assistant) => assistant.tick,
);

/** The assignment's state, attempt and references as stored. */
export const assignmentOf = (assignmentId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{
      readonly state: string;
      readonly attempt: number;
      readonly worker_refs_json: string;
    }>`SELECT state, attempt, worker_refs_json FROM fd_assistant_assignments
      WHERE assignment_id = ${assignmentId}`,
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => rows[0] ?? assert.fail(`No assignment ${assignmentId}.`)),
  );

/** The assignment's link to its current root. */
export const linkOf = (assignmentId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{
      readonly delivery_id: string | null;
      readonly control: string;
    }>`SELECT delivery_id, control FROM fd_assistant_factory_links
      WHERE assignment_id = ${assignmentId}`,
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => rows[0] ?? assert.fail(`No link for ${assignmentId}.`)),
  );

/** The assignment's current root, as its link names it. */
export const rootIdOf = (assignmentId: string) =>
  Effect.map(
    linkOf(assignmentId),
    (link) =>
      (link.delivery_id ?? assert.fail(`${assignmentId} names no root.`)) as FactoryDeliveryId,
  );

export const managedRootOf = (root: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{
        readonly state: string;
        readonly reason: string | null;
      }>`SELECT state, reason FROM fd_assistant_managed_roots WHERE root_delivery_id = ${root}`,
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => rows[0]),
  );

export const queuePositionOf = (assignmentId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{
      readonly seq: number;
      readonly overtaken: number;
    }>`SELECT seq, overtaken FROM fd_assistant_queue_positions
      WHERE assignment_id = ${assignmentId}`,
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => rows[0]),
  );

/** Every outcome the grant history holds for the root, oldest first. */
export const grantOutcomesOf = (root: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{
      readonly kind: string;
      readonly outcome: string;
    }>`SELECT kind, outcome FROM fd_assistant_grant_history
      WHERE root_delivery_id = ${root} ORDER BY grant_number`,
  ).pipe(Effect.orDie);

/**
 * Counts every call of the assistant's Factory port and lets a test fail or replace them: `onStart`
 * is given the real start to run or not, and `failGet`, `failStop` and `failCancel` fail those
 * reads and calls as a storage failure would.
 */
export const spyOnFactoryPort = () => {
  const calls: Array<string> = [];
  /** Every thread the assistant asked to interrupt, through the thread service it alone sees. */
  const interrupted: Array<string> = [];
  const threads = (
    service: ThreadManagement.ThreadManagementService["Service"],
  ): ThreadManagement.ThreadManagementService["Service"] => ({
    ...service,
    interruptThread: (input) =>
      Effect.suspend(() => {
        interrupted.push(input.threadId);
        return service.interruptThread(input);
      }),
  });
  const control: {
    onStart:
      | ((
          input: { readonly deliveryId: string },
          start: ReturnType<typeof HandoffBackend.HandoffFactory.Service.start>,
        ) => ReturnType<typeof HandoffBackend.HandoffFactory.Service.start>)
      | undefined;
    failGet: boolean;
    failStop: boolean;
    failCancel: boolean;
    verifiesAnyway: boolean;
  } = {
    onStart: undefined,
    failGet: false,
    failStop: false,
    failCancel: false,
    verifiesAnyway: false,
  };
  const wrap = (
    service: typeof HandoffBackend.HandoffFactory.Service,
  ): typeof HandoffBackend.HandoffFactory.Service => ({
    ...service,
    verifyConfigured: (projectId) =>
      control.verifiesAnyway ? Effect.succeed(true) : service.verifyConfigured(projectId),
    get: (id) =>
      Effect.suspend(() => {
        calls.push(`get:${id}`);
        return control.failGet
          ? Effect.fail(new HandoffBackend.HandoffFactoryError({ operation: "get" }))
          : service.get(id);
      }),
    start: (input) =>
      Effect.suspend(() => {
        calls.push(`start:${input.deliveryId}`);
        return control.onStart === undefined
          ? service.start(input)
          : control.onStart(input, service.start(input));
      }),
    stop: (id) =>
      Effect.suspend(() => {
        calls.push(`stop:${id}`);
        return control.failStop
          ? Effect.fail(new HandoffBackend.HandoffFactoryError({ operation: "stop" }))
          : service.stop(id);
      }),
    resume: (id) =>
      Effect.suspend(() => {
        calls.push(`resume:${id}`);
        return service.resume(id);
      }),
    cancel: (id) =>
      Effect.suspend(() => {
        calls.push(`cancel:${id}`);
        return control.failCancel
          ? Effect.fail(new HandoffBackend.HandoffFactoryError({ operation: "cancel" }))
          : service.cancel(id);
      }),
  });
  const count = (operation: string) =>
    calls.filter((call) => call.startsWith(`${operation}:`)).length;
  return { calls, control, wrap, count, interrupted, threads };
};

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

/** The turn core's watch reactor presents for a wake of the linked, watched pull request. */
export const pullRequestWakeTurn = (
  threadId: ThreadId,
  link: ThreadPullRequestLink,
): AutomaticTurnGate.PullRequestWakeTurn => {
  const watch = link.watch ?? assert.fail(`Pull request #${link.number} is not watched.`);
  return {
    kind: "pull_request_wake",
    threadId,
    messageId: MessageId.make(`message:pr-watch:${fresh("wake")}`),
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
    const turn = pullRequestWakeTurn(threadId, link);
    const { messageId } = turn;
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

/**
 * Presents the turn to the gate with a dispatch that sends its message on the thread, as core's
 * producers do: a run counted under whatever the gate admitted it into. Returns the outcome.
 */
export const consultRunning = (
  world: World,
  turn: AutomaticTurnGate.AutomaticTurn,
  options: { readonly drop?: Effect.Effect<void> } = {},
) =>
  Effect.gen(function* () {
    const gate = yield* AutomaticTurnGate.AutomaticTurnGate;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const dispatch = threads
      .sendToThread({
        projectId: world.projectId,
        commandId: CommandId.make(`test-turn:${turn.messageId}`),
        threadId: turn.threadId,
        messageId: turn.messageId,
        text: "Carry on with the automatic turn.",
        attachments: [],
        mode: "queue",
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(Effect.orDie);
    return turn.kind === "background_wake"
      ? yield* gate.hand(turn, dispatch, options)
      : yield* gate.admit(turn, dispatch);
  });

/**
 * The delivery of an assignment claimed already, run to its open pull request: its author commits,
 * the server verifies, and its reviewer passes it. Returns the author's thread and the state.
 */
export const runToPullRequest = (world: World, root: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const author = yield* world.launched(root);
    yield* authorCommits(author.worktreePath, "feat: add the export button");
    yield* world.endRun(author.runId, "completed");
    yield* reviewPasses(world, root);
    const state = yield* stateOf(root);
    assert.strictEqual(state.status, "pr_open");
    return { ...author, state };
  }).pipe(Effect.orDie);

/** Nothing of the root holds capacity or waits: no slot, admission, demand or queue row. */
export const assertNothingHeld = (root: string, assignmentId: string) =>
  Effect.gen(function* () {
    assert.isUndefined(yield* slotOf(root), "slot");
    assert.deepStrictEqual(yield* admissionsOf(root), [], "admissions");
    assert.deepStrictEqual(yield* demandsOf(root), [], "demands");
    assert.isUndefined(yield* queuePositionOf(assignmentId), "queue position");
  });

/** The root's row, with when it was fenced: a root that went through ending has `ending_at`. */
export const rootRowOf = (root: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{
      readonly state: string;
      readonly reason: string | null;
      readonly ending_at: string | null;
      readonly retired_at: string | null;
    }>`SELECT state, reason, ending_at, retired_at FROM fd_assistant_managed_roots
      WHERE root_delivery_id = ${root}`,
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => rows[0] ?? assert.fail(`No root ${root}.`)),
  );

/**
 * Sees each automatic turn the admission decides, for a test to wait on the decision of a turn
 * core's worker presents by itself: pass `admission` as the harness's handoff option, and await
 * `decided` for the first decision of a kind and outcome, however early it came.
 */
export const decisionWatch = () => {
  const seen: Array<{ readonly kind: string; readonly type: string }> = [];
  const waiting: Array<{
    readonly kind: string;
    readonly type: string;
    readonly done: Deferred.Deferred<void>;
  }> = [];
  const presented: Array<string> = [];
  const finished: Array<string> = [];
  const finishing: Array<{ readonly messageId: string; readonly done: Deferred.Deferred<void> }> =
    [];
  return {
    admission: (
      service: HandoffAdmission.HandoffAdmission["Service"],
    ): HandoffAdmission.HandoffAdmission["Service"] => ({
      ...service,
      decideTurn: (input) =>
        Effect.tap(service.decideTurn(input), (decision) =>
          Effect.suspend(() => {
            const entry = { kind: input.turn.kind, type: decision.type };
            seen.push(entry);
            presented.push(input.turn.kind);
            return Effect.forEach(
              waiting.filter(({ kind, type }) => kind === entry.kind && type === entry.type),
              ({ done }) => Deferred.succeed(done, undefined),
              { discard: true },
            );
          }),
        ),
      // An admission marked dispatched: what the release pass waits for.
      markDispatched: service.markDispatched,
      dispatchAdmitted: ((decide, dispatch, options) =>
        Effect.tap(service.dispatchAdmitted(decide, dispatch, options), ({ decision }) =>
          Effect.suspend(() => {
            const admitted = decision.admitted;
            if (admitted === undefined) return Effect.void;
            finished.push(admitted.kind);
            return Effect.forEach(
              finishing.filter(({ messageId }) => messageId === admitted.kind),
              ({ done }) => Deferred.succeed(done, undefined),
              { discard: true },
            );
          }),
        )) as typeof service.dispatchAdmitted,
    }),
    /** How many times a turn of the kind was presented, across every rebuild. */
    presentations: (kind: string) =>
      Effect.sync(() => presented.filter((entry) => entry === kind).length),
    /** Waits for an admission of the kind (`automatic_turn`, say) to finish its dispatch. */
    dispatched: (kind: string) =>
      Effect.suspend(() => {
        if (finished.includes(kind)) return Effect.void;
        const done = Deferred.makeUnsafe<void>();
        finishing.push({ messageId: kind, done });
        return Deferred.await(done);
      }),
    /** Forgets what was decided, for a test to wait on a later decision of the same turn. */
    forget: Effect.sync(() => void seen.splice(0)),
    decided: (kind: string, type: string) =>
      Effect.suspend(() => {
        if (seen.some((entry) => entry.kind === kind && entry.type === type)) return Effect.void;
        const done = Deferred.makeUnsafe<void>();
        waiting.push({ kind, type, done });
        return Deferred.await(done);
      }),
  };
};

/**
 * A governed item at its open pull request and released, with the owner's turn running on its
 * thread: a task the owner delegated there has ended, and its result, admitted at the free head,
 * was steered into that turn. Then both slots go to others, and the turn ends before the steer
 * reaches its provider, so core's follow-up presents the result again. It waits, with no run.
 */
export const completionSteerFellBack = (
  world: World,
  watch: ReturnType<typeof decisionWatch>,
  opened: {
    readonly deliveryId: FactoryDeliveryId;
    readonly threadId: ThreadId;
  },
  managed: Pick<Managed, "root">,
) =>
  Effect.gen(function* () {
    const threadId = opened.threadId;
    const ownerRun = yield* world.ownerTurn(threadId, "Check the export before you merge.");
    const delegate = yield* delegateFrom(threadId, ownerRun, "user");
    yield* world.endRun(delegate.runId, "completed");
    yield* watch.decided("delegated_completion", "admitted");
    yield* watch.dispatched("automatic_turn");

    // Nothing of the result's own runs: the family is quiet, and its slot goes.
    yield* tick;
    assert.isUndefined(yield* slotOf(managed.root));
    const fillers = yield* fill(world, 2);
    const runs = (yield* runsOf(threadId)).length;

    const turn =
      world.provider.started.find((candidate) => candidate.runId === ownerRun) ??
      assert.fail("The owner's turn did not start.");
    yield* world.provider.endTurn(turn, "completed");
    yield* runReached(ownerRun, ["waiting", ...ended]);
    yield* drainOrchestration;
    yield* watch.decided("delegated_completion", "demand");

    const [demand] = yield* demandsOf(managed.root);
    assert.strictEqual(demand?.kind, "delegated_completion");
    assert.lengthOf(yield* demandsOf(managed.root), 1);
    const messageId = demand?.messageId ?? assert.fail("No completion waits.");
    assert.strictEqual((yield* runsOf(threadId)).length, runs);
    assert.isUndefined(yield* slotOf(managed.root));
    return { fillers, messageId, ownerRun, taskId: delegate.taskId };
  });

/** Fails core's effect outbox reads until the returned effect restores them, by hiding its table. */
export const failOutboxReads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_v2_effect_outbox RENAME TO hidden_effect_outbox`;
  return sql`ALTER TABLE hidden_effect_outbox RENAME TO orchestration_v2_effect_outbox`.pipe(
    Effect.asVoid,
    Effect.orDie,
  );
}).pipe(Effect.orDie);

/** The run the message started, once it exists: a turn core's worker sends by itself. */
export const runOfMessage = (messageId: string) =>
  Effect.flatMap(EventSink.EventSinkV2, (sink) =>
    sink.stream().pipe(
      Stream.filter(
        ({ event }) => event.type === "run.created" && event.payload.userMessageId === messageId,
      ),
      Stream.runHead,
      Effect.map((found) =>
        found._tag === "Some" && found.value.event.type === "run.created"
          ? found.value.event.payload.id
          : assert.fail(`No run of message ${messageId}.`),
      ),
    ),
  );

/** The thread's runs, as the projection holds them. */
export const runsOf = (threadId: ThreadId) =>
  threadProjection(threadId).pipe(
    Effect.map(({ runs }) => runs),
    Effect.orDie,
  );

/**
 * The owner, as their client reaches Work: every read past Work's cache and every edit of an item
 * is theirs, not the assistant's.
 */
const owner: WorkActor = {
  id: "session:owner",
  grants: [AuthWorkReadScope, AuthWorkWriteScope],
  label: "owner",
};

/** The owner renames the item through Work, which every later read sees. */
export const ownerEdits = (ref: WorkItemRef) =>
  Effect.gen(function* () {
    const work = yield* WorkService.WorkService;
    const item = yield* work.getItem(owner, { ref });
    yield* work.updateItem(owner, {
      ref,
      expectedRevision: item.revision,
      title: `${item.title}, and more`,
      body: item.body,
    });
  }).pipe(Effect.orDie);

/** Puts the item's title back as it was before `ownerEdits`, so it says what was authorized. */
export const ownerRestores = (ref: WorkItemRef) =>
  Effect.gen(function* () {
    const work = yield* WorkService.WorkService;
    const item = yield* work.getItem(owner, { ref });
    yield* work.updateItem(owner, {
      ref,
      expectedRevision: item.revision,
      title: item.title.replace(/, and more$/, ""),
      body: item.body,
    });
  }).pipe(Effect.orDie);

/** How many items the source holds, invalid ones included, read past Work's cache. */
export const itemCount = (world: World) =>
  Effect.gen(function* () {
    const work = yield* WorkService.WorkService;
    yield* work.refresh(owner, {});
    const { items } = yield* work.listItems(owner, {
      sourceId: world.itemRef.sourceId,
      limit: 100,
    });
    return items.length;
  }).pipe(Effect.orDie);

/** Stands in for Work's error, which only Work's own modules may construct. */
class FakeWorkUnavailable extends Schema.TaggedError<FakeWorkUnavailable>()("WorkUnavailable", {
  detail: Schema.String,
}) {}

/**
 * Work as the server runs it, whose reads for the assistant's admission and capture fail while
 * `failing.on`, as an unreachable source does. Everything else reads as usual.
 */
export const unreadableForAssistant =
  (failing: { on: boolean }) =>
  (service: WorkService.WorkService["Service"]): WorkService.WorkService["Service"] => ({
    ...service,
    getItem: (actor, input) =>
      failing.on && actor.id === "assistant:handoff"
        ? Effect.fail(
            new FakeWorkUnavailable({
              detail: "The source could not be reached.",
            }) as unknown as WorkDomainError,
          )
        : service.getItem(actor, input),
  });

/** A brief saved, its goal and criteria agreed, with nothing captured or authorized. */
export const agree = (world: World, idea: string) =>
  Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistant) =>
    assistant.revise({
      projectId: world.projectId,
      ideaId: idea,
      patch: { goal: `Deliver ${idea}`, acceptanceCriteria: [`Check ${idea}`] },
    }),
  ).pipe(Effect.orDie);

/** The assistant's capture of the idea's brief, as its thread asks for it. */
export const captureIdea = (world: World, idea: string, kind: "single" | "parent" = "single") =>
  Effect.flatMap(WorkCapture.WorkCapture, (captures) =>
    captures.capture({ caller: assistantCaller, projectId: world.projectId, ideaId: idea, kind }),
  );

/** The owner gives, or withdraws, the execution grant on the idea's brief. */
export const authorizeIdea = (world: World, idea: string, executionAuthorized = true) =>
  Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistant) =>
    assistant.revise({ projectId: world.projectId, ideaId: idea, patch: { executionAuthorized } }),
  ).pipe(Effect.orDie);

/** An idea captured, authorized, assigned and claimed by a tick; returns its root and item. */
export const claimIdea = (world: World, idea: string, kind: "single" | "parent" = "single") =>
  Effect.gen(function* () {
    const ref = yield* agreeAndCapture(world, idea, kind);
    yield* assignToFactory(world, idea);
    yield* tick;
    return { ref, root: yield* rootIdOf(idea) };
  });

/**
 * Two other real assignments, each claimed by a tick with its author's turn running, so both slots
 * are held by work that can end. Returns them for `freeOne`.
 */
export const occupyBoth = (world: World, prefix = "busy") =>
  Effect.gen(function* () {
    const held = [];
    for (const suffix of [1, 2]) {
      const idea = `${prefix}-${suffix}`;
      const { root } = yield* claimIdea(world, idea);
      held.push({ idea, root, author: yield* world.launched(root) });
    }
    return held;
  });

/** The other assignment's delivery runs to its open pull request, and a tick lets its slot go. */
export const freeOne = (world: World, other: { readonly root: FactoryDeliveryId }) =>
  Effect.gen(function* () {
    yield* runToPullRequest(world, other.root);
    yield* tick;
    assert.isUndefined(yield* slotOf(other.root));
  });

const ambiguousStart = () =>
  Effect.fail(new HandoffBackend.HandoffFactoryError({ operation: "start" }));

/**
 * A root's first start ends ambiguously with no row, and a stop then parks it: its delivery is
 * proven absent, and nothing of it holds capacity. `spy` is the world's Factory port.
 */
export const parkAbsent = (world: World, spy: ReturnType<typeof spyOnFactoryPort>, idea: string) =>
  Effect.gen(function* () {
    const ref = yield* agreeAndCapture(world, idea);
    yield* assignToFactory(world, idea);
    spy.control.onStart = ambiguousStart;
    yield* tick;
    spy.control.onStart = undefined;
    yield* controlAssignment(idea, "stop");
    assert.strictEqual((yield* assignmentOf(idea)).state, "stopped");
    return { ref, root: yield* rootIdOf(idea) };
  });

/** Stores the start's row and fails its step, as a crash right after the insert leaves it. */
export const failStartStep = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`CREATE TRIGGER handoff_start_step_fails BEFORE UPDATE ON fd_factory_deliveries
    WHEN OLD.status = 'queued'
    BEGIN SELECT RAISE(ABORT, 'held by the test'); END`,
).pipe(Effect.orDie);
export const restoreStartStep = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`DROP TRIGGER handoff_start_step_fails`,
).pipe(Effect.orDie);

/** The same park over a queued orphan: its row stored, and its start step never stored. */
export const parkOrphan = (world: World, idea: string) =>
  Effect.gen(function* () {
    const ref = yield* agreeAndCapture(world, idea);
    yield* assignToFactory(world, idea);
    yield* failStartStep;
    yield* tick;
    yield* controlAssignment(idea, "stop");
    yield* restoreStartStep;
    assert.strictEqual((yield* assignmentOf(idea)).state, "stopped");
    const root = yield* rootIdOf(idea);
    assert.strictEqual((yield* stateOf(root)).status, "queued");
    return { ref, root };
  });

/** The provider's question in the run's turn, once core stores it pending. */
export const askedOn = (world: World, runId: RunId, mode: "live" | "message") =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const turn =
      world.provider.started.find((candidate) => candidate.runId === runId) ??
      assert.fail(`No provider turn started run ${runId}.`);
    const requestId = yield* world.provider.ask(turn, mode);
    yield* sink.stream().pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "runtime-request.updated" &&
          event.payload.id === requestId &&
          event.payload.status === "pending",
      ),
      Stream.runHead,
    );
    yield* drainOrchestration;
    return requestId;
  }).pipe(Effect.orDie);

/** What the adapter was asked of a native offer: each offer it cleared, and each it dispatched. */
interface NativeOffers {
  readonly cleared: Array<string>;
  readonly dispatched: Array<string>;
}

export const nativeOffers = (): NativeOffers => ({ cleared: [], dispatched: [] });

let offered = 0;

/**
 * The provider's background work finishing outside a turn, offered on core's one continuation queue
 * the way its adapters offer it: `callbacks` as Codex does, whose offer can be dispatched only while
 * current and be cleared, and `plain` as Claude does, with neither. Returns the message the worker
 * runs it under when `messageId` is on; with it off the worker allocates one, as a Claude wake's.
 */
export const offerNative = (
  threadId: ThreadId,
  providerThreadId: ProviderThreadId,
  shape: "callbacks" | "plain",
  record: NativeOffers,
  options: { readonly messageId?: boolean } = {},
) =>
  Effect.gen(function* () {
    const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    offered += 1;
    const messageId = MessageId.make(`native-offer-${offered}`);
    yield* requests.offer({
      threadId,
      providerThreadId,
      driver,
      detail: null,
      ...(options.messageId === false ? {} : { messageId }),
      ...(shape === "callbacks"
        ? {
            dispatchIfCurrent: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.sync(() => void record.dispatched.push(messageId)).pipe(
                Effect.andThen(effect),
                Effect.asSome,
              ),
            clearIfCurrent: () => Effect.sync(() => void record.cleared.push(messageId)),
          }
        : {}),
    });
    return messageId;
  });

/**
 * Runs `body` with core's question reactor following the event log, as the server starts it: a
 * question its worker sees reaches the gate by itself. The rebuilt server of a restart starts one of
 * its own inside `world.rebuild`.
 */
export const withQuestionReactor = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const reactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
    yield* reactor.start();
    return yield* body;
  }).pipe(
    Effect.provide(
      DelegatedTaskQuestionReactor.layer.pipe(
        Layer.provideMerge(Layer.succeed(ServerActivation.ServerActivation, Effect.void)),
      ),
    ),
    Effect.scoped,
  );

/**
 * Core's usage-limit recovery worker, whose sweep the test runs as the scheduler would, over the
 * server's records and the automatic turn gate it consults, with resuming limited threads on.
 */
export const withLimitSweep = <A, E, R>(
  body: (sweep: Effect.Effect<void>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const registered = yield* Deferred.make<Effect.Effect<void>>();
    const worker = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Scheduler.Scheduler)({
            register: <SweepE, SweepR>(
              _name: string,
              runDueWork: Effect.Effect<void, SweepE, SweepR>,
            ) =>
              Effect.gen(function* () {
                const context = yield* Effect.context<SweepR>();
                yield* Deferred.succeed(
                  registered,
                  runDueWork.pipe(Effect.provideContext(context), Effect.orDie),
                );
              }),
          }),
          ServerSettings.layerTest({ autoResumeLimitedThreads: true }),
        ),
      ),
    );
    return yield* Effect.flatMap(Deferred.await(registered), body).pipe(Effect.provide(worker));
  });

/**
 * The run ended on a usage limit, reported as a provider reports it, with a reset that has already
 * passed since the run ended, so a sweep arms the recovery and the next finds its resume due.
 */
export const usageLimitFailure = (threadId: ThreadId, runId: RunId) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const { runs } = yield* threadProjection(threadId);
    const run = runs.find((candidate) => candidate.id === runId) ?? assert.fail("No such run.");
    const now = yield* DateTime.now;
    const completedAt = DateTime.subtract(now, { minutes: 2 });
    yield* sink.write({
      commandId: CommandId.make(`test-usage-limit:${runId}`),
      events: [
        {
          id: EventId.make(`test-usage-limit-run:${runId}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...run, status: "failed", completedAt },
        },
        {
          id: EventId.make(`test-usage-limit-error:${runId}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`test-usage-limit-error:${runId}`),
            type: "error",
            threadId,
            runId,
            nodeId: run.rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 99,
            status: "failed",
            title: "Usage limit reached",
            startedAt: completedAt,
            completedAt,
            updatedAt: completedAt,
            failure: {
              class: "usage_limit",
              message: "Plan limit reached.",
              code: "usageLimitExceeded",
              retryable: null,
              resetAt: DateTime.formatIso(DateTime.subtract(now, { minutes: 1 })),
            },
          },
        },
      ],
    });
    yield* drainOrchestration;
  }).pipe(Effect.orDie);

/** Holds whichever probe stage a test arms, once, until it lets go. */
export const makeRetirementProbe = Effect.gen(function* () {
  const gates = {
    released: { entered: yield* Deferred.make<void>(), go: yield* Deferred.make<void>() },
    observed: { entered: yield* Deferred.make<void>(), go: yield* Deferred.make<void>() },
    admitted: { entered: yield* Deferred.make<void>(), go: yield* Deferred.make<void>() },
  };
  const armed = { released: false, observed: false, admitted: false };
  const stage = (name: keyof typeof armed) =>
    Effect.suspend(() => {
      if (!armed[name]) return Effect.void;
      armed[name] = false;
      return Deferred.succeed(gates[name].entered, undefined).pipe(
        Effect.andThen(Deferred.await(gates[name].go)),
      );
    });
  const probe: typeof HandoffAdmission.HandoffAdmissionProbe.Service = {
    admitted: () => stage("admitted"),
    released: () => stage("released"),
    observed: () => stage("observed"),
  };
  // An admission's dispatch cannot be interrupted, so a failing test lets go of it to finish.
  const guarded = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    body.pipe(
      Effect.ensuring(
        Effect.forEach(Object.values(gates), ({ go }) => Deferred.succeed(go, undefined), {
          discard: true,
        }),
      ),
    );
  return { gates, armed, probe, guarded };
});

export type RetirementProbe = Effect.Success<typeof makeRetirementProbe>;

/** An assignment started, claimed and delivered to its open pull request, its slot let go. */
export const deliverIdea = (world: World, idea = "export") =>
  Effect.gen(function* () {
    yield* startAssistantThread(world);
    const { ref, root } = yield* claimIdea(world, idea);
    const opened = yield* runToPullRequest(world, root);
    yield* tick;
    assert.isUndefined(yield* slotOf(root));
    assert.strictEqual((yield* assignmentOf(idea)).state, "needs-input");
    return { ref, root, opened, thread: opened.threadId };
  });

/** The reviewer's thread of the delivery, and its latest run. */
export const reviewerOf = (root: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const { threads } = yield* stateOf(root);
    const thread = threads.reviewer ?? assert.fail("No reviewer ran.");
    const run = (yield* runsOf(thread)).at(-1) ?? assert.fail("The reviewer ran nothing.");
    return { thread, run: run.id };
  });

/** The thread's runs of the message: one, once it ran, however often it was presented. */
export const runsOfMessage = (threadId: ThreadId, messageId: string) =>
  Effect.map(runsOf(threadId), (runs) => runs.filter((run) => run.userMessageId === messageId));

/**
 * One turn of every automatic kind, on the threads of a delivery that never existed: each native
 * wake of its own provider thread, so each keeps a disposition of its own.
 */
export const turnsWithoutThreads = (label: string) => {
  const thread = ThreadId.make("factory-thread:missing:1");
  const run = `run-${label}` as RunId;
  const providerThread = (suffix: string) => `${label}-provider-${suffix}` as ProviderThreadId;
  return [
    pullRequestWakeTurn(thread, {
      host: "github.com",
      repository: "acme/alpha",
      number: 7,
      url: `https://github.com/acme/alpha/pull/7-${label}`,
      watch: { startedAt: "2026-10-30T12:00:00.000Z", failedChecks: [] },
    } as unknown as ThreadPullRequestLink),
    turns.usageLimitResume(thread, run),
    turns.delegatedQuestion(thread, { childThreadId: thread, taskId: questionTask }, run),
    turns.delegatedCompletion(thread, run, providerThread("completion")),
    turns.backgroundWake(thread, providerThread("clearable"), true),
    turns.backgroundWake(thread, providerThread("plain"), false),
  ];
};

/** What a native wake's offer gives the admission to keep: a drop only if it can be cleared. */
export const keptFor = (turn: AutomaticTurnGate.AutomaticTurn, dropped: Array<string>) =>
  turn.kind === "background_wake"
    ? {
        kept: {
          dispatch: Effect.die("A failed root's wake never runs."),
          ...(turn.clearable ? { drop: Effect.sync(() => void dropped.push(turn.messageId)) } : {}),
        },
      }
    : {};

/**
 * Sees each consult of the gate end, for a test to wait on all of a turn's decision, a declined
 * wake's clear included: pass `gateConsults` as the harness's option, and await `ended` by message.
 */
export const consultWatch = () => {
  const done: Array<string> = [];
  const waiting: Array<{ readonly messageId: string; readonly done: Deferred.Deferred<void> }> = [];
  return {
    gateConsults: (turn: AutomaticTurnGate.AutomaticTurn): Effect.Effect<void> =>
      Effect.suspend(() => {
        done.push(turn.messageId);
        return Effect.forEach(
          waiting.filter(({ messageId }) => messageId === turn.messageId),
          (entry) => Deferred.succeed(entry.done, undefined),
          { discard: true },
        );
      }),
    ended: (messageId: string) =>
      Effect.suspend(() => {
        if (done.includes(messageId)) return Effect.void;
        const entry = { messageId, done: Deferred.makeUnsafe<void>() };
        waiting.push(entry);
        return Deferred.await(entry.done);
      }),
  };
};
