import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  isWorkNativeStatus,
  parseWorkItemRefString,
  WorkError,
  WorkErrorReason,
  WorkItemId,
  WorkItemRef,
  workItemRefString,
  WorkItemTitle,
  WorkLinksQuery,
  WorkLinksResult,
  WorkListQuery,
  WorkListResult,
  WorkNativeStatus,
  WorkProjectDirectory,
  WorkSearchText,
  WorkSetStatusInput,
  WorkSourceConfig,
  WorkSourceId,
  WorkSourceSaveInput,
  WorkSourceList,
  WorkStartThreadInput,
  WorkStatus,
  WorkThreadLink,
} from "./index.ts";

const uuid = "7e2aa85e-9347-44ce-b019-cb8dfd365b20";
const decodeRef = Schema.decodeUnknownSync(WorkItemRef);

describe("WorkSourceId", () => {
  const decode = Schema.decodeUnknownSync(WorkSourceId);

  it.each(["", "source-1", uuid.slice(0, -1), uuid.replaceAll("-", ""), 42, null])(
    "rejects %j",
    (value) => {
      expect(() => decode(value)).toThrow();
    },
  );

  it("canonicalizes case so one UUID has one identity", () => {
    expect(decode(uuid.toUpperCase())).toBe(uuid);
  });
});

describe("WorkItemId", () => {
  const decode = Schema.decodeUnknownSync(WorkItemId);

  it.each(["fd-7k3qa2", "123", "PROJ-12", "a.b_c-d", "x".repeat(64)])("accepts %j", (id) => {
    expect(decode(id)).toBe(id);
  });

  it.each(["", "-lead", ".lead", "has space", "a/b", "a:b", "x".repeat(65), 7, null])(
    "rejects %j",
    (id) => {
      expect(() => decode(id)).toThrow();
    },
  );
});

describe("WorkItemRef strings", () => {
  const ref = decodeRef({ sourceId: uuid, itemId: "PROJ-12" });

  it("round-trips through the one-string form", () => {
    expect(workItemRefString(ref)).toBe(`${uuid}:PROJ-12`);
    expect(parseWorkItemRefString(`${uuid}:PROJ-12`)).toEqual(ref);
    expect(parseWorkItemRefString(`${uuid.toUpperCase()}:PROJ-12`)).toEqual(ref);
  });

  it.each(["", "PROJ-12", `${uuid}:`, `:PROJ-12`, `source-1:PROJ-12`, `${uuid}:a b`])(
    "reads %j as no ref",
    (value) => {
      expect(parseWorkItemRefString(value)).toBeUndefined();
    },
  );
});

describe("WorkProjectDirectory", () => {
  const decode = Schema.decodeUnknownSync(WorkProjectDirectory);

  it.each(["work", ".foredeck/work", "docs/work", "Work Items/2026", "a".repeat(1024)])(
    "accepts %j",
    (directory) => {
      expect(decode(directory)).toBe(directory);
    },
  );

  it.each([
    "",
    ".",
    "/",
    "/abs/work",
    "..",
    "../work",
    "work/..",
    "./work",
    "work/",
    "a//b",
    ".git",
    ".git/x",
    "docs/.GIT/work",
    "work\\items",
    "C:/work",
    "wo\u0000rk",
    "two\nlines",
    "a".repeat(1025),
  ])("rejects %j", (directory) => {
    expect(() => decode(directory)).toThrow();
  });
});

describe("bounded text", () => {
  const decodeTitle = Schema.decodeUnknownSync(WorkItemTitle);
  const decodeSearch = Schema.decodeUnknownSync(WorkSearchText);

  it.each(["a", "a".repeat(512), "Keep selected source after reconnect"])(
    "accepts the title %j",
    (title) => {
      expect(decodeTitle(title)).toBe(title);
    },
  );

  it.each(["", "a".repeat(513), "   ", "two\nlines", "carriage\rreturn"])(
    "rejects the title %j",
    (title) => {
      expect(() => decodeTitle(title)).toThrow();
    },
  );

  it("bounds search text at 2000 characters", () => {
    expect(decodeSearch("a".repeat(2000))).toHaveLength(2000);
    expect(() => decodeSearch("a".repeat(2001))).toThrow();
  });
});

describe("WorkSourceConfig", () => {
  const decode = Schema.decodeUnknownSync(WorkSourceConfig);

  it("defaults a Markdown source to auto-start", () => {
    expect(decode({ kind: "markdown", directory: ".foredeck/work" })).toEqual({
      kind: "markdown",
      directory: ".foredeck/work",
      autoStart: true,
    });
  });

  it("keeps GitHub and Jira identities whole", () => {
    const github = { kind: "github", host: "github.com", owner: "o", name: "r" };
    const jira = {
      kind: "jira",
      siteUrl: "https://x.atlassian.net",
      projectKey: "PROJ",
      email: "me@example.com",
    };
    expect(decode(github)).toEqual(github);
    expect(decode(jira)).toEqual(jira);
  });

  it.each([
    { kind: "markdown", directory: "/abs" },
    { kind: "github", owner: "o", name: "r" },
    { kind: "jira", siteUrl: "", projectKey: "PROJ", email: "me@example.com" },
    { kind: "linear", teamId: "t" },
  ])("rejects %j", (config) => {
    expect(() => decode(config)).toThrow();
  });
});

