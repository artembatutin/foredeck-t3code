import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AuthWorkWriteScope, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import {
  type WorkCommentInput,
  WorkItemId,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { type WorkActor, type WorkDomainError, WorkService } from "../work-management/index.ts";
import * as FactoryPullRequest from "./FactoryPullRequest.ts";
import * as FactoryReactor from "./FactoryReactor.ts";
import * as FactoryRecord from "./FactoryRecord.ts";
import * as FactoryReview from "./FactoryReview.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as FactoryWorkComments from "./FactoryWorkComments.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import { advance } from "./pipeline/engine.ts";
import { queuedDeliveryState } from "./pipeline/state.ts";
import type { FactoryDeliveryState, FactoryEvent, FactoryRoundLimits } from "./pipeline/state.ts";
import * as FactoryEvidence from "./verify/FactoryEvidence.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";

/**
 * The Work comments a delivery's transitions post, through the real worker, engine, stores,
 * verify runner, git and reactor on in-memory SQLite, with Work and the thread effects faked.
 * Each `boot` is one server process over the test's database. Nothing sleeps: each step drains.
 */

/** What Work was asked to post, and how it answers. */
interface World {
  /** Every comment Factory asked Work to post, in order, whether or not Work took it. */
  readonly posts: Array<{ readonly actor: WorkActor; readonly input: WorkCommentInput }>;
  /** Work posts each comment, cannot reach the source, or the source refuses the comment. */
  work: "posts" | "unavailable" | "refuses";
  /** While set, every post waits for `release`; `posting` resolves once one is waiting. */
  held: {
    readonly posting: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  } | null;
  readonly warnings: Array<string>;
}

// Work's own errors are private to Work; these carry the same tags.
class FakeWorkUnavailable extends Schema.TaggedError<FakeWorkUnavailable>()("WorkUnavailable", {
  detail: Schema.String,
}) {}
class FakeWorkInvalid extends Schema.TaggedError<FakeWorkInvalid>()("WorkInvalid", {
  detail: Schema.String,
}) {}

const projectId = ProjectId.make("project-alpha");
const deliveryId = FactoryDeliveryId.make("delivery-1");
const itemRef = {
  sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
  itemId: WorkItemId.make("fd-aaaaaa"),
};
const branch = "feature/item-7";
const author = ThreadId.make("thread-author");
const authorRun = RunId.make("run-author");

const fakeWork = (world: World) =>
  Layer.mock(WorkService.WorkService)({
    addComment: (actor, input) =>
      Effect.gen(function* () {
        world.posts.push({ actor, input });
        const { held } = world;
        if (held !== null) {
          yield* Deferred.succeed(held.posting, undefined);
          yield* Deferred.await(held.release);
        }
        switch (world.work) {
          case "posts":
            return { commentId: String(world.posts.length) };
          case "unavailable":
            return yield* Effect.fail(
              new FakeWorkUnavailable({
                detail: "The source could not be reached.",
              }) as unknown as WorkDomainError,
            );
          case "refuses":
            return yield* Effect.fail(
              new FakeWorkInvalid({
                detail: "The source refused the comment.",
              }) as unknown as WorkDomainError,
            );
        }
      }),
  });

/** Every launch fails; every other delivery starts with its author's run going. */
const fakeThreads = Layer.mock(FactoryThreadEffects.FactoryThreadEffects)({
  launchThread: () => Effect.die("The launch was refused."),
  runEnded: () => Effect.succeedNone,
});

/**
 * What a boot's reactor reads: an event log with nothing in it, and every awaited run still going,
 * so its sweep changes only a delivery awaiting an effect the previous process lost.
 */
const fakeOrchestration = Layer.mergeAll(
  Layer.mock(EventSink.EventSinkV2)({
    latestSequence: () => Effect.succeed(0),
    stream: () => Stream.empty,
  }),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getThreadRecords: ((
      threadId: ThreadId,
      _fields: unknown,
      filter?: { readonly runIds?: ReadonlyArray<RunId> },
    ) =>
      Effect.succeed({
        thread: { id: threadId, deletedAt: null },
        runs: (filter?.runIds ?? []).map((id) => ({ id, status: "running" })),
      })) as unknown as ProjectionStore.ProjectionStoreV2["Service"]["getThreadRecords"],
  }),
);

