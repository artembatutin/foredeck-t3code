import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  ProjectId,
  RpcScopeAuthorization,
  RunId,
  ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";
import {
  FACTORY_WS_METHODS,
  FactoryDeliveryId,
  FactoryError,
  FactoryPlan,
  type FactoryPlanTask,
  FactoryRpcs,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Rpc from "effect/rpc/Rpc";
import type * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcServer from "effect/rpc/RpcServer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as RpcAuthorization from "../../../auth/RpcAuthorization.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ServerRuntimeStartup from "../../../serverRuntimeStartup.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import { WorkService } from "../../work-management/index.ts";
import * as FactoryChildren from "../FactoryChildren.ts";
import * as FactoryPlanning from "../FactoryPlanning.ts";
import * as FactoryPullRequest from "../FactoryPullRequest.ts";
import * as FactoryRecord from "../FactoryRecord.ts";
import * as FactoryReview from "../FactoryReview.ts";
import * as FactoryService from "../FactoryService.ts";
import * as FactorySettings from "../FactorySettings.ts";
import * as FactoryThreadEffects from "../FactoryThreadEffects.ts";
import * as FactoryWorkComments from "../FactoryWorkComments.ts";
import * as FactoryWorker from "../FactoryWorker.ts";
import * as Factory from "../index.ts";
import { FactoryStoreError } from "../persistence/errors.ts";
import * as FactoryDeliveryStore from "../persistence/FactoryDeliveryStore.ts";
import { advance } from "../pipeline/engine.ts";
import { type FactoryEvent, queuedDeliveryState } from "../pipeline/state.ts";
import * as FactoryVerifyRunner from "../verify/FactoryVerifyRunner.ts";
import { wsHandlers } from "./handlers.ts";

const projectId = ProjectId.make("project-alpha");
const itemRef = (itemId: string) => ({
  sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
  itemId: WorkItemId.make(itemId),
});
const planner = ThreadId.make("thread-planner");
const planRun = RunId.make("run-plan");
const replanRun = RunId.make("run-replan");

/** Runs every command at once, as a server past its startup does. */
const readyStartup = ServerRuntimeStartup.ServerRuntimeStartup.of({
  awaitCommandReady: Effect.void,
  markHttpListening: Effect.void,
  enqueueCommand: (effect) => effect,
});

const plan = Schema.decodeUnknownSync(FactoryPlan)({
  tasks: ["export-csv", "export-header"].map((id) => ({
    id,
    title: `Task ${id}`,
    kind: "feature",
    summary: `Build ${id}.`,
    acceptance: [`${id} works.`],
    testPlan: [{ criterion: 1, check: `${id} is tested.`, paths: [`src/${id}.test.ts`] }],
    likelyPaths: [`src/${id}.ts`],
    risk: "normal",
  })),
});
const [first, second] = plan.tasks as readonly [FactoryPlanTask, FactoryPlanTask];

const encodeError = Schema.encodeSync(FactoryError);
const isFactoryError = Schema.is(FactoryError);

/** The error as the RPC sends it, after checking it is the wire error at all. */
const onTheWire = (error: unknown) => {
  expect(isFactoryError(error)).toBe(true);
  return encodeError(error as FactoryError);
};

/** The fixed texts of the plan gate's invalid requests. */
const editMessage =
  "Factory refused the edited plan. An edited plan follows the planner's rules: nonblank text within its bounds, and a test plan entry for every criterion. An edit can change task titles, summaries, acceptance criteria and test plans, reorder tasks and remove some; it cannot add tasks, empty the plan, or change task ids, kinds, likely paths, risk or the planner's note.";
const noteMessage = "Write a note of at most 8000 characters telling the planner what to change.";

describe("Factory plan RPC errors", () => {
  const deliveryId = FactoryDeliveryId.make("delivery-1");
  const unexpected = Effect.die("not called in this test");
  type PlanActions = Partial<
    Pick<FactoryService.FactoryService["Service"], "updatePlan" | "rejectPlan" | "replan">
  >;
  const handlersOver = (actions: PlanActions) =>
    wsHandlers({
      factory: FactoryService.FactoryService.of({
        start: () => unexpected,
        get: () => unexpected,
        list: () => unexpected,
        listByItem: () => unexpected,
        stop: () => unexpected,
        resume: () => unexpected,
        cancel: () => unexpected,
        updatePlan: () => unexpected,
        approvePlan: () => unexpected,
        rejectPlan: () => unexpected,
        replan: () => unexpected,
        submitPlan: () => unexpected,
        submitReview: () => unexpected,
        subscribe: Stream.die("not called in this test"),
        ...actions,
      }),
      settings: FactorySettings.FactorySettings.of({
        get: () => unexpected,
        set: () => unexpected,
        requireDeliverySettings: () => unexpected,
      }),
      startup: readyStartup,
    });
  type Handlers = ReturnType<typeof handlersOver>;
  const calls: Readonly<
    Record<keyof PlanActions, (handlers: Handlers) => Effect.Effect<object, FactoryError>>
  > = {
    updatePlan: (handlers) => handlers[FACTORY_WS_METHODS.factoryPlanUpdate]({ deliveryId, plan }),
    rejectPlan: (handlers) => handlers[FACTORY_WS_METHODS.factoryPlanReject]({ deliveryId }),
    replan: (handlers) =>
      handlers[FACTORY_WS_METHODS.factoryPlanReplan]({ deliveryId, note: "Split." }),
  };
  const failing =
    <E>(error: E) =>
    () =>
      Effect.fail(error);
  /** Every plan action failing with `error`. */
  const allFailing = <
    E extends
      | FactoryService.FactoryDeliveryNotFoundError
      | FactoryStoreError
      | FactoryService.FactoryPlanGateRefusedError,
  >(
    error: E,
  ): PlanActions => ({
    updatePlan: failing(error),
    rejectPlan: failing(error),
    replan: failing(error),
  });
  const secret = "SECRET task text and /home/owner/.t3/userdata";

  it.effect.each([
    {
      name: "a delivery not waiting at the gate",
      actions: allFailing(
        new FactoryService.FactoryPlanGateRefusedError({ deliveryId, status: "running" }),
      ),
      wire: {
        _tag: "FactoryError",
        reason: "refused",
        message:
          "Only a delivery waiting at the plan gate can have its plan approved, edited, rejected or replanned; this one is running.",
        deliveryId,
      },
    },
    {
      name: "an edit the gate refuses",
      actions: {
        updatePlan: failing(
          new FactoryService.FactoryPlanEditInvalidError({
            deliveryId,
            problems: [secret],
            fields: [],
          }),
        ),
      },
      wire: {
        _tag: "FactoryError",
        reason: "invalid_request",
        message: editMessage,
        deliveryId,
      },
    },
    {
      name: "a blank or overlong replan note",
      actions: {
        replan: failing(new FactoryService.FactoryReplanNoteInvalidError({ deliveryId })),
      },
      wire: {
        _tag: "FactoryError",
        reason: "invalid_request",
        message: noteMessage,
        deliveryId,
      },
    },
    {
      name: "an unknown delivery",
      actions: allFailing(new FactoryService.FactoryDeliveryNotFoundError({ deliveryId })),
      wire: {
        _tag: "FactoryError",
        reason: "not_found",
        message: "This Factory delivery does not exist.",
        deliveryId,
      },
    },
    {
      name: "a storage failure",
      actions: allFailing(
        new FactoryStoreError({ operation: "worker.step", cause: new Error(secret) }),
      ),
      wire: {
        _tag: "FactoryError",
        reason: "unavailable",
        message: "Factory could not read or save its records. Try again.",
      },
    },
  ] satisfies ReadonlyArray<{
    readonly name: string;
    readonly actions: PlanActions;
    readonly wire: ReturnType<typeof encodeError>;
  }>)("maps $name to its fixed text", ({ actions, wire }) =>
    Effect.gen(function* () {
      const handlers = handlersOver(actions);
      const raised = Object.keys(actions) as ReadonlyArray<keyof PlanActions>;
      expect(raised.length).toBeGreaterThan(0);
      for (const action of raised) {
        const sent = onTheWire(yield* Effect.flip(calls[action](handlers)));
        expect(sent).toStrictEqual(wire);
        expect(JSON.stringify(sent)).not.toContain("SECRET");
      }
    }),
  );
});

/** What the scripted planner thread was asked to do. */
interface PlannerCalls {
  readonly replans: Array<{ readonly threadId: ThreadId; readonly note: string }>;
  readonly interrupted: Array<ThreadId>;
}

/**
 * The planner thread: a replan turn is recorded and starts its run once `release` completes, so
 * the step that issued it is the only write until then. Nothing else is sent here.
 */
const plannerThreads = (calls: PlannerCalls, release: Deferred.Deferred<void>) =>
  Layer.succeed(
    FactoryThreadEffects.FactoryThreadEffects,
    FactoryThreadEffects.FactoryThreadEffects.of({
      launchThread: () => Effect.die("launch not scripted"),
      sendFixCommitTurn: () => Effect.die("fix-commit turn not scripted"),
      sendPlanRetryTurn: () => Effect.die("plan retry turn not scripted"),
      sendReplanTurn: (_delivery, { threadId, note }) =>
        Effect.sync(() => calls.replans.push({ threadId, note })).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({ runId: replanRun }),
        ),
      sendReviewRetryTurn: () => Effect.die("review retry turn not scripted"),
      sendRepairTurn: () => Effect.die("repair turn not scripted"),
      sendReviewFollowUpTurn: () => Effect.die("review follow-up turn not scripted"),
      launchState: () => Effect.die("launch read not scripted"),
      threadState: () => Effect.die("thread read not scripted"),
      liveRun: () => Effect.die("live run read not scripted"),
      carriesFactoryTurn: () => Effect.die("factory turn read not scripted"),
      liveRunsOn: () => Effect.die("live runs read not scripted"),
      launchedLiveRuns: Effect.die("live runs read not scripted"),
      // Every run is still going; its end arrives as a step.
      runEnded: () => Effect.succeedNone,
      interruptRun: (_delivery, { threadId }) =>
        Effect.sync(() => calls.interrupted.push(threadId)),
    }),
  );

