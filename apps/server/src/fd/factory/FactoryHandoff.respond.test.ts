import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ProviderSessionId,
  type RunId,
  type RuntimeMode,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  FACTORY_PENDING_REASON_MAX,
  type FactoryPendingAction,
} from "@t3tools/contracts/fd/factory";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as AutomaticTurnGate from "../../orchestration-v2/AutomaticTurnGate.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import { ProjectAssistant } from "../assistant/index.ts";
import * as Factory from "./index.ts";
import * as AssistantHandoff from "../assistant-handoff/index.ts";
import { type WorkDomainError, WorkService } from "../work-management/index.ts";
import {
  agreeAndCapture,
  assignToFactory,
  assistantThread,
  driver,
  endManagement,
  fill,
  governedMessages,
  type Managed,
  manage,
  rootIdOf,
  runsOf,
  startAssistantThread,
  tick,
  writtenRows,
} from "./testkit/handoff.ts";
import { delegateFrom } from "./testkit/familyThreads.ts";
import { editTaskFile } from "./testkit/followThrough.ts";
import { type McpCaller, withEndpoint } from "./testkit/mcpEndpoint.ts";
import {
  drainFactory,
  drainOrchestration,
  ended,
  runReached,
  stateOf,
  threadProjection,
  verifyCommands,
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";

/**
 * Answers to the questions agents of a Factory delivery the project assistant manages ask, given
 * by its other agents through the authenticated MCP endpoint on the server's real stack. A
 * governed caller may only continue a live question of a run already counted under a slot its
 * root holds: one provider response, no message and no run. An answer core would turn into a
 * message, and so a new turn, is refused before anything moves. The owner, outside clients and
 * every other agent answer as before.
 */

const text = AssistantHandoff.callerPolicyText;

class FakeWorkUnavailable extends Schema.TaggedError<FakeWorkUnavailable>()("WorkUnavailable", {
  detail: Schema.String,
}) {}

const edited = "Add the export button and a CSV option";
const retitle = (from: string, to: string) => (body: string) =>
  body.replace(`title: ${from}`, `title: ${to}`);

/** The provider turn of the run, as the fake provider started it. */
const turnOf = (world: World, runId: RunId) =>
  world.provider.started.find((candidate) => candidate.runId === runId) ??
  assert.fail(`No provider turn started run ${runId}.`);

/** The provider asks a question in the run's turn; returns it once core stores it pending. */
const asked = (world: World, runId: RunId, mode: "live" | "message") =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const requestId = yield* world.provider.ask(turnOf(world, runId), mode);
    yield* sink.stream().pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "runtime-request.updated" &&
          event.payload.id === requestId &&
          event.payload.status === "pending",
      ),
      Stream.runHead,
    );
    yield* drainOrchestration;
    return requestId;
  }).pipe(Effect.orDie);

/** The request is stored pending and core has acted on everything before it. */
const requestSettled = (requestId: RuntimeRequestId) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.stream().pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "runtime-request.updated" &&
          event.payload.id === requestId &&
          event.payload.status === "pending",
      ),
      Stream.runHead,
    );
    yield* drainOrchestration;
  }).pipe(Effect.orDie);

const requestOf = (threadId: ThreadId, requestId: RuntimeRequestId) =>
  threadProjection(threadId).pipe(
    Effect.map(
      ({ runtimeRequests }) =>
        runtimeRequests.find((request) => request.id === requestId) ??
        assert.fail(`Request ${requestId} is gone.`),
    ),
    Effect.orDie,
  );

const respondedTo = (world: World, requestId: RuntimeRequestId) =>
  world.provider.responded.filter((response) => response.requestId === requestId).length;

const answering = (caller: McpCaller, threadId: ThreadId) => (requestId: RuntimeRequestId) =>
  caller.call("t3_pending_request_respond", {
    threadId,
    requestId,
    answers: { format: "CSV" },
  });

/**
 * The answer is refused with `expected`, and nothing moves: the request stays pending, no
 * provider response, message, run, effect or admission row appears, before or after a drain.
 */
