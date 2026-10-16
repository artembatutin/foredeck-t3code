import { describe, expect, it } from "@effect/vitest";
import { normalizeDevinUsage, reportedCreditCost } from "./usage.ts";

describe("native usage units", () => {
  it("uses the labelled credit metric without converting differently scaled integers", () => {
    expect(
      reportedCreditCost(
        [{ uid: "credits", kind: { type: "cumulativeMetric", value: 0.47, tail: " credit" } }],
        "turn",
      ),
    ).toEqual({ amount: 0.47, currency: "credit", scope: "turn" });
    expect(
      reportedCreditCost(
        [{ uid: "credits", kind: { CumulativeMetric: { value: 0.47, tail: " credits" } } }],
        "session",
      ),
    ).toEqual({ amount: 0.47, currency: "credits", scope: "session" });
    expect(reportedCreditCost({ creditCost: 47 }, "turn")).toBeUndefined();
    expect(
      reportedCreditCost(
        [{ uid: "credits", kind: { type: "cumulativeMetric", value: -1, tail: " credit" } }],
        "turn",
      ),
    ).toBeUndefined();
    expect(
      reportedCreditCost(
        [{ uid: "credits", kind: { type: "cumulativeMetric", value: 1, tail: " USD" } }],
        "turn",
      ),
    ).toBeUndefined();
  });
  it("preserves measured context and valid token counts without inventing a credit conversion", () => {
    expect(
      normalizeDevinUsage(
        {
          sessionId: "s",
          update: {
            sessionUpdate: "usage_update",
            used: 14076,
            size: 200000,
            _meta: {
              "cognition.ai/inputTokens": 14074,
              "cognition.ai/outputTokens": 2,
              "cognition.ai/cachedReadTokens": 704,
              "cognition.ai/totalCreditCost": 47,
            },
          },
        },
        { usedTokens: 14076, maxTokens: 200000 },
      ),
    ).toEqual({
      usedTokens: 14076,
      maxTokens: 200000,
      lastInputTokens: 14074,
      lastOutputTokens: 2,
      lastCachedInputTokens: 704,
    });
  });
});
