import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { DEFAULT_DEVIN_SETTINGS } from "../devin/index.ts";
import { DevinDriver } from "./index.ts";
import { devinUsageReader } from "./history.ts";

const sinceMs = Date.parse("2026-10-01T00:00:00Z");
const settings = Schema.decodeSync(ServerSettings)({});
const scan = (root: string, windows = false) =>
  devinUsageReader.kind === "scan"
    ? devinUsageReader
        .scan({
          instances: ["one", "two"].map((id) => ({
            instanceId: ProviderInstanceId.make(id),
            config: DEFAULT_DEVIN_SETTINGS,
            environment: windows ? { LOCALAPPDATA: root } : { XDG_DATA_HOME: root },
            configured: true,
          })),
          settings,
          windowStartMs: sinceMs,
          retentionCutoffMs: sinceMs,
          awaitRefresh: true,
        })
        .pipe(Effect.provideService(HostProcess.Platform, windows ? "win32" : "linux"))
    : Effect.die("Expected a scan reader");

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "local-cli-usage-" });
  const dir = path.join(root, "devin", "cli");
  yield* fs.makeDirectory(dir, { recursive: true });
  const filename = path.join(dir, "sessions.db");
  const context = yield* Layer.build(NodeSqliteClient.layer({ filename }));
  const sql = Context.get(context, SqlClient.SqlClient);
  yield* sql.unsafe("PRAGMA journal_mode = WAL");
  yield* sql.unsafe("CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT)");
  yield* sql.unsafe(
    "INSERT INTO sessions VALUES ('root', 'fallback-model'), ('child', 'fallback-model')",
  );
  yield* sql.unsafe(
    "CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY, session_id TEXT, created_at INTEGER, chat_message TEXT)",
  );
  const insert = (row: number, message: unknown, session = "root") =>
    sql.unsafe("INSERT INTO message_nodes VALUES (?, ?, ?, ?)", [
      row,
      session,
      sinceMs / 1000,
      typeof message === "string" ? message : JSON.stringify(message),
    ]);
  return { root, dir, filename, sql, insert };
});

const message = (id: string) => ({
  role: "assistant",
  message_id: id,
  content: "irrelevant tool/context text".repeat(10000),
  metadata: {
    request_id: `request-${id}`,
    created_at: "2026-10-02T10:00:00Z",
    generation_model: "native-model",
    metrics: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 50,
      cache_creation_tokens: 10,
    },
    committed_credit_cost: 100,
    committed_acu_cost: 2,
  },
});

describe("local CLI usage history", () => {
  it.effect(
    "counts generated requests once across copied nodes and sees subsequent WAL writes",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup;
        for (const row of [-4, 3, 65, 130]) yield* fixture.insert(row, message("copied"));
        yield* fixture.insert(131, message("child"), "child");
        yield* fixture.insert(132, { ...message("user"), role: "user" });
        yield* fixture.insert(133, {
          ...message("injected"),
          metadata: { ...message("injected").metadata, is_user_input: true },
        });
        yield* fixture.insert(134, "{invalid-json");
        yield* fixture.insert(135, {
          ...message("old"),
          metadata: { ...message("old").metadata, created_at: "2026-09-01T00:00:00Z" },
        });
        const sources = yield* scan(fixture.root);
        expect(sources).toHaveLength(1);
        const records = sources.flatMap(
          (source) => source.files?.flatMap((file) => file.records) ?? [],
        );
        expect(records).toHaveLength(2);
        expect(records[0]).toMatchObject({
          provider: "devin",
          model: "native-model",
          reportedCostUsd: null,
          totals: {
            uncachedInputTokens: 100,
            cachedInputTokens: 50,
            cacheCreationTokens: 10,
            outputTokens: 20,
            reasoningTokens: 0,
          },
        });
        expect(records.map((record) => record.sessionId)).toEqual(["root", "child"]);
        yield* fixture.insert(136, message("new"));
        const refreshed = yield* scan(fixture.root);
        expect(refreshed[0]?.files?.[0]?.records).toHaveLength(3);
        // Read-only history scans must never change the native store.
        expect(
          (yield* fixture.sql.unsafe<{ total: number }>(
            "SELECT COUNT(*) AS total FROM message_nodes",
          ))[0]?.total,
        ).toBe(10);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps native model/time fallbacks and rejects invalid or empty token counts", () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      yield* fixture.insert(1, {
        role: "assistant",
        message_id: "fallback",
        metadata: {
          metrics: {
            input_tokens: -2,
            cache_read_tokens: "50",
            cache_creation_tokens: null,
            output_tokens: 4,
          },
        },
      });
      yield* fixture.insert(2, {
        ...message("empty"),
        metadata: { metrics: { output_tokens: -2 } },
      });
      const sources = yield* scan(fixture.root, true);
      expect(sources[0]?.files?.[0]?.records).toMatchObject([
        {
          model: "fallback-model",
          timestampMs: sinceMs,
          totals: {
            uncachedInputTokens: 0,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 4,
          },
          dedupeKey: "devin:fallback",
        },
      ]);
      expect(DevinDriver.usage).toBe(devinUsageReader);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reports missing and unsupported databases as coverage gaps without creating stores",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "local-cli-missing-" });
        expect((yield* scan(root))[0]?.files).toBeNull();
        expect(yield* fs.exists(path.join(root, "devin"))).toBe(false);
        const fixture = yield* setup;
        yield* fixture.sql.unsafe("DROP TABLE message_nodes");
        expect((yield* scan(fixture.root))[0]).toMatchObject({ status: "partial", files: [] });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
