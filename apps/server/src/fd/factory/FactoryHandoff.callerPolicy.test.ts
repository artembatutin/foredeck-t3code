import { assert, describe, it } from "@effect/vitest";
import {
  AuthWorkReadScope,
  AuthWorkWriteScope,
  type MessageId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { HandoffAdmission, ProjectAssistant } from "../assistant/index.ts";
import * as AssistantHandoff from "../assistant-handoff/index.ts";
import { type WorkActor, type WorkDomainError, WorkService } from "../work-management/index.ts";
import * as Factory from "./index.ts";
import {
  admissionsOf,
  demandsOf,
  driver,
  endManagement,
  fill,
  governedMessages,
  type Managed,
  manage,
  release,
  runsOf,
  slotOf,
  writtenRows,
} from "./testkit/handoff.ts";
import { delegateFrom, providerTurnRunning } from "./testkit/familyThreads.ts";
import { awaitedRun, editTaskFile, openSingle, reviewPasses } from "./testkit/followThrough.ts";
import { type McpCaller, withEndpoint } from "./testkit/mcpEndpoint.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  ended,
  runReached,
  threadProjection,
  verifyCommands,
  withProject,
  type World,
} from "./testkit/deliveryHarness.ts";

/**
 * Agents on the threads of a Factory delivery the project assistant manages, calling T3's tools
 * through the authenticated MCP endpoint on the server's real stack: what would start, message,
 * schedule, hand off or watch work is refused before its handler runs and writes nothing, and a
 * delegation runs only under the delivery's slot. Everyone else's agents and clients are as
 * before.
 */

const text = AssistantHandoff.callerPolicyText;

const owner: WorkActor = {
  id: "session:owner",
  grants: [AuthWorkReadScope, AuthWorkWriteScope],
  label: "owner",
};

class FakeWorkUnavailable extends Schema.TaggedError<FakeWorkUnavailable>()("WorkUnavailable", {
  detail: Schema.String,
}) {}

const edited = "Add the export button and a CSV option";
const retitle = (from: string, to: string) => (body: string) =>
  body.replace(`title: ${from}`, `title: ${to}`);

/** Every tool that starts, messages, schedules, hands off or watches work, as an agent calls it. */
const runCreatingCalls = (
  world: World,
  targets: { readonly own: ThreadId; readonly family: ThreadId; readonly owner: ThreadId },
): ReadonlyArray<readonly [string, Record<string, unknown>]> => {
  const threads = [targets.own, targets.family, targets.owner];
  const item = `${world.itemRef.sourceId}:${world.itemRef.itemId}`;
  return [
    ...threads.flatMap((threadId) =>
      (["queue", "auto", "steer", "restart"] as const).map(
        (mode) => ["t3_thread_send", { threadId, message: "Check it once more.", mode }] as const,
      ),
    ),
    ...threads.map(
      (threadId) =>
        [
          "t3_thread_send_attachments",
          { threadId, message: "See the log.", attachmentIds: ["upload-1"] },
        ] as const,
    ),
    ["t3_thread_launch", { projectId: world.projectId, message: "Start a side task." }],
    ["create_threads", { threads: [{ title: "Side task", message: "Start a side task." }] }],
    ["schedule_task", { title: "Nightly", prompt: "Deliver the next item.", cron: "0 3 * * *" }],
    ["update_scheduled_task", { taskId: "task-1", prompt: "Deliver everything." }],
    ["run_scheduled_task_now", { taskId: "task-1" }],
    ["t3_worktree_handoff", { mode: "worktree" }],
    ["t3_thread_fork", { threadId: targets.own, sourcePoint: { type: "latest" } }],
    [
      "t3_thread_merge_back",
      {
        sourceThreadId: targets.own,
        targetThreadId: targets.owner,
        sourcePoint: { type: "latest" },
      },
    ],
    ["t3_queue_edit", { threadId: targets.family, queuedRunId: "run-1", text: "Changed." }],
    [
      "t3_queue_promote_to_steer",
      { threadId: targets.family, queuedRunId: "run-1", targetRunId: "run-2" },
    ],
    ["watch_pull_request", { threadId: targets.own, number: 7 }],
    ["work_start_thread", { item, mode: "implement" }],
    ["factory_deliver", { item }],
    ["voice_reply", { text: "Done." }],
    ["assistant_assign", { assignmentId: "side", projectId: world.projectId, ideaId: "side" }],
    ["assistant_capture_work", { projectId: world.projectId, ideaId: "side", kind: "single" }],
    ["assistant_portfolio", {}],
    ["a_tool_nobody_published", {}],
  ];
};

