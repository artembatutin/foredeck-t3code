import type { ProjectId } from "@t3tools/contracts";
import type {
  WorkComment,
  WorkCommentResult,
  WorkItemCreateInput,
  WorkItemDetail,
  WorkItemId,
  WorkItemPatch,
  WorkItemSummary,
  WorkListQuery,
  WorkListResult,
  WorkPeopleQuery,
  WorkPerson,
  WorkSetStatusInput,
  WorkSourceCapabilities,
  WorkSourceConfig,
  WorkSourceId,
  WorkSourceKind,
} from "@t3tools/contracts/fd/work-management";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import type * as Stream from "effect/Stream";

import type { WorkActor } from "../authority.ts";
import type { WorkDomainError } from "../errors.ts";

/**
 * What an adapter needs to act on one configured source. The service resolves the project's
 * canonical root and the stored credential before every call; adapters never look those up.
 */
export interface WorkSourceRuntime {
  readonly sourceId: WorkSourceId;
  readonly projectId: ProjectId;
  readonly kind: WorkSourceKind;
  readonly identity: string;
  readonly config: WorkSourceConfig;
  /** The project's primary checkout root; Markdown resolves its directory below it. */
  readonly rootPath: string;
  /** The stored API token for remote sources, or undefined. */
  readonly secret: string | undefined;
  /** User-initiated reads may spend a host's reserve; background reads may not. */
  readonly interactive: boolean;
}

/** An item as the adapter reads it; the service adds thread links and source capabilities. */
export type WorkSourceItemDetail = Omit<WorkItemDetail, "links" | "capabilities">;

export interface WorkSourceTestInput {
  readonly config: WorkSourceConfig;
  readonly rootPath: string;
  readonly secret: string | undefined;
}

/**
 * One source kind. Methods take the resolved runtime and return domain errors; the service
 * owns grants, caching, epochs, links and attribution, so adapters stay about the source.
 */
export interface WorkSourceAdapter {
  readonly kind: WorkSourceKind;
  readonly capabilities: WorkSourceCapabilities;
  /** Pure: the identity a config names, unique among a project's live sources of this kind. */
  readonly identity: (config: WorkSourceConfig) => string;
  /** Validates the config (and credential) against the source without changing anything. */
  readonly test: (
    input: WorkSourceTestInput,
  ) => Effect.Effect<{ readonly identity: string; readonly message?: string }, WorkDomainError>;
  /** Prepares a newly saved source, such as creating a Markdown directory. */
  readonly prepare: (runtime: WorkSourceRuntime) => Effect.Effect<void, WorkDomainError>;
  readonly list: (
    runtime: WorkSourceRuntime,
    query: WorkListQuery,
  ) => Effect.Effect<WorkListResult, WorkDomainError>;
  readonly get: (
    runtime: WorkSourceRuntime,
    itemId: WorkItemId,
  ) => Effect.Effect<WorkSourceItemDetail, WorkDomainError>;
  readonly people: (
    runtime: WorkSourceRuntime,
    query: WorkPeopleQuery,
  ) => Effect.Effect<ReadonlyArray<WorkPerson>, WorkDomainError>;
  readonly create: (
    runtime: WorkSourceRuntime,
    input: WorkItemCreateInput,
    actor: WorkActor,
  ) => Effect.Effect<WorkItemSummary, WorkDomainError>;
  readonly update: (
    runtime: WorkSourceRuntime,
    patch: WorkItemPatch,
    actor: WorkActor,
  ) => Effect.Effect<WorkItemSummary, WorkDomainError>;
  readonly setStatus: (
    runtime: WorkSourceRuntime,
    input: WorkSetStatusInput,
    actor: WorkActor,
  ) => Effect.Effect<WorkItemSummary, WorkDomainError>;
  /** `body` already carries any attribution the service adds for agent actors. */
  readonly comment: (
    runtime: WorkSourceRuntime,
    itemId: WorkItemId,
    body: string,
    actor: WorkActor,
  ) => Effect.Effect<WorkCommentResult, WorkDomainError>;
  /**
   * A comment of the item whose text contains `text`, looked for through the item's whole
   * comment history; none when no comment does. `get` returns a bounded list that can leave the
   * comment out, so only this answer tells that it is not there.
   */
  readonly findComment: (
    runtime: WorkSourceRuntime,
    itemId: WorkItemId,
    text: string,
  ) => Effect.Effect<Option.Option<WorkComment>, WorkDomainError>;
  /** Current summaries for linked items, batched; missing items are simply absent. */
  readonly snapshots: (
    runtime: WorkSourceRuntime,
    itemIds: ReadonlyArray<WorkItemId>,
  ) => Effect.Effect<ReadonlyArray<WorkItemSummary>, WorkDomainError>;
  /** Emits whenever the source may have changed; absent for sources that cannot tell. */
  readonly watch?: (runtime: WorkSourceRuntime) => Stream.Stream<void>;
}

export class WorkSourceAdapterRegistry extends Context.Service<
  WorkSourceAdapterRegistry,
  {
    readonly kinds: ReadonlyArray<WorkSourceKind>;
    readonly get: (kind: WorkSourceKind) => WorkSourceAdapter | undefined;
  }
>()("t3/fd/work-management/sources/WorkSourceAdapter/WorkSourceAdapterRegistry") {}

export const makeRegistry = (
  adapters: ReadonlyArray<WorkSourceAdapter>,
): WorkSourceAdapterRegistry["Service"] => {
  const byKind = new Map(adapters.map((adapter) => [adapter.kind, adapter] as const));
  return { kinds: adapters.map((adapter) => adapter.kind), get: (kind) => byKind.get(kind) };
};

/** A registry over the given adapters; the server composes the kinds it ships. */
export const layerRegistry = (adapters: ReadonlyArray<WorkSourceAdapter>) =>
  Layer.succeed(WorkSourceAdapterRegistry, makeRegistry(adapters));
