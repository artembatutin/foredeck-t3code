import { useEffect, useRef, useState } from "react";
import {
  CommandId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { MicIcon, SquareIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { newMessageId } from "~/lib/utils";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import type { ChatMessage } from "~/types";
import { startRecording } from "./recording";
import { selectLocalVoice, spokenText } from "./speech";

type Phase = "off" | "loading" | "ready" | "requesting" | "recording" | "transcribing" | "sending";
type Reply =
  | { type: "ready" }
  | { type: "progress"; progress: number }
  | { type: "transcript"; text: string }
  | { type: "error"; message: string };

export function AssistantVoiceControls(props: {
  threadRef: ScopedThreadRef;
  messages: ReadonlyArray<ChatMessage>;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  disabled: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("off");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [speak, setSpeak] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const worker = useRef<Worker | null>(null);
  const recording = useRef<Awaited<ReturnType<typeof startRecording>> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spokenIds = useRef(new Set(props.messages.map((entry) => entry.id)));
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const sendAttempt = useRef<Parameters<typeof startTurn>[0] | null>(null);
  const sending = useRef(false);

  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const stopAudio = () => {
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    setSpeaking(false);
  };
  const cancel = () => {
    generation.current++;
    clearTimer();
    abort.current?.abort();
    recording.current = null;
    worker.current?.terminate();
    worker.current = null;
    stopAudio();
    setSpeak(false);
    setPhase("off");
  };
  useEffect(
    () => () => {
      generation.current++;
      if (timer.current !== null) clearTimeout(timer.current);
      abort.current?.abort();
      worker.current?.terminate();
      if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    },
    [],
  );

  useEffect(() => {
    // Mark old and muted replies as seen so enabling voice never replays chat history.
    const replies = props.messages.filter(
      (entry) => entry.role === "assistant" && !entry.streaming && !spokenIds.current.has(entry.id),
    );
    for (const reply of replies) spokenIds.current.add(reply.id);
    const latest = replies.at(-1);
    if (
      !speak ||
      !latest ||
      typeof speechSynthesis === "undefined" ||
      phase === "recording" ||
      phase === "requesting"
    )
      return;
    const voice = selectLocalVoice(speechSynthesis.getVoices(), navigator.language);
    if (!voice) return;
    const text = spokenText(latest.text);
    if (!text) return;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.addEventListener("start", () => setSpeaking(true));
    utterance.addEventListener("end", () => setSpeaking(false));
    utterance.addEventListener("error", () => setSpeaking(false));
    speechSynthesis.speak(utterance);
  }, [props.messages, speak, phase]);

  const enable = () => {
    if (worker.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMessage(
        "This browser cannot record audio here. Use HTTPS or the desktop app, or type a message.",
      );
      return;
    }
    setMessage(null);
    setProgress(0);
    setPhase("loading");
    const current = new Worker(new URL("./voice.worker.ts", import.meta.url), { type: "module" });
    worker.current = current;
    current.addEventListener("error", () => {
      if (worker.current !== current) return;
      current.terminate();
      worker.current = null;
      setPhase("off");
      setMessage("Local voice could not load. Check your connection and try again.");
    });
    current.addEventListener("message", (event: MessageEvent<Reply>) => {
      if (worker.current !== current) return;
      const reply = event.data;
      if (reply.type === "ready") setPhase("ready");
      else if (reply.type === "progress") setProgress(Math.round(reply.progress));
      else if (reply.type === "transcript") {
        setTranscript(reply.text.trim());
        setPhase("ready");
        if (!reply.text.trim()) setMessage("No speech was detected. Try again.");
      } else {
        setMessage(reply.message);
        current.terminate();
        worker.current = null;
        setPhase("off");
      }
    });
    current.postMessage({ type: "load" }, []);
  };

  const finish = async () => {
    const current = recording.current;
    if (!current) return;
    recording.current = null;
    clearTimer();
    const id = generation.current;
    setPhase("transcribing");
    try {
      const audio = await current.finish();
      if (id !== generation.current) return;
      worker.current?.postMessage({ type: "transcribe", audio }, [audio.buffer]);
    } catch (error) {
      if (id !== generation.current) return;
      setPhase(worker.current ? "ready" : "off");
      setMessage(error instanceof Error ? error.message : "Recording failed.");
    }
  };

  const record = async () => {
    if (phase !== "ready" || props.disabled || transcript) return;
    stopAudio();
    setMessage(null);
    const id = ++generation.current;
    abort.current = new AbortController();
    setPhase("requesting");
    try {
      const current = await startRecording(abort.current.signal);
      if (id !== generation.current) return;
      recording.current = current;
      setPhase("recording");
      timer.current = setTimeout(() => void finish(), 60_000);
    } catch (error) {
      if (id !== generation.current) return;
      setPhase("ready");
      setMessage(error instanceof Error ? error.message : "Microphone access failed.");
    }
  };

  const send = async () => {
    if (!transcript.trim() || props.disabled || phase !== "ready" || sending.current) return;
    sending.current = true;
    const id = generation.current;
    const text = transcript.trim();
    setPhase("sending");
    if (sendAttempt.current?.input.message.text !== text) {
      const messageId = newMessageId();
      sendAttempt.current = {
        environmentId: props.threadRef.environmentId,
        input: {
          commandId: CommandId.make("voice:" + messageId),
          createdAt: new Date().toISOString(),
          threadId: props.threadRef.threadId,
          runtimeMode: props.runtimeMode,
          interactionMode: props.interactionMode,
          message: { messageId, role: "user", text, attachments: [] },
          dispatchMode: "auto",
        },
      };
    }
    try {
      const result = await startTurn(sendAttempt.current);
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (id !== generation.current) return;
      setTranscript("");
      sendAttempt.current = null;
    } catch (error) {
      if (id !== generation.current) return;
      setMessage(
        error instanceof Error
          ? error.message
          : "The message could not be sent. Check the conversation before editing or retrying.",
      );
    } finally {
      sending.current = false;
      if (id === generation.current) setPhase("ready");
    }
  };

  return (
    <section aria-label="Assistant voice" className="space-y-2 border-b border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {phase === "off" ? (
          <Button variant="outline" size="sm" onClick={enable}>
            Enable local voice
          </Button>
        ) : null}
        {phase === "ready" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={props.disabled || !!transcript}
            onClick={() => void record()}
          >
            <MicIcon />
            Talk
          </Button>
        ) : null}
        {phase === "recording" ? (
          <Button variant="default" size="sm" onClick={() => void finish()}>
            <SquareIcon />
            Finish recording
          </Button>
        ) : null}
        {phase !== "off" && phase !== "ready" ? (
          <span role="status" className="text-sm text-muted-foreground">
            {phase === "loading"
              ? `Downloading voice model… ${progress}%`
              : phase === "requesting"
                ? "Waiting for microphone…"
                : phase === "recording"
                  ? "Listening · up to one minute"
                  : phase === "transcribing"
                    ? "Transcribing on this device…"
                    : "Sending…"}
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={speak}
          onClick={() => {
            stopAudio();
            if (
              !speak &&
              (typeof speechSynthesis === "undefined" ||
                !selectLocalVoice(speechSynthesis.getVoices(), navigator.language))
            ) {
              setMessage(
                "No local voice is available yet. Install a system voice or try again after it loads.",
              );
              return;
            }
            setMessage(null);
            setSpeak(!speak);
          }}
        >
          {speak ? <Volume2Icon /> : <VolumeXIcon />}
          {speak ? "Spoken replies on" : "Spoken replies off"}
        </Button>
        {speaking ? (
          <Button variant="ghost" size="sm" onClick={stopAudio}>
            Stop speaking
          </Button>
        ) : null}
        {phase !== "off" ? (
          <Button variant="ghost" size="sm" disabled={phase === "sending"} onClick={cancel}>
            End voice
          </Button>
        ) : null}
      </div>
      {phase === "off" ? (
        <p className="text-xs text-muted-foreground">
          English voice runs on this device after a one-time model download. No speech API charges.
        </p>
      ) : null}
      {transcript ? (
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Textarea
              aria-label="Voice message"
              size="sm"
              value={transcript}
              disabled={phase === "sending"}
              onChange={(event) => setTranscript(event.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={phase !== "ready" || props.disabled || !transcript.trim()}
            onClick={() => void send()}
          >
            Send
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={phase === "sending"}
            onClick={() => {
              setTranscript("");
              sendAttempt.current = null;
            }}
          >
            Discard
          </Button>
        </div>
      ) : null}
      {message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
    </section>
  );
}
