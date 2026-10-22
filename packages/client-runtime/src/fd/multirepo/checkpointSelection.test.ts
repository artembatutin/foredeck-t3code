import { describe, expect, it } from "vite-plus/test";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  RunId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
} from "@t3tools/contracts";
import { v2Now, v2Projection } from "../../state/orchestrationV2TestFixtures.ts";
import { selectRepositoryCheckpoints } from "./checkpointSelection.ts";
import { repositoryHistoryGroups } from "./history.ts";
import { deriveThreadCheckpointSummaries } from "../../state/threadCheckpoints.ts";

const repositories = [
  { id: "server", name: "Server", rootPath: "/server" },
  { id: "client", name: "Client", rootPath: "/client" },
];
const scopes: readonly OrchestrationV2CheckpointScope[] = repositories.map((repository, index) => ({
  id: CheckpointScopeId.make(repository.id),
  threadId: v2Projection.thread.id,
  runId: null,
  nodeId: NodeId.make("root"),
  parentScopeId: null,
  providerThreadId: null,
  kind: index === 0 ? "root_run" : "manual",
  ordinalWithinParent: index,
  advancesAppRunCount: index === 0,
  cwd: repository.rootPath,
  createdAt: v2Now,
  repository,
}));
const checkpoint = (
  scopeId: CheckpointScopeId,
  ordinal: number,
  status: OrchestrationV2Checkpoint["status"],
): OrchestrationV2Checkpoint => ({
  id: CheckpointId.make(`${scopeId}:${ordinal}`),
  threadId: v2Projection.thread.id,
  scopeId,
  runId: ordinal === 0 ? null : RunId.make(`turn:${ordinal}`),
  nodeId: NodeId.make("root"),
  parentCheckpointId: null,
  ordinalWithinScope: ordinal,
  appRunOrdinal: ordinal === 0 ? null : ordinal,
  ref: CheckpointRef.make(`refs/checkpoint/${scopeId}/${ordinal}`),
  status,
  files:
    ordinal === 0
      ? []
      : [
          {
            path: "src/index.ts",
            kind: "modified",
            additions: scopeId === "server" ? 2 : 5,
            deletions: 0,
          },
        ],
  capturedAt: v2Now,
});

