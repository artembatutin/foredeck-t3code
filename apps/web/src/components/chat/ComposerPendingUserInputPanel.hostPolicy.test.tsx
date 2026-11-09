import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../ui/collapsible", () => {
  const Children = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    Collapsible: Children,
    CollapsiblePanel: Children,
    CollapsibleTrigger: Children,
  };
});

vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const provider = {
  driver: "codex",
  displayName: "Codex",
  supportedRuntimeModes: ["approval-required", "auto-accept-edits"] as const,
  runtimeModeRestrictions: [
    { runtimeMode: "approval-required", status: "disallowed" },
    { runtimeMode: "auto-accept-edits", status: "allowed" },
  ] as const,
};
const prompt = (responseCapability: "live" | "message") => ({
  requestId: RuntimeRequestId.make("question"),
  createdAt: "2026-09-05T00:00:00.000Z",
  dismissible: responseCapability === "message",
  responseCapability,
  questions: [
    {
      id: "approach",
      header: "Approach",
      question: "Which approach?",
      options: [{ label: "Incremental", description: "One module at a time" }],
      multiSelect: false,
    },
  ],
});

/** Mounts the panel, chooses its option and lets the answer's delayed submit fire. */
const answering = async (
  responseCapability: "live" | "message",
  threadMode: "approval-required" | "auto-accept-edits",
  provided: typeof provider | null = provider,
) => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const onToggleOption = vi.fn();
  const onAdvance = vi.fn();
  const onDismiss = vi.fn();
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <ComposerPendingUserInputPanel
          pendingUserInputs={[prompt(responseCapability)]}
          cwd="/repo"
          threadRef={threadRef}
          turn={{ provider: provided, threadMode }}
          respondingRequestIds={[]}
          answers={{}}
          questionIndex={0}
          onToggleOption={onToggleOption}
          onAdvance={onAdvance}
          onDismiss={onDismiss}
        />,
      );
    });
    const option = renderer!.root
      .findAllByType("button")
      .find((button) =>
        button.findAllByType("span").some((span) => span.children.includes("Incremental")),
      );
    await act(async () => {
      option!.props.onClick();
      vi.runAllTimers();
    });
    const dismiss = renderer!.root.findAll(
      (node) => node.props["aria-label"] === "Dismiss question without answering",
    )[0]?.props;
    return { option: option!.props, onToggleOption, onAdvance, onDismiss, dismiss };
  } finally {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
};

it("holds an answer that would start a turn the host refuses, and leaves it dismissible", async () => {
  const held = await answering("message", "approval-required");
  expect(held.option.disabled).toBe(true);
  expect(held.onToggleOption).not.toHaveBeenCalled();
  expect(held.onAdvance).not.toHaveBeenCalled();
  expect(held.dismiss?.disabled).toBe(false);
  held.dismiss?.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
  expect(held.onDismiss).toHaveBeenCalledWith("question");
});

it("answers once the owner has chosen a mode the host allows", async () => {
  const chosen = await answering("message", "auto-accept-edits");
  expect(chosen.onToggleOption).toHaveBeenCalledWith("approach", "Incremental");
  expect(chosen.onAdvance).toHaveBeenCalledTimes(1);
});

it("lets a live answer continue the turn that asked, whatever the host refuses", async () => {
  const live = await answering("live", "approval-required");
  expect(live.onToggleOption).toHaveBeenCalledWith("approach", "Incremental");
  expect(live.onAdvance).toHaveBeenCalledTimes(1);
});

it("answers as ever while the policy is unknown", async () => {
  const unknown = await answering("message", "approval-required", null);
  expect(unknown.onAdvance).toHaveBeenCalledTimes(1);
});