/** The real service and worker on in-memory SQLite; only the planner thread is scripted. */
const makeLayer = (calls: PlannerCalls, release: Deferred.Deferred<void>) =>
  FactoryService.layer.pipe(
    Layer.provideMerge(FactoryWorker.layer),
    Layer.provide(Layer.mock(FactoryWorkComments.FactoryWorkComments)({ post: () => Effect.void })),
    Layer.provide(plannerThreads(calls, release)),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(FactoryChildren.FactoryChildren)({}),
        Layer.mock(FactoryPlanning.FactoryPlanning)({}),
        Layer.mock(FactoryReview.FactoryReview)({}),
        Layer.mock(FactoryRecord.FactoryRecord)({}),
        Layer.mock(FactoryPullRequest.FactoryPullRequest)({}),
        Layer.mock(FactoryVerifyRunner.FactoryVerifyRunner)({}),
        Layer.mock(ProjectStore.ProjectStoreV2)({}),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(WorkService.WorkService)({}),
      ),
    ),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-plan-rpc-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

/** A parent waiting at the plan gate on `plan`, as its planner's run left it. */
const seedAtGate = (deliveryId: FactoryDeliveryId, itemId: string) =>
  Effect.gen(function* () {
    const events: ReadonlyArray<FactoryEvent> = [
      { type: "start" },
      {
        type: "thread.launched",
        effectId: 1,
        threadId: planner,
        runId: planRun,
        worktreePath: `/worktrees/${itemId}`,
        baseline: "b".repeat(40),
      },
      {
        type: "plan.submitted",
        round: 1,
        threadId: planner,
        runId: planRun,
        judgment: {
          type: "accepted",
          plan: { ...plan, source: "mcp", evidencePath: "/t3/userdata/fd-factory/plan.json" },
        },
      },
      { type: "run.finished", threadId: planner, runId: planRun, status: "completed" },
    ];
    const state = events.reduce(
      (current, event) => advance(current, event).delivery,
      queuedDeliveryState({ kind: "parent", branch: `work/${itemId}`, baseRef: "HEAD" }),
    );
    expect(state.status).toBe("waiting");
    yield* Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
      deliveries.insert({ deliveryId, projectId, itemRef: itemRef(itemId), state }),
    );
  });

