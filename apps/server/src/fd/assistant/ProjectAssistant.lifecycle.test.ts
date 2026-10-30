import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as Launches from "../../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import { v2PullRequestThread } from "../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Projects from "../../project/ProjectService.ts";
import * as Git from "../../vcs/GitVcsDriver.ts";
import * as HandoffAdmission from "./HandoffAdmission.ts";
import * as HandoffBackend from "./handoffBackend.ts";
import * as Looper from "./Looper.ts";
import { briefScopeHash } from "./portfolio.ts";
import * as Assistant from "./ProjectAssistant.ts";

/**
 * A Factory assignment's lifecycle over a fake Factory: what it mirrors of each delivery, when its
 * slot is released and when its root retires, under each activity Factory can report, and what its
 * controls ask of Factory. The `FactoryHandoff.*` suites run the same paths on the real stack.
 */

const alpha = ProjectId.make("alpha");
const managerId = ThreadId.make("fd-assistant-owner");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "configured" };
const at = "2026-10-30T12:00:00.000Z";
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const itemId = WorkItemId.make("item-export");

const manager = v2PullRequestThread({
  id: managerId,
  projectId: ProjectId.make("manager-workspace"),
  title: "Assistant",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestUserMessageAt: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
}) as OrchestrationV2ThreadShell;

type Follow = HandoffBackend.HandoffFollow;
type Observation = HandoffAdmission.Observation;

const idle: Observation = { phase: "parked", busy: false, deferred: false, unknown: false };

/** A delivery past queued, as a fresh follow reads it. */
const row = (root: string, overrides: Partial<Follow> = {}): Follow => ({
  deliveryId: root,
  status: "running",
  stage: "author",
  awaiting: "run",
  pullRequest: null,
  reason: null,
  threadId: "author-thread",
  child: null,
  marked: [],
  ...overrides,
});

const makeFakes = () => ({
  deliveries: new Map<string, Follow>(),
  activity: { ...idle } as Observation,
  activityFails: false,
  followFails: false,
  requests: [] as Array<HandoffBackend.HandoffRequest>,
  deferral: "stale" as "deferred" | "running" | "stale",
  /** Runs inside each `ensureDeferred`, before it answers. */
  onDeferral: undefined as Effect.Effect<void> | undefined,
  workReads: 0,
  startFails: false,
  runState: "ended" as "live" | "ended" | "none" | "fails",
  /** Every Factory call but a read, in order, as `<operation>:<id>`. */
  calls: [] as Array<string>,
  dispatched: [] as Array<Parameters<Threads.ThreadManagementService["Service"]["dispatch"]>[0]>,
});
type Fakes = ReturnType<typeof makeFakes>;

const factoryPort = (fakes: Fakes): typeof HandoffBackend.HandoffFactory.Service => ({
  verifyConfigured: () => Effect.succeed(true),
  get: (id) =>
    Effect.sync(() => {
      const found = fakes.deliveries.get(id);
      return found === undefined
        ? Option.none()
        : Option.some({ deliveryId: id, status: found.status });
    }),
  follow: (id) =>
    fakes.followFails
      ? Effect.fail(new HandoffBackend.HandoffFactoryError({ operation: "follow" }))
      : Effect.sync(() => Option.fromUndefinedOr(fakes.deliveries.get(id))),
  start: ({ deliveryId }) =>
    Effect.suspend(() => {
      fakes.calls.push(`start:${deliveryId}`);
      if (fakes.startFails) {
        return Effect.fail(new HandoffBackend.HandoffFactoryError({ operation: "start" }));
      }
      const started = row(deliveryId);
      fakes.deliveries.set(deliveryId, started);
      return Effect.succeed({ deliveryId, status: started.status });
    }),
  stop: (id) =>
    Effect.gen(function* () {
      fakes.calls.push(`stop:${id}`);
      const found = fakes.deliveries.get(id);
      if (found?.status !== "running" && found?.status !== "stopping") {
        return yield* new HandoffBackend.HandoffFactoryRefused({
          operation: "stop",
          reason: "not_stoppable",
        });
      }
      fakes.deliveries.set(id, { ...found, status: "stopping" });
      return { deliveryId: id, status: "stopping" as const };
    }),
  resume: (id) =>
    Effect.sync(() => {
      fakes.calls.push(`resume:${id}`);
      const found = fakes.deliveries.get(id) ?? row(id);
      fakes.deliveries.set(id, { ...found, status: "running", reason: null });
      return { deliveryId: id, status: "running" as const };
    }),
  cancel: (id) =>
    Effect.sync(() => {
      fakes.calls.push(`cancel:${id}`);
      const found = fakes.deliveries.get(id) ?? row(id);
      fakes.deliveries.set(id, { ...found, status: "cancelled", awaiting: null });
      return { deliveryId: id, status: "cancelled" as const };
    }),
  activity: () =>
    Effect.suspend(() =>
      fakes.activityFails
        ? Effect.fail(new HandoffBackend.HandoffFactoryError({ operation: "activity" }))
        : Effect.succeed(fakes.activity),
    ),
  ensureDeferred: (id, effectId) =>
    Effect.suspend(() => {
      fakes.calls.push(`ensureDeferred:${id}:${effectId}`);
      const hook = fakes.onDeferral;
      fakes.onDeferral = undefined;
      return Effect.as(hook ?? Effect.void, fakes.deferral);
    }),
  redispatch: (id, effectId) =>
    Effect.sync(() => {
      fakes.calls.push(`redispatch:${id}:${effectId}`);
      return "dispatched" as const;
    }),
  runStateOf: () =>
    Effect.suspend(() =>
      fakes.runState === "fails"
        ? Effect.fail(new HandoffBackend.HandoffFactoryError({ operation: "runState" }))
        : Effect.succeed(fakes.runState),
    ),
  requests: () => Effect.sync(() => fakes.requests),
});

