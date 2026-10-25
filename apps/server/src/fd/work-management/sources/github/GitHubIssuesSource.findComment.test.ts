import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import type { WorkSourceRuntime } from "../WorkSourceAdapter.ts";
import * as GitHubIssuesSource from "./GitHubIssuesSource.ts";

const runtime: WorkSourceRuntime = {
  sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
  projectId: ProjectId.make("p"),
  kind: "github",
  identity: "github.com/acme/app",
  config: { kind: "github", host: "github.com", owner: "acme", name: "app" },
  rootPath: "/repo",
  secret: undefined,
  interactive: false,
};
const issue = WorkItemId.make("7");

const comment = (n: number) => ({
  id: `IC_${n}`,
  body: `comment-${String(n).padStart(3, "0")} on the export.`,
  createdAt: "2026-10-20T10:00:00Z",
  updatedAt: null,
  author: { login: "ann" },
});

/** Pages of an issue with 100 comments: the newest 51-100, then 1-50, keyed by `before`. */
const pages: Record<string, unknown> = {
  newest: {
    pageInfo: { hasPreviousPage: true, startCursor: "C51" },
    nodes: Array.from({ length: 50 }, (_, index) => comment(index + 51)),
  },
  C51: {
    pageInfo: { hasPreviousPage: false, startCursor: "C1" },
    nodes: Array.from({ length: 50 }, (_, index) => comment(index + 1)),
  },
};

/** The GitHub API answering the comment pages, recording the `before` of each request. */
const stub = (page: (before: string | null) => unknown) => {
  const befores: Array<string | null> = [];
  const layer = Layer.mock(GitHubApi.GitHubApi)({
    graphql: (input) =>
      Effect.sync(() => {
        const before = (input.variables?.before ?? null) as string | null;
        befores.push(before);
        const comments = page(before);
        return JSON.stringify({
          data: { repository: { issue: comments === null ? null : { comments } } },
        });
      }),
    credential: () => Effect.succeed({ token: Redacted.make("token"), fingerprint: "fp" }),
  });
  return { befores, layer };
};

const find = (api: ReturnType<typeof stub>, text: string, itemId = issue) =>
  GitHubIssuesSource.make({ writeSpacingMs: 0 }).pipe(
    Effect.flatMap((adapter) => adapter.findComment(runtime, itemId, text)),
    Effect.provide(api.layer),
  );

const twoPages = () => stub((before) => pages[before ?? "newest"]);

describe("GitHubIssuesSource findComment", () => {
  it.effect("walks back from the newest page until it finds the comment", () =>
    Effect.gen(function* () {
      const api = twoPages();
      const found = yield* find(api, "comment-010 ");
      assert.deepStrictEqual(
        Option.map(found, ({ id }) => id),
        Option.some("IC_10"),
      );
      assert.deepStrictEqual(api.befores, [null, "C51"]);
    }),
  );

  it.effect("stops at the page that holds the comment", () =>
    Effect.gen(function* () {
      const api = twoPages();
      assert.isTrue(Option.isSome(yield* find(api, "comment-090 ")));
      assert.deepStrictEqual(api.befores, [null]);
    }),
  );

  it.effect("answers none only after reading the oldest page", () =>
    Effect.gen(function* () {
      const api = twoPages();
      assert.isTrue(Option.isNone(yield* find(api, "comment-101 ")));
      assert.deepStrictEqual(api.befores, [null, "C51"]);
    }),
  );

  it.effect("fails rather than answer for pages it cannot reach", () =>
    Effect.gen(function* () {
      const api = stub(() => ({
        pageInfo: { hasPreviousPage: true, startCursor: null },
        nodes: [comment(100)],
      }));
      const error = yield* Effect.flip(find(api, "comment-010 "));
      assert.strictEqual(error._tag, "WorkUnavailable");
    }),
  );

  it.effect("refuses an issue the repository does not hold", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        find(
          stub(() => null),
          "comment-010 ",
        ),
      );
      assert.strictEqual(error._tag, "WorkItemNotFound");
    }),
  );
});
