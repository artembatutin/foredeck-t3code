import { describe, expect, it } from "@effect/vitest";
import {
  WorkError,
  WorkItemId,
  type WorkItemSummary,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";
import * as Cause from "effect/Cause";

import {
  beginWorkDraft,
  beginWorkRelationshipDraft,
  editWorkDraft,
  mergeComposerText,
  parseWorkItemIds,
  rebaseWorkDraft,
  settleWorkDraft,
  workDraftChanged,
  workDraftConflictReady,
  workDraftPatch,
  workLinkCandidates,
  workRelationshipPatch,
  workStatusInput,
  workStatusUndo,
  workUndoMessage,
  workWriteOutcome,
  type WorkWriteOutcome,
} from "./writes.ts";

const sourceId = WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4");
const ref = { sourceId, itemId: WorkItemId.make("fd-7k3qa2") };
const summary = (overrides: Partial<WorkItemSummary> = {}): WorkItemSummary => ({
  ref,
  kind: "markdown",
  key: "fd-7k3qa2",
  title: "Add sync",
  status: "todo",
  nativeStatus: null,
  blocked: false,
  priority: null,
  labels: [],
  assignee: null,
  parent: null,
  blockedBy: [],
  url: null,
  updatedAt: null,
  revision: "r1",
  invalid: null,
  ...overrides,
});
const failure = (error: unknown) => ({ _tag: "Failure" as const, cause: Cause.fail(error) });
const stale = (current?: WorkItemSummary) =>
  failure(
    new WorkError({
      reason: "stale",
      message: "The item changed.",
      ...(current === undefined ? {} : { current }),
    }),
  );

/**
 * A fake item store with the server's revision rule: a write carrying an expected revision that
 * no longer matches fails as stale; every successful write moves the revision.
 */
const fakeStore = (initial: WorkItemSummary) => {
  let item = initial;
  let counter = 1;
  const write = (
    patch: { readonly expectedRevision?: string } & Partial<WorkItemSummary>,
  ): { _tag: "Success"; value: WorkItemSummary } | ReturnType<typeof stale> => {
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== item.revision) {
      return stale(item);
    }
    const { expectedRevision: _ignored, ...fields } = patch;
    counter += 1;
    item = { ...item, ...fields, revision: `r${counter}` };
    return { _tag: "Success", value: item };
  };
  return { write, current: () => item };
};

describe("workWriteOutcome", () => {
  it("separates stale, ambiguous and other failures", () => {
    expect(workWriteOutcome({ _tag: "Success", value: 1 })).toEqual({ _tag: "success", value: 1 });
    const current = summary({ revision: "r9" });
    expect(workWriteOutcome(stale(current))).toEqual({
      _tag: "stale",
      current,
      message: "The item changed.",
    });
    const candidates = [
      { id: "1", name: "Done", to: "done" as const, toName: "Done", requiresFields: false },
    ];
    expect(
      workWriteOutcome(
        failure(new WorkError({ reason: "conflict", message: "Pick one", candidates })),
      ),
    ).toEqual({ _tag: "candidates", candidates });
    expect(workWriteOutcome(failure(new Error("Offline")))).toEqual({
      _tag: "failed",
      message: "Offline",
    });
  });
});

describe("drafts", () => {
  it("saves with the revision editing began at, even after a background refresh", () => {
    const store = fakeStore(summary());
    let draft = beginWorkDraft("title", store.current());
    draft = editWorkDraft(draft, "Add two-way sync");
    // Another client changes the item; the view refreshes underneath the open editor.
    store.write({ labels: ["sync"] });
    expect(store.current().revision).toBe("r2");
    const patch = workDraftPatch(ref, draft);
    expect(patch).toEqual({ ref, title: "Add two-way sync", expectedRevision: "r1" });
    const outcome = workWriteOutcome(store.write(patch));
    expect(outcome._tag).toBe("stale");
    // The owner's text survives the conflict, which carries the item as it is now.
    const conflicted = settleWorkDraft(draft, outcome);
    expect(conflicted?.value).toBe("Add two-way sync");
    expect(conflicted?.conflict?.current?.revision).toBe("r2");
    expect(store.current().title).toBe("Add sync");
  });

  it("reapplies the draft on the current version only when asked", () => {
    const store = fakeStore(summary());
    const draft = editWorkDraft(beginWorkDraft("body", { ...store.current(), body: "Old" }), "New");
    store.write({ title: "Renamed elsewhere" });
    const conflicted = settleWorkDraft(
      draft,
      workWriteOutcome(store.write(workDraftPatch(ref, draft))),
    );
    const rebased = rebaseWorkDraft(conflicted!, store.current().revision);
    expect(rebased.conflict).toBeNull();
    expect(rebased.value).toBe("New");
    const saved = workWriteOutcome(store.write(workDraftPatch(ref, rebased)));
    expect(saved._tag).toBe("success");
    expect(settleWorkDraft(rebased, saved)).toBeNull();
  });

  it("keeps the draft on an ordinary failure and knows when nothing changed", () => {
    const draft = beginWorkDraft("title", summary());
    const failed: WorkWriteOutcome<unknown> = { _tag: "failed", message: "Offline" };
    expect(settleWorkDraft(draft, failed)).toBe(draft);
    expect(workDraftChanged(draft, summary())).toBe(false);
    expect(workDraftChanged(editWorkDraft(draft, "  "), summary())).toBe(false);
    expect(workDraftChanged(editWorkDraft(draft, "New title"), summary())).toBe(true);
  });
});

