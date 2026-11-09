import type { RunId } from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  type AutomaticTurn,
  AutomaticTurnDecisionError,
  AutomaticTurnGate,
  AutomaticTurnGateInstaller,
  ran,
} from "../../orchestration-v2/AutomaticTurnGate.ts";
import * as FactoryActivity from "./FactoryActivity.ts";
import * as FactoryAdmission from "./FactoryAdmission.ts";
import * as FactoryChanges from "./FactoryChanges.ts";
import type { FactoryFamily, FactoryProvenance } from "./FactoryOwnership.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import * as FactoryAutomaticTurnStore from "./persistence/FactoryAutomaticTurnStore.ts";
import { isFactoryReviewedExecutionRefusedError } from "./reviewedExecution.ts";

/** The run an automatic turn carries on, when its kind names one. */
const sourceRunOf = (turn: AutomaticTurn): RunId | null => {
  switch (turn.kind) {
    case "restart_continuation":
      return turn.sourceRunId;
    case "usage_limit_resume":
      return turn.usageLimitContinuationOfRunId;
    case "delegated_question":
      return turn.delegatingRunId;
    case "delegated_completion":
      return turn.parentRunId;
    case "pull_request_wake":
    case "background_wake":
      return null;
  }
};

/**
 * Where a consult goes: run inline, naming the family of a thread that has one, or to the root's
 * manager with what Factory found of it.
 */
type Route =
  | { readonly type: "inline"; readonly family: FactoryFamily | null }
  | {
      readonly type: "manager";
      readonly root: FactoryDeliveryId;
      readonly launchedBy: FactoryDeliveryId;
      readonly provenance: Exclude<FactoryProvenance["class"], "explicit">;
      readonly management: Exclude<FactoryAdmission.FactoryManagement, "never">;
    };

