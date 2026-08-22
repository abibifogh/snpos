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

  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 820px)');
    const seen = () => setNarrow(mq.matches);
    mq.addEventListener('change', seen);
    return () => mq.removeEventListener('change', seen);
  }, []);

  /**
   * On a phone the navigation is a drawer, not a wall.
   *
   * It used to lay every section out as a wrapping row of links above the
   * page. With thirty-nine of them that is most of a phone screen spent on
   * navigation before a word of the actual page — and because the block is a
   * different height on every screen and reflows as it loads, the content
   * under it moved each time somebody navigated. That is the whole of "the
   * tabs are scattered and the page will not sit still".
   *
   * So it is put away behind a button and comes over the page when asked for.
   * The page below it then starts in the same place every time, which is the
   * property that was actually missing.
   */
  const [drawer, setDrawer] = useState(false);

  /*
    Closed by going somewhere. A drawer that stays open over the page you
    just asked for makes somebody close it every single time.
  */
  useEffect(() => { setDrawer(false); }, [path]);

  /*
    Escape closes it, and while it is open the page behind does not scroll.
    Scrolling the thing underneath a drawer loses your place in both.
  */
  useEffect(() => {
    if (!drawer) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    window.addEventListener('keydown', onKey);
    const had = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = had;
    };
  }, [drawer]);

  /** What to put in the bar, so somebody knows where they are with it shut. */
  const hereLabel = sections.find((sec) => (sec.path === '/' ? path === '/' : path.startsWith(sec.path)))?.label
    ?? 'Admin';

  return (
    <div className={`shell${drawer ? ' drawer-open' : ''}`}>
      {/* Only on a phone; the sidebar is always there on a wide screen and a
          button to reveal what is already visible is a button that confuses. */}
      {narrow && (
        <header className="topbar">
          <Button
            size="sm"
            onClick={() => setDrawer(true)}
            aria-expanded={drawer}
            aria-controls="admin-nav"
          >
            ☰ Menu
          </Button>
          <span className="topbar-here">{hereLabel}</span>
          <Logo size={22} />
        </header>
      )}
      {/* Tapping beside the drawer closes it, which is what everybody tries
          first. Rendered only while open so it can never swallow a tap on the
          page underneath. */}
      {narrow && drawer && (
        <button
          type="button"
          className="drawer-scrim"
          aria-label="Close the menu"
          onClick={() => setDrawer(false)}
        />
      )}
      <aside className="sidebar" id="admin-nav">
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
              /* Open where you are standing, folded elsewhere — on a phone
                 too, now that the drawer is a column with room to scroll
                 rather than a row squeezed above the page. Forcing all of
                 them open was only ever a way to keep a flat row navigable. */
              <details key={section.group} className="nav-group" open={here}>
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
