/** Visible product identity only; runtime and distribution identifiers stay upstream-owned. */
export const FOREDECK_PRODUCT_NAME = "foredeck-t3";
export const FOREDECK_WORDMARK = FOREDECK_PRODUCT_NAME;

/**
 * Reused without geometry changes from Foredeck's archived
 * docs/design/reference/assets/desktop-icon/brandmark.svg.
 * The original source notice is retained below. No font or provider assets are copied.
 */
export const FOREDECK_ANCHOR_CONTENT = `
  <!-- Foredeck brand mark: solid classic anchor. Monochrome via currentColor; the
       brand gradient is reserved for the app-icon tile (see appicon.source.html). -->
  <circle cx="50" cy="15" r="7" stroke="currentColor" stroke-width="4.4"/>
  <line x1="32.5" y1="30.5" x2="67.5" y2="30.5" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>
  <circle cx="32.5" cy="30.5" r="2.9" fill="currentColor"/>
  <circle cx="67.5" cy="30.5" r="2.9" fill="currentColor"/>
  <path d="M47.2 20 L52.8 20 L55.5 76 L50 87.5 L44.5 76 Z" fill="currentColor"/>
  <path d="M50 85.5 C38 83.5 26.5 76.5 21.5 67 L14.5 49 L28 58 L26 65 C34 73.5 43 75 47.5 75 L52.5 75 C57 75 66 73.5 74 65 L72 58 L85.5 49 L78.5 67 C73.5 76.5 62 83.5 50 85.5 Z" fill="currentColor"/>
`;

export const FOREDECK_ANCHOR_SVG = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" fill="none" aria-hidden="true">${FOREDECK_ANCHOR_CONTENT}</svg>`;
