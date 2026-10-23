import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";

import { owner } from "../../testkit/fakes.ts";
import type { WorkSourceRuntime } from "../WorkSourceAdapter.ts";
import { SCOPED_TOKEN_MESSAGE } from "./JiraApi.ts";
import * as JiraSource from "./JiraSource.ts";

const TOKEN = "super-secret-token";
const sourceId = WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4");
const runtime = (overrides: Partial<WorkSourceRuntime> = {}): WorkSourceRuntime => ({
  sourceId,
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
  secret: TOKEN,
  interactive: false,
  ...overrides,
});

interface Answer {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly authorization: string | undefined;
}

const issueJson = (key: string, overrides: Record<string, unknown> = {}) => ({
  id: "10001",
  key,
  fields: {
    summary: "Fix login",
    status: { id: "3", name: "In Review", statusCategory: { key: "indeterminate" } },
    resolution: null,
    assignee: { accountId: "acc-1", displayName: "Ann" },
    priority: { name: "Highest" },
    parent: null,
    updated: "2026-10-20T10:00:00.000+0000",
    labels: ["auth"],
    issuelinks: [],
    description: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Steps" }] }],
    },
    ...overrides,
  },
});

const decoder = new TextDecoder();

/** A fake Jira: answers come from a handler that sees each request. */
const fakeJira = (answer: (seen: Seen) => Answer) => {
  const seen: Array<Seen> = [];
  const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const entry: Seen = {
        method: request.method,
        path: url.pathname,
        body:
          request.body._tag === "Uint8Array"
            ? (JSON.parse(decoder.decode(request.body.body)) as unknown)
            : undefined,
        authorization: request.headers.authorization,
      };
      seen.push(entry);
      const result = answer(entry);
      return HttpClientResponse.fromWeb(
        request,
        new Response(result.body === undefined ? null : JSON.stringify(result.body), {
          status: result.status ?? 200,
          headers: result.headers ?? {},
        }),
      );
    }),
  );
  const layer = Layer.merge(
    Layer.succeed(HttpClient.HttpClient, client),
    SourceControlRateLimit.layer,
  );
  return { seen, layer };
};

const adapterWith = (fake: ReturnType<typeof fakeJira>) =>
  JiraSource.make({ readRetries: 0, issueWriteSpacingMs: 0 }).pipe(Effect.provide(fake.layer));

