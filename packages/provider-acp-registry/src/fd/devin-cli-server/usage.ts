import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";
import type { AcpAdapterV2ExtensionContext } from "@t3tools/provider-acp/server/adapter";
import * as Schema from "effect/Schema";
import type * as Acp from "effect-acp/compat";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Use the explicitly labelled metric, never the differently scaled raw creditCost integer. */
export function reportedCreditCost(
  dimensions: unknown,
  scope: "session" | "turn",
): ThreadTokenUsageSnapshot["cost"] {
  if (!Array.isArray(dimensions)) return undefined;
  for (const dimension of dimensions) {
    const row = record(dimension);
    if (row.uid !== "credits") continue;
    const kind = record(row.kind);
    const metric = kind.type === "cumulativeMetric" ? kind : record(kind.CumulativeMetric);
    const amount = metric.value;
    const currency = typeof metric.tail === "string" ? metric.tail.trim() : "";
    if (
      typeof amount === "number" &&
      Number.isFinite(amount) &&
      amount >= 0 &&
      /^credits?$/.test(currency)
    )
      return { amount, currency, scope };
  }
  return undefined;
}

export function normalizeDevinUsage(
  notification: Acp.SessionNotification,
  usage: ThreadTokenUsageSnapshot,
): ThreadTokenUsageSnapshot {
  if (notification.update.sessionUpdate !== "usage_update") return usage;
  const meta = record(notification.update._meta);
  const input = count(meta["cognition.ai/inputTokens"]);
  const output = count(meta["cognition.ai/outputTokens"]);
  const cached = count(meta["cognition.ai/cachedReadTokens"]);
  const cost = reportedCreditCost(meta["cognition.ai/responseDimensions"], "session");
  return {
    ...usage,
    ...(input === undefined ? {} : { lastInputTokens: input }),
    ...(output === undefined ? {} : { lastOutputTokens: output }),
    ...(cached === undefined ? {} : { lastCachedInputTokens: cached }),
    ...(cost ? { cost } : {}),
  };
}

/** Observed local completion stats carry per-turn usage before session/prompt returns. */
export const registerDevinUsage = (context: AcpAdapterV2ExtensionContext) =>
  context.runtime.handleExtNotification(
    "_cognition.ai/agent_stopped",
    Schema.Struct({ sessionId: Schema.String, stats: Schema.Unknown }),
    (notice) => {
      const stats = record(notice.stats);
      const cost = reportedCreditCost(stats.responseDimensions, "turn");
      const input = count(stats.inputTokens),
        output = count(stats.outputTokens),
        tools = count(stats.toolCalls),
        duration = count(stats.totalTimeMs);
      return context.reportUsage({
        sessionId: notice.sessionId,
        usage: {
          ...(input === undefined ? {} : { lastInputTokens: input }),
          ...(output === undefined ? {} : { lastOutputTokens: output }),
          ...(tools === undefined ? {} : { toolUses: tools }),
          ...(duration === undefined ? {} : { durationMs: duration }),
          ...(cost ? { cost } : {}),
        },
      });
    },
  );
