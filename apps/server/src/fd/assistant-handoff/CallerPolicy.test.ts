import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import type * as McpCallerPolicy from "../../mcp/McpCallerPolicy.ts";
import type * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { HandoffAdmission, HandoffBackend } from "../assistant/index.ts";
import { FactoryActivity, FactoryService } from "../factory/index.ts";
import * as CallerPolicy from "./CallerPolicy.ts";
import { callerToolClass } from "./callerTools.ts";

/**
 * The caller policy's decisions over the reads it takes, each stubbed: who a thread belongs to,
 * its root's management and slot, whose a request is, and the root's Work item.
 */

const root = FactoryDeliveryId.make("delivery-root");
const otherRoot = FactoryDeliveryId.make("delivery-other");
const author = ThreadId.make("factory-thread:delivery-root:1");
const child = ThreadId.make("thread-child");
const outsider = ThreadId.make("thread-outsider");
const factoryRun = RunId.make("run-factory");
const item = {
  sourceId: WorkSourceId.make("6f9b1d2c-1a2b-4c3d-8e4f-5a6b7c8d9e0f"),
  itemId: WorkItemId.make("item"),
};
const text = CallerPolicy.callerPolicyText;

type Ownership = FactoryActivity.FactoryRequestOwnership;

/** A pending live question of a non-terminal Factory run of the root, on the delegated child. */
const liveQuestion: Ownership = {
  root,
  request: { status: "pending", kind: "user_input", capability: "live", runId: factoryRun },
  run: { status: "running", class: "factory" },
};

interface World {
  management: HandoffAdmission.Management;
  slot: "held" | "reserved" | "none";
  ownership: Ownership;
  delegation: HandoffAdmission.DelegationDecision;
  /** Which read fails, if any. */
  failing?: "family" | "management" | "ownership" | "slot" | "work";
}

const reads = { family: 0, ownership: 0, work: 0 };
const authorizedItem: HandoffBackend.HandoffItem = {
  ref: item,
  key: "TASK-1",
  url: null,
  title: "Add the export button",
  status: "todo",
  revision: "1",
  invalid: false,
  body: "",
  fingerprint: "authorized",
  notes: "",
};
const dispatches: Array<{ readonly interruptible: boolean | undefined }> = [];
const admitted: HandoffAdmission.Admitted = {
  admissionId: "admission",
  root,
  assignmentId: "assignment",
  kind: "delegation",
  entrySeq: 4,
};

const readFailure = (threadId: ThreadId) =>
  new FactoryActivity.FactoryOwnershipReadError({ threadId, cause: "unreadable" });
const admissionFailure = (target: string) =>
  new HandoffAdmission.HandoffAdmissionError({ operation: "read", root: target, cause: "unread" });

/** The admission as the policy reads it, over `world`. */
const admissionOver = (world: World) =>
  Layer.mock(HandoffAdmission.HandoffAdmission)({
    instanceId: "instance",
    management: (target) =>
      world.failing === "management"
        ? Effect.fail(admissionFailure(target))
        : Effect.succeed(world.management),
    slot: (target) =>
      world.failing === "slot" ? Effect.fail(admissionFailure(target)) : Effect.succeed(world.slot),
    admitDelegation: (input) =>
      Effect.succeed(
        input.work === undefined && world.delegation.type === "admitted"
          ? ({ type: "needs_work", item } as const)
          : world.delegation,
      ),
    dispatchAdmitted: (decide, dispatch, options) =>
      Effect.flatMap(decide, (decision) =>
        Effect.sync(() => dispatches.push({ interruptible: options?.interruptible })).pipe(
          Effect.andThen(
            decision.admitted === undefined
              ? Effect.succeed({ decision, value: Option.none() })
              : Effect.map(dispatch(decision.admitted), (value) => ({
                  decision,
                  value: Option.some(value),
                })),
          ),
        ),
      ),
  });

const layerOver = (
  world: World,
  admission: Layer.Layer<HandoffAdmission.HandoffAdmission> = admissionOver(world),
) =>
  Layer.mergeAll(
    Layer.mock(FactoryService.FactoryService)({
      familyRoot: (threadId) =>
        Effect.suspend(() => {
          reads.family += 1;
          return world.failing === "family"
            ? Effect.fail(readFailure(threadId))
            : Effect.succeed(threadId === outsider ? null : root);
        }),
      requestOwnership: ({ threadId }) =>
        Effect.suspend(() => {
          reads.ownership += 1;
          return world.failing === "ownership"
            ? Effect.fail(readFailure(threadId))
            : Effect.succeed(world.ownership);
        }),
    }),
    admission,
    Layer.mock(HandoffBackend.HandoffBackend)({
      fingerprint: () => "authorized",
      read: () =>
        Effect.suspend(() => {
          reads.work += 1;
          return world.failing === "work"
            ? Effect.fail(
                new HandoffBackend.HandoffBackendError({
                  operation: "read",
                  reason: "unavailable",
                }),
              )
            : Effect.succeed(authorizedItem);
        }),
    }),
  );