describe("Factory plan RPC handlers over the real service", () => {
  it.effect("move the change epoch once per accepted action and never on a refusal", () => {
    const calls: PlannerCalls = { replans: [], interrupted: [] };
    return Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      return yield* Effect.gen(function* () {
        const factory = yield* FactoryService.FactoryService;
        const settings = yield* FactorySettings.FactorySettings;
        const worker = yield* FactoryWorker.FactoryWorker;
        const rpc = wsHandlers({ factory, settings, startup: readyStartup });
        const epoch = factory.subscribe.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
        /** Runs a refused call: its wire reason, with the epoch where it was. */
        const refusedWith = (call: Effect.Effect<object, FactoryError>) =>
          Effect.gen(function* () {
            const before = yield* epoch;
            const error = onTheWire(yield* Effect.flip(call));
            expect(yield* epoch).toBe(before);
            return error.reason;
          });

        const edited = FactoryDeliveryId.make("delivery-edited");
        const rejected = FactoryDeliveryId.make("delivery-rejected");
        yield* seedAtGate(edited, "fd-aaaaaa");
        yield* seedAtGate(rejected, "fd-bbbbbb");
        const start = yield* epoch;

        // An edit: stored, the epoch moves once, and the snapshot shows it.
        const update = yield* rpc[FACTORY_WS_METHODS.factoryPlanUpdate]({
          deliveryId: edited,
          plan: { tasks: [second, { ...first, title: "Export as CSV" }] },
        });
        expect(update.plan?.tasks.map(({ id, title }) => [id, title])).toEqual([
          ["export-header", "Task export-header"],
          ["export-csv", "Export as CSV"],
        ]);
        expect(yield* epoch).toBe(start + 1);
        expect(
          yield* refusedWith(
            rpc[FACTORY_WS_METHODS.factoryPlanUpdate]({
              deliveryId: edited,
              plan: { tasks: [{ ...first, risk: "high" }] },
            }),
          ),
        ).toBe("invalid_request");

        // A replan: the epoch moves once for the action, before the planner's turn starts.
        const replan = yield* rpc[FACTORY_WS_METHODS.factoryPlanReplan]({
          deliveryId: edited,
          note: "Split the header task.",
        });
        expect(replan.status).toBe("running");
        expect(replan.stage).toEqual({ name: "plan", kind: "agent" });
        expect(yield* epoch).toBe(start + 2);
        for (const call of [
          rpc[FACTORY_WS_METHODS.factoryPlanReplan]({ deliveryId: edited, note: "Again." }),
          rpc[FACTORY_WS_METHODS.factoryPlanReject]({ deliveryId: edited }),
          rpc[FACTORY_WS_METHODS.factoryPlanUpdate]({ deliveryId: edited, plan }),
        ]) {
          expect(yield* refusedWith(call)).toBe("refused");
        }
        // The turn's start is a step of its own.
        yield* Deferred.succeed(release, undefined);
        yield* worker.drain;
        expect(calls.replans).toEqual([{ threadId: planner, note: "Split the header task." }]);
        expect(yield* epoch).toBe(start + 3);
        const replanning = yield* rpc[FACTORY_WS_METHODS.factoryDeliveriesGet]({
          deliveryId: edited,
        });
        expect(replanning.status).toBe("running");
        expect(replanning.plan).toBeUndefined();

        // A rejection: cancelled, the epoch moves once, and nothing more is accepted.
        const reject = yield* rpc[FACTORY_WS_METHODS.factoryPlanReject]({ deliveryId: rejected });
        expect(reject.status).toBe("cancelled");
        expect(yield* epoch).toBe(start + 4);
        expect(
          yield* refusedWith(rpc[FACTORY_WS_METHODS.factoryPlanReject]({ deliveryId: rejected })),
        ).toBe("refused");
        expect(
          yield* refusedWith(
            rpc[FACTORY_WS_METHODS.factoryPlanReject]({
              deliveryId: FactoryDeliveryId.make("delivery-missing"),
            }),
          ),
        ).toBe("not_found");
        yield* worker.drain;
        expect(yield* epoch).toBe(start + 4);
      }).pipe(Effect.provide(makeLayer(calls, release)));
    }).pipe(Effect.scoped);
  });
});

