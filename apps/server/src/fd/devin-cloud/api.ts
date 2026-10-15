import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

const Timestamp = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 253_402_300_799 }));
const Session = Schema.Struct({
  session_id: Schema.NonEmptyString,
  status: Schema.Literals(["new", "claimed", "running", "exit", "error", "suspended", "resuming"]),
  status_detail: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Timestamp,
  url: Schema.optional(Schema.String),
});
export type CloudSession = typeof Session.Type;
const Message = Schema.Struct({
  event_id: Schema.NonEmptyString,
  source: Schema.Literals(["devin", "user"]),
  message: Schema.String,
  created_at: Timestamp,
});
export type CloudMessage = typeof Message.Type;
const MessagePage = Schema.Struct({
  items: Schema.Array(Message),
  end_cursor: Schema.optional(Schema.NullOr(Schema.String)),
  has_next_page: Schema.optional(Schema.Boolean),
});
const Identity = Schema.Struct({
  principal_type: Schema.NonEmptyString,
  org_id: Schema.optional(Schema.NullOr(Schema.String)),
});

export class DevinCloudApiError extends Schema.TaggedError<DevinCloudApiError>()(
  "DevinCloudApiError",
  {
    operation: Schema.Literals(["authenticate", "create", "read", "messages", "send", "stop"]),
    category: Schema.Literals([
      "authentication",
      "permission",
      "not_found",
      "rate_limit",
      "transport",
      "response",
    ]),
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.category) {
      case "authentication":
        return "Devin Cloud rejected the API key. Configure DEVIN_API_KEY with a valid v3 credential.";
      case "permission":
        return "Devin Cloud denied access. Check the organization and session permissions.";
      case "not_found":
        return "The Devin Cloud session or organization was not found.";
      case "rate_limit":
        return "Devin Cloud is rate limiting requests. Retry shortly.";
      case "transport":
        return "Devin Cloud could not be reached. Retry to reconnect to the existing session.";
      case "response":
        return "Devin Cloud returned an invalid or unsuccessful response.";
    }
  }
}

/** The fixed origin prevents a provider setting from forwarding its credential elsewhere. */
export const makeDevinCloudClient = Effect.fn("makeDevinCloudClient")(function* (input: {
  readonly apiKey: string;
  readonly organizationId: string;
  readonly requestTimeoutMs?: number;
}) {
  const client = yield* HttpClient.HttpClient;
  const root = `https://api.devin.ai/v3/organizations/${encodeURIComponent(input.organizationId)}/sessions`;
  const sessionUrl = (id: string) =>
    `${root}/${encodeURIComponent(id.startsWith("devin-") ? id : `devin-${id}`)}`;
  const request = <A>(
    operation: DevinCloudApiError["operation"],
    method: "GET" | "POST" | "DELETE",
    url: string,
    schema: Schema.Codec<A, unknown>,
    body?: unknown,
  ) =>
    Effect.gen(function* () {
      let req = HttpClientRequest.make(method)(url).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${input.apiKey}`),
        HttpClientRequest.setHeader("Accept", "application/json"),
      );
      if (body !== undefined) req = req.pipe(HttpClientRequest.bodyJsonUnsafe(body));
      const response = yield* client
        .execute(req)
        .pipe(
          Effect.mapError(
            (cause) => new DevinCloudApiError({ operation, category: "transport", cause }),
          ),
        );
      if (response.status < 200 || response.status >= 300) {
        const status = response.status;
        return yield* new DevinCloudApiError({
          operation,
          status,
          category:
            status === 401
              ? "authentication"
              : status === 403
                ? "permission"
                : status === 404
                  ? "not_found"
                  : status === 429
                    ? "rate_limit"
                    : status >= 500
                      ? "transport"
                      : "response",
        });
      }
      const json = yield* response.json.pipe(
        Effect.mapError(
          (cause) => new DevinCloudApiError({ operation, category: "response", cause }),
        ),
      );
      return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(
          (cause) => new DevinCloudApiError({ operation, category: "response", cause }),
        ),
      );
    }).pipe(
      Effect.timeout(input.requestTimeoutMs ?? 30_000),
      Effect.catchTags({
        TimeoutError: (cause) =>
          Effect.fail(new DevinCloudApiError({ operation, category: "transport", cause })),
      }),
    );
  return {
    authenticate: () => request("authenticate", "GET", "https://api.devin.ai/v3/self", Identity),
    checkOrganization: () =>
      request(
        "authenticate",
        "GET",
        `${root}?first=1`,
        Schema.Struct({ items: Schema.Array(Schema.Unknown) }),
      ),
    create: (body: {
      readonly prompt: string;
      readonly title?: string;
      readonly repos: ReadonlyArray<string>;
      readonly max_acu_limit: number;
      readonly devin_mode: string;
    }) => request("create", "POST", root, Session, { ...body, resumable: true }),
    read: (id: string) => request("read", "GET", sessionUrl(id), Session),
    send: (id: string, message: string) =>
      request("send", "POST", `${sessionUrl(id)}/messages`, Session, { message }),
    stop: (id: string) => request("stop", "DELETE", `${sessionUrl(id)}?archive=false`, Session),
    messages: (id: string, after?: string) =>
      Effect.gen(function* () {
        const messages: Array<CloudMessage> = [];
        const cursors = new Set<string>();
        let cursor = after;
        // A bounded history read fails explicitly instead of silently truncating a conversation.
        for (let page = 0; page < 100; page++) {
          const result = yield* request(
            "messages",
            "GET",
            `${sessionUrl(id)}/messages?first=200${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`,
            MessagePage,
          );
          messages.push(...result.items);
          if (!result.has_next_page) return { items: messages, tailCursor: cursor };
          if (!result.end_cursor || cursors.has(result.end_cursor))
            return yield* new DevinCloudApiError({ operation: "messages", category: "response" });
          cursor = result.end_cursor;
          cursors.add(cursor);
        }
        return yield* new DevinCloudApiError({ operation: "messages", category: "response" });
      }),
  };
});