const layerOf = (fakes: Fakes) => {
  const coreReads = Layer.mergeAll(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: () => Effect.succeed(manager),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (projectId) =>
        Effect.succeed(
          Option.some({
            projectId,
            title: "Alpha",
            workspaceRoot: "/projects/alpha",
            createdAt: at,
            updatedAt: at,
            deletedAt: null,
            repositories: [],
          } as never),
        ),
    }),
  );
  const admission = HandoffAdmission.layer.pipe(
    Layer.provide(Layer.mergeAll(coreReads, Assistant.layerPersistence)),
  );
  const core = Layer.mergeAll(
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(id === managerId ? manager : null),
      dispatch: (command) =>
        Effect.sync(() => {
          fakes.dispatched.push(command);
          return {} as never;
        }),
    }),
    Layer.mock(Looper.Looper)({}),
    Layer.mock(Projects.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          Option.some({
            id,
            title: id,
            workspaceRoot: `/projects/${id}`,
            repositories: [],
            scripts: [],
            createdAt: at,
            updatedAt: at,
            deletedAt: null,
          } as never),
        ),
    }),
    Layer.mock(Git.GitVcsDriver)({}),
    Layer.mock(Launches.ThreadLaunchService)({}),
    Layer.succeed(HandoffBackend.HandoffFactory, factoryPort(fakes)),
    Layer.succeed(HandoffBackend.HandoffBackend, {
      ...HandoffBackend.HandoffBackend.defaultValue(),
      read: (ref) =>
        Effect.sync(() => {
          fakes.workReads += 1;
        }).pipe(
          Effect.as({
            ref,
            key: ref.itemId,
            url: null,
            title: "An item",
            status: "todo",
            revision: "1",
            invalid: false,
            body: "",
            fingerprint: "print",
            notes: "",
          } as const),
        ),
    }),
  );
  return Assistant.layer.pipe(Layer.provideMerge(admission), Layer.provide(core));
};

const service = Assistant.ProjectAssistant;

/** An authorized brief with its item captured, queued as a Factory assignment and claimed. */
const claimedAssignment = (fakes: Fakes) =>
  Effect.gen(function* () {
    const assistant = yield* service;
    const sql = yield* SqlClient.SqlClient;
    const brief = yield* assistant.revise({
      projectId: alpha,
      ideaId: "idea",
      patch: {
        goal: "Deliver the export",
        acceptanceCriteria: ["It exports."],
        executionAuthorized: true,
      },
    });
    yield* sql`INSERT INTO fd_assistant_work_captures ${sql.insert({
      project_id: alpha,
      idea_id: "idea",
      capture_id: "cap-idea",
      source_id: sourceId,
      kind: "single",
      state: "captured",
      writer_instance_id: "writer",
      item_id: itemId,
      item_key: "fd-idea",
      item_url: null,
      item_fingerprint: "print",
      content_hash: "content",
      scope_hash: briefScopeHash(brief),
      brief_revision: brief.revision,
      updated_at: at,
    })}`;
    yield* assistant.enqueue({
      assignmentId: "idea",
      projectId: alpha,
      ideaId: "idea",
      executor: "factory",
      managerThreadId: managerId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      looperConfig: null,
    });
    yield* assistant.tick;
    const root = [...fakes.deliveries.keys()][0] ?? assert.fail("Nothing started.");
    assert.strictEqual(yield* stateOf(), "running");
    return root;
  });

const stateOf = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [found] = yield* sql<{ readonly state: string }>`
      SELECT state FROM fd_assistant_assignments WHERE assignment_id = 'idea'`;
    return found?.state;
  });

const inspected = Effect.flatMap(service, (assistant) => assistant.inspect(alpha, "idea")).pipe(
  Effect.map(({ assignments }) => assignments[0] ?? assert.fail("No assignment.")),
);

const notes = Effect.map(inspected, ({ progress }) => progress.map(({ text }) => text));

const tick = Effect.flatMap(service, (assistant) => assistant.tick);

const control = (action: "stop" | "resume" | "retry" | "cancel") =>
  Effect.flatMap(service, (assistant) =>
    assistant.control({ assignmentId: "idea", managerThreadId: managerId, action }),
  );

const slotOf = (root: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [found] = yield* sql<{ readonly state: string }>`
      SELECT state FROM fd_assistant_slots WHERE root_delivery_id = ${root}`;
    return found?.state;
  });

const rootOf = (root: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [found] = yield* sql<{ readonly state: string; readonly reason: string | null }>`
      SELECT state, reason FROM fd_assistant_managed_roots WHERE root_delivery_id = ${root}`;
    return found;
  });

const count = (fakes: Fakes, operation: string) =>
  fakes.calls.filter((call) => call.startsWith(`${operation}:`)).length;

const withFakes = <A, E, R>(fakes: Fakes, body: Effect.Effect<A, E, R>) =>
  body.pipe(Effect.provide(Layer.provideMerge(layerOf(fakes), Sqlite.layerMemory)));

const url = "https://github.com/acme/alpha/pull/7";

