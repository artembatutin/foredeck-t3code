import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2Run,
  type Project,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Launches from "../../orchestration-v2/ThreadLaunchService.ts";
import * as Projects from "../../project/ProjectService.ts";
import * as Git from "../../vcs/GitVcsDriver.ts";
import { emptyProjection } from "../../orchestration-v2/ProjectionStore.ts";
import { v2PullRequestThread } from "../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as Assistant from "./ProjectAssistant.ts";
import * as Looper from "./Looper.ts";

const managerId = ThreadId.make("fd-assistant-owner");
const modelSelection = { instanceId: ProviderInstanceId.make("subscription"), model: "configured" };
const at = "2026-10-17T12:00:00.000Z";
const shell = (id: ThreadId, projectId: ProjectId) =>
  v2PullRequestThread({
    id,
    projectId,
    modelSelection,
    title: "Work",
    runtimeMode: "approval-required",
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
  });
const questionNode = (threadId: ThreadId, runId: RunId, requestId: RuntimeRequestId) => ({
  id: NodeId.make("node"),
  threadId,
  runId,
  parentNodeId: null,
  rootNodeId: NodeId.make("node"),
  kind: "user_input_request" as const,
  status: "waiting" as const,
  countsForRun: true,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  runtimeRequestId: requestId,
  checkpointScopeId: null,
  startedAt: DateTime.makeUnsafe(at),
  completedAt: null,
});
const alpha = ProjectId.make("alpha"),
  beta = ProjectId.make("beta"),
  gamma = ProjectId.make("gamma"),
  delta = ProjectId.make("delta");

