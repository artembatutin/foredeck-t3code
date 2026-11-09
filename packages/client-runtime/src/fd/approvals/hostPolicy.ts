import type {
  ModelSelection,
  OrchestrationV2ShellSnapshot,
  RuntimeMode,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { threadTurnRefusal } from "@t3tools/shared/fd/approvals";
import * as Schema from "effect/Schema";

/** The host's policy refuses the turn: nothing was dispatched, and no mode changed. */
export class ThreadRuntimeModeRefusedError extends Schema.TaggedError<ThreadRuntimeModeRefusedError>()(
  "ThreadRuntimeModeRefusedError",
  {
    threadId: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Why the provider's host would refuse a turn on the thread, from what this client last read. The
 * turn's own provider and mode win over the thread's, and a thread, provider or policy it has not
 * read refuses nothing: the server then judges as it would for any client.
 */
export function threadHostRefusal(input: {
  readonly snapshot: OrchestrationV2ShellSnapshot | null;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  readonly threadId: ThreadId;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly instanceId?: ModelSelection["instanceId"] | undefined;
}) {
  const thread =
    input.snapshot?.threads.find(({ id }) => id === input.threadId) ??
    input.snapshot?.archivedThreads.find(({ id }) => id === input.threadId);
  const instanceId = input.instanceId ?? thread?.modelSelection.instanceId;
  const runtimeMode = input.runtimeMode ?? thread?.runtimeMode;
  if (instanceId === undefined || runtimeMode === undefined) return null;
  return threadTurnRefusal(
    input.providers?.find((provider) => provider.instanceId === instanceId),
    runtimeMode,
  );
}