/** What outlives a server process: the database, settings, git and the fakes. */
const baseLayer = (world: World) =>
  Layer.mergeAll(
    fakeWork(world),
    fakeThreads,
    fakeOrchestration,
    // No delivery here is reviewed, records an approval or opens its pull request.
    Layer.mock(FactoryReview.FactoryReview)({}),
    Layer.mock(FactoryRecord.FactoryRecord)({}),
    Layer.mock(FactoryPullRequest.FactoryPullRequest)({}),
    FactoryVerifyRunner.layer.pipe(
      Layer.provide(FactoryEvidence.layer),
      Layer.provide(ProcessRunner.layer),
    ),
  ).pipe(
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-comments-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

/** One server process: its own worker, comment poster and reactor, logging warnings to `world`. */
const serverLayer = (world: World) =>
  FactoryReactor.layer.pipe(
    Layer.provideMerge(FactoryWorker.layer),
    Layer.provide(FactoryWorkComments.layer),
    Layer.provide(
      Logger.layer(
        [
          Logger.make(({ logLevel, message }) => {
            const [first] = Array.isArray(message) ? message : [message];
            if (logLevel === "Warn" && typeof first === "string") world.warnings.push(first);
          }),
        ],
        { mergeWithExisting: false },
      ),
    ),
  );

const withWorld = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) => {
  const world: World = { posts: [], work: "posts", held: null, warnings: [] };
  return body(world).pipe(Effect.provide(baseLayer(world)), Effect.scoped);
};

const drain = Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.drain);

/**
 * Runs `body` in a new server process over the test's database: the reactor starts and its boot
 * sweep reads every active delivery back, as the server's does. Whatever the body sets off is
 * drained before the process ends.
 */
const boot = <A, E, R>(world: World, body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const reactor = yield* FactoryReactor.FactoryReactor;
    yield* reactor.start;
    yield* reactor.drain;
    yield* drain;
    const result = yield* body;
    yield* drain;
    return result;
  }).pipe(Effect.scoped, Effect.provide(serverLayer(world)));

const step = (event: FactoryEvent) =>
  Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.step(deliveryId, event)).pipe(
    Effect.andThen(drain),
  );
const stored = Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
  deliveries.get(deliveryId),
).pipe(Effect.map(Option.getOrThrow));
const state = Effect.map(stored, (delivery) => delivery.state);
const attempts = Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
  runs.listByDelivery(deliveryId),
).pipe(Effect.map((runs) => runs.map(({ stage, attempt, outcome }) => [stage, attempt, outcome])));
const insert = (initial: FactoryDeliveryState) =>
  Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
    deliveries.insert({ deliveryId, projectId, itemRef, state: initial }),
  );

const fold = (initial: FactoryDeliveryState, ...events: ReadonlyArray<FactoryEvent>) =>
  events.reduce((current, event) => advance(current, event).delivery, initial);
const limits = (maxFixRounds: number, maxReviewRounds: number): FactoryRoundLimits => ({
  maxFixRounds,
  maxReviewRounds,
});
const authorFinished: FactoryEvent = {
  type: "run.finished",
  threadId: author,
  runId: authorRun,
  status: "completed",
};
const authorDeleted: FactoryEvent = { type: "thread.deleted", threadId: author };

const blockedText = (reason: string) =>
  `Factory is blocked on this item and needs you. ${reason} Resume or cancel the delivery in Foredeck.`;
const verifyFailedText = blockedText("Verify failed with no fix round left.");

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);
const useFailingVerify = Effect.flatMap(FactorySettings.FactorySettings, (settings) =>
  settings.set(
    projectId,
    decodeSettings({
      verifyCommand: {
        executable: process.execPath,
        args: ["-e", "console.error('1 test failed'); process.exitCode = 1;"],
      },
    }),
  ),
);

const ada = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];
const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) =>
    driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 }),
  ).pipe(Effect.map((result) => result.stdout.trim()));
const commit = (cwd: string, message: string) =>
  git(cwd, [...ada, "commit", "--no-verify", "--no-gpg-sign", "-m", message]);

/**
 * Stores the delivery as its author's launch left it, with the author's run going and the attempt
 * the worker recorded for it. A repository stands in for the worktree, with the author's commit on
 * the delivery branch, so the branch settles. The repository lasts as long as the test.
 */
