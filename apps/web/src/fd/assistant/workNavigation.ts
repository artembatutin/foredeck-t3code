import type { AssistantOverview, EnvironmentId, ThreadId } from "@t3tools/contracts";

type Assignment = AssistantOverview["assignments"][number];

// Overview assignments are ordered by creation time. A new queued assignment must
// not send the owner to an older conversation for the same idea.
export function ideaAssignment(
  idea: Pick<Assignment, "projectId" | "ideaId">,
  assignments: ReadonlyArray<Assignment>,
): Assignment | undefined {
  return assignments.findLast(
    (item) => item.projectId === idea.projectId && item.ideaId === idea.ideaId,
  );
}

export function availableWorkerThread(
  assignment: Assignment | undefined,
  environmentId: EnvironmentId,
  threads: ReadonlyArray<{ id: ThreadId; environmentId: EnvironmentId }>,
): ThreadId | null {
  // Dispatch records contain a planned ID before launch; the shell confirms it exists.
  return assignment?.threadId &&
    threads.some(
      (thread) => thread.id === assignment.threadId && thread.environmentId === environmentId,
    )
    ? assignment.threadId
    : null;
}
