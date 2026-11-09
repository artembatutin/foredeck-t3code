import { type ReactNode, useSyncExternalStore } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";

type SourcesView = { data: { sources: Array<object> } | null; error: string | null };

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  setLink: vi.fn(),
  links: [] as Array<object>,
  // Each environment's sources as the server lists them for a request.
  sources: vi.fn(),
  requested: [] as Array<{ environmentId: string; input: { includeDisconnected: boolean } }>,
  // Moves when a query publishes, as a mounted query's atom re-renders its reader.
  published: 0,
  readers: new Set<() => void>(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../components/chat/ThreadDetailsControl", () => ({
  ThreadDetailsControl: (props: object) => <button {...props} />,
}));
vi.mock("../../components/chat/ThreadDetailsSection", () => ({
  ThreadDetailsSection: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../../state/entities", () => ({
  // The thread lives in the assistant's scratch project, which owns no source.
  useThreadShell: () => ({ projectId: "scratch-project" }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { read: () => SourcesView } | null) => {
    useSyncExternalStore(
      (reader) => {
        mocks.readers.add(reader);
        return () => mocks.readers.delete(reader);
      },
      () => mocks.published,
    );
    return atom?.read() ?? { data: null, error: null, refresh: () => undefined };
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.setLink }));
vi.mock("./LinkWorkItemDialog", () => ({ openLinkWorkItemDialog: () => undefined }));
vi.mock("./shared", () => ({ STATUS_LABELS: { todo: "To do", done: "Done" } }));
vi.mock("./state", () => ({
  useWorkReadable: () => true,
  useWorkWritable: () => true,
  workCommands: { setLink: "set-link" },
  workEnvironment: {
    links: () => ({ read: () => ({ data: { links: mocks.links }, error: null }) }),
    sources: (request: { environmentId: string; input: { includeDisconnected: boolean } }) => {
      mocks.requested.push(request);
      return { read: () => mocks.sources(request) };
    },
  },
}));

import { LinkedWorkSection } from "./LinkedWorkSection";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");
const threadId = ThreadId.make("assistant-thread");
const ownSource = WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4");
const otherSource = WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20");
const itemOwner = ProjectId.make("item-project");

const link = (sourceId: WorkSourceId, itemId: string, status = "todo") => ({
  ref: { sourceId, itemId: WorkItemId.make(itemId) },
  threadId,
  source: "agent",
  linkedAt: "2026-10-31T00:00:00.000Z",
  snapshot: { key: itemId, title: `Title of ${itemId}`, status, url: null, revision: "r1" },
  run: null,
});
const listed = (
  ...sources: Array<{ sourceId: WorkSourceId; projectId: ProjectId }>
): SourcesView => ({
  data: { sources },
  error: null,
});

let views: Array<ReactTestRenderer> = [];
const render = async (environmentId: EnvironmentId = envA) => {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<LinkedWorkSection environmentId={environmentId} threadId={threadId} />);
  });
  views.push(view);
  return view;
};
const row = (view: ReactTestRenderer, key: string) =>
  view.root
    .findAllByType("button")
    .find((node) => node.findAllByType("span").some((span) => span.children[0] === key))!;
const rowText = (view: ReactTestRenderer, key: string) =>
  row(view, key)
    .findAllByType("span")
    .flatMap((span) => span.children)
    .join(" ");
const unlink = (view: ReactTestRenderer) =>
  view.root.findAllByType("button").filter((node) => node.props.children === "Unlink");
const publish = (view: SourcesView) =>
  act(async () => {
    mocks.sources.mockReturnValue(view);
    mocks.published += 1;
    for (const reader of mocks.readers) reader();
  });
const click = (button: ReactTestInstance) =>
  act(async () => {
    button.props.onClick();
  });

beforeEach(() => {
  mocks.links = [];
  mocks.requested = [];
});

afterEach(async () => {
  await act(async () => {
    for (const view of views) view.unmount();
  });
  views = [];
  vi.resetAllMocks();
});

