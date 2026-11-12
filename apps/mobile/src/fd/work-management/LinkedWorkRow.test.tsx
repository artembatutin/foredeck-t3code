import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { Atom, AsyncResult, AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  navigate: vi.fn(),
  setLink: vi.fn(),
  sourcesRead: vi.fn(),
}));

// Native views as the browser elements a press and a screen reader act on.
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    accessibilityLabel,
    disabled,
    onPress,
  }: {
    children?: ReactNode;
    accessibilityLabel: string;
    disabled: boolean;
    onPress: () => void;
  }) => (
    <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: harness.navigate }),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: ({
    children,
    actions,
    onPressAction,
  }: {
    children?: ReactNode;
    actions: ReadonlyArray<{ id: string; title: string }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) => (
    <div>
      {children}
      {actions.map(({ id, title }) => (
        <button key={id} onClick={() => onPressAction({ nativeEvent: { event: id } })}>
          {title}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => harness.setLink }));
vi.mock("./shared", () => ({
  STATUS_LABELS: { todo: "To do" },
  STATUS_SYMBOLS: { todo: { icon: "circle", tint: "text-foreground" } },
}));
vi.mock("./state", () => ({
  useWorkReadable: () => true,
  useWorkWritable: () => true,
  workCommands: { setLink: "set-link" },
  workEnvironment: {
    links: () => linksAtom,
    sources: (request: object) => {
      harness.sourcesRead(request);
      return sourcesAtom;
    },
  },
}));

import { LinkedWorkRow } from "./LinkedWorkRow";

const environmentId = EnvironmentId.make("env-a");
const threadId = ThreadId.make("assistant-thread");
const sourceId = WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4");
const itemId = WorkItemId.make("fd-aaaaaa");
const itemOwner = ProjectId.make("item-project");
const ownedSources = { sources: [{ sourceId, projectId: itemOwner }] };
const link = {
  ref: { sourceId, itemId },
  threadId,
  source: "agent",
  linkedAt: "2026-10-31T00:00:00.000Z",
  snapshot: { key: "fd-aaaaaa", title: "T", status: "todo", url: null, revision: "r1" },
  run: null,
};

const linksAtom = Atom.make(AsyncResult.success({ links: [link] })).pipe(Atom.keepAlive);
const sourcesAtom = Atom.make<AsyncResult.AsyncResult<typeof ownedSources, Error>>(
  AsyncResult.initial(),
).pipe(Atom.keepAlive);

let registry: AtomRegistry.AtomRegistry;
let root: Root;
let container: HTMLElement;

const row = () => container.querySelector<HTMLButtonElement>("button[aria-label^='Work item']")!;
const press = (button: HTMLButtonElement) => act(() => button.click());
const publishSources = (result: AsyncResult.AsyncResult<typeof ownedSources, Error>) =>
  act(() => registry.set(sourcesAtom, result));
const readFailure = () => Cause.fail(new Error("Work sources could not be read."));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  registry = AtomRegistry.make();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <LinkedWorkRow environmentId={environmentId} threadId={threadId} />
      </RegistryContext.Provider>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("a mounted linked item", () => {
  it("opens the project of its source once the sources arrive", () => {
    expect(harness.sourcesRead).toHaveBeenCalledWith({
      environmentId,
      input: { includeDisconnected: true },
    });
    expect(row().getAttribute("aria-label")).toBe("Work item fd-aaaaaa, To do");
    press(row());
    expect(harness.navigate).not.toHaveBeenCalled();

    publishSources(AsyncResult.success(ownedSources));
    expect(row().getAttribute("aria-label")).toBe("Work item fd-aaaaaa, To do");
    press(row());
    expect(harness.navigate).toHaveBeenCalledTimes(1);
    expect(harness.navigate).toHaveBeenCalledWith("WorkItem", {
      environmentId,
      projectId: itemOwner,
      sourceId,
      itemId,
    });
  });

  it("says the project is unavailable once the sources turn out not to hold its source", () => {
    publishSources(AsyncResult.success({ sources: [] }));
    expect(row().textContent).toContain("Project unavailable");
    press(row());
    expect(harness.navigate).not.toHaveBeenCalled();
  });

  it("says the project is unavailable once the read fails, and can still be unlinked", () => {
    publishSources(AsyncResult.failure(readFailure()));
    expect(row().getAttribute("aria-label")).toBe("Work item fd-aaaaaa, Project unavailable");
    press(row());
    expect(harness.navigate).not.toHaveBeenCalled();

    const unlink = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Unlink",
    )!;
    press(unlink);
    expect(harness.setLink).toHaveBeenCalledWith({
      environmentId,
      input: { ref: { sourceId, itemId }, threadId, action: "unlink" },
    });
  });

  it("keeps opening when a later refresh of known sources fails", () => {
    const known = AsyncResult.success(ownedSources);
    publishSources(known);
    publishSources(AsyncResult.failure(readFailure(), { previousSuccess: Option.some(known) }));
    expect(row().textContent).not.toContain("Project unavailable");
    press(row());
    expect(harness.navigate.mock.lastCall?.[1].projectId).toBe(itemOwner);
  });
});
