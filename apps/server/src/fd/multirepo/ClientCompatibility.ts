import {
  MULTIREPO_PROTOCOL_QUERY_PARAM,
  MULTIREPO_PROTOCOL_VERSION,
  RepositoryTargetError,
  type OrchestrationV2Command,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { isMultiRepo } from "./RepositorySet.ts";

export const supportsRepositories = (url: URL) =>
  url.searchParams.get(MULTIREPO_PROTOCOL_QUERY_PARAM) === String(MULTIREPO_PROTOCOL_VERSION);

/** Negotiated per connection; internal launches still use server-owned workspace validation. */
export const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const assertWorkspace = Effect.fn("ClientCompatibility.assertWorkspace")(function* (
    supported: boolean,
    target: {
      readonly projectId?: ProjectId;
      readonly threadIds?: ReadonlyArray<ThreadId>;
    },
  ) {
    if (supported) return;
    const projectIds = new Set(target.projectId === undefined ? [] : [target.projectId]);
    let multi = false;
    for (const threadId of target.threadIds ?? []) {
      const thread = yield* threads.getThread(threadId);
      multi ||= isMultiRepo(thread.workspaceBinding?.repositories);
    }
    for (const projectId of projectIds) {
      const project = yield* projects.get(projectId);
      multi ||= Option.isSome(project) && isMultiRepo(project.value.repositories);
    }
    if (multi)
      return yield* new RepositoryTargetError({
        detail:
          "Update this client to work with multi-repository projects. This conversation has not been changed.",
      });
  });
  return {
    assertWorkspace,
    assertCommand: (supported: boolean, command: OrchestrationV2Command) =>
      assertWorkspace(supported, {
        ...("projectId" in command ? { projectId: command.projectId } : {}),
        threadIds:
          command.type === "thread.create"
            ? []
            : command.type === "thread.merge_back"
              ? [command.sourceThreadId, command.targetThreadId]
              : "sourceThreadId" in command
                ? [command.sourceThreadId]
                : "parentThreadId" in command
                  ? [command.parentThreadId]
                  : "threadId" in command
                    ? [command.threadId]
                    : [],
      }),
  };
});