const refusedUnchanged = (
  world: World,
  answer: (requestId: RuntimeRequestId) => ReturnType<McpCaller["call"]>,
  target: ThreadId,
  requestId: RuntimeRequestId,
  expected: string,
  label: string,
) =>
  Effect.gen(function* () {
    const before = yield* writtenRows;
    const responses = world.provider.responded.length;
    assert.deepStrictEqual(yield* answer(requestId), { isError: true, text: expected }, label);
    yield* drainOrchestration;
    yield* drainFactory;
    assert.deepStrictEqual(yield* writtenRows, before, label);
    assert.strictEqual((yield* requestOf(target, requestId)).status, "pending", label);
    assert.strictEqual(world.provider.responded.length, responses, label);
  });

/** The live answer continues the run once: one provider response, no message and no run. */
const continuedOnce = (
  world: World,
  answer: (requestId: RuntimeRequestId) => ReturnType<McpCaller["call"]>,
  target: ThreadId,
  requestId: RuntimeRequestId,
) =>
  Effect.gen(function* () {
    const before = yield* threadProjection(target);
    const answered = yield* answer(requestId);
    assert.isFalse(answered.isError, answered.text);
    yield* drainOrchestration;
    assert.strictEqual(respondedTo(world, requestId), 1);
    const after = yield* threadProjection(target);
    assert.strictEqual(after.messages.length, before.messages.length);
    assert.strictEqual(after.runs.length, before.runs.length);
    assert.strictEqual(
      after.runtimeRequests.find((request) => request.id === requestId)?.status,
      "resolved",
    );
  }).pipe(Effect.orDie);

const authorize = (world: World, managed: Managed, executionAuthorized: boolean) =>
  Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistant) =>
    assistant.revise({
      projectId: world.projectId,
      ideaId: managed.ideaId,
      patch: { executionAuthorized },
    }),
  ).pipe(Effect.orDie);

/** Work as the server runs it, whose reads for the assistant fail while `failing.on`. */
const unreadableWork = (failing: { on: boolean }) => ({
  work: (service: WorkService.WorkService["Service"]): WorkService.WorkService["Service"] => ({
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
});

const holdSlot = (managed: Managed, entrySeq: number) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`INSERT INTO fd_assistant_slots
      (root_delivery_id, assignment_id, state, entry_seq, granted_at)
      VALUES (${managed.root}, ${managed.assignmentId}, 'held', ${entrySeq},
        '2026-10-29T12:00:00.000Z')`,
  ).pipe(Effect.orDie);
const dropSlot = (managed: Managed) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly entry_seq: number }>`DELETE FROM fd_assistant_slots
      WHERE root_delivery_id = ${managed.root} RETURNING entry_seq`,
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => rows[0]?.entry_seq ?? assert.fail("The root held no slot.")),
  );

