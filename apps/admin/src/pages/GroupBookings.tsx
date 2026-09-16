import { useEffect, useState } from 'react';
import { Card, Badge, Button, Notice, Spinner, Input, useToast } from '@snpos/ui';
import { humanError } from '../lib';
import {
  groupBookingsBetween, resendBookingNotice, resendPendingFor,
  sittingsOf, moveSitting, sittingMoveProblem, sittingIsMovable,
  sendBookingForApproval, approvalState, approvalWords, approvalRequestProblem,
  loadFeatures, featureConfig,
  formatMoney, dateTimeWords, forDateTimeInput, downloadFile, db, DB_ID, Query,
} from '@snpos/core';
import type { GroupBookingDoc, BookingSitting, FeatureMap } from '@snpos/core';
/*
  THE SAME BUILDER THE EMAIL USES, not a second one that looks like it.

  A download that quietly says something different from the copy the kitchen
  was sent is the worst possible version of this feature: two documents about
  one party, both plausible, and no way to tell which the kitchen cooked from.
  So the browser runs the generator the notify job runs — it takes its
  database as an argument and carries no Buffer, which is what makes that
  possible. See functions/notify/src/booking-sheet.js.
*/
import { bookingSittings, bookingSheetPdf } from '../../../../functions/notify/src/booking-sheet.js';
import { useSession } from '../session';

/** The last thirty days, as the date boxes want them. */
const dayInput = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Every group booking, and a way to tell the team about one again.
 *
 * THIS PAGE EXISTS BECAUSE A MESSAGE FAILED AND THERE WAS NOWHERE TO GO.
 *
 * A booking used to be reachable in exactly one place — the Waiting page,
 * while it was still waiting to be agreed to. The moment somebody approved,
 * refused or cancelled it, it existed in the database and on no screen in the
 * system. That is tolerable while the emails work. When one does not, it
 * means a party of forty is in the diary, the guest has a confirmation, and
 * nobody here has heard of it, with nothing to open and nothing to press.
 *
 * So: the list, and one button. "Send to the team again" writes a request on
 * the booking, and the background job sends it — one message per person, so
 * one bad address costs that address and nobody else. See sendToEach.
 */
