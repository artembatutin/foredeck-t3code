import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import type * as AutomaticTurnGate from "../../orchestration-v2/AutomaticTurnGate.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import type { ProjectRow } from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { v2PullRequestThread } from "../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as HandoffAdmission from "./HandoffAdmission.ts";
import * as PortfolioStore from "./PortfolioStore.ts";
import { type AssignmentState, briefScopeHash } from "./portfolio.ts";
import * as ProjectAssistant from "./ProjectAssistant.ts";

/**
 * The assistant's admission on its own tables over an in-memory database, with core's thread and
 * project reads stubbed by `world`. Assignments, captures, links and roots are seeded as the
 * assistant's enqueue and claim write them.
 */

const alpha = ProjectId.make("project-alpha");
const managerId = ThreadId.make("fd-assistant-owner");
const driver = ProviderDriverKind.make("codex");
const at = "2026-10-29T12:00:00.000Z";

interface World {
  readonly shells: Map<string, OrchestrationV2ThreadShell | null>;
  readonly projects: Map<string, ProjectRow>;
}

const managerShell = (runtimeMode: RuntimeMode, archivedAt: string | null = null) =>
  v2PullRequestThread({
    id: managerId,
    projectId: ProjectId.make("manager-workspace"),
    title: "Assistant",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "configured" },
    runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestUserMessageAt: null,
    createdAt: at,
    updatedAt: at,
    archivedAt,
    settledOverride: null,
    settledAt: null,
  });

const projectRow = (overrides: Partial<ProjectRow> = {}): ProjectRow => ({
  projectId: alpha,
  title: "Alpha",
  workspaceRoot: "/projects/alpha",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: at,
  updatedAt: at,
  deletedAt: null,
  ...overrides,
});

const makeWorld = (): World => ({
  shells: new Map([[managerId, managerShell("full-access")]]),
  projects: new Map([[alpha, projectRow()]]),
});

/** Core's reads as the world holds them. */
const coreReads = (world: World) =>
  Layer.mergeAll(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: (threadId) => Effect.succeed(world.shells.get(threadId) ?? null),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (projectId) => Effect.succeed(Option.fromUndefinedOr(world.projects.get(projectId))),
    }),
  );

type Probe = typeof HandoffAdmission.HandoffAdmissionProbe.Service;

const admissionLayer = (world: World, probe?: Probe) =>
  HandoffAdmission.layer.pipe(
    Layer.provide(coreReads(world)),
    Layer.provide(
      probe === undefined
        ? Layer.empty
        : Layer.succeed(HandoffAdmission.HandoffAdmissionProbe, probe),
    ),
  );

const database = ProjectAssistant.layerPersistence.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

/** Runs `body` with one admission instance over a fresh database. */
const withAdmission = <A, E>(
  body: (
    world: World,
  ) => Effect.Effect<
    A,
    E,
    HandoffAdmission.HandoffAdmission | PortfolioStore.PortfolioStore | SqlClient.SqlClient
  >,
  probe?: Probe,
) => {
  const world = makeWorld();
  return body(world).pipe(
    Effect.provide(admissionLayer(world, probe).pipe(Layer.provideMerge(database))),
  );
};

/** A second instance over the same database, as the next process would be. */
const anotherInstance = (world: World) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithMemoMap(
      admissionLayer(world),
      Layer.makeMemoMapUnsafe(),
      scope,
    );
    return Context.get(context, HandoffAdmission.HandoffAdmission);
  });

const service = HandoffAdmission.HandoffAdmission;

const sqlOf = Effect.service(SqlClient.SqlClient);

const takeSeq = Effect.gen(function* () {
  const sql = yield* sqlOf;
  const [row] = yield* sql<{ readonly next_seq: number }>`
    SELECT next_seq FROM fd_assistant_scheduler WHERE id = 1`;
  const seq = row?.next_seq ?? 1;
  yield* sql`UPDATE fd_assistant_scheduler SET next_seq = ${seq + 1} WHERE id = 1`;
  return seq;
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const fingerprintOf = (id: string) => `fingerprint-${id}`;
const freshRead = (id: string): HandoffAdmission.WorkRead => ({
  type: "read",
  fingerprint: fingerprintOf(id),
  status: "todo",
});

interface SeedOptions {
  readonly state?: AssignmentState;
  /** The root's id, when the assignment was claimed. */
  readonly root?: string;
  readonly rootState?: "active" | "ending" | "retired";
  readonly control?: "none" | "stop" | "cancel";
  /** A queue position, at a fresh position. */
  readonly queued?: boolean;
  readonly priority?: number;
  readonly slot?: "held";
  readonly runtimeMode?: RuntimeMode;
}

/**
 * One Factory assignment of idea `id`: an authorized brief, its captured item, the dispatch naming
 * the manager, the link and, as asked, its root, queue position and held slot.
 */
const seed = (id: string, options: SeedOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* sqlOf;
    const portfolio = yield* PortfolioStore.PortfolioStore;
    const brief = yield* portfolio.reviseBrief({
      projectId: alpha,
      ideaId: id,
      patch: {
        goal: `Deliver ${id}`,
        acceptanceCriteria: [`Check ${id}`],
        executionAuthorized: true,
        ...(options.priority === undefined
          ? {}
          : { priority: { rank: options.priority, reason: "Ranked" } }),
      },
    });
    yield* portfolio.createAssignment({
      assignmentId: id,
      projectId: alpha,
      ideaId: id,
      executor: "foredeck",
    });
    yield* sql`UPDATE fd_assistant_assignments SET state = ${options.state ?? "queued"}
      WHERE assignment_id = ${id}`;
    yield* sql`INSERT INTO fd_assistant_work_captures ${sql.insert({
      project_id: alpha,
      idea_id: id,
      capture_id: `cap-${id}`,
      source_id: "source-1",
      kind: "single",
      state: "captured",
      writer_instance_id: "writer",
      item_id: `item-${id}`,
      item_key: `fd-${id}`,
      item_url: null,
      item_fingerprint: fingerprintOf(id),
      content_hash: "content",
      scope_hash: briefScopeHash(brief),
      brief_revision: brief.revision,
      updated_at: at,
    })}`;
    yield* sql`INSERT INTO fd_assistant_dispatches (assignment_id, payload_json)
      VALUES (${id}, ${encodeJson({
        assignmentId: id,
        managerThreadId: managerId,
        interactionMode: "default",
      })})`;
    yield* sql`INSERT INTO fd_assistant_factory_links ${sql.insert({
      assignment_id: id,
      capture_id: `cap-${id}`,
      source_id: "source-1",
      item_id: `item-${id}`,
      kind: "single",
      scope_hash: briefScopeHash(brief),
      item_fingerprint: fingerprintOf(id),
      runtime_mode: options.runtimeMode ?? "full-access",
      delivery_id: options.root ?? null,
      control: options.control ?? "none",
      created_at: at,
      updated_at: at,
    })}`;
    if (options.root !== undefined) {
      const rootState = options.rootState ?? "active";
      yield* sql`INSERT INTO fd_assistant_managed_roots ${sql.insert({
        root_delivery_id: options.root,
        assignment_id: id,
        attempt: 1,
        state: rootState,
        reason: rootState === "active" ? null : "cancelled",
        ending_at: rootState === "ending" ? at : null,
        retired_at: rootState === "retired" ? at : null,
        created_at: at,
      })}`;
    }
    if (options.queued === true) {
      yield* sql`INSERT INTO fd_assistant_queue_positions (assignment_id, seq, overtaken)
        VALUES (${id}, ${yield* takeSeq}, 0)`;
    }
    if (options.slot === "held" && options.root !== undefined) {
      yield* sql`INSERT INTO fd_assistant_slots
        (root_delivery_id, assignment_id, state, entry_seq, granted_at)
        VALUES (${options.root}, ${id}, 'held', ${yield* takeSeq}, ${at})`;
    }
    return { id, root: options.root ?? null, work: freshRead(id) };
  }).pipe(Effect.orDie);

/** `count` other managed roots each holding a slot, filling capacity. */
const fill = (count: number, prefix = "other") =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => index + 1),
    (index) =>
      seed(`${prefix}-${index}`, {
        state: "running",
        root: `root-${prefix}-${index}`,
        slot: "held",
      }),
  );

const rows = (table: string) =>
  Effect.flatMap(
    sqlOf,
    (sql) => sql<Record<string, unknown>>`SELECT * FROM ${sql(table)} ORDER BY rowid`,
  ).pipe(Effect.orDie);
const slotOf = (root: string) =>
  Effect.flatMap(
    sqlOf,
    (sql) => sql<{
      readonly state: string;
      readonly entry_seq: number;
      readonly reserved_demand_id: number | null;
      readonly redelivered_by: string | null;
    }>`SELECT state, entry_seq, reserved_demand_id, redelivered_by FROM fd_assistant_slots
      WHERE root_delivery_id = ${root}`,
  ).pipe(
    Effect.orDie,
    Effect.map((found) => found[0]),
  );
const admissionsOf = (root: string) =>
  Effect.flatMap(
    sqlOf,
    (sql) => sql<{
      readonly admission_id: string;
      readonly kind: string;
      readonly state: string;
      readonly instance_id: string;
      readonly entry_seq: number;
    }>`SELECT admission_id, kind, state, instance_id, entry_seq FROM fd_assistant_admissions
      WHERE root_delivery_id = ${root} ORDER BY created_at, admission_id`,
  ).pipe(Effect.orDie);
const demandsOf = (root: string) =>
  Effect.flatMap(service, (admission) => admission.demands(root)).pipe(Effect.orDie);
const dispositionsOf = (root: string) =>
  Effect.flatMap(
    sqlOf,
    (sql) => sql<{
      readonly kind: string;
      readonly wake_key: string;
      readonly thread_id: string;
      readonly class: string;
      readonly outcome: string;
      readonly adapter_clear: string | null;
    }>`SELECT kind, wake_key, thread_id, class, outcome, adapter_clear FROM fd_assistant_dispositions
      WHERE root_delivery_id = ${root} ORDER BY recorded_at, kind, wake_key`,
  ).pipe(Effect.orDie);
const rootOf = (root: string) =>
  Effect.flatMap(
    sqlOf,
    (sql) =>
      sql<{
        readonly state: string;
        readonly reason: string | null;
      }>`SELECT state, reason FROM fd_assistant_managed_roots WHERE root_delivery_id = ${root}`,
  ).pipe(
    Effect.orDie,
    Effect.map((found) => found[0]),
  );
const linkOf = (assignmentId: string) =>
  Effect.flatMap(
    sqlOf,
    (sql) => sql<{
      readonly delivery_id: string | null;
      readonly control: string;
    }>`SELECT delivery_id, control FROM fd_assistant_factory_links
      WHERE assignment_id = ${assignmentId}`,
  ).pipe(
    Effect.orDie,
    Effect.map((found) => found[0]),
  );
const positionOf = (assignmentId: string) =>
  Effect.flatMap(
    sqlOf,
    (sql) =>
      sql<{
        readonly seq: number;
        readonly overtaken: number;
      }>`SELECT seq, overtaken FROM fd_assistant_queue_positions WHERE assignment_id = ${assignmentId}`,
  ).pipe(
    Effect.orDie,
    Effect.map((found) => found[0]),
  );
const assignmentOf = (assignmentId: string) =>
  Effect.flatMap(PortfolioStore.PortfolioStore, (store) => store.getAssignment(assignmentId)).pipe(
    Effect.orDie,
    Effect.map(Option.getOrThrow),
  );
const historyOf = (assignmentId: string) =>
  Effect.flatMap(
    sqlOf,
    (sql) => sql<{
      readonly kind: string;
      readonly outcome: string;
    }>`SELECT kind, outcome FROM fd_assistant_grant_history WHERE assignment_id = ${assignmentId}
      ORDER BY grant_number`,
  ).pipe(Effect.orDie);

/** Every handoff table's rows, to compare a step that must write nothing. */
const snapshot = Effect.gen(function* () {
  const tables: Record<string, ReadonlyArray<unknown>> = {};
  for (const table of [
    "fd_assistant_managed_roots",
    "fd_assistant_factory_links",
    "fd_assistant_queue_positions",
    "fd_assistant_admission_demands",
    "fd_assistant_slots",
    "fd_assistant_admissions",
    "fd_assistant_dispositions",
    "fd_assistant_grant_history",
    "fd_assistant_assignments",
    "fd_assistant_scheduler",
  ])
    tables[table] = yield* rows(table);
  return tables;
});

let presented = 0;
const fresh = (prefix: string) => `${prefix}-${(presented += 1)}`;

/** Each producer's turn, keyed as it presents it to the gate. */
const turns = {
  pullRequest: (threadId = "thread-a"): AutomaticTurnGate.PullRequestWakeTurn => ({
    kind: "pull_request_wake",
    threadId: ThreadId.make(threadId),
    messageId: MessageId.make(fresh("message:pr")),
    key: "https://example.test/pull/7",
    pullRequest: {
      host: "example.test",
      repository: "alpha",
      number: 7,
      url: "https://example.test/pull/7",
    },
    watchStartedAt: at,
    ending: null,
  }),
  continuation: (settled = false): AutomaticTurnGate.RestartContinuationTurn => {
    const runId = RunId.make(fresh("run"));
    return {
      kind: "restart_continuation",
      threadId: ThreadId.make("thread-a"),
      messageId: MessageId.make(`message:restart-continuation:${runId}`),
      key: runId,
      sourceRunId: runId,
      settled,
    };
  },
  limit: (): AutomaticTurnGate.UsageLimitResumeTurn => {
    const id = fresh("limit-resume");
    return {
      kind: "usage_limit_resume",
      threadId: ThreadId.make("thread-a"),
      messageId: MessageId.make(id),
      key: id,
      usageLimitContinuationOfRunId: RunId.make("run-limit"),
    };
  },
  question: (): AutomaticTurnGate.DelegatedQuestionTurn => {
    const requestId = RuntimeRequestId.make(fresh("request"));
    return {
      kind: "delegated_question",
      threadId: ThreadId.make("thread-a"),
      messageId: MessageId.make(`message:delegated-task-question:thread-a:${requestId}`),
      key: `thread-child:${requestId}`,
      childThreadId: ThreadId.make("thread-child"),
      requestId,
      taskId: NodeId.make("node-task"),
      delegatingRunId: RunId.make("run-delegating"),
    };
  },
  completion: (): AutomaticTurnGate.DelegatedCompletionTurn => {
    const messageId = MessageId.make(fresh("completion"));
    return {
      kind: "delegated_completion",
      threadId: ThreadId.make("thread-a"),
      messageId,
      key: `run-parent:1:${messageId}`,
      parentRunId: RunId.make("run-parent"),
      generation: 1,
      providerThreadId: ProviderThreadId.make("provider-thread-a"),
      driver,
      origin: "offer",
    };
  },
  native: (clearable = false): AutomaticTurnGate.BackgroundWakeTurn => {
    const messageId = MessageId.make(fresh("native"));
    return {
      kind: "background_wake",
      threadId: ThreadId.make("thread-a"),
      messageId,
      key: messageId,
      providerThreadId: ProviderThreadId.make("provider-thread-a"),
      driver,
      clearable,
    };
  },
};

