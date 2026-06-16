import localFont from 'next/font/local';

/**
 * Discreetly typography, ported from the original frontend:
 *  - body / UI  -> Space Grotesk (variable)
 *  - display / headings / buttons -> Nippo (variable)
 *  - monospace  -> Space Mono
 *
 * Each exposes a CSS variable consumed by tailwind.config fontFamily.
 */

export const fontSans = localFont({
  src: '../fonts/SpaceGrotesk-Variable.ttf',
  variable: '--font-sans',
  weight: '300 700',
  display: 'swap',
});

export const fontDisplay = localFont({
  src: '../fonts/Nippo-Variable.ttf',
  variable: '--font-display',
  weight: '200 700',
  display: 'swap',
});

export const fontMono = localFont({
  src: [
    { path: '../fonts/SpaceMono-Regular.ttf', weight: '400', style: 'normal' },
    { path: '../fonts/SpaceMono-Bold.ttf', weight: '700', style: 'normal' },
  ],
  variable: '--font-mono',
  display: 'swap',
});
