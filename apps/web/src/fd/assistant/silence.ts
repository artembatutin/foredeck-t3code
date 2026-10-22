/** End an utterance after a pause, while allowing quiet starts and brief gaps between words. */
export function silenceDetector(startedAt: number) {
  let lastSpeech: number | null = null;
  return (rms: number, now: number) => {
    if (rms >= 0.018) lastSpeech = now;
    return lastSpeech === null ? now - startedAt >= 10_000 : now - lastSpeech >= 1_200;
  };
}
