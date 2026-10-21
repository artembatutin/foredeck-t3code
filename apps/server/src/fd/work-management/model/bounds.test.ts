import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_BODY_MAX_CHARS,
  AGENT_COMMENT_MAX_CHARS,
  AGENT_COMMENTS_MAX,
  BLOCKERS_MAX,
  BODY_MAX_CHARS,
  boundList,
  COMMENT_MAX_CHARS,
  COMMENTS_MAX,
  LABELS_MAX,
  OPEN_LINKS_MAX,
  truncateText,
} from "./bounds.ts";

describe("limits", () => {
  it("keeps agent limits inside the wire limits", () => {
    expect(AGENT_BODY_MAX_CHARS).toBeLessThan(BODY_MAX_CHARS);
    expect(AGENT_COMMENT_MAX_CHARS).toBeLessThan(COMMENT_MAX_CHARS);
    expect(AGENT_COMMENTS_MAX).toBeLessThan(COMMENTS_MAX);
  });

  it("matches the contract schema limits", () => {
    expect(BODY_MAX_CHARS).toBe(65_536);
    expect(COMMENT_MAX_CHARS).toBe(16_000);
    expect(COMMENTS_MAX).toBe(50);
    expect(LABELS_MAX).toBe(32);
    expect(BLOCKERS_MAX).toBe(50);
    expect(OPEN_LINKS_MAX).toBe(2_000);
  });
});

describe("truncateText", () => {
  it("returns text that fits unchanged", () => {
    expect(truncateText("hello", 5)).toEqual({ text: "hello", truncated: false });
    expect(truncateText("", 0)).toEqual({ text: "", truncated: false });
  });

  it("cuts to the limit and reports it", () => {
    expect(truncateText("hello world", 5)).toEqual({ text: "hello", truncated: true });
    expect(truncateText("hello", 0)).toEqual({ text: "", truncated: true });
  });

  it("never splits a surrogate pair", () => {
    // "a" + U+1F600 (two code units) + "b"
    const text = "a\u{1F600}b";
    expect(text).toHaveLength(4);
    expect(truncateText(text, 2)).toEqual({ text: "a", truncated: true });
    expect(truncateText(text, 3)).toEqual({ text: "a\u{1F600}", truncated: true });
    expect(truncateText(text, 4)).toEqual({ text, truncated: false });
    expect(truncateText("\u{1F600}", 1)).toEqual({ text: "", truncated: true });
  });

  it("leaves a lone surrogate at the cut when it is not the start of a pair", () => {
    // A trailing low surrogate has nothing to pair with, so the cut is a plain cut.
    expect(truncateText("a\udc00b", 2)).toEqual({ text: "a\udc00", truncated: true });
  });

  it("treats a negative or fractional limit as its floor at zero", () => {
    expect(truncateText("abc", -1)).toEqual({ text: "", truncated: true });
    expect(truncateText("abc", 2.9)).toEqual({ text: "ab", truncated: true });
  });
});

describe("boundList", () => {
  it("returns the same array when it fits", () => {
    const items = [1, 2, 3];
    const bounded = boundList(items, 3);
    expect(bounded.items).toBe(items);
    expect(bounded.truncated).toBe(false);
  });

  it("keeps the first items and reports the cut", () => {
    expect(boundList(["a", "b", "c"], 2)).toEqual({ items: ["a", "b"], truncated: true });
    expect(boundList(["a"], 0)).toEqual({ items: [], truncated: true });
    expect(boundList([], 0)).toEqual({ items: [], truncated: false });
  });

  it("treats a negative limit as zero", () => {
    expect(boundList([1], -5)).toEqual({ items: [], truncated: true });
  });
});