describe("what a delivery's threads wait on", () => {
  /** The epoch a client follows: its first value is where it stands now. */
  const epoch = Effect.flatMap(Factory.FactoryService.FactoryService, (factory) =>
    factory.listingChanges.pipe(Stream.runHead),
  ).pipe(Effect.map(Option.getOrThrow));

  it.live(
    "lists them for the listing and the overview, writing nothing, and moves the epoch",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* Factory.FactoryService.FactoryService;
            const assistant = yield* ProjectAssistant.ProjectAssistant;
            const author = yield* world.start;
            const managed = yield* manage(world, author.deliveryId, { holding: true });
            const child = yield* delegateFrom(author.threadId, author.runId);
            const before = yield* epoch;

            const question = yield* asked(world, author.runId, "live");
            const said = `Needs network ${"x".repeat(FACTORY_PENDING_REASON_MAX)}`;
            const approval = yield* world.provider
              .askApproval(turnOf(world, child.runId), "command", "rm -rf build", said)
              .pipe(Effect.orDie);
            yield* requestSettled(approval);
            yield* drainFactory;
            assert.isAbove(yield* epoch, before);

            const written = yield* writtenRows;
            const listed = yield* factory.listForClients({ projectId: world.projectId });
            const overview = yield* assistant.overview;
            assert.deepStrictEqual(yield* writtenRows, written);
            yield* drainOrchestration;
            yield* drainFactory;
            assert.deepStrictEqual(yield* writtenRows, written);

            const pending = listed.find(
              ({ deliveryId }) => deliveryId === author.deliveryId,
            )?.pendingActions;
            assert.deepStrictEqual(
              pending?.items
                .map(({ kind, runClass, threadId, projectId, requestId, capability }) => ({
                  kind,
                  runClass,
                  threadId,
                  projectId,
                  requestId,
                  capability,
                }))
                .toSorted((left, right) => left.kind.localeCompare(right.kind)),
              [
                {
                  kind: "command",
                  runClass: "factory",
                  threadId: child.childThreadId,
                  projectId: world.projectId,
                  requestId: approval,
                  capability: "live",
                },
                {
                  kind: "user_input",
                  runClass: "factory",
                  threadId: author.threadId,
                  projectId: world.projectId,
                  requestId: question,
                  capability: "live",
                },
              ],
            );
            assert.strictEqual(pending?.complete, true);
            const asking = pending?.items.find(({ requestId }) => requestId === approval);
            assert.strictEqual(asking?.reason, said.slice(0, FACTORY_PENDING_REASON_MAX));

            const assignment = overview.assignments.find(
              ({ assignmentId }) => assignmentId === managed.assignmentId,
            );
            assert.sameMembers(
              assignment?.factory?.pendingActions?.items.map(({ requestId }) => requestId) ?? [],
              [question, approval],
            );
            assert.strictEqual(
              assignment?.factory?.pendingActions?.items.find(
                ({ requestId }) => requestId === approval,
              )?.reason,
              said.slice(0, FACTORY_PENDING_REASON_MAX),
            );
          }),
        { handoff: {}, automaticTurnGate: true },
      ),
    300_000,
  );

  it.live(
    "keeps an answered question from granting anything, and refuses to answer a permission",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const assistant = yield* ProjectAssistant.ProjectAssistant;
            yield* startAssistantThread(world);
            yield* agreeAndCapture(world, "export");
            yield* assignToFactory(world, "export");
            yield* tick;
            yield* drainFactory;
            yield* drainOrchestration;
            const { awaiting } = yield* stateOf(yield* rootIdOf("export"));
            if (awaiting?.type !== "run") return assert.fail("The author is not running.");
            const author = { runId: awaiting.runId, threadId: awaiting.threadId };
            const answer = (requestId: RuntimeRequestId) =>
              assistant.answer({
                assignmentId: "export",
                managerThreadId: assistantThread,
                requestId,
                answers: { format: "CSV" },
              });

            const approval = yield* world.provider
              .askApproval(turnOf(world, author.runId), "command", "rm -rf build")
              .pipe(Effect.orDie);
            yield* requestSettled(approval);
            const refused = yield* Effect.flip(answer(approval));
            assert.include(refused.message, "question tools cannot grant permission");
            assert.strictEqual(respondedTo(world, approval), 0);
            assert.strictEqual((yield* requestOf(author.threadId, approval)).status, "pending");

            const question = yield* asked(world, author.runId, "live");
            yield* answer(question);
            yield* drainOrchestration;
            const answered = world.provider.responded.find(
              ({ requestId }) => requestId === question,
            );
            assert.deepStrictEqual(answered?.answers, { format: "CSV" });
            assert.isUndefined(answered?.decision);
            // The request it did not answer still waits on the owner's own decision.
            assert.strictEqual((yield* requestOf(author.threadId, approval)).status, "pending");
            assert.strictEqual(respondedTo(world, approval), 0);
            const notices = (yield* assistant.overview).assignments.find(
              ({ assignmentId }) => assignmentId === "export",
            )?.factory?.pendingActions?.items;
            assert.deepStrictEqual(
              notices?.map(({ requestId }) => requestId),
              [approval],
            );
          }),
        { handoff: {}, automaticTurnGate: true },
      ),
    300_000,
  );
});

