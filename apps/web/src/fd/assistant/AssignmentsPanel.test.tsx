import { cloneElement, StrictMode, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  control: vi.fn(),
  navigate: vi.fn(),
  connection: "connected",
  run: null as { runId: string; status: string; completedAt: string | null } | null,
  passthrough: ({ children }: { children?: unknown }) => children ?? null,
}));
vi.mock("~/components/ui/button", () => ({ Button: (props: object) => <button {...props} /> }));
vi.mock("~/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span data-badge>{children}</span>,
}));
vi.mock("~/components/ui/popover", () => ({
  Popover: mocks.passthrough,
  PopoverPopup: mocks.passthrough,
  PopoverTitle: mocks.passthrough,
  PopoverTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
}));
vi.mock("~/components/ui/alert-dialog", () => ({
  AlertDialog: mocks.passthrough,
  AlertDialogClose: mocks.passthrough,
  AlertDialogDescription: mocks.passthrough,
  AlertDialogFooter: mocks.passthrough,
  AlertDialogHeader: mocks.passthrough,
  AlertDialogPopup: mocks.passthrough,
  AlertDialogTitle: mocks.passthrough,
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: mocks.passthrough,
  MenuPopup: mocks.passthrough,
  MenuTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  MenuItem: (props: object) => <button data-menu-item {...props} />,
}));
vi.mock("~/state/entities", () => ({
  useProjects: () => [],
  useThreadShells: () => [],
  useThreadShell: () => ({ latestRun: mocks.run }),
}));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: mocks.connection } }),
}));
vi.mock("~/hooks/useLiveRefresh", () => ({ useLiveRefresh: () => undefined }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("./commands", () => ({
  readOverview: "read-overview",
  controlAssignment: { permissionAtom: () => "allowed" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (command === "read-overview" ? mocks.read : mocks.control),
}));
import { AssignmentsPanel } from "./AssignmentsPanel";

beforeEach(() => {
  mocks.connection = "connected";
  mocks.run = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

const overview = (state: string) => ({
  _tag: "Success" as const,
  value: {
    ideas: [],
    assignments: [
      {
        assignmentId: "a-1",
        projectId: ProjectId.make("p"),
        ideaId: "i-1",
        state,
        attempt: 1,
        goal: "Ship it",
        brief: "",
        threadId: null,
        runId: null,
        evidence: [],
        notice: "",
      },
    ],
  },
});

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("manager") };
const badge = (view: ReactTestRenderer) =>
  view.root.findAll((node) => node.props["data-badge"] === true)[0]?.props.children;
const menuItem = (view: ReactTestRenderer, label: string) =>
  view.root.findAll(
    (node) => node.props["data-menu-item"] === true && node.props.children === label,
  )[0]!;

it("shows an assignment's new state right after a control action succeeds", async () => {
  mocks.read.mockResolvedValue(overview("running"));
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<AssignmentsPanel threadRef={threadRef} />);
  });
  expect(badge(view)).toBe("Running");
  expect(mocks.read).toHaveBeenCalledTimes(1);

  mocks.control.mockResolvedValue({ _tag: "Success", value: undefined });
  mocks.read.mockResolvedValue(overview("stopped"));
  await act(async () => {
    await menuItem(view, "Stop").props.onClick();
  });
  expect(mocks.control).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { assignmentId: "a-1", managerThreadId: threadRef.threadId, action: "stop" },
  });
  expect(mocks.read).toHaveBeenCalledTimes(2);
  expect(badge(view)).toBe("Stopped");
  // The stopped assignment now offers Resume.
  expect(menuItem(view, "Resume")).toBeDefined();
  await act(async () => view.unmount());
});

it("does not reread the overview when a control action fails", async () => {
  mocks.read.mockResolvedValue(overview("failed"));
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<AssignmentsPanel threadRef={threadRef} />);
  });
  mocks.control.mockResolvedValue({ _tag: "Failure", cause: "refused" });
  await act(async () => {
    await menuItem(view, "Retry").props.onClick();
  });
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(badge(view)).toBe("Failed");
  await act(async () => view.unmount());
});

const factoryOverview = (state: string, status: string) => {
  const success = overview(state);
  return {
    ...success,
    value: {
      ...success.value,
      assignments: success.value.assignments.map((item) => ({
        ...item,
        executor: "factory",
        workItem: {
          sourceId: "7e2aa85e-9347-44ce-b019-cb8dfd365b20",
          itemId: "fd-aaaaaa",
          key: "fd-aaaaaa",
          url: null,
        },
        factory: {
          deliveryId: "d1",
          status,
          stage: "verify",
          needsYou: "Verify failed.",
          capacityWait: false,
          automaticWaits: { waiting: 0, blocked: 0 },
          endedDispositions: 0,
          notices: [],
          pullRequestUrl: "https://github.com/acme/alpha/pull/7",
          threadId: null,
        },
      })),
    },
  };
};

const confirmButton = (view: ReactTestRenderer) =>
  view.root.findAll((node) => node.type === "button" && node.props.children === "Cancel work")[0]!;

/** Chooses Cancel in a row's menu, then confirms it as the owner must. */
const cancelAndConfirm = async (view: ReactTestRenderer) => {
  await act(async () => {
    await menuItem(view, "Cancel").props.onClick();
  });
  await act(async () => {
    await confirmButton(view).props.onClick();
  });
};

const menuLabels = (view: ReactTestRenderer) =>
  view.root
    .findAll((node) => node.props["data-menu-item"] === true)
    .map((node) => node.props.children);

