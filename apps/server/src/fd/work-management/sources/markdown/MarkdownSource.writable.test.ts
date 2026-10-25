import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import { WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import type { WorkActor } from "../../authority.ts";
import { canWriteMarkdownItem } from "../../index.ts";
import * as MarkdownSource from "./MarkdownSource.ts";

const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const actor: WorkActor = { id: "session:test", grants: [], label: "Artem" };

/** Titles and bodies, and whether a Markdown source stores them as written. */
const samples: ReadonlyArray<
  readonly [name: string, input: { title: string; body: string }, writable: boolean]
> = [
  ["plain text", { title: "Export rows", body: "Export the visible rows.\n" }, true],
  ["a quote", { title: "Export rows", body: "> A quoted note.\n" }, true],
  [
    "conflict marker lines behind a backslash",
    { title: "Export rows", body: "\\<<<<<<< HEAD\n\\=======\n\\>>>>>>> topic\n" },
    true,
  ],
  ["a conflict marker line", { title: "Export rows", body: "<<<<<<< HEAD\nours\n" }, false],
  [
    "half a surrogate pair in the body",
    { title: "Export rows", body: "Rows \ud800 here.\n" },
    false,
  ],
  ["a whole surrogate pair in the body", { title: "Export rows", body: "Rows 😀 here.\n" }, true],
  ["a line separator in the title", { title: "Export rows", body: "" }, false],
  ["half a surrogate pair in the title", { title: "Export \udc00 rows", body: "" }, false],
];

describe("canWriteMarkdownItem", () => {
  it.effect("answers as a Markdown source's create does", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "work-markdown-writable-" });
      const adapter = yield* MarkdownSource.make;
      const runtime = {
        sourceId,
        projectId: ProjectId.make("project-1"),
        kind: "markdown",
        identity: "work",
        config: { kind: "markdown", directory: "work", autoStart: false },
        rootPath: root,
        secret: undefined,
        interactive: true,
      } as const;
      yield* adapter.prepare(runtime);
      for (const [name, input, writable] of samples) {
        assert.strictEqual(canWriteMarkdownItem(input), writable, name);
        const created = yield* Effect.result(
          adapter.create(runtime, { sourceId, ...input }, actor),
        );
        assert.strictEqual(created._tag === "Success", writable, `${name}: create`);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
