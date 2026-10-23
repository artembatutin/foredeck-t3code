import {
  AuthOrchestrationOperateScope,
  AuthWorkReadScope,
  CommandId,
  MessageId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import type {
  WorkItemRef,
  WorkStartThreadInput,
  WorkStartThreadResult,
  WorkThreadMode,
  WorkWorkspaceStrategy,
} from "@t3tools/contracts/fd/work-management";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import { getAutoBootstrapThreadModelSelection } from "../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { RepositorySet } from "../multirepo/index.ts";
import { requireGrants, type WorkActor } from "./authority.ts";
import { type WorkDomainError, WorkInvalid, WorkUnavailable } from "./errors.ts";
import { LAUNCH_GRACE_MS } from "./model/bounds.ts";
import { renderWorkPrompt, workBranchName, workThreadTitle } from "./model/prompt.ts";
import * as WorkLinkStore from "./persistence/WorkLinkStore.ts";
import * as WorkService from "./WorkService.ts";

/**
 * A thread start as every transport hands it over. The WebSocket client names its surface; the
 * MCP path passes `mcp` with the caller-ceilinged modes and the caller's model as authoritative.
 */
export interface WorkThreadStart {
  readonly ref: WorkItemRef;
  readonly threadId?: ThreadId | undefined;
  readonly creationSource: WorkStartThreadInput["creationSource"] | "mcp";
  readonly mode: WorkThreadMode;
  readonly workspaceStrategy?: WorkWorkspaceStrategy | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  /** A model to use when neither the input nor the project names one (the MCP caller's). */
  readonly fallbackModelSelection?: ModelSelection | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly prompt?: string | undefined;
  readonly force: boolean;
}

/**
 * Starts an agent thread from a Work item. Starts of one item are serialized, the link row is
 * written before the launch so a concurrent start sees it, and an open linked thread is
 * returned instead of a second launch unless the caller forces one.
 */
export class WorkThreads extends Context.Service<
  WorkThreads,
  {
    readonly start: (
      actor: WorkActor,
      input: WorkThreadStart,
    ) => Effect.Effect<WorkStartThreadResult, WorkDomainError>;
  }
>()("t3/fd/work-management/WorkThreads") {}

const make = Effect.gen(function* () {
  const work = yield* WorkService.WorkService;
  const links = yield* WorkLinkStore.WorkLinkStore;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;

  // One server owns a T3 home, so an in-process lock per item is enough. Locks are tiny and
  // bounded by the items ever started in this process.
  const locks = new Map<string, Semaphore.Semaphore>();
  const withItemLock =
    (ref: WorkItemRef) =>
    <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.suspend(() => {
        const key = `${ref.sourceId}\0${ref.itemId}`;
        let lock = locks.get(key);
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1);
          locks.set(key, lock);
        }
        return lock.withPermits(1)(effect);
      });

  const storeFailure = (cause: unknown) =>
    new WorkUnavailable({ detail: "Work storage is unavailable.", cause });
  const threadReadFailure = (cause: unknown) =>
    new WorkUnavailable({ detail: "Thread state could not be read.", cause });

  /** An open linked thread, after dropping links whose launch died before creating it. */
  const openLinkedThread = (ref: WorkItemRef) =>
    Effect.gen(function* () {
      const rows = yield* links
        .listByItem(ref.sourceId, ref.itemId)
        .pipe(Effect.mapError(storeFailure));
      const now = yield* Clock.currentTimeMillis;
      for (const link of rows) {
        const shell = yield* projections
          .getThreadShell(link.threadId)
          .pipe(Effect.mapError(threadReadFailure));
        if (shell === null) {
          if (now - Date.parse(link.linkedAt) < LAUNCH_GRACE_MS) return link.threadId;
          yield* links
            .unlink(link.sourceId, link.itemId, link.threadId)
            .pipe(Effect.mapError(storeFailure));
          continue;
        }
        if (shell.deletedAt === null && shell.settledAt === null && shell.archivedAt === null) {
          return link.threadId;
        }
      }
      return undefined;
    });

  const start: WorkThreads["Service"]["start"] = (actor, input) =>
    Effect.gen(function* () {
      yield* requireGrants(actor, [AuthWorkReadScope, AuthOrchestrationOperateScope]);
      const { stored, adapter, runtime } = yield* work.resolveSource(input.ref.sourceId, {
        interactive: true,
      });
      const item = yield* adapter.get(runtime, input.ref.itemId);

      if (!input.force) {
        const open = yield* openLinkedThread(input.ref);
        if (open !== undefined) return { threadId: open, resumed: true };
      }

      const project = Option.getOrUndefined(
        yield* projects
          .get(stored.projectId)
          .pipe(
            Effect.mapError(
              (cause) => new WorkUnavailable({ detail: "The project could not be read.", cause }),
            ),
          ),
      );
      if (project === undefined) {
        return yield* new WorkInvalid({
          detail: "The project is not available on this environment.",
        });
      }
      const resolved = resolveProjectSettings(
        yield* settings.getSettings.pipe(
          Effect.mapError(
            (cause) => new WorkUnavailable({ detail: "Settings could not be read.", cause }),
          ),
        ),
        project.projectId,
        project,
      ).settings;

      const requested = input.workspaceStrategy;
      const worktree =
        requested !== undefined
          ? requested.type === "worktree"
          : !RepositorySet.isMultiRepo(project.repositories) &&
            resolved.defaultThreadEnvMode === "worktree";
      const workspaceStrategy: ThreadLaunch.ThreadLaunchWorkspaceStrategy = worktree
        ? {
            type: "worktree",
            baseRef: "HEAD",
            branch:
              requested?.type === "worktree" && requested.branch !== undefined
                ? requested.branch
                : workBranchName(item),
            startFromOrigin: false,
          }
        : { type: "root" };
      if (workspaceStrategy.type === "worktree") {
        yield* launches
          .checkWorktreeBase({ projectId: project.projectId, workspaceStrategy })
          .pipe(Effect.mapError((error) => new WorkInvalid({ detail: error.message })));
      }

      // The same chain a new thread in the UI follows, ending at the automatic selection the
      // clients show as "Automatic" when nothing is configured.
      const modelSelection =
        input.modelSelection ??
        resolved.defaultModelSelection ??
        input.fallbackModelSelection ??
        getAutoBootstrapThreadModelSelection();

      const threadId =
        input.threadId ??
        ThreadId.make(
          yield* crypto
            .randomUUIDv4()
            .pipe(
              Effect.mapError(
                (cause) =>
                  new WorkUnavailable({ detail: "A thread id could not be minted.", cause }),
              ),
            ),
        );
      const commandId = CommandId.make(
        `work-start:${input.ref.sourceId}:${input.ref.itemId}:${threadId}`,
      );

      // Written first so a concurrent start (after this lock) or a crash both see the attempt.
      yield* links
        .link({
          sourceId: input.ref.sourceId,
          itemId: input.ref.itemId,
          threadId,
          source: "started",
          snapshot: {
            key: item.key,
            title: item.title,
            status: item.status,
            url: item.url,
            revision: item.revision,
            mode: input.mode,
            autoStarted: false,
          },
        })
        .pipe(Effect.mapError(storeFailure));

      const launched = yield* launches
        .launch({
          commandId,
          threadId,
          projectId: project.projectId,
          title: workThreadTitle(item),
          modelSelection,
          runtimeMode: input.runtimeMode ?? resolved.defaultRuntimeMode,
          interactionMode: input.interactionMode ?? "default",
          workspaceStrategy,
          createdBy: actor.id.startsWith("session:") ? "user" : "agent",
          creationSource: input.creationSource,
          initialMessage: {
            messageId: MessageId.make(`work-start-message:${threadId}`),
            text: renderWorkPrompt({
              item,
              mode: input.mode,
              directory: stored.config.kind === "markdown" ? stored.config.directory : undefined,
              extra: input.prompt,
            }),
            attachments: [],
          },
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ThreadManagementProviderInstanceDisabledError"
              ? new WorkInvalid({ detail: error.message })
              : new WorkUnavailable({ detail: error.message, cause: error }),
          ),
          Effect.tapError(() =>
            links.unlink(input.ref.sourceId, input.ref.itemId, threadId).pipe(Effect.ignore),
          ),
        );

      // Only Markdown moves on its own; remote trackers keep their workflow.
      if (
        !launched.resumed &&
        stored.config.kind === "markdown" &&
        stored.config.autoStart &&
        item.status === "todo"
      ) {
        yield* adapter.setStatus(runtime, { ref: input.ref, status: "in_progress" }, actor).pipe(
          Effect.flatMap((updated) =>
            links.updateSnapshot(input.ref.sourceId, input.ref.itemId, threadId, {
              key: updated.key,
              title: updated.title,
              status: updated.status,
              url: updated.url,
              revision: updated.revision,
              mode: input.mode,
              autoStarted: true,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("work item auto-start status change skipped", cause),
          ),
        );
      }

      yield* work.bumpEpoch;
      return { threadId: launched.threadId, resumed: launched.resumed };
    }).pipe(withItemLock(input.ref));

  return WorkThreads.of({ start });
});

export const layer = Layer.effect(WorkThreads, make);
