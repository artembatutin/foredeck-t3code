import { describe, expect, it } from "@effect/vitest";
import { copilotUsageUpdate } from "./usage.ts";

describe("Copilot live usage", () => {
  it("reports processed session totals without replacing the measured context window", () => {
    expect(
      copilotUsageUpdate({
        type: "session.usage_checkpoint",
        data: {
          accountingSnapshot: {
            modelMetrics: {
              first: { usage: { inputTokens: 1000, outputTokens: 100 } },
              second: { usage: { inputTokens: 2000, outputTokens: 200 } },
            },
          },
        },
      }),
    ).toEqual({ inputTokens: 3000, outputTokens: 300, totalProcessedTokens: 3300 });
    expect(
      copilotUsageUpdate({
        type: "session.shutdown",
        data: {
          modelMetrics: { first: { usage: { inputTokens: 1000 } } },
        },
      }),
    ).toBeUndefined();
  });

  it("keeps context size separate from the last request's token counts", () => {
    expect(
      copilotUsageUpdate({
        type: "session.usage_info",
        data: { currentTokens: 1200, tokenLimit: 128000 },
      }),
    ).toEqual({ usedTokens: 1200, maxTokens: 128000 });
    expect(
      copilotUsageUpdate({
        type: "assistant.usage",
        data: { inputTokens: 1100, outputTokens: 100, cacheReadTokens: 900, cost: 3 },
      }),
    ).toEqual({ lastInputTokens: 1100, lastOutputTokens: 100, lastCachedInputTokens: 900 });
  });

  it("uses only session billing snapshots for session cost and never treats premium multipliers as dollars", () => {
    expect(
      copilotUsageUpdate({ type: "session.usage_checkpoint", data: { totalNanoAiu: 2500000000 } }),
    ).toEqual({ cost: { amount: 2.5, currency: "AI credits", scope: "session" } });
    expect(copilotUsageUpdate({ type: "session.shutdown", data: { totalNanoAiu: 0 } })).toEqual({
      cost: { amount: 0, currency: "AI credits", scope: "session" },
    });
    expect(
      copilotUsageUpdate({ type: "session.shutdown", data: { totalPremiumRequests: 3 } }),
    ).toBeUndefined();
  });

  it("ignores child contexts and invalid measurements", () => {
    expect(
      copilotUsageUpdate({
        type: "session.usage_info",
        agentId: "child",
        data: { currentTokens: 50, tokenLimit: 100 },
      }),
    ).toBeUndefined();
    expect(
      copilotUsageUpdate({
        type: "assistant.usage",
        data: { parentToolCallId: "task", inputTokens: 500 },
      }),
    ).toBeUndefined();
    for (const invalid of [-1, NaN, Infinity, 1.5, "1200"]) {
      expect(
        copilotUsageUpdate({ type: "session.usage_info", data: { currentTokens: invalid } }),
      ).toBeUndefined();
      expect(
        copilotUsageUpdate({ type: "session.shutdown", data: { totalNanoAiu: invalid } }),
      ).toBeUndefined();
    }
  });
});
