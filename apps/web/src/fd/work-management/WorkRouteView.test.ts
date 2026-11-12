import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  workItemLinkTarget,
  workItemOwningProject,
} from "@t3tools/client-runtime/fd/work-management";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";

type TestItem = {
  ref: { sourceId: string; itemId: string };
  key: string;
  title: string;
  status: string;
  blocked: boolean;
  labels: ReadonlyArray<string>;
  assignee?: "me" | "someone";
  priority: string;
  updatedAt: string;
};
type PagedListInput = {
  environmentId: string;
  statuses: ReadonlyArray<string> | undefined;
  pageCount: number;
  search?: string;
  labels?: ReadonlyArray<string>;
  assignee?: "me";
};

const world = vi.hoisted(() => ({
  navigate: vi.fn(),
  sources: vi.fn(),
  pagedList: vi.fn(),
  detail: vi.fn(),
  projects: [] as Array<{ environmentId: string; id: string; title: string; isScratch: boolean }>,
  readable: [] as Array<string>,
  items: [] as Array<TestItem>,
  pageSize: 100,
  links: [] as Array<{ ref: { sourceId: string; itemId: string }; threadId: string }>,
  shells: [] as Array<object>,
  passthrough: ({ children }: { children?: ReactNode }) => children ?? null,
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => world.navigate }));
// Escape navigation is covered by its own hook; this file tests the list and filters.
vi.mock("./useEscapeToGoBack", () => ({ useEscapeToGoBack: () => undefined }));
vi.mock("@effect/atom-react", () => ({
  useAtomRefresh: () => () => undefined,
  useAtomValue: (atom: unknown) => (Array.isArray(atom) ? atom : []),
}));
vi.mock("../../components/WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: world.passthrough,
  WorkspaceBreadcrumbItem: world.passthrough,
}));
vi.mock("../../components/WorkspacePageContainer", () => ({
  WorkspacePageContainer: world.passthrough,
}));
vi.mock("../../components/WorkspacePageHeader", () => ({ WorkspacePageHeader: world.passthrough }));
vi.mock("../../components/ui/badge", () => ({ Badge: world.passthrough }));
vi.mock("../../components/ui/button", () => ({
  Button: (props: object) => createElement("button", props),
}));
vi.mock("../../components/ui/empty", () => ({
  Empty: world.passthrough,
  EmptyContent: world.passthrough,
  EmptyDescription: world.passthrough,
  EmptyHeader: world.passthrough,
  EmptyMedia: world.passthrough,
  EmptyTitle: world.passthrough,
}));
vi.mock("../../components/ui/input-group", () => ({
  InputGroup: world.passthrough,
  InputGroupAddon: world.passthrough,
  InputGroupInput: (props: object) => createElement("input", props),
}));
vi.mock("../../components/ui/refresh-icon", () => ({ RefreshIcon: () => null }));
vi.mock("../../components/ui/select", () => ({
  Select: world.passthrough,
  SelectItem: world.passthrough,
  SelectPopup: world.passthrough,
  SelectTrigger: world.passthrough,
  SelectValue: world.passthrough,
}));
vi.mock("../../components/ui/sidebar", () => ({ SidebarInset: world.passthrough }));
vi.mock("../../components/ui/skeleton", () => ({ Skeleton: () => null }));
vi.mock("../../components/ui/toggle-group", () => ({
  Toggle: world.passthrough,
  ToggleGroup: (props: object) => createElement("div", { ...props, "data-views": true }),
}));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../hooks/useLiveRefresh", () => ({ useLiveRefresh: () => undefined }));
vi.mock("../../hooks/useNavigateBack", () => ({ useEscapeToGoBack: () => undefined }));
vi.mock("../../state/entities", () => ({
  useAllEnvironmentShellsBootstrapped: () => true,
  useProjects: () => world.projects,
  useThreadShells: () => world.shells,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (data: unknown) => ({ data, refresh: () => undefined }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => () => undefined }));
vi.mock("./CreateWorkItemDialog", () => ({ CreateWorkItemDialog: () => null }));
vi.mock("./WorkItemDetail", () => ({
  WorkItemDetail: (props: object) => createElement("section", { ...props, "data-detail": true }),
}));
vi.mock("./shared", () => ({
  SOURCE_KIND_LABELS: { markdown: "Markdown" },
  WorkRepairNotice: () => null,
  WorkSourceGlyph: () => null,
  WorkStatusBadge: () => null,
}));
vi.mock("./state", () => ({
  useReadableWorkEnvironments: () => world.readable,
  useWorkSupport: () => new Set(["env-a"]),
  useWorkWritable: () => false,
  workCommands: { refresh: "refresh", createItem: "createItem" },
  workEnvironment: {
    sources: world.sources,
    pagedList: world.pagedList,
    detail: world.detail,
    links: () => ({ links: world.links }),
  },
}));

import { selectWorkProject, validateWorkSearch, WorkRouteView } from "./WorkRouteView";

const PREFERENCES_KEY = "t3code:work-list-preferences";
const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");
const projectId = ProjectId.make("project-a");
const sourceId = WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4");
const refOf = (itemId: string) => ({ sourceId, itemId: WorkItemId.make(itemId) });
const item = (itemId: string, patch: Partial<TestItem> = {}): TestItem => ({
  ref: refOf(itemId),
  key: itemId,
  title: itemId,
  status: "todo",
  blocked: false,
  labels: [],
  priority: "none",
  updatedAt: "2026-10-31T00:00:00.000Z",
  ...patch,
});
const project = (environmentId: EnvironmentId, title: string) => ({
  environmentId,
  id: projectId,
  title,
  isScratch: false,
});

let stored: Map<string, string>;
const setItem = vi.fn();
let views: Array<ReactTestRenderer> = [];

const open = async (raw: Record<string, unknown>) => {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(createElement(WorkRouteView, { search: validateWorkSearch(raw) }));
  });
  views.push(view);
  return view;
};
const linkTo = (itemId: string, environmentId: EnvironmentId = envA) =>
  workItemLinkTarget({ environmentId, projectId, ref: refOf(itemId) }).search;
