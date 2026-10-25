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
 * `withTotal` is false, as some servers do. `afterRead` runs after each page is served, to change
 * the comments between pages; `servedFrom` stands in for a server that answers another offset.
 */
const fakeJira = (
  comments: Array<unknown>,
  options: {
    readonly withTotal?: boolean;
    readonly afterRead?: (reads: number) => void;
    readonly servedFrom?: (startAt: number) => number;
    readonly totalOverride?: number;
  } = {},
) => {
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
      const served = options.servedFrom?.(startAt) ?? startAt;
      const newestFirst = comments.toReversed();
      const page = newestFirst.slice(served, served + pageCap);
      const total = options.totalOverride ?? comments.length;
      options.afterRead?.(starts.length);
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            startAt: served,
            ...(options.withTotal === false ? {} : { total }),
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

/** `count` comments newer than the `after` already on the issue, oldest first. */
const newer = (after: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `c${after + index + 1}`,
    body: adf("A new comment."),
    created: "2026-10-25T09:00:00.000+0000",
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
      // Jira served 50 a page though 100 were asked for; each page after the first starts at
      // the last comment already read.
      assert.deepStrictEqual(fake.starts, [0, 49, 98]);
    }),
  );

  it.effect("answers none once the total is read, or at an empty page without one", () =>
    Effect.gen(function* () {
      const counted = fakeJira(numbered(120));
      const withTotal = yield* adapterWith(counted);
      assert.isTrue(Option.isNone(yield* withTotal.findComment(runtime, issue, "comment-121 ")));
      assert.deepStrictEqual(counted.starts, [0, 49, 98]);

      const uncounted = fakeJira(numbered(120), { withTotal: false });
      const withoutTotal = yield* adapterWith(uncounted);
      assert.isTrue(Option.isNone(yield* withoutTotal.findComment(runtime, issue, "comment-121 ")));
      assert.deepStrictEqual(uncounted.starts, [0, 49, 98, 119]);

      const empty = fakeJira([], { withTotal: false });
      const withoutComments = yield* adapterWith(empty);
      assert.isTrue(
        Option.isNone(yield* withoutComments.findComment(runtime, issue, "comment-001 ")),
      );
      assert.deepStrictEqual(empty.starts, [0]);
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

  it.effect("still finds a comment after one already read is deleted between pages", () =>
    Effect.gen(function* () {
      // 100 comments; the one asked for is the 51st newest, just past the first page.
      const comments: Array<unknown> = numbered(100);
      const fake = fakeJira(comments, {
        afterRead: (reads) => {
          if (reads === 1) comments.pop();
        },
      });
      const adapter = yield* adapterWith(fake);
      const found = yield* adapter.findComment(runtime, issue, "comment-050 ");
      assert.deepStrictEqual(
        Option.map(found, ({ id }) => id),
        Option.some("c50"),
      );
      // The second page no longer held the last comment read, so the walk started over.
      assert.deepStrictEqual(fake.starts, [0, 49, 0]);
    }),
  );

  it.effect("goes on past comments added between pages without skipping one", () =>
    Effect.gen(function* () {
      const added = (comments: Array<unknown>) => (reads: number) => {
        if (reads === 1) {
          comments.push({
            id: `c${comments.length + 1}`,
            body: adf("A new comment."),
            created: "2026-10-25T09:00:00.000+0000",
          });
        }
      };
      const comments: Array<unknown> = numbered(120);
      const fake = fakeJira(comments, { afterRead: added(comments) });
      const adapter = yield* adapterWith(fake);
      assert.isTrue(Option.isNone(yield* adapter.findComment(runtime, issue, "comment-200 ")));
      // The added comment pushed the last one read to the second page's second place.
      assert.deepStrictEqual(fake.starts, [0, 49, 98]);

      // The comment right after the last one the first page read is still found.
      const more: Array<unknown> = numbered(120);
      const again = fakeJira(more, { afterRead: added(more) });
      const second = yield* adapterWith(again);
      assert.deepStrictEqual(
        Option.map(yield* second.findComment(runtime, issue, "comment-070 "), ({ id }) => id),
        Option.some("c70"),
      );
      assert.deepStrictEqual(again.starts, [0, 49]);
    }),
  );

  it.effect("starts over when, without a total, a page ends at the last comment read", () =>
    Effect.gen(function* () {
      // 49 comments added after the first page push the 50 it read whole onto the next one,
      // which ends at the last comment read with nothing new though older ones are unread.
      const comments: Array<unknown> = numbered(120);
      const fake = fakeJira(comments, {
        withTotal: false,
        afterRead: (reads) => {
          if (reads === 1) comments.push(...newer(comments.length, 49));
        },
      });
      const adapter = yield* adapterWith(fake);
      const found = yield* adapter.findComment(runtime, issue, "comment-010 ");
      assert.deepStrictEqual(
        Option.map(found, ({ id }) => id),
        Option.some("c10"),
      );
      assert.deepStrictEqual(fake.starts, [0, 49, 0, 49, 98, 147]);
    }),
  );

  it.effect("cannot answer, without a total, while added comments keep repeating a page", () =>
    Effect.gen(function* () {
      const comments: Array<unknown> = numbered(120);
      const fake = fakeJira(comments, {
        withTotal: false,
        afterRead: (reads) => {
          if (reads % 2 === 1) comments.push(...newer(comments.length, 49));
        },
      });
      const adapter = yield* adapterWith(fake);
      const error = yield* Effect.flip(adapter.findComment(runtime, issue, "comment-010 "));
      assert.strictEqual(error._tag, "WorkUnavailable");
      // Three walks, each ending on a second page of comments it had already read.
      assert.deepStrictEqual(fake.starts, [0, 49, 0, 49, 0, 49]);
    }),
  );

  it.effect("cannot answer while comments keep changing under the walk", () =>
    Effect.gen(function* () {
      const comments: Array<unknown> = numbered(100);
      const fake = fakeJira(comments, {
        afterRead: (reads) => {
          if (reads % 2 === 1) comments.pop();
        },
      });
      const adapter = yield* adapterWith(fake);
      const error = yield* Effect.flip(adapter.findComment(runtime, issue, "comment-001 "));
      assert.strictEqual(error._tag, "WorkUnavailable");
      assert.deepStrictEqual(fake.starts, [0, 49, 0, 49, 0, 49]);
    }),
  );

  it.effect("does not take an empty page short of its total for the end", () =>
    Effect.gen(function* () {
      const fake = fakeJira([], { totalOverride: 5 });
      const adapter = yield* adapterWith(fake);
      const error = yield* Effect.flip(adapter.findComment(runtime, issue, "comment-001 "));
      assert.strictEqual(error._tag, "WorkUnavailable");
    }),
  );

  it.effect("fails when Jira answers a page from another offset", () =>
    Effect.gen(function* () {
      const fake = fakeJira(numbered(120), { servedFrom: () => 0 });
      const adapter = yield* adapterWith(fake);
      const error = yield* Effect.flip(adapter.findComment(runtime, issue, "comment-010 "));
      assert.strictEqual(error._tag, "WorkUnavailable");
      assert.deepStrictEqual(fake.starts, [0, 49]);
    }),
  );
});
