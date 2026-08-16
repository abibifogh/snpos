import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Badge, useToast } from '@snpos/ui';
import { humanError } from '../lib';
import {
  shelfLines, submitCount, pendingCounts, countLines, approveCount, rejectCount,
  summariseCount, countWarnings, groupLines, COUNT_REASONS, isSelfApproval, formatMoney,
  expenseDraftKey, readExpenseDraft, saveExpenseDraft, clearExpenseDraft,
} from '@snpos/core';
import type {
  CountLine, CountReason, CountGrouping, PendingCount, PendingCountLine, StaffProfile,
} from '@snpos/core';
import { listAll } from '@snpos/core';
import { useSession } from '../session';

/** Where a half-finished count lives while somebody serves a customer. */
const DRAFT_KEY = (userId: string) => expenseDraftKey('main', 'stocktake', userId);

/**
 * Counting the shop's shelves.
 *
 * The craft side had no count at all. Pieces went on the shelf when a delivery
 * was booked in and came off when a bill was settled, and nothing else could
 * move the number — so a piece that broke, walked, or went back to its maker
 * left the shelf saying it was still there, for ever.
 *
 * Nothing here writes to the shelf. A count is submitted and an admin applies
 * it, because an adjustment is the only write in the shop that can make stock
 * disappear with no sale behind it, and the person holding the clipboard
 * should not also be the person who signs it off.
 */
