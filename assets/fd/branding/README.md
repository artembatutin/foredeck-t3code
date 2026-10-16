# Foredeck icons

`appicon.source.html` preserves the Foredeck anchor, silver gradient, and dark tile
from the archived `foredeck/docs/design/reference/assets/desktop-icon/` artwork.
It is the source for the foredeck-t3 application icons on every build channel.

Run `vp run icons:export` after editing the vector source. The fork exporter in
`scripts/fd/branding/export-icons.ts` renders it with the existing Sharp dependency;
`vp run icons:check` verifies all generated files byte for byte.

The macOS rendition retains the original 824px tile inset 100px in a transparent
1024px canvas. iOS uses an opaque full-bleed rendition for the system mask. Android
uses a separate full-bleed background and transparent foreground inside its 66dp
safe zone, with flat white silhouettes for themed icons and notifications. Web and
Windows icons include small renditions rather than relying on launcher-size images.
