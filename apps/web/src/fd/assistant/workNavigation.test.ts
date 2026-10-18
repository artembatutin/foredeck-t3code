import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, type AssistantOverview } from "@t3tools/contracts";
import { availableWorkerThread, ideaAssignment } from "./workNavigation";

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("worker");
const assignment = (patch: Partial<AssistantOverview["assignments"][number]> = {}) => ({
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