describe("WorkSourceList", () => {
  const decode = Schema.decodeUnknownSync(WorkSourceList);
  const source = {
    sourceId: uuid,
    projectId: "project-1",
    kind: "markdown",
    identity: ".foredeck/work",
    label: "Tasks",
    config: { kind: "markdown", directory: ".foredeck/work", autoStart: true },
    state: "active",
    version: 1,
    credential: { configured: false },
    capabilities: {
      create: true,
      statuses: ["todo", "in_progress", "done", "cancelled"],
      fields: ["title", "body"],
      comments: "add",
      transitions: false,
      people: false,
    },
    health: { status: "ok" },
    updatedAt: "2026-10-20T09:15:00.000Z",
  };

  it("drops a source of a kind this build cannot read instead of failing the list", () => {
    const newer = { ...source, sourceId: "0b9d7f8e-1c2a-4e5b-9a7d-3f6e8c1b2a40", kind: "linear" };
    expect(decode({ sources: [source, newer] })).toEqual({ sources: [source] });
  });

  it("keeps a source whose capabilities or health use values from a newer server", () => {
    const newer = {
      ...source,
      capabilities: {
        ...source.capabilities,
        statuses: ["todo", "in_review"],
        fields: ["title", "estimate"],
        comments: "edit",
      },
      health: { status: "degraded", message: "Slow" },
    };
    const [decoded] = decode({ sources: [newer] }).sources;
    expect(decoded?.capabilities).toEqual({
      ...source.capabilities,
      statuses: ["todo"],
      fields: ["title"],
      comments: "none",
    });
    expect(decoded?.health).toEqual({ status: "error", message: "Slow" });
  });
});

describe("WorkListQuery", () => {
  const decode = Schema.decodeUnknownSync(WorkListQuery);

  it("defaults to pages of 50 for one source", () => {
    expect(decode({ sourceId: uuid })).toEqual({ sourceId: uuid, limit: 50 });
  });

  it.each([1, 100])("accepts a page size of %d", (limit) => {
    expect(decode({ sourceId: uuid, limit }).limit).toBe(limit);
  });

  it.each([
    {},
    { sourceId: uuid, limit: 0 },
    { sourceId: uuid, limit: 101 },
    { sourceId: uuid, limit: "50" },
    { sourceId: uuid, cursor: "" },
    { sourceId: uuid, statuses: ["blocked"] },
    { sourceId: uuid, assignee: "alice" },
    { sourceId: uuid, search: "a".repeat(2001) },
  ])("rejects %j", (query) => {
    expect(() => decode(query)).toThrow();
  });
});

describe("WorkStatus", () => {
  const decode = Schema.decodeUnknownSync(WorkStatus);
  const decodeWritable = Schema.decodeUnknownSync(WorkNativeStatus);

  it.each(WorkNativeStatus.literals)("keeps native %s writable", (status) => {
    expect(decode(status)).toBe(status);
    expect(isWorkNativeStatus(status)).toBe(true);
  });

  it.each(["blocked", "archived", "DONE", "done ", "", "unknown"])(
    "decodes %j as read-only unknown, never done",
    (raw) => {
      const status = decode(raw);
      expect(status).toBe("unknown");
      expect(isWorkNativeStatus(status)).toBe(false);
      expect(() => decodeWritable(status)).toThrow();
    },
  );
});

describe("WorkSetStatusInput", () => {
  const decode = Schema.decodeUnknownSync(WorkSetStatusInput);
  const ref = { sourceId: uuid, itemId: "PROJ-12" };

  it("takes exactly one of status or transitionId", () => {
    expect(decode({ ref, status: "done" })).toEqual({ ref, status: "done" });
    expect(decode({ ref, transitionId: "31" })).toEqual({ ref, transitionId: "31" });
    expect(() => decode({ ref })).toThrow();
    expect(() => decode({ ref, status: "done", transitionId: "31" })).toThrow();
  });
});

describe("WorkLinksQuery", () => {
  const decode = Schema.decodeUnknownSync(WorkLinksQuery);

  it("accepts no selector or one selector", () => {
    expect(decode({})).toEqual({});
    expect(decode({ threadId: "thread-1" })).toEqual({ threadId: "thread-1" });
    expect(decode({ projectId: "project-1" })).toEqual({ projectId: "project-1" });
    expect(() => decode({ threadId: "thread-1", projectId: "project-1" })).toThrow();
  });
});

