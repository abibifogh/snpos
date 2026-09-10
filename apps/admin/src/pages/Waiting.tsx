import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, Empty, Modal, Notice, Segmented, Spinner, useToast } from '@snpos/ui';
import { humanError } from '../lib';
import {
  
  approveBarCount, rejectBarCount, approveCount, rejectCount,
  tabExposure, issueCloseCode, releaseWords, displayOrderNo, CLOSE_CODE_GOOD_FOR_MS,
  decideSpend, loadWaiting, nameFrom, waitingCounts, waitingSummary, waitedWords, refuseSpendWords, WAITING_KIND_WORDS, dateTimeWords } from '@snpos/core';
import type {
  WaitingItem, WaitingKind, WaitingSpend, WaitingTabShift, TabOrder,
} from '@snpos/core';
import { useSession, useMoney } from '../session';

type Show = WaitingKind | 'all';
const SHOWS: Show[] = ['all', 'count', 'spend', 'shelf', 'tab'];

/**
 * Everything waiting for somebody senior, and the buttons to decide it.
 *
 * Bar and store-room counts, shop stocktakes, shelf changes, spends nobody
 * has looked at, and shifts that cannot close for the tabs on them. Each
 * used to wait on its own page, so the email that said three things were
 * waiting sent an admin to three screens and the month closed over whatever
 * they missed. Now one page lists them, oldest first, and the period-close
 * checklist and the email both point here.
 *
 * The rules that shape the rows are in core, see waiting.ts. This page reads
 * the five queues, hands them over, and wires each row's buttons to the same
 * functions the old pages called, so approving here is exactly approving
 * there.
 */
