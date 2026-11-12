import type { ComponentType, ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { applyShellStreamEvent } from "@t3tools/client-runtime/state/shell";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import { CommandId, EnvironmentId, OrchestrationV2DispatchCommandError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

type Ref = { environmentId: string; threadId: string };
type Shell = { environmentId: string; id: string; createdAt: string; archivedAt: string | null };
type Project = { environmentId: string; id: string };

// A client store whose thread shells and projects arrive when a test publishes them, as the shell
// stream delivers them after a command's acknowledgement.
const world = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    create: vi.fn(),
    unarchiveThread: vi.fn(),
    readArchived: vi.fn(),
    startTurn: vi.fn(),
    navigate: vi.fn(),
    toast: vi.fn(),
    openScratchProject: vi.fn(),
    newThread: vi.fn(),
    pathname: "/",
    shells: [] as Array<Shell>,
    projects: [] as Array<Project>,
    archived: [] as Array<{ environmentId: string; id: string }>,
    shellWaits: [] as Array<{ ref: Ref; resolve: (found: boolean) => void }>,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    notify() {
      for (const listener of listeners) listener();
    },
  };
  return state;
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  // The web project's router plugin splits a route's component behind this real wrapper.
  lazyRouteComponent: (await importOriginal<typeof import("@tanstack/react-router")>())
    .lazyRouteComponent,
  useNavigate: () => world.navigate,
  useRouter: () => ({ state: { location: { pathname: world.pathname } } }),
  Link: () => null,
  createFileRoute: () => (options: object) => ({
    options,
    useRouteContext: () => ({ authGateState: { status: "authenticated" } }),
  }),
}));
vi.mock("@t3tools/client-runtime/prompt-links", () => ({
  resolvePromptLinkModelSelection: () => ({
    selection: { instanceId: "subscription", model: "configured" },
  }),
}));
vi.mock("~/components/sidebar/SidebarThreadHeader", () => ({
  SidebarHeaderIconButton: (props: object) => <button {...props} />,
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: world.toast } }));
vi.mock("~/hooks/useScratchProject", () => ({
  useScratchProject: () => ({ openScratchProject: world.openScratchProject }),
}));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => world.newThread }));
vi.mock("~/hooks/useThreadActions", () => ({
  useThreadActions: () => ({ unarchiveThread: world.unarchiveThread }),
}));
vi.mock("./commands", () => ({ readArchivedThreads: "read-archived-threads" }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => world.readArchived }));
vi.mock("~/state/entities", () => {
  const useValue = <T,>(read: () => T) => useSyncExternalStore(world.subscribe, read);
  return {
    readProject: (ref: { environmentId: string; projectId: string }) =>
      world.projects.find(
        (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
      ) ?? null,
    readThreadShells: () => world.shells,
    useProjects: () => useValue(() => world.projects),
    useThreadShells: () => useValue(() => world.shells),
    useVisibleThreadShells: () => useValue(() => world.shells),
    useAllEnvironmentShellsBootstrapped: () => true,
    waitForThreadShell: (ref: Ref) =>
      new Promise<boolean>((resolve) => {
        const exact = world.shells.some(
          (shell) => shell.environmentId === ref.environmentId && shell.id === ref.threadId,
        );
        if (exact) resolve(true);
        else world.shellWaits.push({ ref, resolve });
      }),
  };
});
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    isReady: true,
    environments: [
      {
        environmentId: "test",
        connection: { phase: "connected" },
        serverConfig: { providers: [], settings: { defaultRuntimeMode: "approval-required" } },
      },
      {
        environmentId: "second",
        connection: { phase: "connected" },
        serverConfig: { providers: [], settings: { defaultRuntimeMode: "approval-required" } },
      },
      {
        environmentId: "offline",
        connection: { phase: "disconnected" },
        serverConfig: null,
      },
    ],
  }),
}));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
}));
vi.mock("~/state/threads", () => ({
  threadEnvironment: { create: "create", startTurn: "startTurn" },
}));
vi.mock("~/state/use-orchestration-command", () => ({
  useOrchestrationCommand: (name: "create" | "startTurn") => world[name],
}));
vi.mock("~/components/NoProjectsHero", () => ({ NoProjectsHero: () => <div data-hero /> }));
vi.mock("~/components/Sidebar.logic", () => ({
  sortScopedProjectsForSidebar: (projects: ReadonlyArray<Project>) => projects,
}));
vi.mock("~/components/WorkspacePageHeader", () => ({ WorkspacePageHeader: () => null }));
vi.mock("~/components/ui/button", () => ({
  Button: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("~/components/ui/empty", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Empty: Passthrough,
    EmptyDescription: Passthrough,
    EmptyHeader: Passthrough,
    EmptyTitle: Passthrough,
  };
});
vi.mock("~/components/ui/refresh-icon", () => ({ RefreshIcon: () => null }));
vi.mock("~/components/ui/sidebar", () => ({
  SidebarInset: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("~/cloud/publicConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/cloud/publicConfig")>()),
  hasCloudPublicConfig: () => false,
}));
vi.mock("~/branding", () => ({ APP_DISPLAY_NAME: "Test" }));
vi.mock("~/localEnvironment", () => ({ isLocalEnvironmentDisabled: () => false }));
vi.mock("~/env", () => ({ isElectron: false }));
// The route reads the open through the feature's entry; the rest of that entry is unrelated UI.
vi.mock("~/fd/assistant", () => import("./assistantOpening"));

