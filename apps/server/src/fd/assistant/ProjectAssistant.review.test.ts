import { assert, describe, it } from "@effect/vitest";
import {
  AssistantReviewSnapshot,
  type AssistantReviewKind,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  AuthWorkWriteScope,
  type AuthEnvironmentScope,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import type { FactoryReviewedExecution, FactoryRole } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
import type { BriefPatch } from "./portfolio.ts";
import * as PortfolioStore from "./PortfolioStore.ts";
import * as Assistant from "./ProjectAssistant.ts";
import * as WorkCaptureStore from "./WorkCaptureStore.ts";

/**
 * The owner's review over a fake Work and a fake Factory and the real stores: what its snapshot
 * says, what moves its version, and what a start records, with everything that can move held still
 * until a test has moved it. `FactoryHandoff.reviewed.test.ts` runs the same flow on the real stack.
 */

const alpha = ProjectId.make("alpha");
const managerId = ThreadId.make("fd-assistant-owner");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "configured" };
const at = "2026-10-31T12:00:00.000Z";
const ideaId = "export";
const tasks: HandoffBackend.HandoffSource = {
  sourceId: WorkSourceId.make("11111111-1111-4111-8111-111111111111"),
  kind: "markdown",
  label: "Tasks",
  identity: ".foredeck/work",
  version: 1,
};
const plans: HandoffBackend.HandoffSource = {
  sourceId: WorkSourceId.make("33333333-3333-4333-8333-333333333333"),
  kind: "markdown",
  label: "Plans",
  identity: ".foredeck/plans",
  version: 1,
};
const issues: HandoffBackend.HandoffSource = {
  sourceId: WorkSourceId.make("22222222-2222-4222-8222-222222222222"),
  kind: "github",
  label: "Issues",
  identity: "github.com/owner/alpha",
  version: 1,
};

/** The same source, as Work leaves it once moved: its id and label unchanged. */
const retargeted: HandoffBackend.HandoffSource = {
  ...tasks,
  identity: ".foredeck/elsewhere",
  version: 2,
};

/** A source as the snapshot shows it. */
const shownOf = ({ version: _version, ...shown }: HandoffBackend.HandoffSource) => shown;

const execution = (): FactoryReviewedExecution => ({
  receiptId: "preview",
  reviewVersion: 1,
  roles: {
    planner: { instanceId, model: "planner-model" },
    author: { instanceId, model: "author-model" },
    reviewer: { instanceId, model: "reviewer-model" },
  },
  verifyCommand: { executable: "npm", args: ["test"] },
  setupCommand: null,
  limits: { maxFixRounds: 3, maxReviewRounds: 3, maxFixCommitTurns: 1, verifyTimeoutMinutes: 30 },
  blockingSeverities: ["high"],
  highRiskEffort: "xhigh",
  pipelineId: "standard",
  repository: {
    projectId: alpha,
    workspaceRoot: "/projects/alpha",
    publication: {
      push: ["git@github.com:owner/alpha.git"],
      head: ["git@github.com:owner/alpha.git"],
      provider: "github",
      repository: "github.com/owner/alpha",
      remoteConfig: "config-hash",
    },
  },
  runtimeCeiling: "full-access",
  promptOverrides: {
    plan: "absent",
    author: "absent",
    review: "absent",
    "fix-verify": "absent",
    "fix-review": "absent",
    "fix-commit": "absent",
    integrate: "absent",
  },
});

const previewOf = (bound: FactoryReviewedExecution): HandoffBackend.HandoffReviewPreview => ({
  roles: {
    planner: { selection: bound.roles.planner, offered: true, options: [] },
    author: { selection: bound.roles.author, offered: true, options: [] },
    reviewer: { selection: bound.roles.reviewer, offered: true, options: [] },
  },
  verifyCommand: bound.verifyCommand,
  setupCommand: bound.setupCommand,
  limits: bound.limits,
  blockingSeverities: bound.blockingSeverities,
  highRiskEffort: bound.highRiskEffort,
  pipelineId: bound.pipelineId,
  execution: bound,
  refusal: null,
});

/** The review with a pull request going somewhere else, and nothing else changed. */
const movedPublication = (): FactoryReviewedExecution => {
  const values = execution();
  return {
    ...values,
    repository: {
      ...values.repository,
      publication: { ...values.repository.publication, repository: "github.com/someone/else" },
    },
  };
};

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
  readonly ref: HandoffBackend.HandoffItemRef;
  title: string;
  body: string;
  status: HandoffBackend.HandoffItem["status"];
  revision: number;
}

const FULL_GRANT: ReadonlyArray<AuthEnvironmentScope> = [
  AuthWorkWriteScope,
  AuthOrchestrationOperateScope,
];

/** Work, Factory, the manager and the owner, all a test can move, with every call counted. */
const makeFakes = () => {
  const items: Array<FakeItem> = [];
  const fakes = {
    items,
    manager: managerShell() as OrchestrationV2ThreadShell | null,
    sources: [tasks] as ReadonlyArray<HandoffBackend.HandoffSource>,
    preview: previewOf(execution()),
    previewFails: false,
    ownerScopes: FULL_GRANT as ReadonlyArray<AuthEnvironmentScope> | null,
    creates: 0,
    updates: 0,
    started: [] as Array<string>,
    /** Where each delivery stands, as Factory would answer for it. */
    deliveries: new Map<string, HandoffBackend.HandoffDelivery["status"]>(),
    /** Every review a delivery took, and every resume, in order. */
    rebinds: [] as Array<string>,
    resumes: [] as Array<string>,
    /** The receipt owing a resume, as Factory records it in the step of each. */
    owed: undefined as string | undefined,
    receipt: undefined as string | undefined,
    /** How far the delivery has run: a resume by hand moves it on. */
    effects: 1,
    /** The child each parent waits on, as Factory follows it. */
    waitingOn: undefined as string | undefined,
    repositories: [] as ReadonlyArray<string>,
    /** Fails the next call of each, as a restart cutting it short would. */
    failRebind: false,
    failResume: false,
    /** Run in turn by each read of an item before it answers, one per read. */
    onRead: [] as Array<Effect.Effect<void>>,
    /** Run once the source holds a create or update and before it answers. */
    afterWrite: undefined as Effect.Effect<void> | undefined,
    /** Run in turn by each preview after it has read what it answers with, one per preview. */
    onPreview: [] as Array<Effect.Effect<void>>,
    /** What the source reports of the item past its content, as a tracker sets it. */
    itemKey: undefined as string | undefined,
    itemUrl: null as string | null,
    itemTitle: undefined as string | undefined,
  };
  return fakes;
};
type Fakes = ReturnType<typeof makeFakes>;

const fingerprint = (content: { readonly title: string; readonly body: string }) =>
  JSON.stringify([content.title, content.body]);

const canonicalOf = (value: unknown) => JSON.stringify(value);

const workPort = (fakes: Fakes): typeof HandoffBackend.HandoffBackend.Service => ({
  ...HandoffBackend.HandoffBackend.defaultValue(),
  sources: () => Effect.sync(() => fakes.sources),
  fingerprint,
  read: (ref) =>
    Effect.gen(function* () {
      const hook = fakes.onRead.shift();
      if (hook !== undefined) yield* hook;
      const item = fakes.items.find(({ ref: { itemId } }) => itemId === ref.itemId);
      if (item === undefined) {
        return yield* new HandoffBackend.HandoffBackendError({
          operation: "read",
          reason: "not_found",
        });
      }
      return {
        ref,
        key: fakes.itemKey ?? ref.itemId,
        url: fakes.itemUrl,
        title: fakes.itemTitle ?? item.title,
        status: item.status,
        revision: String(item.revision),
        invalid: false,
        body: item.body,
        fingerprint: fingerprint(item),
        notes: "",
      };
    }),
  writer: (actor) =>
    HandoffBackend.isHandoffOwner(actor)
      ? Effect.succeed({ id: `session:${actor.sessionId}`, grants: actor.scopes, label: "owner" })
      : Effect.fail(new HandoffBackend.HandoffWriteRefused()),
  create: (_writer, { sourceId, title, body }) =>
    Effect.gen(function* () {
      fakes.creates += 1;
      const itemId = WorkItemId.make(`T-${fakes.items.length + 1}`);
      fakes.items.push({ ref: { sourceId, itemId }, title, body, status: "todo", revision: 1 });
      const hook = fakes.afterWrite;
      fakes.afterWrite = undefined;
      if (hook !== undefined) yield* hook;
      return { ref: { sourceId, itemId }, key: itemId, url: null };
    }),
  update: (_writer, { ref, expectedRevision, title, body }) =>
    Effect.gen(function* () {
      fakes.updates += 1;
      const item = fakes.items.find(({ ref: { itemId } }) => itemId === ref.itemId);
      if (item === undefined || String(item.revision) !== expectedRevision) {
        return yield* new HandoffBackend.HandoffBackendError({
          operation: "update",
          reason: "stale",
        });
      }
      item.title = title;
      item.body = body;
      item.revision += 1;
      const hook = fakes.afterWrite;
      fakes.afterWrite = undefined;
      if (hook !== undefined) yield* hook;
    }),
});

const factoryPort = (fakes: Fakes): typeof HandoffBackend.HandoffFactory.Service => ({
  ...HandoffBackend.HandoffFactory.defaultValue(),
  verifyConfigured: () => Effect.succeed(true),
  get: (deliveryId) =>
    Effect.sync(() => {
      const status = fakes.deliveries.get(deliveryId);
      return status === undefined ? Option.none() : Option.some({ deliveryId, status });
    }),
  start: ({ deliveryId }) =>
    Effect.sync(() => {
      fakes.started.push(deliveryId);
      fakes.deliveries.set(deliveryId, "running");
      return { deliveryId, status: "running" as const };
    }),
  resume: (deliveryId, options) =>
    Effect.gen(function* () {
      if (fakes.failResume) {
        fakes.failResume = false;
        return yield* new HandoffBackend.HandoffFactoryError({ operation: "resume" });
      }
      if (options?.owedBy !== undefined && fakes.owed !== options.owedBy) {
        return yield* new HandoffBackend.HandoffFactoryRefused({
          operation: "resume",
          reason: "not_owed",
        });
      }
      fakes.resumes.push(deliveryId);
      fakes.owed = undefined;
      fakes.deliveries.set(deliveryId, "running");
      return { deliveryId, status: "running" as const };
    }),
  follow: (deliveryId) =>
    Effect.sync(() => {
      const status = fakes.deliveries.get(deliveryId);
      return status === undefined
        ? Option.none()
        : Option.some({
            deliveryId,
            status,
            stage: null,
            awaiting: null,
            pullRequest: null,
            reason: null,
            threadId: null,
            child:
              fakes.waitingOn === undefined
                ? null
                : {
                    deliveryId: fakes.waitingOn,
                    status: fakes.deliveries.get(fakes.waitingOn) ?? "blocked",
                    stage: null,
                    reason: null,
                    threadId: null,
                  },
            marked: [],
          });
    }),
  activity: () =>
    Effect.succeed({ phase: "proceeding" as const, busy: true, deferred: false, unknown: false }),
  requests: () => Effect.succeed([]),
  pendingRequests: Effect.succeed({ byRoot: new Map(), complete: true }),
});

