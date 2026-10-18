import { useEffect, useRef, useState } from "react";
import { MicIcon, PlayIcon, SquareIcon } from "lucide-react";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { selectLocalVoice } from "./speech";
import { useLocalVoices, useVoicePreferences } from "./voicePreferences";

export function VoiceSettings() {
  const [preferences, setPreferences] = useVoicePreferences();
  const voices = useLocalVoices();
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useRef<SpeechSynthesisUtterance | null>(null);
  const stop = () => {
    if (preview.current) {
      preview.current = null;
      window.speechSynthesis?.cancel();
    }
    setPreviewing(false);
  };
  useEffect(
    () => () => {
      if (preview.current) {
        preview.current = null;
        window.speechSynthesis?.cancel();
      }
    },
    [],
  );
  const play = () => {
    if (previewing) {
      stop();
      return;
    }
    const voice = selectLocalVoice(voices, navigator.language, preferences.voiceURI);
    if (!voice) return;
    setError(null);
    const utterance = new SpeechSynthesisUtterance(
      "The changes are ready. What would you like to explore next?",
    );
    utterance.voice = voice;
    preview.current = utterance;
    setPreviewing(true);
    utterance.addEventListener("end", () => {
      if (preview.current !== utterance) return;
      preview.current = null;
      setPreviewing(false);
    });
    utterance.addEventListener("error", (event) => {
      if (preview.current !== utterance) return;
      preview.current = null;
      setPreviewing(false);
      if (!["canceled", "interrupted"].includes(event.error))
        setError("Voice preview could not play. Try another voice.");
    });
    window.speechSynthesis.speak(utterance);
  };
  return (
    <SettingsSection id="voice" title="Voice" icon={<MicIcon className="size-4" />}>
      <SettingsRow
        id="voice-mode"
        title="Mode"
        description={
          preferences.mode === "dictation"
            ? "Edit your transcript before sending."
            : "Send after a pause and hear spoken replies."
        }
        control={
          <div className="w-full sm:w-56">
            <Select
              items={[
                { value: "dictation", label: "Dictation" },
                { value: "conversation", label: "Conversation" },
              ]}
              value={preferences.mode}
              onValueChange={(mode) => {
                if (mode !== "dictation" && mode !== "conversation") return;
                stop();
                setPreferences((current) => ({ ...current, mode }));
              }}
            >
              <SelectTrigger size="sm" aria-label="Voice mode">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="dictation">Dictation</SelectItem>
                <SelectItem value="conversation">Conversation</SelectItem>
              </SelectPopup>
            </Select>
          </div>
        }
      />
      <SettingsRow
        id="voice-speaking-voice"
        title="Speaking voice"
        description={
          error ??
          (voices.length
            ? "Local voices on this device."
            : "No suitable local voice is installed for your language.")
        }
        control={
          <div className="flex items-center gap-2">
            <div className="w-48">
              <Select
                items={[
                  { value: "", label: "Recommended" },
                  ...voices.map((v) => ({ value: v.voiceURI, label: `${v.name} (${v.lang})` })),
                ]}
                value={
                  voices.some((voice) => voice.voiceURI === preferences.voiceURI)
                    ? preferences.voiceURI
                    : ""
                }
                onValueChange={(voiceURI) => {
                  if (voiceURI === null) return;
                  stop();
                  setPreferences((current) => ({ ...current, voiceURI }));
                }}
              >
                <SelectTrigger size="sm" aria-label="Speaking voice">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="">Recommended</SelectItem>
                  {voices.map((v) => (
                    <SelectItem key={v.voiceURI} value={v.voiceURI}>
                      {v.name} ({v.lang})
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={previewing ? "Stop voice preview" : "Preview voice"}
                    disabled={!voices.length}
                    onClick={play}
                  />
                }
              >
                {previewing ? <SquareIcon /> : <PlayIcon />}
              </TooltipTrigger>
              <TooltipPopup>{previewing ? "Stop preview" : "Preview voice"}</TooltipPopup>
            </Tooltip>
          </div>
        }
      />
    </SettingsSection>
  );
}