export function GroupBookingsPage() {
  const toast = useToast();
  const { settings, profile } = useSession();
  const [rows, setRows] = useState<GroupBookingDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [asked, setAsked] = useState<Set<string>>(new Set());

  /** Which booking is opened out into its sittings, and what they are. */
  const [open, setOpen] = useState<string | null>(null);
  const [openSittings, setOpenSittings] = useState<BookingSitting[] | null>(null);
  /** The new time typed against one sitting, while it is being decided. */
  const [moveTo, setMoveTo] = useState<Record<string, string>>({});
  /** Bookings whose diary has been changed since the page loaded. See the nudge. */
  const [moved, setMoved] = useState<Set<string>>(new Set());
  const [features, setFeatures] = useState<FeatureMap>({});

  useEffect(() => { void loadFeatures().then(setFeatures).catch(() => undefined); }, []);

  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return dayInput(d);
  });
  const [to, setTo] = useState(() => dayInput(new Date()));

  const load = async () => {
    setError(null);
    const found = await groupBookingsBetween(
      new Date(`${from}T00:00:00`).toISOString(),
      new Date(`${to}T23:59:59`).toISOString(),
    );
    setRows(found);
  };

  useEffect(() => {
    setRows(null);
    void load().catch((e) => setError(humanError(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  const sendAgain = async (b: GroupBookingDoc) => {
    setBusy(b.$id);
    try {
      await resendBookingNotice(b.$id);
      /*
        Said as a request, because that is what it is. The job does the
        sending a moment later, and promising "sent" for something that has
        not left yet is the kind of reassurance that stops people checking.
      */
      setAsked((s) => new Set(s).add(b.$id));
      toast('Asked for it to go to the team again. It goes out in the next minute.');
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setBusy(null);
    }
  };

  /**
   * The sheet, built here, from the orders as they stand right now.
   *
   * Which is what makes one button serve two jobs: the booking as it came in,
   * and the booking after somebody changed it. There is no stored copy to go
   * stale — the sheet is made from the orders every time, so a download after
   * a revision IS the revised sheet.
   */
  const download = async (b: GroupBookingDoc) => {
    setBusy(b.$id);
    try {
      const sittings = await bookingSittings({ db, DB_ID, Query, booking: b });
      if (sittings.length === 0) {
        toast('That booking has no orders behind it to print.', 'err');
        return;
      }
      const stem = String(b.reference || b.contact_name || b.$id)
        .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'booking';
      downloadFile(
        `group-booking-${stem}.pdf`,
        bookingSheetPdf({
          settings: settings ?? {},
          // The masthead falls back to the restaurant's name, which is the
          // same thing on a business with one venue and is what the emailed
          // copy says anyway.
          venue: null,
          booking: b,
          sittings,
          accent: settings?.primary_color ?? '#0f766e',
        }),
        'application/pdf',
      );
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setBusy(null);
    }
  };

  /** Open a booking out into its sittings, or shut it again. */
  const toggle = async (b: GroupBookingDoc) => {
    if (open === b.$id) { setOpen(null); setOpenSittings(null); return; }
    setOpen(b.$id);
    setOpenSittings(null);
    try {
      const found = await sittingsOf(b.$id);
      setOpenSittings(found);
      setMoveTo(Object.fromEntries(found.map((s) => [s.$id, forDateTimeInput(s.scheduled_for)])));
    } catch (e) {
      toast(humanError(e), 'err');
      setOpen(null);
    }
  };

  /**
   * Move one sitting to another hour.
   *
   * The refusals are worked out here as well, so the reason shows under the
   * box as it is typed rather than after pressing a button. The same rule runs
   * again in moveSitting — this page's clock is the browser's and its copy of
   * the sitting is however old the page is.
   */
  const move = async (b: GroupBookingDoc, s: BookingSitting) => {
    const typed = moveTo[s.$id] ?? '';
    const when = typed ? new Date(typed) : null;
    const why = sittingMoveProblem({
      sitting: s,
      to: when,
      daysAhead: featureConfig(features, 'preorders', 'max_days_ahead', 0),
    });
    if (why) { toast(why, 'err'); return; }

    setBusy(s.$id);
    try {
      await moveSitting({
        booking: b,
        sitting: s,
        to: when as Date,
        slotCapacity: featureConfig(features, 'preorders', 'slot_capacity', 0),
        by: profile?.$id ?? '',
        byRole: profile?.role ?? '',
      });
      toast(`Sitting ${s.order_no ?? ''} moved.`);
      /*
        The party and the kitchen are both still holding the old time. Saying
        so is the whole reason this is not sent automatically: a late coach
        moves four sittings, and a message per move would reach them four
        times with three of them wrong.
      */
      setMoved((m) => new Set(m).add(b.$id));
      setOpenSittings(await sittingsOf(b.$id));
      await load().catch(() => undefined);
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Send the booking as it now stands to the party, to be agreed to.
   *
   * Asked for, not sent from here — the job builds the revised sheet and
   * sends it, the same way the first notice went, so the party's copy and the
   * kitchen's copy can never be built by two different pieces of code.
   *
   * What changed is typed rather than worked out. A machine-written diff of a
   * booking reads as "sitting 2: 12:30 → 19:00", which is true and tells a
   * hotel manager nothing; "your Thursday lunch is now Thursday dinner, as
   * agreed on the phone" is the sentence that stops them ringing to ask.
   */
  const sendForApproval = async (b: GroupBookingDoc) => {
    const why = approvalRequestProblem(b);
    if (why) { toast(why, 'err'); return; }

    const said = window.prompt(
      'What changed? The party reads this, so say it in a sentence. Leave it blank to send the booking with no note.',
      '',
    );
    // Cancelled, as opposed to deliberately left empty.
    if (said === null) return;

    setBusy(b.$id);
    try {
      await sendBookingForApproval({ bookingId: b.$id, note: said });
      toast('Sent to the party to be agreed to. It goes out in the next minute.');
      setMoved((m) => { const n = new Set(m); n.delete(b.$id); return n; });
      await load().catch(() => undefined);
      // The job answers in seconds; one look, so the row settles itself
      // rather than sitting on "Sending…" until somebody reloads.
      window.setTimeout(() => { void load().catch(() => undefined); }, 8_000);
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setBusy(null);
    }
  };

  const money = (n?: number) => (settings ? formatMoney(n ?? 0, settings) : String(n ?? 0));

  const tone = (s?: string) => {
    if (s === 'approved') return 'ok' as const;
    if (s === 'refused' || s === 'cancelled') return 'warn' as const;
    return undefined;
  };

  /**
   * One booking opened out: every sitting, and the hour each is booked for.
   *
   * A sitting the kitchen has not been shown yet gets a box and a Move button.
   * One it already has gets a sentence saying why not, rather than a disabled
   * control that leaves somebody clicking at it — the reason is the useful
   * part, and it tells them what to do instead.
   */
  const sittingRows = (b: GroupBookingDoc) => {
    if (openSittings === null) return <Spinner />;
    if (openSittings.length === 0) {
      return <p className="small dim" style={{ margin: '0.6rem 0' }}>No orders behind this booking.</p>;
    }
    return (
      <div style={{ padding: '0.4rem 0' }}>
        {moved.has(b.$id) && (
          <Notice tone="warn">
            The diary has changed and nobody has been told. Press <strong>Send for approval</strong> when the
            times are right: the party gets the revised sheet and agrees to it, and the team is told once
            they have. <strong>Send again</strong> tells the team without asking the party.
          </Notice>
        )}
        <table className="data" style={{ margin: '0.4rem 0 0' }}>
          <tbody>
            {openSittings.map((s) => {
              const why = sittingMoveProblem({
                sitting: s,
                to: moveTo[s.$id] ? new Date(moveTo[s.$id] as string) : null,
                daysAhead: featureConfig(features, 'preorders', 'max_days_ahead', 0),
              });
              return (
                <tr key={s.$id}>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>
                    <strong>{s.order_no ?? '-'}</strong>
                    <div className="dim">{s.status}</div>
                  </td>
                  <td className="small">
                    {dateTimeWords(s.scheduled_for)}
                    {s.guest_count ? <div className="dim">{s.guest_count} covers</div> : null}
                  </td>
                  <td>
                    {sittingIsMovable(s) ? (
                      <div className="row" style={{ gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        <Input
                          type="datetime-local"
                          value={moveTo[s.$id] ?? ''}
                          onChange={(e) => setMoveTo((m) => ({ ...m, [s.$id]: e.target.value }))}
                        />
                        <Button
                          size="sm"
                          loading={busy === s.$id}
                          disabled={!!why}
                          onClick={() => void move(b, s)}
                        >
                          Move
                        </Button>
                        {/* Said as it is typed, not after pressing. The commonest
                            refusal by far is a time the kitchen could not start
                            for, and it names the hour it would have needed. */}
                        {why && <span className="small dim">{why}</span>}
                      </div>
                    ) : (
                      <span className="small dim">
                        {sittingMoveProblem({ sitting: s, to: null })}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  if (error) return <Notice>{error}</Notice>;

  return (
    <>
      <h1>Group bookings</h1>
      <p className="dim" style={{ maxWidth: '60ch' }}>
        Every booking a group has sent, whether or not it has been agreed to. Open one to see its sittings and
        move any the kitchen has not started on yet. If the team did not hear about a booking, send it again
        from here — it goes to every admin and manager with an email address, plus anyone named under
        Features, Group ordering.
      </p>

      <div className="row" style={{ gap: '0.6rem', alignItems: 'center', margin: '0.9rem 0' }}>
        <span className="dim small">From</span>
        <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <span className="dim small">To</span>
        <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
      </div>

      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Card pad>
          <p style={{ margin: 0 }}>No group bookings in these dates.</p>
        </Card>
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Booked</th>
                  <th>Who</th>
                  <th>Sittings</th>
                  <th className="num">Total</th>
                  <th>State</th>
                  <th>Party agreed?</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => [
                  <tr key={b.$id}>
                    <td className="small dim">{b.$createdAt ? dateTimeWords(b.$createdAt) : '-'}</td>
                    <td>
                      <strong>{b.contact_name || '-'}</strong>
                      {b.reference && <div className="small dim">{b.reference}</div>}
                      {b.email && <div className="small dim">{b.email}</div>}
                    </td>
                    <td className="small">
                      <button type="button" className="linky" onClick={() => void toggle(b)}>
                        {b.sittings ?? 0} · {b.portions ?? 0} portions
                      </button>
                      {b.first_at && <div className="dim">{dateTimeWords(b.first_at)}</div>}
                    </td>
                    <td className="num" style={{ fontWeight: 650 }}>{money(b.total)}</td>
                    <td><Badge tone={tone(b.status)}>{b.status ?? 'pending'}</Badge></td>
                    {/* Where a revision has got to, which is a different
                        question from whether the house agreed to the booking
                        in the first place. Both are shown, because a booking
                        can be approved here and not yet agreed to there. */}
                    <td className="small">
                      <Badge tone={approvalWords(approvalState(b)).tone === 'default'
                        ? undefined
                        : approvalWords(approvalState(b)).tone}
                      >
                        {approvalWords(approvalState(b)).label}
                      </Badge>
                      {approvalState(b) === 'approved' && b.approval_given_at && (
                        <div className="dim">{dateTimeWords(b.approval_given_at)}</div>
                      )}
                    </td>
                    <td>
                      {/* Pending from the moment it is asked for until the job
                          clears it, so pressing twice does not send twice. */}
                      <div className="row" style={{ gap: '0.35rem', justifyContent: 'flex-end' }}>
                        <Button size="sm" variant="ghost" onClick={() => void toggle(b)}>
                          {open === b.$id ? 'Hide sittings' : 'Sittings'}
                        </Button>
                        {/* Built from the orders as they stand, so this is the
                            revised sheet the moment anything is revised. */}
                        <Button size="sm" variant="ghost" loading={busy === b.$id} onClick={() => void download(b)}>
                          Download
                        </Button>
                        {/* Primary once the diary has been changed: everybody
                            is holding a sheet that is now wrong, and the party
                            has not agreed to what replaced it. */}
                        <Button
                          size="sm"
                          variant={moved.has(b.$id) ? 'primary' : 'ghost'}
                          loading={busy === b.$id}
                          onClick={() => void sendForApproval(b)}
                        >
                          Send for approval
                        </Button>
                        {asked.has(b.$id) || resendPendingFor(b) ? (
                          <span className="small dim">Going out…</span>
                        ) : (
                          <Button
                            size="sm"
                            /* Once the diary has been changed, everybody is
                               holding a sheet that is now wrong, so this is
                               the button that matters rather than one of three. */
                            variant={moved.has(b.$id) ? 'primary' : undefined}
                            loading={busy === b.$id}
                            onClick={() => void sendAgain(b)}
                          >
                            Send again
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>,
                  open === b.$id ? (
                    <tr key={`${b.$id}-sittings`}>
                      <td colSpan={7} style={{ background: 'var(--surface-2, rgba(127,127,127,0.06))' }}>
                        {sittingRows(b)}
                      </td>
                    </tr>
                  ) : null,
                ])}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
