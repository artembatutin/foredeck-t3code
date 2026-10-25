import { RunId, ThreadId } from "@t3tools/contracts";
import { FactoryTaskId, type FactoryPlanTask } from "@t3tools/contracts/fd/factory";
import { describe, expect, it } from "vite-plus/test";

import { advance } from "./engine.ts";
import { queuedDeliveryState } from "./state.ts";
import type {
  FactoryAcceptedPlan,
  FactoryAdvance,
  FactoryDeliveryState,
  FactoryEffect,
  FactoryEvent,
  FactoryPlanJudgment,
  FactoryPlanSource,
  FactoryResumeCheck,
} from "./state.ts";

const planner = ThreadId.make("thread-planner");
const author = ThreadId.make("thread-author");
const planRun = RunId.make("run-plan");
const retryRun = RunId.make("run-plan-retry");
const otherRun = RunId.make("run-other");
const worktreePath = "/worktrees/item-7";
const head = "a".repeat(40);
const evidencePath = "/t3/userdata/fd-factory/delivery-1/plan-1.json";

const task = (id: string): FactoryPlanTask => ({
  id: FactoryTaskId.make(id),
  title: `Task ${id}`,
  kind: "feature",
  summary: `Build ${id}.`,
  acceptance: [`${id} works.`],
  testPlan: [{ criterion: 1, check: `${id} is tested.`, paths: [`src/${id}.test.ts`] }],
  likelyPaths: [`src/${id}.ts`],
  risk: "normal",
});
const tasks = [task("export-button"), task("export-format")];

const accepted = (
  source: FactoryPlanSource,
  planned: ReadonlyArray<FactoryPlanTask> = tasks,
  note?: string,
): FactoryPlanJudgment => ({
  type: "accepted",
  plan: { tasks: planned, ...(note === undefined ? {} : { note }), source, evidencePath },
});
const recordedPlan = (
  source: FactoryPlanSource,
  round = 1,
  planned: ReadonlyArray<FactoryPlanTask> = tasks,
): FactoryAcceptedPlan => ({ tasks: planned, source, evidencePath, round });
const invalid = (problem: string): FactoryPlanJudgment => ({
  type: "invalid",
  problems: [problem],
});

const submitted = (
  judgment: FactoryPlanJudgment,
  overrides: Partial<Extract<FactoryEvent, { readonly type: "plan.submitted" }>> = {},
): FactoryEvent => ({
  type: "plan.submitted",
  round: 1,
  threadId: planner,
  runId: planRun,
  judgment,
  ...overrides,
});
const read = (effectId: number, judgment: FactoryPlanJudgment): FactoryEvent => ({
  type: "plan.read",
  effectId,
  judgment,
});
const finished = (
  runId: RunId,
  status: Extract<FactoryEvent, { readonly type: "run.finished" }>["status"] = "completed",
  threadId = planner,
): FactoryEvent => ({ type: "run.finished", threadId, runId, status });
const launched = (effectId: number): FactoryEvent => ({
  type: "thread.launched",
  effectId,
  threadId: planner,
  runId: planRun,
  worktreePath,
  // A planner's launch reports where it created the delivery branch.
  baseline: head,
});
const turnStarted = (effectId: number, runId: RunId): FactoryEvent => ({
  type: "turn.started",
  effectId,
  runId,
});
const start: FactoryEvent = { type: "start" };
const stop: FactoryEvent = { type: "stop" };
const cancel: FactoryEvent = { type: "cancel" };
const resumeWith = (check: FactoryResumeCheck | null): FactoryEvent => ({ type: "resume", check });
/** What a resume of a parent in planning reads: no worktree yet, and nothing deleted. */
const nothingFound: FactoryResumeCheck = {
  deletedThreads: [],
  unrecordedAuthorRunEnded: false,
  worktree: null,
};

const run = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]): FactoryAdvance =>
  events.reduce<FactoryAdvance>((last, event) => advance(last.delivery, event), {
    delivery,
    effects: [],
  });
const fold = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]) =>
  run(delivery, ...events).delivery;

