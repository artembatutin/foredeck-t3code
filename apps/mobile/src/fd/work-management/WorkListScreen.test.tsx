// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkPagedListInput } from "@t3tools/client-runtime/fd/work-management";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

const world = vi.hoisted(() => ({
  navigate: vi.fn(),
  setOptions: vi.fn(),
  pagedList: vi.fn(),
  projects: [{ environmentId: "env-a", id: "project-a", title: "Project", isScratch: false }],
  sources: [] as Array<{
    sourceId: string;
    kind: string;
    label: string;
    capabilities: { people: boolean; create: boolean };
  }>,
  items: [] as Array<{
    ref: { sourceId: string; itemId: string };
    key: string;
    title: string;
    status: string;
    blocked: boolean;
    labels: string[];
    updatedAt: null;
    assignee: string;
  }>,
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    onPress: () => void;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  ActivityIndicator: () => <span>Loading</span>,
  RefreshControl: () => null,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (value: unknown) => (Array.isArray(value) ? value : []),
  useAtomRefresh: () => () => undefined,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: world.navigate, setOptions: world.setOptions }),
}));
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: ({
    data,
    renderItem,
  }: {
    data: ReadonlyArray<{ key: string }>;
    renderItem: (props: { item: { key: string } }) => ReactNode;
  }) => (
    <div aria-label="Work items">
      {data.map((item) => (
        <div key={item.key}>{renderItem({ item })}</div>
      ))}
    </div>
  ),
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  AppTextInput: ({
    accessibilityLabel,
    value,
    onChangeText,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (value: string) => void;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onInput={(event) => onChangeText(event.currentTarget.value)}
      readOnly
    />
  ),
}));
vi.mock("../../components/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../components/ErrorBanner", () => ({ ErrorBanner: () => null }));
vi.mock("../../features/workspace/ListFilterMenu", () => ({
  ListFilterMenu: ({
    accessibilityLabel,
    actions,
    onSelect,
  }: {
    accessibilityLabel: string;
    actions: ReadonlyArray<{ id: string; title: string; state: string }>;
    onSelect: (id: string) => void;
  }) => (
    <select
      aria-label={accessibilityLabel}
      value={actions.find((action) => action.state === "on")?.id}
      onChange={(event) => onSelect(event.currentTarget.value)}
    >
      {actions.map((action) => (
        <option key={action.id} value={action.id}>
          {action.title}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => world.projects,
  useThreadShells: () => [],
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (data: unknown) => ({ data, refresh: () => undefined, error: null }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => () => undefined }));
vi.mock("./CreateWorkItemForm", () => ({ CreateWorkItemForm: () => null }));
vi.mock("./shared", () => ({
  WorkRepairNotice: () => null,
  STATUS_LABELS: { todo: "To do" },
  STATUS_SYMBOLS: { todo: { icon: "circle", tint: "" } },
}));
vi.mock("./state", () => ({
  useWorkSupport: () => new Set(["env-a"]),
  useReadableWorkEnvironments: () => ["env-a"],
  useWorkWritable: () => false,
  workCommands: { refresh: "refresh", createItem: "create" },
  workEnvironment: {
    sources: () => ({ sources: world.sources }),
    links: () => ({ links: [] }),
    pagedList: world.pagedList,
  },
}));
import { WorkListScreen } from "./WorkListScreen";

let root: Root;
let container: HTMLDivElement;
const source = (sourceId: string, kind: string, people: boolean) => ({
  sourceId,
  kind,
  label: sourceId,
  capabilities: { people, create: false },
});
const row = (id: string, sourceId: string, labels: string[], assignee = "me") => ({
  ref: { sourceId, itemId: id },
  key: id,
  title: id,
  status: "todo",
  blocked: false,
  labels,
  updatedAt: null,
  assignee,
});
const texts = () => container.querySelector('[aria-label="Work items"]')?.textContent;
const press = (label: string) =>
  act(() =>
    (container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement).click(),
  );
const change = (label: string, value: string) =>
  act(() => {
    const input = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(
      new Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
    );
  });
const render = () =>
  act(() =>
    root.render(
      <WorkListScreen
        route={{
          params: {
            environmentId: EnvironmentId.make("env-a"),
            projectId: ProjectId.make("project-a"),
          },
        }}
      />,
    ),
  );
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  world.sources = [source("remote", "github", true), source("local", "markdown", false)];
  world.items = [
    row("mine-auth", "remote", ["auth"]),
    row("theirs-auth", "remote", ["auth"], "someone"),
    row("mine-ui", "remote", ["ui"]),
    row("local-auth", "local", ["auth"]),
  ];
  world.pagedList.mockImplementation((input: WorkPagedListInput) =>
    input.sources.map((source) => ({
      sourceId: source.sourceId,
      pages: {
        items: world.items.filter(
          (item) =>
            item.ref.sourceId === source.sourceId &&
            (input.labels ?? []).every((label) => item.labels.includes(label)) &&
            (input.assignee !== "me" || item.assignee === "me"),
        ),
        waiting: false,
        nextCursor: null,
        failed: false,
      },
    })),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("mobile Work filters", () => {
  it("combines labels and assigned-to-me, excludes unsupported sources and resets both", () => {
    render();
    expect(texts()).toContain("local-auth");
    change("Filter by labels", " auth, auth ");
    press("Apply labels");
    expect(texts()).not.toContain("mine-ui");
    expect(texts()).toContain("theirs-auth");
    change("Filter by assignee", "me");
    expect(texts()).toContain("mine-auth");
    expect(texts()).not.toContain("theirs-auth");
    expect(texts()).not.toContain("local-auth");
    expect(world.pagedList.mock.lastCall?.[0]).toMatchObject({
      labels: ["auth"],
      assignee: "me",
      pageCount: 1,
    });
    press("Clear filters");
    expect(texts()).toContain("mine-ui");
    expect(texts()).toContain("theirs-auth");
    expect(texts()).toContain("local-auth");
  });

  it("hides assignment when the source cannot identify the signed-in owner", () => {
    world.sources = [source("local", "markdown", false)];
    render();
    expect(container.querySelector('[aria-label="Filter by assignee"]')).toBeNull();
    change("Filter by labels", "auth");
    press("Apply labels");
    expect(texts()).toContain("local-auth");
    expect(world.pagedList.mock.lastCall?.[0].assignee).toBeUndefined();
  });
});
