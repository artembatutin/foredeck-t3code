import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import {
  WorkItemId,
  WorkSourceId,
  type WorkThreadLink,
} from "@t3tools/contracts/fd/work-management";

import {
  defaultWorkWorkspace,
  itemInView,
  linkPrompts,
  linksByThread,
  readWorkListPreferences,
  runStateOf,
  type WorkThreadShell,
  workBranchPreview,
  workItemReferenceText,
  writeWorkListPreferences,
} from "./model.ts";

const sourceId = WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4");
const ref = { sourceId, itemId: WorkItemId.make("fd-7k3qa2") };
const shell = (overrides: Partial<WorkThreadShell> = {}): WorkThreadShell => ({
  id: ThreadId.make("t1"),
  title: "Thread",
  latestRun: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  settledAt: null,
  archivedAt: null,
  ...overrides,
});
const link = (overrides: Partial<WorkThreadLink> = {}): WorkThreadLink => ({
  ref,
  threadId: ThreadId.make("t1"),
  source: "started",
  linkedAt: "2026-10-21T09:00:00.000Z",
  snapshot: {
    key: "fd-7k3qa2",
    title: "T",
    status: "todo",
    url: null,
    revision: "r1",
    autoStarted: true,
  },
  run: null,
  ...overrides,
});

describe("runStateOf", () => {
  it("reads what a linked thread is doing", () => {
    expect(runStateOf(null)).toBe("missing");
    expect(runStateOf(shell())).toBe("idle");
    expect(runStateOf(shell({ latestRun: { status: "running" } }))).toBe("working");
    expect(runStateOf(shell({ latestRun: { status: "completed" } }))).toBe("idle");
    expect(runStateOf(shell({ latestRun: { status: "running" }, hasPendingUserInput: true }))).toBe(
      "needs-input",
    );
    expect(runStateOf(shell({ settledAt: "x" }))).toBe("settled");
    expect(runStateOf(shell({ archivedAt: "x" }))).toBe("archived");
  });
});

describe("itemInView", () => {
  it("keeps Ready to unblocked todos nobody is working on", () => {
    const todo = { status: "todo", blocked: false } as const;
    expect(itemInView("ready", todo, [])).toBe(true);
    expect(itemInView("ready", { ...todo, blocked: true }, [])).toBe(false);
    expect(itemInView("ready", todo, ["working"])).toBe(false);
    expect(itemInView("ready", todo, ["settled"])).toBe(true);
    expect(itemInView("active", todo, ["needs-input"])).toBe(true);
    expect(itemInView("done", { status: "cancelled", blocked: false }, [])).toBe(true);
    expect(itemInView("all", { status: "unknown", blocked: true }, [])).toBe(true);
  });
});

describe("linkPrompts", () => {
  it("offers Back to todo only for a failed automatic start", () => {
    expect(
      linkPrompts(link({ run: { status: "failed", at: "x" } }), { status: "in_progress" }),
    ).toEqual({
      backToTodo: true,
      markDone: false,
    });
    expect(
      linkPrompts(
        link({
          run: { status: "failed", at: "x" },
          snapshot: { ...link().snapshot, autoStarted: false },
        }),
        { status: "in_progress" },
      ).backToTodo,
    ).toBe(false);
    expect(
      linkPrompts(link({ run: { status: "completed", at: "x" } }), { status: "in_progress" }),
    ).toEqual({
      backToTodo: false,
      markDone: true,
    });
    expect(
      linkPrompts(link({ run: { status: "completed", at: "x" } }), { status: "done" }).markDone,
    ).toBe(false);
  });
});

describe("helpers", () => {
  it("groups links by thread", () => {
    const grouped = linksByThread([
      link(),
      link({ ref: { sourceId, itemId: WorkItemId.make("fd-2m9x4c") } }),
    ]);
    expect(grouped.get(ThreadId.make("t1"))?.length).toBe(2);
  });

  it("names an item for the owner and the agent", () => {
    expect(
      workItemReferenceText({
        ref,
        key: "fd-7k3qa2",
        title: "Add sync",
        url: null,
        locator: ".foredeck/work/a.md",
      }),
    ).toBe(
      `Work item fd-7k3qa2: Add sync (.foredeck/work/a.md) — read it with work_read ${sourceId}:fd-7k3qa2`,
    );
  });

  it("defaults to a worktree only where the project uses them and checkouts are not shared", () => {
    expect(defaultWorkWorkspace({ defaultThreadEnvMode: "worktree", sharedCheckouts: false })).toBe(
      "worktree",
    );
    expect(defaultWorkWorkspace({ defaultThreadEnvMode: "worktree", sharedCheckouts: true })).toBe(
      "root",
    );
    expect(defaultWorkWorkspace({ defaultThreadEnvMode: null, sharedCheckouts: false })).toBe(
      "root",
    );
  });

  it("previews the branch the server will create", () => {
    expect(
      workBranchPreview({
        kind: "github",
        ref: { sourceId, itemId: WorkItemId.make("12") },
        title: "Fix it!",
      }),
    ).toBe("work/gh-12-fix-it");
  });

  it("round-trips list preferences and falls back on anything else", () => {
    expect(
      readWorkListPreferences(writeWorkListPreferences({ view: "done", assignedToMe: true })),
    ).toEqual({
      view: "done",
      assignedToMe: true,
    });
    expect(readWorkListPreferences("{bad")).toEqual({ view: "ready", assignedToMe: false });
    expect(readWorkListPreferences(null).view).toBe("ready");
  });
});