const layerOf = (fakes: Fakes) => {
  const coreReads = Layer.mergeAll(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: () => Effect.suspend(() => Effect.succeed(fakes.manager)),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (projectId) =>
        Effect.succeedSome({
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
          repositories: [],
        } as never),
    }),
  );
  const admission = HandoffAdmission.layer.pipe(
    Layer.provide(Layer.merge(coreReads, Assistant.layerPersistence)),
  );
  const core = Layer.mergeAll(
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: () => Effect.suspend(() => Effect.succeed(fakes.manager)),
    }),
    Layer.mock(Looper.Looper)({}),
    Layer.mock(Projects.ProjectService)({
      getById: (id) =>
        Effect.sync(() =>
          Option.some({
            id,
            title: id,
            workspaceRoot: "/projects/alpha",
            repositories: fakes.repositories,
            defaultModelSelection: null,
            scripts: [],
            createdAt: at,
            updatedAt: at,
            deletedAt: null,
          } as never),
        ),
    }),
    Layer.mock(Git.GitVcsDriver)({}),
    Layer.mock(Launches.ThreadLaunchService)({}),
    Layer.succeed(HandoffBackend.HandoffFactory, factoryPort(fakes)),
    Layer.succeed(HandoffBackend.HandoffBackend, workPort(fakes)),
    Layer.succeed(HandoffBackend.HandoffReview, {
      preview: () =>
        Effect.gen(function* () {
          if (fakes.previewFails) {
            return yield* new HandoffBackend.HandoffFactoryError({ operation: "review" });
          }
          const read = fakes.preview;
          const hook = fakes.onPreview.shift();
          if (hook !== undefined) yield* hook;
          return read;
        }),
      // The settings as they stand now, which a settings write cannot land inside. Where publication
      // goes is left to the reads around it, as Git and a provider cannot be asked in a transaction.
      holds: ({ execution }) =>
        Effect.sync(() => {
          const { execution: now } = fakes.preview;
          if (now === null) return false;
          const settingsOf = ({
            receiptId: _receipt,
            reviewVersion: _version,
            repository: _repository,
            ...settings
          }: FactoryReviewedExecution) => canonicalOf(settings);
          return settingsOf(now) === settingsOf(execution);
        }),
      atRest: (root) =>
        Effect.sync(() => {
          const status = fakes.deliveries.get(root);
          return status === "stopped" || status === "blocked"
            ? { deliveryId: root, status, effectsIssued: fakes.effects }
            : null;
        }),
      rebind: ({ execution, resume }) =>
        Effect.gen(function* () {
          if (fakes.failRebind) {
            fakes.failRebind = false;
            return yield* new HandoffBackend.HandoffFactoryError({ operation: "review" });
          }
          if (fakes.receipt === execution.receiptId) return;
          if (fakes.effects !== resume.effectsIssued) {
            return yield* new HandoffBackend.HandoffFactoryRefused({
              operation: "rebind",
              reason: "rebind_refused",
            });
          }
          fakes.rebinds.push(execution.receiptId);
          fakes.receipt = execution.receiptId;
          fakes.owed = execution.receiptId;
        }),
      resumeOwed: ({ receiptId }) => Effect.sync(() => fakes.owed === receiptId),
    }),
  );
  return Layer.mergeAll(
    Assistant.layer.pipe(Layer.provideMerge(admission), Layer.provide(core)),
    Assistant.layerPersistence,
  ).pipe(Layer.provideMerge(Sqlite.layerMemory));
};

const service = Assistant.ProjectAssistant;

const target = (kind: AssistantReviewKind = "single") => ({
  projectId: alpha,
  ideaId,
  managerThreadId: managerId,
  kind,
});

const ownerOf = (fakes: Fakes): HandoffBackend.HandoffOwner => ({
  sessionId: AuthSessionId.make("owner"),
  scopes: FULL_GRANT,
  current: Effect.sync(() => fakes.ownerScopes),
});

const revise = (patch: BriefPatch) =>
  Effect.flatMap(service, (assistant) => assistant.revise({ projectId: alpha, ideaId, patch }));

const agreed: BriefPatch = {
  goal: "Add the export button",
  acceptanceCriteria: ["Exports CSV"],
  constraints: ["No new dependencies"],
  decisions: ["Use the toolbar"],
};

const review = (kind?: AssistantReviewKind) =>
  Effect.flatMap(service, (assistant) => assistant.review(target(kind)));

const start = (
  fakes: Fakes,
  reviewVersion: string,
  requestId = "request-1",
  kind: AssistantReviewKind = "single",
) =>
  Effect.flatMap(service, (assistant) =>
    assistant.startReview({ ...target(kind), reviewVersion, requestId, owner: ownerOf(fakes) }),
  );

const tick = Effect.flatMap(service, (assistant) => assistant.tick);

const briefNow = Effect.flatMap(PortfolioStore.PortfolioStore, (store) =>
  store.getBrief(alpha, ideaId),
).pipe(Effect.map(Option.getOrThrow));

