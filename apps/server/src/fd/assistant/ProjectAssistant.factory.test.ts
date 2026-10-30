import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as Launches from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import { v2PullRequestThread } from "../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Projects from "../../project/ProjectService.ts";
import * as Git from "../../vcs/GitVcsDriver.ts";
import * as HandoffAdmission from "./HandoffAdmission.ts";
import * as HandoffBackend from "./handoffBackend.ts";
import * as Looper from "./Looper.ts";
import { type Assignment, briefScopeHash } from "./portfolio.ts";
import * as Assistant from "./ProjectAssistant.ts";

/**
 * The assistant's Factory executor over a fake Factory and Work: what its enqueue writes, what its
 * claim commits before Factory is called, and each pre-delivery control, with every call counted.
 * `FactoryHandoff.dispatch.test.ts` runs the same seams on the real stack.
 */

const alpha = ProjectId.make("alpha");
const managerId = ThreadId.make("fd-assistant-owner");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "configured" };
const at = "2026-10-29T12:00:00.000Z";
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");

const managerShell = (overrides: Partial<OrchestrationV2ThreadShell> = {}) => ({
  ...v2PullRequestThread({
    id: managerId,
    projectId: ProjectId.make("manager-workspace"),
    title: "Assistant",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestUserMessageAt: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
  }),
  ...overrides,
});

interface FakeItem {
  fingerprint: string;
  status: "todo" | "in_progress" | "done" | "cancelled";
  readable: boolean;
}

type Status = HandoffBackend.HandoffDelivery["status"];

/** The fakes' state, what the assistant asked of them, and failures a test turns on. */
const makeFakes = () => {
  const fakes = {
    manager: managerShell() as OrchestrationV2ThreadShell | null,
    repositories: [] as ReadonlyArray<string>,
    projectGone: false,
    items: new Map<string, FakeItem>(),
    deliveries: new Map<string, Status>(),
    /** Every Factory call, in order, as `<operation>:<id>`. */
    calls: [] as Array<string>,
    verify: true as boolean,
    verifyFails: false,
    getFails: false,
    cancelFails: false,
    stopFails: false,
    /** Run once each, inside the next Work read and the next verify read, before they answer. */
    onRead: undefined as Effect.Effect<void> | undefined,
    onVerify: undefined as Effect.Effect<void> | undefined,
    /** Runs at the start of each `start`, in its place when it returns a failure. */
    onStart: undefined as
      | ((
          id: string,
        ) => Effect.Effect<
          "store" | "none" | "lost" | "ambiguous" | "refuse" | "active",
          never,
          never
        >)
      | undefined,
    launches: [] as Array<Launches.ThreadLaunchInput>,
  };
  return fakes;
};
type Fakes = ReturnType<typeof makeFakes>;

/** Runs a hook a test set, once. */
const runOnce = (fakes: Fakes, hook: "onRead" | "onVerify") =>
  Effect.suspend(() => {
    const effect = fakes[hook];
    fakes[hook] = undefined;
    return effect ?? Effect.void;
  });

const count = (fakes: Fakes, operation: string) =>
  fakes.calls.filter((call) => call.startsWith(`${operation}:`)).length;

const factoryPort = (fakes: Fakes): typeof HandoffBackend.HandoffFactory.Service => {
  const known = (id: string) => {
    const status = fakes.deliveries.get(id);
    return status === undefined
      ? Effect.fail(
          new HandoffBackend.HandoffFactoryRefused({ operation: "stop", reason: "not_found" }),
        )
      : Effect.succeed(status);
  };
  return {
    verifyConfigured: () =>
      Effect.andThen(
        runOnce(fakes, "onVerify"),
        Effect.suspend(() =>
          fakes.verifyFails
            ? Effect.fail(new HandoffBackend.HandoffFactoryError({ operation: "verify" }))
            : Effect.succeed(fakes.verify),
        ),
      ),
    get: (id) =>
      Effect.suspend(() => {
        fakes.calls.push(`get:${id}`);
        if (fakes.getFails) {
          return Effect.fail(new HandoffBackend.HandoffFactoryError({ operation: "get" }));
        }
        const status = fakes.deliveries.get(id);
        return Effect.succeed(
          status === undefined ? Option.none() : Option.some({ deliveryId: id, status }),
        );
      }),
    start: ({ deliveryId }) =>
      Effect.gen(function* () {
        fakes.calls.push(`start:${deliveryId}`);
        const outcome = fakes.onStart === undefined ? "store" : yield* fakes.onStart(deliveryId);
        if (outcome === "refuse") {
          return yield* new HandoffBackend.HandoffFactoryRefused({
            operation: "start",
            reason: "no_base_commit",
          });
        }
        if (outcome === "active") {
          return yield* new HandoffBackend.HandoffFactoryRefused({
            operation: "start",
            reason: "active",
            activeDeliveryId: "outside",
          });
        }
        if (outcome === "ambiguous") {
          return yield* new HandoffBackend.HandoffFactoryError({ operation: "start" });
        }
        // What a start does: an absent or queued row runs; any other stays as it is.
        const status = fakes.deliveries.get(deliveryId);
        if (status === undefined || status === "queued") {
          fakes.deliveries.set(deliveryId, outcome === "none" ? "queued" : "running");
        }
        if (outcome === "lost") {
          return yield* new HandoffBackend.HandoffFactoryError({ operation: "start" });
        }
        return { deliveryId, status: fakes.deliveries.get(deliveryId) ?? "running" };
      }),
    stop: (id) =>
      Effect.gen(function* () {
        fakes.calls.push(`stop:${id}`);
        if (fakes.stopFails) {
          return yield* new HandoffBackend.HandoffFactoryError({ operation: "stop" });
        }
        const status = yield* known(id);
        if (status !== "running" && status !== "stopping") {
          return yield* new HandoffBackend.HandoffFactoryRefused({
            operation: "stop",
            reason: "not_stoppable",
          });
        }
        fakes.deliveries.set(id, "stopping");
        return { deliveryId: id, status: "stopping" as const };
      }),
    resume: (id) =>
      Effect.gen(function* () {
        fakes.calls.push(`resume:${id}`);
        const status = yield* known(id);
        if (!["stopping", "stopped", "blocked"].includes(status)) {
          return yield* new HandoffBackend.HandoffFactoryRefused({
            operation: "resume",
            reason: "not_resumable",
          });
        }
        fakes.deliveries.set(id, "running");
        return { deliveryId: id, status: "running" as const };
      }),
    cancel: (id) =>
      Effect.gen(function* () {
        fakes.calls.push(`cancel:${id}`);
        if (fakes.cancelFails) {
          return yield* new HandoffBackend.HandoffFactoryError({ operation: "cancel" });
        }
        const status = yield* known(id);
        if (status === "done" || status === "cancelled") {
          return yield* new HandoffBackend.HandoffFactoryRefused({
            operation: "cancel",
            reason: "ended",
          });
        }
        fakes.deliveries.set(id, "cancelled");
        return { deliveryId: id, status: "cancelled" as const };
      }),
    follow: (id) =>
      Effect.suspend(() => {
        if (fakes.getFails) {
          return Effect.fail(new HandoffBackend.HandoffFactoryError({ operation: "follow" }));
        }
        const status = fakes.deliveries.get(id);
        return Effect.succeed(
          status === undefined
            ? Option.none()
            : Option.some({
                deliveryId: id,
                status,
                awaiting: null,
                pullRequest: null,
                reason: null,
                threadId: null,
                child: null,
                marked: [],
              }),
        );
      }),
    ensureDeferred: () => Effect.succeed("stale"),
    redispatch: () => Effect.succeed("stale"),
    runStateOf: () => Effect.succeed("ended"),
    requests: () => Effect.succeed([]),
    activity: (id) =>
      Effect.sync(() => {
        const status = fakes.deliveries.get(id);
        return {
          phase:
            status === undefined
              ? ("missing" as const)
              : status === "done" || status === "cancelled"
                ? ("terminal" as const)
                : ("proceeding" as const),
          busy: false,
          deferred: false,
          unknown: false,
        };
      }),
  };
};

const workPort = (fakes: Fakes): Partial<typeof HandoffBackend.HandoffBackend.Service> => ({
  read: (ref) =>
    Effect.andThen(
      runOnce(fakes, "onRead"),
      Effect.suspend(() => {
        const item = fakes.items.get(ref.itemId);
        if (item === undefined || !item.readable) {
          return Effect.fail(
            new HandoffBackend.HandoffBackendError({ operation: "read", reason: "unavailable" }),
          );
        }
        return Effect.succeed({
          ref,
          key: ref.itemId,
          url: null,
          title: "An item",
          status: item.status,
          revision: "1",
          invalid: false,
          body: "",
          fingerprint: item.fingerprint,
          notes: "",
        });
      }),
    ),
});

