import { useEffect, useState, type ReactNode } from 'react';
import { Badge, Button, Card, Empty, Spinner } from '@snpos/ui';
import { listAll } from '@snpos/core';
import type { StaffProfile, CountState } from '@snpos/core';
import { countStateLabel } from '@snpos/core';

/**
 * One count, from either side of the business, in the shape the history reads.
 *
 * The bar's counts are forty rows named by shift and end; the shop's are one
 * header row and its lines. Two shapes, one question — who counted what, what
 * differed, what it was worth, and who agreed to it — so both are mapped into
 * this before they reach the screen, and the screen knows nothing about which
 * collection it came from.
 */
export interface HistoryCount {
  id: string;
  /** What to call it: a shift code, a store room, a date. */
  title: string;
  /** Counted in or out, where that applies. */
  phase?: 'open' | 'close';
  at: string;
  countedBy?: string;
  state: CountState;
  /** Who agreed, refused, or took it back — and when. */
  decidedBy?: string;
  decidedAt?: string;
  /** Lines that differed from what was expected. */
  changed: number;
  /** What those differences were worth, in money. */
  worth: number;
  /** Loaded on opening, because a page of every line of every count is a page nobody opens twice. */
  lines: () => Promise<HistoryLine[]>;
}

export interface HistoryLine {
  name: string;
  counted: number | null;
  expected: number;
  variance: number;
  worth: number;
  note?: string;
}

const tone = (state: CountState): 'ok' | 'warn' | 'danger' | 'default' =>
  state === 'applied' ? 'ok'
    : state === 'pending' ? 'warn'
      : state === 'rejected' || state === 'undone' ? 'danger'
        : 'default';

/**
 * Every count filed, with what it found and who agreed.
 *
 * The record the owner asked for: not "was the shelf counted", which the
 * count sheet already answers, but "what did each count claim, what was it
 * worth, and whose decision moved the figures". Read for a month later, when
 * somebody is asking why the tonic figure changed on a Tuesday.
 *
 * Pending counts are the same rows in a different state and, where the caller
 * allows it, can be agreed to or refused from here.
 */
export function CountHistory({
  title,
  counts,
  money,
  onApprove,
  onReject,
  emptyWords,
}: {
  title: string;
  counts: HistoryCount[] | null;
  money: (n: number) => string;
  /** Present only for somebody who may agree to a held count. */
  onApprove?: (count: HistoryCount) => Promise<void>;
  onReject?: (count: HistoryCount) => Promise<void>;
  emptyWords: string;
}) {
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [openId, setOpenId] = useState<string | null>(null);
  const [lines, setLines] = useState<Record<string, HistoryLine[]>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    listAll<StaffProfile>('staff_profiles')
      .then((rows) => {
        const map = new Map<string, string>();
        for (const p of rows) {
          map.set(p.$id, p.display_name);
          if (p.user_id) map.set(p.user_id, p.display_name);
        }
        setNames(map);
      })
      .catch(() => undefined);
  }, []);

  // A name, not an id, because the whole point is being able to ask a person.
  // An id with no profile is shown as it is rather than as "Unknown".
  const nameOf = (id?: string) => (id ? names.get(id) ?? id : '—');

  const open = async (c: HistoryCount) => {
    if (openId === c.id) { setOpenId(null); return; }
    setOpenId(c.id);
    if (!lines[c.id]) {
      const rows = await c.lines().catch(() => [] as HistoryLine[]);
      setLines((m) => ({ ...m, [c.id]: rows }));
    }
  };

  const act = async (c: HistoryCount, fn?: (c: HistoryCount) => Promise<void>) => {
    if (!fn) return;
    setBusy(c.id);
    try { await fn(c); } finally { setBusy(null); }
  };

  return (
    <Card title={title} pad={false}>
      {counts === null ? (
        <div className="card-pad"><Spinner /></div>
      ) : counts.length === 0 ? (
        <Empty title="Nothing here yet">{emptyWords}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Which count</th>
                <th>Counted by</th>
                <th className="num">Lines differed</th>
                <th className="num">Worth</th>
                <th>State</th>
                <th>Decided by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {counts.map((c) => {
                const state = c.state;
                const isOpen = openId === c.id;
                return (
                  <FragmentRow key={c.id}>
                    <tr style={state === 'rejected' || state === 'undone' ? { opacity: 0.6 } : undefined}>
                      <td className="small dim">{c.at ? new Date(c.at).toLocaleString() : '—'}</td>
                      <td>
                        {c.title}
                        {c.phase && (
                          <div className="small dim">{c.phase === 'open' ? 'Counted in' : 'Counted out'}</div>
                        )}
                      </td>
                      <td className="small">{nameOf(c.countedBy)}</td>
                      <td className="num">{c.changed}</td>
                      <td className="num">{c.changed > 0 ? money(c.worth) : <span className="dim">—</span>}</td>
                      <td><Badge tone={tone(state)}>{countStateLabel(state)}</Badge></td>
                      <td className="small">
                        {c.decidedBy ? nameOf(c.decidedBy) : <span className="dim">—</span>}
                        {c.decidedAt && <div className="dim">{new Date(c.decidedAt).toLocaleString()}</div>}
                      </td>
                      <td className="num">
                        <Button size="sm" variant="ghost" onClick={() => void open(c)}>
                          {isOpen ? 'Hide' : 'Lines'}
                        </Button>
                        {state === 'pending' && onApprove && (
                          <Button
                            size="sm"
                            variant="primary"
                            loading={busy === c.id}
                            onClick={() => void act(c, onApprove)}
                          >
                            Agree and apply
                          </Button>
                        )}
                        {state === 'pending' && onReject && (
                          <Button size="sm" variant="ghost" loading={busy === c.id} onClick={() => void act(c, onReject)}>
                            Refuse
                          </Button>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={8} style={{ padding: 0 }}>
                          {!lines[c.id] ? (
                            <div className="card-pad"><Spinner /></div>
                          ) : (
                            <table className="data" style={{ margin: 0 }}>
                              <thead>
                                <tr>
                                  <th>What</th>
                                  <th className="num">Counted</th>
                                  <th className="num">Expected</th>
                                  <th className="num">Difference</th>
                                  <th className="num">Worth</th>
                                  <th>Note</th>
                                </tr>
                              </thead>
                              <tbody>
                                {/* Differences first, matches after: the reason
                                    anybody opened this is the lines that moved. */}
                                {[...lines[c.id]]
                                  .sort((a, b) => Math.abs(b.worth) - Math.abs(a.worth) || Math.abs(b.variance) - Math.abs(a.variance))
                                  .map((l, i) => (
                                    <tr key={i} style={l.variance === 0 ? { opacity: 0.55 } : undefined}>
                                      <td>{l.name}</td>
                                      <td className="num">{l.counted ?? <span className="dim">—</span>}</td>
                                      <td className="num dim">{l.expected}</td>
                                      <td className="num">
                                        {l.variance === 0
                                          ? <span className="dim">—</span>
                                          : <Badge tone={l.variance < 0 ? 'danger' : 'warn'}>{l.variance > 0 ? `+${l.variance}` : l.variance}</Badge>}
                                      </td>
                                      <td className="num dim">{l.variance === 0 ? '' : money(Math.abs(l.worth))}</td>
                                      <td className="small dim">{l.note || ''}</td>
                                    </tr>
                                  ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </FragmentRow>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** Two table rows under one key. */
function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
