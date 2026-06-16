import type { Metadata, Viewport } from 'next';
import './globals.css';
import { fontDisplay, fontMono, fontSans } from '@/lib/fonts';
import { Providers } from './providers';
import { AppShell } from '@/components/shell/app-shell';

export const metadata: Metadata = {
  title: 'Discreetly',
  description: 'Anonymous, rate-limited chat with verifiable credentials.',
  manifest: '/manifest.json',
};

export const viewport: Viewport = {
  themeColor: '#fa5f5f',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`dark ${fontSans.variable} ${fontDisplay.variable} ${fontMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