const layerOf = (fakes: Fakes, probe?: typeof HandoffAdmission.HandoffAdmissionProbe.Service) => {
  const coreReads = Layer.mergeAll(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: () => Effect.suspend(() => Effect.succeed(fakes.manager)),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (projectId) =>
        Effect.suspend(() =>
          Effect.succeed(
            fakes.projectGone
              ? Option.none()
              : Option.some({
                  projectId,
                  title: "Alpha",
                  workspaceRoot: "/projects/alpha",
                  defaultModelSelection: null,
                  defaultThreadEnvMode: null,
                  autoPull: false,
                  faviconPath: null,
                  projectIcon: null,
                  scripts: [],
                  createdAt: at,
                  updatedAt: at,
                  deletedAt: null,
                  repositories: fakes.repositories,
                } as never),
          ),
        ),
    }),
  );
  const admission = HandoffAdmission.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        coreReads,
        Assistant.layerPersistence,
        probe === undefined
          ? Layer.empty
          : Layer.succeed(HandoffAdmission.HandoffAdmissionProbe, probe),
      ),
    ),
  );
  const core = Layer.mergeAll(
    Layer.mock(Threads.ThreadManagementService)({
      // An ordinary worker's thread is unknown here, so its launch stays unconfirmed.
      getThreadShell: (id) =>
        Effect.suspend(() => Effect.succeed(id === managerId ? fakes.manager : null)),
    }),
    Layer.mock(Looper.Looper)({}),
    Layer.mock(Projects.ProjectService)({
      getById: (id) =>
        Effect.suspend(() =>
          Effect.succeed(
            fakes.projectGone
              ? Option.none()
              : Option.some({
                  id,
                  title: id,
                  workspaceRoot: `/projects/${id}`,
                  repositories: fakes.repositories,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: at,
                  updatedAt: at,
                  deletedAt: null,
                } as never),
          ),
        ),
    }),
    Layer.mock(Git.GitVcsDriver)({
      execute: () =>
        Effect.succeed({
          exitCode: 0,
          stdout: "true\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        } as never),
    }),
    Layer.mock(Launches.ThreadLaunchService)({
      checkWorktreeBase: () => Effect.void,
      launch: (input) =>
        Effect.sync(() => {
          fakes.launches.push(input);
          return {
            threadId: input.threadId!,
            projection: { runs: [] } as never,
            resumed: false,
          };
        }),
    }),
    Layer.succeed(HandoffBackend.HandoffFactory, factoryPort(fakes)),
    Layer.succeed(HandoffBackend.HandoffBackend, {
      ...HandoffBackend.HandoffBackend.defaultValue(),
      ...workPort(fakes),
    }),
  );
  return Assistant.layer.pipe(Layer.provideMerge(admission), Layer.provide(core));
};

const service = Assistant.ProjectAssistant;
const admissionService = HandoffAdmission.HandoffAdmission;
const sqlOf = SqlClient.SqlClient;

/** An authorized brief of `idea` with its item captured as it reads now. */
const agree = (fakes: Fakes, idea: string, rank?: number) =>
  Effect.gen(function* () {
    const assistant = yield* service;
    const sql = yield* sqlOf;
    const brief = yield* assistant.revise({
      projectId: alpha,
      ideaId: idea,
      patch: {
        goal: `Deliver ${idea}`,
        acceptanceCriteria: [`Check ${idea}`],
        executionAuthorized: true,
        ...(rank === undefined ? {} : { priority: { rank, reason: "Ranked" } }),
      },
    });
    const itemId = WorkItemId.make(`item-${idea}`);
    fakes.items.set(itemId, { fingerprint: `print-${idea}`, status: "todo", readable: true });
    yield* sql`INSERT INTO fd_assistant_work_captures ${sql.insert({
      project_id: alpha,
      idea_id: idea,
      capture_id: `cap-${idea}`,
      source_id: sourceId,
      kind: "single",
      state: "captured",
      writer_instance_id: "writer",
      item_id: itemId,
      item_key: `fd-${idea}`,
      item_url: null,
      item_fingerprint: `print-${idea}`,
      content_hash: "content",
      scope_hash: briefScopeHash(brief),
      brief_revision: brief.revision,
      updated_at: at,
    })}`;
    return itemId;
  });

const assign = (idea: string, assignmentId = idea) =>
  Effect.flatMap(service, (assistant) =>
    assistant.enqueue({
      assignmentId,
      projectId: alpha,
      ideaId: idea,
      executor: "factory",
      managerThreadId: managerId,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      looperConfig: null,
    }),
  );

const agreed = (fakes: Fakes, idea: string, rank?: number) =>
  Effect.andThen(agree(fakes, idea, rank), assign(idea));

const tick = Effect.flatMap(service, (assistant) => assistant.tick);

const control = (assignmentId: string, action: "stop" | "resume" | "retry" | "cancel") =>
  Effect.flatMap(service, (assistant) =>
    assistant.control({ assignmentId, managerThreadId: managerId, action }),
  );

const stateOf = (assignmentId: string) =>
  Effect.gen(function* () {
    const sql = yield* sqlOf;
    const [row] = yield* sql<{
      readonly state: string;
    }>`SELECT state FROM fd_assistant_assignments WHERE assignment_id = ${assignmentId}`;
    return row?.state;
  });

const linkOf = (assignmentId: string) =>
  Effect.gen(function* () {
    const sql = yield* sqlOf;
    const [row] = yield* sql<{
      readonly delivery_id: string | null;
      readonly control: string;
      readonly runtime_mode: string;
    }>`SELECT delivery_id, control, runtime_mode FROM fd_assistant_factory_links
      WHERE assignment_id = ${assignmentId}`;
    return row;
  });

const rootOf = (root: string) =>
  Effect.gen(function* () {
    const sql = yield* sqlOf;
    const [row] = yield* sql<{
      readonly state: string;
      readonly reason: string | null;
    }>`SELECT state, reason FROM fd_assistant_managed_roots WHERE root_delivery_id = ${root}`;
    return row;
  });

const slotOf = (root: string) =>
  Effect.gen(function* () {
    const sql = yield* sqlOf;
    const [row] = yield* sql<{
      readonly state: string;
      readonly entry_seq: number;
    }>`SELECT state, entry_seq FROM fd_assistant_slots WHERE root_delivery_id = ${root}`;
    return row;
  });

const admissionsOf = (root: string) =>
  Effect.gen(function* () {
    const sql = yield* sqlOf;
    return yield* sql<{
      readonly admission_id: string;
      readonly kind: string;
      readonly state: string;
      readonly entry_seq: number;
    }>`SELECT admission_id, kind, state, entry_seq FROM fd_assistant_admissions
      WHERE root_delivery_id = ${root}`;
  });

const positionOf = (assignmentId: string) =>
  Effect.gen(function* () {
    const sql = yield* sqlOf;
    const [row] = yield* sql<{
      readonly seq: number;
      readonly overtaken: number;
    }>`SELECT seq, overtaken FROM fd_assistant_queue_positions
      WHERE assignment_id = ${assignmentId}`;
    return row;
  });

/** Every row an enqueue could write. */
const enqueueRows = Effect.gen(function* () {
  const sql = yield* sqlOf;
  const tables: Record<string, number> = {};
  for (const table of [
    "fd_assistant_assignments",
    "fd_assistant_dispatches",
    "fd_assistant_factory_links",
    "fd_assistant_queue_positions",
    "fd_assistant_managed_roots",
    "fd_assistant_slots",
    "fd_assistant_admissions",
  ]) {
    const [row] = yield* sql<{
      readonly count: number;
    }>`SELECT COUNT(*) AS count FROM ${sql(table)}`;
    tables[table] = row?.count ?? 0;
  }
  return tables;
});

/** Every row a pre-start step may leave unchanged, compared whole. */
const prestartRows = Effect.gen(function* () {
  const sql = yield* sqlOf;
  const tables: Record<string, ReadonlyArray<unknown>> = {};
  for (const table of [
    "fd_assistant_factory_links",
    "fd_assistant_queue_positions",
    "fd_assistant_managed_roots",
    "fd_assistant_slots",
    "fd_assistant_admissions",
    "fd_assistant_admission_demands",
    "fd_assistant_grant_history",
  ]) {
    tables[table] = yield* sql`SELECT * FROM ${sql(table)} ORDER BY rowid`;
  }
  const [assignments] = yield* sql<{
    readonly rows: string;
  }>`SELECT json_group_array(json_array(assignment_id, state, attempt)) AS rows
    FROM fd_assistant_assignments`;
  return { tables, assignments };
});

/** Runs the program over one in-memory database, with the fakes and the optional probe. */
const withFakes = <A, E, R>(
  fakes: Fakes,
  program: Effect.Effect<A, E, R>,
  probe?: typeof HandoffAdmission.HandoffAdmissionProbe.Service,
) =>
  program.pipe(
    Effect.provide(layerOf(fakes, probe).pipe(Layer.provideMerge(Sqlite.layerMemory))),
    Effect.orDie,
  );

/** A held probe: `pause` says which admissions wait for `go` right after they commit. */
const holdingProbe = Effect.gen(function* () {
  const entered = yield* Deferred.make<HandoffAdmission.Admitted>();
  const go = yield* Deferred.make<void>();
  const hold: { pause: boolean } = { pause: false };
  const probe: typeof HandoffAdmission.HandoffAdmissionProbe.Service = {
    admitted: (admitted) =>
      Effect.suspend(() =>
        hold.pause && admitted.kind === "claim"
          ? Deferred.succeed(entered, admitted).pipe(Effect.andThen(Deferred.await(go)))
          : Effect.void,
      ),
    released: () => Effect.void,
    observed: () => Effect.void,
  };
  return { entered, go, hold, probe };
});

/** A queued assignment claimed once with its delivery absent, then parked by a stop. */
const parkedAbsent = (fakes: Fakes, idea: string, rank?: number) =>
  Effect.gen(function* () {
    yield* agreed(fakes, idea, rank);
    fakes.onStart = () => Effect.succeed("ambiguous");
    yield* tick;
    fakes.onStart = undefined;
    yield* control(idea, "stop");
    assert.strictEqual(yield* stateOf(idea), "stopped");
    return (yield* linkOf(idea))!.delivery_id!;
  });

/** The same with a queued orphan: its row was stored, and its start step never ran. */
const parkedOrphan = (fakes: Fakes, idea: string, rank?: number) =>
  Effect.gen(function* () {
    yield* agreed(fakes, idea, rank);
    fakes.onStart = () => Effect.succeed("none");
    yield* tick;
    fakes.onStart = undefined;
    yield* control(idea, "stop");
    assert.strictEqual(yield* stateOf(idea), "stopped");
    const root = (yield* linkOf(idea))!.delivery_id!;
    assert.strictEqual(fakes.deliveries.get(root), "queued");
    return root;
  });

/** Two other assignments' roots holding both slots. */
const fillSlots = Effect.gen(function* () {
  const sql = yield* sqlOf;
  const roots: Array<string> = [];
  for (const name of ["other-a", "other-b"]) {
    yield* sql`INSERT INTO fd_assistant_assignments ${sql.insert({
      assignment_id: name,
      project_id: alpha,
      idea_id: name,
      executor: "factory",
      attempt: 1,
      state: "running",
      worker_refs_json: "[]",
      progress_json: "[]",
      evidence_json: "[]",
      created_at: at,
      updated_at: at,
    })}`;
    yield* sql`INSERT INTO fd_assistant_factory_links ${sql.insert({
      assignment_id: name,
      capture_id: `cap-${name}`,
      source_id: sourceId,
      item_id: `item-${name}`,
      kind: "single",
      scope_hash: "other",
      item_fingerprint: "other",
      runtime_mode: "full-access",
      delivery_id: `root-${name}`,
      control: "none",
      created_at: at,
      updated_at: at,
    })}`;
    yield* sql`INSERT INTO fd_assistant_managed_roots ${sql.insert({
      root_delivery_id: `root-${name}`,
      assignment_id: name,
      attempt: 1,
      state: "active",
      created_at: at,
    })}`;
    const [{ next_seq } = { next_seq: 1 }] = yield* sql<{ readonly next_seq: number }>`
      SELECT next_seq FROM fd_assistant_scheduler WHERE id = 1`;
    yield* sql`UPDATE fd_assistant_scheduler SET next_seq = ${next_seq + 1} WHERE id = 1`;
    yield* sql`INSERT INTO fd_assistant_slots
      (root_delivery_id, assignment_id, state, entry_seq, granted_at)
      VALUES (${`root-${name}`}, ${name}, 'held', ${next_seq}, ${at})`;
    roots.push(`root-${name}`);
  }
  return roots;
});

/** Frees a slot of `fillSlots`, as the release pass would once that root idles. */
const freeSlot = (root: string) =>
  Effect.flatMap(
    sqlOf,
    (sql) => sql`DELETE FROM fd_assistant_slots WHERE root_delivery_id = ${root}`,
  );

describe("a Factory assignment's enqueue", () => {
  const refused = <E>(
    name: string,
    prepare: (
      fakes: Fakes,
    ) => Effect.Effect<unknown, E, Assistant.ProjectAssistant | SqlClient.SqlClient>,
    text: string,
    attempt: Effect.Effect<
      Assignment,
      Assistant.AssistantError,
      Assistant.ProjectAssistant
    > = assign("idea"),
  ) =>
    it.effect(`writes nothing when ${name}`, () => {
      const fakes = makeFakes();
      return withFakes(
        fakes,
        Effect.gen(function* () {
          yield* prepare(fakes);
          const before = yield* enqueueRows;
          const error = yield* Effect.flip(attempt);
          assert.include(error.message, text);
          assert.deepStrictEqual(yield* enqueueRows, before);
          assert.deepStrictEqual(fakes.calls, []);
        }),
      );
    });

  refused(
    "authorization is missing",
    (fakes) =>
      Effect.andThen(
        agree(fakes, "idea"),
        Effect.flatMap(service, (assistant) =>
          assistant.revise({
            projectId: alpha,
            ideaId: "idea",
            patch: { executionAuthorized: false },
          }),
        ),
      ),
    "explicit execution authorization",
  );
  refused(
    "there is no captured item",
    () =>
      Effect.flatMap(service, (assistant) =>
        assistant.revise({
          projectId: alpha,
          ideaId: "idea",
          patch: {
            goal: "Deliver idea",
            acceptanceCriteria: ["Check idea"],
            executionAuthorized: true,
          },
        }),
      ),
    "assistant_capture_work",
  );
  refused(
    "the capture is uncertain",
    (fakes) =>
      Effect.andThen(
        agree(fakes, "idea"),
        Effect.flatMap(
          sqlOf,
          (sql) => sql`UPDATE fd_assistant_work_captures SET state = 'uncertain', item_id = NULL`,
        ),
      ),
    "assistant_capture_work",
  );
  refused(
    "no read confirmed the captured item",
    (fakes) =>
      Effect.andThen(
        agree(fakes, "idea"),
        Effect.flatMap(
          sqlOf,
          (sql) => sql`UPDATE fd_assistant_work_captures SET item_fingerprint = NULL`,
        ),
      ),
    "No read has confirmed",
  );
  refused(
    "the brief's scope changed after the capture",
    (fakes) =>
      Effect.andThen(
        agree(fakes, "idea"),
        Effect.flatMap(service, (assistant) =>
          assistant.revise({
            projectId: alpha,
            ideaId: "idea",
            patch: { goal: "Something else", executionAuthorized: true },
          }),
        ),
      ),
    "brief changed",
  );
  refused(
    "the item changed after the capture",
    (fakes) =>
      Effect.andThen(
        agree(fakes, "idea"),
        Effect.sync(() => {
          fakes.items.get("item-idea")!.fingerprint = "edited";
        }),
      ),
    "item changed",
  );
  refused(
    "the item is done",
    (fakes) =>
      Effect.andThen(
        agree(fakes, "idea"),
        Effect.sync(() => {
          fakes.items.get("item-idea")!.status = "done";
        }),
      ),
    "done or cancelled",
  );
  refused(
    "the item is cancelled",
    (fakes) =>
      Effect.andThen(
        agree(fakes, "idea"),
        Effect.sync(() => {
          fakes.items.get("item-idea")!.status = "cancelled";
        }),
      ),
    "done or cancelled",
  );
  refused(
    "the item cannot be read",
    (fakes) =>
      Effect.andThen(
        agree(fakes, "idea"),
        Effect.sync(() => {
          fakes.items.get("item-idea")!.readable = false;
        }),
      ),
    "could not be read",
  );
  refused(
    "the caller is in plan mode",
    (fakes) => agree(fakes, "idea"),
    "plan mode",
    Effect.flatMap(service, (assistant) =>
      assistant.enqueue({
        assignmentId: "idea",
        projectId: alpha,
        ideaId: "idea",
        executor: "factory",
        managerThreadId: managerId,
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "plan",
        looperConfig: null,
      }),
    ),
  );
  refused(
    "a Looper configuration is given",
    (fakes) => agree(fakes, "idea"),
    "no Looper configuration",
    Effect.flatMap(service, (assistant) =>
      assistant.enqueue({
        assignmentId: "idea",
        projectId: alpha,
        ideaId: "idea",
        executor: "factory",
        managerThreadId: managerId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        looperConfig: "/config/loop.json",
      }),
    ),
  );
  refused(
    "the project is multi-repository",
    (fakes) =>
      Effect.andThen(
        agree(fakes, "idea"),
        Effect.sync(() => {
          fakes.repositories = ["one", "two"];
        }),
      ),
    "Multi-repository",
  );
  refused(
    "the project has no verify command",
    (fakes) =>
      Effect.andThen(
        agree(fakes, "idea"),
        Effect.sync(() => {
          fakes.verify = false;
        }),
      ),
    "verify command",
  );
  refused(
    "another assignment that has not ended uses the capture",
    (fakes) => Effect.andThen(agree(fakes, "idea"), assign("idea", "first")),
    "already delivers this capture",
    assign("idea", "second"),
  );

  /** An enqueue at full access, which a manager narrowed below that no longer covers. */
  const assignFullAccess = Effect.flatMap(service, (assistant) =>
    assistant.enqueue({
      assignmentId: "idea",
      projectId: alpha,
      ideaId: "idea",
      executor: "factory",
      managerThreadId: managerId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      looperConfig: null,
    }),
  );

  // What the manager's own request said no longer holds by the time the enqueue would commit.
  const managerChanges: ReadonlyArray<{
    readonly name: string;
    readonly change: (fakes: Fakes) => void;
    readonly attempt: typeof assignFullAccess;
  }> = [
    {
      name: "was deleted",
      change: (fakes) => {
        fakes.manager = null;
      },
      attempt: assign("idea"),
    },
    {
      name: "was archived",
      change: (fakes) => {
        fakes.manager = managerShell({ archivedAt: DateTime.makeUnsafe(at) });
      },
      attempt: assign("idea"),
    },
    {
      name: "switched to plan mode",
      change: (fakes) => {
        fakes.manager = managerShell({ interactionMode: "plan" });
      },
      attempt: assign("idea"),
    },
    {
      name: "narrowed its permissions",
      change: (fakes) => {
        fakes.manager = managerShell({ runtimeMode: "approval-required" });
      },
      attempt: assignFullAccess,
    },
  ];

  it.effect.each(
    managerChanges.flatMap((manager) => [
      { ...manager, hook: "onRead" as const, during: "the item's read" },
      { ...manager, hook: "onVerify" as const, during: "the verify read" },
    ]),
  )("writes nothing when the manager $name during $during", ({ change, attempt, hook }) => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        yield* agree(fakes, "idea");
        const before = yield* enqueueRows;
        fakes[hook] = Effect.sync(() => change(fakes));
        const error = yield* Effect.flip(attempt);
        assert.include(error.message, "Not queued");
        assert.deepStrictEqual(yield* enqueueRows, before);
        assert.isUndefined(yield* positionOf("idea"));

        // Nothing stands in the way once the manager is back.
        fakes.manager = managerShell();
        assert.strictEqual((yield* attempt).state, "queued");
      }),
    );
  });

  it.effect(
    "writes nothing when the brief, capture or project changes during the verify read",
    () => {
      const fakes = makeFakes();
      return withFakes(
        fakes,
        Effect.gen(function* () {
          const assistant = yield* service;
          const sql = yield* sqlOf;
          yield* agree(fakes, "idea");
          const before = yield* enqueueRows;

          fakes.onVerify = assistant
            .revise({ projectId: alpha, ideaId: "idea", patch: { executionAuthorized: false } })
            .pipe(Effect.orDie, Effect.asVoid);
          assert.include((yield* Effect.flip(assign("idea"))).message, "Not queued");
          assert.deepStrictEqual(yield* enqueueRows, before);
          yield* assistant.revise({
            projectId: alpha,
            ideaId: "idea",
            patch: { executionAuthorized: true },
          });

          fakes.onVerify = Effect.sync(() => {
            fakes.repositories = ["one", "two"];
          });
          assert.include((yield* Effect.flip(assign("idea"))).message, "Not queued");
          assert.deepStrictEqual(yield* enqueueRows, before);
          fakes.repositories = [];

          fakes.onVerify = sql`DELETE FROM fd_assistant_work_captures`.pipe(
            Effect.orDie,
            Effect.asVoid,
          );
          assert.include((yield* Effect.flip(assign("idea"))).message, "Not queued");
          assert.deepStrictEqual(yield* enqueueRows, before);
        }),
      );
    },
  );

  it.effect("writes its rows in one go, and a repeat returns them unchanged", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        yield* agree(fakes, "idea");
        const before = yield* enqueueRows;
        const first = yield* assign("idea");
        assert.strictEqual(first.state, "queued");
        assert.strictEqual(first.executor, "factory");
        const rows = yield* enqueueRows;
        assert.deepStrictEqual(rows, {
          ...before,
          fd_assistant_assignments: 1,
          fd_assistant_dispatches: 1,
          fd_assistant_factory_links: 1,
          fd_assistant_queue_positions: 1,
        });
        const link = yield* linkOf("idea");
        assert.deepStrictEqual(link, {
          delivery_id: null,
          control: "none",
          runtime_mode: "approval-required",
        });
        const position = yield* positionOf("idea");

        // A repeat after a lost reply reads Work failing, and still finds what was stored.
        fakes.items.get("item-idea")!.readable = false;
        const repeated = yield* assign("idea");
        assert.deepStrictEqual(repeated, first);
        assert.deepStrictEqual(yield* enqueueRows, rows);
        assert.deepStrictEqual(yield* positionOf("idea"), position);
        assert.deepStrictEqual(fakes.calls, []);
      }),
    );
  });

  it.effect("rolls back all of it when the last write fails", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const sql = yield* sqlOf;
        yield* agree(fakes, "idea");
        const before = yield* enqueueRows;
        yield* sql`CREATE TRIGGER enqueue_position_fails
          BEFORE INSERT ON fd_assistant_queue_positions
          BEGIN SELECT RAISE(ABORT, 'held by the test'); END`;
        yield* Effect.flip(assign("idea"));
        assert.deepStrictEqual(yield* enqueueRows, before);
        yield* sql`DROP TRIGGER enqueue_position_fails`;
        assert.strictEqual((yield* assign("idea")).state, "queued");
      }),
    );
  });
});

