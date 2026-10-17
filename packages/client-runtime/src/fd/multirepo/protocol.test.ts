import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { v2Project, v2ThreadShell } from "../../state/orchestrationV2TestFixtures.ts";
import { requiresMultiRepositoryExecution, retainQueuedRepositoryRequirement } from "./protocol.ts";
const repositories = [
  { id: "app", name: "App", rootPath: "/app" },
  { id: "api", name: "API", rootPath: "/api" },
];
const snapshot = {
  schemaVersion: 2 as const,
  snapshotSequence: 1,
  projects: [{ ...v2Project, repositories }],
  threads: [v2ThreadShell],
  archivedThreads: [],
};
describe("execution protocol requirements", () => {
  it("checks new project membership while leaving old single-checkout conversations unchanged", () => {
    expect(
      requiresMultiRepositoryExecution(snapshot, {
        threadId: ThreadId.make("new"),
        projectId: v2Project.id,
      }),
    ).toBe(true);
    expect(
      requiresMultiRepositoryExecution(snapshot, {
        threadId: v2ThreadShell.id,
        projectId: v2Project.id,
      }),
    ).toBe(false);
  });
  it("keeps historical and archived multi-repository bindings after project membership shrinks", () => {
    const bound = {
      ...v2ThreadShell,
      workspaceBinding: { version: 1 as const, defaultCwd: "/app", repositories },
    };
    const changed = { ...snapshot, projects: [v2Project], threads: [], archivedThreads: [bound] };
    expect(requiresMultiRepositoryExecution(changed, { threadId: bound.id })).toBe(true);
  });
});

it("retains queued protocol requirements through edits and missing or changed membership", () => {
  const message = {
    threadId: ThreadId.make("new"),
    creation: { projectId: v2Project.id },
    text: "edited task",
  };
  const required = retainQueuedRepositoryRequirement(message, snapshot);
  expect(required).toEqual({ ...message, requiresRepositoryProtocol: true });
  expect(retainQueuedRepositoryRequirement(required, null)).toEqual(required);
  expect(
    retainQueuedRepositoryRequirement(required, { ...snapshot, projects: [v2Project] }),
  ).toEqual(required);
  expect(retainQueuedRepositoryRequirement(message, null)).toBe(message);
  const existing = { ...message, threadId: v2ThreadShell.id };
  expect(retainQueuedRepositoryRequirement(existing, snapshot)).toBe(existing);
});
