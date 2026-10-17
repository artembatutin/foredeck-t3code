import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
const state = vi.hoisted(() => ({ create: vi.fn(), start: vi.fn(), navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("@t3tools/client-runtime/prompt-links", () => ({
  resolvePromptLinkModelSelection: () => ({
    selection: { instanceId: "subscription", model: "configured" },
  }),
}));
vi.mock("~/components/ui/button", () => ({ Button: (props: object) => <button {...props} /> }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/hooks/useScratchProject", () => ({
  useScratchProject: () => ({ openScratchProject: async () => ({ id: "scratch" }) }),
}));
vi.mock("~/state/entities", () => ({
  useThreadShells: () => [],
  useAllEnvironmentShellsBootstrapped: () => true,
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "test",
        connection: { phase: "connected" },
        serverConfig: { providers: [], settings: { defaultRuntimeMode: "approval-required" } },
      },
    ],
  }),
}));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("~/state/threads", () => ({
  threadEnvironment: { create: "create", startTurn: "start", unarchive: "unarchive" },
}));
vi.mock("~/state/use-orchestration-command", () => ({
  useOrchestrationCommand: (name: string) => (name === "create" ? state.create : state.start),
}));
import { AssistantEntry } from "./AssistantEntry";
it("opening creates a stable empty shell with no fabricated message or model turn", async () => {
  state.create.mockResolvedValue({ _tag: "Success", value: undefined });
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<AssistantEntry environmentId={EnvironmentId.make("test")} />);
  });
  await act(async () => {
    view.root.findByType("button").props.onClick();
  });
  expect(state.create).toHaveBeenCalledTimes(1);
  expect(state.create.mock.calls[0]![0]).toMatchObject({
    input: { threadId: "fd-assistant-owner", projectId: "scratch" },
  });
  expect(state.create.mock.calls[0]![0].input).not.toHaveProperty("message");
  expect(state.start).not.toHaveBeenCalled();
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: "test", threadId: "fd-assistant-owner" },
  });
  await act(async () => {
    view.unmount();
  });
});