describe("a Factory assignment's claim", () => {
  it.effect(
    "commits its ownership before Factory is called, and starts once under its ceiling",
    () => {
      const fakes = makeFakes();
      const held: { seen?: Record<string, unknown> } = {};
      return withFakes(
        fakes,
        Effect.gen(function* () {
          yield* agreed(fakes, "idea");
          const database = yield* Effect.context<SqlClient.SqlClient>();
          fakes.onStart = (id) =>
            Effect.gen(function* () {
              // Everything of the claim is committed by the time Factory is asked.
              held.seen = {
                state: yield* stateOf("idea"),
                link: (yield* linkOf("idea"))?.delivery_id,
                root: yield* rootOf(id),
                slot: (yield* slotOf(id))?.state,
                admissions: (yield* admissionsOf(id)).map(({ kind, state }) => ({ kind, state })),
              };
              return "store" as const;
            }).pipe(Effect.provideContext(database), Effect.orDie);
          yield* tick;

          const root = (yield* linkOf("idea"))!.delivery_id!;
          assert.deepStrictEqual(held.seen, {
            state: "launching",
            link: root,
            root: { state: "active", reason: null },
            slot: "held",
            admissions: [{ kind: "claim", state: "dispatching" }],
          });
          assert.deepStrictEqual(
            fakes.calls.filter((call) => !call.startsWith("get:")),
            [`start:${root}`],
          );
          assert.lengthOf(fakes.launches, 0);
          assert.deepStrictEqual(
            (yield* admissionsOf(root)).map(({ state }) => state),
            ["dispatched"],
          );
          assert.strictEqual(yield* stateOf("idea"), "running");
          const { assignments } = yield* Effect.flatMap(service, (assistant) =>
            assistant.inspect(alpha, "idea"),
          );
          assert.deepStrictEqual(assignments[0]?.workerRefs, [
            { kind: "factory-delivery", id: root },
            { kind: "work-item", id: `${sourceId}:item-idea` },
          ]);

          yield* tick;
          assert.strictEqual(count(fakes, "start"), 1);
        }),
      );
    },
  );

  const refusedAfterCommit = <E>(
    name: string,
    refuse: (fakes: Fakes) => Effect.Effect<unknown, E, Assistant.ProjectAssistant>,
    note: string,
  ) =>
    it.live(`fails and retires, calling nothing of Factory, when ${name} after the commit`, () => {
      const fakes = makeFakes();
      return Effect.flatMap(holdingProbe, (held) =>
        withFakes(
          fakes,
          Effect.gen(function* () {
            yield* agreed(fakes, "idea");
            held.hold.pause = true;
            const ticking = yield* tick.pipe(Effect.forkChild);
            const admitted = yield* Deferred.await(held.entered);
            yield* refuse(fakes);
            yield* Deferred.succeed(held.go, undefined);
            yield* Fiber.join(ticking);

            const root = admitted.root;
            assert.strictEqual(yield* stateOf("idea"), "failed");
            assert.deepStrictEqual(yield* rootOf(root), { state: "retired", reason: "failed" });
            assert.isUndefined(yield* slotOf(root));
            assert.lengthOf(yield* admissionsOf(root), 0);
            assert.isUndefined(yield* positionOf("idea"));
            assert.deepStrictEqual(fakes.calls, []);
            assert.lengthOf(fakes.launches, 0);
            const { assignments } = yield* Effect.flatMap(service, (assistant) =>
              assistant.inspect(alpha, "idea"),
            );
            assert.include(assignments[0]?.progress.at(-1)?.text ?? "", note);
          }),
          held.probe,
        ),
      );
    });

  refusedAfterCommit(
    "the item changed",
    (fakes) =>
      Effect.sync(() => {
        fakes.items.get("item-idea")!.fingerprint = "edited";
      }),
    "Work item changed",
  );
  refusedAfterCommit(
    "the item closed",
    (fakes) =>
      Effect.sync(() => {
        fakes.items.get("item-idea")!.status = "done";
      }),
    "done or cancelled",
  );
  refusedAfterCommit(
    "the item cannot be read",
    (fakes) =>
      Effect.sync(() => {
        fakes.items.get("item-idea")!.readable = false;
      }),
    "could not be read",
  );
  refusedAfterCommit(
    "the brief's authorization was revoked",
    () =>
      Effect.flatMap(service, (assistant) =>
        assistant.revise({
          projectId: alpha,
          ideaId: "idea",
          patch: { executionAuthorized: false },
        }),
      ),
    "authorization",
  );
  refusedAfterCommit(
    "the manager was deleted",
    (fakes) =>
      Effect.sync(() => {
        fakes.manager = null;
      }),
    "manager",
  );
  refusedAfterCommit(
    "the manager's permissions narrowed",
    (fakes) =>
      Effect.sync(() => {
        fakes.manager = managerShell({ interactionMode: "plan" });
      }),
    "manager",
  );
  refusedAfterCommit(
    "the project was deleted",
    (fakes) =>
      Effect.sync(() => {
        fakes.projectGone = true;
      }),
    "project",
  );
  refusedAfterCommit(
    "the project gained repositories",
    (fakes) =>
      Effect.sync(() => {
        fakes.repositories = ["one", "two"];
      }),
    "project",
  );
  refusedAfterCommit(
    "the verify command was removed",
    (fakes) =>
      Effect.sync(() => {
        fakes.verify = false;
      }),
    "verify command",
  );

  it.live("keeps the slot when the verify read fails, and starts once it reads again", () => {
    const fakes = makeFakes();
    return Effect.flatMap(holdingProbe, (held) =>
      withFakes(
        fakes,
        Effect.gen(function* () {
          yield* agreed(fakes, "idea");
          held.hold.pause = true;
          const ticking = yield* tick.pipe(Effect.forkChild);
          const { root } = yield* Deferred.await(held.entered);
          held.hold.pause = false;
          fakes.verifyFails = true;
          yield* Deferred.succeed(held.go, undefined);
          yield* Fiber.join(ticking);
          assert.strictEqual(yield* stateOf("idea"), "launch-uncertain");
          assert.strictEqual((yield* slotOf(root))?.state, "held");
          assert.strictEqual(count(fakes, "start"), 0);

          fakes.verifyFails = false;
          yield* tick;
          assert.strictEqual(count(fakes, "start"), 1);
          assert.strictEqual(yield* stateOf("idea"), "running");
        }),
        held.probe,
      ),
    );
  });

  it.effect("is not granted past full capacity or a queue position ahead of it", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const [first] = yield* fillSlots;
        yield* agreed(fakes, "idea");
        yield* tick;
        assert.strictEqual(yield* stateOf("idea"), "queued");
        assert.deepStrictEqual(fakes.calls, []);
        yield* freeSlot(first!);
        yield* tick;
        assert.strictEqual(yield* stateOf("idea"), "running");
        assert.strictEqual(count(fakes, "start"), 1);
      }),
    );
  });
});

