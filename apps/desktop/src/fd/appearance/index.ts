import {
  FOREDECK_DESKTOP_DARK_THEME_COLORS,
  FOREDECK_DESKTOP_LIGHT_THEME_COLORS,
} from "@t3tools/shared/fd/appearance";

export function getForedeckShellColors(shouldUseDarkColors: boolean) {
  return shouldUseDarkColors
    ? FOREDECK_DESKTOP_DARK_THEME_COLORS
    : FOREDECK_DESKTOP_LIGHT_THEME_COLORS;
}

export function getInitialWindowBackgroundColor(shouldUseDarkColors: boolean): string {
  return getForedeckShellColors(shouldUseDarkColors).canvas;
}

/** Self-contained WSL startup surface; needs neither a backend nor bundled assets. */
export function buildConnectingSplashDataUrl(shouldUseDarkColors: boolean): string {
  const colors = getForedeckShellColors(shouldUseDarkColors);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;height:100%}body{background:${colors.canvas};color:${colors.textMuted};font-family:system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;-webkit-user-select:none;user-select:none;-webkit-app-region:drag}.spinner{width:26px;height:26px;border:3px solid ${colors.border};border-top-color:${colors.accent};border-radius:50%;animation:spin .8s linear infinite}.label{font-size:13px}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none}}</style></head><body><div class="spinner" aria-hidden="true"></div><div class="label" role="status">Connecting to WSL…</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
