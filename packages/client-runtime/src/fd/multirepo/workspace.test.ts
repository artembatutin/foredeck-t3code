import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { repositoryWorkspace, repositoryWorkspaceKey } from "./workspace.ts";

const primary = { id: "server", name: "Server", rootPath: "/projects/server" };
const secondary = { id: "client", name: "Client", rootPath: "/elsewhere/client" };
const project = {
  id: ProjectId.make("project"),
  environmentId: EnvironmentId.make("host"),
  workspaceRoot: "/projects/server/app",
  repositories: [primary, secondary],
};
const thread = {
  id: ThreadId.make("thread"),
  worktreePath: null,
  workspaceBinding: {
    version: 1 as const,
    defaultCwd: project.workspaceRoot,
    repositories: [primary, secondary],
  },
};

describe("repository workspace selection", () => {
  it("selects independent roots explicitly and retains thread identity after membership changes", () => {
    const before = repositoryWorkspace(project, thread, secondary.id);
    const after = repositoryWorkspace(
      { ...project, repositories: [primary] },
      thread,
      secondary.id,
    );
    expect(after).toEqual(before);
    expect(after.cwd).toBe(secondary.rootPath);
    expect(after.repositoryTarget).toEqual({
      type: "thread",
      threadId: thread.id,
      repositoryId: secondary.id,
    });
    expect(after.isMultiRepository).toBe(true);
    // Identical relative files can now only be requested under distinct targets and roots.
    expect(repositoryWorkspace(project, thread, primary.id).repositoryTarget).not.toEqual(
      after.repositoryTarget,
    );
    expect(repositoryWorkspace(project, thread, primary.id).cwd).not.toBe(after.cwd);
  });

  it("does not widen legacy threads or fall back from an obsolete explicit selection", () => {
    const legacy = { id: thread.id, worktreePath: null };
    expect(repositoryWorkspace(project, legacy, null).repositories).toEqual([]);
    const unknown = repositoryWorkspace(project, thread, "removed");
    expect(unknown.cwd).toBeNull();
    expect(unknown.repositoryTarget).toBeUndefined();
    expect(unknown.isMultiRepository).toBe(true);
  });

  it("preserves single-repository worktree and legacy subdirectory behavior", () => {
    const legacyProject = { ...project, repositories: [] };
    expect(repositoryWorkspace(legacyProject, null, null).cwd).toBe(project.workspaceRoot);
    const worktree = repositoryWorkspace(
      legacyProject,
      { ...thread, worktreePath: "/worktrees/task" },
      null,
    );
    expect(worktree.cwd).toBe("/worktrees/task");
    expect(worktree.repositoryTarget).toBeUndefined();
    expect(worktree.isMultiRepository).toBe(false);
  });

  it("keeps configured single checkouts and drafts at their original working directory", () => {
    const single = { ...project, repositories: [primary] };
    const bound = {
      ...thread,
      workspaceBinding: { ...thread.workspaceBinding, repositories: [primary] },
    };
    for (const currentThread of [null, bound, { id: thread.id, worktreePath: null }]) {
      const workspace = repositoryWorkspace(single, currentThread, primary.id);
      expect(workspace.cwd).toBe(project.workspaceRoot);
      expect(workspace.repositoryTarget).toBeUndefined();
      expect(workspace.selected).toBeNull();
    }
    expect(repositoryWorkspace(project, bound, null).cwd).toBe(project.workspaceRoot);
    expect(repositoryWorkspace(project, bound, null).repositoryTarget).toBeUndefined();
    const draft = repositoryWorkspace(single, null, null, "/worktrees/draft");
    expect(draft.cwd).toBe("/worktrees/draft");
    expect(draft.repositoryTarget).toBeUndefined();
  });

  it("separates project, conversation, and destination-environment selections", () => {
    expect(repositoryWorkspaceKey(project, thread)).not.toBe(repositoryWorkspaceKey(project, null));
    expect(repositoryWorkspaceKey(project, thread)).not.toBe(
      repositoryWorkspaceKey({ ...project, environmentId: EnvironmentId.make("other") }, thread),
    );
  });
});
