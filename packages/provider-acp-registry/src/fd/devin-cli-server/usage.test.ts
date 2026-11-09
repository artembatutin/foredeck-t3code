import { describe, expect, it } from "@effect/vitest";
import type { AcpAdapterV2ExtensionContext } from "@t3tools/provider-acp/server/adapter";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { makeDevinUsage, normalizeDevinUsage, reportedCreditCost } from "./usage.ts";

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
      compactsAutomatically: true,
      lastInputTokens: 14074,
      lastOutputTokens: 2,
      lastCachedInputTokens: 704,
    });
  });
  it.effect(
    "keeps the last turn's stats through later context updates until a session cost arrives",
    () =>
      Effect.gen(function* () {
        const usage = makeDevinUsage();
        const update = (_meta: { readonly [key: string]: Schema.Json }) =>
          usage.normalizeUsage(
            {
              sessionId: "s",
              update: { sessionUpdate: "usage_update", used: 900, size: 1000, _meta },
            },
            { usedTokens: 900, maxTokens: 1000 },
          );
        const reported: Array<unknown> = [];
        let stopped:
          | ((notice: { sessionId: string; stats: unknown }) => Effect.Effect<void>)
          | undefined;
        yield* usage.registerExtensions({
          runtime: {
            handleExtNotification: (_method: string, _schema: unknown, handler: typeof stopped) =>
              Effect.sync(() => {
                stopped = handler;
              }),
          },
          reportUsage: (notice: unknown) => Effect.sync(() => void reported.push(notice)),
        } as unknown as AcpAdapterV2ExtensionContext);
        yield* stopped!({
          sessionId: "s",
          stats: {
            toolCalls: 3,
            totalTimeMs: 1200,
            responseDimensions: [
              { uid: "credits", kind: { type: "cumulativeMetric", value: 2, tail: " credits" } },
            ],
          },
        });
        expect(reported).toHaveLength(1);
        expect(update({ "cognition.ai/inputTokens": 10 })).toMatchObject({
          usedTokens: 900,
          lastInputTokens: 10,
          toolUses: 3,
          durationMs: 1200,
          cost: { amount: 2, currency: "credits", scope: "turn" },
        });
        expect(
          update({
            "cognition.ai/responseDimensions": [
              { uid: "credits", kind: { type: "cumulativeMetric", value: 7, tail: " credits" } },
            ],
          }).cost,
        ).toEqual({ amount: 7, currency: "credits", scope: "session" });
      }),
  );
});