/** Calls each tool as `caller` and expects the policy's `refusal` for every one. */
const refusesAll = (
  caller: McpCaller,
  calls: ReadonlyArray<readonly [string, Record<string, unknown>]>,
  refusal: string,
) =>
  Effect.forEach(
    calls,
    ([tool, args]) =>
      caller
        .call(tool, args)
        .pipe(
          Effect.map((answer) =>
            assert.deepStrictEqual(
              answer,
              { isError: true, text: refusal },
              `${tool} on ${caller.threadId}`,
            ),
          ),
        ),
    { discard: true },
  );

/** The owner withdraws, or gives back, the execution grant on the managed idea's brief. */
const authorize = (world: World, managed: Managed, executionAuthorized: boolean) =>
  Effect.flatMap(ProjectAssistant.ProjectAssistant, (assistant) =>
    assistant.revise({
      projectId: world.projectId,
      ideaId: managed.ideaId,
      patch: { executionAuthorized },
    }),
  ).pipe(Effect.orDie);

const childrenOf = (threadId: ThreadId) =>
  threadProjection(threadId).pipe(
    Effect.map(({ subagents }) => subagents.length),
    Effect.orDie,
  );

/**
 * What an agent's send could have left, however its target's turn ended: a message with one of
 * its texts anywhere, a run that message started (a queued turn, or the follow-up core runs for a
 * steer that missed its turn), a steer effect queued on one of the threads, or the receipt of
 * core's steer follow-up there.
 */
const sendTraces = (texts: ReadonlyArray<string>, threadIds: ReadonlyArray<ThreadId>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const messages = yield* sql<{
      readonly message_id: string;
      readonly text: string | null;
    }>`SELECT message_id, json_extract(payload_json, '$.text') AS text
      FROM orchestration_v2_projection_messages`;
    const steers = yield* sql<{ readonly effect_id: string }>`SELECT effect_id
      FROM orchestration_v2_effect_outbox
      WHERE effect_type = 'provider-turn.steer' AND thread_id IN ${sql.in(threadIds)}`;
    const followUps = yield* sql<{ readonly command_id: string }>`SELECT command_id
      FROM orchestration_v2_command_receipts
      WHERE command_id LIKE 'command:steer-follow-up:%' AND thread_id IN ${sql.in(threadIds)}`;
    const sent = messages
      .filter((row) => row.text !== null && texts.includes(row.text))
      .map((row) => row.message_id);
    const runs = yield* sql<{ readonly run_id: string; readonly message_id: string | null }>`
      SELECT run_id, json_extract(payload_json, '$.userMessageId') AS message_id
      FROM orchestration_v2_projection_runs`;
    return {
      messages: sent,
      runs: runs
        .filter((row) => row.message_id !== null && sent.includes(row.message_id))
        .map((row) => row.run_id),
      steers: steers.map((row) => row.effect_id),
      followUps: followUps.map((row) => row.command_id),
    };
  }).pipe(Effect.orDie);

const noTraces = { messages: [], runs: [], steers: [], followUps: [] };

const runStatus = (threadId: ThreadId, runId: RunId) =>
  threadProjection(threadId).pipe(
    Effect.map(
      ({ runs }) =>
        runs.find((run) => run.id === runId)?.status ?? assert.fail(`Run ${runId} is gone.`),
    ),
    Effect.orDie,
  );

const recordedTurn = (threadId: ThreadId, messageId: MessageId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`SELECT * FROM fd_factory_automatic_turns
      WHERE thread_id = ${threadId} AND message_id = ${messageId}`,
  ).pipe(Effect.orDie);

