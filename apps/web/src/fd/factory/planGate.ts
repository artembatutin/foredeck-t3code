import {
  currentDelivery,
  type FactoryPlanDestination,
  type FactoryPlanDraft,
  type FactoryPlanErrors,
  type FactoryPlanTaskErrors,
  type FactoryPlanTaskField,
  factoryPlanDraft,
  factoryPlanDraftEdited,
  factoryPlanFromDraft,
  rebaseFactoryPlanDraft,
} from "@t3tools/client-runtime/fd/factory";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  FACTORY_REPLAN_NOTE_MAX_LENGTH,
  type FactoryDelivery,
  type FactoryDeliveryId,
  type FactoryDeliveryRefInput,
  type FactoryPlan,
  type FactoryPlanReplanInput,
  type FactoryPlanUpdateInput,
} from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";

import { deliveriesWithStarted, factoryErrorText, type FactoryStartedDelivery } from "./deliver";

/** Whether this session holds each plan action's grant where the destination plans. */
export interface FactoryPlanGatePermissions {
  readonly update: boolean;
  readonly approve: boolean;
  readonly reject: boolean;
  readonly replan: boolean;
}

/** A delivery waiting at the plan gate, as a Work item's Factory section shows it. */
export interface FactoryPlanGate {
  readonly destination: FactoryPlanDestination;
  /** The plan as the server holds it. */
  readonly plan: FactoryPlan;
  /** Each action offered now: on a live connection holding its grant. */
  readonly offered: FactoryPlanGatePermissions;
}

const NONE: FactoryPlanGatePermissions = {
  update: false,
  approve: false,
  reject: false,
  replan: false,
};

/**
 * The plan gate of an item's current delivery (the one its Factory section shows), or null: the
 * delivery must wait at the plan gate with a plan, on a server that plans. A status this build
 * does not know is not the gate, and a gate of a stage kind it does not know shows read-only.
 * Without a live connection, or a grant, the plan still shows but its actions are not offered.
 */
export function factoryPlanGate(input: {
  readonly environmentId: EnvironmentId;
  readonly itemRef: WorkItemRef;
  readonly planning: boolean;
  readonly connected: boolean;
  /** The project's deliveries; null until they load. */
  readonly deliveries: ReadonlyArray<FactoryDelivery> | null;
  readonly started: ReadonlyArray<FactoryStartedDelivery>;
  readonly permitted: FactoryPlanGatePermissions;
}): FactoryPlanGate | null {
  if (!input.planning) return null;
  const deliveries = deliveriesWithStarted(input);
  const current = deliveries === null ? undefined : currentDelivery(deliveries, input.itemRef);
  if (
    current === undefined ||
    current.status !== "waiting" ||
    current.stage?.name !== "approve_plan" ||
    current.plan === undefined
  ) {
    return null;
  }
  const { connected, permitted } = input;
  const live = connected && current.stage.kind !== "unknown";
  return {
    destination: { environmentId: input.environmentId, deliveryId: current.deliveryId },
    plan: current.plan,
    offered: live
      ? {
          update: permitted.update,
          approve: permitted.approve,
          reject: permitted.reject,
          replan: permitted.replan,
        }
      : NONE,
  };
}

const sameDestination = (left: FactoryPlanDestination, right: FactoryPlanDestination) =>
  left.environmentId === right.environmentId && left.deliveryId === right.deliveryId;

/**
 * The draft the gate shows once the server holds `gate.plan`: the plan unedited for a gate with
 * no draft yet, or the draft rebased onto it, which follows the plan when unedited and otherwise
 * keeps the edits and flags the change (see `rebaseFactoryPlanDraft`).
 */
export const followFactoryPlan = (
  draft: FactoryPlanDraft | null,
  gate: FactoryPlanGate,
): FactoryPlanDraft =>
  draft === null || !sameDestination(draft, gate.destination)
    ? factoryPlanDraft(gate.destination, gate.plan)
    : rebaseFactoryPlanDraft(draft, gate.destination, gate.plan);

