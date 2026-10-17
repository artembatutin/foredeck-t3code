import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2AppThread,
  ProjectId,
  ProjectRepository,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { isMultiRepo, RepositorySetError } from "./RepositorySet.ts";

/** Run inside the event sink's write transaction, after reservation and before append.
 * This closes the race between project edits and a concurrently planned worktree launch.
 */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const assertProjectMembership = Effect.fn("WorkspaceTransitionGate.assertProjectMembership")(
    function* (projectId: ProjectId, repositories: readonly ProjectRepository[] | undefined) {
      if (!isMultiRepo(repositories)) return;
      const conflicting = yield* sql<{ thread_id: string }>`
        SELECT t.thread_id FROM orchestration_v2_projection_threads t
        WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL AND (
          json_extract(t.payload_json, '$.worktreePath') IS NOT NULL OR EXISTS (
            SELECT 1 FROM orchestration_v2_projection_runs r
            WHERE r.thread_id = t.thread_id AND r.status = 'preparing'
              AND json_extract(r.payload_json, '$.workspacePreparation.type') IN ('worktree', 'existing_worktree')
          )
        ) LIMIT 1
      `;
      if (conflicting.length)
        return yield* new RepositorySetError({ reason: "existing-worktrees" });
    },
  );
  const assertEvents = Effect.fn("WorkspaceTransitionGate.assertEvents")(function* (
    events: readonly OrchestrationV2DomainEvent[],
  ) {
    const createdThreads = new Map<ThreadId, OrchestrationV2AppThread>();
    for (const event of events) {
      if (event.type === "thread.created") createdThreads.set(event.threadId, event.payload);
      const worktreeThread =
        (event.type === "thread.created" || event.type === "thread.metadata-updated") &&
        event.payload.worktreePath !== null
          ? event.payload
          : undefined;
      const preparesWorktree =
        (event.type === "run.created" || event.type === "run.updated") &&
        event.payload.status === "preparing" &&
        event.payload.workspacePreparation !== undefined &&
        event.payload.workspacePreparation.type !== "root";
      if (!worktreeThread && !preparesWorktree) continue;
      const thread = worktreeThread ?? createdThreads.get(event.threadId);
      const saved = thread
        ? undefined
        : (yield* sql<{ project_id: string; repository_count: number }>`
        SELECT project_id, COALESCE(json_array_length(payload_json, '$.workspaceBinding.repositories'), 0) AS repository_count
        FROM orchestration_v2_projection_threads WHERE thread_id = ${event.threadId}
      `)[0];
      if (isMultiRepo(thread?.workspaceBinding?.repositories) || (saved?.repository_count ?? 0) > 1)
        return yield* new RepositorySetError({ reason: "worktree" });
      const projectId = thread?.projectId ?? saved?.project_id;
      if (projectId === undefined) continue;
      const project = yield* sql<{ repository_count: number }>`
        SELECT json_array_length(repositories_json) AS repository_count
        FROM projection_projects WHERE project_id = ${projectId}
      `;
      if ((project[0]?.repository_count ?? 0) > 1)
        return yield* new RepositorySetError({ reason: "worktree" });
    }
  });
  return { assertEvents, assertProjectMembership };
});
