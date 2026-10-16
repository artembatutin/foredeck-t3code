import type { ProviderUsageReader, UsageRecord } from "@t3tools/provider-core/server/usage";
import { parseTimestampMs, tokenCount, totalTokens } from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { DevinSettings } from "../devin/index.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

function usageRecord(row: {
  readonly row_id: number;
  readonly session_id: string;
  readonly model: string;
  readonly created_at: number;
  readonly data: string;
}): (UsageRecord & { readonly dedupeKey: string }) | null {
  const data = object(decodeJson(row.data));
  if (data.role !== "assistant" || data.is_user_input === 1) return null;
  const metrics = object(data.metrics);
  const totals = {
    uncachedInputTokens: tokenCount(metrics.input_tokens),
    cachedInputTokens: tokenCount(metrics.cache_read_tokens),
    cacheCreationTokens: tokenCount(metrics.cache_creation_tokens),
    outputTokens: tokenCount(metrics.output_tokens),
    reasoningTokens: 0,
  };
  const timestampMs = parseTimestampMs(data.created_at) ?? row.created_at * 1000;
  const model = text(data.generation_model) || row.model;
  if (!model || !Number.isFinite(timestampMs) || totalTokens(totals) === 0) return null;
  // Prefix rebuilds and compaction copy messages to new nodes with the same native identity.
  const id = text(data.request_id) || text(data.message_id);
  return {
    provider: "devin",
    timestampMs,
    model,
    sessionId: row.session_id,
    totals,
    // Native credits/ACUs are not USD. The shared pricing path may estimate token costs.
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: id ? `devin:${id}` : `devin:${row.session_id}:row:${row.row_id}`,
  };
}

/** Only usage fields leave SQLite; conversation bodies can be many megabytes per row. */
const readDatabase = Effect.fn("devinUsage.readDatabase")(function* (sinceMs: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe("PRAGMA busy_timeout = 100");
  const [range] = yield* sql.unsafe<{ first: number | null; last: number | null }>(
    "SELECT MIN(row_id) AS first, MAX(row_id) AS last FROM message_nodes",
  );
  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  if (range?.first === null || range?.first === undefined || range.last === null) return records;
  // Bound rowids rather than matching rows, so old/tool-heavy history yields regularly too.
  for (let after = range.first - 1; after < range.last; after += 64) {
    const rows = yield* sql
      .unsafe<{
        row_id: number;
        session_id: string;
        model: string;
        created_at: number;
        data: string;
      }>(
        `SELECT m.row_id, m.session_id, s.model, m.created_at,
         CASE WHEN json_valid(m.chat_message) THEN json_object(
           'role', json_extract(m.chat_message, '$.role'),
           'message_id', json_extract(m.chat_message, '$.message_id'),
           'request_id', json_extract(m.chat_message, '$.metadata.request_id'),
           'is_user_input', json_extract(m.chat_message, '$.metadata.is_user_input'),
           'generation_model', json_extract(m.chat_message, '$.metadata.generation_model'),
           'created_at', json_extract(m.chat_message, '$.metadata.created_at'),
           'metrics', json_extract(m.chat_message, '$.metadata.metrics')
         ) ELSE '{}' END AS data
       FROM message_nodes m JOIN sessions s ON s.id = m.session_id
       WHERE m.row_id > ? AND m.row_id <= ? ORDER BY m.row_id`,
        [after, Math.min(after + 64, range.last)],
      )
      .pipe(Effect.withTracerEnabled(false));
    for (const row of rows) {
      const record = usageRecord(row);
      if (record === null || record.timestampMs < sinceMs || seen.has(record.dedupeKey)) continue;
      seen.add(record.dedupeKey);
      records.push(record);
    }
    yield* Effect.yieldNow;
  }
  return records;
});

export const devinUsageReader: ProviderUsageReader<
  DevinSettings,
  FileSystem.FileSystem | Path.Path
> = {
  kind: "scan",
  provider: "devin",
  scan: Effect.fn("devinUsage.scan")(function* ({ instances, windowStartMs }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const windows = yield* HostProcess.isWindows;
    const roots = new Set<string>();
    for (const { environment } of instances) {
      const dataHome = windows ? environment.LOCALAPPDATA : environment.XDG_DATA_HOME;
      const userHome = environment.HOME?.trim();
      const root = path.join(
        dataHome && path.isAbsolute(dataHome)
          ? dataHome
          : path.join(
              userHome && path.isAbsolute(userHome) ? userHome : home,
              windows ? "AppData/Local" : ".local/share",
            ),
        "devin",
        "cli",
      );
      roots.add(yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => root)));
    }
    return yield* Effect.forEach(
      [...roots],
      Effect.fnUntraced(function* (dir) {
        const filename = path.join(dir, "sessions.db");
        return yield* Effect.gen(function* () {
          if (!(yield* fs.exists(filename))) return { dir, files: null };
          const records = yield* readDatabase(windowStartMs).pipe(
            Effect.provide(NodeSqliteClient.layer({ filename, readonly: true })),
          );
          return { dir, files: [{ path: filename, records }] };
        }).pipe(
          Effect.orElseSucceed(() => ({
            dir,
            files: [],
            status: "partial" as const,
            message:
              "Devin CLI history could not be read. Its local database may be busy or unsupported.",
          })),
        );
      }),
    );
  }),
};