const rows = (view: ReactTestRenderer) =>
  view.root
    .findAllByType("button")
    .filter((node) => "aria-current" in node.props)
    .map((node) => ({
      current: node.props["aria-current"] === "true",
      text: node
        .findAllByType("span")
        .flatMap((span) => span.children)
        .filter((child) => typeof child === "string")
        .join(" "),
    }));
const details = (view: ReactTestRenderer) =>
  view.root.findAllByType("section").filter((node) => node.props["data-detail"]);
const lastListRead = () => world.pagedList.mock.lastCall?.[0] as PagedListInput | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  stored = new Map([[PREFERENCES_KEY, JSON.stringify({ view: "ready", assignedToMe: true })]]);
  setItem.mockImplementation((key: string, value: string) => void stored.set(key, value));
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem },
  });
  world.projects = [project(envA, "On this machine"), project(envB, "On the server")];
  world.readable = [envA, envB];
  world.items = [];
  world.pageSize = 100;
  world.links = [];
  world.shells = [];
  world.sources.mockImplementation(() => ({
    sources: [
      {
        sourceId,
        kind: "markdown",
        label: "Tasks",
        health: { status: "ok" },
        capabilities: { create: false, people: false },
      },
    ],
  }));
  world.detail.mockImplementation(
    ({ input }: { input: { ref: { sourceId: string; itemId: string } } }) =>
      world.items.find((entry) => entry.ref.itemId === input.ref.itemId) ?? null,
  );
  // As the server serves it: the statuses a view asks for, a page at a time.
  world.pagedList.mockImplementation((input: PagedListInput) => {
    const matching = world.items.filter(
      (entry) =>
        (input.statuses === undefined || input.statuses.includes(entry.status)) &&
        (input.search === undefined || entry.title.includes(input.search)) &&
        (input.labels === undefined ||
          input.labels.every((label) => entry.labels.includes(label))) &&
        (input.assignee === undefined || entry.assignee === input.assignee),
    );
    const shown = input.pageCount * world.pageSize;
    return [
      {
        sourceId,
        pages: {
          items: matching.slice(0, shown),
          nextCursor: shown < matching.length ? "next" : null,
          waiting: false,
          failed: false,
          stale: false,
          updatedAt: 1,
        },
      },
    ];
  });
});

