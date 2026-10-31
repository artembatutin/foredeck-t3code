import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import { migrationManifest } from "../../persistence/Migrations.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { Dispatch } from "./dispatch.ts";
import * as HandoffMigrations from "./handoffMigrations.ts";
import * as PortfolioStore from "./PortfolioStore.ts";
import * as ProjectAssistant from "./ProjectAssistant.ts";

const assistantManifest = HandoffMigrations.assistantMigrationEntries.map(
  ([id, name]) => [id, name] as const,
);

const ledger = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id
    `;
    return rows.map((row) => [row.migration_id, row.name] as const);
  });
const coreLedger = ledger("effect_sql_migrations");
const assistantLedger = ledger(HandoffMigrations.ASSISTANT_MIGRATIONS_TABLE);

const schemaObjects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly type: string; readonly name: string; readonly sql: string | null }>`
    SELECT type, name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `;
});

const HANDOFF_TABLES = [
  "fd_assistant_work_captures",
  "fd_assistant_capture_events",
  "fd_assistant_factory_links",
  "fd_assistant_managed_roots",
  "fd_assistant_scheduler",
  "fd_assistant_queue_positions",
  "fd_assistant_admission_demands",
  "fd_assistant_slots",
  "fd_assistant_admissions",
  "fd_assistant_dispositions",
  "fd_assistant_grant_history",
] as const;

const toAssignment = "assignment_id -> fd_assistant_assignments.assignment_id";
const toRoot = "root_delivery_id -> fd_assistant_managed_roots.root_delivery_id";

/** Each table's unique keys (a partial one with its predicate) and foreign keys. */
const HANDOFF_KEYS = {
  fd_assistant_work_captures: { unique: ["capture_id", "project_id, idea_id"], foreignKeys: [] },
  fd_assistant_capture_events: { unique: ["capture_id, sequence"], foreignKeys: [] },
  fd_assistant_factory_links: {
    unique: ["assignment_id", "delivery_id"],
    foreignKeys: [toAssignment],
  },
  fd_assistant_managed_roots: {
    unique: ["assignment_id WHERE state IN ('active', 'ending')", "root_delivery_id"],
    foreignKeys: [toAssignment],
  },
  fd_assistant_scheduler: { unique: [], foreignKeys: [] },
  fd_assistant_queue_positions: { unique: ["assignment_id", "seq"], foreignKeys: [toAssignment] },
  fd_assistant_admission_demands: {
    unique: [
      "root_delivery_id, delivery_id WHERE kind = 'effect'",
      "root_delivery_id, kind, wake_key WHERE kind <> 'effect'",
      "seq",
    ],
    foreignKeys: [toAssignment, toRoot],
  },
  fd_assistant_slots: {
    unique: ["assignment_id", "root_delivery_id"],
    foreignKeys: [toAssignment, "reserved_demand_id -> fd_assistant_admission_demands.id", toRoot],
  },
  fd_assistant_admissions: {
    unique: [
      "admission_id",
      "kind, thread_id, message_id WHERE kind IN ('automatic_turn', 'delegation')",
    ],
    foreignKeys: [toAssignment, toRoot],
  },
  fd_assistant_dispositions: {
    unique: ["root_delivery_id, kind, wake_key"],
    foreignKeys: [toAssignment, toRoot],
  },
  fd_assistant_grant_history: { unique: [], foreignKeys: [] },
};

const keysOf = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const indexes = yield* sql<{ readonly name: string; readonly partial: number }>`
      SELECT name, partial FROM pragma_index_list(${table}) WHERE "unique" = 1
    `;
    const unique: Array<string> = [];
    for (const index of indexes) {
      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_index_info(${index.name}) ORDER BY seqno
      `;
      const [definition] = yield* sql<{ readonly sql: string | null }>`
        SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ${index.name}
      `;
      const text = (definition?.sql ?? "").replace(/\s+/g, " ").trim();
      const predicate = index.partial === 1 ? ` WHERE ${text.split(" WHERE ")[1]}` : "";
      unique.push(`${columns.map((column) => column.name).join(", ")}${predicate}`);
    }
    const foreignKeys = yield* sql<{
      readonly from: string;
      readonly table: string;
      readonly to: string;
    }>`SELECT "from", "table", "to" FROM pragma_foreign_key_list(${table})`;
    return {
      unique: unique.toSorted(),
      foreignKeys: foreignKeys.map((key) => `${key.from} -> ${key.table}.${key.to}`).toSorted(),
    };
  });

const handoffRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows: Record<string, ReadonlyArray<unknown>> = {};
  for (const table of [...HANDOFF_TABLES, HandoffMigrations.ASSISTANT_MIGRATIONS_TABLE])
    rows[table] = yield* sql`SELECT * FROM ${sql(table)} ORDER BY rowid`;
  return rows;
});

type Row = Readonly<Record<string, string | number | null>>;
type Write = Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>;

const insert = (table: string, row: Row): Write =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO ${sql(table)} ${sql.insert(row)}`;
  });

const updateRoot = (rootDeliveryId: string, changes: Row): Write =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE fd_assistant_managed_roots SET ${sql.update(changes)}
      WHERE root_delivery_id = ${rootDeliveryId}`;
  });

