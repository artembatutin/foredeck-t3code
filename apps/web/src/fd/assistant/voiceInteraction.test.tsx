import { cloneElement, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
const mocks = vi.hoisted(() => ({
  read: vi.fn(
    async (): Promise<{ _tag: "Success"; value: { runId: string; text: string } | null }> => ({
      _tag: "Success",
      value: null,
    }),
  ),
  finish: vi.fn(async () => new Float32Array(1)),
}));
vi.mock("~/components/ui/button", () => ({ Button: (props: object) => <button {...props} /> }));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: () => null,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./voicePreferences", () => ({
  useVoicePreferences: () => [{ mode: "conversation", voiceURI: "local" }],
  useLocalVoices: () => [
    { name: "Samantha", lang: "en-US", voiceURI: "local", localService: true },
  ],
}));
vi.mock("./recording", () => ({ startRecording: async () => ({ finish: mocks.finish }) }));
vi.mock("./commands", () => ({ readSpeech: {} }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.read }));
import { AssistantVoiceControls } from "./AssistantVoiceControls";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("records through one control, speaks the final reply, and interrupts despite late audio events", async () => {
  vi.useFakeTimers();
  class Utterance extends EventTarget {
    voice = null;
    constructor(readonly text: string) {
      super();
    }
  }
  let worker!: EventTarget;
  class LocalWorker extends EventTarget {
    postMessage = vi.fn();
    terminate = vi.fn();
  }
  let audio: Utterance | undefined;
  const synth = {
    cancel: vi.fn(),
    speak: vi.fn((utterance: Utterance) => {
      audio = utterance;
      utterance.dispatchEvent(new Event("start"));
    }),
  };
  vi.stubGlobal("window", { speechSynthesis: synth });
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  vi.stubGlobal("Worker", function () {
    worker = new LocalWorker();
    return worker;
  });
  vi.stubGlobal("MediaRecorder", vi.fn());
  vi.stubGlobal("navigator", { language: "en-US", mediaDevices: { getUserMedia: vi.fn() } });
  const onTranscript = vi.fn();
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(
      <AssistantVoiceControls
        threadRef={{
          environmentId: EnvironmentId.make("test"),
          threadId: ThreadId.make("normal-thread"),
        }}
        messages={[]}
        disabled={false}
        thinking={false}
        canConverse={true}
        onTranscript={onTranscript}
      />,
    );
  });
  expect(synth.speak).not.toHaveBeenCalled();
  expect(mocks.read).not.toHaveBeenCalled();
  await act(async () => {
    view.root.findByType("button").props.onClick();
  });
  await act(async () => {
    worker.dispatchEvent(new MessageEvent("message", { data: { type: "ready" } }));
  });
  expect(view.root.findByType("button").props["aria-label"]).toBe("Finish recording");
  await act(async () => {
    view.root.findByType("button").props.onClick();
  });
  expect(mocks.finish).toHaveBeenCalledOnce();
  await act(async () => {
    worker.dispatchEvent(
      new MessageEvent("message", { data: { type: "transcript", text: "Hello" } }),
    );
  });
  expect(onTranscript).toHaveBeenCalledWith("Hello", true);
  mocks.read.mockResolvedValue({
    _tag: "Success",
    value: { runId: "completed-run", text: "The changes are ready." },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(audio?.text).toBe("The changes are ready.");
  expect(view.root.findByType("button").props["aria-label"]).toBe("Interrupt speech");
  const before = synth.cancel.mock.calls.length;
  await act(async () => {
    view.root.findByType("button").props.onClick();
  });
  expect(synth.cancel.mock.calls.length).toBe(before + 1);
  await act(async () => {
    audio!.dispatchEvent(new Event("start"));
    audio!.dispatchEvent(new Event("end"));
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(synth.speak).toHaveBeenCalledOnce();
  expect(view.root.findByType("button").props["aria-label"]).toBe("Microphone");
  await act(async () => {
    view.unmount();
  });
});