export function WaitingPage() {
  const { user, profile } = useSession();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const show = (SHOWS.includes(params.get('show') as Show) ? params.get('show') : 'all') as Show;
  const setShow = (s: Show) => setParams(s === 'all' ? {} : { show: s }, { replace: true });

  const isAdmin = profile?.role === 'admin';
  const userId = user?.$id ?? '';
  const money = useMoney();

  const [items, setItems] = useState<WaitingItem[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [spends, setSpends] = useState<Map<string, WaitingSpend & { source?: string }>>(new Map());
  /** The open shifts with tabs on them, by id, so the release modal can name one. */
  const [tabShifts, setTabShifts] = useState<Map<string, WaitingTabShift>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** The shift a code is being read out for, and the code once issued. */
  const [releasing, setReleasing] = useState<{ shift: WaitingTabShift; orders: TabOrder[] } | null>(null);
  const [issued, setIssued] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    // One reader, shared with the Today dashboard, so the two cannot count differently.
    const got = await loadWaiting('main', money);
    setNames(got.names);
    setSpends(got.spends);
    setTabShifts(got.tabShifts);
    setItems(got.items);
  };
  useEffect(() => { load().catch((e) => { setError(humanError(e)); setItems([]); }); }, []);

  const nameOf = (id?: string) => nameFrom(names, id, '');

  const counts = useMemo(() => waitingCounts(items ?? []), [items]);
  const shown = (items ?? []).filter((i) => show === 'all' || i.kind === show);

  /** Run one decision, say what happened, and read the list again. */
  const run = async (item: WaitingItem, fn: () => Promise<string>) => {
    setBusy(item.id);
    setError(null);
    try {
      toast(await fn());
      await load();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  };

  const approve = (item: WaitingItem) => run(item, async () => {
    const ref = item.ref;
    if (ref.kind === 'bar_count') {
      const { applied, failed } = await approveBarCount({ venueId: 'main', shiftId: ref.shiftId, phase: ref.phase, userId });
      return failed > 0
        ? `${applied} applied, ${failed} could not be. The count stays here until they are.`
        : `${applied} difference${applied === 1 ? '' : 's'} applied to the shelf`;
    }
    if (ref.kind === 'shop_count' || ref.kind === 'shelf') {
      const { applied, failed } = await approveCount({ countId: ref.countId, reviewerId: userId });
      return failed > 0
        ? `${applied} applied, ${failed} could not be. It stays here until they are.`
        : ref.kind === 'shelf' ? 'Shelf changed' : `${applied} difference${applied === 1 ? '' : 's'} applied to the shelf`;
    }
    if (ref.kind === 'spend') {
      await decideSpend({ expenseId: ref.expenseId, decision: 'approved', by: userId });
      return 'Spend approved';
    }
    return '';
  });

  const refuse = (item: WaitingItem) => {
    const ref = item.ref;
    if (ref.kind === 'spend') {
      const s = spends.get(ref.expenseId);
      if (!confirm(refuseSpendWords(s?.source, money(item.value)))) return;
    } else if (!confirm('Refuse this? The shelf stays exactly as it is, and the count is kept, marked as refused.')) {
      return;
    }
    void run(item, async () => {
      if (ref.kind === 'bar_count') {
        await rejectBarCount({ shiftId: ref.shiftId, phase: ref.phase, userId });
        return 'Count refused. The shelf is unchanged.';
      }
      if (ref.kind === 'shop_count' || ref.kind === 'shelf') {
        await rejectCount({ countId: ref.countId, reviewerId: userId });
        return ref.kind === 'shelf' ? 'Change refused. The shelf is unchanged.' : 'Count refused. The shelf is unchanged.';
      }
      if (ref.kind === 'spend') {
        await decideSpend({ expenseId: ref.expenseId, decision: 'rejected', by: userId });
        return 'Spend refused. The books follow in a moment.';
      }
      return '';
    });
  };

  const openRelease = async (item: WaitingItem) => {
    if (item.ref.kind !== 'tab') return;
    const ref = item.ref;
    setIssued(null);
    setBusy(item.id);
    try {
      // Read again on opening: a tab may have been paid since the list was built.
      const t = await tabExposure(ref.shiftId, ref.module, ref.venueId);
      const known = tabShifts.get(ref.shiftId);
      setReleasing({
        shift: { $id: ref.shiftId, code: known?.code, module: ref.module, venue_id: ref.venueId, tabOrders: t.orders.length, tabValue: t.value },
        orders: t.orders,
      });
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  };

  const now = Date.now();

  return (
    <>
      <div className="spread">
        <h1>Waiting for you</h1>
        <Segmented<Show>
          value={show}
          onChange={setShow}
          ariaLabel="Which kind"
          options={SHOWS.map((s) => ({
            value: s,
            label: s === 'all' ? `All (${items?.length ?? 0})` : `${WAITING_KIND_WORDS[s]} (${counts[s]})`,
          }))}
        />
      </div>
      <p className="dim small" style={{ marginTop: 0 }}>
        {items ? waitingSummary(items) : 'Reading every queue…'} Oldest first. Approving a count moves the shelf by the
        difference it found; refusing leaves the shelf as it is. Refusing a spend takes it off the books.
      </p>

      {error && <Notice>{error}</Notice>}

      <Card pad={false}>
        {!items ? (
          <div className="card-pad"><Spinner /></div>
        ) : shown.length === 0 ? (
          <Empty title={show === 'all' ? 'Nothing is waiting' : `No ${WAITING_KIND_WORDS[show as WaitingKind].toLowerCase()} waiting`}>
            Counts, spends, shelf changes and shifts held for a code all appear here the moment somebody sends one.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Waiting</th>
                  <th>What</th>
                  <th>Who</th>
                  <th className="num">Worth</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((item) => {
                  const since = Date.parse(item.at);
                  const decidable = item.kind !== 'tab';
                  // A spend is any manager's to decide; a count that moves a shelf is an admin's.
                  const may = item.kind === 'spend' ? true : isAdmin;
                  return (
                    <tr key={item.id}>
                      <td className="small dim" style={{ whiteSpace: 'nowrap' }}>
                        {Number.isFinite(since) ? (
                          <>
                            {waitedWords(now - since)}
                            <div className="small dim">{dateTimeWords(since)}</div>
                          </>
                        ) : '—'}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                          <Badge tone={item.kind === 'tab' ? 'warn' : 'default'}>{WAITING_KIND_WORDS[item.kind]}</Badge>
                          <span style={{ fontWeight: 550 }}>{item.title}</span>
                        </div>
                        <div className="small dim" style={{ maxWidth: '44rem' }}>{item.detail}</div>
                      </td>
                      <td className="dim small">
                        {nameOf(item.by) || '—'}
                        {/* Allowed and said out loud. A shop with one admin who
                            counts their own shelves would otherwise have a count
                            nobody can ever approve. */}
                        {item.by && (item.by === userId || item.by === profile?.$id) && (
                          <div className="small">Your own. Both names on the record will be yours.</div>
                        )}
                      </td>
                      <td className="num">{item.value > 0 ? money(item.value) : '—'}</td>
                      <td className="num" style={{ whiteSpace: 'nowrap' }}>
                        {decidable ? (
                          may ? (
                            <>
                              <Button size="sm" variant="primary" loading={busy === item.id} onClick={() => void approve(item)}>Approve</Button>
                              {' '}
                              <Button size="sm" variant="ghost" disabled={busy === item.id} onClick={() => refuse(item)}>Refuse</Button>
                            </>
                          ) : (
                            <span className="small dim">An admin decides this</span>
                          )
                        ) : (
                          <Button size="sm" variant="primary" loading={busy === item.id} onClick={() => void openRelease(item)}>
                            Read out a code
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {releasing && (
        <Modal
          title={`Release ${releasing.shift.code ?? 'this shift'}`}
          onClose={() => { setReleasing(null); setIssued(null); }}
          footer={<Button onClick={() => { setReleasing(null); setIssued(null); }}>Close</Button>}
        >
          {releasing.orders.length === 0 ? (
            <p className="small dim" style={{ marginTop: 0 }}>
              Nothing on this shift is on a tab any more, so it can be closed without a code.
            </p>
          ) : (
            <>
              {/* The figure, said out loud, before the button. See the same
                  modal on the shifts page: this is the one moment somebody who
                  can see the whole business is looking at what is going home
                  unpaid. */}
              <Notice tone="warn">{releaseWords(releasing.orders, money)}</Notice>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Order</th><th>When</th><th className="num">Total</th></tr></thead>
                  <tbody>
                    {releasing.orders.map((o) => (
                      <tr key={o.$id}>
                        <td style={{ fontWeight: 550 }}>{displayOrderNo(o.order_no)}</td>
                        <td className="small dim">{dateTimeWords(o.$createdAt)}</td>
                        <td className="num">{money(o.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {issued ? (
                <>
                  <p className="small dim" style={{ margin: '1rem 0 0.2rem' }}>
                    Read this to the cashier. It works once, on this shift only, for the next
                    {' '}{Math.round(CLOSE_CODE_GOOD_FOR_MS / 60_000)} minutes.
                  </p>
                  <div
                    style={{
                      fontSize: '2.4rem', fontWeight: 700, letterSpacing: '0.35rem',
                      fontFamily: 'ui-monospace, monospace', userSelect: 'all', textAlign: 'center',
                      padding: '0.6rem 0',
                    }}
                  >
                    {issued}
                  </div>
                  <p className="small dim" style={{ margin: 0 }}>It will not be shown again. If it is lost, issue another.</p>
                </>
              ) : (
                <Button
                  variant="primary"
                  loading={busy === `code:${releasing.shift.$id}`}
                  style={{ marginTop: '1rem' }}
                  onClick={async () => {
                    setBusy(`code:${releasing.shift.$id}`);
                    setError(null);
                    try {
                      setIssued(await issueCloseCode({
                        shiftId: releasing.shift.$id,
                        module: releasing.shift.module ?? 'kitchen',
                        by: profile?.user_id ?? profile?.$id ?? '',
                        tabOrders: releasing.orders.length,
                        tabValue: releasing.shift.tabValue,
                      }));
                    } catch (e) {
                      setError(humanError(e));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Issue a code
                </Button>
              )}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
