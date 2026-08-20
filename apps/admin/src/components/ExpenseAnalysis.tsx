import { useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Card, Empty, Input, Notice, Select, Spinner,
  FilterBar, FilterField,
} from '@snpos/ui';
import { humanError } from '../lib';
import {
  formatMoney, listCreatedBetween, listAll, toCsv, downloadCsv,
  analyseExpenses, previousWindow, changeWords, highlights, sideOf, SIDES, SIDE_WORDS,
  loadAlerts, acknowledgeAlert, isOutstanding, describeFlag, FLAG_WORDS,
  rankItems, itemCoverage, vitalFew, itemHighlights, listByIds,
} from '@snpos/core';
import type {
  AnalysedExpense, ExpenseAnalysis as Analysis, Slice, Side, Settings, StaffProfile,
  PurchaseAlert, ExpenseCategoryDoc, AnalysedItem,
} from '@snpos/core';
import { useSession } from '../session';

/**
 * What the business spends, taken apart.
 *
 * The list beside this says what was spent. This answers what comes after: on
 * what, by which trade, whether it is going up, who is spending it, and how
 * much of it has nothing behind it.
 *
 * Every figure carries the same figure for the period before, of the same
 * length. A total on its own is a number; a total against last month is
 * information, and it is the only form in which anybody can act on it.
 */