function harness(looperMode = false) {
  const launches: Launches.ThreadLaunchInput[] = [];
  const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>();
  const commands: OrchestrationV2ServerCommand[] = [];
  const notices: Threads.ThreadManagementSendInput[] = [];
  const interrupts: ThreadId[] = [];
  let uncertain: "none" | "accepted" | "absent" = "none";
  const owner = {
    ...shell(managerId, ProjectId.make("manager-workspace")),
    runtimeMode: looperMode ? ("full-access" as const) : ("approval-required" as const),
  };
  let looperStatus: Looper.Status | null = null;
  const looperStops: string[] = [];
  const looperStarts: boolean[] = [];
  const threadService = Layer.mock(Threads.ThreadManagementService)({
    getThreadShell: (id) =>
      Effect.succeed(
        id === managerId
          ? owner
          : projections.has(id)
            ? {
                ...shell(id, projections.get(id)!.thread.projectId),
                worktreePath: `/isolated/${id}`,
                branch: `feature/${id}`,
              }
            : null,
      ),
    getThreadRecords: (id) => Effect.succeed(projections.get(id)!),
    sendToThread: (input) =>
      Effect.sync(() => {
        if (!notices.some((n) => n.commandId === input.commandId)) notices.push(input);
        return {} as Threads.ThreadManagementSendResult;
      }),
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: 1, storedEvents: [] };
      }),
    interruptThread: (input) =>
      Effect.sync(() => {
        interrupts.push(input.threadId);
        return {
          type: "interrupt_requested",
          run: projections.get(input.threadId)!.runs[0]!,
          dispatch: { sequence: 1, storedEvents: [] },
        } as const;
      }),
  });
  const dependencies = Layer.mergeAll(
    threadService,
    Layer.mock(Looper.Looper)({
      prepare: (configPath, projectRoot) =>
        Effect.succeed({
          configPath,
          projectRoot,
          worktree: "/isolated/loop",
          runtimeDir: "/runtime/loop",
          configHash: "hash",
          goalHash: "goal",
        }),
      start: (_, resume) =>
        Effect.sync(() => {
          looperStarts.push(resume);
          return `loop-${looperStarts.length}`;
        }),
      inspect: () => Effect.succeed(looperStatus),
      stop: (_, runId) =>
        Effect.sync(() => {
          looperStops.push(runId);
        }),
    }),
    Layer.mock(Projects.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          Option.some({
            id,
            title: id,
            workspaceRoot: `/projects/${id}`,
            repositories: [],
            defaultModelSelection: null,
            scripts: [],
            createdAt: at,
            updatedAt: at,
            deletedAt: null,
          } satisfies Project),
        ),
    }),
    Layer.mock(Git.GitVcsDriver)({
      execute: () =>
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: "true\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
    }),
    Layer.mock(Launches.ThreadLaunchService)({
      checkWorktreeBase: () => Effect.void,
      launch: (input) =>
        Effect.gen(function* () {
          launches.push(input);
          const id = input.threadId!;
          if (uncertain !== "absent") {
            const run: OrchestrationV2Run = {
              id: RunId.make(`run:${id}`),
              threadId: id,
              ordinal: 1,
              providerInstanceId: modelSelection.instanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: input.initialMessage!.messageId!,
              rootNodeId: null,
              activeAttemptId: null,
              status: "running",
              requestedAt: DateTime.makeUnsafe(at),
              startedAt: DateTime.makeUnsafe(at),
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            };
            const projection = {
              ...emptyProjection({
                id: EventId.make(id),
                threadId: id,
                type: "thread.created",
                occurredAt: DateTime.makeUnsafe(at),
                payload: { ...shell(id, input.projectId), lastVisitedAt: null },
              }),
              runs: [run],
            };
            projections.set(id, projection);
          }
          if (uncertain !== "none")
            return yield* new Launches.ThreadLaunchError({
              commandId: input.commandId,
              projectId: input.projectId,
              operation: "dispatch-message",
              cause: "lost reply",
            });
          return { threadId: id, projection: projections.get(id)!, resumed: false };
        }),
    }),
  );
  const layer = () => Assistant.layer.pipe(Layer.provide(dependencies));
  const change = (id: ThreadId, status: OrchestrationV2Run["status"]) => {
    const projection = projections.get(id)!;
    projections.set(id, {
      ...projection,
      runs: projection.runs.map((run) => ({ ...run, status })),
    });
  };
  return {
    launches,
    projections,
    commands,
    notices,
    interrupts,
    layer,
    change,
    looperStops,
    looperStarts,
    setLooperStatus: (status: Looper.Status) => {
      looperStatus = status;
    },
    loseReply: (mode: typeof uncertain) => {
      uncertain = mode;
    },
  };
}
const queue = Effect.fn(function* (projectId: ProjectId, rank = 1) {
  const service = yield* Assistant.ProjectAssistant;
  yield* service.revise({
    projectId,
    patch: {
      goal: `Build ${projectId}`,
      acceptanceCriteria: [`Verify ${projectId}`],
      constraints: [`Only ${projectId}`],
      priority: { rank, reason: `Owner ranked ${projectId}` },
      executionAuthorized: true,
    },
  });
  return yield* service.enqueue({
    assignmentId: `work-${projectId}`,
    projectId,
    managerThreadId: managerId,
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    looperConfig: null,
  });
});
const inMemory = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(Effect.provide(Sqlite.layerMemory));

it.effect(
  "runs two isolated projects while priority discussion continues; queues by changed priority",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* Assistant.ProjectAssistant;
      yield* queue(alpha, 1);
      yield* queue(beta, 2);
      yield* queue(gamma, 3);
      yield* queue(delta, 4);
      yield* Effect.all([service.tick, service.tick], { concurrency: "unbounded" });
      assert.equal(h.launches.length, 2);
      assert.deepEqual(
        h.launches.map((item) => item.projectId),
        [alpha, beta],
      );
      for (const launch of h.launches) {
        assert.equal(launch.workspaceStrategy.type, "worktree");
        assert.include(launch.initialMessage!.text, `Build ${launch.projectId}`);
        assert.notInclude(
          launch.initialMessage!.text,
          launch.projectId === alpha ? "Build beta" : "Build alpha",
        );
        assert.notInclude(launch.initialMessage!.text, "Owner ranked");
        assert.isUndefined(launch.initialMessage!.senderThreadId);
        assert.equal(launch.runtimeMode, "approval-required");
      }
      yield* service.revise({
        projectId: delta,
        patch: { priority: { rank: 1, reason: "Owner changed priority while workers ran" } },
      });
      yield* service.tick;
      assert.equal(h.launches.length, 2);
      assert.equal(h.interrupts.length, 0);
      h.change(h.launches[0]!.threadId!, "completed");
      yield* service.tick;
      assert.equal(h.launches.length, 3);
      assert.equal(h.launches[2]!.projectId, delta);
      assert.equal((yield* service.inspect(alpha)).assignments[0]!.state, "awaiting-verification");
      yield* service.verify({
        assignmentId: "work-alpha",
        managerThreadId: managerId,
        evidence: [
          "Acceptance criterion checked: focused test passed; not integrated or deployed.",
        ],
      });
      assert.equal((yield* service.inspect(alpha)).assignments[0]!.state, "completed");
      assert.include((yield* service.inspect()).summary, "beta");
    }).pipe(Effect.provide(h.layer()), inMemory);
  },
);

