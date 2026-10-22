import {
  type WorkComment,
  WorkItemId,
  type WorkItemSummary,
  type WorkMarkdownSourceConfig,
  type WorkNativeStatus,
  type WorkSourceCapabilities,
  type WorkSourceConfig,
  type WorkSourceId,
  type WorkStatus,
} from "@t3tools/contracts/fd/work-management";
import * as ByteSize from "effect/ByteSize";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  decodeTaskDocument,
  editTaskDocument,
  MAX_TASK_DOCUMENT_BYTES,
  renderTaskDocument,
  type TaskDocument,
  TOO_LARGE_DIAGNOSTIC,
} from "../../documents/taskDocument.ts";
import {
  appendNote,
  fileItemId,
  formatCommaList,
  formatNoteLine,
  isTaskFileName,
  mintTaskId,
  noteText,
  parseCommaList,
  parseNotes,
  parseOptionalFields,
  parseTaskId,
  type TaskOptionalFields,
} from "../../documents/taskFiles.ts";
import {
  WorkConflict,
  type WorkDomainError,
  WorkInvalid,
  WorkItemNotFound,
  WorkStale,
  WorkUnavailable,
  WorkUnsupported,
} from "../../errors.ts";
import {
  BODY_MAX_CHARS,
  boundList,
  COMMENT_MAX_CHARS,
  COMMENTS_MAX,
  LABELS_MAX,
  truncateText,
} from "../../model/bounds.ts";
import {
  parseSourceDirectory,
  resolveSourceRoute,
  WorkSourceRootRejected,
  type WorkSourceRoute,
} from "../sourceRoot.ts";
import type { WorkSourceAdapter, WorkSourceRuntime } from "../WorkSourceAdapter.ts";

/**
 * The Markdown source: one task file per item in a flat project directory, read through an
 * in-memory index that re-parses a file only when its size, mtime or inode changed. Writes
 * patch the file's bytes in place (`taskDocument.ts`) and land atomically, so another editor
 * or a Git checkout never sees a half-written task.
 */

/** Past this many `.md` files the rest are not indexed and the listing is reported stale. */
const MAX_FILES = 10_000;
const WATCH_DEBOUNCE = Duration.millis(200);

const capabilities: WorkSourceCapabilities = {
  create: true,
  statuses: ["todo", "in_progress", "done", "cancelled"],
  fields: ["title", "body", "priority", "labels", "assignee", "parent", "blockedBy"],
  comments: "add",
  transitions: false,
  people: false,
};

const DUPLICATE_ID = {
  code: "duplicate_id",
  message:
    "Another file in this directory has the same id. Work shows both read-only until one of them is given a new id.",
} as const;

/** Never followed: a link could name a file anywhere, and a write would land there. */
const SYMLINK = {
  code: "symlink",
  message:
    "The file is a symbolic link. Work never reads or writes through links; replace it with a regular file.",
} as const;

const UNREADABLE = {
  code: "unreadable",
  message: "The file could not be read. Work shows it read-only until it can be.",
} as const;

type MarkdownConfig = typeof WorkMarkdownSourceConfig.Type;

const isWorkItemId = Schema.is(WorkItemId);
const NO_FIELDS: ReadonlyMap<string, string> = new Map();

interface IndexedFile {
  readonly filename: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
  readonly revision: string;
  /** The frontmatter id when readable. The view names the file otherwise. */
  readonly frontmatterId: WorkItemId | undefined;
  /**
   * The filename stem when it is an item id: how a broken file is listed, unless a file's
   * frontmatter already claims that id, in which case the view falls back to a hash of the
   * filename. Every file is listed; a broken one read-only under a stable id.
   */
  readonly stemId: WorkItemId | undefined;
  readonly title: string;
  readonly status: WorkStatus;
  /** The body as served, cut at the wire cap; a write re-reads the file for the whole text. */
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly comments: ReadonlyArray<WorkComment>;
  readonly commentsTruncated: boolean;
  readonly fields: TaskOptionalFields;
  /** Lowercased title, labels and body, so a search never re-lowers 10,000 bodies. */
  readonly searchText: string;
  readonly diagnostic: { readonly code: string; readonly message: string } | undefined;
}

interface SourceIndex {
  readonly files: Map<string, IndexedFile>;
  stale: boolean;
}