const issued = (delivery: FactoryDeliveryState, effect: FactoryEffect): FactoryAdvance => ({
  delivery: { ...delivery, effectsIssued: effect.id, awaiting: { type: "effect", effect } },
  effects: [effect],
});
const blockedState = (
  delivery: FactoryDeliveryState,
  block: FactoryDeliveryState["block"],
): FactoryAdvance => ({
  delivery: { ...delivery, status: "blocked", awaiting: null, block },
  effects: [],
});

// Effect ids, issued in order: the planner launch (1). The run's end issues the fallback read (2)
// when no plan was accepted; an invalid one gets the retry turn (3), whose run gets the second
// fallback read (4).
const LAUNCH = 1;
const FALLBACK = 2;
const RETRY_TURN = 3;
const SECOND_FALLBACK = 4;

const plannerLaunch = {
  id: LAUNCH,
  type: "launch_thread",
  role: "planner",
  workspace: { type: "worktree", branch: "fd/item-7", baseRef: "main" },
} as const;

const queuedParent = queuedDeliveryState({ kind: "parent", branch: "fd/item-7", baseRef: "main" });
const awaitingLaunch = fold(queuedParent, start);
const planning = fold(awaitingLaunch, launched(LAUNCH));
const acceptedRunning = fold(planning, submitted(accepted("mcp")));
const awaitingFallback = fold(planning, finished(planRun));
const awaitingRetryTurn = fold(awaitingFallback, read(FALLBACK, invalid("No fenced block.")));
const retrying = fold(awaitingRetryTurn, turnStarted(RETRY_TURN, retryRun));
const awaitingSecondFallback = fold(retrying, finished(retryRun));
const waiting = fold(acceptedRunning, finished(planRun));
const stoppedAtGate = fold(planning, stop, submitted(accepted("mcp")), finished(planRun));
const blockedAtLaunch = fold(awaitingLaunch, {
  type: "effect.failed",
  effectId: LAUNCH,
  detail: "No.",
});
const blockedOnRun = fold(planning, finished(planRun, "failed"));

describe("starting a delivery", () => {
  it("begins a parent's plan stage with a planner launch on a new worktree of its branch", () => {
    expect(advance(queuedParent, start)).toEqual(
      issued(
        {
          ...queuedParent,
          status: "running",
          stage: "plan",
          planRound: 1,
          plannerLaunch,
        },
        plannerLaunch,
      ),
    );
  });

  it("still begins a single item's author stage", () => {
    const single = queuedDeliveryState({ branch: "fd/item-7", baseRef: "main" });
    expect(single.kind).toBe("single");
    const step = advance(single, start);
    expect(step.delivery.stage).toBe("author");
    expect(step.delivery.planRound).toBe(0);
    expect(step.delivery.plannerLaunch).toBeNull();
    expect(step.effects).toEqual([{ ...plannerLaunch, role: "author" }]);
  });

  it("records the planner, the worktree it made and where its branch started", () => {
    expect(planning).toEqual({
      ...awaitingLaunch,
      worktreePath,
      // Where the planner's launch created the branch: the parent's first child starts there.
      baseline: head,
      threads: { planner },
      awaiting: { type: "run", threadId: planner, runId: planRun },
    });
  });
});