const withPolicy = <A, E>(
  world: World,
  body: (policy: typeof McpCallerPolicy.McpCallerPolicy.Service) => Effect.Effect<A, E>,
  admission?: Layer.Layer<HandoffAdmission.HandoffAdmission>,
) =>
  Effect.gen(function* () {
    reads.family = 0;
    reads.ownership = 0;
    reads.work = 0;
    dispatches.length = 0;
    return yield* body(yield* CallerPolicy.make);
  }).pipe(Effect.provide(layerOver(world, admission)));

const active: World = {
  management: "active",
  slot: "held",
  ownership: liveQuestion,
  delegation: { type: "admitted", admitted },
};

const caller = (threadId: ThreadId): McpInvocationContext.McpThreadCaller => ({
  threadId,
  providerSessionId: `session:${threadId}`,
  providerInstanceId: ProviderInstanceId.make("codex"),
});

const scopeOf = (threadId: ThreadId | undefined): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "namespace",
  thread: threadId === undefined ? undefined : caller(threadId),
  client:
    threadId === undefined ? { sessionId: "session", label: "Outside", access: "auto" } : undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const screen = (
  world: World,
  threadId: ThreadId,
  calls: ReadonlyArray<McpCallerPolicy.McpToolCall>,
) => withPolicy(world, (policy) => policy.screen({ caller: caller(threadId), calls }));

const call = (tool: string, args: unknown = {}): McpCallerPolicy.McpToolCall => ({
  tool,
  arguments: args,
});
const answer = (args: Record<string, unknown> = { threadId: child, requestId: "request" }) =>
  call("t3_pending_request_respond", args);

const refused = (message: string) => ({ type: "refuse" as const, text: message });
const allowed = { type: "allow" as const };