const authorRunning = (roundLimits: FactoryRoundLimits) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fd-factory-comments-wt-" });
    yield* git(cwd, ["init", "-b", "main"]);
    yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "root\n");
    yield* git(cwd, ["add", "README.md"]);
    yield* commit(cwd, "chore: root");
    const baseline = yield* git(cwd, ["rev-parse", "HEAD"]);
    yield* git(cwd, ["switch", "-c", branch]);
    yield* fileSystem.writeFileString(path.join(cwd, "export.ts"), "export const csv = 1;\n");
    yield* git(cwd, ["add", "export.ts"]);
    yield* commit(cwd, "feat: export the table as CSV");
    yield* insert(
      fold(
        queuedDeliveryState({ branch, baseRef: "main", limits: roundLimits }),
        { type: "start" },
        {
          type: "thread.launched",
          effectId: 1,
          threadId: author,
          runId: authorRun,
          worktreePath: cwd,
          baseline,
        },
      ),
    );
    yield* Effect.flatMap(FactoryStageRunStore.FactoryStageRunStore, (runs) =>
      runs.append({ deliveryId, stage: "author", threadId: author, runId: authorRun }),
    );
    return { cwd };
  });

/** A resume as FactoryService reads it here: a settled branch, no thread deleted, none approved. */
const resumeOn = (cwd: string) =>
  Effect.gen(function* () {
    const headSha = yield* git(cwd, ["rev-parse", "HEAD"]);
    const tree = yield* git(cwd, ["rev-parse", "HEAD^{tree}"]);
    return {
      type: "resume",
      check: {
        deletedThreads: [],
        unrecordedAuthorRunEnded: false,
        worktree: { settle: { status: "settled" }, commit: { headSha, tree }, approvedSha: null },
      },
    } satisfies FactoryEvent;
  });

/**
 * Runs `body` in a server process that stops as soon as `body` returns: whatever it queued and
 * has not finished is dropped or interrupted, as when the server shuts down.
 */
const stopsAfter = <A, E, R>(world: World, body: Effect.Effect<A, E, R>) =>
  body.pipe(Effect.scoped, Effect.provide(serverLayer(world)));

/** A delivery of its own item, stored with its author's run going. */
const authoringOf = (name: string) => {
  const id = FactoryDeliveryId.make(`delivery-${name}`);
  const thread = ThreadId.make(`thread-author-${name}`);
  return {
    id,
    deleted: { type: "thread.deleted", threadId: thread } satisfies FactoryEvent,
    insert: Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
      deliveries.insert({
        deliveryId: id,
        projectId,
        itemRef: { ...itemRef, itemId: WorkItemId.make(`fd-${name}`) },
        state: fold(
          queuedDeliveryState({ branch: `feature/${name}`, baseRef: "main" }),
          { type: "start" },
          {
            type: "thread.launched",
            effectId: 1,
            threadId: thread,
            runId: RunId.make(`run-author-${name}`),
            worktreePath: `/worktrees/${name}`,
            baseline: "b".repeat(40),
          },
        ),
      }),
    ),
  };
};

const stepOf = (id: FactoryDeliveryId, event: FactoryEvent) =>
  Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.step(id, event));

const bodies = (world: World) => world.posts.map(({ input }) => input.body);
const requestIds = (world: World) => world.posts.map(({ input }) => input.clientRequestId);

