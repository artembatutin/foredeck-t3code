import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { withRepositoryTerminalTarget, repositoryTerminalLabel } from "./terminal.ts";
const repositories = [
  { id: "app", name: "App", rootPath: "/work/app" },
  { id: "api", name: "API", rootPath: "/other/api" },
];
const project = {
  id: ProjectId.make("p"),
  environmentId: EnvironmentId.make("host"),
  workspaceRoot: "/work/app",
  repositories,
};
const thread = {
  id: ThreadId.make("t"),
  worktreePath: null,
  workspaceBinding: { version: 1 as const, defaultCwd: project.workspaceRoot, repositories },
};
describe("terminal repository identity", () => {
  it("retains saved launch authority and labels after membership removal", () => {
    const changed = { ...project, repositories: repositories.slice(0, 1) };
    expect(withRepositoryTerminalTarget({ cwd: "/other/api/src" }, changed, thread)).toEqual({
      cwd: "/other/api/src",
      repositoryTarget: { type: "thread", threadId: thread.id, repositoryId: "api" },
    });
    expect(repositoryTerminalLabel("shell", "/other/api/src", changed, thread)).toBe("API · shell");
  });
  it("keeps explicit targets and single-repository worktrees intact", () => {
    const input = {
      cwd: "/work/task",
      repositoryTarget: { type: "thread" as const, threadId: thread.id, repositoryId: "app" },
    };
    expect(withRepositoryTerminalTarget(input, project, thread)).toBe(input);
    const worktree = { ...thread, worktreePath: "/work/task" };
    expect(withRepositoryTerminalTarget({ cwd: "/work/task" }, project, worktree)).toEqual({
      cwd: "/work/task",
    });
    expect(repositoryTerminalLabel("shell", "/work/task", project, worktree)).toBe("shell");
  });
  it("scopes outside directories for server rejection instead of stripping authority", () => {
    expect(
      withRepositoryTerminalTarget({ cwd: "/outside" }, project, thread).repositoryTarget,
    ).toEqual({ type: "thread", threadId: thread.id, repositoryId: "app" });
  });
});