describe("the caller policy's screen", () => {
  it.effect("reads nothing for tools it always allows", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* screen(active, author, [call("work_read"), call("t3_thread_read")]),
        allowed,
      );
      assert.deepStrictEqual(reads, { family: 0, ownership: 0, work: 0 });
    }),
  );

  it.effect("leaves callers outside every managed family as they are", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* screen(active, outsider, [call("t3_thread_send")]), allowed);
      assert.deepStrictEqual(
        yield* screen({ ...active, management: "never" }, author, [call("t3_thread_send")]),
        allowed,
      );
      assert.deepStrictEqual(
        yield* screen({ ...active, management: "never" }, author, [answer()]),
        allowed,
      );
    }),
  );

  it.effect.each([
    "t3_thread_send",
    "t3_thread_send_attachments",
    "t3_thread_launch",
    "create_threads",
    "schedule_task",
    "update_scheduled_task",
    "run_scheduled_task_now",
    "t3_worktree_handoff",
    "t3_thread_fork",
    "t3_thread_merge_back",
    "t3_queue_edit",
    "t3_queue_promote_to_steer",
    "watch_pull_request",
    "work_start_thread",
    "factory_deliver",
    "voice_reply",
    "assistant_assign",
    "assistant_some_future_tool",
    "a_tool_nobody_listed",
  ])("refuses %s by the root's management", (tool) =>
    Effect.gen(function* () {
      assert.strictEqual(callerToolClass(tool), "refuse");
      assert.deepStrictEqual(yield* screen(active, author, [call(tool)]), refused(text.active));
      for (const management of ["ending", "retired"] as const) {
        assert.deepStrictEqual(
          yield* screen({ ...active, management }, author, [call(tool)]),
          refused(text.retired),
        );
      }
    }),
  );

  it.effect("passes delegate_task to its bracket only while the root is active", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* screen(active, author, [call("delegate_task")]), allowed);
      for (const management of ["ending", "retired"] as const) {
        assert.deepStrictEqual(
          yield* screen({ ...active, management }, author, [call("delegate_task")]),
          refused(text.retired),
        );
      }
    }),
  );

  it.effect("refuses a batch whole by its first refused call", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* screen(active, author, [call("work_read"), call("t3_thread_launch"), answer()]),
        refused(text.active),
      );
      assert.deepStrictEqual(
        yield* screen({ ...active, slot: "none" }, author, [answer(), call("t3_thread_send")]),
        refused(text.liveOnly(child)),
      );
    }),
  );

  it.effect("allows only live questions of counted runs of the root, under a held slot", () =>
    Effect.gen(function* () {
      for (const management of ["active", "ending"] as const) {
        const world = { ...active, management };
        assert.deepStrictEqual(yield* screen(world, author, [answer()]), allowed, management);
        // Unknown work under the slot is counted too.
        assert.deepStrictEqual(
          yield* screen(
            {
              ...world,
              ownership: { ...liveQuestion, run: { status: "waiting", class: "unknown" } },
            },
            author,
            [answer()],
          ),
          allowed,
        );
        const liveOnly = refused(text.liveOnly(child));
        for (const ownership of [
          { ...liveQuestion, run: { status: "running", class: "explicit" } },
          { ...liveQuestion, run: { status: "completed", class: "factory" } },
          { ...liveQuestion, run: null },
          { ...liveQuestion, request: { ...liveQuestion.request!, status: "resolved" } },
          { ...liveQuestion, request: { ...liveQuestion.request!, capability: "not_resumable" } },
          { ...liveQuestion, request: { ...liveQuestion.request!, kind: "approval" } },
          { ...liveQuestion, request: null },
        ] as ReadonlyArray<Ownership>) {
          assert.deepStrictEqual(
            yield* screen({ ...world, ownership }, author, [answer()]),
            liveOnly,
          );
        }
        for (const slot of ["reserved", "none"] as const) {
          assert.deepStrictEqual(yield* screen({ ...world, slot }, author, [answer()]), liveOnly);
        }
      }
    }),
  );

  it.effect("refuses an answer that would start a turn whatever else holds", () =>
    Effect.gen(function* () {
      const message: Ownership = {
        ...liveQuestion,
        request: { ...liveQuestion.request!, capability: "message" },
      };
      for (const management of ["active", "ending"] as const) {
        for (const slot of ["held", "reserved", "none"] as const) {
          for (const run of [liveQuestion.run, { status: "completed", class: "explicit" }, null]) {
            assert.deepStrictEqual(
              yield* screen(
                { ...active, management, slot, ownership: { ...message, run } as Ownership },
                author,
                [answer()],
              ),
              refused(text.message(child)),
            );
          }
        }
      }
    }),
  );

  it.effect("refuses answers outside the root's family, and every answer once it retired", () =>
    Effect.gen(function* () {
      for (const ownership of [
        { ...liveQuestion, root: otherRoot },
        { ...liveQuestion, root: null },
      ]) {
        assert.deepStrictEqual(
          yield* screen({ ...active, ownership }, author, [answer()]),
          refused(text.family),
        );
      }
      const message: Ownership = {
        ...liveQuestion,
        request: { ...liveQuestion.request!, capability: "message" },
      };
      for (const ownership of [liveQuestion, message]) {
        assert.deepStrictEqual(
          yield* screen({ ...active, management: "retired", ownership }, author, [answer()]),
          refused(text.retired),
        );
      }
      // A retired root's answers are refused before whose they are is read.
      assert.strictEqual(reads.ownership, 0);
    }),
  );

  it.effect("judges an answer with no thread named on the caller's own thread", () =>
    Effect.gen(function* () {
      const message: Ownership = {
        ...liveQuestion,
        request: { ...liveQuestion.request!, capability: "message" },
      };
      assert.deepStrictEqual(
        yield* screen({ ...active, ownership: message }, author, [
          answer({ requestId: "request" }),
        ]),
        refused(text.message(author)),
      );
      // An answer that names no request is not one the policy can confirm continues a run.
      assert.deepStrictEqual(
        yield* screen(active, author, [answer({ threadId: child })]),
        refused(text.liveOnly(child)),
      );
    }),
  );

  it.effect.each(["family", "management", "ownership", "slot"] as const)(
    "refuses with the read-failure text when the %s read fails",
    (failing) =>
      Effect.gen(function* () {
        const world = { ...active, failing };
        assert.deepStrictEqual(yield* screen(world, author, [answer()]), refused(text.readFailure));
        if (failing === "family" || failing === "management") {
          assert.deepStrictEqual(
            yield* screen(world, author, [call("t3_thread_send")]),
            refused(text.readFailure),
          );
          assert.deepStrictEqual(
            yield* screen(world, author, [call("delegate_task")]),
            refused(text.readFailure),
          );
        }
      }),
  );
});