describe("JiraSource", () => {
  it.effect("searches with explicit fields and maps issues", () =>
    Effect.gen(function* () {
      const fake = fakeJira(() => ({
        body: {
          issues: [
            issueJson("proj-7", {
              status: { name: "Closed", statusCategory: { key: "done" } },
              resolution: { name: "Won't Do" },
              issuelinks: [
                {
                  type: { name: "Blocks" },
                  inwardIssue: {
                    key: "PROJ-1",
                    fields: { status: { statusCategory: { key: "new" } } },
                  },
                },
                {
                  type: { name: "Blocks" },
                  inwardIssue: {
                    key: "PROJ-2",
                    fields: { status: { statusCategory: { key: "done" } } },
                  },
                },
              ],
            }),
          ],
          nextPageToken: "T2",
        },
      }));
      const adapter = yield* adapterWith(fake);
      const result = yield* adapter.list(runtime(), { sourceId, limit: 20, statuses: ["todo"] });
      const [item] = result.items;
      assert.strictEqual(item?.key, "PROJ-7");
      assert.strictEqual(item?.ref.itemId, "PROJ-7");
      assert.strictEqual(item?.status, "cancelled");
      assert.strictEqual(item?.priority, "high");
      assert.deepStrictEqual([...(item?.blockedBy ?? [])], ["PROJ-1"]);
      assert.isTrue(item?.blocked);
      assert.strictEqual(item?.url, "https://acme.atlassian.net/browse/PROJ-7");
      assert.strictEqual(item?.updatedAt, "2026-10-20T10:00:00.000Z");
      assert.strictEqual(result.nextCursor, "T2");
      const [request] = fake.seen;
      assert.strictEqual(request?.path, "/rest/api/3/search/jql");
      assert.deepInclude(request?.body as object, { maxResults: 20 });
      assert.include((request!.body as { jql: string }).jql, "statusCategory in (2)");
      assert.isTrue(request?.authorization?.startsWith("Basic "));
    }),
  );

  it.effect("stops paging when Jira hands back the same token", () =>
    Effect.gen(function* () {
      const fake = fakeJira(() => ({ body: { issues: [], nextPageToken: "SAME" } }));
      const adapter = yield* adapterWith(fake);
      const result = yield* adapter.list(runtime(), { sourceId, limit: 50, cursor: "SAME" });
      assert.isNull(result.nextCursor);
    }),
  );

  it.effect("refuses a site that is not https without sending the token", () =>
    Effect.gen(function* () {
      const fake = fakeJira(() => ({ body: {} }));
      const adapter = yield* adapterWith(fake);
      const insecure = runtime({
        config: {
          kind: "jira",
          siteUrl: "http://acme.atlassian.net",
          projectKey: "PROJ",
          email: "me@acme.test",
        },
      });
      const error = yield* Effect.flip(adapter.list(insecure, { sourceId, limit: 50 }));
      assert.strictEqual(error._tag, "WorkInvalid");
      assert.strictEqual(fake.seen.length, 0);
    }),
  );

  it.effect("pauses the site on a rate limit, but not for a per-issue write limit", () =>
    Effect.gen(function* () {
      let next: Answer = { status: 429, headers: { "retry-after": "30" } };
      const fake = fakeJira(() => next);
      const adapter = yield* adapterWith(fake);
      const limited = yield* Effect.flip(adapter.list(runtime(), { sourceId, limit: 50 }));
      assert.strictEqual(limited._tag, "WorkRateLimited", limited.message);
      next = { body: { issues: [] } };
      // A background read is held back without a request while the site is paused.
      const paused = yield* Effect.flip(adapter.list(runtime(), { sourceId, limit: 50 }));
      assert.strictEqual(paused._tag, "WorkRateLimited");
      assert.strictEqual(fake.seen.length, 1);
      // The owner's own read may still go through.
      yield* adapter.list(runtime({ interactive: true }), { sourceId, limit: 50 });
      assert.strictEqual(fake.seen.length, 2);

      const perIssue = fakeJira((seen) =>
        seen.method === "POST" && seen.path.endsWith("/comment")
          ? {
              status: 429,
              headers: { "retry-after": "30", "ratelimit-reason": "jira-per-issue-on-write" },
            }
          : { body: { issues: [] } },
      );
      const other = yield* adapterWith(perIssue);
      const writeLimited = yield* Effect.flip(
        other.comment(runtime(), WorkItemId.make("PROJ-1"), "hi", owner),
      );
      assert.strictEqual(writeLimited._tag, "WorkRateLimited");
      yield* other.list(runtime(), { sourceId, limit: 50 });
      assert.strictEqual(perIssue.seen.length, 2);
    }),
  );

  it.effect("resolves a status to its unique transition and asks when several fit", () =>
    Effect.gen(function* () {
      let transitions: ReadonlyArray<unknown> = [];
      const fake = fakeJira((seen) => {
        if (seen.path.endsWith("/transitions") && seen.method === "GET") {
          return { body: { transitions } };
        }
        if (seen.path.endsWith("/transitions")) return { status: 204 };
        return { body: issueJson("PROJ-3") };
      });
      const adapter = yield* adapterWith(fake);
      const ref = { sourceId, itemId: WorkItemId.make("proj-3") };

      transitions = [
        { id: "11", name: "Resolve", to: { name: "Done", statusCategory: { key: "done" } } },
        { id: "12", name: "Close", to: { name: "Closed", statusCategory: { key: "done" } } },
      ];
      const conflict = yield* Effect.flip(
        adapter.setStatus(runtime(), { ref, status: "done" }, owner),
      );
      assert.strictEqual(conflict._tag, "WorkConflict");
      assert.deepStrictEqual(
        ((conflict as { candidates?: ReadonlyArray<{ id: string }> }).candidates ?? []).map(
          (entry) => entry.id,
        ),
        ["11", "12"],
      );

      transitions = [
        {
          id: "21",
          name: "Resolve",
          to: { name: "Done", statusCategory: { key: "done" } },
          fields: {
            resolution: {
              required: true,
              allowedValues: [
                { id: "r1", name: "Fixed" },
                { id: "r2", name: "Done" },
              ],
            },
          },
        },
      ];
      yield* adapter.setStatus(runtime(), { ref, status: "done" }, owner);
      const posted = fake.seen.find(
        (seen) => seen.method === "POST" && seen.path.endsWith("/transitions"),
      );
      assert.strictEqual(posted?.path, "/rest/api/3/issue/PROJ-3/transitions");
      assert.deepStrictEqual(posted?.body, {
        transition: { id: "21" },
        fields: { resolution: { id: "r2" } },
      });

      transitions = [
        {
          id: "31",
          name: "Reject",
          to: { name: "Rejected", statusCategory: { key: "done" } },
          fields: { customfield_1: { required: true } },
        },
      ];
      const refused = yield* Effect.flip(
        adapter.setStatus(runtime(), { ref, transitionId: "31" }, owner),
      );
      assert.strictEqual(refused._tag, "WorkUnsupported");
    }),
  );

  it.effect("refuses to overwrite a description it could not show", () =>
    Effect.gen(function* () {
      const fake = fakeJira((seen) =>
        seen.path.endsWith("/comment")
          ? { body: { comments: [] } }
          : {
              body: issueJson("PROJ-4", {
                description: { type: "doc", content: [{ type: "table", content: [] }] },
              }),
            },
      );
      const adapter = yield* adapterWith(fake);
      const detail = yield* adapter.get(runtime(), WorkItemId.make("PROJ-4"));
      assert.strictEqual(detail.bodyFidelity, "lossy");
      const error = yield* Effect.flip(
        adapter.update(
          runtime(),
          {
            ref: { sourceId, itemId: WorkItemId.make("PROJ-4") },
            body: "new",
            expectedRevision: detail.revision,
          },
          owner,
        ),
      );
      assert.strictEqual(error._tag, "WorkUnsupported");
      assert.isFalse(fake.seen.some((seen) => seen.method === "PUT"));
    }),
  );

  it.effect("creates with a preferred issue type and names refused fields", () =>
    Effect.gen(function* () {
      let createAnswer: Answer = { body: { id: "10009", key: "PROJ-9" } };
      const fake = fakeJira((seen) => {
        if (seen.path.endsWith("/issuetypes")) {
          return {
            body: {
              issueTypes: [
                { id: "1", name: "Bug" },
                { id: "2", name: "Sub-task", subtask: true },
                { id: "3", name: "Task" },
              ],
            },
          };
        }
        if (seen.method === "POST" && seen.path === "/rest/api/3/issue") return createAnswer;
        return { body: issueJson("PROJ-9") };
      });
      const adapter = yield* adapterWith(fake);
      const created = yield* adapter.create(
        runtime(),
        { sourceId, title: "New", body: "**Do** it", priority: "low" },
        owner,
      );
      assert.strictEqual(created.key, "PROJ-9");
      const post = fake.seen.find(
        (seen) => seen.method === "POST" && seen.path === "/rest/api/3/issue",
      );
      const fields = (post!.body as { fields: Record<string, unknown> }).fields;
      assert.deepStrictEqual(fields.issuetype, { id: "3" });
      assert.deepStrictEqual(fields.priority, { name: "Low" });
      assert.strictEqual((fields.description as { type: string }).type, "doc");

      createAnswer = { status: 400, body: { errors: { summary: "You must specify a summary." } } };
      const invalid = yield* Effect.flip(
        adapter.create(runtime(), { sourceId, title: "x" }, owner),
      );
      assert.strictEqual(invalid._tag, "WorkInvalid");
      assert.include(invalid.message, "summary: You must specify a summary.");
    }),
  );

  it.effect("explains a rejected token as a scoped one and never echoes it", () =>
    Effect.gen(function* () {
      const fake = fakeJira(() => ({ status: 401, body: { message: TOKEN } }));
      const adapter = yield* adapterWith(fake);
      const error = yield* Effect.flip(
        adapter.test({ config: runtime().config, rootPath: "/repo", secret: TOKEN }),
      );
      assert.strictEqual(error._tag, "WorkUnauthenticated");
      assert.strictEqual(error.message, SCOPED_TOKEN_MESSAGE);
      assert.notInclude(JSON.stringify(error), TOKEN);
      const missing = yield* Effect.flip(
        adapter.list(runtime({ secret: undefined }), { sourceId, limit: 50 }),
      );
      assert.strictEqual(missing._tag, "WorkUnauthenticated");
    }),
  );
});
