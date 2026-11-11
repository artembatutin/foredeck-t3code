import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, type AssistantOverview } from "@t3tools/contracts";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import {
  assignmentActions,
  availableWorkerThread,
  factoryAssignmentRow,
  ideaAssignment,
  ideaCaptureRow,
  ideaFacts,
  ideaStage,
  portfolioRowTitle,
} from "./workNavigation";

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("worker");
type Assignment = AssistantOverview["assignments"][number];
const assignment = (patch: Partial<Assignment> = {}): Assignment => ({
  assignmentId: "first",
  projectId: ProjectId.make("project-a"),
  ideaId: "release",
  state: "running",
  attempt: 1,
  goal: "Prepare release",
  brief: "Agreed scope",
  threadId,
  runId: null,
  notice: "",
  evidence: [],
  ...patch,
});

describe("assistant work navigation", () => {
  it("matches both project and idea, choosing the latest assignment", () => {
    const original = assignment();
    const latest = assignment({ assignmentId: "latest", threadId: ThreadId.make("latest-worker") });
    const otherProject = assignment({ projectId: ProjectId.make("project-b") });
    const otherIdea = assignment({ ideaId: "performance" });
    expect(ideaAssignment(original, [original, latest, otherProject, otherIdea])).toBe(latest);
    expect(ideaAssignment({ ...original, ideaId: "unknown" }, [original])).toBeUndefined();
  });

  it("does not send a newly queued idea back to its previous worker", () => {
    const old = assignment({ state: "completed" });
    const next = assignment({
      assignmentId: "next",
      state: "queued",
      threadId: ThreadId.make("planned"),
    });
    const target = ideaAssignment(old, [old, next]);
    expect(
      availableWorkerThread(target, environmentId, [{ id: threadId, environmentId }]),
    ).toBeNull();
    expect(
      availableWorkerThread(target, environmentId, [{ id: next.threadId!, environmentId }]),
    ).toBe(next.threadId);
  });

  it("requires the recorded conversation in the correct environment", () => {
    expect(
      availableWorkerThread(assignment(), environmentId, [
        { id: threadId, environmentId: EnvironmentId.make("remote") },
      ]),
    ).toBeNull();
    expect(
      availableWorkerThread(assignment(), environmentId, [{ id: threadId, environmentId }]),
    ).toBe(threadId);
    expect(availableWorkerThread(assignment({ threadId: null }), environmentId, [])).toBeNull();
  });

  it("follows the recorded replacement conversation after retry", () => {
    const next = assignment({ attempt: 2, threadId: ThreadId.make("retry-worker") });
    const threads = [
      { id: threadId, environmentId },
      { id: next.threadId!, environmentId },
    ];
    expect(availableWorkerThread(next, environmentId, threads)).toBe(next.threadId);
  });
});

const workItem = {
  sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
  itemId: WorkItemId.make("fd-aaaaaa"),
  key: "fd-aaaaaa",
  url: null,
};
const delivery = (patch: Partial<NonNullable<Assignment["factory"]>> = {}) => ({
  deliveryId: "d1",
  status: "running" as const,
  stage: null,
  needsYou: null,
  capacityWait: false,
  automaticWaits: { waiting: 0, blocked: 0 },
  endedDispositions: 0,
  notices: [],
  pullRequestUrl: null,
  threadId: null,
  ...patch,
});
const factoryAssignment = (
  state: string,
  factory?: NonNullable<Assignment["factory"]>,
  patch: Partial<Assignment> = {},
) =>
  assignment({
    state,
    executor: "factory",
    threadId: null,
    workItem,
    ...(factory === undefined ? {} : { factory }),
    ...patch,
  });
const row = (item: Assignment) => factoryAssignmentRow(item, environmentId)!;

