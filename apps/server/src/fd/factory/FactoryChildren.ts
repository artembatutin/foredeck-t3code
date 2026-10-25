// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous hash derives child ids.
import * as NodeCrypto from "node:crypto";

import { AuthWorkReadScope, AuthWorkWriteScope } from "@t3tools/contracts";
import { FactoryDeliveryId, FactoryTaskId } from "@t3tools/contracts/fd/factory";
import type {
  WorkItemId,
  WorkItemSummary,
  WorkListQuery,
  WorkListResult,
} from "@t3tools/contracts/fd/work-management";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type WorkActor, type WorkDomainError, WorkService } from "../work-management/index.ts";
import * as FactoryChanges from "./FactoryChanges.ts";
import { FactoryStoreError } from "./persistence/errors.ts";
import * as FactoryDeliveryStore from "./persistence/FactoryDeliveryStore.ts";
import * as FactoryTaskStore from "./persistence/FactoryTaskStore.ts";
import type { FactoryEffect } from "./pipeline/state.ts";
import { queuedDeliveryState } from "./pipeline/state.ts";
import { childItemInput, childReference } from "./plan/childItem.ts";

/**
 * Factory could not tell whether a task's child item exists: the parent's source could not be
 * read whole, or listed an item it could not read, or more than one item under the parent carries
 * the task's reference. Nothing was created for the task.
 */
export class FactoryChildLookupError extends Schema.TaggedError<FactoryChildLookupError>()(
  "FactoryChildLookupError",
  {
    deliveryId: FactoryDeliveryId,
    taskId: FactoryTaskId,
    reason: Schema.Literals(["incomplete", "ambiguous"]),
  },
) {
  override get message(): string {
    return this.reason === "incomplete"
      ? `Factory could not read every item of the parent's Work source, so it cannot tell whether task ${this.taskId} of delivery ${this.deliveryId} has a child item.`
      : `More than one item under the parent carries the reference of task ${this.taskId} of delivery ${this.deliveryId}.`;
  }
}

type FactoryChildrenError =
  | WorkDomainError
  | FactoryChildLookupError
  | FactoryDeliveryStore.FactoryDeliveryActive
  | FactoryStoreError;

/**
 * An approved parent's children: one child Work item per task in the parent item's source, and
 * one queued child delivery per child item.
 */
export class FactoryChildren extends Context.Service<
  FactoryChildren,
  {
    /**
     * Carries out a parent's `create_children` and returns its child deliveries in plan order.
     * Each task, in plan order, gets its child item under the parent item, blocked by the previous
     * task's child, and the item is recorded on the task before the next task's is created. Once
     * every task has its child, the children's deliveries are stored queued, on the parent's
     * branch and worktree with its limits and runtime-mode ceiling and the task's risk; none
     * starts.
     *
     * A task that records its child is done. Each task is claimed before its child is created,
     * so only a claimed one may have a child from a run that stopped before recording it: the item
     * under the parent whose body carries the task's reference (`childReference`) is taken instead
     * of creating another. A search cannot match a body Work could not read, and Work's lists are
     * paged and may be stale, so finding none counts as absence only when every page of the source
     * was read and none lists an item Work could not read; otherwise, or when two such items are
     * found, the lookup fails rather than guess. A Work failure fails the effect, keeping every child
     * recorded so far, and the next run goes on after them. A child delivery stored before is
     * kept, and none is stored once the parent no longer awaits `effect`, as when it was
     * cancelled.
     */
    readonly create: (
      parent: FactoryDeliveryStore.StoredFactoryDelivery,
      effect: Extract<FactoryEffect, { readonly type: "create_children" }>,
    ) => Effect.Effect<ReadonlyArray<FactoryDeliveryId>, FactoryChildrenError>;
  }
>()("t3/fd/factory/FactoryChildren") {}

/** Factory writes a parent's children under this actor, which is not an agent's. */
const creator = (deliveryId: FactoryDeliveryId): WorkActor => ({
  id: `factory:${deliveryId}`,
  grants: [AuthWorkReadScope, AuthWorkWriteScope],
  label: "Factory",
});

/** Every list page a lookup reads holds this many items. */
const LOOKUP_PAGE = 100;

/**
 * A task's child delivery. Derived from the parent and the task, so a run that stopped after
 * storing it finds the same delivery again.
 */
export const childDeliveryId = (parentId: FactoryDeliveryId, taskId: FactoryTaskId) =>
  FactoryDeliveryId.make(
    `child-${NodeCrypto.createHash("sha256").update(`${parentId}\0${taskId}`).digest("hex").slice(0, 40)}`,
  );