const make = Effect.gen(function* () {
  const activity = yield* FactoryActivity.FactoryActivity;
  const turns = yield* FactoryAutomaticTurnStore.FactoryAutomaticTurnStore;
  const admission = yield* FactoryAdmission.FactoryAdmission;
  const installer = yield* AutomaticTurnGateInstaller;
  const threads = yield* FactoryThreadEffects.FactoryThreadEffects;
  const worker = yield* FactoryWorker.FactoryWorker;
  const changes = yield* FactoryChanges.FactoryChanges;

  const failed =
    (turn: AutomaticTurn, stage: AutomaticTurnDecisionError["stage"]) => (cause: unknown) =>
      new AutomaticTurnDecisionError({ kind: turn.kind, thread: turn.threadId, stage, cause });

  /**
   * Where the turn goes. A thread of no Factory family, or of a root nothing manages, runs it
   * inline and records nothing. On a managed root's family thread, the turn's class is decided once
   * from its exact source and recorded, and a turn presented again keeps the recorded one: an
   * explicit turn runs inline, and Factory's own or unknown work goes to the manager, marked with
   * whether its management is active or has ended.
   */
  const route = (turn: AutomaticTurn) =>
    Effect.gen(function* () {
      const family = yield* activity
        .family(turn.threadId)
        .pipe(Effect.mapError(failed(turn, "read")));
      if (family === null) return { type: "inline", family } satisfies Route;
      const management = yield* admission
        .management(family.root)
        .pipe(Effect.mapError(failed(turn, "read")));
      if (management === "never") return { type: "inline", family } satisfies Route;
      const key = { threadId: turn.threadId, messageId: turn.messageId };
      const known = yield* turns.get(key).pipe(Effect.mapError(failed(turn, "record")));
      const decision = Option.isSome(known)
        ? known.value
        : yield* activity.classify(turn, family.root).pipe(
            Effect.mapError(failed(turn, "read")),
            Effect.flatMap((provenance) =>
              turns
                .record({
                  ...key,
                  root: family.root,
                  deliveryId: family.launchedBy,
                  kind: turn.kind,
                  class: provenance.class,
                  sourceRunId: sourceRunOf(turn),
                })
                .pipe(Effect.mapError(failed(turn, "record"))),
            ),
          );
      if (decision.class === "explicit") return { type: "inline", family } satisfies Route;
      return {
        type: "manager",
        root: family.root,
        launchedBy: family.launchedBy,
        provenance: decision.class,
        management,
      } satisfies Route;
    });

  /**
   * Holds any automatic turn to the host's policy before it can run: one in a mode that policy
   * refuses would only fail, however it came and whoever's it is. So the consult fails, dispatching
   * nothing and leaving the thread's mode and provider as they are, for its producer to ask again;
   * once the owner has changed the mode, the next ask runs it. A family's refused turn is also
   * noted, since nothing else tells its owner why it does not run.
   */
  const judgeHostPolicy = (turn: AutomaticTurn, family: FactoryFamily | null) =>
    threads.checkThreadHostPolicy(turn.threadId, family?.launchedBy ?? null).pipe(
      Effect.tap(() => changes.clearRefusedTurn(turn.threadId)),
      Effect.tapError((cause) =>
        family !== null && FactoryThreadEffects.isFactoryRuntimeModeRefusedError(cause)
          ? changes.noteRefusedTurn(turn.threadId, {
              root: family.root,
              launchedBy: family.launchedBy,
            })
          : Effect.void,
      ),
    );

  /**
   * Holds an automatic turn of a reviewed delivery to its review before it can run: core runs such
   * a turn with the thread's selection, which drifted or still holds a mechanical turn's effort.
   * A delivery's manager runs only a turn the review still allows. One it does not fails the
   * consult, dispatching nothing, for its producer to ask again; a delivery waiting on its pull
   * request would otherwise show nothing, so it blocks saying why. A root whose management ended
   * only declines the turn, which needs no judging. The host's policy is judged after the review,
   * whose refusal blocks the delivery and which may have just set the thread's provider back.
   */
  const prepareManaged = (turn: AutomaticTurn, to: Extract<Route, { readonly type: "manager" }>) =>
    (to.management === "active"
      ? threads
          .prepareReviewedTurn(turn.threadId, to.launchedBy)
          .pipe(Effect.andThen(judgeHostPolicy(turn, to)))
      : Effect.void
    ).pipe(
      Effect.catch((cause) =>
        Effect.flatMap(
          isFactoryReviewedExecutionRefusedError(cause)
            ? Effect.ignore(
                worker.step(to.root, { type: "reviewed.refused", detail: cause.message }),
              )
            : Effect.void,
          () => Effect.fail(failed(turn, "admission")(cause)),
        ),
      ),
    );

  yield* installer.install(
    AutomaticTurnGate.of({
      admit: (turn, dispatch) =>
        Effect.flatMap(route(turn), (to) =>
          to.type === "inline"
            ? judgeHostPolicy(turn, to.family).pipe(
                Effect.mapError(failed(turn, "admission")),
                Effect.andThen(Effect.map(dispatch, ran)),
              )
            : prepareManaged(turn, to).pipe(
                Effect.andThen(
                  admission.automaticTurn({
                    root: to.root,
                    provenance: to.provenance,
                    management: to.management,
                    via: "admit",
                    turn,
                    dispatch,
                  }),
                ),
              ),
        ),
      // A native wake can be kept for long, so its dispatch is judged when it runs, not when it
      // was handed; `allowed` lets a kept one that may not run yet wait rather than be lost.
      hand: (turn, dispatch, options) =>
        Effect.flatMap(route(turn), (to) =>
          to.type === "inline"
            ? judgeHostPolicy(turn, to.family).pipe(
                Effect.mapError(failed(turn, "admission")),
                Effect.andThen(Effect.map(dispatch, ran)),
              )
            : admission.automaticTurn({
                root: to.root,
                provenance: to.provenance,
                management: to.management,
                via: "hand",
                turn,
                dispatch: prepareManaged(turn, to).pipe(Effect.andThen(dispatch)),
                allowed: prepareManaged(turn, to).pipe(
                  Effect.as(true),
                  Effect.orElseSucceed(() => false),
                ),
                ...(options.drop === undefined ? {} : { drop: options.drop }),
              }),
        ),
    }),
  );
});

/**
 * Factory's automatic turn gate, installed into core's installable gate (see
 * `AutomaticTurnGate.layerInstallable`) for as long as Factory's layers are built. Every run core
 * starts on its own asks it first: a pull request wake, a restart continuation, a usage-limit
 * resume, a delegated task's question or result, and a native background wake. A turn on a
 * managed root's family thread that Factory cannot show to be someone's on purpose reaches the
 * root's manager through `FactoryAdmission.automaticTurn`, once a reviewed delivery's review allows
 * it; every other turn runs inline. Any turn but one a retired manager declines must also be in a
 * mode the host's policy allows. A refusal, or a read or record that fails, decides nothing: the
 * consult fails with `AutomaticTurnDecisionError`, nothing is dispatched, and the turn's producer
 * asks again by its own means.
 */
export const layer = Layer.effectDiscard(make).pipe(Layer.provide(FactoryActivity.layer));

/** `layer` over the `FactoryActivity` its context holds. */
export const layerOverActivity = Layer.effectDiscard(make);