describe("governed callers of a managed delivery's threads", () => {
  it.live(
    "refuses every run-creating tool to an active root's author and child, and writes nothing",
    () => {
      const failing = { on: false };
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            const managed = yield* manage(world, author.deliveryId, { holding: true });
            const child = yield* delegateFrom(author.threadId, author.runId);
            const matrix = (callers: ReadonlyArray<McpCaller>) =>
              Effect.forEach(
                callers,
                (caller) =>
                  refusesAll(
                    caller,
                    runCreatingCalls(world, {
                      own: caller.threadId,
                      family:
                        caller.threadId === author.threadId ? child.childThreadId : author.threadId,
                      owner: managed.manager,
                    }),
                    text.active,
                  ),
                { discard: true },
              );
            /** The matrix again under `condition`, with every row as it was before it. */
            const unchangedBy = (callers: ReadonlyArray<McpCaller>, label: string) =>
              Effect.gen(function* () {
                const before = yield* writtenRows;
                yield* matrix(callers);
                // A retry under the same request id is refused the same way.
                for (const _ of [1, 2]) {
                  assert.deepStrictEqual(
                    yield* callers[0]!.call("t3_thread_send", {
                      threadId: author.threadId,
                      message: "Once more.",
                      mode: "auto",
                      clientRequestId: "retry-1",
                    }),
                    { isError: true, text: text.active },
                  );
                }
                yield* drainOrchestration;
                assert.deepStrictEqual(yield* writtenRows, before, label);
              });

            yield* withEndpoint(driver, (endpoint) =>
              Effect.gen(function* () {
                const callers = [
                  yield* endpoint.callerOn(author.threadId),
                  yield* endpoint.callerOn(child.childThreadId),
                ];
                yield* unchangedBy(callers, "holding");
                // Full capacity, a withdrawn grant, an edited item and an unreadable one: the
                // same refusal, read from nothing but who the caller is.
                yield* fill(world, 1);
                yield* unchangedBy(callers, "full capacity");
                yield* authorize(world, managed, false);
                yield* unchangedBy(callers, "revoked");
                yield* authorize(world, managed, true);
                yield* editTaskFile(world, world.itemRef, retitle(world.itemTitle, edited));
                yield* unchangedBy(callers, "edited");
                failing.on = true;
                yield* unchangedBy(callers, "unreadable");
              }),
            );
            assert.deepStrictEqual(yield* governedMessages(managed.root), []);

            // A rebuilt server refuses them the same way, with fresh credentials.
            yield* world.rebuild(
              withEndpoint(driver, (endpoint) =>
                Effect.gen(function* () {
                  yield* unchangedBy(
                    [
                      yield* endpoint.callerOn(author.threadId),
                      yield* endpoint.callerOn(child.childThreadId),
                    ],
                    "rebuilt",
                  );
                  yield* drainFactory;
                  assert.deepStrictEqual(yield* governedMessages(managed.root), []);
                }),
              ),
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
    300_000,
  );

  it.live(
    "refuses the reviewer, and once the root ends every family agent, an owner's turn's included",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          withEndpoint(driver, (endpoint) =>
            Effect.gen(function* () {
              const author = yield* world.start;
              const managed = yield* manage(world, author.deliveryId, { holding: true });
              const authorAgent = yield* endpoint.callerOn(author.threadId);
              const callsFrom = (own: ThreadId, family: ThreadId) =>
                runCreatingCalls(world, { own, family, owner: managed.manager });

              // Auto mode while the agent's own turn completes: refused before anything is
              // queued or steered, so no follow-up appears once the turn has ended.
              assert.deepStrictEqual(
                yield* authorAgent.call("t3_thread_send", {
                  threadId: author.threadId,
                  message: "And a CSV option.",
                  mode: "auto",
                }),
                { isError: true, text: text.active },
              );
              const authorMessages = (yield* threadProjection(author.threadId)).messages.length;
              yield* authorCommits(author.worktreePath, "feat: add the export button");
              yield* world.endRun(author.runId, "completed");
              const reviewer = yield* awaitedRun(author.deliveryId);
              const afterEnd = yield* threadProjection(author.threadId);
              assert.isTrue(
                afterEnd.messages
                  .slice(authorMessages)
                  .every((message) => message.createdBy !== "agent"),
              );
              assert.deepStrictEqual(yield* governedMessages(managed.root), []);

              const reviewerAgent = yield* endpoint.callerOn(reviewer.threadId);
              const rows = yield* writtenRows;
              yield* refusesAll(
                reviewerAgent,
                callsFrom(reviewer.threadId, author.threadId),
                text.active,
              );
              assert.deepStrictEqual(yield* writtenRows, rows);

              // Once the root ends, every family agent is refused with the ended text,
              // delegate_task included.
              const endedCalls = (own: ThreadId, family: ThreadId) => [
                ...callsFrom(own, family),
                ["delegate_task", { task: "Check the export." }] as const,
              ];
              yield* endManagement(managed.root, "ending");
              const ending = yield* writtenRows;
              yield* refusesAll(
                reviewerAgent,
                endedCalls(reviewer.threadId, author.threadId),
                text.retired,
              );
              assert.deepStrictEqual(yield* writtenRows, ending);

              // The owner's own turn on the author thread runs, and its agent holds the thread's
              // credential: refused all the same.
              yield* world.ownerTurn(author.threadId, "Rename the button.");
              const ownerAgent = yield* endpoint.callerOn(author.threadId);
              for (const state of ["ending", "retired"] as const) {
                if (state === "retired") yield* endManagement(managed.root, state);
                const before = yield* writtenRows;
                yield* refusesAll(
                  ownerAgent,
                  endedCalls(author.threadId, reviewer.threadId),
                  text.retired,
                );
                yield* refusesAll(
                  reviewerAgent,
                  endedCalls(reviewer.threadId, author.threadId),
                  text.retired,
                );
                yield* drainOrchestration;
                assert.deepStrictEqual(yield* writtenRows, before, state);
              }
              assert.deepStrictEqual(yield* governedMessages(managed.root), []);
            }),
          ),
        { handoff: {}, automaticTurnGate: true },
      ),
    300_000,
  );

  it.live(
    "refuses a governed auto send while its target's turn completes, held either side of the send",
    () =>
      Effect.gen(function* () {
        const screened = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const hold = { on: false };
        return yield* withProject(
          verifyCommands.passes,
          (world) =>
            Effect.gen(function* () {
              const author = yield* world.start;
              const managed = yield* manage(world, author.deliveryId, { holding: true });
              const child = yield* delegateFrom(author.threadId, author.runId);
              yield* providerTurnRunning(author.threadId);
              const duringCompletion = "Also add a CSV option, while the turn completes.";
              const acrossCompletion = "Also check the header row, as the review completes.";
              const texts = [duringCompletion, acrossCompletion];
              let reviewerThread: ThreadId | undefined;

              yield* withEndpoint(
                driver,
                (endpoint) =>
                  Effect.gen(function* () {
                    const authorAgent = yield* endpoint.callerOn(author.threadId);
                    const childAgent = yield* endpoint.callerOn(child.childThreadId);
                    const send = (caller: McpCaller, threadId: ThreadId, message: string) =>
                      caller.call("t3_thread_send", { threadId, message, mode: "auto" });

                    // (A) The provider has reported the end of the author's turn, and core's
                    // finishing of the run is held behind a Deferred: the turn is completing.
                    yield* authorCommits(author.worktreePath, "feat: add the export button");
                    const turn =
                      world.provider.started.find(
                        (candidate) => candidate.runId === author.runId,
                      ) ?? assert.fail("The author's turn did not start.");
                    yield* world.provider.endTurn(turn, "completed");
                    yield* runReached(author.runId, ["waiting", ...ended]);
                    const gate = yield* Deferred.make<void>();
                    const completion = yield* Deferred.await(gate).pipe(
                      Effect.andThen(drainOrchestration),
                      Effect.andThen(drainFactory),
                      Effect.forkChild,
                    );
                    assert.strictEqual(yield* runStatus(author.threadId, author.runId), "waiting");
                    const held = yield* writtenRows;
                    // The agent's own completing turn, and the same turn from a family thread.
                    for (const caller of [authorAgent, childAgent]) {
                      assert.deepStrictEqual(
                        yield* send(caller, author.threadId, duringCompletion),
                        { isError: true, text: text.active },
                        caller.threadId,
                      );
                    }
                    assert.deepStrictEqual(yield* writtenRows, held);
                    assert.strictEqual(yield* runStatus(author.threadId, author.runId), "waiting");
                    // The completion goes on: nothing the sends could have queued follows it.
                    yield* Deferred.succeed(gate, undefined);
                    yield* Fiber.join(completion);
                    assert.strictEqual(
                      yield* runStatus(author.threadId, author.runId),
                      "completed",
                    );
                    const reviewer = yield* awaitedRun(author.deliveryId);
                    reviewerThread = reviewer.threadId;
                    yield* drainOrchestration;
                    assert.deepStrictEqual(
                      yield* sendTraces(texts, [author.threadId, reviewer.threadId]),
                      noTraces,
                    );

                    // (B) The send to the reviewer's running turn is held right after the screen
                    // decided, while that turn completes and Factory records and publishes it.
                    hold.on = true;
                    const call = yield* send(authorAgent, reviewer.threadId, acrossCompletion).pipe(
                      Effect.forkChild,
                    );
                    yield* Deferred.await(screened);
                    hold.on = false;
                    yield* reviewPasses(world, author.deliveryId);
                    assert.strictEqual(
                      yield* runStatus(reviewer.threadId, reviewer.runId),
                      "completed",
                    );
                    const settled = yield* writtenRows;
                    yield* Deferred.succeed(resume, undefined);
                    assert.deepStrictEqual(yield* Fiber.join(call), {
                      isError: true,
                      text: text.active,
                    });
                    yield* drainOrchestration;
                    yield* drainFactory;
                    assert.deepStrictEqual(yield* writtenRows, settled);
                    assert.deepStrictEqual(
                      yield* sendTraces(texts, [author.threadId, reviewer.threadId]),
                      noTraces,
                    );
                    assert.deepStrictEqual(yield* governedMessages(managed.root), []);
                  }).pipe(Effect.ensuring(Deferred.succeed(resume, undefined))),
                {
                  // The bridge's own decision, then a hold before the endpoint answers.
                  policy: (policy) => ({
                    ...policy,
                    screen: (input) =>
                      Effect.tap(policy.screen(input), () =>
                        hold.on
                          ? Deferred.succeed(screened, undefined).pipe(
                              Effect.andThen(Deferred.await(resume)),
                            )
                          : Effect.void,
                      ),
                  }),
                },
              );

              // A rebuilt server, core's restart recovery included, finds none of it either.
              const threads = [author.threadId, reviewerThread ?? assert.fail("No reviewer ran.")];
              yield* world.rebuild(
                Effect.gen(function* () {
                  yield* drainOrchestration;
                  yield* drainFactory;
                  yield* drainOrchestration;
                  assert.deepStrictEqual(yield* sendTraces(texts, threads), noTraces);
                  assert.deepStrictEqual(yield* governedMessages(managed.root), []);
                }),
                { orchestration: true },
              );
            }),
          { handoff: {}, automaticTurnGate: true },
        );
      }),
    240_000,
  );

  it.live(
    "leaves never-managed deliveries, owner threads and outside clients as they are",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          withEndpoint(driver, (endpoint) =>
            Effect.gen(function* () {
              // No assistant manages this delivery: its author's agent sends as today.
              const author = yield* world.start;
              const authorAgent = yield* endpoint.callerOn(author.threadId);
              const sent = yield* authorAgent.call("t3_thread_send", {
                threadId: author.threadId,
                message: "Note for later.",
                mode: "queue",
              });
              assert.isFalse(sent.isError, sent.text);
              const queued = yield* runsOf(author.threadId);
              assert.strictEqual(queued.length, 2);

              // An approved outside client sends to the same thread.
              const outside = yield* endpoint.outsideClient;
              const fromOutside = yield* outside.call("t3_thread_send", {
                threadId: author.threadId,
                message: "Another note.",
                mode: "queue",
              });
              assert.isFalse(fromOutside.isError, fromOutside.text);
              assert.strictEqual((yield* runsOf(author.threadId)).length, 3);
            }),
          ),
        { handoff: {}, automaticTurnGate: true },
      ),
    180_000,
  );

  it.live(
    "runs an owner thread agent's auto send to an author turn that completes once, as the owner's",
    () =>
      withProject(
        verifyCommands.passes,
        (world) =>
          withEndpoint(driver, (endpoint) =>
            Effect.gen(function* () {
              const author = yield* world.start;
              const managed = yield* manage(world, author.deliveryId, { holding: true });
              yield* providerTurnRunning(author.threadId);
              yield* authorCommits(author.worktreePath, "feat: add the export button");
              // An agent on the owner's own thread, outside every Factory family.
              const ownerAgent = yield* endpoint.callerOn(managed.manager);
              const sent = yield* ownerAgent.call("t3_thread_send", {
                threadId: author.threadId,
                message: "Also add a CSV option.",
                mode: "auto",
              });
              assert.isFalse(sent.isError, sent.text);
              const message = (yield* threadProjection(author.threadId)).messages.find(
                (candidate) => candidate.senderThreadId === managed.manager,
              );
              if (message === undefined) return assert.fail("The send left no message.");

              // The author's turn completes before the steer reaches it: core follows it up once.
              const turn =
                world.provider.started.find((candidate) => candidate.runId === author.runId) ??
                assert.fail("The author's turn did not start.");
              yield* world.provider.endTurn(turn, "completed");
              yield* runReached(author.runId, ["waiting", ...ended]);
              yield* drainOrchestration;
              yield* drainFactory;
              yield* drainOrchestration;
              const followUps = (yield* runsOf(author.threadId)).filter(
                (run) => run.userMessageId === message.id,
              );
              assert.strictEqual(followUps.length, 1);
              // What the governed sends never leave: the message, its steer and the run it got.
              const traces = yield* sendTraces(["Also add a CSV option."], [author.threadId]);
              assert.deepStrictEqual(
                [traces.messages.length, traces.steers.length, traces.runs.length],
                [1, 1, 1],
              );
              // Run inline as the owner's: no demand, no recorded automatic turn, uncounted.
              assert.deepStrictEqual(
                (yield* demandsOf(managed.root)).filter(({ kind }) => kind !== "effect"),
                [],
              );
              assert.deepStrictEqual(yield* recordedTurn(author.threadId, message.id), []);
              assert.deepStrictEqual(yield* governedMessages(managed.root), []);

              yield* world.rebuild(
                Effect.gen(function* () {
                  yield* drainOrchestration;
                  yield* drainFactory;
                  const again = (yield* runsOf(author.threadId)).filter(
                    (run) => run.userMessageId === message.id,
                  );
                  assert.strictEqual(again.length, 1);
                  assert.deepStrictEqual(yield* governedMessages(managed.root), []);
                }),
              );
            }),
          ),
        { handoff: {}, automaticTurnGate: true },
      ),
    240_000,
  );
});