const deleteRoot = (rootDeliveryId: string): Write =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM fd_assistant_managed_roots WHERE root_delivery_id = ${rootDeliveryId}`;
  });

// node:sqlite reports SQLite's extended result code as `errcode`.
const SQLITE_REFUSALS = new Map<unknown, string>([
  [275, "check"],
  [787, "foreign key"],
  [1299, "not null"],
  [1555, "unique"],
  [2067, "unique"],
]);
const SQLITE_CONSTRAINT_TRIGGER = 1811;

/** "ok", or how SQLite refused the write; a trigger's refusal carries its message. */
const outcome = (write: Write) =>
  write.pipe(
    Effect.as("ok"),
    Effect.catchTags({
      SqlError: ({ reason: { cause } }) => {
        const errcode = Predicate.hasProperty(cause, "errcode") ? cause.errcode : undefined;
        if (errcode === SQLITE_CONSTRAINT_TRIGGER && Predicate.hasProperty(cause, "message"))
          return Effect.succeed(`trigger: ${String(cause.message)}`);
        return Effect.succeed(SQLITE_REFUSALS.get(errcode) ?? `unexpected ${String(errcode)}`);
      },
    }),
  );

type Case = readonly [label: string, write: Write, expected: string];

/** Runs each labelled write in order and compares every outcome at once. */
const expectOutcomes = Effect.fn(function* (cases: ReadonlyArray<Case>) {
  const actual: Record<string, string> = {};
  for (const [label, write] of cases) actual[label] = yield* outcome(write);
  assert.deepStrictEqual(
    actual,
    Object.fromEntries(cases.map(([label, , expected]) => [label, expected])),
  );
});

const NO_DELETE = "trigger: Assistant managed roots are never deleted.";
const BAD_MOVE = "trigger: Assistant managed roots move only active -> ending -> retired.";

const at = "2026-10-29T12:00:00.000Z";
const later = "2026-10-29T12:05:00.000Z";
const alpha = ProjectId.make("project-alpha");

const decodeDispatch = Schema.decodeUnknownSync(Dispatch);
const DispatchJson = Schema.fromJsonString(Dispatch);
const encodeDispatchJson = Schema.encodeSync(DispatchJson);
const decodeDispatchJson = Schema.decodeUnknownSync(DispatchJson);

/** A fresh server database: core migrations, then the ledger under the portfolio store. */
const migrated = ProjectAssistant.layerPersistence.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

/** Assignments a-1 and a-2, written by the portfolio store, that handoff rows key to. */
const assignments = Effect.gen(function* () {
  const store = yield* PortfolioStore.PortfolioStore;
  for (const assignmentId of ["a-1", "a-2"])
    yield* store.createAssignment({ assignmentId, projectId: alpha, executor: "foredeck" });
});

const activeRoot = (rootDeliveryId: string, assignmentId: string): Row => ({
  root_delivery_id: rootDeliveryId,
  assignment_id: assignmentId,
  attempt: 1,
  state: "active",
  reason: null,
  ending_at: null,
  retired_at: null,
  created_at: at,
});

const readRoot = (rootDeliveryId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`SELECT * FROM fd_assistant_managed_roots
      WHERE root_delivery_id = ${rootDeliveryId}`;
  });

describe("runAssistantMigrations", () => {
  it.effect("creates the handoff schema after core migrations and reruns as a no-op", () =>
    Effect.gen(function* () {
      const core = yield* coreLedger;
      assert.deepStrictEqual(core, migrationManifest);
      const coreSchema = yield* schemaObjects;

      assert.deepStrictEqual(yield* HandoffMigrations.runAssistantMigrations(), [
        [1, "AssistantWorkCaptures"],
        [2, "AssistantFactoryHandoff"],
      ]);
      assert.deepStrictEqual(yield* assistantLedger, assistantManifest);
      assert.deepStrictEqual(yield* coreLedger, core);

      const schema = yield* schemaObjects;
      const isCore = (object: { readonly type: string; readonly name: string }) =>
        coreSchema.some((core) => core.type === object.type && core.name === object.name);
      // Core objects, the portfolio tables of migrations 64-66 among them, are untouched.
      assert.deepStrictEqual(schema.filter(isCore), coreSchema);
      assert.deepStrictEqual(
        schema.filter((object) => !isCore(object)).map((object) => [object.type, object.name]),
        [
          ["index", "fd_assistant_admission_demands_effect"],
          ["index", "fd_assistant_admission_demands_wake"],
          ["index", "fd_assistant_admissions_turn"],
          ["index", "fd_assistant_grant_history_assignment"],
          ["index", "fd_assistant_managed_roots_live"],
          ["table", "fd_assistant_admission_demands"],
          ["table", "fd_assistant_admissions"],
          ["table", "fd_assistant_capture_events"],
          ["table", "fd_assistant_dispositions"],
          ["table", "fd_assistant_factory_links"],
          ["table", "fd_assistant_grant_history"],
          ["table", "fd_assistant_managed_roots"],
          ["table", "fd_assistant_migrations"],
          ["table", "fd_assistant_queue_positions"],
          ["table", "fd_assistant_scheduler"],
          ["table", "fd_assistant_slots"],
          ["table", "fd_assistant_work_captures"],
          ["trigger", "fd_assistant_grant_history_bound"],
          ["trigger", "fd_assistant_managed_roots_kept"],
          ["trigger", "fd_assistant_managed_roots_moves"],
        ],
      );
      const keys: Record<string, unknown> = {};
      for (const table of HANDOFF_TABLES) keys[table] = yield* keysOf(table);
      assert.deepStrictEqual(keys, HANDOFF_KEYS);

      const rows = yield* handoffRows;
      assert.deepStrictEqual(rows.fd_assistant_scheduler, [{ id: 1, next_seq: 1, grants: 0 }]);
      for (const table of HANDOFF_TABLES)
        if (table !== "fd_assistant_scheduler") assert.deepStrictEqual(rows[table], [], table);

      assert.deepStrictEqual(yield* HandoffMigrations.runAssistantMigrations(), []);
      assert.deepStrictEqual(yield* schemaObjects, schema);
      assert.deepStrictEqual(yield* handoffRows, rows);
      assert.deepStrictEqual(yield* assistantLedger, assistantManifest);
      assert.deepStrictEqual(yield* coreLedger, core);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});

describe("assistant migration ledger guard", () => {
  it.effect("refuses another build's ledger before any DDL", () =>
    Effect.gen(function* () {
      // Another build recorded a different migration under id 1. The migrator alone would skip
      // this build's id 1 and run id 2 against a database without its capture tables.
      yield* Migrator.make({})({
        loader: Migrator.fromRecord({ "1_OtherBuildTables": Effect.void }),
        table: HandoffMigrations.ASSISTANT_MIGRATIONS_TABLE,
      });
      const schema = yield* schemaObjects;

      const refused = yield* Effect.flip(HandoffMigrations.runAssistantMigrations());
      assert.strictEqual(refused._tag, "MigrationError");
      if (refused._tag !== "MigrationError") return;
      assert.strictEqual(refused.kind, "BadState");
      assert.include(refused.message, "1_AssistantWorkCaptures (recorded: OtherBuildTables)");

      assert.deepStrictEqual(yield* schemaObjects, schema);
      const names = new Set(schema.map((object) => object.name));
      assert.deepStrictEqual(
        HANDOFF_TABLES.filter((table) => names.has(table)),
        [],
      );
      assert.deepStrictEqual(yield* assistantLedger, [[1, "OtherBuildTables"]]);
      assert.deepStrictEqual(yield* coreLedger, migrationManifest);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("builds no assistant store over a ledger that renamed an id this build ran", () =>
    Effect.gen(function* () {
      yield* HandoffMigrations.runAssistantMigrations();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE ${sql(HandoffMigrations.ASSISTANT_MIGRATIONS_TABLE)}
        SET name = 'OtherHandoff' WHERE migration_id = 2
      `;
      const schema = yield* schemaObjects;

      const refused = yield* Effect.flip(
        Effect.service(PortfolioStore.PortfolioStore).pipe(
          Effect.provide(ProjectAssistant.layerPersistence),
        ),
      );
      assert.strictEqual(refused._tag, "MigrationError");
      if (refused._tag !== "MigrationError") return;
      assert.strictEqual(refused.kind, "BadState");
      assert.include(refused.message, "2_AssistantFactoryHandoff (recorded: OtherHandoff)");
      assert.deepStrictEqual(yield* schemaObjects, schema);
      assert.deepStrictEqual(yield* coreLedger, migrationManifest);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});

