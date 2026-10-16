import { describe, expect, it } from "vite-plus/test";
import { selectLocalVoice, spokenText } from "./speech";

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
  it("reads prose and link labels instead of code and URLs", () => {
    expect(
      spokenText(
        "# Update\n**Done.** [Review](https://example.com)\n```ts\nsecret()\n```\n![chart](https://example.com/chart)",
      ),
    ).toBe("Update Done. Review Code is available in the conversation.");
    expect(spokenText("x".repeat(4000))).toHaveLength(3000);
  });
});
