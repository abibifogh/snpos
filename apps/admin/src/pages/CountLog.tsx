import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, Empty, Field, Input, Notice, Select, Spinner } from '@snpos/ui';
import {
  loadCountLog, shopCountLines, filterLog, logTotals, countLogCsv, downloadCsv, dateTimeWords, loadStaffNames, nameFrom,
  catalogueSides, canOpen, deductionPeriod, LOG_KIND_WORDS, LOG_SIDE_WORDS, LOG_STATE_WORDS, stateTone,
} from '@snpos/core';
import type { CountLogEntry, CountLogLine, CountLogSide, CountLogKind } from '@snpos/core';
import { HubTabs, HubTitle } from '../components/Hub';
import { useSession, useMoney } from '../session';
import { humanError } from '../lib';

type Quick = 'week' | 'lastweek' | 'month' | 'lastmonth' | 'custom';
const QUICK: { key: Exclude<Quick, 'custom'>; label: string }[] = [
  { key: 'week', label: 'This week' },
  { key: 'lastweek', label: 'Last week' },
  { key: 'month', label: 'This month' },
  { key: 'lastmonth', label: 'Last month' },
];
const dayInput = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * The count log: every count filed, from every side, at the start and end of
 * every shift, every stocktake, and the cash drawer counted at both ends.
 *
 * One list, filtered by days, side, kind and person, with each count's lines
 * a click away. Counts that should have been filed and were not are rows too,
 * marked Missed, so a gap is as easy to find as a count. Read only: counting
 * is on the Count now tab, deciding a difference on Differences.
 *
 * `view` 'missed' is the Missed counts tab: the same rows, only the gaps and
 * the counts left part done. The rules are in count-log.ts.
 */
