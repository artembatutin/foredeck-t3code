import { assert, describe, it } from "@effect/vitest";
import { AuthWorkReadScope, AuthWorkWriteScope, MessageId } from "@t3tools/contracts";
import type { RunId, ThreadId } from "@t3tools/contracts";
import {
  type FactoryCommand,
  type FactoryDeliveryId,
  FactoryTaskId,
} from "@t3tools/contracts/fd/factory";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import type * as ProcessRunner from "../../processRunner.ts";
import { type WorkActor, WorkService, workItemScopeFingerprint } from "../work-management/index.ts";
import * as FactoryAdmission from "./FactoryAdmission.ts";
import { childDeliveryId } from "./FactoryChildren.ts";
import { launchThreadId } from "./FactoryThreadEffects.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import type { FactoryDeliveryState } from "./pipeline/state.ts";
import { childItemFingerprint } from "./plan/childItem.ts";
import { renderAuthorPrompt } from "./prompts/author.ts";
import { renderPlanPrompt } from "./prompts/plan.ts";
import {
  authorCommits,
  drainFactory,
  git,
  stateOf,
  threadProjection,
  verifyCommands,
  type World,
  withProject,
} from "./testkit/deliveryHarness.ts";
import { awaitedRun, passingReview, reviewPasses } from "./testkit/followThrough.ts";

/**
 * The opening of each launch of a root a manager governs, on the server's real stack: a Git
 * project with a Markdown Work source, the fake provider and the server's own process runs. The
 * manager is a test port that records each opening it is asked about. A new worktree's launch is
 * made without its opening and asked about only once its workspace is ready; an existing
 * worktree's is asked about before it is made; a child's says whether its item still says what
 * its frozen task does. Turns never render the item and are never asked about. Nothing sleeps:
 * every step drains, and a launch the test must reach first waits for admission.
 */

type Opening = FactoryAdmission.FactoryOpening;
type OpeningDecision = FactoryAdmission.FactoryOpeningDecision;
type Entry = FactoryAdmission.FactoryAdmissionEntry;

const allow: OpeningDecision = { type: "allow" };
const scopeChanged: OpeningDecision = { type: "refuse", category: "scope_changed" };
const proceed: FactoryAdmission.FactoryAdmissionDecision = { type: "proceed" };
const defer: FactoryAdmission.FactoryAdmissionDecision = { type: "defer" };
const scopeChangedText = FactoryAdmission.admissionRefusalText.scope_changed;

/**
 * A manager that manages every root: it admits each effect with `control.enter`, and answers each
 * opening it is asked about, recorded in order, with `control.decide`. A test changes both as it
 * goes.
 */
const managingPort = () => {
  const asked: Array<Opening> = [];
  const control: {
    enter: (entry: Entry) => FactoryAdmission.FactoryAdmissionDecision;
    decide: (opening: Opening) => OpeningDecision;
  } = { enter: () => proceed, decide: () => allow };
  const port: typeof FactoryAdmission.FactoryAdmission.Service = {
    ...FactoryAdmission.FactoryAdmission.defaultValue(),
    management: () => Effect.succeed("active"),
    enter: (entry) => Effect.sync(() => control.enter(entry)),
    authorizeOpening: (opening) =>
      Effect.sync(() => {
        asked.push(opening);
        return control.decide(opening);
      }),
  };
  return { asked, control, port };
};

/**
 * Refuses what a manager that authorized the root's `authorized` scope refuses: a child whose item
 * no longer says what its task does, or a root read that says something else.
 */
const asAuthorized =
  (authorized: string) =>
  (opening: Opening): OpeningDecision =>
    opening.childScopeMatches === false ||
    (opening.childScopeMatches === undefined && opening.fingerprint !== authorized)
      ? scopeChanged
      : allow;

const owner: WorkActor = {
  id: "session:owner",
  grants: [AuthWorkReadScope, AuthWorkWriteScope],
  label: "owner",
};
const service = Factory.FactoryService.FactoryService;

const readItem = (ref: WorkItemRef) =>
  Effect.flatMap(WorkService.WorkService, (work) => work.getItem(owner, { ref })).pipe(
    Effect.orDie,
  );