/** Holds the admitted probe of the next delegation the test asks for. */
const holdingDelegation = Effect.gen(function* () {
  const entered = yield* Deferred.make<HandoffAdmission.Admitted>();
  const go = yield* Deferred.make<void>();
  const control = { hold: false };
  const probe: typeof HandoffAdmission.HandoffAdmissionProbe.Service = {
    admitted: (admitted) =>
      control.hold && admitted.kind === "delegation"
        ? Deferred.succeed(entered, admitted).pipe(Effect.andThen(Deferred.await(go)))
        : Effect.void,
    released: () => Effect.void,
    observed: () => Effect.void,
  };
  return { entered, go, control, probe };
});

describe("delegation from a managed delivery's threads", () => {
  it.live(
    "admits a delegation only under the root's held slot, counted from its commit to its child",
    () =>
      Effect.flatMap(holdingDelegation, (held) => {
        const failing = { on: false };
        return withProject(
          verifyCommands.passes,
          (world) =>
            withEndpoint(driver, (endpoint) =>
              Effect.gen(function* () {
                const factory = yield* Factory.FactoryService.FactoryService;
                const opened = yield* openSingle(world);
                const managed = yield* manage(world, opened.deliveryId, { holding: true });
                // The owner works on the author thread, whose agent delegates from that turn.
                yield* world.ownerTurn(opened.threadId, "Look into a CSV option.");
                const agent = yield* endpoint.callerOn(opened.threadId);
                const delegate = (task: string) => agent.call("delegate_task", { task });

                held.control.hold = true;
                const call = yield* delegate("Check the CSV export.").pipe(Effect.forkChild);
                const admitted = yield* Deferred.await(held.entered);
                // From its commit, the admission keeps the slot: the release pass frees nothing.
                assert.strictEqual(yield* release(managed.root), "kept");
                const rows = yield* admissionsOf(managed.root);
                assert.deepStrictEqual(
                  rows.find(({ admission_id }) => admission_id === admitted.admissionId)?.state,
                  "dispatching",
                );
                assert.strictEqual(yield* childrenOf(opened.threadId), 0);
                held.control.hold = false;
                yield* Deferred.succeed(held.go, undefined);
                const answer = yield* Fiber.join(call);
                assert.isFalse(answer.isError, answer.text);
                yield* drainOrchestration;

                // One child, a family thread of the root, its run counted as the root's work.
                const { subagents } = yield* threadProjection(opened.threadId);
                assert.strictEqual(subagents.length, 1);
                const childThreadId =
                  subagents[0]?.childThreadId ?? assert.fail("The delegation made no thread.");
                assert.strictEqual(yield* factory.familyRoot(childThreadId), managed.root);
                assert.isAtLeast((yield* runsOf(childThreadId)).length, 1);
                assert.strictEqual(
                  (yield* admissionsOf(managed.root)).find(
                    ({ admission_id }) => admission_id === admitted.admissionId,
                  )?.state,
                  "dispatched",
                );
                const activity = yield* factory.activity(managed.root as FactoryDeliveryId);
                assert.strictEqual(activity.phase, "parked");
                assert.isTrue(activity.busy);

                // Each state that does not hold the slot under fresh authority refuses, making
                // no child and no admission.
                const refusedWith = (label: string, expected: string) =>
                  Effect.gen(function* () {
                    const before = (yield* admissionsOf(managed.root)).length;
                    const refused = yield* delegate(`Refused while ${label}.`);
                    assert.isTrue(refused.isError, label);
                    assert.include(refused.text, expected, label);
                    assert.strictEqual(yield* childrenOf(opened.threadId), 1, label);
                    assert.strictEqual((yield* admissionsOf(managed.root)).length, before, label);
                  });
                const sql = yield* SqlClient.SqlClient;
                const slot = yield* slotOf(managed.root);
                yield* sql`DELETE FROM fd_assistant_slots WHERE root_delivery_id = ${managed.root}`;
                yield* refusedWith("parked", text.notHolding);
                yield* sql`INSERT INTO fd_assistant_slots
                  (root_delivery_id, assignment_id, state, entry_seq, granted_at)
                  VALUES (${managed.root}, ${managed.assignmentId}, 'held', ${slot!.entry_seq},
                    '2026-10-29T12:00:00.000Z')`;
                yield* authorize(world, managed, false);
                yield* refusedWith(
                  "revoked",
                  Factory.FactoryAdmission.admissionRefusalText.revoked,
                );
                yield* authorize(world, managed, true);
                yield* editTaskFile(world, world.itemRef, retitle(world.itemTitle, edited));
                yield* refusedWith(
                  "edited",
                  Factory.FactoryAdmission.admissionRefusalText.scope_changed,
                );
                yield* editTaskFile(world, world.itemRef, retitle(edited, world.itemTitle));
                failing.on = true;
                yield* refusedWith(
                  "unreadable",
                  Factory.FactoryAdmission.admissionRefusalText.unreadable,
                );
                failing.on = false;
                const work = yield* WorkService.WorkService;
                yield* work.setStatus(owner, { ref: world.itemRef, status: "done" });
                yield* refusedWith(
                  "closed",
                  Factory.FactoryAdmission.admissionRefusalText.item_closed,
                );
                yield* work.setStatus(owner, { ref: world.itemRef, status: "todo" });
                for (const state of ["ending", "retired"] as const) {
                  yield* endManagement(managed.root, state);
                  yield* refusedWith(state, text.retired);
                }
              }).pipe(Effect.ensuring(Deferred.succeed(held.go, undefined))),
            ),
          {
            handoff: { probe: held.probe },
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
      }),
    300_000,
  );
});
