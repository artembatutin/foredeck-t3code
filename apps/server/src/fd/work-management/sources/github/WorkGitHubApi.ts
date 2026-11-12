import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubHttpClient from "@t3tools/source-control-github/server/GitHubHttpClient";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

export {
  GitHubApiAuthenticationError,
  GitHubApiNotFoundError,
  GitHubApiRateLimitError,
  GitHubApiRequestError,
  GitHubApiResponseError,
} from "@t3tools/source-control-github/server/GitHubRequestPolicy";
export type GitHubApiError = GitHubRequestPolicy.GitHubApiError;
export type GitHubRestInput = GitHubRest.GitHubRestInput;

export interface GitHubGraphQlInput {
  readonly host: string;
  readonly operation: string;
  /** A GraphQL document as text; user text travels in `variables`, never in the document. */
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
  /** Overrides `SourceControlRateLimit.Interactive` for this one request. */
  readonly allowReserve?: boolean;
  readonly maxResponseBytes?: number;
}

/**
 * The GitHub calls Work's GitHub Issues source makes. REST and credentials come from the shared
 * `GitHubRest`; GraphQL documents are Work's own text, sent through the same request policy so
 * they share its credentials, `graphql` quota and host pauses.
 */
export class WorkGitHubApi extends Context.Service<
  WorkGitHubApi,
  {
    /** The raw JSON body of a successful GraphQL answer. */
    readonly graphql: (input: GitHubGraphQlInput) => Effect.Effect<string, GitHubApiError>;
    readonly rest: GitHubRest.GitHubRest["Service"]["rest"];
    /** The credential a request to `host` would carry right now. */
    readonly credential: (
      host: string,
    ) => Effect.Effect<GitHubRequestPolicy.GitHubHeldCredential, GitHubApiError>;
  }
>()("t3/fd/work-management/sources/github/WorkGitHubApi") {}

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const decodeGraphQlErrors = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      errors: Schema.NonEmptyArray(
        Schema.Struct({
          type: Schema.optional(Schema.String),
          message: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

/** Groups traces by document without exposing its text. */
const queryHash = (query: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < query.length; index++) {
    hash ^= query.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/**
 * GitHub fails a GraphQL document with HTTP 200 and an `errors` list, so the body is read for
 * its errors as well as the status. Callers rely on a failed document failing, to fall back to
 * narrower reads.
 */
const classify = (input: {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
  readonly truncated: boolean;
}): GitHubRequestPolicy.GitHubAnswer<string> => {
  const { status, headers, body } = input;
  const meta = { status, headers };
  const errors = Option.getOrUndefined(decodeGraphQlErrors(body))?.errors;
  if (
    GitHubRequestPolicy.isRateLimited({
      status,
      headers,
      body,
      ...(errors ? { graphqlErrors: errors } : {}),
    })
  ) {
    return { _tag: "RateLimited", ...meta };
  }
  if (status === 401) return { _tag: "Unauthorized", ...meta };
  if (
    status === 404 ||
    (errors !== undefined && errors.every((error) => error.type === "NOT_FOUND"))
  ) {
    return { _tag: "NotFound", ...meta };
  }
  if (errors !== undefined) {
    const messages = errors.flatMap((error) =>
      error.message === undefined ? [] : [error.message],
    );
    return { _tag: "Failed", messages, ...meta };
  }
  // A body cut at the byte cap hides any `errors` past the cut and cannot be decoded.
  if (status >= 200 && status < 300 && !input.truncated)
    return { _tag: "Ok", value: body, ...meta };
  return { _tag: "Failed", ...meta };
};

const make = Effect.gen(function* () {
  const rest = yield* GitHubRest.GitHubRest;
  const policy = yield* GitHubRequestPolicy.GitHubRequestPolicy;
  const httpClient = yield* HttpClient.HttpClient;

  const graphql = Effect.fn("WorkGitHubApi.graphql")(function* (input: GitHubGraphQlInput) {
    const host = normalizeHost(input.host);
    const allowReserve = input.allowReserve ?? (yield* SourceControlRateLimit.Interactive);
    // The document's hash, never its variables: user text (bodies, search terms) travels there.
    yield* Effect.annotateCurrentSpan({
      "github.kind": "graphql",
      "github.operation": input.operation,
      "github.graphql.query_hash": queryHash(input.query),
    });
    const request = HttpClientRequest.post(GitHubRequestPolicy.gitHubApiUrls(host).graphql).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyJsonUnsafe({ query: input.query, variables: input.variables ?? {} }),
    );
    return yield* policy.request(
      { host, operation: input.operation, resource: "graphql", allowReserve },
      (headers) =>
        Effect.gen(function* () {
          const response: HttpClientResponse.HttpClientResponse = yield* httpClient
            .execute(request.pipe(HttpClientRequest.setHeaders(headers)))
            .pipe(
              // Client spans would add url.full and url.query; the policy's span is the request's.
              Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            );
          const collected = yield* collectUint8StreamText({
            stream: response.stream,
            maxBytes: input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
          }).pipe(
            Effect.catchIf(
              (error) => error.reason._tag === "EmptyBodyError",
              () => Effect.succeed({ text: "", truncated: false, invalidUtf8: false }),
            ),
          );
          return classify({
            status: response.status,
            headers: response.headers,
            body: collected.text,
            truncated: collected.truncated,
          });
        }).pipe(
          Effect.mapError(
            (cause) =>
              new GitHubRequestPolicy.GitHubApiRequestError({
                host,
                operation: input.operation,
                cause,
              }),
          ),
        ),
    );
  });

  return WorkGitHubApi.of({
    graphql,
    rest: rest.rest,
    credential: rest.credential,
  });
});

/**
 * Work's GitHub client: REST, request policy, credentials and quota, over the `gh`-aware HTTP
 * client the GitHub driver uses. The driver keeps its own instance private, so Work tracks its
 * own per-host quota; host pauses are shared through `SourceControlRateLimit`.
 */
export const layer = Layer.effect(WorkGitHubApi, make).pipe(
  Layer.provide(GitHubRest.layerWithDependencies),
  Layer.provide(GitHubHttpClient.layer),
);
