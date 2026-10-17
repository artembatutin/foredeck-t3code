import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, RunId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadDiffPanelSelection, useDiffPanelStore } from "./diffPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("diffPanelStore", () => {
  it("keeps repository-specific branch bases and same-name file selections separate", () => {
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(THREAD_REF, "origin/server", "server");
    store.selectBranchBaseRef(THREAD_REF, "origin/client", "client");
    store.selectTurn(THREAD_REF, RunId.make("turn-1"), "src/index.ts", "server");
    store.selectTurn(THREAD_REF, RunId.make("turn-2"), "src/index.ts", "client");
    expect(
      selectThreadDiffPanelSelection(
        useDiffPanelStore.getState().byThreadKey,
        THREAD_REF,
        "server",
      ),
    ).toMatchObject({ kind: "turn", turnId: "turn-1", filePath: "src/index.ts" });
    expect(
      selectThreadDiffPanelSelection(
        useDiffPanelStore.getState().byThreadKey,
        THREAD_REF,
        "client",
      ),
    ).toMatchObject({ kind: "turn", turnId: "turn-2" });
    store.selectGitScope(THREAD_REF, "branch", "server");
    store.selectGitScope(THREAD_REF, "branch", "client");
    expect(
      selectThreadDiffPanelSelection(
        useDiffPanelStore.getState().byThreadKey,
        THREAD_REF,
        "server",
      ),
    ).toEqual({ kind: "branch", baseRef: "origin/server" });
    expect(
      selectThreadDiffPanelSelection(
        useDiffPanelStore.getState().byThreadKey,
        THREAD_REF,
        "client",
      ),
    ).toEqual({ kind: "branch", baseRef: "origin/client" });
    store.removeThread(THREAD_REF);
    expect(useDiffPanelStore.getState().byThreadKey).toEqual({});
  });
  beforeEach(() =>
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
    }),
  );

  it("keeps conversation history separate from working-copy and turn selections", () => {
    const store = useDiffPanelStore.getState();
    store.selectThreadHistory(THREAD_REF, "server");
    store.selectTurn(THREAD_REF, RunId.make("turn-3"), undefined, "client");
    expect(
      selectThreadDiffPanelSelection(
        useDiffPanelStore.getState().byThreadKey,
        THREAD_REF,
        "server",
      ),
    ).toEqual({ kind: "thread" });
    expect(
      selectThreadDiffPanelSelection(
        useDiffPanelStore.getState().byThreadKey,
        THREAD_REF,
        "client",
      ),
    ).toMatchObject({ kind: "turn", turnId: "turn-3" });
    store.selectGitScope(THREAD_REF, "unstaged", "client");
    expect(
      selectThreadDiffPanelSelection(
        useDiffPanelStore.getState().byThreadKey,
        THREAD_REF,
        "server",
      ),
    ).toEqual({ kind: "thread" });
  });

  it("defaults each thread to Changes without requiring git status", () => {
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: null });
  });

  it("defaults to Changes before a thread is selected", () => {
    expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, null)).toEqual({
      kind: "branch",
      baseRef: null,
    });
  });

  it("keeps a custom base when a generic open selects Changes again", () => {
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(THREAD_REF, "origin/release");
    store.selectGitScope(THREAD_REF, "branch");
    store.selectTurn(THREAD_REF, RunId.make("turn-1"));
    store.selectGitScope(THREAD_REF, "branch");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/release" });
  });

  it("preserves an explicit branch selection", () => {
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: null });
  });

  it("clears incompatible selection fields when changing scopes", () => {
    const store = useDiffPanelStore.getState();
    store.selectTurn(THREAD_REF, RunId.make("turn-1"), "src/app.ts");
    store.selectGitScope(THREAD_REF, "unstaged");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "unstaged" });

    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, " origin/main ");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("clears a thread's turn and file when selecting working tree without changing another thread's branch base", () => {
    const otherThreadRef = scopeThreadRef(
      EnvironmentId.make("environment-1"),
      ThreadId.make("thread-2"),
    );
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(THREAD_REF, "origin/release");
    store.selectTurn(THREAD_REF, RunId.make("turn-1"), "src/app.ts");
    store.selectBranchBaseRef(otherThreadRef, "origin/main");

    store.selectGitScope(THREAD_REF, "unstaged");

    const { byThreadKey } = useDiffPanelStore.getState();
    expect(selectThreadDiffPanelSelection(byThreadKey, THREAD_REF)).toEqual({ kind: "unstaged" });
    expect(selectThreadDiffPanelSelection(byThreadKey, otherThreadRef)).toEqual({
      kind: "branch",
      baseRef: "origin/main",
    });

    store.selectGitScope(THREAD_REF, "branch");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/release" });
  });

  it("increments the reveal request when opening the same turn file again", () => {
    const turnId = RunId.make("turn-1");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, "src/app.ts");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, "src/app.ts");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "turn", turnId, filePath: "src/app.ts", revealRequestId: 2 });
  });

  it("restores the selected branch base after visiting another scope", () => {
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/main");
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "unstaged");
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("reconciles a missing turn selection to the latest available turn", () => {
    const missingTurnId = RunId.make("turn-missing");
    const latestTurnId = RunId.make("turn-latest");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, missingTurnId, "src/app.ts");
    useDiffPanelStore.getState().reconcileTurnSelection(THREAD_REF, [latestTurnId]);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "turn",
      turnId: latestTurnId,
      filePath: "src/app.ts",
      revealRequestId: 1,
    });
  });
});