const countOf = (table: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM ${sql(table)}`,
  ).pipe(Effect.map((rows) => rows[0]?.count ?? 0));

/** Everything a start records, or a claim after it writes. */
const RECORDED_TABLES = [
  "fd_assistant_review_receipts",
  "fd_assistant_review_starts",
  "fd_assistant_assignments",
  "fd_assistant_dispatches",
  "fd_assistant_factory_links",
  "fd_assistant_queue_positions",
  "fd_assistant_managed_roots",
  "fd_assistant_slots",
];

/** No authorization, receipt, assignment or worker, however often the queue is looked at. */
const assertNothingStarted = (fakes: Fakes) =>
  Effect.gen(function* () {
    assert.isFalse((yield* briefNow).executionAuthorized);
    for (const table of RECORDED_TABLES) assert.strictEqual(yield* countOf(table), 0, table);
    yield* tick;
    for (const table of RECORDED_TABLES) assert.strictEqual(yield* countOf(table), 0, table);
    assert.deepStrictEqual(fakes.started, []);
  });

/** An edit nobody can see coming, at each of the last waits before recording. */
const LATE_EDITS = [
  { name: "edited during the final read of the settings", hook: "preview", closes: false },
  { name: "edited during the final read of the item", hook: "read", closes: false },
  { name: "closed during the final read of the settings", hook: "preview", closes: true },
  { name: "closed during the final read of the item", hook: "read", closes: true },
] as const;

const lateEdit = (fakes: Fakes, closes: boolean) =>
  Effect.sync(() => {
    const [item] = fakes.items;
    if (item === undefined) return assert.fail("No item was created.");
    if (closes) item.status = "done";
    else item.title = "Someone renamed this in Work";
    item.revision += 1;
  });

describe("the owner's review snapshot", () => {
  it.effect("says what a start would capture and run, with what is not delivered marked", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise({ ...agreed, conversationNotes: ["Only discuss for now."] });
      fakes.preview = {
        ...previewOf(execution()),
        roles: {
          ...previewOf(execution()).roles,
          author: {
            selection: { instanceId, model: "author-model" },
            offered: true,
            options: [
              { id: "effort", value: "high", supported: true },
              { id: "tier", value: "priority", supported: false },
            ],
          },
        },
      };
      const snapshot = yield* review();

      assert.deepStrictEqual(snapshot.title, {
        text: "Add the export button",
        origin: "derived",
      });
      assert.strictEqual(snapshot.goal, "Add the export button");
      assert.deepStrictEqual(snapshot.conversationNotes, {
        items: ["Only discuss for now."],
        delivered: false,
      });
      assert.isNull(snapshot.scopeChanges);
      assert.deepStrictEqual(snapshot.target.repository, {
        workspaceRoot: "/projects/alpha",
        provider: "github",
        repository: "github.com/owner/alpha",
      });
      assert.deepStrictEqual(snapshot.target.source, shownOf(tasks));
      assert.isNull(snapshot.target.item);
      // What the model does not support stays visible, and flagged.
      assert.deepStrictEqual(snapshot.roles.author.options, [
        { id: "effort", value: "high", supported: true },
        { id: "tier", value: "priority", supported: false },
      ]);
      // Nothing claims a provider confirmed anything.
      assert.strictEqual(snapshot.roles.author.acknowledgement, "not_reported");
      assert.strictEqual(snapshot.roles.reviewer.acknowledgement, "not_reported");
      assert.strictEqual(snapshot.limits.verifyTimeoutScope, "per_command");
      assert.strictEqual(snapshot.limits.totalTime, "unsupported");
      assert.deepStrictEqual(snapshot.runtime, {
        requested: "full-access",
        ceiling: "full-access",
      });
      assert.lengthOf(snapshot.overrides, 7);
      assert.isTrue(snapshot.overrides.every(({ state }) => state === "absent"));

      // An unsupported option of a role in use stands in the way, saying which.
      assert.strictEqual(snapshot.start.mode, "none");
      assert.deepStrictEqual(
        snapshot.start.blockers.map(({ code }) => code),
        ["option_unsupported"],
      );
      assert.include(snapshot.start.blockers[0]?.message ?? "", "tier");
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("shows what a project that cannot run yet has, and why it cannot start", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      fakes.preview = {
        ...previewOf(execution()),
        verifyCommand: null,
        execution: null,
        refusal: "Set a verify command in the Factory settings of project alpha.",
      };
      const snapshot = yield* review();
      assert.strictEqual(snapshot.start.mode, "none");
      assert.strictEqual(snapshot.start.blockers[0]?.code, "settings");
      assert.include(snapshot.start.blockers[0]?.message ?? "", "verify command");
      assert.isNull(snapshot.verifyCommand);
      assert.isNull(snapshot.runtime.ceiling);
      assert.isTrue(snapshot.overrides.every(({ state }) => state === "unknown"));
      assert.isNull(snapshot.limits.maxFixCommitTurns);

      const refused = yield* Effect.flip(start(fakes, snapshot.reviewVersion));
      assert.include(refused.message, "verify command");
      yield* assertNothingStarted(fakes);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("stays bounded, and starts nothing it could not show whole", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise({
        ...agreed,
        goal: "g".repeat(30_000),
        acceptanceCriteria: Array.from({ length: 300 }, (_, index) => `Criterion ${index}`),
      });
      const snapshot = yield* review();
      assert.isTrue(snapshot.truncated);
      assert.isAtMost(snapshot.goal.length, 20_000);
      assert.isTrue(snapshot.goal.endsWith("…"));
      assert.lengthOf(snapshot.acceptanceCriteria, 200);
      assert.strictEqual(snapshot.acceptanceCriteria.at(-1), "… and 101 more");
      assert.strictEqual(snapshot.start.mode, "none");
      assert.include(
        snapshot.start.blockers.map(({ code }) => code),
        "too_long",
      );
      // A start is judged the same way, whatever a client sends it.
      const refused = yield* Effect.flip(start(fakes, snapshot.reviewVersion));
      assert.include(refused.message, "too long");
      assert.strictEqual(fakes.creates, 0);
      yield* assertNothingStarted(fakes);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("reports what changed since the last capture, field by field", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      const first = yield* review();
      yield* start(fakes, first.reviewVersion);
      yield* revise({ goal: "Add a better export button" });
      yield* revise({ goal: "Add the best export button", constraints: [] });
      yield* revise({ conversationNotes: ["Not a change of scope"] });

      const snapshot = yield* review();
      assert.deepStrictEqual(snapshot.scopeChanges, [
        {
          field: "goal",
          previous: ["Add the export button"],
          next: ["Add the best export button"],
        },
        { field: "constraints", previous: ["No new dependencies"], next: [] },
      ]);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  const moved = (bound: (values: FactoryReviewedExecution) => FactoryReviewedExecution) => {
    return (fakes: Fakes) =>
      Effect.sync(() => {
        fakes.preview = previewOf(bound(execution()));
      });
  };

  const BOUND: ReadonlyArray<{
    readonly name: string;
    readonly move: (
      fakes: Fakes,
    ) => Effect.Effect<unknown, Assistant.AssistantError, Assistant.ProjectAssistant>;
  }> = [
    { name: "the title", move: () => revise({ title: "CSV export" }) },
    { name: "the goal", move: () => revise({ goal: "Add the import button" }) },
    { name: "the criteria", move: () => revise({ acceptanceCriteria: ["Imports CSV"] }) },
    { name: "a restriction", move: () => revise({ constraints: [] }) },
    { name: "a decision", move: () => revise({ decisions: [] }) },
    { name: "an open question", move: () => revise({ openQuestions: ["Which delimiter?"] }) },
    {
      name: "the verify command",
      move: moved((values) => ({
        ...values,
        verifyCommand: { executable: "npm", args: ["run", "check"] },
      })),
    },
    {
      name: "the setup command",
      move: moved((values) => ({
        ...values,
        setupCommand: { executable: "npm", args: ["install"] },
      })),
    },
    {
      name: "a role's model",
      move: moved((values) => ({
        ...values,
        roles: { ...values.roles, reviewer: { instanceId, model: "other-model" } },
      })),
    },
    {
      name: "a role's options",
      move: moved((values) => ({
        ...values,
        roles: {
          ...values.roles,
          author: { instanceId, model: "author-model", options: [{ id: "effort", value: "high" }] },
        },
      })),
    },
    {
      name: "a count limit",
      move: moved((values) => ({ ...values, limits: { ...values.limits, maxFixRounds: 5 } })),
    },
    {
      name: "the per-command timeout",
      move: moved((values) => ({
        ...values,
        limits: { ...values.limits, verifyTimeoutMinutes: 60 },
      })),
    },
    {
      name: "the blocking severities",
      move: moved((values) => ({ ...values, blockingSeverities: ["high", "medium"] })),
    },
    {
      name: "the high-risk effort",
      move: moved((values) => ({ ...values, highRiskEffort: "max" })),
    },
    { name: "the pipeline", move: moved((values) => ({ ...values, pipelineId: "other" })) },
    {
      name: "the runtime ceiling",
      move: moved((values) => ({ ...values, runtimeCeiling: "auto-accept-edits" })),
    },
    {
      name: "a prompt override",
      move: moved((values) => ({
        ...values,
        promptOverrides: { ...values.promptOverrides, review: "a".repeat(64) },
      })),
    },
    {
      name: "the publication target",
      move: moved((values) => ({
        ...values,
        repository: {
          ...values.repository,
          publication: {
            ...values.repository.publication,
            repository: "github.com/someone/else",
          },
        },
      })),
    },
    {
      name: "the manager's mode",
      move: (fakes) =>
        Effect.sync(() => {
          fakes.manager = managerShell({ runtimeMode: "auto-accept-edits" as RuntimeMode });
        }),
    },
    {
      name: "the source",
      move: (fakes) =>
        Effect.sync(() => {
          fakes.sources = [plans, tasks];
        }),
    },
    {
      name: "where the source writes, under the same id and label",
      move: (fakes) =>
        Effect.sync(() => {
          fakes.sources = [retargeted];
        }),
    },
    {
      name: "the source's configuration, under the same id and destination",
      move: (fakes) =>
        Effect.sync(() => {
          fakes.sources = [{ ...tasks, version: 2 }];
        }),
    },
  ];

  it.effect.each(BOUND)("moves its version when $name changes", ({ move }) => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      const before = yield* review();
      assert.strictEqual((yield* review()).reviewVersion, before.reviewVersion);
      yield* move(fakes);
      assert.notStrictEqual((yield* review()).reviewVersion, before.reviewVersion);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("moves its version for another way to deliver it", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      assert.notStrictEqual(
        (yield* review("single")).reviewVersion,
        (yield* review("parent")).reviewVersion,
      );
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("keeps its version for what is not scope: notes, priority and authorization", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      const before = yield* review();
      yield* revise({ conversationNotes: ["Temporary"] });
      yield* revise({ priority: { rank: 1, reason: "Soon" } });
      yield* revise({ executionAuthorized: true });
      assert.strictEqual((yield* review()).reviewVersion, before.reviewVersion);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("reads the owner's chosen source, and a parent's need for a Markdown one", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      fakes.sources = [tasks, issues];
      const several = yield* review();
      assert.strictEqual(several.start.blockers[0]?.code, "several_sources");
      assert.isNull(several.target.source);
      assert.lengthOf(several.target.sources, 2);

      const assistant = yield* service;
      const chosen = yield* assistant.review({ ...target(), sourceId: issues.sourceId });
      assert.deepStrictEqual(chosen.target.source, shownOf(issues));
      assert.strictEqual(chosen.start.mode, "new_attempt");
      const parent = yield* assistant.review({ ...target("parent"), sourceId: issues.sourceId });
      assert.strictEqual(parent.start.blockers[0]?.code, "tracker_parent");
    }).pipe(Effect.provide(layerOf(fakes)));
  });
});

describe("the size of a review", () => {
  /** Characters of JSON no review goes past, whatever it is asked to show. */
  const CEILING = 700_000;
  const sizeOf = (snapshot: AssistantReviewSnapshot) => JSON.stringify(snapshot).length;
  const huge = "x".repeat(100_000);
  const encode = Schema.encodeSync(AssistantReviewSnapshot);
  const withoutVersion = (snapshot: AssistantReviewSnapshot) => ({
    ...snapshot,
    reviewVersion: "",
  });

  const sourceNumbered = (index: number, text = "Source"): HandoffBackend.HandoffSource => ({
    sourceId: WorkSourceId.make(`44444444-4444-4444-8444-${String(index).padStart(12, "0")}`),
    kind: "markdown",
    label: `${text} ${index}`,
    identity: `${text}/${index}`,
    version: 1,
  });

  const setBound = (
    fakes: Fakes,
    change: (values: FactoryReviewedExecution) => FactoryReviewedExecution,
  ) => {
    fakes.preview = previewOf(change(execution()));
  };

  const setOptions = (
    fakes: Fakes,
    role: FactoryRole,
    options: HandoffBackend.HandoffReviewRole["options"],
  ) => {
    fakes.preview = {
      ...fakes.preview,
      roles: { ...fakes.preview.roles, [role]: { ...fakes.preview.roles[role], options } },
    };
  };

  const setModel = (fakes: Fakes, model: string) =>
    setBound(fakes, (values) => ({
      ...values,
      roles: { ...values.roles, author: { instanceId, model } },
    }));

  const longestCommand = {
    executable: "e".repeat(1024),
    args: Array.from({ length: 256 }, () => "a".repeat(8192)),
  };

  /** Everything one field can hold, alone, and how little of it a review may add. */
  const OVERSIZED: ReadonlyArray<{
    readonly name: string;
    readonly grow: (fakes: Fakes) => void;
    readonly adds: number;
    readonly blocks: boolean;
  }> = [
    {
      name: "the chosen source's label",
      grow: (fakes) => {
        fakes.sources = [{ ...tasks, label: huge }];
      },
      adds: 2_400,
      blocks: true,
    },
    {
      name: "the chosen source's destination",
      grow: (fakes) => {
        fakes.sources = [{ ...tasks, identity: huge }];
      },
      adds: 2_400,
      blocks: true,
    },
    {
      name: "a role's model",
      grow: (fakes) => setModel(fakes, huge),
      adds: 1_400,
      blocks: true,
    },
    {
      name: "a saved option's name",
      grow: (fakes) => setOptions(fakes, "author", [{ id: huge, value: "on", supported: true }]),
      adds: 1_500,
      blocks: true,
    },
    {
      name: "a saved option's value",
      grow: (fakes) => setOptions(fakes, "author", [{ id: "tier", value: huge, supported: true }]),
      adds: 1_500,
      blocks: true,
    },
    {
      name: "how many options are saved",
      grow: (fakes) =>
        setOptions(
          fakes,
          "author",
          Array.from({ length: 500 }, (_, index) => ({
            id: `option-${index}`,
            value: "on",
            supported: true,
          })),
        ),
      adds: 2_400,
      blocks: true,
    },
    {
      name: "the name of an option the model does not support",
      grow: (fakes) => setOptions(fakes, "author", [{ id: huge, value: "on", supported: false }]),
      adds: 2_600,
      blocks: true,
    },
    {
      name: "how many options the model does not support",
      grow: (fakes) =>
        setOptions(
          fakes,
          "author",
          Array.from({ length: 500 }, (_, index) => ({
            id: `option-${index}`,
            value: "on",
            supported: false,
          })),
        ),
      adds: 7_000,
      blocks: true,
    },
    {
      name: "the verify command",
      grow: (fakes) => setBound(fakes, (values) => ({ ...values, verifyCommand: longestCommand })),
      adds: 17_600,
      blocks: true,
    },
    {
      name: "the setup command",
      grow: (fakes) => setBound(fakes, (values) => ({ ...values, setupCommand: longestCommand })),
      adds: 17_600,
      blocks: true,
    },
    {
      name: "the repository's path",
      grow: (fakes) =>
        setBound(fakes, (values) => ({
          ...values,
          repository: { ...values.repository, workspaceRoot: huge },
        })),
      adds: 1_400,
      blocks: true,
    },
    {
      name: "where a pull request goes",
      grow: (fakes) =>
        setBound(fakes, (values) => ({
          ...values,
          repository: {
            ...values.repository,
            publication: { ...values.repository.publication, repository: huge },
          },
        })),
      adds: 1_400,
      blocks: true,
    },
    {
      name: "a source nobody chose",
      grow: (fakes) => {
        fakes.sources = [tasks, { ...plans, label: huge, identity: huge }];
      },
      adds: 2_400,
      blocks: false,
    },
    {
      name: "how many sources a project has",
      grow: (fakes) => {
        fakes.sources = [
          tasks,
          ...Array.from({ length: 500 }, (_, index) => sourceNumbered(index)),
        ];
      },
      adds: 6_000,
      blocks: false,
    },
    {
      name: "the options of a role this delivery does not use",
      grow: (fakes) => setOptions(fakes, "planner", [{ id: huge, value: huge, supported: true }]),
      adds: 2_400,
      blocks: false,
    },
  ];

  it.effect.each(OVERSIZED)(
    "shows only so much of $name, and says so",
    ({ grow, adds, blocks }) => {
      const fakes = makeFakes();
      return Effect.gen(function* () {
        const assistant = yield* service;
        const input = { ...target(), sourceId: tasks.sourceId };
        yield* revise(agreed);
        const ordinary = yield* assistant.review(input);

        grow(fakes);
        const snapshot = yield* assistant.review(input);
        assert.isAtMost(sizeOf(snapshot) - sizeOf(ordinary), adds);
        assert.isTrue(snapshot.truncated);
        // The brief is shown whole, so it stays the owner's to edit.
        assert.isFalse(snapshot.briefTruncated);
        assert.doesNotThrow(() => encode(snapshot));

        const started = assistant.startReview({
          ...input,
          reviewVersion: snapshot.reviewVersion,
          requestId: "request-1",
          owner: ownerOf(fakes),
        });
        if (!blocks) {
          assert.strictEqual(snapshot.start.mode, "new_attempt");
          assert.strictEqual((yield* started).outcome, "queued");
          return;
        }
        assert.strictEqual(snapshot.start.mode, "none");
        assert.include(
          snapshot.start.blockers.map(({ code }) => code),
          "details_too_long",
        );
        const refused = yield* Effect.flip(started);
        assert.isAtMost(refused.message.length, 1_024);
        assert.strictEqual(fakes.creates, 0);
        yield* assertNothingStarted(fakes);
      }).pipe(Effect.provide(layerOf(fakes)));
    },
  );

  it.effect.each([
    {
      name: "the settings say",
      block: (fakes: Fakes) => {
        fakes.preview = { ...previewOf(execution()), execution: null, refusal: huge };
      },
    },
    {
      name: "a choice of sources says",
      block: (fakes: Fakes) => {
        fakes.sources = Array.from({ length: 20 }, (_, index) => sourceNumbered(index, huge));
      },
    },
  ])("gives a reason in few words, however much $name", ({ block }) => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      block(fakes);
      const snapshot = yield* review();
      const reason = snapshot.start.blockers[0]?.message ?? "";
      assert.isAtMost(reason.length, 1_024);
      assert.isTrue(reason.endsWith("…"));
      // A start refused for it says the same, whatever a client sends it.
      const refused = yield* Effect.flip(start(fakes, snapshot.reviewVersion));
      assert.strictEqual(refused.message, reason);
      assert.strictEqual(fakes.creates, 0);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("shows only so much of what a tracker says of a captured item", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      yield* start(fakes, (yield* review()).reviewVersion);
      for (const report of [
        { itemKey: huge },
        { itemUrl: huge },
        { itemTitle: huge },
      ] as ReadonlyArray<Partial<Fakes>>) {
        Object.assign(fakes, { itemKey: undefined, itemUrl: null, itemTitle: undefined }, report);
        const snapshot = yield* review();
        assert.isAtMost(snapshot.target.item?.key?.length ?? 0, 1_024);
        assert.isAtMost(snapshot.target.item?.url?.length ?? 0, 1_024);
        assert.isAtMost(snapshot.title.text.length, 1_024);
        assert.isTrue(snapshot.truncated);
        assert.include(
          snapshot.start.blockers.map(({ code }) => code),
          "details_too_long",
        );
      }
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  /** Assignments that ended long ago, numbered so the list reads oldest first. */
  const endedAttempts = (from: number, to: number) =>
    Effect.gen(function* () {
      const store = yield* PortfolioStore.PortfolioStore;
      for (let index = from; index < to; index += 1) {
        const assignmentId = `old-${String(index).padStart(4, "0")}`;
        yield* store.createAssignment({
          assignmentId,
          projectId: alpha,
          ideaId,
          executor: "factory",
        });
        yield* store.transitionAssignment({ assignmentId, event: { type: "cancel" } });
      }
    }).pipe(Effect.orDie);

  it.effect("lists an idea's latest attempts, however many it had, and still starts", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      yield* endedAttempts(0, 201);
      const fewer = yield* review();
      assert.lengthOf(fewer.attempts, 20);
      assert.strictEqual(fewer.attemptsOmitted, 181);

      yield* endedAttempts(201, 401);
      const more = yield* review();
      assert.lengthOf(more.attempts, 20);
      assert.strictEqual(more.attemptsOmitted, 381);
      assert.strictEqual(more.attempts[0]?.assignmentId, "old-0381");
      assert.strictEqual(more.attempts.at(-1)?.assignmentId, "old-0400");
      assert.strictEqual(sizeOf(more), sizeOf(fewer));
      assert.isTrue(more.truncated);
      assert.isFalse(more.briefTruncated);
      assert.strictEqual(more.start.mode, "new_attempt");

      // What a version compares is the whole history, past what any snapshot lists.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE fd_assistant_assignments SET state = 'failed'
        WHERE assignment_id = 'old-0000'`;
      const moved = yield* review();
      assert.deepStrictEqual(withoutVersion(moved), withoutVersion(more));
      assert.notStrictEqual(moved.reviewVersion, more.reviewVersion);
      const refused = yield* Effect.flip(start(fakes, more.reviewVersion));
      assert.include(refused.message, "nothing was authorized or started");

      assert.strictEqual((yield* start(fakes, moved.reviewVersion)).outcome, "queued");
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect.each([
    {
      name: "the chosen source's destination",
      move: (fakes: Fakes, tail: string) => {
        fakes.sources = [{ ...tasks, identity: `${huge}${tail}` }];
      },
    },
    {
      name: "a role's model",
      move: (fakes: Fakes, tail: string) => setModel(fakes, `${huge}${tail}`),
    },
    {
      name: "an argument of the verify command",
      move: (fakes: Fakes, tail: string) =>
        setBound(fakes, (values) => ({
          ...values,
          verifyCommand: {
            executable: "npm",
            args: [...longestCommand.args.slice(0, 255), `${"a".repeat(8000)}${tail}`],
          },
        })),
    },
    {
      name: "a saved option past the ones listed",
      move: (fakes: Fakes, tail: string) => {
        const options = Array.from({ length: 40 }, (_, index) => ({
          id: `option-${index}`,
          value: index === 39 ? tail : "on",
        }));
        setBound(fakes, (values) => ({
          ...values,
          roles: { ...values.roles, author: { instanceId, model: "author-model", options } },
        }));
        setOptions(
          fakes,
          "author",
          options.map((option) => ({ ...option, supported: true })),
        );
      },
    },
  ])("compares all of $name, past what it shows", ({ move }) => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      move(fakes, "one");
      const before = yield* review();
      move(fakes, "two");
      const after = yield* review();
      assert.deepStrictEqual(withoutVersion(after), withoutVersion(before));
      assert.notStrictEqual(after.reviewVersion, before.reviewVersion);
      const refused = yield* Effect.flip(start(fakes, before.reviewVersion));
      assert.include(refused.message, "nothing was authorized or started");
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("cuts a brief that fits field by field but not as a whole", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      const entries = Array.from({ length: 200 }, (_, index) => `${index}`.padEnd(400, "x"));
      yield* revise({
        ...agreed,
        acceptanceCriteria: entries,
        constraints: entries,
        decisions: entries,
        conversationNotes: entries,
      });
      const snapshot = yield* review();
      assert.isTrue(snapshot.truncated);
      assert.isTrue(snapshot.briefTruncated);
      assert.isAtMost(sizeOf(snapshot), 210_000);
      // Whatever comes first shows whole, and what is left says how much was.
      assert.deepStrictEqual(snapshot.acceptanceCriteria, entries);
      assert.match(snapshot.conversationNotes.items.at(-1) ?? "", /^… and \d+ more$/);
      assert.include(
        snapshot.start.blockers.map(({ code }) => code),
        "too_long",
      );
      yield* Effect.flip(start(fakes, snapshot.reviewVersion));
      assert.strictEqual(fakes.creates, 0);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("cuts nothing of a brief that fits exactly, and starts it", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      const goal = "g".repeat(20_000);
      const acceptanceCriteria = Array.from({ length: 45 }, (_, index) =>
        `${index}`.padEnd(4_000, "c"),
      );
      yield* revise({ goal, acceptanceCriteria, constraints: [], decisions: [] });
      const snapshot = yield* review();
      assert.strictEqual(snapshot.goal, goal);
      assert.deepStrictEqual(snapshot.acceptanceCriteria, acceptanceCriteria);
      assert.isFalse(snapshot.truncated);
      assert.isFalse(snapshot.briefTruncated);
      assert.strictEqual((yield* start(fakes, snapshot.reviewVersion)).outcome, "queued");
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("never cuts through a surrogate pair", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise({ ...agreed, goal: `${"g".repeat(19_998)}😀${"g".repeat(10)}` });
      fakes.sources = [{ ...tasks, label: `${"l".repeat(1_022)}😀${"l".repeat(10)}` }];
      const snapshot = yield* review();
      const unpaired = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
      assert.isTrue(snapshot.goal.endsWith("…"));
      assert.isFalse(unpaired.test(snapshot.goal));
      assert.isTrue(snapshot.target.source?.label.endsWith("…"));
      assert.isFalse(unpaired.test(snapshot.target.source?.label ?? ""));
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  /** A review with everything it can show as large as it gets, `scale` times over. */
  const overwhelm = (fakes: Fakes, scale: number, from: number) =>
    Effect.gen(function* () {
      const entries = Array.from({ length: 300 * scale }, () => "t".repeat(5_000));
      yield* revise({
        goal: "t".repeat(30_000 * scale),
        acceptanceCriteria: entries,
        constraints: entries,
        decisions: entries,
        openQuestions: entries,
        conversationNotes: entries,
      });
      yield* endedAttempts(from, 250 * scale);
      const longest = "t".repeat(100_000 * scale);
      fakes.itemKey = longest;
      fakes.itemUrl = longest;
      fakes.itemTitle = longest;
      fakes.sources = [
        { ...tasks, label: longest, identity: longest },
        ...Array.from({ length: 500 * scale }, (_, index) => ({
          ...sourceNumbered(index),
          label: longest,
          identity: longest,
        })),
      ];
      const options = Array.from({ length: 500 * scale }, (_, index) => ({
        id: `${index}-${longest}`,
        value: longest,
        supported: false,
      }));
      const values = execution();
      const bound: FactoryReviewedExecution = {
        ...values,
        verifyCommand: longestCommand,
        setupCommand: longestCommand,
        blockingSeverities: Array.from({ length: 500 * scale }, () => "high" as const),
        highRiskEffort: "h".repeat(64),
        pipelineId: "p".repeat(64),
        repository: {
          ...values.repository,
          workspaceRoot: longest,
          publication: {
            ...values.repository.publication,
            provider: longest,
            repository: longest,
          },
        },
      };
      const roleOf = (model: string): HandoffBackend.HandoffReviewRole => ({
        selection: { instanceId, model: `${model}-${longest}` },
        offered: false,
        options,
      });
      fakes.preview = {
        ...previewOf(bound),
        roles: {
          planner: roleOf("planner"),
          author: roleOf("author"),
          reviewer: roleOf("reviewer"),
        },
        refusal: longest,
      };
    });

  it.effect("has a ceiling, with everything it shows as large as it gets", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      yield* start(fakes, (yield* review()).reviewVersion);

      yield* overwhelm(fakes, 1, 0);
      const large = yield* review();
      assert.isAtMost(sizeOf(large), CEILING);

      // Far more of everything adds no more than the digits of what it counts.
      yield* overwhelm(fakes, 3, 250);
      const larger = yield* review();
      assert.isAtMost(sizeOf(larger), CEILING);
      assert.isAtMost(Math.abs(sizeOf(larger) - sizeOf(large)), 100);

      assert.doesNotThrow(() => encode(larger));
      assert.isTrue(larger.truncated);
      assert.isTrue(larger.briefTruncated);
      assert.strictEqual(larger.start.mode, "none");
      assert.lengthOf(larger.start.blockers, 20);
      assert.match(larger.start.blockers.at(-1)?.message ?? "", /^… and \d+ more reasons$/);
      assert.lengthOf(larger.attempts, 20);
      assert.lengthOf(larger.target.sources, 50);
      assert.strictEqual(larger.target.sourcesOmitted, 1_451);
      assert.lengthOf(larger.roles.author.options, 32);
      assert.strictEqual(larger.roles.author.optionsOmitted, 1_468);
      assert.deepStrictEqual(larger.blockingSeverities, ["high"]);
    }).pipe(Effect.provide(layerOf(fakes)));
  });
});

