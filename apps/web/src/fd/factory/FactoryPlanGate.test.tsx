import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  type FactoryDelivery,
  FactoryDeliveryId,
  FactoryError,
  FactoryPlan,
  FactoryTaskId,
} from "@t3tools/contracts/fd/factory";
import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
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

/** The section's destination: the deliveries it reads, the commands it sent and their answers. */
interface Destination {
  readonly deliveries: Atom.Writable<
    AsyncResult.AsyncResult<{ readonly deliveries: ReadonlyArray<FactoryDelivery> }, never>
  >;
  readonly sent: Array<readonly [Command, unknown]>;
  readonly answers: Partial<Record<Command, unknown>>;
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
  const yes = Atom.make(true).pipe(Atom.keepAlive);
  const command = (label: string) => ({ label, permissionAtom: () => yes });
  return {
    factoryEnvironment: {
      supported: () => yes,
      planning: () => yes,
      deliveries: () => destination.get().deliveries,
      ...Object.fromEntries(
        [
          "start",
          "stop",
          "resume",
          "cancel",
          "updatePlan",
          "approvePlan",
          "rejectPlan",
          "replan",
        ].map((label) => [label, command(label)]),
      ),
    },
  };
});
vi.mock("../../state/environments", () => ({ useConnectedEnvironmentIds: () => ["env-1"] }));
// Commands are recorded and answered as set; their results reach the view only by refetching.
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { readonly label: Command }) => (input: unknown) => {
    destination.get().sent.push([command.label, input]);
    return Promise.resolve(
      destination.get().answers[command.label] ?? { _tag: "Success", value: undefined },
    );
  },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => undefined }));
vi.mock("../../components/ui/button", () => ({
  Button: (props: object) => <button {...props} />,
}));
vi.mock("../../components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/input", () => ({ Input: (props: object) => <input {...props} /> }));
vi.mock("../../components/ui/textarea", () => ({
  Textarea: (props: object) => <textarea {...props} />,
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

import { FACTORY_PLAN_FIELD_REFUSED } from "./planGate";
import { FactoryItemSection } from "./FactoryItemSection";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("p1");
const itemRef = {
  sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
  itemId: WorkItemId.make("fd-7k3qa2"),
};
const plan = Schema.decodeUnknownSync(FactoryPlan)({
  tasks: ["export-csv", "export-header"].map((id) => ({
    id,
    title: `Task ${id}`,
    kind: "feature",
    summary: `Build ${id}.`,
    acceptance: [`${id} works.`],
    testPlan: [{ criterion: 1, check: `${id} is tested.`, paths: [`src/${id}.test.ts`] }],
    likelyPaths: [`src/${id}.ts`],
    risk: "normal",
  })),
});

const waiting = (id: string, overrides: Partial<FactoryDelivery> = {}): FactoryDelivery => ({
  deliveryId: FactoryDeliveryId.make(id),
  projectId,
  itemRef,
  childIds: [],
  status: "waiting",
  stage: { name: "approve_plan", kind: "gate" },
  rounds: { fix: 0, review: 0 },
  threads: {},
  receipts: [],
  reviews: [],
  stageRuns: [],
  plan,
  createdAt: "2026-10-25T09:00:00.000Z",
  updatedAt: "2026-10-25T09:00:00.000Z",
  ...overrides,
});

let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  registry = AtomRegistry.make();
  destination.box.current = {
    deliveries: Atom.make<Destination["deliveries"] extends Atom.Writable<infer R> ? R : never>(
      AsyncResult.success({ deliveries: [waiting("d1")] }),
    ).pipe(Atom.keepAlive),
    sent: [],
    answers: {},
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
const button = (within: ReactTestInstance, label: string) =>
  within.findAll((node) => node.type === "button" && textOf(node) === label)[0];
const press = (target: ReactTestInstance | undefined) => {
  if (target === undefined) throw new Error("No such button.");
  return act(async () => target.props.onClick());
};
const confirm = (label: string) => {
  const open = dialog();
  if (open === undefined) throw new Error("The confirmation is closed.");
  return press(button(open, label));
};

describe("the plan gate", () => {
  it("approves the plan of the delivery it confirmed, and nothing before", async () => {
    await mount();
    await press(button(root(), "Approve plan"));
    expect(dialog()).toBeDefined();
    expect(destination.get().sent).toEqual([]);
    await confirm("Approve plan");
    expect(destination.get().sent).toEqual([
      ["approvePlan", { environmentId, input: { deliveryId: "d1" } }],
    ]);
    expect(dialog()).toBeUndefined();
  });

  it("closes a confirmation, sending nothing, when another delivery replaces it", async () => {
    await mount();
    await press(button(root(), "Reject plan"));
    expect(dialog()).toBeDefined();
    await act(() =>
      registry.set(
        destination.get().deliveries,
        AsyncResult.success({
          deliveries: [
            waiting("d2", { createdAt: "2026-10-25T10:00:00.000Z" }),
            waiting("d1", { status: "cancelled" }),
          ],
        }),
      ),
    );
    expect(dialog()).toBeUndefined();
    expect(destination.get().sent).toEqual([]);
  });

  it("saves the edited plan and shows the server's refusal on the field it names", async () => {
    destination.get().answers.updatePlan = {
      _tag: "Failure",
      cause: Cause.fail(
        new FactoryError({
          reason: "invalid_request",
          message: "Factory refused the edited plan.",
          deliveryId: FactoryDeliveryId.make("d1"),
          fields: [{ taskId: FactoryTaskId.make("export-header"), field: "summary" }],
        }),
      ),
    };
    await mount();
    // Approve waits for the edits to be saved or discarded.
    const [, headerTask] = root().findAll((node) => node.type === "li");
    const [summary] = headerTask!.findAll((node) => node.type === "textarea");
    await act(async () => summary!.props.onChange({ target: { value: "Write the header." } }));
    expect(button(root(), "Approve plan")?.props.disabled).toBe(true);
    await press(button(root(), "Save plan"));
    expect(destination.get().sent).toEqual([
      [
        "updatePlan",
        {
          environmentId,
          input: {
            deliveryId: "d1",
            plan: {
              tasks: [plan.tasks[0], { ...plan.tasks[1], summary: "Write the header." }],
            },
          },
        },
      ],
    ]);
    expect(textOf(root())).toContain("Factory refused the edited plan.");
    const [csv, header] = root().findAll((node) => node.type === "li");
    expect(textOf(header!)).toContain(FACTORY_PLAN_FIELD_REFUSED);
    expect(textOf(csv!)).not.toContain(FACTORY_PLAN_FIELD_REFUSED);
  });

  it("sends a replan only with a note", async () => {
    await mount();
    await press(button(root(), "Replan"));
    const note = root().findAll(
      (node) =>
        node.type === "textarea" && node.props["aria-label"] === "What the planner should change",
    )[0]!;
    expect(button(root(), "Send to planner")?.props.disabled).toBe(true);
    await act(async () => note.props.onChange({ target: { value: "  Split the export.  " } }));
    await press(button(root(), "Send to planner"));
    expect(destination.get().sent).toEqual([
      ["replan", { environmentId, input: { deliveryId: "d1", note: "Split the export." } }],
    ]);
  });
});
