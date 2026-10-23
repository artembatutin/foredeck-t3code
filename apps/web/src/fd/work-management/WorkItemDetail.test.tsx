import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { beginWorkDraft, settleWorkDraft } from "@t3tools/client-runtime/fd/work-management";
import {
  WorkItemId,
  type WorkItemSummary,
  WorkSourceId,
} from "@t3tools/contracts/fd/work-management";

// Only the conflict panel is rendered; the detail view's other dependencies stay out of reach.
vi.mock("../../components/ui/button", () => ({
  Button: (props: object) => <button {...props} />,
}));
vi.mock("../../components/ui/badge", () => ({}));
vi.mock("../../components/ui/input", () => ({}));
vi.mock("../../components/ui/menu", () => ({}));
vi.mock("../../components/ui/spinner", () => ({}));
vi.mock("../../components/ui/textarea", () => ({}));
vi.mock("../../components/ui/toast", () => ({}));
vi.mock("../../composerDraftStore", () => ({}));
vi.mock("../../hooks/useHandleNewThread", () => ({}));
vi.mock("../../state/entities", () => ({}));
vi.mock("../../state/query", () => ({}));
vi.mock("../../lib/utils", () => ({}));
vi.mock("../../state/use-atom-command", () => ({}));
vi.mock("../../threadRoutes", () => ({}));
vi.mock("@tanstack/react-router", () => ({}));
vi.mock("./LinkThreadDialog", () => ({}));
vi.mock("./shared", () => ({}));
vi.mock("./StartWorkThreadDialog", () => ({}));
vi.mock("./state", () => ({}));
vi.mock("./WorkItemFields", () => ({}));
import { DraftConflict } from "./WorkItemDetail";

const ref = {
  sourceId: WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"),
  itemId: WorkItemId.make("fd-7k3qa2"),
};
const summary = (revision: string) =>
  ({ ref, key: "fd-7k3qa2", title: "Ship", revision }) as unknown as WorkItemSummary;
const reapplyButton = (view: ReactTestRenderer) =>
  view.root.findAll(
    (node) => node.type === "button" && node.props.children === "Reapply my edit",
  )[0]!;

it("offers Reapply once a newer version shows, even one past the version the conflict named", async () => {
  // Edited at r1; the save came back stale naming r2.
  const draft = settleWorkDraft(beginWorkDraft("title", summary("r1")), {
    _tag: "stale",
    current: summary("r2"),
    message: "stale",
  })!;
  const onReapply = vi.fn();
  const panel = (revision: string) => (
    <DraftConflict
      draft={draft}
      item={summary(revision)}
      current="Shipped elsewhere"
      onReapply={onReapply}
      onDiscard={vi.fn()}
    />
  );
  let view!: ReactTestRenderer;
  // The cached item is still the one the draft started from: nothing to reapply onto yet.
  await act(async () => {
    view = create(panel("r1"));
  });
  expect(reapplyButton(view).props.disabled).toBe(true);
  // Another edit landed before the reload, so the item shows r3 rather than r2.
  await act(async () => view.update(panel("r3")));
  expect(reapplyButton(view).props.disabled).toBe(false);
  await act(async () => reapplyButton(view).props.onClick());
  expect(onReapply).toHaveBeenCalledWith("r3");
  await act(async () => view.unmount());
});
