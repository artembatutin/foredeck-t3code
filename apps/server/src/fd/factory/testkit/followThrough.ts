import { assert } from "@effect/vitest";
import {
  AuthWorkReadScope,
  CommandId,
  MessageId,
  type PullRequestState,
  type RunId,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import type { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import type { WorkItemRef, WorkSetStatusInput } from "@t3tools/contracts/fd/work-management";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import { type WorkActor, type WorkDomainError, WorkService } from "../../work-management/index.ts";
import * as Factory from "../index.ts";
import {
  authorCommits,
  drainFactory,
  drainOrchestration,
  ended,
  runReached,
  stateOf,
  type World,
} from "./deliveryHarness.ts";

/**
 * Follow-through on the delivery harness: a delivery run to its open pull request, and the pull
 * request links core's sync writes on its threads. A link's snapshot is dispatched as the sync
 * reactor dispatches it, so Factory's reactor sees the event core commits.
 */

const service = Factory.FactoryService.FactoryService;

const reader: WorkActor = { id: "session:owner", grants: [AuthWorkReadScope], label: "owner" };

/** The fixed text of the comment a close without merging posts, before the URL and reference. */
export const closedComment =
  "Pull request #7 for this item was closed without merging, so Factory cancelled the delivery; its worktree, branch and commits stay.";

// Work's own errors are private to Work; these carry the same tags.
class FakeWorkUnavailable extends Schema.TaggedError<FakeWorkUnavailable>()("WorkUnavailable", {
  detail: Schema.String,
}) {}
class FakeWorkUnsupported extends Schema.TaggedError<FakeWorkUnsupported>()("WorkUnsupported", {
  detail: Schema.String,
}) {}

/**
 * Work recording each status it is asked to set, refusing those `fault.fails` picks, and, as
 * Jira does, refusing to set done an item that is done already; pass `work` as the harness's Work
 * option. `writes` counts the statuses it set.
 */
export const statusWrites = () => {
  const fault = { fails: (_input: WorkSetStatusInput) => false };
  const calls: Array<{ readonly actor: WorkActor; readonly input: WorkSetStatusInput }> = [];
  const written: Array<WorkSetStatusInput> = [];
  return {
    fault,
    calls,
    written,
    work: (work: WorkService.WorkService["Service"]): WorkService.WorkService["Service"] => ({
      ...work,
      setStatus: (actor, input) =>
        Effect.gen(function* () {
          calls.push({ actor, input });
          if (fault.fails(input)) {
            return yield* new FakeWorkUnavailable({
              detail: "The task file could not be written.",
            }) as unknown as WorkDomainError;
          }
          const current = yield* work.getItem(actor, { ref: input.ref });
          if (input.status === "done" && current.status === "done") {
            return yield* new FakeWorkUnsupported({
              detail: "No Jira transition reaches that status from here.",
            }) as unknown as WorkDomainError;
          }
          const updated = yield* work.setStatus(actor, input);
          written.push(input);
          return updated;
        }),
    }),
  };
};

/** A review that verifies each of `criteria` criteria and finds nothing. */
export const passingReview = (criteria = 1) => ({
  verdict: "pass",
  findings: [],
  acceptance: Array.from({ length: criteria }, (_, index) => ({
    criterion: index + 1,
    status: "verified",
    evidence: "The export does what the criterion says.",
    paths: ["export.ts"],
  })),
  missing_evidence: [],
});

/** The run the delivery awaits, once its provider turn has started. */
export const awaitedRun = (deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const { awaiting } = yield* stateOf(deliveryId);
    if (awaiting?.type !== "run") return assert.fail("The delivery awaits no run.");
    assert.strictEqual(yield* runReached(awaiting.runId, ["starting", ...ended]), "starting");
    yield* drainOrchestration;
    return awaiting;
  });

/** The reviewer the delivery awaits passes its commit, and its run completes. */
export const reviewPasses = (world: World, deliveryId: FactoryDeliveryId) =>
  Effect.gen(function* () {
    const reviewer = yield* awaitedRun(deliveryId);
    yield* Effect.flatMap(service, (factory) =>
      factory.submitReview({ threadId: reviewer.threadId, review: passingReview() }),
    );
    yield* world.endRun(reviewer.runId, "completed");
    return reviewer.threadId;
  }).pipe(Effect.orDie);

/** The author commits, verify passes and the reviewer passes it, on the delivery's threads. */
const authorAndReview = (
  world: World,
  author: { readonly deliveryId: FactoryDeliveryId; readonly runId: RunId },
  worktreePath: string,
  subject: string,
  text: string,
) =>
  Effect.gen(function* () {
    yield* authorCommits(worktreePath, subject, text);
    yield* world.endRun(author.runId, "completed");
    const reviewer = yield* awaitedRun(author.deliveryId);
    yield* Effect.flatMap(service, (factory) =>
      factory.submitReview({ threadId: reviewer.threadId, review: passingReview() }),
    );
    yield* world.endRun(reviewer.runId, "completed");
    return reviewer.threadId;
  });

/** A single item run to its open pull request, which is linked to its author thread. */
export const openSingle = (world: World) =>
  Effect.gen(function* () {
    const author = yield* world.start;
    const reviewer = yield* authorAndReview(
      world,
      author,
      author.worktreePath,
      "feat: add the export button",
      "export const x = 1;\n",
    );
    const state = yield* stateOf(author.deliveryId);
    assert.strictEqual(state.status, "pr_open");
    return { ...author, reviewer, state };
  }).pipe(Effect.orDie);

/** Two tasks, so the parent has a first child and a last one. */
const twoTaskPlan = {
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

/**
 * A parent of two children run to its open pull request, which is linked to its last child's
 * author thread. Returns each child's delivery, item and author thread, in plan order.
 */
export const openParent = (world: World) =>
  Effect.gen(function* () {
    const factory = yield* service;
    const planner = yield* world.startWith({ kind: "parent" });
    yield* factory.submitPlan({ threadId: planner.threadId, plan: twoTaskPlan });
    yield* world.endRun(planner.runId, "completed");
    yield* factory.approvePlan(planner.deliveryId);
    yield* drainFactory;
    const children = [];
    for (const [index, childId] of (yield* stateOf(planner.deliveryId)).children.entries()) {
      const author = yield* world.launched(childId);
      yield* authorAndReview(
        world,
        author,
        author.worktreePath,
        `feat: task ${index}`,
        `${index}\n`,
      );
      const child = Option.getOrThrow(yield* factory.get(childId));
      assert.strictEqual(child.state.status, "approved");
      children.push({ deliveryId: childId, itemRef: child.itemRef, author: author.threadId });
    }
    const integrate = yield* awaitedRun(planner.deliveryId);
    yield* factory.submitReview({ threadId: integrate.threadId, review: passingReview(2) });
    yield* world.endRun(integrate.runId, "completed");
    const state = yield* stateOf(planner.deliveryId);
    assert.strictEqual(state.status, "pr_open");
    return { deliveryId: planner.deliveryId, worktreePath: planner.worktreePath, children, state };
  }).pipe(Effect.orDie);

/** The thread's link to pull request `number` (at `url`, when given), as the projection has it. */
export const linkOf = (threadId: ThreadId, number: number, url?: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadShell(threadId),
  ).pipe(
    Effect.map(
      (shell) =>
        shell?.pullRequests?.find(
          (link) => link.number === number && (url === undefined || link.url === url),
        ) ?? assert.fail(`Thread ${threadId} links no pull request #${number}.`),
    ),
    Effect.orDie,
  );

let commands = 0;
const commandId = (kind: string) => CommandId.make(`test-${kind}:${(commands += 1)}`);

/** Links a pull request to the thread, as the owner would. */
export const linkPullRequest = (
  threadId: ThreadId,
  link: Pick<ThreadPullRequestLink, "host" | "repository" | "number" | "url">,
) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.pull-request.link",
      commandId: commandId("pr-link"),
      threadId,
      ...link,
      source: "manual",
    }),
  ).pipe(Effect.asVoid, Effect.orDie);

