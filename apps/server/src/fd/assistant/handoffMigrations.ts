import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The assistant's own migration ledger for its Work and Factory handoff tables, migrated after
 * core for the reason Work keeps one: a fork entry in the core manifest would collide with
 * upstream's next migration. The portfolio tables of core migrations 64-66 stay where they are.
 *
 * Effect's Migrator compares ids only, never names: it skips every id up to the highest one
 * recorded in this table. Ids must therefore only ever be appended; renumbering or replacing an
 * entry would silently leave an older database on the old schema. A database whose ledger names
 * another migration under one of these ids is refused with a `BadState` migration error instead.
 */
export const ASSISTANT_MIGRATIONS_TABLE = "fd_assistant_migrations";

// Each DDL statement is its own query: the sqlite client does not run `;`-joined batches.

const AssistantWorkCaptures = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The one Work item an idea was captured as. `item_fingerprint` is null until a read-back
  // verified the item; an abandoned capture mints a new `capture_id` the next time.
  yield* sql`CREATE TABLE fd_assistant_work_captures (
    project_id TEXT NOT NULL,
    idea_id TEXT NOT NULL,
    capture_id TEXT NOT NULL UNIQUE,
    source_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('single', 'parent')),
    state TEXT NOT NULL CHECK (state IN ('pending', 'uncertain', 'captured')),
    writer_instance_id TEXT NOT NULL,
    item_id TEXT,
    item_key TEXT,
    item_url TEXT,
    item_fingerprint TEXT,
    content_hash TEXT NOT NULL,
    scope_hash TEXT NOT NULL,
    brief_revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, idea_id),
    CHECK (state <> 'captured' OR item_id IS NOT NULL)
  )`;
  // Kept for every capture id, abandoned ones included. `detail` is a fixed category, never text
  // from the source.
  yield* sql`CREATE TABLE fd_assistant_capture_events (
    capture_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event TEXT NOT NULL CHECK (event IN (
      'claimed', 'created', 'create_uncertain', 'recovered', 'updated', 'update_uncertain',
      'abandoned'
    )),
    item_id TEXT,
    detail TEXT,
    at TEXT NOT NULL,
    PRIMARY KEY (capture_id, sequence)
  )`;
});

