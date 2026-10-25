import { RunId, ThreadId } from "@t3tools/contracts";
import { FactoryTaskId, type FactoryPlanTask } from "@t3tools/contracts/fd/factory";
import { describe, expect, it } from "vite-plus/test";

import { advance } from "./engine.ts";
import { acceptedPlan, planAtGate, queuedDeliveryState } from "./state.ts";
import type {
  FactoryAdvance,
  FactoryDeliveryState,
  FactoryEvent,
  FactoryPlanJudgment,
} from "./state.ts";

const planner = ThreadId.make("thread-planner");
const planRun = RunId.make("run-plan");
const replanRun = RunId.make("run-replan");
const evidencePath = "/t3/userdata/fd-factory/delivery-1/plan.json";

const task = (id: string, overrides: Partial<FactoryPlanTask> = {}): FactoryPlanTask => ({
  id: FactoryTaskId.make(id),
  title: `Task ${id}`,
  kind: "feature",
  summary: `Build ${id}.`,
  acceptance: [`${id} works.`],
  testPlan: [{ criterion: 1, check: `${id} is tested.`, paths: [`src/${id}.test.ts`] }],
  likelyPaths: [`src/${id}.ts`],
  risk: "normal",
  ...overrides,
});
const firstTasks = [task("export-csv"), task("export-header")];
const secondTasks = [task("export-rows"), task("export-header-row")];

const accepted = (tasks: ReadonlyArray<FactoryPlanTask>, note?: string): FactoryPlanJudgment => ({
  type: "accepted",
  plan: { tasks, ...(note === undefined ? {} : { note }), source: "mcp", evidencePath },
});
const submitted = (round: number, runId: RunId, judgment: FactoryPlanJudgment): FactoryEvent => ({
  type: "plan.submitted",
  round,
  threadId: planner,
  runId,
  judgment,
});
const finished = (runId: RunId): FactoryEvent => ({
  type: "run.finished",
  threadId: planner,
  runId,
  status: "completed",
});

const fold = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]) =>
  events.reduce((current, event) => advance(current, event).delivery, delivery);

const updated = (tasks: ReadonlyArray<FactoryPlanTask>): FactoryEvent => ({
  type: "plan.updated",
  tasks,
});
const rejected: FactoryEvent = { type: "plan.rejected" };
const replanned = (note: string): FactoryEvent => ({ type: "plan.replanned", note });

const queued = queuedDeliveryState({ kind: "parent", branch: "fd/item-7", baseRef: "main" });
const planning = fold(
  queued,
  { type: "start" },
  {
    type: "thread.launched",
    effectId: 1,
    threadId: planner,
    runId: planRun,
    worktreePath: "/worktrees/item-7",
    baseline: "a".repeat(40),
  },
);
const waiting = fold(
  planning,
  submitted(1, planRun, accepted(firstTasks, "Ask about headers.")),
  finished(planRun),
);

/** The states that take no plan action: planning, stopped before the gate, blocked, ended. */
const notAtGate: ReadonlyArray<readonly [string, FactoryDeliveryState]> = [
  ["planning", planning],
  ["planning with its plan accepted", fold(planning, submitted(1, planRun, accepted(firstTasks)))],
  [
    "stopped where it would enter the gate",
    fold(
      planning,
      { type: "stop" },
      submitted(1, planRun, accepted(firstTasks)),
      finished(planRun),
    ),
  ],
  [
    "blocked on an empty plan",
    fold(planning, submitted(1, planRun, accepted([], "Nothing to do.")), finished(planRun)),
  ],
  ["cancelled at the gate", fold(waiting, { type: "cancel" })],
  ["rejected at the gate", fold(waiting, rejected)],
  ["planning again after a replan", fold(waiting, replanned("Split it."))],
];

describe("the plan gate", () => {
  it("is where a parent waits on its round's plan, awaiting nothing", () => {
    expect(waiting.status).toBe("waiting");
    expect(waiting.stage).toBe("approve_plan");
    expect(waiting.awaiting).toBeNull();
    expect(planAtGate(waiting)?.tasks).toEqual(firstTasks);
    for (const [, delivery] of notAtGate) expect(planAtGate(delivery)).toBeUndefined();
  });
});

describe("an owner's plan edit", () => {
  it("replaces the plan's tasks, keeps its round, source, evidence and note, and waits on", () => {
    const edited = [task("export-header", { title: "Write the header first" }), firstTasks[0]!];
    const step = advance(waiting, updated(edited));
    expect(step).toEqual({
      delivery: { ...waiting, plan: { ...waiting.plan!, tasks: edited } },
      effects: [],
    } satisfies FactoryAdvance);
    expect(step.delivery.plan).toMatchObject({
      round: 1,
      source: "mcp",
      evidencePath,
      note: "Ask about headers.",
    });
    // The next edit is of the edited plan.
    const removed = advance(step.delivery, updated([edited[0]!]));
    expect(planAtGate(removed.delivery)?.tasks).toEqual([edited[0]]);
  });

  it("never empties the plan", () => {
    expect(advance(waiting, updated([])).delivery).toBe(waiting);
  });

  it.each(notAtGate)("changes nothing when %s", (_name, delivery) => {
    const step = advance(delivery, updated([firstTasks[0]!]));
    expect(step.delivery).toBe(delivery);
    expect(step.effects).toEqual([]);
  });
});

