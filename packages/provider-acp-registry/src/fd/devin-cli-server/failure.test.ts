import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as EffectAcpErrors from "effect-acp/errors";

import { devinPromptFailure } from "./failure.ts";

const requestError = (data: unknown) =>
  new EffectAcpErrors.AcpRequestError({
    code: -32011,
    errorMessage: "Quota exhausted.",
    data,
  });

describe("Devin prompt failures", () => {
  it("classifies resource exhaustion as a usage limit with its retry time", () => {
    const now = DateTime.makeUnsafe("2026-10-22T12:00:00Z");
    const failure = devinPromptFailure(
      requestError({
        "cognition.ai/errorKind": "resource_exhausted",
        "cognition.ai/retryable": true,
        "cognition.ai/retryAfterSeconds": 60,
      }),
      now,
    );
    expect(failure).toMatchObject({
      class: "usage_limit",
      code: "-32011",
      message: "Quota exhausted.",
      retryable: true,
      resetAt: "2026-10-22T12:01:00.000Z",
    });
  });

  it("keeps other typed errors as provider errors without a reset time", () => {
    const failure = devinPromptFailure(
      requestError({
        "cognition.ai/errorKind": "unavailable",
        "cognition.ai/retryAfterSeconds": 5,
      }),
    );
    expect(failure.class).toBe("provider_error");
    expect(failure.resetAt).toBeUndefined();
    expect(devinPromptFailure(new Error("boom")).class).toBe("provider_error");
  });
});