const make = Effect.gen(function* () {
  const work = yield* WorkService.WorkService;
  const tasks = yield* FactoryTaskStore.FactoryTaskStore;
  const deliveries = yield* FactoryDeliveryStore.FactoryDeliveryStore;
  const changes = yield* FactoryChanges.FactoryChanges;

  /** Every page of a listing: its items, and whether any page was stale. */
  const listAll = (actor: WorkActor, query: Omit<WorkListQuery, "cursor" | "limit">) =>
    Effect.gen(function* () {
      const items: Array<WorkItemSummary> = [];
      let stale = false;
      let cursor: string | null = null;
      do {
        const page: WorkListResult = yield* work.listItems(actor, {
          ...query,
          limit: LOOKUP_PAGE,
          ...(cursor === null ? {} : { cursor }),
        });
        stale ||= page.stale;
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== null);
      return { items, stale };
    });

  /**
   * The child item a run created for the task and never recorded: the one item under the parent
   * whose body carries the task's reference. None only when the whole source was read and Work
   * read every item it lists: an item whose file it could not read is listed as invalid, with no
   * body for a search to match, and could be that child.
   */
  const findChild = (
    actor: WorkActor,
    parent: FactoryDeliveryStore.StoredFactoryDelivery,
    taskId: FactoryTaskId,
  ) =>
    Effect.gen(function* () {
      const { sourceId, itemId: parentItemId } = parent.itemRef;
      const reference = childReference(parent.deliveryId, taskId);
      const fail = (reason: FactoryChildLookupError["reason"]) =>
        new FactoryChildLookupError({ deliveryId: parent.deliveryId, taskId, reason });
      const searched = yield* listAll(actor, { sourceId, search: reference });
      // A search matches loosely; only the reference as written, in the item's own body, counts.
      const found = yield* Effect.filter(
        searched.items.filter((item) => item.parent === parentItemId),
        ({ ref }) =>
          work.getItem(actor, { ref }).pipe(Effect.map(({ body }) => body.includes(reference))),
      );
      if (found.length > 1) return yield* fail("ambiguous");
      const [child] = found;
      if (child !== undefined) return Option.some(child.ref.itemId);
      const source = searched.stale ? searched : yield* listAll(actor, { sourceId });
      if (source.stale || source.items.some(({ invalid }) => invalid !== null)) {
        return yield* fail("incomplete");
      }
      return Option.none();
    });

  /**
   * The task's child item, found or created, blocked by the previous task's, and then recorded:
   * a recorded child is complete.
   */
  const childOf = (
    actor: WorkActor,
    parent: FactoryDeliveryStore.StoredFactoryDelivery,
    task: FactoryTaskStore.StoredFactoryTask,
    previous: WorkItemId | undefined,
  ) =>
    Effect.gen(function* () {
      if (task.childItemId !== null) return task.childItemId;
      // Every task of a parent is a plan task; only a single item's task has no plan.
      if (task.plan === null) return yield* Effect.die("An approved task has no plan.");
      const { deliveryId } = parent;
      // Claimed before any create, so an unclaimed task has no child to look for.
      const found =
        task.childClaimedAt === null
          ? yield* tasks
              .claimChild({ deliveryId, taskId: task.taskId })
              .pipe(Effect.as(Option.none<WorkItemId>()))
          : yield* findChild(actor, parent, task.taskId);
      const itemId = Option.isSome(found)
        ? found.value
        : (yield* work.createItem(
            actor,
            childItemInput({ parent: parent.itemRef, deliveryId, task: task.plan }),
          )).ref.itemId;
      if (previous !== undefined) {
        yield* work.updateItem(actor, {
          ref: { sourceId: parent.itemRef.sourceId, itemId },
          blockedBy: [previous],
        });
      }
      yield* tasks.setChildItem({ deliveryId, taskId: task.taskId, itemId });
      return itemId;
    });

  /**
   * Stores each child's queued delivery that is not stored yet, in one transaction, while the
   * parent still awaits the effect: a parent cancelled meanwhile queues no children.
   */
  const storeDeliveries = (
    parent: FactoryDeliveryStore.StoredFactoryDelivery,
    effectId: number,
    children: ReadonlyArray<{
      readonly task: FactoryTaskStore.StoredFactoryTask;
      readonly itemId: WorkItemId;
    }>,
  ) =>
    Effect.gen(function* () {
      const current = yield* deliveries.get(parent.deliveryId);
      const awaiting = Option.getOrUndefined(current)?.state.awaiting;
      if (awaiting?.type !== "effect" || awaiting.effect.id !== effectId) return Option.none();
      const { state } = parent;
      return Option.some(
        yield* Effect.forEach(children, ({ task, itemId }) =>
          Effect.gen(function* () {
            const deliveryId = childDeliveryId(parent.deliveryId, task.taskId);
            if (Option.isSome(yield* deliveries.get(deliveryId))) return deliveryId;
            yield* deliveries.insert({
              deliveryId,
              projectId: parent.projectId,
              itemRef: { sourceId: parent.itemRef.sourceId, itemId },
              parentId: parent.deliveryId,
              state: queuedDeliveryState({
                branch: state.branch,
                baseRef: state.baseRef,
                ...(state.worktreePath === null ? {} : { worktreePath: state.worktreePath }),
                limits: state.limits,
                ...(task.plan === null ? {} : { risk: task.plan.risk }),
                ...(state.runtimeModeCeiling === undefined
                  ? {}
                  : { runtimeModeCeiling: state.runtimeModeCeiling }),
              }),
            });
            return deliveryId;
          }),
        ),
      );
    }).pipe(
      (write) => changes.transact(write, Option.isSome),
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.fail(new FactoryStoreError({ operation: "children.store", cause })),
      }),
      Effect.map(Option.getOrElse((): ReadonlyArray<FactoryDeliveryId> => [])),
    );

  const create: FactoryChildren["Service"]["create"] = Effect.fn("FactoryChildren.create")(
    function* (parent, effect) {
      const actor = creator(parent.deliveryId);
      const children: Array<{
        readonly task: FactoryTaskStore.StoredFactoryTask;
        readonly itemId: WorkItemId;
      }> = [];
      for (const task of yield* tasks.listByDelivery(parent.deliveryId)) {
        const itemId = yield* childOf(actor, parent, task, children.at(-1)?.itemId);
        children.push({ task, itemId });
      }
      return yield* storeDeliveries(parent, effect.id, children);
    },
  );

  return FactoryChildren.of({ create });
});

export const layer = Layer.effect(FactoryChildren, make);
