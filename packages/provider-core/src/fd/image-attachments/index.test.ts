import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderThreadId, RunId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { ProviderAdapterTurnStartError } from "../../server/ProviderAdapter.ts";
import { makeProviderFailure } from "../../server/failure.ts";
import { ProviderImageInputError } from "./index.ts";

describe("image startup failures", () => {
  it.each(["unsupported_session", "unsupported_model", "unreadable"] as const)(
    "preserves the %s recovery message through turn startup",
    (reason) => {
      const imageError = new ProviderImageInputError({
        reason,
        cause: new Error("private/path token=private-secret"),
      });
      const wrapped = new ProviderAdapterTurnStartError({
        driver: ProviderDriverKind.make("devin"),
        threadId: ThreadId.make("thread"),
        providerThreadId: ProviderThreadId.make("provider-thread"),
        runId: RunId.make("run"),
        cause: imageError,
      });
      const failure = makeProviderFailure({ cause: Cause.fail(wrapped) });
      expect(failure.message).toBe(imageError.message);
      expect(failure.message).not.toContain("private");
    },
  );
  it("does not expose an unrecognized reason or provider-supplied message", () => {
    const failure = makeProviderFailure({
      cause: {
        _tag: "ProviderImageInputError",
        reason: "unknown",
        message: "private-token",
      },
    });
    expect(failure.message).toBe("Provider turn failed.");
  });
});