/**
 * Stores a snapshot of the linked pull request in `state` on the thread, as core's sync does, and
 * waits until Factory has handled the event it commits and everything that followed.
 */
export const syncPullRequest = (
  threadId: ThreadId,
  link: Pick<ThreadPullRequestLink, "host" | "repository" | "number">,
  state: PullRequestState,
  options: { readonly drain?: boolean } = {},
) =>
  Effect.gen(function* () {
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
      orchestrator.dispatch({
        type: "thread.pull-request-link.sync",
        commandId: commandId("pr-sync"),
        threadId,
        host: link.host,
        repository: link.repository,
        number: link.number,
        snapshot: {
          state,
          title: "Add the export button",
          headBranch: "feature/export",
          baseBranch: "main",
          isDraft: false,
          updatedAt: at,
          syncedAt: at,
          closedAt: state === "open" ? null : at,
          mergedAt: state === "merged" ? at : null,
        },
        stack: null,
      }),
    ).pipe(Effect.orDie);
    if (options.drain !== false) yield* drainFactory;
  });

let wakes = 0;

/**
 * What a watch's wake reports, as core's watch reactor sends it: checks that failed, new comments,
 * every check passing, the watch ending because the pull request could not be read, or ending
 * after too many comment-only updates (that last wake carries its comments).
 */
export type WakeReport = "checks-failed" | "remarks" | "checks-passed" | "unreadable" | "exhausted";

