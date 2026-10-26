import { RegistryContext } from "@effect/atom-react";
import { FACTORY_CANCEL_TEXT } from "@t3tools/client-runtime/fd/factory";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { type FactoryDelivery, FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Command =
  | "start"
  | "stop"
  | "resume"
  | "cancel"
  | "updatePlan"
  | "approvePlan"
  | "rejectPlan"
  | "replan";

/** What the destination looks like to the section: the atoms it reads and the commands it sent. */
interface Destination {
  readonly connected: Atom.Writable<ReadonlyArray<EnvironmentId>>;
  readonly deliveries: Atom.Writable<
    AsyncResult.AsyncResult<{ readonly deliveries: ReadonlyArray<FactoryDelivery> }, never>
  >;
  readonly permitted: Record<Command, Atom.Writable<boolean>>;
  readonly sent: Array<readonly [Command, unknown]>;
}

const destination = vi.hoisted(() => {
  const box: { current: Destination | undefined } = { current: undefined };
  const get = () => {
    if (box.current === undefined) throw new Error("No destination set up.");
    return box.current;
  };
  return { box, get };
});

vi.mock("./state", async () => {
  const { Atom } = await import("effect/reactivity");
  const supported = Atom.make(true).pipe(Atom.keepAlive);
  const command = (label: Command) => ({
    label,
    permissionAtom: () => destination.get().permitted[label],
  });
  return {
    factoryEnvironment: {
      supported: () => supported,
      planning: () => supported,
      deliveries: () => destination.get().deliveries,
      start: command("start"),
      stop: command("stop"),
      resume: command("resume"),
      cancel: command("cancel"),
      updatePlan: command("updatePlan"),
      approvePlan: command("approvePlan"),
      rejectPlan: command("rejectPlan"),
      replan: command("replan"),
    },
  };
});
vi.mock("../../state/environments", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return { useConnectedEnvironmentIds: () => useAtomValue(destination.get().connected) };
});
// Commands are recorded, never sent; their results reach the view only through the deliveries.
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { readonly label: Command }) => (input: unknown) => {
    destination.get().sent.push([command.label, input]);
    return Promise.resolve({ _tag: "Success", value: undefined });
  },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => undefined }));
vi.mock("../../components/ui/button", () => ({
  Button: (props: object) => <button {...props} />,
}));
vi.mock("../../components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/alert-dialog", () => {
  const Part = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div role="alertdialog">{children}</div> : null,
    AlertDialogPopup: Part,
    AlertDialogHeader: Part,
    AlertDialogFooter: Part,
    AlertDialogTitle: Part,
    AlertDialogDescription: Part,
    AlertDialogClose: Part,
  };
});

import { FactoryItemSection } from "./FactoryItemSection";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("p1");
const itemRef = {
  sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
  itemId: WorkItemId.make("fd-7k3qa2"),
};

const delivery = (id: string, overrides: Partial<FactoryDelivery> = {}): FactoryDelivery => ({
  deliveryId: FactoryDeliveryId.make(id),
  projectId,
  itemRef,
  childIds: [],
  status: "running",
  rounds: { fix: 0, review: 0 },
  threads: {},
  receipts: [],
  reviews: [],
  stageRuns: [],
  createdAt: "2026-10-21T09:00:00.000Z",
  updatedAt: "2026-10-21T09:00:00.000Z",
  ...overrides,
});

let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer | undefined;

const keep = <A,>(value: A) => Atom.make(value).pipe(Atom.keepAlive);

beforeEach(() => {
  registry = AtomRegistry.make();
  destination.box.current = {
    connected: keep<ReadonlyArray<EnvironmentId>>([environmentId]),
    deliveries: keep<Destination["deliveries"] extends Atom.Writable<infer R> ? R : never>(
      AsyncResult.success({ deliveries: [delivery("delivery-a")] }),
    ),
    permitted: {
      start: keep(true),
      stop: keep(true),
      resume: keep(true),
      cancel: keep(true),
      updatePlan: keep(true),
      approvePlan: keep(true),
      rejectPlan: keep(true),
      replan: keep(true),
    },
    sent: [],
  };
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  destination.box.current = undefined;
});

async function mount() {
  await act(() => {
    renderer = create(
      <RegistryContext.Provider value={registry}>
        <FactoryItemSection
          environmentId={environmentId}
          projectId={projectId}
          item={{ ref: itemRef, key: "FD-12" }}
        />
      </RegistryContext.Provider>,
    );
  });
}

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const root = () => {
  if (renderer === undefined) throw new Error("Not mounted.");
  return renderer.root;
};
const dialog = () => root().findAll((node) => node.props.role === "alertdialog")[0];
const buttons = (within: ReactTestInstance, label: string) =>
  within.findAll((node) => node.type === "button" && textOf(node) === label);
