import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";
import type { AcpAdapterV2ExtensionContext } from "@t3tools/provider-acp/server/adapter";
import * as Effect from "effect/Effect";
import type { AcpRegistrySettings } from "../../settings.ts";

export const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export const isCopilotSettings = (settings: AcpRegistrySettings) =>
  settings.source === "local"
    ? /^copilot(\.exe|\.cmd)?$/i.test(settings.commandPath.split(/[\\/]/).pop() ?? "")
    : settings.agentId === "github-copilot-cli";

export const copilotUsageEvents = [
  "session.usage_info",
  "assistant.usage",
  "session.usage_checkpoint",
  "session.shutdown",
];

/** Only native context measurements set usedTokens; request totals are not context size. */
export function copilotUsageUpdate(event: {
  readonly type: string;
  readonly agentId?: string;
  readonly data?: unknown;
}): Partial<ThreadTokenUsageSnapshot> | undefined {
  // Child context windows must not overwrite the main conversation's meter.
  if (event.agentId !== undefined) return undefined;
  const data = record(event.data);
  switch (event.type) {
    case "session.usage_info": {
      const usedTokens = count(data.currentTokens);
      const maxTokens = count(data.tokenLimit);
      return usedTokens === undefined
        ? undefined
        : { usedTokens, ...(maxTokens ? { maxTokens } : {}) };
    }
    case "assistant.usage": {
      if (typeof data.parentToolCallId === "string") return undefined;
      const input = count(data.inputTokens);
      const output = count(data.outputTokens);
      const cached = count(data.cacheReadTokens);
      return {
        ...(input === undefined ? {} : { lastInputTokens: input }),
        ...(output === undefined ? {} : { lastOutputTokens: output }),
        ...(cached === undefined ? {} : { lastCachedInputTokens: cached }),
      };
    }
    case "session.usage_checkpoint":
    case "session.shutdown": {
      const nanoAiu = count(data.totalNanoAiu);
      const snapshot =
        event.type === "session.usage_checkpoint" ? record(data.accountingSnapshot) : data;
      const models = Object.values(record(snapshot.modelMetrics));
      let inputTokens = 0;
      let outputTokens = 0;
      let complete = models.length > 0;
      for (const model of models) {
        const usage = record(record(model).usage);
        const input = count(usage.inputTokens);
        const output = count(usage.outputTokens);
        if (input === undefined || output === undefined) {
          complete = false;
          break;
        }
        inputTokens += input;
        outputTokens += output;
      }
      const totalProcessedTokens = count(inputTokens + outputTokens);
      // assistant.usage.cost and requests.cost are premium-request multipliers, not USD.
      const usage: Partial<ThreadTokenUsageSnapshot> = {
        ...(complete && totalProcessedTokens !== undefined
          ? { inputTokens, outputTokens, totalProcessedTokens }
          : {}),
        ...(nanoAiu === undefined
          ? {}
          : { cost: { amount: nanoAiu / 1e9, currency: "AI credits", scope: "session" } }),
      };
      return Object.keys(usage).length === 0 ? undefined : usage;
    }
    default:
      return undefined;
  }
}

/** Keep metrics arriving before the first context measurement until the meter can accept them. */
export function makeCopilotUsageReporter(reportUsage: AcpAdapterV2ExtensionContext["reportUsage"]) {
  const pending = new Map<string, Partial<ThreadTokenUsageSnapshot>>();
  return (event: Parameters<typeof copilotUsageUpdate>[0] & { readonly sessionId: string }) => {
    const update = copilotUsageUpdate(event);
    if (update === undefined || Object.keys(update).length === 0) return Effect.void;
    const usage = { ...pending.get(event.sessionId), ...update };
    if (update.usedTokens !== undefined || event.type === "session.shutdown") {
      pending.delete(event.sessionId);
    } else {
      pending.set(event.sessionId, usage);
    }
    return reportUsage({ sessionId: event.sessionId, usage });
  };
}