describe("a start's outcomes", () => {
  it.effect("adopts a lost reply", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        yield* agreed(fakes, "idea");
        fakes.onStart = () => Effect.succeed("lost");
        yield* tick;
        const root = (yield* linkOf("idea"))!.delivery_id!;
        assert.strictEqual(yield* stateOf("idea"), "running");
        assert.strictEqual(count(fakes, "start"), 1);
        assert.strictEqual(count(fakes, "get"), 1);
        assert.strictEqual(fakes.deliveries.get(root), "running");
      }),
    );
  });

  it.effect("fails and retires on a known refusal once a read shows no row", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        yield* agreed(fakes, "idea");
        fakes.onStart = () => Effect.succeed("refuse");
        yield* tick;
        const root = (yield* linkOf("idea"))!.delivery_id!;
        assert.strictEqual(yield* stateOf("idea"), "failed");
        assert.deepStrictEqual(yield* rootOf(root), { state: "retired", reason: "failed" });
        assert.isUndefined(yield* slotOf(root));
        assert.lengthOf(yield* admissionsOf(root), 0);
      }),
    );
  });

  it.effect("fails an outside active delivery without adopting it", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        yield* agreed(fakes, "idea");
        fakes.onStart = () => Effect.succeed("active");
        yield* tick;
        const root = (yield* linkOf("idea"))!.delivery_id!;
        assert.strictEqual(yield* stateOf("idea"), "failed");
        assert.deepStrictEqual(yield* rootOf(root), { state: "retired", reason: "failed" });
        const { assignments } = yield* Effect.flatMap(service, (assistant) =>
          assistant.inspect(alpha, "idea"),
        );
        assert.include(assignments[0]?.progress.at(-1)?.text ?? "", "outside");
        assert.isFalse(assignments[0]?.workerRefs.some(({ id }) => id === "outside"));
      }),
    );
  });

  it.effect("keeps the slot through a failed read, retries the same id, and mints no other", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        yield* agreed(fakes, "idea");
        fakes.onStart = () => Effect.succeed("ambiguous");
        fakes.getFails = true;
        yield* tick;
        const root = (yield* linkOf("idea"))!.delivery_id!;
        assert.strictEqual(yield* stateOf("idea"), "launch-uncertain");
        assert.strictEqual((yield* slotOf(root))?.state, "held");
        assert.strictEqual(count(fakes, "start"), 1);

        // Unreadable, nothing else is tried.
        yield* tick;
        assert.strictEqual(count(fakes, "start"), 1);
        assert.strictEqual(yield* stateOf("idea"), "launch-uncertain");

        fakes.getFails = false;
        fakes.onStart = undefined;
        yield* tick;
        assert.strictEqual(count(fakes, "start"), 2);
        assert.deepStrictEqual(
          fakes.calls.filter((call) => call.startsWith("start:")),
          [`start:${root}`, `start:${root}`],
        );
        assert.strictEqual(yield* stateOf("idea"), "running");
        assert.strictEqual((yield* linkOf("idea"))?.delivery_id, root);
      }),
    );
  });

  it.effect("cancels a queued orphan by its own id once its authority is revoked", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        yield* agreed(fakes, "idea");
        fakes.onStart = () => Effect.succeed("none");
        yield* tick;
        fakes.onStart = undefined;
        const root = (yield* linkOf("idea"))!.delivery_id!;
        assert.strictEqual(fakes.deliveries.get(root), "queued");
        assert.strictEqual(yield* stateOf("idea"), "launching");

        yield* Effect.flatMap(service, (assistant) =>
          assistant.revise({
            projectId: alpha,
            ideaId: "idea",
            patch: { executionAuthorized: false },
          }),
        );
        yield* tick;
        assert.strictEqual(fakes.deliveries.get(root), "cancelled");
        assert.strictEqual(count(fakes, "start"), 1);
        assert.strictEqual(count(fakes, "cancel"), 1);
        assert.strictEqual(yield* stateOf("idea"), "stopping");
        assert.deepStrictEqual(yield* rootOf(root), { state: "active", reason: null });
        assert.strictEqual((yield* slotOf(root))?.state, "held");
        assert.lengthOf(yield* admissionsOf(root), 1);
      }),
    );
  });

  it.effect("starts a queued orphan by the same id while its authority holds", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        yield* agreed(fakes, "idea");
        fakes.onStart = () => Effect.succeed("none");
        yield* tick;
        fakes.onStart = undefined;
        const root = (yield* linkOf("idea"))!.delivery_id!;
        yield* tick;
        assert.deepStrictEqual(
          fakes.calls.filter((call) => call.startsWith("start:")),
          [`start:${root}`, `start:${root}`],
        );
        assert.strictEqual(fakes.deliveries.get(root), "running");
        assert.strictEqual(yield* stateOf("idea"), "running");
      }),
    );
  });

  it.effect("mints a new id only by retrying a failed assignment, whose root stays retired", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        yield* agreed(fakes, "idea");
        fakes.onStart = () => Effect.succeed("refuse");
        yield* tick;
        const first = (yield* linkOf("idea"))!.delivery_id!;
        assert.strictEqual(yield* stateOf("idea"), "failed");

        fakes.onStart = undefined;
        const retried = yield* control("idea", "retry");
        assert.strictEqual(retried.state, "queued");
        assert.strictEqual(retried.attempt, 2);
        assert.isNull((yield* linkOf("idea"))?.delivery_id);
        assert.isDefined(yield* positionOf("idea"));

        yield* tick;
        const second = (yield* linkOf("idea"))!.delivery_id!;
        assert.notStrictEqual(second, first);
        assert.deepStrictEqual(yield* rootOf(first), { state: "retired", reason: "failed" });
        assert.deepStrictEqual(yield* rootOf(second), { state: "active", reason: null });
        assert.strictEqual(yield* stateOf("idea"), "running");
      }),
    );
  });

  it.effect("refuses a retry while the root is active, or with no fresh authority", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        yield* agreed(fakes, "idea");
        yield* tick;
        assert.include((yield* Effect.flip(control("idea", "retry"))).message, "Resume keeps");

        // Nor from a root parked before its first start, or waiting to resume: resume keeps its id.
        yield* parkedAbsent(fakes, "parked");
        assert.include((yield* Effect.flip(control("parked", "retry"))).message, "Resume keeps");
        yield* control("parked", "resume");
        assert.include((yield* Effect.flip(control("parked", "retry"))).message, "Resume keeps");

        yield* agreed(fakes, "other");
        fakes.onStart = () => Effect.succeed("refuse");
        yield* tick;
        assert.strictEqual(yield* stateOf("other"), "failed");
        fakes.items.get("item-other")!.fingerprint = "edited";
        assert.include((yield* Effect.flip(control("other", "retry"))).message, "Not retried");
        assert.strictEqual(yield* stateOf("other"), "failed");
      }),
    );
  });
});