describe("what a Factory assignment shows of its delivery", () => {
  it.effect.each([
    { name: "running", delivery: {}, shows: "running" },
    { name: "approved", delivery: { status: "approved", awaiting: "effect" }, shows: "running" },
    {
      name: "a pull request being followed up",
      delivery: {
        status: "pr_open",
        awaiting: "run",
        pullRequest: { url, outcome: null },
      },
      shows: "running",
    },
    { name: "stopping", delivery: { status: "stopping" }, shows: "stopping" },
    { name: "stopped", delivery: { status: "stopped", awaiting: null }, shows: "stopped" },
    {
      name: "waiting at the plan gate",
      delivery: { status: "waiting", awaiting: null, reason: "A plan of 2 tasks awaits." },
      shows: "needs-input",
      says: "Approve, edit or replan it in the item's Factory section in Work.",
    },
    {
      name: "blocked by a failed close-out",
      delivery: {
        status: "blocked",
        awaiting: null,
        reason: "Work could not set the item done.",
      },
      shows: "needs-input",
      says: "Work could not set the item done. Resume it once that is fixed",
    },
    {
      name: "an open pull request with nothing awaited",
      delivery: {
        status: "pr_open",
        awaiting: null,
        pullRequest: { url, outcome: null },
      },
      shows: "needs-input",
      says: `PR ${url} open; review and merge.`,
    },
  ] as const)("shows $shows for a delivery $name", ({ delivery, shows, ...expected }) => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* claimedAssignment(fakes);
        fakes.deliveries.set(root, row(root, delivery as Partial<Follow>));
        yield* tick;
        assert.strictEqual(yield* stateOf(), shows);
        const says = "says" in expected ? expected.says : undefined;
        if (says !== undefined) {
          const written = yield* notes;
          assert.isTrue(
            written.some((note) => note.includes(says)),
            written.join("\n"),
          );
        }
        // Mirrored again, it adds nothing.
        const before = yield* inspected;
        yield* tick;
        assert.deepStrictEqual((yield* inspected).progress, before.progress);
        const refs = (yield* inspected).workerRefs.map(({ kind }) => kind);
        assert.includeMembers(refs, ["factory-delivery", "work-item", "thread"]);
      }),
    );
  });

  it.effect("shows a parent as the child it awaits, and resumes that child", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* claimedAssignment(fakes);
        fakes.deliveries.set(
          root,
          row(root, {
            awaiting: "child",
            child: {
              deliveryId: "child-1",
              status: "blocked",
              stage: "verify",
              reason: "Verify still fails.",
              threadId: "child-thread",
            },
          }),
        );
        yield* tick;
        assert.strictEqual(yield* stateOf(), "needs-input");
        assert.isTrue((yield* notes).some((note) => note.includes("Verify still fails.")));
        yield* control("resume");
        assert.deepStrictEqual(
          fakes.calls.filter((call) => call.startsWith("resume:")),
          ["resume:child-1"],
        );
      }),
    );
  });

  it.effect("never completes before its delivery is done, whatever its pull request did", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* claimedAssignment(fakes);
        fakes.deliveries.set(
          root,
          row(root, {
            status: "pr_open",
            awaiting: "effect",
            pullRequest: { url, outcome: "merged" },
          }),
        );
        fakes.activity = { ...idle, phase: "proceeding" };
        yield* tick;
        assert.strictEqual(yield* stateOf(), "running");
        assert.deepStrictEqual(yield* rootOf(root), { state: "active", reason: null });
        assert.strictEqual(yield* slotOf(root), "held");
      }),
    );
  });
});

describe("a Factory assignment's slot", () => {
  it.effect("is released for a parked, quiescent family, and only then", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* claimedAssignment(fakes);
        // Proceeding, it stays held however quiet the threads are.
        fakes.activity = { ...idle, phase: "proceeding" };
        yield* tick;
        assert.strictEqual(yield* slotOf(root), "held");
        // Parked and busy, it stays too, with a note.
        fakes.deliveries.set(root, row(root, { status: "stopped", awaiting: null }));
        fakes.activity = { ...idle, busy: true };
        yield* tick;
        assert.strictEqual(yield* slotOf(root), "held");
        assert.isTrue((yield* notes).some((note) => note.includes("is still running")));
        // Parked with nothing known, it stays, with a note.
        fakes.activity = { ...idle, unknown: true };
        yield* tick;
        assert.strictEqual(yield* slotOf(root), "held");
        assert.isTrue((yield* notes).some((note) => note.includes("could not be read")));
        // Quiet at last.
        fakes.activity = idle;
        yield* tick;
        assert.isUndefined(yield* slotOf(root));
      }),
    );
  });

  it.effect.each([
    { runState: "live", label: "a live run" },
    { runState: "fails", label: "a run state that cannot be read" },
  ] as const)("is kept for an admitted turn with $label", ({ runState }) => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const admission = yield* HandoffAdmission.HandoffAdmission;
        const root = yield* claimedAssignment(fakes);
        fakes.deliveries.set(root, row(root, { status: "stopped", awaiting: null }));
        const { admitted } = (yield* admission.decideTurn({
          root,
          provenance: "factory",
          turn: {
            kind: "restart_continuation",
            threadId: ThreadId.make("author-thread"),
            messageId: "message:restart-continuation:run" as never,
            key: "run",
            sourceRunId: "run" as never,
            settled: false,
          },
          work: { type: "read", fingerprint: "print", status: "todo" },
        })) as { readonly admitted: HandoffAdmission.Admitted };
        yield* admission.markDispatched(admitted);
        fakes.runState = runState;
        yield* tick;
        assert.strictEqual(yield* slotOf(root), "held");
        fakes.runState = "ended";
        yield* tick;
        assert.isUndefined(yield* slotOf(root));
      }),
    );
  });
});