afterEach(async () => {
  await act(async () => {
    for (const view of views) view.unmount();
  });
  views = [];
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("validateWorkSearch", () => {
  it("keeps known values and drops everything else", () => {
    expect(
      validateWorkSearch({
        project: "env:project",
        source: "s1",
        view: "done",
        q: "sync",
        item: "s1:fd-7k3qa2",
        extra: "ignored",
      }),
    ).toEqual({
      project: "env:project",
      source: "s1",
      view: "done",
      q: "sync",
      item: "s1:fd-7k3qa2",
    });
    expect(validateWorkSearch({ view: "everything", q: 3, item: "" })).toEqual({});
  });

  it("bounds free text from the URL", () => {
    expect(validateWorkSearch({ q: "x".repeat(500) }).q?.length).toBe(200);
  });

  it("keeps everything a Work item link carries", () => {
    const search = linkTo("fd-aaaaaa", envB);
    expect(validateWorkSearch(search)).toEqual(search);
  });
});

describe("selectWorkProject", () => {
  const first = project(envA, "First");
  const second = project(envB, "Second");

  it("shows the first project only when the URL names none", () => {
    expect(selectWorkProject([first, second], undefined)).toEqual({
      project: first,
      unavailable: false,
    });
    expect(selectWorkProject([], undefined)).toEqual({ project: undefined, unavailable: false });
  });

  it("selects by environment as well as project", () => {
    expect(selectWorkProject([first, second], "env-a:project-a")).toEqual({
      project: first,
      unavailable: false,
    });
    expect(selectWorkProject([first, second], "env-b:project-a")).toEqual({
      project: second,
      unavailable: false,
    });
  });

  it("selects nothing for a project it does not have", () => {
    expect(selectWorkProject([first, second], "env-c:project-a")).toEqual({
      project: undefined,
      unavailable: true,
    });
    expect(selectWorkProject([], "env-a:project-a").unavailable).toBe(true);
  });
});

describe("following a Work item link under a saved Ready filter", () => {
  const threadId = ThreadId.make("worker");
  const shell = {
    id: threadId,
    title: "Worker",
    environmentId: envA,
    latestRun: { status: "running" },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    settledAt: null,
    archivedAt: null,
  };

  beforeEach(() => {
    world.items = [
      item("fd-active"),
      item("fd-inprog", { status: "in_progress" }),
      item("fd-done", { status: "done" }),
      item("fd-gone", { status: "cancelled" }),
      item("fd-blocked", { blocked: true }),
      item("fd-captured"),
    ];
    world.links = [{ ref: refOf("fd-active"), threadId }];
    world.shells = [shell];
  });

  it.each(["fd-active", "fd-inprog", "fd-done", "fd-gone", "fd-blocked", "fd-captured"])(
    "lists %s beside its detail and leaves the saved filter alone",
    async (itemId) => {
      const before = stored.get(PREFERENCES_KEY);
      const view = await open(linkTo(itemId));

      expect(lastListRead()?.statuses).toBeUndefined();
      expect(rows(view).filter((row) => row.current)).toEqual([
        { current: true, text: expect.stringContaining(itemId) },
      ]);
      expect(rows(view)).toHaveLength(world.items.length);
      expect(details(view)).toHaveLength(1);
      expect(details(view)[0]!.props).toMatchObject({
        environmentId: envA,
        projectId,
        itemRef: refOf(itemId),
      });
      expect(setItem).not.toHaveBeenCalled();
      expect(stored.get(PREFERENCES_KEY)).toBe(before);
    },
  );

  it("still hides those items for a plain visit, which reads the saved filter", async () => {
    const view = await open({ project: "env-a:project-a" });
    expect(lastListRead()?.statuses).toEqual(["todo"]);
    expect(rows(view).map((row) => row.text)).toEqual([expect.stringContaining("fd-captured")]);
  });

  it("saves the filter when the owner picks a view, keeping the other preferences", async () => {
    const view = await open(linkTo("fd-done"));
    const toggle = view.root.findAll((node) => node.props["data-views"] === true)[0]!;
    await act(async () => toggle.props.onValueChange(["done"]));

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stored.get(PREFERENCES_KEY)!)).toEqual({ view: "done", assignedToMe: true });
    expect(world.navigate).toHaveBeenCalledWith({
      to: "/work",
      search: { ...linkTo("fd-done"), view: "done" },
      replace: true,
    });
  });

  // A Markdown source serves 100 items a page and a remote one 50; the budget is five pages.
  it.each([
    ["Markdown", 100, 500],
    ["remote", 50, 250],
  ])("lists a %s item past the page budget, without reading more pages", async (_, size, ahead) => {
    world.pageSize = size;
    world.items = [
      ...Array.from({ length: ahead }, (_, index) => item(`fd-first-${index}`)),
      item("fd-far", { status: "done" }),
    ];
    const view = await open(linkTo("fd-far"));

    expect(lastListRead()?.pageCount).toBe(1);
    expect(world.detail).toHaveBeenLastCalledWith({
      environmentId: envA,
      input: { ref: refOf("fd-far") },
    });
    const shown = rows(view);
    expect(shown).toHaveLength(size + 1);
    expect(shown[0]).toEqual({ current: true, text: expect.stringContaining("fd-far") });
    expect(shown.filter((row) => row.current)).toHaveLength(1);
    expect(details(view)[0]!.props.itemRef).toEqual(refOf("fd-far"));
  });

  it("moves it into place once the pages reach it, listed once", async () => {
    world.pageSize = 30;
    world.items = [
      ...Array.from({ length: 35 }, (_, index) => item(`fd-first-${index}`)),
      item("fd-far", { status: "done" }),
    ];
    const view = await open(linkTo("fd-far"));
    expect(rows(view)).toHaveLength(31);

    world.detail.mockClear();
    const more = view.root
      .findAllByType("button")
      .find((node) => node.props.children === "Load more items")!;
    await act(async () => more.props.onClick());

    expect(lastListRead()?.pageCount).toBe(2);
    expect(rows(view)).toHaveLength(36);
    expect(rows(view).filter((row) => row.current)).toEqual([
      { current: true, text: expect.stringContaining("fd-far") },
    ]);
    expect(world.detail).not.toHaveBeenCalled();
  });

  it("does not list an item whose own read found nothing", async () => {
    world.pageSize = 30;
    world.items = Array.from({ length: 90 }, (_, index) => item(`fd-first-${index}`));
    const view = await open(linkTo("fd-missing"));
    expect(lastListRead()?.pageCount).toBe(1);
    expect(rows(view)).toHaveLength(30);
    expect(rows(view).filter((row) => row.current)).toEqual([]);
  });

  it("makes no read of its own for an item the pages already list", async () => {
    world.items = [item("fd-near"), item("fd-other")];
    const view = await open(linkTo("fd-near"));
    expect(world.detail).not.toHaveBeenCalled();
    expect(rows(view)).toHaveLength(2);
  });

  it("leaves the list alone while its first page loads", async () => {
    world.items = [item("fd-near")];
    world.pagedList.mockImplementation(() => [
      {
        sourceId,
        pages: {
          items: [],
          nextCursor: null,
          waiting: true,
          failed: false,
          stale: false,
          updatedAt: 0,
        },
      },
    ]);
    const view = await open(linkTo("fd-near"));
    expect(rows(view)).toEqual([]);
  });

  it("reads no further pages once the list shows enough and no item is linked", async () => {
    world.pageSize = 30;
    world.items = Array.from({ length: 90 }, (_, index) => item(`fd-first-${index}`));
    await open({ project: "env-a:project-a", view: "all" });
    expect(lastListRead()?.pageCount).toBe(1);
  });

  it.each([
    ["a filtered view", { view: "ready" }],
    ["a search", { q: "fd-first" }],
    ["another source", { source: "another-source" }],
  ])("leaves out an open item that %s has left out", async (_, narrowed) => {
    world.pageSize = 30;
    world.items = [
      ...Array.from({ length: 90 }, (_, index) => item(`fd-first-${index}`)),
      item("fd-done", { status: "done" }),
    ];
    const view = await open({
      view: "all",
      project: "env-a:project-a",
      item: `${sourceId}:fd-done`,
      ...narrowed,
    });
    expect(world.detail).not.toHaveBeenCalled();
    expect(rows(view).filter((row) => row.current)).toEqual([]);
  });
});