const dayStart = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999`).toISOString();
const todayStr = () => new Date().toLocaleDateString('en-CA');
const daysAgoStr = (n: number) => new Date(Date.now() - n * 86400_000).toLocaleDateString('en-CA');

/** A bar chart drawn with divs. No library, no fetch, nothing to load. */
function Bars({ rows, money }: { rows: { key: string; label: string; total: number }[]; money: (n: number) => string }) {
  const peak = Math.max(1, ...rows.map((r) => r.total));
  return (
    <div className="row" style={{ gap: '2px', alignItems: 'flex-end', height: '7rem', overflowX: 'auto' }}>
      {rows.map((r) => (
        <div
          key={r.key}
          title={`${r.label}: ${money(r.total)}`}
          style={{ flex: '1 0 6px', minWidth: '6px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}
        >
          <div
            style={{
              height: `${Math.max(r.total > 0 ? 3 : 0, (r.total / peak) * 100)}%`,
              background: r.total > 0 ? 'var(--primary, #0f766e)' : 'transparent',
              borderRadius: '2px 2px 0 0',
            }}
          />
        </div>
      ))}
    </div>
  );
}

function Change({ bp }: { bp: number | null }) {
  const w = changeWords(bp);
  if (w.tone === 'default') return <span className="small dim">{w.text}</span>;
  return <Badge tone={w.tone}>{w.text}</Badge>;
}

function SliceTable({
  title, rows, money, empty,
}: { title: string; rows: Slice[]; money: (n: number) => string; empty: string }) {
  const [all, setAll] = useState(false);
  // Ten is what fits without scrolling past the next question. The rest are a
  // click away rather than gone.
  const shown = all ? rows : rows.slice(0, 10);
  if (rows.length === 0) return <Card title={title}><p className="small dim" style={{ margin: 0 }}>{empty}</p></Card>;

  return (
    <Card title={title} pad={false}>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>What</th>
              <th className="num">This period</th>
              <th className="num">Before</th>
              <th>Change</th>
              <th className="num">Share</th>
              <th className="num">Times</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.key}>
                <td style={{ fontWeight: 550 }}>{r.label}</td>
                <td className="num">{money(r.now)}</td>
                <td className="num dim">{r.before ? money(r.before) : '—'}</td>
                <td><Change bp={r.changeBp} /></td>
                <td className="num dim">{r.now > 0 ? `${(r.shareBp / 100).toFixed(0)}%` : ''}</td>
                <td className="num dim">{r.count || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 10 && (
        <div className="card-pad">
          <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>
            {all ? 'Show the top ten' : `Show all ${rows.length}`}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Widening the dates in one tap, since they open on today. */
const RANGES = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
];

export function ExpenseAnalysisTab({ categories }: { categories: ExpenseCategoryDoc[] }) {
  const { settings, profile, user } = useSession();
  const isAdmin = profile?.role === 'admin';

  // Today, both ends. The comparison then reads today against yesterday,
  // which is the shape of the question somebody has standing in the shop.
  // Widen the dates for a month against the month before.
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(todayStr());
  const [side, setSide] = useState<'all' | Side>('all');
  const [by, setBy] = useState<'day' | 'week'>('day');

  const [now, setNow] = useState<AnalysedExpense[] | null>(null);
  const [before, setBefore] = useState<AnalysedExpense[]>([]);
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [alerts, setAlerts] = useState<PurchaseAlert[]>([]);
  /**
   * The actual things bought, under the expenses that bought them.
   *
   * The category tables answer "how much went on supplies". These answer the
   * question underneath, which is the one that changes what somebody buys:
   * WHICH THINGS. A kitchen spending a third of its money on one item does not
   * find that out from a category called Supplies.
   */
  const [items, setItems] = useState<AnalysedItem[]>([]);
  const [itemsBefore, setItemsBefore] = useState<AnalysedItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyAlert, setBusyAlert] = useState<string | null>(null);
  /** Fifteen is what fits without scrolling past the next question. */
  const [showAll, setShowAll] = useState(false);

  const money = (n: number) => (settings ? formatMoney(n, settings as Settings) : String(n));

  const load = async () => {
    setNow(null);
    setError(null);
    try {
      const back = previousWindow(dayStart(from), dayEnd(to));
      /*
        Two windows, read together.

        The period before is fetched rather than derived, because "the same
        length of time before this" is a different set of rows and there is no
        honest way to guess at it from the ones already in hand.
      */
      const [a, b, p, al] = await Promise.all([
        listCreatedBetween<AnalysedExpense>('shift_expenses', dayStart(from), dayEnd(to)),
        listCreatedBetween<AnalysedExpense>('shift_expenses', back.from, back.to),
        listAll<StaffProfile>('staff_profiles').catch(() => [] as StaffProfile[]),
        loadAlerts('main').catch(() => [] as PurchaseAlert[]),
      ]);
      setNow(a);
      setBefore(b);
      setStaff(p);
      setAlerts(al);

      /*
        The lines behind those expenses, fetched by the expenses they belong to.

        By id rather than by date: an expense line carries no date of its own,
        only the expense it hangs off, and reading every line ever written to
        filter them afterwards is exactly the greed that put the tills on the
        floor when the month's read allowance ran out.
      */
      const [ai, bi] = await Promise.all([
        listByIds<AnalysedItem>('expense_items', 'expense_id', a.map((x) => x.$id)).catch(() => []),
        listByIds<AnalysedItem>('expense_items', 'expense_id', b.map((x) => x.$id)).catch(() => []),
      ]);
      setItems(ai);
      setItemsBefore(bi);
    } catch (e) {
      setError(humanError(e));
      setNow([]);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [from, to]);

  const labelOf = (key: string) => categories.find((c) => c.key === key)?.name ?? key;
  const nameOf = (id: string) => staff.find((s) => s.$id === id || s.user_id === id)?.display_name ?? '';

  /*
    The side filter narrows the ROWS, before anything is worked out.

    Narrowing the finished figures instead would leave every share and every
    comparison measured against the whole business, so a bar spending all of
    its own money on stock would read as spending a fifth of it.
  */
  const mine = useMemo(
    () => (now ?? []).filter((e) => side === 'all' || sideOf(e) === side),
    [now, side],
  );
  const mineBefore = useMemo(
    () => before.filter((e) => side === 'all' || sideOf(e) === side),
    [before, side],
  );

  const a: Analysis | null = useMemo(
    () => (now
      ? analyseExpenses({
        now: mine, before: mineBefore, fromIso: dayStart(from), toIso: dayEnd(to), by, labelOf, nameOf,
      })
      : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [now, mine, mineBefore, from, to, by, categories, staff],
  );

  const notes = useMemo(() => (a ? highlights(a, money) : []), [a, settings]);

  /*
    The ranking, narrowed to the chosen side through the expenses it belongs to.

    A line knows nothing about which trade bought it; its expense does. Joined
    here rather than stored twice, because a line and its expense disagreeing
    about which side they are on is a class of bug with no honest resolution.
  */
  const sideByExpense = useMemo(
    () => new Map((now ?? []).map((e) => [e.$id, sideOf(e)])),
    [now],
  );
  const mineIds = useMemo(() => new Set(mine.map((e) => e.$id)), [mine]);
  const beforeIds = useMemo(() => new Set(mineBefore.map((e) => e.$id)), [mineBefore]);

  const ranked = useMemo(
    () => rankItems({
      now: items.filter((i) => mineIds.has(i.expense_id)),
      before: itemsBefore.filter((i) => beforeIds.has(i.expense_id)),
      sideOfExpense: (id) => sideByExpense.get(id) ?? 'kitchen',
    }),
    [items, itemsBefore, mineIds, beforeIds, sideByExpense],
  );

  const coverage = useMemo(
    () => itemCoverage(items.filter((i) => mineIds.has(i.expense_id)), a?.spend.now ?? 0),
    [items, mineIds, a],
  );

  const few = useMemo(() => vitalFew(ranked), [ranked]);
  const itemNotes = useMemo(() => itemHighlights(ranked, coverage, money), [ranked, coverage, settings]);

  const outstanding = useMemo(
    () => alerts.filter(isOutstanding).filter((x) => side === 'all' || (x.module ?? 'kitchen') === side),
    [alerts, side],
  );

  const tick = async (alert: PurchaseAlert, acknowledged: boolean) => {
    setBusyAlert(alert.$id);
    try {
      await acknowledgeAlert({ alert, userId: user?.$id ?? '', acknowledged });
      setAlerts(await loadAlerts('main'));
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusyAlert(null);
    }
  };

  const exportCsv = () => {
    if (!a) return;
    downloadCsv(
      `expense-categories-${from}-to-${to}.csv`,
      toCsv(
        ['Category', 'This period', 'Period before', 'Change %', 'Share %', 'Times'],
        a.categories.map((c) => [
          c.label, c.now, c.before, c.changeBp === null ? '' : (c.changeBp / 100).toFixed(1),
          (c.shareBp / 100).toFixed(1), c.count,
        ]),
      ),
    );
  };

  /*
    The items as their own file.

    Separate from the categories rather than bolted underneath them: this is
    the one somebody takes to a supplier, and a spreadsheet with two different
    shapes of table in it is a spreadsheet nobody sorts.
  */
  const exportItems = () => {
    downloadCsv(
      `expense-items-${from}-to-${to}.csv`,
      toCsv(
        ['Rank', 'Item', 'Side', 'Spent', 'Before', 'Change %', 'Share %', 'Running %',
          'Quantity', 'Per unit', 'Per unit before', 'Price change %', 'Times'],
        ranked.filter((r) => r.now > 0).map((r, i) => [
          i + 1, r.label, SIDE_WORDS[r.side], r.now, r.before,
          r.changeBp === null ? '' : (r.changeBp / 100).toFixed(1),
          (r.shareBp / 100).toFixed(1), (r.cumulativeBp / 100).toFixed(1),
          r.qty, r.unitCost, r.beforeUnitCost,
          r.priceMoveBp === null ? '' : (r.priceMoveBp / 100).toFixed(1),
          r.times,
        ]),
      ),
    );
  };

  if (!now) return <Card><Spinner /></Card>;

  const back = previousWindow(dayStart(from), dayEnd(to));

  return (
    <>
      <FilterBar>
        <FilterField label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></FilterField>
        <FilterField label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></FilterField>
        <FilterField label="Side">
          <Select value={side} onChange={(e) => setSide(e.target.value as 'all' | Side)}>
            <option value="all">All three together</option>
            {SIDES.map((s) => <option key={s} value={s}>{SIDE_WORDS[s]}</option>)}
          </Select>
        </FilterField>
        <FilterField label="Shown">
          <Select value={by} onChange={(e) => setBy(e.target.value as 'day' | 'week')}>
            <option value="day">By day</option>
            <option value="week">By week</option>
          </Select>
        </FilterField>
        {/* The dates open on today, so today reads against yesterday. These
            widen them in one tap for a month against the month before. */}
        {RANGES.map(({ days, label }) => (
          <Button key={days} size="sm" onClick={() => { setFrom(daysAgoStr(days)); setTo(todayStr()); }}>
            {label}
          </Button>
        ))}
        <Button size="sm" onClick={exportCsv}>Export categories</Button>
        {ranked.some((r) => r.now > 0) && (
          <Button size="sm" onClick={exportItems}>Export items</Button>
        )}
      </FilterBar>

      {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

      {a && a.count === 0 ? (
        <Card>
          <Empty title="Nothing spent in these dates">
            Widen the dates, or check the side filter. Spending is recorded from the tills, from the Expenses tab,
            and from a petty cash box.
          </Empty>
        </Card>
      ) : a && (
        <>
          <Card>
            <div className="row row-wrap" style={{ gap: '2rem', alignItems: 'flex-end' }}>
              <div>
                <div className="dim small">Spent</div>
                <div style={{ fontSize: '1.8rem', fontWeight: 700 }}>{money(a.spend.now)}</div>
                <div className="small"><Change bp={a.spend.changeBp} /></div>
              </div>
              <div>
                <div className="dim small">Period before</div>
                <div style={{ fontSize: '1.2rem' }}>{money(a.spend.before)}</div>
                <div className="small dim">
                  {new Date(back.from).toLocaleDateString()} – {new Date(back.to).toLocaleDateString()}
                </div>
              </div>
              <div>
                <div className="dim small">Entries</div>
                <div style={{ fontSize: '1.2rem' }}>{a.count}</div>
                <div className="small dim">{money(a.average)} each on average</div>
              </div>
              <div>
                <div className="dim small">Has a receipt</div>
                <div style={{ fontSize: '1.2rem' }}>{(a.receiptedBp / 100).toFixed(0)}%</div>
                <div className="small dim">of what was spent</div>
              </div>
              <div>
                <div className="dim small">Not out of a drawer</div>
                <div style={{ fontSize: '1.2rem' }}>{money(a.offDrawer)}</div>
                <div className="small dim">petty cash, or somebody&rsquo;s own money</div>
              </div>
            </div>
          </Card>

          {/* The one or two things worth saying. A page of tables answers
              questions somebody already knew to ask; this is for the ones they
              did not. */}
          {notes.length > 0 && (
            <Card title="Worth knowing">
              <ul className="small" style={{ margin: 0, paddingLeft: '1.1rem' }}>
                {notes.map((n) => <li key={n} style={{ marginBottom: '0.3rem' }}>{n}</li>)}
              </ul>
            </Card>
          )}

          {/* Purchases somebody was asked about at the moment they were
              recorded. The question was got out of the way of; this is where it
              survives. */}
          {outstanding.length > 0 && (
            <Card title={`${outstanding.length} ${outstanding.length === 1 ? 'purchase' : 'purchases'} worth a look`}>
              <p className="small dim" style={{ marginTop: 0 }}>
                Each of these looked dear, or larger than usual, when it was entered. Whoever recorded it was
                asked and carried on, which is right — prices genuinely move. Tick off the ones that were fine
                and what is left is what to ask about.
              </p>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>When</th><th>What</th><th>Side</th><th /></tr>
                  </thead>
                  <tbody>
                    {outstanding.map((x) => (
                      <tr key={x.$id}>
                        <td className="dim small">{new Date(x.$createdAt).toLocaleDateString()}</td>
                        <td>
                          <Badge tone="warn">{FLAG_WORDS[x.kind]}</Badge>{' '}
                          <span className="small">
                            {describeFlag({
                              kind: x.kind,
                              value: x.value,
                              typical: x.typical,
                              name: x.ingredient_name,
                              unit: x.unit,
                              money,
                            })}
                          </span>
                          <div className="small dim">
                            Recorded by {nameOf(x.created_by) || 'somebody who has left'}, against {x.seen} past
                            purchases.
                          </div>
                        </td>
                        <td className="small dim">{SIDE_WORDS[(x.module ?? 'kitchen') as Side]}</td>
                        <td className="num">
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={busyAlert === x.$id}
                            onClick={() => void tick(x, true)}
                          >
                            That was fine
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <Card title={by === 'day' ? 'Day by day' : 'Week by week'}>
            <Bars rows={a.buckets} money={money} />
            <p className="small dim" style={{ marginBottom: 0, marginTop: '0.5rem' }}>
              Every {by} in the range, including the ones nothing was spent on — a chart that skips its empty
              days makes a fortnight of nothing look like a busy week.
            </p>
          </Card>

          {/* Side by side, which is the comparison the whole page exists for.
              Only when all three are being shown: a page already narrowed to
              the bar has nothing to compare. */}
          {side === 'all' && (
            <Card title="The three trades">
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Side</th><th className="num">Spent</th><th className="num">Before</th>
                      <th>Change</th><th className="num">Share</th><th>Biggest single spend</th>
                      <th className="num">Receipted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.sides.map((s) => (
                      <tr key={s.side}>
                        <td style={{ fontWeight: 550 }}>{SIDE_WORDS[s.side]}</td>
                        <td className="num">{money(s.spend.now)}</td>
                        <td className="num dim">{s.spend.before ? money(s.spend.before) : '—'}</td>
                        <td><Change bp={s.spend.changeBp} /></td>
                        <td className="num dim">
                          {a.spend.now > 0 ? `${Math.round((s.spend.now / a.spend.now) * 100)}%` : '—'}
                        </td>
                        <td className="small dim">
                          {s.largest
                            ? `${money(s.largest.amount)} · ${labelOf(s.largest.category_key || s.largest.category || 'other')}`
                            : '—'}
                        </td>
                        <td className="num dim">{s.count ? `${(s.receiptedBp / 100).toFixed(0)}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="small dim" style={{ marginBottom: 0, marginTop: '0.6rem' }}>
                A bar&rsquo;s spending is almost all stock, a kitchen&rsquo;s is stock and gas and transport, a
                shop&rsquo;s is barely anything at all. Added together they describe none of them, which is why
                they are shown apart.
              </p>
            </Card>
          )}

          {/*
            The items themselves, ranked and drawn.

            A bar per thing, longest first, with the running share beside it.
            "These four things are two thirds of what we buy" is a sentence
            somebody can act on; a list of forty percentages is not.
          */}
          {ranked.filter((r) => r.now > 0).length > 0 && (
            <Card title="Every item, ranked by what it cost">
              <p className="small dim" style={{ marginTop: 0 }}>
                Measured against the {money(coverage.itemised)} that was itemised, not against everything spent.
                Transport, gas and repairs have no lines behind them — {(coverage.coverBp / 100).toFixed(0)}% of
                spending in these dates does.
              </p>

              {itemNotes.length > 0 && (
                <ul className="small" style={{ marginTop: 0, paddingLeft: '1.1rem' }}>
                  {itemNotes.map((n) => <li key={n} style={{ marginBottom: '0.3rem' }}>{n}</li>)}
                </ul>
              )}

              <div className="stack" style={{ gap: '0.35rem', marginTop: '0.8rem' }}>
                {ranked.filter((r) => r.now > 0).slice(0, showAll ? 100 : 15).map((r, i) => {
                  const widest = ranked[0]?.now || 1;
                  const inFew = i < few.length;
                  return (
                    <div key={r.key}>
                      <div className="row" style={{ justifyContent: 'space-between', gap: '0.6rem' }}>
                        <span className="small" style={{ fontWeight: inFew ? 650 : 500 }}>
                          {i + 1}. {r.label}
                          {side === 'all' && <span className="dim"> · {SIDE_WORDS[r.side]}</span>}
                        </span>
                        <span className="small" style={{ whiteSpace: 'nowrap' }}>
                          {money(r.now)} <span className="dim">({(r.shareBp / 100).toFixed(1)}%)</span>
                        </span>
                      </div>
                      <div
                        style={{
                          height: '0.5rem',
                          background: 'var(--surface-2, #e5e7eb)',
                          borderRadius: '3px',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          title={`${r.label}: ${money(r.now)}`}
                          style={{
                            width: `${Math.max(1, (r.now / widest) * 100)}%`,
                            height: '100%',
                            // The few that make up most of it are picked out,
                            // because that is the list worth acting on.
                            background: inFew ? 'var(--primary, #0f766e)' : 'var(--muted, #9ca3af)',
                          }}
                        />
                      </div>
                      <div className="small dim">
                        {r.qty > 0 && <>{r.qty} bought · {money(r.unitCost)} each · </>}
                        {r.times} {r.times === 1 ? 'time' : 'times'} · running {(r.cumulativeBp / 100).toFixed(0)}%
                        {r.priceMoveBp !== null && Math.abs(r.priceMoveBp) >= 500 && (
                          <>
                            {' · '}
                            <span style={{ color: r.priceMoveBp > 0 ? 'var(--warn)' : 'var(--ok)' }}>
                              {r.priceMoveBp > 0 ? 'up' : 'down'} {Math.abs(r.priceMoveBp / 100).toFixed(0)}% a unit
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {ranked.filter((r) => r.now > 0).length > 15 && (
                <Button size="sm" variant="ghost" onClick={() => setShowAll(!showAll)}>
                  {showAll ? 'Show the top fifteen' : `Show all ${ranked.filter((r) => r.now > 0).length}`}
                </Button>
              )}
            </Card>
          )}

          {/* The same figures as a table, because a bar shows a shape and a
              table answers "by how much". Both, rather than choosing. */}
          {ranked.filter((r) => r.now > 0).length > 0 && (
            <Card title="Item by item, against the period before" pad={false}>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>#</th><th>Item</th>
                      <th className="num">Spent</th><th className="num">Before</th><th>Change</th>
                      <th className="num">Bought</th><th className="num">Per unit</th><th>Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.filter((r) => r.now > 0).slice(0, showAll ? 100 : 15).map((r, i) => (
                      <tr key={r.key}>
                        <td className="dim small">{i + 1}</td>
                        <td style={{ fontWeight: 550 }}>{r.label}</td>
                        <td className="num">{money(r.now)}</td>
                        <td className="num dim">{r.before ? money(r.before) : '—'}</td>
                        <td><Change bp={r.changeBp} /></td>
                        <td className="num dim">{r.qty || '—'}</td>
                        <td className="num">{r.unitCost ? money(r.unitCost) : '—'}</td>
                        {/* Told apart from the spend on purpose. An item up a
                            third because three times as much was bought is not
                            the same problem as one up a third a unit, and they
                            need completely different answers. */}
                        <td><Change bp={r.priceMoveBp} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <SliceTable
            title="What it went on"
            rows={a.categories}
            money={money}
            empty="Nothing categorised in this range."
          />

          {/* Each side's own categories, so "what does the bar actually spend
              on" is answerable without changing the filter and losing the
              comparison. */}
          {side === 'all' && a.sides.filter((s) => s.count > 0).map((s) => (
            <SliceTable
              key={s.side}
              title={`${SIDE_WORDS[s.side]}: what it went on`}
              rows={s.categories}
              money={money}
              empty="Nothing recorded on this side."
            />
          ))}

          <SliceTable
            title="Who was paid"
            rows={a.payees}
            money={money}
            empty="No payees recorded."
          />

          <SliceTable
            title="Who recorded it"
            rows={a.people}
            money={money}
            empty="Nobody recorded against these."
          />

          {a.outsideShift > 0 && (
            <Card title="Recorded outside any shift">
              <p className="small dim" style={{ margin: 0 }}>
                {money(a.outsideShift)} was recorded against no shift at all — from the admin form, or after a
                till had closed for the night. It is real spending and it is in every figure above. What it is
                not is money any drawer was counted short of, so nothing checks it against a physical count.
                {isAdmin && ' Worth a look if it is a large share of the total.'}
              </p>
            </Card>
          )}
        </>
      )}
    </>
  );
}