/**
 * `changed`: the server's plan changed under the owner's edits, which they reapply or discard
 * before saving or approving.
 */
export type FactoryPlanDraftState = "unedited" | "edited" | "changed";

export const factoryPlanDraftState = (draft: FactoryPlanDraft): FactoryPlanDraftState =>
  draft.current !== null ? "changed" : factoryPlanDraftEdited(draft) ? "edited" : "unedited";

export type FactoryPlanSave =
  | {
      readonly _tag: "Save";
      /** The plan the request sends, which the draft follows once it is saved. */
      readonly plan: FactoryPlan;
      readonly request: {
        readonly environmentId: EnvironmentId;
        readonly input: FactoryPlanUpdateInput;
      };
    }
  | { readonly _tag: "Invalid"; readonly errors: FactoryPlanErrors }
  /** The server's plan changed under the edits; reapply or discard them first. */
  | { readonly _tag: "Changed" }
  /** Not offered here, nothing edited, no task left, or a draft made for another delivery. */
  | { readonly _tag: "Unavailable" };

/**
 * What saving the draft would send: the edited plan as the plan update's payload, always for the
 * gate's own environment and delivery. A draft made for another delivery is never saved here, and
 * neither is one without tasks: the server keeps at least one, and the owner rejects the plan
 * instead.
 */
export const factoryPlanSave = (
  gate: FactoryPlanGate,
  draft: FactoryPlanDraft,
): FactoryPlanSave => {
  if (!gate.offered.update || draft.tasks.length === 0) return { _tag: "Unavailable" };
  const result = factoryPlanFromDraft(draft, gate.destination);
  switch (result._tag) {
    case "Mismatch":
      return { _tag: "Unavailable" };
    case "Changed":
      return { _tag: "Changed" };
    case "Invalid":
      return result;
    case "Valid":
      return factoryPlanDraftEdited(draft)
        ? {
            _tag: "Save",
            plan: result.plan,
            request: {
              environmentId: gate.destination.environmentId,
              input: { deliveryId: gate.destination.deliveryId, plan: result.plan },
            },
          }
        : { _tag: "Unavailable" };
  }
};

/** The plan gate's actions that end or approve it, each asked for once more before it goes. */
export type FactoryPlanDecision = "approve" | "reject";

/** Whether the gate offers each action now. */
export interface FactoryPlanGateActions {
  /** Only while the draft shows the server's plan unedited: the owner approves what they see. */
  readonly approve: boolean;
  readonly reject: boolean;
  readonly replan: boolean;
}

export const factoryPlanGateActions = (
  gate: FactoryPlanGate,
  draft: FactoryPlanDraft,
): FactoryPlanGateActions => ({
  approve:
    gate.offered.approve &&
    sameDestination(draft, gate.destination) &&
    factoryPlanDraftState(draft) === "unedited",
  reject: gate.offered.reject,
  replan: gate.offered.replan,
});

export type FactoryPlanDecisionRequest =
  | {
      readonly _tag: "Send";
      readonly request: {
        readonly environmentId: EnvironmentId;
        readonly input: FactoryDeliveryRefInput;
      };
    }
  /** Ask the owner first; confirming sends it for the delivery the confirmation names. */
  | { readonly _tag: "Confirm" }
  | { readonly _tag: "Unavailable" };

/**
 * What approving or rejecting does: nothing unless the gate offers it, and otherwise a
 * confirmation first. It is sent only once confirmed for the gate's own delivery, so a
 * confirmation opened for a delivery that has since been replaced never acts on the new one.
 */
export const factoryPlanDecision = (
  gate: FactoryPlanGate,
  draft: FactoryPlanDraft,
  decision: FactoryPlanDecision,
  confirmedFor: FactoryDeliveryId | null,
): FactoryPlanDecisionRequest => {
  if (!factoryPlanGateActions(gate, draft)[decision]) return { _tag: "Unavailable" };
  if (confirmedFor !== gate.destination.deliveryId) return { _tag: "Confirm" };
  return {
    _tag: "Send",
    request: {
      environmentId: gate.destination.environmentId,
      input: { deliveryId: gate.destination.deliveryId },
    },
  };
};