import { resolveThreadRouteRenderState } from "~/threadRoutes";
import { Route as IndexRoute } from "~/routes/_chat.index";
import { AssistantEntry } from "./AssistantEntry";
import { resetAssistantOpeningForTests } from "./assistantOpening";

const IndexLanding = IndexRoute.options.component as ComponentType & {
  readonly preload?: () => Promise<void>;
};
const environmentId = EnvironmentId.make("test");
const THREAD_ID = "fd-assistant-owner";
const COMMAND_ID = `create:${THREAD_ID}`;
const scratch: Project = { environmentId, id: "scratch" };
const threadTarget = {
  to: "/$environmentId/$threadId",
  params: { environmentId, threadId: THREAD_ID },
};
const accepted = { _tag: "Success", value: undefined } as const;
const refused = (message: string) => AsyncResult.failure(Cause.fail(new Error(message)));

// One environment's shells after a delta from its stream, through the client's real reducer.
const applyShellDelta = (environment: string, delta: object) => {
  const others = world.shells.filter((shell) => shell.environmentId !== environment);
  const next = applyShellStreamEvent(
    {
      schemaVersion: 1,
      snapshotSequence: 0,
      projects: [],
      threads: world.shells.filter((shell) => shell.environmentId === environment),
      archivedThreads: [],
    } as never,
    { sequence: 1, location: "active", ...delta } as never,
  );
  world.shells = [...others, ...(next.threads as unknown as Array<Shell>)];
};

const publishShell = (shell: Partial<Shell> = {}) => {
  const published: Shell = {
    environmentId,
    id: THREAD_ID,
    createdAt: "2026-10-31T00:00:00.000Z",
    archivedAt: null,
    ...shell,
  };
  applyShellDelta(published.environmentId, { kind: "thread.updated", thread: published });
  for (const wait of world.shellWaits.splice(0)) {
    if (wait.ref.environmentId === published.environmentId && wait.ref.threadId === published.id) {
      wait.resolve(true);
    } else {
      world.shellWaits.push(wait);
    }
  }
  world.notify();
};
// What archiving does to this client: the stream drops the thread, and the archive read holds it.
const archiveOnServer = (environment: string = environmentId) => {
  applyShellDelta(environment, { kind: "thread.removed", threadId: THREAD_ID });
  world.archived = [...world.archived, { environmentId: environment, id: THREAD_ID }];
  world.notify();
};
const expireShellWaits = () => {
  for (const wait of world.shellWaits.splice(0)) wait.resolve(false);
};
const publishProject = (project: Project) => {
  world.projects = [...world.projects, project];
  world.notify();
};

