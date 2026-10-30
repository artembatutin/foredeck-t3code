import { ProjectId, ProviderInteractionMode, RuntimeMode, ThreadId } from "@t3tools/contracts";
import type { WorkItemId, WorkSourceId, WorkStatus } from "@t3tools/contracts/fd/work-management";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { AutomaticTurn } from "../../orchestration-v2/AutomaticTurnGate.ts";
import { exceededDispatchModeLimit } from "../../orchestration-v2/DispatchModeLimit.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { OCCUPIED_STATES } from "./dispatch.ts";
import * as HandoffMigrations from "./handoffMigrations.ts";
import * as Scheduler from "./handoffScheduler.ts";
import * as PortfolioStore from "./PortfolioStore.ts";
import { type AssignmentState, briefScopeHash, type MirroredState } from "./portfolio.ts";

/**
 * Whether the assistant manages a root delivery: `never` for one it never claimed, then `active`
 * while it admits the family's work, `ending` once the delivery was seen done or cancelled, so no
 * new work of the family is admitted, and `retired` once nothing of it is left counted.
 */
export type Management = "never" | "active" | "ending" | "retired";

/** Whose work an automatic turn carries on, as Factory classified it. */
export type Provenance = "factory" | "unknown";

/** Why a managed root's work may not run now; restoring it unblocks waiting work. */
export type BlockedReason = "revoked" | "scope_changed" | "unreadable" | "item_closed";

/** Why a managed root's work is refused: blocked, or its management has ended. */
export type Refusal = BlockedReason | "ended";

export type RetiredReason = "completed" | "cancelled" | "failed" | "abandoned";

export type DemandKind =
  | "effect"
  | "pull_request_wake"
  | "usage_limit_resume"
  | "delegated_question"
  | "delegated_completion"
  | "background_wake";

export type AdmissionKind = "claim" | "effect" | "automatic_turn" | "delegation";

/** The Work item an admitting decision needs read again, outside any SQL transaction. */
export interface ItemRef {
  readonly sourceId: WorkSourceId;
  readonly itemId: WorkItemId;
}

/**
 * A fresh read of a root's Work item, taken outside SQL just before an admitting decision: what
 * the item says, by Work's scope fingerprint, and its status, or that it could not be read.
 */
export type WorkRead =
  | { readonly type: "read"; readonly fingerprint: string; readonly status: WorkStatus }
  | { readonly type: "unreadable" };

/** One admission row, dispatching until whatever it admitted has been dispatched. */
export interface Admitted {
  readonly admissionId: string;
  readonly root: string;
  readonly assignmentId: string;
  readonly kind: AdmissionKind;
  /** The value its admitting transaction gave the root's slot. */
  readonly entrySeq: number;
}

/** A demand: work of a managed root waiting for a grant of its own. */
export interface Demand {
  readonly id: number;
  readonly seq: number;
  readonly root: string;
  readonly assignmentId: string;
  readonly kind: DemandKind;
  readonly state: "waiting" | "reserved";
  readonly deliveryId: string | null;
  readonly effectId: number | null;
  readonly threadId: string | null;
  readonly wakeKey: string | null;
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
  readonly childThreadId: string | null;
  readonly requestId: string | null;
  readonly parentRunId: string | null;
  readonly generation: number | null;
  readonly messageId: string | null;
  readonly providerThreadId: string | null;
  readonly driver: string | null;
  readonly instanceId: string | null;
  readonly provenance: Provenance | null;
  readonly blockedReason: BlockedReason | null;
  readonly overtaken: number;
}

/** What Factory's activity report says of a root's family, as retirement judges it. */
export interface Observation {
  readonly phase: "proceeding" | "parked" | "terminal" | "missing";
  readonly busy: boolean;
  readonly deferred: boolean;
  readonly unknown: boolean;
}

/** An effect a managed root's delivery is about to run (see `FactoryAdmission.enter`). */
export interface EffectEntry {
  readonly root: string;
  readonly deliveryId: string;
  readonly effectId: number;
  /** Whether admitting it needs a fresh read of the root's Work item. */
  readonly fresh: boolean;
}

export type EffectDecision =
  | { readonly type: "proceed"; readonly admitted?: Admitted }
  | { readonly type: "defer" }
  | { readonly type: "refuse"; readonly category: Refusal }
  | { readonly type: "needs_work"; readonly item: ItemRef };

export type TurnDecision =
  | { readonly type: "admitted"; readonly admitted: Admitted }
  | { readonly type: "demand"; readonly demandId: number }
  | { readonly type: "blocked"; readonly demandId: number; readonly category: BlockedReason }
  /** `clear`: the turn was a native wake whose adapter offer can be dropped. */
  | { readonly type: "declined"; readonly clear: boolean }
  | { readonly type: "needs_work"; readonly item: ItemRef }
  /** This instance is still dispatching an admission of the same turn; nothing more runs. */
  | { readonly type: "in_flight" }
  | { readonly type: "unmanaged" };

export type OpeningDecision =
  | { readonly type: "allow" }
  | { readonly type: "refuse"; readonly category: Refusal }
  | { readonly type: "needs_work"; readonly item: ItemRef };

export type DelegationDecision =
  | { readonly type: "admitted"; readonly admitted: Admitted }
  | { readonly type: "refused"; readonly category: Refusal | "not_holding" }
  | { readonly type: "unmanaged" };

/** A candidate of the fair order: a queued assignment, or a demand waiting for its own grant. */
export type GrantCandidate = Scheduler.Candidate<string> &
  (
    | {
        readonly type: "assignment";
        readonly assignmentId: string;
        /** A Factory assignment's root, for a pending resume; null otherwise. */
        readonly root: string | null;
        readonly factory: boolean;
      }
    | { readonly type: "demand"; readonly demand: Demand }
  );

export type ClaimResult =
  | {
      readonly type: "claimed";
      readonly admitted: Admitted;
      readonly root: string;
      /** A first claim inserted the root; a re-claim took a pending resume's own. */
      readonly first: boolean;
    }
  | { readonly type: "stale" };

export type GrantResult =
  | {
      readonly type: "granted";
      readonly admitted: Admitted;
      readonly deliveryId: string;
      readonly effectId: number;
    }
  /**
   * The root's authority fails: nothing was granted, and the effect is to be redispatched so its
   * delivery asks again, is refused with the category and blocks.
   */
  | {
      readonly type: "refused";
      readonly category: BlockedReason;
      readonly deliveryId: string;
      readonly effectId: number;
    }
  | { readonly type: "stale" };

export type ReserveResult =
  | { readonly type: "reserved"; readonly demand: Demand }
  | { readonly type: "blocked"; readonly category: BlockedReason }
  | { readonly type: "stale" };

/**
 * What a reserved native wake's redelivery did: its kept dispatch was admitted and runs, the
 * dispatch was not kept here so the wake is lost, the reservation is gone, the root's authority
 * or fresh read blocked the demand, or a fresh read of the item is needed to decide.
 */
export type NativeRedelivery =
  | { readonly type: "dispatched" }
  | { readonly type: "lost" }
  | { readonly type: "stale" }
  | { readonly type: "blocked"; readonly category: BlockedReason }
  | { readonly type: "needs_work"; readonly item: ItemRef };

/** A currency read of a reserved question or completion whose lease ran out. */
export type Currency = "current" | "not_current" | "unreadable";

/**
 * A provider-native wake the gate keeps until its demand is granted (see `decideTurn`): its
 * dispatch, which checks its thread and offer are still current itself and reports its own
 * failures, since nothing waits for it.
 */
export interface KeptDispatch {
  readonly dispatch: Effect.Effect<void>;
  /** Clears the adapter's offer; only an offer that can be cleared has it. */
  readonly drop?: Effect.Effect<void>;
}

export class HandoffAdmissionError extends Schema.TaggedError<HandoffAdmissionError>()(
  "HandoffAdmissionError",
  {
    operation: Schema.Literals([
      "management",
      "decide",
      "claim",
      "grant",
      "reserve",
      "release",
      "retire",
      "prestart",
      "maintain",
      "dispatched",
      "read",
    ]),
    root: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.root === undefined
      ? `The project assistant's admission could not ${this.operation}.`
      : `The project assistant's admission could not ${this.operation} for delivery ${this.root}.`;
  }
}

/**
 * Where tests hold the admission path still: `admitted` right after an admitting transaction
 * commits and before what it admitted is dispatched, `released` after a retirement's release pass
 * and `observed` after its quiescent observation, each before the step that follows. The default
 * does nothing.
 */
export class HandoffAdmissionProbe extends Context.Reference<{
  readonly admitted: (admitted: Admitted) => Effect.Effect<void>;
  readonly released: (root: string) => Effect.Effect<void>;
  readonly observed: (root: string) => Effect.Effect<void>;
}>("t3/fd/assistant/HandoffAdmissionProbe", {
  defaultValue: () => ({
    admitted: () => Effect.void,
    released: () => Effect.void,
    observed: () => Effect.void,
  }),
}) {}

/** How long a reserved slot waits for its pull request wake, and for any other demand. */
export const PULL_REQUEST_LEASE_MINUTES = 5;
export const LEASE_MINUTES = 1;
/** How often a root's blocked demands are checked again, unless a resume or retry asks. */
export const BLOCKED_RECHECK_MINUTES = 2;

/**
 * The project assistant's admission of the work of the Factory deliveries it manages, on its own
 * SQL tables, reaching neither Work nor Factory: its callers bring what those say. A managed root
 * family holds at most one slot of the assistant's capacity (`Scheduler.CAPACITY`, shared with
 * ordinary assignments), and every Factory effect, automatic turn and delegation of the family is
 * decided here, in one SQL transaction each on the server's one connection, never under the
 * assistant's lock. Each admission commits with its slot's `entry_seq` moved and a dispatching
 * row, so a release that read the slot before can delete nothing until the dispatch is done; and
 * every transaction that creates ownership requires the root active, so once a retirement has
 * fenced the root, ownership only ever decreases.
 */
