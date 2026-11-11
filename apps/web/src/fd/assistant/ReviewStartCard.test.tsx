import type { ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  revise: vi.fn(),
  start: vi.fn(),
  commands: {
    readReview: { name: "read" },
    reviseReview: { name: "revise", permissionAtom: () => "may-edit" },
    startReview: { name: "start", permissionAtom: () => "may-start" },
  },
  passthrough: ({ children }: { children?: unknown }) => children ?? null,
}));
vi.mock("~/components/ui/button", () => ({ Button: (props: object) => <button {...props} /> }));
vi.mock("~/components/ui/input", () => ({ Input: (props: object) => <input {...props} /> }));
vi.mock("~/components/ui/textarea", () => ({
  Textarea: (props: object) => <textarea {...props} />,
}));
vi.mock("~/components/ui/alert", () => ({
  Alert: mocks.passthrough,
  AlertDescription: mocks.passthrough,
  AlertTitle: mocks.passthrough,
}));
vi.mock("~/components/ui/dialog", () => ({
  Dialog: mocks.passthrough,
  DialogDescription: mocks.passthrough,
  DialogFooter: mocks.passthrough,
  DialogHeader: mocks.passthrough,
  DialogPanel: mocks.passthrough,
  DialogPopup: mocks.passthrough,
  DialogTitle: mocks.passthrough,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("./commands", () => mocks.commands);
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { readonly name: "read" | "revise" | "start" }) => mocks[command.name],
}));
import { ReviewStartCard } from "./ReviewStartCard";

/** The brief as the server holds it, which a test changes behind the card's back. */
let server: {
  revision: number;
  goal: string;
  constraints: ReadonlyArray<string>;
  kind?: "single" | "parent";
};

const sources = [
  { sourceId: "source", kind: "markdown", label: "Tasks", identity: ".foredeck/work" },
  { sourceId: "other", kind: "markdown", label: "Other tasks", identity: "other/tasks" },
];
const snapshotOf = (input: { readonly kind: "single" | "parent"; readonly sourceId?: string }) => {
  const role = {
    instanceId: "codex",
    model: "m",
    offered: true,
    options: [],
    optionsOmitted: 0,
    acknowledgement: "not_reported",
  };
  return {
    reviewVersion: `version-${server.revision}-${server.kind ?? input.kind}`,
    projectId: "project",
    ideaId: "idea",
    briefRevision: server.revision,
    title: { text: "Derived", origin: "derived" },
    goal: server.goal,
    acceptanceCriteria: ["Works"],
    constraints: server.constraints,
    decisions: [],
    openQuestions: [],
    conversationNotes: { items: [], delivered: false },
    scopeChanges: null,
    target: {
      repository: null,
      kind: server.kind ?? input.kind,
      kindFixed: server.kind !== undefined,
      source: sources.find((source) => source.sourceId === input.sourceId) ?? sources[0],
      sources,
      sourcesOmitted: 0,
      item: null,
    },
    roles: { planner: { ...role, model: "planner-model" }, author: role, reviewer: role },
    verifyCommand: null,
    setupCommand: null,
    limits: {
      maxFixRounds: 3,
      maxReviewRounds: 3,
      maxFixCommitTurns: null,
      verifyTimeoutMinutes: 30,
      verifyTimeoutScope: "per_command",
      totalTime: "unsupported",
    },
    blockingSeverities: [],
    highRiskEffort: "xhigh",
    pipelineId: "standard",
    runtime: { requested: "full-access", ceiling: "full-access" },
    overrides: [],
    attempts: [],
    attemptsOmitted: 0,
    start: { mode: server.kind === undefined ? "new_attempt" : "amend", blockers: [] },
    briefTruncated: false,
    truncated: false,
  };
};

beforeEach(() => {
  server = { revision: 1, goal: "Add the export", constraints: ["No new dependencies"] };
  mocks.read.mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: snapshotOf(input),
  }));
  // As the assistant's own revise judges it: a revision the brief moved on from is refused.
  mocks.revise.mockImplementation(async ({ input }) => {
    if (input.expectedRevision !== server.revision) {
      return { _tag: "Failure", cause: Cause.fail(new Error("Your edit was not saved.")) };
    }
    server = { ...server, ...input.patch, revision: server.revision + 1 };
    return { _tag: "Success", value: undefined };
  });
  mocks.start.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("Stale.")) });
});

afterEach(() => {
  vi.clearAllMocks();
});

const open = async () => {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(
      <ReviewStartCard
        environmentId={EnvironmentId.make("environment")}
        managerThreadId={ThreadId.make("fd-assistant-owner")}
        target={{ projectId: ProjectId.make("project"), ideaId: "idea" }}
        onClose={() => undefined}
        onStarted={() => undefined}
      />,
    );
  });
  return view;
};

