import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Result from "effect/Result";

import {
  type Assignment,
  type AssignmentEvent,
  type AssignmentEventType,
  type AssignmentState,
  AssignmentTransitionRejected,
  type BriefPatch,
  MANAGER_SUMMARY_LIMITS,
  MAX_PROGRESS_NOTES,
  newAssignment,
  type ProjectBrief,
  renderAssignmentBrief,
  renderManagerSummary,
  reviseBrief,
  transitionAssignment,
} from "./portfolio.ts";

const AT = "2026-10-16T12:00:00.000Z";
const LATER = "2026-10-16T13:00:00.000Z";
const THREAD = { kind: "thread", id: "thread-worker-1" } as const;

const STATES: ReadonlyArray<AssignmentState> = [
  "draft",
  "queued",
  "launching",
  "launch-uncertain",
  "awaiting-verification",
  "running",
  "needs-input",
  "stopping",
  "stopped",
  "failed",
  "completed",
  "cancelled",
];

// One valid event of each kind; payload rules are covered separately.
const EVENTS: ReadonlyArray<AssignmentEvent> = [
  { type: "queue" },
  { type: "claim" },
  { type: "uncertain" },
  { type: "finish" },
  { type: "start", workerRefs: [THREAD] },
  { type: "request-input", note: "Which database?" },
  { type: "provide-input" },
  { type: "record-progress", note: "Tests written" },
  { type: "stop" },
  { type: "confirm-stopped" },
  { type: "resume" },
  { type: "fail", note: "Worker crashed" },
  { type: "retry" },
  { type: "complete", evidence: ["vp test run passed"] },
  { type: "cancel" },
];

// Every accepted move, written out independently of the implementation's table.
const EXPECTED_MOVES: ReadonlyArray<
  readonly [AssignmentState, AssignmentEventType, AssignmentState]
> = [
  ["draft", "queue", "queued"],
  ["draft", "cancel", "cancelled"],
  ["queued", "start", "running"],
  ["queued", "claim", "launching"],
  ["launching", "uncertain", "launch-uncertain"],
  ["launching", "start", "running"],
  ["launching", "fail", "failed"],
  ["launching", "record-progress", "launching"],
  ["launch-uncertain", "start", "running"],
  ["launch-uncertain", "record-progress", "launch-uncertain"],
  ["running", "finish", "awaiting-verification"],
  ["awaiting-verification", "complete", "completed"],
  ["awaiting-verification", "cancel", "cancelled"],
  ["awaiting-verification", "fail", "failed"],
  ["awaiting-verification", "record-progress", "awaiting-verification"],
  ["queued", "fail", "failed"],
  ["queued", "cancel", "cancelled"],
  ["running", "request-input", "needs-input"],
  ["running", "record-progress", "running"],
  ["running", "stop", "stopping"],
  ["running", "fail", "failed"],
  ["running", "complete", "completed"],
  ["needs-input", "provide-input", "running"],
  ["needs-input", "record-progress", "needs-input"],
  ["needs-input", "stop", "stopping"],
  ["needs-input", "fail", "failed"],
  ["stopping", "record-progress", "stopping"],
  ["stopping", "confirm-stopped", "stopped"],
  ["stopping", "fail", "failed"],
  ["stopping", "complete", "completed"],
  ["stopped", "resume", "queued"],
  ["stopped", "cancel", "cancelled"],
  ["failed", "retry", "queued"],
  ["failed", "cancel", "cancelled"],
];

const projectA = ProjectId.make("project-alpha");
const projectB = ProjectId.make("project-bravo");

const draft = newAssignment({
  assignmentId: "assignment-1",
  projectId: projectA,
  executor: "foredeck",
  at: AT,
});

const assignmentIn = (state: AssignmentState, overrides: Partial<Assignment> = {}): Assignment => ({
  ...draft,
  state,
  ...overrides,
});

const authorized = { executionAuthorized: true, at: LATER };
const unauthorized = { executionAuthorized: false, at: LATER };

const outcome = (result: ReturnType<typeof transitionAssignment>) =>
  Result.isSuccess(result) ? result.success.state : `rejected:${result.failure.reason}`;