const AssistantFactoryHandoff = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A Factory assignment's captured item and frozen scope. `delivery_id` names only the current
  // root: null until a claim, cleared by a retry. Former roots live in fd_assistant_managed_roots.
  yield* sql`CREATE TABLE fd_assistant_factory_links (
    assignment_id TEXT PRIMARY KEY NOT NULL REFERENCES fd_assistant_assignments (assignment_id),
    capture_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    scope_hash TEXT NOT NULL,
    item_fingerprint TEXT NOT NULL,
    runtime_mode TEXT NOT NULL,
    delivery_id TEXT UNIQUE,
    control TEXT NOT NULL CHECK (control IN ('none', 'stop', 'cancel')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  // Every root delivery id the assistant claimed, recorded before any of its threads can exist.
  // Rows are tombstones: never deleted, and moved only active -> ending -> retired or
  // active -> retired, so a formerly managed root never reads as never managed.
  yield* sql`CREATE TABLE fd_assistant_managed_roots (
    root_delivery_id TEXT PRIMARY KEY NOT NULL,
    assignment_id TEXT NOT NULL REFERENCES fd_assistant_assignments (assignment_id),
    attempt INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'ending', 'retired')),
    reason TEXT CHECK (reason IN ('completed', 'cancelled', 'failed', 'abandoned')),
    ending_at TEXT,
    retired_at TEXT,
    created_at TEXT NOT NULL,
    CHECK (state <> 'active' OR (reason IS NULL AND ending_at IS NULL AND retired_at IS NULL)),
    CHECK (state <> 'ending' OR (reason IS NOT NULL AND ending_at IS NOT NULL AND retired_at IS NULL)),
    CHECK (state <> 'retired' OR (reason IS NOT NULL AND retired_at IS NOT NULL))
  )`;
  yield* sql`CREATE UNIQUE INDEX fd_assistant_managed_roots_live
    ON fd_assistant_managed_roots (assignment_id)
    WHERE state IN ('active', 'ending')`;
  yield* sql`CREATE TRIGGER fd_assistant_managed_roots_kept
    BEFORE DELETE ON fd_assistant_managed_roots
    BEGIN
      SELECT RAISE(ABORT, 'Assistant managed roots are never deleted.');
    END`;
  // `ending_at` is set only by passing through ending, and retiring an ending root keeps the
  // reason its fence recorded.
  yield* sql`CREATE TRIGGER fd_assistant_managed_roots_moves
    BEFORE UPDATE ON fd_assistant_managed_roots
    WHEN NOT (
      NEW.root_delivery_id IS OLD.root_delivery_id
      AND NEW.assignment_id IS OLD.assignment_id
      AND NEW.attempt IS OLD.attempt
      AND NEW.created_at IS OLD.created_at
      AND (
        (OLD.state = 'active' AND NEW.state = 'ending')
        OR (OLD.state = 'active' AND NEW.state = 'retired' AND NEW.ending_at IS NULL)
        OR (
          OLD.state = 'ending' AND NEW.state = 'retired'
          AND NEW.reason IS OLD.reason AND NEW.ending_at IS OLD.ending_at
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'Assistant managed roots move only active -> ending -> retired.');
    END`;
  // One row: the next fair-order position and the number of grants made.
  yield* sql`CREATE TABLE fd_assistant_scheduler (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    next_seq INTEGER NOT NULL,
    grants INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO fd_assistant_scheduler (id, next_seq, grants) VALUES (1, 1, 0)`;
  // A waiting assignment's place in the fair order, for every executor.
  yield* sql`CREATE TABLE fd_assistant_queue_positions (
    assignment_id TEXT PRIMARY KEY NOT NULL REFERENCES fd_assistant_assignments (assignment_id),
    seq INTEGER NOT NULL UNIQUE,
    overtaken INTEGER NOT NULL
  )`;
  // Work waiting for its own grant. An effect demand names its delivery's effect. Every other
  // kind is an automatic turn on `thread_id`, keyed by `wake_key`, which each kind derives from
  // its identity columns; a completion also keeps what re-offering it needs.
  yield* sql`CREATE TABLE fd_assistant_admission_demands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seq INTEGER NOT NULL UNIQUE,
    root_delivery_id TEXT NOT NULL REFERENCES fd_assistant_managed_roots (root_delivery_id),
    assignment_id TEXT NOT NULL REFERENCES fd_assistant_assignments (assignment_id),
    delivery_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN (
      'effect', 'pull_request_wake', 'usage_limit_resume', 'delegated_question',
      'delegated_completion', 'background_wake'
    )),
    state TEXT NOT NULL CHECK (state IN ('waiting', 'reserved')),
    effect_id INTEGER,
    thread_id TEXT,
    wake_key TEXT,
    pr_number INTEGER,
    pr_url TEXT,
    child_thread_id TEXT,
    request_id TEXT,
    parent_run_id TEXT,
    generation INTEGER,
    message_id TEXT,
    provider_thread_id TEXT,
    driver TEXT,
    instance_id TEXT,
    delivery TEXT CHECK (delivery IN ('adapter_buffered', 'message_text')),
    notification_json TEXT,
    provenance TEXT CHECK (provenance IN ('factory', 'unknown')),
    blocked_reason TEXT CHECK (
      blocked_reason IN ('revoked', 'scope_changed', 'unreadable', 'item_closed')
    ),
    blocked_checked_at TEXT,
    overtaken INTEGER NOT NULL,
    requested_at TEXT NOT NULL,
    CHECK ((kind = 'effect') = (effect_id IS NOT NULL)),
    CHECK (kind <> 'effect' OR delivery_id IS NOT NULL),
    CHECK ((kind = 'effect') = (thread_id IS NULL)),
    CHECK ((kind = 'effect') = (wake_key IS NULL)),
    CHECK ((kind = 'effect') = (provenance IS NULL)),
    CHECK ((kind = 'pull_request_wake') = (pr_number IS NOT NULL)),
    CHECK ((kind = 'pull_request_wake') = (pr_url IS NOT NULL)),
    CHECK (kind <> 'pull_request_wake' OR wake_key IS pr_url),
    CHECK ((kind = 'delegated_question') = (child_thread_id IS NOT NULL)),
    CHECK ((kind = 'delegated_question') = (request_id IS NOT NULL)),
    CHECK (kind <> 'delegated_question' OR wake_key IS (child_thread_id || ':' || request_id)),
    CHECK ((kind = 'delegated_completion') = (parent_run_id IS NOT NULL)),
    CHECK ((kind = 'delegated_completion') = (generation IS NOT NULL)),
    CHECK ((kind IN ('delegated_completion', 'background_wake')) = (message_id IS NOT NULL)),
    CHECK ((kind IN ('delegated_completion', 'background_wake')) = (provider_thread_id IS NOT NULL)),
    CHECK ((kind IN ('delegated_completion', 'background_wake')) = (driver IS NOT NULL)),
    CHECK (
      kind <> 'delegated_completion'
      OR wake_key IS (parent_run_id || ':' || generation || ':' || message_id)
    ),
    CHECK ((kind = 'delegated_completion') = (delivery IS NOT NULL)),
    CHECK (kind = 'delegated_completion' OR notification_json IS NULL),
    CHECK ((kind = 'background_wake') = (instance_id IS NOT NULL)),
    CHECK (kind <> 'background_wake' OR wake_key IS message_id),
    CHECK (blocked_reason IS NULL OR state = 'waiting')
  )`;
  yield* sql`CREATE UNIQUE INDEX fd_assistant_admission_demands_effect
    ON fd_assistant_admission_demands (root_delivery_id, delivery_id)
    WHERE kind = 'effect'`;
  yield* sql`CREATE UNIQUE INDEX fd_assistant_admission_demands_wake
    ON fd_assistant_admission_demands (root_delivery_id, kind, wake_key)
    WHERE kind <> 'effect'`;
  // The capacity a root family holds. A reserved slot waits, under a lease, for the demand it
  // was granted to arrive; `redelivered_by` is the instance that last redelivered it.
  yield* sql`CREATE TABLE fd_assistant_slots (
    root_delivery_id TEXT PRIMARY KEY NOT NULL
      REFERENCES fd_assistant_managed_roots (root_delivery_id),
    assignment_id TEXT NOT NULL UNIQUE REFERENCES fd_assistant_assignments (assignment_id),
    state TEXT NOT NULL CHECK (state IN ('held', 'reserved')),
    entry_seq INTEGER NOT NULL,
    granted_at TEXT NOT NULL,
    reserved_demand_id INTEGER REFERENCES fd_assistant_admission_demands (id),
    lease_until TEXT,
    redelivered_by TEXT,
    CHECK (
      state <> 'held'
      OR (reserved_demand_id IS NULL AND lease_until IS NULL AND redelivered_by IS NULL)
    ),
    CHECK (state <> 'reserved' OR (reserved_demand_id IS NOT NULL AND lease_until IS NOT NULL))
  )`;
  // One row per admitted dispatch, dispatching until it returns. `entry_seq` is the value its
  // admitting transaction wrote; `instance_id` tells a dead process's rows from this one's.
  yield* sql`CREATE TABLE fd_assistant_admissions (
    admission_id TEXT PRIMARY KEY NOT NULL,
    root_delivery_id TEXT NOT NULL REFERENCES fd_assistant_managed_roots (root_delivery_id),
    assignment_id TEXT NOT NULL REFERENCES fd_assistant_assignments (assignment_id),
    kind TEXT NOT NULL CHECK (kind IN ('claim', 'effect', 'automatic_turn', 'delegation')),
    delivery_id TEXT,
    effect_id INTEGER,
    thread_id TEXT,
    message_id TEXT,
    instance_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('dispatching', 'dispatched')),
    entry_seq INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((kind = 'effect') = (effect_id IS NOT NULL)),
    CHECK (kind <> 'effect' OR delivery_id IS NOT NULL),
    CHECK ((kind IN ('automatic_turn', 'delegation')) = (thread_id IS NOT NULL)),
    CHECK ((kind IN ('automatic_turn', 'delegation')) = (message_id IS NOT NULL)),
    CHECK (kind <> 'delegation' OR substr(message_id, 1, 15) = 'mcp-delegation:')
  )`;
  yield* sql`CREATE UNIQUE INDEX fd_assistant_admissions_turn
    ON fd_assistant_admissions (kind, thread_id, message_id)
    WHERE kind IN ('automatic_turn', 'delegation')`;
  // Automatic work that was declined or lost instead of run, one notice per key. A declined
  // native wake is keyed thread:providerThread, so a provider thread gets one notice; a lost one
  // is keyed by its message id.
  yield* sql`CREATE TABLE fd_assistant_dispositions (
    root_delivery_id TEXT NOT NULL REFERENCES fd_assistant_managed_roots (root_delivery_id),
    kind TEXT NOT NULL CHECK (kind IN (
      'pull_request_wake', 'usage_limit_resume', 'delegated_question', 'delegated_completion',
      'background_wake'
    )),
    wake_key TEXT NOT NULL,
    assignment_id TEXT NOT NULL REFERENCES fd_assistant_assignments (assignment_id),
    thread_id TEXT NOT NULL,
    class TEXT NOT NULL CHECK (class IN ('factory', 'unknown')),
    outcome TEXT NOT NULL CHECK (outcome IN ('declined_ended', 'lost_on_restart')),
    adapter_clear TEXT CHECK (adapter_clear IN ('requested', 'unavailable')),
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (root_delivery_id, kind, wake_key),
    CHECK ((kind = 'background_wake') = (adapter_clear IS NOT NULL)),
    CHECK (
      kind <> 'background_wake' OR outcome <> 'declined_ended'
      OR (
        length(wake_key) > length(thread_id) + 1
        AND substr(wake_key, 1, length(thread_id) + 1) = thread_id || ':'
      )
    )
  )`;
  yield* sql`CREATE TABLE fd_assistant_grant_history (
    grant_number INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id TEXT NOT NULL,
    root_delivery_id TEXT,
    kind TEXT NOT NULL,
    candidate_seq INTEGER,
    outcome TEXT NOT NULL CHECK (outcome IN (
      'granted', 'expired', 'stale', 'released', 'declined', 'unused', 'moot', 'blocked',
      'unblocked', 'lost_on_restart', 'retired'
    )),
    at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX fd_assistant_grant_history_assignment
    ON fd_assistant_grant_history (assignment_id, grant_number)`;
  // Keeps each assignment's newest 200 rows, pruned in the transaction that appends.
  yield* sql`CREATE TRIGGER fd_assistant_grant_history_bound
    AFTER INSERT ON fd_assistant_grant_history
    BEGIN
      DELETE FROM fd_assistant_grant_history
      WHERE assignment_id = NEW.assignment_id
        AND grant_number <= (
          SELECT grant_number FROM fd_assistant_grant_history
          WHERE assignment_id = NEW.assignment_id
          ORDER BY grant_number DESC
          LIMIT 1 OFFSET 200
        );
    END`;
});

export const assistantMigrationEntries = [
  [1, "AssistantWorkCaptures", AssistantWorkCaptures],
  [2, "AssistantFactoryHandoff", AssistantFactoryHandoff],
] as const;

const run = Migrator.make({});

/**
 * The migrator keys on migration_id and skips every id up to the highest recorded one, so a
 * ledger written by another build would silently skip this build's migration at a shared id.
 */
const assertAssistantMigrationsCanRun = Effect.fn("assertAssistantMigrationsCanRun")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${ASSISTANT_MIGRATIONS_TABLE}
  `;
  if (tables.length === 0) return;
  const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM ${sql(ASSISTANT_MIGRATIONS_TABLE)}
  `;
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.migration_id));
  const recordedNames = new Map(recorded.map((row) => [row.migration_id, row.name]));
  const skipped = assistantMigrationEntries.flatMap(([id, name]) => {
    if (id > latestRecordedId) return [];
    const recordedName = recordedNames.get(id);
    return recordedName === name ? [] : [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
  });
  if (skipped.length === 0) return;
  // The portfolio tables share the fd_assistant_ prefix but belong to core, so dropping the
  // prefix's tables is never the advice here.
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message: `This database's assistant migration history would skip required schema migrations: ${skipped.join(", ")}. The migrator skips every id up to the highest recorded id (${latestRecordedId}), regardless of name. It was written by a different build; report this history so an upgrade path can be added.`,
  });
});

/** Applies pending assistant migrations on a database whose core migrations already ran. */
export const runAssistantMigrations = Effect.fn("runAssistantMigrations")(function* () {
  yield* assertAssistantMigrationsCanRun();
  const executed = yield* run({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        assistantMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
    table: ASSISTANT_MIGRATIONS_TABLE,
  });
  if (executed.length > 0) {
    yield* Effect.log("Assistant migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});

/** Provide on top of the core-migrated SQL client; assistant stores are built on this layer. */
export const layer = Layer.effectDiscard(runAssistantMigrations());
