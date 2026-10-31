import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Button, SchemaBar, StaleBar, Segmented, THEME_MODES, themeMode, setThemeMode } from '@snpos/ui';
import { navFor, wordsFor, sidebarSides, SIDE_NAMES, loadWaiting, pendingGroupBookings, openBookingChanges, PRODUCT_NAME, pageTitle } from '@snpos/core';
import type { Module } from '@snpos/core';
import { useSession } from './session';

/* One drawing per icon on the rail, on a 24-unit grid, stroked in the text colour. */
const ICONS: Record<string, ReactNode> = {
  Today: <><path d="M4 11.5 12 5l8 6.5V20H4z" /><path d="M9.5 20v-5h5v5" /></>,
  Approvals: <><circle cx="12" cy="12" r="8.5" /><path d="m8.3 12.3 2.5 2.5 5-5.3" /></>,
  Sell: <><path d="M4 8.5h16l-1.4 10.2a2 2 0 0 1-2 1.8H7.4a2 2 0 0 1-2-1.8z" /><path d="M8.8 8.5V6.6a3.2 3.2 0 0 1 6.4 0v1.9" /></>,
  Stock: <><path d="M3.5 8 12 3.8 20.5 8v8L12 20.2 3.5 16z" /><path d="M3.5 8 12 12.2 20.5 8M12 12.2v8" /></>,
  Money: <><rect x="3" y="6" width="18" height="13" rx="3" /><path d="M3 10h18M16 14.5h2" /></>,
  Books: <path d="M4 20V13M9.3 20V5M14.7 20v-8M20 20V9" />,
  Setup: <><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6" /></>,
  More: <><circle cx="5.5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="18.5" cy="12" r="1.3" /></>,
  You: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>,
};
const Icon = ({ name }: { name: string }) => (
  <svg className="nav-ico" viewBox="0 0 24 24" aria-hidden="true">{ICONS[name] ?? ICONS.More}</svg>
);

/** How many icons fit along the bottom of a phone before the rest go under More. */
const BAR_SLOTS = 4;