it.effect("recovers an accepted launch after service restart without duplicate workers", () => {
  const h = harness();
  h.loseReply("accepted");
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      yield* queue(alpha);
      yield* (yield* Assistant.ProjectAssistant).tick;
    }).pipe(Effect.provide(h.layer()));
    yield* Effect.gen(function* () {
      const service = yield* Assistant.ProjectAssistant;
      yield* service.tick;
      const inspection = yield* service.inspect(alpha);
      assert.equal(inspection.assignments[0]!.state, "running");
      assert.equal(
        inspection.dispatches[0]!.runId,
        h.projections.get(h.launches[0]!.threadId!)!.runs[0]!.id,
      );
      yield* service.tick;
      assert.equal(h.launches.length, 1);
    }).pipe(Effect.provide(h.layer()));
  }).pipe(inMemory);
});

it.effect("unknown launches occupy capacity and cannot be blindly retried or cancelled", () => {
  const h = harness();
  h.loseReply("absent");
  return Effect.gen(function* () {
    const service = yield* Assistant.ProjectAssistant;
    yield* queue(alpha);
    yield* queue(beta);
    yield* queue(gamma);
    yield* service.tick;
    yield* service.tick;
    assert.equal(h.launches.length, 2);
    assert.equal((yield* service.inspect(alpha)).assignments[0]!.state, "launch-uncertain");
    yield* Effect.flip(
      service.control({ assignmentId: "work-alpha", managerThreadId: managerId, action: "retry" }),
    );
    yield* Effect.flip(
      service.control({ assignmentId: "work-alpha", managerThreadId: managerId, action: "cancel" }),
    );
    assert.equal(h.launches.length, 2);
  }).pipe(Effect.provide(h.layer()), inMemory);
});

it.effect(
  "stop confirms the executor state; resume has fresh context and retains prior attempt evidence",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* Assistant.ProjectAssistant;
      yield* queue(alpha);
      yield* queue(beta);
      yield* service.tick;
      const first = h.launches[0]!.threadId!;
      yield* service.control({
        assignmentId: "work-alpha",
        managerThreadId: managerId,
        action: "stop",
      });
      assert.equal((yield* service.inspect(alpha)).assignments[0]!.state, "stopping");
      h.change(first, "interrupted");
      yield* service.tick;
      assert.equal((yield* service.inspect(alpha)).assignments[0]!.state, "stopped");
      yield* service.control({
        assignmentId: "work-alpha",
        managerThreadId: managerId,
        action: "resume",
      });
      yield* service.tick;
      const inspection = yield* service.inspect(alpha);
      assert.equal(inspection.assignments[0]!.attempt, 2);
      assert.equal(inspection.assignments[0]!.state, "running");
      assert.notEqual(inspection.dispatches[0]!.threadId, first);
      assert.deepEqual(h.launches.at(-1)!.workspaceStrategy, {
        type: "existing_worktree",
        worktreePath: `/isolated/${first}`,
        branch: `feature/${first}`,
      });
      assert.equal(inspection.dispatches[0]!.history[0]!.threadId, first);
      assert.equal((yield* service.inspect(beta)).assignments[0]!.state, "running");
    }).pipe(Effect.provide(h.layer()), inMemory);
  },
);

