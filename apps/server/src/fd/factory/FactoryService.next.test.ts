import { assert, describe, it } from "@effect/vitest";
import {
  AuthSettingsWriteScope,
  AuthWorkReadScope,
  AuthWorkWriteScope,
  CommandId,
  ProjectId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { FactoryProjectSettings } from "@t3tools/contracts/fd/factory";
import {
  type WorkItemRef,
  workItemRefString,
  WorkItemId,
  type WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectService from "../../project/ProjectService.ts";
import { type WorkActor, WorkService } from "../work-management/index.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactorySettings from "./FactorySettings.ts";
import { git, verifyCommands, type World, withProject } from "./testkit/deliveryHarness.ts";

const owner: WorkActor = {
  id: "session:owner",
  grants: [AuthWorkReadScope, AuthWorkWriteScope, AuthSettingsWriteScope],
  label: "owner",
};

const identity = ["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com"];

const decodeSettings = Schema.decodeUnknownSync(FactoryProjectSettings);

/**
 * What the Work service the server runs with does differently in a test: pages of at most
 * `pageLimit` items, so a source spans several; one source's first or later pages read stale or
 * fail to read; and an effect run once just before Factory's start reads an item's reference,
 * as a start from somewhere else that takes the item first.
 */
interface WorkFaults {
  pageLimit: number;
  page?:
    | {
        readonly sourceId: WorkSourceId;
        readonly pages: "first" | "later";
        readonly fault: "stale" | "unreadable";
      }
    | undefined;
  beforeStart?: { readonly ref: WorkItemRef; readonly run: Effect.Effect<void> } | undefined;
}

const faulty =
  (faults: WorkFaults) =>
  (service: WorkService.WorkService["Service"]): WorkService.WorkService["Service"] => ({
    ...service,
    listItems: (actor, query) => {
      const limited = { ...query, limit: Math.min(query.limit, faults.pageLimit) };
      const { page } = faults;
      if (
        page === undefined ||
        page.sourceId !== query.sourceId ||
        (page.pages === "later") !== (query.cursor !== undefined)
      ) {
        return service.listItems(actor, limited);
      }
      return page.fault === "stale"
        ? service.listItems(actor, limited).pipe(Effect.map((read) => ({ ...read, stale: true })))
        : // The source refuses a cursor it never issued, as it would a page it cannot serve.
          service.listItems(actor, { ...limited, cursor: "unreadable" });
    },
    canonicalRef: (ref) =>
      Effect.suspend(() => {
        const hook = faults.beforeStart;
        if (hook === undefined || workItemRefString(hook.ref) !== workItemRefString(ref)) {
          return Effect.void;
        }
        faults.beforeStart = undefined;
        return hook.run;
      }).pipe(Effect.andThen(service.canonicalRef(ref))),
  });

interface Task {
  readonly id: string;
  readonly title: string;
  readonly status: "todo" | "in_progress";
  /** Sources list newest first, so the day decides the order; all sort before the harness item. */
  readonly day: number;
  readonly labels?: string;
  readonly blockedBy?: string;
  /** The file's name when it is not the id's. */
  readonly file?: string;
}

/** Writes task files into a Markdown source's directory, commits them and drops Work's caches. */
const writeTasks = (world: World, directory: string, tasks: ReadonlyArray<Task>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const task of tasks) {
      const text = [
        "---",
        `id: ${task.id}`,
        `title: ${task.title}`,
        `status: ${task.status}`,
        ...(task.labels === undefined ? [] : [`labels: ${task.labels}`]),
        ...(task.blockedBy === undefined ? [] : [`blocked_by: ${task.blockedBy}`]),
        `updated: 2099-01-${String(task.day).padStart(2, "0")}T00:00:00.000Z`,
        "---",
        "",
      ].join("\n");
      yield* fileSystem.writeFileString(
        path.join(world.root, directory, `${task.file ?? task.id}.md`),
        text,
      );
    }
    yield* git(world.root, ["add", "-A"]);
    yield* git(world.root, [...identity, "commit", "--no-verify", "-m", "docs: add tasks"]);
    const work = yield* WorkService.WorkService;
    yield* work.refresh(owner, {});
  }).pipe(Effect.orDie);

