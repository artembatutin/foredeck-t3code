import { assert, describe, it } from "@effect/vitest";
import { AuthWorkReadScope, AuthWorkWriteScope } from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as AutomaticTurnGate from "../../orchestration-v2/AutomaticTurnGate.ts";
import { HandoffAdmission, ProjectAssistant } from "../assistant/index.ts";
import { type WorkActor, WorkService } from "../work-management/index.ts";
import * as Factory from "./index.ts";
import {
  admissionsOf,
  consult,
  demandsOf,
  fill,
  freshRead,
  manage,
  release,
  slotOf,
  turns,
} from "./testkit/handoff.ts";
import { awaitedRun } from "./testkit/followThrough.ts";
import {
  authorCommits,
  drainFactory,
  stateOf,
  verifyCommands,
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";

/**
 * A Factory delivery the project assistant manages, on the server's real stack: Factory asks the
 * assistant's admission, through the bridge, before each effect and opening of the root, and a
 * slot is what lets its work run.
 */

const owner: WorkActor = {
  id: "session:owner",
  grants: [AuthWorkReadScope, AuthWorkWriteScope],
  label: "owner",
};

/** The owner renames the item through Work, which every later read sees. */
const ownerEdits = (world: World) =>
  Effect.gen(function* () {
    const work = yield* WorkService.WorkService;
    const item = yield* work.getItem(owner, { ref: world.itemRef });
    yield* work.updateItem(owner, {
      ref: world.itemRef,
      expectedRevision: item.revision,
      title: `${item.title}, and a CSV option`,
      body: item.body,
    });
  }).pipe(Effect.orDie);

/** Holds admissions for the test once `pause` says so, right after each commits. */
const holdingProbe = Effect.gen(function* () {
  const entered = yield* Deferred.make<HandoffAdmission.Admitted>();
  const go = yield* Deferred.make<void>();
  const control: {
    pause?: (admitted: HandoffAdmission.Admitted) => Effect.Effect<boolean>;
  } = {};
  const probe: typeof HandoffAdmission.HandoffAdmissionProbe.Service = {
    admitted: (admitted) =>
      Effect.suspend(() => control.pause?.(admitted) ?? Effect.succeed(false)).pipe(
        Effect.flatMap((pause) =>
          pause
            ? Deferred.succeed(entered, admitted).pipe(Effect.andThen(Deferred.await(go)))
            : Effect.void,
        ),
      ),
    released: () => Effect.void,
    observed: () => Effect.void,
  };
  return { entered, go, control, probe };
});

/** Pauses the admission of the reviewer's launch, the first effect that renders the item. */
const atReviewerLaunch = Effect.gen(function* () {
  const factory = yield* Factory.FactoryService.FactoryService;
  return (admitted: HandoffAdmission.Admitted) =>
    factory.get(FactoryDeliveryId.make(admitted.root)).pipe(
      Effect.map((delivery) => {
        const awaiting = delivery._tag === "Some" ? delivery.value.state.awaiting : null;
        return (
          admitted.kind === "effect" &&
          awaiting?.type === "effect" &&
          awaiting.effect.type === "launch_thread" &&
          awaiting.effect.role === "reviewer"
        );
      }),
      Effect.orElseSucceed(() => false),
    );
});

describe("governed Factory effects on the real stack", () => {
  it.live("waits while capacity is full and runs the effect once it is granted", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* Factory.FactoryService.FactoryService;
          const admission = yield* HandoffAdmission.HandoffAdmission;
          const author = yield* world.start;
          yield* manage(world, author.deliveryId);
          const [first] = yield* fill(world, 2);
          yield* authorCommits(author.worktreePath, "feat: add the export button", "x\n");
          yield* world.endRun(author.runId, "completed");

          // The settle check waits for a slot: marked, with one demand, and nothing ran.
          const waiting = yield* stateOf(author.deliveryId);
          if (waiting.awaiting?.type !== "effect") return assert.fail("No effect is awaited.");
          const effect = waiting.awaiting.effect;
          assert.strictEqual(effect.type, "check_settle");
          assert.strictEqual(waiting.admissionWait?.effectId, effect.id);
          const [demand] = yield* demandsOf(author.deliveryId);
          assert.deepStrictEqual(
            { kind: demand?.kind, effectId: demand?.effectId },
            { kind: "effect", effectId: effect.id },
          );
          assert.isUndefined(yield* slotOf(author.deliveryId));
          assert.isTrue(
            yield* factory
              .ensureDeferred(author.deliveryId, effect.id)
              .pipe(Effect.map((outcome) => outcome === "deferred")),
          );

          // A slot frees; the tick's grant at the head redispatches the effect, which runs.
          yield* release(first!);
          const next = yield* admission.next;
          assert.strictEqual(next.head?.id, `demand:${demand!.id}`);
          const { decision, value } = yield* admission.dispatchAdmitted(
            admission.grantEffect(demand!.id),
            () => factory.redispatch(author.deliveryId, effect.id),
          );
          assert.strictEqual(decision.type, "granted");
          assert.deepStrictEqual(value._tag === "Some" ? value.value : undefined, "dispatched");
          yield* drainFactory;
          // Settled, verified and launched the reviewer, each admitted in the root's slot.
          const reviewer = yield* awaitedRun(author.deliveryId);
          assert.notStrictEqual(reviewer.threadId, author.threadId);
          assert.strictEqual((yield* slotOf(author.deliveryId))?.state, "held");
          assert.deepStrictEqual(yield* demandsOf(author.deliveryId), []);
          const rows = yield* admissionsOf(author.deliveryId);
          assert.isAtLeast(rows.length, 3);
          assert.isTrue(
            rows.every(({ kind, state }) => kind === "effect" && state === "dispatched"),
          );
          yield* world.endRun(reviewer.runId, "completed");
        }),
      { handoff: {}, automaticTurnGate: true },
    ),
  );

  it.live("keeps an admitted effect's slot from its commit until it is dispatched", () =>
    Effect.flatMap(holdingProbe, (held) =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const admission = yield* HandoffAdmission.HandoffAdmission;
            const author = yield* world.start;
            yield* manage(world, author.deliveryId, { holding: true });
            yield* fill(world, 1);
            // Another assignment waits in the queue for a slot.
            yield* manage(world, FactoryDeliveryId.make("root-queued"), { unclaimed: true });
            held.control.pause = yield* atReviewerLaunch;
            yield* authorCommits(author.worktreePath, "feat: add the export button", "x\n");
            const ending = yield* world.endRun(author.runId, "completed").pipe(Effect.forkChild);
            const admitted = yield* Deferred.await(held.entered);

            assert.strictEqual(
              yield* admission.release(author.deliveryId, admitted.entrySeq),
              "kept",
            );
            const next = yield* admission.next;
            assert.strictEqual(next.free, 0);
            assert.isUndefined(next.head);
            const row = (yield* admissionsOf(author.deliveryId)).find(
              ({ admission_id }) => admission_id === admitted.admissionId,
            );
            assert.strictEqual(row?.state, "dispatching");
            assert.isUndefined((yield* stateOf(author.deliveryId)).threads.reviewer);

            yield* Deferred.succeed(held.go, undefined);
            yield* Fiber.join(ending);
            const reviewer = yield* awaitedRun(author.deliveryId);
            assert.strictEqual(
              (yield* stateOf(author.deliveryId)).threads.reviewer,
              reviewer.threadId,
            );
            assert.strictEqual(
              (yield* admissionsOf(author.deliveryId)).find(
                ({ admission_id }) => admission_id === admitted.admissionId,
              )?.state,
              "dispatched",
            );
            yield* world.endRun(reviewer.runId, "completed");
          }),
        { handoff: { probe: held.probe }, automaticTurnGate: true },
      ),
    ),
  );

  it.live("refuses an opening once the root's item is edited after its effect was admitted", () =>
    Effect.flatMap(holdingProbe, (held) =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            yield* manage(world, author.deliveryId, { holding: true });
            held.control.pause = yield* atReviewerLaunch;
            yield* authorCommits(author.worktreePath, "feat: add the export button", "x\n");
            const ending = yield* world.endRun(author.runId, "completed").pipe(Effect.forkChild);
            yield* Deferred.await(held.entered);
            // The launch was admitted on the item as authorized; the owner edits it now.
            yield* ownerEdits(world);
            yield* Deferred.succeed(held.go, undefined);
            yield* Fiber.join(ending);
            yield* drainFactory;

            const state = yield* stateOf(author.deliveryId);
            assert.strictEqual(state.status, "blocked");
            if (state.block?.reason !== "effect_failed")
              return assert.fail("The launch did not fail.");
            assert.include(
              state.block.detail,
              Factory.FactoryAdmission.admissionRefusalText.scope_changed,
            );
            assert.isUndefined(state.threads.reviewer);
          }),
        { handoff: { probe: held.probe }, automaticTurnGate: true },
      ),
    ),
  );
});