export function CountLogPage({ view = 'log' }: { view?: 'log' | 'missed' }) {
  const { profile, settings } = useSession();
  const money = useMoney();
  const decimals = settings?.currency_decimals ?? 2;
  const [quick, setQuick] = useState<Quick>(view === 'missed' ? 'month' : 'week');
  const [from, setFrom] = useState(() => dayInput(deductionPeriod(view === 'missed' ? 'month' : 'week').from));
  const [to, setTo] = useState(() => dayInput(deductionPeriod(view === 'missed' ? 'month' : 'week').to));
  const [side, setSide] = useState<CountLogSide | 'all'>('all');
  const [kind, setKind] = useState<CountLogKind | 'all'>('all');
  const [by, setBy] = useState('');
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [rows, setRows] = useState<CountLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [openId, setOpenId] = useState<string | null>(null);
  const [lines, setLines] = useState<Record<string, CountLogLine[]>>({});

  // Only the sides this person can open, and the drawer for whoever can open shifts.
  const sides = useMemo(() => {
    const mine = catalogueSides('/counts', profile, settings) as CountLogSide[];
    return canOpen('shifts', profile, settings) ? [...mine, 'cash' as const] : mine;
  }, [profile, settings]);

  const window = useMemo(() => ({
    from: new Date(`${from}T00:00:00`).toISOString(),
    to: new Date(`${to}T23:59:59.999`).toISOString(),
  }), [from, to]);
  const problem = !from || !to ? 'Choose both days.' : from > to ? 'The first day is after the last.' : null;

  useEffect(() => { loadStaffNames().then(setNames).catch(() => undefined); }, []);
  useEffect(() => {
    if (problem) return;
    let live = true;
    setRows(null);
    setError(null);
    loadCountLog({ ...window, settings, money })
      .then((r) => { if (live) setRows(r.filter((e) => sides.includes(e.side))); })
      .catch((e) => { if (live) { setError(humanError(e)); setRows([]); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [window.from, window.to, sides.join(',')]);

  const pick = (q: Exclude<Quick, 'custom'>) => {
    const p = deductionPeriod(q);
    setQuick(q);
    setFrom(dayInput(p.from));
    setTo(dayInput(p.to));
  };

  const shown = useMemo(() => {
    const all = filterLog(rows ?? [], { ...window, side, kind, by, onlyDifferences: onlyDiff });
    return view === 'missed' ? all.filter((e) => e.state === 'missed' || (e.of !== null && e.counted !== null && e.counted < e.of)) : all;
  }, [rows, window, side, kind, by, onlyDiff, view]);
  const totals = logTotals(shown);
  const people = useMemo(() => {
    const ids = [...new Set((rows ?? []).map((e) => e.by).filter((x): x is string => !!x))];
    return ids.map((id) => [id, nameFrom(names, id)] as const).sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows, names]);
  const nameOf = (id?: string) => (id ? nameFrom(names, id) : '—');

  const open = async (e: CountLogEntry) => {
    if (openId === e.id) { setOpenId(null); return; }
    setOpenId(e.id);
    if (e.countId && !lines[e.id]) {
      const l = await shopCountLines(e.countId).catch(() => [] as CountLogLine[]);
      setLines((m) => ({ ...m, [e.id]: l }));
    }
  };

  const csv = () => {
    downloadCsv(`Counts ${from} to ${to}`, countLogCsv(shown, nameOf, decimals));
  };

  return (
    <>
      <div className="spread">
        <h1><HubTitle>{view === 'missed' ? 'Missed counts' : 'Count log'}</HubTitle></h1>
        <Button disabled={!rows || shown.length === 0} onClick={csv}>Spreadsheet</Button>
      </div>
      <HubTabs />

      <div className="row row-wrap" style={{ gap: '0.5rem', alignItems: 'flex-end', margin: '0.5rem 0 1rem' }}>
        <div className="row row-wrap" style={{ gap: '0.35rem' }} role="group" aria-label="Which days">
          {QUICK.map((q) => (
            <Button key={q.key} size="sm" variant={quick === q.key ? 'primary' : 'default'} aria-pressed={quick === q.key} onClick={() => pick(q.key)}>
              {q.label}
            </Button>
          ))}
        </div>
        <Field label="From"><Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setQuick('custom'); }} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setQuick('custom'); }} /></Field>
        {sides.length > 1 && (
          <Field label="Side">
            <Select value={side} onChange={(e) => setSide(e.target.value as CountLogSide | 'all')}>
              <option value="all">Every side</option>
              {sides.map((s) => <option key={s} value={s}>{LOG_SIDE_WORDS[s]}</option>)}
            </Select>
          </Field>
        )}
        {view === 'log' && (
          <Field label="Count">
            <Select value={kind} onChange={(e) => setKind(e.target.value as CountLogKind | 'all')}>
              <option value="all">Any</option>
              {(Object.keys(LOG_KIND_WORDS) as CountLogKind[]).map((k) => <option key={k} value={k}>{LOG_KIND_WORDS[k]}</option>)}
            </Select>
          </Field>
        )}
        <Field label="By">
          <Select value={by} onChange={(e) => setBy(e.target.value)}>
            <option value="">Anybody</option>
            {people.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </Select>
        </Field>
        {view === 'log' && (
          <label className="row" style={{ gap: '0.4rem', paddingBottom: '0.55rem' }}>
            <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} />
            <span className="small">Only with a difference</span>
          </label>
        )}
      </div>

      {problem && <Notice>{problem}</Notice>}
      {error && <Notice>{error}</Notice>}
      {rows && !problem && (
        <Notice tone="info">
          {view === 'missed'
            ? `${totals.missed} count${totals.missed === 1 ? '' : 's'} not filed${shown.length > totals.missed ? `, ${shown.length - totals.missed} left part done` : ''}. Each one is also a follow-up on To do.`
            : `${totals.counts} count${totals.counts === 1 ? '' : 's'} · ${totals.agree} agree${totals.missed ? ` · ${totals.missed} missed` : ''} · short ${money(totals.short)} · over ${money(totals.over)} · net ${money(Math.abs(totals.net))}${totals.net < 0 ? ' short' : totals.net > 0 ? ' over' : ''}`}
        </Notice>
      )}

      <Card pad={false}>
        {!rows ? <div className="card-pad"><Spinner /></div> : shown.length === 0 ? (
          <Empty title={view === 'missed' ? 'Nothing missed' : 'No counts in these days'}>
            {view === 'missed' ? 'Every shift in these days was counted at both ends.' : 'Choose other days, or clear a filter.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Shift or room</th>
                  <th>Side</th>
                  <th>Count</th>
                  <th>By</th>
                  <th className="num">Counted</th>
                  <th className="num">Short</th>
                  <th className="num">Over</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => {
                  const isOpen = openId === e.id;
                  const theLines = e.lines ?? lines[e.id];
                  return (
                    <Fragment key={e.id}>
                      <tr className="clickable" onClick={() => void open(e)} aria-expanded={isOpen} style={{ cursor: 'pointer' }}>
                        <td className="small">{e.at ? dateTimeWords(e.at) : '—'}</td>
                        <td><b>{e.place}</b></td>
                        <td className="small">{LOG_SIDE_WORDS[e.side]}</td>
                        <td className="small">{LOG_KIND_WORDS[e.kind]}</td>
                        <td className="small">{nameOf(e.by)}</td>
                        <td className="num small">
                          {e.side === 'cash' ? (e.amount !== undefined ? money(e.amount) : '—')
                            : e.state === 'missed' ? '—' : e.of !== null ? `${e.counted} of ${e.of}` : e.counted}
                        </td>
                        <td className="num">{e.short ? <span className="danger-text">{money(e.short)}</span> : <span className="dim">·</span>}</td>
                        <td className="num">{e.over ? <span className="ok-text">{money(e.over)}</span> : <span className="dim">·</span>}</td>
                        <td><Badge tone={stateTone(e.state)}>{LOG_STATE_WORDS[e.state]}</Badge></td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={9} style={{ background: 'var(--surface-2, transparent)' }}>
                            <div style={{ display: 'grid', gap: '0.5rem', padding: '0.25rem 0' }}>
                              {e.note && <span className="small">{e.note}</span>}
                              {e.side !== 'cash' && e.state !== 'missed' && (
                                !theLines ? <Spinner /> : (
                                  <LinesTable lines={theLines} money={money} />
                                )
                              )}
                              <div className="row row-wrap" style={{ gap: '0.5rem' }}>
                                {(e.short > 0 || e.chargeId) && e.side !== 'cash' && (
                                  <Link className="btn btn-sm btn-primary" to="/differences">Open Differences</Link>
                                )}
                                {e.state === 'missed' && <Link className="btn btn-sm" to="/todo?tab=follow">Open its follow-up</Link>}
                                {e.shiftId && <Link className="btn btn-sm" to="/shifts">Open Shifts</Link>}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="small dim">
        Click a row for its lines. Counts filed on the till at the start and end of a shift, store-room counts, shop
        stocktakes and the cash drawer all land here, for any days you choose.
      </p>
    </>
  );
}

/** A count's lines, differences first: the reason anybody opened it. */
function LinesTable({ lines, money }: { lines: CountLogLine[]; money: (n: number) => string }) {
  const sorted = [...lines].sort((a, b) => Math.abs(b.worth) - Math.abs(a.worth) || Math.abs(b.diff) - Math.abs(a.diff));
  const differing = sorted.filter((l) => l.diff !== 0);
  const [all, setAll] = useState(differing.length === 0);
  const show = all ? sorted : differing;
  return (
    <div style={{ display: 'grid', gap: '0.35rem' }}>
      {show.length === 0 ? <span className="small dim">Every line agreed with what was expected.</span> : (
        <div className="table-wrap">
          <table className="data" style={{ margin: 0 }}>
            <thead>
              <tr><th>Item</th><th className="num">Expected</th><th className="num">Counted</th><th className="num">Difference</th><th className="num">Worth</th></tr>
            </thead>
            <tbody>
              {show.map((l, i) => (
                <tr key={i} style={l.diff === 0 ? { opacity: 0.55 } : undefined}>
                  <td>{l.name}</td>
                  <td className="num dim">{l.expected}</td>
                  <td className="num">{l.counted ?? <span className="dim">—</span>}</td>
                  <td className="num">{l.diff === 0 ? <span className="dim">—</span> : <Badge tone={l.diff < 0 ? 'danger' : 'warn'}>{l.diff > 0 ? `+${l.diff}` : l.diff}</Badge>}</td>
                  <td className="num dim">{l.diff === 0 ? '' : `${l.worth < 0 ? '−' : '+'}${money(Math.abs(l.worth))}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {differing.length > 0 && differing.length < lines.length && (
        <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
          {all ? 'Only the lines that differ' : `All ${lines.length} lines`}
        </Button>
      )}
    </div>
  );
}
