// @effect-diagnostics-next-line nodeBuiltinImport:off -- secret names hash synchronously.
import * as NodeCrypto from "node:crypto";

import {
  AuthSettingsWriteScope,
  AuthWorkReadScope,
  AuthWorkWriteScope,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  type WorkCommentInput,
  type WorkCommentResult,
  type WorkItemCreateInput,
  type WorkItemDetail,
  type WorkItemGetInput,
  WorkItemId,
  type WorkItemPatch,
  type WorkItemRef,
  type WorkItemSummary,
  type WorkLinkSetInput,
  type WorkLinkSetResult,
  type WorkLinksQuery,
  type WorkLinksResult,
  WorkListQuery,
  type WorkListResult,
  type WorkPeopleQuery,
  type WorkPeopleResult,
  type WorkRefreshInput,
  type WorkSetStatusInput,
  type WorkSource,
  type WorkSourceConfig,
  type WorkSourceHealth,
  WorkSourceId,
  type WorkSourceList,
  type WorkSourceRefInput,
  type WorkSourceSaveInput,
  type WorkSourcesListInput,
  type WorkSourceTestInput,
  type WorkSourceTestResult,
  type WorkThreadLink,
  type WorkThreadLinkOrigin,
} from "@t3tools/contracts/fd/work-management";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { requireGrants, isAgentActor, type WorkActor } from "./authority.ts";
import {
  WorkConflict,
  type WorkDomainError,
  WorkInvalid,
  WorkSourceNotFound,
  WorkSourceStale,
  WorkUnavailable,
  WorkUnsupported,
} from "./errors.ts";
import { attributeComment } from "./model/attribution.ts";
import { AGENT_COMMENT_MAX_CHARS, OPEN_LINKS_MAX } from "./model/bounds.ts";
import { canonicalItemId } from "./model/itemId.ts";
import * as WorkLinkStore from "./persistence/WorkLinkStore.ts";
import * as WorkSourceStore from "./persistence/WorkSourceStore.ts";
import { directoriesOverlap } from "./sources/sourceRoot.ts";
import {
  type WorkSourceAdapter,
  WorkSourceAdapterRegistry,
  type WorkSourceRuntime,
} from "./sources/WorkSourceAdapter.ts";

const LIST_TTL = "30 seconds";
const ITEM_TTL = "15 seconds";
const CACHE_CAPACITY = 256;
/** How long a `clientRequestId` replays its stored result for create and comment. */
const REQUEST_REPLAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_REPLAY_CAPACITY = 1000;
const OPEN_LINK_READ_CONCURRENCY = 8;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Cache keys carry the epoch, so a bump makes every older entry unreachable. */
const ListCacheKey = Schema.fromJsonString(
  Schema.Tuple([WorkSourceId, WorkListQuery, Schema.Number]),
);
const encodeListKey = Schema.encodeSync(ListCacheKey);
const decodeListKey = Schema.decodeSync(ListCacheKey);
const ItemCacheKey = Schema.fromJsonString(Schema.Tuple([WorkSourceId, WorkItemId, Schema.Number]));
const encodeItemKey = Schema.encodeSync(ItemCacheKey);
const decodeItemKey = Schema.decodeSync(ItemCacheKey);

/** A source as the service hands it to an adapter, plus its stored record. */
export interface ResolvedSource {
  readonly stored: WorkSourceStore.StoredWorkSource;
  readonly adapter: WorkSourceAdapter;
  readonly runtime: WorkSourceRuntime;
}

/** A source the reactor may watch; `resolved` is null while its project or token cannot be read. */
export interface WatchableSource {
  readonly stored: WorkSourceStore.StoredWorkSource;
  readonly resolved: ResolvedSource | null;
}