it.effect(
  "routes questions by assignment and request identity and refuses permission approvals",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* Assistant.ProjectAssistant;
      yield* queue(alpha);
      yield* queue(beta);
      yield* service.tick;
      const worker = h.launches[0]!.threadId!,
        requestId = RuntimeRequestId.make("question-alpha");
      const projection = h.projections.get(worker)!;
      h.projections.set(worker, {
        ...projection,
        nodes: [questionNode(worker, projection.runs[0]!.id, requestId)],
        runtimeRequests: [
          {
            id: requestId,
            nodeId: NodeId.make("node"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: DateTime.makeUnsafe(at),
            resolvedAt: null,
          },
        ],
      });
      yield* service.tick;
      assert.equal((yield* service.inspect(alpha)).assignments[0]!.state, "needs-input");
      yield* Effect.flip(
        service.answer({
          assignmentId: "work-beta",
          managerThreadId: managerId,
          requestId,
          answers: {},
        }),
      );
      const correct = h.projections.get(worker)!;
      h.projections.set(worker, {
        ...correct,
        nodes: correct.nodes.map((node) => ({ ...node, runId: RunId.make("unrelated") })),
      });
      yield* Effect.flip(
        service.answer({
          assignmentId: "work-alpha",
          managerThreadId: managerId,
          requestId,
          answers: {},
        }),
      );
      h.projections.set(worker, correct);
      yield* service.answer({
        assignmentId: "work-alpha",
        managerThreadId: managerId,
        requestId,
        answers: { choice: ["yes"] },
      });
      const sent = h.commands.at(-1)!;
      assert.isTrue("threadId" in sent && sent.threadId === worker);
      const pending = h.projections.get(worker)!;
      h.projections.set(worker, {
        ...pending,
        runtimeRequests: pending.runtimeRequests.map((request) => ({
          ...request,
          kind: "command",
        })),
      });
      yield* Effect.flip(
        service.answer({
          assignmentId: "work-alpha",
          managerThreadId: managerId,
          requestId,
          answers: {},
        }),
      );
      assert.equal(h.commands.length, 1);
    }).pipe(Effect.provide(h.layer()), inMemory);
  },
);

it.effect(
  "repeated queue requests are idempotent and revoked or changed scope never launches",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* Assistant.ProjectAssistant;
      yield* queue(alpha);
      yield* queue(alpha);
      yield* service.revise({ projectId: alpha, patch: { goal: "Changed goal" } });
      assert.isFalse((yield* service.inspect(alpha)).briefs[0]!.executionAuthorized);
      yield* service.tick;
      assert.equal(h.launches.length, 0);
      yield* service.revise({ projectId: alpha, patch: { executionAuthorized: true } });
      yield* service.tick;
      assert.equal(h.launches.length, 0);
      assert.equal((yield* service.inspect(alpha)).assignments[0]!.state, "failed");
      yield* service.control({
        assignmentId: "work-alpha",
        managerThreadId: managerId,
        action: "retry",
      });
      yield* service.tick;
      assert.equal(h.launches.length, 1);
      assert.include(h.launches[0]!.initialMessage!.text, "Changed goal");
      yield* Effect.flip(
        service.control({
          assignmentId: "work-alpha",
          managerThreadId: ThreadId.make("fd-assistant-other"),
          action: "stop",
        }),
      );
      assert.equal(h.interrupts.length, 0);
    }).pipe(Effect.provide(h.layer()), inMemory);
  },
);

it.effect("cancellation holds its slot until confirmed and then releases it", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Assistant.ProjectAssistant;
    yield* queue(alpha);
    yield* queue(beta);
    yield* queue(gamma);
    yield* service.tick;
    yield* service.control({
      assignmentId: "work-alpha",
      managerThreadId: managerId,
      action: "cancel",
    });
    yield* service.tick;
    assert.equal(h.launches.length, 2);
    h.change(h.launches[0]!.threadId!, "interrupted");
    yield* service.tick;
    assert.equal((yield* service.inspect(alpha)).assignments[0]!.state, "cancelled");
    assert.equal(h.launches.length, 3);
    assert.equal(h.launches[2]!.projectId, gamma);
  }).pipe(Effect.provide(h.layer()), inMemory);
});

