# Brand icons

foredeck-t3 uses the Foredeck anchor artwork in `fd/branding/` across all build channels.
Run `vp run icons:export` to regenerate desktop, web, iOS, and Android icons, or
`vp run icons:check` to verify the checked-in assets. See [Foredeck artwork](fd/branding/README.md).
These commands use the checked-in vector artwork and Sharp, without Icon Composer or a browser.

The original T3 Icon Composer projects and their exporters are retained for upstream
compatibility. They are not the active foredeck-t3 artwork. Use the commands above when
updating this fork's icons.