const refOf = (sourceId: WorkSourceId, itemId: string): WorkItemRef => ({
  sourceId,
  itemId: WorkItemId.make(itemId),
});

/**
 * The project's two Markdown sources, in the order they were added, and what each lists of its
 * todo items, two to a page:
 *
 * - tasks: `blocked` (blocked by `inProgress`, labelled auto), `linked` (linked to a thread whose
 *   run has ended, so idle); then the harness's item. `inProgress` is not todo.
 * - backlog: `later` (labelled later), `auto` (labelled auto); then `autoToo` (labelled auto).
 *
 * Every item but the three of backlog and the harness's is not Ready.
 */
const seed = (world: World) =>
  Effect.gen(function* () {
    const work = yield* WorkService.WorkService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tasks = world.itemRef.sourceId;
    const backlog = (yield* work.saveSource(owner, {
      projectId: world.projectId,
      label: "Backlog",
      config: { kind: "markdown", directory: "backlog", autoStart: false },
    })).sourceId;
    yield* writeTasks(world, "tasks", [
      {
        id: "fd-b00001",
        title: "Blocked",
        status: "todo",
        day: 6,
        labels: "auto",
        blockedBy: "fd-b00002",
      },
      { id: "fd-b00002", title: "In progress", status: "in_progress", day: 5 },
      { id: "fd-b00003", title: "Linked", status: "todo", day: 4 },
    ]);
    yield* writeTasks(world, "backlog", [
      { id: "fd-c00001", title: "Later", status: "todo", day: 3, labels: "later" },
      { id: "fd-c00002", title: "Auto", status: "todo", day: 2, labels: "auto" },
      { id: "fd-c00003", title: "Auto too", status: "todo", day: 1, labels: "auto" },
    ]);
    const refs = {
      blocked: refOf(tasks, "fd-b00001"),
      inProgress: refOf(tasks, "fd-b00002"),
      linked: refOf(tasks, "fd-b00003"),
      later: refOf(backlog, "fd-c00001"),
      auto: refOf(backlog, "fd-c00002"),
      autoToo: refOf(backlog, "fd-c00003"),
    };
    // An owner's thread whose run has ended: idle, and still open. Its project is a folder beside
    // the harness's, which goes with it.
    const elsewhere = path.join(path.dirname(world.root), "elsewhere");
    yield* fileSystem.makeDirectory(elsewhere).pipe(Effect.orDie);
    const idle = yield* world.ownerThreadAt(elsewhere, "Look into the linked task.");
    assert.strictEqual(yield* world.endRun(idle.runId, "completed"), "completed");
    yield* work
      .setLink(owner, { ref: refs.linked, threadId: idle.threadId, action: "link" })
      .pipe(Effect.orDie);
    return { tasks, backlog, refs, idleThread: idle.threadId };
  });

const startNext = (input: {
  readonly projectId: ProjectId;
  readonly label?: string;
  readonly runtimeModeCeiling?: RuntimeMode;
}) => Effect.flatMap(FactoryService.FactoryService, (service) => service.startNext(input));

/** The started delivery, failing the test when nothing started. */
const started = (result: FactoryService.FactoryStartNextResult) => {
  if (result.type !== "started") return assert.fail(`Nothing started: ${JSON.stringify(result)}`);
  return result.delivery;
};

/** Every delivery of the project, as `item status` lines, oldest first. */
const deliveredItems = (world: World) =>
  Effect.flatMap(FactoryService.FactoryService, (service) =>
    service.list({ projectId: world.projectId }),
  ).pipe(
    Effect.orDie,
    Effect.map((deliveries) =>
      deliveries.map(({ itemRef }) => workItemRefString(itemRef)).toReversed(),
    ),
  );