describe("pre-delivery controls", () => {
  it.effect(
    "a queued, never claimed assignment cancels, refuses a stop with text, and has no resume",
    () => {
      const fakes = makeFakes();
      return withFakes(
        fakes,
        Effect.gen(function* () {
          const [first] = yield* fillSlots;
          yield* agreed(fakes, "idea");
          const refusal = yield* Effect.flip(control("idea", "stop"));
          assert.strictEqual(refusal.message, "Not started; cancel removes it from the queue");
          yield* Effect.flip(control("idea", "resume"));
          yield* Effect.flip(control("idea", "retry"));
          assert.strictEqual(yield* stateOf("idea"), "queued");

          const cancelled = yield* control("idea", "cancel");
          assert.strictEqual(cancelled.state, "cancelled");
          assert.isUndefined(yield* positionOf("idea"));
          assert.deepStrictEqual(fakes.calls, []);

          yield* freeSlot(first!);
          yield* tick;
          assert.deepStrictEqual(fakes.calls, []);
        }),
      );
    },
  );

  it.effect("cancel during launching with the delivery proven absent retires abandoned", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        yield* agreed(fakes, "idea");
        fakes.onStart = () => Effect.succeed("ambiguous");
        yield* tick;
        fakes.onStart = undefined;
        const root = (yield* linkOf("idea"))!.delivery_id!;
        assert.strictEqual(yield* stateOf("idea"), "launch-uncertain");

        const cancelled = yield* control("idea", "cancel");
        assert.strictEqual(cancelled.state, "cancelled");
        assert.deepStrictEqual(yield* rootOf(root), { state: "retired", reason: "abandoned" });
        assert.isUndefined(yield* slotOf(root));
        assert.lengthOf(yield* admissionsOf(root), 0);
        assert.strictEqual(count(fakes, "start"), 1);
        assert.strictEqual(count(fakes, "cancel"), 0);
        assert.strictEqual(count(fakes, "stop"), 0);
      }),
    );
  });

  it.effect(
    "cancel cancels an existing row by its own id, keeping the claim slot and admission",
    () => {
      const fakes = makeFakes();
      return withFakes(
        fakes,
        Effect.gen(function* () {
          yield* agreed(fakes, "idea");
          fakes.onStart = () => Effect.succeed("none");
          yield* tick;
          fakes.onStart = undefined;
          const root = (yield* linkOf("idea"))!.delivery_id!;
          const cancelled = yield* control("idea", "cancel");
          assert.strictEqual(cancelled.state, "stopping");
          assert.deepStrictEqual(
            fakes.calls.filter((call) => !call.startsWith("get:")),
            [`start:${root}`, `cancel:${root}`],
          );
          assert.strictEqual((yield* linkOf("idea"))?.control, "cancel");
          assert.strictEqual((yield* slotOf(root))?.state, "held");
          const [claim] = yield* admissionsOf(root);
          assert.deepStrictEqual(
            { kind: claim?.kind, state: claim?.state },
            { kind: "claim", state: "dispatched" },
          );

          // With the intent set, nothing starts it, however often it is looked at.
          yield* tick;
          yield* tick;
          assert.strictEqual(count(fakes, "start"), 1);
        }),
      );
    },
  );

  it.effect("stop calls Factory.stop only for a row past queued", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        yield* agreed(fakes, "idea");
        yield* tick;
        const root = (yield* linkOf("idea"))!.delivery_id!;
        const stopping = yield* control("idea", "stop");
        assert.strictEqual(stopping.state, "stopping");
        assert.strictEqual(count(fakes, "stop"), 1);
        assert.strictEqual(fakes.deliveries.get(root), "stopping");
      }),
    );
  });

  /** A claim whose start ran its row, with the reply and the read after it lost. */
  const uncertainOverARow = (fakes: Fakes, idea: string) =>
    Effect.gen(function* () {
      yield* agreed(fakes, idea);
      fakes.onStart = () => Effect.succeed("lost");
      fakes.getFails = true;
      yield* tick;
      fakes.onStart = undefined;
      fakes.getFails = false;
      assert.strictEqual(yield* stateOf(idea), "launch-uncertain");
      const root = (yield* linkOf(idea))!.delivery_id!;
      assert.strictEqual(fakes.deliveries.get(root), "running");
      return root;
    });

  it.effect("a stop Factory failed to take stays persisted, and a later pass stops the row", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* uncertainOverARow(fakes, "idea");
        fakes.stopFails = true;

        const asked = yield* control("idea", "stop");
        assert.strictEqual(asked.state, "launch-uncertain");
        assert.strictEqual((yield* linkOf("idea"))?.control, "stop");
        assert.strictEqual(count(fakes, "stop"), 1);
        assert.strictEqual(fakes.deliveries.get(root), "running");

        // Still failing, it is asked again and nothing else moves.
        yield* tick;
        assert.strictEqual(count(fakes, "stop"), 2);
        assert.strictEqual(yield* stateOf("idea"), "launch-uncertain");
        assert.strictEqual((yield* linkOf("idea"))?.control, "stop");
        assert.strictEqual((yield* slotOf(root))?.state, "held");

        fakes.stopFails = false;
        yield* tick;
        assert.strictEqual(count(fakes, "stop"), 3);
        assert.strictEqual(yield* stateOf("idea"), "stopping");
        assert.strictEqual(fakes.deliveries.get(root), "stopping");

        yield* tick;
        assert.strictEqual(count(fakes, "stop"), 3);
        assert.strictEqual(count(fakes, "start"), 1);
      }),
    );
  });

  it.effect("a stop whose reply was lost converges on the same row", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* uncertainOverARow(fakes, "idea");
        fakes.stopFails = true;
        yield* control("idea", "stop");
        // Factory took it; only the reply was lost.
        fakes.deliveries.set(root, "stopping");
        fakes.stopFails = false;
        yield* tick;
        assert.strictEqual(yield* stateOf("idea"), "stopping");
        assert.strictEqual(fakes.deliveries.get(root), "stopping");
      }),
    );
  });

  it.effect("a stop Factory refuses for a row that runs no stage is spent, not retried", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* uncertainOverARow(fakes, "idea");
        fakes.deliveries.set(root, "blocked");
        const asked = yield* control("idea", "stop");
        assert.strictEqual(asked.state, "running");
        assert.strictEqual((yield* linkOf("idea"))?.control, "none");
        assert.strictEqual(count(fakes, "stop"), 1);
        const { assignments } = yield* Effect.flatMap(service, (assistant) =>
          assistant.inspect(alpha, "idea"),
        );
        assert.include(assignments[0]?.progress.at(-1)?.text ?? "", "cannot stop");

        yield* tick;
        yield* tick;
        assert.strictEqual(count(fakes, "stop"), 1);
        // The blocked delivery it found is what its assignment now shows.
        assert.strictEqual(yield* stateOf("idea"), "needs-input");
      }),
    );
  });

  it.effect("a cancel Factory failed to take on a running row stands, and is asked again", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        yield* agreed(fakes, "idea");
        yield* tick;
        const root = (yield* linkOf("idea"))!.delivery_id!;
        fakes.cancelFails = true;

        // The intent is saved, so the caller is not told it failed.
        const asked = yield* control("idea", "cancel");
        assert.strictEqual(asked.state, "running");
        assert.strictEqual((yield* linkOf("idea"))?.control, "cancel");
        assert.strictEqual(count(fakes, "cancel"), 1);
        assert.strictEqual(fakes.deliveries.get(root), "running");

        fakes.cancelFails = false;
        yield* tick;
        assert.strictEqual(count(fakes, "cancel"), 2);
        assert.strictEqual(fakes.deliveries.get(root), "cancelled");
        assert.strictEqual(yield* stateOf("idea"), "stopping");
      }),
    );
  });

  it.effect("stop with the delivery absent parks the root and frees exactly its claim", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* parkedAbsent(fakes, "idea");
        assert.strictEqual(yield* stateOf("idea"), "stopped");
        assert.deepStrictEqual(yield* rootOf(root), { state: "active", reason: null });
        assert.isUndefined(yield* slotOf(root));
        assert.lengthOf(yield* admissionsOf(root), 0);
        const link = yield* linkOf("idea");
        assert.strictEqual(link?.delivery_id, root);
        assert.strictEqual(link?.control, "stop");
        assert.isDefined(yield* positionOf("idea"));
        assert.strictEqual(count(fakes, "stop"), 0);
        assert.strictEqual(count(fakes, "resume"), 0);
        assert.strictEqual(count(fakes, "cancel"), 0);

        // Nothing more changes, and a further stop asks nothing.
        const rows = yield* prestartRows;
        yield* tick;
        yield* control("idea", "stop");
        yield* tick;
        assert.deepStrictEqual(yield* prestartRows, rows);
        assert.strictEqual(count(fakes, "start"), 1);
      }),
    );
  });

  it.effect("stop over a queued orphan parks it, leaving the row queued and untouched", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* parkedOrphan(fakes, "idea");
        assert.strictEqual(fakes.deliveries.get(root), "queued");
        assert.isUndefined(yield* slotOf(root));
        assert.lengthOf(yield* admissionsOf(root), 0);
        assert.strictEqual(count(fakes, "stop"), 0);
        assert.strictEqual(count(fakes, "resume"), 0);
        yield* tick;
        assert.strictEqual(fakes.deliveries.get(root), "queued");
        assert.strictEqual(count(fakes, "start"), 1);
      }),
    );
  });

  it.effect("a failed read after the intent keeps the claim, starts nothing, and converges", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        yield* agreed(fakes, "idea");
        fakes.onStart = () => Effect.succeed("ambiguous");
        yield* tick;
        fakes.onStart = undefined;
        const root = (yield* linkOf("idea"))!.delivery_id!;
        fakes.getFails = true;

        yield* control("idea", "stop");
        assert.strictEqual(yield* stateOf("idea"), "launch-uncertain");
        assert.strictEqual((yield* linkOf("idea"))?.control, "stop");
        assert.strictEqual((yield* slotOf(root))?.state, "held");
        assert.lengthOf(yield* admissionsOf(root), 1);
        yield* tick;
        assert.strictEqual(count(fakes, "start"), 1);
        assert.strictEqual((yield* slotOf(root))?.state, "held");

        fakes.getFails = false;
        yield* tick;
        assert.strictEqual(yield* stateOf("idea"), "stopped");
        assert.isUndefined(yield* slotOf(root));
        assert.strictEqual(count(fakes, "start"), 1);
      }),
    );
  });

  it.effect(
    "a claim still dispatching here keeps its slot and admission, and starts nothing",
    () => {
      const fakes = makeFakes();
      return withFakes(
        fakes,
        Effect.gen(function* () {
          const admission = yield* admissionService;
          yield* agreed(fakes, "idea");
          // This instance's own claim, committed with its dispatch not finished.
          const claimed = yield* admission.claim({ assignmentId: "idea", deliveryId: "root-idea" });
          assert.strictEqual(claimed.type, "claimed");
          yield* control("idea", "stop");
          assert.strictEqual(yield* stateOf("idea"), "launch-uncertain");
          assert.strictEqual((yield* linkOf("idea"))?.control, "stop");
          assert.strictEqual((yield* slotOf("root-idea"))?.state, "held");
          const [row] = yield* admissionsOf("root-idea");
          assert.strictEqual(row?.state, "dispatching");
          yield* tick;
          assert.deepStrictEqual(fakes.calls, []);
          assert.strictEqual((yield* slotOf("root-idea"))?.state, "held");
        }),
      );
    },
  );

  it.effect(
    "a moved entry or any other ownership keeps the claim, and the next pass retries",
    () => {
      const fakes = makeFakes();
      return withFakes(
        fakes,
        Effect.gen(function* () {
          const sql = yield* sqlOf;
          yield* agreed(fakes, "idea");
          fakes.onStart = () => Effect.succeed("ambiguous");
          yield* tick;
          fakes.onStart = undefined;
          const root = (yield* linkOf("idea"))!.delivery_id!;
          const { entry_seq: entrySeq } = (yield* slotOf(root))!;

          yield* sql`UPDATE fd_assistant_slots SET entry_seq = ${entrySeq + 1000}
          WHERE root_delivery_id = ${root}`;
          yield* control("idea", "stop");
          assert.strictEqual(yield* stateOf("idea"), "launch-uncertain");
          assert.strictEqual((yield* slotOf(root))?.state, "held");
          assert.lengthOf(yield* admissionsOf(root), 1);

          yield* sql`UPDATE fd_assistant_slots SET entry_seq = ${entrySeq}
          WHERE root_delivery_id = ${root}`;
          yield* tick;
          assert.strictEqual(yield* stateOf("idea"), "stopped");
        }),
      );
    },
  );

  it.effect("a claim whose dispatched mark failed is not read as a start still running", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const sql = yield* sqlOf;
        yield* agreed(fakes, "idea");
        fakes.onStart = () => Effect.succeed("ambiguous");
        yield* sql`CREATE TRIGGER claim_mark_fails BEFORE UPDATE ON fd_assistant_admissions
          BEGIN SELECT RAISE(ABORT, 'held by the test'); END`;
        yield* tick;
        fakes.onStart = undefined;
        const root = (yield* linkOf("idea"))!.delivery_id!;
        assert.strictEqual((yield* admissionsOf(root))[0]?.state, "dispatching");

        // While the mark still fails, the claim keeps its protection.
        yield* control("idea", "stop");
        assert.strictEqual((yield* slotOf(root))?.state, "held");
        assert.strictEqual(count(fakes, "start"), 1);

        yield* sql`DROP TRIGGER claim_mark_fails`;
        yield* tick;
        assert.strictEqual(yield* stateOf("idea"), "stopped");
        assert.isUndefined(yield* slotOf(root));
        assert.lengthOf(yield* admissionsOf(root), 0);
        assert.strictEqual(count(fakes, "start"), 1);
      }),
    );
  });

  it.effect(
    "a resume before the intent is honored takes it back, and calls no start itself",
    () => {
      const fakes = makeFakes();
      return withFakes(
        fakes,
        Effect.gen(function* () {
          yield* agreed(fakes, "idea");
          fakes.onStart = () => Effect.succeed("ambiguous");
          yield* tick;
          fakes.onStart = undefined;
          fakes.getFails = true;
          yield* control("idea", "stop");
          assert.strictEqual((yield* linkOf("idea"))?.control, "stop");

          yield* control("idea", "resume");
          assert.strictEqual((yield* linkOf("idea"))?.control, "none");
          assert.strictEqual(count(fakes, "start"), 1);

          fakes.getFails = false;
          yield* tick;
          assert.strictEqual(count(fakes, "start"), 2);
          assert.strictEqual(yield* stateOf("idea"), "running");
        }),
      );
    },
  );
});

