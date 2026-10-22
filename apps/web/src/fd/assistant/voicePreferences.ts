import { useEffect, useState } from "react";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { rankedLocalVoices } from "./speech";

const VoicePreferences = Schema.Struct({
  mode: Schema.Literals(["dictation", "conversation"]),
  voiceURI: Schema.String,
});
export const VOICE_PREFERENCES_KEY = "fd.voice.preferences";

/** Preserve the original composer's choices until the shared preference is saved. */
export function readLegacyVoicePreferences(
  read: (key: string) => string | null,
): typeof VoicePreferences.Type {
  try {
    return {
      mode: read("fd.voice.mode") === "conversation" ? "conversation" : "dictation",
      voiceURI: read("fd.voice.voice") ?? "",
    };
  } catch {
    return { mode: "dictation", voiceURI: "" };
  }
}

export function useVoicePreferences() {
  const [initial] = useState(() =>
    readLegacyVoicePreferences((key) => window.localStorage.getItem(key)),
  );
  return useLocalStorage(VOICE_PREFERENCES_KEY, initial, VoicePreferences);
}

export function useLocalVoices() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    const update = () =>
      setVoices(rankedLocalVoices(window.speechSynthesis?.getVoices() ?? [], navigator.language));
    update();
    window.speechSynthesis?.addEventListener("voiceschanged", update);
    return () => window.speechSynthesis?.removeEventListener("voiceschanged", update);
  }, []);
  return voices;
}