const key = workItemRefString;

describe("FactoryService.startNext picks", () => {
  it.live("starts the first Ready item in Work's order across sources and pages", () => {
    const faults: WorkFaults = { pageLimit: 2 };
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { refs } = yield* seed(world);
          const work = yield* WorkService.WorkService;
          // The harness's item, last in tasks, has a delivery but no linked thread any more.
          const harness = yield* world.start;
          yield* work
            .setLink(owner, { ref: world.itemRef, threadId: harness.threadId, action: "unlink" })
            .pipe(Effect.orDie);

          // With a label only labelled items count: blocked is labelled but blocked, and later
          // comes first in backlog but is not labelled.
          const auto = started(yield* startNext({ projectId: world.projectId, label: "auto" }));
          assert.strictEqual(key(auto.itemRef), key(refs.auto));
          yield* world.launched(auto.deliveryId);

          // Without one, every page of tasks holds nothing Ready, so backlog's first item starts,
          // under the ceiling given.
          const first = started(
            yield* startNext({
              projectId: world.projectId,
              runtimeModeCeiling: "auto-accept-edits",
            }),
          );
          assert.strictEqual(key(first.itemRef), key(refs.later));
          assert.strictEqual(first.state.runtimeModeCeiling, "auto-accept-edits");
          assert.strictEqual(first.state.kind, "single");
          assert.strictEqual(first.state.status, "running");
          const author = yield* world.launched(first.deliveryId);
          const turn = world.provider.started.find(({ runId }) => runId === author.runId);
          assert.strictEqual(turn?.runtimePolicy.runtimeMode, "auto-accept-edits");

          // The next labelled item is on backlog's second page.
          const autoToo = started(yield* startNext({ projectId: world.projectId, label: "auto" }));
          assert.strictEqual(key(autoToo.itemRef), key(refs.autoToo));
          yield* world.launched(autoToo.deliveryId);

          // Each item started has an active delivery and an open thread now.
          assert.deepStrictEqual(yield* startNext({ projectId: world.projectId }), {
            type: "nothing_ready",
            incomplete: false,
          });
          assert.deepStrictEqual(yield* deliveredItems(world), [
            key(world.itemRef),
            key(refs.auto),
            key(refs.later),
            key(refs.autoToo),
          ]);
        }),
      { work: faulty(faults) },
    );
  });

  it.live("skips an item while a thread launch for it is in flight", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const work = yield* WorkService.WorkService;
        const linked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        // A launch links its thread before the thread exists, and holds it while it runs.
        const launching = yield* work
          .linkLaunch(
            { ref: world.itemRef, threadId: ThreadId.make("thread-launching"), origin: "factory" },
            Deferred.succeed(linked, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.orDie, Effect.forkChild);
        yield* Deferred.await(linked);

        assert.deepStrictEqual(yield* startNext({ projectId: world.projectId }), {
          type: "nothing_ready",
          incomplete: false,
        });

        // Once the launch is over, a link whose thread never came is no open thread.
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(launching);
        const next = started(yield* startNext({ projectId: world.projectId }));
        assert.strictEqual(key(next.itemRef), key(world.itemRef));
        yield* world.launched(next.deliveryId);
      }),
    ),
  );

  it.live("finds nothing Ready in an empty project, and refuses one it cannot deliver from", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projects = yield* ProjectService.ProjectService;
        const work = yield* WorkService.WorkService;
        const settings = yield* FactorySettings.FactorySettings;
        const projectId = ProjectId.make("project-empty");
        const root = path.join(path.dirname(world.root), "empty");
        yield* fileSystem.makeDirectory(root).pipe(Effect.orDie);
        yield* projects
          .create({
            commandId: CommandId.make("create-empty-project"),
            projectId,
            title: "Empty",
            workspaceRoot: root,
          })
          .pipe(Effect.orDie);
        yield* work
          .saveSource(owner, {
            projectId,
            label: "Tasks",
            config: { kind: "markdown", directory: "tasks", autoStart: false },
          })
          .pipe(Effect.orDie);

        // Without a verify command no start could go through, Ready or not.
        const unconfigured = yield* Effect.flip(startNext({ projectId }));
        assert.strictEqual(unconfigured._tag, "FactoryVerifyCommandMissingError");
        yield* settings
          .set(projectId, decodeSettings({ verifyCommand: verifyCommands.passes }))
          .pipe(Effect.orDie);

        assert.deepStrictEqual(yield* startNext({ projectId }), {
          type: "nothing_ready",
          incomplete: false,
        });
        const gone = yield* Effect.flip(startNext({ projectId: ProjectId.make("project-gone") }));
        assert.strictEqual(gone._tag, "FactoryProjectMissingError");
        // The harness's project, with its one Ready item, was never touched.
        assert.deepStrictEqual(yield* deliveredItems(world), []);
      }),
    ),
  );
});

