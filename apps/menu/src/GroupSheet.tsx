import { useMemo, useState } from 'react';
import { Button, Input, Field, Notice, FormError, Textarea } from '@snpos/ui';
import { QtyBox } from './QtyBox';
import { GroupSteps } from './GroupDays';
import {
  formatMoney, lineTotal, createOrder, featureConfig, isProvisionalOrderNo,
  ensureGuestSession, humanError, selfOrderModule, isSlotFull,
  bookingTotals, bookingProblem, dayKeyOf, longDayWords, timeWords,
  portionsAtBiggest, serviceOf, mealServiceWords,
  db, DB_ID, Query, recordGroupBooking,
} from '@snpos/core';
import type {
  CartLine, Settings, Venue, FeatureMap, GroupMeal, MealPricing, Order,
} from '@snpos/core';

/**
 * Step three of a group booking: check it all, say who it is for, and send.
 *
 * ONE PAGE, every meal time on it. This used to be a pop-up with a tab per
 * meal time and the name and email on a last tab, so checking a booking of
 * four meal times meant five taps, and the first a guest learnt that an email
 * was needed was when Send refused. Now the whole booking reads top to
 * bottom — each meal time with its food and its packing, then who it is for,
 * then the total beside the button — and each meal time has a Change that
 * goes back to the menu with it chosen.
 *
 * Eat here or packed is no longer asked here; it is chosen with the time, on
 * step one, where it cannot be skipped. See GroupDays.
 *
 * The rules are in core, see pricing.ts. This shows them and sends the
 * booking: one order per meal time, tied together by a booking id, each
 * scheduled for its own moment so the kitchen is silent until it matters.
 */
