import { cloneElement, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  control: vi.fn(),
  navigate: vi.fn(),
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
vi.mock("~/components/ui/menu", () => ({
  Menu: mocks.passthrough,
  MenuPopup: mocks.passthrough,
  MenuTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  MenuItem: (props: object) => <button data-menu-item {...props} />,
}));
vi.mock("~/state/entities", () => ({ useProjects: () => [], useThreadShells: () => [] }));
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
  await act(async () => {
    await menuItem(view, "Cancel").props.onClick();
  });
  expect(mocks.read).toHaveBeenCalledTimes(1);
  mocks.control.mockResolvedValue({ _tag: "Success", value: undefined });
  await act(async () => {
    await menuItem(view, "Cancel").props.onClick();
  });
  expect(mocks.read).toHaveBeenCalledTimes(2);
  expect(menuLabels(view)).toEqual(["Resume", "Cancel"]);
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
    },
  });
  await act(async () => view.unmount());
});
