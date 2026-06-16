import { AppHeader } from './app-header';
import { AppRail } from './app-rail';
import { MobileNav } from './mobile-nav';

/**
 * App chrome ported from the original frontend: a sticky top AppBar, a left
 * icon rail on desktop, a bottom tab bar on mobile, and a single scrolling
 * main region in between.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <AppHeader />
      <div className="flex min-h-0 flex-1">
        <AppRail />
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      <MobileNav />
    </div>
  );
}