/** The turns of every kind that can wait as a demand. */
const waitingKinds = () => [
  turns.pullRequest(),
  turns.limit(),
  turns.question(),
  turns.completion(),
  turns.native(),
];

/**
 * A gate decision as the bridge makes it: once, and again with `work` when it asked for a fresh
 * read; an admission runs its dispatch, recording that it ran. Counts the reads asked for.
 */
const decide = (
  input: {
    readonly root: string;
    readonly provenance?: HandoffAdmission.Provenance;
    readonly turn: AutomaticTurnGate.AutomaticTurn;
    readonly kept?: HandoffAdmission.KeptDispatch;
  },
  work: HandoffAdmission.WorkRead,
) =>
  Effect.gen(function* () {
    const admission = yield* service;
    let reads = 0;
    const ran: Array<string> = [];
    const once = (read: HandoffAdmission.WorkRead | undefined) =>
      admission.dispatchAdmitted(
        admission.decideTurn({
          root: input.root,
          provenance: input.provenance ?? "factory",
          turn: input.turn,
          ...(read === undefined ? {} : { work: read }),
          ...(input.kept === undefined ? {} : { kept: input.kept }),
        }),
        () => Effect.sync(() => void ran.push(input.turn.messageId)),
      );
    let { decision } = yield* once(undefined);
    if (decision.type === "needs_work") {
      reads += 1;
      ({ decision } = yield* once(work));
    }
    return { decision, reads, ran: ran.length > 0 };
  }).pipe(Effect.orDie);

/** An effect decision as the bridge makes it, counting the reads it asked for. */
const enter = (
  entry: {
    readonly root: string;
    readonly deliveryId?: string;
    readonly effectId: number;
    readonly fresh?: boolean;
  },
  work: HandoffAdmission.WorkRead,
) =>
  Effect.gen(function* () {
    const admission = yield* service;
    let reads = 0;
    const once = (read: HandoffAdmission.WorkRead | undefined) =>
      admission.dispatchAdmitted(
        admission.enter(
          {
            root: entry.root,
            deliveryId: entry.deliveryId ?? entry.root,
            effectId: entry.effectId,
            fresh: entry.fresh ?? true,
          },
          read,
        ),
        () => Effect.void,
      );
    let { decision } = yield* once(undefined);
    if (decision.type === "needs_work") {
      reads += 1;
      ({ decision } = yield* once(work));
    }
    return { decision, reads };
  }).pipe(Effect.orDie);

const delegate = (root: string, work: HandoffAdmission.WorkRead) =>
  Effect.flatMap(service, (admission) =>
    admission.admitDelegation({
      root,
      threadId: "thread-a",
      messageId: `mcp-delegation:${fresh("delegation")}`,
      work,
    }),
  ).pipe(Effect.orDie);

const quiescent: HandoffAdmission.Observation = {
  phase: "terminal",
  busy: false,
  deferred: false,
  unknown: false,
};

describe("decisions for never-managed and active roots", () => {
  it.effect("writes nothing and runs everything for a root it never claimed", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        const before = yield* snapshot;
        const entered = yield* admission
          .enter({ root: "never", deliveryId: "never", effectId: 1, fresh: true })
          .pipe(Effect.orDie);
        assert.deepStrictEqual(entered, { type: "proceed" });
        for (const turn of [...waitingKinds(), turns.continuation()]) {
          const { decision, reads } = yield* decide({ root: "never", turn }, freshRead("never"));
          assert.deepStrictEqual(decision, { type: "unmanaged" }, turn.kind);
          assert.strictEqual(reads, 0);
        }
        assert.strictEqual(yield* admission.management("never").pipe(Effect.orDie), "never");
        assert.deepStrictEqual(yield* snapshot, before);
      }),
    ),
  );

  it.effect("admits effects in the holding, at the free head, or keeps one demand", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        const held = yield* seed("held", { state: "running", root: "root-held", slot: "held" });
        const before = (yield* slotOf("root-held"))!.entry_seq;
        const proceed = yield* enter({ root: "root-held", effectId: 1 }, held.work);
        assert.strictEqual(proceed.decision.type, "proceed");
        assert.strictEqual(proceed.reads, 1);
        // An effect that needs no fresh read reads nothing.
        const settle = yield* enter({ root: "root-held", effectId: 2, fresh: false }, held.work);
        assert.strictEqual(settle.reads, 0);
        const after = yield* slotOf("root-held");
        assert.isAbove(after!.entry_seq, before);
        const rowsHeld = yield* admissionsOf("root-held");
        assert.deepStrictEqual(
          rowsHeld.map(({ kind, state }) => [kind, state]),
          [
            ["effect", "dispatched"],
            ["effect", "dispatched"],
          ],
        );

        // No slot, capacity free, nobody waiting: granted at the head.
        const free = yield* seed("free", { state: "running", root: "root-free" });
        const granted = yield* enter({ root: "root-free", effectId: 1 }, free.work);
        assert.strictEqual(granted.decision.type, "proceed");
        assert.strictEqual((yield* slotOf("root-free"))?.state, "held");
        assert.lengthOf(yield* admissionsOf("root-free"), 1);
        assert.deepStrictEqual(
          (yield* historyOf("free")).map(({ outcome }) => outcome),
          ["granted"],
        );

        // Capacity full: one demand, which keeps its position when asked again.
        const waiting = yield* seed("waiting", { state: "running", root: "root-waiting" });
        const deferred = yield* enter({ root: "root-waiting", effectId: 3 }, waiting.work);
        assert.deepStrictEqual(deferred, { decision: { type: "defer" }, reads: 0 });
        const [demand] = yield* demandsOf("root-waiting");
        assert.strictEqual(demand?.kind, "effect");
        assert.strictEqual(demand?.effectId, 3);
        const again = yield* enter({ root: "root-waiting", effectId: 3 }, waiting.work);
        assert.deepStrictEqual(again, { decision: { type: "defer" }, reads: 0 });
        assert.deepStrictEqual(yield* demandsOf("root-waiting"), [demand!]);
        assert.isTrue(
          yield* admission
            .deferredDemand({ root: "root-waiting", deliveryId: "root-waiting", effectId: 3 })
            .pipe(Effect.orDie),
        );
        assert.lengthOf(yield* admissionsOf("root-waiting"), 0);
        assert.isUndefined(yield* slotOf("root-waiting"));
      }),
    ),
  );

  it.effect("converts a reservation for its own effect and returns the reserved demand", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        const subject = yield* seed("subject", { state: "running", root: "root-s" });
        yield* fill(1);
        const wake = turns.pullRequest();
        // Waits: the other root holds one slot, but its PR wake is the head with one slot free.
        yield* fill(1, "busy");
        const parked = yield* decide({ root: "root-s", turn: wake }, subject.work);
        assert.strictEqual(parked.decision.type, "demand");
        yield* admission
          .release("root-busy-1", (yield* slotOf("root-busy-1"))!.entry_seq)
          .pipe(Effect.orDie);
        const [demand] = yield* demandsOf("root-s");
        const reserved = yield* admission.reserve(demand!.id, subject.work).pipe(Effect.orDie);
        assert.strictEqual(reserved.type, "reserved");
        assert.strictEqual((yield* slotOf("root-s"))?.state, "reserved");
        const seqBefore = demand!.seq;
        const proceed = yield* enter({ root: "root-s", effectId: 1 }, subject.work);
        assert.strictEqual(proceed.decision.type, "proceed");
        assert.strictEqual((yield* slotOf("root-s"))?.state, "held");
        const [back] = yield* demandsOf("root-s");
        assert.strictEqual(back?.state, "waiting");
        assert.isAbove(back!.seq, seqBefore);
        assert.lengthOf(yield* admissionsOf("root-s"), 1);
      }),
    ),
  );

  it.effect("follows the automatic turn table row for row", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        const held = yield* seed("held", { state: "running", root: "root-held", slot: "held" });
        // Held: Factory's continuation and question admit in the holding; an unknown
        // continuation declines and an unknown question waits; every other kind waits.
        const heldCases: ReadonlyArray<
          readonly [AutomaticTurnGate.AutomaticTurn, HandoffAdmission.Provenance, string]
        > = [
          [turns.continuation(true), "factory", "declined"],
          [turns.continuation(), "factory", "admitted"],
          [turns.continuation(), "unknown", "declined"],
          [turns.question(), "factory", "admitted"],
          [turns.question(), "unknown", "demand"],
          [turns.pullRequest(), "factory", "demand"],
          [turns.limit(), "factory", "demand"],
          [turns.completion(), "factory", "demand"],
          [turns.completion(), "unknown", "demand"],
          [turns.native(), "factory", "demand"],
          [turns.native(), "unknown", "demand"],
        ];
        for (const [turn, provenance, expected] of heldCases) {
          const admissions = (yield* admissionsOf("root-held")).length;
          const { decision, ran } = yield* decide(
            { root: "root-held", provenance, turn },
            held.work,
          );
          assert.strictEqual(decision.type, expected, `${turn.kind} ${provenance}`);
          assert.strictEqual(ran, expected === "admitted");
          assert.strictEqual(
            (yield* admissionsOf("root-held")).length,
            admissions + (expected === "admitted" ? 1 : 0),
          );
        }
        assert.lengthOf(yield* demandsOf("root-held"), 7);

        // Free and at the head with no slot: every kind is granted a held slot and admitted.
        for (const make of [
          () => turns.continuation(),
          turns.pullRequest,
          turns.limit,
          turns.question,
          turns.completion,
          () => turns.native(),
        ]) {
          const turn = make();
          const id = fresh("head");
          const subject = yield* seed(id, { state: "running", root: `root-${id}` });
          const { decision } = yield* decide(
            { root: `root-${id}`, provenance: "unknown", turn },
            subject.work,
          );
          assert.strictEqual(decision.type, "admitted", turn.kind);
          assert.strictEqual((yield* slotOf(`root-${id}`))?.state, "held");
          assert.lengthOf(yield* admissionsOf(`root-${id}`), 1);
          yield* admission
            .release(`root-${id}`, (yield* slotOf(`root-${id}`))!.entry_seq)
            .pipe(Effect.orDie);
        }

        // Full: a continuation declines with no demand; every other kind waits as one.
        yield* fill(1, "full");
        const full = yield* seed("full", { state: "running", root: "root-full" });
        const declined = yield* decide(
          { root: "root-full", turn: turns.continuation() },
          full.work,
        );
        assert.strictEqual(declined.decision.type, "declined");
        assert.lengthOf(yield* demandsOf("root-full"), 0);
        for (const turn of waitingKinds()) {
          const { decision, reads } = yield* decide({ root: "root-full", turn }, full.work);
          assert.strictEqual(decision.type, "demand", turn.kind);
          assert.strictEqual(reads, 0);
        }
        assert.lengthOf(yield* demandsOf("root-full"), 5);
        assert.lengthOf(yield* admissionsOf("root-full"), 0);
      }),
    ),
  );

  /**
   * The kind's demand waits under full capacity, a slot frees and the tick reserves it for the
   * demand: another key of the kind still waits, and the reserved key's presentation converts it.
   */
  const reservedKey = (turnOf: () => AutomaticTurnGate.AutomaticTurn, otherKey: boolean) =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        const subject = yield* seed("subject", { state: "running", root: "root-s" });
        yield* fill(2);
        const turn = turnOf();
        assert.strictEqual(
          (yield* decide({ root: "root-s", turn }, subject.work)).decision.type,
          "demand",
        );
        yield* admission
          .release("root-other-1", (yield* slotOf("root-other-1"))!.entry_seq)
          .pipe(Effect.orDie);
        const [demand] = yield* demandsOf("root-s");
        assert.strictEqual(
          (yield* admission.reserve(demand!.id, subject.work).pipe(Effect.orDie)).type,
          "reserved",
        );
        assert.strictEqual((yield* slotOf("root-s"))?.reserved_demand_id, demand!.id);
        if (otherKey) {
          const other = yield* decide({ root: "root-s", turn: turnOf() }, subject.work);
          assert.strictEqual(other.decision.type, "demand");
          assert.strictEqual((yield* slotOf("root-s"))?.state, "reserved");
        }
        const { decision, ran } = yield* decide({ root: "root-s", turn }, subject.work);
        assert.strictEqual(decision.type, "admitted");
        assert.isTrue(ran);
        assert.strictEqual((yield* slotOf("root-s"))?.state, "held");
        assert.isUndefined((yield* demandsOf("root-s")).find(({ id }) => id === demand!.id));
        assert.deepStrictEqual(
          (yield* admissionsOf("root-s")).map(({ kind, state }) => [kind, state]),
          [["automatic_turn", "dispatched"]],
        );
      }),
    );

  it.effect("admits a pull request wake into the reservation made for it", () =>
    reservedKey(turns.pullRequest, false),
  );
  it.effect("admits a usage-limit resume into the reservation made for it", () =>
    reservedKey(turns.limit, true),
  );
  it.effect("admits a delegated completion into the reservation made for it", () =>
    reservedKey(turns.completion, true),
  );
  it.effect("admits a native wake into the reservation made for it", () =>
    reservedKey(() => turns.native(), true),
  );
  it.effect("admits a delegated question into the reservation made for it", () =>
    reservedKey(turns.question, false),
  );

  it.effect("admits Factory's question by converting a reservation made for another key", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        const q = yield* seed("q", { state: "running", root: "root-q" });
        yield* fill(2);
        yield* decide({ root: "root-q", turn: turns.pullRequest() }, q.work);
        yield* admission
          .release("root-other-1", (yield* slotOf("root-other-1"))!.entry_seq)
          .pipe(Effect.orDie);
        const [prDemand] = yield* demandsOf("root-q");
        yield* admission.reserve(prDemand!.id, q.work).pipe(Effect.orDie);
        // An unknown question waits; Factory's own lands in the holding the reservation was for.
        assert.strictEqual(
          (yield* decide({ root: "root-q", provenance: "unknown", turn: turns.question() }, q.work))
            .decision.type,
          "demand",
        );
        const question = yield* decide({ root: "root-q", turn: turns.question() }, q.work);
        assert.strictEqual(question.decision.type, "admitted");
        assert.strictEqual((yield* slotOf("root-q"))?.state, "held");
        const returned = (yield* demandsOf("root-q")).find(({ id }) => id === prDemand!.id);
        assert.strictEqual(returned?.state, "waiting");
        assert.isAbove(returned!.seq, prDemand!.seq);
        assert.deepStrictEqual(
          (yield* historyOf("q")).map(({ outcome }) => outcome),
          ["granted", "unused"],
        );
      }),
    ),
  );
});