/** What the item says now, as its manager fingerprints it. */
const scopeOf = (ref: WorkItemRef) => Effect.map(readItem(ref), workItemScopeFingerprint);

/** Changes what the item says through Work, as its owner does in Work. */
const editItem = (ref: WorkItemRef, patch: { readonly title?: string; readonly body?: string }) =>
  Effect.gen(function* () {
    const work = yield* WorkService.WorkService;
    const current = yield* work.getItem(owner, { ref });
    yield* work.updateItem(owner, { ref, expectedRevision: current.revision, ...patch });
  }).pipe(Effect.orDie);

/** The thread's shell; null when no thread has that id. */
const shellOf = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadShell(threadId),
  ).pipe(Effect.orDie);

const storedDelivery = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (store) => store.get(deliveryId)).pipe(
    Effect.orDie,
    Effect.map(Option.getOrThrow),
  );

const frozenTasks = (deliveryId: FactoryDeliveryId) =>
  Effect.flatMap(FactoryTaskStore.FactoryTaskStore, (store) =>
    store.listByDelivery(deliveryId),
  ).pipe(Effect.orDie);

const launchMessageId = (deliveryId: FactoryDeliveryId, effectId: number) =>
  MessageId.make(`factory-launch-message:${deliveryId}:${effectId}`);

/** The block of a delivery whose effect failed, such as a launch whose opening was refused. */
const failedEffect = (state: FactoryDeliveryState) =>
  state.status === "blocked" && state.block?.reason === "effect_failed"
    ? state.block
    : assert.fail(`The delivery is ${state.status}, not blocked by a failed effect.`);

/** The child delivery approval stored for the plan task `taskId`. */
const childOf = (parentId: FactoryDeliveryId, taskId: string) =>
  childDeliveryId(parentId, FactoryTaskId.make(taskId));

/** The text of the provider turn that started the run. */
const turnText = (world: World, runId: RunId) =>
  (
    world.provider.started.find((turn) => turn.runId === runId) ??
    assert.fail(`No provider turn started run ${runId}.`)
  ).message.text;

/** The message a run carries, by its id, as the thread records it. */
const runMessageId = (threadId: ThreadId, runId: RunId) =>
  threadProjection(threadId).pipe(
    Effect.orDie,
    Effect.map(({ runs }) => runs.find((run) => run.id === runId)?.userMessageId),
  );

/** A command that runs `script` with the current Node executable, as Factory runs commands. */
const node = (script: string): FactoryCommand => ({
  executable: process.execPath,
  args: ["-e", script],
});
const isRun = (input: ProcessRunner.ProcessRunInput, command: FactoryCommand) =>
  input.command === command.executable &&
  JSON.stringify(input.args) === JSON.stringify(command.args);

/** Passes once the branch has committed `fixed.txt`, so a delivery gets one fix-verify round. */
const verifyUntilFixed = node(`process.exit(require("node:fs").existsSync("fixed.txt") ? 0 : 3)`);
const identity = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];
const commitFixed = (worktreePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFileString(path.join(worktreePath, "fixed.txt"), "fixed\n");
    yield* git(worktreePath, ["add", "-A"]);
    yield* git(worktreePath, [...identity, "commit", "--no-verify", "-m", "fix: pass the checks"]);
  }).pipe(Effect.orDie);

