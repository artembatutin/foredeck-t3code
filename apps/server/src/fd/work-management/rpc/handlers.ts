import {
  type AuthEnvironmentScope,
  type AuthSessionId,
  RpcScopeAuthorization,
} from "@t3tools/contracts";
import { WORK_WS_METHODS, WorkError, WorkRpcs } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { RpcInstrumentation } from "../../../observability/RpcInstrumentation.ts";
import * as ServerRuntimeStartup from "../../../serverRuntimeStartup.ts";
import type { WorkActor } from "../authority.ts";
import { toWorkError, type WorkDomainError } from "../errors.ts";
import * as WorkService from "../WorkService.ts";
import * as WorkThreads from "../WorkThreads.ts";

/**
 * The Work procedures with the server's middleware, in core's order (instrumentation wraps
 * authorization). Handler services are keyed by method, so this group's handler layer serves the
 * server's full group; a single handler layer over every method is too deep for the type checker.
 */
const WorkServerRpcGroup = RpcGroup.make(...WorkRpcs)
  .middleware(RpcScopeAuthorization)
  .middleware(RpcInstrumentation);

type WorkHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WorkServerRpcGroup>>;

/** The methods `ws.ts` leaves out of its own handler layer. */
export const WS_METHOD_TAGS = Object.values(WORK_WS_METHODS);

/** The owner's own session; grants are the connection's fixed scopes. */
export const actorFromSession = (session: {
  readonly sessionId: AuthSessionId;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}): WorkActor => ({
  id: `session:${session.sessionId}`,
  grants: session.scopes,
  label: "owner",
});

const wire = <A>(effect: Effect.Effect<A, WorkDomainError>): Effect.Effect<A, WorkError> =>
  Effect.mapError(effect, toWorkError);

/**
 * Thin WebSocket handlers: decode is done by the group, each entry calls one service method
 * and maps domain errors to the wire error.
 */
export const wsHandlers = (input: {
  readonly work: WorkService.WorkService["Service"];
  readonly workThreads: WorkThreads.WorkThreads["Service"];
  readonly startup: ServerRuntimeStartup.ServerRuntimeStartup["Service"];
  readonly actor: WorkActor;
}) => {
  const { work, workThreads, startup, actor } = input;
  return {
    [WORK_WS_METHODS.workSourcesList]: (query) => wire(work.listSources(actor, query)),
    [WORK_WS_METHODS.workSourcesSave]: (payload) => wire(work.saveSource(actor, payload)),
    [WORK_WS_METHODS.workSourcesDisconnect]: (payload) =>
      wire(work.disconnectSource(actor, payload)),
    [WORK_WS_METHODS.workSourcesRestore]: (payload) => wire(work.restoreSource(actor, payload)),
    [WORK_WS_METHODS.workSourcesTest]: (payload) => wire(work.testSource(actor, payload)),
    [WORK_WS_METHODS.workItemsList]: (query) =>
      Effect.annotateCurrentSpan({ "work.source_id": query.sourceId }).pipe(
        Effect.andThen(wire(work.listItems(actor, query))),
      ),
    [WORK_WS_METHODS.workItemsGet]: (payload) =>
      Effect.annotateCurrentSpan({
        "work.source_id": payload.ref.sourceId,
        "work.item_id": payload.ref.itemId,
      }).pipe(Effect.andThen(wire(work.getItem(actor, payload)))),
    [WORK_WS_METHODS.workItemsPeople]: (query) => wire(work.listPeople(actor, query)),
    [WORK_WS_METHODS.workItemsCreate]: (payload) => wire(work.createItem(actor, payload)),
    [WORK_WS_METHODS.workItemsUpdate]: (payload) => wire(work.updateItem(actor, payload)),
    [WORK_WS_METHODS.workItemsSetStatus]: (payload) => wire(work.setStatus(actor, payload)),
    [WORK_WS_METHODS.workItemsComment]: (payload) => wire(work.addComment(actor, payload)),
    [WORK_WS_METHODS.workLinksList]: (query) => wire(work.listLinks(actor, query)),
    [WORK_WS_METHODS.workLinksSet]: (payload) => wire(work.setLink(actor, payload)),
    [WORK_WS_METHODS.workRefresh]: (payload) => wire(work.refresh(actor, payload)),
    [WORK_WS_METHODS.workSubscribeRefreshes]: () => work.subscribeRefreshes,
    // Direct WebSocket calls are not gated on command readiness, so the launch queues like core's.
    [WORK_WS_METHODS.workThreadsStart]: (payload) =>
      Effect.annotateCurrentSpan({
        "work.source_id": payload.ref.sourceId,
        "work.item_id": payload.ref.itemId,
      }).pipe(
        Effect.andThen(
          startup.enqueueCommand(wire(workThreads.start(actor, payload))).pipe(
            Effect.catchTags({
              ServerRuntimeStartupError: (error) =>
                Effect.fail(new WorkError({ reason: "unavailable", message: error.message })),
            }),
          ),
        ),
      ),
  } satisfies WorkHandlers;
};

/** The Work handler layer for one authenticated WebSocket session. */
export const layerWsRpc = (session: Parameters<typeof actorFromSession>[0]) =>
  WorkServerRpcGroup.toLayer(
    Effect.gen(function* () {
      const work = yield* WorkService.WorkService;
      const workThreads = yield* WorkThreads.WorkThreads;
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      return wsHandlers({ work, workThreads, startup, actor: actorFromSession(session) });
    }),
  );
