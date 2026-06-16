'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Github } from '@/components/icons';
import { GITHUB_URL, isNavActive, navItems } from './nav-items';
import { useIsAdmin } from './use-is-admin';

const railAnchor =
  'group relative flex flex-col items-center justify-center gap-1 py-3.5 text-[0.65rem] font-display uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:bg-accent';

/** Left icon rail (desktop). Mirrors the old Skeleton AppRail. */
export function AppRail() {
  const pathname = usePathname();
  const isAdmin = useIsAdmin();
  const items = navItems.filter((item) => !item.adminOnly || isAdmin);

  return (
    <nav
      aria-label="Primary"
      className="hidden w-[4.5rem] shrink-0 flex-col border-r border-border bg-[hsl(180_6%_9%)] md:flex"
    >
      <ul className="flex flex-1 flex-col">
        {items.map((item) => {
          const active = isNavActive(pathname, item);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                title={item.label}
                aria-current={active ? 'page' : undefined}
                className={cn(railAnchor, active && 'text-primary')}
              >
                <span
                  className={cn(
                    'absolute left-0 top-0 h-full w-0.5 bg-primary transition-opacity',
                    active ? 'opacity-100' : 'opacity-0',
                  )}
                />
                <item.Icon className="h-5 w-5" />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col border-t border-border">
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          title="GitHub"
          className={railAnchor}
        >
          <Github className="h-5 w-5" />
          <span>GitHub</span>
        </a>
      </div>
    </nav>
  );
}