/** An indexed file that names an item, with duplicate ids folded into `invalid`. */
interface ListedItem {
  readonly file: IndexedFile;
  readonly id: WorkItemId;
  /** The id, or the filename when the id is only a hash of it. */
  readonly key: string;
  readonly invalid: { readonly code: string; readonly message: string } | null;
}

interface SourceView {
  /** Every item, in filename order; two files sharing an id both appear. */
  readonly items: ReadonlyArray<ListedItem>;
  /** The first file of each id. */
  readonly byId: ReadonlyMap<WorkItemId, ListedItem>;
  readonly stale: boolean;
}

interface Source {
  /** Index key: the same directory under two project roots is two sources. */
  readonly key: string;
  readonly route: WorkSourceRoute;
  readonly directory: string;
}

interface FileStamp {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
}

/** The stamp of an entry that was never stat'ed through: a symlink or an unreadable file. */
const NO_STAMP: FileStamp = { size: 0, mtimeMs: 0, ino: 0 };

/** One directory entry as the index sees it, with its document when its bytes were read. */
interface Inspected {
  readonly file: IndexedFile;
  readonly document: TaskDocument | undefined;
}

/** The item's file as it is on disk when a write begins. */
interface CurrentDocument {
  readonly fields: ReadonlyMap<string, string>;
  readonly body: string;
  readonly newline: TaskDocument["newline"];
}

/** What one write changes; `fields` always carries the new `updated` stamp. */
interface PendingEdit {
  readonly title?: string;
  readonly status?: WorkNativeStatus;
  readonly body?: string;
  readonly fields: Readonly<Record<string, string | null>>;
}

const stemOf = (filename: string) => filename.slice(0, -".md".length);

/** The stem as an item id when it is one: `fd-` ids in any casing, other id shapes as written. */
const stemIdOf = (filename: string): WorkItemId | undefined => {
  const stem = stemOf(filename);
  return parseTaskId(stem) ?? (isWorkItemId(stem) ? stem : undefined);
};

/** The title of a file whose frontmatter has none. */
const titleOf = (filename: string) => {
  const stem = stemOf(filename);
  return stem.trim() === "" ? filename : stem;
};

const searchTextOf = (title: string, labels: ReadonlyArray<string>, body: string) =>
  truncateText(`${title}\n${labels.join("\n")}\n${body}`.toLowerCase(), BODY_MAX_CHARS).text;

const indexFile = (filename: string, document: TaskDocument, stamp: FileStamp): IndexedFile => {
  const frontmatterId = document.item?.id ?? parseTaskId(document.fields.get("id") ?? "");
  const title = document.item?.title ?? titleOf(filename);
  const fullBody = document.item?.body ?? "";
  const body = truncateText(fullBody, BODY_MAX_CHARS);
  const comments = boundList(parseNotes(fullBody), COMMENTS_MAX);
  const fields = parseOptionalFields(document.fields);
  const [diagnostic] = document.diagnostics;
  return {
    filename,
    ...stamp,
    revision: document.revision,
    frontmatterId,
    stemId: frontmatterId === undefined ? stemIdOf(filename) : undefined,
    title,
    status: document.item?.status ?? "unknown",
    body: body.text,
    bodyTruncated: body.truncated,
    comments: comments.items,
    commentsTruncated: comments.truncated,
    fields,
    searchText: searchTextOf(title, fields.labels, body.text),
    diagnostic:
      diagnostic === undefined ? undefined : { code: diagnostic.code, message: diagnostic.message },
  };
};

/** An entry listed read-only without its bytes: a symlink, an unreadable or an oversized file. */
const indexUnread = (
  filename: string,
  stamp: FileStamp,
  diagnostic: { readonly code: string; readonly message: string },
): IndexedFile => {
  const title = titleOf(filename);
  return {
    filename,
    ...stamp,
    // Nothing was hashed, so the stamp stands in; the entry is read-only regardless.
    revision: `stamp:${stamp.size}:${stamp.mtimeMs}:${stamp.ino}`,
    frontmatterId: undefined,
    stemId: stemIdOf(filename),
    title,
    status: "unknown",
    body: "",
    bodyTruncated: false,
    comments: [],
    commentsTruncated: false,
    fields: parseOptionalFields(NO_FIELDS),
    searchText: searchTextOf(title, [], ""),
    diagnostic: { code: diagnostic.code, message: diagnostic.message },
  };
};