describe("assignment controls", () => {
  it.each([
    ["queued", ["cancel"]],
    ["running", ["stop", "cancel"]],
    ["needs-input", ["stop", "cancel"]],
    ["stopped", ["resume", "cancel"]],
    ["failed", ["retry", "cancel"]],
    ["awaiting-verification", ["cancel"]],
    ["launching", []],
    ["launch-uncertain", []],
    ["stopping", []],
    ["completed", []],
    ["cancelled", []],
  ])("keeps an ordinary assignment's table when %s", (state, actions) => {
    expect(assignmentActions(assignment({ state }))).toEqual(actions);
    expect(assignmentActions(assignment({ state, executor: "foredeck" }))).toEqual(actions);
    expect(assignmentActions(assignment({ state, executor: "looper" }))).toEqual(actions);
  });

  // Each line is what `FactoryExecutor.control` accepts, and Factory's own stop and resume behind it.
  it.each<[string, string | null | undefined, ReadonlyArray<string>]>([
    // Queued, never claimed: nothing of it exists outside the queue.
    ["queued", undefined, ["cancel"]],
    // A pending resume waits for its slot, and only cancel ends it.
    ["queued", null, ["cancel"]],
    ["queued", "queued", ["cancel"]],
    // A committed claim takes its stop or cancel as an intent.
    ["launching", null, ["stop", "cancel"]],
    ["launch-uncertain", "queued", ["stop", "cancel"]],
    ["launch-uncertain", "unknown", ["stop", "cancel"]],
    ["running", "running", ["stop", "cancel"]],
    // Factory only stops a running delivery, and these run no stage of their own to stop after.
    ["running", "approved", ["cancel"]],
    ["running", "pr_open", ["cancel"]],
    ["running", "unknown", ["cancel"]],
    // The plan gate and an open pull request are the owner's, in Work and on the host.
    ["needs-input", "waiting", ["cancel"]],
    ["needs-input", "pr_open", ["cancel"]],
    ["needs-input", "blocked", ["resume", "cancel"]],
    ["stopping", "stopping", ["resume", "cancel"]],
    // A cancel in flight: Factory still runs it, so nothing resumes.
    ["stopping", "running", ["cancel"]],
    // Stopped before its first start, or by Factory.
    ["stopped", null, ["resume", "cancel"]],
    ["stopped", "queued", ["resume", "cancel"]],
    ["stopped", "stopped", ["resume", "cancel"]],
    // Its read failed, so resume would be refused until it can be read.
    ["stopped", "unknown", ["cancel"]],
    // The delivery ended: only its retirement is left, and cancel would be refused.
    ["running", "done", []],
    ["stopping", "cancelled", []],
    ["stopped", "cancelled", []],
    ["launching", "done", []],
    // Retired: a retry starts a new delivery.
    ["failed", null, ["retry", "cancel"]],
    ["cancelled", null, ["retry"]],
    ["cancelled", "cancelled", ["retry"]],
    ["completed", "done", []],
  ])("offers a Factory assignment's table when %s with a delivery %s", (state, status, actions) => {
    const factory = status === undefined ? undefined : delivery({ status: status as never });
    expect(assignmentActions(factoryAssignment(state, factory))).toEqual(actions);
  });

  it("offers no retry of an assignment cancelled before it was ever claimed", () => {
    expect(assignmentActions(factoryAssignment("cancelled"))).toEqual([]);
  });
});

