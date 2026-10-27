import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type ModelSelection,
  ProjectId,
  type ProviderOptionDescriptor,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { WorkService } from "../work-management/index.ts";
import * as FactoryChildren from "./FactoryChildren.ts";
import * as FactoryPlanning from "./FactoryPlanning.ts";
import * as FactoryPullRequest from "./FactoryPullRequest.ts";
import * as FactoryRecord from "./FactoryRecord.ts";
import * as FactoryReview from "./FactoryReview.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactorySettings from "./FactorySettings.ts";
import * as FactoryThreadEffects from "./FactoryThreadEffects.ts";
import * as FactoryWorkComments from "./FactoryWorkComments.ts";
import * as FactoryWorker from "./FactoryWorker.ts";
import * as Factory from "./index.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryStageRunStore from "./persistence/FactoryStageRunStore.ts";
import { advance } from "./pipeline/engine.ts";
import { type FactoryEffect, queuedDeliveryState } from "./pipeline/state.ts";
import * as FactoryEvidence from "./verify/FactoryEvidence.ts";
import * as FactoryVerifyRunner from "./verify/FactoryVerifyRunner.ts";
import {
  authorCommits,
  drainOrchestration,
  instanceId as integratedInstanceId,
  stateOf,
  verifyCommands,
  withProject,
} from "./testkit/deliveryHarness.ts";

const projectId = ProjectId.make("project-mechanical");
const deliveryId = FactoryDeliveryId.make("delivery-mechanical");
const author = ThreadId.make("author-mechanical");
const authorRun = RunId.make("author-run");
const instanceId = ProviderInstanceId.make("test-provider");
const branch = "feature/mechanical";
const original = {
  instanceId,
  model: "author-model",
  options: [
    { id: "effort", value: "high" },
    { id: "fastMode", value: true },
  ],
} satisfies ModelSelection;
const effort: ProviderOptionDescriptor = {
  id: "effort",
  label: "Effort",
  type: "select",
  options: ["low", "medium", "high", "xhigh", "max"].map((id) => ({
    id,
    label: id,
    isDefault: id === "high",
  })),
};
const atEffort = (selection: ModelSelection, value: string): ModelSelection => ({
  ...selection,
  options: [
    ...(selection.options ?? []).filter(({ id }) => id !== "effort"),
    { id: "effort", value },
  ],
});
type Send = ThreadManagement.ThreadManagementSendInput;
const runOf = (send: Send) => RunId.make(`run:${send.messageId}`);
const fixEffect: Extract<FactoryEffect, { type: "send_fix_commit_turn" }> = {
  id: 3,
  type: "send_fix_commit_turn",
  threadId: author,
  problems: ["The worktree is dirty."],
};
const decodeSettings = Schema.decodeEffect(FactoryProjectSettings);
interface World {
  readonly sends: Array<Send>;
  readonly accepted: Map<string, Send>;
  selection: ModelSelection;
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined;
  sendFailure: ThreadManagement.ThreadManagementThreadNotFoundError | null;
  cwd: string;
}

/** Core's queued-run start persists the requested model selection; a receipt replay does not. */
const fakes = (world: World) =>
  Layer.mergeAll(
    Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      sendToThread: (input) =>
        Effect.suspend(() => {
          world.sends.push(input);
          if (world.sendFailure !== null) return Effect.fail(world.sendFailure);
          if (!world.accepted.has(input.commandId)) {
            world.accepted.set(input.commandId, input);
            if (input.modelSelection !== undefined) world.selection = input.modelSelection;
          }
          return Effect.succeed({
            run: { id: runOf(input) },
            message: { attachments: [] },
          } as unknown as ThreadManagement.ThreadManagementSendResult);
        }),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: ((threadId: ThreadId) =>
        Effect.sync(() => ({
          thread: {
            id: threadId,
            worktreePath: world.cwd,
            deletedAt: null,
            modelSelection: world.selection,
          },
          runs: [...world.accepted.values()].map((send) => ({
            id: runOf(send),
            userMessageId: send.messageId,
            status: "running",
          })),
          messages: [],
        }))) as unknown as ProjectionStore.ProjectionStoreV2["Service"]["getThreadRecords"],
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({}),
    Layer.mock(WorkService.WorkService)({}),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.sync(
        () =>
          [
            {
              instanceId,
              models: ["author-model", "owner-model"].map((slug) => ({
                slug,
                capabilities: { optionDescriptors: world.descriptors },
              })),
            },
          ] as unknown as ReadonlyArray<ServerProvider>,
      ),
    }),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  );