describe("editing through the review", () => {
  it.effect(
    "refuses a stale edit, overwriting nothing, and starts nothing however it is saved",
    () => {
      const fakes = makeFakes();
      return Effect.gen(function* () {
        yield* revise(agreed);
        const snapshot = yield* review();
        const assistant = yield* service;
        const edit = (goal: string) =>
          assistant.revise({
            projectId: alpha,
            ideaId,
            expectedRevision: snapshot.briefRevision,
            patch: { goal },
          });
        const saved = yield* edit("Add the import button");
        const refused = yield* Effect.flip(edit("Add something else"));
        assert.include(refused.message, "was not saved");
        assert.strictEqual((yield* briefNow).goal, saved.goal);
        yield* assertNothingStarted(fakes);
        assert.deepStrictEqual(fakes.items, []);
      }).pipe(Effect.provide(layerOf(fakes)));
    },
  );

  it.effect("clears an earlier authorization when scope changes, and only then", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise({ ...agreed, executionAuthorized: true });
      yield* revise({ conversationNotes: ["Keep talking"] });
      assert.isTrue((yield* briefNow).executionAuthorized);
      yield* revise({ constraints: ["Keep it small"] });
      assert.isFalse((yield* briefNow).executionAuthorized);
      yield* assertNothingStarted(fakes);
    }).pipe(Effect.provide(layerOf(fakes)));
  });
});