describe("a managed delivery's work in a mode its host refuses", () => {
  const options = (): Parameters<typeof withProject>[2] => ({
    handoff: {},
    automaticTurnGate: true,
    hostPolicy: {
      restrictions: [
        { runtimeMode: "approval-required", status: "disallowed" },
        { runtimeMode: "auto-accept-edits", status: "allowed" },
        { runtimeMode: "full-access", status: "allowed" },
      ],
    },
  });

  const setThreadMode = (threadId: ThreadId, runtimeMode: RuntimeMode, label: string) =>
    Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
      orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make(label),
        threadId,
        runtimeMode,
      }),
    ).pipe(Effect.andThen(drainOrchestration));

  const epoch = Effect.flatMap(Factory.FactoryService.FactoryService, (factory) =>
    factory.listingChanges.pipe(Stream.runHead),
  ).pipe(Effect.map(Option.getOrThrow));

  it.live(
    "lists a refused automatic turn for the listing and the overview, writing nothing",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* Factory.FactoryService.FactoryService;
            const assistant = yield* ProjectAssistant.ProjectAssistant;
            const gate = yield* AutomaticTurnGate.AutomaticTurnGate;
            const author = yield* world.start;
            const managed = yield* manage(world, author.deliveryId, { holding: true });
            yield* setThreadMode(author.threadId, "approval-required", "owner-supervises");
            let ran = 0;
            const turn = {
              kind: "restart_continuation",
              threadId: author.threadId,
              messageId: MessageId.make(`message:restart-continuation:${author.runId}`),
              key: author.runId,
              sourceRunId: author.runId,
              settled: false,
            } as const;
            const present = gate.admit(
              turn,
              Effect.sync(() => void (ran += 1)),
            );
            const before = yield* epoch;

            const failure = yield* Effect.flip(present);
            assert.strictEqual(failure.stage, "admission");
            const refusing = yield* epoch;
            assert.isAbove(refusing, before);
            // Asking again says nothing new, so nothing a client follows moves.
            yield* Effect.flip(present);
            assert.strictEqual(yield* epoch, refusing);
            assert.strictEqual(ran, 0);

            const written = yield* writtenRows;
            const listed = yield* factory.listForClients({ projectId: world.projectId });
            const overview = yield* assistant.overview;
            assert.deepStrictEqual(yield* writtenRows, written);
            assert.strictEqual(yield* epoch, refusing);

            const shown = (items: ReadonlyArray<FactoryPendingAction> | undefined) =>
              (items ?? []).filter(({ kind }) => kind === "host_policy");
            const inListing = shown(
              listed.find(({ deliveryId }) => deliveryId === author.deliveryId)?.pendingActions
                ?.items,
            );
            const inOverview = shown(
              overview.assignments.find(({ assignmentId }) => assignmentId === managed.assignmentId)
                ?.factory?.pendingActions?.items,
            );
            assert.deepStrictEqual(inOverview, inListing);
            assert.lengthOf(inListing, 1);
            assert.strictEqual(inListing[0]?.threadId, author.threadId);
            assert.strictEqual(inListing[0]?.runtimeMode, "approval-required");
            assert.deepStrictEqual(inListing[0]?.refused?.alternatives, [
              "auto-accept-edits",
              "full-access",
            ]);
            assert.strictEqual(inListing[0]?.refused?.choose, "automatic_turn");

            // The owner chooses: nothing to show, before the turn is even asked for again.
            yield* setThreadMode(author.threadId, "auto-accept-edits", "owner-chooses");
            assert.deepStrictEqual(
              shown(
                (yield* factory.listForClients({ projectId: world.projectId })).find(
                  ({ deliveryId }) => deliveryId === author.deliveryId,
                )?.pendingActions?.items,
              ),
              [],
            );
            assert.isUndefined(
              (yield* assistant.overview).assignments
                .find(({ assignmentId }) => assignmentId === managed.assignmentId)
                ?.factory?.pendingActions?.items.find(({ kind }) => kind === "host_policy"),
            );
          }),
        options(),
      ),
    300_000,
  );

  it.live("refuses delegate_task from an unreviewed delivery's thread, writing nothing", () =>
    withProject(
      verifyCommands.passes,
      (world) =>
        withEndpoint(driver, (endpoint) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            yield* manage(world, author.deliveryId, { holding: true });
            const agent = yield* endpoint.callerOn(author.threadId);
            yield* setThreadMode(author.threadId, "approval-required", "owner-supervises");
            const written = yield* writtenRows;

            const refused = yield* agent.call("delegate_task", { task: "Check the export." });

            assert.isTrue(refused.isError);
            assert.include(refused.text, "This delivery cannot delegate now.");
            assert.include(refused.text, "host policy refuses Supervised");
            yield* drainFactory;
            assert.deepStrictEqual(yield* writtenRows, written);
            assert.deepStrictEqual((yield* threadProjection(author.threadId)).subagents, []);
          }),
        ).pipe(Effect.orDie),
      options(),
    ),
  );
});

