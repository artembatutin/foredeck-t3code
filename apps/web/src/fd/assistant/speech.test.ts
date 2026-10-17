import { describe, expect, it } from "vite-plus/test";
import { rankedLocalVoices, selectLocalVoice, shouldSpeakReply } from "./speech";

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
  it("keeps the enhanced version of a voice and honors a saved shortlist choice", () => {
    const compact = { ...voice("en-US", true), name: "Samantha", voiceURI: "compact" };
    const enhanced = { ...compact, name: "Samantha (Enhanced)", voiceURI: "enhanced" };
    const alternative = { ...compact, name: "Ava", voiceURI: "ava" };
    expect(selectLocalVoice([compact, enhanced], "en-US")).toBe(enhanced);
    expect(rankedLocalVoices([compact, enhanced], "en-US")).toEqual([enhanced]);
    expect(selectLocalVoice([alternative, enhanced], "en-US", "ava")).toBe(alternative);
  });
  it("removes novelty voices even if previously selected", () => {
    const normal = { ...voice("en-US", true), name: "Samantha", voiceURI: "samantha" };
    const novelty = [
      "Bells",
      "Grandpa (English (US))",
      "Grandma",
      "Boing",
      "Organ",
      "Zarvox",
      "Eddy (English (US))",
    ].map((name) => ({
      ...voice("en-US", true),
      name,
      voiceURI: name,
    }));
    expect(rankedLocalVoices([...novelty, normal], "en-US")).toEqual([normal]);
    expect(selectLocalVoice([...novelty, normal], "en-US", "Bells")).toBe(normal);
    expect(selectLocalVoice(novelty, "en-US")).toBeUndefined();
  });
  it("limits the picker to six same-language local voices without duplicate qualities", () => {
    const candidates = [
      "Samantha",
      "Daniel",
      "Karen",
      "Moira",
      "Tessa",
      "Rishi",
      "Aman",
      "Tara",
    ].map((name) => ({
      ...voice("en_US", true),
      name,
      voiceURI: name,
    }));
    const result = rankedLocalVoices(
      [voice("fr-FR", true), voice("en-US", false), ...candidates],
      "en-US",
    );
    expect(result).toHaveLength(6);
    expect(result.every((v) => v.localService && v.lang === "en_US")).toBe(true);
    expect(rankedLocalVoices([voice("fr-FR", true)], "en-US")).toEqual([]);
  });
  it("prefers enhanced speech over a compact exact-region voice", () => {
    const compact = { ...voice("en-US", true), name: "Samantha" };
    const enhanced = { ...voice("en-GB", true), name: "Daniel (Enhanced)" };
    expect(selectLocalVoice([compact, enhanced], "en-US")).toBe(enhanced);
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
