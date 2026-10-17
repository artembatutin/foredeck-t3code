import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { MicIcon, SquareIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useAtomCommand } from "~/state/use-atom-command";
import type { ChatMessage } from "~/types";
import { startRecording } from "./recording";
import { rankedLocalVoices, selectLocalVoice, shouldSpeakReply } from "./speech";
import { readSpeech } from "./commands";

type Phase = "off" | "loading" | "ready" | "requesting" | "recording" | "transcribing";
type Reply =
  | { type: "ready" }
  | { type: "progress"; progress: number }
  | { type: "transcript"; text: string }
  | { type: "error"; message: string };
const preference = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};

export function AssistantVoiceControls(props: {
  threadRef: ScopedThreadRef;
  messages: ReadonlyArray<ChatMessage>;
  disabled: boolean;
  thinking: boolean;
  canConverse: boolean;
  onTranscript: (text: string, submit: boolean) => void;
}) {
  const optionsId = useId();
  const [phase, setPhase] = useState<Phase>("off");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState(() => preference("fd.voice.mode", "dictation"));
  const [voiceURI, setVoiceURI] = useState(() => preference("fd.voice.voice", ""));
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [options, setOptions] = useState(false);
  const worker = useRef<Worker | null>(null);
  const recording = useRef<Awaited<ReturnType<typeof startRecording>> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seen = useRef(new Set<string>(props.messages.flatMap((m) => (m.runId ? [m.runId] : []))));
  const requested = useRef(false);
  const read = useAtomCommand(readSpeech, { reportFailure: false });
  const onTranscript = useEffectEvent((text: string) =>
    props.onTranscript(text, mode === "conversation" && props.canConverse),
  );
  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const stopAudio = () => {
    generation.current++;
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  };
  const end = () => {
    requested.current = false;
    clearTimer();
    abort.current?.abort();
    recording.current = null;
    worker.current?.terminate();
    worker.current = null;
    stopAudio();
    setPhase("off");
  };
  useEffect(() => {
    const update = () =>
      setVoices(rankedLocalVoices(window.speechSynthesis?.getVoices() ?? [], navigator.language));
    update();
    window.speechSynthesis?.addEventListener("voiceschanged", update);
    return () => {
      window.speechSynthesis?.removeEventListener("voiceschanged", update);
      generation.current++;
      if (timer.current) clearTimeout(timer.current);
      abort.current?.abort();
      worker.current?.terminate();
      window.speechSynthesis?.cancel();
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("fd.voice.mode", mode);
      localStorage.setItem("fd.voice.voice", voiceURI);
    } catch {
      /* Storage is optional. */
    }
  }, [mode, voiceURI]);
  const speak = (text: string) => {
    const voice = selectLocalVoice(voices, navigator.language, voiceURI);
    if (!voice) {
      setError(
        "No suitable local voice is available for your language. You can keep typing or dictating.",
      );
      return;
    }
    stopAudio();
    const id = generation.current;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.addEventListener("start", () => {
      if (generation.current === id) setSpeaking(true);
    });
    utterance.addEventListener("end", () => {
      if (generation.current === id) setSpeaking(false);
    });
    utterance.addEventListener("error", (event) => {
      if (generation.current !== id) return;
      setSpeaking(false);
      if (!["canceled", "interrupted"].includes(event.error))
        setError("Speech stopped. The written response is available.");
    });
    speechSynthesis.speak(utterance);
  };
  useEffect(() => {
    if (phase === "off" || mode !== "conversation") {
      for (const message of props.messages) if (message.runId) seen.current.add(message.runId);
    }
  }, [props.messages, mode, phase]);
  const acceptReply = useEffectEvent((reply: { runId: string; text: string } | null) => {
    const enabled = mode === "conversation" && phase !== "off";
    if (
      shouldSpeakReply(
        reply,
        seen.current,
        enabled,
        ["recording", "requesting", "transcribing"].includes(phase),
      )
    )
      speak(reply!.text);
    if (reply) seen.current.add(reply.runId);
  });
  const voiceEnabled = phase !== "off" && mode === "conversation";
  useEffect(() => {
    if (!voiceEnabled) return;
    let alive = true;
    let next: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const result = await read({
        environmentId: props.threadRef.environmentId,
        input: { threadId: props.threadRef.threadId },
      });
      if (!alive) return;
      if (result._tag === "Success") acceptReply(result.value);
      next = setTimeout(() => void refresh(), 1500);
    };
    void refresh();
    return () => {
      alive = false;
      clearTimeout(next);
    };
  }, [voiceEnabled, read, props.threadRef.environmentId, props.threadRef.threadId]);
  const finish = async () => {
    const current = recording.current;
    if (!current) return;
    recording.current = null;
    clearTimer();
    const id = generation.current;
    setPhase("transcribing");
    try {
      const audio = await current.finish();
      if (id === generation.current)
        worker.current?.postMessage({ type: "transcribe", audio }, [audio.buffer]);
    } catch (cause) {
      if (id === generation.current) {
        setPhase("ready");
        setError(cause instanceof Error ? cause.message : "Recording failed; try again or type.");
      }
    }
  };
  const record = useEffectEvent(async () => {
    if (props.disabled) return;
    stopAudio();
    setError(null);
    const id = generation.current;
    abort.current = new AbortController();
    setPhase("requesting");
    try {
      const current = await startRecording(abort.current.signal, () => void finish());
      if (id !== generation.current) {
        abort.current.abort();
        return;
      }
      recording.current = current;
      setPhase("recording");
      timer.current = setTimeout(() => void finish(), 60_000);
    } catch (cause) {
      if (id === generation.current) {
        setPhase("ready");
        setError(
          cause instanceof Error
            ? cause.message
            : "Microphone access failed. You can type instead.",
        );
      }
    }
  });
  const enable = () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Recording needs HTTPS or the desktop app. You can type instead.");
      setOptions(true);
      return;
    }
    requested.current = true;
    setError(null);
    setProgress(0);
    setPhase("loading");
    const current = new Worker(new URL("./voice.worker.ts", import.meta.url), { type: "module" });
    worker.current = current;
    const fail = (message: string) => {
      if (worker.current !== current) return;
      current.terminate();
      worker.current = null;
      requested.current = false;
      setPhase("off");
      setError(message);
      setOptions(true);
    };
    current.addEventListener("error", () =>
      fail("Local recognition could not load. Retry or type a message."),
    );
    current.addEventListener("message", (event: MessageEvent<Reply>) => {
      if (worker.current !== current) return;
      const reply = event.data;
      if (reply.type === "ready") setPhase("ready");
      else if (reply.type === "progress") setProgress(Math.round(reply.progress));
      else if (reply.type === "transcript") {
        setPhase("ready");
        if (reply.text.trim()) onTranscript(reply.text.trim());
        else {
          setError("No speech detected. Try again.");
          setOptions(true);
        }
      } else fail(reply.message);
    });
    current.postMessage({ type: "load" }, []);
  };
  useEffect(() => {
    if (phase === "ready" && requested.current && !props.disabled) {
      requested.current = false;
      void record();
    }
  }, [phase, props.disabled]);
  const status = speaking
    ? "Speaking"
    : phase === "recording"
      ? "Listening"
      : phase === "transcribing"
        ? "Transcribing"
        : props.thinking && mode === "conversation" && phase !== "off"
          ? "Thinking"
          : phase === "loading"
            ? `Loading ${progress}%`
            : phase === "requesting"
              ? "Microphone…"
              : "";
  const label = speaking
    ? "Interrupt speech"
    : phase === "recording"
      ? "Finish speaking"
      : "Microphone";
  return (
    <div className="flex items-center gap-1">
      {status ? (
        <span role="status" className="text-xs text-muted-foreground">
          {status}
        </span>
      ) : null}
      <Button
        type="button"
        variant={phase === "recording" ? "default" : "ghost"}
        size="icon-sm"
        aria-label={label}
        disabled={props.disabled && !speaking && phase !== "recording"}
        onClick={() => {
          if (speaking) {
            stopAudio();
            return;
          }
          if (phase === "off") enable();
          else if (phase === "ready") void record();
          else if (phase === "recording") void finish();
          else end();
        }}
      >
        {speaking || phase === "recording" ? <SquareIcon /> : <MicIcon />}
      </Button>
      <Popover open={options} onOpenChange={setOptions}>
        <PopoverTrigger
          openOnHover
          render={
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Voice options" />
          }
        >
          <ChevronDownIcon />
        </PopoverTrigger>
        <PopoverPopup width="sm" side="top" align="end">
          <div className="space-y-3 text-sm">
            <div className="space-y-1.5">
              <label htmlFor={`${optionsId}-mode`} className="text-xs text-muted-foreground">
                Mode
              </label>
              <Select
                items={[
                  { value: "dictation", label: "Dictation" },
                  { value: "conversation", label: "Conversation" },
                ]}
                value={mode}
                onValueChange={(value) => {
                  if (value === null) return;
                  stopAudio();
                  setMode(value);
                }}
              >
                <SelectTrigger id={`${optionsId}-mode`} size="sm" aria-label="Voice mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="dictation">Dictation</SelectItem>
                  <SelectItem value="conversation">Conversation</SelectItem>
                </SelectPopup>
              </Select>
              <p className="text-xs text-muted-foreground">
                {mode === "dictation" ? "Edit before sending." : "Send after a pause."}
              </p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${optionsId}-voice`} className="text-xs text-muted-foreground">
                Voice
              </label>
              <Select
                items={[
                  { value: "", label: "Recommended" },
                  ...voices.map((v) => ({ value: v.voiceURI, label: `${v.name} (${v.lang})` })),
                ]}
                value={voices.some((voice) => voice.voiceURI === voiceURI) ? voiceURI : ""}
                onValueChange={(value) => {
                  if (value === null) return;
                  stopAudio();
                  setVoiceURI(value);
                }}
              >
                <SelectTrigger id={`${optionsId}-voice`} size="sm" aria-label="Local voice">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="">Recommended</SelectItem>
                  {voices.map((v) => (
                    <SelectItem key={v.voiceURI} value={v.voiceURI}>
                      {v.name} ({v.lang})
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => speak("The changes are ready. What would you like to explore next?")}
              >
                Preview voice
              </Button>
              {phase !== "off" ? (
                <Button type="button" variant="ghost" size="sm" onClick={end}>
                  End voice
                </Button>
              ) : null}
            </div>
            {error ? <p role="status">{error}</p> : null}
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