describe("answers by a managed delivery's agents", () => {
  it.live(
    "refuses a parent's message-capable answer in every condition, and continues a live one once",
    () => {
      const failing = { on: false };
      return withProject(
        verifyCommands.passes,
        (world) =>
          withEndpoint(driver, (endpoint) =>
            Effect.gen(function* () {
              const author = yield* world.start;
              const managed = yield* manage(world, author.deliveryId, { holding: true });
              const child = yield* delegateFrom(author.threadId, author.runId);
              const parent = yield* endpoint.callerOn(author.threadId);
              const answer = answering(parent, child.childThreadId);
              const refuse = (requestId: RuntimeRequestId, expected: string, label: string) =>
                refusedUnchanged(world, answer, child.childThreadId, requestId, expected, label);

              // A question the provider would take as a new turn, while the child's turn runs
              // and could be steered.
              const message = yield* asked(world, child.runId, "message");
              const messageText = text.message(child.childThreadId);
              yield* refuse(message, messageText, "held, steerable target");
              yield* fill(world, 1);
              yield* refuse(message, messageText, "full capacity");
              const entrySeq = yield* dropSlot(managed);
              yield* refuse(message, messageText, "parked");
              yield* holdSlot(managed, entrySeq);
              yield* authorize(world, managed, false);
              yield* refuse(message, messageText, "revoked");
              yield* authorize(world, managed, true);
              yield* editTaskFile(world, world.itemRef, retitle(world.itemTitle, edited));
              yield* refuse(message, messageText, "edited");
              failing.on = true;
              yield* refuse(message, messageText, "unreadable");

              // A live question of the counted child run, under the root's held slot: answered
              // once, continuing that run. No Work read is needed to let a counted run drain.
              const live = yield* asked(world, child.runId, "live");
              yield* continuedOnce(world, answer, child.childThreadId, live);
              failing.on = false;

              // Without a held slot, the same live question is refused.
              const unheld = yield* asked(world, child.runId, "live");
              const reserved = yield* dropSlot(managed);
              yield* refuse(unheld, text.liveOnly(child.childThreadId), "no slot");
              yield* holdSlot(managed, reserved);

              // Outside the root's family: a question on the owner's own thread.
              const owners = yield* asked(world, (yield* runsOf(managed.manager))[0]!.id, "live");
              yield* refusedUnchanged(
                world,
                answering(parent, managed.manager),
                managed.manager,
                owners,
                text.family,
                "outside the family",
              );

              // The child completes; its message-capable question stays pending, and stays
              // refused before and after a rebuild, with no answer's message anywhere.
              yield* world.provider.endTurn(turnOf(world, child.runId), "completed");
              yield* runReached(child.runId, ["waiting", ...ended]);
              yield* drainOrchestration;
              yield* drainFactory;
              yield* refuse(message, messageText, "completed child");
              assert.deepStrictEqual(yield* governedMessages(managed.root), []);
              yield* world.rebuild(
                withEndpoint(driver, (rebuilt) =>
                  Effect.gen(function* () {
                    yield* drainOrchestration;
                    yield* drainFactory;
                    const again = answering(
                      yield* rebuilt.callerOn(author.threadId),
                      child.childThreadId,
                    );
                    yield* refusedUnchanged(
                      world,
                      again,
                      child.childThreadId,
                      message,
                      messageText,
                      "rebuilt",
                    );
                    assert.deepStrictEqual(yield* governedMessages(managed.root), []);
                  }),
                ),
                { orchestration: true },
              );
            }),
          ),
        { handoff: {}, automaticTurnGate: true, ...unreadableWork(failing) },
      );
    },
    300_000,
  );

  it.live(
    "lets an ending root drain counted live questions only, and refuses every answer once retired",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          withEndpoint(driver, (endpoint) =>
            Effect.gen(function* () {
              const author = yield* world.start;
              const managed = yield* manage(world, author.deliveryId, { holding: true });
              const child = yield* delegateFrom(author.threadId, author.runId);
              const parent = yield* endpoint.callerOn(author.threadId);
              const answer = answering(parent, child.childThreadId);

              // Fenced while an admission it won still holds its slot.
              yield* endManagement(managed.root, "ending");
              const live = yield* asked(world, child.runId, "live");
              yield* continuedOnce(world, answer, child.childThreadId, live);
              const message = yield* asked(world, child.runId, "message");
              yield* refusedUnchanged(
                world,
                answer,
                child.childThreadId,
                message,
                text.message(child.childThreadId),
                "ending, message",
              );

              // The owner's own turn on the child thread is no work of the root's: its live
              // question is the owner's to answer.
              yield* world.provider.endTurn(turnOf(world, child.runId), "completed");
              yield* runReached(child.runId, ["waiting", ...ended]);
              yield* drainOrchestration;
              yield* drainFactory;
              const ownerRun = yield* world.ownerTurn(child.childThreadId, "Also check a header.");
              const explicit = yield* asked(world, ownerRun, "live");
              yield* refusedUnchanged(
                world,
                answer,
                child.childThreadId,
                explicit,
                text.liveOnly(child.childThreadId),
                "ending, explicit run",
              );

              // Retired: every managed answer is refused.
              yield* endManagement(managed.root, "retired");
              for (const [requestId, label] of [
                [explicit, "retired, explicit"],
                [message, "retired, message"],
              ] as const) {
                yield* refusedUnchanged(
                  world,
                  answer,
                  child.childThreadId,
                  requestId,
                  text.retired,
                  label,
                );
              }
              const late = yield* asked(world, ownerRun, "live");
              yield* refusedUnchanged(
                world,
                answer,
                child.childThreadId,
                late,
                text.retired,
                "retired, live",
              );
              assert.deepStrictEqual(yield* governedMessages(managed.root), []);
            }),
          ),
        { handoff: {}, automaticTurnGate: true },
      ),
    240_000,
  );

  it.live.each([{ cut: "session" as const }, { cut: "run" as const }])(
    "leaves core to refuse a screened live answer whose $cut ended before its handler",
    ({ cut }) =>
      Effect.gen(function* () {
        const screened = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const hold = { on: false };
        return yield* withProject(
          verifyCommands.passes,
          (world) =>
            withEndpoint(
              driver,
              (endpoint) =>
                Effect.gen(function* () {
                  const author = yield* world.start;
                  const managed = yield* manage(world, author.deliveryId, { holding: true });
                  const child = yield* delegateFrom(author.threadId, author.runId);
                  const answer = answering(
                    yield* endpoint.callerOn(author.threadId),
                    child.childThreadId,
                  );
                  const live = yield* asked(world, child.runId, "live");
                  const request = yield* requestOf(child.childThreadId, live);
                  const before = yield* threadProjection(child.childThreadId);

                  hold.on = true;
                  const call = yield* answer(live).pipe(Effect.forkChild);
                  yield* Deferred.await(screened);
                  if (cut === "session") {
                    if (request.responseCapability.type !== "live") {
                      return assert.fail("The question is not live.");
                    }
                    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
                    yield* sessions.release({
                      providerSessionId: request.responseCapability
                        .providerSessionId as ProviderSessionId,
                      reason: "manual_shutdown",
                    });
                  } else {
                    yield* world.provider.endTurn(turnOf(world, child.runId), "cancelled");
                    yield* runReached(child.runId, ended);
                  }
                  yield* drainOrchestration;
                  yield* Deferred.succeed(resume, undefined);
                  const answered = yield* Fiber.join(call);
                  // Core refused it: no provider response, no message and no run.
                  assert.isTrue(answered.isError, answered.text);
                  yield* drainOrchestration;
                  assert.strictEqual(respondedTo(world, live), 0);
                  const after = yield* threadProjection(child.childThreadId);
                  assert.strictEqual(after.messages.length, before.messages.length);
                  assert.strictEqual(after.runs.length, before.runs.length);
                  assert.notStrictEqual(
                    after.runtimeRequests.find(({ id }) => id === live)?.status,
                    "resolved",
                  );
                  assert.deepStrictEqual(yield* governedMessages(managed.root), []);
                }).pipe(Effect.ensuring(Deferred.succeed(resume, undefined))),
              {
                // The bridge's own decision, then a hold before the handler runs.
                policy: (policy) => ({
                  ...policy,
                  screen: (input) =>
                    Effect.tap(policy.screen(input), (decision) =>
                      hold.on && decision.type === "allow"
                        ? Deferred.succeed(screened, undefined).pipe(
                            Effect.andThen(Deferred.await(resume)),
                          )
                        : Effect.void,
                    ),
                }),
              },
            ),
          { handoff: {}, automaticTurnGate: true },
        );
      }),
    240_000,
  );

  it.live(
    "answers as today for the owner, outside clients, unmanaged threads and owner agents",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          withEndpoint(driver, (endpoint) =>
            Effect.gen(function* () {
              // No assistant manages this delivery.
              const author = yield* world.start;
              const child = yield* delegateFrom(author.threadId, author.runId);
              const fromParent = yield* asked(world, child.runId, "message");
              const fromOwner = yield* asked(world, child.runId, "message");
              const fromOutside = yield* asked(world, child.runId, "message");
              const live = yield* asked(world, child.runId, "live");
              // The parent's agent continues a live question.
              yield* continuedOnce(
                world,
                answering(yield* endpoint.callerOn(author.threadId), child.childThreadId),
                child.childThreadId,
                live,
              );
              // With the child's turn over, message answers start turns as they always have.
              yield* world.provider.endTurn(turnOf(world, child.runId), "completed");
              yield* runReached(child.runId, ["waiting", ...ended]);
              yield* drainOrchestration;
              yield* drainFactory;
              const answeredBy = (requestId: RuntimeRequestId) =>
                threadProjection(child.childThreadId).pipe(
                  Effect.map(({ messages }) =>
                    messages.some(({ id }) => id === `async-answer:${requestId}`),
                  ),
                  Effect.orDie,
                );
              const parentAnswer = yield* answering(
                yield* endpoint.callerOn(author.threadId),
                child.childThreadId,
              )(fromParent);
              assert.isFalse(parentAnswer.isError, parentAnswer.text);
              assert.isTrue(yield* answeredBy(fromParent));
              // The owner's client answers through its own command, as the web client does.
              const orchestrator = yield* Orchestrator.OrchestratorV2;
              yield* orchestrator
                .dispatch({
                  type: "runtime-request.respond",
                  commandId: CommandId.make("owner-answer"),
                  threadId: child.childThreadId,
                  requestId: fromOwner,
                  answers: { format: "CSV" },
                })
                .pipe(Effect.orDie);
              assert.isTrue(yield* answeredBy(fromOwner));
              const outside = yield* endpoint.outsideClient;
              const outsideAnswer = yield* outside.call("t3_pending_request_respond", {
                threadId: child.childThreadId,
                requestId: fromOutside,
                answers: { format: "CSV" },
              });
              assert.isFalse(outsideAnswer.isError, outsideAnswer.text);
              assert.isTrue(yield* answeredBy(fromOutside));

              // An agent on an ordinary owner thread answers its own thread's question.
              const folder = `${world.root}-owner`;
              yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
                fileSystem.makeDirectory(folder, { recursive: true }),
              ).pipe(Effect.orDie);
              const ownerThread = yield* world.ownerThreadAt(folder, "Plan the export with me.");
              const own = yield* asked(world, ownerThread.runId, "live");
              yield* continuedOnce(
                world,
                answering(yield* endpoint.callerOn(ownerThread.threadId), ownerThread.threadId),
                ownerThread.threadId,
                own,
              );
            }),
          ),
        { handoff: {}, automaticTurnGate: true },
      ),
    240_000,
  );
});