/** One way a root's authority or its Work item fails, and the category it refuses with. */
interface Revocation {
  readonly name: string;
  readonly category: HandoffAdmission.BlockedReason;
  /** Changes what the database or core holds; the item read stays fresh unless `work` says. */
  readonly revoke?: (
    world: World,
  ) => Effect.Effect<void, never, PortfolioStore.PortfolioStore | SqlClient.SqlClient>;
  readonly work?: HandoffAdmission.WorkRead;
}

const sqlRun = <E>(run: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, E>) =>
  Effect.flatMap(sqlOf, run).pipe(Effect.orDie, Effect.asVoid);

const reviseSubject = (
  patch: Parameters<PortfolioStore.PortfolioStore["Service"]["reviseBrief"]>[0]["patch"],
) =>
  Effect.flatMap(PortfolioStore.PortfolioStore, (store) =>
    store.reviseBrief({ projectId: alpha, ideaId: "subject", patch }),
  ).pipe(Effect.orDie, Effect.asVoid);

const REVOCATIONS: ReadonlyArray<Revocation> = [
  {
    name: "a deauthorized brief",
    category: "revoked",
    revoke: () => reviseSubject({ executionAuthorized: false }),
  },
  {
    name: "a rescoped brief, authorized again",
    category: "revoked",
    revoke: () => reviseSubject({ goal: "Deliver something else", executionAuthorized: true }),
  },
  {
    name: "a capture of other content",
    category: "revoked",
    revoke: () =>
      sqlRun(
        (sql) => sql`UPDATE fd_assistant_work_captures SET item_fingerprint = 'other'
        WHERE idea_id = 'subject'`,
      ),
  },
  {
    name: "a capture no longer captured",
    category: "revoked",
    revoke: () =>
      sqlRun(
        (sql) => sql`UPDATE fd_assistant_work_captures SET state = 'uncertain'
        WHERE idea_id = 'subject'`,
      ),
  },
  {
    name: "a deleted manager",
    category: "revoked",
    revoke: (world) => Effect.sync(() => void world.shells.set(managerId, null)),
  },
  {
    name: "an archived manager",
    category: "revoked",
    revoke: (world) =>
      Effect.sync(() => void world.shells.set(managerId, managerShell("full-access", at))),
  },
  {
    name: "a narrowed manager",
    category: "revoked",
    revoke: (world) =>
      Effect.sync(() => void world.shells.set(managerId, managerShell("approval-required"))),
  },
  {
    name: "a deleted project",
    category: "revoked",
    revoke: (world) =>
      Effect.sync(() => void world.projects.set(alpha, projectRow({ deletedAt: at }))),
  },
  {
    name: "a multi-repository project",
    category: "revoked",
    revoke: (world) =>
      Effect.sync(
        () =>
          void world.projects.set(
            alpha,
            projectRow({
              repositories: [
                { id: "one", name: "one", rootPath: "/projects/alpha/one" },
                { id: "two", name: "two", rootPath: "/projects/alpha/two" },
              ],
            }),
          ),
      ),
  },
  {
    name: "a persisted cancel",
    category: "revoked",
    revoke: () =>
      sqlRun(
        (sql) => sql`UPDATE fd_assistant_factory_links SET control = 'cancel'
        WHERE assignment_id = 'subject'`,
      ),
  },
  {
    name: "an edited item",
    category: "scope_changed",
    work: { type: "read", fingerprint: "edited", status: "todo" },
  },
  {
    name: "a closed item",
    category: "item_closed",
    work: { type: "read", fingerprint: fingerprintOf("subject"), status: "done" },
  },
  { name: "an unreadable item", category: "unreadable", work: { type: "unreadable" } },
];

describe("fresh authority", () => {
  it.effect.each(REVOCATIONS)("refuses and blocks every decision kind for $name", (revocation) =>
    withAdmission((world) =>
      Effect.gen(function* () {
        const admission = yield* service;
        yield* seed("subject", { state: "running", root: "root-s", slot: "held" });
        if (revocation.revoke !== undefined) yield* revocation.revoke(world);
        const work = revocation.work ?? freshRead("subject");
        // The database decides first: only the item's own failure needs it read.
        const reads = revocation.work === undefined ? 0 : 1;

        const effect = yield* enter({ root: "root-s", effectId: 1 }, work);
        assert.deepStrictEqual(effect, {
          decision: { type: "refuse", category: revocation.category },
          reads,
        });
        const continuation = yield* decide({ root: "root-s", turn: turns.continuation() }, work);
        assert.strictEqual(continuation.decision.type, "declined");
        assert.strictEqual(continuation.reads, reads);
        assert.isFalse(continuation.ran);
        assert.deepStrictEqual(yield* delegate("root-s", work), {
          type: "refused",
          category: revocation.category,
        });
        const opening =
          work.type === "read"
            ? yield* admission
                .authorizeOpening({
                  root: "root-s",
                  fingerprint: work.fingerprint,
                  status: work.status,
                })
                .pipe(Effect.orDie)
            : yield* admission
                .authorizeOpening({
                  root: "root-s",
                  fingerprint: "child",
                  status: "todo",
                  childScopeMatches: true,
                  work,
                })
                .pipe(Effect.orDie);
        assert.deepStrictEqual(opening, { type: "refuse", category: revocation.category });
        // Nothing of the family was admitted in its slot.
        assert.lengthOf(yield* admissionsOf("root-s"), 0);

        // With the slot released, a turn at the free head is recorded blocked, not run.
        yield* admission.release("root-s", (yield* slotOf("root-s"))!.entry_seq).pipe(Effect.orDie);
        const wake = yield* decide({ root: "root-s", turn: turns.pullRequest() }, work);
        assert.strictEqual(wake.decision.type, "blocked");
        assert.isFalse(wake.ran);
        const [demand] = yield* demandsOf("root-s");
        assert.strictEqual(demand?.blockedReason, revocation.category);
        assert.isUndefined(yield* slotOf("root-s"));
        // A blocked demand is never the head, and presenting it again reads nothing.
        assert.isUndefined((yield* admission.next.pipe(Effect.orDie)).head);
        const again = yield* decide({ root: "root-s", turn: turns.pullRequest() }, work);
        assert.deepStrictEqual(again, {
          decision: { type: "demand", demandId: demand!.id },
          reads: 0,
          ran: false,
        });
      }),
    ),
  );

  it.effect("unblocks at a fresh position once restored", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        yield* seed("subject", { state: "running", root: "root-s" });
        const edited: HandoffAdmission.WorkRead = {
          type: "read",
          fingerprint: "edited",
          status: "todo",
        };
        yield* decide({ root: "root-s", turn: turns.pullRequest() }, edited);
        const [blocked] = yield* demandsOf("root-s");
        assert.strictEqual(blocked?.blockedReason, "scope_changed");

        // Not due yet: the re-check waits two minutes per root unless a resume asks.
        assert.deepStrictEqual(yield* admission.blockedRoots().pipe(Effect.orDie), []);
        yield* TestClock.adjust("2 minutes");
        assert.deepStrictEqual(yield* admission.blockedRoots().pipe(Effect.orDie), ["root-s"]);
        // Still edited: it stays blocked, checked again.
        assert.strictEqual(
          yield* admission.recheckBlocked({ root: "root-s", work: edited }).pipe(Effect.orDie),
          0,
        );
        assert.deepStrictEqual(yield* admission.blockedRoots().pipe(Effect.orDie), []);
        // A resume re-checks at once; restored, it enters again at a fresh position.
        assert.strictEqual(
          yield* admission
            .recheckBlocked({ root: "root-s", work: freshRead("subject"), force: true })
            .pipe(Effect.orDie),
          1,
        );
        const [unblocked] = yield* demandsOf("root-s");
        assert.strictEqual(unblocked?.blockedReason, null);
        assert.isAbove(unblocked!.seq, blocked!.seq);
        assert.strictEqual(unblocked?.overtaken, 0);
        assert.deepStrictEqual(
          (yield* historyOf("subject")).map(({ outcome }) => outcome),
          ["blocked", "unblocked"],
        );
        assert.strictEqual(
          (yield* admission.next.pipe(Effect.orDie)).head?.id,
          `demand:${unblocked!.id}`,
        );
      }),
    ),
  );
});

describe("fresh authority after a rescope", () => {
  it.effect("never rebinds a root to a rescoped brief, authorized again", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        yield* seed("subject", { state: "running", root: "root-s" });
        const edited: HandoffAdmission.WorkRead = {
          type: "read",
          fingerprint: "edited",
          status: "todo",
        };
        yield* decide({ root: "root-s", turn: turns.pullRequest() }, edited);
        yield* reviseSubject({ goal: "Deliver a revised scope", executionAuthorized: true });
        // The item restored and re-checked at once: the brief no longer says what the root froze.
        assert.strictEqual(
          yield* admission
            .recheckBlocked({ root: "root-s", work: freshRead("subject"), force: true })
            .pipe(Effect.orDie),
          0,
        );
        assert.deepStrictEqual(
          (yield* demandsOf("root-s")).map(({ blockedReason }) => blockedReason),
          ["revoked"],
        );
        assert.isUndefined((yield* admission.next.pipe(Effect.orDie)).head);
        assert.deepStrictEqual(yield* delegate("root-s", freshRead("subject")), {
          type: "refused",
          category: "revoked",
        });
      }),
    ),
  );
});

/** A probe that, once armed, holds each admission still right after its commit. */
const pausingProbe = Effect.gen(function* () {
  const entered = yield* Deferred.make<HandoffAdmission.Admitted>();
  const go = yield* Deferred.make<void>();
  const state = { armed: false };
  const probe: Probe = {
    admitted: (admitted) =>
      state.armed
        ? Deferred.succeed(entered, admitted).pipe(Effect.andThen(Deferred.await(go)))
        : Effect.void,
    released: () => Effect.void,
    observed: () => Effect.void,
  };
  return { entered, go, state, probe };
});

/**
 * Holds `admit` at the admitted probe, with capacity full and another assignment queued: release
 * with the new entry deletes nothing, nothing else is granted and the row is dispatching. Once let
 * go, the dispatch has run and the row is dispatched.
 */
const pausedAdmission = (
  setup: Effect.Effect<
    {
      readonly root: string;
      readonly admit: (
        dispatch: Effect.Effect<void>,
      ) => Effect.Effect<unknown, HandoffAdmission.HandoffAdmissionError>;
    },
    never,
    HandoffAdmission.HandoffAdmission | PortfolioStore.PortfolioStore | SqlClient.SqlClient
  >,
) =>
  Effect.flatMap(pausingProbe, (paused) =>
    withAdmission(
      () =>
        Effect.gen(function* () {
          const admission = yield* service;
          const { root, admit } = yield* setup;
          yield* seed("queued", { queued: true });
          const ran: Array<string> = [];
          paused.state.armed = true;
          const fiber = yield* admit(Effect.sync(() => void ran.push("dispatched"))).pipe(
            Effect.orDie,
            Effect.forkChild,
          );
          const admitted = yield* Deferred.await(paused.entered);
          assert.strictEqual(admitted.root, root);
          const before = yield* snapshot;
          assert.strictEqual(
            yield* admission.release(root, admitted.entrySeq).pipe(Effect.orDie),
            "kept",
          );
          const next = yield* admission.next.pipe(Effect.orDie);
          assert.strictEqual(next.free, 0);
          assert.isUndefined(next.head);
          assert.strictEqual(
            (yield* admission
              .claim({ assignmentId: "queued", deliveryId: "root-queued" })
              .pipe(Effect.orDie)).type,
            "stale",
          );
          assert.deepStrictEqual(yield* snapshot, before);
          const row = (yield* admissionsOf(root)).find(
            ({ admission_id }) => admission_id === admitted.admissionId,
          );
          assert.strictEqual(row?.state, "dispatching");
          assert.deepStrictEqual(ran, []);
          yield* Deferred.succeed(paused.go, undefined);
          yield* Fiber.join(fiber);
          assert.deepStrictEqual(ran, ["dispatched"]);
          assert.strictEqual(
            (yield* admissionsOf(root)).find(
              ({ admission_id }) => admission_id === admitted.admissionId,
            )?.state,
            "dispatched",
          );
          // Dispatched, the slot can be released at its current entry.
          assert.strictEqual(
            yield* admission.release(root, (yield* slotOf(root))!.entry_seq).pipe(Effect.orDie),
            "released",
          );
        }).pipe(Effect.ensuring(Deferred.succeed(paused.go, undefined))),
      paused.probe,
    ),
  );

describe("continuous ownership from commit to dispatch", () => {
  it.effect("keeps an effect admitted in the holding", () =>
    pausedAdmission(
      Effect.gen(function* () {
        const admission = yield* service;
        const subject = yield* seed("subject", { state: "running", root: "root-s", slot: "held" });
        yield* fill(1);
        return {
          root: "root-s",
          admit: (dispatch) =>
            admission.dispatchAdmitted(
              admission.enter(
                { root: "root-s", deliveryId: "root-s", effectId: 1, fresh: true },
                subject.work,
              ),
              () => dispatch,
            ),
        };
      }),
    ),
  );

  it.effect("keeps an effect demand's grant", () =>
    pausedAdmission(
      Effect.gen(function* () {
        const admission = yield* service;
        yield* seed("subject", { state: "running", root: "root-s" });
        yield* fill(2);
        yield* admission
          .enter({ root: "root-s", deliveryId: "root-s", effectId: 1, fresh: true })
          .pipe(Effect.orDie);
        yield* admission
          .release("root-other-2", (yield* slotOf("root-other-2"))!.entry_seq)
          .pipe(Effect.orDie);
        const [demand] = yield* demandsOf("root-s");
        return {
          root: "root-s",
          admit: (dispatch) =>
            admission.dispatchAdmitted(admission.grantEffect(demand!.id), () => dispatch),
        };
      }),
    ),
  );

  it.effect("keeps a claim", () =>
    pausedAdmission(
      Effect.gen(function* () {
        const admission = yield* service;
        yield* seed("subject", { queued: true, priority: 1 });
        yield* fill(1);
        return {
          root: "root-s",
          admit: (dispatch) =>
            admission.dispatchAdmitted(
              admission.claim({ assignmentId: "subject", deliveryId: "root-s" }),
              () => dispatch,
            ),
        };
      }),
    ),
  );

  it.effect("keeps a delegation", () =>
    pausedAdmission(
      Effect.gen(function* () {
        const admission = yield* service;
        const subject = yield* seed("subject", { state: "running", root: "root-s", slot: "held" });
        yield* fill(1);
        return {
          root: "root-s",
          admit: (dispatch) =>
            admission.dispatchAdmitted(
              admission.admitDelegation({
                root: "root-s",
                threadId: "thread-a",
                messageId: "mcp-delegation:paused",
                work: subject.work,
              }),
              () => dispatch,
            ),
        };
      }),
    ),
  );

  it.effect("takes another instance's dispatching row as dispatched", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        yield* seed("subject", { state: "running", root: "root-s", slot: "held" });
        const entry = (yield* slotOf("root-s"))!.entry_seq;
        yield* sqlRun(
          (sql) =>
            sql`INSERT INTO fd_assistant_admissions ${sql.insert({
              admission_id: "dead-row",
              root_delivery_id: "root-s",
              assignment_id: "subject",
              kind: "effect",
              delivery_id: "root-s",
              effect_id: 1,
              instance_id: "a-dead-process",
              state: "dispatching",
              entry_seq: entry,
              created_at: at,
              updated_at: at,
            })}`,
        );
        // This instance's own would keep the slot; a dead process's does not.
        const settled = yield* admission
          .settleAdmissions("root-s", () => Effect.succeed("none" as const))
          .pipe(Effect.orDie);
        assert.deepStrictEqual(settled, { entrySeq: entry, busy: false, unknown: false });
        assert.lengthOf(yield* admissionsOf("root-s"), 0);
        assert.strictEqual(
          yield* admission.release("root-s", entry).pipe(Effect.orDie),
          "released",
        );
      }),
    ),
  );
});

