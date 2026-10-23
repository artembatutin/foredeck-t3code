import { type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import {
  WorkItemId,
  WorkSourceId,
  type WorkItemDetail,
} from "@t3tools/contracts/fd/work-management";

vi.mock("../../components/ui/button", () => ({
  Button: (props: object) => <button {...props} />,
}));
vi.mock("../../components/ui/input", () => ({ Input: (props: object) => <input {...props} /> }));
vi.mock("../../components/ui/menu", () => ({}));
vi.mock("../../components/ui/popover", () => ({}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("./state", () => ({ workEnvironment: {} }));
import { WorkRelationshipEditor } from "./WorkItemFields";

const ref = {
  sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
  itemId: WorkItemId.make("fd-7k3qa2"),
};
const item = (revision: string, blockedBy: ReadonlyArray<string>) =>
  ({
    ref,
    key: "fd-7k3qa2",
    revision,
    parent: null,
    blockedBy: blockedBy.map((id) => WorkItemId.make(id)),
  }) as unknown as WorkItemDetail;

const buttonNamed = (view: ReactTestRenderer, label: string): ReactTestInstance =>
  view.root.findAll(
    (node) => node.type === "button" && (node.props.children as ReactNode) === label,
  )[0]!;
const input = (view: ReactTestRenderer) => view.root.findByType("input");

it("saves blocked-by against the revision the edit began at and recovers from a conflict", async () => {
  const update = vi.fn();
  const element = (detail: WorkItemDetail) => (
    <WorkRelationshipEditor item={detail} field="blockedBy" update={update} />
  );
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(element(item("r1", ["fd-aaaaaa"])));
  });
  await act(async () => buttonNamed(view, "Edit").props.onClick());
  expect(input(view).props.value).toBe("fd-aaaaaa");

  // Another client adds a blocker; the detail refreshes to r2 while the editor is open.
  await act(async () => view.update(element(item("r2", ["fd-aaaaaa", "fd-cccccc"]))));
  await act(async () => input(view).props.onChange({ target: { value: "fd-aaaaaa, fd-bbbbbb" } }));
  update.mockResolvedValueOnce({ _tag: "stale", current: null, message: "stale" });
  await act(async () => buttonNamed(view, "Save").props.onClick());
  expect(update).toHaveBeenLastCalledWith({
    blockedBy: ["fd-aaaaaa", "fd-bbbbbb"],
    expectedRevision: "r1",
  });

  // The conflict keeps the owner's text and shows the newer set; reapplying bases it on r2.
  expect(input(view).props.value).toBe("fd-aaaaaa, fd-bbbbbb");
  expect(buttonNamed(view, "Save").props.disabled).toBe(true);
  const reapply = buttonNamed(view, "Reapply my edit");
  expect(reapply.props.disabled).toBe(false);
  await act(async () => reapply.props.onClick());
  update.mockResolvedValueOnce({ _tag: "success", value: null });
  await act(async () => buttonNamed(view, "Save").props.onClick());
  expect(update).toHaveBeenLastCalledWith({
    blockedBy: ["fd-aaaaaa", "fd-bbbbbb"],
    expectedRevision: "r2",
  });
  expect(view.root.findAllByType("input")).toHaveLength(0);
  await act(async () => view.unmount());
});