const fenced = (value: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

const blockingReview = {
  verdict: "changes-required",
  findings: [
    {
      id: "empty-table",
      severity: "high",
      required: true,
      file: "export.ts",
      line: 1,
      detail: "An empty table exports no header row.",
    },
  ],
  acceptance: passingReview().acceptance,
  missing_evidence: [],
};

const oneTask = {
  tasks: [
    {
      id: "export-csv",
      title: "Export the current table as CSV",
      kind: "feature",
      summary: "Add a CSV export of the visible rows behind the export button.",
      acceptance: ["The export button downloads the visible rows as CSV."],
      testPlan: [{ criterion: 1, check: "Export two rows.", paths: ["export.test.ts"] }],
      likelyPaths: ["export.ts"],
      risk: "normal",
    },
  ],
  note: "One task changes the export module.",
};
const twoTasks = {
  tasks: [
    ...oneTask.tasks,
    {
      id: "export-header",
      title: "Write a header row first",
      kind: "fix",
      summary: "Spreadsheets read the first record as column names without a header row.",
      acceptance: ["The CSV starts with the column names."],
      testPlan: [{ criterion: 1, check: "Read the first line.", paths: ["export.test.ts"] }],
      likelyPaths: ["export.ts"],
      risk: "normal",
    },
  ],
  note: "Both tasks change the export module.",
};

/** Starts a parent and approves `plan` at its gate once its planner submitted it. */
const approvedParent = (world: World, plan: typeof oneTask) =>
  Effect.gen(function* () {
    const factory = yield* service;
    const planner = yield* world.startWith({ kind: "parent" });
    yield* factory.submitPlan({ threadId: planner.threadId, plan });
    yield* world.endRun(planner.runId, "completed");
    assert.strictEqual((yield* stateOf(planner.deliveryId)).status, "waiting");
    yield* factory.approvePlan(planner.deliveryId);
    yield* drainFactory;
    return planner.deliveryId;
  }).pipe(Effect.orDie);

describe("a managed root's new-worktree launches", () => {
  it.live.each([
    ["with", true],
    ["without", false],
  ] as const)(
    "launch the author %s setup without its opening, then ask: a refusal sends none, and a resume asks again and sends it once",
    ([, withSetup]) => {
      const manager = managingPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* service;
            const order: Array<"setup" | "ask"> = [];
            if (withSetup) {
              const setup = node(`console.log("set up")`);
              const settings = yield* Factory.FactorySettings.FactorySettings;
              const current = yield* settings.get(world.projectId);
              yield* settings.set(world.projectId, { ...current, setupCommand: setup });
              world.processes.around = (input, run) =>
                isRun(input, setup)
                  ? Effect.sync(() => order.push("setup")).pipe(Effect.andThen(run(input)))
                  : run(input);
            }
            let refusals = 1;
            manager.control.decide = () => {
              order.push("ask");
              refusals -= 1;
              return refusals >= 0 ? scopeChanged : allow;
            };
            const authorized = yield* scopeOf(world.itemRef);

            const { deliveryId } = yield* factory.start({ itemRef: world.itemRef });
            yield* drainFactory;
            const threadId = launchThreadId(deliveryId, 1);

            // Asked once the new worktree was prepared (and set up), with the very read the
            // opening renders; refused, the thread holds the worktree and nothing else.
            assert.strictEqual(
              failedEffect(yield* stateOf(deliveryId)).detail,
              `Factory did not launch the author thread. ${scopeChangedText}`,
            );
            const refused = yield* threadProjection(threadId).pipe(Effect.orDie);
            const worktreePath = refused.thread.worktreePath ?? assert.fail("No worktree.");
            assert.isTrue(yield* world.exists(worktreePath));
            assert.deepStrictEqual(refused.messages, []);
            assert.deepStrictEqual(refused.runs, []);
            assert.deepStrictEqual(world.provider.started, []);
            assert.deepStrictEqual(order, withSetup ? ["setup", "ask"] : ["ask"]);
            const { status } = yield* readItem(world.itemRef);
            assert.deepStrictEqual(manager.asked, [
              { root: deliveryId, deliveryId, role: "author", fingerprint: authorized, status },
            ]);

            // The resume replays the same launch, asks again and sends the opening once.
            yield* factory.resume(deliveryId);
            const author = yield* world.launched(deliveryId);
            assert.strictEqual(author.threadId, threadId);
            assert.strictEqual(author.worktreePath, worktreePath);
            assert.deepStrictEqual(
              order,
              withSetup ? ["setup", "ask", "setup", "ask"] : ["ask", "ask"],
            );
            assert.deepStrictEqual(manager.asked, [manager.asked[0], manager.asked[0]]);
            const state = yield* stateOf(deliveryId);
            assert.strictEqual(state.threads.author, threadId);
            const opening = renderAuthorPrompt({
              item: yield* readItem(world.itemRef),
              branch: state.branch,
            });
            const thread = yield* threadProjection(threadId).pipe(Effect.orDie);
            assert.deepStrictEqual(
              thread.messages.map(({ id, text }) => ({ id, text })),
              [{ id: launchMessageId(deliveryId, 1), text: opening }],
            );
            assert.deepStrictEqual(
              thread.runs.map(({ id, userMessageId }) => ({ id, userMessageId })),
              [{ id: author.runId, userMessageId: launchMessageId(deliveryId, 1) }],
            );
            assert.deepStrictEqual(
              world.provider.started.map(({ runId }) => runId),
              [author.runId],
            );
          }).pipe(Effect.orDie),
        { admission: manager.port },
      );
    },
  );

  it.live(
    "launch a parent's planner without its opening, then ask: a refusal blocks planning, and a resume plans with one opening",
    () => {
      const manager = managingPort();
      let refusals = 1;
      manager.control.decide = () => {
        refusals -= 1;
        return refusals >= 0 ? scopeChanged : allow;
      };
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* service;
            const authorized = yield* scopeOf(world.itemRef);
            const { deliveryId } = yield* factory.start({ itemRef: world.itemRef, kind: "parent" });
            yield* drainFactory;
            const threadId = launchThreadId(deliveryId, 1);

            const blocked = yield* stateOf(deliveryId);
            assert.strictEqual(blocked.stage, "plan");
            assert.strictEqual(
              failedEffect(blocked).detail,
              `Factory did not launch the planner thread. ${scopeChangedText}`,
            );
            const refused = yield* threadProjection(threadId).pipe(Effect.orDie);
            assert.isNotNull(refused.thread.worktreePath);
            assert.deepStrictEqual(refused.messages, []);
            assert.deepStrictEqual(world.provider.started, []);
            const { status } = yield* readItem(world.itemRef);
            const expected = {
              root: deliveryId,
              deliveryId,
              role: "planner",
              fingerprint: authorized,
              status,
            } as const;
            assert.deepStrictEqual(manager.asked, [expected]);

            yield* factory.resume(deliveryId);
            const planner = yield* world.launched(deliveryId);
            assert.strictEqual(planner.threadId, threadId);
            assert.deepStrictEqual(manager.asked, [expected, expected]);
            const state = yield* stateOf(deliveryId);
            assert.strictEqual(state.threads.planner, threadId);
            const thread = yield* threadProjection(threadId).pipe(Effect.orDie);
            assert.deepStrictEqual(
              thread.messages.map(({ id, text }) => ({ id, text })),
              [
                {
                  id: launchMessageId(deliveryId, 1),
                  text: renderPlanPrompt({
                    item: yield* readItem(world.itemRef),
                    branch: state.branch,
                  }),
                },
              ],
            );
            assert.deepStrictEqual(
              world.provider.started.map(({ runId }) => runId),
              [planner.runId],
            );
          }).pipe(Effect.orDie),
        { admission: manager.port },
      );
    },
  );
});

