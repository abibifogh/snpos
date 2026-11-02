import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Badge, Spinner, Notice, TrendChart } from '@snpos/ui';
import {
  todayFacts, against, percentWords, tradingHours, topSellers, openForWords, SIDE_NAMES,
  loadWaiting, waitedWords, levelOf, timeWords, nameFrom, greetingFor, daySoFar, canOpen } from '@snpos/core';
import type { TodayFacts, WaitingItem } from '@snpos/core';
import { useSession, useMoney } from '../session';
import { CloseDayCard } from '../components/CloseDay';
import { HubTabs } from '../components/Hub';

/**
 * Today.
 *
 * The questions an owner asks at eight in the evening, in the order they
 * ask them: what has each side taken, against the same night last week; who
 * is on; what is waiting for me; what needs a look before tomorrow; how the
 * evening ran hour by hour; what sold. The old dashboard counted menu items
 * and venues, which is a fact about the setup and says nothing about the
 * day. The figures come from three days of rows, see todayFacts; the rules
 * that turn them into these cards are in today.ts.
 */
export function Dashboard() {
  const { settings, profile } = useSession();
  const money = useMoney();
  const [facts, setFacts] = useState<TodayFacts | null>(null);
  const [waiting, setWaiting] = useState<{ items: WaitingItem[]; names: Map<string, string> } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    todayFacts('main', settings).then(setFacts).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    loadWaiting('main', money).then((w) => setWaiting({ items: w.items, names: w.names })).catch(() => setWaiting({ items: [], names: new Map() }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const now = new Date();
  const when = `${now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} · ${now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}${settings?.timezone ? ` · ${settings.timezone.split('/').pop()?.replace('_', ' ')}` : ''}`;

  const points = useMemo(() => {
    if (!facts) return [];
    return tradingHours(facts.hoursToday, facts.hoursLastWeek).map((h) => ({
      key: String(h), label: String(h), full: `${h}:00 to ${h + 1}:00`,
      revenue: facts.hoursToday[h], cost: facts.hoursLastWeek[h],
    }));
  }, [facts]);

  const lastWeekName = useMemo(() => {
    const d = new Date(now); d.setDate(d.getDate() - 7);
    return `last ${d.toLocaleDateString(undefined, { weekday: 'long' })}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** What needs a look before tomorrow: stock, money in transit, the database, the jobs. */
  const look = useMemo(() => {
    if (!facts) return [];
    const out: { what: string; why: string; badge: string; to: string; tone: 'warn' | 'danger' | 'default' }[] = [];
    for (const i of facts.lowStock.slice(0, 3)) {
      const level = levelOf(i, settings?.low_stock_default_bp ?? 3000);
      out.push({
        what: i.name, why: level === 'out' ? 'None left' : `${i.current_qty} ${i.unit} left, low at ${Math.round(i.low_threshold ?? (i.par_level * (settings?.low_stock_default_bp ?? 3000)) / 10000)}`,
        badge: level === 'out' ? 'Out' : 'Low', to: `/stock?side=${i.module ?? 'kitchen'}`, tone: level === 'out' ? 'danger' : 'warn',
      });
    }
    if (facts.hanging.momo + facts.hanging.card > 0) {
      out.push({ what: 'Card and mobile money not settled to the bank', why: `MoMo ${money(facts.hanging.momo)} · Card ${money(facts.hanging.card)}`, badge: 'Books', to: '/accounting?tab=settle', tone: 'default' });
    }
    if (facts.schema === 'behind') {
      out.push({ what: 'The database is behind the app', why: 'A provision run has not happened since the schema changed', badge: 'Health', to: '/settings?tab=data', tone: 'danger' });
    }
    const quiet = !facts.lastHealthRun || Date.parse(facts.now) - Date.parse(facts.lastHealthRun) > 36 * 3_600_000;
    if (quiet) {
      out.push({ what: 'The nightly check has not run', why: facts.lastHealthRun ? `Last ran ${facts.lastHealthRun.slice(0, 10)}` : 'It has never run; the background job may not be deployed', badge: 'Health', to: '/settings?tab=data', tone: 'warn' });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facts]);

  if (error) return <><h1>Today</h1><HubTabs /><Notice>{error}</Notice></>;
  if (!facts) return <><h1>Today</h1><HubTabs /><Spinner /></>;

  const sides = facts.sides;
  const kinds = facts.today.byKind;
  const sellers = topSellers(facts.lines, 5);
  const bills = sides.reduce((n, sd) => n + (facts.today.orders[sd] ?? 0), 0);
  const billsBefore = sides.reduce((n, sd) => n + (facts.lastWeek.orders[sd] ?? 0), 0);
  const totalPct = percentWords(against(facts.today.total, facts.lastWeek.total));
  const billPct = percentWords(against(bills, billsBefore));
  const first = (profile?.display_name ?? '').trim().split(/\s+/)[0];
  const soFar = daySoFar(points.map((x) => Number(x.key)), facts.hoursToday, now.getHours());
  const topQty = Math.max(1, ...sellers.map((x) => x.qty));
  const oldestWait = waiting?.items.reduce((m, w) => (w.at ? Math.max(m, Date.parse(facts.now) - Date.parse(w.at)) : m), 0) ?? 0;

  return (
    <>
      <div className="today-head">
        <div className="kicker today-when">{when}</div>
        <h1>{greetingFor(now.getHours())}{first ? `, ${first}` : ''}</h1>
      </div>
      <HubTabs />

      {facts.catalogueEmpty && (
        <Card title="Getting started"
          help={
            <>
              The database is set up. Work down this list and the customer menu will have something to show.
            </>
          }
        >
          <ol className="small" style={{ lineHeight: 1.9, paddingLeft: '1.2rem', margin: 0 }}>
            <li><Link to="/settings">Settings</Link>, restaurant name, currency, tax and colours.</li>
            <li><Link to="/venues">Venues</Link>, set your opening hours. Pre-ordering needs these.</li>
            <li><Link to="/catalogue/items?tab=categories">Categories</Link>, Starters, Mains, Drinks.</li>
            <li><Link to="/catalogue/items">Products</Link>, the menu itself, with prices.</li>
            <li><Link to="/settings?tab=features">Features</Link>, switch off anything you do not want yet.</li>
          </ol>
        </Card>
      )}

      {/*
        The figure an owner opens the app for, as big as it deserves, with
        the day drawn under it hour by hour. Then who is on.
      */}
      <div className="today-top">
        <section className="hero" aria-label="Takings so far">
          <div className="kicker hero-k">Takings so far</div>
          <div className="hero-big">{money(facts.today.total)}</div>
          <div className="hero-sub">
            {totalPct ? `${totalPct} on ${lastWeekName}` : `Nothing to compare with ${lastWeekName}`}
            {` · Cash ${money(kinds.cash)} · Card ${money(kinds.card)} · MoMo ${money(kinds.mobile_money)}`}
            {kinds.other > 0 ? ` · Other ${money(kinds.other)}` : ''}
          </div>
          <DayLine points={soFar} />
          {sides.length > 1 && (
            <div className="hero-sides">
              {sides.map((side) => <span key={side}>{SIDE_NAMES[side]} {money(facts.today.bySide[side])}</span>)}
            </div>
          )}
        </section>

        <Card title={`On now · ${facts.openShifts.length}`} pad={false}>
          {facts.openShifts.length === 0 && facts.closedToday.length === 0 ? (
            <p className="small dim card-pad" style={{ margin: 0 }}>Nothing is open. No shift has closed today either.</p>
          ) : (
            <div className="today-list">
              {facts.openShifts.map((o) => {
                const age = Date.parse(facts.now) - Date.parse(o.shift.opened_at);
                return (
                  <div className="today-row" key={o.shift.$id}>
                    <span className="live-dot" aria-hidden="true" />
                    <div className="grow">
                      <div className="t">{SIDE_NAMES[o.side]}{o.openedBy ? ` · ${o.openedBy}` : ''}</div>
                      <div className="d">
                        Since {timeWords(o.shift.opened_at)} · {openForWords(o.shift.opened_at, facts.now)}
                        {o.side === 'bar' && o.countedIn === true ? ' · counted in' : ''}
                        {o.side === 'bar' && o.countedIn === false ? ' · not counted in' : ''}
                      </div>
                    </div>
                    <div className="num">
                      {money(o.takings)}
                      {age > 8 * 3_600_000 && <div><Badge tone="warn">Past 8h</Badge></div>}
                    </div>
                  </div>
                );
              })}
              {facts.closedToday.filter((c) => !facts.openShifts.some((o) => o.side === c.side)).map((c) => (
                <div className="today-row" key={c.code}>
                  <span className={`check ${c.settled ? 'y' : 'n'}`} aria-hidden="true">{c.settled ? '✓' : '!'}</span>
                  <div className="grow d">
                    {SIDE_NAMES[c.side]} closed at {timeWords(c.closedAt)}
                    {c.settled ? ' · settled' : ' · not yet settled'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="label">Bills paid</div>
          <div className="value">{bills}</div>
          <div className="note">{billPct ? `${billPct} on ${lastWeekName}` : 'Nothing to compare with yet'}</div>
        </div>
        {sides.includes('kitchen') && (
          <div className="stat">
            <div className="label">Covers</div>
            <div className="value">{facts.today.covers}</div>
            <div className="note">guests on bistro bills</div>
          </div>
        )}
        <div className="stat">
          <div className="label">Average bill</div>
          <div className="value">{bills > 0 ? money(Math.round(facts.today.total / bills)) : '—'}</div>
          <div className="note">across every side</div>
        </div>
        <div className="stat">
          <div className="label">Waiting for a decision</div>
          <div className="value">{waiting ? waiting.items.length : '…'}</div>
          <div className="note">
            {waiting && waiting.items.length > 0 && oldestWait > 0
              ? <Badge tone={oldestWait > 24 * 3_600_000 ? 'warn' : 'default'}>oldest {waitedWords(oldestWait)}</Badge>
              : 'nothing held up'}
          </div>
        </div>
      </div>

      <div className="grid-2 today-pair">
        <Card
          title={`Needs you${waiting ? ` · ${waiting.items.length}` : ''}`}
          actions={<Link to="/waiting" className="btn btn-ghost btn-sm">Open Approvals →</Link>}
          pad={false}
        >
          {!waiting ? (
            <div className="card-pad"><Spinner /></div>
          ) : waiting.items.length === 0 ? (
            <div className="card-pad today-clear"><span className="check y" aria-hidden="true">✓</span>All clear. Nothing is waiting for you.</div>
          ) : (
            <div className="today-list">
              {waiting.items.slice(0, 4).map((w) => {
                const waited = w.at ? Date.parse(facts.now) - Date.parse(w.at) : 0;
                return (
                  <Link className="today-row" to="/waiting" key={w.id}>
                    <div className="grow">
                      <div className="t">{w.title}</div>
                      <div className="d">
                        {w.by ? nameFrom(waiting.names, w.by, '') : ''}
                        {w.at ? ` · waiting ${waitedWords(waited)}` : ''}
                      </div>
                    </div>
                    {w.value > 0
                      ? <span className="num">{money(w.value)}</span>
                      : waited > 24 * 3_600_000 ? <Badge tone="warn">over a day</Badge> : null}
                  </Link>
                );
              })}
              {waiting.items.length > 4 && <div className="today-row d">and {waiting.items.length - 4} more</div>}
            </div>
          )}
        </Card>
        <Card title="Selling today" pad={false}>
          {sellers.length === 0 ? (
            <p className="small dim card-pad" style={{ margin: 0 }}>Nothing sold yet today.</p>
          ) : (
            <div className="today-list">
              {sellers.map((s, i) => (
                <div className="today-row" key={s.name}>
                  <span className="rank">{i + 1}</span>
                  <div className="grow">
                    <div className="t">{s.name}</div>
                    <div className="meter" style={{ marginTop: 6 }}><span style={{ width: `${(s.qty / topQty) * 100}%` }} /></div>
                  </div>
                  <span className="num">{s.qty}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Whether yesterday (or today) is put away, before anything else that
          needs a look. See close-day.ts. The whole list is the Close the day
          tab beside this one; the card stays only for somebody who can see
          the day and not that tab, as it always has. */}
      {!canOpen('close_day', profile, settings) && <CloseDayCard money={money} compact />}

      <Card title={`Needs a look${look.length ? ` · ${look.length}` : ''}`} pad={false}>
        {look.length === 0 ? (
          <div className="card-pad today-clear"><span className="check y" aria-hidden="true">✓</span>Nothing is running low, nothing is in transit, and the checks are up to date.</div>
        ) : (
          <div className="today-list">
            {look.map((l) => (
              <Link className="today-row" to={l.to} key={l.what}>
                <div className="grow">
                  <div className="t">{l.what}</div>
                  <div className="d">{l.why}</div>
                </div>
                <Badge tone={l.tone}>{l.badge}</Badge>
              </Link>
            ))}
          </div>
        )}
      </Card>

      <Card title="Takings by hour">
        <p className="small dim" style={{ marginTop: 0 }}>Today against {lastWeekName}, every side together.</p>
        <TrendChart points={points} money={money} height={200} revenueLabel="Today" costLabel={lastWeekName} />
      </Card>
    </>
  );
}

/**
 * The day so far, drawn on the hero in its own ink: a line and a wash under it,
 * ending on a dot at the hour now. The hours are written under it as text
 * rather than inside the drawing, so they keep their shape at any width.
 */
function DayLine({ points }: { points: { hour: number; value: number }[] }) {
  if (points.length < 2) return <div className="hero-line empty" aria-hidden="true" />;
  const W = 600;
  const H = 110;
  const max = Math.max(1, ...points.map((x) => x.value));
  const step = W / (points.length - 1);
  const xy = points.map((x, i) => [i * step, H - 6 - (x.value / max) * (H - 18)] as const);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const last = xy[xy.length - 1];
  const label = (h: number) => (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`);
  return (
    <div className="hero-line">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Takings hour by hour so far today">
        <defs>
          <linearGradient id="dayline-wash" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.42" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${line} L${W} ${H} L0 ${H}Z`} fill="url(#dayline-wash)" />
        <path d={line} fill="none" stroke="currentColor" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" className="hero-path" />
        <circle cx={last[0] - 3} cy={last[1]} r="5" fill="currentColor" />
      </svg>
      <div className="hero-hours" aria-hidden="true">{points.map((x) => <span key={x.hour}>{label(x.hour)}</span>)}</div>
    </div>
  );
}
