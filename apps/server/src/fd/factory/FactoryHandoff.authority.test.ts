import { assert, describe, it } from "@effect/vitest";
import type { WorkDomainError } from "../work-management/index.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import { HandoffAdmission, HandoffBackend } from "../assistant/index.ts";
import {
  consult,
  demandsOf,
  fill,
  freshRead,
  manage,
  release,
  runsOf,
  slotOf,
  turns,
  wakeThroughGate,
} from "./testkit/handoff.ts";
import { coreRecovery, providerThreadOf, providerTurnRunning } from "./testkit/familyThreads.ts";
import { editTaskFile, linkOf, openSingle } from "./testkit/followThrough.ts";
import {
  drainFactory,
  drainOrchestration,
  fakePullRequest,
  stateOf,
  verifyCommands,
  withProject,
} from "./testkit/deliveryHarness.ts";

/**
 * A managed root's authority read fresh, on the server's real stack: automatic turns that would
 * run in its family read its Work item again first, and run nothing while it says something else
 * or cannot be read.
 */

const edited = "Add the export button and a CSV option";
const retitle = (from: string, to: string) => (text: string) =>
  text.replace(`title: ${from}`, `title: ${to}`);

class FakeWorkUnavailable extends Schema.TaggedError<FakeWorkUnavailable>()("WorkUnavailable", {
  detail: Schema.String,
}) {}