const press = (button: ReactTestInstance | undefined) => {
  if (button === undefined) throw new Error("No such button.");
  return act(async () => button.props.onClick());
};
/** Opens the cancel confirmation from the section's own control. */
const openCancel = () => press(buttons(root(), "Cancel delivery")[0]);
const confirmCancel = () => {
  const open = dialog();
  if (open === undefined) throw new Error("The confirmation is closed.");
  return press(buttons(open, "Cancel delivery")[0]);
};
const change = <A,>(atom: Atom.Writable<A>, value: A) => act(() => registry.set(atom, value));

describe("cancel confirmation", () => {
  it("cancels the delivery it was opened for", async () => {
    await mount();
    await openCancel();
    expect(dialog()).toBeDefined();
    await confirmCancel();
    expect(destination.get().sent).toEqual([
      ["cancel", { environmentId, input: { deliveryId: "delivery-a" } }],
    ]);
    expect(dialog()).toBeUndefined();
  });

  it("closes, sending nothing, when another delivery replaces it", async () => {
    await mount();
    await openCancel();
    // Another client cancels delivery A and starts B while A's confirmation is open.
    await change(
      destination.get().deliveries,
      AsyncResult.success({
        deliveries: [
          delivery("delivery-b", { createdAt: "2026-10-21T10:00:00.000Z" }),
          delivery("delivery-a", { status: "cancelled" }),
        ],
      }),
    );
    expect(dialog()).toBeUndefined();
    expect(destination.get().sent).toEqual([]);
    // Cancelling B takes a confirmation of its own.
    await openCancel();
    await confirmCancel();
    expect(destination.get().sent).toEqual([
      ["cancel", { environmentId, input: { deliveryId: "delivery-b" } }],
    ]);
  });

  it.each([
    ["a delivery on its own", {}, FACTORY_CANCEL_TEXT.single],
    [
      "a parent, whose unapproved children end too",
      { childIds: [FactoryDeliveryId.make("child-1"), FactoryDeliveryId.make("child-2")] },
      FACTORY_CANCEL_TEXT.parent,
    ],
    [
      "a child, whose parent and unapproved siblings end too",
      { parentId: FactoryDeliveryId.make("parent-1") },
      FACTORY_CANCEL_TEXT.child,
    ],
  ] as const)("says what cancelling ends for %s", async (_name, family, text) => {
    await change(
      destination.get().deliveries,
      AsyncResult.success({ deliveries: [delivery("delivery-a", family)] }),
    );
    await mount();
    await openCancel();
    expect(textOf(dialog()!)).toContain(text);
    await confirmCancel();
    expect(destination.get().sent).toEqual([
      ["cancel", { environmentId, input: { deliveryId: "delivery-a" } }],
    ]);
  });

  it("closes, sending nothing, when cancelling would end more than it said", async () => {
    await mount();
    await openCancel();
    expect(textOf(dialog()!)).toContain(FACTORY_CANCEL_TEXT.single);
    // Another client approves the delivery's plan, which gives it child deliveries.
    await change(
      destination.get().deliveries,
      AsyncResult.success({
        deliveries: [delivery("delivery-a", { childIds: [FactoryDeliveryId.make("child-1")] })],
      }),
    );
    expect(dialog()).toBeUndefined();
    expect(destination.get().sent).toEqual([]);
    await openCancel();
    expect(textOf(dialog()!)).toContain(FACTORY_CANCEL_TEXT.parent);
    await confirmCancel();
    expect(destination.get().sent).toEqual([
      ["cancel", { environmentId, input: { deliveryId: "delivery-a" } }],
    ]);
  });

  it("closes when cancel stops being available, and stays closed when it returns", async () => {
    await mount();
    await openCancel();
    await change(destination.get().permitted.cancel, false);
    expect(dialog()).toBeUndefined();
    expect(buttons(root(), "Cancel delivery")).toEqual([]);
    await change(destination.get().permitted.cancel, true);
    expect(dialog()).toBeUndefined();

    await openCancel();
    // The environment drops into a reconnect's backoff.
    await change(destination.get().connected, []);
    expect(dialog()).toBeUndefined();
    expect(buttons(root(), "Cancel delivery")).toEqual([]);
    expect(destination.get().sent).toEqual([]);
  });
});