describe("resuming a root parked before its first start", () => {
  it.effect("re-enters the queue, and only a fair grant re-claims and starts the same id", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* parkedAbsent(fakes, "idea");
        const before = yield* positionOf("idea");
        const [first] = yield* fillSlots;

        const resumed = yield* control("idea", "resume");
        assert.strictEqual(resumed.state, "queued");
        assert.strictEqual(resumed.attempt, 2);
        assert.strictEqual((yield* linkOf("idea"))?.control, "none");
        assert.isAbove((yield* positionOf("idea"))?.seq ?? 0, before?.seq ?? 0);
        assert.isUndefined(yield* slotOf(root));
        assert.lengthOf(yield* admissionsOf(root), 0);
        assert.strictEqual(count(fakes, "start"), 1);

        // Repeated, it is refused unchanged.
        const rows = yield* prestartRows;
        const again = yield* Effect.flip(control("idea", "resume"));
        assert.include(again.message, "Waiting for a project assistant slot");
        const stopped = yield* Effect.flip(control("idea", "stop"));
        assert.include(stopped.message, "Waiting for a project assistant slot");
        yield* Effect.flip(control("idea", "retry"));
        assert.deepStrictEqual(yield* prestartRows, rows);

        // Both slots are held: no re-claim, start or run.
        yield* tick;
        assert.strictEqual(yield* stateOf("idea"), "queued");
        assert.strictEqual(count(fakes, "start"), 1);

        yield* freeSlot(first!);
        yield* tick;
        assert.deepStrictEqual(
          fakes.calls.filter((call) => call.startsWith("start:")),
          [`start:${root}`, `start:${root}`],
        );
        assert.strictEqual(count(fakes, "resume"), 0);
        assert.strictEqual((yield* linkOf("idea"))?.delivery_id, root);
        assert.strictEqual(yield* stateOf("idea"), "running");
        assert.strictEqual((yield* slotOf(root))?.state, "held");
      }),
    );
  });

  it.effect("a queued orphan is started through start(id), never Factory.resume", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* parkedOrphan(fakes, "idea");
        yield* control("idea", "resume");
        yield* tick;
        assert.strictEqual(count(fakes, "start"), 2);
        assert.strictEqual(count(fakes, "resume"), 0);
        assert.strictEqual(fakes.deliveries.get(root), "running");
      }),
    );
  });

  it.effect("refuses with its text and changes nothing when the recheck fails", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        yield* parkedAbsent(fakes, "idea");
        const rows = yield* prestartRows;

        fakes.items.get("item-idea")!.fingerprint = "edited";
        assert.include((yield* Effect.flip(control("idea", "resume"))).message, "Not resumed");
        fakes.items.get("item-idea")!.fingerprint = "print-idea";

        fakes.items.get("item-idea")!.readable = false;
        assert.include((yield* Effect.flip(control("idea", "resume"))).message, "Not resumed");
        fakes.items.get("item-idea")!.readable = true;

        fakes.verify = false;
        assert.include((yield* Effect.flip(control("idea", "resume"))).message, "Not resumed");
        fakes.verify = true;

        fakes.getFails = true;
        assert.include(
          (yield* Effect.flip(control("idea", "resume"))).message,
          "could not be read",
        );
        fakes.getFails = false;

        assert.deepStrictEqual(yield* prestartRows, rows);
        assert.strictEqual(yield* stateOf("idea"), "stopped");
      }),
    );
  });

  it.effect(
    "a re-claim's refusal retires a root with no row, and cancels a queued row by its id",
    () => {
      const fakes = makeFakes();
      return withFakes(
        fakes,
        Effect.gen(function* () {
          const absent = yield* parkedAbsent(fakes, "absent");
          const orphan = yield* parkedOrphan(fakes, "orphan");
          yield* control("absent", "resume");
          yield* control("orphan", "resume");

          // Each is granted, and each refused by the post-commit read of its edited item.
          fakes.items.get("item-absent")!.fingerprint = "edited";
          fakes.items.get("item-orphan")!.fingerprint = "edited";
          yield* tick;

          assert.strictEqual(yield* stateOf("absent"), "failed");
          assert.deepStrictEqual(yield* rootOf(absent), { state: "retired", reason: "failed" });
          assert.isUndefined(yield* slotOf(absent));

          assert.strictEqual(fakes.deliveries.get(orphan), "cancelled");
          assert.strictEqual(yield* stateOf("orphan"), "stopping");
          assert.deepStrictEqual(yield* rootOf(orphan), { state: "active", reason: null });
          assert.strictEqual((yield* slotOf(orphan))?.state, "held");
          assert.strictEqual(count(fakes, "start"), 2);
        }),
      );
    },
  );

  it.effect("a re-claim's failed read keeps the slot as launch-uncertain", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* parkedAbsent(fakes, "idea");
        yield* control("idea", "resume");
        fakes.items.get("item-idea")!.fingerprint = "edited";
        fakes.getFails = true;
        yield* tick;
        assert.strictEqual(yield* stateOf("idea"), "launch-uncertain");
        assert.strictEqual((yield* slotOf(root))?.state, "held");
        assert.strictEqual(count(fakes, "start"), 1);

        // The item restored, the same id starts.
        fakes.items.get("item-idea")!.fingerprint = "print-idea";
        fakes.getFails = false;
        yield* tick;
        assert.strictEqual(count(fakes, "start"), 2);
        assert.strictEqual(yield* stateOf("idea"), "running");
      }),
    );
  });

  it.live(
    "with the admitted probe paused, nothing deletes the re-claim, and nothing else is granted",
    () => {
      const fakes = makeFakes();
      return Effect.flatMap(holdingProbe, (held) =>
        withFakes(
          fakes,
          Effect.gen(function* () {
            const admission = yield* admissionService;
            const root = yield* parkedAbsent(fakes, "idea");
            yield* control("idea", "resume");
            yield* agreed(fakes, "behind");
            yield* fillSlots.pipe(Effect.andThen(freeSlot("root-other-b")));

            held.hold.pause = true;
            const ticking = yield* tick.pipe(Effect.forkChild);
            const admitted = yield* Deferred.await(held.entered);
            assert.strictEqual(admitted.root, root);
            assert.strictEqual(admitted.kind, "claim");

            const rows = yield* prestartRows;
            assert.strictEqual(yield* admission.release(root, admitted.entrySeq), "kept");
            assert.strictEqual(
              yield* admission.parkPreStart({
                root,
                admissionId: admitted.admissionId,
                entrySeq: admitted.entrySeq,
              }),
              "contended",
            );
            assert.strictEqual(
              yield* admission.retirePreDelivery({
                root,
                reason: "abandoned",
                shape: { type: "parked" },
              }),
              "contended",
            );
            assert.strictEqual(
              yield* admission.retirePreDelivery({
                root,
                reason: "failed",
                shape: {
                  type: "claim",
                  admissionId: admitted.admissionId,
                  entrySeq: admitted.entrySeq,
                },
              }),
              "contended",
            );
            const next = yield* admission.next;
            assert.strictEqual(next.free, 0);
            assert.isUndefined(next.head);
            assert.deepStrictEqual(yield* prestartRows, rows);
            assert.strictEqual(count(fakes, "start"), 1);

            yield* Deferred.succeed(held.go, undefined);
            yield* Fiber.join(ticking);
            assert.strictEqual(count(fakes, "start"), 2);
            assert.strictEqual((yield* admissionsOf(root))[0]?.state, "dispatched");
            assert.strictEqual(yield* stateOf("behind"), "queued");
          }),
          held.probe,
        ),
      );
    },
  );

  it.effect("a stopped delivery and a blocked one still resume through Factory.resume", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        yield* agreed(fakes, "idea");
        yield* tick;
        const root = (yield* linkOf("idea"))!.delivery_id!;

        yield* control("idea", "stop");
        fakes.deliveries.set(root, "stopped");
        const resumed = yield* control("idea", "resume");
        assert.strictEqual(resumed.state, "running");
        assert.strictEqual(count(fakes, "resume"), 1);
        assert.strictEqual(fakes.deliveries.get(root), "running");

        fakes.deliveries.set(root, "blocked");
        yield* control("idea", "resume");
        assert.strictEqual(count(fakes, "resume"), 2);
        assert.strictEqual(count(fakes, "start"), 1);

        // Running, it has nothing to resume.
        const refused = yield* Effect.flip(control("idea", "resume"));
        assert.include(refused.message, "cannot resume");
        assert.strictEqual(count(fakes, "resume"), 2);
      }),
    );
  });
});