/** A demand of `turn` for root-s, reserved by the tick once a filler releases its slot. */
const reservedDemand = (
  turn: AutomaticTurnGate.AutomaticTurn,
  kept?: HandoffAdmission.KeptDispatch,
) =>
  Effect.gen(function* () {
    const admission = yield* service;
    const subject = yield* seed("subject", { state: "running", root: "root-s" });
    yield* fill(2);
    yield* decide({ root: "root-s", turn, ...(kept === undefined ? {} : { kept }) }, subject.work);
    yield* admission
      .release("root-other-1", (yield* slotOf("root-other-1"))!.entry_seq)
      .pipe(Effect.orDie);
    const [demand] = yield* demandsOf("root-s");
    const reserved = yield* admission.reserve(demand!.id, subject.work).pipe(Effect.orDie);
    assert.strictEqual(reserved.type, "reserved");
    return demand!;
  });

const expire = (minutes: number, currency: HandoffAdmission.Currency = "current") =>
  Effect.gen(function* () {
    yield* TestClock.adjust(`${minutes} minutes`);
    yield* Effect.flatMap(service, (admission) =>
      admission.expireLeases(() => Effect.succeed(currency)),
    ).pipe(Effect.orDie);
  });

/** Each currency an expired question or completion reservation can be read with. */
const EXPIRY_CASES = (["current", "unreadable", "not_current"] as const).flatMap((currency) =>
  [turns.question, turns.completion].map((make) => ({
    currency,
    outcome: currency === "not_current" ? ("moot" as const) : ("waiting" as const),
    kind: make().kind,
    make,
  })),
);

describe("release and lease expiry", () => {
  it.effect("releases a held slot only at the entry it read, with no dispatch of its own", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        const subject = yield* seed("subject", { state: "running", root: "root-s", slot: "held" });
        const e0 = (yield* slotOf("root-s"))!.entry_seq;
        // An admission between the read and the delete moves the entry.
        yield* enter({ root: "root-s", effectId: 1 }, subject.work);
        assert.strictEqual(yield* admission.release("root-s", e0).pipe(Effect.orDie), "kept");
        const e1 = (yield* slotOf("root-s"))!.entry_seq;
        assert.isAbove(e1, e0);
        // A row this instance still dispatches keeps it even at the current entry.
        const claimRow = yield* admission
          .admitDelegation({
            root: "root-s",
            threadId: "thread-a",
            messageId: "mcp-delegation:x",
            work: subject.work,
          })
          .pipe(Effect.orDie);
        assert.strictEqual(claimRow.type, "admitted");
        const e2 = (yield* slotOf("root-s"))!.entry_seq;
        assert.strictEqual(yield* admission.release("root-s", e2).pipe(Effect.orDie), "kept");
        if (claimRow.type === "admitted") {
          yield* admission.markDispatched(claimRow.admitted).pipe(Effect.orDie);
        }
        assert.strictEqual(yield* admission.release("root-s", e2).pipe(Effect.orDie), "released");
        assert.isUndefined(yield* slotOf("root-s"));
        assert.deepStrictEqual(
          (yield* historyOf("subject")).map(({ outcome }) => outcome),
          ["released"],
        );
      }),
    ),
  );

  it.effect("deletes an expired pull request or usage-limit reservation", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        yield* reservedDemand(turns.pullRequest());
        yield* expire(4);
        assert.strictEqual((yield* slotOf("root-s"))?.state, "reserved");
        yield* expire(1);
        assert.isUndefined(yield* slotOf("root-s"));
        assert.deepStrictEqual(yield* demandsOf("root-s"), []);
        assert.deepStrictEqual(
          (yield* historyOf("subject")).map(({ outcome }) => outcome),
          ["granted", "expired"],
        );
      }),
    ),
  );

  it.effect("deletes an expired usage-limit reservation after its minute", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        yield* reservedDemand(turns.limit());
        yield* expire(1);
        assert.isUndefined(yield* slotOf("root-s"));
        assert.deepStrictEqual(yield* demandsOf("root-s"), []);
      }),
    ),
  );

  it.effect.each(EXPIRY_CASES)(
    "returns an expired $kind to waiting or deletes it as moot ($currency)",
    ({ currency, outcome, make }) =>
      withAdmission(() =>
        Effect.gen(function* () {
          const demand = yield* reservedDemand(make());
          yield* expire(1, currency);
          assert.isUndefined(yield* slotOf("root-s"));
          const left = yield* demandsOf("root-s");
          if (outcome === "moot") assert.deepStrictEqual(left, []);
          else {
            assert.strictEqual(left[0]?.state, "waiting");
            assert.isAbove(left[0]!.seq, demand.seq);
          }
          assert.strictEqual(
            (yield* historyOf("subject")).at(-1)?.outcome,
            outcome === "moot" ? "moot" : "expired",
          );
        }),
      ),
  );

  it.effect("returns a native reservation to waiting while its dispatch is kept here", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const demand = yield* reservedDemand(turns.native(), { dispatch: Effect.void });
        yield* expire(1);
        const [back] = yield* demandsOf("root-s");
        assert.strictEqual(back?.state, "waiting");
        assert.isAbove(back!.seq, demand.seq);
        assert.deepStrictEqual(yield* dispositionsOf("root-s"), []);
      }),
    ),
  );

  it.effect(
    "loses a native reservation with no dispatch kept, atomically with history and notice",
    () =>
      withAdmission(() =>
        Effect.gen(function* () {
          yield* reservedDemand(turns.native());
          // A history write that fails takes the disposition and notice with it.
          yield* sqlRun(
            (sql) => sql`CREATE TRIGGER refuse_lost BEFORE INSERT ON fd_assistant_grant_history
          WHEN NEW.outcome = 'lost_on_restart'
          BEGIN SELECT RAISE(ABORT, 'refused'); END`,
          );
          const before = yield* snapshot;
          const notes = (yield* assignmentOf("subject")).progress.length;
          yield* TestClock.adjust("1 minute");
          const failed = yield* Effect.flatMap(service, (admission) =>
            admission.expireLeases(() => Effect.succeed("current" as const)),
          ).pipe(Effect.flip);
          assert.strictEqual(failed._tag, "HandoffAdmissionError");
          assert.deepStrictEqual(yield* snapshot, before);
          assert.strictEqual((yield* assignmentOf("subject")).progress.length, notes);

          yield* sqlRun((sql) => sql`DROP TRIGGER refuse_lost`);
          yield* expire(0);
          assert.deepStrictEqual(yield* demandsOf("root-s"), []);
          assert.isUndefined(yield* slotOf("root-s"));
          const [lost] = yield* dispositionsOf("root-s");
          assert.deepStrictEqual(
            { kind: lost?.kind, outcome: lost?.outcome, clear: lost?.adapter_clear },
            { kind: "background_wake", outcome: "lost_on_restart", clear: "unavailable" },
          );
          assert.strictEqual((yield* historyOf("subject")).at(-1)?.outcome, "lost_on_restart");
          assert.include(
            (yield* assignmentOf("subject")).progress.at(-1)?.text ?? "",
            "the server restarted before it could continue",
          );
          assert.strictEqual((yield* assignmentOf("subject")).progress.length, notes + 1);
        }),
      ),
  );

  it.effect("deletes a moot redelivery with its history", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        const demand = yield* reservedDemand(turns.question());
        yield* admission.moot(demand.id).pipe(Effect.orDie);
        assert.isUndefined(yield* slotOf("root-s"));
        assert.deepStrictEqual(yield* demandsOf("root-s"), []);
        assert.strictEqual((yield* historyOf("subject")).at(-1)?.outcome, "moot");
      }),
    ),
  );

  it.effect(
    "redelivers another instance's reserved questions and completions once, on its first tick",
    () =>
      withAdmission((world) =>
        Effect.gen(function* () {
          const admission = yield* service;
          const question = yield* reservedDemand(turns.question());
          const subject = yield* seed("second", { state: "running", root: "root-2" });
          yield* fill(1, "late");
          const completion = turns.completion();
          yield* decide({ root: "root-2", turn: completion }, subject.work);
          yield* admission
            .release("root-other-2", (yield* slotOf("root-other-2"))!.entry_seq)
            .pipe(Effect.orDie);
          yield* admission
            .release("root-late-1", (yield* slotOf("root-late-1"))!.entry_seq)
            .pipe(Effect.orDie);
          const [completionDemand] = yield* demandsOf("root-2");
          yield* admission.reserve(completionDemand!.id, subject.work).pipe(Effect.orDie);
          // A native demand of this instance, waiting.
          yield* fill(2, "native");
          const nativeSubject = yield* seed("native", { state: "running", root: "root-n" });
          yield* decide({ root: "root-n", turn: turns.native() }, nativeSubject.work);
          assert.strictEqual((yield* slotOf("root-s"))?.redelivered_by, admission.instanceId);

          // This instance's own reservations are not redelivered on its first tick.
          assert.deepStrictEqual(yield* admission.firstTick.pipe(Effect.orDie), []);
          assert.lengthOf(yield* demandsOf("root-n"), 1);

          const next = yield* anotherInstance(world);
          const redelivered = yield* next.firstTick.pipe(Effect.orDie);
          assert.deepStrictEqual(
            redelivered.map(({ id, kind }) => [id, kind]),
            [
              [question.id, "delegated_question"],
              [completionDemand!.id, "delegated_completion"],
            ],
          );
          assert.strictEqual((yield* slotOf("root-s"))?.redelivered_by, next.instanceId);
          assert.strictEqual((yield* slotOf("root-2"))?.redelivered_by, next.instanceId);
          // The other instance's native demand is lost with it.
          assert.deepStrictEqual(yield* demandsOf("root-n"), []);
          assert.strictEqual((yield* dispositionsOf("root-n"))[0]?.outcome, "lost_on_restart");
          // Stamped, they are not redelivered again.
          assert.deepStrictEqual(yield* next.firstTick.pipe(Effect.orDie), []);
        }),
      ),
  );
});

/** The notices on the assignment's progress, newest last. */
const noticesOf = (assignmentId: string) =>
  Effect.map(assignmentOf(assignmentId), ({ progress }) => progress.map(({ text }) => text));

describe("ending and retired roots", () => {
  it.effect.each([{ rootState: "ending" as const }, { rootState: "retired" as const }])(
    "declines a $rootState root's every automatic kind once per key, creating nothing",
    ({ rootState }) =>
      withAdmission(() =>
        Effect.gen(function* () {
          const admission = yield* service;
          yield* seed("subject", { state: "stopping", root: "root-s", rootState });
          const work = freshRead("subject");
          const presented = [
            [turns.pullRequest(), "factory"],
            [turns.limit(), "unknown"],
            [turns.question(), "factory"],
            [turns.completion(), "unknown"],
            [turns.native(true), "factory"],
            [turns.native(false), "unknown"],
          ] as const;
          let ranAny = false;
          for (const [turn, provenance] of presented) {
            const { decision, reads, ran } = yield* decide(
              { root: "root-s", provenance, turn },
              work,
            );
            ranAny ||= ran;
            assert.deepStrictEqual(decision, {
              type: "declined",
              clear: turn.kind === "background_wake" && turn.clearable,
            });
            assert.strictEqual(reads, 0);
          }
          assert.isFalse(ranAny);
          const dispositions = yield* dispositionsOf("root-s");
          // The two native wakes share their provider thread, so one disposition and notice.
          assert.deepStrictEqual(
            dispositions.map(({ kind, class: cls, adapter_clear, wake_key }) => [
              kind,
              cls,
              adapter_clear,
              wake_key,
            ]),
            [
              ["background_wake", "factory", "requested", "thread-a:provider-thread-a"],
              ["delegated_completion", "unknown", null, presented[3][0].key],
              ["delegated_question", "factory", null, presented[2][0].key],
              ["pull_request_wake", "factory", null, "https://example.test/pull/7"],
              ["usage_limit_resume", "unknown", null, presented[1][0].key],
            ],
          );
          assert.strictEqual(
            dispositions.find(({ kind }) => kind === "delegated_question")?.thread_id,
            "thread-child",
          );
          const notices = yield* noticesOf("subject");
          assert.lengthOf(notices, 5);
          assert.include(
            notices.join("\n"),
            "Pull request feedback on thread-a arrived after this assignment ended",
          );
          assert.include(notices.join("\n"), "A delegated agent on thread-child is waiting");

          // Repeats, and a restart continuation, an effect and a delegation, write nothing.
          const before = yield* snapshot;
          for (const [turn, provenance] of presented) {
            yield* decide({ root: "root-s", provenance, turn }, work);
          }
          assert.strictEqual(
            (yield* decide({ root: "root-s", turn: turns.continuation() }, work)).decision.type,
            "declined",
          );
          assert.deepStrictEqual(yield* enter({ root: "root-s", effectId: 1 }, work), {
            decision: { type: "refuse", category: "ended" },
            reads: 0,
          });
          assert.deepStrictEqual(yield* delegate("root-s", work), {
            type: "refused",
            category: "ended",
          });
          assert.deepStrictEqual(
            yield* admission
              .authorizeOpening({
                root: "root-s",
                fingerprint: fingerprintOf("subject"),
                status: "todo",
              })
              .pipe(Effect.orDie),
            { type: "refuse", category: "ended" },
          );
          assert.deepStrictEqual(yield* snapshot, before);
          assert.lengthOf(yield* noticesOf("subject"), 5);
          for (const table of [
            "fd_assistant_slots",
            "fd_assistant_admission_demands",
            "fd_assistant_admissions",
          ]) {
            assert.deepStrictEqual(yield* rows(table), [], table);
          }
          assert.strictEqual(yield* admission.management("root-s").pipe(Effect.orDie), rootState);
        }),
      ),
  );

  it.effect(
    "raises a typed error and dispatches nothing when a disposition cannot be written",
    () =>
      withAdmission(() =>
        Effect.gen(function* () {
          const admission = yield* service;
          yield* seed("subject", { state: "stopping", root: "root-s", rootState: "ending" });
          yield* sqlRun(
            (sql) => sql`CREATE TRIGGER refuse_disposition
          BEFORE INSERT ON fd_assistant_dispositions
          BEGIN SELECT RAISE(ABORT, 'refused'); END`,
          );
          const before = yield* snapshot;
          let ran = false;
          const failed = yield* admission
            .dispatchAdmitted(
              admission.decideTurn({
                root: "root-s",
                provenance: "factory",
                turn: turns.pullRequest(),
              }),
              () => Effect.sync(() => void (ran = true)),
            )
            .pipe(Effect.flip);
          assert.strictEqual(failed._tag, "HandoffAdmissionError");
          assert.isFalse(ran);
          assert.deepStrictEqual(yield* snapshot, before);
        }),
      ),
  );

  it.effect("drops a fenced root's reservation by its demand and disposes of it", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        const demand = yield* reservedDemand(turns.limit());
        assert.isTrue(yield* admission.fence("root-s", "cancelled").pipe(Effect.orDie));
        // Its own key presented after the fence takes the reservation by compare-and-delete.
        const limit = yield* decide(
          {
            root: "root-s",
            turn: {
              ...turns.limit(),
              key: demand.wakeKey!,
              messageId: MessageId.make(demand.wakeKey!),
            },
          },
          freshRead("subject"),
        );
        assert.strictEqual(limit.decision.type, "declined");
        assert.isUndefined(yield* slotOf("root-s"));
        assert.deepStrictEqual(yield* demandsOf("root-s"), []);
        assert.strictEqual((yield* dispositionsOf("root-s"))[0]?.kind, "usage_limit_resume");
      }),
    ),
  );
});