describe("fresh authority for a managed root's automatic turns", () => {
  it.live(
    "blocks pull request feedback on an idle root edited outside, then admits it once restored",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const admission = yield* HandoffAdmission.HandoffAdmission;
            const opened = yield* openSingle(world);
            const managed = yield* manage(world, opened.deliveryId);
            const link = yield* linkOf(opened.threadId, fakePullRequest.number);
            const runs = (yield* runsOf(opened.threadId)).length;
            yield* editTaskFile(world, world.itemRef, retitle(world.itemTitle, edited));

            // Feedback arrives with a slot free: the item read again no longer says what was
            // authorized, so the wake waits blocked and nothing is dispatched.
            const blocked = yield* wakeThroughGate(opened.threadId, link);
            assert.strictEqual(blocked.outcome._tag, "NotNow");
            assert.isUndefined(blocked.runId);
            assert.strictEqual((yield* runsOf(opened.threadId)).length, runs);
            const [demand] = yield* demandsOf(managed.root);
            assert.deepStrictEqual(
              { kind: demand?.kind, blockedReason: demand?.blockedReason },
              { kind: "pull_request_wake", blockedReason: "scope_changed" },
            );
            assert.isUndefined(yield* slotOf(managed.root));
            // Core's watch is as it was: the wake's sync was never committed.
            assert.deepStrictEqual(
              (yield* linkOf(opened.threadId, fakePullRequest.number)).watch,
              link.watch,
            );
            assert.strictEqual((yield* stateOf(opened.deliveryId)).status, "pr_open");

            // Restored and re-checked, it waits at the head; the tick reserves the slot for it,
            // and the watch's next presentation runs it once.
            yield* editTaskFile(world, world.itemRef, retitle(edited, world.itemTitle));
            const restored = yield* freshRead(world);
            assert.strictEqual(
              yield* admission.recheckBlocked({ root: managed.root, work: restored, force: true }),
              1,
            );
            const next = yield* admission.next;
            assert.strictEqual(next.head?.id, `demand:${demand!.id}`);
            const reserved = yield* admission.reserve(demand!.id, restored);
            assert.strictEqual(reserved.type, "reserved");
            const admitted = yield* wakeThroughGate(opened.threadId, link);
            assert.strictEqual(admitted.outcome._tag, "Ran");
            assert.isDefined(admitted.runId);
            assert.strictEqual((yield* slotOf(managed.root))?.state, "held");
            // Held, a later wake of the pull request waits for its own grant.
            const later = yield* wakeThroughGate(
              opened.threadId,
              yield* linkOf(opened.threadId, fakePullRequest.number),
            );
            assert.strictEqual(later.outcome._tag, "NotNow");
            assert.strictEqual((yield* runsOf(opened.threadId)).length, runs + 1);
          }),
        { handoff: {}, automaticTurnGate: true },
      ),
    180_000,
  );

  it.live("redelivers a reserved native wake only once its root's item reads as authorized", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const admission = yield* HandoffAdmission.HandoffAdmission;
          const redelivery = yield* HandoffBackend.HandoffRedelivery;
          const author = yield* world.start;
          const managed = yield* manage(world, author.deliveryId);
          const [filler] = yield* fill(world, 2);
          // Factory's own background work wakes with both slots held: kept, waiting.
          const record = { ran: [] as Array<string> };
          const wake = turns.backgroundWake(
            author.threadId,
            yield* providerThreadOf(author.threadId, author.runId),
          );
          yield* consult(wake, record);
          const [demand] = yield* demandsOf(managed.root);
          // A slot frees and the tick reserves it on a fresh read; the item is edited after.
          yield* release(filler!);
          assert.strictEqual(
            (yield* admission.reserve(demand!.id, yield* freshRead(world))).type,
            "reserved",
          );
          yield* editTaskFile(world, world.itemRef, retitle(world.itemTitle, edited));
          assert.strictEqual(yield* redelivery.redeliver(demand!), "blocked");
          assert.deepStrictEqual(record.ran, []);
          assert.isUndefined(yield* slotOf(managed.root));
          assert.strictEqual((yield* demandsOf(managed.root))[0]?.blockedReason, "scope_changed");

          // Restored, re-checked and reserved again, its kept dispatch runs once.
          yield* editTaskFile(world, world.itemRef, retitle(edited, world.itemTitle));
          const restored = yield* freshRead(world);
          yield* admission.recheckBlocked({ root: managed.root, work: restored, force: true });
          yield* admission.reserve(demand!.id, restored);
          assert.strictEqual(yield* redelivery.redeliver(demand!), "dispatched");
          assert.deepStrictEqual(record.ran, [wake.messageId]);
          assert.strictEqual((yield* slotOf(managed.root))?.state, "held");
          yield* world.endRun(author.runId, "completed");
        }),
      { handoff: {}, automaticTurnGate: true },
    ),
  );

  it.live(
    "runs a cut run's continuation across a restart in the root's slot while its item is unchanged",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            const managed = yield* manage(world, author.deliveryId, { holding: true });
            yield* providerTurnRunning(author.threadId);
            const recovery = yield* coreRecovery;
            yield* recovery.prepareForShutdown;
            yield* recovery.reconcile("shutdown");
            yield* world.rebuild(
              Effect.gen(function* () {
                yield* drainOrchestration;
                yield* drainFactory;
                const runs = yield* runsOf(author.threadId);
                assert.isTrue(runs.some((run) => run.restartContinuationOfRunId === author.runId));
                assert.strictEqual((yield* slotOf(managed.root))?.state, "held");
              }),
              { orchestration: true },
            );
          }),
        { handoff: {}, automaticTurnGate: true },
      ),
    180_000,
  );

  it.live.each([{ variant: "edited" as const }, { variant: "unreadable" as const }])(
    "declines a cut run's continuation across a restart when the root is $variant",
    ({ variant }) => {
      const failing = { on: false };
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            const managed = yield* manage(world, author.deliveryId, { holding: true });
            if (variant === "edited") {
              yield* editTaskFile(world, world.itemRef, retitle(world.itemTitle, edited));
            } else failing.on = true;
            // Core's shutdown records restart intent for the turn its provider is working on.
            yield* providerTurnRunning(author.threadId);
            const recovery = yield* coreRecovery;
            yield* recovery.prepareForShutdown;
            yield* recovery.reconcile("shutdown");
            yield* world.rebuild(
              Effect.gen(function* () {
                yield* drainOrchestration;
                yield* drainFactory;
                // The continuation was declined: no run carries the cut turn on.
                const runs = yield* runsOf(author.threadId);
                assert.isTrue(runs.every((run) => run.restartContinuationOfRunId !== author.runId));
                // Its outbox effect settled as a declined continuation does.
                const outbox = yield* EffectOutbox.EffectOutboxV2;
                const effect = yield* outbox.get(`effect:restart-continuation:${author.runId}`);
                assert.isTrue(effect._tag === "Some");
                if (effect._tag === "Some") {
                  assert.notInclude(["pending", "running"], effect.value.status);
                }
                // Factory takes the cut run's end, and the delivery blocks for its owner.
                assert.strictEqual((yield* stateOf(author.deliveryId)).status, "blocked");
                // Nothing was admitted in the root's slot for it.
                assert.deepStrictEqual(yield* demandsOf(managed.root), []);
              }).pipe(Effect.provide(EffectOutbox.layer)),
              { orchestration: true },
            );
          }),
        {
          handoff: {},
          automaticTurnGate: true,
          work: (service) => ({
            ...service,
            getItem: (actor, input) =>
              failing.on && actor.id === "assistant:handoff"
                ? Effect.fail(
                    new FakeWorkUnavailable({
                      detail: "The source could not be reached.",
                    }) as unknown as WorkDomainError,
                  )
                : service.getItem(actor, input),
          }),
        },
      );
    },
    180_000,
  );
});