describe("cancelling a root parked or pending a resume", () => {
  const branches = [
    {
      name: "a parked root with no row",
      park: parkedAbsent,
      pending: false,
      row: false,
    },
    {
      name: "a parked root with a queued row",
      park: parkedOrphan,
      pending: false,
      row: true,
    },
    {
      name: "a pending resume with no row",
      park: parkedAbsent,
      pending: true,
      row: false,
    },
    {
      name: "a pending resume with a queued row",
      park: parkedOrphan,
      pending: true,
      row: true,
    },
  ];

  it.effect.each(branches)("$name ends as its row says, and is never claimed after", (branch) => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* branch.park(fakes, "idea");
        if (branch.pending) yield* control("idea", "resume");
        const starts = count(fakes, "start");

        // A failed read persists the intent and changes nothing else.
        fakes.getFails = true;
        yield* control("idea", "cancel");
        assert.strictEqual((yield* linkOf("idea"))?.control, "cancel");
        assert.strictEqual(yield* stateOf("idea"), branch.pending ? "queued" : "stopped");
        assert.deepStrictEqual(yield* rootOf(root), { state: "active", reason: null });
        yield* tick;
        assert.strictEqual(count(fakes, "start"), starts);
        assert.strictEqual(yield* stateOf("idea"), branch.pending ? "queued" : "stopped");

        fakes.getFails = false;
        yield* tick;
        assert.strictEqual(yield* stateOf("idea"), "cancelled");
        assert.deepStrictEqual(yield* rootOf(root), {
          state: "retired",
          reason: branch.row ? "cancelled" : "abandoned",
        });
        assert.strictEqual(count(fakes, "cancel"), branch.row ? 1 : 0);
        assert.strictEqual(fakes.deliveries.get(root), branch.row ? "cancelled" : undefined);
        assert.isUndefined(yield* slotOf(root));
        assert.lengthOf(yield* admissionsOf(root), 0);
        assert.isUndefined(yield* positionOf("idea"));

        yield* tick;
        yield* tick;
        assert.strictEqual(count(fakes, "start"), starts);
        assert.strictEqual(yield* stateOf("idea"), "cancelled");
      }),
    );
  });

  it.effect("a failed cancel keeps every row and is retried", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* parkedOrphan(fakes, "idea");
        fakes.cancelFails = true;
        yield* control("idea", "cancel");
        assert.strictEqual(yield* stateOf("idea"), "stopped");
        assert.strictEqual(fakes.deliveries.get(root), "queued");
        yield* tick;
        assert.strictEqual(yield* stateOf("idea"), "stopped");

        fakes.cancelFails = false;
        yield* tick;
        assert.strictEqual(yield* stateOf("idea"), "cancelled");
        assert.deepStrictEqual(yield* rootOf(root), { state: "retired", reason: "cancelled" });
      }),
    );
  });

  it.effect("a row an owner cancelled in Factory retires the root with its reason", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const root = yield* parkedOrphan(fakes, "idea");
        fakes.deliveries.set(root, "cancelled");
        yield* tick;
        assert.strictEqual(yield* stateOf("idea"), "cancelled");
        assert.deepStrictEqual(yield* rootOf(root), { state: "retired", reason: "cancelled" });
        assert.strictEqual(count(fakes, "cancel"), 0);
        assert.isUndefined(yield* slotOf(root));
      }),
    );
  });

  it.live(
    "a cancel while a re-claim is paused waits for that start, then cancels the same id",
    () => {
      const fakes = makeFakes();
      return Effect.flatMap(holdingProbe, (held) =>
        withFakes(
          fakes,
          Effect.gen(function* () {
            const root = yield* parkedAbsent(fakes, "idea");
            yield* control("idea", "resume");
            held.hold.pause = true;
            const ticking = yield* tick.pipe(Effect.forkChild);
            yield* Deferred.await(held.entered);

            const cancelling = yield* control("idea", "cancel").pipe(
              Effect.forkChild({ startImmediately: true }),
            );
            // The claim holds the assistant's lock from its commit through its start.
            assert.strictEqual((yield* linkOf("idea"))?.control, "none");
            assert.strictEqual(count(fakes, "start"), 1);

            yield* Deferred.succeed(held.go, undefined);
            yield* Fiber.join(ticking);
            const cancelled = yield* Fiber.join(cancelling);

            assert.strictEqual(cancelled.state, "stopping");
            assert.strictEqual(count(fakes, "start"), 2);
            assert.strictEqual(count(fakes, "cancel"), 1);
            assert.strictEqual(fakes.deliveries.get(root), "cancelled");
            assert.strictEqual((yield* linkOf("idea"))?.delivery_id, root);
          }),
          held.probe,
        ),
      );
    },
  );
});

