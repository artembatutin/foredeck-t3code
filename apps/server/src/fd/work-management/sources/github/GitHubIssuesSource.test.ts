import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

import { owner } from "../../testkit/fakes.ts";
import type { WorkSourceRuntime } from "../WorkSourceAdapter.ts";
import * as GitHubIssuesSource from "./GitHubIssuesSource.ts";

const sourceId = WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4");
const runtime: WorkSourceRuntime = {
  sourceId,
  projectId: ProjectId.make("p"),
  kind: "github",
  identity: "github.com/acme/app",
  config: { kind: "github", host: "github.com", owner: "acme", name: "app" },
  rootPath: "/repo",
  secret: undefined,
  interactive: true,
};

const issue = (number: number, overrides: Record<string, unknown> = {}) => ({
  id: `I_${number}`,
  number,
  title: `Issue ${number}`,
  state: "OPEN",
  stateReason: null,
  url: `https://github.com/acme/app/issues/${number}`,
  updatedAt: "2026-10-20T10:00:00Z",
  labels: { nodes: [{ name: "bug" }] },
  assignees: { nodes: [] },
  parent: null,
  issueDependenciesSummary: { totalBlockedBy: 0 },
  blockedBy: { nodes: [] },
  ...overrides,
});

const detailBody = (number: number, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    data: {
      repository: {
        issue: {
          ...issue(number, overrides),
          body: "Body",
          subIssues: { nodes: [] },
          blocking: { nodes: [] },
          comments: { totalCount: 0, nodes: [] },
        },
      },
    },
  });

interface Call {
  readonly kind: "graphql" | "rest";
  readonly operation: string;
  readonly method?: string;
  readonly path?: string;
  readonly body?: unknown;
  readonly query?: string;
  readonly variables?: Record<string, unknown>;
  readonly allowReserve?: boolean;
  /** When the request was sent, on the test clock. */
  readonly at?: number;
}

/** A GitHubApi whose answers come from a handler per operation. */
const stubApi = (answer: (call: Call) => Effect.Effect<string, GitHubApi.GitHubApiError>) => {
  const calls: Array<Call> = [];
  const layer = Layer.mock(GitHubApi.GitHubApi)({
    graphql: (input) => {
      const call: Call = {
        kind: "graphql",
        operation: input.operation,
        query: input.query,
        ...(input.variables === undefined ? {} : { variables: { ...input.variables } }),
        ...(input.allowReserve === undefined ? {} : { allowReserve: input.allowReserve }),
      };
      calls.push(call);
      return answer(call);
    },
    rest: (input) =>
      Effect.gen(function* () {
        const call: Call = {
          kind: "rest",
          operation: input.operation,
          method: input.method ?? "GET",
          path: input.path,
          body: input.body,
          at: yield* Clock.currentTimeMillis,
        };
        calls.push(call);
        return call;
      }).pipe(
        Effect.flatMap(answer),
        Effect.map((body) => ({
          status: 200,
          headers: {},
          body,
          truncated: false,
          invalidUtf8: false,
        })),
      ),
    credential: () => Effect.succeed({ token: Redacted.make("token"), fingerprint: "fp" }),
  });
  return { calls, layer };
};

const adapterWith = (api: ReturnType<typeof stubApi>, writeSpacingMs = 0) =>
  GitHubIssuesSource.make({ writeSpacingMs }).pipe(Effect.provide(api.layer));

/** The REST issue a fresh assignee read answers with. */
const restIssue = (number: number, assignees: ReadonlyArray<string>) =>
  JSON.stringify({
    number,
    node_id: `I_${number}`,
    updated_at: "2026-10-20T10:00:00Z",
    assignees: assignees.map((login) => ({ login })),
  });

/**
 * Moves the test clock a second at a time, so a fiber that only starts sleeping after an earlier
 * one wakes still wakes at its own deadline.
 */
const advanceSeconds = (seconds: number) =>
  Effect.forEach(Array.from({ length: seconds }), () => TestClock.adjust("1 second"), {
    discard: true,
  });

const isWrite = (call: Call) => call.kind === "rest" && call.method !== "GET";

