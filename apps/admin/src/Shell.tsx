import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Button, Logo, THEME_MODES, themeMode, setThemeMode } from '@snpos/ui';
import { sectionsFor, wordsFor } from '@snpos/core';
import { useSession } from './session';

export function Shell({ children }: { children: ReactNode }) {
  const { settings, profile, user, signOut } = useSession();
  const path = useLocation().pathname;

  // The navigation is built from what this person may actually open, not from
  // a fixed list with some entries hidden. One source, so a link can never
  // appear for a page the router will refuse.
  const sections = sectionsFor(profile, settings);
  // A shop assistant hunting for "Dishes & drinks" to add a woven basket is
  // being asked to translate, every time. One map decides what things are
  // called; everything else about the page is the same.
  const words = wordsFor(settings);
  const groups: { group: string; links: { to: string; label: string; end?: boolean }[] }[] = [];
  for (const s of sections) {
    const group = words[s.group] ?? s.group;
    const existing = groups.find((g) => g.group === group);
    const link = { to: s.path, label: words[s.key] ?? s.label, end: s.path === '/' };
    if (existing) existing.links.push(link);
    else groups.push({ group, links: [link] });
  }
  groups.push({ group: 'You', links: [{ to: '/account', label: 'Your account' }, { to: '/help', label: 'Help' }] });

  /**
   * A phone has no room to fold, and folding there hid things for good.
   *
   * On a narrow screen the sidebar becomes a wrapping row of links and the
   * group headings are hidden to keep it compact — which left every group but
   * the current one closed, with the only control for opening them not on the
   * screen. Half the app was unreachable from a phone.
   */
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 820px)');
    const seen = () => setNarrow(mq.matches);
    mq.addEventListener('change', seen);
    return () => mq.removeEventListener('change', seen);
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Logo size={24} />
          <span>{settings?.restaurant_name ?? 'NiceOps POS'}</span>
        </div>
        <nav>
          {groups.map((section) => {
            /**
             * Folded, except the one you are standing in.
             *
             * Two trades running side by side is around twenty links, and a
             * column that long means scrolling past nine things you are not
             * doing to reach the one you are. Closed by default keeps the whole
             * shape of the app visible at once; the group holding the current
             * page opens itself, so nothing is ever hidden from somebody who is
             * already there.
             *
             * The browser remembers nothing here on purpose, this reopens from
             * where you actually are on every load, which is more useful than
             * restoring whatever was open last Tuesday.
             */
            const here = section.links.some((l) =>
              l.end ? path === l.to : path === l.to || path.startsWith(`${l.to}/`),
            );
            return (
              <details key={section.group} className="nav-group" open={here || narrow}>
                <summary className="group">
                  <span className="fold-caret" aria-hidden="true" />
                  {section.group}
                </summary>
                {section.links.map((l) => (
                  <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? 'active' : '')}>
                    {l.label}
                  </NavLink>
                ))}
              </details>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <NavLink to="/account" style={{ fontWeight: 600, display: 'block', padding: 0 }}>
            {profile?.display_name ?? user?.name ?? 'Signed in'}
          </NavLink>
          <div className="dim small" style={{ marginBottom: '0.5rem' }}>{profile?.role ?? 'no staff profile'}</div>
          <select
            className="theme-pick"
            value={themeMode()}
            onChange={(e) => setThemeMode(e.target.value as ReturnType<typeof themeMode>)}
            aria-label="Appearance"
          >
            {THEME_MODES.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
          </select>
          <Button size="sm" variant="ghost" onClick={signOut}>Sign out</Button>
        </div>
      </aside>
      <div className="main">
        <div className="page">{children}</div>
      </div>
    </div>
  );
}
