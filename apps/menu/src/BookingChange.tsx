import { useEffect, useState } from 'react';
import { Button, Field, Input, Notice, Select, Spinner, Textarea } from '@snpos/ui';
import {
  loadGroupBooking, requestBookingChange, changeProblem, changeWindowWords, requestProblem,
  CHANGE_KIND_WORDS, humanError, ensureGuestSession, dateWords,
  cancelGroupBooking, bookingIsCancelled,
} from '@snpos/core';
import type { GroupBookingDoc } from '@snpos/core';

/**
 * A group asking for something to be changed.
 *
 * A booking made three weeks out will change. Numbers move, somebody turns
 * vegetarian, a coach arrives an hour late. The only route before this was to
 * ring, which means it lands on whoever picks up and is written on whatever is
 * nearest — and a party of forty whose count moved by six is six meals cooked
 * or six meals short.
 *
 * A REQUEST, and the page says so. Nothing here edits an order: the tickets
 * are what the kitchen is cooking, and a guest who could rewrite them the day
 * before service could empty a pass with nobody having agreed. It is a message
 * with the booking attached, and somebody answers it.
 */
export function BookingChange({ bookingId, onClose }: { bookingId: string; onClose: () => void }) {
  const [booking, setBooking] = useState<GroupBookingDoc | null | 'missing'>(null);
  const [kind, setKind] = useState('numbers');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  useEffect(() => {
    void ensureGuestSession().catch(() => undefined);
    void loadGroupBooking(bookingId).then((b) => setBooking(b ?? 'missing')).catch(() => setBooking('missing'));
  }, [bookingId]);

  if (booking === null) return <div style={{ padding: '3rem 1rem' }}><Spinner /></div>;

  if (booking === 'missing') {
    return (
      <div className="status-page">
        <h1>Booking</h1>
        <Notice tone="warn">
          We cannot find that booking. The link may have been mistyped, or it may belong to a booking that has
          since been removed. Please ring the restaurant.
        </Notice>
        <Button onClick={onClose} style={{ marginTop: '1rem' }}>Back to the menu</Button>
      </div>
    );
  }

  // Checked on the way in, so the form is not offered where it cannot be used.
  const shut = changeProblem(booking.first_at ?? '');

  /*
    Calling the whole thing off.

    Behind a question, because it cannot be undone from here: the sittings are
    cancelled and the times they were holding go back to whoever wants them.
    Asked for rather than done — the server decides, and refuses anything
    inside five days however this page was reached. See cancelGroupBooking.
  */
  const cancelAll = async () => {
    if (shut) { setProblem(shut); return; }
    if (!confirm(
      'Cancel this whole booking? Every sitting comes off, the times go back to anybody else who wants them, '
      + 'and it cannot be undone from here.',
    )) return;
    setBusy(true);
    setProblem(null);
    try {
      const { asked } = await cancelGroupBooking(bookingId);
      if (asked === 0) {
        setProblem('There is nothing left on this booking to cancel.');
        return;
      }
      // Written by the server a moment later, so it is read back rather than
      // assumed: a cancellation the server refused must not read as done.
      await new Promise((r) => { setTimeout(r, 1500); });
      setCancelled(await bookingIsCancelled(bookingId));
      if (!(await bookingIsCancelled(bookingId))) {
        setProblem(
          'The restaurant has not accepted the cancellation. That usually means the first meal is now inside '
          + 'five days. Please ring them.',
        );
      }
    } catch (e) {
      setProblem(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const says = shut ?? requestProblem(kind, note);
    if (says) { setProblem(says); return; }
    setBusy(true);
    setProblem(null);
    try {
      await requestBookingChange({ booking, kind, note });
      setSent(true);
    } catch (e) {
      setProblem(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="status-page">
      <h1>Your booking</h1>
      <p className="meta">
        {booking.contact_name}{booking.reference ? ` · ${booking.reference}` : ''}
        {booking.sittings ? ` · ${booking.sittings} sitting${booking.sittings === 1 ? '' : 's'}` : ''}
        {booking.portions ? `, ${booking.portions} portions` : ''}
      </p>

      {cancelled ? (
        <Notice tone="ok">
          <strong>This booking is cancelled.</strong> Every sitting has come off and the times have gone back.
          Nothing is owed. If that was a mistake, ring the restaurant — it cannot be undone from here.
        </Notice>
      ) : sent ? (
        <Notice tone="ok">
          <strong>Your request has been sent.</strong> Somebody will look at it and come back to you
          {booking.email ? ` at ${booking.email}` : ''}. Nothing has changed on the booking yet — the kitchen is
          still working to what you ordered until it is agreed.
        </Notice>
      ) : shut ? (
        <Notice tone="warn">{shut}</Notice>
      ) : (
        <>
          {/* Said before they type, not after. */}
          <Notice tone="info">
            This asks for a change; it does not make one. The kitchen goes on working to what you ordered until
            somebody here agrees to it, and you will hear back either way.{' '}
            {changeWindowWords(booking.first_at ?? '', (d) => dateWords(d))}
          </Notice>

          <Field label="What would you like to change?">
            <Select value={kind} onChange={(e) => { setKind(e.target.value); setProblem(null); }}>
              {Object.entries(CHANGE_KIND_WORDS).map(([k, words]) => (
                <option key={k} value={k}>{words}</option>
              ))}
            </Select>
          </Field>

          <Field
            label="In your own words"
            hint="The detail is what saves a telephone call: which sitting, how many, and what instead."
          >
            <Textarea
              rows={5}
              value={note}
              onChange={(e) => { setNote(e.target.value); setProblem(null); }}
              placeholder="Eight more for Tuesday lunch, and one of them cannot have nuts."
            />
          </Field>

          {booking.email && (
            <Field label="We will reply to">
              <Input value={booking.email} readOnly />
            </Field>
          )}

          {problem && <Notice tone="warn">{problem}</Notice>}

          <Button variant="primary" loading={busy} onClick={() => void send()} style={{ width: '100%' }}>
            Send this request
          </Button>

          {/* Last, and set apart. Cancelling is the one thing on this page
              that happens rather than being asked for, and it is not what
              most people came here to do. */}
          <hr style={{ margin: '1.5rem 0', border: 0, borderTop: '1px solid var(--border)' }} />
          <p className="meta" style={{ marginTop: 0 }}>
            Not coming at all? Cancelling takes every sitting off and gives the times back.
          </p>
          <Button variant="danger" disabled={busy} onClick={() => void cancelAll()} style={{ width: '100%' }}>
            Cancel the whole booking
          </Button>
        </>
      )}

      <Button variant="ghost" onClick={onClose} style={{ marginTop: '1rem' }}>Back to the menu</Button>
    </div>
  );
}
