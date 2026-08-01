import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Button } from '@snpos/ui';
import { useSession } from './session';

interface NavLinkDef { to: string; label: string; end?: boolean }

const NAV: { group: string; links: NavLinkDef[] }[] = [
  { group: 'Overview', links: [{ to: '/', label: 'Dashboard', end: true }] },
  {
    group: 'Menu',
    links: [
      { to: '/menu/categories', label: 'Categories' },
      { to: '/menu/items', label: 'Dishes & drinks' },
    ],
  },
  {
    group: 'Setup',
    links: [
      { to: '/venues', label: 'Venues' },
      { to: '/features', label: 'Features' },
      { to: '/settings', label: 'Settings' },
    ],
  },
];

export function Shell({ children }: { children: ReactNode }) {
  const { settings, profile, user, signOut } = useSession();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="dot" />
          <span>{settings?.restaurant_name ?? 'SNPOS'}</span>
        </div>
        <nav>
          {NAV.map((section) => (
            <div key={section.group}>
              <div className="group">{section.group}</div>
              {section.links.map((l) => (
                <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? 'active' : '')}>
                  {l.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div style={{ fontWeight: 600 }}>{profile?.display_name ?? user?.name ?? 'Signed in'}</div>
          <div className="dim small" style={{ marginBottom: '0.5rem' }}>{profile?.role ?? 'no staff profile'}</div>
          <Button size="sm" variant="ghost" onClick={signOut}>Sign out</Button>
        </div>
      </aside>
      <div className="main">
        <div className="page">{children}</div>
      </div>
    </div>
  );
}