export function StocktakePage() {
  const { settings, profile, user } = useSession();
  const toast = useToast();

  const [tab, setTab] = useState<'count' | 'approve'>('count');
  const [lines, setLines] = useState<CountLine[] | null>(null);
  const [filter, setFilter] = useState('');
  const [maker, setMaker] = useState('');
  const [category, setCategory] = useState('');
  const [groupBy, setGroupBy] = useState<CountGrouping>('maker');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [restored, setRestored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [queue, setQueue] = useState<PendingCount[] | null>(null);
  const [staff, setStaff] = useState<StaffProfile[]>([]);

  const isAdmin = profile?.role === 'admin';
  const mayCount = isAdmin || profile?.role === 'manager';
  const userId = user?.$id ?? '';
  const store = typeof window === 'undefined' ? null : window.localStorage;

  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));

  const loadShelf = () =>
    shelfLines()
      .then(setLines)
      .catch((e) => setError(humanError(e)));

  const loadQueue = () =>
    pendingCounts()
      .then(setQueue)
      .catch(() => setQueue([]));

  useEffect(() => {
    void loadShelf();
    void loadQueue();
    listAll<StaffProfile>('staff_profiles').then(setStaff).catch(() => undefined);
  }, []);

  /**
   * A half-finished count is picked up where it was left.
   *
   * Counting four hundred pieces is not one sitting. Somebody gets through the
   * baskets, serves a customer, comes back — and a browser that had thrown
   * away the first hour would make this a screen people do not start. Kept on
   * the device rather than in the database: an unfinished count is not a
   * record, and half of one sitting in the approvals queue would be worse than
   * no count at all.
   */
  useEffect(() => {
    if (!lines || restored || !userId) return;
    const draft = readExpenseDraft(store, DRAFT_KEY(userId));
    const saved = (draft as { lines?: { ingredientId: string; qtyText: string; totalText: string }[] })?.lines;
    if (!saved?.length) return;
    // Keyed by product and variant, so a piece that has since been archived
    // simply does not match rather than landing on the wrong row.
    const byKey = new Map(saved.map((l) => [l.ingredientId, l]));
    setLines((rows) => (rows ?? []).map((r) => {
      const hit = byKey.get(`${r.menuItemId}:${r.variantId ?? ''}`);
      return hit ? { ...r, countedText: hit.qtyText, reason: (hit.totalText || 'counted') as CountReason } : r;
    }));
    setNote((draft as { noteText?: string }).noteText ?? '');
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, userId]);

  /**
   * Written as it is typed, not on the way out.
   *
   * There are more ways off this page than there are buttons on it: a tab
   * closing, a tablet sleeping, a browser reloading a page it has sat on all
   * afternoon.
   */
  useEffect(() => {
    if (!lines || !userId) return;
    const typed = lines
      .filter((l) => (l.countedText ?? '').trim() !== '')
      .map((l) => ({
        ingredientId: `${l.menuItemId}:${l.variantId ?? ''}`,
        qtyText: l.countedText ?? '',
        totalText: l.reason ?? 'counted',
      }));
    saveExpenseDraft(store, DRAFT_KEY(userId), { lines: typed, noteText: note });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, note, userId]);

  const setLine = (i: number, patch: Partial<CountLine>) =>
    setLines((rows) => (rows ?? []).map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const makers = useMemo(
    () => [...new Set((lines ?? []).map((l) => l.consignorName ?? ''))].filter(Boolean).sort(),
    [lines],
  );
  const categories = useMemo(
    () => [...new Set((lines ?? []).map((l) => l.categoryName ?? ''))].filter(Boolean).sort(),
    [lines],
  );

  /**
   * What is on screen. Filtering never drops what has been typed — somebody
   * counts the baskets, searches for "bowl", counts those, and both are saved.
   */
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (lines ?? [])
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => {
        if (maker && (line.consignorName ?? 'The shop') !== maker) return false;
        if (category && (line.categoryName ?? 'Uncategorised') !== category) return false;
        if (!q) return true;
        return `${line.name} ${line.variantLabel ?? ''} ${line.consignorName ?? ''}`.toLowerCase().includes(q);
      });
  }, [lines, filter, maker, category]);

  const groups = useMemo(() => groupLines(shown, groupBy), [shown, groupBy]);
  const summary = useMemo(() => summariseCount(lines ?? []), [lines]);
  const warnings = useMemo(() => countWarnings(lines ?? []), [lines]);
  const nameOf = (id: string) =>
    staff.find((s) => s.user_id === id || s.$id === id)?.display_name ?? 'someone';

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { lines: written } = await submitCount({
        venueId: 'main',
        lines: lines ?? [],
        userId,
        note,
      });
      clearExpenseDraft(store, DRAFT_KEY(userId));
      setConfirming(false);
      setNote('');
      setRestored(false);
      await loadShelf();
      await loadQueue();
      toast(
        isAdmin
          ? `${written} difference${written === 1 ? '' : 's'} sent for approval. Apply them under Approvals.`
          : `${written} difference${written === 1 ? '' : 's'} sent to an admin to approve.`,
      );
      if (isAdmin) setTab('approve');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!mayCount) {
    return (
      <>
        <h1>Count the shelf</h1>
        <Notice>Only an admin or a manager can record a stock count.</Notice>
      </>
    );
  }

  return (
    <>
      <div className="spread">
        <h1>Count the shelf</h1>
        {tab === 'count' && (
          <Button
            variant="primary"
            onClick={() => setConfirming(true)}
            disabled={summary.differences.length === 0}
          >
            {summary.differences.length === 0
              ? 'Nothing to send yet'
              : `Send ${summary.differences.length} difference${summary.differences.length === 1 ? '' : 's'}`}
          </Button>
        )}
      </div>

      <div className="pos-tabs" style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.8rem' }}>
        <Button size="sm" variant={tab === 'count' ? 'primary' : 'default'} onClick={() => setTab('count')}>
          Count
        </Button>
        <Button size="sm" variant={tab === 'approve' ? 'primary' : 'default'} onClick={() => setTab('approve')}>
          Approvals{queue?.length ? ` (${queue.length})` : ''}
        </Button>
      </div>

      {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

      {tab === 'approve' ? (
        <Approvals
          queue={queue}
          isAdmin={isAdmin}
          reviewerId={userId}
          money={money}
          nameOf={nameOf}
          onDone={async () => { await loadQueue(); await loadShelf(); }}
          onToast={toast}
        />
      ) : (
        <>
          {restored && (
            <div style={{ marginBottom: '0.8rem' }}>
              <Notice tone="info">
                Picked up where you left off.{' '}
                <button
                  type="button"
                  onClick={() => {
                    clearExpenseDraft(store, DRAFT_KEY(userId));
                    setRestored(false);
                    setNote('');
                    void loadShelf();
                  }}
                  style={{
                    background: 'none', border: 'none', padding: 0, font: 'inherit',
                    color: 'inherit', textDecoration: 'underline', cursor: 'pointer',
                  }}
                >
                  Start again
                </button>
              </Notice>
            </div>
          )}

          <p className="dim" style={{ maxWidth: '46rem' }}>
            Walk the shop and type what is actually on the shelf. Leave a line blank and it is left exactly as it
            is — blank is not nought. Nothing moves until an admin approves it.
          </p>

          {warnings.map((w) => (
            <div key={w} style={{ marginBottom: '0.6rem' }}><Notice tone="warn">{w}</Notice></div>
          ))}

          <Card title="How to walk it">
            <div className="grid-2">
              <Field label="Search">
                <Input value={filter} placeholder="Basket, necklace…" onChange={(e) => setFilter(e.target.value)} />
              </Field>
              <Field label="Group by" hint="A shop is counted one shelf at a time, not alphabetically.">
                <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as CountGrouping)}>
                  <option value="maker">Maker</option>
                  <option value="category">Category</option>
                  <option value="none">One flat list</option>
                </Select>
              </Field>
              <Field label="Only this maker">
                <Select value={maker} onChange={(e) => setMaker(e.target.value)}>
                  <option value="">Everyone</option>
                  {makers.map((m) => <option key={m} value={m}>{m}</option>)}
                  <option value="The shop">The shop</option>
                </Select>
              </Field>
              <Field label="Only this category">
                <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">All of them</option>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                  <option value="Uncategorised">Uncategorised</option>
                </Select>
              </Field>
            </div>
            {/* Said plainly, because a filtered list that silently threw away
                what was already typed would be the worst surprise here. */}
            {(filter || maker || category) && summary.countedLines > 0 && (
              <p className="small dim" style={{ margin: 0 }}>
                {summary.countedLines} line{summary.countedLines === 1 ? '' : 's'} counted so far, including any
                hidden by this filter. Nothing is lost by searching.
              </p>
            )}
          </Card>

          {!lines ? (
            <Card><Spinner /></Card>
          ) : shown.length === 0 ? (
            <Card>
              <Empty title={lines.length === 0 ? 'Nothing on the shelves yet' : 'Nothing matches that'}>
                {lines.length === 0
                  ? 'Pieces appear here once a delivery has been booked in under Goods received.'
                  : 'Clear the search, or choose a different maker.'}
              </Empty>
            </Card>
          ) : (
            groups.map((group) => (
              <Card
                key={group.key}
                title={group.label || undefined}
                actions={
                  group.label ? (
                    /* Progress per group, because a long count needs to show
                       which shelves are done without anybody scrolling them. */
                    <Badge tone={group.counted === group.total ? 'ok' : 'default'}>
                      {group.counted} of {group.total} counted
                    </Badge>
                  ) : undefined
                }
                pad={false}
              >
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Piece</th>
                        {groupBy !== 'maker' && <th>Maker</th>}
                        {groupBy !== 'category' && <th>Category</th>}
                        <th className="num">Shelf says</th>
                        <th style={{ width: '7rem' }}>Actually there</th>
                        <th style={{ width: '13rem' }}>If it differs, why</th>
                        <th className="num">Difference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.lines.map(({ line, index }) => {
                        const typed = (line.countedText ?? '').trim();
                        const counted = typed === '' ? null : Number(typed);
                        const delta = counted === null || !Number.isFinite(counted)
                          ? null
                          : counted - line.onHand;
                        return (
                          <tr key={`${line.menuItemId}-${line.variantId ?? ''}`}>
                            <td>
                              <div style={{ fontWeight: 550 }}>{line.name}</div>
                              {line.variantLabel && <div className="small dim">{line.variantLabel}</div>}
                            </td>
                            {groupBy !== 'maker' && (
                              <td className="dim small">{line.consignorName ?? 'The shop'}</td>
                            )}
                            {groupBy !== 'category' && (
                              <td className="dim small">{line.categoryName ?? '—'}</td>
                            )}
                            <td className="num">{line.onHand}</td>
                            <td>
                              <Input
                                type="number"
                                min="0"
                                step="1"
                                placeholder="—"
                                value={line.countedText ?? ''}
                                onChange={(e) => setLine(index, { countedText: e.target.value })}
                              />
                            </td>
                            <td>
                              {delta !== null && delta < 0 ? (
                                <Select
                                  value={line.reason ?? 'counted'}
                                  onChange={(e) => setLine(index, { reason: e.target.value as CountReason })}
                                >
                                  {COUNT_REASONS.map((r) => (
                                    <option key={r.value} value={r.value}>{r.label}</option>
                                  ))}
                                </Select>
                              ) : (
                                <span className="dim small">
                                  {delta === null ? 'Not counted' : delta > 0 ? 'More than expected' : 'Matches'}
                                </span>
                              )}
                            </td>
                            <td className="num">
                              {delta === null || delta === 0 ? (
                                <span className="dim">—</span>
                              ) : (
                                <Badge tone={delta < 0 ? 'danger' : 'warn'}>
                                  {delta > 0 ? `+${delta}` : delta}
                                </Badge>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            ))
          )}
        </>
      )}

      {confirming && (
        <Modal
          title="Send this count for approval?"
          onClose={() => (busy ? undefined : setConfirming(false))}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
                Keep counting
              </Button>
              <Button variant="primary" onClick={() => void submit()} loading={busy}>
                Send it
              </Button>
            </>
          }
        >
          {/* The whole point of a confirm step. What is about to be recorded,
              in the shape somebody can check against the clipboard in their
              hand, before it is anywhere near the shelf. */}
          <Notice tone="info">
            Nothing on the shelf changes yet. An admin applies it from Approvals, and the till goes on selling what
            the shelf currently says until then.
          </Notice>

          <div className="row row-wrap" style={{ gap: '1.4rem', margin: '0.8rem 0' }}>
            <div>
              <div className="dim small">Missing</div>
              <div style={{ fontSize: '1.3rem', fontWeight: 650 }}>{summary.missingPieces}</div>
              <div className="dim small">{money(summary.missingValue)} at retail</div>
            </div>
            {summary.surplusPieces > 0 && (
              <div>
                <div className="dim small">More than expected</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 650 }}>{summary.surplusPieces}</div>
              </div>
            )}
            {summary.byReason.map((r) => (
              <div key={r.reason}>
                <div className="dim small">{COUNT_REASONS.find((x) => x.value === r.reason)?.label}</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 650 }}>{r.pieces}</div>
                <div className="dim small">{money(r.value)}</div>
              </div>
            ))}
          </div>

          <div className="table-wrap" style={{ maxHeight: '34vh', overflowY: 'auto' }}>
            <table className="data">
              <thead><tr><th>Piece</th><th className="num">Was</th><th className="num">Now</th><th>Why</th></tr></thead>
              <tbody>
                {summary.differences.map((d) => (
                  <tr key={`${d.line.menuItemId}-${d.line.variantId ?? ''}`}>
                    <td>
                      {d.line.name}
                      {d.line.variantLabel && <span className="dim small"> · {d.line.variantLabel}</span>}
                    </td>
                    <td className="num dim">{d.line.onHand}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{d.counted}</td>
                    <td className="small dim">{COUNT_REASONS.find((x) => x.value === d.reason)?.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Field label="Note" hint="Goes on the count and on every movement it eventually writes.">
            <Input value={note} placeholder="Monthly count, 12 August" onChange={(e) => setNote(e.target.value)} />
          </Field>
        </Modal>
      )}
    </>
  );
}

/**
 * Counts waiting to be applied.
 *
 * Read-only for a manager, deliberately. They can see what they submitted and
 * that it is still waiting, which is the difference between a queue and a
 * black hole; applying it is an admin's.
 */
function Approvals({
  queue, isAdmin, reviewerId, money, nameOf, onDone, onToast,
}: {
  queue: PendingCount[] | null;
  isAdmin: boolean;
  reviewerId: string;
  money: (n: number) => string;
  nameOf: (id: string) => string;
  onDone: () => Promise<void>;
  onToast: (message: string, tone?: 'ok' | 'err') => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [lines, setLines] = useState<PendingCountLine[] | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const [busy, setBusy] = useState(false);

  const open = async (id: string) => {
    setOpenId(id);
    setLines(null);
    setReviewNote('');
    setLines(await countLines(id).catch(() => []));
  };

  const act = async (approve: boolean) => {
    if (!openId) return;
    setBusy(true);
    try {
      if (approve) {
        const { applied, failed } = await approveCount({ countId: openId, reviewerId, note: reviewNote });
        onToast(
          failed > 0
            ? `${applied} applied, ${failed} could not be. The count stays here until they are.`
            : `${applied} difference${applied === 1 ? '' : 's'} applied to the shelf`,
          failed > 0 ? 'err' : 'ok',
        );
      } else {
        await rejectCount({ countId: openId, reviewerId, note: reviewNote });
        onToast('Count rejected. The shelf is unchanged.');
      }
      setOpenId(null);
      await onDone();
    } catch (e) {
      onToast(humanError(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const current = (queue ?? []).find((c) => c.$id === openId) ?? null;

  return (
    <>
      <Card pad={false}>
        {!queue ? (
          <div className="card-pad"><Spinner /></div>
        ) : queue.length === 0 ? (
          <Empty title="Nothing waiting">
            Counts appear here when somebody sends one. Until one is approved, the shelf is exactly as it was.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Counted</th><th>By</th><th>Note</th>
                  <th className="num">Lines</th><th className="num">Missing</th><th />
                </tr>
              </thead>
              <tbody>
                {queue.map((c) => (
                  <tr key={c.$id}>
                    <td className="dim small">{new Date(c.counted_at).toLocaleString()}</td>
                    <td>{nameOf(c.counted_by)}</td>
                    <td className="dim small">{c.note || '—'}</td>
                    <td className="num">{c.line_count}</td>
                    <td className="num">
                      {c.missing_pieces > 0 && (
                        <Badge tone="danger">{c.missing_pieces} · {money(c.missing_value)}</Badge>
                      )}
                      {c.surplus_pieces > 0 && <Badge tone="warn"> +{c.surplus_pieces}</Badge>}
                    </td>
                    <td className="num">
                      <Button size="sm" onClick={() => void open(c.$id)}>
                        {isAdmin ? 'Review' : 'Look'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {openId && current && (
        <Modal
          wide
          title={`Counted by ${nameOf(current.counted_by)}`}
          onClose={() => (busy ? undefined : setOpenId(null))}
          footer={
            isAdmin ? (
              <>
                <Button variant="ghost" onClick={() => setOpenId(null)} disabled={busy}>Close</Button>
                <Button variant="danger" onClick={() => void act(false)} loading={busy}>Reject</Button>
                <Button variant="primary" onClick={() => void act(true)} loading={busy}>
                  Apply to the shelf
                </Button>
              </>
            ) : (
              <Button onClick={() => setOpenId(null)}>Close</Button>
            )
          }
        >
          {!isAdmin && (
            <Notice tone="info">
              Waiting for an admin. Nothing on the shelf has changed, and the till is still selling what it says.
            </Notice>
          )}
          {isAdmin && isSelfApproval(current, reviewerId) && (
            /* Allowed and said out loud. A shop with one admin who counts their
               own shelves would otherwise have a count nobody can ever approve,
               which is not a control — it is a locked door with the key inside. */
            <Notice tone="warn">
              This is your own count. You can apply it, and both names on the record will be yours.
            </Notice>
          )}

          {!lines ? <Spinner /> : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Piece</th><th>Maker</th>
                    <th className="num">Shelf said</th><th className="num">Counted</th>
                    <th className="num">Change</th><th>Why</th><th className="num">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.$id} className={l.applied ? 'dim' : undefined}>
                      <td>
                        {l.name_snapshot}
                        {l.variant_label && <span className="dim small"> · {l.variant_label}</span>}
                        {l.applied && <Badge tone="ok"> applied</Badge>}
                      </td>
                      <td className="dim small">{l.consignor_name || 'The shop'}</td>
                      <td className="num dim">{l.expected}</td>
                      <td className="num" style={{ fontWeight: 600 }}>{l.counted}</td>
                      <td className="num">
                        <Badge tone={l.delta < 0 ? 'danger' : 'warn'}>
                          {l.delta > 0 ? `+${l.delta}` : l.delta}
                        </Badge>
                      </td>
                      <td className="small dim">{COUNT_REASONS.find((x) => x.value === l.reason)?.label}</td>
                      <td className="num">{money(Math.abs(l.delta) * l.unit_price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {isAdmin && (
            <>
              {/* Said before the button, not after. Applying the DIFFERENCE is
                  what makes a count taken this morning safe to approve this
                  evening: anything sold in between is a movement of its own and
                  stays counted. */}
              <p className="small dim">
                The <strong>change</strong> column is what is applied, not the counted figure. Anything sold since
                this was counted stays sold — approving takes the difference off whatever the shelf holds now.
              </p>
              <Field label="Note" hint="Kept on the count, whether you apply it or turn it down.">
                <Input
                  value={reviewNote}
                  placeholder="Checked against the shelf on the 14th"
                  onChange={(e) => setReviewNote(e.target.value)}
                />
              </Field>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