describe("parked roots and capacity", () => {
  it.effect("two parked roots hold nothing, and a third assignment is claimed past them", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const admission = yield* admissionService;
        const absent = yield* parkedAbsent(fakes, "absent");
        const orphan = yield* parkedOrphan(fakes, "orphan");
        assert.strictEqual((yield* admission.next).free, 2);

        yield* agreed(fakes, "third");
        yield* tick;
        assert.strictEqual(yield* stateOf("third"), "running");
        assert.strictEqual(yield* stateOf("absent"), "stopped");
        assert.strictEqual(yield* stateOf("orphan"), "stopped");
        assert.isUndefined(yield* slotOf(absent));
        assert.isUndefined(yield* slotOf(orphan));
      }),
    );
  });

  it.effect("a revoked brief keeps a pending resume queued and unclaimed until restored", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const assistant = yield* service;
        const root = yield* parkedAbsent(fakes, "idea");
        yield* control("idea", "resume");
        const [first] = yield* fillSlots;
        yield* assistant.revise({
          projectId: alpha,
          ideaId: "idea",
          patch: { executionAuthorized: false },
        });
        yield* freeSlot(first!);
        yield* tick;
        assert.strictEqual(yield* stateOf("idea"), "queued");
        assert.isUndefined(yield* slotOf(root));
        assert.strictEqual(count(fakes, "start"), 1);

        yield* assistant.revise({
          projectId: alpha,
          ideaId: "idea",
          patch: { executionAuthorized: true },
        });
        yield* tick;
        assert.strictEqual(count(fakes, "start"), 2);
        assert.strictEqual(yield* stateOf("idea"), "running");
      }),
    );
  });

  it.effect(
    "an item edited or unreadable while it waits is refused at the post-commit read",
    () => {
      const fakes = makeFakes();
      return withFakes(
        fakes,
        Effect.gen(function* () {
          const edited = yield* parkedAbsent(fakes, "edited");
          const unreadable = yield* parkedAbsent(fakes, "unreadable");
          yield* control("edited", "resume");
          yield* control("unreadable", "resume");
          fakes.items.get("item-edited")!.fingerprint = "edited";
          fakes.items.get("item-unreadable")!.readable = false;
          yield* tick;
          assert.strictEqual(count(fakes, "start"), 2);
          for (const [idea, root] of [
            ["edited", edited],
            ["unreadable", unreadable],
          ] as const) {
            assert.strictEqual(yield* stateOf(idea), "failed");
            assert.deepStrictEqual(yield* rootOf(root), { state: "retired", reason: "failed" });
            assert.isUndefined(yield* slotOf(root));
          }
        }),
      );
    },
  );
});

describe("legacy executors under the shared fair order", () => {
  const ordinary = (idea: string, rank: number) =>
    Effect.gen(function* () {
      const assistant = yield* service;
      yield* assistant.revise({
        projectId: alpha,
        ideaId: idea,
        patch: {
          goal: `Build ${idea}`,
          acceptanceCriteria: [`Verify ${idea}`],
          priority: { rank, reason: "Ranked" },
          executionAuthorized: true,
        },
      });
      return yield* assistant.enqueue({
        assignmentId: idea,
        projectId: alpha,
        ideaId: idea,
        managerThreadId: managerId,
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        looperConfig: null,
      });
    });

  it.effect("grants ordinary and Factory assignments by rank, counting each one slot", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const admission = yield* admissionService;
        yield* ordinary("second", 2);
        yield* agreed(fakes, "first", 1);
        yield* ordinary("third", 3);
        yield* tick;
        // Rank one is the Factory assignment, rank two the ordinary one: both slots are taken.
        assert.strictEqual(yield* stateOf("first"), "running");
        assert.strictEqual(yield* stateOf("second"), "launch-uncertain");
        assert.strictEqual(yield* stateOf("third"), "queued");
        assert.lengthOf(fakes.launches, 1);
        assert.strictEqual(fakes.launches[0]?.projectId, alpha);
        assert.strictEqual(count(fakes, "start"), 1);
        assert.strictEqual((yield* admission.next).free, 0);
      }),
    );
  });

  it.effect("counts a Factory assignment by its slot alone, not by its state", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const admission = yield* admissionService;
        const sql = yield* sqlOf;
        yield* agreed(fakes, "factory", 1);
        yield* tick;
        const root = (yield* linkOf("factory"))!.delivery_id!;
        assert.strictEqual((yield* admission.next).free, 1);

        // Released while its assignment still shows running: it counts for nothing.
        yield* sql`DELETE FROM fd_assistant_admissions WHERE root_delivery_id = ${root}`;
        yield* sql`DELETE FROM fd_assistant_slots WHERE root_delivery_id = ${root}`;
        assert.strictEqual(yield* stateOf("factory"), "running");
        assert.strictEqual((yield* admission.next).free, 2);

        // Ordinary assignments still count by their state.
        yield* ordinary("one", 2);
        yield* ordinary("two", 3);
        yield* ordinary("three", 4);
        yield* tick;
        assert.lengthOf(fakes.launches, 2);
        assert.strictEqual(yield* stateOf("three"), "queued");
      }),
    );
  });

  it.effect("gives rows an earlier build left queued positions in creation order", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const sql = yield* sqlOf;
        const admission = yield* admissionService;
        yield* ordinary("younger", 1);
        yield* ordinary("older", 1);
        yield* ordinary("orphan", 1);
        yield* sql`DELETE FROM fd_assistant_queue_positions`;
        yield* sql`UPDATE fd_assistant_assignments SET created_at = '2026-01-02T00:00:00.000Z'
          WHERE assignment_id = 'younger'`;
        yield* sql`UPDATE fd_assistant_assignments SET created_at = '2026-01-01T00:00:00.000Z'
          WHERE assignment_id = 'older'`;
        // A row with no stored dispatch has nothing to launch, and stays out of the order.
        yield* sql`DELETE FROM fd_assistant_dispatches WHERE assignment_id = 'orphan'`;

        yield* admission.normalizeQueue;
        assert.isBelow((yield* positionOf("older"))!.seq, (yield* positionOf("younger"))!.seq);
        assert.isUndefined(yield* positionOf("orphan"));
        const positions = [yield* positionOf("older"), yield* positionOf("younger")];
        yield* admission.normalizeQueue;
        assert.deepStrictEqual(
          [yield* positionOf("older"), yield* positionOf("younger")],
          positions,
        );

        yield* tick;
        assert.deepStrictEqual(
          fakes.launches.map(({ title }) => title),
          ["Build older", "Build younger"],
        );
      }),
    );
  });

  it.effect("keeps one assignment of an idea running, whichever executor runs it", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        const assistant = yield* service;
        yield* agreed(fakes, "idea");
        yield* tick;
        assert.strictEqual(yield* stateOf("idea"), "running");
        yield* assistant.enqueue({
          assignmentId: "second-attempt",
          projectId: alpha,
          ideaId: "idea",
          managerThreadId: managerId,
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          looperConfig: null,
        });
        yield* ordinary("elsewhere", 5);
        yield* tick;
        // The idea's second assignment waits, and holds up nothing behind it.
        assert.strictEqual(yield* stateOf("second-attempt"), "queued");
        assert.strictEqual(yield* stateOf("elsewhere"), "launch-uncertain");
      }),
    );
  });

  it.effect("refuses an assignment id already queued for another executor", () => {
    const fakes = makeFakes();
    return withFakes(
      fakes,
      Effect.gen(function* () {
        yield* agree(fakes, "idea");
        yield* ordinary("idea", 1);
        const refused = yield* Effect.flip(assign("idea"));
        assert.include(refused.message, "another executor");
      }),
    );
  });
});
