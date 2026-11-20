import { retainQueuedRepositoryRequirement } from "@t3tools/client-runtime/fd/multirepo";
import { appAtomRegistry } from "./atom-registry";
import { createThreadOutboxManager } from "./thread-outbox-manager";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { expoThreadOutboxStorage, flushThreadOutboxWrites } from "./thread-outbox-storage";

export * from "./thread-outbox-model";

export const threadOutboxManager = createThreadOutboxManager({
  registry: appAtomRegistry,
  storage: expoThreadOutboxStorage,
});

/** Drain queued mutations too; optimistic publication precedes the durable file write. */
export async function flushThreadOutbox(): Promise<void> {
  await threadOutboxManager.serialize(async () => {});
  await flushThreadOutboxWrites();
}

export async function enqueueThreadOutboxMessage(message: QueuedThreadMessage): Promise<void> {
  // Reading persisted drafts must not initialize the native connection runtime.
  const { environmentSnapshotAtom } = await import("./shell");
  return threadOutboxManager.enqueue(
    retainQueuedRepositoryRequirement(
      message,
      appAtomRegistry.get(environmentSnapshotAtom(message.environmentId)),
    ),
  );
}

export function confirmThreadOutboxMessageQueued(message: QueuedThreadMessage): Promise<boolean> {
  return threadOutboxManager.confirmQueued(message);
}

/** Returns false if removed or if expectedRevision differs from threadOutboxRevision; otherwise rewrites the message. */
export function updateThreadOutboxMessage(
  message: QueuedThreadMessage,
  expectedRevision?: number,
): Promise<boolean> {
  return threadOutboxManager.update(message, expectedRevision);
}

/** Changes the message as it is when its turn comes; false when it is gone or `change` returns null. */
export function modifyThreadOutboxMessage(
  messageId: QueuedThreadMessage["messageId"],
  change: (message: QueuedThreadMessage) => QueuedThreadMessage | null,
): Promise<boolean> {
  return threadOutboxManager.modify(messageId, change);
}

export function threadOutboxRevision(messageId: QueuedThreadMessage["messageId"]): number {
  return threadOutboxManager.revisionOf(messageId);
}

// Removal needs draft-state ownership to release files; keep that dependency outside this module.
