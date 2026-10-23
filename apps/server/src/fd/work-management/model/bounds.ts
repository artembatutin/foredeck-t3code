/**
 * Size limits on what Work carries over the wire and hands to agents. The wire limits match
 * the contract schemas; the agent limits are tighter because every character lands in a
 * prompt. Text is measured in UTF-16 code units, the same unit the schemas check.
 */

export const BODY_MAX_CHARS = 65_536;
export const AGENT_BODY_MAX_CHARS = 16_000;
export const COMMENT_MAX_CHARS = 16_000;
export const AGENT_COMMENT_MAX_CHARS = 4_000;
export const COMMENTS_MAX = 50;
export const AGENT_COMMENTS_MAX = 20;
export const LABELS_MAX = 32;
export const BLOCKERS_MAX = 50;
export const OPEN_LINKS_MAX = 2_000;

export interface BoundedText {
  readonly text: string;
  readonly truncated: boolean;
}

export interface BoundedList<T> {
  readonly items: ReadonlyArray<T>;
  readonly truncated: boolean;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/**
 * Cuts `text` to at most `maxChars` code units on a code point boundary: a cut that would
 * land between the halves of a surrogate pair drops the pair instead of splitting it.
 */
export const truncateText = (text: string, maxChars: number): BoundedText => {
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return { text, truncated: false };
  const end = limit > 0 && isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit;
  return { text: text.slice(0, end), truncated: true };
};

/** Keeps the first `max` items. The input is returned as is when it already fits. */
export const boundList = <T>(items: ReadonlyArray<T>, max: number): BoundedList<T> => {
  const limit = Math.max(0, Math.floor(max));
  return items.length <= limit
    ? { items, truncated: false }
    : { items: items.slice(0, limit), truncated: true };
};
