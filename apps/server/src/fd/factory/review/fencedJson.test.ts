import { describe, expect, it } from "vite-plus/test";

import { parseFencedReview } from "./fencedJson.ts";
import type { FactoryFencedReview } from "./fencedJson.ts";

const review = (verdict: string) => ({
  verdict,
  findings: [],
  acceptance: [
    { criterion: 1, status: "verified", evidence: "Covered by a test.", paths: ["src/a.ts"] },
  ],
  missing_evidence: [],
});

const fenced = (body: string, info = "json", fence = "```") => `${fence}${info}\n${body}\n${fence}`;

/** Parses without letting a throw escape, so a defect fails the assertion instead of the run. */
const parse = (message: string): FactoryFencedReview | "threw" => {
  try {
    return parseFencedReview(message);
  } catch {
    return "threw";
  }
};

describe("parseFencedReview", () => {
  it("decodes the last json block and ignores earlier ones", () => {
    const message = [
      "Draft:",
      fenced(JSON.stringify(review("changes-required"))),
      "Final:",
      fenced(JSON.stringify(review("pass"), null, 2)),
      "Done.",
    ].join("\n");
    const result = parse(message);
    expect(result).toMatchObject({ status: "decoded", review: { verdict: "pass" } });
  });

  it("takes the last json block even when a block in another language follows", () => {
    const message = [fenced(JSON.stringify(review("pass"))), fenced("pnpm test", "sh")].join("\n");
    expect(parse(message)).toMatchObject({ status: "decoded", review: { verdict: "pass" } });
  });

  it("treats a json fence inside a longer fence as content", () => {
    const quoted = fenced(fenced(JSON.stringify(review("changes-required"))), "markdown", "````");
    const message = [fenced(JSON.stringify(review("pass"))), quoted].join("\n");
    expect(parse(message)).toMatchObject({ status: "decoded", review: { verdict: "pass" } });
  });

  it("decodes an unclosed json block that ends the message", () => {
    const message = `Final:\n\`\`\`json\n${JSON.stringify(review("pass"))}`;
    expect(parse(message)).toMatchObject({ status: "decoded", review: { verdict: "pass" } });
  });

  it("returns none without a json block", () => {
    expect(parse("The review passed; no findings.")).toEqual({ status: "none" });
    expect(parse(fenced(JSON.stringify(review("pass")), "ts"))).toEqual({ status: "none" });
    expect(parse(`Inline \`${JSON.stringify(review("pass"))}\` only.`)).toEqual({
      status: "none",
    });
  });

  it("reports invalid JSON as a bounded decode failure", () => {
    const result = parse(fenced(`{"verdict": "pass", ${"x".repeat(5000)}`));
    expect(result).toMatchObject({ status: "decode_failed" });
    if (result === "threw" || result.status !== "decode_failed") return;
    expect(result.message).toMatch(/^The last json block is not valid JSON/);
    expect(result.message.length).toBeLessThanOrEqual(1000);
  });

  it("reports a wrong verdict literal as a bounded decode failure", () => {
    const result = parse(fenced(JSON.stringify(review(`approve${"!".repeat(5000)}`))));
    expect(result).toMatchObject({ status: "decode_failed" });
    if (result === "threw" || result.status !== "decode_failed") return;
    expect(result.message).toMatch(/^The last json block is not a valid review/);
    expect(result.message).toContain('["verdict"]');
    expect(result.message).not.toContain("approve");
    expect(result.message.length).toBeLessThanOrEqual(1000);
  });

  it("reports every schema issue, still bounded", () => {
    const issues = {
      ...review("approve"),
      findings: Array.from({ length: 100 }, (_, index) => ({ id: `f${index}` })),
    };
    const result = parse(fenced(JSON.stringify(issues)));
    expect(result).toMatchObject({ status: "decode_failed" });
    if (result === "threw" || result.status !== "decode_failed") return;
    expect(result.message).toContain('["verdict"]');
    expect(result.message).toContain('["findings"][0]["severity"]');
    expect(result.message.length).toBeLessThanOrEqual(1000);
  });

  it("reports a json block that is not an object as a decode failure", () => {
    expect(parse(fenced("null"))).toMatchObject({ status: "decode_failed" });
    expect(parse(fenced(""))).toMatchObject({ status: "decode_failed" });
  });
});
