import type {
  AuthEnvironmentScope,
  AuthSessionId,
  ModelSelection,
  OrchestrationV2RunStatus,
  ProjectId,
  ProviderOptionSelectionValue,
  RuntimeMode,
} from "@t3tools/contracts";
import {
  type FactoryCommand,
  type FactoryDeliveryStatus,
  type FactoryFindingSeverity,
  type FactoryPendingAction,
  FactoryReviewedExecution,
  type FactoryRole,
  type FactoryStageName,
} from "@t3tools/contracts/fd/factory";
import {
  WorkErrorReason,
  type WorkItemId,
  type WorkSourceId,
  type WorkSourceKind,
  type WorkStatus,
} from "@t3tools/contracts/fd/work-management";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { Caller } from "../../mcp/threadAccess.ts";
import type { Currency, Demand, Observation } from "./HandoffAdmission.ts";

/** An active Work source of a project, which an idea can be captured in. */
export interface HandoffSource {
  readonly sourceId: WorkSourceId;
  readonly kind: WorkSourceKind;
  readonly label: string;
  /** Where it writes: its directory, repository or project, which one id can move between. */
  readonly identity: string;
  /** Moves with any change to its configuration. */
  readonly version: number;
}

export interface HandoffItemRef {
  readonly sourceId: WorkSourceId;
  readonly itemId: WorkItemId;
}

/** A Work item as a fresh read of its source shows it. */
/** What an item's source says of it now, beside what the assistant and Factory hold. */
export interface HandoffItemSummary {
  readonly ref: HandoffItemRef;
  readonly title: string;
  readonly status: WorkStatus;
  /** The source's own name for the status, where it has one. */
  readonly statusName: string | null;
  /** The human the source assigns it to. */
  readonly assignee: string | null;
}

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

/**
 * The authenticated owner, as the session of their connection says: no MCP caller, which exists only
 * for a live agent thread, is ever made up for them. `current` reads the grants that session holds
 * now, none once it is revoked or expired, for a decision that outlasts the request's own check.
 */
export interface HandoffOwner {
  readonly sessionId: AuthSessionId;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly current: Effect.Effect<ReadonlyArray<AuthEnvironmentScope> | null>;
}

/** Whoever a capture writes for: the assistant's own thread, or the owner themselves. */
export type HandoffActor = Caller | HandoffOwner;

export const isHandoffOwner = (actor: HandoffActor): actor is HandoffOwner => "sessionId" in actor;

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

/**
 * The caller may only read Work: an outside client approved read-only, a thread in plan mode, or an
 * owner's session without the grant.
 */
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
  /**
   * What each item's source says now, for a client to show. It asks each source once and never
   * fails: an item a source cannot answer for in time is left out, so a tracker that is down costs
   * the owner that one fact and not the overview. It writes nothing.
   */
  readonly summaries: (
    refs: ReadonlyArray<HandoffItemRef>,
  ) => Effect.Effect<ReadonlyArray<HandoffItemSummary>>;
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
    actor: HandoffActor,
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
    summaries: () => Effect.succeed([]),
    fingerprint: () => "",
    findByMarker: () => unavailable("find"),
    writer: () => unavailable("writer"),
    create: () => unavailable("create"),
    update: () => unavailable("update"),
  }),
}) {}