const makeLayer = (world: World) =>
  FactoryService.layer.pipe(
    Layer.provideMerge(FactoryWorker.layer),
    Layer.provideMerge(FactoryThreadEffects.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(FactoryWorkComments.FactoryWorkComments)({ post: () => Effect.void }),
        Layer.mock(FactoryChildren.FactoryChildren)({}),
        Layer.mock(FactoryPlanning.FactoryPlanning)({}),
        Layer.mock(FactoryPullRequest.FactoryPullRequest)({}),
        Layer.mock(FactoryRecord.FactoryRecord)({}),
        Layer.mock(FactoryReview.FactoryReview)({}),
      ),
    ),
    Layer.provide(
      FactoryVerifyRunner.layer.pipe(
        Layer.provide(ProcessRunner.layer),
        Layer.provide(FactoryEvidence.layer),
      ),
    ),
    Layer.provideMerge(fakes(world)),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(FactorySettings.layer),
    Layer.provideMerge(Factory.layerPersistence),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fd-factory-mechanical-" })),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );
const withWorld = <A, E, R>(body: (world: World) => Effect.Effect<A, E, R>) => {
  const world: World = {
    sends: [],
    accepted: new Map(),
    selection: original,
    descriptors: [effort],
    sendFailure: null,
    cwd: "",
  };
  return body(world).pipe(Effect.provide(makeLayer(world)), Effect.scoped);
};
const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) =>
    driver
      .execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 })
      .pipe(Effect.map(({ stdout }) => stdout.trim())),
  );
const commit = (cwd: string) =>
  git(cwd, ["add", "-A"]).pipe(
    Effect.andThen(
      git(cwd, [
        "-c",
        "user.name=Ada Lovelace",
        "-c",
        "user.email=ada@example.com",
        "commit",
        "--no-verify",
        "--no-gpg-sign",
        "-m",
        "fix: record the work",
      ]),
    ),
  );
const stored = Effect.flatMap(FactoryDeliveryStore.FactoryDeliveryStore, (store) =>
  store.get(deliveryId),
).pipe(Effect.map(Option.getOrThrow));
const drain = Effect.flatMap(FactoryWorker.FactoryWorker, (worker) => worker.drain);
const endRun = (runId: RunId) =>
  Effect.flatMap(FactoryWorker.FactoryWorker, (worker) =>
    worker.step(deliveryId, {
      type: "run.finished",
      threadId: author,
      runId,
      status: "completed",
    }),
  ).pipe(Effect.andThen(drain));

/** A real dirty branch, stored just before the author's run ends. */
const prepare = (world: World, risk: "normal" | "high" = "normal") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    world.cwd = yield* fs.makeTempDirectoryScoped({ prefix: "fd-factory-mechanical-wt-" });
    yield* git(world.cwd, ["init", "-b", "main"]);
    yield* fs.writeFileString(`${world.cwd}/README.md`, "baseline\n");
    yield* commit(world.cwd);
    const baseline = yield* git(world.cwd, ["rev-parse", "HEAD"]);
    yield* git(world.cwd, ["switch", "-c", branch]);
    yield* fs.writeFileString(`${world.cwd}/README.md`, "author's uncommitted work\n");
    const state = advance(
      advance(queuedDeliveryState({ branch, baseRef: "main", risk }), { type: "start" }).delivery,
      {
        type: "thread.launched",
        effectId: 1,
        threadId: author,
        runId: authorRun,
        worktreePath: world.cwd,
        baseline,
      },
    ).delivery;
    const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
    yield* store.insert({
      deliveryId,
      projectId,
      itemRef: {
        sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
        itemId: WorkItemId.make("item"),
      },
      state,
    });
    const stages = yield* FactoryStageRunStore.FactoryStageRunStore;
    yield* stages.append({ deliveryId, stage: "author", threadId: author, runId: authorRun });
    const settings = yield* FactorySettings.FactorySettings;
    yield* settings.set(
      projectId,
      yield* decodeSettings({
        verifyCommand: {
          executable: process.execPath,
          args: ["-e", "console.error('verification failed'); process.exitCode = 1"],
        },
      }),
    );
  });

