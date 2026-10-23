import { SourceControlProviderKind } from "@t3tools/contracts";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/http";

import {
  boundedHostMessage,
  type WorkDomainError,
  WorkForbidden,
  WorkInvalid,
  WorkItemNotFound,
  WorkRateLimited,
  WorkUnauthenticated,
  WorkUnavailable,
} from "../../errors.ts";

/**
 * The Jira Cloud REST transport. URLs are built only from the configured site's origin; links
 * inside payloads are data and never followed. Bodies are bounded, reads retry with backoff,
 * writes never retry, and rate limits pause the site in the server-wide rate-limit registry
 * (except per-issue write limits, which only that issue's serialized writes wait out).
 */

const REQUEST_TIMEOUT = Duration.seconds(30);
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SITE_CONCURRENCY = 4;
const JIRA_PROVIDER = SourceControlProviderKind.make("jira");
/** Copied from the Bitbucket transport: a credential that is not header-safe is never sent. */
const HEADER_SAFE = /^[\x21-\x7e]+$/u;

export const SCOPED_TOKEN_MESSAGE =
  "Scoped API tokens are not supported yet; create an unscoped API token.";

export interface JiraCredential {
  readonly email: string;
  readonly token: string;
}

export interface JiraRequest {
  readonly operation: string;
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Relative to the site, starting with `/rest/`. Query strings are passed in `query`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** User-initiated: may go through a pause the server recorded for background reads. */
  readonly interactive: boolean;
  /** The item a 404 names, so it reads as not found instead of a bad request. */
  readonly itemId?: string;
}

export interface JiraResponse {
  readonly status: number;
  readonly body: string;
}

export interface JiraApiOptions {
  /** Extra attempts for idempotent reads after a network failure or a 5xx answer. */
  readonly readRetries?: number;
}

/** The site's origin, or a reason it cannot be used. Only https sites are trusted. */
export const jiraSiteOrigin = (siteUrl: string): { origin: string } | { error: string } => {
  let url: URL;
  try {
    url = new URL(siteUrl.trim());
  } catch {
    return { error: "Enter the Jira site as a URL, such as https://your-site.atlassian.net." };
  }
  if (url.protocol !== "https:") return { error: "The Jira site must use https." };
  if (url.username !== "" || url.password !== "") {
    return { error: "The Jira site URL must not carry credentials." };
  }
  return { origin: url.origin };
};

const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      errors: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      errorMessages: Schema.optional(Schema.Array(Schema.Unknown)),
    }),
  ),
);

/** Jira's own field errors (`summary: Field is required`), never the rest of a body. */
const fieldErrors = (body: string): string | undefined => {
  const parsed = decodeErrorBody(body);
  if (Option.isNone(parsed)) return undefined;
  const fields = Object.entries(parsed.value.errors ?? {}).map(([field, message]) =>
    typeof message === "string" ? `${field}: ${message}` : field,
  );
  const messages = (parsed.value.errorMessages ?? []).filter(
    (entry): entry is string => typeof entry === "string",
  );
  const all = [...messages, ...fields];
  return all.length === 0 ? undefined : boundedHostMessage(all.join("; "));
};

/** A failure worth retrying for a read; unwrapped before it leaves the transport. */
class RetryableFailure extends Data.TaggedError("RetryableFailure")<{
  readonly error: WorkDomainError;
}> {}

