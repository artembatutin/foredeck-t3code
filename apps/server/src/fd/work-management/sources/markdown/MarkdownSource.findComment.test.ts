import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { WorkSourceRuntime } from "../WorkSourceAdapter.ts";
import * as MarkdownSource from "./MarkdownSource.ts";

const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const itemId = WorkItemId.make("fd-aaaaaa");

/** A task whose Notes hold `count` notes, `note-001` to `note-<count>`. */
const withNotes = (count: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "work-markdown-find-" });
    const adapter = yield* MarkdownSource.make;
    const runtime: WorkSourceRuntime = {
      sourceId,
      projectId: ProjectId.make("project-1"),
      kind: "markdown",
      identity: "work",
      config: { kind: "markdown", directory: "work", autoStart: false },
      rootPath: root,
      secret: undefined,
      interactive: false,
    };
    yield* adapter.prepare(runtime);
    const notes = Array.from(
      { length: count },
      (_, index) =>
        `- 2026-10-25T08:00:00.000Z (Ann) note-${String(index + 1).padStart(3, "0")} reviewed.`,
    );
    const file = path.join(root, "work", "fd-aaaaaa.md");
    yield* fs.writeFileString(
      file,
      `---\nid: fd-aaaaaa\ntitle: Alpha\nstatus: todo\n---\nBody.\n\n## Notes\n\n${notes.join("\n")}\n`,
    );
    return { fs, file, adapter, runtime };
  });

describe("MarkdownSource findComment", () => {
  it.effect("looks through every note, past the bounded list get returns", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* withNotes(55);
      const detail = yield* adapter.get(runtime, itemId);
      assert.strictEqual(detail.comments.length, 50);
      assert.isTrue(detail.commentsTruncated);

      const found = yield* adapter.findComment(runtime, itemId, "note-053 ");
      assert.deepStrictEqual(
        Option.map(found, ({ id, body }) => ({ id, body })),
        Option.some({ id: "53", body: "note-053 reviewed." }),
      );
      assert.isTrue(Option.isNone(yield* adapter.findComment(runtime, itemId, "note-056 ")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads the file as it is now, not the notes the index read before", () =>
    Effect.gen(function* () {
      const { fs, file, adapter, runtime } = yield* withNotes(55);
      yield* adapter.get(runtime, itemId);
      yield* fs.writeFileString(
        file,
        `${yield* fs.readFileString(file)}- 2026-10-25T09:00:00.000Z (Factory) note-056 posted.\n`,
      );
      assert.isTrue(Option.isSome(yield* adapter.findComment(runtime, itemId, "note-056 ")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses an item the source does not hold", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* withNotes(1);
      const error = yield* Effect.flip(
        adapter.findComment(runtime, WorkItemId.make("fd-bbbbbb"), "note-001"),
      );
      assert.strictEqual(error._tag, "WorkItemNotFound");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("cannot answer for a file that does not read as an item, and can once repaired", () =>
    Effect.gen(function* () {
      const { fs, file, adapter, runtime } = yield* withNotes(3);
      const repaired = yield* fs.readFileString(file);
      // Without its title the file no longer decodes as an item, though its notes are intact.
      yield* fs.writeFileString(file, repaired.replace("title: Alpha\n", ""));
      const broken = yield* adapter.get(runtime, itemId);
      assert.isNotNull(broken.invalid);
      const error = yield* Effect.flip(adapter.findComment(runtime, itemId, "note-002 "));
      assert.strictEqual(error._tag, "WorkUnsupported");

      yield* fs.writeFileString(file, repaired);
      assert.isTrue(Option.isSome(yield* adapter.findComment(runtime, itemId, "note-002 ")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
