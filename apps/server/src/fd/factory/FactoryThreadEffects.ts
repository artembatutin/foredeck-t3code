import type { RunId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { StoredFactoryDelivery } from "./persistence/FactoryDeliveryStore.ts";
import type { FactoryEffect, FactoryEvent } from "./pipeline/state.ts";

/** A launched thread, as `thread.launched` records it. */
type FactoryThreadLaunch = Omit<
  Extract<FactoryEvent, { readonly type: "thread.launched" }>,
  "type" | "effectId"
>;

/** A failed thread effect. Only its tag reaches the delivery's block, never its message. */
interface FactoryThreadEffectFailure {
  readonly _tag: string;
}

/**
 * Carries out the thread effects for `FactoryWorker`: launching a role's thread and sending the
 * fix-commit turn on a thread. Each receives the delivery as stored with the effect. The worker
 * feeds what they report back as `thread.launched` / `turn.started`, and a failure as
 * `effect.failed`.
 */
export class FactoryThreadEffects extends Context.Service<
  FactoryThreadEffects,
  {
    readonly launchThread: (
      delivery: StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "launch_thread" }>,
    ) => Effect.Effect<FactoryThreadLaunch, FactoryThreadEffectFailure>;
    /** Sends the turn and reports the run it started on the effect's thread. */
    readonly sendFixCommitTurn: (
      delivery: StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "send_fix_commit_turn" }>,
    ) => Effect.Effect<{ readonly runId: RunId }, FactoryThreadEffectFailure>;
  }
>()("t3/fd/factory/FactoryThreadEffects") {}