describe("WorkStartThreadInput", () => {
  const decode = Schema.decodeUnknownSync(WorkStartThreadInput);

  it("defaults to implement mode without forcing a second thread", () => {
    const input = { ref: { sourceId: uuid, itemId: "fd-7k3qa2" }, creationSource: "web" };
    expect(decode(input)).toEqual({ ...input, mode: "implement", force: false });
  });

  it("rejects a creation source only the server may claim", () => {
    const ref = { sourceId: uuid, itemId: "fd-7k3qa2" };
    expect(() => decode({ ref, creationSource: "mcp" })).toThrow();
  });
});

describe("WorkError", () => {
  const decodeReason = Schema.decodeUnknownSync(WorkErrorReason);
  const decodeError = Schema.decodeSync(WorkError);

  it("reads a reason from a newer server as unavailable", () => {
    expect(decodeReason("stale")).toBe("stale");
    expect(decodeReason("teapot")).toBe("unavailable");
  });

  it("decodes Work errors from the wire with their transition candidates", () => {
    const error = decodeError({
      _tag: "WorkError",
      reason: "conflict",
      message: "Pick a transition.",
      candidates: [{ id: "31", name: "Done", to: "done", toName: "Done", requiresFields: false }],
    });
    expect(error).toBeInstanceOf(WorkError);
    expect(error.reason).toBe("conflict");
    expect(error.candidates?.[0]?.to).toBe("done");
  });
});

const decodeSaveInput = Schema.decodeUnknownOption(WorkSourceSaveInput);

describe("WorkSourceSaveInput", () => {
  const base = {
    projectId: "project-1",
    label: "Jira",
    config: {
      kind: "jira",
      siteUrl: "https://acme.atlassian.net",
      projectKey: "ONE",
      email: "me@acme.test",
    },
  };

  it("takes a new token or a clear, not both", () => {
    expect(decodeSaveInput({ ...base, apiToken: "token" })._tag).toBe("Some");
    expect(decodeSaveInput({ ...base, credential: "clear" })._tag).toBe("Some");
    expect(decodeSaveInput({ ...base, apiToken: "token", credential: "clear" })._tag).toBe("None");
  });
});

describe("WorkThreadLink", () => {
  const decode = Schema.decodeUnknownSync(WorkThreadLink);
  const link = {
    ref: { sourceId: uuid, itemId: "fd-abc123" },
    threadId: "thread-1",
    source: "started",
    linkedAt: "2026-10-20T09:15:00.000Z",
    snapshot: {
      key: "fd-abc123",
      title: "Ship",
      status: "todo",
      url: null,
      revision: "r",
      autoStarted: false,
    },
    run: null,
  };

  it("reads a link without an origin unchanged", () => {
    const decoded = decode(link);
    expect(decoded).toEqual(link);
    expect("origin" in decoded).toBe(false);
  });

  it("reads a Factory origin", () => {
    expect(decode({ ...link, origin: "factory" }).origin).toBe("factory");
  });

  it("reads an origin from a newer server as absent instead of failing the link", () => {
    const decoded = decode({ ...link, origin: "someday" });
    expect(decoded.origin).toBeUndefined();
    expect(decoded).toEqual(link);
  });
});

const decodeListResult = Schema.decodeUnknownSync(WorkListResult);
const decodeLinksResult = Schema.decodeUnknownSync(WorkLinksResult);

describe("payloads from a newer server", () => {
  const ref = { sourceId: uuid, itemId: "fd-abc123" };

  it("reads unknown item statuses and priorities without dropping the item", () => {
    const item = {
      ref,
      kind: "markdown",
      key: "fd-abc123",
      title: "Ship",
      status: "triage",
      nativeStatus: null,
      blocked: false,
      priority: "urgent",
      labels: [],
      assignee: null,
      parent: null,
      blockedBy: [],
      url: null,
      updatedAt: null,
      revision: "r",
      invalid: null,
    };
    const { items } = decodeListResult({
      items: [item],
      nextCursor: null,
      stale: false,
    });
    expect(items.map((entry) => [entry.status, entry.priority])).toEqual([["unknown", null]]);
  });

  it("keeps a link whose thread mode this build does not know", () => {
    const link = (mode: string) => ({
      ref,
      threadId: "thread-1",
      source: "started",
      linkedAt: "2026-10-20T09:15:00.000Z",
      snapshot: {
        key: "fd-abc123",
        title: "Ship",
        status: "todo",
        url: null,
        revision: "r",
        mode,
        autoStarted: false,
      },
      run: null,
    });
    const { links } = decodeLinksResult({
      links: [link("review"), link("scope")],
      truncated: false,
    });
    expect(links.map((entry) => entry.snapshot.mode ?? null)).toEqual([null, "scope"]);
  });
});
