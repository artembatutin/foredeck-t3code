import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, type HttpClientRequest, HttpClientResponse, UrlParams } from "effect/http";

import { owner } from "../../testkit/fakes.ts";
import type { WorkSourceRuntime } from "../WorkSourceAdapter.ts";
import * as JiraSource from "./JiraSource.ts";

const runtime: WorkSourceRuntime = {
  sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
  projectId: ProjectId.make("p"),
  kind: "jira",
  identity: "acme.atlassian.net/PROJ",
  config: {
    kind: "jira",
    siteUrl: "https://acme.atlassian.net",
    projectKey: "PROJ",
    email: "me@acme.test",
  },
  rootPath: "/repo",
  secret: "token",
  interactive: false,
};
const issue = WorkItemId.make("PROJ-1");

const adf = (text: string) => ({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const decoder = new TextDecoder();

/**
 * A Jira issue whose comments, oldest first, are `comments`; it serves them newest first, at most
 * `pageCap` a page whatever is asked, and takes posted comments. `total` is left out when
 * `withTotal` is false, as some servers do.
 */
const fakeJira = (comments: Array<unknown>, options: { readonly withTotal?: boolean } = {}) => {
  const pageCap = 50;
  const starts: Array<number> = [];
  const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.sync(() => {
      if (request.method === "POST") {
        const posted =
          request.body._tag === "Uint8Array"
            ? (JSON.parse(decoder.decode(request.body.body)) as { readonly body: unknown })
            : { body: null };
        comments.push({
          id: `c${comments.length + 1}`,
          body: posted.body,
          created: "2026-10-25T08:00:00.000+0000",
        });
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ id: `c${comments.length}` }), { status: 201 }),
        );
      }
      const startAt = Number(
        Option.getOrElse(UrlParams.getFirst(request.urlParams, "startAt"), () => "0"),
      );
      starts.push(startAt);
      const newestFirst = comments.toReversed();
      const page = newestFirst.slice(startAt, startAt + pageCap);
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            ...(options.withTotal === false ? {} : { total: comments.length }),
            comments: page,
          }),
          { status: 200 },
        ),
      );
    }),
  );
  const layer = Layer.merge(
    Layer.succeed(HttpClient.HttpClient, client),
    SourceControlRateLimit.layer,
  );
  return { starts, layer };
};

const numbered = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `c${index + 1}`,
    body: adf(`comment-${String(index + 1).padStart(3, "0")} on the export.`),
    created: "2026-10-20T10:00:00.000+0000",
  }));

const adapterWith = (fake: ReturnType<typeof fakeJira>) =>
  JiraSource.make({ readRetries: 0, issueWriteSpacingMs: 0 }).pipe(Effect.provide(fake.layer));

describe("JiraSource findComment", () => {
  it.effect("pages back from the newest comment until it finds the one asked for", () =>
    Effect.gen(function* () {
      const fake = fakeJira(numbered(120));
      const adapter = yield* adapterWith(fake);
      const found = yield* adapter.findComment(runtime, issue, "comment-010 ");
      assert.deepStrictEqual(
        Option.map(found, ({ id }) => id),
        Option.some("c10"),
      );
      // Jira served 50 a page though 100 were asked for; the walk went on from what it got.
      assert.deepStrictEqual(fake.starts, [0, 50, 100]);
    }),
  );

  it.effect("answers none once the total is read, or at an empty page without one", () =>
    Effect.gen(function* () {
      const counted = fakeJira(numbered(120));
      const withTotal = yield* adapterWith(counted);
      assert.isTrue(Option.isNone(yield* withTotal.findComment(runtime, issue, "comment-121 ")));
      assert.deepStrictEqual(counted.starts, [0, 50, 100]);

      const uncounted = fakeJira(numbered(120), { withTotal: false });
      const withoutTotal = yield* adapterWith(uncounted);
      assert.isTrue(Option.isNone(yield* withoutTotal.findComment(runtime, issue, "comment-121 ")));
      assert.deepStrictEqual(uncounted.starts, [0, 50, 100, 120]);
    }),
  );

  it.effect("finds a comment it posted by the text it was posted with", () =>
    Effect.gen(function* () {
      const fake = fakeJira(numbered(60));
      const adapter = yield* adapterWith(fake);
      const reference = "Factory delivery 3f2a8c1e-9b7d-4c2a-8e1f-0a1b2c3d4e5f, update 2.";
      yield* adapter.comment(runtime, issue, `The review blocked this item. ${reference}`, owner);
      assert.isTrue(Option.isSome(yield* adapter.findComment(runtime, issue, reference)));
    }),
  );
});