/** A reserved automatic turn could not be handed back to its producer; the lease ends it. */
export class HandoffRedeliveryError extends Schema.TaggedError<HandoffRedeliveryError>()(
  "HandoffRedeliveryError",
  {
    kind: Schema.Literals(["delegated_question", "delegated_completion", "background_wake"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The project assistant could not redeliver a reserved ${this.kind}.`;
  }
}

/**
 * How the assistant hands a turn it reserved a slot for back to the producer holding it, without
 * importing core's producers: the bridge feature provides it where the server is composed. A
 * question goes through its reactor, which presents it to the gate again (`moot` once it needs no
 * answer, and the reservation is gone); a completion is offered again on the continuation
 * worker's shared queue; a native wake runs the dispatch the gate kept once the root's authority
 * and a fresh read of its item confirm it (`blocked`, waiting, otherwise), or is `lost` when none
 * is kept here. A pull request wake or usage-limit resume needs nothing: its producer presents it
 * again by itself. `currency` reads whether a reserved question or completion whose lease ran out
 * still needs delivering; a failed read is `unreadable`. The default redelivers nothing, so a
 * reservation waits for its lease, and can read nothing.
 */
export class HandoffRedelivery extends Context.Reference<{
  readonly redeliver: (
    demand: Demand,
  ) => Effect.Effect<
    "dispatched" | "offered" | "deferred" | "blocked" | "moot" | "lost" | "none",
    HandoffRedeliveryError
  >;
  readonly currency: (demand: Demand) => Effect.Effect<Currency>;
}>("t3/fd/assistant/HandoffRedelivery", {
  defaultValue: () => ({
    redeliver: () => Effect.succeed("none"),
    currency: () => Effect.succeed("unreadable"),
  }),
}) {}

/** A Factory delivery as the assistant follows it. */
export interface HandoffDelivery {
  readonly deliveryId: string;
  readonly status: FactoryDeliveryStatus;
}

/**
 * A root delivery as its assignment mirrors it (note 6.8): where it is, what it awaits, its pull
 * request, why it needs its owner and the thread to open, with the same of the child it awaits, and
 * every effect of its family marked as waiting for admission.
 */
export interface HandoffFollow extends HandoffDelivery {
  /** The stage it is in, once it has started one. */
  readonly stage: FactoryStageName | null;
  readonly awaiting: "effect" | "run" | "child" | null;
  readonly pullRequest: {
    readonly url: string;
    readonly outcome: "merged" | "closed" | null;
  } | null;
  /** Why it waits on its owner, at a plan gate or blocked; null otherwise. */
  readonly reason: string | null;
  /** Whether anything of it is under way now, rather than it resting on its owner. */
  readonly proceeding?: boolean;
  /** The thread it awaits, or else its latest author's. */
  readonly threadId: string | null;
  /** The child it awaits. */
  readonly child: {
    readonly deliveryId: string;
    readonly status: FactoryDeliveryStatus;
    readonly stage: FactoryStageName | null;
    readonly reason: string | null;
    readonly threadId: string | null;
  } | null;
  readonly marked: ReadonlyArray<{ readonly deliveryId: string; readonly effectId: number }>;
  /** What the delivery itself waits on its owner for, apart from any request on its threads. */
  readonly ownerActions?: ReadonlyArray<FactoryPendingAction>;
}

/** A request still pending on a thread of a root's family; see `HandoffFactory.requests`. */
export interface HandoffRequest {
  readonly threadId: string;
  readonly requestId: string;
  /** `user_input` for a question; anything else asks for a decision the thread's UI takes. */
  readonly kind: string;
  readonly capability: "live" | "message" | "not_resumable";
  readonly run: {
    readonly status: OrchestrationV2RunStatus;
    readonly class: "factory" | "explicit" | "unknown";
  } | null;
  readonly questions: unknown;
  /** The thread's own project and mode, which its request is explained under. */
  readonly projectId?: ProjectId;
  readonly runtimeMode?: RuntimeMode;
  /** Why the provider says it asks, when it says. */
  readonly reason?: string;
}

/** The requests pending across every root, as one bounded read; `complete` if it read them all. */
export interface HandoffPendingRequests {
  readonly byRoot: ReadonlyMap<string, ReadonlyArray<HandoffRequest>>;
  readonly complete: boolean;
}

/**
 * Factory refused the call, and says why: nothing was written. Refusing a start, it wrote no row
 * under the id, which the assistant still confirms with a read of the id.
 */
export class HandoffFactoryRefused extends Schema.TaggedError<HandoffFactoryRefused>()(
  "HandoffFactoryRefused",
  {
    operation: Schema.Literals(["start", "stop", "cancel", "resume", "rebind"]),
    reason: Schema.Literals([
      "active",
      "not_configured",
      "project_missing",
      "no_base_commit",
      "no_free_branch",
      "unsupported_source",
      "item_unavailable",
      "reviewed_invalid",
      "not_stoppable",
      "not_resumable",
      "pull_request_unknown",
      "ended",
      "not_found",
      "rebind_refused",
      "not_owed",
    ]),
    /** The delivery the item already has, for `active`. */
    activeDeliveryId: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "active":
        return `The Work item already has an active Factory delivery${this.activeDeliveryId === undefined ? "" : ` (${this.activeDeliveryId})`} that this assignment did not start.`;
      case "not_configured":
        return "The project has no Factory verify command. Set one in the project's Factory settings.";
      case "project_missing":
        return "The project is not on this environment.";
      case "no_base_commit":
        return "The project's repository has no commit for a delivery's worktree to start from.";
      case "no_free_branch":
        return "Factory found no free branch name for a new delivery of the item.";
      case "unsupported_source":
        return "Factory plans a parent only from a Markdown Work source.";
      case "item_unavailable":
        return "Work could not serve the item to Factory.";
      case "reviewed_invalid":
        return "the owner's review of this delivery is incomplete or no longer matches its project, so it needs a fresh review";
      case "not_stoppable":
        return "Only a running Factory delivery can stop after its step.";
      case "not_resumable":
        return "Only a stopping, stopped or blocked Factory delivery can resume.";
      case "pull_request_unknown":
        return "This delivery published a pull request that a server restart lost track of, so resuming could open a second one. Cancel it to keep its work.";
      case "ended":
        return "The Factory delivery has already ended.";
      case "not_found":
        return "The Factory delivery does not exist.";
      case "not_owed":
        return "The Factory delivery was already resumed since this review, so it took no second resume.";
      case "rebind_refused":
        return "The Factory delivery moved on or already stood under this review, so it took nothing new. Review it again.";
    }
  }
}

/** The call failed, and whether it did anything is unknown until the delivery is read again. */
export class HandoffFactoryError extends Schema.TaggedError<HandoffFactoryError>()(
  "HandoffFactoryError",
  {
    operation: Schema.Literals([
      "verify",
      "get",
      "follow",
      "start",
      "stop",
      "cancel",
      "resume",
      "activity",
      "deferral",
      "runState",
      "requests",
      "review",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `The assistant could not complete Factory's ${this.operation}.`;
  }
}

const factoryUnavailable = (operation: HandoffFactoryError["operation"]) =>
  Effect.fail(new HandoffFactoryError({ operation }));

/**
 * How the assistant runs its assignments as Factory deliveries without importing Factory: the
 * bridge feature provides it over Factory's service where the server is composed. `start` is
 * idempotent under the id the assistant minted: it stores that id or takes the delivery it already
 * names, and starts it only if it is still queued. `get` is strict: its failure never reads as
 * absent, which only `Option.none` says. The default reaches no Factory, so every call fails and
 * no assignment can be queued for it.
 */
export class HandoffFactory extends Context.Reference<{
  /** Whether the project has the verify command a delivery needs. */
  readonly verifyConfigured: (projectId: ProjectId) => Effect.Effect<boolean, HandoffFactoryError>;
  readonly get: (
    deliveryId: string,
  ) => Effect.Effect<Option.Option<HandoffDelivery>, HandoffFactoryError>;
  readonly start: (input: {
    readonly deliveryId: string;
    readonly item: HandoffItemRef;
    readonly kind: "single" | "parent";
    readonly runtimeModeCeiling: RuntimeMode;
    /** What the owner reviewed, for a delivery of a review receipt; Factory judges it. */
    readonly reviewedExecution?: unknown;
  }) => Effect.Effect<HandoffDelivery, HandoffFactoryRefused | HandoffFactoryError>;
  readonly stop: (
    deliveryId: string,
  ) => Effect.Effect<HandoffDelivery, HandoffFactoryRefused | HandoffFactoryError>;
  /**
   * With `owedBy`, only as the one resume that review's receipt owes this delivery, judged and taken
   * in the step of the resume: `not_owed`, changing nothing, once anyone has taken it.
   */
  readonly resume: (
    deliveryId: string,
    options?: { readonly owedBy?: string },
  ) => Effect.Effect<HandoffDelivery, HandoffFactoryRefused | HandoffFactoryError>;
  readonly cancel: (
    deliveryId: string,
  ) => Effect.Effect<HandoffDelivery, HandoffFactoryRefused | HandoffFactoryError>;
  /** What the root's family is doing, as a release and a retirement judge it. */
  readonly activity: (root: string) => Effect.Effect<Observation, HandoffFactoryError>;
  /** The root as its assignment mirrors it; strict, as `get` is. */
  readonly follow: (
    root: string,
  ) => Effect.Effect<Option.Option<HandoffFollow>, HandoffFactoryError>;
  /** Makes sure an awaited effect waits marked, never running it; see `FactoryService`. */
  readonly ensureDeferred: (
    deliveryId: string,
    effectId: number,
  ) => Effect.Effect<"deferred" | "running" | "stale", HandoffFactoryError>;
  /** Runs a marked effect once, which asks for its admission again before it runs. */
  readonly redispatch: (
    deliveryId: string,
    effectId: number,
  ) => Effect.Effect<"dispatched" | "stale", HandoffFactoryError>;
  /** Where an admitted turn's run is, for the release pass; a failed read is never `ended`. */
  readonly runStateOf: (turn: {
    readonly threadId: string;
    readonly messageId: string;
  }) => Effect.Effect<"live" | "ended" | "none", HandoffFactoryError>;
  /** Every request still pending on the root's family's threads, walking all of them. */
  readonly requests: (
    root: string,
  ) => Effect.Effect<ReadonlyArray<HandoffRequest>, HandoffFactoryError>;
  /**
   * The requests pending across every root, for what only shows them: it starts from the threads
   * holding one, so its cost follows those, not how much work any family has done.
   */
  readonly pendingRequests: Effect.Effect<HandoffPendingRequests, HandoffFactoryError>;
}>("t3/fd/assistant/HandoffFactory", {
  defaultValue: () => ({
    verifyConfigured: () => factoryUnavailable("verify"),
    get: () => factoryUnavailable("get"),
    start: () => factoryUnavailable("start"),
    stop: () => factoryUnavailable("stop"),
    resume: () => factoryUnavailable("resume"),
    cancel: () => factoryUnavailable("cancel"),
    activity: () => factoryUnavailable("activity"),
    follow: () => factoryUnavailable("follow"),
    ensureDeferred: () => factoryUnavailable("deferral"),
    redispatch: () => factoryUnavailable("deferral"),
    runStateOf: () => factoryUnavailable("runState"),
    requests: () => factoryUnavailable("requests"),
    pendingRequests: factoryUnavailable("requests"),
  }),
}) {}

const decodeReviewedExecution = Schema.decodeUnknownEffect(FactoryReviewedExecution);

/** A review as its record kept it, which only decoding proves is still one. */
export const decodeReviewed = (stored: unknown) =>
  decodeReviewedExecution(stored).pipe(
    Effect.mapError((cause) => new HandoffFactoryError({ operation: "review", cause })),
  );

/** A role's settings as an owner reviews them, and whether its provider offers them now. */
export interface HandoffReviewRole {
  readonly selection: ModelSelection;
  readonly offered: boolean;
  readonly options: ReadonlyArray<{
    readonly id: string;
    readonly value: ProviderOptionSelectionValue;
    readonly supported: boolean;
  }>;
}

/**
 * What an owner would review for a delivery of a project, as it stands now. `execution` is what a
 * start would bind, none when `refusal` says why it could not, so the rest can still be shown.
 */
export interface HandoffReviewPreview {
  readonly roles: { readonly [role in FactoryRole]: HandoffReviewRole };
  readonly verifyCommand: FactoryCommand | null;
  readonly setupCommand: FactoryCommand | null;
  readonly limits: {
    readonly maxFixRounds: number;
    readonly maxReviewRounds: number;
    readonly verifyTimeoutMinutes: number;
  };
  readonly blockingSeverities: ReadonlyArray<FactoryFindingSeverity>;
  readonly highRiskEffort: string;
  readonly pipelineId: string;
  readonly execution: FactoryReviewedExecution | null;
  readonly refusal: string | null;
}

/** The delivery of a family a resume would pick, while nothing of it is under way. */
export interface HandoffAtRest {
  readonly deliveryId: string;
  readonly status: "stopped" | "blocked";
  readonly effectsIssued: number;
}

/**
 * How the owner's review reaches Factory without the assistant importing it: the bridge provides it
 * beside `HandoffFactory`. `preview` writes nothing, and a project this environment does not have
 * fails it. `holds` asks whether a review still says what would be bound now, with only reads quick
 * enough for a transaction, so everything but where publication goes. `atRest` names the delivery a
 * resume of the root would pick, while it has nothing under way. `rebind` hands that family a fresh
 * review, keeping what it used, and the named delivery last, which then owes one resume: so that is
 * owed only once all of it stands under the review. It is idempotent under the review's receipt, and
 * refused when the named delivery ran on since or the family moved on before ever taking it.
 * `resumeOwed` says whether that delivery's next resume is still the one its review owes, which only
 * a resume takes up. The default reaches no Factory, so no review can start anything.
 */
export class HandoffReview extends Context.Reference<{
  readonly preview: (input: {
    readonly projectId: ProjectId;
    readonly runtimeCeiling: RuntimeMode;
  }) => Effect.Effect<HandoffReviewPreview, HandoffFactoryError>;
  readonly holds: (input: {
    readonly projectId: ProjectId;
    /** What the review was resolved under, before the project and providers narrowed it. */
    readonly runtimeCeiling: RuntimeMode;
    readonly execution: FactoryReviewedExecution;
  }) => Effect.Effect<boolean>;
  readonly atRest: (root: string) => Effect.Effect<HandoffAtRest | null, HandoffFactoryError>;
  readonly rebind: (input: {
    readonly root: string;
    readonly execution: FactoryReviewedExecution;
    readonly resume: { readonly deliveryId: string; readonly effectsIssued: number };
  }) => Effect.Effect<void, HandoffFactoryRefused | HandoffFactoryError>;
  readonly resumeOwed: (input: {
    readonly deliveryId: string;
    readonly receiptId: string;
  }) => Effect.Effect<boolean, HandoffFactoryError>;
}>("t3/fd/assistant/HandoffReview", {
  defaultValue: () => ({
    preview: () => factoryUnavailable("review"),
    holds: () => Effect.succeed(false),
    atRest: () => factoryUnavailable("review"),
    rebind: () => factoryUnavailable("review"),
    resumeOwed: () => factoryUnavailable("review"),
  }),
}) {}