export const make = (options: JiraApiOptions = {}) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const rateLimit = yield* SourceControlRateLimit.SourceControlRateLimit;
    const siteLocks = new Map<string, Semaphore.Semaphore>();
    const readRetries = options.readRetries ?? 3;

    const lockFor = (origin: string) => {
      let lock = siteLocks.get(origin);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(SITE_CONCURRENCY);
        siteLocks.set(origin, lock);
      }
      return lock;
    };

    const request = (
      siteUrl: string,
      credential: JiraCredential | undefined,
      input: JiraRequest,
    ): Effect.Effect<JiraResponse, WorkDomainError> =>
      Effect.gen(function* () {
        const site = jiraSiteOrigin(siteUrl);
        if ("error" in site) return yield* new WorkInvalid({ detail: site.error });
        if (credential === undefined) {
          return yield* new WorkUnauthenticated({
            detail: "Add the Jira API token for this site.",
          });
        }
        if (!HEADER_SAFE.test(credential.email) || !HEADER_SAFE.test(credential.token)) {
          return yield* new WorkUnauthenticated({
            detail: "The Jira email or token contains characters a request cannot carry.",
          });
        }
        const host = new URL(site.origin).host;
        const key = { provider: JIRA_PROVIDER, host };
        const url = new URL(input.path, site.origin);
        if (url.origin !== site.origin || !url.pathname.startsWith("/rest/")) {
          return yield* new WorkInvalid({
            detail: "Refused a Jira request outside the site's API.",
          });
        }
        for (const [name, value] of Object.entries(input.query ?? {}))
          url.searchParams.set(name, value);
        const method = input.method ?? "GET";
        const base =
          method === "GET"
            ? HttpClientRequest.get(url)
            : method === "POST"
              ? HttpClientRequest.post(url)
              : method === "PUT"
                ? HttpClientRequest.put(url)
                : HttpClientRequest.make("DELETE")(url);
        const prepared = base.pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.basicAuth(credential.email, credential.token),
          input.body === undefined
            ? (request) => request
            : HttpClientRequest.bodyJsonUnsafe(input.body),
        );

        const attempt = Effect.gen(function* () {
          const lease = yield* rateLimit.check(key, { allowPaused: input.interactive }).pipe(
            Effect.mapError(
              (paused) =>
                new WorkRateLimited({
                  retryAt: DateTime.formatIso(DateTime.makeUnsafe(paused.retryAt)),
                }),
            ),
          );
          const response = yield* http.execute(prepared).pipe(
            Effect.timeout(REQUEST_TIMEOUT),
            Effect.mapError(
              () =>
                new RetryableFailure({
                  error: new WorkUnavailable({ detail: `Could not reach Jira at ${host}.` }),
                }),
            ),
          );
          const collected = yield* collectUint8StreamText({
            stream: response.stream,
            maxBytes: MAX_BODY_BYTES,
          }).pipe(
            // 204s and many 429s carry no body at all, which is not a read failure.
            Effect.catchIf(
              (error) => error.reason._tag === "EmptyBodyError",
              () => Effect.succeed({ text: "", truncated: false }),
            ),
            Effect.mapError(
              () =>
                new RetryableFailure({
                  error: new WorkUnavailable({ detail: "The Jira answer could not be read." }),
                }),
            ),
          );
          if (collected.truncated) {
            return yield* new WorkUnavailable({ detail: "The Jira answer was too large to read." });
          }
          const status = response.status;
          if (status >= 200 && status < 300) {
            yield* rateLimit.recordSuccess({ ...key, lease });
            return { status, body: collected.text };
          }
          if (status === 429) {
            const now = yield* Clock.currentTimeMillis;
            const retryAt = SourceControlRateLimit.retryAtFromHeader(
              response.headers["retry-after"],
              now,
            );
            const perIssue = (response.headers["ratelimit-reason"] ?? "").includes(
              "per-issue-on-write",
            );
            // A per-issue write limit holds only that issue; anything else pauses the site.
            if (!perIssue) yield* rateLimit.recordRateLimit({ ...key, lease, retryAt });
            return yield* new WorkRateLimited(
              retryAt === undefined
                ? {}
                : { retryAt: DateTime.formatIso(DateTime.makeUnsafe(retryAt)) },
            );
          }
          if (status === 401) {
            return yield* new WorkUnauthenticated({
              detail: `Jira refused the credential for ${host}. Check the email and API token.`,
            });
          }
          if (status === 403) {
            return yield* new WorkForbidden({
              detail: fieldErrors(collected.text) ?? "Jira does not allow this account to do that.",
            });
          }
          if (status === 404) {
            return yield* input.itemId === undefined
              ? new WorkInvalid({ detail: "Jira could not find that project or resource." })
              : new WorkItemNotFound({ itemId: input.itemId });
          }
          if (status >= 400 && status < 500) {
            return yield* new WorkInvalid({
              detail: fieldErrors(collected.text) ?? `Jira refused the request (HTTP ${status}).`,
            });
          }
          return yield* new RetryableFailure({
            error: new WorkUnavailable({
              detail: `Jira answered HTTP ${status} to ${input.operation}.`,
            }),
          });
        });

        const retried =
          method === "GET" && readRetries > 0
            ? attempt.pipe(
                Effect.retry({
                  while: (error) => error._tag === "RetryableFailure",
                  times: readRetries,
                  schedule: Schedule.exponential(Duration.millis(500)).pipe(Schedule.jittered),
                }),
              )
            : attempt;
        return yield* lockFor(site.origin)
          .withPermits(1)(retried)
          .pipe(Effect.catchTags({ RetryableFailure: (failure) => Effect.fail(failure.error) }));
      });

    return { request };
  });

export type JiraApi = Effect.Success<ReturnType<typeof make>>;
