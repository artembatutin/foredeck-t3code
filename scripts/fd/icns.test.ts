import { assert, it } from "vite-plus/test";

import { ICNS_PNG_TYPES, icnsProblems, packIcns } from "./icns.ts";

/** A PNG header claiming `size`x`size`, which is all the validator reads of it. */
const pngOf = (size: number) => {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.write("IHDR", 12, "latin1");
  png.writeUInt32BE(size, 16);
  png.writeUInt32BE(size, 20);
  return png;
};
const complete = () => ICNS_PNG_TYPES.map(([type, size]) => [type, pngOf(size)] as const);

it("accepts an icon holding each rendition once at its size", () => {
  assert.deepStrictEqual(icnsProblems(packIcns(complete())), []);
});

it("names a missing, repeated or wrong-sized rendition and a broken container", () => {
  const renditions = complete();
  assert.deepStrictEqual(icnsProblems(packIcns(renditions.slice(1))), ["icp4 is missing"]);
  assert.deepStrictEqual(icnsProblems(packIcns([...renditions, renditions[0]!])), [
    "icp4 appears 2 times",
  ]);
  assert.deepStrictEqual(
    icnsProblems(
      packIcns(renditions.map(([type, png]) => [type, type === "ic10" ? pngOf(512) : png])),
    ),
    ["ic10 is not 1024x1024"],
  );
  assert.deepStrictEqual(
    icnsProblems(
      packIcns(
        renditions.map(([type, png]) => [type, type === "ic07" ? Buffer.from("jpeg") : png]),
      ),
    ),
    ["ic07 holds no PNG"],
  );
  const truncated = packIcns(renditions).subarray(0, 100);
  assert.deepStrictEqual(icnsProblems(truncated), ["its length is not the file's"]);
  assert.deepStrictEqual(icnsProblems(Buffer.from("not an icon")), ["not an ICNS file"]);
});