it("offers a Factory row only what the server accepts, and refreshes after it", async () => {
  mocks.read.mockResolvedValue(factoryOverview("needs-input", "waiting"));
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<AssignmentsPanel threadRef={threadRef} />);
  });
  // A plan gate is approved in Work, and neither stops nor resumes from here.
  expect(menuLabels(view)).toEqual(["Cancel"]);

  mocks.read.mockResolvedValue(factoryOverview("needs-input", "blocked"));
  mocks.control.mockResolvedValue({ _tag: "Failure", cause: "refused" });
  await cancelAndConfirm(view);
  expect(mocks.read).toHaveBeenCalledTimes(1);
  mocks.control.mockResolvedValue({ _tag: "Success", value: undefined });
  await cancelAndConfirm(view);
  expect(mocks.read).toHaveBeenCalledTimes(2);
  expect(menuLabels(view)).toEqual(["Resume", "Cancel"]);
  await act(async () => view.unmount());
});

it("sends no cancel until the owner confirms it", async () => {
  mocks.read.mockResolvedValue(factoryOverview("running", "running"));
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<AssignmentsPanel threadRef={threadRef} />);
  });
  // Nothing to confirm yet, so the confirmation's own button cannot cancel anything.
  expect(confirmButton(view).props.disabled).toBe(true);
  await act(async () => {
    await menuItem(view, "Cancel").props.onClick();
  });
  expect(mocks.control).not.toHaveBeenCalled();
  expect(confirmButton(view).props.disabled).toBe(false);

  mocks.control.mockResolvedValue({ _tag: "Success", value: undefined });
  await act(async () => {
    await confirmButton(view).props.onClick();
  });
  expect(mocks.control).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { assignmentId: "a-1", managerThreadId: threadRef.threadId, action: "cancel" },
  });
  await act(async () => view.unmount());
});

it("opens a Factory row's Work item from the row", async () => {
  mocks.read.mockResolvedValue(factoryOverview("running", "running"));
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<AssignmentsPanel threadRef={threadRef} />);
  });
  const open = view.root.findAll(
    (node) => node.type === "button" && node.props.children === "Open in Work",
  )[0]!;
  await act(async () => open.props.onClick());
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/work",
    search: {
      project: "env:p",
      item: "7e2aa85e-9347-44ce-b019-cb8dfd365b20:fd-aaaaaa",
      view: "all",
    },
  });
  await act(async () => view.unmount());
});

const ideaOverview = {
  _tag: "Success" as const,
  value: {
    assignments: [],
    ideas: [
      {
        projectId: ProjectId.make("p"),
        ideaId: "saved",
        title: "Export visible rows",
        goal: "Export visible rows",
        brief: "Export visible rows",
        authorized: false,
        priority: null,
        priorityReason: "",
      },
    ],
  },
};
const rerender = async (view: ReactTestRenderer) => {
  await act(async () => view.update(<AssignmentsPanel threadRef={threadRef} />));
};

it("loads saved ideas as soon as the mounted environment connects and reconnects", async () => {
  mocks.connection = "connecting";
  mocks.read.mockResolvedValue(ideaOverview);
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<AssignmentsPanel threadRef={threadRef} />);
  });
  expect(mocks.read).not.toHaveBeenCalled();
  mocks.connection = "connected";
  await rerender(view);
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(view.toJSON())).toContain("Export visible rows");
  mocks.connection = "reconnecting";
  await rerender(view);
  mocks.connection = "connected";
  await rerender(view);
  expect(mocks.read).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(view.toJSON())).not.toContain("Status unavailable");
  await act(async () => view.unmount());
});

it("refreshes newly saved ideas after the assistant completes a turn, without reads while streaming", async () => {
  mocks.read.mockResolvedValue({ _tag: "Success", value: { ideas: [], assignments: [] } });
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<AssignmentsPanel threadRef={threadRef} />);
  });
  expect(mocks.read).toHaveBeenCalledTimes(1);
  mocks.run = { runId: "discussion", status: "running", completedAt: null };
  await rerender(view);
  await rerender(view);
  expect(mocks.read).toHaveBeenCalledTimes(1);
  mocks.read.mockResolvedValue(ideaOverview);
  mocks.run = { ...mocks.run, status: "completed", completedAt: "2026-11-09T20:00:00Z" };
  await rerender(view);
  expect(mocks.read).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(view.toJSON())).toContain("Export visible rows");
  await rerender(view);
  expect(mocks.read).toHaveBeenCalledTimes(2);
  mocks.run = { runId: "capture", status: "running", completedAt: null };
  await rerender(view);
  expect(mocks.read).toHaveBeenCalledTimes(2);
  await act(async () => view.unmount());
});

it("ignores an old disconnected read that fails after the reconnect loaded fresh ideas", async () => {
  let failOld!: (value: { _tag: "Failure"; cause: string }) => void;
  mocks.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        failOld = resolve;
      }),
  );
  mocks.read.mockResolvedValue(ideaOverview);
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<AssignmentsPanel threadRef={threadRef} />);
  });
  mocks.connection = "reconnecting";
  await rerender(view);
  mocks.connection = "connected";
  await rerender(view);
  expect(JSON.stringify(view.toJSON())).toContain("Export visible rows");
  await act(async () => failOld({ _tag: "Failure", cause: "not connected" }));
  expect(JSON.stringify(view.toJSON())).not.toContain("Status unavailable");
  expect(JSON.stringify(view.toJSON())).toContain("Export visible rows");
  await act(async () => view.unmount());
});

it("loads ideas when development effect replay invalidates the first read", async () => {
  mocks.read.mockResolvedValue(ideaOverview);
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(
      <StrictMode>
        <AssignmentsPanel threadRef={threadRef} />
      </StrictMode>,
    );
  });
  expect(JSON.stringify(view.toJSON())).toContain("Export visible rows");
  expect(JSON.stringify(view.toJSON())).not.toContain("Status unavailable");
  await act(async () => view.unmount());
});
