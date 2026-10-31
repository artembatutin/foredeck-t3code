import { assert, describe, it } from "@effect/vitest";
import type { WorkDomainError } from "../work-management/index.ts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as AutomaticTurnGate from "../../orchestration-v2/AutomaticTurnGate.ts";
import { HandoffAdmission } from "../assistant/index.ts";
import {
  consult,
  demandsOf,
  fill,
  freshRead,
  manage,
  questionTask,
  release,
  slotOf,
  turns,
  wakeThroughGate,
} from "./testkit/handoff.ts";
import { delegateFrom, providerThreadOf } from "./testkit/familyThreads.ts";
import {
  awaitedRun,
  editTaskFile,
  linkOf,
  linkPullRequest,
  openSingle,
  ownerQueues,
  runStarted,
  watchPullRequest,
} from "./testkit/followThrough.ts";
import {
  authorCommits,
  verifyCommands,
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";

/**
 * The provenance an automatic turn reaches the assistant's admission with, on the server's real
 * stack: Factory's own and unknown work of a managed root waits for the family's slot, and the
 * owner's runs inline.
 */

class FakeWorkUnavailable extends Schema.TaggedError<FakeWorkUnavailable>()("WorkUnavailable", {
  detail: Schema.String,
}) {}

const retitle = (from: string, to: string) => (text: string) =>
  text.replace(`title: ${from}`, `title: ${to}`);

/**
 * A native wake of unknown origin waits as one demand and runs nothing; granted later with the
 * root's item `spoiled`, the fresh read blocks it, and still nothing runs.
 */
const waitsUnknownThenBlocks = (
  world: World,
  root: string,
  wake: AutomaticTurnGate.BackgroundWakeTurn,
  spoil: Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>,
  category: HandoffAdmission.BlockedReason,
) =>
  Effect.gen(function* () {
    const admission = yield* HandoffAdmission.HandoffAdmission;
    const ran: Array<string> = [];
    assert.deepStrictEqual(yield* consult(wake, { ran }), AutomaticTurnGate.notNow("deferred"));
    assert.deepStrictEqual(ran, []);
    const waiting = (yield* demandsOf(root)).filter(({ kind }) => kind === "background_wake");
    assert.deepStrictEqual(
      waiting.map(({ provenance, messageId }) => [provenance, messageId]),
      [["unknown", wake.messageId]],
    );
    // The root's slot frees, and the tick takes a fresh read before it grants the wake.
    yield* spoil;
    yield* release(root);
    const next = yield* admission.next;
    assert.strictEqual(next.head?.id, `demand:${waiting[0]!.id}`);
    const granted = yield* admission.reserve(waiting[0]!.id, yield* freshRead(world));
    assert.deepStrictEqual(granted, { type: "blocked", category });
    assert.isUndefined(yield* slotOf(root));
    assert.deepStrictEqual(ran, []);
  });

describe("provenance at the assistant's gate", () => {
  it.live.each([{ spoiled: "edited" as const }, { spoiled: "unreadable" as const }])(
    "keeps a wake after Factory's work and then the owner's turn waiting ($spoiled)",
    ({ spoiled }) => {
      const failing = { on: false };
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            const managed = yield* manage(world, author.deliveryId, { holding: true });
            yield* fill(world, 1);
            const providerThread = yield* providerThreadOf(author.threadId, author.runId);
            // (a) Factory's run, then the owner's turn on the same provider thread.
            const ownerRun = yield* ownerQueues(author.threadId, "Rename the button.");
            yield* authorCommits(author.worktreePath, "feat: add the export button", "x\n");
            yield* world.endRun(author.runId, "completed");
            yield* runStarted(ownerRun);
            yield* waitsUnknownThenBlocks(
              world,
              managed.root,
              turns.backgroundWake(author.threadId, providerThread),
              spoiled === "edited"
                ? editTaskFile(
                    world,
                    world.itemRef,
                    retitle(world.itemTitle, "Add the export button and a CSV option"),
                  )
                : Effect.sync(() => void (failing.on = true)),
              spoiled === "edited" ? "scope_changed" : "unreadable",
            );
            yield* world.endRun(ownerRun, "completed");
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
                      detail: "unreachable",
                    }) as unknown as WorkDomainError,
                  )
                : service.getItem(actor, input),
          }),
        },
      );
    },
  );

  it.live("keeps a wake after the owner's turn and then Factory's repair turn waiting", () =>
    withProject(
      verifyCommands.fails,
      (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          const managed = yield* manage(world, author.deliveryId, { holding: true });
          yield* fill(world, 1);
          const providerThread = yield* providerThreadOf(author.threadId, author.runId);
          // (b) The owner's turn, then Factory's repair turn queued behind it.
          const ownerRun = yield* ownerQueues(author.threadId, "Rename the button.");
          yield* authorCommits(author.worktreePath, "feat: add the export button", "x\n");
          yield* world.endRun(author.runId, "completed");
          yield* runStarted(ownerRun);
          yield* world.endRun(ownerRun, "completed");
          const repair = yield* awaitedRun(author.deliveryId);
          assert.strictEqual(repair.threadId, author.threadId);
          yield* waitsUnknownThenBlocks(
            world,
            managed.root,
            turns.backgroundWake(author.threadId, providerThread),
            editTaskFile(
              world,
              world.itemRef,
              retitle(world.itemTitle, "Add the export button and a CSV option"),
            ),
            "scope_changed",
          );
          yield* world.endRun(repair.runId, "completed");
        }),
      { handoff: {}, automaticTurnGate: true, limits: { maxFixRounds: 1 } },
    ),
  );

  it.live("runs the owner's own task's wake inline with both slots held by others", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const author = yield* world.start;
          const managed = yield* manage(world, author.deliveryId);
          yield* fill(world, 2);
          yield* authorCommits(author.worktreePath, "feat: add the export button", "x\n");
          yield* world.endRun(author.runId, "completed");
          // (c) The owner delegates a task themselves: its provider thread carries only theirs.
          const ownerRun = yield* world.ownerTurn(author.threadId, "Split the export.");
          const ownerTask = yield* delegateFrom(author.threadId, ownerRun, "user");
          const wake = turns.backgroundWake(
            ownerTask.childThreadId,
            yield* providerThreadOf(ownerTask.childThreadId, ownerTask.runId),
          );
          const ran: Array<string> = [];
          assert.deepStrictEqual(yield* consult(wake, { ran }), AutomaticTurnGate.ran(undefined));
          assert.deepStrictEqual(ran, [wake.messageId]);
          assert.isUndefined(
            (yield* demandsOf(managed.root)).find(({ kind }) => kind === "background_wake"),
          );
          yield* world.endRun(ownerTask.runId, "completed");
          yield* world.endRun(ownerRun, "completed");
        }),
      { handoff: {}, automaticTurnGate: true },
    ),
  );

  it.live("runs the owner's own pull request wake inline with both slots held by others", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const opened = yield* openSingle(world);
          const managed = yield* manage(world, opened.deliveryId);
          yield* fill(world, 2);
          // (c) The owner watches another pull request on the author thread.
          const owned = {
            host: "github.com",
            repository: "acme/alpha",
            number: 8,
            url: "https://github.com/acme/alpha/pull/8",
          };
          yield* linkPullRequest(opened.threadId, owned);
          yield* watchPullRequest(opened.threadId, owned);
          const wake = yield* wakeThroughGate(opened.threadId, yield* linkOf(opened.threadId, 8));
          assert.strictEqual(wake.outcome._tag, "Ran");
          assert.isDefined(wake.runId);
          assert.deepStrictEqual(yield* demandsOf(managed.root), []);
          yield* world.endRun(wake.runId!, "completed");
        }),
      { handoff: {}, automaticTurnGate: true },
    ),
  );

  it.live(
    "admits Factory's delegation's question in the holding, and keeps an unknown one waiting",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            const managed = yield* manage(world, author.deliveryId, { holding: true });
            yield* fill(world, 1);
            yield* authorCommits(author.worktreePath, "feat: add the export button", "x\n");
            yield* world.endRun(author.runId, "completed");
            const ownerRun = yield* world.ownerTurn(author.threadId, "Ask the delegate.");
            const task = { childThreadId: author.threadId, taskId: questionTask };
            const ran: Array<string> = [];
            // (d) The question of a task Factory's run delegated lands in the family's slot.
            const factoryQuestion = turns.delegatedQuestion(author.threadId, task, author.runId);
            assert.deepStrictEqual(
              yield* consult(factoryQuestion, { ran }),
              AutomaticTurnGate.ran(undefined),
            );
            // A task the owner's turn delegated is not known to be Factory's: it waits.
            const ownerQuestion = turns.delegatedQuestion(author.threadId, task, ownerRun);
            assert.deepStrictEqual(
              yield* consult(ownerQuestion, { ran }),
              AutomaticTurnGate.notNow("deferred"),
            );
            assert.deepStrictEqual(ran, [factoryQuestion.messageId]);
            assert.deepStrictEqual(
              (yield* demandsOf(managed.root))
                .filter(({ kind }) => kind === "delegated_question")
                .map(({ provenance, requestId }) => [provenance, requestId]),
              [["unknown", ownerQuestion.requestId]],
            );
            yield* world.endRun(ownerRun, "completed");
          }),
        { handoff: {}, automaticTurnGate: true },
      ),
  );
});