describe("FactoryService.startNext over a listing it cannot read whole", () => {
  it.live.each(["stale", "unreadable"] as const)(
    "starts nothing past a %s page, and the Ready item before it",
    (fault) => {
      const faults: WorkFaults = { pageLimit: 2 };
      return withProject(
        verifyCommands.passes,
        (world) =>
          Effect.gen(function* () {
            const { tasks, refs, idleThread } = yield* seed(world);
            const work = yield* WorkService.WorkService;
            // Tasks' second page holds the harness's item, Ready; backlog's items are Ready too.
            faults.page = { sourceId: tasks, pages: "later", fault };

            assert.deepStrictEqual(yield* startNext({ projectId: world.projectId }), {
              type: "nothing_ready",
              incomplete: true,
            });
            assert.deepStrictEqual(yield* deliveredItems(world), []);

            // An item on the page read before it is Ready once its thread is unlinked, and it is
            // the first Ready item whatever the unread page holds.
            yield* work
              .setLink(owner, { ref: refs.linked, threadId: idleThread, action: "unlink" })
              .pipe(Effect.orDie);
            const linked = started(yield* startNext({ projectId: world.projectId }));
            assert.strictEqual(key(linked.itemRef), key(refs.linked));
            yield* world.launched(linked.deliveryId);
            assert.deepStrictEqual(yield* deliveredItems(world), [key(refs.linked)]);
          }),
        { work: faulty(faults) },
      );
    },
  );

  it.live("takes a stale first page as unread, Ready items on it included", () => {
    const faults: WorkFaults = { pageLimit: 2 };
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const { backlog } = yield* seed(world);
          // Backlog's first page lists its first two items, both Ready, but the listing misses
          // items it could not index, which may come first.
          faults.page = { sourceId: backlog, pages: "first", fault: "stale" };
          assert.deepStrictEqual(yield* startNext({ projectId: world.projectId, label: "later" }), {
            type: "nothing_ready",
            incomplete: true,
          });
          assert.deepStrictEqual(yield* deliveredItems(world), []);
        }),
      { work: faulty(faults) },
    );
  });

  it.live("starts nothing past an item Work lists but could not read", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        yield* seed(world);
        // Two files claim one id: Work lists both, read-only, first in tasks.
        const duplicate = { id: "fd-d00001", title: "Duplicate", status: "todo", day: 9 } as const;
        yield* writeTasks(world, "tasks", [
          { ...duplicate, file: "fd-d00001-a" },
          { ...duplicate, file: "fd-d00001-b" },
        ]);
        const work = yield* WorkService.WorkService;
        const listed = yield* work
          .listItems(owner, { sourceId: world.itemRef.sourceId, statuses: ["todo"], limit: 2 })
          .pipe(Effect.orDie);
        assert.deepStrictEqual(
          listed.items.map(({ ref, invalid }) => [ref.itemId, invalid !== null]),
          [
            ["fd-d00001", true],
            ["fd-d00001", true],
          ],
        );

        assert.deepStrictEqual(yield* startNext({ projectId: world.projectId }), {
          type: "nothing_ready",
          incomplete: true,
        });
        assert.deepStrictEqual(yield* deliveredItems(world), []);
      }),
    ),
  );
});

