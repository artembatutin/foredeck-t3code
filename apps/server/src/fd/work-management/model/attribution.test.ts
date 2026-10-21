import { describe, expect, it } from "vite-plus/test";

import type { WorkActor } from "../authority.ts";
import { attributeComment, neutralizeTriggerHandles, TRIGGER_HANDLES } from "./attribution.ts";

const owner: WorkActor = { id: "session:abc", grants: [], label: "Owner" };
const thread: WorkActor = { id: "thread:t-123", grants: [], label: "Codex" };
const client: WorkActor = { id: "client:mcp-1", grants: [], label: "Claude Code" };

describe("neutralizeTriggerHandles", () => {
  it("wraps a handle in backticks", () => {
    expect(neutralizeTriggerHandles("ask @codex to review")).toBe("ask `@codex` to review");
  });

  it("neutralizes every listed handle regardless of case", () => {
    for (const handle of TRIGGER_HANDLES) {
      expect(neutralizeTriggerHandles(`cc ${handle}`), handle).toBe(`cc \`${handle}\``);
      const upper = handle.toUpperCase();
      expect(neutralizeTriggerHandles(`cc ${upper}`), upper).toBe(`cc \`${upper}\``);
    }
  });

  it("handles several mentions in one body", () => {
    expect(neutralizeTriggerHandles("@claude and @Copilot, then @devin again @devin")).toBe(
      "`@claude` and `@Copilot`, then `@devin` again `@devin`",
    );
  });

  it("matches at the start and end of lines and before punctuation", () => {
    expect(neutralizeTriggerHandles("@codex\nhello @cursor.\n(@jules)")).toBe(
      "`@codex`\nhello `@cursor`.\n(`@jules`)",
    );
  });

  it("skips handles already inside backticks", () => {
    expect(neutralizeTriggerHandles("use `@codex` here")).toBe("use `@codex` here");
    expect(neutralizeTriggerHandles("run `ask @codex now` please")).toBe(
      "run `ask @codex now` please",
    );
    expect(neutralizeTriggerHandles("```\n@claude fix\n```\nthen @claude")).toBe(
      "```\n@claude fix\n```\nthen `@claude`",
    );
    expect(neutralizeTriggerHandles("`@codex` and @codex")).toBe("`@codex` and `@codex`");
  });

  it("leaves longer handles and addresses alone", () => {
    expect(neutralizeTriggerHandles("@codexbot @codex-ai @claude_dev")).toBe(
      "@codexbot @codex-ai @claude_dev",
    );
    expect(neutralizeTriggerHandles("mail team@codex now")).toBe("mail team@codex now");
    expect(neutralizeTriggerHandles("@@codex")).toBe("@@codex");
  });

  it("returns an unchanged body when nothing matches", () => {
    expect(neutralizeTriggerHandles("")).toBe("");
    expect(neutralizeTriggerHandles("plain text @someone")).toBe("plain text @someone");
  });
});

describe("attributeComment", () => {
  it("returns the owner's comment unchanged", () => {
    expect(attributeComment("ping @codex", owner)).toBe("ping @codex");
  });

  it("neutralizes and signs a thread agent's comment with its thread id", () => {
    expect(attributeComment("ping @codex", thread)).toBe(
      "ping `@codex`\n\n— posted by Codex via Foredeck (thread t-123)",
    );
  });

  it("signs an MCP client's comment without a thread", () => {
    expect(attributeComment("done", client)).toBe("done\n\n— posted by Claude Code via Foredeck");
  });

  it("is deterministic", () => {
    expect(attributeComment("x @claude", thread)).toBe(attributeComment("x @claude", thread));
  });
});
