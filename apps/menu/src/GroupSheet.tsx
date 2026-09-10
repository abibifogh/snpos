import { useMemo, useState } from 'react';
import { Button, Modal, Input, Field, Notice, Select, FormError, Badge } from '@snpos/ui';
import {
  formatMoney, lineTotal, createOrder, featureConfig, isProvisionalOrderNo,
  ensureGuestSession, humanError, selfOrderModule, isSlotFull,
  bookingTotals, bookingProblem, packWords, dayWords, FULFILMENT_WORDS, dayKeyOf, longDayWords, timeWords,
  db, DB_ID, Query,
} from '@snpos/core';
import type {
  CartLine, Settings, Venue, FeatureMap, GroupDay, DayPricing, Fulfilment, Order,
} from '@snpos/core';

/**
 * A group that is staying, booking every day of it at once.
 *
 * Kept apart from the ordinary cart sheet on purpose. A walk-in has one
 * basket and one question, "where are you sitting"; a hotel booking a party
 * for four nights has a basket per night, a different answer per night about
 * whether they are eating here or taking it away, and one bill for the lot.
 * Folding both into one screen would make the common case worse to serve the
 * rare one.
 *
 * The rules are in core, see group-booking.ts. This shows them and sends the
 * booking: one order per day, tied together by a booking id, each scheduled
 * for its own moment so the kitchen is silent until the morning it matters.
 */