describe("FactoryService.startNext with concurrent starts", () => {
  it.live("starts each item once when two calls run together", () =>
    withProject(verifyCommands.passes, (world) =>
      Effect.gen(function* () {
        const both = () =>
          Effect.all(
            [startNext({ projectId: world.projectId }), startNext({ projectId: world.projectId })],
            { concurrency: "unbounded" },
          );

        // One Ready item: one call starts it, the other finds nothing Ready.
        const one = yield* both();
        const oneStarted = one.filter((result) => result.type === "started");
        assert.lengthOf(oneStarted, 1);
        assert.deepStrictEqual(
          one.filter((result) => result.type !== "started"),
          [{ type: "nothing_ready", incomplete: false }],
        );
        for (const { delivery } of oneStarted) yield* world.launched(delivery.deliveryId);
        assert.deepStrictEqual(yield* deliveredItems(world), [key(world.itemRef)]);

        // Two more Ready items: each call starts a different one.
        const tasks = world.itemRef.sourceId;
        yield* writeTasks(world, "tasks", [
          { id: "fd-e00001", title: "First", status: "todo", day: 2 },
          { id: "fd-e00002", title: "Second", status: "todo", day: 1 },
        ]);
        const two = (yield* both()).map(started);
        for (const delivery of two) yield* world.launched(delivery.deliveryId);
        assert.deepStrictEqual(two.map(({ itemRef }) => key(itemRef)).toSorted(), [
          key(refOf(tasks, "fd-e00001")),
          key(refOf(tasks, "fd-e00002")),
        ]);
        assert.deepStrictEqual(
          (yield* deliveredItems(world)).toSorted(),
          [
            key(world.itemRef),
            key(refOf(tasks, "fd-e00001")),
            key(refOf(tasks, "fd-e00002")),
          ].toSorted(),
        );
      }),
    ),
  );

  it.live("goes on to the next Ready item when another start takes its pick first", () => {
    const faults: WorkFaults = { pageLimit: 2 };
    return withProject(
      verifyCommands.passes,
      (world) =>
        Effect.gen(function* () {
          const factory = yield* FactoryService.FactoryService;
          const tasks = world.itemRef.sourceId;
          const first = refOf(tasks, "fd-f00001");
          yield* writeTasks(world, "tasks", [
            { id: "fd-f00001", title: "First", status: "todo", day: 1 },
          ]);
          // The owner delivers the first Ready item just as this call's start of it begins.
          const owners: Array<FactoryService.FactoryDeliveryWithRuns> = [];
          faults.beforeStart = {
            ref: first,
            run: factory.start({ itemRef: first }).pipe(
              Effect.map((delivery) => void owners.push(delivery)),
              Effect.orDie,
            ),
          };

          const next = started(yield* startNext({ projectId: world.projectId }));
          assert.strictEqual(key(next.itemRef), key(world.itemRef));
          yield* world.launched(next.deliveryId);
          const [ownerDelivery] = owners;
          assert.isDefined(ownerDelivery);
          yield* world.launched(ownerDelivery!.deliveryId);
          // The first item has the owner's delivery alone.
          const deliveries = yield* factory.list({ projectId: world.projectId }).pipe(Effect.orDie);
          assert.deepStrictEqual(
            deliveries
              .map(({ deliveryId, itemRef }) => [deliveryId, key(itemRef)])
              .toSorted(([, left], [, right]) => left!.localeCompare(right!)),
            [
              [next.deliveryId, key(world.itemRef)],
              [ownerDelivery!.deliveryId, key(first)],
            ].toSorted(([, left], [, right]) => left!.localeCompare(right!)),
          );
        }),
      { work: faulty(faults) },
    );
  });
});
