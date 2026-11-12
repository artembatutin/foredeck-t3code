import type { RuntimeMode } from "@t3tools/contracts";
import {
  runtimeModeMeaning,
  runtimeModeRefusal,
  type RuntimeModePolicyProvider,
  type RuntimeModeRefusal,
} from "@t3tools/shared/fd/approvals";

export {
  approvalChoiceNote,
  approvalChoices,
  approvalOptionLabel,
  APPROVAL_REASON_UNKNOWN,
  autoAcceptEditsCoverage,
  classifyPendingAction,
  HOST_POLICY_ACTION,
  pendingAnswerRefusal,
  isOwnerDecidedRequest,
  PENDING_ACTION_LABELS,
  pendingActionProvenance,
  pendingActionReason,
  pendingApprovalReason,
  pendingRequestNotice,
  PLAN_GATE_ACTION,
  runtimeModeMeaning,
} from "@t3tools/shared/fd/approvals";

/**
 * Why the composer will not start a turn in this mode, or null. Only a refusal the provider read
 * from its host stops a send, and this never picks another mode: the composer keeps the thread's
 * mode as it is until the owner chooses one of the alternatives.
 */
export const composerRuntimeModeRefusal = (input: {
  readonly provider: RuntimeModePolicyProvider | null | undefined;
  readonly runtimeMode: RuntimeMode;
}): RuntimeModeRefusal | null => runtimeModeRefusal(input.provider, input.runtimeMode);

/** The composer's mode choices with what each means on the provider that would run them. */
export const runtimeModeChoiceDescriptions = <Option extends { readonly mode: RuntimeMode }>(
  options: ReadonlyArray<Option>,
  driver: string | null | undefined,
): ReadonlyArray<Option & { readonly description: string }> =>
  options.map((option) => ({ ...option, description: runtimeModeMeaning(option.mode, driver) }));