// What the thread route would render for the Assistant's URL given what the client holds now.
const routeStates: Array<string> = [];
let refuseHeldCreate: () => void = () => undefined;
const renderedViews: Array<ReactTestRenderer> = [];
const render = async (element: ReactNode) => {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<>{element}</>);
  });
  renderedViews.push(view);
  return view;
};
const entry = (environment: EnvironmentId = environmentId) => (
  <AssistantEntry environmentId={environment} />
);
const entryButton = (view: ReactTestRenderer, index = 0) =>
  view.root.findAllByType("button")[index]!;
const click = (view: ReactTestRenderer, index = 0) =>
  act(async () => {
    entryButton(view, index).props.onClick();
  });
const settle = (run: () => void) =>
  act(async () => {
    run();
  });
const expectIdle = (view: ReactTestRenderer, index = 0) => {
  expect(entryButton(view, index).props.label).toBe("Assistant");
  expect(entryButton(view, index).props.disabled).toBe(false);
};
const expectOpening = (view: ReactTestRenderer, index = 0) => {
  expect(entryButton(view, index).props.label).toBe("Opening assistant…");
  expect(entryButton(view, index).props.disabled).toBe(true);
};
// Opening saves and shows a conversation; nothing it calls can start one.
const expectNoExecution = () => {
  for (const [{ input }] of world.create.mock.calls) {
    expect(input).not.toHaveProperty("message");
  }
  expect(world.startTurn).not.toHaveBeenCalled();
};

beforeEach(() => {
  resetAssistantOpeningForTests();
  world.pathname = "/";
  world.shells = [];
  world.projects = [];
  world.archived = [];
  world.shellWaits = [];
  routeStates.length = 0;
  refuseHeldCreate = () => undefined;
  world.create.mockResolvedValue(accepted);
  world.readArchived.mockImplementation(
    async ({ environmentId: environment }: { environmentId: string }) => ({
      _tag: "Success",
      value: { threads: world.archived.filter((thread) => thread.environmentId === environment) },
    }),
  );
  world.unarchiveThread.mockImplementation(async ({ threadId }: { threadId: string }) => {
    world.archived = world.archived.filter((thread) => thread.id !== threadId);
    return accepted;
  });
  world.openScratchProject.mockImplementation(async () => {
    if (!world.projects.includes(scratch)) publishProject(scratch);
    return scratch;
  });
  world.newThread.mockResolvedValue({ opened: true });
  world.navigate.mockImplementation(async (target: typeof threadTarget) => {
    routeStates.push(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadExists: world.shells.some(
          (shell) =>
            shell.environmentId === target.params.environmentId &&
            shell.id === target.params.threadId,
        ),
        serverThreadDeleted: false,
        unlistedThreadDetail: EMPTY_ENVIRONMENT_THREAD_STATE,
        draftThreadExists: false,
      }),
    );
    world.pathname = `/${target.params.environmentId}/${target.params.threadId}`;
  });
});

afterEach(async () => {
  // Opens outlive a test in module state until their wait ends, even one that failed midway.
  await settle(() => {
    refuseHeldCreate();
    expireShellWaits();
  });
  await act(async () => {
    for (const view of renderedViews.splice(0)) view.unmount();
  });
  vi.resetAllMocks();
});

describe("opening the Assistant with a delayed shell", () => {
  it("waits for the exact environment and thread before navigating", async () => {
    const view = await render(entry());
    await click(view);

    expect(world.create).toHaveBeenCalledTimes(1);
    expect(world.create.mock.calls[0]![0]).toMatchObject({
      environmentId,
      input: { commandId: COMMAND_ID, threadId: THREAD_ID, projectId: "scratch" },
    });
    expect(world.navigate).not.toHaveBeenCalled();
    expectOpening(view);

    // Neither the same thread id elsewhere nor another thread here is the Assistant's shell.
    await settle(() => publishShell({ environmentId: "elsewhere" }));
    await settle(() => publishShell({ id: "another-thread" }));
    expect(world.navigate).not.toHaveBeenCalled();
    expectOpening(view);

    await settle(() => publishShell());
    expect(world.navigate).toHaveBeenCalledTimes(1);
    expect(world.navigate).toHaveBeenCalledWith(threadTarget);
    // The thread route redirects to the index only for a thread it reads as missing.
    expect(routeStates).toEqual(["ready"]);
    expectIdle(view);
    expectNoExecution();
  });
});