describe("opening a linked item", () => {
  it("opens the project of the item's source, not the thread's", async () => {
    mocks.links = [link(ownSource, "fd-aaaaaa")];
    mocks.sources.mockReturnValue(listed({ sourceId: ownSource, projectId: itemOwner }));
    const view = await render();

    await click(row(view, "fd-aaaaaa"));
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/work",
      search: {
        project: "env-a:item-project",
        item: `${ownSource}:fd-aaaaaa`,
        view: "all",
      },
    });
  });

  it("opens each of a thread's items in its own project", async () => {
    const secondOwner = ProjectId.make("second-project");
    mocks.links = [link(ownSource, "fd-aaaaaa"), link(otherSource, "fd-bbbbbb")];
    mocks.sources.mockReturnValue(
      listed(
        { sourceId: ownSource, projectId: itemOwner },
        { sourceId: otherSource, projectId: secondOwner },
      ),
    );
    const view = await render();

    await click(row(view, "fd-bbbbbb"));
    expect(mocks.navigate.mock.lastCall?.[0].search.project).toBe("env-a:second-project");
    await click(row(view, "fd-aaaaaa"));
    expect(mocks.navigate.mock.lastCall?.[0].search.project).toBe("env-a:item-project");
  });

  it("stays in the thread's environment", async () => {
    mocks.links = [link(ownSource, "fd-aaaaaa")];
    mocks.sources.mockImplementation(({ environmentId }: { environmentId: string }) =>
      environmentId === envB
        ? listed({ sourceId: ownSource, projectId: itemOwner })
        : listed({ sourceId: ownSource, projectId: ProjectId.make("same-source-id-elsewhere") }),
    );
    const view = await render(envB);

    await click(row(view, "fd-aaaaaa"));
    expect(mocks.navigate.mock.lastCall?.[0].search.project).toBe("env-b:item-project");
  });

  it("still names the project of a source that has been disconnected", async () => {
    mocks.links = [link(ownSource, "fd-aaaaaa")];
    mocks.sources.mockImplementation(({ input }: { input: { includeDisconnected: boolean } }) =>
      input.includeDisconnected ? listed({ sourceId: ownSource, projectId: itemOwner }) : listed(),
    );
    const view = await render();

    await click(row(view, "fd-aaaaaa"));
    expect(mocks.navigate.mock.lastCall?.[0].search.project).toBe("env-a:item-project");
  });

  it("reads no sources for a thread with no links", async () => {
    await render();
    expect(mocks.requested).toEqual([]);
  });
});

describe("a linked item whose project is not known", () => {
  beforeEach(() => {
    mocks.links = [link(ownSource, "fd-aaaaaa", "done")];
  });

  it("opens the right project once the mounted row's sources arrive", async () => {
    mocks.sources.mockReturnValue({ data: null, error: null });
    const view = await render();
    await click(row(view, "fd-aaaaaa"));
    expect(mocks.navigate).not.toHaveBeenCalled();

    await publish(listed({ sourceId: ownSource, projectId: itemOwner }));
    expect(row(view, "fd-aaaaaa").props.disabled).toBe(false);
    await click(row(view, "fd-aaaaaa"));
    expect(mocks.navigate.mock.lastCall?.[0].search.project).toBe("env-a:item-project");
  });

  it("says the project is unavailable once the mounted row's read fails", async () => {
    mocks.sources.mockReturnValue({ data: null, error: null });
    const view = await render();
    expect(rowText(view, "fd-aaaaaa")).toContain("Done");

    await publish({ data: null, error: "Work sources could not be read." });
    expect(rowText(view, "fd-aaaaaa")).toContain("Project unavailable");
  });

  it("does not open while the sources are being read, or guess the thread's project", async () => {
    mocks.sources.mockReturnValue({ data: null, error: null });
    const view = await render();

    expect(row(view, "fd-aaaaaa").props.disabled).toBe(true);
    expect(rowText(view, "fd-aaaaaa")).toContain("Done");
    await click(row(view, "fd-aaaaaa"));
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it.each<[string, SourcesView]>([
    ["no longer holds its source", listed({ sourceId: otherSource, projectId: itemOwner })],
    ["could not be read", { data: null, error: "Work sources could not be read." }],
  ])("says the project is unavailable when the list %s, and can still unlink", async (_, view) => {
    mocks.sources.mockReturnValue(view);
    const rendered = await render();

    expect(row(rendered, "fd-aaaaaa").props.disabled).toBe(true);
    expect(rowText(rendered, "fd-aaaaaa")).toContain("Project unavailable");
    await click(row(rendered, "fd-aaaaaa"));
    expect(mocks.navigate).not.toHaveBeenCalled();

    await click(unlink(rendered)[0]!);
    expect(mocks.setLink).toHaveBeenCalledWith({
      environmentId: envA,
      input: { ref: { sourceId: ownSource, itemId: "fd-aaaaaa" }, threadId, action: "unlink" },
    });
  });
});