describe("a start", () => {
  it.effect.each([
    { name: "names the title it already has", first: {}, edit: "Add the export button" },
    { name: "clears the title it was captured under", first: { title: "CSV export" }, edit: "" },
  ])("goes ahead once an edit $name, writing nothing to Work", ({ first, edit }) => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise({ ...agreed, ...first });
      // A start the settings moved under leaves its capture behind, with no authority.
      const refusedFirst = yield* review();
      fakes.afterWrite = Effect.sync(() => {
        fakes.preview = previewOf(movedPublication());
      });
      yield* Effect.flip(start(fakes, refusedFirst.reviewVersion));
      fakes.preview = previewOf(execution());
      assert.strictEqual(fakes.creates, 1);
      yield* assertNothingStarted(fakes);

      const assistant = yield* service;
      yield* assistant.revise({
        projectId: alpha,
        ideaId,
        expectedRevision: (yield* review()).briefRevision,
        patch: { title: edit },
      });
      const edited = yield* review();
      assert.strictEqual(edited.start.mode, "new_attempt");
      assert.deepStrictEqual(edited.start.blockers, []);

      const started = yield* start(fakes, edited.reviewVersion, "request-2");
      assert.strictEqual(started.outcome, "queued");
      assert.strictEqual(fakes.creates, 1);
      assert.strictEqual(fakes.updates, 0);
      assert.isTrue((yield* briefNow).executionAuthorized);
      assert.strictEqual(yield* countOf("fd_assistant_review_receipts"), 1);
      // The capture now stands for the brief as edited, with nothing left to report since.
      assert.deepStrictEqual((yield* review()).scopeChanges, []);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("captures, authorizes and queues exactly what was reviewed, under one receipt", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      const snapshot = yield* review();
      const started = yield* start(fakes, snapshot.reviewVersion);

      assert.strictEqual(started.outcome, "queued");
      assert.isFalse(started.replayed);
      assert.strictEqual(started.attempt, 1);
      assert.strictEqual(fakes.creates, 1);
      assert.strictEqual(fakes.items[0]?.title, "Add the export button");
      assert.isTrue((yield* briefNow).executionAuthorized);
      for (const table of [
        "fd_assistant_review_receipts",
        "fd_assistant_review_starts",
        "fd_assistant_assignments",
        "fd_assistant_factory_links",
        "fd_assistant_queue_positions",
      ]) {
        assert.strictEqual(yield* countOf(table), 1, table);
      }
      const sql = yield* SqlClient.SqlClient;
      const [receipt] = yield* sql<{
        readonly receipt_id: string;
        readonly review_version: number;
        readonly attempt: number;
      }>`SELECT receipt_id, review_version, attempt FROM fd_assistant_review_receipts`;
      assert.strictEqual(receipt?.receipt_id, started.receiptId);
      assert.strictEqual(receipt?.review_version, 1);
      assert.strictEqual(receipt?.attempt, 1);

      // The next pass claims it, under the review.
      yield* tick;
      assert.lengthOf(fakes.started, 1);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("fails its read when Factory cannot be asked, and starts nothing", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      fakes.previewFails = true;
      const refused = yield* Effect.flip(review());
      assert.strictEqual(refused._tag, "AssistantError");
      assert.deepStrictEqual(fakes.items, []);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("takes nothing on an old version, and an owner who may no longer write", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      const old = yield* review();
      yield* revise({ goal: "Add the import button" });
      const refused = yield* Effect.flip(start(fakes, old.reviewVersion));
      assert.include(refused.message, "nothing was authorized or started");
      assert.strictEqual(fakes.creates, 0);

      const current = yield* review();
      fakes.ownerScopes = [AuthWorkWriteScope];
      const revoked = yield* Effect.flip(start(fakes, current.reviewVersion));
      assert.include(revoked.message, "no longer");
      assert.strictEqual(fakes.creates, 0);
      yield* assertNothingStarted(fakes);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  /** A hold at one point of a start: entered once it gets there, and released by a test. */
  const holdAt = (fakes: Fakes, point: "write" | "capture_read" | "late_read") =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const go = yield* Deferred.make<void>();
      const hold = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(go)),
        Effect.asVoid,
      );
      switch (point) {
        case "write":
          fakes.afterWrite = hold;
          break;
        case "capture_read":
          fakes.onRead.push(hold);
          break;
        case "late_read":
          fakes.onRead.push(Effect.void, hold);
          break;
      }
      return { entered, go };
    });

  const editItem = (fakes: Fakes) =>
    Effect.sync(() => {
      const [item] = fakes.items;
      if (item === undefined) return assert.fail("No item was created.");
      item.title = "Someone renamed this in Work";
      item.revision += 1;
    });

  const setPreview =
    (bound: (values: FactoryReviewedExecution) => FactoryReviewedExecution) => (fakes: Fakes) =>
      Effect.sync(() => {
        fakes.preview = previewOf(bound(execution()));
      });

  const MUTATIONS: ReadonlyArray<{
    readonly name: string;
    readonly mutate: (
      fakes: Fakes,
    ) => Effect.Effect<unknown, Assistant.AssistantError, Assistant.ProjectAssistant>;
    /** Whether a fresh review can start, once the fixture has been put right. */
    readonly recover?: (fakes: Fakes) => Effect.Effect<void>;
    readonly edited?: true;
  }> = [
    { name: "the brief's goal", mutate: () => revise({ goal: "Add something else" }) },
    { name: "the brief's title", mutate: () => revise({ title: "Something else" }) },
    { name: "the brief's restrictions", mutate: () => revise({ constraints: [] }) },
    { name: "the captured item", mutate: editItem, edited: true },
    {
      name: "the Work source",
      mutate: (fakes) =>
        Effect.sync(() => {
          fakes.sources = [];
        }),
      recover: (fakes) =>
        Effect.sync(() => {
          fakes.sources = [tasks];
        }),
    },
    {
      name: "where the Work source writes",
      mutate: (fakes) =>
        Effect.sync(() => {
          fakes.sources = [retargeted];
        }),
    },
    {
      name: "the publication target",
      mutate: setPreview((values) => ({
        ...values,
        repository: {
          ...values.repository,
          publication: {
            ...values.repository.publication,
            repository: "github.com/someone/else",
          },
        },
      })),
    },
    {
      name: "a verify command",
      mutate: setPreview((values) => ({
        ...values,
        verifyCommand: { executable: "rm", args: ["-rf", "."] },
      })),
    },
    {
      name: "a role's model",
      mutate: setPreview((values) => ({
        ...values,
        roles: { ...values.roles, author: { instanceId, model: "unreviewed-model" } },
      })),
    },
    {
      name: "a prompt override's hash",
      mutate: setPreview((values) => ({
        ...values,
        promptOverrides: { ...values.promptOverrides, author: "b".repeat(64) },
      })),
    },
    {
      name: "the manager's archived thread",
      mutate: (fakes) =>
        Effect.sync(() => {
          fakes.manager = managerShell({ archivedAt: DateTime.makeUnsafe(at) });
        }),
      recover: (fakes) =>
        Effect.sync(() => {
          fakes.manager = managerShell();
        }),
    },
    {
      name: "the manager's narrower mode",
      mutate: (fakes) =>
        Effect.sync(() => {
          fakes.manager = managerShell({ runtimeMode: "approval-required" });
        }),
      // As Factory resolves it, within what the manager allows.
      recover: (fakes) =>
        Effect.sync(() => {
          fakes.preview = previewOf({ ...execution(), runtimeCeiling: "approval-required" });
        }),
    },
    {
      name: "the manager's plan mode",
      mutate: (fakes) =>
        Effect.sync(() => {
          fakes.manager = managerShell({ interactionMode: "plan" });
        }),
      recover: (fakes) =>
        Effect.sync(() => {
          fakes.manager = managerShell();
        }),
    },
    {
      name: "the owner's session",
      mutate: (fakes) =>
        Effect.sync(() => {
          fakes.ownerScopes = null;
        }),
      recover: (fakes) =>
        Effect.sync(() => {
          fakes.ownerScopes = FULL_GRANT;
        }),
    },
  ];

  const POINTS = [
    { point: "write", during: "the capture's write" },
    { point: "capture_read", during: "the capture's read-back" },
    { point: "late_read", during: "the start's own read-back" },
  ] as const;

  describe.each(POINTS)("held at $during", ({ point }) => {
    it.effect.each(MUTATIONS)(
      "records nothing once $name moved, and a retry stays refused",
      ({ mutate, recover, edited }) => {
        const fakes = makeFakes();
        return Effect.gen(function* () {
          yield* revise(agreed);
          const snapshot = yield* review();
          const { entered, go } = yield* holdAt(fakes, point);
          const running = yield* Effect.forkChild(
            Effect.exit(start(fakes, snapshot.reviewVersion)),
          );
          yield* Deferred.await(entered);
          yield* mutate(fakes);
          yield* Deferred.succeed(go, undefined);

          const exit = yield* Fiber.join(running);
          assert.isTrue(Exit.isFailure(exit));
          yield* assertNothingStarted(fakes);

          // The item stays for recovery, holding no authority, and nothing made a second one.
          assert.strictEqual(fakes.creates, 1);
          assert.lengthOf(fakes.items, 1);
          const capture = yield* Effect.flatMap(WorkCaptureStore.WorkCaptureStore, (store) =>
            store.get(alpha, ideaId),
          );
          assert.strictEqual(Option.getOrThrow(capture).state, "captured");

          // The same confirmation again finds what moved, and takes it no further.
          const retried = yield* Effect.flip(start(fakes, snapshot.reviewVersion));
          assert.match(retried.message, /nothing was authorized or started|review (it )?again/i);
          yield* assertNothingStarted(fakes);
          assert.strictEqual(fakes.creates, 1);

          if (edited === true) {
            const blocked = yield* review();
            assert.include(
              blocked.start.blockers.map(({ code }) => code),
              "item_edited",
            );
            return;
          }

          // Reviewed afresh, what stands now starts, once.
          if (recover !== undefined) yield* recover(fakes);
          const fresh = yield* review();
          assert.deepStrictEqual(fresh.start.blockers, []);
          const started = yield* start(fakes, fresh.reviewVersion, "request-2");
          assert.strictEqual(started.outcome, "queued");
          assert.strictEqual(yield* countOf("fd_assistant_review_receipts"), 1);
          assert.isTrue((yield* briefNow).executionAuthorized);
        }).pipe(Effect.provide(layerOf(fakes)));
      },
    );
  });

  it.effect("records nothing once a setting moved after the start's last read of a source", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      const snapshot = yield* review();
      const entered = yield* Deferred.make<void>();
      const go = yield* Deferred.make<void>();
      // Its first read at the start, then the one right after the capture, which this holds.
      fakes.onPreview.push(
        Effect.void,
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(go)),
          Effect.asVoid,
        ),
      );
      const running = yield* Effect.forkChild(Effect.exit(start(fakes, snapshot.reviewVersion)));
      yield* Deferred.await(entered);
      fakes.preview = previewOf({
        ...execution(),
        verifyCommand: { executable: "rm", args: ["-rf", "."] },
      });
      yield* Deferred.succeed(go, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(running)));
      yield* assertNothingStarted(fakes);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("records nothing once a setting moved during the final read before recording", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      const snapshot = yield* review();
      const entered = yield* Deferred.make<void>();
      const go = yield* Deferred.make<void>();
      // At the start, after the capture, and the last one under the lock, which this holds: what
      // it read still matches, and only the transaction can see what moved.
      fakes.onPreview.push(
        Effect.void,
        Effect.void,
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(go)),
          Effect.asVoid,
        ),
      );
      const running = yield* Effect.forkChild(Effect.exit(start(fakes, snapshot.reviewVersion)));
      yield* Deferred.await(entered);
      fakes.preview = previewOf({
        ...execution(),
        verifyCommand: { executable: "rm", args: ["-rf", "."] },
      });
      yield* Deferred.succeed(go, undefined);
      const exit = yield* Fiber.join(running);
      assert.isTrue(Exit.isFailure(exit));
      yield* assertNothingStarted(fakes);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("records nothing once the publication target moved after its last read of it", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      const snapshot = yield* review();
      const entered = yield* Deferred.make<void>();
      const go = yield* Deferred.make<void>();
      // Held in the read after the capture, so only the one under the lock can see what moved.
      fakes.onPreview.push(
        Effect.void,
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(go)),
          Effect.asVoid,
        ),
      );
      const running = yield* Effect.forkChild(Effect.exit(start(fakes, snapshot.reviewVersion)));
      yield* Deferred.await(entered);
      fakes.preview = previewOf(movedPublication());
      yield* Deferred.succeed(go, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(running)));
      yield* assertNothingStarted(fakes);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect(
    "records nothing once a model was dropped after the start's last read of a source",
    () => {
      const fakes = makeFakes();
      return Effect.gen(function* () {
        yield* revise(agreed);
        const snapshot = yield* review();
        const entered = yield* Deferred.make<void>();
        const go = yield* Deferred.make<void>();
        fakes.onPreview.push(
          Effect.void,
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(go)),
            Effect.asVoid,
          ),
        );
        const running = yield* Effect.forkChild(Effect.exit(start(fakes, snapshot.reviewVersion)));
        yield* Deferred.await(entered);
        // What it would bind reads the same, and its provider no longer offers that.
        const usable = previewOf(execution());
        fakes.preview = {
          ...usable,
          roles: { ...usable.roles, author: { ...usable.roles.author, offered: false } },
        };
        yield* Deferred.succeed(go, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.join(running)));
        yield* assertNothingStarted(fakes);
      }).pipe(Effect.provide(layerOf(fakes)));
    },
  );

  it.effect("records nothing once the project gained a repository during the final read", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      const snapshot = yield* review();
      const entered = yield* Deferred.make<void>();
      const go = yield* Deferred.make<void>();
      fakes.onPreview.push(
        Effect.void,
        Effect.void,
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(go)),
          Effect.asVoid,
        ),
      );
      const running = yield* Effect.forkChild(Effect.exit(start(fakes, snapshot.reviewVersion)));
      yield* Deferred.await(entered);
      fakes.repositories = ["/repositories/a", "/repositories/b"];
      yield* Deferred.succeed(go, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(running)));
      yield* assertNothingStarted(fakes);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("takes no version once its Work source was moved, before capturing anything", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      const reviewed = yield* review();
      fakes.sources = [retargeted];
      const refused = yield* Effect.flip(start(fakes, reviewed.reviewVersion));
      assert.include(refused.message, "nothing was authorized or started");
      assert.strictEqual(fakes.creates, 0);
      yield* assertNothingStarted(fakes);

      // The owner reads where it goes now, and it starts from that.
      const fresh = yield* review();
      assert.strictEqual(fresh.target.source?.identity, ".foredeck/elsewhere");
      assert.strictEqual((yield* start(fakes, fresh.reviewVersion)).outcome, "queued");
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("records nothing once the Work source was moved during the final read", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      const snapshot = yield* review();
      const entered = yield* Deferred.make<void>();
      const go = yield* Deferred.make<void>();
      fakes.onPreview.push(
        Effect.void,
        Effect.void,
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(go)),
          Effect.asVoid,
        ),
      );
      const running = yield* Effect.forkChild(Effect.exit(start(fakes, snapshot.reviewVersion)));
      yield* Deferred.await(entered);
      fakes.sources = [retargeted];
      yield* Deferred.succeed(go, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(running)));
      yield* assertNothingStarted(fakes);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect.each(LATE_EDITS)("records nothing once the item was $name", ({ hook, closes }) => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      const snapshot = yield* review();
      const entered = yield* Deferred.make<void>();
      const go = yield* Deferred.make<void>();
      const hold = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(go)),
        Effect.asVoid,
      );
      if (hook === "preview") fakes.onPreview.push(Effect.void, Effect.void, hold);
      // The capture's read-back, the read after it, then the last.
      else fakes.onRead.push(Effect.void, Effect.void, hold);
      const running = yield* Effect.forkChild(Effect.exit(start(fakes, snapshot.reviewVersion)));
      yield* Deferred.await(entered);
      yield* lateEdit(fakes, closes);
      yield* Deferred.succeed(go, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(running)));
      yield* assertNothingStarted(fakes);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect(
    "records nothing once the Work source went during the final read before recording",
    () => {
      const fakes = makeFakes();
      return Effect.gen(function* () {
        yield* revise(agreed);
        const snapshot = yield* review();
        const entered = yield* Deferred.make<void>();
        const go = yield* Deferred.make<void>();
        fakes.onPreview.push(
          Effect.void,
          Effect.void,
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(go)),
            Effect.asVoid,
          ),
        );
        const running = yield* Effect.forkChild(Effect.exit(start(fakes, snapshot.reviewVersion)));
        yield* Deferred.await(entered);
        fakes.sources = [];
        yield* Deferred.succeed(go, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.join(running)));
        yield* assertNothingStarted(fakes);
        // What was captured stays, for when the source is back.
        assert.lengthOf(fakes.items, 1);
      }).pipe(Effect.provide(layerOf(fakes)));
    },
  );

  it.effect(
    "takes no version of a scope that changed and came back before it was confirmed",
    () => {
      const fakes = makeFakes();
      return Effect.gen(function* () {
        yield* revise(agreed);
        const reviewed = yield* review();
        yield* revise({ goal: "Add something else" });
        yield* revise({ goal: agreed.goal! });
        const restored = yield* review();
        // It reads as it did, and it is not what was reviewed.
        assert.strictEqual(restored.goal, reviewed.goal);
        assert.notStrictEqual(restored.reviewVersion, reviewed.reviewVersion);
        const refused = yield* Effect.flip(start(fakes, reviewed.reviewVersion));
        assert.include(refused.message, "nothing was authorized or started");
        assert.strictEqual(fakes.creates, 0);
        yield* assertNothingStarted(fakes);

        // What it now says can be reviewed, and started.
        const started = yield* start(fakes, restored.reviewVersion);
        assert.strictEqual(started.outcome, "queued");
      }).pipe(Effect.provide(layerOf(fakes)));
    },
  );

  it.effect("keeps its version across an authorization of the scope it reviewed", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      const reviewed = yield* review();
      yield* revise({ executionAuthorized: true });
      yield* revise({ executionAuthorized: false });
      yield* revise({ conversationNotes: ["Still talking"] });
      const started = yield* start(fakes, reviewed.reviewVersion);
      assert.strictEqual(started.outcome, "queued");
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("records nothing once a goal moved and came back while its capture ran", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      const snapshot = yield* review();
      const { entered, go } = yield* holdAt(fakes, "late_read");
      const running = yield* Effect.forkChild(Effect.exit(start(fakes, snapshot.reviewVersion)));
      yield* Deferred.await(entered);
      yield* revise({ goal: "Add something else" });
      yield* revise({ goal: agreed.goal! });
      yield* Deferred.succeed(go, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(running)));
      yield* assertNothingStarted(fakes);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect(
    "records nothing once a brief moved during an update of an item already captured",
    () => {
      const fakes = makeFakes();
      return Effect.gen(function* () {
        yield* revise(agreed);
        // A start that went no further than its capture leaves the item, as the assistant's would.
        const first = yield* review();
        const firstHold = yield* holdAt(fakes, "write");
        const refused = yield* Effect.forkChild(Effect.exit(start(fakes, first.reviewVersion)));
        yield* Deferred.await(firstHold.entered);
        yield* revise({ decisions: [] });
        yield* Deferred.succeed(firstHold.go, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.join(refused)));
        assert.strictEqual(fakes.creates, 1);

        const second = yield* review();
        assert.strictEqual(second.title.origin, "stored");
        assert.deepStrictEqual(
          second.scopeChanges?.map(({ field }) => field),
          ["decisions"],
        );
        const hold = yield* holdAt(fakes, "write");
        const running = yield* Effect.forkChild(
          Effect.exit(start(fakes, second.reviewVersion, "request-2")),
        );
        yield* Deferred.await(hold.entered);
        yield* revise({ goal: "Add something else" });
        yield* Deferred.succeed(hold.go, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.join(running)));
        assert.strictEqual(fakes.updates, 1);
        assert.strictEqual(fakes.creates, 1);
        yield* assertNothingStarted(fakes);
      }).pipe(Effect.provide(layerOf(fakes)));
    },
  );
});

