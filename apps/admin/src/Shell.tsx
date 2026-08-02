import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Button, Logo } from '@snpos/ui';
import { useSession } from './session';

interface NavLinkDef { to: string; label: string; end?: boolean }

const NAV: { group: string; links: NavLinkDef[] }[] = [
  {
    group: 'Overview',
    links: [
      { to: '/', label: 'Dashboard', end: true },
      { to: '/reports', label: 'Reports' },
    ],
  },
  {
    group: 'Menu',
    links: [
      { to: '/menu/categories', label: 'Categories' },
      { to: '/menu/items', label: 'Dishes & drinks' },
      { to: '/menu/options', label: 'Options' },
    ],
  },
  {
    group: 'Money',
    links: [
      { to: '/shifts', label: 'Shifts' },
      { to: '/expenses', label: 'Expenses' },
    ],
  },
  {
    group: 'Kitchen',
    links: [
      { to: '/stations', label: 'Stations' },
      { to: '/stock', label: 'Stock' },
      { to: '/waste', label: 'Waste' },
    ],
  },
  {
    group: 'Setup',
    links: [
      { to: '/venues', label: 'Venues' },
      { to: '/tables', label: 'Tables & QR' },
      { to: '/staff', label: 'Staff' },
      { to: '/features', label: 'Features' },
      { to: '/settings', label: 'Settings' },
    ],
  },
  { group: 'You', links: [{ to: '/account', label: 'Your account' }, { to: '/help', label: 'Help' }] },
];

export function Shell({ children }: { children: ReactNode }) {
  const { settings, profile, user, signOut } = useSession();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Logo size={24} />
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
          <NavLink to="/account" style={{ fontWeight: 600, display: 'block', padding: 0 }}>
            {profile?.display_name ?? user?.name ?? 'Signed in'}
          </NavLink>
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
