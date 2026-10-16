import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import sharp from "sharp";
import { encodePngIco, WINDOWS_ICON_SIZES } from "../../lib/icon-export.ts";

const root = NodePath.resolve(import.meta.dirname, "../../..");
const source = await NodeFSP.readFile(
  NodePath.join(root, "assets/fd/branding/appicon.source.html"),
  "utf8",
);
const tile = source.match(/<svg id="tile"[^>]*>([\s\S]*?)<\/svg>/)?.[1];
const definitions = tile?.match(/<defs>([\s\S]*?)<\/defs>/)?.[1];
const anchor = tile?.match(/<g transform="[^"]*">([\s\S]*?)<\/g>/)?.[1];
if (!tile || !definitions || !anchor) throw new Error("Foredeck icon source structure changed.");

const svg = (body: string, viewBox = "0 0 100 100") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;
const background = '<rect width="100" height="100" fill="url(#tile-grad)"/>';
const glyph = (scale: number, centerY = 50, monochrome = false) =>
  `<g transform="translate(50 50) scale(${scale}) translate(-50 -${centerY})">${
    monochrome ? anchor.replaceAll("url(#brand-stroke)", "#ffffff") : anchor
  }</g>`;
const artwork = (body: string) => svg(`<defs>${definitions}</defs>${body}`);
const render = (sourceSvg: string, size: number) =>
  sharp(Buffer.from(sourceSvg)).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

const generated = new Map<string, Buffer>();
const emit = async (path: string, artwork: string, size: number) => {
  const buffer = await render(artwork, size);
  generated.set(path, buffer);
  return buffer;
};
const assets = "assets/fd/branding";
const mobile = "apps/mobile/assets/fd/branding";
const rounded = svg(tile);
await emit(`${assets}/appicon.png`, rounded, 1024);
// Preserve the original desktop's 824px tile, centered inside a 1024px transparent canvas.
await emit(
  `${assets}/appicon-macos.png`,
  svg(
    `<svg x="100" y="100" width="824" height="824" viewBox="0 0 100 100">${tile}</svg>`,
    "0 0 1024 1024",
  ),
  1024,
);
await emit(`${assets}/appicon-ios.png`, artwork(background + glyph(0.78)), 1024);
await emit(`${assets}/apple-touch-icon.png`, artwork(background + glyph(0.78)), 180);
await emit(`${assets}/favicon-16x16.png`, rounded, 16);
await emit(`${assets}/favicon-32x32.png`, rounded, 32);
generated.set(
  `${assets}/icon.ico`,
  encodePngIco(
    await Promise.all(
      WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await render(rounded, size) })),
    ),
  ),
);

// Android applies its own outer mask. Keep the anchor inside the central 66dp safe zone.
await emit(`${mobile}/android-foreground.png`, artwork(glyph(0.63, 46.65)), 432);
await emit(`${mobile}/android-background.png`, artwork(background), 432);
await emit(`${mobile}/android-monochrome.png`, artwork(glyph(0.63, 46.65, true)), 432);
await emit(`${mobile}/android-notification.png`, artwork(glyph(0.95, 46.65, true)), 96);
await emit(`${mobile}/android-splash.png`, artwork(background + glyph(0.63, 46.65)), 1152);

for (const name of [
  "favicon-16x16.png",
  "favicon-32x32.png",
  "apple-touch-icon.png",
  "favicon.ico",
]) {
  generated.set(
    `apps/web/public/${name}`,
    generated.get(`${assets}/${name === "favicon.ico" ? "icon.ico" : name}`)!,
  );
}
generated.set("apps/web/public/fd/branding/appicon.png", generated.get(`${assets}/appicon.png`)!);

const check = NodeProcess.argv.includes("--check");
for (const [relative, expected] of generated) {
  const path = NodePath.join(root, relative);
  if (check) {
    const actual = await NodeFSP.readFile(path);
    if (!actual.equals(expected)) throw new Error(`Stale Foredeck icon: ${relative}`);
  } else {
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, expected);
  }
}
console.log(`${check ? "Verified" : "Generated"} ${generated.size} Foredeck icon assets.`);