const button = (view: ReactTestRenderer, label: string) =>
  view.root.findAll((node) => node.type === "button" && node.props.children === label)[0];

const click = async (view: ReactTestRenderer, label: string) => {
  const found = button(view, label);
  if (found === undefined) throw new Error(`No ${label} button.`);
  await act(async () => found.props.onClick());
};

const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const field = (view: ReactTestRenderer, label: string): ReactTestInstance =>
  view.root.findByProps({ "aria-label": label });

const type = async (view: ReactTestRenderer, label: string, value: string) => {
  await act(async () => field(view, label).props.onChange({ target: { value } }));
};

const textOf = (view: ReactTestRenderer) => {
  const text = (node: ReactNode): string =>
    typeof node === "string"
      ? node
      : node === null || node === undefined || typeof node === "boolean"
        ? ""
        : Array.isArray(node)
          ? node.map(text).join(" ")
          : "";
  return view.root
    .findAll((node) => node.type === "p" || node.type === "dd")
    .map((node) => text(node.props.children))
    .join("\n");
};

it("never saves a draft over a correction that landed during a kind change", async () => {
  const view = await open();
  await type(view, "Restriction 1", "Keep it small");

  // Someone corrects the goal, and the owner then asks to deliver it another way.
  server = { ...server, revision: 2, goal: "Add the export, corrected" };
  await click(view, "Plan into tasks");
  expect(mocks.read).toHaveBeenCalledTimes(2);
  expect(textOf(view)).toContain("changed after you began editing");

  await click(view, "Save edits");
  expect(mocks.revise).toHaveBeenCalledTimes(1);
  expect(mocks.revise.mock.calls[0]?.[0].input).toEqual({
    projectId: "project",
    ideaId: "idea",
    expectedRevision: 1,
    patch: { constraints: ["Keep it small"] },
  });
  // Refused, and neither side lost anything: the correction stands and the draft stays.
  expect(server.goal).toBe("Add the export, corrected");
  expect(server.constraints).toEqual(["No new dependencies"]);
  expect(textOf(view)).toContain("Your edit was not saved.");
  expect(field(view, "Restriction 1").props.value).toBe("Keep it small");
  expect(button(view, "Start delivery")?.props.disabled).toBe(true);

  // Discarding shows what it says now, which can then be started.
  await click(view, "Discard edits");
  expect(field(view, "Goal").props.value).toBe("Add the export, corrected");
  expect(field(view, "Restriction 1").props.value).toBe("No new dependencies");
  expect(button(view, "Save edits")).toBeUndefined();
  expect(button(view, "Start delivery")?.props.disabled).toBe(false);
  await act(async () => view.unmount());
});

it("follows a correction while its owner has typed nothing", async () => {
  const view = await open();
  server = { ...server, revision: 2, goal: "Add the export, corrected" };
  await click(view, "Plan into tasks");
  expect(field(view, "Goal").props.value).toBe("Add the export, corrected");
  expect(button(view, "Save edits")).toBeUndefined();
  expect(textOf(view)).not.toContain("changed after you began editing");
  await act(async () => view.unmount());
});

it("saves an edit of the current revision, and starts from what that left", async () => {
  const view = await open();
  await type(view, "Goal", "Add it");
  expect(button(view, "Start delivery")?.props.disabled).toBe(true);
  await click(view, "Save edits");
  expect(mocks.revise.mock.calls[0]?.[0].input.expectedRevision).toBe(1);
  expect(server.goal).toBe("Add it");
  expect(field(view, "Goal").props.value).toBe("Add it");
  expect(button(view, "Save edits")).toBeUndefined();
  await click(view, "Start delivery");
  expect(mocks.start.mock.calls[0]?.[0].input.reviewVersion).toBe("version-2-single");
  await act(async () => view.unmount());
});

it("reviews a delivery at rest as what it is, whatever was asked for", async () => {
  server = { ...server, kind: "parent" };
  const view = await open();
  // Read as a single item, and shown as the parent it is, its planner included.
  expect(mocks.read.mock.calls[0]?.[0].input.kind).toBe("single");
  expect(textOf(view)).toContain("planner-model");
  expect(button(view, "Plan into tasks")?.props.disabled).toBe(true);
  expect(button(view, "Single item")?.props.disabled).toBe(true);

  await click(view, "Resume delivery");
  expect(mocks.start.mock.calls[0]?.[0].input).toMatchObject({
    kind: "parent",
    reviewVersion: "version-1-parent",
  });
  await act(async () => view.unmount());
});