describe("a plan submission while the planner runs", () => {
  it("records an accepted plan for the round and waits for the run to complete", () => {
    const step = advance(planning, submitted(accepted("mcp")));
    expect(step).toEqual({
      delivery: { ...planning, plan: recordedPlan("mcp") },
      effects: [],
    });
    expect(step.delivery.status).toBe("running");
  });

  it("waits at the plan gate with the plan once the run completes, awaiting nothing", () => {
    expect(advance(acceptedRunning, finished(planRun))).toEqual({
      delivery: {
        ...acceptedRunning,
        status: "waiting",
        stage: "approve_plan",
        awaiting: null,
      },
      effects: [],
    });
    expect(waiting.plan).toEqual(recordedPlan("mcp"));
  });

  it("counts a first invalid submission for the planner to correct in its turn", () => {
    expect(advance(planning, submitted(invalid("Task 1 has no test plan.")))).toEqual({
      delivery: { ...planning, invalidSubmissions: 1 },
      effects: [],
    });
  });

  it("accepts a corrected submission after an invalid one in the same run", () => {
    const corrected = fold(
      planning,
      submitted(invalid("Task 1 has no test plan.")),
      submitted(accepted("mcp")),
    );
    expect(corrected.invalidSubmissions).toBe(1);
    expect(corrected.plan).toEqual(recordedPlan("mcp"));
    expect(advance(corrected, finished(planRun)).delivery).toMatchObject({
      status: "waiting",
      stage: "approve_plan",
    });
  });

  it("blocks on a second invalid submission with its problems", () => {
    expect(
      run(
        planning,
        submitted(invalid("Task 1 has no test plan.")),
        submitted(invalid("Duplicate task id.")),
      ),
    ).toEqual(
      blockedState(
        { ...planning, invalidSubmissions: 2 },
        { reason: "invalid_submission", problems: ["Duplicate task id."] },
      ),
    );
  });

  it("blocks with the planner's note once the run completes, for an empty plan", () => {
    const empty = fold(planning, submitted(accepted("mcp", [], "Already done in #12.")));
    const step = advance(empty, finished(planRun));
    expect(step).toEqual(
      blockedState(empty, { reason: "plan_empty", note: "Already done in #12." }),
    );
    expect(step.delivery.stage).toBe("plan");
  });

  it("blocks an empty plan without a note as plan_empty too", () => {
    const empty = fold(planning, submitted(accepted("mcp", [])));
    expect(advance(empty, finished(planRun)).delivery.block).toEqual({
      reason: "plan_empty",
      note: null,
    });
  });

  it("blocks on the run's failure even after a plan was accepted", () => {
    expect(advance(acceptedRunning, finished(planRun, "interrupted"))).toEqual(
      blockedState(acceptedRunning, {
        reason: "run_ended",
        threadId: planner,
        runId: planRun,
        runStatus: "interrupted",
      }),
    );
  });

  it("blocks when the planner thread is deleted", () => {
    expect(advance(planning, { type: "thread.deleted", threadId: planner })).toEqual(
      blockedState(planning, { reason: "thread_deleted", threadId: planner }),
    );
  });

  it("blocks when the planner launch fails", () => {
    expect(blockedAtLaunch).toEqual({
      ...awaitingLaunch,
      status: "blocked",
      awaiting: null,
      block: { reason: "effect_failed", effect: plannerLaunch, detail: "No." },
    });
  });
});

describe("the fenced-JSON fallback plan", () => {
  it("reads the last message of a run that completed without an accepted plan", () => {
    expect(advance(planning, finished(planRun))).toEqual(
      issued(planning, {
        id: FALLBACK,
        type: "read_fallback_plan",
        threadId: planner,
        runId: planRun,
      }),
    );
  });

  it("waits at the plan gate at once on an accepted fallback plan", () => {
    expect(advance(awaitingFallback, read(FALLBACK, accepted("fallback")))).toEqual({
      delivery: {
        ...awaitingFallback,
        status: "waiting",
        stage: "approve_plan",
        awaiting: null,
        plan: recordedPlan("fallback"),
      },
      effects: [],
    });
  });

  it("blocks at once on an accepted empty fallback plan, with its note", () => {
    const step = advance(awaitingFallback, read(FALLBACK, accepted("fallback", [], "Nothing.")));
    expect(step.delivery.status).toBe("blocked");
    expect(step.delivery.block).toEqual({ reason: "plan_empty", note: "Nothing." });
    expect(step.effects).toEqual([]);
  });

  it("asks the planner thread for one retry turn listing the problems", () => {
    expect(advance(awaitingFallback, read(FALLBACK, invalid("No fenced block.")))).toEqual(
      issued(
        { ...awaitingFallback, invalidSubmissions: 1 },
        {
          id: RETRY_TURN,
          type: "send_plan_retry_turn",
          threadId: planner,
          problems: ["No fenced block."],
        },
      ),
    );
  });

  it("awaits the retry turn's run, then reads its last message", () => {
    expect(retrying.awaiting).toEqual({ type: "run", threadId: planner, runId: retryRun });
    expect(advance(retrying, finished(retryRun))).toEqual(
      issued(retrying, {
        id: SECOND_FALLBACK,
        type: "read_fallback_plan",
        threadId: planner,
        runId: retryRun,
      }),
    );
  });

  it("accepts a submission made during the retry turn", () => {
    const corrected = fold(
      retrying,
      submitted(accepted("mcp"), { runId: retryRun }),
      finished(retryRun),
    );
    expect(corrected.status).toBe("waiting");
    expect(corrected.plan).toEqual(recordedPlan("mcp"));
  });

  it("blocks when the retry's answer is invalid too", () => {
    expect(
      advance(awaitingSecondFallback, read(SECOND_FALLBACK, invalid("Not valid JSON."))),
    ).toEqual(
      blockedState(
        { ...awaitingSecondFallback, invalidSubmissions: 2 },
        { reason: "invalid_submission", problems: ["Not valid JSON."] },
      ),
    );
  });

  it("blocks without a retry turn after an invalid submission on the tool path", () => {
    const afterTool = fold(planning, submitted(invalid("Duplicate task id.")), finished(planRun));
    expect(advance(afterTool, read(FALLBACK, invalid("No fenced block.")))).toEqual(
      blockedState(
        { ...afterTool, invalidSubmissions: 2 },
        { reason: "invalid_submission", problems: ["No fenced block."] },
      ),
    );
  });

  it.each([
    ["fallback read", awaitingFallback],
    ["retry turn", awaitingRetryTurn],
  ] as const)("blocks when the worker cannot carry out the %s", (_, delivery) => {
    if (delivery.awaiting?.type !== "effect") throw new Error("the state awaits an effect");
    const { effect } = delivery.awaiting;
    expect(
      advance(delivery, { type: "effect.failed", effectId: effect.id, detail: "No." }),
    ).toEqual(blockedState(delivery, { reason: "effect_failed", effect, detail: "No." }));
  });
});