describe("an owner's rejection", () => {
  it("cancels the delivery at the gate, issuing nothing", () => {
    const step = advance(waiting, rejected);
    expect(step).toEqual({
      delivery: { ...waiting, status: "cancelled" },
      effects: [],
    } satisfies FactoryAdvance);
    // Nothing moves a cancelled delivery again.
    expect(advance(step.delivery, replanned("Again.")).delivery).toBe(step.delivery);
    expect(advance(step.delivery, { type: "resume", check: null }).delivery).toBe(step.delivery);
  });

  it.each(notAtGate)("changes nothing when %s", (_name, delivery) => {
    const step = advance(delivery, rejected);
    expect(step.delivery).toBe(delivery);
    expect(step.effects).toEqual([]);
  });
});

describe("an owner's replan", () => {
  const replanTurn = {
    id: waiting.effectsIssued + 1,
    type: "send_replan_turn",
    threadId: planner,
    note: "Split the header into its own task.",
  } as const;
  const replanning = advance(waiting, replanned(replanTurn.note));

  it("returns to the plan stage in a new round and sends the note to the planner thread", () => {
    expect(replanning).toEqual({
      delivery: {
        ...waiting,
        status: "running",
        stage: "plan",
        planRound: 2,
        invalidSubmissions: 0,
        effectsIssued: replanTurn.id,
        awaiting: { type: "effect", effect: replanTurn },
      },
      effects: [replanTurn],
    } satisfies FactoryAdvance);
    // The old plan no longer stands for the round.
    expect(acceptedPlan(replanning.delivery)).toBeUndefined();
  });

  it("awaits the turn's run, and waits at the gate again on the plan that run submits", () => {
    const running = fold(replanning.delivery, {
      type: "turn.started",
      effectId: replanTurn.id,
      runId: replanRun,
    });
    expect(running.awaiting).toEqual({ type: "run", threadId: planner, runId: replanRun });

    // A submission naming the first round, or its run, is not this round's.
    expect(advance(running, submitted(1, replanRun, accepted(secondTasks))).delivery).toBe(running);
    expect(advance(running, submitted(2, planRun, accepted(secondTasks))).delivery).toBe(running);

    const resubmitted = fold(running, submitted(2, replanRun, accepted(secondTasks)));
    expect(resubmitted.status).toBe("running");
    const back = fold(resubmitted, finished(replanRun));
    expect(back.status).toBe("waiting");
    expect(back.stage).toBe("approve_plan");
    expect(back.awaiting).toBeNull();
    expect(planAtGate(back)).toEqual({ tasks: secondTasks, source: "mcp", evidencePath, round: 2 });
  });

  it("gives the new round a fresh retry allowance", () => {
    // The first round spent its one corrected retry on an invalid fenced plan.
    const retried = fold(
      planning,
      finished(planRun),
      { type: "plan.read", effectId: 2, judgment: { type: "invalid", problems: ["No block."] } },
      { type: "turn.started", effectId: 3, runId: RunId.make("run-retry") },
      submitted(1, RunId.make("run-retry"), accepted(firstTasks)),
      finished(RunId.make("run-retry")),
    );
    expect(retried.status).toBe("waiting");
    expect(retried.invalidSubmissions).toBe(1);

    const effectId = retried.effectsIssued + 1;
    const running = fold(retried, replanned("Smaller tasks."), {
      type: "turn.started",
      effectId,
      runId: replanRun,
    });
    expect(running.invalidSubmissions).toBe(0);
    // Its first invalid plan is answered, not blocked.
    const invalid = fold(
      running,
      submitted(2, replanRun, { type: "invalid", problems: ["Task 1 has no test plan."] }),
    );
    expect(invalid.status).toBe("running");
    expect(invalid.invalidSubmissions).toBe(1);
  });

  it("reads the fenced plan of a replan run that ends without a submission", () => {
    const ended = advance(
      fold(replanning.delivery, {
        type: "turn.started",
        effectId: replanTurn.id,
        runId: replanRun,
      }),
      finished(replanRun),
    );
    expect(ended.effects).toEqual([
      { id: replanTurn.id + 1, type: "read_fallback_plan", threadId: planner, runId: replanRun },
    ]);
  });

  it("blocks when the replan turn cannot be sent", () => {
    const failed = advance(replanning.delivery, {
      type: "effect.failed",
      effectId: replanTurn.id,
      detail: "Factory could not send the replan turn (ThreadMessageIntakeError).",
    });
    expect(failed.delivery.status).toBe("blocked");
    expect(failed.delivery.block).toEqual({
      reason: "effect_failed",
      effect: replanTurn,
      detail: "Factory could not send the replan turn (ThreadMessageIntakeError).",
    });
  });

  it("stops where it would enter the gate again when the owner stops it meanwhile", () => {
    const stopped = fold(
      replanning.delivery,
      { type: "turn.started", effectId: replanTurn.id, runId: replanRun },
      { type: "stop" },
      submitted(2, replanRun, accepted(secondTasks)),
      finished(replanRun),
    );
    expect(stopped.status).toBe("stopped");
    expect(stopped.checkpoint).toBe("approve_plan");
    expect(acceptedPlan(stopped)?.tasks).toEqual(secondTasks);
  });

  it.each(notAtGate)("changes nothing when %s", (_name, delivery) => {
    const step = advance(delivery, replanned("Split it."));
    expect(step.delivery).toBe(delivery);
    expect(step.effects).toEqual([]);
  });
});
