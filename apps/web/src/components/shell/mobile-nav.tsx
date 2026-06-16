'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { isNavActive, navItems } from './nav-items';
import { useIsAdmin } from './use-is-admin';

/** Bottom tab bar (mobile). Replaces the rail below the md breakpoint. */
export function MobileNav() {
  const pathname = usePathname();
  const isAdmin = useIsAdmin();
  const items = navItems.filter((item) => !item.adminOnly || isAdmin);

  return (
    <nav
      aria-label="Primary"
      className="flex shrink-0 border-t border-border bg-[hsl(180_6%_9%)] md:hidden"
    >
      {items.map((item) => {
        const active = isNavActive(pathname, item);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex flex-1 flex-col items-center justify-center gap-1 py-2.5 text-[0.65rem] font-display uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground',
              active && 'text-primary',
            )}
          >
            <item.Icon className="h-5 w-5" />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