describe("stale and foreign planning events", () => {
  const authoring = fold(queuedDeliveryState({ branch: "fd/item-7", baseRef: "main" }), start, {
    type: "thread.launched",
    effectId: 1,
    threadId: author,
    runId: planRun,
    worktreePath,
    baseline: head,
  });

  it.each([
    [
      "a submission naming another thread",
      planning,
      submitted(accepted("mcp"), { threadId: author }),
    ],
    ["a submission naming another run", planning, submitted(invalid("x"), { runId: otherRun })],
    [
      "a submission from an earlier run of the planner",
      retrying,
      submitted(accepted("mcp"), { runId: planRun }),
    ],
    ["a submission for another round", planning, submitted(accepted("mcp"), { round: 2 })],
    ["a submission for no round", planning, submitted(accepted("mcp"), { round: 0 })],
    [
      "a second submission once the round's plan is accepted",
      acceptedRunning,
      submitted(invalid("x")),
    ],
    [
      "another accepted submission once the round's plan is accepted",
      acceptedRunning,
      submitted(accepted("mcp", [task("other")])),
    ],
    ["a submission before the planner launched", awaitingLaunch, submitted(accepted("mcp"))],
    ["a submission while the fallback is read", awaitingFallback, submitted(accepted("mcp"))],
    ["a submission at the plan gate", waiting, submitted(accepted("mcp"))],
    ["a submission to a blocked delivery", blockedOnRun, submitted(accepted("mcp"))],
    [
      "a plan submission to a single item's author run",
      authoring,
      submitted(accepted("mcp"), { round: 0, threadId: author }),
    ],
    [
      "a review submission while the planner runs",
      planning,
      {
        type: "review.submitted",
        round: 0,
        threadId: planner,
        runId: planRun,
        judgment: { type: "invalid", problems: ["x"] },
      },
    ],
    [
      "a fallback result naming another effect",
      awaitingFallback,
      read(LAUNCH, accepted("fallback")),
    ],
    [
      "the first fallback's result while the second is awaited",
      awaitingSecondFallback,
      read(FALLBACK, accepted("fallback")),
    ],
    [
      "a fallback result naming the awaited retry turn",
      awaitingRetryTurn,
      read(RETRY_TURN, accepted("fallback")),
    ],
    ["a fallback result while the planner runs", planning, read(FALLBACK, accepted("fallback"))],
    ["the first planner run's end during the retry", retrying, finished(planRun)],
    ["a run of another thread", planning, finished(planRun, "failed", author)],
    ["the planner run's end at the plan gate", waiting, finished(planRun, "failed")],
    [
      "the planner's deletion at the plan gate",
      waiting,
      { type: "thread.deleted", threadId: planner },
    ],
  ] as const)("ignore %s", (_, delivery, event: FactoryEvent) => {
    const result = advance(delivery, event);
    expect(result.delivery).toBe(delivery);
    expect(result.effects).toEqual([]);
  });
});

