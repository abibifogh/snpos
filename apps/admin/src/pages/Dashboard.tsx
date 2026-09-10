import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Badge, Spinner, Notice, TrendChart } from '@snpos/ui';
import {
  formatMoney, todayFacts, against, percentWords, tradingHours, topSellers, openForWords, SIDE_NAMES,
  loadWaiting, waitedWords, levelOf,
} from '@snpos/core';
import type { TodayFacts, WaitingItem } from '@snpos/core';
import { useSession } from '../session';

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
  const { settings } = useSession();
  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));
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
      out.push({ what: 'The database is behind the app', why: 'A provision run has not happened since the schema changed', badge: 'Health', to: '/health', tone: 'danger' });
    }
    const quiet = !facts.lastHealthRun || Date.parse(facts.now) - Date.parse(facts.lastHealthRun) > 36 * 3_600_000;
    if (quiet) {
      out.push({ what: 'The nightly check has not run', why: facts.lastHealthRun ? `Last ran ${facts.lastHealthRun.slice(0, 10)}` : 'It has never run; the background job may not be deployed', badge: 'Health', to: '/health', tone: 'warn' });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facts]);

  if (error) return <><h1>Today</h1><Notice>{error}</Notice></>;
  if (!facts) return <><h1>Today</h1><Spinner /></>;

  const sides = facts.sides;
  const kinds = facts.today.byKind;
  const sellers = topSellers(facts.lines, 5);

  return (
    <>
      <div className="spread">
        <div>
          <h1>Today</h1>
          <p className="dim small" style={{ margin: '0.2rem 0 0' }}>{when}</p>
        </div>
      </div>

      {facts.catalogueEmpty && (
        <Card title="Getting started">
          <p className="small dim" style={{ marginTop: 0 }}>
            The database is set up. Work down this list and the customer menu will have something to show.
          </p>
          <ol className="small" style={{ lineHeight: 1.9, paddingLeft: '1.2rem', margin: 0 }}>
            <li><Link to="/settings">Settings</Link>, restaurant name, currency, tax and colours.</li>
            <li><Link to="/venues">Venues</Link>, set your opening hours. Pre-ordering needs these.</li>
            <li><Link to="/catalogue/categories">Categories</Link>, Starters, Mains, Drinks.</li>
            <li><Link to="/catalogue/items">Menu &amp; products</Link>, the menu itself, with prices.</li>
            <li><Link to="/features">Features</Link>, switch off anything you do not want yet.</li>
          </ol>
        </Card>
      )}

      {/* One card per side that trades, and one for the lot. */}
      <div className="grid-4" style={{ marginBottom: '1rem' }}>
        {sides.map((side) => {
          const ratio = against(facts.today.bySide[side], facts.lastWeek.bySide[side]);
          const pct = percentWords(ratio);
          return (
            <Card key={side} title={SIDE_NAMES[side]}>
              <div style={{ fontSize: '1.6rem', fontWeight: 650 }}>{money(facts.today.bySide[side])}</div>
              <div className="small">
                {pct && <Badge tone={ratio! >= 0 ? 'ok' : 'warn'}>{pct}</Badge>}
                <span className="dim">
                  {pct ? ` vs ${lastWeekName}` : `Nothing to compare with ${lastWeekName}`}
                  {side === 'kitchen' && facts.today.covers > 0 ? ` · ${facts.today.covers} covers` : ''}
                  {side !== 'kitchen' && facts.today.orders[side] > 0 ? ` · ${facts.today.orders[side]} ${side === 'craft' ? 'sales' : 'bills'}` : ''}
                </span>
              </div>
            </Card>
          );
        })}
        <Card title="All sides">
          <div style={{ fontSize: '1.6rem', fontWeight: 650 }}>{money(facts.today.total)}</div>
          <div className="small dim">
            Cash {money(kinds.cash)} · Card {money(kinds.card)} · MoMo {money(kinds.mobile_money)}
            {kinds.other > 0 ? ` · Other ${money(kinds.other)}` : ''}
          </div>
        </Card>
      </div>

      <div className="grid-2" style={{ marginBottom: '1rem' }}>
        <Card title={`Open shifts · ${facts.openShifts.length}`} pad={false}>
          {facts.openShifts.length === 0 && facts.closedToday.length === 0 ? (
            <p className="small dim card-pad" style={{ margin: 0 }}>Nothing is open. No shift has closed today either.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <tbody>
                  {facts.openShifts.map((o) => {
                    const age = Date.parse(facts.now) - Date.parse(o.shift.opened_at);
                    return (
                      <tr key={o.shift.$id}>
                        <td>
                          <div style={{ fontWeight: 550 }}>{SIDE_NAMES[o.side]}{o.openedBy ? ` · ${o.openedBy}` : ''}</div>
                          <div className="small dim">
                            Since {new Date(o.shift.opened_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · {openForWords(o.shift.opened_at, facts.now)}
                            {o.side === 'bar' && o.countedIn === true ? ' · counted in' : ''}
                            {o.side === 'bar' && o.countedIn === false ? ' · not counted in' : ''}
                          </div>
                        </td>
                        <td className="num">
                          <div>{money(o.takings)}</div>
                          {age > 8 * 3_600_000 && <Badge tone="warn">Past 8h</Badge>}
                        </td>
                      </tr>
                    );
                  })}
                  {facts.closedToday.filter((c) => !facts.openShifts.some((o) => o.side === c.side)).map((c) => (
                    <tr key={c.code}>
                      <td colSpan={2} className="small dim">
                        {SIDE_NAMES[c.side]} closed at {new Date(c.closedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                        {c.settled ? ' · settled' : ' · not yet settled'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card
          title={`Waiting for you${waiting ? ` · ${waiting.items.length}` : ''}`}
          actions={<Link to="/waiting" className="small">Open the list</Link>}
          pad={false}
        >
          {!waiting ? (
            <div className="card-pad"><Spinner /></div>
          ) : waiting.items.length === 0 ? (
            <p className="small dim card-pad" style={{ margin: 0 }}>Nothing is waiting for you.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <tbody>
                  {waiting.items.slice(0, 4).map((w) => (
                    <tr key={w.id}>
                      <td>
                        <div style={{ fontWeight: 550 }}>{w.title}</div>
                        <div className="small dim">
                          {w.by ? (waiting.names.get(w.by) ?? 'Somebody no longer on the staff list') : ''}
                          {w.at ? ` · waiting ${waitedWords(Date.parse(facts.now) - Date.parse(w.at))}` : ''}
                        </div>
                      </td>
                      <td className="num">{w.value > 0 ? money(w.value) : ''}</td>
                    </tr>
                  ))}
                  {waiting.items.length > 4 && (
                    <tr><td colSpan={2} className="small dim">and {waiting.items.length - 4} more</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card title={`Needs a look${look.length ? ` · ${look.length}` : ''}`} pad={false}>
        {look.length === 0 ? (
          <p className="small dim card-pad" style={{ margin: 0 }}>Nothing is running low, nothing is in transit, and the checks are up to date.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <tbody>
                {look.map((l) => (
                  <tr key={l.what}>
                    <td>
                      <div style={{ fontWeight: 550 }}>{l.what}</div>
                      <div className="small dim">{l.why}</div>
                    </td>
                    <td className="num"><Link to={l.to}><Badge tone={l.tone}>{l.badge}</Badge></Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div style={{ height: '1rem' }} />

      <div className="grid-2">
        <Card title="Takings by hour">
          <p className="small dim" style={{ marginTop: 0 }}>Today against {lastWeekName}, every side together.</p>
          <TrendChart points={points} money={money} height={200} revenueLabel="Today" costLabel={lastWeekName} />
        </Card>
        <Card title="Selling today" pad={false}>
          {sellers.length === 0 ? (
            <p className="small dim card-pad" style={{ margin: 0 }}>Nothing sold yet today.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <tbody>
                  {sellers.map((s) => (
                    <tr key={s.name}><td>{s.name}</td><td className="num">{s.qty}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