const brief = (projectId: ProjectId, patch: BriefPatch): ProjectBrief =>
  reviseBrief(undefined, { projectId, patch, reason: null, at: AT }).brief;

describe("assignment lifecycle", () => {
  it("accepts exactly the expected moves across every state and event", () => {
    const expected = new Map(EXPECTED_MOVES.map(([from, event, to]) => [`${from}:${event}`, to]));
    const reachedPairs = new Set<string>();
    for (const from of STATES) {
      for (const event of EVENTS) {
        const result = outcome(transitionAssignment(assignmentIn(from), event, authorized));
        const to = expected.get(`${from}:${event.type}`);
        assert.strictEqual(result, to ?? "rejected:invalid-transition", `${from} + ${event.type}`);
        if (to !== undefined) reachedPairs.add(`${from}->${to}`);
      }
    }
    // Every state pair: only the listed pairs are reachable, and terminal states have no way out.
    for (const from of STATES) {
      for (const to of STATES) {
        const listed = EXPECTED_MOVES.some(([a, , b]) => a === from && b === to);
        assert.strictEqual(reachedPairs.has(`${from}->${to}`), listed, `${from} -> ${to}`);
      }
    }
    for (const terminal of ["completed", "cancelled"] as const) {
      assert.isFalse([...reachedPairs].some((pair) => pair.startsWith(`${terminal}->`)));
    }
  });

  it("rejects every dispatch without authorization but still allows stopping and cancelling", () => {
    const dispatches = [
      ["draft", { type: "queue" }],
      ["queued", { type: "start", workerRefs: [THREAD] }],
      ["stopped", { type: "resume" }],
      ["failed", { type: "retry" }],
    ] as const;
    for (const [from, event] of dispatches) {
      const result = transitionAssignment(assignmentIn(from), event, unauthorized);
      assert.strictEqual(outcome(result), "rejected:not-authorized", event.type);
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, AssignmentTransitionRejected);
        assert.include(result.failure.message, "not authorized for execution");
      }
    }
    assert.strictEqual(
      outcome(transitionAssignment(assignmentIn("running"), { type: "stop" }, unauthorized)),
      "stopping",
    );
    assert.strictEqual(
      outcome(transitionAssignment(assignmentIn("queued"), { type: "cancel" }, unauthorized)),
      "cancelled",
    );
  });

  it("requires an exact worker reference to start", () => {
    for (const workerRefs of [[], [{ kind: "thread", id: "  " }]] as const) {
      assert.strictEqual(
        outcome(
          transitionAssignment(assignmentIn("queued"), { type: "start", workerRefs }, authorized),
        ),
        "rejected:missing-worker-reference",
      );
    }
    const started = transitionAssignment(
      assignmentIn("queued"),
      { type: "start", workerRefs: [THREAD, THREAD, { kind: "looper-run", id: "run-7" }] },
      authorized,
    );
    assert.isTrue(Result.isSuccess(started));
    if (Result.isSuccess(started)) {
      assert.deepStrictEqual(started.success.workerRefs, [
        THREAD,
        { kind: "looper-run", id: "run-7" },
      ]);
    }
  });

  it("rejects completion without evidence from the current attempt", () => {
    for (const evidence of [[], ["   "]]) {
      assert.strictEqual(
        outcome(
          transitionAssignment(assignmentIn("running"), { type: "complete", evidence }, authorized),
        ),
        "rejected:missing-evidence",
      );
    }

    const recorded = transitionAssignment(
      assignmentIn("running"),
      { type: "record-progress", evidence: ["Independent review approved"] },
      authorized,
    );
    assert.isTrue(Result.isSuccess(recorded));
    if (!Result.isSuccess(recorded)) return;
    const completed = transitionAssignment(
      recorded.success,
      { type: "complete", evidence: [] },
      authorized,
    );
    assert.strictEqual(outcome(completed), "completed");
    if (Result.isSuccess(completed)) {
      assert.deepStrictEqual(completed.success.evidence, ["Independent review approved"]);
    }

    // A failed attempt's evidence does not carry into the retry.
    const failed = assignmentIn("failed", { evidence: ["Old attempt passed one check"] });
    const retried = transitionAssignment(failed, { type: "retry" }, authorized);
    assert.isTrue(Result.isSuccess(retried));
    if (!Result.isSuccess(retried)) return;
    const restarted = transitionAssignment(
      retried.success,
      { type: "start", workerRefs: [{ kind: "thread", id: "thread-worker-2" }] },
      authorized,
    );
    assert.isTrue(Result.isSuccess(restarted));
    if (!Result.isSuccess(restarted)) return;
    assert.strictEqual(
      outcome(
        transitionAssignment(restarted.success, { type: "complete", evidence: [] }, authorized),
      ),
      "rejected:missing-evidence",
    );
  });

  it("resumes, retries with the next attempt, and cancels queued work", () => {
    const stopped = assignmentIn("stopped", { workerRefs: [{ kind: "looper-run", id: "run-7" }] });
    const resumed = transitionAssignment(stopped, { type: "resume" }, authorized);
    assert.isTrue(Result.isSuccess(resumed));
    if (Result.isSuccess(resumed)) {
      assert.strictEqual(resumed.success.state, "queued");
      assert.strictEqual(resumed.success.attempt, 2);
      // The service archives the previous attempt and waits for the new executor acknowledgment.
      assert.deepStrictEqual(resumed.success.workerRefs, []);
    }

    const failed = assignmentIn("failed", { attempt: 2, workerRefs: [THREAD] });
    const retried = transitionAssignment(
      failed,
      { type: "retry", note: "Retry after fix" },
      authorized,
    );
    assert.isTrue(Result.isSuccess(retried));
    if (Result.isSuccess(retried)) {
      assert.strictEqual(retried.success.state, "queued");
      assert.strictEqual(retried.success.attempt, 3);
      assert.deepStrictEqual(retried.success.workerRefs, []);
      assert.deepStrictEqual(retried.success.progress, [{ at: LATER, text: "Retry after fix" }]);
      assert.strictEqual(retried.success.updatedAt, LATER);
    }

    assert.strictEqual(
      outcome(transitionAssignment(assignmentIn("queued"), { type: "cancel" }, authorized)),
      "cancelled",
    );
  });

  it("keeps a bounded window of the most recent progress notes", () => {
    let assignment = assignmentIn("running");
    for (let index = 0; index < MAX_PROGRESS_NOTES + 5; index += 1) {
      const result = transitionAssignment(
        assignment,
        { type: "record-progress", note: `step ${index}` },
        authorized,
      );
      if (Result.isSuccess(result)) assignment = result.success;
    }
    assert.strictEqual(assignment.progress.length, MAX_PROGRESS_NOTES);
    assert.strictEqual(assignment.progress.at(-1)?.text, `step ${MAX_PROGRESS_NOTES + 4}`);
    assert.strictEqual(assignment.progress[0]?.text, "step 5");
  });
});

