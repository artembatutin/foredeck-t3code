import type {
  CommandId,
  MessageId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  RunId,
  ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { FactoryEvent, FactoryWakeKind } from "./pipeline/state.ts";

/**
 * Reading what core's pull request watch committed on a delivery's author thread: its wakes, and
 * the watches Factory's own watch commands started. Pure: the reactor and the PR stage read the
 * events, these judge them.
 */

/** A run created by a command, which may be a pull request watch's wake. */
export interface RunCreated {
  readonly type: "run.created";
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly userMessageId: MessageId;
  readonly commandId: CommandId;
  /** The run's creation in the event log. */
  readonly sequence: number;
}

/** The stored event as a run created by a command; none for any other event. */
export const runCreated = ({ sequence, commandId, event }: OrchestrationV2StoredEvent) =>
  event.type === "run.created" && commandId !== null
    ? ({
        type: "run.created",
        threadId: event.payload.threadId,
        runId: event.payload.id,
        userMessageId: event.payload.userMessageId,
        commandId,
        sequence,
      } satisfies RunCreated)
    : undefined;

/** The command that records a watch's progress and queues its wakes. */
export const WATCH_SYNC_COMMAND = "thread.pull-request-watch.sync";

export type FactoryWakeEvent = Extract<FactoryEvent, { readonly type: "pr.feedback" }>;

/**
 * The wake a run starts, from the type of the command that created it and the events that
 * command committed on the run's thread: the command is a watch's sync that stored the wake as
 * the run's message, and the link it updated names the pull request. What it reports is read
 * from what the command committed: a watch it ended is the watch's end (core could not read the
 * pull request, it closed, or core stopped after too many comment-only updates), a notification of
 * completed work reports only passing checks, and anything else is feedback. None for any other
 * run, such as a turn the owner or Factory sent.
 */
export const wakeOf = (
  run: RunCreated,
  commandType: string | undefined,
  events: Iterable<OrchestrationV2StoredEvent>,
): FactoryWakeEvent | undefined => {
  if (commandType !== WATCH_SYNC_COMMAND) return undefined;
  let wake: OrchestrationV2ConversationMessage | undefined;
  let link: { readonly payload: ThreadPullRequestLink; readonly sequence: number } | undefined;
  for (const { event, sequence, commandId } of events) {
    if (commandId !== run.commandId || event.threadId !== run.threadId) continue;
    if (event.type === "thread.pull-request-link-updated")
      link = { payload: event.payload, sequence };
    if (
      event.type === "message.updated" &&
      event.payload.role === "user" &&
      event.payload.id === run.userMessageId
    ) {
      wake = event.payload;
    }
  }
  if (wake === undefined || link === undefined) return undefined;
  const watch = link.payload.watch;
  const kind: FactoryWakeKind =
    watch === undefined
      ? "ended"
      : wake.notification?.outcome === "completed"
        ? "notice"
        : "feedback";
  return {
    type: "pr.feedback",
    kind,
    threadId: run.threadId,
    runId: run.runId,
    number: link.payload.number,
    url: link.payload.url,
    sequence: run.sequence,
    watchStartedAt: watch?.startedAt ?? null,
    linkSequence: link.sequence,
  };
};

/** A pull request by the number and URL its link names. */
export interface FactoryPullRequestKey {
  readonly number: number;
  readonly url: string;
}

const linkFor = (
  links: ReadonlyArray<ThreadPullRequestLink> | undefined,
  pullRequest: FactoryPullRequestKey,
) =>
  links?.find(
    (link) =>
      link.source !== "stack-dismissed" &&
      link.number === pullRequest.number &&
      link.url === pullRequest.url,
  );

type ThreadStateEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly payload: OrchestrationV2AppThread }
>;

/** The events whose payload is the whole thread as it left it, its links and their watches. */
const THREAD_STATE_EVENTS: ReadonlySet<string> = new Set<ThreadStateEvent["type"]>([
  "thread.created",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.pinned",
  "thread.auto-settle-set",
  "thread.unpinned",
  "thread.pin-reordered",
  "thread.active-reordered",
  "thread.visited",
  "thread.marked-unread",
  "thread.metadata-updated",
  "thread.pull-request-synced",
  "thread.runtime-mode-updated",
  "thread.interaction-mode-updated",
  "thread.model-selection-updated",
  "thread.provider-switched",
]);

const isThreadState = (event: OrchestrationV2DomainEvent): event is ThreadStateEvent =>
  THREAD_STATE_EVENTS.has(event.type);

/**
 * The pull request's watch as an event left it: its start, null when the event shows the link
 * without one (a settle or archive removes it), undefined when the event says nothing of the link.
 */
const watchIn = (
  { event }: OrchestrationV2StoredEvent,
  pullRequest: FactoryPullRequestKey,
): string | null | undefined => {
  if (event.type === "thread.pull-request-link-updated") {
    const link = event.payload;
    return link.number === pullRequest.number && link.url === pullRequest.url
      ? (link.watch?.startedAt ?? null)
      : undefined;
  }
  if (isThreadState(event)) {
    return linkFor(event.payload.pullRequests, pullRequest)?.watch?.startedAt ?? null;
  }
  return undefined;
};

/**
 * Where the watch that started at `startedAt` stopped being the pull request's watch, in events of
 * the thread: the first that shows the link without it once it was on, from the first event when
 * `on`, or else from the first that shows it.
 */
export const watchEndIn = (
  events: Iterable<OrchestrationV2StoredEvent>,
  pullRequest: FactoryPullRequestKey,
  startedAt: string,
  on = true,
) => {
  let seen = on;
  for (const stored of events) {
    const watch = watchIn(stored, pullRequest);
    if (watch === startedAt) seen = true;
    else if (watch !== undefined && seen) return stored.sequence;
  }
  return undefined;
};

/**
 * The watch a `thread.pull-request.watch` command started, and the link it is on, from the one
 * event the command committed and the thread's earlier `thread.pull-request-synced` events. Core
 * starts a watch at the moment of its command, so the watch's start is that event's time; and it
 * starts one only in such an event, so a watch an earlier one shows was kept, however close in
 * time the two commands were. Undefined when the command started none.
 */
export const watchStartedBy = (
  stored: OrchestrationV2StoredEvent,
  earlier: ReadonlyArray<OrchestrationV2StoredEvent>,
) => {
  const { event } = stored;
  if (event.type !== "thread.pull-request-synced") return undefined;
  const at = DateTime.formatIso(event.occurredAt);
  for (const link of event.payload.pullRequests ?? []) {
    if (link.source === "stack-dismissed" || link.watch?.startedAt !== at) continue;
    if (!earlier.some((before) => watchIn(before, link) === at)) return { startedAt: at, link };
  }
  return undefined;
};
