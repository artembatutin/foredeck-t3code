import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { AudioLinesIcon, EllipsisIcon, MicIcon, MicOffIcon, Volume2Icon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { toastManager } from "~/components/ui/toast";
import { useLocalVoices, useVoicePreferences } from "./voicePreferences";
import styles from "./voiceControl.module.css";
import { useAtomCommand } from "~/state/use-atom-command";
import type { ChatMessage } from "~/types";
import { startRecording } from "./recording";
import { selectLocalVoice, shouldSpeakReply } from "./speech";
import { readSpeech } from "./commands";

type Phase = "off" | "loading" | "ready" | "requesting" | "recording" | "transcribing";
type Reply =
  | { type: "ready" }
  | { type: "progress"; progress: number }
  | { type: "transcript"; text: string }
  | { type: "error"; message: string };
export function AssistantVoiceControls(props: {
  threadRef: ScopedThreadRef;
  messages: ReadonlyArray<ChatMessage>;
  disabled: boolean;
  thinking: boolean;
  canConverse: boolean;
  onTranscript: (text: string, submit: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>("off");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [{ mode, voiceURI }] = useVoicePreferences();
  const voices = useLocalVoices();
  const [speaking, setSpeaking] = useState(false);
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
    return () => {
      generation.current++;
      if (timer.current) clearTimeout(timer.current);
      abort.current?.abort();
      worker.current?.terminate();
      window.speechSynthesis?.cancel();
    };
  }, []);
  const previousPreferences = useRef({ mode, voiceURI });
  const preferencesChanged = useEffectEvent((nextMode: typeof mode, nextVoice: string) => {
    const previous = previousPreferences.current;
    previousPreferences.current = { mode: nextMode, voiceURI: nextVoice };
    if (previous.mode !== nextMode || previous.voiceURI !== nextVoice) end();
  });
  useEffect(() => preferencesChanged(mode, voiceURI), [mode, voiceURI]);
  useEffect(() => {
    if (error) toastManager.add({ type: "error", title: "Voice unavailable", description: error });
  }, [error]);
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
  const processing = ["loading", "requesting", "transcribing"].includes(phase);
  const label = speaking
    ? "Interrupt speech"
    : phase === "recording"
      ? "Finish recording"
      : processing
        ? "Cancel recording"
        : error
          ? "Retry microphone"
          : "Microphone";
  const visualState = speaking
    ? "speaking"
    : phase === "recording"
      ? "listening"
      : processing || status === "Thinking"
        ? "processing"
        : error
          ? "error"
          : "idle";
  const Icon =
    visualState === "speaking"
      ? Volume2Icon
      : visualState === "listening"
        ? AudioLinesIcon
        : visualState === "processing"
          ? EllipsisIcon
          : visualState === "error"
            ? MicOffIcon
            : MicIcon;
  return (
    <>
      <span role="status" className="sr-only">
        {error ?? status}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant={phase === "recording" || speaking ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={label}
              aria-pressed={phase === "recording" || speaking}
              disabled={props.disabled && !speaking && phase !== "recording" && !processing}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  end();
                }
              }}
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
            />
          }
        >
          <span
            key={visualState}
            className={`flex items-center justify-center ${styles.stateIcon}`}
            aria-hidden="true"
          >
            <Icon className={error ? "text-destructive" : undefined} />
          </span>
        </TooltipTrigger>
        <TooltipPopup>{error ?? (status ? `${status} · ${label}` : label)}</TooltipPopup>
      </Tooltip>
    </>
  );
}
