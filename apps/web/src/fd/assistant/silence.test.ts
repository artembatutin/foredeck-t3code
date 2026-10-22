import { expect, it } from "vite-plus/test";
import { silenceDetector } from "./silence";

it("keeps word gaps and quiet starts, then finishes after a natural pause", () => {
  const ended = silenceDetector(0);
  expect(ended(0, 1_000)).toBe(false);
  expect(ended(0.1, 2_000)).toBe(false);
  expect(ended(0, 2_800)).toBe(false);
  expect(ended(0.1, 3_000)).toBe(false);
  expect(ended(0, 4_199)).toBe(false);
  expect(ended(0, 4_200)).toBe(true);
});
it("releases a silent microphone after ten seconds", () => {
  const ended = silenceDetector(500);
  expect(ended(0, 10_499)).toBe(false);
  expect(ended(0, 10_500)).toBe(true);
});