describe("delegation", () => {
  it.effect(
    "admits a delegation only in a held slot, and leaves its row for the release pass",
    () =>
      withAdmission(() =>
        Effect.gen(function* () {
          const admission = yield* service;
          const subject = yield* seed("subject", {
            state: "running",
            root: "root-s",
            slot: "held",
          });
          const e0 = (yield* slotOf("root-s"))!.entry_seq;
          const admitted = yield* delegate("root-s", subject.work);
          assert.strictEqual(admitted.type, "admitted");
          if (admitted.type !== "admitted") return;
          assert.isAbove((yield* slotOf("root-s"))!.entry_seq, e0);
          assert.deepStrictEqual(
            (yield* admissionsOf("root-s")).map(({ kind, state }) => [kind, state]),
            [["delegation", "dispatching"]],
          );
          yield* admission.markDispatched(admitted.admitted).pipe(Effect.orDie);
          assert.deepStrictEqual(
            (yield* admissionsOf("root-s")).map(({ kind, state }) => [kind, state]),
            [["delegation", "dispatched"]],
          );
          // The release pass deletes it, then the slot goes at its entry.
          const settled = yield* admission
            .settleAdmissions("root-s", () => Effect.die("a delegation needs no run read"))
            .pipe(Effect.orDie);
          assert.deepStrictEqual(settled, {
            entrySeq: (yield* slotOf("root-s"))!.entry_seq,
            busy: false,
            unknown: false,
          });
          assert.deepStrictEqual(yield* admissionsOf("root-s"), []);
          assert.strictEqual(
            yield* admission.release("root-s", settled.entrySeq!).pipe(Effect.orDie),
            "released",
          );

          // Without a slot, or with only a reserved one, it is not holding.
          assert.deepStrictEqual(yield* delegate("root-s", subject.work), {
            type: "refused",
            category: "not_holding",
          });
        }),
      ),
  );

  it.effect("refuses a delegation with only a reserved slot, and for each failing read", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        yield* reservedDemand(turns.pullRequest());
        assert.deepStrictEqual(yield* delegate("root-s", freshRead("subject")), {
          type: "refused",
          category: "not_holding",
        });
        for (const [work, category] of [
          [{ type: "read", fingerprint: "edited", status: "todo" }, "scope_changed"],
          [
            { type: "read", fingerprint: fingerprintOf("subject"), status: "cancelled" },
            "item_closed",
          ],
          [{ type: "unreadable" }, "unreadable"],
        ] as const) {
          assert.deepStrictEqual(yield* delegate("root-s", work), { type: "refused", category });
        }
        yield* reviseSubject({ executionAuthorized: false });
        assert.deepStrictEqual(yield* delegate("root-s", freshRead("subject")), {
          type: "refused",
          category: "revoked",
        });
        assert.lengthOf(yield* admissionsOf("root-s"), 0);
      }),
    ),
  );
});

describe("retirement linearization", () => {
  it.effect("retires on a quiescent observation with nothing held, disposing of every demand", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        yield* seed("subject", { state: "stopping", root: "root-s", queued: true });
        yield* fill(2);
        yield* enter({ root: "root-s", effectId: 1 }, freshRead("subject"));
        for (const turn of [turns.pullRequest(), turns.question(), turns.native()]) {
          yield* decide({ root: "root-s", turn }, freshRead("subject"));
        }
        assert.lengthOf(yield* demandsOf("root-s"), 4);

        // Busy or unknown: only the fence.
        for (const observation of [
          { ...quiescent, busy: true },
          { ...quiescent, unknown: true },
          { ...quiescent, deferred: true },
          { ...quiescent, phase: "parked" as const },
        ]) {
          assert.strictEqual(
            yield* admission
              .retireAttempt({ root: "root-s", reason: "cancelled", observation })
              .pipe(Effect.orDie),
            "unobserved",
          );
        }
        assert.deepStrictEqual(yield* rootOf("root-s"), { state: "ending", reason: "cancelled" });
        assert.lengthOf(yield* demandsOf("root-s"), 4);
        assert.strictEqual((yield* assignmentOf("subject")).state, "stopping");

        assert.strictEqual(
          yield* admission
            .retireAttempt({ root: "root-s", reason: "cancelled", observation: quiescent })
            .pipe(Effect.orDie),
          "retired",
        );
        assert.deepStrictEqual(yield* rootOf("root-s"), { state: "retired", reason: "cancelled" });
        assert.deepStrictEqual(yield* demandsOf("root-s"), []);
        assert.isUndefined(yield* positionOf("subject"));
        assert.strictEqual((yield* assignmentOf("subject")).state, "cancelled");
        assert.deepStrictEqual(
          (yield* dispositionsOf("root-s")).map(({ kind, outcome }) => [kind, outcome]),
          [
            ["background_wake", "declined_ended"],
            ["delegated_question", "declined_ended"],
            ["pull_request_wake", "declined_ended"],
          ],
        );
        // Repeated attempts change nothing.
        const before = yield* snapshot;
        const notices = (yield* noticesOf("subject")).length;
        assert.strictEqual(
          yield* admission
            .retireAttempt({ root: "root-s", reason: "cancelled", observation: quiescent })
            .pipe(Effect.orDie),
          "retired",
        );
        assert.deepStrictEqual(yield* snapshot, before);
        assert.strictEqual((yield* noticesOf("subject")).length, notices);
      }),
    ),
  );

  it.effect("completes with evidence only once Factory is done and nothing is held", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        yield* seed("subject", { state: "running", root: "root-s", slot: "held" });
        assert.strictEqual(
          yield* admission
            .retireAttempt({ root: "root-s", reason: "completed", observation: quiescent })
            .pipe(Effect.orDie),
          "contended",
        );
        // The fence committed alone; the slot stays, never deleted by retirement.
        assert.deepStrictEqual(yield* rootOf("root-s"), { state: "ending", reason: "completed" });
        assert.strictEqual((yield* slotOf("root-s"))?.state, "held");
        assert.strictEqual((yield* assignmentOf("subject")).state, "running");
        yield* admission.release("root-s", (yield* slotOf("root-s"))!.entry_seq).pipe(Effect.orDie);
        assert.strictEqual(
          yield* admission
            .retireAttempt({
              root: "root-s",
              reason: "completed",
              observation: quiescent,
              evidence: ["PR https://example.test/pull/7 merged"],
            })
            .pipe(Effect.orDie),
          "retired",
        );
        const done = yield* assignmentOf("subject");
        assert.strictEqual(done.state, "completed");
        assert.deepStrictEqual(done.evidence, ["PR https://example.test/pull/7 merged"]);
      }),
    ),
  );

  it.effect.each([{ stage: "released" as const }, { stage: "observed" as const }])(
    "keeps an assignment whose admission lands at the $stage probe, before the attempt",
    ({ stage }) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const go = yield* Deferred.make<void>();
        const admitting: { fiber?: Fiber.Fiber<unknown, HandoffAdmission.HandoffAdmissionError> } =
          {};
        const ran: Array<string> = [];
        // At the probe stage, a turn is admitted at the free head and its dispatch held: after
        // the release pass, or after the quiescent observation the attempt then relies on.
        const admitMeanwhile = () =>
          Effect.gen(function* () {
            const admission = yield* service;
            admitting.fiber = yield* admission
              .dispatchAdmitted(
                admission.decideTurn({
                  root: "root-s",
                  provenance: "factory",
                  turn: turns.pullRequest(),
                  work: freshRead("subject"),
                }),
                () => Effect.sync(() => void ran.push("wake")),
              )
              .pipe(Effect.forkDetach);
            yield* Deferred.await(entered);
          }).pipe(Effect.provideService(service, admissionRef.current!));
        const probe: Probe = {
          admitted: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(go))),
          released: () => (stage === "released" ? admitMeanwhile() : Effect.void),
          observed: () => (stage === "observed" ? admitMeanwhile() : Effect.void),
        };
        const admissionRef: { current?: HandoffAdmission.HandoffAdmission["Service"] } = {};
        return yield* withAdmission(
          () =>
            Effect.gen(function* () {
              const admission = yield* service;
              admissionRef.current = admission;
              yield* seed("subject", { state: "stopping", root: "root-s" });
              const outcome = yield* admission
                .retire({
                  root: "root-s",
                  reason: "cancelled",
                  release: Effect.void,
                  observe: Effect.succeed(quiescent),
                })
                .pipe(Effect.orDie);
              assert.strictEqual(outcome, "contended");
              assert.deepStrictEqual(yield* rootOf("root-s"), {
                state: "ending",
                reason: "cancelled",
              });
              assert.strictEqual((yield* slotOf("root-s"))?.state, "held");
              assert.deepStrictEqual(
                (yield* admissionsOf("root-s")).map(({ state }) => state),
                ["dispatching"],
              );
              assert.strictEqual((yield* assignmentOf("subject")).state, "stopping");
              yield* Deferred.succeed(go, undefined);
              yield* Fiber.join(admitting.fiber!);
              assert.deepStrictEqual(ran, ["wake"]);
              // A later turn of the fenced root is declined with its disposition, not admitted.
              const late = yield* decide(
                { root: "root-s", turn: turns.limit() },
                freshRead("subject"),
              );
              assert.strictEqual(late.decision.type, "declined");
              assert.strictEqual((yield* dispositionsOf("root-s"))[0]?.kind, "usage_limit_resume");
              // Drained and released, the next attempt retires it.
              yield* admission
                .settleAdmissions("root-s", () => Effect.succeed("ended" as const))
                .pipe(Effect.orDie);
              yield* admission
                .release("root-s", (yield* slotOf("root-s"))!.entry_seq)
                .pipe(Effect.orDie);
              assert.strictEqual(
                yield* admission
                  .retireAttempt({ root: "root-s", reason: "cancelled", observation: quiescent })
                  .pipe(Effect.orDie),
                "retired",
              );
              assert.strictEqual((yield* assignmentOf("subject")).state, "cancelled");
            }).pipe(Effect.ensuring(Deferred.succeed(go, undefined))),
          probe,
        );
      }),
  );

  it.effect("compares and retires a claim that never started a delivery", () =>
    withAdmission((world) =>
      Effect.gen(function* () {
        const admission = yield* service;
        yield* seed("subject", { queued: true });
        const claimed = yield* admission
          .claim({ assignmentId: "subject", deliveryId: "root-s" })
          .pipe(Effect.orDie);
        assert.strictEqual(claimed.type, "claimed");
        if (claimed.type !== "claimed") return;
        const shape = {
          type: "claim" as const,
          admissionId: claimed.admitted.admissionId,
          entrySeq: claimed.admitted.entrySeq,
        };
        // The claim's start is in flight here: refused.
        assert.strictEqual(
          yield* admission
            .retirePreDelivery({ root: "root-s", reason: "failed", shape })
            .pipe(Effect.orDie),
          "contended",
        );
        yield* admission.markDispatched(claimed.admitted).pipe(Effect.orDie);
        // Another row of the root, even another instance's, refuses it too.
        const other = yield* anotherInstance(world);
        const foreign = yield* other
          .admitDelegation({
            root: "root-s",
            threadId: "thread-a",
            messageId: "mcp-delegation:foreign",
            work: freshRead("subject"),
          })
          .pipe(Effect.orDie);
        assert.strictEqual(foreign.type, "admitted");
        const moved = (yield* slotOf("root-s"))!.entry_seq;
        assert.strictEqual(
          yield* admission
            .retirePreDelivery({ root: "root-s", reason: "failed", shape })
            .pipe(Effect.orDie),
          "contended",
        );
        // Without the extra row, a moved entry still refuses it.
        yield* sqlRun((sql) => sql`DELETE FROM fd_assistant_admissions WHERE kind = 'delegation'`);
        assert.isAbove(moved, shape.entrySeq);
        assert.strictEqual(
          yield* admission
            .retirePreDelivery({ root: "root-s", reason: "failed", shape })
            .pipe(Effect.orDie),
          "contended",
        );
        yield* sqlRun((sql) => sql`UPDATE fd_assistant_slots SET entry_seq = ${shape.entrySeq}`);
        assert.strictEqual(
          yield* admission
            .retirePreDelivery({ root: "root-s", reason: "failed", shape })
            .pipe(Effect.orDie),
          "retired",
        );
        assert.deepStrictEqual(yield* rootOf("root-s"), { state: "retired", reason: "failed" });
        assert.strictEqual((yield* assignmentOf("subject")).state, "failed");
        assert.isUndefined(yield* slotOf("root-s"));
        assert.deepStrictEqual(yield* admissionsOf("root-s"), []);
        assert.isUndefined(yield* positionOf("subject"));
      }),
    ),
  );

  it.effect("drops only a reservation still reserved, keeping a converted slot", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        const demand = yield* reservedDemand(turns.pullRequest());
        // Active roots drop nothing.
        assert.strictEqual(
          yield* admission
            .dropFencedReservation({ root: "root-s", demandId: demand.id })
            .pipe(Effect.orDie),
          "kept",
        );
        // An effect converts the reservation before the fence: the slot is kept, counted.
        yield* enter({ root: "root-s", effectId: 1 }, freshRead("subject"));
        yield* admission.fence("root-s", "cancelled").pipe(Effect.orDie);
        assert.strictEqual(
          yield* admission
            .dropFencedReservation({ root: "root-s", demandId: demand.id })
            .pipe(Effect.orDie),
          "kept",
        );
        assert.strictEqual((yield* slotOf("root-s"))?.state, "held");
        assert.deepStrictEqual(yield* dispositionsOf("root-s"), []);
      }),
    ),
  );
});

