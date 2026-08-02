import { useMemo, useState } from 'react';
import { Button, Modal, Input, Field, Notice, Select } from '@snpos/ui';
import {
  computeTotals, formatMoney, lineTotal, createOrder, parseWindows,
  isEnabled, featureConfig, db, DB_ID, Query,
} from '@snpos/core';
import type { CartLine, Settings, Venue, FeatureMap, LoadedMenu, Doc } from '@snpos/core';

interface TableRow extends Doc { venue_id: string; label: string }

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

export function CartSheet({
  cart, setCart, settings, venue, table, features, venueOpen, menu, onClose, onPlaced, onError,
}: {
  cart: CartLine[];
  setCart: (fn: (c: CartLine[]) => CartLine[]) => void;
  settings: Settings;
  venue: Venue;
  table: TableRow | null;
  features: FeatureMap;
  venueOpen: boolean;
  menu: LoadedMenu;
  onClose: () => void;
  onPlaced: (orderNo: string, scheduled?: string) => void;
  onError: (message: string) => void;
}) {
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
  const [code, setCode] = useState('');
  const [codeState, setCodeState] = useState<{ id: string; amount: number; label: string } | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        | { $id: string; name: string; kind: string; value: number; active: boolean; guest_applicable: boolean; min_order_total: number; max_discount_amount?: number; starts_at?: string; ends_at?: string }
        | undefined;

      // A code that does not exist and one that is not for customers get the
      // same message on purpose — otherwise the form becomes a way to discover
      // staff-only codes by guessing.
      if (!d || !d.active || !d.guest_applicable) {
        setCodeError("That code isn't valid for this order.");
        return;
      }
      const now = new Date();
      if ((d.starts_at && new Date(d.starts_at) > now) || (d.ends_at && new Date(d.ends_at) < now)) {
        setCodeError('That code has expired.');
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
      onError('Please choose a collection time.');
      return;
    }
    setBusy(true);
    try {
      const prepById: Record<string, number> = {};
      for (const line of cart) prepById[line.menu_item_id] = menu.byId[line.menu_item_id]?.item.prep_minutes ?? 10;

      const { order } = await createOrder({
        venueId: venue.$id,
        lines: cart,
        settings,
        channel: table ? 'qr' : 'takeaway',
        placedBy: name.trim() || (table ? `Table ${table.label}` : 'Guest'),
        tableId: table?.$id,
        discount: codeState?.amount ?? 0,
        customer: { name: name.trim() || undefined, email: email.trim() || undefined },
        fulfilment: table ? 'dine_in' : 'takeaway',
        scheduledFor: slot ? new Date(slot) : undefined,
        placedWhileClosed: !venueOpen,
      });

      if (codeState) {
        // Recorded even for guest-applied codes: discounts are the easiest way
        // for money to leave a restaurant unnoticed, so every one is on file.
        await db
          .createDocument(DB_ID, 'discount_redemptions', 'unique()', {
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

      onPlaced(order.order_no, slot || undefined);
      setCart(() => []);
    } catch (e) {
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
        <Field label="Email for your receipt" hint="Optional — leave blank if you'd rather not.">
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
