/**
 * App footer. Carries the standardized "Alpha · <build date>" tag, where the
 * date is injected at build time via `NEXT_PUBLIC_BUILD_DATE` (see
 * `next.config.mjs`), so a deployed image reports the day it was built. Desktop
 * only - on mobile the bottom tab bar (`MobileNav`) occupies this space.
 */
export function AppFooter() {
  return (
    <footer className="hidden shrink-0 items-center justify-center border-t border-border bg-[hsl(180_6%_9%)] px-3 py-1.5 md:flex">
      <span className="font-display text-[11px] text-muted-foreground">
        Alpha · {process.env.NEXT_PUBLIC_BUILD_DATE ?? 'dev'}
      </span>
    </footer>
  );
}