/**
 * A pre-start root parked by a stop: claimed at the head, its start never called, its claim
 * marked dispatched as reconcile does when it honours a stop, and the stop persisted.
 */
const claimedStopped = Effect.gen(function* () {
  const admission = yield* service;
  yield* seed("subject", { queued: true });
  const claimed = yield* admission
    .claim({ assignmentId: "subject", deliveryId: "root-s" })
    .pipe(Effect.orDie);
  if (claimed.type !== "claimed") return assert.fail("The claim was not made.");
  yield* sqlRun((sql) => sql`UPDATE fd_assistant_factory_links SET control = 'stop'`);
  return claimed.admitted;
});

const setControl = (control: "none" | "stop" | "cancel") =>
  sqlRun(
    (sql) => sql`UPDATE fd_assistant_factory_links SET control = ${control}
    WHERE assignment_id = 'subject'`,
  );

const park = (admitted: HandoffAdmission.Admitted) =>
  Effect.flatMap(service, (admission) =>
    admission.parkPreStart({
      root: "root-s",
      admissionId: admitted.admissionId,
      entrySeq: admitted.entrySeq,
    }),
  ).pipe(Effect.orDie);

/** Every row of a bystander root, to see that a pre-start operation never touches it. */
const bystander = Effect.gen(function* () {
  return {
    slot: yield* slotOf("root-other-1"),
    admissions: yield* admissionsOf("root-other-1"),
    demands: yield* demandsOf("root-other-1"),
    root: yield* rootOf("root-other-1"),
    position: yield* positionOf("other-1"),
  };
});

describe("pre-start parking, resume and cancel", () => {
  it.effect("parks exactly the claim's row and slot, keeping the root, link and position", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        yield* fill(1);
        const others = yield* bystander;
        const admitted = yield* claimedStopped;
        const position = yield* positionOf("subject");
        // In flight here, it is refused.
        assert.strictEqual(yield* park(admitted), "contended");
        yield* admission.markDispatched(admitted).pipe(Effect.orDie);
        // A moved entry, another row, a demand, or control other than stop refuse it.
        yield* sqlRun(
          (sql) => sql`UPDATE fd_assistant_slots SET entry_seq = entry_seq + 1000
          WHERE root_delivery_id = 'root-s'`,
        );
        assert.strictEqual(yield* park(admitted), "contended");
        yield* sqlRun(
          (sql) => sql`UPDATE fd_assistant_slots SET entry_seq = ${admitted.entrySeq}
          WHERE root_delivery_id = 'root-s'`,
        );
        const extra = yield* delegate("root-s", freshRead("subject"));
        assert.strictEqual(extra.type, "admitted");
        if (extra.type === "admitted") {
          yield* admission.markDispatched(extra.admitted).pipe(Effect.orDie);
        }
        yield* sqlRun(
          (sql) => sql`UPDATE fd_assistant_slots SET entry_seq = ${admitted.entrySeq}
          WHERE root_delivery_id = 'root-s'`,
        );
        assert.strictEqual(yield* park(admitted), "contended");
        yield* sqlRun((sql) => sql`DELETE FROM fd_assistant_admissions WHERE kind = 'delegation'`);
        yield* sqlRun(
          (sql) =>
            sql`INSERT INTO fd_assistant_admission_demands ${sql.insert({
              seq: 9000,
              root_delivery_id: "root-s",
              assignment_id: "subject",
              delivery_id: "root-s",
              kind: "effect",
              state: "waiting",
              effect_id: 1,
              overtaken: 0,
              requested_at: at,
            })}`,
        );
        assert.strictEqual(yield* park(admitted), "contended");
        yield* sqlRun((sql) => sql`DELETE FROM fd_assistant_admission_demands`);
        for (const control of ["none", "cancel"] as const) {
          yield* setControl(control);
          assert.strictEqual(yield* park(admitted), "contended");
        }
        yield* setControl("stop");
        assert.strictEqual(yield* park(admitted), "parked");

        assert.isUndefined(yield* slotOf("root-s"));
        assert.deepStrictEqual(yield* admissionsOf("root-s"), []);
        assert.deepStrictEqual(yield* rootOf("root-s"), { state: "active", reason: null });
        assert.deepStrictEqual(yield* linkOf("subject"), {
          delivery_id: "root-s",
          control: "stop",
        });
        assert.deepStrictEqual(yield* positionOf("subject"), position);
        const parked = yield* assignmentOf("subject");
        assert.strictEqual(parked.state, "stopped");
        assert.strictEqual(parked.progress.at(-1)?.text, HandoffAdmission.parkedNotice("root-s"));
        assert.strictEqual((yield* historyOf("subject")).at(-1)?.outcome, "released");
        // Parked, it holds nothing: capacity is free for others, and it is no candidate.
        const next = yield* admission.next.pipe(Effect.orDie);
        assert.strictEqual(next.free, 1);
        assert.isUndefined(next.candidates.find(({ id }) => id === "assignment:subject"));
        // Again: nothing changes.
        const before = yield* snapshot;
        assert.strictEqual(yield* park(admitted), "contended");
        assert.deepStrictEqual(yield* snapshot, before);
        assert.deepStrictEqual(yield* bystander, others);
      }),
    ),
  );

  it.effect("parks a claim another instance left dispatching", () =>
    withAdmission((world) =>
      Effect.gen(function* () {
        yield* seed("subject", { queued: true });
        const other = yield* anotherInstance(world);
        const claimed = yield* other
          .claim({ assignmentId: "subject", deliveryId: "root-s" })
          .pipe(Effect.orDie);
        if (claimed.type !== "claimed") return assert.fail("The claim was not made.");
        yield* setControl("stop");
        assert.strictEqual(yield* park(claimed.admitted), "parked");
      }),
    ),
  );

  it.effect("resumes a parked root into the queue at a fresh position, creating no ownership", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        yield* fill(1);
        const others = yield* bystander;
        const admitted = yield* claimedStopped;
        yield* admission.markDispatched(admitted).pipe(Effect.orDie);
        const before = (yield* positionOf("subject"))!;
        // With its slot still held, a resume re-enters nothing.
        assert.deepStrictEqual(
          yield* admission
            .resumeReentry({ root: "root-s", work: freshRead("subject") })
            .pipe(Effect.orDie),
          { type: "contended" },
        );
        yield* park(admitted);
        // A failing read refuses it, changing nothing.
        assert.deepStrictEqual(
          yield* admission
            .resumeReentry({
              root: "root-s",
              work: { type: "read", fingerprint: "edited", status: "todo" },
            })
            .pipe(Effect.orDie),
          { type: "refused", category: "scope_changed" },
        );
        assert.strictEqual((yield* assignmentOf("subject")).state, "stopped");
        // Arrivals at the same time, effects of another root deferred under full capacity, all
        // take unique positions.
        yield* fill(1, "more");
        yield* seed("arrivals", { state: "running", root: "root-arrivals" });
        const arrivals = yield* Effect.all(
          [
            admission.resumeReentry({ root: "root-s", work: freshRead("subject") }),
            ...Array.from({ length: 3 }, (_, index) =>
              admission.enter({
                root: "root-arrivals",
                deliveryId: `child-${index}`,
                effectId: 1,
                fresh: false,
              }),
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.orDie);
        assert.deepStrictEqual(arrivals[0], { type: "queued" });
        const position = (yield* positionOf("subject"))!;
        assert.isAbove(position.seq, before.seq);
        assert.strictEqual(position.overtaken, 0);
        const demandSeqs = (yield* rows("fd_assistant_admission_demands")).map((row) => row.seq);
        assert.lengthOf(demandSeqs, 3);
        const seqs = [
          ...demandSeqs,
          ...(yield* rows("fd_assistant_queue_positions")).map((row) => row.seq),
        ];
        assert.strictEqual(new Set(seqs).size, seqs.length);
        const resumed = yield* assignmentOf("subject");
        assert.strictEqual(resumed.state, "queued");
        assert.strictEqual(
          resumed.progress.at(-1)?.text,
          HandoffAdmission.pendingResumeNotice("root-s"),
        );
        assert.deepStrictEqual(yield* linkOf("subject"), {
          delivery_id: "root-s",
          control: "none",
        });
        assert.isUndefined(yield* slotOf("root-s"));
        assert.deepStrictEqual(yield* admissionsOf("root-s"), []);
        assert.deepStrictEqual(yield* rootOf("root-s"), { state: "active", reason: null });
        assert.deepStrictEqual((yield* bystander).slot, others.slot);
      }),
    ),
  );

  it.effect("re-claims a pending resume's own root once, only with control none", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        yield* fill(1);
        const others = yield* bystander;
        const admitted = yield* claimedStopped;
        yield* admission.markDispatched(admitted).pipe(Effect.orDie);
        yield* park(admitted);
        yield* admission
          .resumeReentry({ root: "root-s", work: freshRead("subject") })
          .pipe(Effect.orDie);
        const grantsBefore = ((yield* rows("fd_assistant_scheduler"))[0] as { grants: number })
          .grants;
        // A held slot of its own refuses the re-claim.
        yield* sqlRun(
          (sql) => sql`INSERT INTO fd_assistant_slots
          (root_delivery_id, assignment_id, state, entry_seq, granted_at)
          VALUES ('root-s', 'subject', 'held', 8000, ${at})`,
        );
        assert.deepStrictEqual(
          yield* admission.claim({ assignmentId: "subject" }).pipe(Effect.orDie),
          { type: "stale" },
        );
        yield* sqlRun(
          (sql) => sql`DELETE FROM fd_assistant_slots WHERE root_delivery_id = 'root-s'`,
        );
        for (const control of ["stop", "cancel"] as const) {
          yield* setControl(control);
          const before = yield* snapshot;
          assert.deepStrictEqual(
            yield* admission.claim({ assignmentId: "subject" }).pipe(Effect.orDie),
            { type: "stale" },
          );
          assert.deepStrictEqual(yield* snapshot, before);
        }
        yield* setControl("none");
        // Another id than its own is refused.
        assert.deepStrictEqual(
          yield* admission
            .claim({ assignmentId: "subject", deliveryId: "another" })
            .pipe(Effect.orDie),
          { type: "stale" },
        );
        const reclaimed = yield* admission.claim({ assignmentId: "subject" }).pipe(Effect.orDie);
        assert.strictEqual(reclaimed.type, "claimed");
        if (reclaimed.type !== "claimed") return;
        assert.strictEqual(reclaimed.root, "root-s");
        assert.isFalse(reclaimed.first);
        assert.lengthOf(yield* rows("fd_assistant_managed_roots"), 2);
        assert.strictEqual((yield* slotOf("root-s"))?.state, "held");
        assert.deepStrictEqual(
          (yield* admissionsOf("root-s")).map(({ kind, state }) => [kind, state]),
          [["claim", "dispatching"]],
        );
        assert.strictEqual((yield* assignmentOf("subject")).state, "launching");
        assert.strictEqual((yield* historyOf("subject")).at(-1)?.outcome, "granted");
        assert.strictEqual(
          ((yield* rows("fd_assistant_scheduler"))[0] as { grants: number }).grants,
          grantsBefore + 1,
        );
        // Repeated, it writes nothing.
        const before = yield* snapshot;
        assert.deepStrictEqual(
          yield* admission.claim({ assignmentId: "subject" }).pipe(Effect.orDie),
          { type: "stale" },
        );
        assert.deepStrictEqual(yield* snapshot, before);
        assert.deepStrictEqual(yield* bystander, others);
      }),
    ),
  );

  /** A pending resume: parked by a stop, then resumed into the queue. */
  const pendingResume = Effect.gen(function* () {
    const admission = yield* service;
    const admitted = yield* claimedStopped;
    yield* admission.markDispatched(admitted).pipe(Effect.orDie);
    yield* park(admitted);
    yield* admission
      .resumeReentry({ root: "root-s", work: freshRead("subject") })
      .pipe(Effect.orDie);
  });

  const parkedRetire = Effect.flatMap(service, (admission) =>
    admission.retirePreDelivery({ root: "root-s", reason: "abandoned", shape: { type: "parked" } }),
  ).pipe(Effect.orDie);

  it.effect("retires a parked cancel abandoned, creating and deleting no ownership", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        yield* fill(1);
        const others = yield* bystander;
        const admitted = yield* claimedStopped;
        yield* admission.markDispatched(admitted).pipe(Effect.orDie);
        yield* park(admitted);
        // Without its cancel persisted, it is refused.
        assert.strictEqual(yield* parkedRetire, "contended");
        yield* setControl("cancel");
        // A cancel is never taken back by a resume.
        assert.deepStrictEqual(
          yield* admission
            .resumeReentry({ root: "root-s", work: freshRead("subject") })
            .pipe(Effect.orDie),
          { type: "contended" },
        );
        assert.strictEqual(yield* parkedRetire, "retired");
        assert.deepStrictEqual(yield* rootOf("root-s"), { state: "retired", reason: "abandoned" });
        assert.strictEqual((yield* assignmentOf("subject")).state, "cancelled");
        assert.isUndefined(yield* positionOf("subject"));
        assert.isUndefined(yield* slotOf("root-s"));
        const before = yield* snapshot;
        assert.strictEqual(yield* parkedRetire, "contended");
        assert.deepStrictEqual(yield* snapshot, before);
        assert.deepStrictEqual(yield* bystander, others);
      }),
    ),
  );

  it.effect(
    "lets exactly one of a re-claim and a parked cancel commit when the claim is first",
    () =>
      withAdmission(() =>
        Effect.gen(function* () {
          const admission = yield* service;
          yield* pendingResume;
          assert.strictEqual(
            (yield* admission.claim({ assignmentId: "subject" }).pipe(Effect.orDie)).type,
            "claimed",
          );
          yield* setControl("cancel");
          assert.strictEqual(yield* parkedRetire, "contended");
          assert.deepStrictEqual(yield* rootOf("root-s"), { state: "active", reason: null });
          assert.strictEqual((yield* assignmentOf("subject")).state, "launching");
          assert.strictEqual((yield* slotOf("root-s"))?.state, "held");
        }),
      ),
  );

  it.effect(
    "lets exactly one of a re-claim and a parked cancel commit when the cancel is first",
    () =>
      withAdmission(() =>
        Effect.gen(function* () {
          const admission = yield* service;
          yield* pendingResume;
          yield* setControl("cancel");
          assert.deepStrictEqual(
            yield* admission.claim({ assignmentId: "subject" }).pipe(Effect.orDie),
            { type: "stale" },
          );
          assert.strictEqual(yield* parkedRetire, "retired");
          assert.strictEqual((yield* assignmentOf("subject")).state, "cancelled");
          assert.isUndefined(yield* slotOf("root-s"));
          assert.deepStrictEqual(yield* admissionsOf("root-s"), []);
          assert.deepStrictEqual(
            yield* admission.claim({ assignmentId: "subject" }).pipe(Effect.orDie),
            { type: "stale" },
          );
        }),
      ),
  );
});

