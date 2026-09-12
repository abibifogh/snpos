import { useMemo, useState } from 'react';
import { Button, Modal, Input, Field, Notice, Select, FormError, Badge, Textarea } from '@snpos/ui';
import { QtyBox } from './QtyBox';
import {
  formatMoney, lineTotal, createOrder, featureConfig, isProvisionalOrderNo,
  ensureGuestSession, humanError, selfOrderModule, isSlotFull,
  bookingTotals, bookingProblem, packWords, mealWords, FULFILMENT_WORDS, dayKeyOf, longDayWords, timeWords,
  portionsAtBiggest,
  serviceOf, SERVICE_WORDS, SERVICE_HINTS,
  tabLabel,
  db, DB_ID, Query, recordGroupBooking,
} from '@snpos/core';
import type {
  CartLine, Settings, Venue, FeatureMap, GroupMeal, MealPricing, Fulfilment, ServiceStyle, Order,
} from '@snpos/core';

/** The last tab: asked once for the booking, not once per meal. */
const WHO = 'who';

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
  meals, setMeals, settings, venue, features, onClose, onPlaced, onError,
}: {
  meals: GroupMeal[];
  setMeals: (fn: (m: GroupMeal[]) => GroupMeal[]) => void;
  settings: Settings;
  venue: Venue;
  features: FeatureMap;
  onClose: () => void;
  /**
   * Everything the sent page needs, because this sheet is gone by then.
   *
   * `bookingId` is null when the booking record could not be written, which
   * is also what stops both emails — so the page says so rather than
   * promising a confirmation nobody will get.
   */
  onPlaced: (sent: {
    booked: { id: string; orderNo: string; at: string }[];
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
   * Anything true of the whole booking rather than of one dish.
   *
   * Every dish already has its own box for "no pepper on this one". What had
   * nowhere to go was the sentence about the arrangement: the coach that
   * leaves at two, the high chair, the guest in a wheelchair, the cake to be
   * brought out at the end. It arrived by telephone, to whoever picked up, or
   * it did not arrive.
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
    How big the party is, counted rather than asked.

    There used to be a "How many people?" box. It asked a second time for
    something the order had already said — somebody ordering thirty plates has
    told you there are about thirty of them — and it was the only gate on the
    smallest-group rule, so a party of two could type "twenty" and walk
    through. The biggest sitting is the count: see portionsAtBiggest.
  */
  const partySize = portionsAtBiggest(meals);

  const setMeal = (key: string, patch: Partial<GroupMeal>) =>
    setMeals((all) => all.map((m) => (m.key === key ? { ...m, ...patch } : m)));

  const setQty = (key: string, lineKey: string, qty: number) =>
    setMeals((all) => all.map((m) => (m.key === key
      ? { ...m, lines: m.lines.map((l: CartLine) => (l.key === lineKey ? { ...l, qty } : l)).filter((l: CartLine) => l.qty > 0) }
      : m)));

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
      /*
        Show the tab the complaint is about.

        With one meal on screen at a time, "Wednesday has nothing on it" said
        over a panel showing Thursday is a complaint about something the
        reader cannot see, and they would reasonably conclude the form is
        broken. The empty meal is found the same way bookingProblem finds it:
        earliest first.
      */
      const empty = [...meals].sort((a, b) => a.at.localeCompare(b.at)).find((m) => m.lines.length === 0);
      setTab(meals.length > 0 && empty ? empty.key : WHO);
      return;
    }

    setBusy(true);
    setProblem(null);
    const bookingId = `gb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    /** Whether the booking record landed, which is what sends both emails. */
    let recorded = false;
    const booked: { id: string; orderNo: string; at: string }[] = [];

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
          /* No opening hours. A sitting is agreed with the kitchen, which
             opens for it; what the doors are doing this evening has nothing
             to say about a booking three weeks out. */
        });
        booked.push({ id: order.$id, orderNo: order.order_no, at: meal.at });
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
        The booking itself, written last.

        Once every sitting has actually landed, and not before: a booking row
        for sittings that failed would be a confirmation of something that is
        not booked. Writing it is also what sends the emails — one to whoever
        runs the place and one to the person who booked — so a stay of four
        sittings is one message each rather than four.

        Never fatal. The food is ordered and the kitchen has it; failing the
        whole booking here would tell somebody their party is not booked when
        it is, which is the worse of the two wrongs by a distance.
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
          /*
            Not fatal, and no longer silent.

            The food IS ordered: failing the whole booking here would tell
            somebody their party is not booked when it is, which is the worse
            of the two wrongs by a distance. But this write is what sends both
            emails, so swallowing it meant a booking went in, nobody was told,
            and nothing anywhere said why. The page says so instead, and the
            console names it.
          */
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
        ? `${message} ${done} meal${done === 1 ? '' : 's'} of the booking went through before this; the rest have not. Please tell the front desk.`
        : message);
      onError(message);
    } finally {
      setBusy(false);
    }
  };

  /*
    One meal at a time, behind tabs.

    Every meal of the stay used to be laid out one under another, each with its
    own heading, its own eat-in-or-packed box with a line of explanation under
    it, its own dishes, its own total and its own Remove — then the booking
    summary and four questions below all of that. Four nights of lunch and
    dinner made a sheet somebody scrolled through rather than read, and the
    Send button at the bottom of it was a leap of faith.

    So the tabs carry the whole booking's shape in one line, the panel shows
    only what is being looked at, and the total is beside Send where it is
    always in view. "Who it is for" is the last tab, because it is asked once
    for the booking and not once per meal.
  */
  const [tab, setTab] = useState<string>(booking.meals[0]?.meal.key ?? WHO);
  const shown = booking.meals.find((m) => m.meal.key === tab) ?? null;
  const onWho = tab === WHO || !shown;

  return (
    <Modal
      title="Your group booking"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={() => void send()} loading={busy} disabled={meals.length === 0} style={{ width: '100%' }}>
          Send this booking · {money(booking.total)}
        </Button>
      }
    >
      <FormError message={problem} />

      {meals.length === 0 ? (
        <Notice tone="info">
          Nothing booked yet. Close this, add a meal above the menu, and choose what the group would like to
          eat at it. Lunch and dinner on the same day are two meals.
        </Notice>
      ) : (
        <>
          <div className="book-tabs">
            {booking.meals.map(({ meal, totals }: { meal: GroupMeal; totals: MealPricing }) => (
              <button
                key={meal.key}
                type="button"
                className={meal.key === tab ? 'on' : ''}
                onClick={() => setTab(meal.key)}
              >
                {tabLabel(meal.at)}
                {/* A meal with nothing on it is the commonest reason a booking
                    will not send, and the one thing the tabs can say about it
                    without being read. */}
                {totals.portions > 0 ? ` · ${totals.portions}` : ' · —'}
              </button>
            ))}
            <button type="button" className={onWho ? 'on' : ''} onClick={() => setTab(WHO)}>
              Who it is for
            </button>
          </div>

          {shown && !onWho && (
            <>
              <div className="spread" style={{ alignItems: 'baseline', marginTop: '0.8rem' }}>
                <h3 style={{ margin: 0 }}>{longDayWords(shown.meal.at)}</h3>
                <span className="meta">{timeWords(shown.meal.at)}</span>
              </div>

              {/* The choice that carries the money, made per meal and beside
                  that meal's food rather than once for the whole stay. The
                  packing charge is only worth a line where one is charged. */}
              <Field hint={shown.meal.fulfilment === 'takeaway' ? packWords(packFee, money) : undefined}>
                <Select
                  value={shown.meal.fulfilment}
                  onChange={(e) => setMeal(shown.meal.key, { fulfilment: e.target.value as Fulfilment })}
                >
                  <option value="dine_in">{FULFILMENT_WORDS.dine_in}</option>
                  <option value="takeaway">{FULFILMENT_WORDS.takeaway}</option>
                </Select>
              </Field>

              {/*
                Plated or a buffet, and only where the question has two
                answers. Forty covers plated and forty as a buffet are the
                same food and two different days of work — forty plates
                leaving together at a promised time, against chafing dishes
                set out beforehand and topped up — and the kitchen used to
                find out which when the party arrived. Food going into boxes
                is not asked.
              */}
              {shown.meal.fulfilment === 'dine_in' && (
                <Field
                  label="How should it be served?"
                  hint={SERVICE_HINTS[serviceOf(shown.meal) ?? 'plated']}
                >
                  <Select
                    value={serviceOf(shown.meal) ?? 'plated'}
                    onChange={(e) => setMeal(shown.meal.key, { service: e.target.value as ServiceStyle })}
                  >
                    <option value="plated">{SERVICE_WORDS.plated}</option>
                    <option value="buffet">{SERVICE_WORDS.buffet}</option>
                  </Select>
                </Field>
              )}

              {/* A flat list, in the order they were tapped.

                  These used to be gathered under the headings they came from,
                  which is right for a menu divided into Wraps and Sandwiches
                  and wrong for this one: its headings are "Everyday
                  offerings", "Monday special" — which day a dish is cooked on.
                  A booking for a Sunday then read as "Monday special", which
                  tells the party nothing and misleads them about what they
                  have ordered. */}
              {shown.meal.lines.length === 0 ? (
                <p className="meta" style={{ margin: '0.6rem 0' }}>
                  Nothing on this meal yet. Close this and choose from the menu.
                </p>
              ) : shown.meal.lines.map((line: CartLine) => (
                <div className="line" key={line.key}>
                  <div>
                    <div style={{ fontWeight: 550 }}>{line.name}</div>
                    {line.addons.length > 0 && <div className="meta">{line.addons.map((a) => a.name).join(', ')}</div>}
                    {line.notes && <div className="meta">&ldquo;{line.notes}&rdquo;</div>}
                    <div style={{ marginTop: '0.4rem' }}>
                      <QtyBox
                        qty={line.qty}
                        onChange={(q) => setQty(shown.meal.key, line.key, q)}
                        least={0}
                        label={line.name}
                      />
                    </div>
                  </div>
                  <div style={{ fontWeight: 600 }}>{formatMoney(lineTotal(line), settings)}</div>
                </div>
              ))}

              <div className="spread" style={{ marginTop: '0.6rem' }}>
                <span className="meta">{mealWords(shown.totals, money)}</span>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    if (shown.meal.lines.length > 0
                      && !confirm(`Take ${longDayWords(shown.meal.at)}, ${timeWords(shown.meal.at)} off the booking? What is on it will be lost.`)) {
                      return;
                    }
                    setMeals((all) => all.filter((m) => m.key !== shown.meal.key));
                    setTab(WHO);
                  }}
                >
                  Remove this meal
                </Button>
              </div>
            </>
          )}

          {onWho && (
            <div style={{ marginTop: '0.8rem' }}>
              <Field label="Who is this booking for?" hint="So the kitchen and the front desk know whose it is.">
                <Input value={name} onChange={(e) => { setName(e.target.value); setProblem(null); }} />
              </Field>
              <Field label={reservationLabel} hint={needReference ? 'Needed for a group booking.' : 'Optional.'}>
                <Input value={groupRef} onChange={(e) => { setGroupRef(e.target.value); setProblem(null); }} />
              </Field>

              {/* Required here, optional on an ordinary order, and the
                  difference is the situation: a walk-in is standing in the
                  room and can be told; a party of forty booked three weeks ago
                  has nothing to hold. */}
              <Field
                label="Email"
                hint="We send the whole booking through in writing, so you have it on the day."
              >
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setProblem(null); }}
                />
              </Field>

              {/* Not a dish note — every dish has its own box for those. This
                  is for what is true of the whole booking, which until now
                  had nowhere to go but a telephone call. */}
              <Field
                label="Anything else we should know?"
                hint="About the booking as a whole — a high chair, a wheelchair, a coach to catch, a cake at the
                      end. For one dish, use the box on that dish. Optional."
              >
                <Textarea
                  rows={3}
                  maxLength={1000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </Field>

              {/* The whole booking, priced, on the tab where somebody is about
                  to send it. Packing and service are only worth a line where
                  they come to something. */}
              <div className="spread" style={{ marginTop: '0.8rem' }}>
                <span>Food</span><span>{money(booking.subtotal)}</span>
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
                <span>{booking.meals.length} sitting{booking.meals.length === 1 ? '' : 's'}, {booking.portions} portions</span>
                <span>{money(booking.total)}</span>
              </div>

              <p className="meta">
                Each meal is sent to the kitchen as its own order, in time to cook it and not before, so nothing
                is made early. They all carry your reference.
              </p>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/** A meal that has just been added, ready for dishes. */
export const newMeal = (at: Date): GroupMeal => ({
  key: `m-${dayKeyOf(at)}-${at.getHours()}${at.getMinutes()}-${Math.random().toString(36).slice(2, 6)}`,
  at: at.toISOString(),
  fulfilment: 'dine_in',
  lines: [],
});