const delegate = (world: World, threadId: ThreadId | undefined) =>
  withPolicy(world, (policy) =>
    Effect.gen(function* () {
      let ran = 0;
      const result = yield* policy
        .delegation(
          scopeOf(threadId),
          Effect.sync(() => {
            ran += 1;
            return "child";
          }),
        )
        .pipe(Effect.result);
      return { result, ran, dispatches: [...dispatches], work: reads.work };
    }),
  );

/** The policy's refusal of a delegation, or undefined when it did not refuse. */
const failureOf = <A>(result: Result.Result<A, OrchestratorMcpFailure>) =>
  Result.isFailure(result) ? result.failure : undefined;

describe("the caller policy's delegation", () => {
  it.effect("runs the handler as it is outside every managed family", () =>
    Effect.gen(function* () {
      for (const [world, threadId] of [
        [active, undefined],
        [active, outsider],
        [{ ...active, management: "never" }, author],
      ] as const) {
        const outcome = yield* delegate(world, threadId);
        assert.strictEqual(outcome.ran, 1);
        assert.deepStrictEqual(outcome.dispatches, []);
      }
    }),
  );

  it.effect("admits an active root's delegation on a fresh read, under its slot", () =>
    Effect.gen(function* () {
      const outcome = yield* delegate(active, author);
      assert.isTrue(Result.isSuccess(outcome.result));
      assert.strictEqual(outcome.ran, 1);
      assert.strictEqual(outcome.work, 1);
      // Admitted and run in the admission's bracket, with the handler left interruptible.
      assert.deepStrictEqual(outcome.dispatches, [{ interruptible: true }]);
    }),
  );

  it.effect.each([
    ["not_holding", text.notHolding],
    ["revoked", "The project assistant no longer authorizes this delivery."],
    ["scope_changed", "The Work item changed after the project assistant authorized it."],
    ["unreadable", "The Work item could not be read"],
    ["item_closed", "The Work item is done or cancelled."],
    ["ended", text.retired],
  ] as const)("refuses %s with its text and runs nothing", ([category, expected]) =>
    Effect.gen(function* () {
      const outcome = yield* delegate(
        { ...active, delegation: { type: "refused", category } },
        author,
      );
      assert.strictEqual(outcome.ran, 0);
      const failure = failureOf(outcome.result);
      assert.strictEqual(failure?.code, "capability_denied");
      assert.include(failure?.message, expected);
    }),
  );

  it.effect.each(["ending", "retired"] as const)(
    "refuses a %s root's delegation before admitting anything",
    (management) =>
      Effect.gen(function* () {
        const outcome = yield* delegate({ ...active, management }, author);
        assert.strictEqual(outcome.ran, 0);
        assert.deepStrictEqual(outcome.dispatches, []);
        const failure = failureOf(outcome.result);
        assert.strictEqual(failure?.code, "capability_denied");
        assert.strictEqual(failure?.message, text.retired);
      }),
  );

  it.effect.each(["family", "management"] as const)(
    "refuses when the %s read fails, running nothing",
    (failing) =>
      Effect.gen(function* () {
        const outcome = yield* delegate({ ...active, failing }, author);
        assert.strictEqual(outcome.ran, 0);
        const failure = failureOf(outcome.result);
        assert.strictEqual(failure?.code, "orchestration_error");
        assert.strictEqual(failure?.message, text.readFailure);
      }),
  );

  it.effect("takes a failed Work read as unreadable for the admission to judge", () =>
    Effect.gen(function* () {
      const seen: Array<HandoffAdmission.WorkRead | undefined> = [];
      const world: World = { ...active, failing: "work" };
      const outcome = yield* withPolicy(
        world,
        (policy) => policy.delegation(scopeOf(author), Effect.succeed("child")).pipe(Effect.result),
        Layer.mock(HandoffAdmission.HandoffAdmission)({
          instanceId: "instance",
          management: () => Effect.succeed("active" as const),
          admitDelegation: (input) =>
            Effect.sync(() => seen.push(input.work)).pipe(
              Effect.as(
                input.work === undefined
                  ? ({ type: "needs_work", item } as const)
                  : ({ type: "refused", category: "unreadable" } as const),
              ),
            ),
          dispatchAdmitted: (decide) =>
            Effect.map(decide, (decision) => ({ decision, value: Option.none() })),
        }),
      );
      assert.deepStrictEqual(seen, [undefined, { type: "unreadable" }]);
      assert.strictEqual(failureOf(outcome)?.code, "capability_denied");
    }),
  );
});