describe("Factory fix-commit effort", () => {
  it.live.each(["effort", "unrelated option"] as const)(
    "honors public owner %s changes during verification before another Factory turn",
    (change) =>
      withProject(
        verifyCommands.fails,
        (world) =>
          Effect.gen(function* () {
            const author = yield* world.start;
            const threads = yield* ThreadManagement.ThreadManagementService;
            const projection = () =>
              threads
                .getProjectThread({ projectId: world.projectId, threadId: author.threadId })
                .pipe(Effect.orDie);
            const before = {
              ...(yield* projection()).thread.modelSelection,
              options: original.options,
            };
            let selections = 0;
            const select = (selection: ModelSelection) =>
              threads
                .dispatch({
                  type: "thread.model-selection.set",
                  commandId: CommandId.make(`owner-selection:${++selections}`),
                  threadId: author.threadId,
                  modelSelection: selection,
                })
                .pipe(Effect.orDie);
            yield* select(before);
            const fs = yield* FileSystem.FileSystem;
            yield* fs.writeFileString(`${author.worktreePath}/export.ts`, "uncommitted work\n");
            yield* world.endRun(author.runId, "completed");
            yield* drainOrchestration;
            const fixing = (yield* stateOf(author.deliveryId)).awaiting;
            if (fixing?.type !== "run") return assert.fail("No mechanical turn started.");
            assert.deepStrictEqual(
              (yield* projection()).thread.modelSelection,
              atEffort(before, "medium"),
            );
            yield* authorCommits(author.worktreePath, "fix: commit the work");
            let verified = false;
            world.processes.around = (input, run) =>
              Effect.gen(function* () {
                assert.isFalse(verified);
                verified = true;
                const during = yield* projection();
                assert.strictEqual(during.runs.length, 2);
                assert.strictEqual(during.runs.at(-1)?.status, "completed");
                if (change === "effort") {
                  yield* select(atEffort(before, "high"));
                  yield* select(atEffort(before, "medium"));
                } else {
                  yield* select({
                    ...before,
                    options: [
                      { id: "effort", value: "medium" },
                      { id: "fastMode", value: false },
                    ],
                  });
                }
                assert.strictEqual((yield* projection()).runs.length, 2);
                return yield* run(input);
              });
            yield* world.endRun(fixing.runId, "completed");
            yield* drainOrchestration;
            assert.isTrue(verified);
            const next = yield* projection();
            assert.strictEqual(next.runs.length, 3);
            assert.strictEqual((yield* stateOf(author.deliveryId)).rounds.fix, 1);
            const expected =
              change === "effort"
                ? atEffort(before, "medium")
                : {
                    ...before,
                    options: [
                      { id: "fastMode", value: false },
                      { id: "effort", value: "high" },
                    ],
                  };
            assert.deepStrictEqual(next.thread.modelSelection, expected);
            assert.deepStrictEqual(next.runs.at(-1)?.modelSelection, expected);
          }),
        {
          providers: [
            {
              instanceId: integratedInstanceId,
              models: [{ slug: "test-model", capabilities: { optionDescriptors: [effort] } }],
            } as unknown as ServerProvider,
          ],
        },
      ),
  );

  it.effect.each(["normal", "high"] as const)(
    "uses medium for a %s-risk author's unsettled branch, irrespective of earlier rounds",
    (risk) =>
      withWorld((world) =>
        Effect.gen(function* () {
          yield* prepare(world, risk);
          const delivery = yield* stored;
          const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
          yield* store.update(deliveryId, { ...delivery.state, rounds: { fix: 2, review: 2 } });
          yield* endRun(authorRun);
          assert.strictEqual(world.sends.length, 1);
          assert.deepStrictEqual(world.sends[0]?.modelSelection, atEffort(original, "medium"));
          assert.deepStrictEqual(world.selection, atEffort(original, "medium"));
        }),
      ),
  );

  it.effect.each([
    { name: "no descriptors", descriptors: undefined },
    { name: "an empty descriptor list", descriptors: [] },
    { name: "no effort option", descriptors: [{ id: "fastMode", label: "Fast", type: "boolean" }] },
    {
      name: "no medium value",
      descriptors: [{ ...effort, options: [{ id: "high", label: "High" }] }],
    },
  ] satisfies Array<{
    name: string;
    descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined;
  }>)("omits modelSelection with $name", ({ descriptors }) =>
    withWorld((world) =>
      Effect.gen(function* () {
        world.descriptors = descriptors;
        yield* prepare(world);
        yield* endRun(authorRun);
        assert.strictEqual(world.sends.length, 1);
        assert.isFalse("modelSelection" in world.sends[0]!);
        assert.deepStrictEqual(world.selection, original);
      }),
    ),
  );

  it.effect.each(
    (["normal", "high"] as const).flatMap((risk) =>
      ["low", "high", undefined].map((value) => ({ risk, value })),
    ),
  )(
    "restores $value before a $risk-risk round-1 fix-verify after medium fix-commit",
    ({ risk, value }) =>
      withWorld((world) =>
        Effect.gen(function* () {
          const before =
            value === undefined
              ? { ...original, options: [{ id: "fastMode", value: true }] }
              : atEffort(original, value);
          world.selection = before;
          yield* prepare(world, risk);
          yield* endRun(authorRun);
          const fixing = world.sends[0]!;
          assert.deepStrictEqual(fixing.modelSelection, atEffort(before, "medium"));
          yield* commit(world.cwd);
          yield* endRun(runOf(fixing));
          assert.strictEqual(world.sends.length, 2);
          assert.include(world.sends[1]!.commandId, "factory-fix-verify:");
          assert.deepStrictEqual((yield* stored).state.rounds, { fix: 1, review: 0 });
          assert.deepStrictEqual(
            world.sends[1]!.modelSelection,
            risk === "high" ? atEffort(before, "xhigh") : before,
          );
          assert.deepStrictEqual(
            world.selection,
            risk === "high" ? atEffort(before, "xhigh") : before,
          );
        }),
      ),
  );

  it.effect.each([
    { name: "model", selection: { ...original, model: "owner-model" } },
    { name: "effort", selection: atEffort(original, "max") },
  ])("keeps an owner's subsequent $name change", ({ selection: ownerSelection }) =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* prepare(world);
        yield* endRun(authorRun);
        const fixing = world.sends[0]!;
        world.selection = ownerSelection;
        yield* commit(world.cwd);
        yield* endRun(runOf(fixing));
        assert.strictEqual(world.sends.length, 2);
        assert.isUndefined(world.sends[1]!.modelSelection);
        assert.deepStrictEqual(world.selection, ownerSelection);
      }),
    ),
  );

  it.effect(
    "replays one fix-commit effect with identical ids and selection across a rebuilt service",
    () =>
      withWorld((world) =>
        Effect.gen(function* () {
          yield* prepare(world);
          const delivery = yield* stored;
          const threads = yield* FactoryThreadEffects.FactoryThreadEffects;
          const first = yield* threads.sendFixCommitTurn(delivery, fixEffect);
          world.selection = { ...original, model: "owner-model" };
          world.descriptors = undefined;
          const rebuilt = yield* FactoryThreadEffects.FactoryThreadEffects.pipe(
            Effect.provide(Layer.fresh(FactoryThreadEffects.layer)),
          );
          assert.notStrictEqual(rebuilt, threads);
          const again = yield* rebuilt.sendFixCommitTurn(delivery, fixEffect);
          assert.deepStrictEqual(world.sends[0], world.sends[1]);
          assert.deepStrictEqual(first, again);
          assert.strictEqual(world.accepted.size, 1);
          assert.deepStrictEqual(world.selection, { ...original, model: "owner-model" });
        }),
      ),
  );

  it.effect("replays an unsupported selection unchanged when the model later offers medium", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        world.descriptors = undefined;
        yield* prepare(world);
        const threads = yield* FactoryThreadEffects.FactoryThreadEffects;
        const delivery = yield* stored;
        yield* threads.sendFixCommitTurn(delivery, fixEffect);
        world.descriptors = [effort];
        yield* threads.sendFixCommitTurn(delivery, fixEffect);
        assert.deepStrictEqual(world.sends[0], world.sends[1]);
        assert.isFalse("modelSelection" in world.sends[0]!);
        assert.strictEqual(world.accepted.size, 1);
      }),
    ),
  );

  it.effect("leaves an owner's selection alone when a recorded mechanical send was refused", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* prepare(world);
        const delivery = yield* stored;
        const threads = yield* FactoryThreadEffects.FactoryThreadEffects;
        world.sendFailure = new ThreadManagement.ThreadManagementThreadNotFoundError({
          projectId,
          threadId: author,
        });
        const refused = yield* Effect.flip(threads.sendFixCommitTurn(delivery, fixEffect));
        assert.strictEqual(refused._tag, "ThreadManagementThreadNotFoundError");
        assert.strictEqual(world.accepted.size, 0);
        world.sendFailure = null;
        world.selection = atEffort(original, "medium");
        yield* threads.sendReviewRetryTurn(delivery, {
          id: 4,
          type: "send_review_retry_turn",
          threadId: author,
          problems: ["Submit the review again."],
        });
        assert.isUndefined(world.sends[1]!.modelSelection);
        assert.deepStrictEqual(world.selection, atEffort(original, "medium"));
      }),
    ),
  );

  it.effect("resumes an unsettled stopped delivery with the same medium selection rule", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* prepare(world);
        const delivery = yield* stored;
        const store = yield* FactoryDeliveryStore.FactoryDeliveryStore;
        yield* store.update(deliveryId, {
          ...delivery.state,
          status: "stopped",
          checkpoint: "verify",
          awaiting: null,
        });
        const stages = yield* FactoryStageRunStore.FactoryStageRunStore;
        yield* stages.finish({ deliveryId, stage: "author", attempt: 1, outcome: "passed" });
        const service = yield* FactoryService.FactoryService;
        yield* service.resume(deliveryId);
        yield* drain;
        assert.strictEqual(world.sends.length, 1);
        assert.deepStrictEqual(world.sends[0]?.modelSelection, atEffort(original, "medium"));
        assert.include(world.sends[0]!.text, "verify");
      }),
    ),
  );

  it.effect("restores effort while keeping unrelated options the owner changed", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* prepare(world);
        yield* endRun(authorRun);
        world.selection = {
          ...world.selection,
          options: [
            { id: "effort", value: "medium" },
            { id: "fastMode", value: false },
          ],
        };
        yield* commit(world.cwd);
        yield* endRun(runOf(world.sends[0]!));
        assert.deepStrictEqual(world.selection, {
          ...original,
          options: [
            { id: "fastMode", value: false },
            { id: "effort", value: "high" },
          ],
        });
      }),
    ),
  );

  it.effect("does not undo an owner choosing medium after the temporary effort was restored", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* prepare(world);
        yield* endRun(authorRun);
        yield* commit(world.cwd);
        yield* endRun(runOf(world.sends[0]!));
        assert.deepStrictEqual(world.selection, original);
        world.selection = atEffort(original, "medium");
        const threads = yield* FactoryThreadEffects.FactoryThreadEffects;
        yield* threads.sendRepairTurn(yield* stored, {
          id: 20,
          type: "send_repair_turn",
          kind: "fix-verify",
          threadId: author,
          round: 1,
        });
        assert.isUndefined(world.sends.at(-1)!.modelSelection);
        assert.deepStrictEqual(world.selection, atEffort(original, "medium"));
      }),
    ),
  );

  it.effect("escalates a later repair from the pre-mechanical effort without lowering max", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        world.selection = atEffort(original, "max");
        yield* prepare(world);
        yield* endRun(authorRun);
        yield* commit(world.cwd);
        yield* endRun(runOf(world.sends[0]!));
        const threads = yield* FactoryThreadEffects.FactoryThreadEffects;
        yield* threads.sendFixCommitTurn(yield* stored, { ...fixEffect, id: 10 });
        assert.deepStrictEqual(world.selection, atEffort(original, "medium"));
        yield* threads.sendRepairTurn(yield* stored, {
          id: 11,
          type: "send_repair_turn",
          kind: "fix-verify",
          threadId: author,
          round: 2,
        });
        assert.deepStrictEqual(world.selection, atEffort(original, "max"));
      }),
    ),
  );

  it.effect("blocks without sending when recording the pre-mechanical selection fails", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* prepare(world);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER refuse_selection BEFORE INSERT ON fd_factory_turn_selections
      BEGIN SELECT RAISE(ABORT, 'test storage failure'); END`;
        yield* endRun(authorRun);
        assert.strictEqual(world.sends.length, 0);
        assert.deepStrictEqual(world.selection, original);
        assert.strictEqual((yield* stored).state.status, "blocked");
        const { block } = (yield* stored).state;
        assert.strictEqual(block?.reason, "effect_failed");
        assert.strictEqual(
          block?.reason === "effect_failed" ? block.detail : undefined,
          "Factory could not send the fix-commit turn (FactoryStoreError).",
        );
      }),
    ),
  );
});
