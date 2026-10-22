import { isAgentActor, type WorkActor } from "../authority.ts";

/**
 * Comments an agent posts go out under the owner's credential, so the remote source cannot
 * tell them apart from the owner's own. Attribution restores that: the text names the agent,
 * and any handle that would summon another bot on that source is disarmed first.
 */

/** Mentions that trigger a bot on GitHub or Jira. Matched case-insensitively as whole words. */
export const TRIGGER_HANDLES = [
  "@claude",
  "@codex",
  "@copilot",
  "@cursor",
  "@devin",
  "@jules",
] as const;

/** Fenced and inline code spans, which already render a handle literally. */
const CODE_SPAN = /```[\s\S]*?```|`[^`]*`/g;

/** A handle not glued to a word (an email address) and not the prefix of a longer handle. */
const HANDLE = new RegExp(
  `(?<![\\w@])@(?:${TRIGGER_HANDLES.map((handle) => handle.slice(1)).join("|")})(?![\\w-])`,
  "gi",
);

const neutralizeProse = (prose: string): string => prose.replace(HANDLE, "`$&`");

/**
 * Wraps each trigger handle in backticks so the source renders it as text instead of a
 * mention. Handles already inside backticks are left alone.
 */
export const neutralizeTriggerHandles = (body: string): string => {
  let out = "";
  let last = 0;
  for (const span of body.matchAll(CODE_SPAN)) {
    out += neutralizeProse(body.slice(last, span.index)) + span[0];
    last = span.index + span[0].length;
  }
  return out + neutralizeProse(body.slice(last));
};

const THREAD_PREFIX = "thread:";

/**
 * The comment body as it should reach the source. An agent's comment is neutralized and
 * signed; the owner's own session posts what it wrote.
 */
export const attributeComment = (body: string, actor: WorkActor): string => {
  if (!isAgentActor(actor)) return body;
  const thread = actor.id.startsWith(THREAD_PREFIX)
    ? ` (thread ${actor.id.slice(THREAD_PREFIX.length)})`
    : "";
  return `${neutralizeTriggerHandles(body)}\n\n— posted by ${actor.label} via Foredeck${thread}`;
};
