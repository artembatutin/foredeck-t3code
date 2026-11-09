import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type EnvironmentId,
  OrchestrationV2DispatchCommandError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";

/**
 * The Assistant opens in flight, one per environment. Module state because every mounted entry
 * shares them, and the index landing reads them: an open publishes the scratch project before its
 * thread exists, and a draft started on that project would replace the Assistant.
 */
const useOpeningStore = create<{ readonly opening: ReadonlySet<EnvironmentId> }>(() => ({
  opening: new Set(),
}));

/** Claims this environment's open, synchronously; false while another click holds it. */
export const beginAssistantOpen = (environmentId: EnvironmentId): boolean => {
  const { opening } = useOpeningStore.getState();
  if (opening.has(environmentId)) return false;
  useOpeningStore.setState({ opening: new Set([...opening, environmentId]) });
  return true;
};

export const endAssistantOpen = (environmentId: EnvironmentId): void => {
  const opening = new Set(useOpeningStore.getState().opening);
  opening.delete(environmentId);
  useOpeningStore.setState({ opening });
};

export const useAssistantOpening = (environmentId: EnvironmentId | null): boolean =>
  useOpeningStore((state) => environmentId !== null && state.opening.has(environmentId));

/** Whether the Assistant is opening on any environment. */
export const useAssistantOpenPending = (): boolean =>
  useOpeningStore((state) => state.opening.size > 0);

const isDispatchError = Schema.is(OrchestrationV2DispatchCommandError);

/** How far one open walks, a stop for a server that only ever refuses; the next goes on from there. */
const MAX_CREATES_PER_OPEN = 64;

/**
 * How many leading ids of each environment's sequence this client has seen refused. A receipt never
 * changes, so they need no asking again, and how many there can be has no limit.
 */
const refusedCreateIds = new Map<string, number>();

export const resetAssistantOpeningForTests = (): void => {
  refusedCreateIds.clear();
};

/**
 * Dispatches the Assistant's one create. A rejected create changed nothing, but its receipt
 * refuses that command id for good, so the server's answer that the id was rejected moves on to
 * the next id of a fixed sequence. Anything else keeps the id, since the create may have landed.
 *
 * The sequence is what keeps one thread: every client walks it without skipping an id it has not
 * seen refused and stops at the first that is not, so at most one id is ever accepted, and a retry
 * of it replays. A random id could not promise that, because `thread.create` on a thread that
 * exists overwrites it.
 */
export const dispatchAssistantCreate = async <A, E>(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  dispatch: (commandId: CommandId) => Promise<AtomCommandResult<A, E>>,
): Promise<AtomCommandResult<A, E>> => {
  const key = scopedThreadKey(scopeThreadRef(environmentId, threadId));
  for (let walked = 1; ; walked += 1) {
    const attempt = (refusedCreateIds.get(key) ?? 0) + 1;
    const result = await dispatch(
      CommandId.make(attempt === 1 ? `create:${threadId}` : `create:${threadId}:${attempt}`),
    );
    if (result._tag !== "Failure") return result;
    const failure = squashAtomCommandFailure(result);
    if (!isDispatchError(failure) || failure.previouslyRejected !== true) return result;
    refusedCreateIds.set(key, attempt);
    if (walked === MAX_CREATES_PER_OPEN) return result;
  }
};
