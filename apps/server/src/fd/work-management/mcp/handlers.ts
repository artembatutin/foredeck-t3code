import { OrchestratorMcpFailure, type ProjectId, type ThreadId } from "@t3tools/contracts";
import { WorkItemId, WorkMcpFailure, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import {
  type Caller,
  loadCaller,
  resolveProjectId,
  unavailable,
} from "../../../mcp/threadAccess.ts";
import type { WorkActor } from "../authority.ts";
import { toWorkError, type WorkDomainError } from "../errors.ts";
import {
  AGENT_BODY_MAX_CHARS,
  AGENT_COMMENT_MAX_CHARS,
  AGENT_COMMENTS_MAX,
  truncateText,
} from "../model/bounds.ts";
import * as WorkService from "../WorkService.ts";
import * as WorkThreads from "../WorkThreads.ts";
import { actorFromCaller } from "./actor.ts";
import { describeSources, parseWorkItemReference, resolveWorkTarget } from "./target.ts";
import { WorkToolkit } from "./tools.ts";

const decodeSourceId = Schema.decodeUnknownOption(WorkSourceId);
const decodeItemId = Schema.decodeUnknownOption(WorkItemId);

/** A Work failure as an agent sees it: a reason code and a bounded message. */
const failure = (error: WorkDomainError) => {
  const wire = toWorkError(error);
  return new WorkMcpFailure({ code: wire.reason, message: wire.message });
};
const invalid = (message: string) => new WorkMcpFailure({ code: "invalid_request", message });
const work = <A>(effect: Effect.Effect<A, WorkDomainError>) => Effect.mapError(effect, failure);

const optionalSourceId = (value: string | undefined) => {
  if (value === undefined) return Effect.succeed(undefined);
  const decoded = decodeSourceId(value);
  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(invalid(`${value} is not a Work source id.`));
};

const itemId = (value: string) => {
  const decoded = decodeItemId(value);
  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(invalid(`${value} is not a Work item id.`));
};
const optionalItemId = (value: string | undefined) =>
  value === undefined ? Effect.succeed(undefined) : itemId(value);
const nullableItemId = (value: string | null | undefined) =>
  value === null ? Effect.succeed(null) : optionalItemId(value);
const isWorkMcpFailure = Schema.is(WorkMcpFailure);

/** The caller and the Work actor it acts as. */
const context = Effect.gen(function* () {
  const caller = yield* loadCaller();
  return { caller, actor: actorFromCaller(caller) };
});

const projectSources = (actor: WorkActor, caller: Caller, projectId: ProjectId | undefined) =>
  Effect.gen(function* () {
    const service = yield* WorkService.WorkService;
    const project = yield* resolveProjectId(caller, projectId);
    const { sources } = yield* work(
      service.listSources(actor, { projectId: project, includeDisconnected: false }),
    );
    return sources;
  });

/** The item an agent named, in its project unless the reference is already canonical. */
const resolveItem = (
  actor: WorkActor,
  caller: Caller,
  params: { readonly item: string; readonly sourceId?: string; readonly projectId?: ProjectId },
) =>
  Effect.gen(function* () {
    const reference = parseWorkItemReference(params.item);
    if (reference === undefined) {
      return yield* invalid(
        "Name the item as <sourceId>:<itemId>, a key such as fd-7k3qa2, #123 or PROJ-12, or its URL.",
      );
    }
    if (reference.type === "ref") return reference.ref;
    const sourceId = yield* optionalSourceId(params.sourceId);
    const resolved = resolveWorkTarget({
      reference,
      sources: yield* projectSources(actor, caller, params.projectId),
      sourceId,
    });
    return resolved.ok ? resolved.ref : yield* invalid(resolved.message);
  });

/** The source to create in or list: the one named, else the project's only active source. */
const resolveSource = (
  actor: WorkActor,
  caller: Caller,
  params: { readonly sourceId?: string; readonly projectId?: ProjectId },
) =>
  Effect.gen(function* () {
    const named = yield* optionalSourceId(params.sourceId);
    if (named !== undefined) return named;
    const sources = yield* projectSources(actor, caller, params.projectId);
    if (sources.length === 1) return sources[0]!.sourceId;
    return yield* new OrchestratorMcpFailure({
      code: "target_required",
      message:
        sources.length === 0
          ? "This project has no active Work sources."
          : `Pass sourceId. Sources: ${describeSources(sources)}.`,
    });
  });

/** What a thread linked to an item is doing now. */
const threadState = (caller: Caller, threadId: ThreadId) =>
  caller.threads.getThreadShell(threadId).pipe(
    Effect.mapError(unavailable),
    Effect.map((shell) =>
      shell === null || shell.deletedAt !== null
        ? "deleted"
        : shell.settledAt !== null
          ? "settled"
          : shell.archivedAt !== null
            ? "archived"
            : shell.activeRunId !== null
              ? "running"
              : "idle",
    ),
  );

export const toolLayer = McpToolAccess.toLayer(WorkToolkit, {
  work_list: McpToolAccess.reads((params) =>
    Effect.gen(function* () {
      const { caller, actor } = yield* context;
      const service = yield* WorkService.WorkService;
      const sourceId = yield* resolveSource(actor, caller, params);
      const result = yield* work(
        service.listItems(actor, {
          sourceId,
          ...(params.search === undefined ? {} : { search: params.search }),
          ...(params.statuses === undefined ? {} : { statuses: params.statuses }),
          ...(params.assignee === undefined ? {} : { assignee: params.assignee }),
          ...(params.labels === undefined ? {} : { labels: params.labels }),
          ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
          limit: params.limit ?? 50,
        }),
      );
      return { sourceId, ...result };
    }),
  ),
  work_read: McpToolAccess.reads((params) =>
    Effect.gen(function* () {
      const { caller, actor } = yield* context;
      const service = yield* WorkService.WorkService;
      const ref = yield* resolveItem(actor, caller, params);
      const detail = yield* work(service.getItem(actor, { ref }));
      const body = truncateText(detail.body, AGENT_BODY_MAX_CHARS);
      const comments = detail.comments.slice(-AGENT_COMMENTS_MAX).map((comment) => {
        const text = truncateText(comment.body, AGENT_COMMENT_MAX_CHARS);
        return { ...comment, body: text.text, truncated: text.truncated };
      });
      const links = yield* Effect.forEach(detail.links, (link) =>
        threadState(caller, link.threadId).pipe(
          Effect.map((state) => ({
            threadId: link.threadId,
            source: link.source,
            linkedAt: link.linkedAt,
            state,
            lastRun: link.run,
            changedSinceStart: link.snapshot.revision !== detail.revision,
          })),
        ),
      );
      const { links: _links, capabilities, ...item } = detail;
      return {
        ...item,
        ref: `${ref.sourceId}:${ref.itemId}`,
        body: body.text,
        bodyTruncated: body.truncated || detail.bodyTruncated,
        comments,
        commentsTruncated: detail.commentsTruncated || detail.comments.length > comments.length,
        links,
        writableStatuses: capabilities.statuses,
        writableFields: capabilities.fields,
      };
    }),
  ),
  work_create: McpToolAccess.writesWithCapability((params) =>
    Effect.gen(function* () {
      const { caller, actor } = yield* context;
      const service = yield* WorkService.WorkService;
      const sourceId = yield* resolveSource(actor, caller, params);
      const parent = yield* optionalItemId(params.parent);
      return yield* work(
        service.createItem(actor, {
          sourceId,
          title: params.title,
          ...(params.body === undefined ? {} : { body: params.body }),
          ...(params.priority === undefined ? {} : { priority: params.priority }),
          ...(params.labels === undefined ? {} : { labels: params.labels }),
          ...(params.assignee === undefined ? {} : { assignee: params.assignee }),
          ...(parent === undefined ? {} : { parent }),
          ...(params.clientRequestId === undefined
            ? {}
            : { clientRequestId: `${caller.scope.requestNamespace}:${params.clientRequestId}` }),
        }),
      );
    }),
  ),
  work_update: McpToolAccess.writesWithCapability((params) =>
    Effect.gen(function* () {
      const { caller, actor } = yield* context;
      const service = yield* WorkService.WorkService;
      const ref = yield* resolveItem(actor, caller, params);
      const parent = yield* nullableItemId(params.parent);
      const blockedBy =
        params.blockedBy === undefined
          ? undefined
          : yield* Effect.forEach(params.blockedBy, itemId);
      return yield* work(
        service.updateItem(actor, {
          ref,
          ...(params.expectedRevision === undefined
            ? {}
            : { expectedRevision: params.expectedRevision }),
          ...(params.title === undefined ? {} : { title: params.title }),
          ...(params.body === undefined ? {} : { body: params.body }),
          ...(params.priority === undefined ? {} : { priority: params.priority }),
          ...(params.labels === undefined ? {} : { labels: params.labels }),
          ...(params.assignee === undefined ? {} : { assignee: params.assignee }),
          ...(parent === undefined ? {} : { parent }),
          ...(blockedBy === undefined ? {} : { blockedBy }),
        }),
      );
    }),
  ),
  work_set_status: McpToolAccess.writesWithCapability((params) =>
    Effect.gen(function* () {
      const { caller, actor } = yield* context;
      const service = yield* WorkService.WorkService;
      if ((params.status === undefined) === (params.transitionId === undefined)) {
        return yield* invalid("Give exactly one of status or transitionId.");
      }
      const ref = yield* resolveItem(actor, caller, params);
      return yield* service
        .setStatus(actor, {
          ref,
          ...(params.status === undefined ? {} : { status: params.status }),
          ...(params.transitionId === undefined ? {} : { transitionId: params.transitionId }),
          ...(params.expectedRevision === undefined
            ? {}
            : { expectedRevision: params.expectedRevision }),
        })
        .pipe(
          Effect.map((item) => ({
            status: item.status,
            nativeStatus: item.nativeStatus,
            revision: item.revision,
          })),
          // An ambiguous status is answered with its choices instead of a second failure.
          Effect.catchTags({
            WorkConflict: (conflict) =>
              conflict.candidates === undefined
                ? Effect.fail(failure(conflict))
                : Effect.succeed({
                    applied: false,
                    message: conflict.message,
                    candidates: conflict.candidates,
                  }),
          }),
          Effect.mapError((error) => (isWorkMcpFailure(error) ? error : failure(error))),
        );
    }),
  ),
  work_comment: McpToolAccess.writesWithCapability((params) =>
    Effect.gen(function* () {
      const { caller, actor } = yield* context;
      const service = yield* WorkService.WorkService;
      const ref = yield* resolveItem(actor, caller, params);
      return yield* work(
        service.addComment(actor, {
          ref,
          body: params.body,
          ...(params.clientRequestId === undefined
            ? {}
            : { clientRequestId: `${caller.scope.requestNamespace}:${params.clientRequestId}` }),
        }),
      );
    }),
  ),
  work_link_thread: McpToolAccess.writesThreads(
    (params) => [params.threadId],
    (params) =>
      Effect.gen(function* () {
        const { caller, actor } = yield* context;
        const service = yield* WorkService.WorkService;
        const threadId = params.threadId ?? caller.scope.thread?.threadId;
        if (threadId === undefined) {
          return yield* new OrchestratorMcpFailure({
            code: "target_required",
            message: "Pass threadId: this MCP client is not running inside a T3 thread.",
          });
        }
        const ref = yield* resolveItem(actor, caller, params);
        return yield* work(service.setLink(actor, { ref, threadId, action: params.action }));
      }),
  ),
  work_start_thread: McpToolAccess.startsThreads(
    () => ({}),
    (params, started) =>
      Effect.gen(function* () {
        const { caller, actor } = yield* context;
        const threads = yield* WorkThreads.WorkThreads;
        const ref = yield* resolveItem(actor, caller, params);
        return yield* work(
          threads.start(actor, {
            ref,
            creationSource: "mcp",
            mode: params.mode ?? "implement",
            ...(params.workspace === undefined
              ? {}
              : {
                  workspaceStrategy:
                    params.workspace === "root"
                      ? { type: "root" as const }
                      : {
                          type: "worktree" as const,
                          ...(params.branch === undefined ? {} : { branch: params.branch }),
                        },
                }),
            fallbackModelSelection: caller.caller?.modelSelection,
            // The caller-ceilinged modes are authoritative: thread creation is not re-checked.
            runtimeMode: started.runtimeMode,
            interactionMode: started.interactionMode,
            ...(params.prompt === undefined ? {} : { prompt: params.prompt }),
            force: params.force ?? false,
          }),
        );
      }),
  ),
});
