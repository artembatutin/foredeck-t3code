import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  repositoryFileSurfaceId,
  repositoryRelativePath,
  repositoryFileRequest,
  resolveRepositoryFileReference,
} from "./fileReference.ts";

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

describe("durable file references", () => {
  it("reads configuration under the saved default subdirectory without changing checkout authority", () => {
    const reference = resolveRepositoryFileReference(project, thread, "t3.json");
    expect(repositoryFileRequest(project.workspaceRoot, "t3.json", reference.scope)).toEqual({
      cwd: primary.rootPath,
      path: "app/t3.json",
      repositoryTarget: { type: "thread", threadId: thread.id, repositoryId: primary.id },
    });
  });

  it("keeps relative transcript links under the saved default working directory", () => {
    expect(resolveRepositoryFileReference(project, thread, "src/index.ts")).toMatchObject({
      path: "app/src/index.ts",
      scope: {
        repository: primary,
        target: { type: "thread", threadId: thread.id, repositoryId: primary.id },
      },
    });
  });
  it("resolves absolute secondary paths after that repository is removed from the project", () => {
    expect(
      resolveRepositoryFileReference(
        { ...project, repositories: [primary] },
        thread,
        "/elsewhere/client/src/index.ts",
      ),
    ).toMatchObject({ path: "src/index.ts", scope: { repository: secondary } });
  });
  it("keeps two identical relative filenames and different conversations independent", () => {
    const first = resolveRepositoryFileReference(project, thread, "/projects/server/src/index.ts");
    const second = resolveRepositoryFileReference(
      project,
      thread,
      "/elsewhere/client/src/index.ts",
    );
    const otherThread = resolveRepositoryFileReference(
      project,
      { ...thread, id: ThreadId.make("other") },
      "/elsewhere/client/src/index.ts",
    );
    expect(first.path).toBe(second.path);
    expect(
      new Set(
        [first, second, otherThread].map((file) => repositoryFileSurfaceId(file.path, file.scope)),
      ).size,
    ).toBe(3);
  });
  it("does not authorize new members for legacy conversations or unscoped paths outside the binding", () => {
    const outside = resolveRepositoryFileReference(
      project,
      thread,
      "/elsewhere/client-backup/src/index.ts",
    );
    expect(outside).toMatchObject({
      path: "/elsewhere/client-backup/src/index.ts",
      scope: { repository: primary },
    });
    const legacy = resolveRepositoryFileReference(
      project,
      { id: thread.id, worktreePath: null },
      "/elsewhere/client/src/index.ts",
    );
    expect(legacy.scope).toBeUndefined();
  });
  it("preserves legacy project and worktree paths", () => {
    expect(
      resolveRepositoryFileReference({ ...project, repositories: [] }, null, "src/index.ts"),
    ).toEqual({ path: "src/index.ts" });
    expect(
      resolveRepositoryFileReference(
        project,
        { ...thread, worktreePath: "/worktrees/task" },
        "src/index.ts",
      ),
    ).toEqual({ path: "src/index.ts" });
  });
  it("matches Windows paths case-insensitively without accepting a neighboring root", () => {
    const repository = { ...secondary, rootPath: "C:\\Repos\\Client" };
    expect(repositoryRelativePath("c:/repos/client/src/index.ts", repository)).toBe("src/index.ts");
    expect(repositoryRelativePath("c:/repos/client-two/src/index.ts", repository)).toBeNull();
  });
});
