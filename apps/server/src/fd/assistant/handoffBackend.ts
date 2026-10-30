import type { AuthEnvironmentScope, ProjectId } from "@t3tools/contracts";
import {
  WorkErrorReason,
  type WorkItemId,
  type WorkSourceId,
  type WorkSourceKind,
  type WorkStatus,
} from "@t3tools/contracts/fd/work-management";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { Caller } from "../../mcp/threadAccess.ts";

/** An active Work source of a project, which an idea can be captured in. */
export interface HandoffSource {
  readonly sourceId: WorkSourceId;
  readonly kind: WorkSourceKind;
  readonly label: string;
}

export interface HandoffItemRef {
  readonly sourceId: WorkSourceId;
  readonly itemId: WorkItemId;
}

/** A Work item as a fresh read of its source shows it. */
export interface HandoffItem {
  readonly ref: HandoffItemRef;
  readonly key: string;
  readonly url: string | null;
  readonly title: string;
  readonly status: WorkStatus;
  /** A write based on another revision is refused. */
  readonly revision: string;
  /** Work could not read the item's record cleanly, so it is read-only. */
  readonly invalid: boolean;
  /** The body as Work serves it. */
  readonly body: string;
  /** Work's fingerprint of what the item says; adding a comment never changes it. */
  readonly fingerprint: string;
  /** The comments section the item keeps in its body, which a rewrite of the body keeps. */
  readonly notes: string;
}

/** An item the backend created, as its source names it. */
export interface HandoffCreated {
  readonly ref: HandoffItemRef;
  readonly key: string;
  readonly url: string | null;
}

/**
 * The Work actor a caller writes as, which `writer` derives from what the caller may change. Work
 * checks its grants again on every write.
 */
export interface HandoffWriter {
  readonly id: string;
  readonly grants: ReadonlyArray<AuthEnvironmentScope>;
  readonly label: string;
}

/** Work refused or failed the call; `reason` is Work's own category for it. */
export class HandoffBackendError extends Schema.TaggedError<HandoffBackendError>()(
  "HandoffBackendError",
  {
    operation: Schema.Literals(["sources", "read", "find", "create", "update", "writer"]),
    reason: WorkErrorReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Work could not complete the assistant's ${this.operation} (${this.reason}).`;
  }
}

/** The caller may only read Work: an outside client approved read-only, or a thread in plan mode. */
export class HandoffWriteRefused extends Schema.TaggedError<HandoffWriteRefused>()(
  "HandoffWriteRefused",
  {},
) {
  override get message(): string {
    return "This caller can only read Work items.";
  }
}

const unavailable = (operation: HandoffBackendError["operation"]) =>
  Effect.fail(new HandoffBackendError({ operation, reason: "unavailable" }));

/**
 * How the assistant reaches the owner's Work items without importing Work: the bridge feature
 * provides it over Work's service where the server is composed. Reads refresh Work first, so they
 * never answer from a cache older than the call. `findByMarker` returns every item of the source
 * whose body carries `marker`, each read in full; `complete` says whether finding none proves
 * that no item carries it, which only a Markdown source read whole, with no stale page and no file
 * Work could not read, can prove: a tracker's search may not show an item created moments ago.
 *
 * `fingerprint` is Work's fingerprint of content as a writer gives it, comparable with a read's:
 * the two are equal only when the item says exactly that content. A source that changes what it
 * stores, as Jira's rich text can, may never read back equal, so its item is never taken to say
 * what was written.
 *
 * The default reaches no Work: every call fails as unavailable, so nothing is ever captured or
 * read for a fingerprint to be compared with.
 */
export class HandoffBackend extends Context.Reference<{
  readonly sources: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<HandoffSource>, HandoffBackendError>;
  readonly read: (ref: HandoffItemRef) => Effect.Effect<HandoffItem, HandoffBackendError>;
  readonly fingerprint: (content: {
    readonly kind: WorkSourceKind;
    readonly title: string;
    readonly body: string;
  }) => string;
  readonly findByMarker: (input: {
    readonly sourceId: WorkSourceId;
    readonly marker: string;
  }) => Effect.Effect<
    { readonly items: ReadonlyArray<HandoffItem>; readonly complete: boolean },
    HandoffBackendError
  >;
  readonly writer: (
    caller: Caller,
  ) => Effect.Effect<HandoffWriter, HandoffWriteRefused | HandoffBackendError>;
  readonly create: (
    writer: HandoffWriter,
    input: { readonly sourceId: WorkSourceId; readonly title: string; readonly body: string },
  ) => Effect.Effect<HandoffCreated, HandoffBackendError>;
  readonly update: (
    writer: HandoffWriter,
    input: {
      readonly ref: HandoffItemRef;
      readonly expectedRevision: string;
      readonly title: string;
      readonly body: string;
    },
  ) => Effect.Effect<void, HandoffBackendError>;
}>("t3/fd/assistant/HandoffBackend", {
  defaultValue: () => ({
    sources: () => unavailable("sources"),
    read: () => unavailable("read"),
    fingerprint: () => "",
    findByMarker: () => unavailable("find"),
    writer: () => unavailable("writer"),
    create: () => unavailable("create"),
    update: () => unavailable("update"),
  }),
}) {}