describe("the index landing during an open", () => {
  beforeAll(async () => {
    await IndexLanding.preload?.();
  });

  it("starts no draft when the open publishes the scratch project", async () => {
    const view = await render(
      <>
        <IndexLanding />
        {entry()}
      </>,
    );
    expect(view.root.findAllByType("div").filter((node) => node.props["data-hero"])).toHaveLength(
      1,
    );

    await click(view);
    expect(world.projects).toEqual([scratch]);
    expect(world.navigate).not.toHaveBeenCalled();
    expect(world.newThread).not.toHaveBeenCalled();

    await settle(() => publishShell());
    expect(world.navigate).toHaveBeenCalledTimes(1);
    expect(world.newThread).not.toHaveBeenCalled();
    expectNoExecution();
  });

  it("starts a draft normally once a failed open is no longer pending", async () => {
    world.create.mockReturnValue(
      new Promise((resolve) => {
        refuseHeldCreate = () => resolve(refused("The server refused."));
      }),
    );
    const view = await render(
      <>
        <IndexLanding />
        {entry()}
      </>,
    );
    await click(view);
    expect(world.projects).toEqual([scratch]);
    expect(world.newThread).not.toHaveBeenCalled();

    await settle(refuseHeldCreate);
    expect(world.navigate).not.toHaveBeenCalled();
    expect(world.newThread).toHaveBeenCalledTimes(1);
    expect(world.newThread).toHaveBeenCalledWith(
      { environmentId, projectId: "scratch" },
      { replace: true },
    );
  });

  it("starts a draft at once when nothing is opening", async () => {
    world.projects = [scratch];
    await render(<IndexLanding />);
    expect(world.newThread).toHaveBeenCalledTimes(1);
  });
});

describe("overlapping opens", () => {
  it("creates once from two mounted entries, which both show the open", async () => {
    const view = await render(
      <>
        {entry()}
        {entry()}
      </>,
    );
    await click(view, 0);
    expectOpening(view, 0);
    expectOpening(view, 1);

    await click(view, 1);
    await click(view, 0);
    expect(world.openScratchProject).toHaveBeenCalledTimes(1);
    expect(world.create).toHaveBeenCalledTimes(1);

    await settle(() => publishShell());
    expect(world.navigate).toHaveBeenCalledTimes(1);
    expectIdle(view, 0);
    expectIdle(view, 1);
  });

  it("claims the open before anything awaits, so a same-tick click does nothing", async () => {
    const view = await render(entry());
    await act(async () => {
      const { onClick } = entryButton(view).props;
      onClick();
      onClick();
    });
    expect(world.openScratchProject).toHaveBeenCalledTimes(1);
    expect(world.create).toHaveBeenCalledTimes(1);
  });
});

