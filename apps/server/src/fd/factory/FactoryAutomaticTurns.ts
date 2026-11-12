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
   * The turn's thread's family. One that cannot be read fails the turn only while some root is or
   * was managed, since the thread may then be in a managed family that must not run uncounted;
   * otherwise no managed family can hold it, and the turn runs as a thread of no family would.
   */
  const familyOf = (turn: AutomaticTurn) =>
    activity
      .family(turn.threadId)
      .pipe(
        Effect.catch((cause) =>
          (admission.managesAny ?? Effect.succeed(true)).pipe(
            Effect.flatMap((managesAny) =>
              managesAny ? Effect.fail(failed(turn, "read")(cause)) : Effect.succeed(null),
            ),
          ),
        ),
      );

  /**
   * Where the turn goes. Outside a managed root's family it runs inline, unrecorded. Inside, its
   * class is decided once and recorded (a turn presented again keeps it): explicit runs inline,
   * Factory's or unknown goes to the manager, marked active or ended.
   */
  const route = Effect.fn("FactoryAutomaticTurns.route")(function* (turn: AutomaticTurn) {
    const family = yield* familyOf(turn);
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
   * Holds any automatic turn to the host's policy: a refused mode fails the consult, dispatching
   * nothing and changing nothing, so the producer asks again once the owner changes the mode.
   * A family's refused turn is noted, since nothing else tells its owner why it does not run.
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
   * Holds a reviewed delivery's automatic turn to its review, since core runs it with the thread's
   * possibly drifted selection. A refusal fails the consult and blocks the delivery saying why.
   * Ended management only declines, so needs no judging. Host policy is judged after the review,
   * which may have just set the thread's provider back.
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
      admit: Effect.fn("AutomaticTurnGate.admit")((turn, dispatch) =>
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
      ),
      // A native wake can be kept for long, so its dispatch is judged when it runs, not when it
      // was handed; `allowed` lets a kept one that may not run yet wait rather than be lost.
      // @effect-diagnostics-next-line effectFnOpportunity:off - only the gate's generic signature infers this turn's requirements as never.
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
 * Factory's gate in `AutomaticTurnGate.layerInstallable` while its layers are built: non-explicit
 * turns on a managed family go to `FactoryAdmission.automaticTurn`, others run inline. A refusal
 * or failed read fails with `AutomaticTurnDecisionError`, dispatching nothing; a failed family
 * read still runs the turn while no root was ever managed.
 */
export const layer = Layer.effectDiscard(make).pipe(Layer.provide(FactoryActivity.layer));

/** `layer` over the `FactoryActivity` its context holds. */
export const layerOverActivity = Layer.effectDiscard(make);