describe("handoff constraints", () => {
  it.effect("records a capture's item before it counts as captured", () =>
    Effect.gen(function* () {
      const capture = (row: Row = {}): Row => ({
        project_id: "project-alpha",
        idea_id: "idea-1",
        capture_id: "cap-1",
        source_id: "source-1",
        kind: "single",
        state: "pending",
        writer_instance_id: "instance-1",
        item_id: null,
        item_key: null,
        item_url: null,
        item_fingerprint: null,
        content_hash: "content",
        scope_hash: "scope",
        brief_revision: 1,
        updated_at: at,
        ...row,
      });
      const event = (sequence: number, row: Row = {}): Row => ({
        capture_id: "cap-1",
        sequence,
        event: "claimed",
        item_id: null,
        detail: null,
        at,
        ...row,
      });
      const captures = "fd_assistant_work_captures";
      const events = "fd_assistant_capture_events";
      yield* expectOutcomes([
        ["captured without item", insert(captures, capture({ state: "captured" })), "check"],
        ["unknown kind", insert(captures, capture({ kind: "epic" })), "check"],
        ["unknown state", insert(captures, capture({ state: "done" })), "check"],
        ["pending", insert(captures, capture()), "ok"],
        [
          "captured with item",
          insert(
            captures,
            capture({
              idea_id: "idea-2",
              capture_id: "cap-2",
              state: "captured",
              item_id: "fd-7k3qa2",
              item_fingerprint: "fingerprint",
            }),
          ),
          "ok",
        ],
        [
          "uncertain",
          insert(captures, capture({ idea_id: "idea-3", capture_id: "cap-3", state: "uncertain" })),
          "ok",
        ],
        ["second capture of an idea", insert(captures, capture({ capture_id: "cap-4" })), "unique"],
        ["reused capture id", insert(captures, capture({ idea_id: "idea-4" })), "unique"],
        ["unknown event", insert(events, event(1, { event: "deleted" })), "check"],
        ["claimed", insert(events, event(1)), "ok"],
        ["created", insert(events, event(2, { event: "created", item_id: "fd-7k3qa2" })), "ok"],
        ["create_uncertain", insert(events, event(3, { event: "create_uncertain" })), "ok"],
        ["recovered", insert(events, event(4, { event: "recovered", item_id: "fd-7k3qa2" })), "ok"],
        ["updated", insert(events, event(5, { event: "updated", detail: "content" })), "ok"],
        ["update_uncertain", insert(events, event(6, { event: "update_uncertain" })), "ok"],
        ["abandoned", insert(events, event(7, { event: "abandoned" })), "ok"],
        ["repeated sequence", insert(events, event(7, { event: "claimed" })), "unique"],
      ]);
    }).pipe(Effect.provide(migrated)),
  );

  it.effect("keeps one live managed root per assignment with each state's fields", () =>
    Effect.gen(function* () {
      yield* assignments;
      const roots = "fd_assistant_managed_roots";
      const root = (row: Row): Row => ({ ...activeRoot("r-1", "a-1"), ...row });
      const ending = { state: "ending", reason: "cancelled", ending_at: later };
      const retired = { state: "retired", reason: "cancelled", retired_at: later };
      yield* expectOutcomes([
        ["missing assignment", insert(roots, root({ assignment_id: "missing" })), "foreign key"],
        ["unknown state", insert(roots, root({ state: "paused" })), "check"],
        ["unknown reason", insert(roots, root({ ...retired, reason: "done" })), "check"],
        ["active with reason", insert(roots, root({ reason: "failed" })), "check"],
        ["active with ending_at", insert(roots, root({ ending_at: later })), "check"],
        ["active with retired_at", insert(roots, root({ retired_at: later })), "check"],
        ["ending without reason", insert(roots, root({ ...ending, reason: null })), "check"],
        ["ending without ending_at", insert(roots, root({ ...ending, ending_at: null })), "check"],
        ["ending with retired_at", insert(roots, root({ ...ending, retired_at: later })), "check"],
        ["retired without reason", insert(roots, root({ ...retired, reason: null })), "check"],
        [
          "retired without retired_at",
          insert(roots, root({ ...retired, retired_at: null })),
          "check",
        ],
        ["first live root", insert(roots, root({})), "ok"],
        ["second active root", insert(roots, root({ root_delivery_id: "r-2" })), "unique"],
        [
          "second ending root",
          insert(roots, root({ root_delivery_id: "r-2", ...ending })),
          "unique",
        ],
        ["former root", insert(roots, root({ root_delivery_id: "r-0", ...retired })), "ok"],
        ["other assignment's root", insert(roots, activeRoot("r-3", "a-2")), "ok"],
        ["reused root id", insert(roots, activeRoot("r-1", "a-2")), "unique"],
      ]);
    }).pipe(Effect.provide(migrated)),
  );

  it.effect("moves managed roots only forward and never deletes them", () =>
    Effect.gen(function* () {
      yield* assignments;
      const roots = "fd_assistant_managed_roots";
      yield* insert(roots, activeRoot("r-1", "a-1"));
      yield* insert(roots, activeRoot("r-2", "a-2"));
      const fence = { state: "ending", reason: "completed", ending_at: later };
      const retire = { state: "retired", retired_at: later };
      yield* expectOutcomes([
        ["fence with a changed attempt", updateRoot("r-1", { ...fence, attempt: 2 }), BAD_MOVE],
        [
          "fence with a changed assignment",
          updateRoot("r-1", { ...fence, assignment_id: "a-2" }),
          BAD_MOVE,
        ],
        [
          "fence with a changed created_at",
          updateRoot("r-1", { ...fence, created_at: later }),
          BAD_MOVE,
        ],
        [
          "fence with a changed root id",
          updateRoot("r-1", { ...fence, root_delivery_id: "r-9" }),
          BAD_MOVE,
        ],
        ["active to active", updateRoot("r-1", { attempt: 2 }), BAD_MOVE],
        ["fence without ending_at", updateRoot("r-1", { ...fence, ending_at: null }), "check"],
        [
          "retire active with ending_at",
          updateRoot("r-2", { ...retire, reason: "failed", ending_at: later }),
          BAD_MOVE,
        ],
        ["delete active", deleteRoot("r-1"), NO_DELETE],
        ["fence", updateRoot("r-1", fence), "ok"],
        [
          "ending to active",
          updateRoot("r-1", { state: "active", reason: null, ending_at: null }),
          BAD_MOVE,
        ],
        ["ending to ending", updateRoot("r-1", { ending_at: at }), BAD_MOVE],
        [
          "retire with a changed reason",
          updateRoot("r-1", { ...retire, reason: "cancelled" }),
          BAD_MOVE,
        ],
        [
          "retire with a changed ending_at",
          updateRoot("r-1", { ...retire, ending_at: at }),
          BAD_MOVE,
        ],
        ["delete ending", deleteRoot("r-1"), NO_DELETE],
        ["retire ending", updateRoot("r-1", retire), "ok"],
        ["retire active", updateRoot("r-2", { ...retire, reason: "failed" }), "ok"],
        [
          "retired to active",
          updateRoot("r-1", { state: "active", reason: null, ending_at: null, retired_at: null }),
          BAD_MOVE,
        ],
        [
          "retired to ending",
          updateRoot("r-2", { state: "ending", ending_at: later, retired_at: null }),
          BAD_MOVE,
        ],
        ["retired to retired", updateRoot("r-2", { reason: "abandoned" }), BAD_MOVE],
        ["delete retired", deleteRoot("r-2"), NO_DELETE],
        ["next root after retirement", insert(roots, activeRoot("r-3", "a-1")), "ok"],
      ]);
      assert.deepStrictEqual(yield* readRoot("r-1"), [
        { ...activeRoot("r-1", "a-1"), ...fence, ...retire },
      ]);
      assert.deepStrictEqual(yield* readRoot("r-2"), [
        { ...activeRoot("r-2", "a-2"), ...retire, reason: "failed" },
      ]);
    }).pipe(Effect.provide(migrated)),
  );

  it.effect("keys links and queue positions to assignments, with one scheduler row", () =>
    Effect.gen(function* () {
      yield* assignments;
      const links = "fd_assistant_factory_links";
      const positions = "fd_assistant_queue_positions";
      const link = (assignmentId: string, row: Row = {}): Row => ({
        assignment_id: assignmentId,
        capture_id: "cap-1",
        source_id: "source-1",
        item_id: "fd-7k3qa2",
        kind: "single",
        scope_hash: "scope",
        item_fingerprint: "fingerprint",
        runtime_mode: "approval-required",
        delivery_id: null,
        control: "none",
        created_at: at,
        updated_at: at,
        ...row,
      });
      const setDelivery = (assignmentId: string, deliveryId: string): Write =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE fd_assistant_factory_links SET delivery_id = ${deliveryId}
            WHERE assignment_id = ${assignmentId}`;
        });
      yield* expectOutcomes([
        ["link to a missing assignment", insert(links, link("missing")), "foreign key"],
        ["unknown control", insert(links, link("a-1", { control: "pause" })), "check"],
        [
          "link without fingerprint",
          insert(links, link("a-1", { item_fingerprint: null })),
          "not null",
        ],
        ["unclaimed link", insert(links, link("a-1")), "ok"],
        ["second unclaimed link", insert(links, link("a-2", { control: "stop" })), "ok"],
        [
          "second link for an assignment",
          insert(links, link("a-1", { control: "cancel" })),
          "unique",
        ],
        ["claim", setDelivery("a-1", "r-1"), "ok"],
        ["same root on another link", setDelivery("a-2", "r-1"), "unique"],
        [
          "position for a missing assignment",
          insert(positions, { assignment_id: "missing", seq: 1, overtaken: 0 }),
          "foreign key",
        ],
        ["position", insert(positions, { assignment_id: "a-1", seq: 1, overtaken: 0 }), "ok"],
        ["shared seq", insert(positions, { assignment_id: "a-2", seq: 1, overtaken: 0 }), "unique"],
        [
          "second position",
          insert(positions, { assignment_id: "a-1", seq: 2, overtaken: 0 }),
          "unique",
        ],
        [
          "another scheduler row",
          insert("fd_assistant_scheduler", { id: 2, next_seq: 1, grants: 0 }),
          "check",
        ],
        [
          "scheduler row again",
          insert("fd_assistant_scheduler", { id: 1, next_seq: 1, grants: 0 }),
          "unique",
        ],
      ]);
    }).pipe(Effect.provide(migrated)),
  );

  it.effect("gives each demand exactly its kind's identity and wake key", () =>
    Effect.gen(function* () {
      yield* assignments;
      yield* insert("fd_assistant_managed_roots", activeRoot("r-1", "a-1"));
      yield* insert("fd_assistant_managed_roots", activeRoot("r-2", "a-2"));
      const demands = "fd_assistant_admission_demands";
      let seq = 0;
      const demand = (row: Row): Row => ({
        seq: ++seq,
        root_delivery_id: "r-1",
        assignment_id: "a-1",
        delivery_id: null,
        state: "waiting",
        effect_id: null,
        thread_id: null,
        wake_key: null,
        pr_number: null,
        pr_url: null,
        child_thread_id: null,
        request_id: null,
        parent_run_id: null,
        generation: null,
        message_id: null,
        provider_thread_id: null,
        driver: null,
        instance_id: null,
        delivery: null,
        notification_json: null,
        provenance: null,
        blocked_reason: null,
        blocked_checked_at: null,
        overtaken: 0,
        requested_at: at,
        ...row,
      });
      const prUrl = "https://github.com/acme/app/pull/12";
      const kinds = {
        effect: { kind: "effect", delivery_id: "r-1", effect_id: 7 },
        pr: {
          kind: "pull_request_wake",
          thread_id: "t-author",
          wake_key: prUrl,
          pr_number: 12,
          pr_url: prUrl,
          provenance: "factory",
        },
        limit: {
          kind: "usage_limit_resume",
          thread_id: "t-author",
          wake_key: "command-1",
          provenance: "unknown",
        },
        question: {
          kind: "delegated_question",
          thread_id: "t-child",
          wake_key: "t-child:request-1",
          child_thread_id: "t-child",
          request_id: "request-1",
          provenance: "factory",
        },
        completion: {
          kind: "delegated_completion",
          thread_id: "t-author",
          wake_key: "run-1:2:message-1",
          parent_run_id: "run-1",
          generation: 2,
          message_id: "message-1",
          provider_thread_id: "provider-thread-1",
          driver: "claudeAgent",
          delivery: "message_text",
          notification_json: '{"type":"delegated-task-completed"}',
          provenance: "factory",
        },
        native: {
          kind: "background_wake",
          thread_id: "t-author",
          wake_key: "message-2",
          message_id: "message-2",
          provider_thread_id: "provider-thread-1",
          driver: "claudeAgent",
          instance_id: "instance-1",
          provenance: "unknown",
        },
      } satisfies Record<string, Row>;
      const add = (row: Row) => insert(demands, demand(row));
      const effect = demand(kinds.effect);
      yield* expectOutcomes([
        ["missing root", add({ ...kinds.effect, root_delivery_id: "missing" }), "foreign key"],
        ["missing assignment", add({ ...kinds.effect, assignment_id: "missing" }), "foreign key"],
        ["unknown kind", add({ ...kinds.limit, kind: "restart_continuation" }), "check"],
        ["unknown state", add({ ...kinds.effect, state: "held" }), "check"],
        ["unknown provenance", add({ ...kinds.limit, provenance: "explicit" }), "check"],
        ["effect without effect id", add({ ...kinds.effect, effect_id: null }), "check"],
        ["effect without delivery", add({ ...kinds.effect, delivery_id: null }), "check"],
        ["effect with thread", add({ ...kinds.effect, thread_id: "t-author" }), "check"],
        ["effect with wake key", add({ ...kinds.effect, wake_key: "key" }), "check"],
        ["effect with provenance", add({ ...kinds.effect, provenance: "factory" }), "check"],
        ["wake with effect id", add({ ...kinds.limit, effect_id: 7 }), "check"],
        ["wake without thread", add({ ...kinds.limit, thread_id: null }), "check"],
        ["wake without wake key", add({ ...kinds.limit, wake_key: null }), "check"],
        ["wake without provenance", add({ ...kinds.limit, provenance: null }), "check"],
        ["pr wake without number", add({ ...kinds.pr, pr_number: null }), "check"],
        ["pr wake without url", add({ ...kinds.pr, pr_url: null }), "check"],
        ["pr wake keyed otherwise", add({ ...kinds.pr, wake_key: "command-1" }), "check"],
        [
          "pr fields on another kind",
          add({ ...kinds.limit, pr_number: 12, pr_url: prUrl }),
          "check",
        ],
        ["question without request", add({ ...kinds.question, request_id: null }), "check"],
        ["question without child", add({ ...kinds.question, child_thread_id: null }), "check"],
        ["question keyed otherwise", add({ ...kinds.question, wake_key: "request-1" }), "check"],
        [
          "question fields on another kind",
          add({ ...kinds.limit, child_thread_id: "t-child" }),
          "check",
        ],
        [
          "completion without parent run",
          add({ ...kinds.completion, parent_run_id: null }),
          "check",
        ],
        ["completion without generation", add({ ...kinds.completion, generation: null }), "check"],
        ["completion without message", add({ ...kinds.completion, message_id: null }), "check"],
        [
          "completion without provider thread",
          add({ ...kinds.completion, provider_thread_id: null }),
          "check",
        ],
        ["completion without driver", add({ ...kinds.completion, driver: null }), "check"],
        ["completion without delivery", add({ ...kinds.completion, delivery: null }), "check"],
        [
          "completion with unknown delivery",
          add({ ...kinds.completion, delivery: "inline" }),
          "check",
        ],
        [
          "completion keyed otherwise",
          add({ ...kinds.completion, wake_key: "message-1" }),
          "check",
        ],
        [
          "completion with instance",
          add({ ...kinds.completion, instance_id: "instance-1" }),
          "check",
        ],
        ["completion fields on another kind", add({ ...kinds.native, generation: 2 }), "check"],
        [
          "notification on another kind",
          add({ ...kinds.native, notification_json: "{}" }),
          "check",
        ],
        ["native without instance", add({ ...kinds.native, instance_id: null }), "check"],
        ["native without message", add({ ...kinds.native, message_id: null }), "check"],
        [
          "native keyed otherwise",
          add({ ...kinds.native, wake_key: "t-author:provider-thread-1" }),
          "check",
        ],
        ["instance on another kind", add({ ...kinds.limit, instance_id: "instance-1" }), "check"],
        ["unknown block", add({ ...kinds.limit, blocked_reason: "busy" }), "check"],
        [
          "blocked while reserved",
          add({ ...kinds.limit, state: "reserved", blocked_reason: "revoked" }),
          "check",
        ],
        ["effect", insert(demands, effect), "ok"],
        ["pr wake", add(kinds.pr), "ok"],
        ["usage-limit resume", add(kinds.limit), "ok"],
        ["question", add(kinds.question), "ok"],
        ["completion", add(kinds.completion), "ok"],
        ["native wake", add(kinds.native), "ok"],
        [
          "blocked wake",
          add({
            ...kinds.limit,
            wake_key: "command-2",
            blocked_reason: "scope_changed",
            blocked_checked_at: at,
          }),
          "ok",
        ],
        ["reserved wake", add({ ...kinds.limit, wake_key: "command-3", state: "reserved" }), "ok"],
        ["shared seq", add({ ...kinds.limit, wake_key: "command-4", seq: effect.seq! }), "unique"],
        ["second demand for an effect", add({ ...kinds.effect, effect_id: 8 }), "unique"],
        ["a child's effect", add({ ...kinds.effect, delivery_id: "r-1-child-1" }), "ok"],
        [
          "another root's effect",
          add({
            ...kinds.effect,
            root_delivery_id: "r-2",
            assignment_id: "a-2",
            delivery_id: "r-2",
          }),
          "ok",
        ],
        ["repeated wake", add(kinds.pr), "unique"],
        ["repeated native wake", add({ ...kinds.native, instance_id: "instance-2" }), "unique"],
        ["same key for another kind", add({ ...kinds.limit, wake_key: prUrl }), "ok"],
        [
          "same wake for another root",
          add({ ...kinds.pr, root_delivery_id: "r-2", assignment_id: "a-2" }),
          "ok",
        ],
      ]);
    }).pipe(Effect.provide(migrated)),
  );

  it.effect("holds or reserves one slot per root and assignment", () =>
    Effect.gen(function* () {
      yield* assignments;
      yield* insert("fd_assistant_managed_roots", activeRoot("r-1", "a-1"));
      yield* insert("fd_assistant_managed_roots", activeRoot("r-2", "a-2"));
      yield* insert("fd_assistant_admission_demands", {
        seq: 1,
        root_delivery_id: "r-2",
        assignment_id: "a-2",
        kind: "usage_limit_resume",
        state: "reserved",
        thread_id: "t-author",
        wake_key: "command-1",
        provenance: "unknown",
        overtaken: 0,
        requested_at: at,
      });
      const sql = yield* SqlClient.SqlClient;
      const [reserved] = yield* sql<{ readonly id: number }>`
        SELECT id FROM fd_assistant_admission_demands
      `;
      const slots = "fd_assistant_slots";
      const held = (row: Row = {}): Row => ({
        root_delivery_id: "r-1",
        assignment_id: "a-1",
        state: "held",
        entry_seq: 1,
        granted_at: at,
        reserved_demand_id: null,
        lease_until: null,
        redelivered_by: null,
        ...row,
      });
      const reservation = {
        root_delivery_id: "r-2",
        assignment_id: "a-2",
        state: "reserved",
        reserved_demand_id: reserved!.id,
        lease_until: later,
        redelivered_by: "instance-1",
      };
      const deleteReserved: Write = sql`
        DELETE FROM fd_assistant_admission_demands WHERE id = ${reserved!.id}
      `.pipe(Effect.asVoid);
      yield* expectOutcomes([
        ["missing root", insert(slots, held({ root_delivery_id: "missing" })), "foreign key"],
        ["missing assignment", insert(slots, held({ assignment_id: "missing" })), "foreign key"],
        ["unknown state", insert(slots, held({ state: "draining" })), "check"],
        ["held with a demand", insert(slots, held({ reserved_demand_id: reserved!.id })), "check"],
        ["held with a lease", insert(slots, held({ lease_until: later })), "check"],
        ["held with redelivery", insert(slots, held({ redelivered_by: "instance-1" })), "check"],
        [
          "reserved without a demand",
          insert(slots, held({ ...reservation, reserved_demand_id: null })),
          "check",
        ],
        [
          "reserved without a lease",
          insert(slots, held({ ...reservation, lease_until: null })),
          "check",
        ],
        [
          "reserved for a missing demand",
          insert(slots, held({ ...reservation, reserved_demand_id: 999 })),
          "foreign key",
        ],
        ["held", insert(slots, held()), "ok"],
        ["reserved", insert(slots, held(reservation)), "ok"],
        ["second slot for a root", insert(slots, held({ assignment_id: "a-2" })), "unique"],
        [
          "second slot for an assignment",
          insert(slots, held({ root_delivery_id: "r-2" })),
          "unique",
        ],
        ["deleting a reserved demand", deleteReserved, "foreign key"],
      ]);
    }).pipe(Effect.provide(migrated)),
  );

  it.effect("records each admission with its kind's identity and one row per turn", () =>
    Effect.gen(function* () {
      yield* assignments;
      yield* insert("fd_assistant_managed_roots", activeRoot("r-1", "a-1"));
      const admissions = "fd_assistant_admissions";
      let next = 0;
      const admission = (row: Row): Row => ({
        admission_id: `admission-${++next}`,
        root_delivery_id: "r-1",
        assignment_id: "a-1",
        delivery_id: null,
        effect_id: null,
        thread_id: null,
        message_id: null,
        instance_id: "instance-1",
        state: "dispatching",
        entry_seq: 1,
        created_at: at,
        updated_at: at,
        ...row,
      });
      const kinds = {
        claim: { kind: "claim", delivery_id: "r-1" },
        effect: { kind: "effect", delivery_id: "r-1", effect_id: 3 },
        turn: { kind: "automatic_turn", thread_id: "t-author", message_id: "message-1" },
        delegation: {
          kind: "delegation",
          thread_id: "t-author",
          message_id: "mcp-delegation:6f1c1f2e-0d55-4c43-9a8e-3bf3c4d1a7a2",
        },
      } satisfies Record<string, Row>;
      const add = (row: Row) => insert(admissions, admission(row));
      const claim = admission(kinds.claim);
      yield* expectOutcomes([
        ["missing root", add({ ...kinds.claim, root_delivery_id: "missing" }), "foreign key"],
        ["missing assignment", add({ ...kinds.claim, assignment_id: "missing" }), "foreign key"],
        ["unknown kind", add({ ...kinds.claim, kind: "turn" }), "check"],
        ["unknown state", add({ ...kinds.claim, state: "done" }), "check"],
        ["without instance", add({ ...kinds.claim, instance_id: null }), "not null"],
        ["without entry_seq", add({ ...kinds.claim, entry_seq: null }), "not null"],
        ["effect without effect id", add({ ...kinds.effect, effect_id: null }), "check"],
        ["effect without delivery", add({ ...kinds.effect, delivery_id: null }), "check"],
        ["claim with effect id", add({ ...kinds.claim, effect_id: 3 }), "check"],
        [
          "claim with a turn",
          add({ ...kinds.claim, thread_id: "t-author", message_id: "message-1" }),
          "check",
        ],
        ["turn without thread", add({ ...kinds.turn, thread_id: null }), "check"],
        ["turn without message", add({ ...kinds.turn, message_id: null }), "check"],
        [
          "delegation without its key",
          add({ ...kinds.delegation, message_id: "message-2" }),
          "check",
        ],
        ["claim", insert(admissions, claim), "ok"],
        ["effect", add(kinds.effect), "ok"],
        ["automatic turn", add(kinds.turn), "ok"],
        ["delegation", add(kinds.delegation), "ok"],
        [
          "dispatched claim",
          add({ ...kinds.claim, state: "dispatched", instance_id: "instance-0" }),
          "ok",
        ],
        ["second admission of a turn", add(kinds.turn), "unique"],
        ["second admission of a delegation", add(kinds.delegation), "unique"],
        [
          "reused admission id",
          add({ ...kinds.claim, admission_id: claim.admission_id! }),
          "unique",
        ],
      ]);
    }).pipe(Effect.provide(migrated)),
  );

  it.effect("keeps one disposition per key, a declined native wake per provider thread", () =>
    Effect.gen(function* () {
      yield* assignments;
      yield* insert("fd_assistant_managed_roots", activeRoot("r-1", "a-1"));
      const dispositions = "fd_assistant_dispositions";
      const disposition = (row: Row): Row => ({
        root_delivery_id: "r-1",
        assignment_id: "a-1",
        thread_id: "t-author",
        class: "factory",
        outcome: "declined_ended",
        adapter_clear: null,
        recorded_at: at,
        ...row,
      });
      const pr = { kind: "pull_request_wake", wake_key: "https://github.com/acme/app/pull/12" };
      const declinedNative = {
        kind: "background_wake",
        wake_key: "t-author:provider-thread-1",
        class: "unknown",
        adapter_clear: "requested",
      };
      const lostNative = {
        kind: "background_wake",
        wake_key: "message-2",
        outcome: "lost_on_restart",
        adapter_clear: "unavailable",
      };
      const add = (row: Row) => insert(dispositions, disposition(row));
      yield* expectOutcomes([
        ["missing root", add({ ...pr, root_delivery_id: "missing" }), "foreign key"],
        ["missing assignment", add({ ...pr, assignment_id: "missing" }), "foreign key"],
        ["effect kind", add({ ...pr, kind: "effect" }), "check"],
        ["unknown class", add({ ...pr, class: "explicit" }), "check"],
        ["unknown outcome", add({ ...pr, outcome: "ignored" }), "check"],
        ["without thread", add({ ...pr, thread_id: null }), "not null"],
        ["adapter clear on another kind", add({ ...pr, adapter_clear: "unavailable" }), "check"],
        ["native without adapter clear", add({ ...declinedNative, adapter_clear: null }), "check"],
        ["unknown adapter clear", add({ ...declinedNative, adapter_clear: "maybe" }), "check"],
        [
          "declined native keyed by message",
          add({ ...declinedNative, wake_key: "message-3" }),
          "check",
        ],
        [
          "declined native of another thread",
          add({ ...declinedNative, wake_key: "t-other:provider-thread-1" }),
          "check",
        ],
        [
          "declined native without provider thread",
          add({ ...declinedNative, wake_key: "t-author:" }),
          "check",
        ],
        ["pr wake", add(pr), "ok"],
        ["usage-limit resume", add({ kind: "usage_limit_resume", wake_key: "command-1" }), "ok"],
        [
          "question",
          add({ kind: "delegated_question", wake_key: "t-child:request-1", thread_id: "t-child" }),
          "ok",
        ],
        ["completion", add({ kind: "delegated_completion", wake_key: "run-1:2:message-1" }), "ok"],
        ["declined native wake", add(declinedNative), "ok"],
        ["lost native wake", add(lostNative), "ok"],
        ["repeated pr wake", add({ ...pr, class: "unknown" }), "unique"],
        [
          "another wake on the provider thread",
          add({ ...declinedNative, adapter_clear: "unavailable" }),
          "unique",
        ],
      ]);
    }).pipe(Effect.provide(migrated)),
  );

  it.effect("keeps each assignment's newest 200 history rows in the appending transaction", () =>
    Effect.gen(function* () {
      yield* assignments;
      const sql = yield* SqlClient.SqlClient;
      const history = "fd_assistant_grant_history";
      const entry = (assignmentId: string, candidateSeq: number): Row => ({
        assignment_id: assignmentId,
        root_delivery_id: null,
        kind: "claim",
        candidate_seq: candidateSeq,
        outcome: "granted",
        at,
      });
      yield* expectOutcomes([
        ["unknown outcome", insert(history, { ...entry("a-1", 0), outcome: "skipped" }), "check"],
      ]);
      for (let seq = 1; seq <= 200; seq++) yield* insert(history, entry("a-1", seq));
      for (let seq = 1; seq <= 3; seq++) yield* insert(history, entry("a-2", seq));
      const kept = (assignmentId: string) =>
        sql<{ readonly total: number; readonly oldest: number; readonly newest: number }>`
          SELECT COUNT(*) AS total, MIN(candidate_seq) AS oldest, MAX(candidate_seq) AS newest
          FROM fd_assistant_grant_history WHERE assignment_id = ${assignmentId}
        `;
      assert.deepStrictEqual(yield* kept("a-1"), [{ total: 200, oldest: 1, newest: 200 }]);

      const inTransaction = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* insert(history, entry("a-1", 201));
          return yield* kept("a-1");
        }),
      );
      assert.deepStrictEqual(inTransaction, [{ total: 200, oldest: 2, newest: 201 }]);
      for (let seq = 202; seq <= 205; seq++) yield* insert(history, entry("a-1", seq));
      assert.deepStrictEqual(yield* kept("a-1"), [{ total: 200, oldest: 6, newest: 205 }]);
      assert.deepStrictEqual(yield* kept("a-2"), [{ total: 3, oldest: 1, newest: 3 }]);
      const numbers = yield* sql<{ readonly grant_number: number }>`
        SELECT grant_number FROM fd_assistant_grant_history
        WHERE assignment_id = 'a-1' ORDER BY candidate_seq
      `;
      const grantNumbers = numbers.map((row) => row.grant_number);
      assert.deepStrictEqual(
        grantNumbers,
        grantNumbers.toSorted((a, b) => a - b),
      );
    }).pipe(Effect.provide(migrated)),
  );
});

describe("assistant persistence composition", () => {
  it.effect("decodes the portfolio rows of core migrations 64-66 after the ledger runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const brief = {
        projectId: alpha,
        ideaId: "idea-1",
        goal: "Export reports as CSV",
        acceptanceCriteria: ["Download matches the table"],
        constraints: ["No new dependencies"],
        decisions: ["Stream large reports"],
        priority: { rank: 1, reason: "Finance asked for it" },
        openQuestions: ["Include archived rows?"],
        executionAuthorized: true,
        revision: 1,
        updatedAt: at,
      };
      // Rows as a build with only core migrations wrote them.
      yield* sql`INSERT INTO fd_assistant_project_briefs ${sql.insert({
        project_id: alpha,
        idea_id: "idea-1",
        goal: brief.goal,
        acceptance_criteria_json: JSON.stringify(brief.acceptanceCriteria),
        constraints_json: JSON.stringify(brief.constraints),
        decisions_json: JSON.stringify(brief.decisions),
        priority_rank: 1,
        priority_reason: brief.priority.reason,
        open_questions_json: JSON.stringify(brief.openQuestions),
        execution_authorized: 1,
        revision: 1,
        updated_at: at,
      })}`;
      const changes = [{ field: "goal" as const, previous: "", next: brief.goal }];
      yield* sql`INSERT INTO fd_assistant_brief_revisions ${sql.insert({
        project_id: alpha,
        idea_id: "idea-1",
        revision: 1,
        changes_json: JSON.stringify(changes),
        reason: "Agreed in conversation",
        recorded_at: at,
      })}`;
      yield* sql`INSERT INTO fd_assistant_assignments ${sql.insert({
        assignment_id: "a-keep",
        project_id: alpha,
        idea_id: "idea-1",
        executor: "looper",
        attempt: 1,
        state: "running",
        worker_refs_json: JSON.stringify([{ kind: "looper-run", id: "run-42" }]),
        progress_json: JSON.stringify([{ at, text: "Accepted by Looper" }]),
        evidence_json: "[]",
        created_at: at,
        updated_at: at,
      })}`;
      const dispatch = decodeDispatch({
        assignmentId: "a-keep",
        managerThreadId: "fd-assistant-owner",
        brief,
        modelSelection: { instanceId: "subscription", model: "configured" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        threadId: "thread-worker",
        commandId: "command-launch",
        messageId: "message-launch",
        runId: null,
        cancelRequested: false,
        resumeWorkspace: null,
        answeredRequestIds: [],
        lastProgress: "",
        lastNotice: "",
        looper: null,
        looperRunId: "run-42",
        previousLooperRunId: null,
        history: [],
        looperConfig: "/tmp/looper/config.json",
      });
      yield* sql`INSERT INTO fd_assistant_dispatches ${sql.insert({
        assignment_id: "a-keep",
        payload_json: encodeDispatchJson(dispatch),
      })}`;
      const portfolioRows = Effect.gen(function* () {
        const rows: Record<string, ReadonlyArray<unknown>> = {};
        for (const table of [
          "fd_assistant_project_briefs",
          "fd_assistant_brief_revisions",
          "fd_assistant_assignments",
          "fd_assistant_dispatches",
        ])
          rows[table] = yield* sql`SELECT * FROM ${sql(table)}`;
        return rows;
      });
      const before = yield* portfolioRows;

      const read = yield* Effect.gen(function* () {
        const store = yield* PortfolioStore.PortfolioStore;
        return {
          brief: yield* store.getBrief(alpha, "idea-1"),
          revisions: yield* store.listRevisions(alpha, "idea-1"),
          assignment: yield* store.getAssignment("a-keep"),
        };
      }).pipe(Effect.provide(ProjectAssistant.layerPersistence));
      assert.deepStrictEqual(yield* assistantLedger, assistantManifest);
      assert.deepStrictEqual(yield* coreLedger, migrationManifest);

      assert.deepStrictEqual(read.brief, Option.some(brief));
      assert.deepStrictEqual(read.revisions, [
        {
          projectId: alpha,
          ideaId: "idea-1",
          revision: 1,
          changes,
          reason: "Agreed in conversation",
          recordedAt: at,
        },
      ]);
      const assignment = Option.getOrThrow(read.assignment);
      assert.strictEqual(assignment.state, "running");
      assert.strictEqual(assignment.executor, "looper");
      assert.strictEqual(assignment.ideaId, "idea-1");
      assert.deepStrictEqual(assignment.workerRefs, [{ kind: "looper-run", id: "run-42" }]);
      const [stored] = yield* sql<{ readonly payload: string }>`
        SELECT payload_json AS payload FROM fd_assistant_dispatches
      `;
      assert.deepStrictEqual(decodeDispatchJson(stored!.payload), dispatch);
      assert.deepStrictEqual(yield* portfolioRows, before);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
