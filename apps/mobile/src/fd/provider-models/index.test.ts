import { describe, expect, it } from "vite-plus/test";
import { modelMetadataSubtitle } from "./index";

describe("native model metadata", () => {
  it("keeps native credits distinct from model names and prices", () => {
    const subtitle = modelMetadataSubtitle({
      costSummary: "9 credits / message",
      contextWindow: 200000,
      maxOutputTokens: 64000,
      supportsImages: false,
    });
    expect(subtitle).toContain("Estimate: 9 credits / message");
    expect(subtitle).toContain("Text only");
    expect(subtitle).toContain("200,000 context tokens");
    expect(subtitle).toContain("64,000 max output tokens");
    expect(subtitle).not.toContain("$");
    expect(modelMetadataSubtitle(undefined)).toBe("");
  });
});
