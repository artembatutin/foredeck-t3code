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
import type { FactoryProvenance } from "./FactoryOwnership.ts";
import * as FactoryAutomaticTurnStore from "./persistence/FactoryAutomaticTurnStore.ts";

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

/** Where a consult goes: run inline, or to the root's manager with what Factory found of it. */
type Route =
  | { readonly type: "inline" }
  | {
      readonly type: "manager";
      readonly root: FactoryDeliveryId;
      readonly provenance: Exclude<FactoryProvenance["class"], "explicit">;
      readonly management: Exclude<FactoryAdmission.FactoryManagement, "never">;
    };

const inline: Route = { type: "inline" };

const make = Effect.gen(function* () {
  const activity = yield* FactoryActivity.FactoryActivity;
  const turns = yield* FactoryAutomaticTurnStore.FactoryAutomaticTurnStore;
  const admission = yield* FactoryAdmission.FactoryAdmission;
  const installer = yield* AutomaticTurnGateInstaller;

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
      if (family === null) return inline;
      const management = yield* admission
        .management(family.root)
        .pipe(Effect.mapError(failed(turn, "read")));
      if (management === "never") return inline;
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
      if (decision.class === "explicit") return inline;
      return {
        type: "manager",
        root: family.root,
        provenance: decision.class,
        management,
      } satisfies Route;
    });

  yield* installer.install(
    AutomaticTurnGate.of({
      admit: (turn, dispatch) =>
        Effect.flatMap(route(turn), (to) =>
          to.type === "inline"
            ? Effect.map(dispatch, ran)
            : admission.automaticTurn({
                root: to.root,
                provenance: to.provenance,
                management: to.management,
                via: "admit",
                turn,
                dispatch,
              }),
        ),
      hand: (turn, dispatch, options) =>
        Effect.flatMap(route(turn), (to) =>
          to.type === "inline"
            ? Effect.map(dispatch, ran)
            : admission.automaticTurn({
                root: to.root,
                provenance: to.provenance,
                management: to.management,
                via: "hand",
                turn,
                dispatch,
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
 * root's manager through `FactoryAdmission.automaticTurn`; every other turn runs inline. A read or
 * record that fails decides nothing: the consult fails with `AutomaticTurnDecisionError`,
 * nothing is dispatched, and the turn's producer asks again by its own means.
 */
export const layer = Layer.effectDiscard(make).pipe(Layer.provide(FactoryActivity.layer));

/** `layer` over the `FactoryActivity` its context holds. */
export const layerOverActivity = Layer.effectDiscard(make);
