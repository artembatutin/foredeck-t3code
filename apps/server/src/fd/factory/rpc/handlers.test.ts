import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import {
  FACTORY_WS_METHODS,
  FactoryDeliveryId,
  FactoryError,
  FactorySettingsSetInput,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, type WorkItemRef, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ServerRuntimeStartup from "../../../serverRuntimeStartup.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import { WorkService } from "../../work-management/index.ts";
import * as FactoryReview from "../FactoryReview.ts";
import * as FactoryService from "../FactoryService.ts";
import * as FactorySettings from "../FactorySettings.ts";
import * as FactoryThreadEffects from "../FactoryThreadEffects.ts";
import * as FactoryWorker from "../FactoryWorker.ts";
import * as Factory from "../index.ts";
import { FactoryStoreError } from "../persistence/errors.ts";
import * as FactoryDeliveryStore from "../persistence/FactoryDeliveryStore.ts";
import { queuedDeliveryState } from "../pipeline/state.ts";
import { wsHandlers } from "./handlers.ts";

const alpha = ProjectId.make("project-alpha");
const beta = ProjectId.make("project-beta");
const sourceId = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const itemRef = (itemId: string): WorkItemRef => ({ sourceId, itemId: WorkItemId.make(itemId) });
const deliveryId = FactoryDeliveryId.make("delivery-1");

/** Runs every command at once, as a server past its startup does. */
const readyStartup = ServerRuntimeStartup.ServerRuntimeStartup.of({
  awaitCommandReady: Effect.void,
  markHttpListening: Effect.void,
  enqueueCommand: (effect) => effect,
});

const encodeError = Schema.encodeSync(FactoryError);
const isFactoryError = Schema.is(FactoryError);
const decodeSettingsSet = Schema.decodeSync(FactorySettingsSetInput);

/** The error as the RPC sends it, after checking it is the wire error at all. */
const onTheWire = (error: unknown) => {
  expect(isFactoryError(error)).toBe(true);
  return encodeError(error as FactoryError);
};

describe("Factory RPC errors", () => {
  const unexpected = Effect.die("not called in this test");
  const stubFactory = (
    overrides: Partial<FactoryService.FactoryService["Service"]>,
  ): FactoryService.FactoryService["Service"] =>
    FactoryService.FactoryService.of({
      start: () => unexpected,
      get: () => unexpected,
      list: () => unexpected,
      stop: () => unexpected,
      resume: () => unexpected,
      cancel: () => unexpected,
      submitReview: () => unexpected,
      ...overrides,
    });
  const stubSettings = FactorySettings.FactorySettings.of({
    get: (projectId) =>
      Effect.fail(
        new FactorySettings.FactorySettingsStorageError({
          operation: "get",
          projectId,
          cause: new Error("SQLITE_IOERR: disk I/O error in /home/owner/.t3/userdata/state.sqlite"),
        }),
      ),
    set: () => unexpected,
    requireDeliverySettings: () => unexpected,
  });
  const handlersOver = (
    factory: Partial<FactoryService.FactoryService["Service"]>,
    startup = readyStartup,
  ) => wsHandlers({ factory: stubFactory(factory), settings: stubSettings, startup });
  type Handlers = ReturnType<typeof handlersOver>;
  interface ErrorCase {
    readonly name: string;
    readonly handlers: Handlers;
    readonly call: (handlers: Handlers) => Effect.Effect<object, FactoryError>;
    readonly wire: ReturnType<typeof encodeError>;
  }
  const storageCause = new Error("SQLITE_BUSY: database is locked at /home/owner/.t3/userdata");

  const errorCases: ReadonlyArray<ErrorCase> = [
    {
      name: "a start without a verify command",
      handlers: handlersOver({
        start: () =>
          Effect.fail(new FactorySettings.FactoryVerifyCommandMissingError({ projectId: alpha })),
      }),
      call: (handlers) =>
        handlers[FACTORY_WS_METHODS.factoryDeliveriesStart]({ itemRef: itemRef("fd-aaaaaa") }),
      wire: {
        _tag: "FactoryError",
        reason: "not_configured",
        message:
          "Set a verify command in the project's Factory settings before starting a delivery.",
      },
    },
    {
      name: "a start of an item with an active delivery",
      handlers: handlersOver({
        start: ({ itemRef: ref }) =>
          Effect.fail(new FactoryDeliveryStore.FactoryDeliveryActive({ itemRef: ref, deliveryId })),
      }),
      call: (handlers) =>
        handlers[FACTORY_WS_METHODS.factoryDeliveriesStart]({ itemRef: itemRef("fd-aaaaaa") }),
      wire: {
        _tag: "FactoryError",
        reason: "conflict",
        message: "This Work item already has a Factory delivery that is not done or cancelled.",
        deliveryId,
      },
    },
    {
      name: "a resume of a cancelled delivery",
      handlers: handlersOver({
        resume: (id) =>
          Effect.fail(
            new FactoryService.FactoryResumeRefusedError({ deliveryId: id, status: "cancelled" }),
          ),
      }),
      call: (handlers) => handlers[FACTORY_WS_METHODS.factoryDeliveriesResume]({ deliveryId }),
      wire: {
        _tag: "FactoryError",
        reason: "refused",
        message: "Only a stopping, stopped or blocked delivery can resume; this one is cancelled.",
        deliveryId,
      },
    },
    {
      name: "a stop of a blocked delivery",
      handlers: handlersOver({
        stop: (id) =>
          Effect.fail(
            new FactoryService.FactoryStopRefusedError({ deliveryId: id, status: "blocked" }),
          ),
      }),
      call: (handlers) => handlers[FACTORY_WS_METHODS.factoryDeliveriesStop]({ deliveryId }),
      wire: {
        _tag: "FactoryError",
        reason: "refused",
        message: "Only a running delivery can stop after its step; this one is blocked.",
        deliveryId,
      },
    },
    {
      name: "a cancel of a done delivery",
      handlers: handlersOver({
        cancel: (id) =>
          Effect.fail(
            new FactoryService.FactoryCancelRefusedError({ deliveryId: id, status: "done" }),
          ),
      }),
      call: (handlers) => handlers[FACTORY_WS_METHODS.factoryDeliveriesCancel]({ deliveryId }),
      wire: {
        _tag: "FactoryError",
        reason: "refused",
        message: "This delivery is already done, so it cannot be cancelled.",
        deliveryId,
      },
    },
    {
      name: "a storage failure",
      handlers: handlersOver({
        cancel: () =>
          Effect.fail(
            new FactoryStoreError({ operation: "deliveries.update", cause: storageCause }),
          ),
      }),
      call: (handlers) => handlers[FACTORY_WS_METHODS.factoryDeliveriesCancel]({ deliveryId }),
      wire: {
        _tag: "FactoryError",
        reason: "unavailable",
        message: "Factory could not read or save its records. Try again.",
      },
    },
    {
      name: "a settings storage failure",
      handlers: handlersOver({}),
      call: (handlers) => handlers[FACTORY_WS_METHODS.factorySettingsGet]({ projectId: alpha }),
      wire: {
        _tag: "FactoryError",
        reason: "unavailable",
        message: "Factory could not read or save its records. Try again.",
      },
    },
    {
      name: "a server that failed to start",
      handlers: handlersOver(
        { start: () => unexpected },
        ServerRuntimeStartup.ServerRuntimeStartup.of({
          ...readyStartup,
          enqueueCommand: () =>
            Effect.fail(
              new ServerRuntimeStartup.ServerRuntimeStartupError({
                mode: "web",
                host: null,
                port: 0,
                cause: storageCause,
              }),
            ),
        }),
      ),
      call: (handlers) =>
        handlers[FACTORY_WS_METHODS.factoryDeliveriesStart]({ itemRef: itemRef("fd-aaaaaa") }),
      wire: {
        _tag: "FactoryError",
        reason: "unavailable",
        message: "The server failed to start, so Factory cannot run deliveries.",
      },
    },
  ];

  it.effect.each(errorCases)("maps $name to the Factory RPC error", ({ handlers, call, wire }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(call(handlers));
      expect(onTheWire(error)).toStrictEqual(wire);
      // Fixed text only: nothing of the storage failure's cause reaches the client.
      expect(JSON.stringify(onTheWire(error))).not.toMatch(/SQLITE|\/home\/owner/);
    }),
  );
});