describe("a manager that cannot be read", () => {
  it.live.each([
    ["whether the root is managed", "management"],
    ["its answer about the opening", "authorizeOpening"],
  ] as const)(
    "sends no opening when Factory cannot read %s, and blocks naming only the failure",
    ([, unread]) => {
      const manager = managingPort();
      const unreadable = (root: FactoryDeliveryId) =>
        Effect.fail(
          new FactoryAdmission.FactoryAdmissionReadError({
            root,
            cause: new Error("manager store unavailable"),
          }),
        );
      const port: typeof FactoryAdmission.FactoryAdmission.Service =
        unread === "management"
          ? { ...manager.port, management: unreadable }
          : { ...manager.port, authorizeOpening: (opening) => unreadable(opening.root) };
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* service;
            const { deliveryId } = yield* factory.start({ itemRef: world.itemRef });
            yield* drainFactory;

            assert.strictEqual(
              failedEffect(yield* stateOf(deliveryId)).detail,
              "Factory could not launch the author thread (FactoryAdmissionReadError).",
            );
            assert.deepStrictEqual(world.provider.started, []);
            const shell = yield* shellOf(launchThreadId(deliveryId, 1));
            if (unread === "management") {
              // Read first, before anything is launched.
              assert.isNull(shell);
            } else {
              // Asked once the workspace was ready: the thread holds no message.
              const thread = yield* threadProjection(launchThreadId(deliveryId, 1)).pipe(
                Effect.orDie,
              );
              assert.deepStrictEqual(thread.messages, []);
            }
          }).pipe(Effect.orDie),
        { admission: port },
      );
    },
  );
});