describe("a failed open", () => {
  it("names a create failure, clears the open and retries the same thread and command", async () => {
    world.create.mockResolvedValueOnce(refused("The server refused."));
    const view = await render(entry());
    await click(view);

    expect(world.toast).toHaveBeenCalledTimes(1);
    expect(world.toast.mock.calls[0]![0]).toMatchObject({
      type: "error",
      title: "Could not open the assistant",
    });
    expect(world.toast.mock.calls[0]![0].description).toContain("The server refused.");
    expect(world.toast.mock.calls[0]![0].description).toContain("try again");
    expect(world.navigate).not.toHaveBeenCalled();
    expectIdle(view);

    await click(view);
    expectOpening(view);
    expect(world.create).toHaveBeenCalledTimes(2);
    const [first, second] = world.create.mock.calls.map(([call]) => call.input);
    expect(second.threadId).toBe(first.threadId);
    expect(second.threadId).toBe(THREAD_ID);
    expect(second.commandId).toBe(first.commandId);
    expect(second.commandId).toBe(COMMAND_ID);

    await settle(() => publishShell());
    expect(world.navigate).toHaveBeenCalledTimes(1);
    expect(world.navigate).toHaveBeenCalledWith(threadTarget);
    expect(world.shells.filter((shell) => shell.id === THREAD_ID)).toHaveLength(1);
    expectIdle(view);
    expectNoExecution();
  });

  it("names a shell timeout, clears the open and retries the same command", async () => {
    const view = await render(entry());
    await click(view);
    expectOpening(view);

    await settle(expireShellWaits);
    expect(world.navigate).not.toHaveBeenCalled();
    expect(world.toast).toHaveBeenCalledTimes(1);
    expect(world.toast.mock.calls[0]![0].description).toMatch(/connection.*try again/i);
    expectIdle(view);

    await click(view);
    expect(world.create).toHaveBeenCalledTimes(2);
    expect(world.create.mock.calls[1]![0].input.commandId).toBe(COMMAND_ID);
    expect(world.create.mock.calls[1]![0].input.threadId).toBe(THREAD_ID);

    await settle(() => publishShell());
    expect(world.navigate).toHaveBeenCalledTimes(1);
    expect(routeStates).toEqual(["ready"]);
    expectNoExecution();
  });

  it("opens the shell a timed-out open was waiting for without creating again", async () => {
    const view = await render(entry());
    await click(view);
    await settle(expireShellWaits);

    publishShell();
    await click(view);
    expect(world.create).toHaveBeenCalledTimes(1);
    expect(world.navigate).toHaveBeenCalledTimes(1);
    expect(world.navigate).toHaveBeenCalledWith(threadTarget);
    expectNoExecution();
  });

  it("clears the open when the environment is not connected", async () => {
    const offline = EnvironmentId.make("offline");
    const view = await render(entry(offline));
    await click(view);
    expect(world.create).not.toHaveBeenCalled();
    expect(world.toast.mock.calls[0]![0].description).toMatch(/connect/i);
    expectIdle(view);
  });

  it("clears the open when the scratch project cannot open", async () => {
    world.openScratchProject.mockResolvedValue(null);
    const view = await render(entry());
    await click(view);
    expect(world.create).not.toHaveBeenCalled();
    expect(world.navigate).not.toHaveBeenCalled();
    expectIdle(view);
  });
});