describe("Factory plan RPC authorization", () => {
  const planTags = new Set<string>([
    FACTORY_WS_METHODS.factoryPlanUpdate,
    FACTORY_WS_METHODS.factoryPlanReject,
    FACTORY_WS_METHODS.factoryPlanReplan,
  ]);
  type WsTag = RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"];
  type PlanTag =
    | typeof FACTORY_WS_METHODS.factoryPlanUpdate
    | typeof FACTORY_WS_METHODS.factoryPlanReject
    | typeof FACTORY_WS_METHODS.factoryPlanReplan;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<WsTag, PlanTag> => !planTags.has(tag),
    ),
  );
  type PlanClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof group>>;
  const deliveryId = FactoryDeliveryId.make("delivery-1");

  /** The core group's plan methods, served by the real handlers, as a session with `scopes`. */
  const callAs = (
    scopes: ReadonlyArray<AuthEnvironmentScope>,
    call: (client: PlanClient) => Effect.Effect<object, { readonly _tag: string }>,
  ) =>
    Effect.gen(function* () {
      const reached: Array<string> = [];
      const notFound = (method: string) =>
        Effect.sync(() => reached.push(method)).pipe(
          Effect.andThen(
            Effect.fail(new FactoryService.FactoryDeliveryNotFoundError({ deliveryId })),
          ),
        );
      const unexpected = Effect.die("not called in this test");
      const handlers = wsHandlers({
        factory: FactoryService.FactoryService.of({
          start: () => unexpected,
          get: () => unexpected,
          list: () => unexpected,
          listByItem: () => unexpected,
          stop: () => unexpected,
          resume: () => unexpected,
          cancel: () => unexpected,
          updatePlan: () => notFound("update"),
          approvePlan: () => unexpected,
          rejectPlan: () => notFound("reject"),
          replan: () => notFound("replan"),
          submitPlan: () => unexpected,
          submitReview: () => unexpected,
          subscribe: Stream.die("not called in this test"),
        }),
        settings: FactorySettings.FactorySettings.of({
          get: () => unexpected,
          set: () => unexpected,
          requireDeliverySettings: () => unexpected,
        }),
        startup: readyStartup,
      });
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayer(
              group.of({
                [FACTORY_WS_METHODS.factoryPlanUpdate]:
                  handlers[FACTORY_WS_METHODS.factoryPlanUpdate],
                [FACTORY_WS_METHODS.factoryPlanReject]:
                  handlers[FACTORY_WS_METHODS.factoryPlanReject],
                [FACTORY_WS_METHODS.factoryPlanReplan]:
                  handlers[FACTORY_WS_METHODS.factoryPlanReplan],
              }),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );
      const failure = yield* Effect.flip(call(client));
      return { failure, reached };
    }).pipe(Effect.scoped);

  const everyScope = AuthEnvironmentScope.literals;
  const withoutOperate = everyScope.filter((scope) => scope !== AuthOrchestrationOperateScope);

  it.effect.each([
    {
      method: "update",
      call: (client: PlanClient) =>
        client[FACTORY_WS_METHODS.factoryPlanUpdate]({ deliveryId, plan }),
    },
    {
      method: "reject",
      call: (client: PlanClient) => client[FACTORY_WS_METHODS.factoryPlanReject]({ deliveryId }),
    },
    {
      method: "replan",
      call: (client: PlanClient) =>
        client[FACTORY_WS_METHODS.factoryPlanReplan]({ deliveryId, note: "Split it." }),
    },
  ])(
    "refuses plan $method without orchestration:operate before its handler runs",
    ({ method, call }) =>
      Effect.gen(function* () {
        const refused = yield* callAs(withoutOperate, call);
        expect(refused.failure).toMatchObject({
          requiredPermission: AuthOrchestrationOperateScope,
        });
        expect(refused.reached).toEqual([]);

        // With the grant, the call reaches the service.
        const granted = yield* callAs(everyScope, call);
        expect(granted.failure).toMatchObject({ _tag: "FactoryError", reason: "not_found" });
        expect(granted.reached).toEqual([method]);
      }),
  );
});