export function GroupSheet({
  days, setDays, settings, venue, features, onClose, onPlaced, onError,
}: {
  days: GroupDay[];
  setDays: (fn: (d: GroupDay[]) => GroupDay[]) => void;
  settings: Settings;
  venue: Venue;
  features: FeatureMap;
  onClose: () => void;
  onPlaced: (booked: { id: string; orderNo: string; at: string }[]) => void;
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
  const [groupSize, setGroupSize] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const booking = useMemo(
    () => bookingTotals(days, settings, packFee),
    [days, settings, packFee],
  );

  const money = (n: number) => formatMoney(n, settings);

  const setDay = (key: string, patch: Partial<GroupDay>) =>
    setDays((all) => all.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  const setQty = (key: string, lineKey: string, qty: number) =>
    setDays((all) => all.map((d) => (d.key === key
      ? { ...d, lines: d.lines.map((l: CartLine) => (l.key === lineKey ? { ...l, qty } : l)).filter((l: CartLine) => l.qty > 0) }
      : d)));

  /**
   * Send the booking: one order per day.
   *
   * In the order the days will be eaten, and one after another rather than
   * all at once. Each order takes an order number and, where the slot is
   * capped, a place in it; firing four of those off together is four races
   * against each other for numbers that are worked out from the last one.
   *
   * A day that fails stops the rest. The days already written stay — they are
   * real orders the kitchen can see — and the person is told which day it got
   * to, rather than being left guessing whether any of it landed.
   */
  const send = async () => {
    const said = bookingProblem(days, {
      reference: groupRef,
      needReference,
      referenceLabel: reservationLabel,
      size: Number(groupSize || 0),
      minSize: minGroup,
      contactName: name,
    });
    if (said) { setProblem(said); return; }

    setBusy(true);
    setProblem(null);
    const bookingId = `gb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const booked: { id: string; orderNo: string; at: string }[] = [];

    try {
      await ensureGuestSession();
      for (const { day, totals } of booking.days) {
        const { order } = await createOrder({
          module: selfOrderModule(settings),
          venueId: venue.$id,
          lines: day.lines.filter((l: CartLine) => l.qty > 0),
          settings,
          guest: true,
          channel: 'takeaway',
          placedBy: name.trim(),
          group: {
            reference: groupRef.trim(),
            size: Number(groupSize || 0),
            contactName: name.trim(),
            bookingId,
          },
          customer: { name: name.trim() || undefined, email: email.trim() || undefined },
          fulfilment: day.fulfilment,
          packFee: totals.packFee,
          scheduledFor: new Date(day.at),
          slotCapacity,
          openingHours: venue.opening_hours,
        });
        booked.push({ id: order.$id, orderNo: order.order_no, at: day.at });
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

      setDays(() => []);
      onPlaced(settled);
    } catch (e) {
      const message = isSlotFull(e)
        ? (e as Error).message
        : humanError(e) || 'Could not send the booking. Please try again.';
      const done = booked.length;
      setProblem(done > 0
        ? `${message} ${done} day${done === 1 ? '' : 's'} of the booking went through before this; the rest have not. Please tell the front desk.`
        : message);
      onError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Your group booking"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={() => void send()} loading={busy} disabled={days.length === 0} style={{ width: '100%' }}>
          Send this booking · {money(booking.total)}
        </Button>
      }
    >
      <FormError message={problem} />

      {days.length === 0 && (
        <Notice tone="info">
          Nothing booked yet. Close this, pick a day at the top of the menu, and add what the group would like
          to eat on it. Add as many days as the group is staying.
        </Notice>
      )}

      {booking.days.map(({ day, totals }: { day: GroupDay; totals: DayPricing }) => (
        <div key={day.key} style={{ marginBottom: '1.2rem' }}>
          <div className="spread" style={{ alignItems: 'baseline' }}>
            <h3 style={{ margin: '0 0 0.2rem' }}>
              {longDayWords(day.at)}
            </h3>
            <span className="meta">
              {timeWords(day.at)}
            </span>
          </div>

          {/* The choice that carries the money, made per day and beside that
              day's food rather than once for the whole stay. */}
          <Field hint={packWords(packFee, money)}>
            <Select
              value={day.fulfilment}
              onChange={(e) => setDay(day.key, { fulfilment: e.target.value as Fulfilment })}
            >
              <option value="dine_in">{FULFILMENT_WORDS.dine_in}</option>
              <option value="takeaway">{FULFILMENT_WORDS.takeaway}</option>
            </Select>
          </Field>

          {day.lines.length === 0 ? (
            <p className="meta" style={{ margin: '0.4rem 0' }}>
              Nothing on this day yet.
            </p>
          ) : day.lines.map((line: CartLine) => (
            <div className="line" key={line.key}>
              <div>
                <div style={{ fontWeight: 550 }}>{line.name}</div>
                {line.addons.length > 0 && <div className="meta">{line.addons.map((a) => a.name).join(', ')}</div>}
                {line.notes && <div className="meta">&ldquo;{line.notes}&rdquo;</div>}
                <div className="qty" style={{ marginTop: '0.4rem' }}>
                  <button onClick={() => setQty(day.key, line.key, line.qty - 1)} aria-label="One fewer">−</button>
                  <span>{line.qty}</span>
                  <button onClick={() => setQty(day.key, line.key, line.qty + 1)} aria-label="One more">+</button>
                </div>
              </div>
              <div style={{ fontWeight: 600 }}>{formatMoney(lineTotal(line), settings)}</div>
            </div>
          ))}

          <div className="spread" style={{ marginTop: '0.4rem' }}>
            <span className="meta">{dayWords(totals, money)}</span>
            <Button
              variant="ghost"
              onClick={() => setDays((all) => all.filter((d) => d.key !== day.key))}
            >
              Take this day off
            </Button>
          </div>
        </div>
      ))}

      {days.length > 0 && (
        <>
          <div className="spread" style={{ marginTop: '0.6rem' }}>
            <span>Food</span>
            <span>{money(booking.subtotal)}</span>
          </div>
          {booking.packFees > 0 && (
            <div className="spread">
              <span>Packing <Badge>{booking.portions} portions</Badge></span>
              <span>{money(booking.packFees)}</span>
            </div>
          )}
          {booking.service > 0 && (
            <div className="spread"><span>Service</span><span>{money(booking.service)}</span></div>
          )}
          <div className="spread" style={{ fontWeight: 650, fontSize: '1.05rem' }}>
            <span>{booking.days.length} day{booking.days.length === 1 ? '' : 's'} in all</span>
            <span>{money(booking.total)}</span>
          </div>

          <Field label="Who is this booking for?" hint="So the kitchen and the front desk know whose it is.">
            <Input value={name} onChange={(e) => { setName(e.target.value); setProblem(null); }} />
          </Field>
          <Field label={reservationLabel} hint={needReference ? 'Needed for a group booking.' : 'Optional.'}>
            <Input value={groupRef} onChange={(e) => { setGroupRef(e.target.value); setProblem(null); }} />
          </Field>
          <Field label="How many people?" hint={minGroup > 0 ? `Group bookings are for ${minGroup} or more.` : undefined}>
            <Input
              type="number"
              min={minGroup || 1}
              value={groupSize}
              onChange={(e) => { setGroupSize(e.target.value); setProblem(null); }}
            />
          </Field>
          <Field label="Email" hint="Optional. We will send the booking through so you have it in writing.">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>

          <p className="meta">
            Each day is sent to the kitchen as its own order, on the morning it is wanted, so nothing is cooked
            early. They all carry your reference.
          </p>
        </>
      )}
    </Modal>
  );
}

/** A day that has just been added, ready for dishes. */
export const newDay = (at: Date): GroupDay => ({
  key: `d-${dayKeyOf(at)}-${Math.random().toString(36).slice(2, 6)}`,
  at: at.toISOString(),
  fulfilment: 'dine_in',
  lines: [],
});
