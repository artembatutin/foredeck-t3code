import { type ProviderApprovalDecision, RuntimeRequestId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  passthrough: ({ children }: { children?: unknown }) => children ?? null,
}));
vi.mock("../ui/button", () => ({ Button: (props: object) => <button {...props} /> }));
vi.mock("../ui/menu", () => ({
  Menu: mocks.passthrough,
  MenuItem: (props: object) => <button {...props} />,
  MenuPopup: mocks.passthrough,
  MenuTrigger: mocks.passthrough,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: mocks.passthrough,
  TooltipPopup: mocks.passthrough,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
}));

import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

const requestId = RuntimeRequestId.make("approval-1");

/** Mounted with its menu open, which the static markup in the sibling test leaves closed. */
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

describe("the choices an approval offers", () => {
  let renderer: ReactTestRenderer | undefined;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  const render = (
    options: Parameters<typeof ComposerPendingApprovalActions>[0]["options"],
    onRespond = vi.fn(
      async (_requestId: RuntimeRequestId, _decision: ProviderApprovalDecision) => undefined,
    ),
  ) => {
    act(() => {
      renderer = create(
        <ComposerPendingApprovalActions
          requestId={requestId}
          isResponding={false}
          canRespond
          options={options}
          onRespondToApproval={onRespond}
        />,
      );
    });
    return { buttons: renderer!.root.findAllByType("button"), onRespond };
  };

  it("offers exactly what the provider supplied, adding no session or lasting choice", () => {
    const { buttons } = render([
      { decision: "decline", label: "Deny" },
      { decision: "accept", label: "Run once" },
    ]);
    expect(buttons.map(textOf)).toEqual(["Deny", "Run once"]);
  });

  it("answers with the provider's own decision", () => {
    const { buttons, onRespond } = render([{ decision: "accept", label: "Run once" }]);
    act(() => buttons[0]!.props.onClick());
    expect(onRespond).toHaveBeenCalledExactlyOnceWith(requestId, "accept");
  });

  it("offers no session choice for a request that lists no choices", () => {
    const { buttons, onRespond } = render(undefined);
    expect(buttons.map(textOf)).toEqual(["Decline", "Approve", "Cancel"]);
    for (const button of buttons) act(() => button.props.onClick());
    expect(onRespond.mock.calls.map(([, decision]) => decision)).not.toContain("acceptForSession");
    expect(onRespond.mock.calls.map(([, decision]) => decision)).toEqual([
      "decline",
      "accept",
      "cancel",
    ]);
  });

  it("keeps a provider's session label that says so", () => {
    const { buttons } = render([
      { decision: "acceptForSession", label: "Allow all edits this session" },
      { decision: "acceptForSession", label: "Allow for this thread" },
    ]);
    expect(buttons.map(textOf)).toEqual(["Allow all edits this session", "Allow for this thread"]);
  });

  it("says a session choice is for this session when the provider's label does not", () => {
    const { buttons } = render([{ decision: "acceptForSession", label: "Allow network" }]);
    expect(buttons.map(textOf)).toEqual(["Allow network for this session"]);
  });
});