describe("Factory plan RPCs over the wire", () => {
  const group = RpcGroup.make(...FactoryRpcs).middleware(RpcScopeAuthorization);

  /** A method's exit as a client decodes it off the wire. */
  const exitDecoders = new Map(
    FactoryRpcs.map((rpc) => [
      rpc._tag as string,
      Schema.decodeUnknownSync(Schema.toCodecJson(Rpc.exitSchema(rpc))) as (
        encoded: unknown,
      ) => Exit.Exit<unknown, unknown>,
    ]),
  );

  /**
   * The Factory methods served as the WebSocket serves them: each request arrives JSON-encoded,
   * the server decodes its payload before any handler runs, and the exit goes back encoded. The
   * session holds every grant, and the handlers are the real ones over the real service.
   */
  const serveOverJson = Effect.gen(function* () {
    const factory = yield* FactoryService.FactoryService;
    const settings = yield* FactorySettings.FactorySettings;
    const responses = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
    let write:
      | ((clientId: number, request: RpcMessage.FromClientEncoded) => Effect.Effect<void>)
      | undefined;
    const protocol = yield* RpcServer.Protocol.make((writeRequest) =>
      Effect.gen(function* () {
        write = writeRequest;
        return {
          disconnects: yield* Queue.make<number>(),
          send: (_clientId: number, response: RpcMessage.FromServerEncoded) =>
            Queue.offer(responses, JSON.parse(JSON.stringify(response))).pipe(Effect.asVoid),
          end: () => Effect.void,
          clientIds: Effect.succeed(new Set([0])),
          initialMessage: Effect.succeedNone,
          supportsAck: false,
          supportsTransferables: false,
          supportsSpanPropagation: false,
          supportsNotifications: false,
          codecFor: Schema.toCodecJson,
        };
      }),
    );
    yield* RpcServer.make(group).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provide(
        Layer.mergeAll(
          group.toLayer(Effect.succeed(wsHandlers({ factory, settings, startup: readyStartup }))),
          RpcAuthorization.layer(AuthEnvironmentScope.literals),
        ),
      ),
      Effect.forkScoped,
    );
    let requests = 0;
    /** Sends `payload` as JSON to `tag` and returns the exit a client decodes from the answer. */
    return (tag: string, payload: unknown) =>
      Effect.gen(function* () {
        const id = String((requests += 1));
        if (write === undefined) return yield* Effect.die("The server is not running.");
        yield* write(0, {
          _tag: "Request",
          id,
          tag,
          payload: JSON.parse(JSON.stringify(payload)),
          headers: [],
        });
        while (true) {
          const response = yield* Queue.take(responses);
          if (response._tag === "Exit" && String(response.requestId) === id) {
            return exitDecoders.get(tag)!(response.exit);
          }
        }
      });
  });

  /** The wire error of a failed exit; a defect, or a success, fails the test. */
  const factoryErrorOf = (exit: Exit.Exit<unknown, unknown>) => {
    expect(Exit.isFailure(exit), "the request succeeded").toBe(true);
    if (Exit.isSuccess(exit)) return undefined;
    expect(Cause.hasDies(exit.cause), "the request died instead of failing").toBe(false);
    return onTheWire(Option.getOrUndefined(Cause.findErrorOption(exit.cause)));
  };

  it.effect("refuses malformed edits and notes as invalid_request, changing nothing", () => {
    const calls: PlannerCalls = { replans: [], interrupted: [] };
    return Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      return yield* Effect.gen(function* () {
        const factory = yield* FactoryService.FactoryService;
        const worker = yield* FactoryWorker.FactoryWorker;
        const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
        const send = yield* serveOverJson;
        const epoch = factory.subscribe.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
        const deliveryId = FactoryDeliveryId.make("delivery-wire");
        yield* seedAtGate(deliveryId, "fd-cccccc");
        const before = yield* deliveries.get(deliveryId);
        const start = yield* epoch;

        // Each with the fields of the plan its refusal names, by task id and never with text.
        const malformedEdits: ReadonlyArray<
          readonly [unknown, ReadonlyArray<{ readonly taskId: string; readonly field?: string }>]
        > = [
          [{ tasks: [{ ...first, title: "   " }, second] }, [{ taskId: first.id, field: "title" }]],
          [{ tasks: [{ ...first, risk: "extreme" }, second] }, [{ taskId: first.id }]],
          [{ tasks: [first, { ...second, kind: "perf" }] }, [{ taskId: second.id }]],
          [
            { tasks: [{ ...first, acceptance: ["c".repeat(2001)] }] },
            [{ taskId: first.id, field: "acceptance.1" }],
          ],
          [
            { tasks: [{ ...first, testPlan: [{ criterion: 1, check: "x", paths: ["../up"] }] }] },
            [{ taskId: first.id, field: "testPlan.0.paths" }],
          ],
          [{ tasks: "export-csv" }, []],
          [{ note: "No tasks list." }, []],
          ["Keep the plan as it is.", []],
          [null, []],
        ];
        for (const [edited, fields] of malformedEdits) {
          const exit = yield* send(FACTORY_WS_METHODS.factoryPlanUpdate, {
            deliveryId,
            plan: edited,
          });
          expect(factoryErrorOf(exit), JSON.stringify(edited)).toStrictEqual({
            _tag: "FactoryError",
            reason: "invalid_request",
            message: editMessage,
            deliveryId,
            ...(fields.length === 0 ? {} : { fields }),
          });
        }
        for (const note of ["", " \n\t ", "n".repeat(8001)]) {
          const exit = yield* send(FACTORY_WS_METHODS.factoryPlanReplan, { deliveryId, note });
          expect(factoryErrorOf(exit)).toStrictEqual({
            _tag: "FactoryError",
            reason: "invalid_request",
            message: noteMessage,
            deliveryId,
          });
        }
        // None of them stored anything, moved the epoch or reached the planner.
        expect(yield* deliveries.get(deliveryId)).toStrictEqual(before);
        expect(yield* epoch).toBe(start);
        expect(calls.replans).toEqual([]);

        // Well-formed actions still pass the same wire: an edit, then a replan, trimmed.
        const edit = yield* send(FACTORY_WS_METHODS.factoryPlanUpdate, {
          deliveryId,
          plan: { tasks: [second, first] },
        });
        if (!Exit.isSuccess(edit)) return expect.fail("The edit did not succeed.");
        expect((edit.value as { readonly plan?: FactoryPlan }).plan?.tasks).toEqual([
          second,
          first,
        ]);
        expect(yield* epoch).toBe(start + 1);
        const replan = yield* send(FACTORY_WS_METHODS.factoryPlanReplan, {
          deliveryId,
          note: "  Split the header task.\n",
        });
        expect(Exit.isSuccess(replan)).toBe(true);
        yield* Deferred.succeed(release, undefined);
        yield* worker.drain;
        expect(calls.replans).toEqual([{ threadId: planner, note: "Split the header task." }]);
      }).pipe(Effect.provide(makeLayer(calls, release)));
    }).pipe(Effect.scoped);
  });
});
