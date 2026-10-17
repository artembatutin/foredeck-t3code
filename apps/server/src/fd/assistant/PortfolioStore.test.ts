import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import type { AssignmentEvent } from "./portfolio.ts";
import * as PortfolioStore from "./PortfolioStore.ts";
import portfolioMigration from "./migration.ts";

const PORTFOLIO_TABLES = [
  "fd_assistant_assignments",
  "fd_assistant_brief_revisions",
  "fd_assistant_dispatches",
  "fd_assistant_project_briefs",
  "fd_assistant_spoken_replies",
];

const schemaObjects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly type: string; readonly name: string; readonly sql: string | null }>`
    SELECT type, name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `;
});

const isPortfolioObject = (name: string) => name.startsWith("fd_assistant_");

const portfolioTables = (
  objects: ReadonlyArray<{ readonly type: string; readonly name: string }>,
) =>
  objects
    .filter((object) => object.type === "table" && isPortfolioObject(object.name))
    .map((object) => object.name);

/** A full server persistence stack (migrations included) on one database file. */
const persistenceAt = (dbPath: string) =>
  PortfolioStore.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerFromPath(dbPath)),
    Layer.provide(NodeServices.layer),
  );

const tempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fd-portfolio-" });
  return path.join(dir, "state.sqlite");
});

const memoryStore = PortfolioStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const alpha = ProjectId.make("project-alpha");

