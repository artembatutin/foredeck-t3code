import { describe, expect, it } from "vite-plus/test";

import { failureFingerprint } from "./fingerprint.ts";

const tree = "c".repeat(40);
const otherTree = "d".repeat(40);
const tail = "FAIL src/export.test.ts > exports a header row\nexpected 1 to be 2";

const verify = (logTail: string, onTree = tree) =>
  failureFingerprint({ stage: "verify", tail: logTail, tree: onTree });

const emptyTable = { id: "empty-table", detail: "An empty table exports no header row." };
const quoting = { id: "quoting", detail: "Cells with commas are not quoted." };
const review = (
  findings: ReadonlyArray<{ readonly id: string; readonly detail: string }>,
  onTree = tree,
) => failureFingerprint({ stage: "review", findings, tree: onTree });

describe("failureFingerprint", () => {
  it("hashes the same failure on the same tree to the same sha-256", () => {
    expect(verify(tail)).toBe(verify(tail));
    expect(review([emptyTable, quoting])).toBe(review([emptyTable, quoting]));
    expect(verify(tail)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tells a verify failure on another tree apart", () => {
    expect(verify(tail, otherTree)).not.toBe(verify(tail));
  });

  it("tells another log tail apart", () => {
    expect(verify(`${tail}\n1 test failed`)).not.toBe(verify(tail));
    expect(verify("")).not.toBe(verify(tail));
  });

  it("tells a review on another tree apart", () => {
    expect(review([emptyTable], otherTree)).not.toBe(review([emptyTable]));
  });

  it.each([
    ["another finding id", [{ ...emptyTable, id: "empty-rows" }]],
    ["another detail", [{ ...emptyTable, detail: "The header row is missing." }]],
    ["one more finding", [emptyTable, quoting]],
    ["no findings", []],
  ] as const)("tells a review with %s apart", (_, findings) => {
    expect(review(findings)).not.toBe(review([emptyTable]));
  });

  it("ignores the order a review lists its findings in", () => {
    expect(review([quoting, emptyTable])).toBe(review([emptyTable, quoting]));
  });

  it("tells the stages apart", () => {
    expect(failureFingerprint({ stage: "review", findings: [], tree })).not.toBe(verify("[]"));
  });
});
