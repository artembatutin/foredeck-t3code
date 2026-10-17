import { describe, expect, it } from "vite-plus/test";
import { selectLocalVoice, shouldSpeakReply } from "./speech";

const voice = (lang: string, localService: boolean): SpeechSynthesisVoice => ({
  lang,
  localService,
  default: false,
  name: lang,
  voiceURI: lang,
});

describe("local spoken replies", () => {
  it("never chooses a network voice, even when it matches the preferred language", () => {
    const local = voice("en-GB", true);
    expect(selectLocalVoice([voice("en-US", false), local], "en-US")).toBe(local);
    expect(selectLocalVoice([voice("en-US", false)], "en-US")).toBeUndefined();
  });
  it("prefers an exact local language, then the same language", () => {
    const exact = voice("en-US", true);
    const nearby = voice("en-GB", true);
    const other = voice("fr-FR", true);
    expect(selectLocalVoice([other, nearby, exact], "en-US")).toBe(exact);
    expect(selectLocalVoice([other, nearby], "en-US")).toBe(nearby);
  });
  it("selects enhanced quality and respects a saved local voice", () => {
    const compact = { ...voice("en-US", true), name: "Samantha", voiceURI: "compact" };
    const enhanced = { ...compact, name: "Ava (Enhanced)", voiceURI: "enhanced" };
    expect(selectLocalVoice([compact, enhanced], "en-US")).toBe(enhanced);
    expect(selectLocalVoice([compact, enhanced], "en-US", "compact")).toBe(compact);
  });
  it("plays only an intentional unseen reply and never while listening or muted", () => {
    const reply = { runId: "run-a", text: "The changes are ready. One decision remains." };
    expect(shouldSpeakReply(null, new Set(), true, false)).toBe(false);
    expect(shouldSpeakReply(reply, new Set(), true, false)).toBe(true);
    expect(shouldSpeakReply(reply, new Set(["run-a"]), true, false)).toBe(false);
    expect(shouldSpeakReply(reply, new Set(), true, true)).toBe(false);
    expect(shouldSpeakReply(reply, new Set(), false, false)).toBe(false);
  });
});