describe("migration 064", () => {
  it.effect("upgrades migration-63 assistant data without losing briefs or assignments", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* portfolioMigration;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (63, 'AssistantPortfolio')`;
      const store = yield* PortfolioStore.PortfolioStore;
      yield* sql`INSERT INTO fd_assistant_project_briefs VALUES (${alpha}, 'Keep this brief', '[]', '[]', NULL, NULL, '[]', 0, 1, '2026-10-16T12:00:00.000Z')`;
      yield* sql`INSERT INTO fd_assistant_brief_revisions VALUES (${alpha}, 1, '[]', 'Original decision', '2026-10-16T12:00:00.000Z')`;
      yield* sql`INSERT INTO fd_assistant_assignments VALUES ('keep', ${alpha}, 'foredeck', 1, 'draft', '[]', '[]', '[]', '2026-10-16T12:00:00.000Z', '2026-10-16T12:00:00.000Z')`;
      yield* runMigrations();
      const brief = Option.getOrThrow(yield* store.getBrief(alpha));
      assert.equal(brief.ideaId, "legacy");
      assert.equal(brief.goal, "Keep this brief");
      assert.equal((yield* store.listRevisions(alpha))[0]!.reason, "Original decision");
      assert.equal(Option.getOrThrow(yield* store.getAssignment("keep")).ideaId, "legacy");
      const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_projects)`;
      assert.isTrue(columns.some((c) => c.name === "repositories_json"));
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(
      Effect.provide(
        PortfolioStore.layer.pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        ),
      ),
    ),
  );

  it.effect("creates the portfolio tables on a fresh database", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      assert.deepStrictEqual(portfolioTables(yield* schemaObjects), PORTFOLIO_TABLES);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("adds only portfolio objects to a database migrated through 063", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 63 });
      const before = yield* schemaObjects;
      assert.isFalse(before.some((object) => isPortfolioObject(object.name)));

      assert.deepStrictEqual(yield* runMigrations(), [
        [64, "AssistantPortfolio"],
        [65, "AssistantDispatches"],
        [66, "AssistantIdeas"],
      ]);
      const after = yield* schemaObjects;
      assert.deepStrictEqual(
        after.filter((object) => !isPortfolioObject(object.name)),
        before,
      );
      assert.deepStrictEqual(portfolioTables(after), PORTFOLIO_TABLES);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

describe("PortfolioStore persistence", () => {
  it.effect("keeps a brief and its assignment across a persistence restart", () =>
    Effect.gen(function* () {
      const dbPath = yield* tempDatabase;

      const written = yield* Effect.gen(function* () {
        const store = yield* PortfolioStore.PortfolioStore;
        const brief = yield* store.reviseBrief({
          projectId: alpha,
          patch: {
            goal: "Export reports as CSV",
            acceptanceCriteria: ["Download matches the table", "Large reports stream"],
            constraints: ["No new dependencies"],
            priority: { rank: 2, reason: "Finance asked for it this month" },
            openQuestions: ["Include archived rows?"],
            executionAuthorized: true,
          },
          reason: "Agreed in conversation",
        });
        yield* store.createAssignment({
          assignmentId: "assignment-alpha-1",
          projectId: alpha,
          executor: "looper",
        });
        yield* store.transitionAssignment({
          assignmentId: "assignment-alpha-1",
          event: { type: "queue" },
        });
        const assignment = yield* store.transitionAssignment({
          assignmentId: "assignment-alpha-1",
          event: {
            type: "start",
            workerRefs: [{ kind: "looper-run", id: "run-42" }],
            note: "Accepted by Looper",
          },
        });
        return { brief, assignment };
      }).pipe(Effect.provide(persistenceAt(dbPath)));

      const reread = yield* Effect.gen(function* () {
        const store = yield* PortfolioStore.PortfolioStore;
        return {
          brief: yield* store.getBrief(alpha),
          assignment: yield* store.getAssignment("assignment-alpha-1"),
          briefs: yield* store.listBriefs(),
        };
      }).pipe(Effect.provide(persistenceAt(dbPath)));

      assert.deepStrictEqual(reread.brief, Option.some(written.brief));
      const brief = Option.getOrThrow(reread.brief);
      assert.strictEqual(brief.projectId, alpha);
      assert.strictEqual(brief.goal, "Export reports as CSV");
      assert.deepStrictEqual(brief.acceptanceCriteria, [
        "Download matches the table",
        "Large reports stream",
      ]);
      assert.deepStrictEqual(brief.constraints, ["No new dependencies"]);
      assert.deepStrictEqual(brief.priority, {
        rank: 2,
        reason: "Finance asked for it this month",
      });
      assert.deepStrictEqual(brief.openQuestions, ["Include archived rows?"]);
      assert.isTrue(brief.executionAuthorized);
      assert.deepStrictEqual(reread.briefs, [brief]);

      assert.deepStrictEqual(reread.assignment, Option.some(written.assignment));
      const assignment = Option.getOrThrow(reread.assignment);
      assert.strictEqual(assignment.state, "running");
      assert.strictEqual(assignment.executor, "looper");
      assert.strictEqual(assignment.attempt, 1);
      assert.deepStrictEqual(assignment.workerRefs, [{ kind: "looper-run", id: "run-42" }]);
      assert.deepStrictEqual(
        assignment.progress.map((note) => note.text),
        ["Accepted by Looper"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "returns the latest values and every previous priority with its reason after restart",
    () =>
      Effect.gen(function* () {
        const dbPath = yield* tempDatabase;

        yield* Effect.gen(function* () {
          const store = yield* PortfolioStore.PortfolioStore;
          yield* store.reviseBrief({
            projectId: alpha,
            patch: { goal: "Ship sync", priority: { rank: 3, reason: "Nice to have" } },
          });
          yield* store.reviseBrief({
            projectId: alpha,
            patch: { goal: "Ship offline sync" },
            reason: "Owner corrected the goal",
          });
          yield* store.reviseBrief({
            projectId: alpha,
            patch: { priority: { rank: 2, reason: "Customer demo next week" } },
          });
          yield* store.reviseBrief({
            projectId: alpha,
            patch: { priority: { rank: 1, reason: "Blocks the release" } },
          });
          // Repeating an unchanged correction records nothing.
          const repeated = yield* store.reviseBrief({
            projectId: alpha,
            patch: { priority: { rank: 1, reason: "Blocks the release" } },
            reason: "Said it again",
          });
          assert.strictEqual(repeated.revision, 4);
        }).pipe(Effect.provide(persistenceAt(dbPath)));

        const { brief, revisions } = yield* Effect.gen(function* () {
          const store = yield* PortfolioStore.PortfolioStore;
          return {
            brief: Option.getOrThrow(yield* store.getBrief(alpha)),
            revisions: yield* store.listRevisions(alpha),
          };
        }).pipe(Effect.provide(persistenceAt(dbPath)));

        assert.strictEqual(brief.goal, "Ship offline sync");
        assert.deepStrictEqual(brief.priority, { rank: 1, reason: "Blocks the release" });
        assert.strictEqual(brief.revision, 4);
        assert.deepStrictEqual(
          revisions.map(({ revision, changes, reason }) => ({ revision, changes, reason })),
          [
            {
              revision: 1,
              changes: [
                { field: "goal", previous: "", next: "Ship sync" },
                { field: "priority", previous: null, next: { rank: 3, reason: "Nice to have" } },
              ],
              reason: null,
            },
            {
              revision: 2,
              changes: [{ field: "goal", previous: "Ship sync", next: "Ship offline sync" }],
              reason: "Owner corrected the goal",
            },
            {
              revision: 3,
              changes: [
                {
                  field: "priority",
                  previous: { rank: 3, reason: "Nice to have" },
                  next: { rank: 2, reason: "Customer demo next week" },
                },
              ],
              reason: null,
            },
            {
              revision: 4,
              changes: [
                {
                  field: "priority",
                  previous: { rank: 2, reason: "Customer demo next week" },
                  next: { rank: 1, reason: "Blocks the release" },
                },
              ],
              reason: null,
            },
          ],
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("PortfolioStore assignments", () => {
  const transitionOutcome = (assignmentId: string, event: AssignmentEvent) =>
    Effect.gen(function* () {
      const store = yield* PortfolioStore.PortfolioStore;
      return yield* store.transitionAssignment({ assignmentId, event }).pipe(
        Effect.map((assignment): string => assignment.state),
        Effect.catchTags({
          AssignmentTransitionRejected: (error) => Effect.succeed(`rejected:${error.reason}`),
          AssignmentNotFound: () => Effect.succeed("not-found"),
        }),
      );
    });

  it.effect("dispatches only against the stored brief's current authorization", () =>
    Effect.gen(function* () {
      const store = yield* PortfolioStore.PortfolioStore;
      const bravo = ProjectId.make("project-bravo");
      yield* store.createAssignment({
        assignmentId: "no-brief",
        projectId: bravo,
        executor: "foredeck",
      });
      assert.strictEqual(
        yield* transitionOutcome("no-brief", { type: "queue" }),
        "rejected:not-authorized",
      );

      yield* store.reviseBrief({ projectId: alpha, patch: { goal: "Export reports" } });
      yield* store.createAssignment({
        assignmentId: "a-1",
        projectId: alpha,
        executor: "foredeck",
      });
      assert.strictEqual(
        yield* transitionOutcome("a-1", { type: "queue" }),
        "rejected:not-authorized",
      );
      assert.strictEqual(Option.getOrThrow(yield* store.getAssignment("a-1")).state, "draft");

      yield* store.reviseBrief({
        projectId: alpha,
        patch: { executionAuthorized: true },
        reason: "Owner said go",
      });
      assert.strictEqual(yield* transitionOutcome("a-1", { type: "queue" }), "queued");

      // Revoking authorization blocks the start but not cancelling the queued work.
      yield* store.reviseBrief({ projectId: alpha, patch: { executionAuthorized: false } });
      assert.strictEqual(
        yield* transitionOutcome("a-1", {
          type: "start",
          workerRefs: [{ kind: "thread", id: "thread-1" }],
        }),
        "rejected:not-authorized",
      );
      assert.strictEqual(yield* transitionOutcome("a-1", { type: "cancel" }), "cancelled");
      assert.strictEqual(yield* transitionOutcome("missing", { type: "queue" }), "not-found");
    }).pipe(Effect.provide(memoryStore)),
  );

  it.effect("creates one assignment per id even when requests repeat concurrently", () =>
    Effect.gen(function* () {
      const store = yield* PortfolioStore.PortfolioStore;
      const create = store.createAssignment({
        assignmentId: "a-dup",
        projectId: alpha,
        executor: "foredeck",
      });
      const [first, second] = yield* Effect.all([create, create], { concurrency: 2 });
      assert.deepStrictEqual(first, second);

      yield* store.reviseBrief({ projectId: alpha, patch: { executionAuthorized: true } });
      yield* store.transitionAssignment({ assignmentId: "a-dup", event: { type: "queue" } });
      // A retried create after the assignment moved on does not reset it.
      assert.strictEqual((yield* create).state, "queued");
      assert.deepStrictEqual(
        (yield* store.listAssignments({ projectId: alpha })).map((a) => a.assignmentId),
        ["a-dup"],
      );
      assert.deepStrictEqual(
        (yield* store.listAssignments({ states: ["queued"] })).map((a) => a.assignmentId),
        ["a-dup"],
      );
      assert.deepStrictEqual(yield* store.listAssignments({ states: [] }), []);
    }).pipe(Effect.provide(memoryStore)),
  );
});
