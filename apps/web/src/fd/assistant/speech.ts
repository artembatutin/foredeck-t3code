/** Prefer installed enhanced voices; a saved selection always wins if it is still local. */
export function rankedLocalVoices(voices: ReadonlyArray<SpeechSynthesisVoice>, language: string) {
  const lang = language.toLowerCase();
  const score = (voice: SpeechSynthesisVoice) =>
    (voice.lang.toLowerCase() === lang
      ? 100
      : voice.lang.split("-")[0] === lang.split("-")[0]
        ? 80
        : 0) +
    (/premium/i.test(voice.name) ? 30 : /enhanced|natural/i.test(voice.name) ? 20 : 0) +
    (/samantha|ava|alex|daniel/i.test(voice.name) ? 10 : 0) -
    (/bells|bad news|boing|bubbles|cellos|good news|whisper|zarvox|trinoids/i.test(voice.name)
      ? 100
      : 0);
  return voices
    .filter((voice) => voice.localService)
    .toSorted((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}
export function selectLocalVoice(
  voices: ReadonlyArray<SpeechSynthesisVoice>,
  language: string,
  selected?: string,
) {
  return (
    voices.find((voice) => voice.localService && voice.voiceURI === selected) ??
    rankedLocalVoices(voices, language)[0]
  );
}
/** Speech is intentional content from the completed run, never extracted from a transcript. */
export function shouldSpeakReply(
  reply: { runId: string; text: string } | null,
  seen: ReadonlySet<string>,
  enabled: boolean,
  listening: boolean,
) {
  return !!reply && !!reply.text.trim() && !seen.has(reply.runId) && enabled && !listening;
}
