import { PositiveInt, ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryPlan } from "@t3tools/contracts/fd/factory";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import type { FactoryStoreError } from "./persistence/errors.ts";
import type { StoredFactoryDelivery } from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import type { FactoryEffect, FactoryPlanJudgment, FactoryPlanSource } from "./pipeline/state.ts";
import { parseFencedPlan } from "./plan/fencedPlan.ts";
import { type FactoryPlanValidation, validatePlan } from "./plan/validate.ts";
import * as FactoryEvidence from "./verify/FactoryEvidence.ts";

export type FactoryPlanJudgeError = FactoryStoreError | FactoryEvidence.FactoryEvidenceError;

/** `plan.json`: the delivery's latest accepted plan as the planner submitted it, and how. */
const FactoryPlanEvidence = Schema.Struct({
  version: PositiveInt,
  deliveryId: FactoryDeliveryId,
  round: PositiveInt,
  source: Schema.Literals(["mcp", "fallback"]),
  threadId: ThreadId,
  plan: FactoryPlan,
});
const PLAN_EVIDENCE_VERSION = 1;
const encodeEvidence = Schema.encodeEffect(Schema.fromJsonString(FactoryPlanEvidence));

/**
 * Judges a planner's submissions for its delivery's current plan round (port of Looper's
 * `validatePlan`), by either path: the `factory_submit_plan` tool, or the fenced JSON of the
 * planner run's last assistant message. Task ids the delivery already uses are refused. A valid
 * plan, with tasks or without, is written to the delivery's evidence folder under T3 home as
 * `plan.json`, never to the worktree, and accepted; a later round's accepted plan replaces it, as
 * a task's later approval replaces its approval file. An invalid one goes back with every problem
 * at once. Judging records nothing on the delivery; the engine does, from the judgment.
 */
export class FactoryPlanning extends Context.Service<
  FactoryPlanning,
  {
    readonly judge: (
      delivery: StoredFactoryDelivery,
      submission: {
        readonly source: FactoryPlanSource;
        readonly threadId: ThreadId;
        readonly plan: unknown;
      },
    ) => Effect.Effect<FactoryPlanJudgment, FactoryPlanJudgeError>;
    /** Judges the fenced plan of the effect's run; a run without one is an invalid submission. */
    readonly judgeFallback: (
      delivery: StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "read_fallback_plan" }>,
    ) => Effect.Effect<
      FactoryPlanJudgment,
      FactoryPlanJudgeError | ProjectionStore.ProjectionStoreV2Error
    >;
  }
>()("t3/fd/factory/FactoryPlanning") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const evidence = yield* FactoryEvidence.FactoryEvidence;
  const tasks = yield* FactoryTaskStore.FactoryTaskStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const usedTaskIds = (delivery: StoredFactoryDelivery) =>
    tasks
      .listByDelivery(delivery.deliveryId)
      .pipe(Effect.map((stored) => stored.map(({ taskId }) => taskId)));

  const writeEvidence = Effect.fn("FactoryPlanning.writeEvidence")(function* (
    record: typeof FactoryPlanEvidence.Type,
  ) {
    const file = yield* evidence.planFile(record.deliveryId);
    yield* encodeEvidence(record).pipe(
      Effect.flatMap((json) => fileSystem.writeFileString(file, json)),
      Effect.mapError(
        (cause) =>
          new FactoryEvidence.FactoryEvidenceError({ operation: "write", path: file, cause }),
      ),
    );
    return file;
  });

  const conclude = Effect.fn("FactoryPlanning.judge")(function* (
    delivery: StoredFactoryDelivery,
    source: FactoryPlanSource,
    threadId: ThreadId,
    validation: FactoryPlanValidation,
  ) {
    if (validation.status === "invalid") {
      return {
        type: "invalid",
        problems: validation.problems.map((problem) => problem.description),
      } satisfies FactoryPlanJudgment;
    }
    const plan: FactoryPlan =
      validation.status === "valid"
        ? validation.plan
        : { tasks: [], ...(validation.note === null ? {} : { note: validation.note }) };
    const evidencePath = yield* writeEvidence({
      version: PLAN_EVIDENCE_VERSION,
      deliveryId: delivery.deliveryId,
      round: delivery.state.planRound,
      source,
      threadId,
      plan,
    });
    return {
      type: "accepted",
      plan: { ...plan, source, evidencePath },
    } satisfies FactoryPlanJudgment;
  });

  const judge: FactoryPlanning["Service"]["judge"] = (delivery, submission) =>
    usedTaskIds(delivery).pipe(
      Effect.flatMap((used) =>
        conclude(
          delivery,
          submission.source,
          submission.threadId,
          validatePlan(submission.plan, used),
        ),
      ),
    );

  /** The text of the run's last assistant message that has any; null when it has none. */
  const lastAssistantText = (
    effect: Extract<FactoryEffect, { readonly type: "read_fallback_plan" }>,
  ) =>
    projections
      .getThreadRecords(effect.threadId, ["messages"], {
        messageRunIds: [effect.runId],
        messageRoles: ["assistant"],
      })
      .pipe(
        Effect.map(
          ({ messages }) =>
            messages.findLast((message) => message.text.trim().length > 0)?.text ?? null,
        ),
      );

  const judgeFallback: FactoryPlanning["Service"]["judgeFallback"] = (delivery, effect) =>
    Effect.gen(function* () {
      const text = yield* lastAssistantText(effect);
      const used = yield* usedTaskIds(delivery);
      // A run without a message has no fenced block either.
      const validation = parseFencedPlan(text ?? "", used);
      return yield* conclude(delivery, "fallback", effect.threadId, validation);
    });

  return FactoryPlanning.of({ judge, judgeFallback });
});

export const layer = Layer.effect(FactoryPlanning, make);