describe("stop and cancel while planning", () => {
  it("finishes the planning work of a stopping parent and stops before the plan gate", () => {
    const stopping = fold(planning, stop, submitted(accepted("mcp")));
    expect(advance(stopping, finished(planRun))).toEqual({
      delivery: { ...stopping, status: "stopped", awaiting: null, checkpoint: "approve_plan" },
      effects: [],
    });
    expect(stoppedAtGate.stage).toBe("plan");
    expect(stoppedAtGate.plan).toEqual(recordedPlan("mcp"));
  });

  it("reads the fallback plan of a stopping parent, then stops before the plan gate", () => {
    const reading = run(planning, stop, finished(planRun));
    expect(reading.effects).toEqual([
      { id: FALLBACK, type: "read_fallback_plan", threadId: planner, runId: planRun },
    ]);
    const stopped = advance(reading.delivery, read(FALLBACK, accepted("fallback")));
    expect(stopped.effects).toEqual([]);
    expect(stopped.delivery).toMatchObject({
      status: "stopped",
      checkpoint: "approve_plan",
      plan: recordedPlan("fallback"),
    });
  });

  it("still blocks a stopping parent on an empty plan", () => {
    expect(
      fold(planning, stop, submitted(accepted("mcp", [], "None.")), finished(planRun)).block,
    ).toEqual({ reason: "plan_empty", note: "None." });
  });

  it("returns a stopped parent to the plan gate with the same plan, issuing nothing", () => {
    const step = advance(stoppedAtGate, resumeWith(nothingFound));
    expect(step).toEqual({
      delivery: {
        ...stoppedAtGate,
        status: "waiting",
        stage: "approve_plan",
        checkpoint: null,
      },
      effects: [],
    });
    expect(step.delivery.plan).toBe(stoppedAtGate.plan);
  });

  it("runs a stopping parent on when it resumes before stopping", () => {
    const stopping = fold(planning, stop);
    expect(advance(stopping, resumeWith(null))).toEqual({ delivery: planning, effects: [] });
  });

  it.each([
    ["awaiting the planner launch", awaitingLaunch, launched(LAUNCH)],
    ["awaiting the planner run", planning, finished(planRun)],
    ["awaiting the fallback read", awaitingFallback, read(FALLBACK, accepted("fallback"))],
    ["at the plan gate", waiting, submitted(accepted("mcp"))],
  ] as const)("ends a parent %s, and no later event changes it", (_, delivery, late) => {
    const cancelled = advance(delivery, cancel);
    expect(cancelled).toEqual({
      delivery: { ...delivery, status: "cancelled", awaiting: null, block: null, checkpoint: null },
      effects: [],
    });
    for (const event of [
      late,
      finished(planRun),
      finished(planRun, "failed"),
      submitted(accepted("mcp")),
      submitted(invalid("x")),
      resumeWith(nothingFound),
    ]) {
      const after = advance(cancelled.delivery, event);
      expect(after.delivery).toBe(cancelled.delivery);
      expect(after.effects).toEqual([]);
    }
  });
});

