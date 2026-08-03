import { useMemo, useState } from 'react';
import { Button, Modal, Input, Field, Notice, Select, FormError } from '@snpos/ui';
import {
  computeTotals, formatMoney, lineTotal, createOrder, parseWindows,
  isEnabled, featureConfig, db, DB_ID, ID, Query, isProvisionalOrderNo,
} from '@snpos/core';
import type { CartLine, Settings, Venue, FeatureMap, LoadedMenu, Doc, Order } from '@snpos/core';

interface TableRow extends Doc {
  venue_id: string;
  label: string;
  zone?: string;
  kind?: 'table' | 'area';
  guest_selectable?: boolean;
  active?: boolean;
  sort?: number;
}

/**
 * Slots the kitchen can actually serve.
 *
 * Offering a time the restaurant is shut, or one five minutes from now, is
 * worse than offering nothing — the customer plans around it and arrives to a
 * locked door.
 */
function buildSlots(venue: Venue, features: FeatureMap, from = new Date()): Date[] {
  const windows = parseWindows(venue.opening_hours);
  if (!windows) return [];

  const leadMinutes = featureConfig(features, 'preorders', 'min_lead_minutes', 30);
  const slotMinutes = featureConfig(features, 'preorders', 'slot_minutes', 15);
  const cutoff = featureConfig(features, 'preorders', 'cutoff_minutes_before_close', 30);
  const daysAhead = featureConfig(features, 'preorders', 'max_days_ahead', 7);

  const earliest = new Date(from.getTime() + leadMinutes * 60_000);
  const slots: Date[] = [];
  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

  for (let d = 0; d <= daysAhead && slots.length < 200; d++) {
    const day = new Date(from);
    day.setDate(day.getDate() + d);
    for (const [open, close] of windows[DAYS[day.getDay()]] ?? []) {
      const [oh, om] = open.split(':').map(Number);
      const [ch, cm] = close.split(':').map(Number);
      const start = new Date(day);
      start.setHours(oh, om || 0, 0, 0);
      const end = new Date(day);
      end.setHours(ch, cm || 0, 0, 0);
      if (end <= start) end.setDate(end.getDate() + 1); // crosses midnight
      const last = new Date(end.getTime() - cutoff * 60_000);

      for (let t = new Date(start); t <= last; t = new Date(t.getTime() + slotMinutes * 60_000)) {
        if (t >= earliest) slots.push(new Date(t));
      }
    }
  }
  return slots.slice(0, 60);
}

/**
 * Wait for the order to be given its real number.
 *
 * Roughly six seconds, then give up gracefully. A number that never settles is
 * annoying; a confirmation screen that never appears is a customer who orders
 * the same food twice.
 */
async function settledOrderNo(order: Order): Promise<string> {
  if (!isProvisionalOrderNo(order.order_no)) return order.order_no;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const fresh = await db.getDocument(DB_ID, 'orders', order.$id).catch(() => null);
    const no = (fresh as unknown as Order | null)?.order_no;
    if (no && !isProvisionalOrderNo(no)) return no;
  }
  return '';
}