describe("a Factory assignment's row", () => {
  it("leaves every other executor's row as it was", () => {
    expect(factoryAssignmentRow(assignment(), environmentId)).toBeNull();
    expect(factoryAssignmentRow(assignment({ executor: "looper" }), environmentId)).toBeNull();
  });

  const factsOf = (item: Assignment) =>
    Object.fromEntries(row(item).facts.map(({ label, value }) => [label, value]));

  it("shows Factory's status and stage, once a delivery row exists", () => {
    const deliveryFact = (item: Assignment) => factsOf(item)["Factory delivery"];
    expect(
      deliveryFact(
        factoryAssignment("needs-input", delivery({ status: "blocked", stage: "verify" })),
      ),
    ).toBe("Blocked · Verify");
    expect(deliveryFact(factoryAssignment("running", delivery()))).toBe("Running");
    expect(deliveryFact(factoryAssignment("stopped", delivery({ status: null })))).toBe(
      "Not started",
    );
    expect(deliveryFact(factoryAssignment("queued"))).toBe("Not started");
  });

  it("keeps a To do item, its queue rank and its open pull request as separate facts", () => {
    const item = factoryAssignment(
      "needs-input",
      delivery({
        status: "pr_open",
        stage: "pr",
        pullRequestUrl: "https://github.com/acme/alpha/pull/7",
        proceeding: false,
      }),
      {
        priority: 1,
        source: { title: "Format durations", status: "todo", statusName: null, assignee: null },
      },
    );
    expect(factsOf(item)).toEqual({
      "Work status": "To do",
      "Queue priority": "P1",
      "Human assignee": "Unassigned",
      "Factory delivery": "PR open · Pull request",
    });
    expect(row(item).nextAction?.title).toBe("Ready for your review");
  });

  it("reads a source it could not read as unavailable, in the source's words otherwise", () => {
    expect(factsOf(factoryAssignment("running", delivery()))).toMatchObject({
      "Work status": "Not available",
      "Human assignee": "Not available",
    });
    expect(
      factsOf(
        factoryAssignment("running", delivery(), {
          source: {
            title: "Format durations",
            status: "in_progress",
            statusName: "In review",
            assignee: "Sam",
          },
        }),
      ),
    ).toMatchObject({ "Work status": "In review", "Human assignee": "Sam" });
  });

  it("reads the delivery's current state, whatever note its assignment last mirrored", () => {
    // What the chat and the assignment's note said while the delivery ran stays as it was.
    const item = factoryAssignment(
      "running",
      delivery({
        status: "pr_open",
        pullRequestUrl: "https://github.com/a/b/pull/1",
        proceeding: false,
      }),
      { notice: "Factory delivery d1 is running." },
    );
    expect(row(item).nextAction?.title).toBe("Ready for your review");
    expect(row(item).reasons).toEqual(["Factory delivery d1 is running."]);
    expect(row(factoryAssignment("queued")).nextAction).toBeNull();
  });

  it("reads a merged pull request as closing out, and a following one as following", () => {
    const url = "https://github.com/a/b/pull/1";
    expect(
      row(
        factoryAssignment(
          "running",
          delivery({
            status: "pr_open",
            pullRequestUrl: url,
            pullRequestOutcome: "merged",
            proceeding: true,
          }),
        ),
      ).nextAction?.title,
    ).toBe("Merged, finishing up");
    expect(
      row(factoryAssignment("running", delivery({ status: "running", pullRequestUrl: url })))
        .nextAction?.title,
    ).toBe("Following up on the pull request");
  });

  it("opens its Work item in the All view of its own project and environment", () => {
    expect(row(factoryAssignment("running", delivery())).work).toEqual({
      to: "/work",
      search: {
        project: `local:project-a`,
        item: `${workItem.sourceId}:${workItem.itemId}`,
        view: "all",
      },
    });
    expect(
      factoryAssignmentRow(factoryAssignment("running", delivery()), EnvironmentId.make("remote"))
        ?.work?.search.project,
    ).toBe("remote:project-a");
    const { workItem: _, ...withoutItem } = factoryAssignment("running");
    expect(row(withoutItem).work).toBeNull();
  });

  it("links only a pull request a browser should open", () => {
    const linked = (pullRequestUrl: string) =>
      row(factoryAssignment("running", delivery({ pullRequestUrl }))).pullRequestUrl;
    expect(linked("https://github.com/acme/alpha/pull/7")).toBe(
      "https://github.com/acme/alpha/pull/7",
    );
    expect(linked("javascript:alert(1)")).toBeNull();
    expect(linked("not a url")).toBeNull();
    expect(row(factoryAssignment("running", delivery())).pullRequestUrl).toBeNull();
  });

  it("says why it needs you once, however the server's note words it", () => {
    const needsYou = "Verify failed.";
    const blocked = delivery({ status: "blocked", needsYou });
    const reasons = (notice: string) =>
      row(factoryAssignment("needs-input", blocked, { notice })).reasons;
    // The mirrored note quotes the reason, and says what to do.
    const mirrored = "Factory delivery d1 is blocked: Verify failed. Resume it once that is fixed.";
    expect(reasons(mirrored)).toEqual([mirrored]);
    // A later note has nothing of it, so both show.
    expect(reasons("Stopping after its step.")).toEqual([needsYou, "Stopping after its step."]);
    expect(reasons("")).toEqual([needsYou]);
  });

  it("states a slot wait, without asking anything of the owner", () => {
    const note = "Waiting for a project assistant slot";
    expect(row(factoryAssignment("queued")).waits).toEqual([note]);
    expect(row(factoryAssignment("queued", delivery({ status: null }))).waits).toEqual([note]);
    expect(row(factoryAssignment("running", delivery({ capacityWait: true }))).waits).toEqual([
      note,
    ]);
    expect(row(factoryAssignment("running", delivery())).waits).toEqual([]);
  });

  it("counts follow-ups that wait, are blocked or were not done", () => {
    expect(
      row(
        factoryAssignment(
          "running",
          delivery({ automaticWaits: { waiting: 1, blocked: 2 }, endedDispositions: 3 }),
        ),
      ).waits,
    ).toEqual([
      "1 automatic follow-up is waiting for a project assistant slot.",
      "2 automatic follow-ups are blocked until what was authorized is restored.",
      "3 automatic follow-ups were not done, because the delivery had ended or the server restarted.",
    ]);
  });

  it("shows each notice once, in the server's words", () => {
    const notice =
      "Background work on t1 finished after this assignment ended and was not continued. Open the thread and ask the agent to check it.";
    const shown = row(
      factoryAssignment("completed", delivery({ status: "done", notices: [notice] }), { notice }),
    );
    expect(shown.notices).toEqual([notice]);
    expect(shown.reasons).toEqual([]);
  });

  it("shows two follow-ups that read the same as one notice", () => {
    const notice = "A usage-limit resume on t1 is waiting for a project assistant slot.";
    const shown = row(factoryAssignment("running", delivery({ notices: [notice, notice] })));
    expect(shown.notices).toEqual([notice]);
  });

  it("opens the thread its delivery awaits, once the shell has it", () => {
    const awaited = ThreadId.make("awaited");
    const item = factoryAssignment("running", delivery({ threadId: awaited }));
    expect(availableWorkerThread(item, environmentId, [])).toBeNull();
    expect(availableWorkerThread(item, environmentId, [{ id: awaited, environmentId }])).toBe(
      awaited,
    );
  });
});

