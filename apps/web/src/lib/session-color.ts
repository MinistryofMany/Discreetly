/**
 * Per-browser-session display color, friendly handle, and deterministic avatar.
 *
 * `sessionColor` is generated once per browser session (persisted in
 * sessionStorage so a reload keeps it but a new tab/session gets a fresh one)
 * and attached to each `message.send` so a recipient can visually group a
 * sender's messages WITHIN an epoch without any cross-epoch linkability.
 *
 * DISPLAY ONLY. This color/handle/avatar are cosmetic and are derived from the
 * ephemeral per-session `sessionColor`, NEVER from the Semaphore identity
 * secret / membership commitment / RLN nullifier. Rotating them per session
 * therefore has no effect on room membership or anonymity. Because the seed
 * lives in sessionStorage (cleared when the tab/session closes), it is
 * ephemeral and cannot serve as a persistent cross-session linkage identifier.
 */
import { createAvatar } from '@dicebear/core';
import { rings } from '@dicebear/collection';

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

// Inline word lists for the friendly {Adjective}{Noun} display name. Kept small,
// PascalCase, and dependency-free so the name is deterministic in tests and the
// browser alike. ~40 of each -> ~1600 combinations.
const ADJECTIVES = [
  'Captain',
  'Professor',
  'Sneaky',
  'Brave',
  'Cosmic',
  'Grumpy',
  'Jolly',
  'Mellow',
  'Nimble',
  'Plucky',
  'Quiet',
  'Rowdy',
  'Silly',
  'Turbo',
  'Velvet',
  'Wobbly',
  'Zesty',
  'Fuzzy',
  'Gentle',
  'Hasty',
  'Icy',
  'Lucky',
  'Merry',
  'Noble',
  'Odd',
  'Peppy',
  'Rusty',
  'Salty',
  'Tiny',
  'Witty',
  'Amber',
  'Breezy',
  'Crimson',
  'Dizzy',
  'Electric',
  'Feral',
  'Golden',
  'Humble',
  'Jazzy',
  'Kooky',
];

const NOUNS = [
  'Cardboard',
  'Shrimp',
  'Cup',
  'Otter',
  'Comet',
  'Waffle',
  'Pickle',
  'Badger',
  'Lantern',
  'Muffin',
  'Narwhal',
  'Pebble',
  'Quokka',
  'Raccoon',
  'Sprocket',
  'Turnip',
  'Umbrella',
  'Walrus',
  'Yeti',
  'Zeppelin',
  'Acorn',
  'Biscuit',
  'Cactus',
  'Doodle',
  'Ferret',
  'Gadget',
  'Hedgehog',
  'Iguana',
  'Jellybean',
  'Kettle',
  'Llama',
  'Mango',
  'Noodle',
  'Octopus',
  'Penguin',
  'Quill',
  'Robot',
  'Sparrow',
  'Toucan',
  'Vulture',
];

/**
 * Stable, friendly per-session display name derived from the same seed as the
 * identicon (the message's sessionColor, falling back to its id), e.g.
 * "CaptainCardboard". Messages from one sender within an epoch share a
 * sessionColor, so they share a name - readable grouping without any
 * cross-epoch linkability beyond what sessionColor already provides.
 */
export function sessionHandle(seed: string): string {
  const h = hashSeed(seed);
  const adj = ADJECTIVES[h % ADJECTIVES.length]!;
  const noun = NOUNS[Math.floor(h / ADJECTIVES.length) % NOUNS.length]!;
  return `${adj}${noun}`;
}

// Memo cache: DiceBear output is deterministic per seed, and the chat feed
// re-renders a row on every message, so cache the generated data URI to avoid
// re-running the generator for a seed we have already rendered.
const avatarCache = new Map<string, string>();

/**
 * Deterministic Dicebear "Rings" avatar rendered as an inline SVG data URI,
 * seeded by the ephemeral per-session value (the message's `sessionColor`,
 * falling back to its id). Same seed -> byte-identical avatar in the browser
 * and in tests, so a sender's messages within an epoch share one avatar. The
 * seed is display-only and carries no link to the Semaphore/RLN identity.
 */
export function avatarDataUri(seed: string): string {
  const cached = avatarCache.get(seed);
  if (cached !== undefined) return cached;
  const uri = createAvatar(rings, { seed }).toDataUri();
  avatarCache.set(seed, uri);
  return uri;
}