export function Shell({ children }: { children: ReactNode }) {
  const { settings, profile, user, signOut, viewAs, realProfile, stopViewAs } = useSession();
  const navigate = useNavigate();
  const path = useLocation().pathname;

  /**
   * Which side of the business the navigation is narrowed to.
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
  // appear for a page the router will refuse. One group per icon on the rail,
  // with the pages of the group as chips along the top; see navFor.
  const words = wordsFor(settings);
  const groups = navFor(profile, settings, filter).map((g) => ({
    group: words[g.group] ?? g.group,
    icon: g.group,
    links: g.links.map((l) => ({ ...l, label: words[l.keys[0]] ?? l.label })),
  }));

  /**
   * How many things are waiting for a decision, shown on the Approvals icon.
   *
   * Counted by the same reader the page itself uses, plus the group bookings
   * and booking changes it lists above, so the badge and the page always
   * agree. Read again on every page change — deciding something and moving on
   * brings it down — and every minute for what arrives meanwhile. Only for
   * somebody who can open the page; a failed read shows nothing rather than a
   * number that is not true.
   */
  const canWait = groups.some((g) => g.links.some((l) => l.to === '/waiting'));
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    if (!canWait) { setWaiting(0); return undefined; }
    let live = true;
    const count = () => {
      void Promise.all([
        loadWaiting('main', () => '').then((w) => w.items.length),
        pendingGroupBookings().then((b) => b.length).catch(() => 0),
        openBookingChanges().then((c) => c.length).catch(() => 0),
      ]).then((ns) => { if (live) setWaiting(ns.reduce((a, n) => a + n, 0)); })
        .catch(() => { if (live) setWaiting(0); });
    };
    count();
    const timer = window.setInterval(count, 60_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [canWait, path]);
  const badgeFor = (g: { links: { to: string }[] }) => (g.links.some((l) => l.to === '/waiting') && waiting > 0
    ? <span className="nav-badge" aria-label={`${waiting} waiting`}>{waiting > 99 ? '99+' : waiting}</span>
    : null);

  /** Where you are: the group holding this page, and the page's own name. */
  const bare = (to: string) => to.split('?')[0];
  const isHere = (l: { to: string; end?: boolean }) =>
    (l.end ? path === '/' : path === bare(l.to) || path.startsWith(`${bare(l.to)}/`));
  const hub = groups.find((g) => g.links.some(isHere)) ?? null;
  const hereLabel = hub?.links.find(isHere)?.label
    ?? (path === '/account' ? 'Your account' : path === '/help' ? 'Help' : 'Admin');

  /* The tab says which page too, so six Admin tabs can be told apart. */
  useEffect(() => { document.title = pageTitle(hereLabel, 'admin'); }, [hereLabel]);

  /*
    The More sheet on a phone, and the "you" menu on the rail. Closed by going
    somewhere, and by Escape: a panel that stays open over the page you just
    asked for makes somebody close it every single time.
  */
  const [more, setMore] = useState(false);
  const [you, setYou] = useState(false);
  useEffect(() => { setMore(false); setYou(false); }, [path]);
  useEffect(() => {
    if (!more && !you) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMore(false); setYou(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [more, you]);

  const barGroups = groups.slice(0, BAR_SLOTS);
  const moreGroups = groups.slice(BAR_SLOTS);
  const inMore = !!hub && moreGroups.includes(hub);
  const name = profile?.display_name ?? user?.name ?? 'Signed in';
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '·';

  /** The things about you: who, how it looks, and the way out. On the rail's foot and in More. */
  const youItems = (
    <>
      <Link className="you-row" to="/account">
        <span className="you-av" aria-hidden="true">{initials}</span>
        <span className="you-name">{name}<span className="dim small">{profile?.role ?? 'no staff profile'}</span></span>
      </Link>
      <Link className="you-row" to="/help">Help and the manual</Link>
      <select
        className="theme-pick"
        value={themeMode()}
        onChange={(e) => setThemeMode(e.target.value as ReturnType<typeof themeMode>)}
        aria-label="Appearance"
      >
        {THEME_MODES.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
      </select>
      <Button size="sm" onClick={signOut}>Sign out</Button>
    </>
  );

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <Link to="/" className="rail-logo" aria-label={settings?.restaurant_name ?? PRODUCT_NAME}>
          {(settings?.restaurant_name ?? PRODUCT_NAME).trim().charAt(0).toUpperCase() || 'N'}
        </Link>
        {groups.map((g) => (
          <Link key={g.group} to={g.links[0].to} className={`rail-btn${g === hub ? ' on' : ''}`} aria-current={g === hub ? 'page' : undefined}>
            <Icon name={g.icon} />
            <span>{g.group}</span>
            {badgeFor(g)}
          </Link>
        ))}
        <span className="rail-gap" />
        <div className="you">
          <button type="button" className={`rail-btn${you ? ' on' : ''}`} aria-expanded={you} onClick={() => setYou((v) => !v)}>
            <span className="you-av" aria-hidden="true">{initials}</span>
            <span>You</span>
          </button>
          {you && (
            <>
              <button type="button" className="sheet-scrim clear" aria-label="Close" onClick={() => setYou(false)} />
              <div className="you-pop" role="dialog" aria-label="You">{youItems}</div>
            </>
          )}
        </div>
      </nav>

      <div className="main">
        {/*
          Whose eyes these are. Sticky, so it is never scrolled out of sight:
          a screen that looks like somebody else's without saying so is how
          an owner ends up believing a page is missing that is only hidden.
        */}
        {viewAs && (
          <div role="status" className="viewas">
            <span style={{ flex: '1 1 16rem' }}>
              Viewing as {viewAs.display_name || 'this person'} ({viewAs.role}). This is what they see. Nothing can be
              saved until you switch back.
            </span>
            <Button size="sm" variant="primary" onClick={() => { stopViewAs(); navigate('/staff'); }}>
              Back to {realProfile?.display_name || 'you'}
            </Button>
          </div>
        )}
        {/* Above the database bar on purpose. When a page is an old copy the
            two bars are the same fault, and this one names it correctly: the
            other reads the mismatch the wrong way round and sends somebody to
            provision a database that is in fact ahead of the page. */}
        <StaleBar />
        {/* Across the top of every page, for the person who can fix it. */}
        <SchemaBar settings={settings} owner={(realProfile ?? profile)?.role === 'admin'} />

        {/*
          The pages of this group, as chips along the top, and which side of
          the business, for somebody who works on one. Only drawn when there
          is a choice to make.
        */}
        {((hub && hub.links.length > 1) || sides.length > 1) && (
          <div className="hubbar">
            {hub && hub.links.length > 1 && (
              <div className="chips hub-chips">
                {hub.links.map((l) => (
                  <NavLink key={l.to} to={l.to} end={l.end} className="chip">
                    {l.label}
                    {l.to === '/waiting' && waiting > 0 && <span className="n">{waiting}</span>}
                  </NavLink>
                ))}
              </div>
            )}
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
          </div>
        )}
        <div className="page">{children}</div>
      </div>

      {/* A phone: the rail becomes a bar along the bottom, within reach of a thumb. */}
      <nav className="bottombar" aria-label="Main">
        {barGroups.map((g) => (
          <Link key={g.group} to={g.links[0].to} className={`bar-btn${g === hub ? ' on' : ''}`} aria-current={g === hub ? 'page' : undefined}>
            <Icon name={g.icon} />
            <span>{g.group}</span>
            {badgeFor(g)}
          </Link>
        ))}
        <button type="button" className={`bar-btn${more || inMore ? ' on' : ''}`} aria-expanded={more} onClick={() => setMore((v) => !v)}>
          <Icon name="More" />
          <span>More</span>
        </button>
      </nav>
      {more && (
        <>
          <button type="button" className="sheet-scrim" aria-label="Close" onClick={() => setMore(false)} />
          <div className="more-sheet" role="dialog" aria-label="More">
            <span className="grab" aria-hidden="true" />
            {moreGroups.length > 0 && (
              <div className="more-grid">
                {moreGroups.map((g) => (
                  <Link key={g.group} to={g.links[0].to} className={g === hub ? 'on' : ''}>
                    <Icon name={g.icon} />
                    {g.group}
                  </Link>
                ))}
              </div>
            )}
            <div className="more-you">{youItems}</div>
          </div>
        </>
      )}
    </div>
  );
}