export type FactoryReplanRequest =
  | {
      readonly _tag: "Send";
      readonly request: {
        readonly environmentId: EnvironmentId;
        readonly input: FactoryPlanReplanInput;
      };
    }
  | { readonly _tag: "Invalid"; readonly message: string }
  | { readonly _tag: "Unavailable" };

/** What replanning with `note` sends: the trimmed note, refused while blank or past its bound. */
export const factoryReplanRequest = (gate: FactoryPlanGate, note: string): FactoryReplanRequest => {
  if (!gate.offered.replan) return { _tag: "Unavailable" };
  const trimmed = note.trim();
  if (trimmed.length === 0) {
    return { _tag: "Invalid", message: "Write what the planner should change." };
  }
  if (trimmed.length > FACTORY_REPLAN_NOTE_MAX_LENGTH) {
    return {
      _tag: "Invalid",
      message: `Use at most ${FACTORY_REPLAN_NOTE_MAX_LENGTH} characters.`,
    };
  }
  return {
    _tag: "Send",
    request: {
      environmentId: gate.destination.environmentId,
      input: { deliveryId: gate.destination.deliveryId, note: trimmed },
    },
  };
};

/** What a refused plan edit or approval shows. */
export interface FactoryPlanRefusal {
  /** The refusal's text, as every Factory command shows it. */
  readonly message: string;
  /** Messages on the task fields the refusal names, keyed by task id. */
  readonly fields: FactoryPlanErrors;
  /** Messages for the tasks it names as a whole, keyed by task id. */
  readonly tasks: Readonly<Record<string, string>>;
}

const DRAFT_FIELD =
  /^(?:title|summary|acceptance(?:\.[1-9]\d*(?:\.testPlan)?)?|testPlan(?:\.\d+\.(?:criterion|check|paths))?)$/;
const isDraftField = (field: string): field is FactoryPlanTaskField => DRAFT_FIELD.test(field);

export const FACTORY_PLAN_FIELD_REFUSED = "Factory refused this as written.";
export const FACTORY_PLAN_TASK_REFUSED = "Factory refused this task as written.";

const refusedFieldText = (field: FactoryPlanTaskField) => {
  const missingTest = /^acceptance\.(\d+)\.testPlan$/.exec(field);
  return missingTest === null
    ? FACTORY_PLAN_FIELD_REFUSED
    : `Add a test plan entry for criterion ${missingTest[1]}.`;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/**
 * What a failed plan edit or approval shows: the failure's text, and for a Factory error that
 * names parts of the plan, a message on each field it names, or on the task for a field this
 * build does not know or none. The messages are this client's own; the server sends none.
 */
export const factoryPlanRefusal = (cause: Cause.Cause<unknown>): FactoryPlanRefusal => {
  const fields: Record<string, FactoryPlanTaskErrors> = {};
  const tasks: Record<string, string> = {};
  const error: unknown = Option.getOrNull(Cause.findErrorOption(cause));
  const named =
    isRecord(error) && error._tag === "FactoryError" && Array.isArray(error.fields)
      ? (error.fields as ReadonlyArray<unknown>)
      : [];
  for (const entry of named) {
    if (!isRecord(entry) || typeof entry.taskId !== "string") continue;
    const { taskId, field } = entry;
    if (typeof field === "string" && isDraftField(field)) {
      fields[taskId] = { ...fields[taskId], [field]: refusedFieldText(field) };
    } else {
      tasks[taskId] = FACTORY_PLAN_TASK_REFUSED;
    }
  }
  return { message: factoryErrorText(cause), fields, tasks };
};

/** A task's field messages: the draft's own, and the refusal's on fields the draft finds none. */
export const factoryPlanTaskErrors = (
  own: FactoryPlanErrors,
  refusal: FactoryPlanRefusal | null,
  taskId: string,
): FactoryPlanTaskErrors => ({ ...refusal?.fields[taskId], ...own[taskId] });