describe("a Factory assignment's waiting work, each tick", () => {
  const revise = (executionAuthorized: boolean) =>
    Effect.flatMap(service, (assistant) =>
      assistant.revise({ projectId: alpha, ideaId: "idea", patch: { executionAuthorized } }),
    );
  const resume = (root: string, runId: string) => ({
    root,
    provenance: "factory" as const,
    turn: {
      kind: "usage_limit_resume" as const,
      threadId: ThreadId.make("author-thread"),
      messageId: `limit-resume:${runId}` as never,
      key: `limit-resume:${runId}`,
      usageLimitContinuationOfRunId: runId as never,
    },
  });
  /** A root parked and released, with the other slot and this one's turn left to the test. */
  const released = (fakes: Fakes) =>
    Effect.gen(function* () {
      const root = yield* claimedAssignment(fakes);
      fakes.deliveries.set(
        root,
        row(root, { status: "pr_open", awaiting: null, pullRequest: { url, outcome: null } }),
      );
      yield* tick;
      assert.isUndefined(yield* slotOf(root));
      return root;
    });

  it.effect("keeps a pre-start claim's slot however quiet its missing delivery is", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const assistant = yield* service;
        const sql = yield* SqlClient.SqlClient;
        fakes.startFails = true;
        fakes.activity = { ...idle, phase: "missing" };
        const brief = yield* assistant.revise({
          projectId: alpha,
          ideaId: "idea",
          patch: {
            goal: "Deliver the export",
            acceptanceCriteria: ["It exports."],
            executionAuthorized: true,
          },
        });
        yield* sql`INSERT INTO fd_assistant_work_captures ${sql.insert({
          project_id: alpha,
          idea_id: "idea",
          capture_id: "cap-idea",
          source_id: sourceId,
          kind: "single",
          state: "captured",
          writer_instance_id: "writer",
          item_id: itemId,
          item_key: "fd-idea",
          item_url: null,
          item_fingerprint: "print",
          content_hash: "content",
          scope_hash: briefScopeHash(brief),
          brief_revision: brief.revision,
          updated_at: at,
        })}`;
        yield* assistant.enqueue({
          assignmentId: "idea",
          projectId: alpha,
          ideaId: "idea",
          executor: "factory",
          managerThreadId: managerId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          looperConfig: null,
        });
        yield* tick;
        yield* tick;
        assert.strictEqual(yield* stateOf(), "launch-uncertain");
        const [claimed] = yield* sql<{ readonly root_delivery_id: string }>`
          SELECT root_delivery_id FROM fd_assistant_managed_roots`;
        assert.strictEqual(yield* slotOf(claimed?.root_delivery_id ?? ""), "held");
      }),
    );
  });

  it.effect(
    "gives a marked effect with no demand one, and drops a demand no longer awaited",
    () => {
      const fakes = makeFakes();
      return withFakes(
        fakes,
        Effect.gen(function* () {
          const admission = yield* HandoffAdmission.HandoffAdmission;
          const root = yield* released(fakes);
          fakes.deliveries.set(
            root,
            row(root, {
              status: "running",
              awaiting: "effect",
              marked: [{ deliveryId: root, effectId: 7 }],
            }),
          );
          fakes.activity = { ...idle, phase: "proceeding", deferred: true };
          // Marked: its demand enters the fair order; granted, it is redispatched once.
          fakes.deferral = "deferred";
          yield* tick;
          assert.include(fakes.calls, `redispatch:${root}:7`);
          assert.strictEqual(yield* slotOf(root), "held");
          assert.deepStrictEqual(yield* admission.demands(root), []);
          // Held, a mark still standing runs in the holding rather than wait for a second slot.
          yield* tick;
          assert.lengthOf(
            fakes.calls.filter((call) => call === `redispatch:${root}:7`),
            2,
          );

          // A demand whose delivery awaits another effect goes, with a notice naming Resume.
          fakes.deliveries.set(
            root,
            row(root, { status: "blocked", awaiting: null, reason: "No." }),
          );
          yield* admission.ensureEffectDemand({ root, deliveryId: root, effectId: 8 });
          fakes.deferral = "stale";
          fakes.activity = idle;
          yield* tick;
          assert.deepStrictEqual(yield* admission.demands(root), []);
          assert.isTrue((yield* notes).some((note) => note.includes("Resume it to go on")));
        }),
      );
    },
  );

  it.effect("checks a blocked demand again only when due, or when the owner resumes", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const admission = yield* HandoffAdmission.HandoffAdmission;
        const root = yield* released(fakes);
        yield* revise(false);
        const blocked = yield* admission.decideTurn(resume(root, "run-1"));
        assert.strictEqual(blocked.type, "blocked");
        yield* revise(true);

        // Restored, it stays blocked until its re-check is due, and takes no slot meanwhile.
        yield* tick;
        assert.strictEqual((yield* admission.demands(root))[0]?.blockedReason, "revoked");
        assert.isUndefined(yield* slotOf(root));

        yield* TestClock.adjust(`${HandoffAdmission.BLOCKED_RECHECK_MINUTES} minutes`);
        yield* tick;
        // A fresh read holds: it re-enters at a fresh position and takes its grant.
        const [demand] = yield* admission.demands(root);
        assert.isNull(demand?.blockedReason ?? null);
        assert.strictEqual(demand?.state, "reserved");
        assert.strictEqual(yield* slotOf(root), "reserved");
      }),
    );
  });

  it.effect("reads a root's item once per interval however staggered its blocks", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const admission = yield* HandoffAdmission.HandoffAdmission;
        const root = yield* released(fakes);
        // Stays revoked throughout, so nothing it reads unblocks anything.
        yield* revise(false);
        yield* admission.decideTurn(resume(root, "run-1"));
        yield* TestClock.adjust("1 minute");
        yield* admission.decideTurn(resume(root, "run-2"));
        fakes.workReads = 0;

        // Over five minutes of ticks, the root's two re-checks are two minutes apart.
        const readsAt: Array<number> = [];
        for (let minute = 1; minute <= 5; minute += 1) {
          yield* TestClock.adjust("1 minute");
          const before = fakes.workReads;
          yield* tick;
          yield* tick;
          if (fakes.workReads > before) readsAt.push(minute);
          assert.isAtMost(fakes.workReads - before, 1);
        }
        assert.deepStrictEqual(readsAt, [1, 3, 5]);
      }),
    );
  });

  it.effect("keeps a demand a later effect took over while its old effect was checked", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const admission = yield* HandoffAdmission.HandoffAdmission;
        const assistant = yield* service;
        const sql = yield* SqlClient.SqlClient;
        const root = yield* released(fakes);
        fakes.deliveries.set(root, row(root, { status: "blocked", awaiting: null, reason: "No." }));
        for (const id of ["other", "other-2"]) {
          yield* sql`INSERT INTO fd_assistant_assignments ${sql.insert({
            assignment_id: id,
            project_id: alpha,
            idea_id: id,
            executor: "foredeck",
            attempt: 1,
            state: "running",
            worker_refs_json: "[]",
            progress_json: "[]",
            evidence_json: "[]",
            created_at: at,
            updated_at: at,
          })}`;
        }
        yield* admission.ensureEffectDemand({ root, deliveryId: root, effectId: 7 });

        // While effect 7 is found stale, a Factory resume's effect 8 takes over its row.
        fakes.deferral = "stale";
        fakes.onDeferral = admission
          .enter({ root, deliveryId: root, effectId: 8, fresh: false })
          .pipe(Effect.asVoid, Effect.orDie);
        yield* assistant.tick;

        const [kept] = yield* admission.demands(root);
        assert.strictEqual(kept?.effectId, 8);
        assert.isFalse((yield* notes).some((note) => note.includes("lost its place")));

        // Its own check comes next, whose mark the tick repairs.
        fakes.deferral = "deferred";
        yield* assistant.tick;
        assert.include(fakes.calls, `ensureDeferred:${root}:8`);
        assert.lengthOf(yield* admission.demands(root), 1);

        // Granted, it is the later effect that runs.
        yield* sql`UPDATE fd_assistant_assignments SET state = 'completed'
          WHERE assignment_id = 'other'`;
        yield* assistant.tick;
        assert.include(fakes.calls, `redispatch:${root}:8`);
        assert.notInclude(fakes.calls, `redispatch:${root}:7`);
      }),
    );
  });

  it.effect("ends a reservation whose lease ran out, per kind", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const admission = yield* HandoffAdmission.HandoffAdmission;
        const root = yield* released(fakes);
        // The other slot held, so the turn cannot be admitted at once and waits.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO fd_assistant_assignments ${sql.insert({
          assignment_id: "other",
          project_id: alpha,
          idea_id: "other",
          executor: "foredeck",
          attempt: 1,
          state: "running",
          worker_refs_json: "[]",
          progress_json: "[]",
          evidence_json: "[]",
          created_at: at,
          updated_at: at,
        })}`;
        yield* sql`INSERT INTO fd_assistant_assignments ${sql.insert({
          assignment_id: "other-2",
          project_id: alpha,
          idea_id: "other-2",
          executor: "foredeck",
          attempt: 1,
          state: "running",
          worker_refs_json: "[]",
          progress_json: "[]",
          evidence_json: "[]",
          created_at: at,
          updated_at: at,
        })}`;
        const waits = yield* admission.decideTurn({
          ...resume(root, "run-1"),
          work: { type: "read", fingerprint: "print", status: "todo" },
        });
        assert.strictEqual(waits.type, "demand");
        yield* sql`UPDATE fd_assistant_assignments SET state = 'completed'
          WHERE assignment_id = 'other'`;
        yield* tick;
        assert.strictEqual(yield* slotOf(root), "reserved");

        // Its producer never came back: the lease ends it, and its next presentation starts over.
        yield* TestClock.adjust(`${HandoffAdmission.LEASE_MINUTES} minutes`);
        yield* tick;
        assert.isUndefined(yield* slotOf(root));
        assert.deepStrictEqual(yield* admission.demands(root), []);
      }),
    );
  });
});

describe("a Factory assignment whose delivery ended", () => {
  it.effect("completes only after done, known activity and quiescence, with evidence", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* claimedAssignment(fakes);
        const done = row(root, {
          status: "done",
          awaiting: null,
          pullRequest: { url, outcome: "merged" },
        });
        fakes.deliveries.set(root, done);
        // Busy: fenced, with a note, and held.
        fakes.activity = { ...idle, phase: "terminal", busy: true };
        yield* tick;
        assert.strictEqual(yield* stateOf(), "running");
        assert.deepStrictEqual(yield* rootOf(root), { state: "ending", reason: "completed" });
        assert.strictEqual(yield* slotOf(root), "held");
        // Unknown: the same.
        fakes.activity = { ...idle, phase: "terminal", unknown: true };
        yield* tick;
        assert.strictEqual(yield* stateOf(), "running");
        assert.isTrue((yield* notes).some((note) => note.includes("could not be read")));
        // A read that fails knows nothing either.
        fakes.activityFails = true;
        yield* tick;
        assert.strictEqual(yield* stateOf(), "running");
        assert.deepStrictEqual(yield* rootOf(root), { state: "ending", reason: "completed" });
        // Quiet: released, then retired in the same pass.
        fakes.activityFails = false;
        fakes.activity = { ...idle, phase: "terminal" };
        yield* tick;
        assert.strictEqual(yield* stateOf(), "completed");
        assert.deepStrictEqual(yield* rootOf(root), { state: "retired", reason: "completed" });
        assert.isUndefined(yield* slotOf(root));
        const { evidence } = yield* inspected;
        assert.isTrue(evidence.some((line) => line.includes(url)));
        assert.isTrue(evidence.some((line) => line.includes(root)));
      }),
    );
  });

  it.effect("a contended retirement holds while an admission of the root still counts", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const admission = yield* HandoffAdmission.HandoffAdmission;
        const root = yield* claimedAssignment(fakes);
        const turn = {
          kind: "restart_continuation" as const,
          threadId: ThreadId.make("author-thread"),
          messageId: "message:restart-continuation:run" as never,
          key: "run",
          sourceRunId: "run" as never,
          settled: false,
        };
        const { admitted } = (yield* admission.decideTurn({
          root,
          provenance: "factory",
          turn,
          work: { type: "read", fingerprint: "print", status: "todo" },
        })) as { readonly admitted: HandoffAdmission.Admitted };
        fakes.deliveries.set(root, row(root, { status: "cancelled", awaiting: null }));
        fakes.activity = { ...idle, phase: "terminal" };
        // This instance's dispatch still runs: its row stays and so does the slot.
        yield* tick;
        assert.strictEqual(yield* stateOf(), "running");
        assert.deepStrictEqual(yield* rootOf(root), { state: "ending", reason: "cancelled" });
        assert.strictEqual(yield* slotOf(root), "held");
        assert.isTrue((yield* notes).some((note) => note.includes("has ended")));
        yield* admission.markDispatched(admitted);
        yield* tick;
        assert.strictEqual(yield* stateOf(), "cancelled");
        assert.deepStrictEqual(yield* rootOf(root), { state: "retired", reason: "cancelled" });
      }),
    );
  });

  it.effect.each([
    { from: "stopped", delivery: { status: "stopped", awaiting: null } },
    {
      from: "needs-input",
      delivery: { status: "blocked", awaiting: null, reason: "Verify failed." },
    },
  ] as const)(
    "a cancel from $from calls Factory and shows stopping until it ends",
    ({ from, delivery }) => {
      const fakes = makeFakes();
      return withFakes(
        fakes,
        Effect.gen(function* () {
          const root = yield* claimedAssignment(fakes);
          fakes.deliveries.set(root, row(root, delivery as Partial<Follow>));
          yield* tick;
          assert.strictEqual(yield* stateOf(), from);
          fakes.activity = { ...idle, phase: "terminal", busy: true };
          const asked = yield* control("cancel");
          assert.strictEqual(asked.state, "stopping");
          assert.strictEqual(count(fakes, "cancel"), 1);
          assert.notInclude(fakes.calls.join(), "stop:");
          // A run Factory's cancel did not interrupt holds the assignment, and is named.
          yield* tick;
          assert.strictEqual(yield* stateOf(), "stopping");
          assert.isTrue(
            (yield* notes).some((note) =>
              note.includes("Stop it in the thread to finish cancelling"),
            ),
          );
          fakes.activity = { ...idle, phase: "terminal" };
          yield* tick;
          assert.strictEqual(yield* stateOf(), "cancelled");
          assert.deepStrictEqual(yield* rootOf(root), { state: "retired", reason: "cancelled" });
          assert.strictEqual(count(fakes, "cancel"), 1);
        }),
      );
    },
  );

  it.effect("a retry after a cancel starts a new delivery under a new root", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* claimedAssignment(fakes);
        fakes.deliveries.set(root, row(root, { status: "stopped", awaiting: null }));
        fakes.activity = { ...idle, phase: "terminal" };
        yield* control("cancel");
        yield* tick;
        assert.strictEqual(yield* stateOf(), "cancelled");

        const retried = yield* control("retry");
        assert.strictEqual(retried.state, "queued");
        fakes.activity = { ...idle, phase: "proceeding" };
        yield* tick;
        assert.strictEqual(yield* stateOf(), "running");
        assert.lengthOf(
          fakes.calls.filter((call) => call.startsWith("start:")),
          2,
        );
        const newest = [...fakes.deliveries.keys()].at(-1) ?? assert.fail("Nothing started.");
        assert.notStrictEqual(newest, root);
        assert.deepStrictEqual(yield* rootOf(newest), { state: "active", reason: null });
        assert.deepStrictEqual(yield* rootOf(root), { state: "retired", reason: "cancelled" });
      }),
    );
  });
});

describe("what the overview shows of a Factory assignment", () => {
  const overviewRow = Effect.flatMap(service, (assistant) => assistant.overview).pipe(
    Effect.map(({ assignments }) => assignments[0] ?? assert.fail("No assignment.")),
  );
  const resume = (root: string, runId: string) => ({
    root,
    provenance: "unknown" as const,
    turn: {
      kind: "usage_limit_resume" as const,
      threadId: ThreadId.make("author-thread"),
      messageId: `limit-resume:${runId}` as never,
      key: `limit-resume:${runId}`,
      usageLimitContinuationOfRunId: runId as never,
    },
  });

  it.effect("names its Work item from the capture, and its delivery's progress", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* claimedAssignment(fakes);
        fakes.deliveries.set(
          root,
          row(root, {
            stage: "verify",
            awaiting: "effect",
            marked: [{ deliveryId: root, effectId: 7 }],
            pullRequest: { url, outcome: null },
          }),
        );
        const shown = yield* overviewRow;
        assert.strictEqual(shown.executor, "factory");
        // A Factory assignment has no worker thread of its own for an older client to open.
        assert.isNull(shown.threadId);
        assert.deepStrictEqual(shown.workItem, {
          sourceId,
          itemId,
          key: "fd-idea",
          url: null,
        });
        assert.deepStrictEqual(shown.factory, {
          deliveryId: root,
          status: "running",
          stage: "verify",
          needsYou: null,
          capacityWait: true,
          automaticWaits: { waiting: 0, blocked: 0 },
          endedDispositions: 0,
          notices: [],
          pullRequestUrl: url,
          threadId: ThreadId.make("author-thread"),
        });
      }),
    );
  });

  it.effect("names an idea's capture with the item it found", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        yield* claimedAssignment(fakes);
        const { ideas } = yield* Effect.flatMap(service, (assistant) => assistant.overview);
        assert.deepStrictEqual(ideas[0]?.capture, {
          state: "captured",
          item: { sourceId, itemId, key: "fd-idea", url: null },
        });
      }),
    );
  });

  it.effect("shows a parent as the child that stopped it, on that child's thread", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* claimedAssignment(fakes);
        fakes.deliveries.set(
          root,
          row(root, {
            stage: null,
            awaiting: "child",
            child: {
              deliveryId: "child-1",
              status: "blocked",
              stage: "verify",
              reason: "Verify still fails.",
              threadId: "child-thread",
            },
          }),
        );
        assert.deepInclude((yield* overviewRow).factory, {
          deliveryId: root,
          status: "blocked",
          stage: "verify",
          needsYou: "Verify still fails.",
          threadId: ThreadId.make("child-thread"),
        });
      }),
    );
  });

  it.effect("counts what waits and what is blocked, in their notices' words", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const admission = yield* HandoffAdmission.HandoffAdmission;
        const assistant = yield* service;
        const root = yield* claimedAssignment(fakes);
        // Held by the root itself, its turns wait for a grant of their own.
        assert.strictEqual((yield* admission.decideTurn(resume(root, "run-1"))).type, "demand");
        // A marked effect is the slot wait, never an automatic follow-up.
        yield* admission.ensureEffectDemand({ root, deliveryId: root, effectId: 8 });
        yield* assistant.revise({
          projectId: alpha,
          ideaId: "idea",
          patch: { executionAuthorized: false },
        });
        assert.strictEqual((yield* admission.decideTurn(resume(root, "run-2"))).type, "blocked");

        const { factory } = yield* overviewRow;
        assert.deepStrictEqual(factory?.automaticWaits, { waiting: 1, blocked: 1 });
        assert.strictEqual(factory?.endedDispositions, 0);
        assert.lengthOf(factory?.notices ?? [], 2);
        assert.include(factory?.notices[0], "T3 cannot tell whether it came from the delivery");
        assert.include(factory?.notices[1], "is blocked because");
      }),
    );
  });

  it.effect("keeps the counts and notices bounded however much waits", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const admission = yield* HandoffAdmission.HandoffAdmission;
        const root = yield* claimedAssignment(fakes);
        for (const run of [1, 2, 3, 4, 5, 6, 7]) {
          yield* admission.decideTurn(resume(root, `run-${run}`));
        }
        const { factory } = yield* overviewRow;
        assert.strictEqual(factory?.automaticWaits.waiting, 7);
        assert.lengthOf(factory?.notices ?? [], 5);
      }),
    );
  });

  it.effect("says what arrived after the delivery ended, and what to do about it", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const admission = yield* HandoffAdmission.HandoffAdmission;
        const root = yield* claimedAssignment(fakes);
        fakes.deliveries.set(
          root,
          row(root, { status: "done", awaiting: null, pullRequest: { url, outcome: "merged" } }),
        );
        fakes.activity = { ...idle, phase: "terminal" };
        yield* tick;
        assert.strictEqual(yield* stateOf(), "completed");
        const late = yield* admission.decideTurn(resume(root, "run-late"));
        assert.strictEqual(late.type, "declined");
        // Presented again, it records and counts nothing more.
        yield* admission.decideTurn(resume(root, "run-late"));

        const { factory, notice } = yield* overviewRow;
        assert.strictEqual(factory?.status, "done");
        assert.strictEqual(factory?.pullRequestUrl, url);
        assert.strictEqual(factory?.endedDispositions, 1);
        const expected = `author-thread hit a usage limit after this assignment ended, and was not resumed automatically. Continue it from the thread if you want.`;
        assert.deepStrictEqual(factory?.notices, [expected]);
        assert.strictEqual(notice, expected);
      }),
    );
  });

  it.effect("reads a delivery it cannot read as unknown, and keeps the other fields", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* claimedAssignment(fakes);
        fakes.followFails = true;
        const shown = yield* overviewRow;
        assert.strictEqual(shown.factory?.status, "unknown");
        assert.strictEqual(shown.factory?.deliveryId, root);
        assert.strictEqual(shown.workItem?.key, "fd-idea");
      }),
    );
  });

  it.effect("says no row exists yet for a delivery only intended", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* claimedAssignment(fakes);
        fakes.deliveries.delete(root);
        const { factory } = yield* overviewRow;
        assert.deepInclude(factory, { deliveryId: root, status: null, stage: null });
      }),
    );
  });
});

describe("a Factory assignment's controls", () => {
  it.effect("stops and resumes through Factory, and only a delivery that can resume", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* claimedAssignment(fakes);
        fakes.activity = { ...idle, phase: "proceeding" };
        assert.strictEqual((yield* control("stop")).state, "stopping");
        assert.deepStrictEqual(
          fakes.calls.filter((call) => !call.startsWith("start:")),
          [`stop:${root}`],
        );
        fakes.deliveries.set(root, row(root, { status: "stopped", awaiting: null }));
        fakes.activity = idle;
        yield* tick;
        assert.strictEqual(yield* stateOf(), "stopped");
        assert.isUndefined(yield* slotOf(root));

        assert.strictEqual((yield* control("resume")).state, "running");
        assert.strictEqual(count(fakes, "resume"), 1);
        assert.strictEqual(count(fakes, "start"), 1);
        fakes.deliveries.set(root, row(root, { status: "waiting", awaiting: null }));
        const refused = yield* Effect.flip(control("resume"));
        assert.include(refused.message, "cannot resume");
        assert.strictEqual(count(fakes, "resume"), 1);
      }),
    );
  });

  it.effect("refuses assistant_verify for a Factory assignment", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const assistant = yield* service;
        yield* claimedAssignment(fakes);
        const refused = yield* Effect.flip(
          assistant.verify({
            assignmentId: "idea",
            managerThreadId: managerId,
            evidence: ["It works."],
          }),
        );
        assert.include(refused.message, "completes itself");
        assert.strictEqual(yield* stateOf(), "running");
      }),
    );
  });

  const live = { status: "running", class: "factory" } as const;
  it.effect.each([
    {
      label: "a question of an unknown-origin run",
      request: { kind: "user_input", capability: "live", run: { ...live, class: "unknown" } },
      refused: "Answer this one in thread",
    },
    {
      label: "a question of the owner's run",
      request: { kind: "user_input", capability: "live", run: { ...live, class: "explicit" } },
      refused: "Answer this one in thread",
    },
    {
      label: "a question whose answer would start a turn",
      request: { kind: "user_input", capability: "message", run: live },
      refused: "Answer this one in thread",
    },
    {
      label: "a question of a run that ended",
      request: {
        kind: "user_input",
        capability: "live",
        run: { status: "completed", class: "factory" },
      },
      refused: "Answer this one in thread",
    },
    {
      label: "a permission request",
      request: { kind: "command_execution_approval", capability: "live", run: live },
      refused: "approval UI",
    },
  ] as const)("refuses to answer $label, sending nothing", ({ request, refused }) => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const assistant = yield* service;
        yield* claimedAssignment(fakes);
        fakes.requests = [
          { threadId: "author-thread", requestId: "request-1", questions: null, ...request },
        ];
        const failure = yield* Effect.flip(
          assistant.answer({
            assignmentId: "idea",
            managerThreadId: managerId,
            requestId: RuntimeRequestId.make("request-1"),
            answers: { format: "CSV" },
          }),
        );
        assert.include(failure.message, refused);
        assert.deepStrictEqual(fakes.dispatched, []);
      }),
    );
  });

  it.effect("relays an answer to a live question of Factory's own running agent", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const assistant = yield* service;
        yield* claimedAssignment(fakes);
        fakes.requests = [
          {
            threadId: "author-thread",
            requestId: "request-1",
            kind: "user_input",
            capability: "live",
            run: live,
            questions: [{ id: "format" }],
          },
        ];
        fakes.activity = { ...idle, phase: "proceeding" };
        yield* tick;
        assert.isTrue(
          (yield* notes).some(
            (note) =>
              note.includes("Owner question from thread author-thread") &&
              note.includes("request-1"),
          ),
        );
        yield* assistant.answer({
          assignmentId: "idea",
          managerThreadId: managerId,
          requestId: RuntimeRequestId.make("request-1"),
          answers: { format: "CSV" },
        });
        assert.deepStrictEqual(
          fakes.dispatched.map((command) => [
            command.type,
            (command as { readonly threadId?: string }).threadId,
          ]),
          [["runtime-request.respond", "author-thread"]],
        );
        // Unknown to the assignment, a request is refused.
        const unknown = yield* Effect.flip(
          assistant.answer({
            assignmentId: "idea",
            managerThreadId: managerId,
            requestId: RuntimeRequestId.make("request-2"),
            answers: {},
          }),
        );
        assert.include(unknown.message, "not a pending question");
      }),
    );
  });

  it.effect("asks a revoked root's delivery to stop, once, and records a notice", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const assistant = yield* service;
        const root = yield* claimedAssignment(fakes);
        fakes.activity = { ...idle, phase: "proceeding" };
        yield* assistant.revise({
          projectId: alpha,
          ideaId: "idea",
          patch: { executionAuthorized: false },
        });
        yield* tick;
        assert.strictEqual(count(fakes, "stop"), 1);
        assert.strictEqual(yield* stateOf(), "stopping");
        assert.isTrue((yield* notes).some((note) => note.includes("is being stopped because")));
        yield* tick;
        assert.strictEqual(count(fakes, "stop"), 1);
        assert.strictEqual(fakes.deliveries.get(root)?.status, "stopping");
        const refused = yield* Effect.flip(control("resume"));
        assert.include(refused.message, "Not resumed");
        assert.strictEqual(count(fakes, "resume"), 0);

        yield* assistant.revise({
          projectId: alpha,
          ideaId: "idea",
          patch: { executionAuthorized: true },
        });
        assert.strictEqual((yield* control("resume")).state, "running");
        assert.strictEqual(count(fakes, "resume"), 1);
      }),
    );
  });
});