it.effect("follows only answer and restart continuation runs, never unrelated runs", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Assistant.ProjectAssistant;
    yield* queue(alpha);
    yield* service.tick;
    const worker = h.launches[0]!.threadId!;
    const initial = h.projections.get(worker)!;
    const requestId = RuntimeRequestId.make("continuation-question");
    h.projections.set(worker, {
      ...initial,
      nodes: [questionNode(worker, initial.runs[0]!.id, requestId)],
      runtimeRequests: [
        {
          id: requestId,
          nodeId: NodeId.make("node"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: DateTime.makeUnsafe(at),
          resolvedAt: null,
        },
      ],
    });
    yield* service.tick;
    yield* service.answer({
      assignmentId: "work-alpha",
      managerThreadId: managerId,
      requestId,
      answers: { decision: "Use CSV" },
    });
    const first = initial.runs[0]!;
    const continuation = {
      ...first,
      id: RunId.make("answer-run"),
      ordinal: 2,
      userMessageId: MessageId.make(`async-answer:${requestId}`),
    };
    h.projections.set(worker, {
      ...initial,
      runs: [{ ...first, status: "completed" }, continuation],
    });
    yield* service.tick;
    assert.equal((yield* service.inspect(alpha)).dispatches[0]!.runId, continuation.id);
    assert.equal((yield* service.inspect(alpha)).assignments[0]!.state, "running");
    const restarted = {
      ...continuation,
      id: RunId.make("restart-run"),
      ordinal: 3,
      restartContinuationOfRunId: continuation.id,
      userMessageId: MessageId.make("restart"),
    };
    const unrelated = {
      ...continuation,
      id: RunId.make("unrelated-run"),
      ordinal: 4,
      userMessageId: MessageId.make("other-work"),
    };
    h.projections.set(worker, {
      ...initial,
      runs: [
        { ...first, status: "completed" },
        { ...continuation, status: "interrupted" },
        restarted,
        unrelated,
      ],
    });
    yield* service.tick;
    const inspection = yield* service.inspect(alpha);
    assert.equal(inspection.dispatches[0]!.runId, restarted.id);
    assert.isTrue(inspection.assignments[0]!.workerRefs.some((ref) => ref.id === restarted.id));
    assert.isFalse(inspection.assignments[0]!.workerRefs.some((ref) => ref.id === unrelated.id));
  }).pipe(Effect.provide(h.layer()), inMemory);
});

it.effect("tracks exact Looper runs, progress, graceful stop and resumed identity", () => {
  const h = harness(true);
  return Effect.gen(function* () {
    const service = yield* Assistant.ProjectAssistant;
    yield* service.revise({
      projectId: alpha,
      patch: {
        goal: "Build alpha",
        acceptanceCriteria: ["Verify alpha"],
        executionAuthorized: true,
      },
    });
    yield* service.enqueue({
      assignmentId: "loop-work",
      projectId: alpha,
      managerThreadId: managerId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      looperConfig: "/config/loop.json",
    });
    yield* service.tick;
    assert.equal((yield* service.inspect(alpha)).assignments[0]!.state, "launch-uncertain");
    yield* service.tick;
    assert.equal((yield* service.inspect(alpha)).assignments[0]!.state, "launch-uncertain");
    assert.equal(h.looperStarts.length, 1);
    const status = {
      runId: "loop-1",
      status: "running",
      stage: "author",
      updatedAt: at,
      lastError: null,
      runDir: "/runtime/loop/runs/loop-1",
    };
    h.setLooperStatus(status);
    yield* service.tick;
    assert.deepEqual((yield* service.inspect(alpha)).assignments[0]!.workerRefs, [
      { kind: "looper-run", id: "loop-1" },
    ]);
    yield* service.control({
      assignmentId: "loop-work",
      managerThreadId: managerId,
      action: "stop",
    });
    assert.deepEqual(h.looperStops, ["loop-1"]);
    assert.equal((yield* service.inspect(alpha)).assignments[0]!.state, "stopping");
    h.setLooperStatus({ ...status, status: "stopped" });
    yield* service.tick;
    yield* service.control({
      assignmentId: "loop-work",
      managerThreadId: managerId,
      action: "resume",
    });
    yield* service.tick;
    assert.deepEqual(h.looperStarts, [false, true]);
    assert.equal((yield* service.inspect(alpha)).assignments[0]!.state, "launch-uncertain");
    h.setLooperStatus({ ...status, runId: "loop-2", status: "completed", stage: "done" });
    yield* service.tick;
    assert.equal((yield* service.inspect(alpha)).assignments[0]!.state, "awaiting-verification");
    yield* service.control({
      assignmentId: "loop-work",
      managerThreadId: managerId,
      action: "cancel",
    });
    assert.equal((yield* service.inspect(alpha)).assignments[0]!.state, "cancelled");
    assert.equal(h.launches.length, 0);
  }).pipe(Effect.provide(h.layer()), inMemory);
});