export function CartSheet({
  cart, setCart, settings, venue, table, seating, groupMode, features, venueOpen, menu,
  onClose, onPlaced, onError,
}: {
  cart: CartLine[];
  setCart: (fn: (c: CartLine[]) => CartLine[]) => void;
  settings: Settings;
  venue: Venue;
  /** Set when the QR code named a table; then there is nothing to ask. */
  table: TableRow | null;
  /** Tables and areas a guest may pick from when the QR code did not say. */
  seating: TableRow[];
  groupMode: boolean;
  features: FeatureMap;
  venueOpen: boolean;
  menu: LoadedMenu;
  onClose: () => void;
  onPlaced: (orderNo: string, orderId: string, scheduled?: string) => void;
  onError: (message: string) => void;
}) {
  const needReference = featureConfig(features, 'group_orders', 'require_reservation_number', true);
  const reservationLabel = featureConfig<string>(
    features, 'group_orders', 'reservation_label', 'Hotel reservation number',
  );
  const minGroup = featureConfig(features, 'group_orders', 'min_group_size', 0);

  const preordersOn = isEnabled(features, 'preorders');
  const collectEmail = isEnabled(features, 'receipts') && featureConfig(features, 'receipts', 'ask_email_at_qr_order', true);
  const discountsOn = isEnabled(features, 'discounts') && featureConfig(features, 'discounts', 'guest_codes_enabled', true);

  const slots = useMemo(
    () => (preordersOn ? buildSlots(venue, features) : []),
    [venue, features, preordersOn],
  );

  // Closed with no slot chosen would be an order nobody can cook.
  const [slot, setSlot] = useState<string>(venueOpen ? '' : (slots[0]?.toISOString() ?? ''));
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [seatId, setSeatId] = useState('');
  const [groupRef, setGroupRef] = useState('');
  const [groupSize, setGroupSize] = useState('');
  const [code, setCode] = useState('');
  const [codeState, setCodeState] = useState<{ id: string; amount: number; label: string } | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The QR sticker wins; only when it says nothing does the guest get asked.
  //
  // Kept below the state it reads, deliberately. Sitting above `seatId` this
  // threw on every single render of the sheet — the cart button did nothing and
  // no order could be sent, with nothing on screen to say why.
  const chosenSeat = table ?? seating.find((x) => x.$id === seatId) ?? null;
  const areasFirst = [...seating].sort(
    (a, b) => Number(b.kind === 'area') - Number(a.kind === 'area') || a.label.localeCompare(b.label),
  );

  const totals = computeTotals({ lines: cart, discount: codeState?.amount ?? 0, settings });

  const setQty = (key: string, delta: number) =>
    setCart((c) =>
      c.flatMap((l) => (l.key === key ? (l.qty + delta <= 0 ? [] : [{ ...l, qty: l.qty + delta }]) : [l])),
    );

  const applyCode = async () => {
    setCodeError(null);
    const typed = code.trim().toUpperCase();
    if (!typed) return;
    try {
      const found = await db.listDocuments(DB_ID, 'discounts', [Query.equal('code', typed), Query.limit(1)]);
      const d = found.documents[0] as unknown as
        | {
            $id: string; name: string; kind: string; value: number; active: boolean;
            guest_applicable: boolean; min_order_total: number; max_discount_amount?: number;
            starts_at?: string; ends_at?: string; usage_limit_total?: number; used_count?: number;
          }
        | undefined;

      // A code that does not exist and one that is not for customers get the
      // same message on purpose — otherwise the form becomes a way to discover
      // staff-only codes by guessing.
      if (!d || !d.active || !d.guest_applicable) {
        setCodeError("That code isn't valid for this order.");
        return;
      }
      const now = new Date();
      if (d.starts_at && new Date(d.starts_at) > now) {
        setCodeError('That code is not active yet.');
        return;
      }
      if (d.ends_at && new Date(d.ends_at) < now) {
        setCodeError('That code has expired.');
        return;
      }
      // Told here for a quick answer; enforced on the server, which is the
      // only place that can be sure two people did not use the last one at
      // the same moment.
      if (d.usage_limit_total && (d.used_count ?? 0) >= d.usage_limit_total) {
        setCodeError('That code has been used the maximum number of times.');
        return;
      }
      const subtotal = cart.reduce((s, l) => s + lineTotal(l), 0);
      if (d.min_order_total && subtotal < d.min_order_total) {
        setCodeError(`That code needs a minimum order of ${formatMoney(d.min_order_total, settings)}.`);
        return;
      }
      let amount = d.kind === 'percent' ? Math.round((subtotal * d.value) / 10000) : d.value;
      if (d.max_discount_amount) amount = Math.min(amount, d.max_discount_amount);
      setCodeState({ id: d.$id, amount, label: d.name });
    } catch {
      setCodeError('Could not check that code. Try again.');
    }
  };

  const place = async () => {
    if (!venueOpen && !slot) {
      setProblem('Please choose a collection time.');
      return;
    }
    // Somebody eating in has to be findable. Guessing because the question
    // went unanswered is how food goes cold on a pass.
    if (!table && seating.length > 0 && !seatId) {
      setProblem('Please say where you are sitting.');
      return;
    }

    // A group order the kitchen cannot tie to a booking is a party nobody can
    // find at the front desk, so the reference is asked for before it is sent
    // rather than chased afterwards.
    if (groupMode && needReference && !groupRef.trim()) {
      setProblem(`Please enter your ${reservationLabel.toLowerCase()}.`);
      return;
    }
    if (groupMode && minGroup > 0 && Number(groupSize || 0) < minGroup) {
      setProblem(`Group orders are for ${minGroup} people or more.`);
      return;
    }

    setBusy(true);
    try {
      // Checked again here, not only when the code was typed. A guest can sit
      // with the sheet open for twenty minutes, and the last use of a code can
      // go to somebody else in that time. The server refuses it either way;
      // this is so they find out before they order rather than after.
      if (codeState) {
        const fresh = await db.getDocument(DB_ID, 'discounts', codeState.id).catch(() => null);
        const v = fresh as unknown as
          | { active: boolean; ends_at?: string; usage_limit_total?: number; used_count?: number }
          | null;
        const usedUp = !!v?.usage_limit_total && (v.used_count ?? 0) >= v.usage_limit_total;
        if (!v || v.active === false || usedUp || (v.ends_at && new Date(v.ends_at) < new Date())) {
          setCodeState(null);
          setCodeError('That code is no longer available. Your order has been updated to the full price.');
          setProblem('The discount code is no longer available — check the total and send again.');
          setBusy(false);
          return;
        }
      }

      const prepById: Record<string, number> = {};
      for (const line of cart) prepById[line.menu_item_id] = menu.byId[line.menu_item_id]?.item.prep_minutes ?? 10;

      const { order } = await createOrder({
        venueId: venue.$id,
        lines: cart,
        settings,
        guest: true,
        channel: chosenSeat ? 'qr' : 'takeaway',
        placedBy: name.trim() || (chosenSeat ? chosenSeat.label : 'Guest'),
        tableId: chosenSeat?.$id,
        group: groupMode
          ? {
              reference: groupRef.trim(),
              size: Number(groupSize || 0),
              contactName: name.trim(),
            }
          : undefined,
        discount: codeState?.amount ?? 0,
        customer: { name: name.trim() || undefined, email: email.trim() || undefined },
        fulfilment: chosenSeat ? 'dine_in' : 'takeaway',
        scheduledFor: slot ? new Date(slot) : undefined,
        placedWhileClosed: !venueOpen,
      });

      if (codeState) {
        // Recorded even for guest-applied codes: discounts are the easiest way
        // for money to leave a restaurant unnoticed, so every one is on file.
        await db
          .createDocument(DB_ID, 'discount_redemptions', ID.unique(), {
            venue_id: venue.$id,
            discount_id: codeState.id,
            code_snapshot: code.trim().toUpperCase(),
            order_id: order.$id,
            amount: codeState.amount,
            stage: 'guest_ordering',
            status: 'applied',
          })
          .catch(() => undefined);
      }

      // The number on screen is the one the customer will say out loud at the
      // counter, so it has to be the real one. It is settled server-side a
      // moment after the order lands; wait for it rather than showing the
      // placeholder. The guest can read their own order, and nothing else.
      onPlaced(await settledOrderNo(order), order.$id, slot || undefined);
      setCart(() => []);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Could not send your order. Please try again.');
      onError(e instanceof Error ? e.message : 'Could not send your order. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Your order"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={place} loading={busy} disabled={cart.length === 0} style={{ width: '100%' }}>
          {slot ? 'Book this order' : 'Send to kitchen'} · {formatMoney(totals.total, settings)}
        </Button>
      }
    >
      <FormError message={problem} />

      {/* Asked first, and asked plainly. Somebody eating in has to be findable
          when the food is ready, and burying this under the bill is how an
          order goes out with nowhere to take it. */}
      {!table && seating.length > 0 && (
        <Field label="Where are you sitting?" hint="So we can bring your food to you.">
          <Select value={seatId} onChange={(e) => { setSeatId(e.target.value); setProblem(null); }}>
            <option value="">— please choose —</option>
            {areasFirst.map((t) => (
              <option key={t.$id} value={t.$id}>
                {t.kind === 'area' ? t.label : `Table ${t.label}`}
                {t.zone ? ` · ${t.zone}` : ''}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {cart.map((line) => (
        <div className="line" key={line.key}>
          <div>
            <div style={{ fontWeight: 550 }}>{line.name}</div>
            {line.addons.length > 0 && <div className="meta">{line.addons.map((a) => a.name).join(', ')}</div>}
            {line.notes && <div className="meta">“{line.notes}”</div>}
            <div className="qty" style={{ marginTop: '0.4rem' }}>
              <button onClick={() => setQty(line.key, -1)} aria-label="Fewer">−</button>
              <span>{line.qty}</span>
              <button onClick={() => setQty(line.key, +1)} aria-label="More">+</button>
            </div>
          </div>
          <div style={{ fontWeight: 600 }}>{formatMoney(lineTotal(line), settings)}</div>
        </div>
      ))}

      {/* An area has no table number, so the only way to be found is to say
          where in it you are. Asked only when it would actually help. */}

      {groupMode && (
        <>
          <Field
            label={reservationLabel}
            hint={needReference ? 'Required for a group order.' : 'Optional.'}
          >
            <Input value={groupRef} onChange={(e) => setGroupRef(e.target.value)} />
          </Field>
          <Field label="How many people?" hint={minGroup > 0 ? `Group orders are for ${minGroup} or more.` : undefined}>
            <Input
              type="number"
              min={minGroup || 1}
              value={groupSize}
              onChange={(e) => setGroupSize(e.target.value)}
            />
          </Field>
        </>
      )}

      {!venueOpen && preordersOn && (
        <Field
          label="Collection time"
          hint="We're closed at the moment. Pick a time when we're open and we'll have it ready."
        >
          {slots.length === 0 ? (
            <Notice tone="warn">
              No times are available yet — opening hours have not been set. Please order in person.
            </Notice>
          ) : (
            <Select value={slot} onChange={(e) => setSlot(e.target.value)}>
              {slots.map((s) => (
                <option key={s.toISOString()} value={s.toISOString()}>
                  {s.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}

      {venueOpen && preordersOn && slots.length > 0 && (
        <Field label="When do you want it?" >
          <Select value={slot} onChange={(e) => setSlot(e.target.value)}>
            <option value="">As soon as possible</option>
            {slots.slice(0, 24).map((s) => (
              <option key={s.toISOString()} value={s.toISOString()}>
                {s.toLocaleString([], { hour: '2-digit', minute: '2-digit', weekday: 'short' })}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <Field label="Your name" hint="So staff know whose order this is. Optional.">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      {collectEmail && (
        <Field
          label="Your email"
          hint="We'll tell you when your order is accepted and when it's ready, and send your receipt once you've paid. Optional — leave blank if you'd rather not."
        >
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      )}

      {discountsOn && (
        <Field label="Have a code?" error={codeError}>
          <div className="row">
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="OPENING20" />
            <Button onClick={applyCode} type="button">Apply</Button>
          </div>
        </Field>
      )}

      <div className="totals">
        <div className="row-t">
          <span className="dim">Subtotal</span>
          <span>{formatMoney(totals.subtotal, settings)}</span>
        </div>
        {totals.discount_total > 0 && (
          <div className="row-t">
            <span className="dim">{codeState?.label ?? 'Discount'}</span>
            <span>−{formatMoney(totals.discount_total, settings)}</span>
          </div>
        )}
        {totals.service_total > 0 && (
          <div className="row-t">
            <span className="dim">Service</span>
            <span>{formatMoney(totals.service_total, settings)}</span>
          </div>
        )}
        {totals.tax_total > 0 && (
          <div className="row-t">
            <span className="dim">Tax {settings.tax_inclusive ? '(included)' : ''}</span>
            <span>{formatMoney(totals.tax_total, settings)}</span>
          </div>
        )}
        <div className="row-t grand">
          <span>Total</span>
          <span>{formatMoney(totals.total, settings)}</span>
        </div>
      </div>

      <p className="small dim" style={{ marginTop: '0.9rem' }}>
        Pay a member of staff when you're done — there's no payment in this app.
      </p>
    </Modal>
  );
}