export class WorkService extends Context.Service<
  WorkService,
  {
    readonly listSources: (
      actor: WorkActor,
      input: WorkSourcesListInput,
    ) => Effect.Effect<WorkSourceList, WorkDomainError>;
    readonly saveSource: (
      actor: WorkActor,
      input: WorkSourceSaveInput,
    ) => Effect.Effect<WorkSource, WorkDomainError>;
    readonly disconnectSource: (
      actor: WorkActor,
      input: WorkSourceRefInput,
    ) => Effect.Effect<WorkSource, WorkDomainError>;
    readonly restoreSource: (
      actor: WorkActor,
      input: WorkSourceRefInput,
    ) => Effect.Effect<WorkSource, WorkDomainError>;
    readonly testSource: (
      actor: WorkActor,
      input: WorkSourceTestInput,
    ) => Effect.Effect<WorkSourceTestResult, WorkDomainError>;
    readonly listItems: (
      actor: WorkActor,
      query: WorkListQuery,
    ) => Effect.Effect<WorkListResult, WorkDomainError>;
    readonly getItem: (
      actor: WorkActor,
      input: WorkItemGetInput,
    ) => Effect.Effect<WorkItemDetail, WorkDomainError>;
    readonly listPeople: (
      actor: WorkActor,
      query: WorkPeopleQuery,
    ) => Effect.Effect<WorkPeopleResult, WorkDomainError>;
    readonly createItem: (
      actor: WorkActor,
      input: WorkItemCreateInput,
    ) => Effect.Effect<WorkItemSummary, WorkDomainError>;
    readonly updateItem: (
      actor: WorkActor,
      patch: WorkItemPatch,
    ) => Effect.Effect<WorkItemSummary, WorkDomainError>;
    readonly setStatus: (
      actor: WorkActor,
      input: WorkSetStatusInput,
    ) => Effect.Effect<WorkItemSummary, WorkDomainError>;
    readonly addComment: (
      actor: WorkActor,
      input: WorkCommentInput,
    ) => Effect.Effect<WorkCommentResult, WorkDomainError>;
    readonly listLinks: (
      actor: WorkActor,
      query: WorkLinksQuery,
    ) => Effect.Effect<WorkLinksResult, WorkDomainError>;
    readonly setLink: (
      actor: WorkActor,
      input: WorkLinkSetInput,
    ) => Effect.Effect<WorkLinkSetResult, WorkDomainError>;
    readonly refresh: (
      actor: WorkActor,
      input: WorkRefreshInput,
    ) => Effect.Effect<void, WorkDomainError>;
    /** The current epoch on subscribe, then every move; a subscriber refetches on each value. */
    readonly subscribeRefreshes: Stream.Stream<number>;

    /** Resolves a source for another Work module (thread start, the sync reactor). */
    readonly resolveSource: (
      sourceId: WorkSourceId,
      options?: { readonly interactive?: boolean },
    ) => Effect.Effect<ResolvedSource, WorkDomainError>;
    /** Every active source whose adapter can report changes, resolved when possible. */
    readonly watchableSources: Effect.Effect<ReadonlyArray<WatchableSource>, WorkDomainError>;
    /** Current summaries for linked items of one source, read without interactive reserve. */
    readonly snapshots: (
      sourceId: WorkSourceId,
      itemIds: ReadonlyArray<WorkItemId>,
    ) => Effect.Effect<ReadonlyArray<WorkItemSummary>, WorkDomainError>;
    /** Disconnects a deleted project's sources, drops their links and releases their secrets. */
    readonly retireProject: (projectId: ProjectId) => Effect.Effect<void, WorkDomainError>;
    /** Marks every Work read stale and wakes subscribers. */
    readonly bumpEpoch: Effect.Effect<void>;
    /** The spelling locks, caches and link rows key on; an unknown source keeps the input. */
    readonly canonicalRef: (ref: WorkItemRef) => Effect.Effect<WorkItemRef, WorkDomainError>;
    /**
     * Marks a thread launch as in flight until the scope closes. A link whose thread does not
     * exist yet is a live reservation while this holds, however long the launch takes.
     */
    readonly reserveLaunch: (threadId: ThreadId) => Effect.Effect<void, never, Scope.Scope>;
    readonly isLaunching: (threadId: ThreadId) => Effect.Effect<boolean>;
    /**
     * Runs another server module's launch of a thread for an item, with the item's link written
     * first under its canonical ref and marked with that module's origin. As with Work's own
     * starts, the link is reserved while the launch runs, so the thread's runs always find it,
     * and a launch that ends without its thread removes it. Running the launch again keeps the
     * one link.
     */
    readonly linkLaunch: <A, E>(
      input: {
        readonly ref: WorkItemRef;
        readonly threadId: ThreadId;
        readonly origin: WorkThreadLinkOrigin;
      },
      launch: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | WorkDomainError>;
  }
>()("t3/fd/work-management/WorkService") {}

/** One stable secret name per Jira site and account, so sources on one site share a token. */
export const jiraSecretName = (siteUrl: string, email: string): string => {
  const host = (() => {
    try {
      return new URL(siteUrl).host.toLowerCase();
    } catch {
      return siteUrl.trim().toLowerCase();
    }
  })();
  const digest = NodeCrypto.createHash("sha256")
    .update(`${host}\0${email.trim().toLowerCase()}`)
    .digest("hex");
  return `fd-work-jira-${digest}`;
};

const secretNameFor = (config: WorkSourceConfig): string | null =>
  config.kind === "jira" ? jiraSecretName(config.siteUrl, config.email) : null;

const unavailable = (detail: string) => (cause: unknown) => new WorkUnavailable({ detail, cause });

const TOKEN_REMOVED: WorkSourceHealth = {
  status: "auth_required",
  message: "The API token was removed; add one to read this source.",
};

interface ReplayEntry {
  readonly at: number;
  /** Settles with the first attempt's outcome; a retry in flight waits on it. */
  readonly outcome: Deferred.Deferred<unknown, WorkDomainError>;
  /** Set once the first attempt settled; an attempt still running is never evicted. */
  settled: boolean;
}

const make = Effect.gen(function* () {
  const sources = yield* WorkSourceStore.WorkSourceStore;
  const links = yield* WorkLinkStore.WorkLinkStore;
  const registry = yield* WorkSourceAdapterRegistry;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;

  const epoch = yield* SubscriptionRef.make(0);
  const bumpEpoch = SubscriptionRef.update(epoch, (value) => value + 1);
  const health = new Map<WorkSourceId, WorkSourceHealth>();
  const replays = new Map<string, ReplayEntry>();
  const launching = new Map<ThreadId, number>();

  const reserveLaunch: WorkService["Service"]["reserveLaunch"] = (threadId) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        launching.set(threadId, (launching.get(threadId) ?? 0) + 1);
      }),
      () =>
        Effect.sync(() => {
          const count = (launching.get(threadId) ?? 1) - 1;
          if (count > 0) launching.set(threadId, count);
          else launching.delete(threadId);
        }),
    );
  const isLaunching: WorkService["Service"]["isLaunching"] = (threadId) =>
    Effect.sync(() => launching.has(threadId));

  const adapterFor = (kind: WorkSourceConfig["kind"]) => {
    const adapter = registry.get(kind);
    return adapter === undefined
      ? Effect.fail(
          new WorkUnsupported({ detail: `Work sources of kind ${kind} are not available here.` }),
        )
      : Effect.succeed(adapter);
  };

  /** The project's primary checkout. Core guards the same way before passing a repository. */
  const projectRoot = (projectId: ProjectId) =>
    projects.get(projectId).pipe(
      Effect.mapError(unavailable("The project could not be read.")),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new WorkInvalid({ detail: "The project is not available on this environment." }),
            ),
          onSome: (project) =>
            Effect.succeed(project.repositories?.[0]?.rootPath ?? project.workspaceRoot),
        }),
      ),
    );

  const readSecret = (
    name: string | null,
  ): Effect.Effect<Option.Option<string>, WorkUnavailable> =>
    name === null
      ? Effect.succeedNone
      : secrets
          .get(name)
          .pipe(
            Effect.map(Option.map((bytes) => decoder.decode(bytes))),
            Effect.mapError(unavailable("The source credential could not be read.")),
          );

  const toRuntime = (
    stored: WorkSourceStore.StoredWorkSource,
    rootPath: string,
    secret: string | undefined,
    interactive: boolean,
  ): WorkSourceRuntime => ({
    sourceId: stored.sourceId,
    projectId: stored.projectId,
    kind: stored.kind,
    identity: stored.identity,
    config: stored.config,
    rootPath,
    secret,
    interactive,
  });

  const resolveStored = (
    stored: WorkSourceStore.StoredWorkSource,
    interactive: boolean,
  ): Effect.Effect<ResolvedSource, WorkDomainError> =>
    Effect.gen(function* () {
      if (stored.state !== "active") {
        return yield* new WorkUnavailable({ detail: "This Work source is disconnected." });
      }
      const adapter = yield* adapterFor(stored.kind);
      const rootPath = yield* projectRoot(stored.projectId);
      const secret = Option.getOrUndefined(yield* readSecret(stored.secretName));
      return { stored, adapter, runtime: toRuntime(stored, rootPath, secret, interactive) };
    });

  const resolveSource: WorkService["Service"]["resolveSource"] = (sourceId, options) =>
    sources.get(sourceId).pipe(
      Effect.mapError(unavailable("Work sources could not be read.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new WorkSourceNotFound({ sourceId })),
          onSome: (stored) => resolveStored(stored, options?.interactive ?? false),
        }),
      ),
    );

  const canonicalRef: WorkService["Service"]["canonicalRef"] = (ref) =>
    sources.get(ref.sourceId).pipe(
      Effect.mapError(unavailable("Work sources could not be read.")),
      Effect.map(
        Option.match({
          onNone: () => ref,
          onSome: (stored) => {
            const itemId = canonicalItemId(stored.kind, ref.itemId);
            return itemId === ref.itemId ? ref : { sourceId: ref.sourceId, itemId };
          },
        }),
      ),
    );

  const healthOf = (sourceId: WorkSourceId): WorkSourceHealth =>
    health.get(sourceId) ?? { status: "ok" };

  const setHealth = (sourceId: WorkSourceId, next: WorkSourceHealth) =>
    Effect.suspend(() => {
      const previous = healthOf(sourceId);
      if (
        previous.status === next.status &&
        previous.retryAt === next.retryAt &&
        previous.message === next.message
      ) {
        return Effect.void;
      }
      health.set(sourceId, next);
      // Only a status change is worth a refetch: a retryAt that moves on every attempt would have
      // clients hammer a host that just asked them to back off.
      return previous.status === next.status ? Effect.void : bumpEpoch;
    });

  /** Records what a source call said about the source's reachability. */
  const observed = <A>(
    sourceId: WorkSourceId,
    effect: Effect.Effect<A, WorkDomainError>,
  ): Effect.Effect<A, WorkDomainError> =>
    effect.pipe(
      Effect.tap(() => setHealth(sourceId, { status: "ok" })),
      Effect.tapError((error) => {
        switch (error._tag) {
          case "WorkUnauthenticated":
            return setHealth(sourceId, { status: "auth_required", message: error.message });
          case "WorkRateLimited":
            return setHealth(sourceId, {
              status: "rate_limited",
              message: error.message,
              ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
            });
          case "WorkUnavailable":
            return setHealth(sourceId, { status: "error", message: error.message });
          // The item changed at the source behind the cache (another tracker client, an
          // agent's own tool): drop the cached reads, so the reload a conflict asks for shows
          // the current version instead of the one the stale write was based on.
          case "WorkStale":
            return bumpEpoch;
          default:
            return Effect.void;
        }
      }),
    );

  const toWorkSource = (
    stored: WorkSourceStore.StoredWorkSource,
    adapter: WorkSourceAdapter | undefined,
  ): WorkSource => ({
    sourceId: stored.sourceId,
    projectId: stored.projectId,
    kind: stored.kind,
    identity: stored.identity,
    label: stored.label,
    config: stored.config,
    state: stored.state,
    version: stored.version,
    credential: { configured: stored.secretName !== null },
    capabilities: adapter?.capabilities ?? {
      create: false,
      statuses: [],
      fields: [],
      comments: "none",
      transitions: false,
      people: false,
    },
    health: healthOf(stored.sourceId),
    updatedAt: stored.updatedAt,
  });

  const storeFailure = unavailable("Work storage is unavailable.");

  const listSources: WorkService["Service"]["listSources"] = (actor, input) =>
    Effect.gen(function* () {
      yield* requireGrants(actor, [AuthWorkReadScope]);
      const rows = yield* sources
        .list({
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          includeDisconnected: input.includeDisconnected,
        })
        .pipe(Effect.mapError(storeFailure));
      return { sources: rows.map((stored) => toWorkSource(stored, registry.get(stored.kind))) };
    });

  /** Removes a stored token nobody references any more. */
  const releaseSecret = (name: string | null) =>
    name === null
      ? Effect.void
      : sources.countActiveBySecret(name).pipe(
          Effect.mapError(storeFailure),
          Effect.flatMap((count) =>
            count > 0
              ? Effect.void
              : secrets
                  .remove(name)
                  .pipe(
                    Effect.mapError(unavailable("The source credential could not be removed.")),
                  ),
          ),
        );

  /** Drops a removed token's name from every other source that still names it. */
  const forgetSecret = (name: string, except: WorkSourceId | undefined) =>
    sources.list({ includeDisconnected: true }).pipe(
      Effect.mapError(storeFailure),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows.filter((stored) => stored.secretName === name && stored.sourceId !== except),
          (stored) =>
            Effect.suspend(() => {
              health.set(stored.sourceId, TOKEN_REMOVED);
              return sources
                .update({ sourceId: stored.sourceId, secretName: null })
                .pipe(
                  Effect.catchTags({ WorkStoreError: (error) => Effect.fail(storeFailure(error)) }),
                );
            }),
          { discard: true },
        ),
      ),
    );

  /**
   * Points every source on the token's site and account at a freshly stored token, so one
   * replacement repairs all of them, and forgets their stale authentication failures.
   */
  const adoptSecret = (name: string, except: WorkSourceId | undefined) =>
    sources.list({ includeDisconnected: true }).pipe(
      Effect.mapError(storeFailure),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows.filter(
            (stored) => stored.sourceId !== except && secretNameFor(stored.config) === name,
          ),
          (stored) =>
            Effect.suspend(() => {
              health.delete(stored.sourceId);
              return stored.secretName === name
                ? Effect.void
                : sources.update({ sourceId: stored.sourceId, secretName: name }).pipe(
                    Effect.asVoid,
                    Effect.catchTags({
                      WorkStoreError: (error) => Effect.fail(storeFailure(error)),
                    }),
                  );
            }),
          { discard: true },
        ),
      ),
    );

  const requireSource = (sourceId: WorkSourceId) =>
    sources.get(sourceId).pipe(
      Effect.mapError(storeFailure),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new WorkSourceNotFound({ sourceId })),
          onSome: (stored) => Effect.succeed(stored),
        }),
      ),
    );

  const saveSource: WorkService["Service"]["saveSource"] = (actor, input) =>
    Effect.gen(function* () {
      yield* requireGrants(actor, [AuthSettingsWriteScope]);
      const adapter = yield* adapterFor(input.config.kind);
      const previous =
        input.sourceId === undefined ? undefined : yield* requireSource(input.sourceId);
      if (previous !== undefined && previous.kind !== input.config.kind) {
        return yield* new WorkInvalid({
          detail: `A ${previous.kind} source cannot become a ${input.config.kind} source; add a new source instead.`,
        });
      }
      if (previous !== undefined && previous.projectId !== input.projectId) {
        return yield* new WorkInvalid({ detail: "The source belongs to another project." });
      }
      if (previous !== undefined && previous.state !== "active") {
        return yield* new WorkInvalid({
          detail: "The source is disconnected; restore it before changing it.",
        });
      }
      // Version and identity are checked here, before any token moves, and again by the store.
      if (
        previous !== undefined &&
        input.expectedVersion !== undefined &&
        previous.version !== input.expectedVersion
      ) {
        return yield* new WorkSourceStale({ sourceId: previous.sourceId });
      }
      const identity = adapter.identity(input.config);
      const siblings = yield* sources
        .list({ projectId: input.projectId })
        .pipe(Effect.mapError(storeFailure));
      const taken = siblings.find(
        (stored) =>
          stored.sourceId !== input.sourceId &&
          stored.kind === input.config.kind &&
          stored.identity === identity,
      );
      if (taken !== undefined) {
        return yield* new WorkConflict({ detail: `A source for ${identity} already exists.` });
      }
      // Two Markdown sources on one directory, or a nested one, would list the same files twice;
      // the store's identity index only catches the exact spelling.
      if (input.config.kind === "markdown") {
        const directory = input.config.directory;
        const overlapping = siblings.find(
          (stored) =>
            stored.sourceId !== input.sourceId &&
            stored.config.kind === "markdown" &&
            directoriesOverlap(stored.config.directory, directory),
        );
        if (overlapping !== undefined) {
          return yield* new WorkConflict({
            detail: `${overlapping.label} already covers ${overlapping.identity}.`,
          });
        }
      }
      const rootPath = yield* projectRoot(input.projectId);

      // The token is shared by every source on the same site and account. A replacement is
      // tested before it is stored, so a mistyped token never displaces a working one.
      const name = secretNameFor(input.config);
      const secret =
        name === null || input.credential === "clear"
          ? undefined
          : (input.apiToken ?? Option.getOrUndefined(yield* readSecret(name)));
      // A source whose token was just cleared is knowingly unauthenticated; testing it would only
      // refuse the save the owner asked for.
      if (input.credential !== "clear") {
        yield* adapter.test({ config: input.config, rootPath, secret });
      }
      let secretName: string | null = null;
      if (name !== null) {
        if (input.credential === "clear") {
          yield* secrets
            .remove(name)
            .pipe(Effect.mapError(unavailable("The source credential could not be removed.")));
          yield* forgetSecret(name, input.sourceId);
        } else if (input.apiToken !== undefined) {
          yield* secrets
            .set(name, encoder.encode(input.apiToken))
            .pipe(Effect.mapError(unavailable("The source credential could not be stored.")));
          secretName = name;
          yield* adoptSecret(name, input.sourceId);
        } else {
          secretName = secret === undefined ? null : name;
        }
      }

      const persist: Effect.Effect<
        WorkSourceStore.StoredWorkSource,
        | WorkSourceStore.WorkStoreError
        | WorkConflict
        | WorkSourceNotFound
        | WorkSourceStale
        | WorkUnavailable
      > =
        input.sourceId === undefined
          ? crypto.randomUUIDv4().pipe(
              Effect.mapError(unavailable("A source id could not be minted.")),
              Effect.flatMap((uuid) =>
                sources.insertOrRevive({
                  sourceId: WorkSourceId.make(uuid.toLowerCase()),
                  projectId: input.projectId,
                  kind: input.config.kind,
                  identity,
                  label: input.label,
                  config: input.config,
                  secretName,
                }),
              ),
            )
          : sources.update({
              sourceId: input.sourceId,
              ...(input.expectedVersion === undefined
                ? {}
                : { expectedVersion: input.expectedVersion }),
              label: input.label,
              config: input.config,
              identity,
              secretName,
            });
      const stored = yield* persist.pipe(
        Effect.catchTags({ WorkStoreError: (error) => Effect.fail(storeFailure(error)) }),
      );
      if (input.credential === "clear") health.set(stored.sourceId, TOKEN_REMOVED);
      else health.delete(stored.sourceId);
      // The row exists whether or not prepare succeeds, so subscribers hear about it either way.
      yield* adapter
        .prepare(toRuntime(stored, rootPath, secret, true))
        .pipe(Effect.ensuring(bumpEpoch));
      // A rotated account leaves its old token behind unless another source still uses it.
      if (
        previous !== undefined &&
        previous.secretName !== null &&
        previous.secretName !== stored.secretName
      ) {
        yield* releaseSecret(previous.secretName);
      }
      return toWorkSource(stored, adapter);
    });

  const disconnectSource: WorkService["Service"]["disconnectSource"] = (actor, input) =>
    Effect.gen(function* () {
      yield* requireGrants(actor, [AuthSettingsWriteScope]);
      const stored = yield* sources
        .disconnect(input.sourceId, input.expectedVersion)
        .pipe(Effect.catchTags({ WorkStoreError: (error) => Effect.fail(storeFailure(error)) }));
      yield* releaseSecret(stored.secretName);
      health.delete(stored.sourceId);
      yield* bumpEpoch;
      return toWorkSource(stored, registry.get(stored.kind));
    });

  const restoreSource: WorkService["Service"]["restoreSource"] = (actor, input) =>
    Effect.gen(function* () {
      yield* requireGrants(actor, [AuthSettingsWriteScope]);
      // A source cannot come back to a project that is gone.
      yield* projectRoot((yield* requireSource(input.sourceId)).projectId);
      const restored = yield* sources
        .restore(input.sourceId, input.expectedVersion)
        .pipe(Effect.catchTags({ WorkStoreError: (error) => Effect.fail(storeFailure(error)) }));
      // The shared token may have been released, or replaced for a sibling, while this source
      // was disconnected; it uses whatever its site and account hold now.
      const name = secretNameFor(restored.config);
      const current = name !== null && Option.isSome(yield* readSecret(name)) ? name : null;
      const stored =
        current !== restored.secretName
          ? yield* sources
              .update({ sourceId: restored.sourceId, secretName: current })
              .pipe(
                Effect.catchTags({ WorkStoreError: (error) => Effect.fail(storeFailure(error)) }),
              )
          : restored;
      health.delete(stored.sourceId);
      yield* bumpEpoch;
      return toWorkSource(stored, registry.get(stored.kind));
    });

  const testSource: WorkService["Service"]["testSource"] = (actor, input) =>
    Effect.gen(function* () {
      yield* requireGrants(actor, [AuthSettingsWriteScope]);
      const adapter = yield* adapterFor(input.config.kind);
      const rootPath = yield* projectRoot(input.projectId);
      if (input.sourceId !== undefined) yield* requireSource(input.sourceId);
      // The token is the one for the site and account the config names; a stored row never
      // lends its token to another host.
      const stored = yield* readSecret(secretNameFor(input.config));
      const secret = input.apiToken ?? Option.getOrUndefined(stored);
      return yield* adapter.test({ config: input.config, rootPath, secret }).pipe(
        Effect.map((result): WorkSourceTestResult => ({
          ok: true,
          identity: result.identity,
          ...(result.message === undefined ? {} : { message: result.message }),
        })),
        Effect.catchTags({
          WorkInvalid: (error) => Effect.succeed({ ok: false, message: error.message }),
          WorkUnavailable: (error) => Effect.succeed({ ok: false, message: error.message }),
          WorkUnauthenticated: (error) => Effect.succeed({ ok: false, message: error.message }),
          WorkForbidden: (error) => Effect.succeed({ ok: false, message: error.message }),
          WorkUnsupported: (error) => Effect.succeed({ ok: false, message: error.message }),
          WorkRateLimited: (error) => Effect.succeed({ ok: false, message: error.message }),
        }),
      );
    });

  /** Failures are not worth remembering: the next read after a fix should see it. */
  const liveFor = (ttl: Duration.Input) => (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isFailure(exit) ? Duration.zero : ttl;

  const listCache = yield* Cache.makeWith(
    (key: string): Effect.Effect<WorkListResult, WorkDomainError> => {
      const [sourceId, query] = decodeListKey(key);
      return resolveSource(sourceId, { interactive: true }).pipe(
        Effect.flatMap(({ adapter, runtime }) => observed(sourceId, adapter.list(runtime, query))),
      );
    },
    { capacity: CACHE_CAPACITY, timeToLive: liveFor(LIST_TTL) },
  );
  const itemCache = yield* Cache.makeWith(
    (key: string) => {
      const [sourceId, itemId] = decodeItemKey(key);
      return resolveSource(sourceId, { interactive: true }).pipe(
        Effect.flatMap(({ adapter, runtime }) => observed(sourceId, adapter.get(runtime, itemId))),
      );
    },
    { capacity: CACHE_CAPACITY, timeToLive: liveFor(ITEM_TTL) },
  );

  const currentEpoch = SubscriptionRef.get(epoch);

  const listItems: WorkService["Service"]["listItems"] = (actor, query) =>
    Effect.gen(function* () {
      yield* requireGrants(actor, [AuthWorkReadScope]);
      const at = yield* currentEpoch;
      return yield* Cache.get(listCache, encodeListKey([query.sourceId, query, at]));
    });

  const toLink = (link: WorkLinkStore.StoredWorkLink): WorkThreadLink => ({
    ref: { sourceId: link.sourceId, itemId: link.itemId },
    threadId: link.threadId,
    source: link.source,
    ...(link.origin === null ? {} : { origin: link.origin }),
    linkedAt: link.linkedAt,
    snapshot: link.snapshot,
    run: link.run,
  });

  const getItem: WorkService["Service"]["getItem"] = (actor, input) =>
    Effect.gen(function* () {
      yield* requireGrants(actor, [AuthWorkReadScope]);
      const { adapter } = yield* resolveSource(input.ref.sourceId, { interactive: true });
      const ref = yield* canonicalRef(input.ref);
      const at = yield* currentEpoch;
      const detail = yield* Cache.get(itemCache, encodeItemKey([ref.sourceId, ref.itemId, at]));
      const itemLinks = yield* links
        .listByItem(ref.sourceId, ref.itemId)
        .pipe(Effect.mapError(storeFailure));
      return { ...detail, links: itemLinks.map(toLink), capabilities: adapter.capabilities };
    });

  const listPeople: WorkService["Service"]["listPeople"] = (actor, query) =>
    Effect.gen(function* () {
      yield* requireGrants(actor, [AuthWorkReadScope]);
      const { adapter, runtime } = yield* resolveSource(query.sourceId, { interactive: true });
      const itemId =
        query.itemId === undefined ? undefined : canonicalItemId(adapter.kind, query.itemId);
      const people = yield* observed(
        query.sourceId,
        adapter.people(runtime, itemId === undefined ? query : { ...query, itemId }),
      );
      return { people };
    });

  /** Replays the stored result of a non-idempotent write retried with the same request id. */
  const replayed = <A>(
    actor: WorkActor,
    operation: string,
    requestId: string | undefined,
    write: Effect.Effect<A, WorkDomainError>,
  ): Effect.Effect<A, WorkDomainError> =>
    Effect.gen(function* () {
      if (requestId === undefined) return yield* write;
      const key = `${actor.id}\0${operation}\0${requestId}`;
      const now = yield* Clock.currentTimeMillis;
      for (const [existing, entry] of replays) {
        if (now - entry.at > REQUEST_REPLAY_MS) replays.delete(existing);
      }
      const earlier = replays.get(key);
      // A retry that lands while the first attempt still runs waits for that attempt.
      if (earlier !== undefined) return (yield* Deferred.await(earlier.outcome)) as A;
      if (replays.size >= REQUEST_REPLAY_CAPACITY) {
        for (const [oldest, entry] of replays) {
          if (entry.settled) {
            replays.delete(oldest);
            break;
          }
        }
      }
      const entry: ReplayEntry = {
        at: now,
        outcome: yield* Deferred.make<unknown, WorkDomainError>(),
        settled: false,
      };
      replays.set(key, entry);
      // The bookkeeping is a finalizer: an interrupted first attempt (the client dropped) must
      // still settle its waiters and free the id, or every retry would hang on it.
      return yield* write.pipe(
        Effect.onExit((exit) =>
          Effect.suspend(() => {
            entry.settled = true;
            if (Exit.isFailure(exit)) replays.delete(key);
            const settled: Exit.Exit<unknown, WorkDomainError> =
              Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
                ? Exit.fail(
                    new WorkUnavailable({ detail: "The first attempt was cancelled; try again." }),
                  )
                : exit;
            return Deferred.done(entry.outcome, settled);
          }),
        ),
      );
    });

  const createItem: WorkService["Service"]["createItem"] = (actor, input) =>
    Effect.gen(function* () {
      yield* requireGrants(actor, [AuthWorkWriteScope]);
      const { adapter, runtime } = yield* resolveSource(input.sourceId, { interactive: true });
      const created = yield* replayed(
        actor,
        "create",
        input.clientRequestId,
        observed(input.sourceId, adapter.create(runtime, input, actor)),
      );
      yield* bumpEpoch;
      return created;
    });

  const updateItem: WorkService["Service"]["updateItem"] = (actor, input) =>
    Effect.gen(function* () {
      yield* requireGrants(actor, [AuthWorkWriteScope]);
      if (
        (input.title !== undefined || input.body !== undefined) &&
        input.expectedRevision === undefined
      ) {
        return yield* new WorkInvalid({
          detail: "Title and body edits need the revision they were based on.",
        });
      }
      const { adapter, runtime } = yield* resolveSource(input.ref.sourceId, { interactive: true });
      const patch = { ...input, ref: yield* canonicalRef(input.ref) };
      const updated = yield* observed(patch.ref.sourceId, adapter.update(runtime, patch, actor));
      yield* bumpEpoch;
      return updated;
    });

  const setStatus: WorkService["Service"]["setStatus"] = (actor, input) =>
    Effect.gen(function* () {
      yield* requireGrants(actor, [AuthWorkWriteScope]);
      const { adapter, runtime } = yield* resolveSource(input.ref.sourceId, { interactive: true });
      const request = { ...input, ref: yield* canonicalRef(input.ref) };
      const updated = yield* observed(
        input.ref.sourceId,
        adapter.setStatus(runtime, request, actor),
      );
      yield* bumpEpoch;
      return updated;
    });

  const addComment: WorkService["Service"]["addComment"] = (actor, input) =>
    Effect.gen(function* () {
      yield* requireGrants(actor, [AuthWorkWriteScope]);
      if (input.body.trim().length === 0) {
        return yield* new WorkInvalid({ detail: "A comment needs some text." });
      }
      // Agents get a shorter budget so the attribution always fits the source's line cap.
      if (isAgentActor(actor) && input.body.length > AGENT_COMMENT_MAX_CHARS) {
        return yield* new WorkInvalid({
          detail: `An agent comment may have at most ${AGENT_COMMENT_MAX_CHARS} characters.`,
        });
      }
      const { adapter, runtime } = yield* resolveSource(input.ref.sourceId, { interactive: true });
      const ref = yield* canonicalRef(input.ref);
      const body = attributeComment(input.body, actor);
      const result = yield* replayed(
        actor,
        "comment",
        input.clientRequestId,
        observed(ref.sourceId, adapter.comment(runtime, ref.itemId, body, actor)),
      );
      yield* bumpEpoch;
      return result;
    });

  const isOpenThread = (threadId: WorkThreadLink["threadId"]) =>
    projections.getThreadShell(threadId).pipe(
      Effect.map(
        (shell) =>
          shell !== null &&
          shell.deletedAt === null &&
          shell.settledAt === null &&
          shell.archivedAt === null,
      ),
      Effect.mapError(unavailable("Thread state could not be read.")),
    );

  const listLinks: WorkService["Service"]["listLinks"] = (actor, query) =>
    Effect.gen(function* () {
      yield* requireGrants(actor, [AuthWorkReadScope]);
      if (query.threadId !== undefined) {
        const rows = yield* links.listByThread(query.threadId).pipe(Effect.mapError(storeFailure));
        return { links: rows.map(toLink), truncated: false };
      }
      if (query.ref !== undefined) {
        const ref = yield* canonicalRef(query.ref);
        const rows = yield* links
          .listByItem(ref.sourceId, ref.itemId)
          .pipe(Effect.mapError(storeFailure));
        return { links: rows.map(toLink), truncated: false };
      }
      if (query.projectId !== undefined) {
        const rows = yield* links
          .listByProject(query.projectId)
          .pipe(Effect.mapError(storeFailure));
        return { links: rows.map(toLink), truncated: false };
      }
      const all = yield* links.listAll(OPEN_LINKS_MAX).pipe(Effect.mapError(storeFailure));
      const open = yield* Effect.forEach(
        all.links,
        (link) => isOpenThread(link.threadId).pipe(Effect.map((open) => (open ? [link] : []))),
        { concurrency: OPEN_LINK_READ_CONCURRENCY },
      );
      return { links: open.flat().map(toLink), truncated: all.truncated };
    });

  const setLink: WorkService["Service"]["setLink"] = (actor, request) =>
    Effect.gen(function* () {
      yield* requireGrants(actor, [AuthWorkWriteScope]);
      const input = { ...request, ref: yield* canonicalRef(request.ref) };
      if (input.action === "unlink") {
        const removed = yield* links
          .unlink(input.ref.sourceId, input.ref.itemId, input.threadId)
          .pipe(Effect.mapError(storeFailure));
        if (removed) yield* bumpEpoch;
        return { linked: false };
      }
      const { adapter, runtime } = yield* resolveSource(input.ref.sourceId, { interactive: true });
      const shell = yield* projections
        .getThreadShell(input.threadId)
        .pipe(Effect.mapError(unavailable("Thread state could not be read.")));
      if (shell === null || shell.deletedAt !== null) {
        return yield* new WorkInvalid({ detail: "The thread does not exist on this environment." });
      }
      const detail = yield* observed(input.ref.sourceId, adapter.get(runtime, input.ref.itemId));
      yield* links
        .link({
          sourceId: input.ref.sourceId,
          itemId: input.ref.itemId,
          threadId: input.threadId,
          source: isAgentActor(actor) ? "agent" : "manual",
          snapshot: {
            key: detail.key,
            title: detail.title,
            status: detail.status,
            url: detail.url,
            revision: detail.revision,
            autoStarted: false,
          },
        })
        .pipe(Effect.mapError(storeFailure));
      yield* bumpEpoch;
      return { linked: true };
    });

  /** Drops a reserved link whose launch ended without creating its thread. */
  const releaseUnlaunched = (ref: WorkItemRef, threadId: ThreadId) =>
    projections.getThreadShell(threadId).pipe(
      Effect.flatMap((shell) =>
        shell === null ? links.unlink(ref.sourceId, ref.itemId, threadId) : Effect.void,
      ),
      // Left for the sweep when it cannot be decided now; nothing reserves it any more.
      Effect.catchCause((cause) => Effect.logWarning("work launch reservation left", cause)),
    );

  const linkLaunch: WorkService["Service"]["linkLaunch"] = (input, launch) =>
    Effect.gen(function* () {
      const ref = yield* canonicalRef(input.ref);
      // Usually served by the read the caller made before preparing its launch.
      const at = yield* currentEpoch;
      const detail = yield* Cache.get(itemCache, encodeItemKey([ref.sourceId, ref.itemId, at]));
      const reserve = links
        .link({
          sourceId: ref.sourceId,
          itemId: ref.itemId,
          threadId: input.threadId,
          source: "started",
          origin: input.origin,
          snapshot: {
            key: detail.key,
            title: detail.title,
            status: detail.status,
            url: detail.url,
            revision: detail.revision,
            autoStarted: false,
          },
        })
        .pipe(Effect.mapError(storeFailure));
      // Written before the launch: the launch prepares the thread in the background, and a run
      // that ended before a later link was written would never be recorded on it. Whatever ends
      // the launch without its thread (a failure, a defect, the caller going away) removes it.
      const { launched, inserted } = yield* Effect.uninterruptibleMask((restore) =>
        reserveLaunch(input.threadId).pipe(
          Effect.andThen(reserve),
          Effect.flatMap(({ inserted }) =>
            restore(launch).pipe(Effect.map((launched) => ({ launched, inserted }))),
          ),
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) ? Effect.void : releaseUnlaunched(ref, input.threadId),
          ),
          Effect.scoped,
        ),
      );
      if (inserted) yield* bumpEpoch;
      return launched;
    });

  const refresh: WorkService["Service"]["refresh"] = (actor, _input) =>
    requireGrants(actor, [AuthWorkReadScope]).pipe(Effect.andThen(bumpEpoch));

  const watchableSources: WorkService["Service"]["watchableSources"] = sources.list().pipe(
    Effect.mapError(storeFailure),
    Effect.flatMap((rows) =>
      Effect.forEach(
        rows.filter((stored) => registry.get(stored.kind)?.watch !== undefined),
        (stored) =>
          resolveStored(stored, false).pipe(
            Effect.map((resolved): WatchableSource => ({ stored, resolved })),
            // A source whose project vanished is retired by the reactor; until then, or while
            // its token cannot be read, it stays listed without a resolution.
            Effect.orElseSucceed((): WatchableSource => ({ stored, resolved: null })),
          ),
      ),
    ),
  );

  const snapshots: WorkService["Service"]["snapshots"] = (sourceId, itemIds) =>
    resolveSource(sourceId, { interactive: false }).pipe(
      Effect.flatMap(({ adapter, runtime }) =>
        observed(sourceId, adapter.snapshots(runtime, itemIds)),
      ),
    );

  const retireProject: WorkService["Service"]["retireProject"] = (projectId) =>
    Effect.gen(function* () {
      // Tombstones keep their links until their project goes; a tombstone's token is released too.
      const rows = yield* sources
        .list({ projectId, includeDisconnected: true })
        .pipe(Effect.mapError(storeFailure));
      for (const stored of rows) {
        yield* links.deleteBySource(stored.sourceId).pipe(Effect.mapError(storeFailure));
        yield* sources
          .disconnect(stored.sourceId)
          .pipe(Effect.catchTags({ WorkStoreError: (error) => Effect.fail(storeFailure(error)) }));
        yield* releaseSecret(stored.secretName);
        health.delete(stored.sourceId);
      }
      if (rows.length > 0) yield* bumpEpoch;
    });

  return WorkService.of({
    listSources,
    saveSource,
    disconnectSource,
    restoreSource,
    testSource,
    listItems,
    getItem,
    listPeople,
    createItem,
    updateItem,
    setStatus,
    addComment,
    listLinks,
    setLink,
    refresh,
    subscribeRefreshes: SubscriptionRef.changes(epoch),
    resolveSource,
    watchableSources,
    snapshots,
    retireProject,
    bumpEpoch,
    canonicalRef,
    reserveLaunch,
    isLaunching,
    linkLaunch,
  });
});

export const layer = Layer.effect(WorkService, make);