export class HandoffAdmission extends Context.Service<
  HandoffAdmission,
  {
    /** This instance's id, which its admission rows, native demands and redeliveries record. */
    readonly instanceId: string;
    /** The root's management, read now; a failed read is never taken as `never`. */
    readonly management: (root: string) => Effect.Effect<Management, HandoffAdmissionError>;
    /**
     * Decides a Factory effect of the root's family (note 6.3). A root never managed proceeds and
     * writes nothing; an ending or retired one refuses `ended`. An active root whose authority
     * fails refuses the effect with its category, a waiting one included, whose demand goes.
     * Otherwise it proceeds holding or reserving its slot, or granted the slot at the free fair
     * head, needing for a `fresh` effect a fresh Work read (`needs_work` asks for one); else the
     * effect waits as the delivery's one effect demand, which keeps its position.
     */
    readonly enter: (
      entry: EffectEntry,
      work?: WorkRead,
    ) => Effect.Effect<EffectDecision, HandoffAdmissionError>;
    /** Whether the delivery's effect waits as a demand, for Factory's boot sweep. */
    readonly deferredDemand: (effect: {
      readonly root: string;
      readonly deliveryId: string;
      readonly effectId: number;
    }) => Effect.Effect<boolean, HandoffAdmissionError>;
    /**
     * Whether a launch of the root's family may send its opening: the root's authority, and the
     * read that opening renders, which for a child is its own item (it must still say what its
     * task froze) while the root's item is read afresh (`needs_work`).
     */
    readonly authorizeOpening: (opening: {
      readonly root: string;
      readonly fingerprint: string;
      readonly status: WorkStatus;
      readonly childScopeMatches?: boolean;
      readonly work?: WorkRead;
    }) => Effect.Effect<OpeningDecision, HandoffAdmissionError>;
    /**
     * Decides an automatic turn Factory classified as the root's own or unknown work (note 6.3).
     * An ending or retired root declines it; the first presentation of each key records one
     * disposition and notice, later ones only read it. An active root whose authority fails
     * blocks it, its waiting demand included, with the category. A native wake's `kept` dispatch is held
     * while its demand waits, for a grant to run later.
     */
    readonly decideTurn: (input: {
      readonly root: string;
      readonly provenance: Provenance;
      readonly turn: AutomaticTurn;
      readonly work?: WorkRead;
      readonly kept?: KeptDispatch;
    }) => Effect.Effect<TurnDecision, HandoffAdmissionError>;
    /**
     * Admits a delegation from a family caller: only for an active root holding its slot, with its
     * authority and the fresh Work read; `not_holding` with no slot or only a reserved one.
     */
    readonly admitDelegation: (input: {
      readonly root: string;
      readonly threadId: string;
      readonly messageId: string;
      readonly work: WorkRead;
    }) => Effect.Effect<DelegationDecision, HandoffAdmissionError>;
    /**
     * Runs `decide`, an admitting operation, and for its admission `dispatch`: the admitted probe,
     * then the dispatch, and that admission marked dispatched once the dispatch returns, however
     * it ends. The whole region from the commit to the mark is uninterruptible, so an admission is
     * never marked dispatched with its dispatch not run. A mark that fails is retried, never the
     * dispatch, before the release pass, a release or a pre-start operation next judges the root.
     */
    readonly dispatchAdmitted: <
      D extends { readonly type: string; readonly admitted?: Admitted | undefined },
      DE,
      A,
      E,
      R,
    >(
      decide: Effect.Effect<D, DE>,
      dispatch: (admitted: Admitted) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<{ readonly decision: D; readonly value: Option.Option<A> }, DE | E, R>;
    /**
     * Marks the admission dispatched, for the release pass to delete later. Only the generation
     * it names (its `entrySeq`) is marked, never a later admission of the same turn.
     */
    readonly markDispatched: (
      admitted: Pick<Admitted, "admissionId" | "entrySeq">,
    ) => Effect.Effect<void, HandoffAdmissionError>;
    /** The free capacity and the fair order's head, as the tick grants. */
    readonly next: Effect.Effect<
      {
        readonly free: number;
        readonly head: GrantCandidate | undefined;
        readonly candidates: ReadonlyArray<GrantCandidate>;
      },
      HandoffAdmissionError
    >;
    /**
     * Claims a queued Factory assignment at the free fair head: a first claim inserts its root
     * under `deliveryId`, the intended id, and links it; a pending resume's re-claim takes its
     * own active root and id again. Either writes a held slot and one dispatching claim
     * admission, and moves the assignment to launching. `stale`, writing nothing, otherwise.
     */
    readonly claim: (input: {
      readonly assignmentId: string;
      readonly deliveryId?: string;
    }) => Effect.Effect<ClaimResult, HandoffAdmissionError>;
    /**
     * Grants a waiting effect demand at the free fair head: a held slot and its admission. A
     * revoked root's effect is `refused` instead, writing nothing.
     */
    readonly grantEffect: (demandId: number) => Effect.Effect<GrantResult, HandoffAdmissionError>;
    /**
     * Reserves the slot for an automatic demand at the free fair head, under a lease, once the
     * fresh `work` read confirms its root; a root that fails it blocks the demand, which keeps its
     * turn. A revoked root's demand is blocked whether or not it is at the head.
     */
    readonly reserve: (
      demandId: number,
      work: WorkRead,
    ) => Effect.Effect<ReserveResult, HandoffAdmissionError>;
    /**
     * Runs a reserved native wake's kept dispatch under a held slot, as an admitting decision: the
     * root's authority is read in its transaction and the item's `work` read is required
     * (`needs_work` asks for one), and either failing blocks the demand, keeping its dispatch.
     * With no dispatch kept here, the demand takes the lost disposition.
     */
    readonly redeliverNative: (
      demandId: number,
      work?: WorkRead,
    ) => Effect.Effect<NativeRedelivery, HandoffAdmissionError>;
    /** A redelivery found the reserved turn no longer needed: it and its slot are deleted. */
    readonly moot: (demandId: number) => Effect.Effect<void, HandoffAdmissionError>;
    /** The demand's work is gone with a restart: the lost disposition, with history and notice. */
    readonly lose: (demandId: number) => Effect.Effect<void, HandoffAdmissionError>;
    /**
     * An instance's first tick: reserved questions and completions another instance last
     * redelivered are stamped as this one's and returned to redeliver; native demands of another
     * instance are lost.
     */
    readonly firstTick: Effect.Effect<ReadonlyArray<Demand>, HandoffAdmissionError>;
    /** Ends every reservation whose lease ran out, per kind (note 6.3). */
    readonly expireLeases: <E>(
      currency: (demand: Demand) => Effect.Effect<Currency, E>,
    ) => Effect.Effect<void, HandoffAdmissionError | E>;
    /**
     * Applies revocation to work already waiting, from the database alone (note 6.2): each
     * waiting demand of an active root whose authority fails is blocked with its category, out
     * of the fair order until a re-check restores it at a fresh position. An effect demand is
     * returned instead of blocked, to be redispatched so its delivery refuses it.
     */
    readonly blockRevoked: Effect.Effect<
      ReadonlyArray<{ readonly demand: Demand; readonly category: BlockedReason }>,
      HandoffAdmissionError
    >;
    /** Roots with blocked demands due for a re-check (every one when `force`). */
    readonly blockedRoots: (options?: {
      readonly force?: boolean;
    }) => Effect.Effect<ReadonlyArray<string>, HandoffAdmissionError>;
    /**
     * Checks the root's blocked demands again with a fresh read: restored, each enters again at a
     * fresh position; otherwise each keeps waiting blocked with the current category.
     */
    readonly recheckBlocked: (input: {
      readonly root: string;
      readonly work: WorkRead;
      readonly force?: boolean;
    }) => Effect.Effect<number, HandoffAdmissionError>;
    /** Every demand of the root, oldest position first. */
    readonly demands: (root: string) => Effect.Effect<ReadonlyArray<Demand>, HandoffAdmissionError>;
    /**
     * The release pass's reading of the root's admissions (note 6.4, steps 1 and 2): the held
     * slot's `entry_seq` first, then each row. A row dispatching from this instance is busy;
     * another instance's counts as dispatched. A dispatched claim, effect or delegation is
     * deleted, since its work is visible as the family's by then; a dispatched automatic turn is
     * deleted once `runState` shows its run ended or never made, is busy while it is live, and
     * unknown when that read fails. A dispatch this instance finished whose mark failed is marked
     * first; a mark failing again fails the pass, which then judges nothing.
     */
    readonly settleAdmissions: <E>(
      root: string,
      runState: (turn: {
        readonly threadId: string;
        readonly messageId: string;
      }) => Effect.Effect<"live" | "ended" | "none", E>,
    ) => Effect.Effect<
      { readonly entrySeq: number | null; readonly busy: boolean; readonly unknown: boolean },
      HandoffAdmissionError
    >;
    /**
     * The release pass's compare-and-delete (note 6.4): the root's held slot goes only while its
     * `entry_seq` is still `entrySeq` and no admission of this instance is dispatching for it.
     */
    readonly release: (
      root: string,
      entrySeq: number,
    ) => Effect.Effect<"released" | "kept", HandoffAdmissionError>;
    /** Fences an active root: active -> ending, so nothing new of its family is admitted. */
    readonly fence: (
      root: string,
      reason: "completed" | "cancelled",
    ) => Effect.Effect<boolean, HandoffAdmissionError>;
    /**
     * Fences the root, then retires it only on a terminal, quiescent observation while it holds no
     * slot and no admission row: its demands become dispositions, its assignment completes or is
     * cancelled, and the root is retired. Never deletes a slot or an admission row.
     */
    readonly retireAttempt: (input: {
      readonly root: string;
      readonly reason: "completed" | "cancelled";
      readonly observation: Observation;
      readonly evidence?: ReadonlyArray<string>;
      readonly note?: string;
    }) => Effect.Effect<"retired" | "contended" | "unobserved", HandoffAdmissionError>;
    /**
     * A retirement's path once the root's delivery is done or cancelled (note 6.9): the release
     * pass, the released probe, a fresh observation, the observed probe when it is quiescent, then
     * `retireAttempt`.
     */
    readonly retire: <E>(input: {
      readonly root: string;
      readonly reason: "completed" | "cancelled";
      readonly release: Effect.Effect<void, E>;
      readonly observe: Effect.Effect<Observation, E>;
      readonly evidence?: ReadonlyArray<string>;
      readonly note?: string;
    }) => Effect.Effect<"retired" | "contended" | "unobserved", HandoffAdmissionError | E>;
    /**
     * Retires a root no delivery row of which can exist. `claim`: compare-and-retire on its
     * dispatched claim and that claim's slot, with no other slot or admission. `parked` (abandoned
     * only): a stopped or queued pre-start root whose cancel is persisted, holding no slot,
     * admission or demand; it creates and deletes no ownership.
     */
    readonly retirePreDelivery: (input: {
      readonly root: string;
      readonly reason: "failed" | "abandoned";
      readonly shape:
        | {
            readonly type: "claim";
            readonly admissionId: string;
            readonly entrySeq: number;
          }
        | { readonly type: "parked" };
      readonly note?: string;
    }) => Effect.Effect<"retired" | "contended", HandoffAdmissionError>;
    /**
     * Parks a root stopped before its first start: deletes exactly its dispatched claim and that
     * claim's slot and shows the assignment stopped, keeping the root active, its link, its stop
     * and its queue position. `contended`, writing nothing, otherwise.
     */
    readonly parkPreStart: (input: {
      readonly root: string;
      readonly admissionId: string;
      readonly entrySeq: number;
    }) => Effect.Effect<"parked" | "contended", HandoffAdmissionError>;
    /**
     * Resumes a parked root into the queue: stopped -> queued at a fresh position, its stop
     * cleared, creating no ownership; only a fair grant re-claims it.
     */
    readonly resumeReentry: (input: {
      readonly root: string;
      readonly work: WorkRead;
    }) => Effect.Effect<
      | { readonly type: "queued" }
      | { readonly type: "refused"; readonly category: BlockedReason }
      | { readonly type: "contended" },
      HandoffAdmissionError
    >;
    /** Drops a fenced root's reservation by compare-and-delete; a converted slot is kept. */
    readonly dropFencedReservation: (input: {
      readonly root: string;
      readonly demandId: number;
    }) => Effect.Effect<"dropped" | "kept", HandoffAdmissionError>;
    /** Drops kept native dispatches whose demand is gone, clearing offers that can be cleared. */
    readonly pruneKept: Effect.Effect<void, HandoffAdmissionError>;
  }
>()("t3/fd/assistant/HandoffAdmission") {}

interface RootRow {
  readonly root_delivery_id: string;
  readonly assignment_id: string;
  readonly attempt: number;
  readonly state: "active" | "ending" | "retired";
  readonly reason: RetiredReason | null;
}

interface LinkRow {
  readonly assignment_id: string;
  readonly capture_id: string;
  readonly source_id: string;
  readonly item_id: string;
  readonly scope_hash: string;
  readonly item_fingerprint: string;
  readonly runtime_mode: string;
  readonly delivery_id: string | null;
  readonly control: "none" | "stop" | "cancel";
}

interface SlotRow {
  readonly root_delivery_id: string;
  readonly assignment_id: string;
  readonly state: "held" | "reserved";
  readonly entry_seq: number;
  readonly reserved_demand_id: number | null;
  readonly lease_until: string | null;
  readonly redelivered_by: string | null;
}

interface DemandRow {
  readonly id: number;
  readonly seq: number;
  readonly root_delivery_id: string;
  readonly assignment_id: string;
  readonly delivery_id: string | null;
  readonly kind: DemandKind;
  readonly state: "waiting" | "reserved";
  readonly effect_id: number | null;
  readonly thread_id: string | null;
  readonly wake_key: string | null;
  readonly pr_number: number | null;
  readonly pr_url: string | null;
  readonly child_thread_id: string | null;
  readonly request_id: string | null;
  readonly parent_run_id: string | null;
  readonly generation: number | null;
  readonly message_id: string | null;
  readonly provider_thread_id: string | null;
  readonly driver: string | null;
  readonly instance_id: string | null;
  readonly provenance: Provenance | null;
  readonly blocked_reason: BlockedReason | null;
  readonly blocked_checked_at: string | null;
  readonly overtaken: number;
}

interface AdmissionRow {
  readonly admission_id: string;
  readonly kind: AdmissionKind;
  readonly instance_id: string;
  readonly state: "dispatching" | "dispatched";
  readonly entry_seq: number;
}

const demandOf = (row: DemandRow): Demand => ({
  id: row.id,
  seq: row.seq,
  root: row.root_delivery_id,
  assignmentId: row.assignment_id,
  kind: row.kind,
  state: row.state,
  deliveryId: row.delivery_id,
  effectId: row.effect_id,
  threadId: row.thread_id,
  wakeKey: row.wake_key,
  pullRequest:
    row.pr_number === null || row.pr_url === null
      ? null
      : { number: row.pr_number, url: row.pr_url },
  childThreadId: row.child_thread_id,
  requestId: row.request_id,
  parentRunId: row.parent_run_id,
  generation: row.generation,
  messageId: row.message_id,
  providerThreadId: row.provider_thread_id,
  driver: row.driver,
  instanceId: row.instance_id,
  provenance: row.provenance,
  blockedReason: row.blocked_reason,
  overtaken: row.overtaken,
});

/** The demand key each kind derives from its identity, as its table's CHECKs require. */
const wakeKeyOf = (turn: Exclude<AutomaticTurn, { readonly kind: "restart_continuation" }>) => {
  switch (turn.kind) {
    case "pull_request_wake":
      return turn.pullRequest.url;
    case "usage_limit_resume":
      return turn.key;
    case "delegated_question":
      return `${turn.childThreadId}:${turn.requestId}`;
    case "delegated_completion":
      return `${turn.parentRunId}:${turn.generation}:${turn.messageId}`;
    case "background_wake":
      return turn.messageId;
  }
};

type WakeKind = Exclude<DemandKind, "effect">;

/** A late arrival's notice, naming the thread the owner should open. */
const endedNotice = (kind: WakeKind, thread: string) => {
  switch (kind) {
    case "pull_request_wake":
      return `Pull request feedback on ${thread} arrived after this assignment ended, and nothing acted on it. Review the pull request yourself, or retry the assignment for a new delivery.`;
    case "usage_limit_resume":
      return `${thread} hit a usage limit after this assignment ended, and was not resumed automatically. Continue it from the thread if you want.`;
    case "delegated_question":
      return `A delegated agent on ${thread} is waiting for an answer after this assignment ended. Answer it in that thread or stop it there.`;
    case "delegated_completion":
      return `Delegated work on ${thread} finished after this assignment ended, and its result was not sent to the agent. Open the thread to read it.`;
    case "background_wake":
      return `Background work on ${thread} finished after this assignment ended and was not continued. Open the thread and ask the agent to check it.`;
  }
};

const lostNotice = (thread: string) =>
  `Background work on ${thread} finished while it waited for a project assistant slot, and the server restarted before it could continue. Its provider output is gone; open the thread and ask the agent to check that work.`;

export const parkedNotice = (root: string) =>
  `Stopped before Factory started delivery ${root}. Nothing runs and no project assistant slot is held. Resume waits for a slot and starts this same delivery; cancel ends it.`;

export const pendingResumeNotice = (root: string) =>
  `Resumed. Factory delivery ${root} starts once it gets a project assistant slot.`;

/**
 * Where a demand's or turn's disposition is kept, and the thread its notice names. A declined
 * native wake is kept per provider thread, so a provider thread gets one notice.
 */
const dispositionOf = (
  identity: {
    readonly kind: WakeKind;
    readonly threadId: string;
    readonly wakeKey: string;
    readonly childThreadId: string | null;
    readonly providerThreadId: string | null;
  },
  outcome: "declined_ended" | "lost_on_restart",
) => ({
  wakeKey:
    identity.kind === "background_wake" && outcome === "declined_ended"
      ? `${identity.threadId}:${identity.providerThreadId}`
      : identity.wakeKey,
  threadId:
    identity.kind === "delegated_question" && identity.childThreadId !== null
      ? identity.childThreadId
      : identity.threadId,
});

const TERMINAL_ASSIGNMENT: ReadonlySet<string> = new Set(["completed", "cancelled"]);
const isRuntimeMode = Schema.is(RuntimeMode);
const isInteractionMode = Schema.is(ProviderInteractionMode);

/** Why `work` does not confirm what the root was authorized for, if it does not. */
const freshness = (link: LinkRow, work: WorkRead): BlockedReason | undefined => {
  if (work.type === "unreadable") return "unreadable";
  if (work.fingerprint !== link.item_fingerprint) return "scope_changed";
  if (work.status === "done" || work.status === "cancelled") return "item_closed";
  return undefined;
};

/** Whether a decision stopped short to ask for a fresh read of the root's Work item. */
export const needsWork = (decision: {
  readonly type: string;
}): decision is { readonly type: "needs_work"; readonly item: ItemRef } =>
  decision.type === "needs_work" && "item" in decision;

const itemOf = (link: LinkRow): ItemRef => ({
  sourceId: link.source_id as WorkSourceId,
  itemId: link.item_id as WorkItemId,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const portfolio = yield* PortfolioStore.PortfolioStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const probe = yield* HandoffAdmissionProbe;
  const scope = yield* Effect.scope;
  const instanceId = yield* randomUuidV4;
  /** Native wakes kept for their demands' grants; `pending` until the demand commits. */
  const kept = new Map<
    string,
    KeptDispatch & { readonly root: string; readonly threadId: string; pending: boolean }
  >();
  /**
   * Admissions whose dispatch returned but whose dispatched mark failed, by generation. Their
   * rows still read as this instance's dispatches, so each is marked again before ownership is
   * next judged; the dispatch itself never runs again.
   */
  const unmarked = new Map<string, Admitted>();
  const generationOf = (admitted: Pick<Admitted, "admissionId" | "entrySeq">) =>
    `${admitted.admissionId}:${admitted.entrySeq}`;

  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const minutesFromNow = (minutes: number) =>
    Effect.map(DateTime.now, (at) => DateTime.formatIso(DateTime.add(at, { minutes })));

  const failed =
    (operation: HandoffAdmissionError["operation"], root?: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new HandoffAdmissionError({
              operation,
              cause,
              ...(root === undefined ? {} : { root }),
            }),
        ),
      );
  const transact =
    (operation: HandoffAdmissionError["operation"], root?: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      sql.withTransaction(effect).pipe(failed(operation, root));

  const readRoot = (root: string) =>
    Effect.map(
      sql<RootRow>`SELECT root_delivery_id, assignment_id, attempt, state, reason
        FROM fd_assistant_managed_roots WHERE root_delivery_id = ${root}`,
      (rows) => rows[0],
    );
  const readLink = (assignmentId: string) =>
    Effect.map(
      sql<LinkRow>`SELECT assignment_id, capture_id, source_id, item_id, scope_hash,
          item_fingerprint, runtime_mode, delivery_id, control
        FROM fd_assistant_factory_links WHERE assignment_id = ${assignmentId}`,
      (rows) => rows[0],
    );
  const readSlot = (root: string) =>
    Effect.map(
      sql<SlotRow>`SELECT root_delivery_id, assignment_id, state, entry_seq, reserved_demand_id,
          lease_until, redelivered_by
        FROM fd_assistant_slots WHERE root_delivery_id = ${root}`,
      (rows) => rows[0],
    );
  const readDemand = (id: number) =>
    Effect.map(
      sql<DemandRow>`SELECT * FROM fd_assistant_admission_demands WHERE id = ${id}`,
      (rows) => rows[0],
    );
  const demandByKey = (root: string, kind: WakeKind, key: string) =>
    Effect.map(
      sql<DemandRow>`SELECT * FROM fd_assistant_admission_demands
        WHERE root_delivery_id = ${root} AND kind = ${kind} AND wake_key = ${key}`,
      (rows) => rows[0],
    );
  const effectDemand = (root: string, deliveryId: string) =>
    Effect.map(
      sql<DemandRow>`SELECT * FROM fd_assistant_admission_demands
        WHERE root_delivery_id = ${root} AND kind = 'effect' AND delivery_id = ${deliveryId}`,
      (rows) => rows[0],
    );
  const admissionsOf = (root: string) =>
    sql<AdmissionRow>`SELECT admission_id, kind, instance_id, state, entry_seq
      FROM fd_assistant_admissions WHERE root_delivery_id = ${root}`;
  /**
   * Whether this instance still dispatches an admission of the turn. Another one would take over
   * its row, and the earlier dispatch's end could then settle the later admission. A dispatch
   * that returned and only awaits its mark is not in flight.
   */
  const turnInFlight = (threadId: string, messageId: string) =>
    Effect.map(
      sql<{ readonly admission_id: string; readonly entry_seq: number }>`
        SELECT admission_id, entry_seq FROM fd_assistant_admissions
        WHERE kind = 'automatic_turn' AND thread_id = ${threadId} AND message_id = ${messageId}
          AND state = 'dispatching' AND instance_id = ${instanceId}`,
      (rows) =>
        rows.some(
          (row) =>
            !unmarked.has(generationOf({ admissionId: row.admission_id, entrySeq: row.entry_seq })),
        ),
    );
  const demandCount = (root: string) =>
    Effect.map(
      sql<{ readonly count: number }>`SELECT COUNT(*) AS count
        FROM fd_assistant_admission_demands WHERE root_delivery_id = ${root}`,
      (rows) => rows[0]?.count ?? 0,
    );

  /** A fresh position from the one counter every position and slot entry is taken from. */
  const freshSeq = Effect.gen(function* () {
    const [row] = yield* sql<{ readonly next_seq: number }>`
      SELECT next_seq FROM fd_assistant_scheduler WHERE id = 1`;
    const seq = row?.next_seq ?? 1;
    yield* sql`UPDATE fd_assistant_scheduler SET next_seq = ${seq + 1} WHERE id = 1`;
    return seq;
  });

  const history = (entry: {
    readonly assignmentId: string;
    readonly root: string | null;
    readonly kind: string;
    readonly seq: number | null;
    readonly outcome:
      | "granted"
      | "expired"
      | "stale"
      | "released"
      | "declined"
      | "unused"
      | "moot"
      | "blocked"
      | "unblocked"
      | "lost_on_restart"
      | "retired";
  }) =>
    Effect.flatMap(
      now,
      (at) => sql`INSERT INTO fd_assistant_grant_history
        (assignment_id, root_delivery_id, kind, candidate_seq, outcome, at)
        VALUES (${entry.assignmentId}, ${entry.root}, ${entry.kind}, ${entry.seq},
          ${entry.outcome}, ${at})`,
    );

  const notice = (assignmentId: string, note: string) =>
    portfolio.transitionAssignment({ assignmentId, event: { type: "record-notice", note } });

  const mirror = (
    assignmentId: string,
    to: MirroredState,
    note: string,
    evidence?: ReadonlyArray<string>,
  ) =>
    portfolio.transitionAssignment({
      assignmentId,
      event: { type: "mirror", to, note, ...(evidence === undefined ? {} : { evidence }) },
    });

  const assignmentState = (assignmentId: string) =>
    Effect.map(
      sql<{ readonly state: AssignmentState; readonly attempt: number }>`
        SELECT state, attempt FROM fd_assistant_assignments WHERE assignment_id = ${assignmentId}`,
      (rows) => rows[0],
    );

  /**
   * The root's authority as the database holds it (note 6.2, A), memoized for one decision:
   * undefined when it holds, otherwise `revoked`. The capture's item, the brief's scope, the
   * manager's thread and permissions and the project are read as they stand now.
   */
  const makeAuthority = () => {
    const results = new Map<string, BlockedReason | undefined>();
    const compute = (link: LinkRow) =>
      Effect.gen(function* () {
        if (link.control === "cancel") return "revoked" as const;
        const [assignment] = yield* sql<{
          readonly project_id: string;
          readonly idea_id: string;
          readonly state: string;
        }>`SELECT project_id, idea_id, state FROM fd_assistant_assignments
          WHERE assignment_id = ${link.assignment_id}`;
        if (assignment === undefined || TERMINAL_ASSIGNMENT.has(assignment.state)) {
          return "revoked" as const;
        }
        const projectId = ProjectId.make(assignment.project_id);
        const brief = yield* portfolio.getBrief(projectId, assignment.idea_id);
        if (
          Option.isNone(brief) ||
          !brief.value.executionAuthorized ||
          briefScopeHash(brief.value) !== link.scope_hash
        ) {
          return "revoked" as const;
        }
        const [capture] = yield* sql<{
          readonly state: string;
          readonly capture_id: string;
          readonly item_fingerprint: string | null;
        }>`SELECT state, capture_id, item_fingerprint FROM fd_assistant_work_captures
          WHERE project_id = ${assignment.project_id} AND idea_id = ${assignment.idea_id}`;
        if (
          capture?.state !== "captured" ||
          capture.capture_id !== link.capture_id ||
          capture.item_fingerprint !== link.item_fingerprint
        ) {
          return "revoked" as const;
        }
        const [dispatch] = yield* sql<{
          readonly manager: string | null;
          readonly interaction: string | null;
        }>`SELECT json_extract(payload_json, '$.managerThreadId') AS manager,
            json_extract(payload_json, '$.interactionMode') AS interaction
          FROM fd_assistant_dispatches WHERE assignment_id = ${link.assignment_id}`;
        const runtimeMode = link.runtime_mode;
        const interactionMode = dispatch?.interaction ?? null;
        if (
          dispatch?.manager === null ||
          dispatch?.manager === undefined ||
          !isRuntimeMode(runtimeMode) ||
          !isInteractionMode(interactionMode)
        ) {
          return "revoked" as const;
        }
        const manager = yield* projections.getThreadShell(ThreadId.make(dispatch.manager));
        if (
          manager === null ||
          manager.archivedAt !== null ||
          exceededDispatchModeLimit(manager, { runtimeMode, interactionMode }) !== undefined
        ) {
          return "revoked" as const;
        }
        const project = yield* projects.get(projectId, { includeDeleted: true });
        if (
          Option.isNone(project) ||
          project.value.deletedAt !== null ||
          (project.value.repositories?.length ?? 0) > 1
        ) {
          return "revoked" as const;
        }
        return undefined;
      });
    return (link: LinkRow) =>
      Effect.suspend(() =>
        results.has(link.assignment_id)
          ? Effect.succeed(results.get(link.assignment_id))
          : Effect.tap(compute(link), (result) =>
              Effect.sync(() => results.set(link.assignment_id, result)),
            ),
      );
  };
  type Authority = ReturnType<typeof makeAuthority>;

  /** Every assignment of a legacy executor in an occupied state, plus every slot row. */
  const occupied = Effect.map(
    sql<{ readonly occupied: number }>`SELECT
      (SELECT COUNT(*) FROM fd_assistant_assignments a
        WHERE a.state IN ${sql.in([...OCCUPIED_STATES])}
          AND NOT EXISTS (
            SELECT 1 FROM fd_assistant_factory_links l WHERE l.assignment_id = a.assignment_id
          ))
      + (SELECT COUNT(*) FROM fd_assistant_slots) AS occupied`,
    (rows) => rows[0]?.occupied ?? 0,
  );

  /** The fair order's candidates: queued assignments with a position, and waiting demands. */
  const readCandidates = (authority: Authority) =>
    Effect.gen(function* () {
      const briefs = yield* portfolio.listBriefs();
      const briefOf = (projectId: string, ideaId: string) =>
        briefs.find(
          (brief) => brief.projectId === projectId && (brief.ideaId ?? "legacy") === ideaId,
        );
      const candidates: Array<GrantCandidate> = [];
      const queued = yield* sql<{
        readonly assignment_id: string;
        readonly project_id: string;
        readonly idea_id: string;
        readonly seq: number;
        readonly overtaken: number;
        readonly linked: number;
        readonly delivery_id: string | null;
        readonly root_state: string | null;
        readonly slots: number;
      }>`SELECT a.assignment_id, a.project_id, a.idea_id, p.seq, p.overtaken,
          l.assignment_id IS NOT NULL AS linked, l.delivery_id, r.state AS root_state,
          (SELECT COUNT(*) FROM fd_assistant_slots s
            WHERE s.assignment_id = a.assignment_id) AS slots
        FROM fd_assistant_queue_positions p
        JOIN fd_assistant_assignments a ON a.assignment_id = p.assignment_id
        LEFT JOIN fd_assistant_factory_links l ON l.assignment_id = a.assignment_id
        LEFT JOIN fd_assistant_managed_roots r ON r.root_delivery_id = l.delivery_id
        WHERE a.state = 'queued'`;
      for (const row of queued) {
        const brief = briefOf(row.project_id, row.idea_id);
        const link = row.linked === 1 ? yield* readLink(row.assignment_id) : undefined;
        const eligible =
          link === undefined
            ? brief?.executionAuthorized === true
            : link.control === "none" &&
              (link.delivery_id === null || (row.root_state === "active" && row.slots === 0)) &&
              (yield* authority(link)) === undefined;
        candidates.push({
          type: "assignment",
          id: `assignment:${row.assignment_id}`,
          seq: row.seq,
          overtaken: row.overtaken,
          priority: brief?.priority?.rank ?? null,
          eligible,
          assignmentId: row.assignment_id,
          root: link?.delivery_id ?? null,
          factory: link !== undefined,
        });
      }
      const waiting = yield* sql<
        DemandRow & {
          readonly root_state: string;
          readonly project_id: string;
          readonly idea_id: string;
          readonly slots: number;
        }
      >`SELECT d.*, r.state AS root_state, a.project_id, a.idea_id,
          (SELECT COUNT(*) FROM fd_assistant_slots s
            WHERE s.root_delivery_id = d.root_delivery_id) AS slots
        FROM fd_assistant_admission_demands d
        JOIN fd_assistant_managed_roots r ON r.root_delivery_id = d.root_delivery_id
        JOIN fd_assistant_assignments a ON a.assignment_id = d.assignment_id
        WHERE d.state = 'waiting'`;
      for (const row of waiting) {
        const link = yield* readLink(row.assignment_id);
        // A family holds one slot at most: its demands wait for their own grant until it is
        // released, without holding up the grants others can take.
        const eligible =
          row.blocked_reason === null &&
          row.root_state === "active" &&
          row.slots === 0 &&
          link !== undefined &&
          (yield* authority(link)) === undefined;
        candidates.push({
          type: "demand",
          id: `demand:${row.id}`,
          seq: row.seq,
          overtaken: row.overtaken,
          priority: briefOf(row.project_id, row.idea_id)?.priority?.rank ?? null,
          eligible,
          demand: demandOf(row),
        });
      }
      return candidates;
    });

  /**
   * Whether a grant may go to `own` now: capacity is free, and `own` is the fair order's head, or,
   * for work with no demand yet, nobody eligible waits.
   */
  const freeAndHead = (authority: Authority, own: string | undefined) =>
    Effect.gen(function* () {
      if ((yield* occupied) >= Scheduler.CAPACITY) return { ok: false, candidates: [] } as const;
      const candidates = yield* readCandidates(authority);
      const first = Scheduler.head(candidates);
      return { ok: own === undefined ? first === undefined : first?.id === own, candidates };
    });

  /**
   * A grant's bookkeeping: each eligible candidate waiting since before the granted one is passed
   * over once more, the grant is counted, and its history appended.
   */
  const recordGrant = (
    candidates: ReadonlyArray<GrantCandidate>,
    granted: { readonly id: string | undefined; readonly assignmentId: string },
    entry: { readonly root: string; readonly kind: string; readonly seq: number | null },
  ) =>
    Effect.gen(function* () {
      if (granted.id !== undefined) {
        const { overtaken } = Scheduler.grant(candidates, granted.id);
        for (const candidate of overtaken) {
          if (candidate.type === "assignment") {
            yield* sql`UPDATE fd_assistant_queue_positions SET overtaken = ${candidate.overtaken}
              WHERE assignment_id = ${candidate.assignmentId}`;
          } else {
            yield* sql`UPDATE fd_assistant_admission_demands SET overtaken = ${candidate.overtaken}
              WHERE id = ${candidate.demand.id}`;
          }
        }
      }
      yield* sql`UPDATE fd_assistant_scheduler SET grants = grants + 1 WHERE id = 1`;
      yield* history({
        assignmentId: granted.assignmentId,
        root: entry.root,
        kind: entry.kind,
        seq: entry.seq,
        outcome: "granted",
      });
    });

  const insertSlot = (root: RootRow, entrySeq: number) =>
    Effect.flatMap(
      now,
      (at) => sql`INSERT INTO fd_assistant_slots
        (root_delivery_id, assignment_id, state, entry_seq, granted_at)
        VALUES (${root.root_delivery_id}, ${root.assignment_id}, 'held', ${entrySeq}, ${at})`,
    );

  /** Moves the root's slot's `entry_seq` on, making it held: one admission's commit. */
  const holdSlot = (root: string, entrySeq: number) =>
    sql`UPDATE fd_assistant_slots
      SET state = 'held', reserved_demand_id = NULL, lease_until = NULL, redelivered_by = NULL,
        entry_seq = ${entrySeq}
      WHERE root_delivery_id = ${root}`;

  /** Puts a demand back in the waiting set at a fresh position. */
  const reenter = (demand: DemandRow, outcome: "unused" | "expired" | "unblocked") =>
    Effect.gen(function* () {
      const seq = yield* freshSeq;
      yield* sql`UPDATE fd_assistant_admission_demands
        SET state = 'waiting', seq = ${seq}, overtaken = 0, blocked_reason = NULL,
          blocked_checked_at = NULL
        WHERE id = ${demand.id}`;
      yield* history({
        assignmentId: demand.assignment_id,
        root: demand.root_delivery_id,
        kind: demand.kind,
        seq,
        outcome,
      });
    });

  /**
   * Turns the root's slot, reserved for another demand, into a held one for an admission landing
   * in it; the reserved demand enters the waiting set again.
   */
  const convertReservation = (slot: SlotRow, entrySeq: number) =>
    Effect.gen(function* () {
      yield* holdSlot(slot.root_delivery_id, entrySeq);
      if (slot.reserved_demand_id === null) return;
      const reserved = yield* readDemand(slot.reserved_demand_id);
      if (reserved !== undefined) yield* reenter(reserved, "unused");
    });

  const insertAdmission = (
    root: RootRow,
    entry: {
      readonly kind: AdmissionKind;
      readonly entrySeq: number;
      readonly deliveryId?: string;
      readonly effectId?: number;
      readonly threadId?: string;
      readonly messageId?: string;
    },
  ) =>
    Effect.gen(function* () {
      const at = yield* now;
      const id = yield* randomUuidV4;
      // A turn presented again under its message keeps its one row, dispatching once more.
      yield* sql`INSERT INTO fd_assistant_admissions (
          admission_id, root_delivery_id, assignment_id, kind, delivery_id, effect_id, thread_id,
          message_id, instance_id, state, entry_seq, created_at, updated_at
        ) VALUES (
          ${id}, ${root.root_delivery_id}, ${root.assignment_id}, ${entry.kind},
          ${entry.deliveryId ?? null}, ${entry.effectId ?? null}, ${entry.threadId ?? null},
          ${entry.messageId ?? null}, ${instanceId}, 'dispatching', ${entry.entrySeq}, ${at}, ${at}
        )
        ON CONFLICT (kind, thread_id, message_id) WHERE kind IN ('automatic_turn', 'delegation')
        DO UPDATE SET state = 'dispatching', instance_id = excluded.instance_id,
          entry_seq = excluded.entry_seq, updated_at = excluded.updated_at`;
      const [row] =
        entry.threadId === undefined
          ? [{ admission_id: id }]
          : yield* sql<{ readonly admission_id: string }>`SELECT admission_id
              FROM fd_assistant_admissions
              WHERE kind = ${entry.kind} AND thread_id = ${entry.threadId}
                AND message_id = ${entry.messageId ?? null}`;
      return {
        admissionId: row?.admission_id ?? id,
        root: root.root_delivery_id,
        assignmentId: root.assignment_id,
        kind: entry.kind,
        entrySeq: entry.entrySeq,
      } satisfies Admitted;
    });

  const insertDemand = (
    root: RootRow,
    demand:
      | { readonly kind: "effect"; readonly deliveryId: string; readonly effectId: number }
      | {
          readonly kind: "turn";
          readonly turn: Exclude<AutomaticTurn, { readonly kind: "restart_continuation" }>;
          readonly provenance: Provenance;
          readonly blocked?: BlockedReason;
        },
  ) =>
    Effect.gen(function* () {
      const seq = yield* freshSeq;
      const at = yield* now;
      const turn = demand.kind === "turn" ? demand.turn : undefined;
      const columns = {
        seq,
        root_delivery_id: root.root_delivery_id,
        assignment_id: root.assignment_id,
        delivery_id: demand.kind === "effect" ? demand.deliveryId : null,
        kind: turn?.kind ?? "effect",
        state: "waiting",
        effect_id: demand.kind === "effect" ? demand.effectId : null,
        thread_id: turn?.threadId ?? null,
        wake_key: turn === undefined ? null : wakeKeyOf(turn),
        pr_number: turn?.kind === "pull_request_wake" ? turn.pullRequest.number : null,
        pr_url: turn?.kind === "pull_request_wake" ? turn.pullRequest.url : null,
        child_thread_id: turn?.kind === "delegated_question" ? turn.childThreadId : null,
        request_id: turn?.kind === "delegated_question" ? turn.requestId : null,
        parent_run_id: turn?.kind === "delegated_completion" ? turn.parentRunId : null,
        generation: turn?.kind === "delegated_completion" ? turn.generation : null,
        message_id:
          turn?.kind === "delegated_completion" || turn?.kind === "background_wake"
            ? turn.messageId
            : null,
        provider_thread_id:
          turn?.kind === "delegated_completion" || turn?.kind === "background_wake"
            ? turn.providerThreadId
            : null,
        driver:
          turn?.kind === "delegated_completion" || turn?.kind === "background_wake"
            ? turn.driver
            : null,
        instance_id: turn?.kind === "background_wake" ? instanceId : null,
        delivery: turn?.kind === "delegated_completion" ? "message_text" : null,
        notification_json: null,
        provenance: demand.kind === "turn" ? demand.provenance : null,
        blocked_reason: demand.kind === "turn" ? (demand.blocked ?? null) : null,
        blocked_checked_at: demand.kind === "turn" && demand.blocked !== undefined ? at : null,
        overtaken: 0,
        requested_at: at,
      };
      yield* sql`INSERT INTO fd_assistant_admission_demands ${sql.insert(columns)}`;
      const [row] = yield* sql<{ readonly id: number }>`SELECT id
        FROM fd_assistant_admission_demands WHERE seq = ${seq}`;
      return row?.id ?? 0;
    });

  /** Marks a demand blocked with `category`, ending its reservation if it held one. */
  const blockDemand = (demand: DemandRow, category: BlockedReason) =>
    Effect.gen(function* () {
      if (demand.state === "reserved") {
        yield* sql`DELETE FROM fd_assistant_slots
          WHERE root_delivery_id = ${demand.root_delivery_id}
            AND reserved_demand_id = ${demand.id}`;
      }
      yield* sql`UPDATE fd_assistant_admission_demands
        SET state = 'waiting', blocked_reason = ${category}, blocked_checked_at = ${yield* now}
        WHERE id = ${demand.id}`;
      yield* history({
        assignmentId: demand.assignment_id,
        root: demand.root_delivery_id,
        kind: demand.kind,
        seq: demand.seq,
        outcome: "blocked",
      });
    });

  const deleteDemand = (id: number) =>
    sql`DELETE FROM fd_assistant_admission_demands WHERE id = ${id}`;

  /**
   * Records the disposition of a declined or lost turn if its key has none, with one notice;
   * returns whether it was new.
   */
  const dispose = (
    root: RootRow,
    identity: {
      readonly kind: WakeKind;
      readonly threadId: string;
      readonly wakeKey: string;
      readonly childThreadId: string | null;
      readonly providerThreadId: string | null;
      readonly provenance: Provenance;
      readonly clearable: boolean;
    },
    outcome: "declined_ended" | "lost_on_restart",
  ) =>
    Effect.gen(function* () {
      const { wakeKey, threadId } = dispositionOf(identity, outcome);
      const [existing] = yield* sql<{ readonly found: number }>`SELECT 1 AS found
        FROM fd_assistant_dispositions
        WHERE root_delivery_id = ${root.root_delivery_id} AND kind = ${identity.kind}
          AND wake_key = ${wakeKey}`;
      if (existing !== undefined) return false;
      yield* sql`INSERT INTO fd_assistant_dispositions ${sql.insert({
        root_delivery_id: root.root_delivery_id,
        kind: identity.kind,
        wake_key: wakeKey,
        assignment_id: root.assignment_id,
        thread_id: threadId,
        class: identity.provenance,
        outcome,
        adapter_clear:
          identity.kind !== "background_wake"
            ? null
            : outcome === "declined_ended" && identity.clearable
              ? "requested"
              : "unavailable",
        recorded_at: yield* now,
      })}`;
      yield* notice(
        root.assignment_id,
        outcome === "lost_on_restart" ? lostNotice(threadId) : endedNotice(identity.kind, threadId),
      );
      return true;
    });

  const identityOfDemand = (demand: DemandRow) => ({
    kind: demand.kind as WakeKind,
    threadId: demand.thread_id ?? "",
    wakeKey: demand.wake_key ?? "",
    childThreadId: demand.child_thread_id,
    providerThreadId: demand.provider_thread_id,
    provenance: demand.provenance ?? "unknown",
    clearable: demand.message_id !== null && kept.get(demand.message_id)?.drop !== undefined,
  });

  /**
   * Disposes of every demand of a root whose management ends: effect demands are deleted, every
   * other becomes its declined disposition with one notice per key.
   */
  const disposeDemands = (root: RootRow) =>
    Effect.gen(function* () {
      const demands = yield* sql<DemandRow>`SELECT * FROM fd_assistant_admission_demands
        WHERE root_delivery_id = ${root.root_delivery_id} ORDER BY seq`;
      for (const demand of demands) {
        if (demand.kind !== "effect") {
          yield* dispose(root, identityOfDemand(demand), "declined_ended");
        }
        yield* deleteDemand(demand.id);
        yield* history({
          assignmentId: demand.assignment_id,
          root: root.root_delivery_id,
          kind: demand.kind,
          seq: demand.seq,
          outcome: "retired",
        });
      }
    });

  /** The lost disposition of a demand whose work a restart took, in the caller's transaction. */
  const loseDemand = (root: RootRow, demand: DemandRow) =>
    Effect.gen(function* () {
      yield* sql`DELETE FROM fd_assistant_slots
        WHERE root_delivery_id = ${root.root_delivery_id} AND reserved_demand_id = ${demand.id}`;
      yield* deleteDemand(demand.id);
      yield* dispose(root, identityOfDemand(demand), "lost_on_restart");
      yield* history({
        assignmentId: demand.assignment_id,
        root: root.root_delivery_id,
        kind: demand.kind,
        seq: demand.seq,
        outcome: "lost_on_restart",
      });
    });

  /** Clears a kept native wake's adapter offer, where it can be, and forgets it. */
  const dropKept = (messageId: string) =>
    Effect.suspend(() => {
      const entry = kept.get(messageId);
      kept.delete(messageId);
      return entry?.drop ?? Effect.void;
    });

  const dropRootKept = (root: string) =>
    Effect.forEach(
      [...kept.entries()].filter(([, entry]) => entry.root === root && !entry.pending),
      ([messageId]) => dropKept(messageId),
      { discard: true },
    );

  const markDispatched: HandoffAdmission["Service"]["markDispatched"] = (admitted) =>
    Effect.flatMap(
      now,
      (at) => sql`UPDATE fd_assistant_admissions SET state = 'dispatched', updated_at = ${at}
        WHERE admission_id = ${admitted.admissionId} AND entry_seq = ${admitted.entrySeq}
          AND state = 'dispatching'`,
    ).pipe(Effect.asVoid, failed("dispatched"));

  /**
   * Marks a dispatch's admission dispatched once the dispatch returned. A mark that fails is kept
   * as owed, for `flushUnmarked` to retry, so the finished dispatch never holds the slot.
   */
  const settleDispatch = (admitted: Admitted) =>
    markDispatched(admitted).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => void unmarked.set(generationOf(admitted), admitted)).pipe(
          Effect.andThen(
            Effect.logWarning(
              "the assistant could not mark an admission dispatched; it is retried",
              cause,
            ),
          ),
        ),
      ),
    );

  /**
   * Marks each dispatch this instance finished but could not mark, by its own generation, before
   * ownership is judged. A mark that fails again stays owed and fails the caller, which judges
   * nothing until it succeeds; a generation a later admission took over is marked no more.
   */
  const flushUnmarked = Effect.suspend(() =>
    Effect.forEach(
      Array.from(unmarked),
      ([generation, admitted]) =>
        Effect.tap(markDispatched(admitted), () => Effect.sync(() => unmarked.delete(generation))),
      { discard: true },
    ),
  );

  /** The admitted probe, then the dispatch, then its admission marked dispatched. */
  const runAdmitted = <A, E, R>(admitted: Admitted, dispatch: Effect.Effect<A, E, R>) =>
    Effect.andThen(probe.admitted(admitted), dispatch).pipe(
      Effect.ensuring(settleDispatch(admitted)),
    );

  // Uninterruptible from the commit to the mark: an interrupt landing before the dispatch ran
  // would otherwise mark the row dispatched and let the release pass free a slot its work never
  // took. The transaction commits inside the same region, so its result is never lost either.
  const dispatchAdmitted: HandoffAdmission["Service"]["dispatchAdmitted"] = (decide, dispatch) =>
    Effect.uninterruptible(
      Effect.flatMap(decide, (decision) => {
        const admitted = decision.admitted;
        if (admitted === undefined) {
          return Effect.succeed({ decision, value: Option.none() });
        }
        return runAdmitted(admitted, dispatch(admitted)).pipe(
          Effect.map((value) => ({ decision, value: Option.some(value) })),
        );
      }),
    );

  const management: HandoffAdmission["Service"]["management"] = (root) =>
    readRoot(root).pipe(
      Effect.map((row): Management => row?.state ?? "never"),
      failed("management", root),
    );

  const enter: HandoffAdmission["Service"]["enter"] = (entry, work) =>
    Effect.gen(function* () {
      const root = yield* readRoot(entry.root);
      if (root === undefined) return { type: "proceed" } as const;
      if (root.state !== "active") return { type: "refuse", category: "ended" } as const;
      const link = yield* readLink(root.assignment_id);
      if (link === undefined) return { type: "refuse", category: "revoked" } as const;
      const authority = makeAuthority();
      const slot = yield* readSlot(root.root_delivery_id);
      const demand = yield* effectDemand(root.root_delivery_id, entry.deliveryId);
      // The root's authority, read from the database alone, decides first: a revoked root's
      // effect is refused whether it would be admitted or wait, its waiting demand included.
      const category = yield* authority(link);
      if (category !== undefined) {
        if (demand !== undefined) {
          yield* deleteDemand(demand.id);
          yield* history({
            assignmentId: root.assignment_id,
            root: root.root_delivery_id,
            kind: "effect",
            seq: demand.seq,
            outcome: "declined",
          });
        }
        return { type: "refuse", category } as const;
      }
      const head =
        slot === undefined
          ? yield* freeAndHead(authority, demand === undefined ? undefined : `demand:${demand.id}`)
          : undefined;
      const route =
        slot?.state === "held"
          ? "held"
          : slot?.state === "reserved"
            ? "convert"
            : head?.ok === true
              ? "grant"
              : "demand";
      if (route === "demand") {
        if (demand === undefined) {
          yield* insertDemand(root, {
            kind: "effect",
            deliveryId: entry.deliveryId,
            effectId: entry.effectId,
          });
        } else if (demand.effect_id !== entry.effectId) {
          // Another effect of the delivery now waits; it enters at a fresh position.
          const seq = yield* freshSeq;
          yield* sql`UPDATE fd_assistant_admission_demands
            SET effect_id = ${entry.effectId}, seq = ${seq}, overtaken = 0,
              blocked_reason = NULL, blocked_checked_at = NULL
            WHERE id = ${demand.id}`;
          yield* history({
            assignmentId: root.assignment_id,
            root: root.root_delivery_id,
            kind: "effect",
            seq,
            outcome: "stale",
          });
        }
        return { type: "defer" } as const;
      }
      if (entry.fresh && work === undefined) {
        return { type: "needs_work", item: itemOf(link) } as const;
      }
      const refusal = entry.fresh && work !== undefined ? freshness(link, work) : undefined;
      if (refusal !== undefined) {
        if (demand !== undefined) {
          yield* deleteDemand(demand.id);
          yield* history({
            assignmentId: root.assignment_id,
            root: root.root_delivery_id,
            kind: "effect",
            seq: demand.seq,
            outcome: "declined",
          });
        }
        return { type: "refuse", category: refusal } as const;
      }
      const entrySeq = yield* freshSeq;
      if (route === "held") yield* holdSlot(root.root_delivery_id, entrySeq);
      else if (route === "convert" && slot !== undefined) yield* convertReservation(slot, entrySeq);
      else {
        yield* insertSlot(root, entrySeq);
        yield* recordGrant(
          head?.candidates ?? [],
          {
            id: demand === undefined ? undefined : `demand:${demand.id}`,
            assignmentId: root.assignment_id,
          },
          { root: root.root_delivery_id, kind: "effect", seq: demand?.seq ?? null },
        );
      }
      if (demand !== undefined) yield* deleteDemand(demand.id);
      const admitted = yield* insertAdmission(root, {
        kind: "effect",
        entrySeq,
        deliveryId: entry.deliveryId,
        effectId: entry.effectId,
      });
      return { type: "proceed", admitted } as const;
    }).pipe(transact("decide", entry.root));

  const deferredDemand: HandoffAdmission["Service"]["deferredDemand"] = (effect) =>
    Effect.map(
      sql<{ readonly found: number }>`SELECT 1 AS found FROM fd_assistant_admission_demands
        WHERE root_delivery_id = ${effect.root} AND kind = 'effect'
          AND delivery_id = ${effect.deliveryId} AND effect_id = ${effect.effectId}`,
      (rows) => rows.length > 0,
    ).pipe(failed("read", effect.root));

  const authorizeOpening: HandoffAdmission["Service"]["authorizeOpening"] = (opening) =>
    Effect.gen(function* () {
      const root = yield* readRoot(opening.root);
      if (root === undefined) return { type: "allow" } as const;
      if (root.state !== "active") return { type: "refuse", category: "ended" } as const;
      const link = yield* readLink(root.assignment_id);
      if (link === undefined) return { type: "refuse", category: "revoked" } as const;
      const category = yield* makeAuthority()(link);
      if (category !== undefined) return { type: "refuse", category } as const;
      if (opening.childScopeMatches === undefined) {
        const refusal = freshness(link, {
          type: "read",
          fingerprint: opening.fingerprint,
          status: opening.status,
        });
        return refusal === undefined
          ? ({ type: "allow" } as const)
          : ({ type: "refuse", category: refusal } as const);
      }
      // A child's launch renders its own item, which must still say what its task froze; the
      // root's item is read afresh.
      if (!opening.childScopeMatches) return { type: "refuse", category: "scope_changed" } as const;
      if (opening.status === "done" || opening.status === "cancelled") {
        return { type: "refuse", category: "item_closed" } as const;
      }
      if (opening.work === undefined) return { type: "needs_work", item: itemOf(link) } as const;
      const refusal = freshness(link, opening.work);
      return refusal === undefined
        ? ({ type: "allow" } as const)
        : ({ type: "refuse", category: refusal } as const);
    }).pipe(transact("decide", opening.root));

  /** An ending or retired root's late turn: declined, its key's disposition recorded once. */
  const declineEnded = (
    root: RootRow,
    provenance: Provenance,
    turn: Exclude<AutomaticTurn, { readonly kind: "restart_continuation" }>,
  ) =>
    Effect.gen(function* () {
      const wakeKey = wakeKeyOf(turn);
      const demand = yield* demandByKey(root.root_delivery_id, turn.kind, wakeKey);
      if (demand !== undefined) {
        // Its reservation goes by compare-and-delete; a slot an admission took over is kept.
        yield* sql`DELETE FROM fd_assistant_slots
          WHERE root_delivery_id = ${root.root_delivery_id} AND state = 'reserved'
            AND reserved_demand_id = ${demand.id}`;
        const [still] = yield* sql<{ readonly found: number }>`SELECT 1 AS found
          FROM fd_assistant_slots WHERE reserved_demand_id = ${demand.id}`;
        if (still === undefined) {
          yield* deleteDemand(demand.id);
          yield* history({
            assignmentId: root.assignment_id,
            root: root.root_delivery_id,
            kind: demand.kind,
            seq: demand.seq,
            outcome: "declined",
          });
        }
      }
      const clearable = turn.kind === "background_wake" && turn.clearable;
      yield* dispose(
        root,
        {
          kind: turn.kind,
          threadId: turn.threadId,
          wakeKey,
          childThreadId: turn.kind === "delegated_question" ? turn.childThreadId : null,
          providerThreadId:
            turn.kind === "background_wake" || turn.kind === "delegated_completion"
              ? turn.providerThreadId
              : null,
          provenance,
          clearable,
        },
        "declined_ended",
      );
      return { type: "declined", clear: clearable } as const;
    });

  const decideTurnTransaction = (input: {
    readonly root: string;
    readonly provenance: Provenance;
    readonly turn: AutomaticTurn;
    readonly work?: WorkRead;
  }) =>
    Effect.gen(function* () {
      const { turn, provenance } = input;
      const root = yield* readRoot(input.root);
      if (root === undefined) return { type: "unmanaged" } as const;
      if (turn.kind === "restart_continuation") {
        // A settled source is woken only for awaited work it lost; a managed family declines it.
        if (root.state !== "active" || turn.settled) {
          return { type: "declined", clear: false } as const;
        }
      } else if (root.state !== "active") {
        return yield* declineEnded(root, provenance, turn);
      }
      // Presented again while its dispatch goes on: that dispatch is the turn's, alone.
      if (yield* turnInFlight(turn.threadId, turn.messageId)) {
        return { type: "in_flight" } as const;
      }
      const link = yield* readLink(root.assignment_id);
      if (link === undefined) {
        return { type: "declined", clear: false } as const;
      }
      const authority = makeAuthority();
      const slot = yield* readSlot(root.root_delivery_id);
      const demand =
        turn.kind === "restart_continuation"
          ? undefined
          : yield* demandByKey(root.root_delivery_id, turn.kind, wakeKeyOf(turn));
      /**
       * Waits with `category` instead of running: its demand, reserved or waiting, is blocked,
       * or one is recorded blocked. A continuation, which never waits, declines.
       */
      const blockTurn = (category: BlockedReason) =>
        Effect.gen(function* () {
          if (turn.kind === "restart_continuation") {
            return { type: "declined", clear: false } as const;
          }
          if (demand !== undefined) {
            yield* blockDemand(demand, category);
            return { type: "blocked", demandId: demand.id, category } as const;
          }
          const demandId = yield* insertDemand(root, {
            kind: "turn",
            turn,
            provenance,
            blocked: category,
          });
          yield* history({
            assignmentId: root.assignment_id,
            root: root.root_delivery_id,
            kind: turn.kind,
            seq: null,
            outcome: "blocked",
          });
          return { type: "blocked", demandId, category } as const;
        });
      // The root's authority, read from the database alone, decides first, so a revocation
      // reaches work already waiting: its demand is blocked with the category, out of the fair
      // order until a re-check restores it at a fresh position. One blocked already stays so,
      // and nothing is read for it.
      const category = yield* authority(link);
      if (category !== undefined) {
        if (demand?.blocked_reason !== null && demand?.blocked_reason !== undefined) {
          return { type: "demand", demandId: demand.id } as const;
        }
        return yield* blockTurn(category);
      }
      const reservedForKey =
        slot?.state === "reserved" && demand !== undefined && slot.reserved_demand_id === demand.id;
      const atHead = () =>
        freeAndHead(authority, demand === undefined ? undefined : `demand:${demand.id}`);
      let head: { readonly ok: boolean; readonly candidates: ReadonlyArray<GrantCandidate> } = {
        ok: false,
        candidates: [],
      };
      const grantable = () =>
        Effect.gen(function* () {
          if (slot !== undefined) return false;
          head = yield* atHead();
          return head.ok;
        });
      type Route = "held" | "convert" | "reserved" | "grant" | "demand" | "decline";
      let route: Route;
      switch (turn.kind) {
        case "restart_continuation":
          route =
            provenance === "factory" && slot?.state === "held"
              ? "held"
              : provenance === "factory" && slot?.state === "reserved"
                ? "convert"
                : slot !== undefined
                  ? "decline"
                  : (yield* grantable())
                    ? "grant"
                    : "decline";
          break;
        case "delegated_question":
          route =
            provenance === "factory" && slot?.state === "held"
              ? "held"
              : reservedForKey
                ? "reserved"
                : provenance === "factory" && slot?.state === "reserved"
                  ? "convert"
                  : (yield* grantable())
                    ? "grant"
                    : "demand";
          break;
        default:
          route = reservedForKey ? "reserved" : (yield* grantable()) ? "grant" : "demand";
      }
      if (route === "decline") return { type: "declined", clear: false } as const;
      if (route === "demand" && turn.kind !== "restart_continuation") {
        // Waiting already, it keeps its position, and nothing is read for it.
        if (demand !== undefined) return { type: "demand", demandId: demand.id } as const;
        const demandId = yield* insertDemand(root, { kind: "turn", turn, provenance });
        return { type: "demand", demandId } as const;
      }
      if (input.work === undefined) {
        return { type: "needs_work", item: itemOf(link) } as const;
      }
      const refusal = freshness(link, input.work);
      if (refusal !== undefined) return yield* blockTurn(refusal);
      const entrySeq = yield* freshSeq;
      if (route === "held" || route === "reserved") {
        yield* holdSlot(root.root_delivery_id, entrySeq);
      } else if (route === "convert" && slot !== undefined) {
        yield* convertReservation(slot, entrySeq);
      } else {
        yield* insertSlot(root, entrySeq);
        yield* recordGrant(
          head.candidates,
          {
            id: demand === undefined ? undefined : `demand:${demand.id}`,
            assignmentId: root.assignment_id,
          },
          { root: root.root_delivery_id, kind: turn.kind, seq: demand?.seq ?? null },
        );
      }
      if (demand !== undefined) yield* deleteDemand(demand.id);
      const admitted = yield* insertAdmission(root, {
        kind: "automatic_turn",
        entrySeq,
        threadId: turn.threadId,
        messageId: turn.messageId,
      });
      return { type: "admitted", admitted } as const;
    }).pipe(transact("decide", input.root));

  const decideTurn: HandoffAdmission["Service"]["decideTurn"] = (input) => {
    const { turn } = input;
    if (turn.kind !== "background_wake" || input.kept === undefined) {
      return decideTurnTransaction(input);
    }
    // Kept before the decision, so a grant right after its demand commits finds it here.
    const keptInput = input.kept;
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const already = kept.has(turn.messageId);
        if (!already) {
          kept.set(turn.messageId, {
            ...keptInput,
            root: input.root,
            threadId: turn.threadId,
            pending: true,
          });
        }
        return already;
      }),
      () => decideTurnTransaction(input),
      (already, exit) =>
        Effect.sync(() => {
          const entry = kept.get(turn.messageId);
          if (entry === undefined) return;
          const waits =
            exit._tag === "Success" &&
            (exit.value.type === "demand" || exit.value.type === "blocked");
          // A wake no longer waiting is forgotten without clearing its offer: it ran, or the
          // decline clears it itself.
          if (!waits) kept.delete(turn.messageId);
          else if (!already) entry.pending = false;
        }),
    );
  };

  const admitDelegation: HandoffAdmission["Service"]["admitDelegation"] = (input) =>
    Effect.gen(function* () {
      const root = yield* readRoot(input.root);
      if (root === undefined) return { type: "unmanaged" } as const;
      if (root.state !== "active") return { type: "refused", category: "ended" } as const;
      const link = yield* readLink(root.assignment_id);
      if (link === undefined) return { type: "refused", category: "revoked" } as const;
      const refusal = (yield* makeAuthority()(link)) ?? freshness(link, input.work);
      if (refusal !== undefined) return { type: "refused", category: refusal } as const;
      const slot = yield* readSlot(root.root_delivery_id);
      if (slot?.state !== "held") return { type: "refused", category: "not_holding" } as const;
      const entrySeq = yield* freshSeq;
      yield* holdSlot(root.root_delivery_id, entrySeq);
      const admitted = yield* insertAdmission(root, {
        kind: "delegation",
        entrySeq,
        threadId: input.threadId,
        messageId: input.messageId,
      });
      return { type: "admitted", admitted } as const;
    }).pipe(transact("decide", input.root));

  const next: HandoffAdmission["Service"]["next"] = Effect.gen(function* () {
    const free = Scheduler.CAPACITY - (yield* occupied);
    const candidates = yield* readCandidates(makeAuthority());
    return { free, head: free > 0 ? Scheduler.head(candidates) : undefined, candidates };
  }).pipe(transact("read"));

  /** The candidate's grant at the free fair head, or undefined when it is not there. */
  const atHeadOf = (authority: Authority, id: string) =>
    Effect.gen(function* () {
      const head = yield* freeAndHead(authority, id);
      return head.ok ? head.candidates : undefined;
    });

  const claim: HandoffAdmission["Service"]["claim"] = (input) =>
    Effect.gen(function* () {
      const stale = { type: "stale" } as const;
      const link = yield* readLink(input.assignmentId);
      const assignment = yield* assignmentState(input.assignmentId);
      if (link === undefined || assignment?.state !== "queued" || link.control !== "none") {
        return stale;
      }
      const first = link.delivery_id === null;
      let root: RootRow | undefined;
      if (first) {
        if (input.deliveryId === undefined) return stale;
      } else {
        root = yield* readRoot(link.delivery_id ?? "");
        if (
          root?.state !== "active" ||
          (input.deliveryId !== undefined && input.deliveryId !== link.delivery_id) ||
          (yield* readSlot(root.root_delivery_id)) !== undefined ||
          (yield* admissionsOf(root.root_delivery_id)).length > 0 ||
          (yield* demandCount(root.root_delivery_id)) > 0
        ) {
          return stale;
        }
      }
      const authority = makeAuthority();
      const candidates = yield* atHeadOf(authority, `assignment:${input.assignmentId}`);
      if (candidates === undefined) return stale;
      if (first) {
        const deliveryId = input.deliveryId ?? "";
        const at = yield* now;
        yield* sql`INSERT INTO fd_assistant_managed_roots
          (root_delivery_id, assignment_id, attempt, state, created_at)
          VALUES (${deliveryId}, ${input.assignmentId}, ${assignment.attempt}, 'active', ${at})`;
        yield* sql`UPDATE fd_assistant_factory_links
          SET delivery_id = ${deliveryId}, updated_at = ${at}
          WHERE assignment_id = ${input.assignmentId}`;
        root = yield* readRoot(deliveryId);
      }
      if (root === undefined) return stale;
      const entrySeq = yield* freshSeq;
      yield* insertSlot(root, entrySeq);
      const admitted = yield* insertAdmission(root, {
        kind: "claim",
        entrySeq,
        deliveryId: root.root_delivery_id,
      });
      yield* portfolio.transitionAssignment({
        assignmentId: input.assignmentId,
        event: { type: "claim" },
      });
      const candidate = candidates.find(({ id }) => id === `assignment:${input.assignmentId}`);
      yield* recordGrant(
        candidates,
        { id: candidate?.id, assignmentId: input.assignmentId },
        { root: root.root_delivery_id, kind: "claim", seq: candidate?.seq ?? null },
      );
      return { type: "claimed", admitted, root: root.root_delivery_id, first } as const;
    }).pipe(transact("claim"));

  const grantEffect: HandoffAdmission["Service"]["grantEffect"] = (demandId) =>
    Effect.gen(function* () {
      const stale = { type: "stale" } as const;
      const demand = yield* readDemand(demandId);
      if (
        demand?.kind !== "effect" ||
        demand.state !== "waiting" ||
        demand.delivery_id === null ||
        demand.effect_id === null
      ) {
        return stale;
      }
      const root = yield* readRoot(demand.root_delivery_id);
      if (root?.state !== "active") return stale;
      // A revoked root's effect is never granted, at the head or not: redispatched, its
      // delivery is refused with the category.
      const authority = makeAuthority();
      const link = yield* readLink(root.assignment_id);
      const category = link === undefined ? "revoked" : yield* authority(link);
      if (category !== undefined) {
        return {
          type: "refused",
          category,
          deliveryId: demand.delivery_id,
          effectId: demand.effect_id,
        } as const;
      }
      if ((yield* readSlot(root.root_delivery_id)) !== undefined) return stale;
      const candidates = yield* atHeadOf(authority, `demand:${demandId}`);
      if (candidates === undefined) return stale;
      const entrySeq = yield* freshSeq;
      yield* insertSlot(root, entrySeq);
      yield* recordGrant(
        candidates,
        { id: `demand:${demandId}`, assignmentId: root.assignment_id },
        { root: root.root_delivery_id, kind: "effect", seq: demand.seq },
      );
      yield* deleteDemand(demandId);
      const admitted = yield* insertAdmission(root, {
        kind: "effect",
        entrySeq,
        deliveryId: demand.delivery_id,
        effectId: demand.effect_id,
      });
      return {
        type: "granted",
        admitted,
        deliveryId: demand.delivery_id,
        effectId: demand.effect_id,
      } as const;
    }).pipe(transact("grant"));

  const reserve: HandoffAdmission["Service"]["reserve"] = (demandId, work) =>
    Effect.gen(function* () {
      const stale = { type: "stale" } as const;
      const demand = yield* readDemand(demandId);
      if (demand === undefined || demand.kind === "effect" || demand.state !== "waiting") {
        return stale;
      }
      const root = yield* readRoot(demand.root_delivery_id);
      const link = root === undefined ? undefined : yield* readLink(root.assignment_id);
      if (
        root?.state !== "active" ||
        link === undefined ||
        (yield* readSlot(root.root_delivery_id)) !== undefined
      ) {
        return stale;
      }
      // Blocked, only a re-check restores it.
      if (demand.blocked_reason !== null) return stale;
      // A revoked root's demand is blocked at once, at the head or not, so restoring the root
      // brings it back at a fresh position.
      const authority = makeAuthority();
      const category = yield* authority(link);
      if (category !== undefined) {
        yield* blockDemand(demand, category);
        return { type: "blocked", category } as const;
      }
      const candidates = yield* atHeadOf(authority, `demand:${demandId}`);
      if (candidates === undefined) return stale;
      // The head's own fresh read decides; failing it blocks the demand without its turn.
      const refusal = freshness(link, work);
      if (refusal !== undefined) {
        yield* blockDemand(demand, refusal);
        return { type: "blocked", category: refusal } as const;
      }
      const entrySeq = yield* freshSeq;
      const leaseUntil = yield* minutesFromNow(
        demand.kind === "pull_request_wake" ? PULL_REQUEST_LEASE_MINUTES : LEASE_MINUTES,
      );
      yield* sql`UPDATE fd_assistant_admission_demands SET state = 'reserved'
        WHERE id = ${demandId}`;
      yield* sql`INSERT INTO fd_assistant_slots (
          root_delivery_id, assignment_id, state, entry_seq, granted_at, reserved_demand_id,
          lease_until, redelivered_by
        ) VALUES (
          ${root.root_delivery_id}, ${root.assignment_id}, 'reserved', ${entrySeq}, ${yield* now},
          ${demandId}, ${leaseUntil}, ${instanceId}
        )`;
      yield* recordGrant(
        candidates,
        { id: `demand:${demandId}`, assignmentId: root.assignment_id },
        { root: root.root_delivery_id, kind: demand.kind, seq: demand.seq },
      );
      return {
        type: "reserved",
        demand: demandOf({ ...demand, state: "reserved" }),
      } as const;
    }).pipe(transact("reserve"));

  const redeliverNative: HandoffAdmission["Service"]["redeliverNative"] = (demandId, work) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const stale = { type: "stale" } as const;
        const decided = yield* Effect.gen(function* () {
          const demand = yield* readDemand(demandId);
          if (demand?.kind !== "background_wake" || demand.state !== "reserved") return stale;
          const root = yield* readRoot(demand.root_delivery_id);
          const slot = root === undefined ? undefined : yield* readSlot(root.root_delivery_id);
          if (
            root?.state !== "active" ||
            slot?.state !== "reserved" ||
            slot.reserved_demand_id !== demandId ||
            demand.message_id === null ||
            demand.thread_id === null ||
            (yield* turnInFlight(demand.thread_id, demand.message_id))
          ) {
            return stale;
          }
          const entry = kept.get(demand.message_id);
          if (entry === undefined) {
            yield* loseDemand(root, demand);
            return { type: "lost" } as const;
          }
          const link = yield* readLink(root.assignment_id);
          if (link === undefined) return stale;
          // An admitting decision like any other: the root's authority as it stands, and the
          // item read again since the reservation.
          const category = yield* makeAuthority()(link);
          if (category === undefined && work === undefined) {
            return { type: "needs_work", item: itemOf(link) } as const;
          }
          const refusal = category ?? (work === undefined ? undefined : freshness(link, work));
          if (refusal !== undefined) {
            // Blocked, it waits with its dispatch kept until the root is restored.
            yield* blockDemand(demand, refusal);
            return { type: "blocked", category: refusal } as const;
          }
          const entrySeq = yield* freshSeq;
          yield* holdSlot(root.root_delivery_id, entrySeq);
          yield* deleteDemand(demandId);
          const admitted = yield* insertAdmission(root, {
            kind: "automatic_turn",
            entrySeq,
            threadId: demand.thread_id,
            messageId: demand.message_id,
          });
          kept.delete(demand.message_id);
          return { type: "admitted", admitted, dispatch: entry.dispatch } as const;
        }).pipe(transact("grant"));
        if (decided.type !== "admitted") return decided;
        // The kept dispatch runs on a fiber of its own, uninterruptible from the commit to its
        // admission's mark like any admitted dispatch.
        yield* runAdmitted(decided.admitted, decided.dispatch).pipe(
          Effect.forkIn(scope, { startImmediately: true, uninterruptible: true }),
        );
        return { type: "dispatched" } as const;
      }),
    );

  const moot: HandoffAdmission["Service"]["moot"] = (demandId) =>
    Effect.gen(function* () {
      const demand = yield* readDemand(demandId);
      if (demand === undefined) return;
      yield* sql`DELETE FROM fd_assistant_slots WHERE reserved_demand_id = ${demandId}`;
      yield* deleteDemand(demandId);
      yield* history({
        assignmentId: demand.assignment_id,
        root: demand.root_delivery_id,
        kind: demand.kind,
        seq: demand.seq,
        outcome: "moot",
      });
    }).pipe(transact("maintain"));

  const lose: HandoffAdmission["Service"]["lose"] = (demandId) =>
    Effect.gen(function* () {
      const demand = yield* readDemand(demandId);
      if (demand === undefined) return;
      const root = yield* readRoot(demand.root_delivery_id);
      if (root !== undefined) yield* loseDemand(root, demand);
    }).pipe(transact("maintain"));

  const firstTick: HandoffAdmission["Service"]["firstTick"] = Effect.gen(function* () {
    const foreign = yield* sql<DemandRow>`SELECT * FROM fd_assistant_admission_demands
      WHERE kind = 'background_wake' AND instance_id <> ${instanceId}`;
    for (const demand of foreign) {
      const root = yield* readRoot(demand.root_delivery_id);
      if (root !== undefined) yield* loseDemand(root, demand);
    }
    const reserved = yield* sql<DemandRow>`SELECT d.* FROM fd_assistant_admission_demands d
      JOIN fd_assistant_slots s ON s.reserved_demand_id = d.id
      WHERE d.state = 'reserved'
        AND d.kind IN ('delegated_question', 'delegated_completion')
        AND (s.redelivered_by IS NULL OR s.redelivered_by <> ${instanceId})
      ORDER BY d.seq`;
    for (const demand of reserved) {
      yield* sql`UPDATE fd_assistant_slots SET redelivered_by = ${instanceId}
        WHERE reserved_demand_id = ${demand.id}`;
    }
    return reserved.map(demandOf);
  }).pipe(transact("maintain"));

  const expireLeases: HandoffAdmission["Service"]["expireLeases"] = (currency) =>
    Effect.gen(function* () {
      const at = yield* now;
      const expired = yield* sql<DemandRow & { readonly lease_until: string }>`
        SELECT d.*, s.lease_until FROM fd_assistant_slots s
        JOIN fd_assistant_admission_demands d ON d.id = s.reserved_demand_id
        WHERE s.state = 'reserved' AND s.lease_until <= ${at}
        ORDER BY s.lease_until`.pipe(failed("maintain"));
      for (const demand of expired) {
        // Read outside the transaction; the transaction then acts only on that same reservation.
        const current =
          demand.kind === "delegated_question" || demand.kind === "delegated_completion"
            ? yield* currency(demandOf(demand))
            : undefined;
        yield* Effect.gen(function* () {
          const ended = yield* sql<{ readonly found: number }>`SELECT 1 AS found
            FROM fd_assistant_slots
            WHERE reserved_demand_id = ${demand.id} AND lease_until = ${demand.lease_until}`;
          if (ended.length === 0) return;
          yield* sql`DELETE FROM fd_assistant_slots WHERE reserved_demand_id = ${demand.id}`;
          const root = yield* readRoot(demand.root_delivery_id);
          switch (demand.kind) {
            case "pull_request_wake":
            case "usage_limit_resume":
              // Its producer presents it again, entering at a fresh position.
              yield* deleteDemand(demand.id);
              yield* history({
                assignmentId: demand.assignment_id,
                root: demand.root_delivery_id,
                kind: demand.kind,
                seq: demand.seq,
                outcome: "expired",
              });
              return;
            case "delegated_question":
            case "delegated_completion":
              if (current === "not_current") {
                yield* deleteDemand(demand.id);
                yield* history({
                  assignmentId: demand.assignment_id,
                  root: demand.root_delivery_id,
                  kind: demand.kind,
                  seq: demand.seq,
                  outcome: "moot",
                });
              } else yield* reenter(demand, "expired");
              return;
            case "background_wake":
              if (demand.message_id !== null && kept.has(demand.message_id)) {
                yield* reenter(demand, "expired");
              } else if (root !== undefined) {
                yield* loseDemand(root, demand);
              }
              return;
            case "effect":
              return;
          }
        }).pipe(transact("maintain", demand.root_delivery_id));
      }
    });

  const blockRevoked: HandoffAdmission["Service"]["blockRevoked"] = Effect.gen(function* () {
    const waiting = yield* sql<DemandRow>`SELECT d.* FROM fd_assistant_admission_demands d
      JOIN fd_assistant_managed_roots r ON r.root_delivery_id = d.root_delivery_id
      WHERE r.state = 'active' AND d.state = 'waiting' AND d.blocked_reason IS NULL
      ORDER BY d.seq`;
    const authority = makeAuthority();
    const refused: Array<{ readonly demand: Demand; readonly category: BlockedReason }> = [];
    for (const demand of waiting) {
      const link = yield* readLink(demand.assignment_id);
      const category = link === undefined ? "revoked" : yield* authority(link);
      if (category === undefined) continue;
      if (demand.kind === "effect") refused.push({ demand: demandOf(demand), category });
      else yield* blockDemand(demand, category);
    }
    return refused;
  }).pipe(transact("maintain"));

  const blockedRoots: HandoffAdmission["Service"]["blockedRoots"] = (options) =>
    Effect.gen(function* () {
      const due = DateTime.formatIso(
        DateTime.add(yield* DateTime.now, { minutes: -BLOCKED_RECHECK_MINUTES }),
      );
      const rows = yield* sql<{ readonly root_delivery_id: string }>`
        SELECT DISTINCT d.root_delivery_id FROM fd_assistant_admission_demands d
        JOIN fd_assistant_managed_roots r ON r.root_delivery_id = d.root_delivery_id
        WHERE r.state = 'active' AND d.blocked_reason IS NOT NULL
          AND (${options?.force === true ? 1 : 0} = 1 OR d.blocked_checked_at <= ${due})
        ORDER BY d.root_delivery_id`;
      return rows.map((row) => row.root_delivery_id);
    }).pipe(failed("read"));

  const recheckBlocked: HandoffAdmission["Service"]["recheckBlocked"] = (input) =>
    Effect.gen(function* () {
      const root = yield* readRoot(input.root);
      if (root?.state !== "active") return 0;
      const link = yield* readLink(root.assignment_id);
      if (link === undefined) return 0;
      const due = DateTime.formatIso(
        DateTime.add(yield* DateTime.now, { minutes: -BLOCKED_RECHECK_MINUTES }),
      );
      const blocked = yield* sql<DemandRow>`SELECT * FROM fd_assistant_admission_demands
        WHERE root_delivery_id = ${input.root} AND blocked_reason IS NOT NULL
          AND (${input.force === true ? 1 : 0} = 1 OR blocked_checked_at <= ${due})
        ORDER BY seq`;
      if (blocked.length === 0) return 0;
      const refusal = (yield* makeAuthority()(link)) ?? freshness(link, input.work);
      if (refusal !== undefined) {
        const at = yield* now;
        for (const demand of blocked) {
          yield* sql`UPDATE fd_assistant_admission_demands
            SET blocked_reason = ${refusal}, blocked_checked_at = ${at}
            WHERE id = ${demand.id}`;
        }
        return 0;
      }
      for (const demand of blocked) yield* reenter(demand, "unblocked");
      return blocked.length;
    }).pipe(transact("maintain", input.root));

  const demands: HandoffAdmission["Service"]["demands"] = (root) =>
    sql<DemandRow>`SELECT * FROM fd_assistant_admission_demands
      WHERE root_delivery_id = ${root} ORDER BY seq`.pipe(
      Effect.map((rows) => rows.map(demandOf)),
      failed("read", root),
    );

  const settleAdmissions: HandoffAdmission["Service"]["settleAdmissions"] = (root, runState) =>
    Effect.gen(function* () {
      yield* flushUnmarked;
      const slot = yield* readSlot(root).pipe(failed("release", root));
      const rows = yield* sql<
        AdmissionRow & { readonly thread_id: string | null; readonly message_id: string | null }
      >`SELECT admission_id, kind, instance_id, state, entry_seq, thread_id, message_id
        FROM fd_assistant_admissions WHERE root_delivery_id = ${root}`.pipe(
        failed("release", root),
      );
      let busy = false;
      let unknown = false;
      const settled: Array<string> = [];
      for (const row of rows) {
        if (row.state === "dispatching" && row.instance_id === instanceId) {
          busy = true;
          continue;
        }
        if (row.kind !== "automatic_turn" || row.thread_id === null || row.message_id === null) {
          settled.push(row.admission_id);
          continue;
        }
        const state = yield* Effect.exit(
          runState({ threadId: row.thread_id, messageId: row.message_id }),
        );
        if (state._tag === "Failure") unknown = true;
        else if (state.value === "live") busy = true;
        else settled.push(row.admission_id);
      }
      if (settled.length > 0) {
        // A row this instance has admitted again since it was read is dispatching, and stays.
        yield* sql`DELETE FROM fd_assistant_admissions
          WHERE admission_id IN ${sql.in(settled)}
            AND (state = 'dispatched' OR instance_id <> ${instanceId})`.pipe(
          failed("release", root),
        );
      }
      return {
        entrySeq: slot?.state === "held" ? slot.entry_seq : null,
        busy,
        unknown,
      };
    });

  const release: HandoffAdmission["Service"]["release"] = (root, entrySeq) =>
    Effect.andThen(
      flushUnmarked,
      Effect.gen(function* () {
        const slot = yield* readSlot(root);
        if (slot?.state !== "held" || slot.entry_seq !== entrySeq) return "kept" as const;
        // Another instance's dispatching row is a dead process's, taken as dispatched.
        const dispatching = (yield* admissionsOf(root)).some(
          (row) => row.state === "dispatching" && row.instance_id === instanceId,
        );
        if (dispatching) return "kept" as const;
        yield* sql`DELETE FROM fd_assistant_slots
        WHERE root_delivery_id = ${root} AND state = 'held' AND entry_seq = ${entrySeq}`;
        yield* history({
          assignmentId: slot.assignment_id,
          root,
          kind: "release",
          seq: null,
          outcome: "released",
        });
        return "released" as const;
      }).pipe(transact("release", root)),
    );

  const fenceRoot = (root: string, reason: "completed" | "cancelled") =>
    Effect.gen(function* () {
      const row = yield* readRoot(root);
      if (row?.state !== "active") return false;
      yield* sql`UPDATE fd_assistant_managed_roots
        SET state = 'ending', reason = ${reason}, ending_at = ${yield* now}
        WHERE root_delivery_id = ${root} AND state = 'active'`;
      return true;
    });

  const fence: HandoffAdmission["Service"]["fence"] = (root, reason) =>
    fenceRoot(root, reason).pipe(transact("retire", root));

  const retireAttempt: HandoffAdmission["Service"]["retireAttempt"] = (input) =>
    Effect.gen(function* () {
      const retired = yield* Effect.gen(function* () {
        const before = yield* readRoot(input.root);
        if (before === undefined) return "unobserved" as const;
        if (before.state === "retired") return "retired" as const;
        yield* fenceRoot(input.root, input.reason);
        const { observation } = input;
        const quiescent =
          observation.phase === "terminal" &&
          !observation.busy &&
          !observation.deferred &&
          !observation.unknown;
        if (!quiescent) return "unobserved" as const;
        if (
          (yield* readSlot(input.root)) !== undefined ||
          (yield* admissionsOf(input.root)).length > 0
        ) {
          return "contended" as const;
        }
        const root = (yield* readRoot(input.root)) ?? before;
        yield* disposeDemands(root);
        yield* sql`DELETE FROM fd_assistant_queue_positions
          WHERE assignment_id = ${root.assignment_id}`;
        const assignment = yield* assignmentState(root.assignment_id);
        if (assignment !== undefined && !TERMINAL_ASSIGNMENT.has(assignment.state)) {
          if (root.reason === "completed") {
            yield* mirror(
              root.assignment_id,
              "completed",
              input.note ??
                `Factory delivery ${input.root} is done: its pull request merged and its close-out finished.`,
              input.evidence ?? [`Factory delivery ${input.root} is done.`],
            );
          } else {
            yield* mirror(
              root.assignment_id,
              "cancelled",
              input.note ?? `Factory delivery ${input.root} was cancelled.`,
            );
          }
        }
        yield* sql`UPDATE fd_assistant_managed_roots SET state = 'retired', retired_at = ${yield* now}
          WHERE root_delivery_id = ${input.root} AND state = 'ending'`;
        yield* history({
          assignmentId: root.assignment_id,
          root: input.root,
          kind: "retire",
          seq: null,
          outcome: "retired",
        });
        return "retired-now" as const;
      }).pipe(transact("retire", input.root));
      if (retired !== "retired-now") return retired;
      yield* dropRootKept(input.root);
      return "retired" as const;
    });

  const retire: HandoffAdmission["Service"]["retire"] = (input) =>
    Effect.gen(function* () {
      yield* input.release;
      yield* probe.released(input.root);
      const observation = yield* input.observe;
      if (
        observation.phase === "terminal" &&
        !observation.busy &&
        !observation.deferred &&
        !observation.unknown
      ) {
        yield* probe.observed(input.root);
      }
      return yield* retireAttempt({
        root: input.root,
        reason: input.reason,
        observation,
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
        ...(input.note === undefined ? {} : { note: input.note }),
      });
    });

  /** Whether a claim row counts as dispatched: marked so, or a dead process's. */
  const claimSettled = (row: AdmissionRow, entrySeq: number) =>
    row.kind === "claim" &&
    row.entry_seq === entrySeq &&
    (row.state === "dispatched" || row.instance_id !== instanceId);

  const retirePreDelivery: HandoffAdmission["Service"]["retirePreDelivery"] = (input) =>
    Effect.gen(function* () {
      yield* flushUnmarked;
      const committed = yield* Effect.gen(function* () {
        const root = yield* readRoot(input.root);
        if (root?.state !== "active") return false;
        const slot = yield* readSlot(input.root);
        const admissions = yield* admissionsOf(input.root);
        const { shape } = input;
        if (shape.type === "claim") {
          const claimRow = admissions.find((row) => row.admission_id === shape.admissionId);
          if (
            claimRow === undefined ||
            !claimSettled(claimRow, shape.entrySeq) ||
            admissions.length !== 1 ||
            slot?.state !== "held" ||
            slot.entry_seq !== shape.entrySeq
          ) {
            return false;
          }
          yield* sql`DELETE FROM fd_assistant_admissions WHERE admission_id = ${shape.admissionId}`;
          yield* sql`DELETE FROM fd_assistant_slots
            WHERE root_delivery_id = ${input.root} AND entry_seq = ${shape.entrySeq}`;
        } else {
          const link = yield* readLink(root.assignment_id);
          const assignment = yield* assignmentState(root.assignment_id);
          if (
            input.reason !== "abandoned" ||
            link?.delivery_id !== input.root ||
            link.control !== "cancel" ||
            (assignment?.state !== "stopped" && assignment?.state !== "queued") ||
            slot !== undefined ||
            admissions.length > 0 ||
            (yield* demandCount(input.root)) > 0
          ) {
            return false;
          }
        }
        yield* disposeDemands(root);
        yield* sql`DELETE FROM fd_assistant_queue_positions
          WHERE assignment_id = ${root.assignment_id}`;
        yield* mirror(
          root.assignment_id,
          input.reason === "failed" ? "failed" : "cancelled",
          input.note ??
            (input.reason === "failed"
              ? `Factory delivery ${input.root} could not be started.`
              : `Factory delivery ${input.root} was cancelled before it started.`),
        );
        yield* sql`UPDATE fd_assistant_managed_roots
          SET state = 'retired', reason = ${input.reason}, retired_at = ${yield* now}
          WHERE root_delivery_id = ${input.root} AND state = 'active'`;
        yield* history({
          assignmentId: root.assignment_id,
          root: input.root,
          kind: "retire",
          seq: null,
          outcome: "retired",
        });
        return true;
      }).pipe(transact("prestart", input.root));
      if (!committed) return "contended" as const;
      yield* dropRootKept(input.root);
      return "retired" as const;
    });

  const parkPreStart: HandoffAdmission["Service"]["parkPreStart"] = (input) =>
    Effect.andThen(
      flushUnmarked,
      Effect.gen(function* () {
        const root = yield* readRoot(input.root);
        if (root?.state !== "active") return "contended" as const;
        const link = yield* readLink(root.assignment_id);
        const assignment = yield* assignmentState(root.assignment_id);
        const slot = yield* readSlot(input.root);
        const admissions = yield* admissionsOf(input.root);
        const claimRow = admissions.find((row) => row.admission_id === input.admissionId);
        if (
          link?.delivery_id !== input.root ||
          link.control !== "stop" ||
          (assignment?.state !== "launching" && assignment?.state !== "launch-uncertain") ||
          claimRow === undefined ||
          !claimSettled(claimRow, input.entrySeq) ||
          admissions.length !== 1 ||
          slot?.state !== "held" ||
          slot.entry_seq !== input.entrySeq ||
          (yield* demandCount(input.root)) > 0
        ) {
          return "contended" as const;
        }
        yield* sql`DELETE FROM fd_assistant_admissions WHERE admission_id = ${input.admissionId}`;
        yield* sql`DELETE FROM fd_assistant_slots
        WHERE root_delivery_id = ${input.root} AND entry_seq = ${input.entrySeq}`;
        yield* mirror(root.assignment_id, "stopped", parkedNotice(input.root));
        yield* history({
          assignmentId: root.assignment_id,
          root: input.root,
          kind: "park",
          seq: null,
          outcome: "released",
        });
        return "parked" as const;
      }).pipe(transact("prestart", input.root)),
    );

  const resumeReentry: HandoffAdmission["Service"]["resumeReentry"] = (input) =>
    Effect.gen(function* () {
      const contended = { type: "contended" } as const;
      const root = yield* readRoot(input.root);
      if (root?.state !== "active") return contended;
      const link = yield* readLink(root.assignment_id);
      const assignment = yield* assignmentState(root.assignment_id);
      // A persisted cancel is not taken back: the parked cancel retires the root.
      if (
        link?.delivery_id !== input.root ||
        link.control === "cancel" ||
        assignment?.state !== "stopped" ||
        (yield* readSlot(input.root)) !== undefined ||
        (yield* admissionsOf(input.root)).length > 0
      ) {
        return contended;
      }
      const refusal = (yield* makeAuthority()(link)) ?? freshness(link, input.work);
      if (refusal !== undefined) return { type: "refused", category: refusal } as const;
      yield* sql`UPDATE fd_assistant_factory_links SET control = 'none', updated_at = ${yield* now}
        WHERE assignment_id = ${root.assignment_id}`;
      yield* portfolio.transitionAssignment({
        assignmentId: root.assignment_id,
        event: { type: "resume", note: pendingResumeNotice(input.root) },
      });
      const seq = yield* freshSeq;
      yield* sql`INSERT INTO fd_assistant_queue_positions (assignment_id, seq, overtaken)
        VALUES (${root.assignment_id}, ${seq}, 0)
        ON CONFLICT (assignment_id) DO UPDATE SET seq = excluded.seq, overtaken = 0`;
      return { type: "queued" } as const;
    }).pipe(transact("prestart", input.root));

  const dropFencedReservation: HandoffAdmission["Service"]["dropFencedReservation"] = (input) =>
    Effect.gen(function* () {
      const root = yield* readRoot(input.root);
      const demand = yield* readDemand(input.demandId);
      if (root === undefined || root.state === "active" || demand === undefined) {
        return "kept" as const;
      }
      const [slot] = yield* sql<{ readonly found: number }>`SELECT 1 AS found
        FROM fd_assistant_slots
        WHERE root_delivery_id = ${input.root} AND state = 'reserved'
          AND reserved_demand_id = ${input.demandId}`;
      if (slot === undefined) return "kept" as const;
      yield* sql`DELETE FROM fd_assistant_slots
        WHERE root_delivery_id = ${input.root} AND state = 'reserved'
          AND reserved_demand_id = ${input.demandId}`;
      if (demand.kind !== "effect") {
        yield* dispose(root, identityOfDemand(demand), "declined_ended");
      }
      yield* deleteDemand(demand.id);
      yield* history({
        assignmentId: root.assignment_id,
        root: input.root,
        kind: demand.kind,
        seq: demand.seq,
        outcome: "declined",
      });
      return "dropped" as const;
    }).pipe(transact("retire", input.root));

  const pruneKept: HandoffAdmission["Service"]["pruneKept"] = Effect.gen(function* () {
    for (const [messageId, entry] of kept) {
      if (entry.pending) continue;
      const [demand] = yield* sql<{ readonly found: number }>`SELECT 1 AS found
        FROM fd_assistant_admission_demands
        WHERE root_delivery_id = ${entry.root} AND kind = 'background_wake'
          AND message_id = ${messageId}`.pipe(failed("maintain", entry.root));
      if (demand === undefined) yield* dropKept(messageId);
    }
  });

  return HandoffAdmission.of({
    instanceId,
    management,
    enter,
    deferredDemand,
    authorizeOpening,
    decideTurn,
    admitDelegation,
    dispatchAdmitted,
    markDispatched,
    next,
    claim,
    grantEffect,
    reserve,
    redeliverNative,
    moot,
    lose,
    firstTick,
    expireLeases,
    blockRevoked,
    blockedRoots,
    recheckBlocked,
    demands,
    settleAdmissions,
    release,
    fence,
    retireAttempt,
    retire,
    retirePreDelivery,
    parkPreStart,
    resumeReentry,
    dropFencedReservation,
    pruneKept,
  });
});

/** The service over assistant persistence, core's projections and its project store. */
export const layer = Layer.effect(HandoffAdmission, make);

/**
 * `layer` with assistant persistence and core's thread projections on the core-migrated SQL
 * client; the project store comes from the server's context. The assistant handoff ledger
 * migrates first, so no store is built against an older schema.
 */
export const layerLive = layer.pipe(
  Layer.provide(
    Layer.merge(PortfolioStore.layer, ProjectionStore.layer).pipe(
      Layer.provide(HandoffMigrations.layer),
    ),
  ),
);
