import {
  MULTIREPO_PROTOCOL_VERSION,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";

export function repositoryExecutionBlockReason(input: {
  readonly isMultiRepository: boolean;
  readonly serverProtocolVersion: number | undefined;
  readonly provider:
    | Pick<ServerProvider, "driver" | "displayName" | "multiRepository">
    | null
    | undefined;
  readonly runtimeMode: RuntimeMode;
}): string | null {
  if (!input.isMultiRepository) return null;
  if (input.serverProtocolVersion !== MULTIREPO_PROTOCOL_VERSION)
    return "Update this server before running a multi-repository conversation.";
  if (input.provider?.multiRepository?.runtimeModes.includes(input.runtimeMode)) return null;
  const name = input.provider?.displayName ?? input.provider?.driver ?? "The selected provider";
  return `${name} cannot use multiple repositories in this permission mode. Choose a supported provider or mode.`;
}