const byFilename = (left: IndexedFile, right: IndexedFile) =>
  left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0;

/**
 * Names every file: by its frontmatter id, else by its stem when no frontmatter claims that
 * id, else by a hash of its filename. Files sharing an id are all listed, as duplicates.
 */
const buildView = (index: SourceIndex): SourceView => {
  const files = [...index.files.values()].sort(byFilename);
  const claimed = new Set<WorkItemId>();
  for (const file of files) {
    if (file.frontmatterId !== undefined) claimed.add(file.frontmatterId);
  }
  const groups = new Map<WorkItemId, Array<Omit<ListedItem, "invalid">>>();
  for (const file of files) {
    const stemId = file.stemId !== undefined && !claimed.has(file.stemId) ? file.stemId : undefined;
    const id = file.frontmatterId ?? stemId ?? fileItemId(file.filename);
    const key = file.frontmatterId ?? stemId ?? file.filename;
    const group = groups.get(id);
    if (group === undefined) groups.set(id, [{ file, id, key }]);
    else group.push({ file, id, key });
  }
  const items: Array<ListedItem> = [];
  const byId = new Map<WorkItemId, ListedItem>();
  for (const [id, named] of groups) {
    for (const { file, key } of named) {
      const item: ListedItem = {
        file,
        id,
        key,
        invalid: named.length > 1 ? DUPLICATE_ID : (file.diagnostic ?? null),
      };
      items.push(item);
      if (!byId.has(id)) byId.set(id, item);
    }
  }
  items.sort((left, right) => byFilename(left.file, right.file));
  return { items, byId, stale: index.stale };
};

const isOpen = (item: ListedItem | undefined) =>
  item !== undefined && item.file.status !== "done" && item.file.status !== "cancelled";

const summarize = (item: ListedItem, view: SourceView, sourceId: WorkSourceId): WorkItemSummary => {
  const { file, id } = item;
  const { fields } = file;
  return {
    ref: { sourceId, itemId: id },
    kind: "markdown",
    key: item.key,
    title: file.title,
    status: file.status,
    nativeStatus: null,
    // An id the index does not know cannot block; neither can the item itself.
    blocked: fields.blockedBy.some((other) => other !== id && isOpen(view.byId.get(other))),
    priority: fields.priority,
    labels: fields.labels,
    assignee: fields.assignee === null ? null : { id: fields.assignee, label: fields.assignee },
    parent: fields.parent,
    blockedBy: fields.blockedBy,
    url: null,
    updatedAt: fields.updated,
    revision: file.revision,
    invalid: item.invalid,
  };
};

// Normalized ISO strings in UTC compare chronologically; items without `updated` go last.
const byUpdatedDesc = (left: ListedItem, right: ListedItem) => {
  const [a, b] = [left.file.fields.updated, right.file.fields.updated];
  if (a !== b) {
    if (a === null) return 1;
    if (b === null) return -1;
    return a < b ? 1 : -1;
  }
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return byFilename(left.file, right.file);
};

const CURSOR = /^(?:0|[1-9]\d{0,8})$/;

const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

const stampFrom = (info: FileSystem.File.Info): FileStamp => ({
  size: ByteSize.toNumberUnsafe(info.size),
  mtimeMs: Option.getOrElse(
    Option.map(info.mtime, (mtime) => mtime.getTime()),
    () => 0,
  ),
  ino: Option.getOrElse(info.ino, () => 0),
});

const sameStamp = (file: IndexedFile, stamp: FileStamp) =>
  file.size === stamp.size && file.mtimeMs === stamp.mtimeMs && file.ino === stamp.ino;

/** Lookups accept any casing of an item id; stem and hashed ids stay as written. */
const normalizeId = (itemId: WorkItemId): WorkItemId => parseTaskId(itemId) ?? itemId;

const unique = <A>(values: ReadonlyArray<A>) => [...new Set(values)];