describe("resume a parent that blocked or stopped while planning", () => {
  it("issues the planner launch it never recorded again, under its own id", () => {
    expect(advance(blockedAtLaunch, resumeWith(nothingFound))).toEqual({
      delivery: {
        ...blockedAtLaunch,
        status: "running",
        stage: "plan",
        block: null,
        awaiting: { type: "effect", effect: plannerLaunch },
      },
      effects: [plannerLaunch],
    });
  });

  it("awaits a replayed planner run still going", () => {
    const replayed = fold(blockedAtLaunch, resumeWith(nothingFound), launched(LAUNCH));
    expect(replayed.threads).toEqual({ planner });
    expect(replayed.awaiting).toEqual({ type: "run", threadId: planner, runId: planRun });
    expect(advance(replayed, submitted(accepted("mcp"))).delivery.plan).toEqual(
      recordedPlan("mcp"),
    );
  });

  it("gives a replayed planner whose run had ended its retry turn once it is recorded", () => {
    const ended = { ...nothingFound, unrecordedPlannerRunEnded: true };
    const replay = { ...plannerLaunch, resumeCheckpoint: "plan" };
    const resumed = advance(blockedAtLaunch, resumeWith(ended));
    expect(resumed.effects).toEqual([replay]);
    expect(resumed.delivery.plannerLaunch).toEqual(plannerLaunch);

    const retry = {
      id: 2,
      type: "send_plan_retry_turn",
      threadId: planner,
      problems: [],
      checkpoint: "plan",
    };
    const recorded = advance(resumed.delivery, launched(LAUNCH));
    expect(recorded.effects).toEqual([retry]);
    expect(recorded.delivery.threads).toEqual({ planner });
    // The run's end that the worker read with the launch's result is no news.
    expect(advance(recorded.delivery, finished(planRun)).delivery).toBe(recorded.delivery);
  });

  it("stays blocked on every resume once the thread of its unrecorded launch is deleted", () => {
    const thread = ThreadId.make("factory-thread:delivery:1");
    const deleted = { ...nothingFound, deletedThreads: [thread] };
    const first = advance(blockedAtLaunch, resumeWith(deleted));
    expect(first).toEqual({
      delivery: { ...blockedAtLaunch, block: { reason: "thread_deleted", threadId: thread } },
      effects: [],
    });
    // The new block does not hide the launch: the next resume issues only that launch, again.
    expect(first.delivery.plannerLaunch).toEqual(plannerLaunch);
    expect(advance(first.delivery, resumeWith(deleted)).delivery).toEqual(first.delivery);
    expect(advance(first.delivery, resumeWith(nothingFound)).effects).toEqual([plannerLaunch]);
  });

  const blockedWhilePlanning: ReadonlyArray<
    readonly [string, FactoryDeliveryState, ReadonlyArray<string>]
  > = [
    ["its run ended", blockedOnRun, []],
    [
      "its plan was invalid again",
      fold(planning, submitted(invalid("Bad id.")), submitted(invalid("Bad paths."))),
      ["Bad paths."],
    ],
    [
      "its plan was empty",
      fold(planning, submitted(accepted("mcp", [], "None.")), finished(planRun)),
      [],
    ],
    [
      "its fallback read failed",
      fold(awaitingFallback, { type: "effect.failed", effectId: FALLBACK, detail: "No." }),
      [],
    ],
    [
      "its plan's run failed after the plan was accepted",
      fold(acceptedRunning, finished(planRun, "failed")),
      [],
    ],
  ];

  it.each(blockedWhilePlanning)(
    "gives the recorded planner one retry turn in a new plan round when %s",
    (_, delivery, problems) => {
      const retry = {
        id: delivery.effectsIssued + 1,
        type: "send_plan_retry_turn",
        threadId: planner,
        problems,
        checkpoint: "plan",
      } as const;
      expect(advance(delivery, resumeWith(nothingFound))).toEqual(
        issued(
          {
            ...delivery,
            status: "running",
            stage: "plan",
            block: null,
            planRound: 2,
            invalidSubmissions: 0,
          },
          retry,
        ),
      );
    },
  );

  it("takes the new round's plan, even after an earlier round's plan was accepted", () => {
    const empty = fold(planning, submitted(accepted("mcp", [], "None.")), finished(planRun));
    const resumed = fold(empty, resumeWith(nothingFound), turnStarted(2, retryRun));
    // The earlier round's empty plan is history: a submission for it is stale...
    expect(advance(resumed, submitted(accepted("mcp"), { runId: retryRun })).delivery).toBe(
      resumed,
    );
    // ...and the new round's plan is taken and acted on once the retry turn's run completes.
    const next = fold(
      resumed,
      submitted(accepted("mcp"), { round: 2, runId: retryRun }),
      finished(retryRun),
    );
    expect(next.status).toBe("waiting");
    expect(next.plan).toEqual(recordedPlan("mcp", 2));
  });

  it("grants a fresh retry allowance", () => {
    const spent: FactoryDeliveryState = {
      ...fold(planning, submitted(invalid("Bad id.")), submitted(invalid("Bad paths."))),
      fixCommitTurns: 1,
      rounds: { fix: 1, review: 1 },
      fingerprints: ["fp-1"],
    };
    const resumed = fold(spent, resumeWith(nothingFound), turnStarted(2, retryRun));
    expect(resumed).toMatchObject({
      invalidSubmissions: 0,
      fixCommitTurns: 0,
      rounds: { fix: 0, review: 0 },
      fingerprints: [],
      limits: spent.limits,
    });
    // The new round's first invalid submission earns its retry again; the second blocks.
    const once = advance(resumed, submitted(invalid("Again."), { round: 2, runId: retryRun }));
    expect(once.delivery.status).toBe("running");
    expect(once.delivery.invalidSubmissions).toBe(1);
    expect(
      advance(once.delivery, submitted(invalid("Again."), { round: 2, runId: retryRun })).delivery
        .block,
    ).toEqual({ reason: "invalid_submission", problems: ["Again."] });
  });

  it.each([
    ["the planner", [planner], planner],
    ["another thread and the planner, naming the planner", [author, planner], planner],
  ] as const)("blocks again when %s was deleted, issuing nothing", (_, deletedThreads, named) => {
    for (const delivery of [blockedOnRun, stoppedAtGate]) {
      expect(advance(delivery, resumeWith({ ...nothingFound, deletedThreads }))).toEqual(
        blockedState(delivery, { reason: "thread_deleted", threadId: named }),
      );
    }
  });

  it("never begins the author stage", () => {
    const thread = ThreadId.make("factory-thread:delivery:1");
    const resumes = [
      advance(blockedAtLaunch, resumeWith(nothingFound)),
      advance(blockedAtLaunch, resumeWith({ ...nothingFound, unrecordedPlannerRunEnded: true })),
      advance(blockedAtLaunch, resumeWith({ ...nothingFound, unrecordedAuthorRunEnded: true })),
      advance(blockedAtLaunch, resumeWith({ ...nothingFound, deletedThreads: [thread] })),
      advance(stoppedAtGate, resumeWith(nothingFound)),
      ...blockedWhilePlanning.map(([, delivery]) => advance(delivery, resumeWith(nothingFound))),
    ];
    for (const { delivery, effects } of resumes) {
      expect(delivery.stage === "plan" || delivery.stage === "approve_plan").toBe(true);
      expect(delivery.threads.author).toBeUndefined();
      expect(delivery.authorLaunch).toBeNull();
      for (const effect of effects) {
        expect(effect.type === "launch_thread" && effect.role === "author").toBe(false);
      }
    }
  });

  it.each([
    ["stopped", stoppedAtGate],
    ["blocked", blockedOnRun],
  ] as const)("leaves a %s parent as it is when nothing was read", (_, delivery) => {
    const step = advance(delivery, resumeWith(null));
    expect(step.delivery).toBe(delivery);
    expect(step.effects).toEqual([]);
  });

  it("leaves a parent waiting at the plan gate as it is", () => {
    const step = advance(waiting, resumeWith(nothingFound));
    expect(step.delivery).toBe(waiting);
    expect(step.effects).toEqual([]);
  });
});

describe("planning steps", () => {
  const deepFreeze = <T>(value: T): T => {
    if (typeof value === "object" && value !== null) {
      for (const child of Object.values(value)) deepFreeze(child);
      Object.freeze(value);
    }
    return value;
  };

  it.each([
    ["the start", queuedParent, start],
    ["a submission", planning, submitted(accepted("mcp"))],
    ["an invalid submission", planning, submitted(invalid("x"))],
    ["the run's end", acceptedRunning, finished(planRun)],
    ["the fallback's result", awaitingFallback, read(FALLBACK, invalid("x"))],
    ["a resume", blockedOnRun, resumeWith(nothingFound)],
    ["a resume at the gate", stoppedAtGate, resumeWith(nothingFound)],
  ] as const)("never mutate their input: %s", (_, delivery, event: FactoryEvent) => {
    const input = deepFreeze(structuredClone(delivery));
    const first = advance(input, deepFreeze(structuredClone(event)));
    expect(advance(structuredClone(delivery), structuredClone(event))).toEqual(first);
    expect(input).toEqual(delivery);
  });
});
