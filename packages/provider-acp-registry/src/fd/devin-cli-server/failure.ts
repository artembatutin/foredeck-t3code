import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Devin types prompt errors in `data`, e.g. quota exhaustion is
 * `{code: -32011, data: {"cognition.ai/errorKind": "resource_exhausted"}}`.
 * Devin has no separate rate-limit kind; its quota, plan and organization limits use this one.
 */
export function devinPromptFailure(cause: unknown, now: DateTime.Utc = DateTime.nowUnsafe()) {
  if (!isAcpRequestError(cause)) return makeProviderFailure({ cause, class: "provider_error" });
  const data = record(cause.data);
  const limited = data["cognition.ai/errorKind"] === "resource_exhausted";
  const retryable = data["cognition.ai/retryable"];
  const retryAfterSeconds = data["cognition.ai/retryAfterSeconds"];
  return makeProviderFailure({
    cause,
    message: cause.errorMessage,
    code: String(cause.code),
    class: limited ? "usage_limit" : "provider_error",
    ...(typeof retryable === "boolean" ? { retryable } : {}),
    ...(limited && typeof retryAfterSeconds === "number" && retryAfterSeconds > 0
      ? {
          resetAt: DateTime.formatIso(DateTime.add(now, { seconds: retryAfterSeconds })),
        }
      : {}),
  });
}
