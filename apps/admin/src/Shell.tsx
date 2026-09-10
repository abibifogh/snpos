import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Button, Logo, SchemaBar, Segmented, THEME_MODES, themeMode, setThemeMode } from '@snpos/ui';
import { navFor, wordsFor, sidebarSides, SIDE_NAMES } from '@snpos/core';
import type { Module } from '@snpos/core';
import { useSession } from './session';

export function Shell({ children }: { children: ReactNode }) {
  const { settings, profile, user, signOut } = useSession();
  const path = useLocation().pathname;

  /**
   * Which side of the business the sidebar is narrowed to.
   *
   * Remembered on this device. A bartender who picks Bar on Monday should
   * find the bar on Tuesday; an owner who wants everything picks All once.
   */
  const [side, setSide] = useState<Module | 'all'>(() => {
    try {
      const saved = window.localStorage.getItem('admin.side');
      return saved === 'kitchen' || saved === 'bar' || saved === 'craft' ? saved : 'all';
    } catch { return 'all'; }
  });
  const pickSide = (s: Module | 'all') => {
    setSide(s);
    try { window.localStorage.setItem('admin.side', s); } catch { /* a private window forgets; fine */ }
  };
  const sides = sidebarSides(profile, settings);
  // A side that stopped running, or that this person no longer works on, is
  // not a filter: it would hide everything and explain nothing.
  const filter: Module | 'all' = side !== 'all' && sides.includes(side) ? side : 'all';

  // The navigation is built from what this person may actually open, not from
  // a fixed list with some entries hidden. One source, so a link can never
  // appear for a page the router will refuse. Grouped by the job somebody is
  // doing, with the per-side pages folded into one link each; see navFor.
  const words = wordsFor(settings);
  const groups = navFor(profile, settings, filter).map((g) => ({
    group: words[g.group] ?? g.group,
    links: g.links.map((l) => ({ ...l, label: words[l.keys[0]] ?? l.label })),
  }));
  groups.push({ group: 'You', links: [{ to: '/account', label: 'Your account', keys: [] }, { to: '/help', label: 'Help', keys: [] }] });

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
  const bare = (to: string) => to.split('?')[0];
  const hereLabel = groups.flatMap((g) => g.links)
    .find((l) => (l.end ? path === '/' : path === bare(l.to) || path.startsWith(`${bare(l.to)}/`)))?.label
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
          {/* One side at a time, for somebody who works on one. Only offered
              where there is more than one to choose between. */}
          {sides.length > 1 && (
            <div className="side-pick">
              <Segmented<Module | 'all'>
                value={filter}
                onChange={pickSide}
                ariaLabel="Which side of the business"
                options={[{ value: 'all', label: 'All' }, ...sides.map((m) => ({ value: m, label: SIDE_NAMES[m] }))]}
              />
            </div>
          )}
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
              l.end ? path === '/' : path === bare(l.to) || path.startsWith(`${bare(l.to)}/`),
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
        {/* Across the top of every page, for the person who can fix it. */}
        <SchemaBar settings={settings} owner={profile?.role === 'admin'} />
        <div className="page">{children}</div>
      </div>
    </div>
  );
}
