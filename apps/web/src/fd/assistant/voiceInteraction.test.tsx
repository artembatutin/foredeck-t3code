import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
vi.mock("~/components/ui/button", () => ({ Button: (props: object) => <button {...props} /> }));
vi.mock("~/components/ui/popover", () => ({
  Popover: (props: object) => <div {...props} />,
  PopoverPopup: (props: object) => <div {...props} />,
  PopoverTrigger: (props: object) => <div {...props} />,
}));
vi.mock("./commands", () => ({ readSpeech: {} }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: null }),
}));
import { AssistantVoiceControls } from "./AssistantVoiceControls";
afterEach(() => vi.unstubAllGlobals());
it("interrupts playback immediately and ignores late audio completion", async () => {
  class Utterance extends EventTarget {
    voice = null;
    constructor(readonly text: string) {
      super();
    }
  }
  let audio: Utterance | undefined;
  const synth = {
    getVoices: () => [{ name: "Samantha", lang: "en-US", voiceURI: "local", localService: true }],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    cancel: vi.fn(),
    speak: (utterance: Utterance) => {
      audio = utterance;
      utterance.dispatchEvent(new Event("start"));
    },
  };
  vi.stubGlobal("window", { speechSynthesis: synth });
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  vi.stubGlobal("navigator", { language: "en-US" });
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
        onTranscript={vi.fn()}
      />,
    );
  });
  await act(async () => {
    view.root
      .findAllByType("button")
      .find((b) => b.props.children === "Preview voice")!
      .props.onClick();
  });
  expect(audio?.text).toBe("The changes are ready. What would you like to explore next?");
  const before = synth.cancel.mock.calls.length;
  await act(async () => {
    view.root.findByProps({ "aria-label": "Interrupt speech" }).props.onClick();
  });
  expect(synth.cancel.mock.calls.length).toBe(before + 1);
  await act(async () => {
    audio!.dispatchEvent(new Event("start"));
    audio!.dispatchEvent(new Event("end"));
  });
  expect(view.root.findAllByProps({ "aria-label": "Interrupt speech" })).toHaveLength(0);
  await act(async () => {
    view.unmount();
  });
});