describe("brief revisions", () => {
  it("records only changed fields with their previous values and skips no-op patches", () => {
    const first = reviseBrief(undefined, {
      projectId: projectA,
      patch: { goal: " Ship sync ", acceptanceCriteria: ["Works offline", " "] },
      reason: null,
      at: AT,
    });
    assert.strictEqual(first.brief.goal, "Ship sync");
    assert.deepStrictEqual(first.brief.acceptanceCriteria, ["Works offline"]);
    assert.strictEqual(first.revision?.revision, 1);

    const repeated = reviseBrief(first.brief, {
      projectId: projectA,
      patch: { goal: "Ship sync", acceptanceCriteria: ["Works offline"] },
      reason: "Same again",
      at: LATER,
    });
    assert.isUndefined(repeated.revision);
    assert.strictEqual(repeated.brief, first.brief);

    const reprioritized = reviseBrief(first.brief, {
      projectId: projectA,
      patch: { goal: "Ship sync", priority: { rank: 1, reason: "Blocks release" } },
      reason: null,
      at: LATER,
    });
    assert.deepStrictEqual(reprioritized.revision?.changes, [
      { field: "priority", previous: null, next: { rank: 1, reason: "Blocks release" } },
    ]);
  });
});

describe("bounded rendering", () => {
  const managerConversation =
    "MANAGER-CONVERSATION-MARKER: we discussed project-alpha and project-bravo together.";
  const alpha = brief(projectA, {
    goal: "ALPHA-GOAL-MARKER: export reports as CSV",
    acceptanceCriteria: ["ALPHA-CRITERION-MARKER: download matches the table"],
    constraints: ["ALPHA-CONSTRAINT-MARKER: no new dependencies"],
    openQuestions: ["ALPHA-QUESTION-MARKER: include archived rows?"],
    priority: { rank: 1, reason: "Ahead of BRAVO-PRIORITY-MARKER because finance needs it" },
    executionAuthorized: true,
  });
  const bravo = brief(projectB, {
    goal: "BRAVO-GOAL-MARKER: redesign onboarding",
    acceptanceCriteria: ["BRAVO-CRITERION-MARKER: new users finish setup"],
    constraints: ["BRAVO-CONSTRAINT-MARKER: keep the old flow behind a flag"],
    openQuestions: ["BRAVO-QUESTION-MARKER: which copy?"],
    priority: { rank: 2, reason: "BRAVO-PRIORITY-MARKER" },
  });

  it("gives a worker only its own project's agreed brief", () => {
    const rendered = renderAssignmentBrief(alpha);
    for (const marker of [
      "ALPHA-GOAL-MARKER",
      "ALPHA-CRITERION-MARKER",
      "ALPHA-CONSTRAINT-MARKER",
      "ALPHA-QUESTION-MARKER",
    ]) {
      assert.include(rendered, marker);
    }
    // Priority reasons compare projects, so they never reach a worker.
    for (const foreign of [
      "BRAVO",
      "project-bravo",
      "MANAGER-CONVERSATION-MARKER",
      managerConversation,
      alpha.priority?.reason ?? "",
    ]) {
      assert.notInclude(rendered, foreign);
    }
    assert.notInclude(renderAssignmentBrief(bravo), "ALPHA");
  });

  it("bounds the manager summary per project and by project count", () => {
    const longText = "x".repeat(5_000);
    const briefs = Array.from({ length: 20 }, (_, index) =>
      brief(ProjectId.make(`project-${String(index).padStart(2, "0")}`), {
        goal: `${index} ${longText}`,
        openQuestions: [longText, longText],
        priority: { rank: index + 1, reason: longText },
      }),
    );
    // A low-priority project with a waiting worker question still makes the cut.
    const waiting = assignmentIn("needs-input", {
      assignmentId: "waiting",
      projectId: ProjectId.make("project-19"),
      progress: [{ at: AT, text: longText }],
    });
    const summary = renderManagerSummary(briefs, [waiting]);
    const sections = summary.split("\n\n");
    const projectSections = sections.filter((section) => section.startsWith("## "));

    assert.strictEqual(projectSections.length, MANAGER_SUMMARY_LIMITS.projects);
    for (const section of projectSections) {
      assert.isAtMost(section.length, MANAGER_SUMMARY_LIMITS.charactersPerProject);
    }
    assert.isTrue(projectSections[0]?.startsWith("## project-19"));
    assert.isTrue(projectSections[1]?.startsWith("## project-00"));
    assert.strictEqual(sections.at(-1), "(12 more projects not shown.)");
    assert.isAtMost(
      summary.length,
      MANAGER_SUMMARY_LIMITS.projects * (MANAGER_SUMMARY_LIMITS.charactersPerProject + 2) + 40,
    );

    const tight = renderManagerSummary([alpha, bravo], [], {
      projects: 1,
      charactersPerProject: 80,
    });
    assert.isAtMost(tight.split("\n\n")[0]?.length ?? 0, 80);
    assert.include(tight, "## project-alpha");
    assert.notInclude(tight, "BRAVO-GOAL-MARKER");
    assert.include(tight, "(1 more project not shown.)");
  });
});