/** Raw ownership rows of root-s, as another transaction would have left them. */
const extraRows = {
  slot: sqlRun(
    (sql) => sql`INSERT INTO fd_assistant_slots
    (root_delivery_id, assignment_id, state, entry_seq, granted_at)
    VALUES ('root-s', 'subject', 'held', 7000, ${at})`,
  ),
  admission: sqlRun(
    (sql) =>
      sql`INSERT INTO fd_assistant_admissions ${sql.insert({
        admission_id: "extra-row",
        root_delivery_id: "root-s",
        assignment_id: "subject",
        kind: "effect",
        delivery_id: "root-s",
        effect_id: 1,
        instance_id: "a-dead-process",
        state: "dispatched",
        entry_seq: 7001,
        created_at: at,
        updated_at: at,
      })}`,
  ),
  demand: sqlRun(
    (sql) =>
      sql`INSERT INTO fd_assistant_admission_demands ${sql.insert({
        seq: 7002,
        root_delivery_id: "root-s",
        assignment_id: "subject",
        delivery_id: "root-s",
        kind: "effect",
        state: "waiting",
        effect_id: 1,
        overtaken: 0,
        requested_at: at,
      })}`,
  ),
  clear: sqlRun((sql) =>
    Effect.all([
      sql`DELETE FROM fd_assistant_slots WHERE root_delivery_id = 'root-s'`,
      sql`DELETE FROM fd_assistant_admissions WHERE root_delivery_id = 'root-s'`,
      sql`DELETE FROM fd_assistant_admission_demands WHERE root_delivery_id = 'root-s'`,
    ]),
  ),
};

/** A pre-start root parked by a stop, its claim's slot released. */
const parked = Effect.gen(function* () {
  const admission = yield* service;
  const admitted = yield* claimedStopped;
  yield* admission.markDispatched(admitted).pipe(Effect.orDie);
  assert.strictEqual(yield* park(admitted), "parked");
});

/** Runs `operation` once with each single extra ownership row, expecting it to change nothing. */
const refusedWithEachExtraRow = <A>(
  rowsToTry: ReadonlyArray<"slot" | "admission" | "demand">,
  operation: Effect.Effect<A, never, HandoffAdmission.HandoffAdmission | SqlClient.SqlClient>,
  refused: A,
) =>
  Effect.gen(function* () {
    for (const extra of rowsToTry) {
      yield* extraRows[extra];
      const before = yield* snapshot;
      assert.deepStrictEqual(yield* operation, refused, extra);
      assert.deepStrictEqual(yield* snapshot, before, extra);
      yield* extraRows.clear;
    }
  });

describe("pre-start refusals, one ownership row at a time", () => {
  it.effect("refuses a resume re-entry while a slot or an admission row alone exists", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        yield* parked;
        // Stopped, active and linked: only the extra row refuses it.
        const resume = admission
          .resumeReentry({ root: "root-s", work: freshRead("subject") })
          .pipe(Effect.orDie);
        yield* refusedWithEachExtraRow(["slot", "admission"], resume, { type: "contended" });
        assert.deepStrictEqual(yield* resume, { type: "queued" });
      }),
    ),
  );

  it.effect("refuses a re-claim while a slot, an admission row or a demand alone exists", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        yield* parked;
        yield* admission
          .resumeReentry({ root: "root-s", work: freshRead("subject") })
          .pipe(Effect.orDie);
        // Queued, active, control none and at the free head: only the extra row refuses it.
        const reclaim = admission.claim({ assignmentId: "subject" }).pipe(Effect.orDie);
        yield* refusedWithEachExtraRow(["slot", "admission", "demand"], reclaim, {
          type: "stale",
        });
        assert.strictEqual((yield* reclaim).type, "claimed");
      }),
    ),
  );

  it.effect(
    "refuses a parked cancel's retirement while a slot, an admission or a demand exists",
    () =>
      withAdmission(() =>
        Effect.gen(function* () {
          const admission = yield* service;
          yield* parked;
          yield* setControl("cancel");
          const retire = admission
            .retirePreDelivery({ root: "root-s", reason: "abandoned", shape: { type: "parked" } })
            .pipe(Effect.orDie);
          yield* refusedWithEachExtraRow(["slot", "admission", "demand"], retire, "contended");
          assert.strictEqual(yield* retire, "retired");
        }),
      ),
  );
});

describe("dispatch lifetime", () => {
  it.effect("never admits a turn again while this instance still dispatches it", () =>
    Effect.flatMap(pausingProbe, (paused) =>
      withAdmission(
        () =>
          Effect.gen(function* () {
            const admission = yield* service;
            const subject = yield* seed("subject", {
              state: "running",
              root: "root-s",
              slot: "held",
            });
            const question = turns.question();
            const present = (label: string, ran: Array<string>) =>
              admission.dispatchAdmitted(
                admission.decideTurn({
                  root: "root-s",
                  provenance: "factory",
                  turn: question,
                  work: subject.work,
                }),
                () => Effect.sync(() => void ran.push(label)),
              );
            const ran: Array<string> = [];
            paused.state.armed = true;
            const first = yield* present("first", ran).pipe(Effect.orDie, Effect.forkChild);
            const admitted = yield* Deferred.await(paused.entered);
            paused.state.armed = false;

            // Presented again while its dispatch is held: it runs nothing and takes over nothing.
            const before = yield* snapshot;
            const second = yield* present("second", ran).pipe(Effect.orDie);
            assert.deepStrictEqual(second.decision, { type: "in_flight" });
            assert.deepStrictEqual(yield* snapshot, before);
            assert.strictEqual(
              yield* admission.release("root-s", admitted.entrySeq).pipe(Effect.orDie),
              "kept",
            );

            yield* Deferred.succeed(paused.go, undefined);
            yield* Fiber.join(first);
            assert.deepStrictEqual(ran, ["first"]);
            assert.deepStrictEqual(
              (yield* admissionsOf("root-s")).map(({ state, entry_seq }) => [state, entry_seq]),
              [["dispatched", admitted.entrySeq]],
            );
            assert.strictEqual(
              yield* admission.release("root-s", admitted.entrySeq).pipe(Effect.orDie),
              "released",
            );
          }).pipe(Effect.ensuring(Deferred.succeed(paused.go, undefined))),
        paused.probe,
      ),
    ),
  );

  it.effect("marks only the admission generation a dispatch belongs to", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        const subject = yield* seed("subject", { state: "running", root: "root-s", slot: "held" });
        const question = turns.question();
        const decideQuestion = admission.decideTurn({
          root: "root-s",
          provenance: "factory",
          turn: question,
          work: subject.work,
        });
        const { decision: first } = yield* admission
          .dispatchAdmitted(decideQuestion, () => Effect.void)
          .pipe(Effect.orDie);
        if (first.type !== "admitted") return assert.fail("The question was not admitted.");
        // Dispatched, it may be admitted again: its row is taken over by a new generation.
        const second = yield* decideQuestion.pipe(Effect.orDie);
        if (second.type !== "admitted") return assert.fail("The question was not admitted again.");
        assert.strictEqual(second.admitted.admissionId, first.admitted.admissionId);
        assert.isAbove(second.admitted.entrySeq, first.admitted.entrySeq);
        // The earlier dispatch's end settles nothing of the later admission.
        yield* admission.markDispatched(first.admitted).pipe(Effect.orDie);
        assert.deepStrictEqual(
          (yield* admissionsOf("root-s")).map(({ state }) => state),
          ["dispatching"],
        );
        assert.strictEqual(
          yield* admission.release("root-s", second.admitted.entrySeq).pipe(Effect.orDie),
          "kept",
        );
        yield* admission.markDispatched(second.admitted).pipe(Effect.orDie);
        assert.strictEqual(
          yield* admission.release("root-s", second.admitted.entrySeq).pipe(Effect.orDie),
          "released",
        );
      }),
    ),
  );

  it.effect(
    "dispatches an admission whose fiber is interrupted at the probe before marking it",
    () =>
      Effect.flatMap(pausingProbe, (paused) =>
        withAdmission(
          () =>
            Effect.gen(function* () {
              const admission = yield* service;
              const subject = yield* seed("subject", {
                state: "running",
                root: "root-s",
                slot: "held",
              });
              const ran: Array<string> = [];
              paused.state.armed = true;
              const fiber = yield* admission
                .dispatchAdmitted(
                  admission.enter(
                    { root: "root-s", deliveryId: "root-s", effectId: 1, fresh: true },
                    subject.work,
                  ),
                  () => Effect.sync(() => void ran.push("dispatched")),
                )
                .pipe(Effect.orDie, Effect.forkChild);
              const admitted = yield* Deferred.await(paused.entered);
              // The interrupt is sent now and waits for the region to end.
              const interrupting = yield* Fiber.interrupt(fiber).pipe(
                Effect.forkChild({ startImmediately: true }),
              );
              assert.isUndefined(interrupting.pollUnsafe());
              assert.deepStrictEqual(ran, []);
              assert.deepStrictEqual(
                (yield* admissionsOf("root-s")).map(({ state }) => state),
                ["dispatching"],
              );
              assert.strictEqual(
                yield* admission.release("root-s", admitted.entrySeq).pipe(Effect.orDie),
                "kept",
              );
              yield* Deferred.succeed(paused.go, undefined);
              yield* Fiber.join(interrupting);
              assert.deepStrictEqual(ran, ["dispatched"]);
              assert.deepStrictEqual(
                (yield* admissionsOf("root-s")).map(({ state }) => state),
                ["dispatched"],
              );
            }).pipe(Effect.ensuring(Deferred.succeed(paused.go, undefined))),
          paused.probe,
        ),
      ),
  );
});

describe("kept native redelivery", () => {
  /** A native wake's kept dispatch, counting its runs and signalling each. */
  const keptDispatch = Effect.gen(function* () {
    const runs = { count: 0, done: yield* Deferred.make<void>() };
    const dispatch = Effect.suspend(() => {
      runs.count += 1;
      return Deferred.succeed(runs.done, undefined);
    }).pipe(Effect.asVoid);
    return { runs, kept: { dispatch } satisfies HandoffAdmission.KeptDispatch };
  });

  it.effect("blocks a reserved native wake whose authority was revoked since its reservation", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        const { runs, kept } = yield* keptDispatch;
        const demand = yield* reservedDemand(turns.native(), kept);
        yield* reviseSubject({ executionAuthorized: false });
        // Revoked, it is refused before any read of the item.
        assert.deepStrictEqual(yield* admission.redeliverNative(demand.id).pipe(Effect.orDie), {
          type: "blocked",
          category: "revoked",
        });
        assert.strictEqual(runs.count, 0);
        assert.isUndefined(yield* slotOf("root-s"));
        assert.deepStrictEqual(yield* admissionsOf("root-s"), []);
        const [blocked] = yield* demandsOf("root-s");
        assert.deepStrictEqual(
          { state: blocked?.state, blockedReason: blocked?.blockedReason },
          { state: "waiting", blockedReason: "revoked" },
        );
        // Its dispatch is still kept: authorized again and granted, it runs once.
        yield* admission.pruneKept.pipe(Effect.orDie);
        yield* reviseSubject({ executionAuthorized: true });
        assert.strictEqual(
          yield* admission
            .recheckBlocked({ root: "root-s", work: freshRead("subject"), force: true })
            .pipe(Effect.orDie),
          1,
        );
        assert.strictEqual(
          (yield* admission.reserve(blocked!.id, freshRead("subject")).pipe(Effect.orDie)).type,
          "reserved",
        );
        const asked = yield* admission.redeliverNative(blocked!.id).pipe(Effect.orDie);
        assert.strictEqual(asked.type, "needs_work");
        assert.deepStrictEqual(
          yield* admission.redeliverNative(blocked!.id, freshRead("subject")).pipe(Effect.orDie),
          { type: "dispatched" },
        );
        yield* Deferred.await(runs.done);
        assert.strictEqual(runs.count, 1);
        assert.strictEqual((yield* slotOf("root-s"))?.state, "held");
        assert.deepStrictEqual(yield* demandsOf("root-s"), []);
      }),
    ),
  );

  it.effect(
    "blocks a reserved native wake whose item changed or is unreadable since its reservation",
    () =>
      withAdmission(() =>
        Effect.gen(function* () {
          const admission = yield* service;
          const { runs, kept } = yield* keptDispatch;
          const demand = yield* reservedDemand(turns.native(), kept);
          const asked = yield* admission.redeliverNative(demand.id).pipe(Effect.orDie);
          // The item it names is the root's, frozen in its link.
          assert.deepStrictEqual<unknown>(asked, {
            type: "needs_work",
            item: { sourceId: "source-1", itemId: "item-subject" },
          });
          // Asking writes nothing: the reservation still waits for the read.
          assert.strictEqual((yield* slotOf("root-s"))?.state, "reserved");
          assert.deepStrictEqual(
            yield* admission
              .redeliverNative(demand.id, { type: "read", fingerprint: "edited", status: "todo" })
              .pipe(Effect.orDie),
            { type: "blocked", category: "scope_changed" },
          );
          assert.strictEqual(runs.count, 0);
          assert.isUndefined(yield* slotOf("root-s"));
          assert.deepStrictEqual(yield* admissionsOf("root-s"), []);
          assert.strictEqual((yield* demandsOf("root-s"))[0]?.blockedReason, "scope_changed");
          // Reserved again with the item unreadable at its conversion: blocked again.
          yield* admission
            .recheckBlocked({ root: "root-s", work: freshRead("subject"), force: true })
            .pipe(Effect.orDie);
          yield* admission.reserve(demand.id, freshRead("subject")).pipe(Effect.orDie);
          assert.deepStrictEqual(
            yield* admission.redeliverNative(demand.id, { type: "unreadable" }).pipe(Effect.orDie),
            { type: "blocked", category: "unreadable" },
          );
          assert.strictEqual(runs.count, 0);
        }),
      ),
  );
});

