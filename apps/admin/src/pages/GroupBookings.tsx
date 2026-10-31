import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, Badge, Button, Notice, Spinner, Input, Modal, Segmented, Textarea, useToast, InfoTip } from '@snpos/ui';
import { humanError } from '../lib';
import {
  groupBookingsFrom, resendBookingNotice, resendPendingFor,
  sittingsOf, moveSitting, sittingMoveProblem, sittingIsMovable,
  sendBookingForApproval, approvalState, approvalWords, approvalRequestProblem,
  decideGroupBooking, declineGroupBooking, openBookingChanges, decideBookingChange, CHANGE_KIND_WORDS,
  bookingStatusWords, bookingsOnTab, tabCounts, whenFromNow, BOOKING_TAB_WORDS,
  loadFeatures, featureConfig, FULFILMENT_WORDS, SERVICE_WORDS,
  formatMoney, dateTimeWords, forDateTimeInput, downloadFile, db, DB_ID, Query, listByIds,
} from '@snpos/core';
import type { GroupBookingDoc, BookingSitting, BookingChangeDoc, BookingTab, FeatureMap } from '@snpos/core';
/*
  THE SAME BUILDER THE EMAIL USES, not a second one that looks like it.

  A download that quietly says something different from the copy the kitchen
  was sent is the worst possible version of this feature: two documents about
  one party, both plausible, and no way to tell which the kitchen cooked from.
  So the browser runs the generator the notify job runs. See
  functions/notify/src/booking-sheet.js.
*/
import { bookingSittings, bookingSheetPdf } from '../../../../functions/notify/src/booking-sheet.js';
import { useSession } from '../session';

/** How far back the Past tab reaches. */
const PAST_DAYS = 90;

const TABS: BookingTab[] = ['decide', 'changes', 'upcoming', 'past', 'all'];

/**
 * Group bookings: one page for everything about them.
 *
 * Opens on what needs somebody — a decision, then a guest's request — and
 * lists by when the food is EATEN, not when the booking was made. Each row
 * has one button. Everything else about a booking is inside it: the decision,
 * its meal times and moving them, what the guest has asked for, the sheets,
 * and the messages. The row used to carry five buttons, and the decision
 * itself was only on Approvals.
 *
 * The words are the guest's words: "Confirm booking" here sends "Your booking
 * is confirmed" there. "Send changes to guest" is the other direction —
 * asking them to agree to what we changed — and is named so it cannot be
 * mistaken for our own decision.
 */
