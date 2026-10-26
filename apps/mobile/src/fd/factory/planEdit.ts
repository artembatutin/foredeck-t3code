import {
  type FactoryPlanDestination,
  type FactoryPlanDraft,
  type FactoryPlanGate,
  type FactoryPlanRefusal,
  factoryPlanRefusal,
  factoryPlanSave,
  type FactoryPlanSave,
  factoryPlanTaskErrors,
  type FactoryPlanTaskErrors,
  followFactoryPlan,
  settleFactoryPlanSave,
} from "@t3tools/client-runtime/fd/factory";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { FactoryPlan } from "@t3tools/contracts/fd/factory";
import * as Equal from "effect/Equal";

import { factoryCommandError } from "./itemSection";

/**
 * The plan gate's draft as the mobile editor holds it: the plan its server was last seen holding,
 * the draft following it, and the last refusal of a save or decision. Kept together so a save that
 * settles later settles against the plan seen by then, not the one its request was sent over.
 */
export interface MobilePlanEdit {
  readonly followed: FactoryPlan;
  readonly draft: FactoryPlanDraft;
  readonly refusal: FactoryPlanRefusal | null;
}

const sameDestination = (left: FactoryPlanDestination, right: FactoryPlanDestination) =>
  left.environmentId === right.environmentId && left.deliveryId === right.deliveryId;

/** The editor of a gate first shown: its plan, unedited. */
export const mobilePlanEdit = (gate: FactoryPlanGate): MobilePlanEdit => ({
  followed: gate.plan,
  draft: followFactoryPlan(null, gate),
  refusal: null,
});

/**
 * The editor once the gate is seen holding `gate.plan`: the same editor while it already follows
 * that plan object, and otherwise the draft follows it (see the shared `followFactoryPlan`). A
 * refusal stays while the plan is the same and goes once it changed or belongs to another delivery.
 */
export const followMobilePlanEdit = (
  edit: MobilePlanEdit,
  gate: Pick<FactoryPlanGate, "destination" | "plan">,
): MobilePlanEdit => {
  const here = sameDestination(edit.draft, gate.destination);
  if (here && gate.plan === edit.followed) return edit;
  return {
    followed: gate.plan,
    draft: followFactoryPlan(edit.draft, gate),
    refusal: here && Equal.equals(gate.plan, edit.followed) ? edit.refusal : null,
  };
};

/** The editor after one change to its draft; a refusal's messages stay until the next attempt. */
export const changeMobilePlanEdit = (
  edit: MobilePlanEdit,
  change: (draft: FactoryPlanDraft) => FactoryPlanDraft,
): MobilePlanEdit => ({ ...edit, draft: change(edit.draft) });

export const MOBILE_PLAN_EMPTY = "Keep at least one task, or reject the plan.";

/** The shared save outcome, or `Empty` for this gate's draft with every task removed. */
export type MobilePlanSave = FactoryPlanSave | { readonly _tag: "Empty"; readonly message: string };

/**
 * What saving the draft sends: the shared plan update for the gate's own environment and delivery
 * (see `factoryPlanSave`). A draft with no tasks is not saved and says why, since the server keeps
 * at least one and the owner rejects the plan instead.
 */
export const mobilePlanSave = (gate: FactoryPlanGate, draft: FactoryPlanDraft): MobilePlanSave =>
  gate.offered.update &&
  draft.tasks.length === 0 &&
  draft.current === null &&
  sameDestination(draft, gate.destination)
    ? { _tag: "Empty", message: MOBILE_PLAN_EMPTY }
    : factoryPlanSave(gate, draft);

/** A task's field messages: the draft's own from `save`, and the refusal's where it has none. */
export const mobilePlanTaskErrors = (
  save: MobilePlanSave,
  refusal: FactoryPlanRefusal | null,
  taskId: string,
): FactoryPlanTaskErrors =>
  factoryPlanTaskErrors(save._tag === "Invalid" ? save.errors : {}, refusal, taskId);

/**
 * The editor once a save of `saved`, sent for `destination` while its server was seen holding
 * `sentOver`, succeeds: the draft settles against the plan seen since (see the shared
 * `settleFactoryPlanSave`), so a newer plan seen meanwhile is kept. An editor of another delivery
 * is left as it is.
 */
export const settleMobilePlanSave = (
  edit: MobilePlanEdit,
  destination: FactoryPlanDestination,
  sentOver: FactoryPlan,
  saved: FactoryPlan,
): MobilePlanEdit =>
  sameDestination(edit.draft, destination)
    ? {
        ...edit,
        draft: settleFactoryPlanSave({ destination, plan: edit.followed }, sentOver, saved),
        refusal: null,
      }
    : edit;

/**
 * The editor once Factory refuses a save or decision sent for `destination`: the draft as the owner
 * left it, with the command's text and the client's own message on each field the refusal names
 * (see the shared `factoryPlanRefusal`). An editor of another delivery is left as it is.
 */
export const refuseMobilePlanEdit = (
  edit: MobilePlanEdit,
  destination: FactoryPlanDestination,
  result: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>,
): MobilePlanEdit =>
  sameDestination(edit.draft, destination)
    ? { ...edit, refusal: factoryPlanRefusal(result.cause, factoryCommandError(result)!) }
    : edit;
