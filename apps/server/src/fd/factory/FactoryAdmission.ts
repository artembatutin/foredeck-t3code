import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { FactoryEffect } from "./pipeline/state.ts";

/**
 * Whether something outside Factory manages a root delivery (a single item, or a parent with its
 * children): `never` for a delivery nothing manages, `active` while its manager admits its work,
 * `retired` once that management has ended or is ending, after which nothing of the root runs
 * again on its manager's behalf.
 */
export type FactoryManagement = "never" | "active" | "retired";

/** Why a managed root refuses an effect; the delivery blocks with the category's fixed text. */
export type FactoryAdmissionRefusal =
  | "revoked"
  | "scope_changed"
  | "unreadable"
  | "item_closed"
  | "ended";

/**
 * What the port decides for an effect: run it now, leave it waiting until a redispatch runs it
 * (see `FactoryService.redispatch`), or refuse it, which blocks the delivery.
 */
export type FactoryAdmissionDecision =
  | { readonly type: "proceed" }
  | { readonly type: "defer" }
  | { readonly type: "refuse"; readonly category: FactoryAdmissionRefusal };

/** An effect a delivery is about to run; close-outs are never asked about. */
export interface FactoryAdmissionEntry {
  /** The root delivery: a child's parent, any other delivery itself. */
  readonly root: FactoryDeliveryId;
  readonly deliveryId: FactoryDeliveryId;
  readonly effectId: number;
  readonly effectType: Exclude<FactoryEffect["type"], "close_out">;
  /** Whether admitting it needs a fresh read of the root's Work item; see `isFreshEffect`. */
  readonly fresh: boolean;
}

/**
 * The port could not read what the root's manager holds. Never taken as `never`: a caller that
 * cannot tell whether a root is managed does nothing on its behalf.
 */
export class FactoryAdmissionReadError extends Schema.TaggedError<FactoryAdmissionReadError>()(
  "FactoryAdmissionReadError",
  { root: FactoryDeliveryId, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Factory could not read whether delivery ${this.root} is managed.`;
  }
}

/**
 * Whether admitting the effect needs a fresh read of the root's Work item: each launch, turn,
 * child creation and PR stage starts agent work from, or publishes, what the item says. Every
 * other effect reads or judges what the delivery already holds. Close-outs are never admitted.
 */
const FRESH: Readonly<Record<FactoryEffect["type"], boolean>> = {
  launch_thread: true,
  send_fix_commit_turn: true,
  send_plan_retry_turn: true,
  send_replan_turn: true,
  send_review_retry_turn: true,
  send_repair_turn: true,
  send_review_follow_up_turn: true,
  create_children: true,
  open_pr: true,
  check_settle: false,
  run_command: false,
  read_fallback_plan: false,
  read_fallback_review: false,
  record_approval: false,
  start_child: false,
  close_out: false,
};

export const isFreshEffect = (type: FactoryEffect["type"]) => FRESH[type];

/** The fixed text a refused effect's block shows after what Factory did not do. */
export const admissionRefusalText: Readonly<Record<FactoryAdmissionRefusal, string>> = {
  revoked:
    "The project assistant no longer authorizes this delivery. Authorize it again in the assistant and Resume, or cancel the delivery.",
  scope_changed:
    "The Work item changed after the project assistant authorized it. Restore the authorized content and Resume, or cancel the delivery.",
  unreadable:
    "The Work item could not be read to confirm what the project assistant authorized. Check its Work source, then Resume.",
  item_closed: "The Work item is done or cancelled. Reopen it and Resume, or cancel the delivery.",
  ended:
    "The project assistant assignment for this delivery has ended. Retry the assignment for a new delivery.",
};

const proceed: FactoryAdmissionDecision = { type: "proceed" };

/**
 * How Factory asks whoever manages a root delivery before it acts for it. The worker asks `enter`
 * before every effect but a close-out and runs the effect only on `proceed`. On `defer` it stores
 * the effect as waiting (`admissionWait`) and runs nothing until a redispatch; a refusal blocks
 * the delivery with the category's text. After a restart the boot sweep asks `deferredDemand`
 * whether an awaited effect stored without that mark was deferred, and blocks it when not.
 * Factory imports nothing of its manager: one is provided where Factory is built.
 *
 * The default manages nothing: every root is `never`, every effect proceeds and nothing was
 * deferred, so Factory runs as it does without a manager.
 */
export class FactoryAdmission extends Context.Reference<{
  readonly management: (
    root: FactoryDeliveryId,
  ) => Effect.Effect<FactoryManagement, FactoryAdmissionReadError>;
  readonly enter: (
    entry: FactoryAdmissionEntry,
  ) => Effect.Effect<FactoryAdmissionDecision, FactoryAdmissionReadError>;
  readonly deferredDemand: (effect: {
    readonly root: FactoryDeliveryId;
    readonly deliveryId: FactoryDeliveryId;
    readonly effectId: number;
  }) => Effect.Effect<boolean, FactoryAdmissionReadError>;
}>("t3/fd/factory/FactoryAdmission", {
  defaultValue: () => ({
    management: () => Effect.succeed("never"),
    enter: () => Effect.succeed(proceed),
    deferredDemand: () => Effect.succeed(false),
  }),
}) {}