describe("a managed root's existing-worktree launches", () => {
  it.live(
    "ask before a single item's reviewer is launched, with the root's fingerprint, and launch none when refused",
    () => {
      const manager = managingPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* service;
            const authorized = yield* scopeOf(world.itemRef);
            manager.control.decide = asAuthorized(authorized);
            const author = yield* world.start;
            const { deliveryId } = author;
            const { title } = yield* readItem(world.itemRef);

            // The owner changes the item while the author works; verify passes the commit.
            yield* editItem(world.itemRef, { title: "Add the export and import buttons" });
            const edited = yield* scopeOf(world.itemRef);
            yield* authorCommits(author.worktreePath, "feat: add the export button");
            yield* world.endRun(author.runId, "completed");

            const blocked = failedEffect(yield* stateOf(deliveryId));
            assert.strictEqual(
              blocked.detail,
              `Factory did not launch the reviewer thread. ${scopeChangedText}`,
            );
            assert.isNull(yield* shellOf(launchThreadId(deliveryId, blocked.effect.id)));
            const { status } = yield* readItem(world.itemRef);
            assert.deepStrictEqual(manager.asked, [
              { root: deliveryId, deliveryId, role: "author", fingerprint: authorized, status },
              { root: deliveryId, deliveryId, role: "reviewer", fingerprint: edited, status },
            ]);
            assert.deepStrictEqual(
              world.provider.started.map(({ threadId }) => threadId),
              [author.threadId],
            );

            // Restored to what was authorized, a resume verifies again and launches the reviewer.
            yield* editItem(world.itemRef, { title });
            yield* factory.resume(deliveryId);
            yield* drainFactory;
            const reviewer = yield* awaitedRun(deliveryId);
            assert.notStrictEqual(reviewer.threadId, author.threadId);
            assert.deepStrictEqual(manager.asked.at(-1), {
              root: deliveryId,
              deliveryId,
              role: "reviewer",
              fingerprint: authorized,
              status,
            });
            assert.strictEqual(manager.asked.length, 3);
          }).pipe(Effect.orDie),
        { admission: manager.port },
      );
    },
  );

  it.live(
    "ask before a child's author is launched: one whose item changed after approval is refused, and once restored, Factory's notes included, it matches",
    () => {
      const manager = managingPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* service;
            manager.control.decide = asAuthorized(yield* scopeOf(world.itemRef));
            // The first child's launch waits for admission, so the owner can change its item.
            let held = true;
            manager.control.enter = (entry) =>
              held && entry.effectType === "launch_thread" && entry.deliveryId !== entry.root
                ? defer
                : proceed;
            const parentId = yield* approvedParent(world, twoTasks);
            const first = childOf(parentId, twoTasks.tasks[0]!.id);
            const second = childOf(parentId, twoTasks.tasks[1]!.id);
            assert.deepStrictEqual((yield* stateOf(first)).admissionWait, { effectId: 1 });
            const childRef = (yield* storedDelivery(first)).itemRef;
            const { title, status } = yield* readItem(childRef);
            const [firstTask, secondTask] = yield* frozenTasks(parentId);
            const approvedScope = (task: FactoryTaskStore.StoredFactoryTask | undefined) =>
              childItemFingerprint({
                parent: world.itemRef,
                deliveryId: parentId,
                task: task?.plan ?? assert.fail("A task has no plan."),
              });
            assert.strictEqual(yield* scopeOf(childRef), approvedScope(firstTask));

            yield* editItem(childRef, { title: "Export every table as CSV" });
            const edited = yield* scopeOf(childRef);
            held = false;
            assert.strictEqual(yield* factory.redispatch(first, 1), "dispatched");
            yield* drainFactory;

            assert.strictEqual(
              failedEffect(yield* stateOf(first)).detail,
              `Factory did not launch the author thread. ${scopeChangedText}`,
            );
            // Asked before the launch: no thread was made.
            assert.isNull(yield* shellOf(launchThreadId(first, 1)));
            const child = { root: parentId, deliveryId: first, status } as const;
            assert.deepStrictEqual(manager.asked.at(-1), {
              ...child,
              role: "author",
              fingerprint: edited,
              childScopeMatches: false,
            });

            // Restored as approved, the item keeps the comment Factory posted on its block.
            yield* editItem(childRef, { title });
            const restored = yield* readItem(childRef);
            assert.include(restored.body, "## Notes");
            assert.include(restored.body, "Factory is blocked on this item and needs you.");
            assert.strictEqual(workItemScopeFingerprint(restored), approvedScope(firstTask));
            yield* factory.resume(first);
            const author = yield* world.launched(first);
            assert.strictEqual(author.threadId, launchThreadId(first, 1));
            const matched = {
              ...child,
              fingerprint: approvedScope(firstTask),
              childScopeMatches: true,
            };
            assert.deepStrictEqual(manager.asked.at(-1), { ...matched, role: "author" });

            // Its reviewer, and the next child, unedited, match too.
            yield* authorCommits(author.worktreePath, "feat: export the table as CSV", "0\n");
            yield* world.endRun(author.runId, "completed");
            yield* reviewPasses(world, first);
            assert.strictEqual((yield* stateOf(first)).status, "approved");
            const next = yield* world.launched(second);
            const { status: nextStatus } = yield* readItem((yield* storedDelivery(second)).itemRef);
            assert.deepStrictEqual(manager.asked.slice(-2), [
              { ...matched, role: "reviewer" },
              {
                root: parentId,
                deliveryId: second,
                status: nextStatus,
                role: "author",
                fingerprint: approvedScope(secondTask),
                childScopeMatches: true,
              },
            ]);
            assert.strictEqual(next.threadId, launchThreadId(second, 1));
          }).pipe(Effect.orDie),
        { admission: manager.port },
      );
    },
  );

  it.live(
    "ask before a child's reviewer is launched: one whose item changed before its review is refused",
    () => {
      const manager = managingPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            manager.control.decide = asAuthorized(yield* scopeOf(world.itemRef));
            const parentId = yield* approvedParent(world, oneTask);
            const first = childOf(parentId, oneTask.tasks[0]!.id);
            const author = yield* world.launched(first);
            const childRef = (yield* storedDelivery(first)).itemRef;
            assert.isTrue(manager.asked.at(-1)?.childScopeMatches);

            const current = yield* readItem(childRef);
            yield* editItem(childRef, { body: `${current.body}\nAlso export the hidden rows.\n` });
            const edited = yield* readItem(childRef);
            yield* authorCommits(author.worktreePath, "feat: export the table as CSV", "0\n");
            yield* world.endRun(author.runId, "completed");

            const blocked = failedEffect(yield* stateOf(first));
            assert.strictEqual(
              blocked.detail,
              `Factory did not launch the reviewer thread. ${scopeChangedText}`,
            );
            assert.isNull(yield* shellOf(launchThreadId(first, blocked.effect.id)));
            assert.deepStrictEqual(manager.asked.at(-1), {
              root: parentId,
              deliveryId: first,
              role: "reviewer",
              fingerprint: workItemScopeFingerprint(edited),
              status: edited.status,
              childScopeMatches: false,
            });
            assert.deepStrictEqual(
              world.provider.started.map(({ threadId }) => threadId),
              [launchThreadId(parentId, 1), author.threadId],
            );
          }).pipe(Effect.orDie),
        { admission: manager.port },
      );
    },
  );

  it.live(
    "ask before a parent's integrate reviewer with the parent's own fingerprint, which renders only the frozen tasks",
    () => {
      const manager = managingPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const parentId = yield* approvedParent(world, oneTask);
            const first = childOf(parentId, oneTask.tasks[0]!.id);
            // The plan stored in the parent's state says what its frozen task row does not.
            const unfrozen = "Every export holds a totals row.";
            yield* sql`
              UPDATE fd_factory_deliveries
              SET state_json = json_set(state_json, '$.plan.tasks[0].acceptance[0]', ${unfrozen})
              WHERE delivery_id = ${parentId}
            `;
            assert.strictEqual((yield* stateOf(parentId)).plan?.tasks[0]?.acceptance[0], unfrozen);

            const author = yield* world.launched(first);
            yield* authorCommits(author.worktreePath, "feat: export the table as CSV", "0\n");
            yield* world.endRun(author.runId, "completed");
            yield* reviewPasses(world, first);
            const parent = yield* stateOf(parentId);
            assert.strictEqual(parent.stage, "integrate");
            const integrate = yield* awaitedRun(parentId);

            const { status } = yield* readItem(world.itemRef);
            assert.deepStrictEqual(manager.asked.at(-1), {
              root: parentId,
              deliveryId: parentId,
              role: "reviewer",
              fingerprint: yield* scopeOf(world.itemRef),
              status,
            });
            const text = turnText(world, integrate.runId);
            const [row] = yield* frozenTasks(parentId);
            const criterion = row?.plan?.acceptance[0] ?? assert.fail("No frozen criterion.");
            assert.strictEqual(criterion, oneTask.tasks[0]!.acceptance[0]);
            assert.include(text, `- Criterion 1: ${criterion}`);
            assert.notInclude(text, unfrozen);
            // The openings of the planner, the child's author and reviewer, and integrate.
            assert.deepStrictEqual(
              manager.asked.map(({ deliveryId, role }) => [deliveryId, role]),
              [
                [parentId, "planner"],
                [first, "author"],
                [first, "reviewer"],
                [parentId, "reviewer"],
              ],
            );
          }).pipe(Effect.orDie),
        { admission: manager.port },
      );
    },
  );
});

