import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "~/connection/runtime";
export const readOverview = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "assistant:overview",
  tag: WS_METHODS.assistantOverview,
});
export const controlAssignment = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "assistant:control",
  tag: WS_METHODS.assistantControl,
});
export const readSpeech = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "assistant:speech",
  tag: WS_METHODS.assistantSpeech,
});