export function GroupBookingsPage() {
  const toast = useToast();
  const { settings, profile, user } = useSession();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<GroupBookingDoc[] | null>(null);
  const [changes, setChanges] = useState<BookingChangeDoc[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<BookingTab>('decide');
  const [features, setFeatures] = useState<FeatureMap>({});
  const openId = params.get('open');

  useEffect(() => { void loadFeatures().then(setFeatures).catch(() => undefined); }, []);

  const load = async () => {
    setError(null);
    try {
      const since = new Date(Date.now() - PAST_DAYS * 86_400_000).toISOString();
      const [found, asked] = await Promise.all([groupBookingsFrom('main', since), openBookingChanges()]);
      setRows(found);
      setChanges(asked);
    } catch (e) {
      setError(humanError(e));
      setRows([]);
    }
  };
  useEffect(() => { void load(); }, []);

  const now = new Date();
  const asking = useMemo(() => new Set(changes.map((c) => c.booking_id)), [changes]);
  const counts = rows ? tabCounts(rows, now, asking) : null;
  /*
    Open on the first tab with something in it. A page that opens on an
    empty "Needs a decision" when three bookings are coming up this week
    reads as "nothing here".
  */
  useEffect(() => {
    if (!counts) return;
    if (counts[tab] === 0) {
      const first = TABS.find((t) => t !== 'all' && counts[t] > 0);
      if (first) setTab(first);
    }
    // Only on the first load, not every time a count changes under somebody.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows === null]);

  const shown = rows ? bookingsOnTab(rows, tab, now, asking) : [];
  const money = (n?: number) => (settings ? formatMoney(n ?? 0, settings) : String(n ?? 0));
  const opened = rows?.find((b) => b.$id === openId) ?? null;
  const open = (b: GroupBookingDoc | null) => {
    const next = new URLSearchParams(params);
    if (b) next.set('open', b.$id); else next.delete('open');
    setParams(next, { replace: true });
  };

  if (error) return <Notice>{error}</Notice>;

  return (
    <>
      <h1>
        Bookings
        <InfoTip>
          Every group booking, by when it is eaten. Open one to confirm or decline it, move its meal times, answer
          the guest, or download its sheets. Meal times reach the kitchen at their time either way; until a booking
          is confirmed they show <strong>Not confirmed</strong> on the kitchen screen.
        </InfoTip>
      </h1>

      <div style={{ margin: '0.9rem 0' }}>
        <Segmented<BookingTab>
          value={tab}
          onChange={setTab}
          ariaLabel="Which bookings"
          options={TABS.map((t) => ({
            value: t,
            label: counts && t !== 'all' && counts[t] > 0 ? `${BOOKING_TAB_WORDS[t]} (${counts[t]})` : BOOKING_TAB_WORDS[t],
          }))}
        />
      </div>

      {rows === null ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <Card pad>
          <p style={{ margin: 0 }}>
            {tab === 'decide' ? 'Nothing is waiting for a decision.'
              : tab === 'changes' ? 'No guest is waiting for an answer about a change.'
                : tab === 'upcoming' ? 'No group bookings coming up.'
                  : `No group bookings in the last ${PAST_DAYS} days.`}
          </p>
        </Card>
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Party</th>
                  <th>First meal time</th>
                  <th>Meal times</th>
                  <th className="num">Total</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((b) => {
                  const st = bookingStatusWords(b.status);
                  const ap = approvalState(b);
                  return (
                    <tr key={b.$id}>
                      <td>
                        <strong>{b.contact_name || '-'}</strong>
                        {b.reference && <div className="small dim">{b.reference}</div>}
                      </td>
                      <td className="small">
                        {b.first_at ? dateTimeWords(b.first_at) : '-'}
                        {b.first_at && <div className="dim">{whenFromNow(b.first_at, now)}</div>}
                      </td>
                      <td className="small">{b.sittings ?? 0} · {b.portions ?? 0} portions</td>
                      <td className="num" style={{ fontWeight: 650 }}>{money(b.total)}</td>
                      <td>
                        <Badge tone={st.tone}>{st.label}</Badge>
                        {ap !== 'none' && (
                          <div style={{ marginTop: '0.25rem' }}>
                            <Badge tone={approvalWords(ap).tone === 'default' ? undefined : approvalWords(ap).tone}>
                              {approvalWords(ap).label}
                            </Badge>
                          </div>
                        )}
                        {asking.has(b.$id) && (
                          <div style={{ marginTop: '0.25rem' }}><Badge tone="warn">Asked for a change</Badge></div>
                        )}
                      </td>
                      <td className="num">
                        <Button size="sm" variant={st.label === 'Waiting to confirm' || asking.has(b.$id) ? 'primary' : undefined} onClick={() => open(b)}>
                          Open
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {opened && (
        <BookingPanel
          booking={opened}
          requests={changes.filter((c) => c.booking_id === opened.$id)}
          features={features}
          money={money}
          userId={user?.$id ?? ''}
          profileId={profile?.$id ?? ''}
          role={profile?.role ?? ''}
          accent={settings?.primary_color ?? '#0f766e'}
          settings={settings}
          onClose={() => open(null)}
          onChanged={async (words) => {
            if (words) toast(words);
            await load();
          }}
          onError={(m) => toast(m, 'err')}
        />
      )}
    </>
  );
}

/** Everything about one booking, with its one main action at the top. */
function BookingPanel({
  booking: b, requests, features, money, userId, profileId, role, accent, settings, onClose, onChanged, onError,
}: {
  booking: GroupBookingDoc;
  requests: BookingChangeDoc[];
  features: FeatureMap;
  money: (n?: number) => string;
  userId: string;
  profileId: string;
  role: string;
  accent: string;
  settings: ReturnType<typeof useSession>['settings'];
  onClose: () => void;
  onChanged: (words?: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [sittings, setSittings] = useState<(BookingSitting & { fulfilment?: string; group_service?: string })[] | null>(null);
  /** Portions on each meal time, added up from its lines. */
  const [portions, setPortions] = useState<Record<string, number>>({});
  const [moveTo, setMoveTo] = useState<Record<string, string>>({});
  const [moved, setMoved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [line, setLine] = useState('');
  const [declining, setDeclining] = useState(false);
  const [cancelToo, setCancelToo] = useState(true);
  const [replies, setReplies] = useState<Record<string, string>>({});
  /** "Send changes to guest", while what changed is being written. */
  const [sendingChanges, setSendingChanges] = useState(false);
  const [changeNote, setChangeNote] = useState('');
  const [teamAsked, setTeamAsked] = useState(false);

  const st = bookingStatusWords(b.status);
  const ap = approvalState(b);
  const pending = (b.status ?? 'pending') === 'pending';
  const live = (sittings ?? []).filter((s) => !['CANCELLED', 'REJECTED'].includes(s.status));

  const readSittings = async () => {
    try {
      const found = await sittingsOf(b.$id);
      setSittings(found);
      const lines = await listByIds<{ order_id: string; qty?: number; status?: string }>(
        'order_items', 'order_id', found.map((s) => s.$id),
      ).catch(() => []);
      const n: Record<string, number> = {};
      for (const l of lines) if (l.status !== 'void') n[l.order_id] = (n[l.order_id] ?? 0) + Math.max(0, l.qty ?? 0);
      setPortions(n);
      setMoveTo(Object.fromEntries(found.map((s) => [s.$id, forDateTimeInput(s.scheduled_for)])));
    } catch (e) {
      onError(humanError(e));
      setSittings([]);
    }
  };
  useEffect(() => { void readSittings(); }, [b.$id]);

  const act = async (key: string, fn: () => Promise<string | undefined>) => {
    setBusy(key);
    try {
      const words = await fn();
      await onChanged(words);
    } catch (e) {
      onError(humanError(e));
    } finally {
      setBusy(null);
    }
  };

  const confirmIt = () => act('confirm', async () => {
    await decideGroupBooking({ id: b.$id, status: 'approved', by: userId, note: line });
    return `Booking confirmed. ${b.contact_name || 'The guest'} is emailed now.`;
  });

  const declineIt = () => act('decline', async () => {
    const { cancelled } = await declineGroupBooking({
      id: b.$id, by: userId, userId, note: line, cancelMealTimes: cancelToo,
    });
    setDeclining(false);
    await readSittings();
    return cancelled > 0
      ? `Declined, and ${cancelled} meal time${cancelled === 1 ? '' : 's'} cancelled. The guest is emailed now.`
      : 'Declined. The guest is emailed now. The meal times are still on the kitchen’s list.';
  });

  const move = (s: BookingSitting) => act(s.$id, async () => {
    const typed = moveTo[s.$id] ?? '';
    const when = typed ? new Date(typed) : null;
    const why = sittingMoveProblem({ sitting: s, to: when });
    if (why) throw new Error(why);
    await moveSitting({
      booking: b, sitting: s, to: when as Date,
      slotCapacity: featureConfig(features, 'preorders', 'slot_capacity', 0),
      by: profileId, byRole: role,
    });
    setMoved(true);
    await readSittings();
    return `Meal time ${s.order_no ?? ''} moved. Nobody has been told yet.`;
  });

  const answer = (c: BookingChangeDoc, status: 'done' | 'refused') => act(c.$id, async () => {
    await decideBookingChange({ id: c.$id, status, by: userId, reply: replies[c.$id] ?? '' });
    return status === 'done' ? 'Marked done. The guest is told.' : 'Marked as not possible. The guest is told.';
  });

  const sendChanges = () => act('changes', async () => {
    const why = approvalRequestProblem(b);
    if (why) throw new Error(why);
    await sendBookingForApproval({ bookingId: b.$id, note: changeNote });
    setSendingChanges(false);
    setChangeNote('');
    setMoved(false);
    return 'Sent to the guest to check. It goes out in the next minute.';
  });

  const emailTeam = () => act('team', async () => {
    await resendBookingNotice(b.$id);
    setTeamAsked(true);
    return 'The team will be emailed again in the next minute.';
  });

  const download = (prices: boolean) => act(prices ? 'sheet' : 'kitchen', async () => {
    const found = await bookingSittings({ db, DB_ID, Query, booking: b });
    if (found.length === 0) throw new Error('That booking has no orders behind it to print.');
    const stem = String(b.reference || b.contact_name || b.$id)
      .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'booking';
    downloadFile(
      `group-booking-${stem}${prices ? '' : '-kitchen'}.pdf`,
      bookingSheetPdf({ settings: settings ?? {}, venue: null, booking: b, sittings: found, accent, prices }),
      'application/pdf',
    );
    return undefined;
  });

  const how = (s: { fulfilment?: string; group_service?: string }) => {
    const where = FULFILMENT_WORDS[(s.fulfilment === 'takeaway' ? 'takeaway' : 'dine_in')];
    return s.fulfilment === 'takeaway' ? where : `${where} · ${SERVICE_WORDS[s.group_service === 'buffet' ? 'buffet' : 'plated']}`;
  };

  return (
    <Modal wide title={`${b.contact_name || 'A group'}${b.reference ? ` · ${b.reference}` : ''}`} onClose={onClose}>
      <div style={{ display: 'grid', gap: '1rem' }}>
        <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <Badge tone={st.tone}>{st.label}</Badge>
          {ap !== 'none' && <Badge tone={approvalWords(ap).tone === 'default' ? undefined : approvalWords(ap).tone}>{approvalWords(ap).label}</Badge>}
          <span className="small dim">
            Booked {b.$createdAt ? dateTimeWords(b.$createdAt) : '-'}
            {b.email ? ` · ${b.email}` : ' · no email'}
            {` · ${money(b.total)}`}
          </span>
        </div>
        {b.note?.trim() && (
          <div className="small" style={{ paddingLeft: '0.6rem', borderLeft: '3px solid var(--brand)', whiteSpace: 'pre-wrap' }}>
            <strong>Their note:</strong> “{b.note.trim()}”
          </div>
        )}

        {/* The decision, first, because it is why most people open this. */}
        {pending && (
          <Card title="Your decision">
            <div style={{ display: 'grid', gap: '0.6rem' }}>
              <Input
                placeholder={`A line to ${b.contact_name || 'the guest'} (optional)`}
                value={line}
                onChange={(e) => setLine(e.target.value)}
              />
              {!declining ? (
                <div className="row" style={{ gap: '0.5rem' }}>
                  <Button variant="primary" loading={busy === 'confirm'} disabled={!!busy} onClick={() => void confirmIt()}>
                    Confirm booking
                  </Button>
                  <Button variant="ghost" disabled={!!busy} onClick={() => setDeclining(true)}>Decline…</Button>
                </div>
              ) : (
                <Notice tone="warn">
                  <div style={{ display: 'grid', gap: '0.5rem' }}>
                    <strong>Decline this booking? {b.contact_name || 'The guest'} is emailed straight away.</strong>
                    <label className="row" style={{ gap: '0.5rem', alignItems: 'flex-start' }}>
                      <input type="checkbox" checked={cancelToo} onChange={(e) => setCancelToo(e.target.checked)} style={{ marginTop: '0.2rem' }} />
                      <span>
                        Also cancel its {live.length || b.sittings || ''} meal time{(live.length || b.sittings) === 1 ? '' : 's'}, so the kitchen
                        does not cook them
                      </span>
                    </label>
                    <div className="row" style={{ gap: '0.5rem' }}>
                      <Button disabled={!!busy} onClick={() => setDeclining(false)}>Keep it</Button>
                      <Button variant="danger" loading={busy === 'decline'} disabled={!!busy} onClick={() => void declineIt()}>Decline</Button>
                    </div>
                  </div>
                </Notice>
              )}
            </div>
          </Card>
        )}

        {/* What the guest has asked for, beside the booking it is about. */}
        {requests.length > 0 && (
          <Card title={`The guest asked for a change (${requests.length})`}>
            <p className="small dim" style={{ marginTop: 0 }}>
              Nothing has changed yet. Change the orders or move a meal time, then mark it done.
            </p>
            {requests.map((c) => (
              <div key={c.$id} style={{ padding: '0.5rem 0', borderTop: '1px solid var(--border)' }}>
                <div className="small dim">{CHANGE_KIND_WORDS[c.kind as keyof typeof CHANGE_KIND_WORDS] ?? c.kind}</div>
                <p style={{ margin: '0.2rem 0 0.4rem', whiteSpace: 'pre-wrap' }}>{c.note}</p>
                <div className="row" style={{ gap: '0.5rem' }}>
                  <Input
                    placeholder={c.email ? `A line back to ${c.email} (optional)` : 'A note for the record (optional)'}
                    value={replies[c.$id] ?? ''}
                    onChange={(e) => setReplies({ ...replies, [c.$id]: e.target.value })}
                  />
                  <Button size="sm" variant="primary" loading={busy === c.$id} disabled={!!busy} onClick={() => void answer(c, 'done')}>Done</Button>
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void answer(c, 'refused')}>Cannot do it</Button>
                </div>
              </div>
            ))}
          </Card>
        )}

        <Card title="Meal times">
          {moved && (
            <Notice tone="warn">
              A meal time has moved and nobody has been told. When the times are right, use{' '}
              <strong>Send changes to guest</strong> below.
            </Notice>
          )}
          {sittings === null ? <Spinner /> : sittings.length === 0 ? (
            <p className="small dim" style={{ margin: 0 }}>No orders behind this booking.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Meal time</th><th>How</th><th className="num">Portions</th><th /></tr></thead>
                <tbody>
                  {sittings.map((s) => {
                    const why = sittingMoveProblem({
                      sitting: s,
                      to: moveTo[s.$id] ? new Date(moveTo[s.$id] as string) : null,
                    });
                    const off = ['CANCELLED', 'REJECTED'].includes(s.status);
                    return (
                      <tr key={s.$id}>
                        <td className="small">
                          {dateTimeWords(s.scheduled_for)}
                          <div className="dim">{s.order_no ?? '-'}{off ? ' · cancelled' : ''}</div>
                        </td>
                        <td className="small">{how(s)}</td>
                        <td className="num small">{portions[s.$id] ?? ''}</td>
                        <td>
                          {sittingIsMovable(s) ? (
                            <div className="row" style={{ gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                              <Input
                                type="datetime-local"
                                value={moveTo[s.$id] ?? ''}
                                onChange={(e) => setMoveTo((m) => ({ ...m, [s.$id]: e.target.value }))}
                              />
                              <Button size="sm" loading={busy === s.$id} disabled={!!why || !!busy} onClick={() => void move(s)}>Move</Button>
                              {/* Said as it is typed, not after pressing. */}
                              {why && <span className="small dim">{why}</span>}
                            </div>
                          ) : (
                            <span className="small dim">{sittingMoveProblem({ sitting: s, to: null })}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="small dim" style={{ marginBottom: 0 }}>
            To change the food on a meal time, edit its order on the Orders page.
          </p>
        </Card>

        <div className="row" style={{ gap: '1.5rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ display: 'grid', gap: '0.4rem' }}>
            <strong className="small">Booking sheet</strong>
            <div className="row" style={{ gap: '0.4rem' }}>
              <Button size="sm" loading={busy === 'sheet'} disabled={!!busy} onClick={() => void download(true)}>With prices</Button>
              {/* The one pinned up by the pass: no money on it. */}
              <Button size="sm" loading={busy === 'kitchen'} disabled={!!busy} onClick={() => void download(false)}>Kitchen sheet</Button>
            </div>
          </div>
          <div style={{ display: 'grid', gap: '0.4rem' }}>
            <strong className="small">Messages</strong>
            <div className="row" style={{ gap: '0.4rem' }}>
              <Button size="sm" variant={moved ? 'primary' : undefined} disabled={!!busy} onClick={() => setSendingChanges(true)}>
                Send changes to guest
              </Button>
              {teamAsked || resendPendingFor(b) ? (
                <span className="small dim">Emailing the team…</span>
              ) : (
                <Button size="sm" loading={busy === 'team'} disabled={!!busy} onClick={() => void emailTeam()}>Email the team again</Button>
              )}
            </div>
          </div>
        </div>

        {sendingChanges && (
          <Card title="Send changes to guest">
            <p className="small dim" style={{ marginTop: 0 }}>
              The guest gets the booking as it stands now, with the sheet, and is asked to agree to it. Say what
              changed in a sentence; they read this.
            </p>
            <Textarea
              rows={3}
              value={changeNote}
              onChange={(e) => setChangeNote(e.target.value)}
              placeholder="Your Monday breakfast is now at 08:30, as agreed on the phone."
            />
            <div className="row" style={{ gap: '0.5rem', marginTop: '0.5rem' }}>
              <Button disabled={!!busy} onClick={() => setSendingChanges(false)}>Not now</Button>
              <Button variant="primary" loading={busy === 'changes'} disabled={!!busy} onClick={() => void sendChanges()}>Send to guest</Button>
            </div>
          </Card>
        )}
      </div>
    </Modal>
  );
}
