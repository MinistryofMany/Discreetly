/**
 * Per-browser-session display color and deterministic identicon generation.
 *
 * `sessionColor` is generated once per browser session (persisted in
 * sessionStorage so a reload keeps it but a new tab/session gets a fresh one)
 * and attached to each `message.send` so a recipient can visually group a
 * sender's messages WITHIN an epoch without any cross-epoch linkability.
 */

const SESSION_COLOR_KEY = 'discreetly.sessionColor.v1';

function randomColor(): string {
  // Pleasant, readable HSL-derived hex: fixed-ish saturation/lightness, random hue.
  const hue = Math.floor(Math.random() * 360);
  return hslToHex(hue, 65, 50);
}

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sN * Math.min(lN, 1 - lN);
  const f = (n: number) => {
    const color = lN - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Get (or lazily create) the per-session color. Falls back to a fresh value off-DOM. */
export function getSessionColor(): string {
  if (typeof sessionStorage === 'undefined') return randomColor();
  const existing = sessionStorage.getItem(SESSION_COLOR_KEY);
  if (existing) return existing;
  const color = randomColor();
  sessionStorage.setItem(SESSION_COLOR_KEY, color);
  return color;
}

/** Deterministic 32-bit FNV-1a hash of a string seed. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Generate a deterministic 5x5 mirrored identicon as an inline SVG data URI from
 * a seed (e.g. the message's sessionColor or a commitment). Pure + no deps so it
 * renders identically in tests and the browser.
 */
export function identiconDataUri(seed: string, fg?: string): string {
  const h = hashSeed(seed);
  const hue = h % 360;
  const color = fg ?? hslToHex(hue, 60, 45);
  const cells: string[] = [];
  // 3 columns (mirrored to 5), 5 rows = 15 bits drawn from the hash.
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      const bit = (h >> (row * 3 + col)) & 1;
      if (bit) {
        cells.push(rect(col, row));
        if (col < 2) cells.push(rect(4 - col, row));
      }
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" shape-rendering="crispEdges">` +
    `<rect width="5" height="5" fill="#ffffff"/>` +
    `<g fill="${color}">${cells.join('')}</g>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function rect(x: number, y: number): string {
  return `<rect x="${x}" y="${y}" width="1" height="1"/>`;
}
