import type { ComponentType, SVGProps } from 'react';
import { MessageSquare, Mask, Shield } from '@/components/icons';

export type NavItem = {
  href: string;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  exact?: boolean;
  adminOnly?: boolean;
};

/** Primary destinations shown in the rail (desktop) and bottom bar (mobile). */
export const navItems: NavItem[] = [
  { href: '/', label: 'Rooms', Icon: MessageSquare, exact: true },
  { href: '/identity', label: 'Identity', Icon: Mask },
  { href: '/admin', label: 'Admin', Icon: Shield, adminOnly: true },
];

export const GITHUB_URL = 'https://github.com/Discreetly';

export function isNavActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