describe("Work comments on a delivery's transitions", () => {
  it.effect(
    "posts one comment with the block's message when a failed verify with no fix round left blocks",
    () =>
      withWorld((world) =>
        boot(
          world,
          Effect.gen(function* () {
            yield* useFailingVerify;
            yield* authorRunning(limits(0, 2));

            yield* step(authorFinished);
            const blocked = yield* stored;
            assert.strictEqual(blocked.state.status, "blocked");
            assert.deepStrictEqual(blocked.state.block, { reason: "verify_failed" });
            assert.deepStrictEqual(bodies(world), [verifyFailedText]);
            const [post] = world.posts;
            assert.deepStrictEqual(post?.input.ref, itemRef);
            assert.isDefined(post?.input.clientRequestId);
            // Factory's own actor, which writes to Work and is not an agent's.
            assert.strictEqual(post?.actor.id, `factory:${deliveryId}`);
            assert.strictEqual(post?.actor.label, "Factory");
            assert.include(post?.actor.grants ?? [], AuthWorkWriteScope);

            // A late run end and a late deletion leave it blocked and post nothing more.
            yield* step(authorFinished);
            yield* step(authorDeleted);
            assert.deepStrictEqual(yield* stored, blocked);
            assert.strictEqual(world.posts.length, 1);
          }),
        ),
      ),
  );

  it.effect("posts one comment naming the deleted thread when a deletion blocks", () =>
    withWorld((world) =>
      boot(
        world,
        Effect.gen(function* () {
          yield* authorRunning(limits(2, 2));

          yield* step(authorDeleted);
          const blocked = yield* stored;
          assert.deepStrictEqual(blocked.state.block, {
            reason: "thread_deleted",
            threadId: author,
          });
          assert.deepStrictEqual(bodies(world), [blockedText("The author thread was deleted.")]);

          // The deletion again, and the end of the run it cancelled, change nothing.
          yield* step(authorDeleted);
          yield* step({ ...authorFinished, status: "cancelled" });
          assert.deepStrictEqual(yield* stored, blocked);
          assert.strictEqual(world.posts.length, 1);
        }),
      ),
    ),
  );

  it.effect(
    "posts nothing again for a retried step or a restart, and a new comment for a later block",
    () =>
      withWorld((world) =>
        Effect.gen(function* () {
          yield* useFailingVerify;
          const { cwd } = yield* authorRunning(limits(0, 2));

          yield* boot(
            world,
            Effect.gen(function* () {
              // Stopping and stopped need nothing from Work.
              yield* step({ type: "stop" });
              yield* step(authorFinished);
              assert.strictEqual((yield* state).status, "stopped");
              assert.deepStrictEqual(world.posts, []);

              // Resumed, it verifies again and blocks: the first comment.
              yield* step(yield* resumeOn(cwd));
              const blocked = yield* stored;
              assert.strictEqual(blocked.state.status, "blocked");
              assert.deepStrictEqual(bodies(world), [verifyFailedText]);

              // The step that blocked it, retried: the verify result it took, again.
              const receipt = blocked.state.receipts.at(-1);
              const fingerprint = blocked.state.fingerprints.at(-1);
              if (receipt === undefined || fingerprint === undefined) {
                return assert.fail("The failed verify recorded no receipt or fingerprint.");
              }
              yield* step({
                type: "command.finished",
                // Verify is the last effect the delivery issued.
                effectId: blocked.state.effectsIssued,
                outcome: { type: "receipt", receipt, fingerprint },
              });
              assert.deepStrictEqual(yield* stored, blocked);
              assert.strictEqual(world.posts.length, 1);
            }),
          );

          // A restart: a new worker, poster and reactor, whose sweep reads the delivery back.
          yield* boot(world, Effect.void);
          assert.strictEqual(world.posts.length, 1);

          // A later block is a transition of its own, and gets a comment of its own.
          yield* boot(
            world,
            Effect.gen(function* () {
              yield* step(yield* resumeOn(cwd));
              assert.strictEqual((yield* state).status, "blocked");
            }),
          );
          assert.deepStrictEqual(bodies(world), [verifyFailedText, verifyFailedText]);
          const [first, second] = requestIds(world);
          assert.isDefined(first);
          assert.isDefined(second);
          assert.notStrictEqual(first, second);

          yield* boot(world, Effect.void);
          assert.strictEqual(world.posts.length, 2);
        }),
      ),
  );

  it.effect("announces a block the boot sweep makes once, and the next boot posts nothing", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        // The previous process stored the settled branch and lost the verify command it queued.
        yield* authorRunning(limits(2, 2));
        yield* Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (deliveries) =>
          Effect.flatMap(stored, ({ state: authoring }) =>
            deliveries.update(
              deliveryId,
              fold(authoring, authorFinished, {
                type: "settle.checked",
                effectId: 2,
                result: { status: "settled" },
              }),
            ),
          ),
        );

        yield* boot(world, Effect.void);
        assert.strictEqual((yield* state).status, "blocked");
        assert.deepStrictEqual(bodies(world), [
          blockedText("Factory could not run the verify command: a server restart interrupted it."),
        ]);

        yield* boot(world, Effect.void);
        assert.strictEqual(world.posts.length, 1);
      }),
    ),
  );

  it.effect(
    "posts after a restart a comment the stopped process recorded and never began, and never again one it began",
    () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const first = authoringOf("first");
          const second = authoringOf("second");
          yield* first.insert;
          yield* second.insert;
          const held = {
            posting: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
          };
          world.held = held;

          yield* stopsAfter(
            world,
            Effect.gen(function* () {
              // The first block's comment is being posted when the second delivery blocks.
              yield* stepOf(first.id, first.deleted);
              yield* Deferred.await(held.posting);
              yield* stepOf(second.id, second.deleted);
            }),
          );
          // The process stopped with the second comment still queued.
          const blocked = yield* Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (d) =>
            d.get(second.id),
          ).pipe(Effect.map(Option.getOrThrow));
          assert.strictEqual(blocked.state.status, "blocked");
          assert.deepStrictEqual(
            world.posts.map(({ actor }) => actor.id),
            [`factory:${first.id}`],
          );

          // The next boot posts the comment nobody began; the one interrupted mid-post may have
          // reached the source, so it is not posted again.
          world.held = null;
          yield* boot(world, Effect.void);
          assert.deepStrictEqual(
            world.posts.map(({ actor, input }) => [actor.id, input.body]),
            [
              [`factory:${first.id}`, blockedText("The author thread was deleted.")],
              [`factory:${second.id}`, blockedText("The author thread was deleted.")],
            ],
          );
          yield* boot(world, Effect.void);
          assert.strictEqual(world.posts.length, 2);
        }),
      ),
  );

  it.effect("posts a comment queued twice once", () =>
    withWorld((world) =>
      boot(
        world,
        Effect.gen(function* () {
          const first = authoringOf("first");
          const second = authoringOf("second");
          yield* first.insert;
          yield* second.insert;
          const held = {
            posting: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
          };
          world.held = held;
          yield* stepOf(first.id, first.deleted);
          yield* Deferred.await(held.posting);
          yield* stepOf(second.id, second.deleted);
          // A sweep that finds the queued, unclaimed comment queues it a second time.
          yield* Effect.flatMap(
            FactoryWorker.FactoryWorker,
            (worker) => worker.postUnattemptedComments,
          );
          yield* Deferred.succeed(held.release, undefined);
          yield* drain;
          assert.deepStrictEqual(
            world.posts.map(({ actor }) => actor.id),
            [`factory:${first.id}`, `factory:${second.id}`],
          );
        }),
      ),
    ),
  );

  describe("a comment Work does not post", () => {
    const queued = queuedDeliveryState({ branch, baseRef: "main" });
    const launchFailed = {
      type: "effect.failed",
      effectId: 1,
      detail: "Factory could not launch the author thread (unexpected error).",
    } satisfies FactoryEvent;
    // Nothing was recorded of the failed launch, so a resume issues it again, as effect 1.
    const resume: FactoryEvent = {
      type: "resume",
      check: { deletedThreads: [], unrecordedAuthorRunEnded: false, worktree: null },
    };

    it.effect.each([
      { work: "posts", how: "posts it" },
      { work: "unavailable", how: "cannot reach the source" },
      { work: "refuses", how: "is refused" },
    ] as const)(
      "changes nothing the transition stored when Work $how, and the next transition comments",
      ({ work }) =>
        withWorld((world) =>
          boot(
            world,
            Effect.gen(function* () {
              world.work = work;
              yield* insert(queued);

              // The author launch fails: the delivery blocks exactly as the engine decides.
              yield* step({ type: "start" });
              const blocked = fold(queued, { type: "start" }, launchFailed);
              assert.deepStrictEqual(yield* state, blocked);
              assert.deepStrictEqual(yield* attempts, [["author", 1, "blocked"]]);
              assert.deepStrictEqual(bodies(world), [blockedText(launchFailed.detail)]);

              // Resumed, the launch fails again: a new transition, so a new attempt to comment.
              yield* step(resume);
              assert.deepStrictEqual(yield* state, fold(blocked, resume, launchFailed));
              assert.deepStrictEqual(yield* attempts, [
                ["author", 1, "blocked"],
                ["author", 2, "blocked"],
              ]);
              assert.strictEqual(world.posts.length, 2);
              const [first, second] = requestIds(world);
              assert.notStrictEqual(first, second);

              const failures = world.warnings.filter(
                (warning) => warning === "factory could not comment on its delivery's item",
              );
              assert.strictEqual(failures.length, work === "posts" ? 0 : 2);
            }),
          ),
        ),
    );
  });
});