/**
 * Wakes the thread about the watched pull request of `link`, as core's watch reactor does: one
 * `thread.pull-request-watch.sync` recording the watch's progress, or ending it, and queuing the
 * wake message with the notification core gives that report. Returns the wake's run, which starts
 * at once on an idle thread and otherwise waits behind the thread's run.
 */
export const wakeThread = (
  threadId: ThreadId,
  link: ThreadPullRequestLink,
  report: WakeReport = "checks-failed",
) =>
  Effect.gen(function* () {
    wakes += 1;
    const watch = link.watch ?? assert.fail(`Pull request #${link.number} is not watched.`);
    const pr = `#${link.number}`;
    const reports = {
      "checks-failed": {
        watch: { ...watch, failedChecks: [...watch.failedChecks, `checks-${wakes}`] },
        outcome: "failed",
        summary: `${pr}: checks failed`,
      },
      remarks: {
        watch: { ...watch, remarkIds: [...watch.remarkIds, `remark-${wakes}`], wakes: 1 },
        outcome: "updated",
        summary: `${pr}: new comments`,
      },
      "checks-passed": {
        watch: { ...watch, passed: true, passedChecks: ["ci"] },
        outcome: "completed",
        summary: `${pr}: checks passed`,
      },
      unreadable: {
        watch: null,
        outcome: "failed",
        summary: `${pr}: stopped watching, could not read it`,
      },
      exhausted: {
        watch: null,
        outcome: "updated",
        summary: `${pr}: new comments, stopped watching`,
      },
    } as const;
    const { outcome, summary, ...next } = reports[report];
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const result = yield* orchestrator.dispatch({
      type: "thread.pull-request-watch.sync",
      commandId: CommandId.make(`server:pr-watch:${threadId}:wake-${wakes}`),
      threadId,
      host: link.host,
      repository: link.repository,
      number: link.number,
      startedAt: watch.startedAt,
      watch: next.watch,
      wake: {
        messageId: MessageId.make(`message:pr-watch:wake-${wakes}`),
        text: `Update on pull request ${pr} (${link.url}): ${summary}.`,
        notification: { source: { kind: "monitor" }, outcome, summary },
      },
    });
    const created = result.storedEvents.flatMap(({ event }) =>
      event.type === "run.created" ? [event.payload.id] : [],
    );
    return created[0] ?? assert.fail("The wake queued no run.");
  }).pipe(Effect.orDie);

/**
 * Starts or stops a watch of the linked pull request on the thread, as the owner's Watch does,
 * linking it first when the thread has not.
 */
export const watchPullRequest = (
  threadId: ThreadId,
  link: Pick<ThreadPullRequestLink, "host" | "repository" | "number" | "url">,
  watching = true,
) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: commandId("pr-watch"),
      threadId,
      host: link.host,
      repository: link.repository,
      number: link.number,
      watching,
      link: { url: link.url, source: "manual" },
    }),
  ).pipe(Effect.asVoid, Effect.orDie);

/** The item's status as Work reads it. */
export const itemStatus = (ref: WorkItemRef) =>
  Effect.flatMap(WorkService.WorkService, (work) => work.getItem(reader, { ref })).pipe(
    Effect.map((item) => item.status),
    Effect.orDie,
  );

/** The thread's shell as the projection holds it. */
export const threadShell = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadShell(threadId),
  ).pipe(
    Effect.orDie,
    Effect.map((shell) => shell ?? assert.fail(`Thread ${threadId} has no shell.`)),
  );

/**
 * Settles the thread as its owner does. Its provider stops only once core's effect worker runs
 * the detach this queues, which these tests leave queued.
 */
export const settleThread = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({ type: "thread.settle", commandId: commandId("settle"), threadId }),
  ).pipe(Effect.asVoid, Effect.orDie);

/** Unsettles the thread as its owner does. */
export const unsettleThread = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.unsettle",
      commandId: commandId("unsettle"),
      threadId,
      reason: "user",
    }),
  ).pipe(Effect.asVoid, Effect.orDie);

/**
 * Rewrites the item's task file in the project's Markdown source with `edit`, behind Work's
 * back, as a change made in the tracker itself is.
 */
export const editTaskFile = (world: World, ref: WorkItemRef, edit: (text: string) => string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(world.root, "tasks");
    for (const name of yield* fileSystem.readDirectory(directory)) {
      const file = path.join(directory, name);
      const text = yield* fileSystem.readFileString(file);
      if (!text.includes(`id: ${ref.itemId}`)) continue;
      const edited = edit(text);
      assert.notStrictEqual(edited, text);
      return yield* fileSystem.writeFileString(file, edited);
    }
    return assert.fail(`No task file holds item ${ref.itemId}.`);
  }).pipe(Effect.orDie);