describe("repository checkpoint presentation", () => {
  it("shows each turn once and uses only the selected repository's same-name file", () => {
    const projection = {
      ...v2Projection,
      thread: {
        ...v2Projection.thread,
        workspaceBinding: { version: 1 as const, defaultCwd: "/server", repositories },
      },
      checkpointScopes: scopes,
      checkpoints: scopes.flatMap((scope) => [
        checkpoint(scope.id, 0, "ready"),
        checkpoint(scope.id, 1, "ready"),
      ]),
    };
    expect(deriveThreadCheckpointSummaries(projection)).toHaveLength(1);
    expect(
      deriveThreadCheckpointSummaries(projection)[0]?.repositoryGroups?.map((group) => [
        group.repository.id,
        group.files[0]?.additions,
      ]),
    ).toEqual([
      ["server", 2],
      ["client", 5],
    ]);
    expect(
      deriveThreadCheckpointSummaries(projection, "client")[0]?.repositoryGroups,
    ).toBeUndefined();
    expect(deriveThreadCheckpointSummaries(projection, "server")[0]?.files[0]?.additions).toBe(2);
    expect(deriveThreadCheckpointSummaries(projection, "client")[0]?.files[0]?.additions).toBe(5);
    expect(deriveThreadCheckpointSummaries(projection, "unknown")).toEqual([]);
    const grouped = repositoryHistoryGroups(projection, RunId.make("turn:1"));
    expect(grouped.toTurnCount).toBe(1);
    expect(
      grouped.groups.map((group) => [
        group.repository.id,
        group.files[0]?.path,
        group.files[0]?.additions,
      ]),
    ).toEqual([
      ["server", "src/index.ts", 2],
      ["client", "src/index.ts", 5],
    ]);
    expect(repositoryHistoryGroups(projection, null).groups.every((group) => group.available)).toBe(
      true,
    );
  });

  it("retains unavailable history when a checkout or its baseline could not be captured", () => {
    const projection = {
      ...v2Projection,
      thread: {
        ...v2Projection.thread,
        workspaceBinding: { version: 1 as const, defaultCwd: "/server", repositories },
      },
      checkpointScopes: scopes,
      checkpoints: [
        checkpoint(scopes[1]!.id, 0, "missing"),
        checkpoint(scopes[1]!.id, 1, "ready"),
        checkpoint(scopes[1]!.id, 2, "missing"),
      ],
    };
    const summaries = deriveThreadCheckpointSummaries(projection, "client");
    expect(summaries.map((summary) => [summary.checkpointTurnCount, summary.status])).toEqual([
      [1, "missing"],
      [2, "missing"],
    ]);
    expect(summaries[0]?.files).toEqual([]);
    const grouped = repositoryHistoryGroups(projection, null);
    expect(grouped.toTurnCount).toBe(2);
    expect(grouped.groups.map((group) => group.message)).toEqual([
      "Snapshot unavailable",
      "Snapshot unavailable",
    ]);
  });
  it("does not replace a missing latest snapshot with an older repository snapshot", () => {
    const projection = {
      ...v2Projection,
      thread: {
        ...v2Projection.thread,
        workspaceBinding: { version: 1 as const, defaultCwd: "/server", repositories },
      },
      checkpointScopes: scopes,
      checkpoints: [
        checkpoint(scopes[0]!.id, 0, "ready"),
        checkpoint(scopes[0]!.id, 1, "missing"),
        checkpoint(scopes[0]!.id, 2, "ready"),
        checkpoint(scopes[1]!.id, 0, "ready"),
        checkpoint(scopes[1]!.id, 1, "ready"),
      ],
    };
    const grouped = repositoryHistoryGroups(projection, null);
    expect(grouped.toTurnCount).toBe(2);
    expect(grouped.groups[0]?.available).toBe(true);
    expect(grouped.groups[0]?.message).toContain("some turn snapshots are unavailable");
    expect(grouped.groups[1]?.available).toBe(false);
    expect(grouped.groups[1]?.files).toEqual([]);
  });
  it("uses the adjacent snapshot for turn diffs and the initial baseline only for conversation diffs", () => {
    const scope = scopes[1]!;
    const projection = {
      ...v2Projection,
      thread: {
        ...v2Projection.thread,
        workspaceBinding: { version: 1 as const, defaultCwd: "/server", repositories },
      },
      checkpointScopes: scopes,
      checkpoints: [
        checkpoint(scope.id, 0, "missing"),
        checkpoint(scope.id, 1, "ready"),
        { ...checkpoint(scope.id, 2, "ready"), filesAvailable: false },
        checkpoint(scope.id, 3, "missing"),
        checkpoint(scope.id, 4, "ready"),
      ],
    };
    const selected = selectRepositoryCheckpoints(projection, "client");
    expect(selected.find((entry) => entry.appRunOrdinal === 2)?.status).toBe("ready");
    expect(selected.find((entry) => entry.appRunOrdinal === 4)?.status).toBe("missing");
    expect(repositoryHistoryGroups(projection, RunId.make("turn:2")).groups[1]?.available).toBe(
      true,
    );
    expect(repositoryHistoryGroups(projection, RunId.make("turn:2")).groups[1]?.message).toBe(
      "File list unavailable",
    );
    expect(repositoryHistoryGroups(projection, null).groups[1]?.available).toBe(false);
    const withBaseline = {
      ...projection,
      checkpoints: [checkpoint(scope.id, 0, "ready"), ...projection.checkpoints.slice(1)],
    };
    expect(repositoryHistoryGroups(withBaseline, null).groups[1]?.available).toBe(true);
  });
});