export const make: Effect.Effect<
  WorkSourceAdapter,
  never,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const indexes = new Map<string, SourceIndex>();
  // One refresh at a time per source, one write at a time per file.
  const sourceLocks = new Map<string, Semaphore.Semaphore>();
  const fileLocks = new Map<string, Semaphore.Semaphore>();

  const withLock =
    (locks: Map<string, Semaphore.Semaphore>, key: string) =>
    <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.flatMap(
        Effect.sync(() => {
          const existing = locks.get(key);
          if (existing !== undefined) return existing;
          const created = Semaphore.makeUnsafe(1);
          locks.set(key, created);
          return created;
        }),
        (semaphore) => semaphore.withPermits(1)(effect),
      );

  const provideServices = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const unavailable = (detail: string) => ({
    PlatformError: (cause: PlatformError.PlatformError) =>
      Effect.fail(new WorkUnavailable({ detail, cause })),
  });

  const markdownConfig = (config: WorkSourceConfig): Effect.Effect<MarkdownConfig, WorkInvalid> =>
    config.kind === "markdown"
      ? Effect.succeed(config)
      : Effect.fail(new WorkInvalid({ detail: "This source is not a Markdown source." }));

  const resolve = (config: MarkdownConfig, rootPath: string) =>
    Effect.gen(function* () {
      const directory = parseSourceDirectory(config.directory);
      if (Result.isFailure(directory)) {
        const rejected = new WorkSourceRootRejected({ problem: directory.failure });
        return yield* new WorkInvalid({ detail: rejected.message });
      }
      return yield* resolveSourceRoute(rootPath, directory.success, Effect.void).pipe(
        Effect.catchTags({
          WorkSourceRootRejected: (error) =>
            Effect.fail(new WorkInvalid({ detail: error.message })),
          WorkSourceFileError: (error) =>
            Effect.fail(new WorkUnavailable({ detail: error.message, cause: error })),
        }),
        provideServices,
      );
    });

  const open = (runtime: WorkSourceRuntime): Effect.Effect<Source, WorkDomainError> =>
    Effect.gen(function* () {
      const config = yield* markdownConfig(runtime.config);
      const route = yield* resolve(config, runtime.rootPath);
      return {
        key: `${runtime.rootPath}\0${config.directory}`,
        route,
        directory: config.directory,
      };
    });

  const indexOf = (source: Source): SourceIndex => {
    const existing = indexes.get(source.key);
    if (existing !== undefined) return existing;
    const created: SourceIndex = { files: new Map(), stale: false };
    indexes.set(source.key, created);
    return created;
  };

  /**
   * Inspects one `.md` entry without ever failing the source. A symbolic link is listed
   * read-only and never followed; an entry whose stat or read fails, or whose size alone
   * exceeds the document cap, is listed read-only without its bytes; one that vanished or is
   * not a regular file is none. `previous` is reused while the file's stamp has not changed,
   * except for an unreadable entry, which is retried because a permission fix leaves the
   * stamp alone.
   */
  const inspect = (
    filePath: string,
    filename: string,
    previous: IndexedFile | undefined,
  ): Effect.Effect<Option.Option<Inspected>> =>
    Effect.gen(function* () {
      const info = yield* Effect.result(fs.stat(filePath));
      if (
        previous !== undefined &&
        previous.diagnostic?.code !== UNREADABLE.code &&
        Result.isSuccess(info) &&
        info.success.type === "File" &&
        sameStamp(previous, stampFrom(info.success))
      ) {
        // Same inode and bytes, even through a link swapped in meanwhile; a write looks again.
        return Option.some({ file: previous, document: undefined });
      }
      // First sight or a change: a link is listed as such whether or not its target exists.
      const link = yield* Effect.option(fs.readLink(filePath));
      if (Option.isSome(link)) {
        return Option.some({ file: indexUnread(filename, NO_STAMP, SYMLINK), document: undefined });
      }
      if (Result.isFailure(info)) {
        return isNotFound(info.failure)
          ? Option.none()
          : Option.some({ file: indexUnread(filename, NO_STAMP, UNREADABLE), document: undefined });
      }
      if (info.success.type !== "File") return Option.none();
      const stamp = stampFrom(info.success);
      if (stamp.size > MAX_TASK_DOCUMENT_BYTES) {
        return Option.some({
          file: indexUnread(filename, stamp, TOO_LARGE_DIAGNOSTIC),
          document: undefined,
        });
      }
      const bytes = yield* Effect.result(fs.readFile(filePath));
      if (Result.isFailure(bytes)) {
        return isNotFound(bytes.failure)
          ? Option.none()
          : Option.some({ file: indexUnread(filename, stamp, UNREADABLE), document: undefined });
      }
      const document = decodeTaskDocument(bytes.success);
      return Option.some({ file: indexFile(filename, document, stamp), document });
    });

  /** Brings the source's index up to date with the directory and returns the current view. */
  const refresh = (source: Source): Effect.Effect<SourceView, WorkDomainError> =>
    withLock(
      sourceLocks,
      source.key,
    )(
      Effect.gen(function* () {
        const index = indexOf(source);
        if (!source.route.exists) {
          index.files.clear();
          index.stale = false;
          return buildView(index);
        }
        const names = yield* fs.readDirectory(source.route.path).pipe(
          Effect.catchIf(isNotFound, () => Effect.succeed<Array<string>>([])),
          Effect.catchTags(unavailable("The Work directory could not be read.")),
        );
        const taskNames = names.filter(isTaskFileName).sort();
        index.stale = taskNames.length > MAX_FILES;
        const seen = new Set<string>();
        for (const name of taskNames.slice(0, MAX_FILES)) {
          const inspected = yield* inspect(
            path.join(source.route.path, name),
            name,
            index.files.get(name),
          );
          if (Option.isNone(inspected)) continue;
          index.files.set(name, inspected.value.file);
          seen.add(name);
        }
        // Deleting during Map iteration is well-defined: unvisited deleted keys are skipped.
        for (const name of index.files.keys()) {
          if (!seen.has(name)) index.files.delete(name);
        }
        return buildView(index);
      }),
    );

  /** Re-indexes one file from the document just written, so the view reflects it now. */
  const reindex = (source: Source, filename: string, document: TaskDocument) =>
    Effect.gen(function* () {
      const index = indexOf(source);
      const info = yield* fs.stat(path.join(source.route.path, filename)).pipe(
        Effect.asSome,
        Effect.catchIf(isNotFound, () => Effect.succeedNone),
        Effect.catchTags(unavailable("The Work directory could not be read.")),
      );
      if (Option.isNone(info) || info.value.type !== "File") index.files.delete(filename);
      else index.files.set(filename, indexFile(filename, document, stampFrom(info.value)));
      return buildView(index);
    });

  /**
   * Lands the exact bytes through a sibling temp file and a rename, so a reader sees the old
   * file or the new one and never a partial one. The rename replaces whatever is at the path,
   * a symbolic link included, rather than following it: nothing is written outside the Work
   * directory.
   */
  const write = (filePath: string, bytes: Uint8Array) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = path.dirname(filePath);
        // The temp directory is cleanup, not part of the write: failing to remove it must not
        // fail a write that already landed.
        const tempDirectory = yield* Effect.acquireRelease(
          fs.makeTempDirectory({ directory, prefix: `${path.basename(filePath)}.` }),
          (created) => fs.remove(created, { recursive: true }).pipe(Effect.ignore({ log: true })),
        );
        const tempPath = path.join(tempDirectory, "contents.tmp");
        yield* fs.writeFile(tempPath, bytes);
        yield* fs.rename(tempPath, filePath);
      }),
    ).pipe(Effect.catchTags(unavailable("The task file could not be written.")));

  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const normalizeLabels = (labels: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const trimmed = unique(labels.map((label) => label.trim()).filter((label) => label !== ""));
      if (trimmed.some((label) => /[,\r\n]/.test(label))) {
        return yield* new WorkInvalid({ detail: "Labels cannot contain commas or line breaks." });
      }
      if (trimmed.length > LABELS_MAX) {
        return yield* new WorkInvalid({ detail: `An item can have at most ${LABELS_MAX} labels.` });
      }
      return trimmed;
    });

  /** Parent and blocker references must be Markdown item ids; stem ids are not referenceable. */
  const normalizeReference = (itemId: WorkItemId) => {
    const id = parseTaskId(itemId);
    return id === undefined
      ? Effect.fail(
          new WorkInvalid({ detail: "Markdown items are referenced by ids like fd-7k3qa2." }),
        )
      : Effect.succeed(id);
  };

  const mintUnusedId = (view: SourceView) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const bytes = yield* crypto
          .randomBytes(4)
          .pipe(Effect.catchTags(unavailable("Random bytes for a new task id were unavailable.")));
        const id = mintTaskId(bytes);
        if (!view.byId.has(id)) return id;
      }
      return yield* new WorkUnavailable({ detail: "Could not mint an unused task id." });
    });

  /**
   * Reads, edits and rewrites one item's file under its lock. `makeEdit` sees the item as it
   * is on disk and the write time; the result is the item as re-read after the write.
   */
  const writeItem = (
    runtime: WorkSourceRuntime,
    itemId: WorkItemId,
    expectedRevision: string | undefined,
    makeEdit: (
      item: ListedItem,
      current: CurrentDocument,
      writtenAt: string,
    ) => Effect.Effect<PendingEdit, WorkDomainError>,
  ): Effect.Effect<{ readonly item: ListedItem; readonly view: SourceView }, WorkDomainError> =>
    Effect.gen(function* () {
      const source = yield* open(runtime);
      const id = normalizeId(itemId);
      const located = (yield* refresh(source)).byId.get(id);
      if (located === undefined) return yield* new WorkItemNotFound({ itemId });
      const { filename } = located.file;
      const filePath = path.join(source.route.path, filename);
      return yield* withLock(
        fileLocks,
        filePath,
      )(
        Effect.gen(function* () {
          // Inspected afresh: the entry may have become a link or lost its id since the refresh.
          const inspected = yield* inspect(filePath, filename, undefined);
          const index = indexOf(source);
          if (Option.isNone(inspected)) {
            index.files.delete(filename);
            return yield* new WorkItemNotFound({ itemId });
          }
          index.files.set(filename, inspected.value.file);
          const view = buildView(index);
          const item = view.byId.get(id);
          if (item === undefined || item.file.filename !== filename) {
            return yield* new WorkItemNotFound({ itemId });
          }
          if (expectedRevision !== undefined && expectedRevision !== item.file.revision) {
            return yield* new WorkStale({
              itemId,
              current: summarize(item, view, runtime.sourceId),
            });
          }
          if (item.invalid !== null)
            return yield* new WorkUnsupported({ detail: item.invalid.message });
          const { document } = inspected.value;
          if (document === undefined) {
            return yield* new WorkUnavailable({ detail: "The task file could not be read." });
          }
          const writtenAt = yield* now;
          const edit = yield* makeEdit(
            item,
            { fields: document.fields, body: document.item?.body ?? "", newline: document.newline },
            writtenAt,
          );
          const edited = editTaskDocument(document.bytes, { ...edit, id });
          if (Result.isFailure(edited)) {
            const { failure } = edited;
            return yield* failure.reason === "read_only"
              ? new WorkUnsupported({ detail: failure.message })
              : new WorkInvalid({ detail: failure.message });
          }
          yield* write(filePath, edited.success.bytes);
          const after = yield* reindex(source, filename, edited.success);
          const written = after.byId.get(id);
          if (written === undefined) {
            return yield* new WorkUnavailable({ detail: "The task file could not be read back." });
          }
          return { item: written, view: after };
        }),
      );
    });

  const identity: WorkSourceAdapter["identity"] = (config) =>
    // The registry dispatches by kind, so a foreign config never reaches this adapter.
    config.kind === "markdown" ? config.directory : "";

  const test: WorkSourceAdapter["test"] = ({ config, rootPath }) =>
    Effect.gen(function* () {
      const markdown = yield* markdownConfig(config);
      yield* resolve(markdown, rootPath);
      return { identity: markdown.directory };
    });

  const prepare: WorkSourceAdapter["prepare"] = (runtime) =>
    Effect.gen(function* () {
      const source = yield* open(runtime);
      if (source.route.exists) return;
      yield* fs
        .makeDirectory(source.route.path, { recursive: true })
        .pipe(Effect.catchTags(unavailable("The Work directory could not be created.")));
    });

  const list: WorkSourceAdapter["list"] = (runtime, query) =>
    Effect.gen(function* () {
      if (query.cursor !== undefined && !CURSOR.test(query.cursor)) {
        return yield* new WorkInvalid({ detail: "The page cursor is not one this source issued." });
      }
      const offset = query.cursor === undefined ? 0 : Number(query.cursor);
      const view = yield* refresh(yield* open(runtime));
      // Markdown names nobody, so no item is assigned to the caller.
      if (query.assignee === "me") return { items: [], nextCursor: null, stale: view.stale };
      const search = query.search?.trim().toLowerCase() ?? "";
      const statuses = query.statuses === undefined ? undefined : new Set<string>(query.statuses);
      const labels = query.labels ?? [];
      const matches = view.items
        .filter(({ file }) => {
          if (statuses !== undefined && !statuses.has(file.status)) return false;
          if (!labels.every((label) => file.fields.labels.includes(label))) return false;
          return search === "" || file.searchText.includes(search);
        })
        .sort(byUpdatedDesc);
      const end = offset + query.limit;
      return {
        items: matches.slice(offset, end).map((item) => summarize(item, view, runtime.sourceId)),
        nextCursor: end < matches.length ? String(end) : null,
        stale: view.stale,
      };
    });

  const get: WorkSourceAdapter["get"] = (runtime, itemId) =>
    Effect.gen(function* () {
      const source = yield* open(runtime);
      const view = yield* refresh(source);
      const item = view.byId.get(normalizeId(itemId));
      if (item === undefined) return yield* new WorkItemNotFound({ itemId });
      const { file } = item;
      const others = [...view.byId.values()].filter((other) => other !== item);
      return {
        ...summarize(item, view, runtime.sourceId),
        body: file.body,
        bodyTruncated: file.bodyTruncated,
        bodyFidelity: "exact" as const,
        comments: file.comments,
        commentsTruncated: file.commentsTruncated,
        children: others
          .filter((other) => other.file.fields.parent === item.id)
          .map((child) => ({
            itemId: child.id,
            key: child.key,
            title: child.file.title,
            status: child.file.status,
          })),
        blocking: others
          .filter((other) => other.file.fields.blockedBy.includes(item.id))
          .map((other) => other.id),
        transitions: [],
        locator: `${source.directory}/${file.filename}`,
      };
    });

  const create: WorkSourceAdapter["create"] = (runtime, input) =>
    Effect.gen(function* () {
      const source = yield* open(runtime);
      const view = yield* refresh(source);
      const id = yield* mintUnusedId(view);
      const writtenAt = yield* now;
      const labels = yield* normalizeLabels(input.labels ?? []);
      const assignee = input.assignee?.trim() ?? "";
      const fields: Record<string, string> = { created: writtenAt, updated: writtenAt };
      if (input.priority !== undefined) fields.priority = input.priority;
      if (labels.length > 0) fields.labels = formatCommaList(labels);
      if (assignee !== "") fields.assignee = assignee;
      if (input.parent !== undefined) fields.parent = yield* normalizeReference(input.parent);
      const rendered = renderTaskDocument({
        id,
        title: input.title,
        status: "todo",
        ...(input.body === undefined ? {} : { body: input.body }),
        fields,
      });
      if (Result.isFailure(rendered)) {
        return yield* new WorkInvalid({ detail: rendered.failure.message });
      }
      const { filename, bytes } = rendered.success;
      const filePath = path.join(source.route.path, filename);
      const exists = yield* fs
        .exists(filePath)
        .pipe(Effect.catchTags(unavailable("The Work directory could not be read.")));
      if (exists) {
        return yield* new WorkConflict({
          detail: `A file named ${filename} already exists in the Work directory.`,
        });
      }
      yield* write(filePath, bytes);
      const after = yield* reindex(source, filename, decodeTaskDocument(bytes));
      const item = after.byId.get(id);
      if (item === undefined) {
        return yield* new WorkUnavailable({ detail: "The task file could not be read back." });
      }
      return summarize(item, after, runtime.sourceId);
    });

  const update: WorkSourceAdapter["update"] = (runtime, patch) =>
    writeItem(runtime, patch.ref.itemId, patch.expectedRevision, (item, current, writtenAt) =>
      Effect.gen(function* () {
        // The served body was cut at the wire cap; saving it back would drop the rest.
        if (patch.body !== undefined && current.body.length > BODY_MAX_CHARS) {
          return yield* new WorkUnsupported({
            detail: "The body is longer than this view can edit; change it in an external editor.",
          });
        }
        const fields: Record<string, string | null> = { updated: writtenAt };
        if (patch.priority !== undefined) fields.priority = patch.priority;
        const labelsPatch = patch.labels;
        if (labelsPatch !== undefined) {
          // Merged against the file's whole list, not the capped one a summary shows, so a
          // label past the cap is refused rather than dropped.
          const kept = unique(parseCommaList(current.fields.get("labels") ?? "")).filter(
            (label) => !labelsPatch.remove.includes(label),
          );
          const labels = yield* normalizeLabels([...kept, ...labelsPatch.add]);
          fields.labels = labels.length === 0 ? null : formatCommaList(labels);
        }
        if (patch.assignee !== undefined) {
          const assignee = patch.assignee?.trim() ?? "";
          fields.assignee = assignee === "" ? null : assignee;
        }
        if (patch.parent !== undefined) {
          const parent = patch.parent === null ? null : yield* normalizeReference(patch.parent);
          if (parent === item.id) {
            return yield* new WorkInvalid({ detail: "An item cannot be its own parent." });
          }
          fields.parent = parent;
        }
        if (patch.blockedBy !== undefined) {
          const blockers = unique(yield* Effect.forEach(patch.blockedBy, normalizeReference));
          if (blockers.includes(item.id)) {
            return yield* new WorkInvalid({ detail: "An item cannot block itself." });
          }
          fields.blocked_by = blockers.length === 0 ? null : formatCommaList(blockers);
        }
        return {
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.body === undefined ? {} : { body: patch.body }),
          fields,
        };
      }),
    ).pipe(Effect.map(({ item, view }) => summarize(item, view, runtime.sourceId)));

  const setStatus: WorkSourceAdapter["setStatus"] = (runtime, input) => {
    const { status } = input;
    if (status === undefined || input.transitionId !== undefined) {
      return Effect.fail(
        new WorkUnsupported({
          detail: "Markdown sources have no transitions; set a status instead.",
        }),
      );
    }
    return writeItem(
      runtime,
      input.ref.itemId,
      input.expectedRevision,
      (_item, _current, writtenAt) => Effect.succeed({ status, fields: { updated: writtenAt } }),
    ).pipe(Effect.map(({ item, view }) => summarize(item, view, runtime.sourceId)));
  };

  const comment: WorkSourceAdapter["comment"] = (runtime, itemId, body, actor) => {
    let commentId: string | null = null;
    const label = actor.label.trim() === "" ? actor.id : actor.label;
    const text = noteText(body);
    if (text.length > COMMENT_MAX_CHARS) {
      return Effect.fail(
        new WorkInvalid({ detail: `A comment can have at most ${COMMENT_MAX_CHARS} characters.` }),
      );
    }
    return writeItem(runtime, itemId, undefined, (_item, current, writtenAt) => {
      const before = parseNotes(current.body).length;
      const next = appendNote(
        current.body,
        formatNoteLine(writtenAt, label, text),
        current.newline,
      );
      const count = parseNotes(next).length;
      // The id is the note's position, so a note the body would hide is never reported.
      if (count <= before) {
        return Effect.fail(
          new WorkInvalid({ detail: "The comment could not be added to this item's Notes." }),
        );
      }
      commentId = String(count);
      return Effect.succeed({ body: next, fields: { updated: writtenAt } });
    }).pipe(Effect.map(() => ({ commentId })));
  };

  const snapshots: WorkSourceAdapter["snapshots"] = (runtime, itemIds) =>
    Effect.gen(function* () {
      const view = yield* refresh(yield* open(runtime));
      return itemIds.flatMap((itemId) => {
        const item = view.byId.get(normalizeId(itemId));
        return item === undefined ? [] : [summarize(item, view, runtime.sourceId)];
      });
    });

  // A missing directory or a watcher failure ends the stream quietly; the reactor keeps polling.
  const watch: NonNullable<WorkSourceAdapter["watch"]> = (runtime) =>
    Stream.unwrap(Effect.map(open(runtime), (source) => fs.watch(source.route.path))).pipe(
      Stream.debounce(WATCH_DEBOUNCE),
      Stream.map(() => undefined),
      Stream.catchCause(() => Stream.empty),
    );

  return {
    kind: "markdown",
    capabilities,
    identity,
    test,
    prepare,
    list,
    get,
    people: () => Effect.succeed([]),
    create,
    update,
    setStatus,
    comment,
    snapshots,
    watch,
  } satisfies WorkSourceAdapter;
});