describe("a create the server rejected", () => {
  type Input = { commandId: string; threadId: string };

  // Each environment's receipts: a refusal stays with its command id, an acceptance replays.
  const refusesCreates = { now: true };
  const receipts = new Map<string, "accepted" | "rejected">();
  const receiptKey = (environment: string, commandId: string) => `${environment}|${commandId}`;
  const nthId = (attempt: number) => (attempt === 1 ? COMMAND_ID : `${COMMAND_ID}:${attempt}`);
  const seedRefusals = (count: number, environment: string = environmentId) => {
    for (let attempt = 1; attempt <= count; attempt += 1) {
      receipts.set(receiptKey(environment, nthId(attempt)), "rejected");
    }
  };
  const applied: Array<Input> = [];
  const refusal = (commandId: string, previouslyRejected: boolean) =>
    AsyncResult.failure(
      Cause.fail(
        new OrchestrationV2DispatchCommandError({
          commandId: CommandId.make(commandId),
          commandType: "thread.create",
          message: previouslyRejected ? "Previously rejected." : "The project is unavailable.",
          ...(previouslyRejected ? { previouslyRejected } : {}),
        }),
      ),
    );

  beforeEach(() => {
    refusesCreates.now = true;
    receipts.clear();
    applied.length = 0;
    world.create.mockImplementation(
      async ({ environmentId: environment, input }: { environmentId: string; input: Input }) => {
        const key = receiptKey(environment, input.commandId);
        const receipt = receipts.get(key);
        if (receipt === "accepted") return accepted;
        if (receipt === "rejected") return refusal(input.commandId, true);
        if (refusesCreates.now) {
          receipts.set(key, "rejected");
          return refusal(input.commandId, false);
        }
        receipts.set(key, "accepted");
        applied.push(input);
        return accepted;
      },
    );
  });
  const commandIds = () => world.create.mock.calls.map(([{ input }]) => input.commandId);

  it("recovers on retry once the cause is gone, keeping the one thread", async () => {
    const view = await render(entry());
    await click(view);
    expect(world.toast).toHaveBeenCalledTimes(1);
    expect(world.toast.mock.calls[0]![0].description).toContain("The project is unavailable.");
    expectIdle(view);
    expect(applied).toEqual([]);

    refusesCreates.now = false;
    await click(view);
    expect(commandIds()).toEqual([COMMAND_ID, COMMAND_ID, `${COMMAND_ID}:2`]);
    expect(applied.map((input) => input.threadId)).toEqual([THREAD_ID]);
    expect(world.toast).toHaveBeenCalledTimes(1);
    expectOpening(view);

    await settle(() => publishShell());
    expect(world.navigate).toHaveBeenCalledTimes(1);
    expect(world.navigate).toHaveBeenCalledWith(threadTarget);
    expectNoExecution();
  });

  it("reports each new refusal and still recovers after several", async () => {
    const view = await render(entry());
    await click(view);
    await click(view);
    expect(commandIds()).toEqual([COMMAND_ID, COMMAND_ID, `${COMMAND_ID}:2`]);
    expect(world.toast).toHaveBeenCalledTimes(2);
    expect(world.toast.mock.calls[1]![0].description).toContain("The project is unavailable.");
    expect(world.navigate).not.toHaveBeenCalled();

    refusesCreates.now = false;
    world.create.mockClear();
    await click(view);
    // The id it saw refused needs no asking again.
    expect(commandIds()).toEqual([`${COMMAND_ID}:2`, `${COMMAND_ID}:3`]);
    expect(applied).toHaveLength(1);

    await settle(() => publishShell());
    expect(world.navigate).toHaveBeenCalledTimes(1);
  });

  // Past what one open walks: all 64 ids refused is where a retry used to stop for good.
  it.each([
    [64, 2],
    [65, 2],
    [150, 3],
  ])("recovers from %i refused ids in %i opens, skipping none", async (refused, opens) => {
    seedRefusals(refused);
    refusesCreates.now = false;
    const view = await render(entry());

    for (let open = 1; open < opens; open += 1) {
      await click(view);
      expect(world.toast).toHaveBeenCalledTimes(open);
      expect(world.toast.mock.calls[open - 1]![0].description).toContain("try again");
      expect(world.create).toHaveBeenCalledTimes(open * 64);
      expect(applied).toEqual([]);
      expectIdle(view);
    }
    await click(view);
    expect(world.toast).toHaveBeenCalledTimes(opens - 1);
    expect(applied.map((input) => input.commandId)).toEqual([nthId(refused + 1)]);
    expect(applied.map((input) => input.threadId)).toEqual([THREAD_ID]);
    expect(commandIds()).toEqual(
      Array.from({ length: refused + 1 }, (_, index) => nthId(index + 1)),
    );

    await settle(() => publishShell());
    expect(world.navigate).toHaveBeenCalledTimes(1);
    expect(world.navigate).toHaveBeenCalledWith(threadTarget);
    expectNoExecution();
  });

  it("walks each environment's own refusals", async () => {
    const second = EnvironmentId.make("second");
    seedRefusals(64);
    refusesCreates.now = false;
    const view = await render(
      <>
        {entry()}
        {entry(second)}
      </>,
    );
    await click(view, 0);
    expect(world.create).toHaveBeenCalledTimes(64);

    world.create.mockClear();
    await click(view, 1);
    expect(commandIds()).toEqual([COMMAND_ID]);
    expect(world.create.mock.calls[0]![0].environmentId).toBe(second);
  });

  it("replays the accepted id for any later client, creating nothing more", async () => {
    const view = await render(entry());
    await click(view);
    refusesCreates.now = false;
    await click(view);
    expect(applied).toHaveLength(1);

    // The shell never arrives here, and this client tries again from where it was.
    await settle(expireShellWaits);
    world.create.mockClear();
    await click(view);
    expect(commandIds()).toEqual([`${COMMAND_ID}:2`]);
    expect(applied).toHaveLength(1);

    // Another client, which has seen no refusal, walks there from the start.
    await settle(expireShellWaits);
    resetAssistantOpeningForTests();
    world.create.mockClear();
    await click(view);
    expect(commandIds()).toEqual([COMMAND_ID, `${COMMAND_ID}:2`]);
    expect(applied).toHaveLength(1);

    await settle(() => publishShell());
    expect(world.navigate).toHaveBeenCalledTimes(1);
    expect(world.shells.filter((shell) => shell.id === THREAD_ID)).toHaveLength(1);
    expectNoExecution();
  });

  it("keeps the id for a failure that does not say the id was rejected", async () => {
    const view = await render(entry());
    receipts.set(COMMAND_ID, "accepted");
    world.create.mockResolvedValueOnce(refusal(COMMAND_ID, false));
    await click(view);
    expect(commandIds()).toEqual([COMMAND_ID]);
    expect(world.toast).toHaveBeenCalledTimes(1);

    await click(view);
    expect(commandIds()).toEqual([COMMAND_ID, COMMAND_ID]);
    expect(applied).toEqual([]);
  });

  it("stops each open with an error on a server that only ever refuses", async () => {
    world.create.mockImplementation(async ({ input }: { input: Input }) =>
      refusal(input.commandId, true),
    );
    const view = await render(entry());
    await click(view);
    expect(world.create).toHaveBeenCalledTimes(64);
    expect(world.toast).toHaveBeenCalledTimes(1);
    expect(world.navigate).not.toHaveBeenCalled();
    expectIdle(view);

    await click(view);
    expect(world.create).toHaveBeenCalledTimes(128);
    expect(commandIds().at(-1)).toBe(nthId(128));
    expect(world.toast).toHaveBeenCalledTimes(2);
    expectIdle(view);
  });
});

