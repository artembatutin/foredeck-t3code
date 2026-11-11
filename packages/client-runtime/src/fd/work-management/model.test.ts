import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  WorkItemId,
  WorkSourceId,
  type WorkThreadLink,
} from "@t3tools/contracts/fd/work-management";

import {
  changedSinceLink,
  defaultWorkWorkspace,
  itemInView,
  linkPrompts,
  linksByThread,
  readWorkListPreferences,
  runStateOf,
  type WorkThreadShell,
  workBranchPreview,
  workEmptyState,
  workItemLinkTarget,
  workItemOwningProject,
  workItemReferenceText,
  writeWorkListPreferences,
} from "./model.ts";
import { workViewStatuses } from "./paging.ts";

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

describe("workItemLinkTarget", () => {
  const target = (environmentId: string) =>
    workItemLinkTarget({
      environmentId: EnvironmentId.make(environmentId),
      projectId: ProjectId.make("project-a"),
      ref,
    });

  it("names the exact project of each environment, the item and the All view", () => {
    expect(target("env-a")).toEqual({
      to: "/work",
      search: {
        project: "env-a:project-a",
        item: `${sourceId}:fd-7k3qa2`,
        view: "all",
      },
    });
    expect(target("env-b")).toEqual({
      to: "/work",
      search: {
        project: "env-b:project-a",
        item: `${sourceId}:fd-7k3qa2`,
        view: "all",
      },
    });
  });

  it("opens a view that shows what Ready hides, and asks the server for every status", () => {
    const { view } = target("env-a").search;
    const active = { status: "todo", blocked: false } as const;
    const inProgress = { status: "in_progress", blocked: false } as const;
    const done = { status: "done", blocked: false } as const;
    const cancelled = { status: "cancelled", blocked: false } as const;
    const captured = { status: "todo", blocked: false } as const;

    expect(itemInView("ready", active, ["working"])).toBe(false);
    expect(itemInView("ready", inProgress, [])).toBe(false);
    expect(itemInView("ready", done, [])).toBe(false);

    expect(itemInView(view, active, ["working"])).toBe(true);
    expect(itemInView(view, inProgress, [])).toBe(true);
    expect(itemInView(view, done, [])).toBe(true);
    expect(itemInView(view, cancelled, [])).toBe(true);
    expect(itemInView(view, captured, [])).toBe(true);
    expect(workViewStatuses(view)).toBeUndefined();
  });
});

describe("workItemOwningProject", () => {
  const owner = ProjectId.make("item-project");
  const elsewhere = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");

  it("reads the project from the item's source, whichever others are listed", () => {
    expect(
      workItemOwningProject(
        [
          { sourceId: elsewhere, projectId: ProjectId.make("thread-project") },
          { sourceId, projectId: owner },
        ],
        ref,
      ),
    ).toBe(owner);
  });

  it("names no project for a source it does not hold, rather than guess", () => {
    expect(workItemOwningProject([], ref)).toBeUndefined();
    expect(workItemOwningProject([{ sourceId: elsewhere, projectId: owner }], ref)).toBeUndefined();
  });
});

describe("changedSinceLink", () => {
  const baselined = (scopeFingerprint: string) =>
    link({
      snapshot: {
        key: "fd-7k3qa2",
        title: "T",
        status: "todo",
        url: null,
        revision: "r1",
        autoStarted: false,
        scopeFingerprint,
      },
    });

  it("reads what the item says, not its revision, which every comment and status moves", () => {
    expect(changedSinceLink(baselined("scope"), { scopeFingerprint: "scope" })).toBe(false);
    expect(changedSinceLink(baselined("scope"), { scopeFingerprint: "edited" })).toBe(true);
  });

  it("never claims a change for a link stored without a baseline", () => {
    expect(changedSinceLink(link(), { scopeFingerprint: "edited" })).toBe(false);
  });

  it("claims none from an older server that sends no fingerprint", () => {
    expect(changedSinceLink(baselined("scope"), {})).toBe(false);
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

  it("offers nothing on a Factory link, whatever its run did", () => {
    const none = { backToTodo: false, markDone: false };
    expect(
      linkPrompts(link({ origin: "factory", run: { status: "failed", at: "x" } }), {
        status: "in_progress",
      }),
    ).toEqual(none);
    expect(
      linkPrompts(link({ origin: "factory", run: { status: "completed", at: "x" } }), {
        status: "todo",
      }),
    ).toEqual(none);
    // The same links without an origin still prompt.
    expect(
      linkPrompts(link({ run: { status: "completed", at: "x" } }), { status: "todo" }).markDone,
    ).toBe(true);
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

describe("workEmptyState", () => {
  const none = { labels: [], assignedToMe: false };

  it("names a label or assignee filter before the view, and offers to clear it", () => {
    expect(
      workEmptyState({ view: "ready", labels: ["auth", "urgent"], assignedToMe: true, term: "x" }),
    ).toEqual({
      title: "No items match these filters",
      detail: "Nothing matching “x”, labelled auth and urgent, assigned to you is in Ready.",
      action: "clear-filters",
    });
    expect(workEmptyState({ view: "all", labels: [], assignedToMe: true }).action).toBe(
      "clear-filters",
    );
  });

  it("offers to clear a search that is the only thing narrowing the list", () => {
    const state = workEmptyState({ ...none, view: "ready", term: `  ${"long ".repeat(20)}` });
    expect(state.action).toBe("clear-search");
    expect(state.title.length).toBeLessThan(80);
  });

  it("says what a view holds, and leads out of every view but All", () => {
    expect(workEmptyState({ ...none, view: "ready" })).toEqual({
      title: "Nothing in Ready",
      detail: "Ready shows unblocked to-do items that nobody is working on.",
      action: "show-all",
    });
    expect(workEmptyState({ ...none, view: "all", term: " " })).toMatchObject({
      title: "No items",
      action: null,
    });
  });
});