export function GroupSheet({
  meals, setMeals, settings, venue, features, onClose, onEditMeal, onPlaced, onError,
}: {
  meals: GroupMeal[];
  setMeals: (fn: (m: GroupMeal[]) => GroupMeal[]) => void;
  settings: Settings;
  venue: Venue;
  features: FeatureMap;
  /** Back to the menu, as it was. */
  onClose: () => void;
  /** Back to the menu with this meal time chosen, to change its food. */
  onEditMeal: (key: string) => void;
  /**
   * Everything the sent page needs, because this page is gone by then.
   *
   * `bookingId` is null when the booking record could not be written, which
   * is also what stops both emails — so the page says so rather than
   * promising a confirmation nobody will get.
   */
  onPlaced: (sent: {
    booked: { id: string; orderNo: string; at: string; how: string }[];
    bookingId: string | null;
    contactName: string;
    email: string;
    reference: string;
    portions: number;
    total: number;
  }) => void;
  onError: (message: string) => void;
}) {
  const needReference = featureConfig(features, 'group_orders', 'require_reservation_number', true);
  const reservationLabel = featureConfig<string>(
    features, 'group_orders', 'reservation_label', 'Hotel reservation number',
  );
  const minGroup = featureConfig(features, 'group_orders', 'min_group_size', 0);
  const packFee = featureConfig(features, 'group_orders', 'pack_fee', 0);
  const slotCapacity = featureConfig(features, 'preorders', 'slot_capacity', 0);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [groupRef, setGroupRef] = useState('');
  /**
   * Anything true of the whole booking rather than of one dish: the coach
   * that leaves at two, the high chair, the cake at the end. Every dish has
   * its own box for "no pepper on this one".
   */
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const booking = useMemo(
    () => bookingTotals(meals, settings, packFee),
    [meals, settings, packFee],
  );

  const money = (n: number) => formatMoney(n, settings);

  /*
    How big the party is, counted rather than asked: the biggest meal time.
    A box asking "how many people?" was a second answer to a question the
    order had already answered, and the only gate on the smallest-group rule.
  */
  const partySize = portionsAtBiggest(meals);

  const setQty = (key: string, lineKey: string, qty: number) =>
    setMeals((all) => all.map((m) => (m.key === key
      ? { ...m, lines: m.lines.map((l: CartLine) => (l.key === lineKey ? { ...l, qty } : l)).filter((l: CartLine) => l.qty > 0) }
      : m)));

  /**
   * Send the booking: one order per meal time.
   *
   * In the order they will be eaten, and one after another rather than all at
   * once. Each order takes an order number and, where the slot is capped, a
   * place in it; firing four of those off together is four races against
   * each other for numbers that are worked out from the last one.
   *
   * A meal time that fails stops the rest. The ones already written stay —
   * they are real orders the kitchen can see — and the person is told how far
   * it got, rather than being left guessing whether any of it landed.
   */
  const send = async () => {
    const said = bookingProblem(meals, {
      reference: groupRef,
      needReference,
      referenceLabel: reservationLabel,
      minSize: minGroup,
      contactName: name,
      email,
    });
    if (said) {
      setProblem(said);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    setBusy(true);
    setProblem(null);
    const bookingId = `gb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    /** Whether the booking record landed, which is what sends both emails. */
    let recorded = false;
    const booked: { id: string; orderNo: string; at: string; how: string }[] = [];

    try {
      await ensureGuestSession();
      for (const { meal, totals } of booking.meals) {
        const { order } = await createOrder({
          module: selfOrderModule(settings),
          venueId: venue.$id,
          lines: meal.lines.filter((l: CartLine) => l.qty > 0),
          settings,
          guest: true,
          channel: 'takeaway',
          placedBy: name.trim(),
          group: {
            reference: groupRef.trim(),
            size: partySize,
            contactName: name.trim(),
            bookingId,
          },
          customer: { name: name.trim() || undefined, email: email.trim() || undefined },
          fulfilment: meal.fulfilment,
          groupService: serviceOf(meal) ?? undefined,
          packFee: totals.packFee,
          scheduledFor: new Date(meal.at),
          slotCapacity,
          /* No opening hours. A meal time is agreed with the kitchen, which
             opens for it; what the doors are doing this evening has nothing
             to say about a booking three weeks out. */
        });
        booked.push({ id: order.$id, orderNo: order.order_no, at: meal.at, how: mealServiceWords(meal) });
      }

      // The numbers are settled server-side a moment after each order lands.
      // Read them back so the hotel writes down what the kitchen will call out.
      const settled = await Promise.all(booked.map(async (b, i) => {
        if (!isProvisionalOrderNo(b.orderNo)) return b;
        const found = await db.listDocuments(DB_ID, 'orders', [
          Query.equal('group_booking_id', bookingId), Query.limit(50),
        ]).catch(() => null);
        const mine = (found?.documents as unknown as Order[] | undefined)
          ?.filter((o) => !isProvisionalOrderNo(o.order_no))
          .sort((x, y) => (x.scheduled_for ?? '').localeCompare(y.scheduled_for ?? ''));
        return { ...b, orderNo: mine?.[i]?.order_no ?? b.orderNo };
      }));

      /*
        The booking itself, written last, once every meal time has landed: a
        booking row for orders that failed would confirm something that is not
        booked. Writing it is what sends the emails, one to the team and one
        to the guest.

        Never fatal. The food is ordered and the kitchen has it; failing the
        whole booking here would tell somebody their party is not booked when
        it is. But it is not silent either: the page says the email failed.
      */
      await recordGroupBooking({
        bookingId,
        venueId: venue.$id,
        reference: groupRef.trim(),
        contactName: name.trim(),
        email: email.trim(),
        size: partySize,
        sittings: booking.meals.length,
        portions: booking.portions,
        total: booking.total,
        currencyCode: settings.currency_code,
        orderNos: settled.map((b) => b.orderNo),
        firstAt: booking.meals[0]?.meal.at ?? '',
        lastAt: booking.meals[booking.meals.length - 1]?.meal.at ?? '',
        note: note.trim(),
      })
        .then(() => { recorded = true; })
        .catch((e) => {
          onError(`The booking was placed but its confirmation could not be sent: ${humanError(e)}`);
        });

      setMeals(() => []);
      onPlaced({
        booked: settled,
        bookingId: recorded ? bookingId : null,
        contactName: name.trim(),
        email: email.trim(),
        reference: groupRef.trim(),
        portions: booking.portions,
        total: booking.total,
      });
    } catch (e) {
      const message = isSlotFull(e)
        ? (e as Error).message
        : humanError(e) || 'Could not send the booking. Please try again.';
      const done = booked.length;
      setProblem(done > 0
        ? `${message} ${done} meal time${done === 1 ? '' : 's'} of the booking went through before this; the rest have not. Please tell the front desk.`
        : message);
      onError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="status-page group-review">
      <GroupSteps at={3} />
      <h1>Check and send</h1>
      <FormError message={problem} />

      {meals.length === 0 ? (
        <Notice tone="info">
          Nothing on the booking yet. Go back, add a meal time, and choose the food for it.
        </Notice>
      ) : (
        <>
          {booking.meals.map(({ meal, totals }: { meal: GroupMeal; totals: MealPricing }) => (
            <section key={meal.key} className="review-meal">
              <div className="spread" style={{ alignItems: 'baseline' }}>
                <h2>{longDayWords(meal.at)}, {timeWords(meal.at)}</h2>
                <Button size="sm" variant="ghost" onClick={() => onEditMeal(meal.key)}>Change</Button>
              </div>
              <div className="meta">
                {mealServiceWords(meal)} · {totals.portions} portion{totals.portions === 1 ? '' : 's'}
              </div>

              {meal.lines.length === 0 ? (
                <Notice tone="warn">No food on this meal time yet. Press Change to add some, or remove it.</Notice>
              ) : meal.lines.map((line: CartLine) => (
                <div className="line" key={line.key}>
                  <div>
                    <div style={{ fontWeight: 550 }}>{line.name}</div>
                    {line.addons.length > 0 && <div className="meta">{line.addons.map((a) => a.name).join(', ')}</div>}
                    {line.notes && <div className="meta">&ldquo;{line.notes}&rdquo;</div>}
                    <div style={{ marginTop: '0.4rem' }}>
                      <QtyBox qty={line.qty} onChange={(q) => setQty(meal.key, line.key, q)} least={0} label={line.name} />
                    </div>
                  </div>
                  <div style={{ fontWeight: 600 }}>{formatMoney(lineTotal(line), settings)}</div>
                </div>
              ))}

              {/* The boxes, on a line of their own, so the dishes and the
                  total under them agree. */}
              {totals.packFee > 0 && (
                <div className="line meta">
                  <span>Packing, {totals.portions} × {money(totals.packFee / Math.max(1, totals.portions))}</span>
                  <span>{money(totals.packFee)}</span>
                </div>
              )}
              <div className="spread" style={{ fontWeight: 600, paddingTop: '0.4rem' }}>
                <span>This meal time</span><span>{money(totals.total)}</span>
              </div>
            </section>
          ))}

          <section className="review-who">
            <h2>Who is it for?</h2>
            <Field label="Name for the booking" hint="So the kitchen and the front desk know whose it is.">
              <Input value={name} onChange={(e) => { setName(e.target.value); setProblem(null); }} />
            </Field>
            <Field label={reservationLabel} hint={needReference ? 'Needed for a group booking.' : 'Optional.'}>
              <Input value={groupRef} onChange={(e) => { setGroupRef(e.target.value); setProblem(null); }} />
            </Field>
            {/* Required here, optional on an ordinary order: a party booked
                three weeks out has nothing else to hold. */}
            <Field label="Email" hint="We email you a copy now, and again once the booking is confirmed.">
              <Input type="email" value={email} onChange={(e) => { setEmail(e.target.value); setProblem(null); }} />
            </Field>
            <Field
              label="Anything else we should know? (optional)"
              hint="About the booking as a whole: a high chair, a wheelchair, a coach to catch, a cake at the end. For one dish, use the box on that dish."
            >
              <Textarea rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </section>

          <section className="review-total">
            <div className="spread"><span>Food</span><span>{money(booking.subtotal)}</span></div>
            {booking.packFees > 0 && (
              <div className="spread">
                <span>Packing, {booking.packedPortions} portion{booking.packedPortions === 1 ? '' : 's'}</span>
                <span>{money(booking.packFees)}</span>
              </div>
            )}
            {booking.service > 0 && (
              <div className="spread"><span>Service</span><span>{money(booking.service)}</span></div>
            )}
            <div className="spread grand">
              <span>{booking.meals.length} meal time{booking.meals.length === 1 ? '' : 's'}, {booking.portions} portions</span>
              <span>{money(booking.total)}</span>
            </div>
            <Button variant="primary" loading={busy} onClick={() => void send()} style={{ width: '100%' }}>
              Send booking · {money(booking.total)}
            </Button>
            <p className="meta" style={{ margin: 0 }}>
              Nothing to pay now. We will check the booking and email you to confirm it. Each meal time is paid
              on the day.
            </p>
          </section>
        </>
      )}

      <Button variant="ghost" onClick={onClose} disabled={busy} style={{ marginTop: '0.8rem' }}>
        Back to the menu
      </Button>
    </div>
  );
}

/** A meal time that has just been added, ready for dishes. */
export const newMeal = (at: Date): GroupMeal => ({
  key: `m-${dayKeyOf(at)}-${at.getHours()}${at.getMinutes()}-${Math.random().toString(36).slice(2, 6)}`,
  at: at.toISOString(),
  fulfilment: 'dine_in',
  lines: [],
});