describe("an Assistant the owner archived", () => {
  const restoredRef = { environmentId, threadId: THREAD_ID };

  beforeEach(() => {
    publishShell();
    archiveOnServer();
  });

  it("is restored from the archive, not created, and opens once its shell returns", async () => {
    expect(world.shells).toEqual([]);
    const view = await render(entry());
    await click(view);

    expect(world.readArchived).toHaveBeenCalledWith({ environmentId, input: {} });
    expect(world.unarchiveThread).toHaveBeenCalledTimes(1);
    expect(world.unarchiveThread).toHaveBeenCalledWith(restoredRef);
    expect(world.create).not.toHaveBeenCalled();
    expect(world.openScratchProject).not.toHaveBeenCalled();
    expect(world.navigate).not.toHaveBeenCalled();
    expectOpening(view);

    await settle(() => publishShell());
    expect(world.navigate).toHaveBeenCalledTimes(1);
    expect(world.navigate).toHaveBeenCalledWith(threadTarget);
    expect(routeStates).toEqual(["ready"]);
    expectIdle(view);
    expectNoExecution();
  });

  it("restores once for overlapping clicks", async () => {
    const view = await render(
      <>
        {entry()}
        {entry()}
      </>,
    );
    await click(view, 0);
    await click(view, 1);
    expect(world.unarchiveThread).toHaveBeenCalledTimes(1);
    await settle(() => publishShell());
    expect(world.navigate).toHaveBeenCalledTimes(1);
  });

  it("names a shell that does not return, and a retry opens it without restoring again", async () => {
    const view = await render(entry());
    await click(view);
    await settle(expireShellWaits);
    expect(world.navigate).not.toHaveBeenCalled();
    expect(world.toast.mock.calls[0]![0].description).toMatch(/connection.*try again/i);
    expectIdle(view);

    // The thread is restored by now, so its create only replays, and its shell decides.
    await click(view);
    expect(world.unarchiveThread).toHaveBeenCalledTimes(1);
    expect(world.create).toHaveBeenCalledTimes(1);
    expect(world.create.mock.calls[0]![0].input.commandId).toBe(COMMAND_ID);
    await settle(() => publishShell());
    expect(world.navigate).toHaveBeenCalledTimes(1);
    expect(routeStates).toEqual(["ready"]);
    expectNoExecution();
  });

  it("stays put and can retry when the restore is refused", async () => {
    world.unarchiveThread.mockResolvedValueOnce(refused("Could not restore."));
    const view = await render(entry());
    await click(view);
    expect(world.navigate).not.toHaveBeenCalled();
    expect(world.create).not.toHaveBeenCalled();
    expect(world.toast.mock.calls[0]![0].description).toContain("Could not restore.");
    expectIdle(view);

    await click(view);
    expect(world.unarchiveThread).toHaveBeenCalledTimes(2);
    await settle(() => publishShell());
    expect(world.navigate).toHaveBeenCalledTimes(1);
    expectNoExecution();
  });

  it("creates nothing and can retry when the archive cannot be read", async () => {
    world.readArchived.mockResolvedValueOnce(refused("Could not read."));
    const view = await render(entry());
    await click(view);
    expect(world.toast.mock.calls[0]![0].description).toContain("Could not read.");
    expect(world.unarchiveThread).not.toHaveBeenCalled();
    expect(world.create).not.toHaveBeenCalled();
    expect(world.openScratchProject).not.toHaveBeenCalled();
    expectIdle(view);

    await click(view);
    expect(world.unarchiveThread).toHaveBeenCalledTimes(1);
  });

  it("starts no draft on the index while it is restored", async () => {
    world.projects = [];
    world.newThread.mockClear();
    const view = await render(
      <>
        <IndexLanding />
        {entry()}
      </>,
    );
    await click(view);
    await settle(() => publishProject(scratch));
    expect(world.newThread).not.toHaveBeenCalled();

    await settle(() => publishShell());
    expect(world.navigate).toHaveBeenCalledTimes(1);
    expect(world.newThread).not.toHaveBeenCalled();
  });

  it("does not take another archived thread for it", async () => {
    world.archived = [{ environmentId, id: "an-ordinary-thread" }];
    const view = await render(entry());
    await click(view);
    expect(world.unarchiveThread).not.toHaveBeenCalled();
    expect(world.create).toHaveBeenCalledTimes(1);
    expect(world.create.mock.calls[0]![0].input.threadId).toBe(THREAD_ID);
  });

  it("does not take another environment's archive for its own", async () => {
    world.archived = [{ environmentId: "second", id: THREAD_ID }];
    const view = await render(entry());
    await click(view);
    expect(world.unarchiveThread).not.toHaveBeenCalled();
    expect(world.create).toHaveBeenCalledTimes(1);
  });

  it("is restored when a stale shell of it is still among the active ones", async () => {
    world.shells = [
      {
        environmentId,
        id: THREAD_ID,
        createdAt: "2026-10-31T00:00:00.000Z",
        archivedAt: "2026-10-31T01:00:00.000Z",
      },
    ];
    const view = await render(entry());
    await click(view);
    expect(world.unarchiveThread).toHaveBeenCalledWith(restoredRef);
    expect(world.create).not.toHaveBeenCalled();
    expect(world.navigate).toHaveBeenCalledTimes(1);
  });
});