describe("what a row is called", () => {
  const goal = "Format durations exactly, in every place the app shows one, and ".repeat(8);

  it("takes the short title, and never cuts the goal to make one", () => {
    expect(portfolioRowTitle({ title: "Format durations", goal }, "idea")).toBe("Format durations");
  });

  it("keeps a legacy item's long title until its owner edits it", () => {
    const stored = "x".repeat(400);
    expect(portfolioRowTitle({ title: stored, goal }, "idea")).toBe(stored);
  });

  it("reads an older server's goal, and an empty one's id", () => {
    expect(portfolioRowTitle({ goal }, "idea")).toBe(goal);
    expect(portfolioRowTitle({ title: "  ", goal: "" }, "idea")).toBe("idea");
  });
});

describe("an idea's capture", () => {
  const idea = (capture?: AssistantOverview["ideas"][number]["capture"]) => ({
    projectId: ProjectId.make("project-a"),
    ideaId: "release",
    goal: "Prepare release",
    brief: "Agreed scope",
    authorized: false,
    priority: null,
    priorityReason: "",
    ...(capture === undefined ? {} : { capture }),
  });

  it("tells discussion, captured work and active delivery apart", () => {
    const captured = idea({ state: "captured", item: null });
    expect(ideaStage(idea(), undefined).label).toBe("Discussion");
    expect(ideaStage(idea({ state: "pending", item: null }), undefined).label).toBe("Capturing");
    expect(ideaStage(captured, undefined)).toMatchObject({
      label: "Captured",
      detail: expect.stringContaining("started no worker"),
    });
    expect(ideaStage(idea({ state: "lost", item: null }), undefined).stage).toBe("unconfirmed");
    expect(ideaStage(captured, assignment({ state: "queued" })).label).toBe("In delivery");
    expect(ideaStage(captured, assignment({ state: "stopped" })).label).toBe("In delivery");
    // An attempt that ended, or was never started, leaves the idea where its capture has it.
    for (const state of ["draft", "completed", "failed", "cancelled"]) {
      expect(ideaStage(captured, assignment({ state })).label).toBe("Captured");
    }
  });

  it("says nothing of an idea with none, from an older server too", () => {
    expect(ideaCaptureRow(idea(), environmentId)).toBeNull();
    expect(ideaFacts(idea(), undefined)).toBeNull();
  });

  it("states a captured idea's facts apart, with no delivery until one exists", () => {
    const captured = {
      ...idea({ state: "captured", item: workItem }),
      priority: 3,
      source: { title: "Prepare", status: "todo" as const, statusName: null, assignee: "Sam" },
    };
    const facts = (assignment?: Assignment) =>
      Object.fromEntries(
        (ideaFacts(captured, assignment) ?? []).map(({ label, value }) => [label, value]),
      );
    expect(facts()).toEqual({
      "Work status": "To do",
      "Queue priority": "P3",
      "Human assignee": "Sam",
      "Factory delivery": "Not started",
    });
    expect(
      facts(factoryAssignment("running", delivery({ status: "pr_open", stage: "pr" })))[
        "Factory delivery"
      ],
    ).toBe("PR open · Pull request");
  });

  it("opens a captured item in the All view, where a saved filter cannot hide it", () => {
    expect(ideaCaptureRow(idea({ state: "captured", item: workItem }), environmentId)).toEqual({
      text: "Captured as fd-aaaaaa.",
      work: {
        to: "/work",
        search: {
          project: "local:project-a",
          item: `${workItem.sourceId}:${workItem.itemId}`,
          view: "all",
        },
      },
    });
  });

  it("offers no link until a capture is confirmed", () => {
    expect(ideaCaptureRow(idea({ state: "pending", item: null }), environmentId)?.work).toBeNull();
    expect(
      ideaCaptureRow(idea({ state: "uncertain", item: workItem }), environmentId)?.work,
    ).toBeNull();
  });
});

describe("an attempt run under a review", () => {
  const ended = (reviewed: boolean) =>
    assignmentActions({
      assignmentId: "a",
      projectId: ProjectId.make("project"),
      ideaId: "idea",
      state: "cancelled",
      attempt: 1,
      goal: "Ship it",
      brief: "",
      threadId: null,
      runId: null,
      evidence: [],
      notice: "",
      executor: "factory",
      reviewed,
      factory: {
        deliveryId: "d",
        status: "cancelled",
        stage: null,
        needsYou: null,
        capacityWait: false,
        automaticWaits: { waiting: 0, blocked: 0 },
        endedDispositions: 0,
        notices: [],
        pullRequestUrl: null,
        threadId: null,
      },
    });

  it("offers no retry, since only a fresh review can start another", () => {
    expect(ended(false)).toContain("retry");
    expect(ended(true)).not.toContain("retry");
  });
});
