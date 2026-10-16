/** Strip visual markup before sending a short conversational reply to a local voice. */
export function spokenText(text: string): string {
  return text
    .replace(/`{3}[\s\S]*?`{3}/g, " Code is available in the conversation. ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(?:^|\n)\s{0,3}#{1,6}\s+/g, " ")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);
}

export function selectLocalVoice(
  voices: ReadonlyArray<SpeechSynthesisVoice>,
  language: string,
): SpeechSynthesisVoice | undefined {
  const local = voices.filter((voice) => voice.localService);
  return (
    local.find((voice) => voice.lang.toLowerCase() === language.toLowerCase()) ??
    local.find((voice) => voice.lang.split("-")[0] === language.split("-")[0]) ??
    local[0]
  );
}
