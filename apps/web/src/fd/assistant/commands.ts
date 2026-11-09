import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "~/connection/runtime";
export const readOverview = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "assistant:overview",
  tag: WS_METHODS.assistantOverview,
});
export const readArchivedThreads = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "assistant:archived-threads",
  tag: ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
});
export const controlAssignment = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "assistant:control",
  tag: WS_METHODS.assistantControl,
});
export const readSpeech = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "assistant:speech",
  tag: WS_METHODS.assistantSpeech,
});
export const readReview = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "assistant:review",
  tag: WS_METHODS.assistantReviewGet,
});
export const reviseReview = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "assistant:review-revise",
  tag: WS_METHODS.assistantReviewRevise,
});
export const startReview = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "assistant:review-start",
  tag: WS_METHODS.assistantReviewStart,
});