describe("a fresh review of a delivery at rest", () => {
  /** A reviewed attempt claimed, whose delivery then stopped or blocked. */
  const atRest = (fakes: Fakes, status: "stopped" | "blocked" = "blocked") =>
    Effect.gen(function* () {
      yield* revise(agreed);
      const first = yield* review();
      const started = yield* start(fakes, first.reviewVersion);
      yield* tick;
      const root = fakes.started[0] ?? assert.fail("The attempt was not claimed.");
      fakes.deliveries.set(root, status);
      yield* tick;
      fakes.preview = previewOf({
        ...execution(),
        limits: { ...execution().limits, maxFixRounds: 5 },
      });
      const snapshot = yield* review();
      assert.strictEqual(snapshot.start.mode, "amend");
      return { root, started, snapshot };
    });

  const amendmentRows = Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly receipt_id: string }>`SELECT receipt_id FROM fd_assistant_review_starts
      WHERE kind = 'amendment'`,
  );

  const held = () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const go = yield* Deferred.make<void>();
      const hold = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(go)),
        Effect.asVoid,
      );
      return { entered, go, hold };
    });

  it.effect.each([
    { name: "its first read", holds: (hold: Effect.Effect<void>) => [hold] },
    {
      name: "its final read before recording",
      holds: (hold: Effect.Effect<void>) => [Effect.void, hold],
    },
  ])("records nothing once a setting moved during $name", ({ holds }) => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      const { snapshot, started } = yield* atRest(fakes);
      const { entered, go, hold } = yield* held();
      fakes.onPreview.push(...holds(hold));
      const running = yield* Effect.forkChild(
        Effect.exit(start(fakes, snapshot.reviewVersion, "request-2")),
      );
      yield* Deferred.await(entered);
      fakes.preview = previewOf({
        ...execution(),
        verifyCommand: { executable: "rm", args: ["-rf", "."] },
      });
      yield* Deferred.succeed(go, undefined);

      const exit = yield* Fiber.join(running);
      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(yield* amendmentRows, []);
      assert.deepStrictEqual(fakes.rebinds, []);
      assert.deepStrictEqual(fakes.resumes, []);
      assert.strictEqual(yield* countOf("fd_assistant_review_receipts"), 1);
      assert.strictEqual(started.attempt, 1);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("records nothing once the publication target moved during its first read", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      const { snapshot } = yield* atRest(fakes);
      const { entered, go, hold } = yield* held();
      fakes.onPreview.push(hold);
      const running = yield* Effect.forkChild(
        Effect.exit(start(fakes, snapshot.reviewVersion, "request-2")),
      );
      yield* Deferred.await(entered);
      fakes.preview = previewOf({
        ...movedPublication(),
        limits: { ...execution().limits, maxFixRounds: 5 },
      });
      yield* Deferred.succeed(go, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(running)));
      assert.deepStrictEqual(yield* amendmentRows, []);
      assert.deepStrictEqual(fakes.rebinds, []);
      assert.deepStrictEqual(fakes.resumes, []);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect.each(LATE_EDITS)("records nothing once the item was $name", ({ hook, closes }) => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      const { snapshot } = yield* atRest(fakes);
      const authorizedBefore = (yield* briefNow).revision;
      const { entered, go, hold } = yield* held();
      if (hook === "preview") fakes.onPreview.push(Effect.void, hold);
      // Its first read, then the last.
      else fakes.onRead.push(Effect.void, hold);
      const running = yield* Effect.forkChild(
        Effect.exit(start(fakes, snapshot.reviewVersion, "request-2")),
      );
      yield* Deferred.await(entered);
      yield* lateEdit(fakes, closes);
      yield* Deferred.succeed(go, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(running)));
      assert.deepStrictEqual(yield* amendmentRows, []);
      assert.deepStrictEqual(fakes.rebinds, []);
      assert.deepStrictEqual(fakes.resumes, []);
      assert.strictEqual(yield* countOf("fd_assistant_review_receipts"), 1);
      assert.strictEqual((yield* briefNow).revision, authorizedBefore);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("records nothing once the Work source was moved during its final read", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      const { snapshot } = yield* atRest(fakes);
      const { entered, go, hold } = yield* held();
      fakes.onPreview.push(Effect.void, hold);
      const running = yield* Effect.forkChild(
        Effect.exit(start(fakes, snapshot.reviewVersion, "request-2")),
      );
      yield* Deferred.await(entered);
      fakes.sources = [retargeted];
      yield* Deferred.succeed(go, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(running)));
      assert.deepStrictEqual(yield* amendmentRows, []);
      assert.deepStrictEqual(fakes.rebinds, []);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect(
    "takes no resume someone else took while it read Work, after they stopped it again",
    () => {
      const fakes = makeFakes();
      return Effect.gen(function* () {
        const { root, snapshot } = yield* atRest(fakes);
        const { entered, go, hold } = yield* held();
        // Its first read, its last read, then the one its resume makes after seeing the obligation.
        fakes.onRead.push(Effect.void, Effect.void, hold);
        const running = yield* Effect.forkChild(start(fakes, snapshot.reviewVersion, "request-2"));
        yield* Deferred.await(entered);
        assert.isDefined(fakes.owed);
        // The owner resumes it directly, which takes the obligation, and it stops again.
        fakes.owed = undefined;
        fakes.effects += 1;
        fakes.deliveries.set(root, "stopped");
        yield* Deferred.succeed(go, undefined);

        const amended = yield* Fiber.join(running);
        assert.strictEqual(amended.outcome, "amended");
        assert.deepStrictEqual(fakes.resumes, []);
        assert.strictEqual(fakes.deliveries.get(root), "stopped");
      }).pipe(Effect.provide(layerOf(fakes)));
    },
  );

  it.effect("records nothing once the Work source went during its final read", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      const { snapshot } = yield* atRest(fakes);
      const { entered, go, hold } = yield* held();
      fakes.onPreview.push(Effect.void, hold);
      const running = yield* Effect.forkChild(
        Effect.exit(start(fakes, snapshot.reviewVersion, "request-2")),
      );
      yield* Deferred.await(entered);
      fakes.sources = [];
      yield* Deferred.succeed(go, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(running)));
      assert.deepStrictEqual(yield* amendmentRows, []);
      assert.deepStrictEqual(fakes.rebinds, []);
      assert.deepStrictEqual(fakes.resumes, []);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("records nothing once its delivery ran on during its final read", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      const { root, snapshot } = yield* atRest(fakes);
      const { entered, go, hold } = yield* held();
      fakes.onPreview.push(Effect.void, hold);
      const running = yield* Effect.forkChild(
        Effect.exit(start(fakes, snapshot.reviewVersion, "request-2")),
      );
      yield* Deferred.await(entered);
      // Resumed by hand and stopped again: it reads the same, and is not what was reviewed.
      fakes.effects += 1;
      fakes.deliveries.set(root, "blocked");
      yield* Deferred.succeed(go, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(running)));
      assert.deepStrictEqual(yield* amendmentRows, []);
      assert.deepStrictEqual(fakes.rebinds, []);
      assert.deepStrictEqual(fakes.resumes, []);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("takes nothing late from a repeat once its delivery ran on by hand", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      const { root, snapshot } = yield* atRest(fakes);
      fakes.failRebind = true;
      yield* Effect.flip(start(fakes, snapshot.reviewVersion, "request-2"));
      assert.lengthOf(yield* amendmentRows, 1);

      // The owner resumes it themselves, and it comes to rest again.
      fakes.deliveries.set(root, "running");
      fakes.effects += 1;
      fakes.deliveries.set(root, "stopped");

      const refused = yield* Effect.flip(start(fakes, snapshot.reviewVersion, "request-2"));
      assert.include(refused.message, "moved on");
      assert.deepStrictEqual(fakes.rebinds, []);
      assert.deepStrictEqual(fakes.resumes, []);
      assert.strictEqual(fakes.deliveries.get(root), "stopped");
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("resumes only the delivery its confirmation named", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      const { root, snapshot } = yield* atRest(fakes);
      fakes.failResume = true;
      yield* Effect.flip(start(fakes, snapshot.reviewVersion, "request-2"));
      assert.lengthOf(fakes.rebinds, 1);

      // The family moved on, so a resume of it now would pick another delivery.
      const child = "child-delivery";
      fakes.deliveries.set(root, "running");
      fakes.deliveries.set(child, "blocked");
      fakes.waitingOn = child;
      const refused = yield* Effect.flip(start(fakes, snapshot.reviewVersion, "request-2"));
      assert.include(refused.message, "moved on");
      assert.deepStrictEqual(fakes.resumes, []);
      assert.strictEqual(fakes.deliveries.get(child), "blocked");
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("finishes nothing for a session that no longer has the grants", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      const { snapshot } = yield* atRest(fakes);
      fakes.failRebind = true;
      yield* Effect.flip(start(fakes, snapshot.reviewVersion, "request-2"));
      fakes.ownerScopes = [AuthWorkWriteScope];
      const refused = yield* Effect.flip(start(fakes, snapshot.reviewVersion, "request-2"));
      assert.include(refused.message, "no longer");
      assert.deepStrictEqual(fakes.rebinds, []);
      assert.deepStrictEqual(fakes.resumes, []);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("resumes once, and a repeat after a later stop or block resumes nothing", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      const { root, snapshot } = yield* atRest(fakes);
      const amended = yield* start(fakes, snapshot.reviewVersion, "request-2");
      assert.strictEqual(amended.outcome, "amended");
      assert.isFalse(amended.replayed);
      assert.deepStrictEqual(fakes.rebinds, [amended.receiptId]);
      assert.deepStrictEqual(fakes.resumes, [root]);

      for (const status of ["stopped", "blocked"] as const) {
        fakes.deliveries.set(root, status);
        const replayed = yield* start(fakes, snapshot.reviewVersion, "request-2");
        assert.deepStrictEqual(replayed, { ...amended, replayed: true });
        assert.deepStrictEqual(fakes.resumes, [root]);
        assert.strictEqual(fakes.deliveries.get(root), status);
      }
      assert.deepStrictEqual(fakes.rebinds, [amended.receiptId]);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("finishes a rebind a failure cut short, resuming once", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      const { root, snapshot } = yield* atRest(fakes);
      fakes.failRebind = true;
      yield* Effect.flip(start(fakes, snapshot.reviewVersion, "request-2"));
      assert.lengthOf(yield* amendmentRows, 1);
      assert.deepStrictEqual(fakes.rebinds, []);
      assert.deepStrictEqual(fakes.resumes, []);

      const replayed = yield* start(fakes, snapshot.reviewVersion, "request-2");
      assert.isTrue(replayed.replayed);
      assert.deepStrictEqual(fakes.rebinds, [replayed.receiptId]);
      assert.deepStrictEqual(fakes.resumes, [root]);

      fakes.deliveries.set(root, "stopped");
      yield* start(fakes, snapshot.reviewVersion, "request-2");
      assert.deepStrictEqual(fakes.resumes, [root]);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("finishes a resume a failure cut short, once", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      const { root, snapshot } = yield* atRest(fakes);
      fakes.failResume = true;
      yield* Effect.flip(start(fakes, snapshot.reviewVersion, "request-2"));
      assert.lengthOf(fakes.rebinds, 1);
      assert.deepStrictEqual(fakes.resumes, []);
      assert.strictEqual(fakes.deliveries.get(root), "blocked");

      yield* start(fakes, snapshot.reviewVersion, "request-2");
      assert.deepStrictEqual(fakes.resumes, [root]);
      fakes.deliveries.set(root, "blocked");
      yield* start(fakes, snapshot.reviewVersion, "request-2");
      assert.deepStrictEqual(fakes.resumes, [root]);
      assert.lengthOf(fakes.rebinds, 1);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("takes no version of a scope that changed and came back while it rested", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      const { snapshot } = yield* atRest(fakes);
      yield* revise({ goal: "Add something else" });
      yield* revise({ goal: agreed.goal! });
      const refused = yield* Effect.flip(start(fakes, snapshot.reviewVersion, "request-2"));
      assert.include(refused.message, "nothing was authorized or started");
      assert.deepStrictEqual(fakes.rebinds, []);
      assert.deepStrictEqual(fakes.resumes, []);
    }).pipe(Effect.provide(layerOf(fakes)));
  });
});

describe("a review of an attempt under way", () => {
  /** An attempt of `kind` claimed, whose delivery then blocked. */
  const blockedAs = (fakes: Fakes, kind: AssistantReviewKind) =>
    Effect.gen(function* () {
      yield* revise(agreed);
      const first = yield* review(kind);
      yield* start(fakes, first.reviewVersion, "request-1", kind);
      yield* tick;
      fakes.deliveries.set(fakes.started[0] ?? assert.fail("Not claimed."), "blocked");
      yield* tick;
      fakes.preview = previewOf({
        ...execution(),
        limits: { ...execution().limits, maxFixRounds: 5 },
      });
    });

  const amendments = Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`SELECT receipt_id FROM fd_assistant_review_starts WHERE kind = 'amendment'`,
  );

  it.effect.each([
    { kind: "parent", asked: "single" },
    { kind: "single", asked: "parent" },
  ] as const)("describes the $kind it would carry on, when asked for $asked", ({ kind, asked }) => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* blockedAs(fakes, kind);
      const snapshot = yield* review(asked);
      assert.strictEqual(snapshot.target.kind, kind);
      assert.isTrue(snapshot.target.kindFixed);
      assert.strictEqual(snapshot.start.mode, "amend");
      // Asked either way, it is one review of one delivery.
      assert.strictEqual((yield* review(kind)).reviewVersion, snapshot.reviewVersion);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect.each([
    { kind: "parent", asked: "single" },
    { kind: "single", asked: "parent" },
  ] as const)("refuses a $asked confirmation of a $kind before recording it", ({ kind, asked }) => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* blockedAs(fakes, kind);
      const snapshot = yield* review(asked);
      const refused = yield* Effect.flip(start(fakes, snapshot.reviewVersion, "request-2", asked));
      assert.include(refused.message, "runs as it started");
      assert.deepStrictEqual(yield* amendments, []);
      assert.deepStrictEqual(fakes.rebinds, []);
      assert.deepStrictEqual(fakes.resumes, []);

      // Confirmed as what it is, it goes on.
      const amended = yield* start(fakes, snapshot.reviewVersion, "request-3", kind);
      assert.strictEqual(amended.outcome, "amended");
      assert.lengthOf(fakes.resumes, 1);
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("judges a parent's planner, even when asked to review it as a single item", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* blockedAs(fakes, "parent");
      const usable = fakes.preview;
      fakes.preview = {
        ...usable,
        roles: {
          ...usable.roles,
          planner: {
            ...usable.roles.planner,
            options: [{ id: "tier", value: "priority", supported: false }],
          },
        },
      };
      const snapshot = yield* review("single");
      assert.strictEqual(snapshot.start.mode, "none");
      assert.include(
        snapshot.start.blockers.map(({ code }) => code),
        "option_unsupported",
      );
    }).pipe(Effect.provide(layerOf(fakes)));
  });

  it.effect("leaves the choice open while no attempt is under way", () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      yield* revise(agreed);
      const single = yield* review("single");
      const parent = yield* review("parent");
      assert.isFalse(single.target.kindFixed);
      assert.isFalse(parent.target.kindFixed);
      assert.strictEqual(parent.target.kind, "parent");
      assert.notStrictEqual(single.reviewVersion, parent.reviewVersion);
    }).pipe(Effect.provide(layerOf(fakes)));
  });
});