describe("an Assistant the client already holds", () => {
  it("opens the existing thread without creating or waiting", async () => {
    world.shells = [
      {
        environmentId,
        id: THREAD_ID,
        createdAt: "2026-10-31T00:00:00.000Z",
        archivedAt: null,
      },
    ];
    const view = await render(entry());
    await click(view);
    expect(world.create).not.toHaveBeenCalled();
    expect(world.readArchived).not.toHaveBeenCalled();
    expect(world.unarchiveThread).not.toHaveBeenCalled();
    expect(world.navigate).toHaveBeenCalledTimes(1);
    expect(world.navigate).toHaveBeenCalledWith(threadTarget);
    expectIdle(view);
    expectNoExecution();
  });

  it("does not take another environment's Assistant for its own", async () => {
    world.shells = [
      {
        environmentId: EnvironmentId.make("elsewhere"),
        id: THREAD_ID,
        createdAt: "2026-10-31T00:00:00.000Z",
        archivedAt: null,
      },
    ];
    const view = await render(entry());
    await click(view);
    expect(world.create).toHaveBeenCalledTimes(1);
    expect(world.navigate).not.toHaveBeenCalled();
    await settle(() => publishShell());
    expect(world.navigate).toHaveBeenCalledWith(threadTarget);
  });
});