it("says where a capture would go, and confirms the source it showed", async () => {
  const view = await open();
  expect(textOf(view)).toContain("Tasks (.foredeck/work)");
  await click(view, "Start delivery");
  expect(mocks.start.mock.calls[0]?.[0].input.sourceId).toBe("source");
  await act(async () => view.unmount());
});

it("hides the planner of a single item, and asks for it once planned into tasks", async () => {
  const view = await open();
  expect(textOf(view)).not.toContain("planner-model");
  await click(view, "Plan into tasks");
  expect(textOf(view)).toContain("planner-model");
  await click(view, "Start delivery");
  expect(mocks.start.mock.calls[0]?.[0].input.kind).toBe("parent");
  await act(async () => view.unmount());
});

it.each(["success", "failure"])(
  "ignores a superseded %s while reviewing rapid kind and source changes",
  async (superseded) => {
    const view = await open();
    const first = deferred();
    const latest = deferred();
    mocks.read.mockImplementationOnce(() => first.promise);
    mocks.read.mockImplementationOnce(() => latest.promise);

    await click(view, "Plan into tasks");
    expect(button(view, "Start delivery")?.props.disabled).toBe(true);
    await click(view, "Start delivery");
    expect(mocks.start).not.toHaveBeenCalled();
    await click(view, "Other tasks");
    expect(mocks.read.mock.calls.at(-1)?.[0].input).toMatchObject({
      kind: "parent",
      sourceId: "other",
    });

    await act(async () =>
      latest.resolve({
        _tag: "Success",
        value: snapshotOf({ kind: "parent", sourceId: "other" }),
      }),
    );
    expect(button(view, "Start delivery")?.props.disabled).toBe(false);
    await act(async () =>
      first.resolve(
        superseded === "success"
          ? { _tag: "Success", value: snapshotOf({ kind: "parent" }) }
          : { _tag: "Failure", cause: Cause.fail(new Error("Old request failed")) },
      ),
    );
    expect(textOf(view)).toContain("Other tasks (other/tasks)");
    expect(textOf(view)).not.toContain("Old request failed");
    await click(view, "Start delivery");
    expect(mocks.start.mock.calls[0]?.[0].input).toMatchObject({
      kind: "parent",
      sourceId: "other",
      reviewVersion: "version-1-parent",
    });
    await act(async () => view.unmount());
  },
);

it("keeps confirmation disabled when an old response arrives before the latest selection", async () => {
  const view = await open();
  const first = deferred();
  const latest = deferred();
  mocks.read.mockImplementationOnce(() => first.promise);
  mocks.read.mockImplementationOnce(() => latest.promise);
  await click(view, "Plan into tasks");
  await click(view, "Single item");
  await act(async () => first.resolve({ _tag: "Success", value: snapshotOf({ kind: "parent" }) }));
  expect(button(view, "Start delivery")?.props.disabled).toBe(true);
  await click(view, "Start delivery");
  expect(mocks.start).not.toHaveBeenCalled();
  await act(async () => latest.resolve({ _tag: "Success", value: snapshotOf({ kind: "single" }) }));
  await click(view, "Start delivery");
  expect(mocks.start.mock.calls[0]?.[0].input).toMatchObject({
    kind: "single",
    reviewVersion: "version-1-single",
  });
  await act(async () => view.unmount());
});

it("keeps typed edits when asked to close, and closes once they are discarded", async () => {
  const onClose = vi.fn();
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(
      <ReviewStartCard
        environmentId={EnvironmentId.make("environment")}
        managerThreadId={ThreadId.make("fd-assistant-owner")}
        target={{ projectId: ProjectId.make("project"), ideaId: "idea" }}
        onClose={onClose}
        onStarted={() => undefined}
      />,
    );
  });
  await type(view, "Goal", "Add it");
  // With edits there is no plain Close, and dismissing the dialog is refused, saying why.
  expect(button(view, "Close")).toBeUndefined();
  const dialog = view.root.findAll((node) => typeof node.props.onOpenChange === "function")[0]!;
  await act(async () => dialog.props.onOpenChange(false));
  expect(onClose).not.toHaveBeenCalled();
  expect(textOf(view)).toContain("Save or discard your edits before closing.");
  expect(field(view, "Goal").props.value).toBe("Add it");

  await click(view, "Discard edits");
  await click(view, "Close");
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => view.unmount());
});

it("offers a way out and another try when the review cannot be read", async () => {
  mocks.read.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("Offline.")) });
  const view = await open();
  expect(button(view, "Close")).toBeDefined();
  await click(view, "Try again");
  expect(mocks.read).toHaveBeenCalledTimes(2);
  expect(field(view, "Goal").props.value).toBe("Add the export");
  await act(async () => view.unmount());
});