describe("status changes and Undo", () => {
  it("guards a status change with the revision on screen", () => {
    expect(workStatusInput(summary({ revision: "r4" }), { status: "done" })).toEqual({
      ref,
      status: "done",
      expectedRevision: "r4",
    });
  });

  it("undoes its own change when nothing happened in between", () => {
    const store = fakeStore(summary({ status: "in_progress" }));
    const before = store.current();
    const done = store.write(workStatusInput(before, { status: "done" }) as never);
    if (done._tag !== "Success") throw new Error("expected success");
    const undo = workStatusUndo(before, done.value);
    expect(undo).toEqual({ ref, status: "in_progress", expectedRevision: done.value.revision });
    const outcome = workWriteOutcome(store.write(undo as never));
    expect(outcome._tag).toBe("success");
    expect(store.current().status).toBe("in_progress");
    expect(workUndoMessage("fd-7k3qa2", outcome)).toBeNull();
  });

  it("refuses to undo over a later write by someone else", () => {
    const store = fakeStore(summary({ status: "in_progress" }));
    const before = store.current();
    const backToTodo = store.write(workStatusInput(before, { status: "todo" }) as never);
    if (backToTodo._tag !== "Success") throw new Error("expected success");
    // An agent picks the item up again before the owner presses Undo.
    store.write({ status: "in_progress", title: "Claimed by agent" });
    const outcome = workWriteOutcome(
      store.write(workStatusUndo(before, backToTodo.value) as never),
    );
    expect(outcome._tag).toBe("stale");
    expect(store.current().title).toBe("Claimed by agent");
    expect(workUndoMessage("fd-7k3qa2", outcome)).toMatch(/Undo was not applied/);
  });

  it("has nothing to undo from an unknown status or a no-op", () => {
    expect(workStatusUndo({ status: "unknown" }, summary({ status: "done" }))).toBeNull();
    expect(workStatusUndo({ status: "done" }, summary({ status: "done" }))).toBeNull();
  });
});

describe("mergeComposerText", () => {
  it("adds to an unsent draft instead of replacing it", () => {
    expect(mergeComposerText("", "Update")).toBe("Update");
    expect(mergeComposerText("  \n", "Update")).toBe("Update");
    expect(mergeComposerText("Please also fix the tests\n", "Update")).toBe(
      "Please also fix the tests\n\nUpdate",
    );
    expect(mergeComposerText("Mine\n\nUpdate", "Update")).toBe("Mine\n\nUpdate");
  });
});

describe("parseWorkItemIds", () => {
  it("reads ids the owner typed and reports the rest", () => {
    expect(parseWorkItemIds("PROJ-1, #12  fd-7k3qa2,PROJ-1")).toEqual({
      ids: ["PROJ-1", "12", "fd-7k3qa2"],
      invalid: [],
    });
    expect(parseWorkItemIds("ok -bad")).toEqual({ ids: ["ok"], invalid: ["-bad"] });
    expect(parseWorkItemIds("  ")).toEqual({ ids: [], invalid: [] });
  });
});

describe("workLinkCandidates", () => {
  it("offers open, unlinked threads of the item's project", () => {
    const shell = (id: string, overrides: Record<string, unknown> = {}) => ({
      environmentId: "e1",
      projectId: "p1",
      id,
      title: `Thread ${id}`,
      archivedAt: null as string | null,
      ...overrides,
    });
    const shells = [
      shell("a"),
      shell("b", { archivedAt: "x" }),
      shell("c", { projectId: "p2" }),
      shell("d"),
      shell("e", { title: "Fix sync" }),
    ];
    const ids = (query: string) =>
      workLinkCandidates(shells, {
        environmentId: "e1",
        projectId: "p1",
        linked: ["d"],
        query,
      }).map((entry) => entry.id);
    expect(ids("")).toEqual(["a", "e"]);
    expect(ids("SYNC")).toEqual(["e"]);
  });
});

describe("relationship drafts", () => {
  it("saves blocked-by against the revision the edit started from, not a later refresh", () => {
    const opened = summary({ revision: "r1", blockedBy: [WorkItemId.make("fd-aaaaaa")] });
    let draft = beginWorkRelationshipDraft(opened, "blockedBy");
    // Another client adds a blocker; the item refreshes to r2 while the editor stays open.
    draft = { ...draft, value: `${draft.value}, fd-bbbbbb` };
    expect(workRelationshipPatch(draft)).toEqual({
      patch: { blockedBy: ["fd-aaaaaa", "fd-bbbbbb"], expectedRevision: "r1" },
    });
  });

  it("guards parents too and names what is not an id", () => {
    const draft = beginWorkRelationshipDraft(summary({ revision: "r3" }), "parent");
    expect(workRelationshipPatch({ ...draft, value: "#12" })).toEqual({
      patch: { parent: "12", expectedRevision: "r3" },
    });
    expect(workRelationshipPatch({ ...draft, value: "" })).toEqual({
      patch: { parent: null, expectedRevision: "r3" },
    });
    expect(workRelationshipPatch({ ...draft, value: "a, b" })).toEqual({
      invalid: "Enter one item id.",
    });
    expect(workRelationshipPatch({ ...draft, value: "fd/1" })).toEqual({
      invalid: "Not item ids: fd/1",
    });
  });
});

describe("workDraftConflictReady", () => {
  it("is ready once any newer version is shown, even past the one the conflict named", () => {
    const draft = settleWorkDraft(beginWorkDraft("title", summary({ revision: "r1" })), {
      _tag: "stale",
      current: summary({ revision: "r2" }),
      message: "stale",
    })!;
    expect(workDraftConflictReady(draft, "r1")).toBe(false);
    expect(workDraftConflictReady(draft, "r2")).toBe(true);
    // Another edit landed before the reload.
    expect(workDraftConflictReady(draft, "r3")).toBe(true);
    expect(workDraftConflictReady(beginWorkDraft("title", summary()), "r9")).toBe(false);
  });
});
