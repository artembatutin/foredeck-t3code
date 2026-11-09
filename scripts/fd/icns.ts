import sharp from "sharp";

/**
 * A macOS icon written from one PNG with the accepted lock's pinned `sharp`, for a UX preview
 * build whose `iconutil` fails: the same PNG renditions `iconutil` packs from an iconset, in the
 * ICNS container, checked before the build uses it.
 */

/** Each ICNS type with the pixel size of the PNG it holds, as `iconutil` writes an iconset. */
export const ICNS_PNG_TYPES = [
  ["icp4", 16],
  ["icp5", 32],
  ["ic11", 32],
  ["ic12", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic13", 256],
  ["ic09", 512],
  ["ic14", 512],
  ["ic10", 1024],
] as const;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Packs PNG renditions, by ICNS type, into an ICNS file. */
export function packIcns(renditions: ReadonlyArray<readonly [string, Buffer]>): Buffer {
  const entries = renditions.map(([type, png]) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, "latin1");
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const body = Buffer.concat(entries);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "latin1");
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

/** Renders `sourcePng` at every size an app icon needs and packs it. */
export async function convertPngToIcns(sourcePng: string): Promise<Buffer> {
  const renditions: Array<readonly [string, Buffer]> = [];
  for (const [type, size] of ICNS_PNG_TYPES) {
    renditions.push([type, await sharp(sourcePng).resize(size, size).png().toBuffer()]);
  }
  return packIcns(renditions);
}

/**
 * What is wrong with an ICNS file, judged from its bytes: its header and length, and every
 * expected type present once holding a PNG of that type's size. Empty when it is a valid icon.
 */
export function icnsProblems(icns: Uint8Array): ReadonlyArray<string> {
  const bytes = Buffer.from(icns.buffer, icns.byteOffset, icns.byteLength);
  if (bytes.length < 8 || bytes.toString("latin1", 0, 4) !== "icns") return ["not an ICNS file"];
  if (bytes.readUInt32BE(4) !== bytes.length) return ["its length is not the file's"];
  const found = new Map<string, number>();
  const problems: Array<string> = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 8 > bytes.length) return ["it ends inside an entry header"];
    const type = bytes.toString("latin1", offset, offset + 4);
    const length = bytes.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > bytes.length) return [`${type} runs past the file`];
    const data = bytes.subarray(offset + 8, offset + length);
    const expected = ICNS_PNG_TYPES.find(([name]) => name === type)?.[1];
    if (expected !== undefined) {
      found.set(type, (found.get(type) ?? 0) + 1);
      const isPng = data.length >= 24 && data.subarray(0, 8).equals(PNG_SIGNATURE);
      if (!isPng) problems.push(`${type} holds no PNG`);
      else if (data.readUInt32BE(16) !== expected || data.readUInt32BE(20) !== expected) {
        problems.push(`${type} is not ${expected}x${expected}`);
      }
    }
    offset += length;
  }
  for (const [type] of ICNS_PNG_TYPES) {
    const count = found.get(type) ?? 0;
    if (count !== 1)
      problems.push(count === 0 ? `${type} is missing` : `${type} appears ${count} times`);
  }
  return problems;
}