describe("GitHubIssuesSource", () => {
  it.effect(
    "lists through the issue connection with its cursor and never shows pull requests",
    () =>
      Effect.gen(function* () {
        const api = stubApi(() =>
          Effect.succeed(
            JSON.stringify({
              data: {
                repository: {
                  issues: {
                    pageInfo: { hasNextPage: true, endCursor: "CUR2" },
                    nodes: [issue(1), issue(2, { state: "CLOSED", stateReason: "DUPLICATE" })],
                  },
                },
              },
            }),
          ),
        );
        const adapter = yield* adapterWith(api);
        const result = yield* adapter.list(runtime, { sourceId, limit: 50, cursor: "CUR1" });
        assert.deepStrictEqual(
          result.items.map((item) => [item.key, item.status]),
          [
            ["#1", "todo"],
            ["#2", "cancelled"],
          ],
        );
        assert.strictEqual(result.nextCursor, "CUR2");
        const [call] = api.calls;
        assert.strictEqual(call?.operation, "work.issues.list");
        assert.strictEqual(call?.variables?.after, "CUR1");
        assert.strictEqual(call?.allowReserve, true);
        assert.include(call?.query ?? "", "orderBy: { field: UPDATED_AT, direction: DESC }");
      }),
  );

  it.effect("searches with repository and filter qualifiers", () =>
    Effect.gen(function* () {
      const api = stubApi((call) =>
        call.kind === "rest"
          ? Effect.succeed(JSON.stringify({ login: "octo" }))
          : Effect.succeed(
              JSON.stringify({
                data: {
                  search: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [issue(3), {}],
                  },
                },
              }),
            ),
      );
      const adapter = yield* adapterWith(api);
      const result = yield* adapter.list(runtime, {
        sourceId,
        limit: 20,
        search: 'crash "now"',
        statuses: ["todo"],
        labels: ["bug"],
        assignee: "me",
      });
      assert.deepStrictEqual(
        result.items.map((item) => item.key),
        ["#3"],
      );
      const search = api.calls.find((call) => call.operation === "work.issues.search");
      assert.strictEqual(
        search?.variables?.query,
        'repo:acme/app is:issue sort:updated-desc is:open label:"bug" assignee:octo crash  now',
      );
    }),
  );

  it.effect("reads a status only asking for in-progress as empty without a request", () =>
    Effect.gen(function* () {
      const api = stubApi(() => Effect.die("no request expected"));
      const adapter = yield* adapterWith(api);
      const result = yield* adapter.list(runtime, {
        sourceId,
        limit: 50,
        statuses: ["in_progress"],
      });
      assert.deepStrictEqual(result.items, []);
      assert.strictEqual(api.calls.length, 0);
    }),
  );

  it.effect("changes labels through the add and remove endpoints and refuses a stale edit", () =>
    Effect.gen(function* () {
      let updatedAt = "2026-10-20T10:00:00Z";
      const api = stubApi((call) =>
        call.kind === "graphql"
          ? Effect.succeed(detailBody(7, { updatedAt }))
          : Effect.succeed("{}"),
      );
      const adapter = yield* adapterWith(api);
      const itemId = WorkItemId.make("7");
      yield* adapter.update(
        runtime,
        { ref: { sourceId, itemId }, labels: { add: ["p1"], remove: ["bug", "a/b"] } },
        owner,
      );
      const writes = api.calls.filter((call) => call.kind === "rest");
      assert.deepStrictEqual(
        writes.map((call) => [call.method, call.path, call.body]),
        [
          ["POST", "repos/acme/app/issues/7/labels", { labels: ["p1"] }],
          ["DELETE", "repos/acme/app/issues/7/labels/bug", undefined],
          ["DELETE", "repos/acme/app/issues/7/labels/a%2Fb", undefined],
        ],
      );

      const before = `${updatedAt}|I_7`;
      updatedAt = "2026-10-21T10:00:00Z";
      const stale = yield* Effect.flip(
        adapter.update(
          runtime,
          { ref: { sourceId, itemId }, title: "New", expectedRevision: before },
          owner,
        ),
      );
      assert.strictEqual(stale._tag, "WorkStale");
    }),
  );

  it.effect("writes statuses as state and reason, and has no in-progress", () =>
    Effect.gen(function* () {
      const api = stubApi((call) =>
        call.kind === "graphql" ? Effect.succeed(detailBody(9)) : Effect.succeed("{}"),
      );
      const adapter = yield* adapterWith(api);
      const ref = { sourceId, itemId: WorkItemId.make("9") };
      yield* adapter.setStatus(runtime, { ref, status: "cancelled" }, owner);
      const patch = api.calls.find((call) => call.method === "PATCH");
      assert.deepStrictEqual(patch?.body, { state: "closed", state_reason: "not_planned" });
      const refused = yield* Effect.flip(
        adapter.setStatus(runtime, { ref, status: "in_progress" }, owner),
      );
      assert.strictEqual(refused._tag, "WorkUnsupported");
    }),
  );

  it.effect("maps GitHub failures to Work reasons", () =>
    Effect.gen(function* () {
      const failWith = (error: GitHubApi.GitHubApiError) =>
        adapterWith(stubApi(() => Effect.fail(error))).pipe(
          Effect.flatMap((adapter) => Effect.flip(adapter.get(runtime, WorkItemId.make("5")))),
        );
      const base = { host: "github.com", operation: "work.issue" };
      assert.strictEqual(
        (yield* failWith(new GitHubApi.GitHubApiAuthenticationError(base)))._tag,
        "WorkUnauthenticated",
      );
      assert.strictEqual(
        (yield* failWith(new GitHubApi.GitHubApiResponseError({ ...base, status: 403 })))._tag,
        "WorkForbidden",
      );
      const moved = yield* failWith(new GitHubApi.GitHubApiResponseError({ ...base, status: 301 }));
      assert.strictEqual(moved._tag, "WorkItemNotFound");
      assert.include(moved.message, "transferred");
      assert.strictEqual(
        (yield* failWith(new GitHubApi.GitHubApiResponseError({ ...base, status: 410 })))._tag,
        "WorkItemNotFound",
      );
      const limited = yield* failWith(
        new GitHubApi.GitHubApiRateLimitError({
          ...base,
          retryAt: Date.parse("2026-10-21T12:00:00Z"),
        }),
      );
      assert.strictEqual(limited._tag, "WorkRateLimited");
      assert.include(limited.message, "2026-10-21T12:00:00.000Z");
    }),
  );

  it.effect("falls back to basic fields when an older server lacks dependency fields", () =>
    Effect.gen(function* () {
      const api = stubApi((call) =>
        (call.query ?? "").includes("issueDependenciesSummary")
          ? Effect.fail(
              new GitHubApi.GitHubApiResponseError({
                host: "github.com",
                operation: call.operation,
                status: 200,
                githubErrors: ["Field 'issueDependenciesSummary' doesn't exist on type 'Issue'"],
              }),
            )
          : Effect.succeed(
              detailBody(4, {
                parent: undefined,
                issueDependenciesSummary: undefined,
                blockedBy: undefined,
              }),
            ),
      );
      const adapter = yield* adapterWith(api);
      const detail = yield* adapter.get(runtime, WorkItemId.make("4"));
      assert.strictEqual(detail.key, "#4");
      assert.isFalse(detail.blocked);
      // The host is remembered: the next read goes straight to the basic set.
      yield* adapter.get(runtime, WorkItemId.make("4"));
      assert.strictEqual(api.calls.length, 3);
    }),
  );

  it.effect("derives blocked from open blockers and maps people", () =>
    Effect.gen(function* () {
      const api = stubApi(() =>
        Effect.succeed(
          detailBody(6, {
            issueDependenciesSummary: { totalBlockedBy: 1 },
            blockedBy: { nodes: [{ number: 2, state: "OPEN" }] },
            assignees: { nodes: [{ login: "octo", name: "Octo Cat" }] },
          }),
        ),
      );
      const adapter = yield* adapterWith(api);
      const detail = yield* adapter.get(runtime, WorkItemId.make("6"));
      assert.isTrue(detail.blocked);
      assert.deepStrictEqual([...detail.blockedBy], [WorkItemId.make("2")]);
      assert.deepStrictEqual(detail.assignee, { id: "octo", label: "Octo Cat" });
      assert.strictEqual(detail.revision, "2026-10-20T10:00:00Z|I_6");
    }),
  );
  it.effect("spaces every request of a multi-request update and of a queued write", () =>
    Effect.gen(function* () {
      const api = stubApi((call) =>
        call.kind === "graphql"
          ? Effect.succeed(detailBody(7))
          : call.method === "GET"
            ? Effect.succeed(restIssue(7, ["ann", "bob"]))
            : call.operation === "work.issue.comment"
              ? Effect.succeed(JSON.stringify({ id: 99 }))
              : Effect.succeed("{}"),
      );
      const adapter = yield* adapterWith(api, 1_000);
      const ref = { sourceId, itemId: WorkItemId.make("7") };
      const update = yield* adapter
        .update(
          runtime,
          {
            ref,
            title: "New",
            labels: { add: ["p1"], remove: ["bug"] },
            assignee: "cat",
          },
          owner,
        )
        .pipe(Effect.forkChild);
      const comment = yield* adapter
        .comment(runtime, ref.itemId, "hi", owner)
        .pipe(Effect.forkChild);
      yield* advanceSeconds(60);
      yield* Fiber.join(update);
      yield* Fiber.join(comment);
      const writes = api.calls.filter(isWrite);
      assert.deepStrictEqual(
        writes.map((call) => [call.operation, call.at]),
        [
          ["work.issue.update", 0],
          ["work.issue.labels.add", 1_000],
          ["work.issue.labels.remove", 2_000],
          ["work.issue.assignees.remove", 3_000],
          ["work.issue.assignees.add", 4_000],
          ["work.issue.comment", 5_000],
        ],
      );
    }),
  );

  it.effect("clears or replaces every assignee from a fresh read, not only the first", () =>
    Effect.gen(function* () {
      const api = stubApi((call) =>
        call.kind === "graphql"
          ? // The summary only names the first assignee.
            Effect.succeed(detailBody(8, { assignees: { nodes: [{ login: "ann" }] } }))
          : call.method === "GET"
            ? Effect.succeed(restIssue(8, ["ann", "Bob", "cat"]))
            : Effect.succeed("{}"),
      );
      const adapter = yield* adapterWith(api);
      const ref = { sourceId, itemId: WorkItemId.make("8") };
      const assigneeWrites = () =>
        api.calls
          .filter((call) => isWrite(call) && call.path === "repos/acme/app/issues/8/assignees")
          .map((call) => [call.method, call.body]);

      yield* adapter.update(runtime, { ref, assignee: null }, owner);
      assert.deepStrictEqual(assigneeWrites(), [["DELETE", { assignees: ["ann", "Bob", "cat"] }]]);
      const read = api.calls.find((call) => call.operation === "work.issue.assignees");
      assert.deepStrictEqual([read?.method, read?.path], ["GET", "repos/acme/app/issues/8"]);

      api.calls.length = 0;
      yield* adapter.update(runtime, { ref, assignee: "dan" }, owner);
      assert.deepStrictEqual(assigneeWrites(), [
        ["DELETE", { assignees: ["ann", "Bob", "cat"] }],
        ["POST", { assignees: ["dan"] }],
      ]);

      // Keeping one of them removes the rest and adds nothing; logins ignore case.
      api.calls.length = 0;
      yield* adapter.update(runtime, { ref, assignee: "bob" }, owner);
      assert.deepStrictEqual(assigneeWrites(), [["DELETE", { assignees: ["ann", "cat"] }]]);
    }),
  );

  it.effect("reads only decimal issue numbers, so no other spelling reaches an issue", () =>
    Effect.gen(function* () {
      const api = stubApi((call) =>
        call.kind === "graphql" ? Effect.succeed(detailBody(1)) : Effect.succeed("{}"),
      );
      const adapter = yield* adapterWith(api);
      for (const spelling of ["1e0", "0x1", "1.0"]) {
        const itemId = WorkItemId.make(spelling);
        const ref = { sourceId, itemId };
        assert.strictEqual(
          (yield* Effect.flip(adapter.get(runtime, itemId)))._tag,
          "WorkItemNotFound",
        );
        assert.strictEqual(
          (yield* Effect.flip(adapter.setStatus(runtime, { ref, status: "done" }, owner)))._tag,
          "WorkItemNotFound",
        );
        assert.strictEqual(
          (yield* Effect.flip(adapter.comment(runtime, itemId, "hi", owner)))._tag,
          "WorkItemNotFound",
        );
      }
      assert.deepStrictEqual(api.calls, []);
      assert.strictEqual((yield* adapter.get(runtime, WorkItemId.make("1"))).ref.itemId, "1");
    }),
  );
});