describe("Factory RPC handlers over real stores", () => {
  /** The real service, settings and stores; nothing here launches, reviews or reads Git. */
  const layer = FactoryService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(FactoryWorker.FactoryWorker)({}),
        Layer.mock(FactoryReview.FactoryReview)({}),
        Layer.mock(FactoryThreadEffects.FactoryThreadEffects)({}),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(ProjectStore.ProjectStoreV2)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        // A start reads the item's source and project before it checks the settings.
        Layer.mock(WorkService.WorkService)({
          canonicalRef: (ref) => Effect.succeed(ref),
          resolveSource: () =>
            Effect.succeed({
              stored: { sourceId, projectId: alpha },
            } as unknown as WorkService.ResolvedSource),
        }),
      ),
    ),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
  );

  const handlers = Effect.gen(function* () {
    const factory = yield* FactoryService.FactoryService;
    const settings = yield* FactorySettings.FactorySettings;
    return wsHandlers({ factory, settings, startup: readyStartup });
  });

  /** Stores a queued delivery; the test clock moves a second after each, so none share a time. */
  const store = (id: string, projectId: ProjectId, item: string) =>
    Effect.gen(function* () {
      const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
      yield* deliveries.insert({
        deliveryId: FactoryDeliveryId.make(id),
        projectId,
        itemRef: itemRef(item),
        state: queuedDeliveryState({ branch: `work/${item}`, baseRef: "HEAD" }),
      });
      yield* TestClock.adjust("1 second");
    });

  it.effect("lists every project's deliveries or one project's, newest first", () =>
    Effect.gen(function* () {
      yield* store("delivery-old", alpha, "fd-aaaaaa");
      yield* store("delivery-mid", beta, "fd-bbbbbb");
      yield* store("delivery-new", alpha, "fd-cccccc");
      const rpc = yield* handlers;
      const list = (query: { readonly projectId?: ProjectId }) =>
        rpc[FACTORY_WS_METHODS.factoryDeliveriesList](query).pipe(
          Effect.map(({ deliveries }) =>
            deliveries.map((delivery) => [delivery.deliveryId, delivery.projectId]),
          ),
        );

      expect(yield* list({})).toEqual([
        ["delivery-new", alpha],
        ["delivery-mid", beta],
        ["delivery-old", alpha],
      ]);
      expect(yield* list({ projectId: alpha })).toEqual([
        ["delivery-new", alpha],
        ["delivery-old", alpha],
      ]);
      expect(yield* list({ projectId: beta })).toEqual([["delivery-mid", beta]]);
      expect(yield* list({ projectId: ProjectId.make("project-elsewhere") })).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("gets a stored delivery's snapshot and refuses an unknown id as not found", () =>
    Effect.gen(function* () {
      yield* store("delivery-old", alpha, "fd-aaaaaa");
      const rpc = yield* handlers;

      const found = yield* rpc[FACTORY_WS_METHODS.factoryDeliveriesGet]({
        deliveryId: FactoryDeliveryId.make("delivery-old"),
      });
      expect(found).toMatchObject({
        deliveryId: "delivery-old",
        projectId: alpha,
        itemRef: itemRef("fd-aaaaaa"),
        status: "queued",
        branch: "work/fd-aaaaaa",
      });

      const missing = FactoryDeliveryId.make("delivery-missing");
      const error = yield* Effect.flip(
        rpc[FACTORY_WS_METHODS.factoryDeliveriesGet]({ deliveryId: missing }),
      );
      expect(onTheWire(error)).toStrictEqual({
        _tag: "FactoryError",
        reason: "not_found",
        message: "This Factory delivery does not exist.",
        deliveryId: missing,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("saves settings with their defaults and refuses a start until verify is set", () =>
    Effect.gen(function* () {
      const rpc = yield* handlers;
      const start = rpc[FACTORY_WS_METHODS.factoryDeliveriesStart]({
        itemRef: itemRef("fd-aaaaaa"),
      });
      expect(onTheWire(yield* Effect.flip(start))).toMatchObject({ reason: "not_configured" });

      const saved = yield* rpc[FACTORY_WS_METHODS.factorySettingsSet](
        decodeSettingsSet({
          projectId: alpha,
          settings: { verifyCommand: { executable: "vp", args: ["test"] } },
        }),
      );
      expect(saved).toMatchObject({
        verifyCommand: { executable: "vp", args: ["test"] },
        limits: { maxFixRounds: 2, maxReviewRounds: 2 },
        pipelineId: "standard",
      });
      expect(yield* rpc[FACTORY_WS_METHODS.factorySettingsGet]({ projectId: alpha })).toEqual(
        saved,
      );

      const unknownPipeline = yield* Effect.flip(
        rpc[FACTORY_WS_METHODS.factorySettingsSet]({
          projectId: alpha,
          settings: { ...saved, pipelineId: "express" },
        }),
      );
      expect(onTheWire(unknownPipeline)).toStrictEqual({
        _tag: "FactoryError",
        reason: "invalid_request",
        message: "This server does not have the selected Factory pipeline.",
      });
    }).pipe(Effect.provide(layer)),
  );
});
