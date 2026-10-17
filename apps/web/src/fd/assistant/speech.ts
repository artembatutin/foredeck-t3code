const noveltyVoice =
  /^(albert|bad news|bahh|bells|boing|bubbles|cellos|eddy|flo|fred|good news|grandma|grandpa|jester|junior|kathy|organ|ralph|reed|rocko|sandy|shelley|superstar|trinoids|whisper|wobble|zarvox)\b/i;
const normalizedLanguage = (language: string) => language.toLowerCase().replaceAll("_", "-");

/** A small local shortlist: matching language, no character voices, best quality per voice. */
export function rankedLocalVoices(voices: ReadonlyArray<SpeechSynthesisVoice>, language: string) {
  const lang = normalizedLanguage(language);
  const score = (voice: SpeechSynthesisVoice) =>
    (/premium/i.test(voice.name) ? 300 : /enhanced|natural/i.test(voice.name) ? 200 : 0) +
    (normalizedLanguage(voice.lang) === lang ? 30 : 0) +
    (/samantha|ava|alex/i.test(voice.name)
      ? 20
      : /daniel|karen|moira|tessa/i.test(voice.name)
        ? 10
        : 0);
  const seen = new Set<string>();
  return voices
    .filter(
      (voice) =>
        voice.localService &&
        normalizedLanguage(voice.lang).split("-")[0] === lang.split("-")[0] &&
        !noveltyVoice.test(voice.name),
    )
    .toSorted((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))
    .filter((voice) => {
      const name = voice.name.replace(/\s*\((premium|enhanced|natural|compact)\)/gi, "").trim();
      const key = `${name.toLowerCase()}:${normalizedLanguage(voice.lang)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);
}
export function selectLocalVoice(
  voices: ReadonlyArray<SpeechSynthesisVoice>,
  language: string,
  selected?: string,
) {
  const shortlist = rankedLocalVoices(voices, language);
  return shortlist.find((voice) => voice.voiceURI === selected) ?? shortlist[0];
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