describe("a managed root's turns", () => {
  /**
   * Changes what the item says each time, so that a turn rendering it would show the change; the
   * markers it used, for checking that none shows.
   */
  const scopeEdits = (ref: WorkItemRef) => {
    const markers: Array<string> = [];
    return {
      markers,
      edit: Effect.suspend(() => {
        const marker = `Scope edit ${markers.length + 1}`;
        markers.push(marker);
        return editItem(ref, { title: `${marker} title`, body: `${marker} body.` });
      }),
    };
  };

  it.live(
    "render no item scope in a single item's fix-commit, fix-verify, review retry, fix-review and follow-up turns, and are never asked about",
    () => {
      const manager = managingPort();
      return withProject(
        verifyUntilFixed,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* service;
            const { title: original } = yield* readItem(world.itemRef);
            const edits = scopeEdits(world.itemRef);
            /** The run's turn carries a Factory message of `kind` and none of the item's text. */
            const assertTurn = (threadId: ThreadId, runId: RunId, kind: string) =>
              Effect.gen(function* () {
                const messageId = yield* runMessageId(threadId, runId);
                assert.match(messageId ?? "", new RegExp(`^factory-${kind}-message:`));
                const text = turnText(world, runId);
                assert.notInclude(text, original);
                for (const marker of edits.markers) assert.notInclude(text, marker);
              });

            const author = yield* world.start;
            const { deliveryId } = author;
            yield* edits.edit;
            // The author's turn ends without a commit: a fix-commit turn.
            yield* world.endRun(author.runId, "completed");
            const fixCommit = yield* awaitedRun(deliveryId);
            assert.strictEqual(fixCommit.threadId, author.threadId);
            yield* assertTurn(author.threadId, fixCommit.runId, "fix-commit");

            // It commits, and verify fails: a fix-verify turn.
            yield* edits.edit;
            yield* authorCommits(author.worktreePath, "feat: add the export button");
            yield* world.endRun(fixCommit.runId, "completed");
            const fixVerify = yield* awaitedRun(deliveryId);
            yield* assertTurn(author.threadId, fixVerify.runId, "fix-verify");

            // Fixed, verify passes and the reviewer launches: the second opening asked about.
            yield* edits.edit;
            yield* commitFixed(author.worktreePath);
            yield* world.endRun(fixVerify.runId, "completed");
            const reviewer = yield* awaitedRun(deliveryId);
            assert.strictEqual(manager.asked.length, 2);

            // The reviewer answers with an invalid review: a review retry turn.
            yield* edits.edit;
            const reviewTurn =
              world.provider.started.find(({ runId }) => runId === reviewer.runId) ??
              assert.fail("The reviewer's turn did not start.");
            yield* world.provider.say(reviewTurn, fenced({ verdict: "maybe" }));
            yield* world.endRun(reviewer.runId, "completed");
            const retry = yield* awaitedRun(deliveryId);
            assert.strictEqual(retry.threadId, reviewer.threadId);
            yield* assertTurn(reviewer.threadId, retry.runId, "review-retry");

            // It requires changes: a fix-review turn on the author's thread.
            yield* edits.edit;
            yield* factory.submitReview({ threadId: reviewer.threadId, review: blockingReview });
            yield* world.endRun(retry.runId, "completed");
            const fixReview = yield* awaitedRun(deliveryId);
            assert.strictEqual(fixReview.threadId, author.threadId);
            yield* assertTurn(author.threadId, fixReview.runId, "fix-review");

            // The fix passes verify: the next review round is a follow-up on the reviewer.
            yield* edits.edit;
            yield* authorCommits(author.worktreePath, "fix: export a header row", "x = 2;\n");
            yield* world.endRun(fixReview.runId, "completed");
            const followUp = yield* awaitedRun(deliveryId);
            assert.strictEqual(followUp.threadId, reviewer.threadId);
            yield* assertTurn(reviewer.threadId, followUp.runId, "review-follow-up");

            assert.deepStrictEqual(
              manager.asked.map(({ role }) => role),
              ["author", "reviewer"],
            );
          }).pipe(Effect.orDie),
        { admission: manager.port },
      );
    },
  );

  it.live(
    "render no item scope in a parent's plan retry and replan turns, and are never asked about",
    () => {
      const manager = managingPort();
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const factory = yield* service;
            const { title: original } = yield* readItem(world.itemRef);
            const edits = scopeEdits(world.itemRef);
            const assertTurn = (threadId: ThreadId, runId: RunId, kind: string) =>
              Effect.gen(function* () {
                const messageId = yield* runMessageId(threadId, runId);
                assert.match(messageId ?? "", new RegExp(`^factory-${kind}-message:`));
                const text = turnText(world, runId);
                assert.notInclude(text, original);
                for (const marker of edits.markers) assert.notInclude(text, marker);
                return text;
              });

            const planner = yield* world.startWith({ kind: "parent" });
            const { deliveryId, threadId } = planner;
            // The planner answers with an invalid plan: a plan retry turn.
            yield* edits.edit;
            const planTurn =
              world.provider.started.find(({ runId }) => runId === planner.runId) ??
              assert.fail("The planner's turn did not start.");
            yield* world.provider.say(planTurn, fenced({ tasks: "none" }));
            yield* world.endRun(planner.runId, "completed");
            const retry = yield* awaitedRun(deliveryId);
            assert.strictEqual(retry.threadId, threadId);
            yield* assertTurn(threadId, retry.runId, "plan-retry");

            // A valid plan waits at the gate; the owner sends it back: a replan turn.
            yield* edits.edit;
            yield* factory.submitPlan({ threadId, plan: oneTask });
            yield* world.endRun(retry.runId, "completed");
            assert.strictEqual((yield* stateOf(deliveryId)).status, "waiting");
            yield* edits.edit;
            yield* factory.replan({ deliveryId, note: "Keep the header with the export." });
            yield* drainFactory;
            const replan = yield* awaitedRun(deliveryId);
            const text = yield* assertTurn(threadId, replan.runId, "replan");
            assert.include(text, "> Keep the header with the export.");

            assert.deepStrictEqual(
              manager.asked.map(({ role }) => role),
              ["planner"],
            );
          }).pipe(Effect.orDie),
        { admission: manager.port },
      );
    },
  );
});