describe("a Work item link's project", () => {
  beforeEach(() => {
    world.items = [item("fd-aaaaaa")];
  });

  it("lists an item of another project than its thread's, beside its detail", async () => {
    const owner = ProjectId.make("item-project");
    const source = world.sources.getMockImplementation()!();
    world.projects = [project(envA, "The thread's"), { ...project(envA, "The item's"), id: owner }];
    // As the server lists them: a project's own sources, none of another's.
    world.sources.mockImplementation(({ input }: { input: { projectId: string } }) =>
      input.projectId === owner ? source : { sources: [] },
    );

    const target = workItemLinkTarget({
      environmentId: envA,
      projectId: workItemOwningProject([{ sourceId, projectId: owner }], { sourceId })!,
      ref: refOf("fd-aaaaaa"),
    });
    const view = await open(target.search);

    expect(world.sources.mock.lastCall?.[0]).toMatchObject({
      environmentId: envA,
      input: { projectId: owner },
    });
    expect(details(view)[0]!.props).toMatchObject({
      environmentId: envA,
      projectId: owner,
      itemRef: refOf("fd-aaaaaa"),
    });
    expect(rows(view)).toEqual([{ current: true, text: expect.stringContaining("fd-aaaaaa") }]);
  });

  it("lists no row for an item of a source the page does not show, leaving it to the detail", async () => {
    world.sources.mockImplementation(() => ({ sources: [] }));
    const view = await open(linkTo("fd-aaaaaa"));
    expect(details(view)).toHaveLength(1);
    expect(rows(view)).toEqual([]);
  });

  it("opens in its own environment when two hold the same project id", async () => {
    const view = await open(linkTo("fd-aaaaaa", envB));
    expect(world.sources.mock.lastCall?.[0]).toMatchObject({ environmentId: envB });
    expect(lastListRead()?.environmentId).toBe(envB);
    expect(details(view)[0]!.props.environmentId).toBe(envB);
    expect(JSON.stringify(view.toJSON())).not.toContain("Project unavailable");
  });

  it.each([
    ["no client holds it", () => undefined],
    [
      "this client holds but cannot read its environment",
      () => {
        world.readable = [envA];
      },
    ],
  ])("says the project is unavailable when %s", async (_, arrange) => {
    arrange();
    const environmentId = world.readable.length === 1 ? envB : EnvironmentId.make("env-gone");
    const view = await open(linkTo("fd-aaaaaa", environmentId));

    expect(JSON.stringify(view.toJSON())).toContain("Project unavailable");
    // No other project's list or item stands in for it.
    expect(world.sources).not.toHaveBeenCalled();
    expect(world.pagedList).not.toHaveBeenCalled();
    expect(rows(view)).toEqual([]);
    expect(details(view)).toEqual([]);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("offers a way out of an unavailable project, back to the saved filter", async () => {
    const view = await open(linkTo("fd-aaaaaa", EnvironmentId.make("env-gone")));
    const leave = view.root
      .findAllByType("button")
      .find((node) => node.props.children === "Open another project")!;
    await act(async () => leave.props.onClick());
    expect(world.navigate).toHaveBeenCalledWith({ to: "/work", search: {}, replace: true });
  });

  it("offers no way out when there is no other project", async () => {
    world.projects = [];
    const view = await open(linkTo("fd-aaaaaa"));
    expect(JSON.stringify(view.toJSON())).toContain("Project unavailable");
    expect(
      view.root
        .findAllByType("button")
        .filter((node) => node.props.children === "Open another project"),
    ).toEqual([]);
  });
});

describe("Work search navigation", () => {
  const searchInput = (view: ReactTestRenderer) =>
    view.root.findByProps({ "aria-label": "Search work" });
  const visit = async (view: ReactTestRenderer, search: Record<string, unknown>) => {
    await act(async () =>
      view.update(createElement(WorkRouteView, { search: validateWorkSearch(search) })),
    );
  };
  const type = async (view: ReactTestRenderer, value: string) => {
    await act(async () => searchInput(view).props.onChange({ target: { value } }));
  };
  const tick = async () =>
    act(async () => {
      vi.advanceTimersByTime(250);
    });

  it("clears an obsolete search and cancels pending typing when an item link opens", async () => {
    world.items = [item("fd-captured")];
    const view = await open({ project: "env-a:project-a", q: "obsolete" });
    await type(view, "pending obsolete");
    await visit(view, linkTo("fd-captured"));
    await tick();
    expect(searchInput(view).props.value).toBe("");
    expect(world.navigate).not.toHaveBeenCalled();
    expect(rows(view)).toEqual([{ current: true, text: expect.stringContaining("fd-captured") }]);
  });

  it("debounces ordinary typing and retains typing ahead of the route acknowledgement", async () => {
    const view = await open({ project: "env-a:project-a" });
    await type(view, "first");
    await tick();
    expect(world.navigate).toHaveBeenCalledTimes(1);
    await type(view, "first second");
    await visit(view, { project: "env-a:project-a", q: "first" });
    expect(searchInput(view).props.value).toBe("first second");
    await tick();
    expect(world.navigate).toHaveBeenLastCalledWith({
      to: "/work",
      search: { project: "env-a:project-a", q: "first second" },
      replace: true,
    });
    await visit(view, { project: "env-a:project-a", q: "first second" });
    await tick();
    expect(world.navigate).toHaveBeenCalledTimes(2);
  });

  it("keeps the typing deadline when the same route renders again", async () => {
    const search = { project: "env-a:project-a" };
    const view = await open(search);
    await type(view, "current query");
    await act(async () => {
      vi.advanceTimersByTime(125);
    });
    await visit(view, search);
    await act(async () => {
      vi.advanceTimersByTime(125);
    });
    expect(world.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/work",
      search: { ...search, q: "current query" },
      replace: true,
    });
  });

  it("back and forward restore each URL search without writing it back", async () => {
    const view = await open({ project: "env-a:project-a", q: "second" });
    await type(view, "discard this draft");
    await visit(view, { project: "env-a:project-a", q: "first" });
    expect(searchInput(view).props.value).toBe("first");
    await tick();
    await visit(view, { project: "env-a:project-a", q: "second" });
    expect(searchInput(view).props.value).toBe("second");
    await tick();
    expect(world.navigate).not.toHaveBeenCalled();
  });
});

describe("Work label and assignee filters", () => {
  beforeEach(() => {
    world.sources.mockImplementation(() => ({
      sources: [
        {
          sourceId,
          kind: "github",
          label: "Issues",
          health: { status: "ok" },
          capabilities: { create: false, people: true },
        },
      ],
    }));
    world.items = [
      item("mine-auth", { labels: ["auth", "urgent"], assignee: "me" }),
      item("their-auth", { labels: ["auth", "urgent"], assignee: "someone" }),
      item("mine-ui", { labels: ["ui"], assignee: "me" }),
    ];
  });

  it("combines saved assignment with all selected labels and clears both", async () => {
    const view = await open({ project: "env-a:project-a", labels: ["urgent", "auth"] });
    expect(rows(view).map((row) => row.text)).toEqual([expect.stringContaining("mine-auth")]);
    expect(lastListRead()).toMatchObject({ assignee: "me", labels: ["auth", "urgent"] });
    const clear = view.root
      .findAllByType("button")
      .find((node) => node.props.children === "Clear filters")!;
    await act(async () => clear.props.onClick());
    const next = world.navigate.mock.lastCall?.[0].search;
    await act(async () => view.update(createElement(WorkRouteView, { search: next })));
    expect(rows(view)).toHaveLength(3);
    expect(lastListRead()?.assignee).toBeUndefined();
    expect(lastListRead()?.labels).toEqual([]);
  });

  it("applies labels absent from the first page and resets pagination", async () => {
    world.pageSize = 30;
    world.items = [
      ...Array.from({ length: 35 }, (_, index) => item(`other-${index}`, { assignee: "me" })),
      item("matching", { labels: ["later"], assignee: "me" }),
    ];
    const view = await open({ project: "env-a:project-a", view: "all" });
    const more = view.root
      .findAllByType("button")
      .find((node) => node.props.children === "Load more items")!;
    await act(async () => more.props.onClick());
    expect(lastListRead()?.pageCount).toBe(2);
    const input = view.root.findByProps({ "aria-label": "Filter by labels" });
    await act(async () => input.props.onChange({ target: { value: " later, later " } }));
    await act(async () => view.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    const next = world.navigate.mock.lastCall?.[0].search;
    await act(async () => view.update(createElement(WorkRouteView, { search: next })));
    expect(lastListRead()?.pageCount).toBe(1);
    expect(rows(view).map((row) => row.text)).toEqual([expect.stringContaining("matching")]);
  });

  it("opens a linked item outside the saved assigned-to-me filter without changing that preference", async () => {
    const view = await open(linkTo("their-auth"));
    expect(lastListRead()?.assignee).toBeUndefined();
    expect(rows(view).filter((row) => row.current)).toEqual([
      { current: true, text: expect.stringContaining("their-auth") },
    ]);
    expect(JSON.parse(stored.get(PREFERENCES_KEY)!).assignedToMe).toBe(true);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("saves an explicit assignment choice and retains the view preference", async () => {
    const view = await open({ project: "env-a:project-a" });
    const toggle = view.root
      .findAllByType("button")
      .find((node) => node.props.children === "Assigned to me")!;
    await act(async () => toggle.props.onClick());
    const next = world.navigate.mock.lastCall?.[0].search;
    await act(async () => view.update(createElement(WorkRouteView, { search: next })));
    expect(rows(view)).toHaveLength(3);
    expect(JSON.parse(stored.get(PREFERENCES_KEY)!)).toEqual({
      view: "ready",
      assignedToMe: false,
    });
  });
});