describe("the gate beside the assistant's tick", () => {
  it.live("decides while one decision waits on its Work read and the tick runs", () => {
    const hold: {
      armed: boolean;
      entered?: Deferred.Deferred<void>;
      go?: Deferred.Deferred<void>;
    } = { armed: false };
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const assistant = yield* ProjectAssistant.ProjectAssistant;
          const admission = yield* HandoffAdmission.HandoffAdmission;
          const author = yield* world.start;
          yield* manage(world, author.deliveryId);
          const second = yield* manage(world, FactoryDeliveryId.make("root-second"));
          hold.entered = yield* Deferred.make<void>();
          hold.go = yield* Deferred.make<void>();
          hold.armed = true;
          // A resume of Factory's run at the free head needs the item read; the read is held.
          const ran: Array<string> = [];
          const held = yield* consult(turns.usageLimitResume(author.threadId, author.runId), {
            ran,
          }).pipe(Effect.forkChild);
          yield* Deferred.await(hold.entered);
          hold.armed = false;

          // Meanwhile the tick runs to its end, and another root's decisions are made.
          yield* assistant.tick;
          yield* fill(world, 2);
          const waits = yield* admission.decideTurn({
            root: second.root,
            provenance: "factory",
            turn: turns.usageLimitResume(author.threadId, author.runId),
          });
          assert.strictEqual(waits.type, "demand");

          yield* Deferred.succeed(hold.go, undefined);
          const outcome = yield* Fiber.join(held);
          // Capacity filled while it read: decided again, it waits as a demand.
          assert.deepStrictEqual(outcome, AutomaticTurnGate.notNow("deferred"));
          assert.deepStrictEqual(ran, []);
          assert.lengthOf(yield* demandsOf(author.deliveryId), 1);
          yield* world.endRun(author.runId, "completed");
        }),
      {
        handoff: {},
        automaticTurnGate: true,
        work: (service) => ({
          ...service,
          getItem: (actor, input) =>
            hold.armed && actor.id === "assistant:handoff"
              ? Deferred.succeed(hold.entered!, undefined).pipe(
                  Effect.andThen(Deferred.await(hold.go!)),
                  Effect.andThen(service.getItem(actor, input)),
                )
              : service.getItem(actor, input),
        }),
      },
    );
  });

  it.live("decides while a tick's grant is held between its commit and its dispatch", () =>
    Effect.flatMap(holdingProbe, (held) =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const assistant = yield* ProjectAssistant.ProjectAssistant;
            const admission = yield* HandoffAdmission.HandoffAdmission;
            const author = yield* world.start;
            yield* manage(world, author.deliveryId);
            const queued = yield* manage(world, FactoryDeliveryId.make("root-queued"), {
              unclaimed: true,
            });
            held.control.pause = (admitted) => Effect.succeed(admitted.kind === "claim");
            const claiming = yield* admission
              .dispatchAdmitted(
                admission.claim({ assignmentId: queued.assignmentId, deliveryId: "root-queued" }),
                () => Effect.void,
              )
              .pipe(Effect.forkChild);
            const claimed = yield* Deferred.await(held.entered);
            assert.strictEqual(claimed.root, "root-queued");

            // The claim holds one slot, dispatching; gate decisions and the tick go on.
            const ran: Array<string> = [];
            const resume = turns.usageLimitResume(author.threadId, author.runId);
            const outcome = yield* consult(resume, { ran });
            assert.deepStrictEqual(outcome, AutomaticTurnGate.ran(undefined));
            assert.deepStrictEqual(ran, [resume.messageId]);
            assert.strictEqual((yield* slotOf(author.deliveryId))?.state, "held");
            yield* assistant.tick;
            assert.strictEqual((yield* admissionsOf("root-queued"))[0]?.state, "dispatching");

            yield* Deferred.succeed(held.go, undefined);
            const { decision } = yield* Fiber.join(claiming);
            assert.strictEqual(decision.type, "claimed");
            assert.strictEqual((yield* admissionsOf("root-queued"))[0]?.state, "dispatched");
            assert.isTrue((yield* freshRead(world)).type === "read");
            yield* world.endRun(author.runId, "completed");
          }),
        { handoff: { probe: held.probe }, automaticTurnGate: true },
      ),
    ),
  );
});