describe("revocation of work already waiting", () => {
  it.effect("refuses a waiting effect once its root is revoked, granted or asked again", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        const subject = yield* seed("subject", { state: "running", root: "root-s" });
        yield* fill(2);
        assert.deepStrictEqual(yield* enter({ root: "root-s", effectId: 1 }, subject.work), {
          decision: { type: "defer" },
          reads: 0,
        });
        const [demand] = yield* demandsOf("root-s");
        // Revoked while it waits, then a slot frees.
        yield* reviseSubject({ executionAuthorized: false });
        yield* admission
          .release("root-other-1", (yield* slotOf("root-other-1"))!.entry_seq)
          .pipe(Effect.orDie);

        // The tick's grant refuses it, writing nothing, for its redispatch to be refused.
        const before = yield* snapshot;
        assert.deepStrictEqual(yield* admission.grantEffect(demand!.id).pipe(Effect.orDie), {
          type: "refused",
          category: "revoked",
          deliveryId: "root-s",
          effectId: 1,
        });
        assert.deepStrictEqual(yield* snapshot, before);
        assert.strictEqual((yield* admission.next.pipe(Effect.orDie)).free, 1);
        assert.deepStrictEqual(
          (yield* admission.blockRevoked.pipe(Effect.orDie)).map(({ demand, category }) => [
            demand.id,
            category,
          ]),
          [[demand!.id, "revoked"]],
        );
        // Asked again, the effect is refused with no read, and its demand goes.
        assert.deepStrictEqual(yield* enter({ root: "root-s", effectId: 1 }, subject.work), {
          decision: { type: "refuse", category: "revoked" },
          reads: 0,
        });
        assert.deepStrictEqual(yield* demandsOf("root-s"), []);
        assert.strictEqual((yield* historyOf("subject")).at(-1)?.outcome, "declined");
        assert.isUndefined(yield* slotOf("root-s"));
        // An effect that never waited is refused just the same, with capacity free.
        assert.deepStrictEqual(
          yield* enter({ root: "root-s", deliveryId: "child-1", effectId: 2 }, subject.work),
          { decision: { type: "refuse", category: "revoked" }, reads: 0 },
        );
        assert.deepStrictEqual(yield* demandsOf("root-s"), []);
      }),
    ),
  );

  it.effect(
    "blocks a waiting automatic demand once its root is revoked, and restores it later",
    () =>
      withAdmission(() =>
        Effect.gen(function* () {
          const admission = yield* service;
          const subject = yield* seed("subject", { state: "running", root: "root-s" });
          yield* fill(2);
          yield* decide({ root: "root-s", turn: turns.pullRequest() }, subject.work);
          const [waiting] = yield* demandsOf("root-s");
          assert.strictEqual(waiting?.blockedReason, null);
          yield* reviseSubject({ executionAuthorized: false });
          yield* admission
            .release("root-other-1", (yield* slotOf("root-other-1"))!.entry_seq)
            .pipe(Effect.orDie);

          // The tick reaches it with a slot free: it is blocked, not passed over as stale.
          assert.deepStrictEqual(
            yield* admission.reserve(waiting!.id, subject.work).pipe(Effect.orDie),
            { type: "blocked", category: "revoked" },
          );
          const [blocked] = yield* demandsOf("root-s");
          assert.deepStrictEqual(
            { state: blocked?.state, blockedReason: blocked?.blockedReason, seq: blocked?.seq },
            { state: "waiting", blockedReason: "revoked", seq: waiting!.seq },
          );
          assert.isUndefined(yield* slotOf("root-s"));
          assert.strictEqual((yield* historyOf("subject")).at(-1)?.outcome, "blocked");
          assert.deepStrictEqual(
            yield* admission.reserve(waiting!.id, subject.work).pipe(Effect.orDie),
            { type: "stale" },
          );

          // Authorized again, it is no candidate until a re-check restores it at a fresh position.
          yield* reviseSubject({ executionAuthorized: true });
          assert.isUndefined((yield* admission.next.pipe(Effect.orDie)).head);
          assert.strictEqual(
            yield* admission
              .recheckBlocked({ root: "root-s", work: subject.work, force: true })
              .pipe(Effect.orDie),
            1,
          );
          const [restored] = yield* demandsOf("root-s");
          assert.strictEqual(restored?.blockedReason, null);
          assert.isAbove(restored!.seq, waiting!.seq);
          assert.strictEqual(restored?.overtaken, 0);
          assert.strictEqual(
            (yield* admission.next.pipe(Effect.orDie)).head?.id,
            `demand:${waiting!.id}`,
          );
          assert.strictEqual(
            (yield* admission.reserve(waiting!.id, subject.work).pipe(Effect.orDie)).type,
            "reserved",
          );
        }),
      ),
  );

  it.effect("blocks a waiting demand presented again after a revocation, reading nothing", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const subject = yield* seed("subject", { state: "running", root: "root-s" });
        yield* fill(2);
        const limit = turns.limit();
        assert.strictEqual(
          (yield* decide({ root: "root-s", turn: limit }, subject.work)).decision.type,
          "demand",
        );
        const [waiting] = yield* demandsOf("root-s");
        yield* reviseSubject({ executionAuthorized: false });
        const again = yield* decide({ root: "root-s", turn: limit }, subject.work);
        assert.deepStrictEqual(again, {
          decision: { type: "blocked", demandId: waiting!.id, category: "revoked" },
          reads: 0,
          ran: false,
        });
        // Blocked already, a further presentation changes nothing.
        const before = yield* snapshot;
        const later = yield* decide({ root: "root-s", turn: limit }, subject.work);
        assert.deepStrictEqual(later.decision, { type: "demand", demandId: waiting!.id });
        assert.strictEqual(later.reads, 0);
        assert.deepStrictEqual(yield* snapshot, before);
        // A turn arriving while revoked waits blocked; a continuation declines.
        const completion = yield* decide(
          { root: "root-s", turn: turns.completion() },
          subject.work,
        );
        assert.strictEqual(completion.decision.type, "blocked");
        assert.strictEqual(completion.reads, 0);
        assert.strictEqual(
          (yield* decide({ root: "root-s", turn: turns.continuation() }, subject.work)).decision
            .type,
          "declined",
        );
        assert.deepStrictEqual(
          (yield* demandsOf("root-s")).map(({ kind, blockedReason }) => [kind, blockedReason]),
          [
            ["usage_limit_resume", "revoked"],
            ["delegated_completion", "revoked"],
          ],
        );
      }),
    ),
  );

  it.effect("blocks each waiting demand of a revoked root in one pass, leaving others alone", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        const subject = yield* seed("subject", { state: "running", root: "root-s" });
        const bravo = yield* seed("bravo", { state: "running", root: "root-b" });
        yield* fill(2);
        yield* decide({ root: "root-s", turn: turns.pullRequest() }, subject.work);
        yield* decide({ root: "root-s", turn: turns.question() }, subject.work);
        yield* enter({ root: "root-s", effectId: 4 }, subject.work);
        yield* decide({ root: "root-b", turn: turns.pullRequest() }, bravo.work);
        const bravoBefore = yield* demandsOf("root-b");
        yield* reviseSubject({ executionAuthorized: false });

        const refused = yield* admission.blockRevoked.pipe(Effect.orDie);
        assert.deepStrictEqual(
          refused.map(({ demand, category }) => [demand.kind, demand.effectId, category]),
          [["effect", 4, "revoked"]],
        );
        assert.deepStrictEqual(
          (yield* demandsOf("root-s")).map(({ kind, blockedReason }) => [kind, blockedReason]),
          [
            ["pull_request_wake", "revoked"],
            ["delegated_question", "revoked"],
            ["effect", null],
          ],
        );
        assert.deepStrictEqual(yield* demandsOf("root-b"), bravoBefore);
        // Again, it changes nothing and returns the effect still to be refused.
        const before = yield* snapshot;
        assert.deepStrictEqual(yield* admission.blockRevoked.pipe(Effect.orDie), refused);
        assert.deepStrictEqual(yield* snapshot, before);
      }),
    ),
  );
});

/** Fails every dispatched mark until `allowMarks`, as a failing write would. */
const refuseMarks = sqlRun(
  (sql) => sql`CREATE TRIGGER refuse_mark
  BEFORE UPDATE OF state ON fd_assistant_admissions WHEN NEW.state = 'dispatched'
  BEGIN SELECT RAISE(ABORT, 'refused'); END`,
);
const allowMarks = sqlRun((sql) => sql`DROP TRIGGER refuse_mark`);

describe("a dispatched mark that fails", () => {
  it.effect("marks a finished dispatch again once writes work, without running it twice", () =>
    Effect.flatMap(pausingProbe, (paused) =>
      withAdmission(
        () =>
          Effect.gen(function* () {
            const admission = yield* service;
            const subject = yield* seed("subject", {
              state: "running",
              root: "root-s",
              slot: "held",
            });
            yield* fill(1);
            yield* seed("queued", { queued: true });
            const runs = { count: 0 };
            const run = () => Effect.sync(() => void (runs.count += 1));
            const effect = (effectId: number) =>
              admission.enter(
                { root: "root-s", deliveryId: "root-s", effectId, fresh: true },
                subject.work,
              );

            // The dispatch returns; its mark fails, and the row still reads as dispatching.
            yield* refuseMarks;
            const finished = yield* admission.dispatchAdmitted(effect(1), run).pipe(Effect.orDie);
            assert.strictEqual(finished.decision.type, "proceed");
            assert.strictEqual(runs.count, 1);
            assert.deepStrictEqual(
              (yield* admissionsOf("root-s")).map(({ state }) => state),
              ["dispatching"],
            );
            // While marks still fail, nothing is judged: the pass and the release fail.
            const entry = (yield* slotOf("root-s"))!.entry_seq;
            const pass = yield* admission
              .settleAdmissions("root-s", () => Effect.succeed("ended" as const))
              .pipe(Effect.flip);
            assert.strictEqual(pass._tag, "HandoffAdmissionError");
            assert.strictEqual(
              (yield* admission.release("root-s", entry).pipe(Effect.flip))._tag,
              "HandoffAdmissionError",
            );
            assert.strictEqual((yield* slotOf("root-s"))?.state, "held");

            // Writes work again; another effect is admitted and held at its probe, really active.
            yield* allowMarks;
            paused.state.armed = true;
            const active = yield* admission
              .dispatchAdmitted(effect(2), run)
              .pipe(Effect.orDie, Effect.forkChild);
            const admitted = yield* Deferred.await(paused.entered);
            paused.state.armed = false;
            // The pass marks the finished generation and deletes it, never running it again;
            // the active one still holds the slot.
            assert.deepStrictEqual(
              yield* admission
                .settleAdmissions("root-s", () => Effect.succeed("ended" as const))
                .pipe(Effect.orDie),
              { entrySeq: admitted.entrySeq, busy: true, unknown: false },
            );
            assert.deepStrictEqual(
              (yield* admissionsOf("root-s")).map(({ admission_id, state }) => [
                admission_id,
                state,
              ]),
              [[admitted.admissionId, "dispatching"]],
            );
            assert.strictEqual(runs.count, 1);
            assert.strictEqual(
              yield* admission.release("root-s", admitted.entrySeq).pipe(Effect.orDie),
              "kept",
            );
            assert.strictEqual((yield* admission.next.pipe(Effect.orDie)).free, 0);
            assert.deepStrictEqual(
              yield* admission
                .claim({ assignmentId: "queued", deliveryId: "root-q" })
                .pipe(Effect.orDie),
              { type: "stale" },
            );

            // Once that one returns too, the slot goes and the waiting assignment is claimed.
            yield* Deferred.succeed(paused.go, undefined);
            yield* Fiber.join(active);
            assert.strictEqual(runs.count, 2);
            const settled = yield* admission
              .settleAdmissions("root-s", () => Effect.succeed("ended" as const))
              .pipe(Effect.orDie);
            assert.isFalse(settled.busy);
            assert.strictEqual(
              yield* admission.release("root-s", settled.entrySeq!).pipe(Effect.orDie),
              "released",
            );
            assert.strictEqual((yield* admission.next.pipe(Effect.orDie)).free, 1);
            assert.strictEqual(
              (yield* admission
                .claim({ assignmentId: "queued", deliveryId: "root-q" })
                .pipe(Effect.orDie)).type,
              "claimed",
            );
          }).pipe(Effect.ensuring(Deferred.succeed(paused.go, undefined))),
        paused.probe,
      ),
    ),
  );

  it.effect("takes a finished turn whose mark failed as no longer in flight, by generation", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        const subject = yield* seed("subject", { state: "running", root: "root-s", slot: "held" });
        const question = turns.question();
        const present = () =>
          admission
            .dispatchAdmitted(
              admission.decideTurn({
                root: "root-s",
                provenance: "factory",
                turn: question,
                work: subject.work,
              }),
              () => Effect.void,
            )
            .pipe(Effect.orDie);
        yield* refuseMarks;
        const first = yield* present();
        if (first.decision.type !== "admitted")
          return assert.fail("The question was not admitted.");
        // Its dispatch returned: presented again, it is admitted again, not held as in flight.
        const second = yield* present();
        if (second.decision.type !== "admitted") {
          return assert.fail("The question was held as in flight.");
        }
        assert.isAbove(second.decision.admitted.entrySeq, first.decision.admitted.entrySeq);
        yield* allowMarks;
        // Both owed marks are flushed by generation: the earlier is superseded, the later marked.
        const settled = yield* admission
          .settleAdmissions("root-s", () => Effect.succeed("ended" as const))
          .pipe(Effect.orDie);
        assert.deepStrictEqual(settled, {
          entrySeq: second.decision.admitted.entrySeq,
          busy: false,
          unknown: false,
        });
        assert.deepStrictEqual(yield* admissionsOf("root-s"), []);
      }),
    ),
  );

  it.effect("parks a claim whose mark failed once writes work", () =>
    withAdmission(() =>
      Effect.gen(function* () {
        const admission = yield* service;
        yield* seed("subject", { queued: true });
        yield* refuseMarks;
        const { decision } = yield* admission
          .dispatchAdmitted(
            admission.claim({ assignmentId: "subject", deliveryId: "root-s" }),
            () => Effect.void,
          )
          .pipe(Effect.orDie);
        if (decision.type !== "claimed") return assert.fail("The claim was not made.");
        yield* setControl("stop");
        // While marks fail, parking fails rather than reading the claim as still in flight.
        assert.strictEqual(
          (yield* admission
            .parkPreStart({
              root: "root-s",
              admissionId: decision.admitted.admissionId,
              entrySeq: decision.admitted.entrySeq,
            })
            .pipe(Effect.flip))._tag,
          "HandoffAdmissionError",
        );
        yield* allowMarks;
        assert.strictEqual(yield* park(decision.admitted), "parked");
        assert.isUndefined(yield* slotOf("root-s"));
        assert.strictEqual((yield* assignmentOf("subject")).state, "stopped");
      }),
    ),
  );
});
