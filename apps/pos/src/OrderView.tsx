import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Field, Input, Modal, Notice, Select, Badge, Spinner } from '@snpos/ui';
import {
  db, DB_ID, Query, listAll, createOrder, computeTotals, lineTotal, formatMoney,
  parseMoney, toInput, isEnabled, featureConfig, visibleSections, recordPayment, asksForTip,
  variantPriceRange, shiftUsable, shiftAgeOf, shiftAgeMessage, SHIFT_MAX_HOURS, sharesFor, mustWaitForNextShift,
} from '@snpos/core';
import type { CartLine, Order, OrderItem, Doc, MenuEntry, Settings } from '@snpos/core';
import { COUNTER_TABLE_ID } from './App';
import type { PosContext, TableRow } from './App';

/**
 * One price, or the range the sizes cover.
 *
 * Printing the product's own price where sizes exist would print a figure the
 * till will never charge, which is exactly the number a customer reads over
 * the counter and then queries.
 */
function priceLabel(entry: MenuEntry, settings: Settings): string {
  const { from, to } = variantPriceRange(entry);
  return from === to ? formatMoney(from, settings) : `${formatMoney(from, settings)}–${formatMoney(to, settings)}`;
}

interface PaymentMethod extends Doc { name: string; kind: string; enabled: boolean; requires_reference: boolean; venue_id: string }

export function OrderView({
  ctx, table, onBack, onToast,
}: {
  ctx: PosContext;
  table: TableRow;
  onBack: () => void;
  onToast: (m: string, tone?: 'ok' | 'err') => void;
}) {
  // Neither is tied to a seat, and both create counter-channel orders. They are
  // still different places: see COUNTER_TABLE_ID.
  const isTakeaway = table.$id === 'takeaway' || table.$id === COUNTER_TABLE_ID;

  const [cart, setCart] = useState<CartLine[]>([]);
  const [existing, setExisting] = useState<Order[]>([]);
  const [existingItems, setExistingItems] = useState<Record<string, OrderItem[]>>({});
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [paying, setPaying] = useState(false);
  const [discount, setDiscount] = useState(0);
  const [discountLabel, setDiscountLabel] = useState('');
  const [showDiscount, setShowDiscount] = useState(false);
  const [sectionId, setSectionId] = useState<string | null>(null);
  /**
   * The product waiting on a size.
   *
   * A basket in three sizes has three prices and no single one of them is "the
   * price", so the till cannot add it to a bill until somebody says which. Held
   * here rather than added at a guessed price and corrected later, a corrected
   * line is a line the customer has already been quoted.
   */
  const [pickingSize, setPickingSize] = useState<string | null>(null);

  /**
   * Only this side's catalogue.
   *
   * A craft till showing jollof is a craft till somebody will eventually ring
   * jollof up on, and that sale would land in the wrong shift, the wrong
   * takings and the wrong set of books. Filtering here rather than at load
   * keeps one menu in memory for a device that switches sides.
   */
  const sections = useMemo(
    () =>
      visibleSections(ctx.menu).filter(
        (s) => (s.category.module ?? 'kitchen') === ctx.module,
      ),
    [ctx.menu, ctx.module],
  );

  useEffect(() => {
    (async () => {
      const [m] = await Promise.all([
        listAll<PaymentMethod>('payment_methods', [Query.equal('venue_id', ctx.venue.$id)]),
      ]);
      setMethods(m.filter((x) => x.enabled));

      /**
       * What is still owed here.
       *
       * The craft counter needs this as much as a table does, and used to be
       * skipped along with takeaway: a counter sale whose payment failed could
       * never be seen or settled again from the till it was rung up on. The
       * money was owed and no screen in the shop would take it.
       *
       * Restaurant takeaway keeps its old behaviour, where each order is
       * started fresh from the takeaway list.
       */
      if (!isTakeaway || ctx.module === 'craft') {
        const orders = await listAll<Order>('orders', [
          Query.equal('venue_id', ctx.venue.$id),
          Query.equal('table_id', table.$id),
        ]);
        const live = orders.filter(
          (o) => o.payment_status !== 'paid'
            && !['REJECTED', 'CANCELLED'].includes(o.status)
            && (o.module ?? 'kitchen') === ctx.module,
        );
        setExisting(live);
        if (live.length) {
          const rows = await listAll<OrderItem>('order_items', [Query.equal('order_id', live.map((o) => o.$id))]);
          const grouped: Record<string, OrderItem[]> = {};
          for (const r of rows) (grouped[r.order_id] ??= []).push(r);
          setExistingItems(grouped);
        }
      }
      setSectionId(sections[0]?.category.$id ?? null);
      setLoading(false);
    })();
  }, [ctx.venue.$id, table.$id, isTakeaway, sections]);

  const addItem = (menuItemId: string, variantId?: string) => {
    const entry = ctx.menu.byId[menuItemId];
    if (!entry) return;

    // Sizes have to be answered before a price exists. Asked once, here, so no
    // caller has to remember to.
    const sizes = (entry.variants ?? []).filter((v) => v.active);
    if (sizes.length > 0 && !variantId) { setPickingSize(menuItemId); return; }
    const size = variantId ? sizes.find((v) => v.$id === variantId) ?? null : null;

    setPickingSize(null);
    setCart((c) => {
      const twin = c.find(
        (l) =>
          l.menu_item_id === menuItemId &&
          (l.variant_id ?? '') === (size?.$id ?? '') &&
          l.addons.length === 0 &&
          !l.notes,
      );
      if (twin) return c.map((l) => (l === twin ? { ...l, qty: l.qty + 1 } : l));
      return [
        ...c,
        {
          key: `${menuItemId}-${size?.$id ?? ''}-${Date.now()}`,
          menu_item_id: menuItemId,
          name: size ? `${entry.item.name} · ${size.label}` : entry.item.name,
          unit_price: size ? size.price : entry.price,
          qty: 1,
          addons: [],
          station: entry.station,
          station_key: entry.stationKey,
          prep_minutes: entry.item.prep_minutes,
          variant_id: size?.$id,
          variant_label: size?.label,
          // Whose work it is, carried from the shelf to the sale so the ledger
          // can credit the right person without looking anything up at payment.
          consignor_id: entry.item.consignor_id || undefined,
          commission_bp: entry.item.commission_bp ?? undefined,
          commission_flat: entry.item.commission_flat ?? undefined,
        },
      ];
    });
  };

  const newTotals = computeTotals({ lines: cart, settings: ctx.settings });

  // What is already owed, plus whatever is being added right now.
  const billTotal = existing.reduce((s, o) => s + o.total, 0) + (cart.length ? newTotals.total : 0);

  /**
   * Can new business be started on this shift?
   *
   * Past a day, no. Everything rung up against it lands in a night that ended.
   *
   * Settling what is ALREADY on it stays allowed, and that distinction is the
   * whole point. Blocking payment as well produced a shift that could not take
   * the money for an order and could not close over the same order being
   * unpaid: a locked door with the key on the other side. A rule with no way
   * out of it is worse than the thing it was preventing.
   */
  const usable = shiftUsable(ctx.shift);
  const age = shiftAgeOf(ctx.shift);

  /** Bills on this screen that the shift ran past its limit to take. */
  const shelvedHere = existing.filter((o) => mustWaitForNextShift(o, ctx.shift));

  const send = async () => {
    if (cart.length === 0) return;
    // Starting NEW business on a shift that should have closed a day ago is
    // the thing being stopped. What is already on it can still be settled.
    if (ctx.module === 'craft' && !usable) {
      onToast(shiftAgeMessage(age, SHIFT_MAX_HOURS, ctx.module), 'err');
      return;
    }
    setSending(true);
    try {
      const { order } = await createOrder({
        module: ctx.module,
        venueId: ctx.venue.$id,
        lines: cart,
        settings: ctx.settings,
        channel: isTakeaway ? 'counter' : 'waiter',
        placedBy: ctx.profile?.display_name ?? 'Staff',
        tableId: isTakeaway ? undefined : table.$id,
        shiftId: ctx.shift?.$id,
        discount,
        fulfilment: isTakeaway ? 'takeaway' : 'dine_in',
      });
      setExisting((e) => [...e, order]);
      const rows = await listAll<OrderItem>('order_items', [Query.equal('order_id', order.$id)]);
      setExistingItems((m) => ({ ...m, [order.$id]: rows }));
      setCart([]);
      setDiscount(0);
      setDiscountLabel('');
      if (!isTakeaway) await db.updateDocument(DB_ID, 'tables', table.$id, { status: 'ordered' }).catch(() => undefined);
      if (ctx.module === 'craft') {
        // Nothing is being sent anywhere. A shop sale is rung up and paid for
        // in one movement at the counter, so the till goes straight to taking
        // the money rather than announcing a kitchen that does not exist.
        onToast(`${order.order_no} rung up`);
        setPaying(true);
      } else {
        onToast(`Order ${order.order_no} sent to the kitchen`);
      }
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'Could not send the order.', 'err');
    } finally {
      setSending(false);
    }
  };

  if (loading) return <div className="pos" style={{ display: 'grid', placeItems: 'center' }}><Spinner /></div>;

  return (
    <div className="pos">
      <div className="pos-top">
        {/* The craft till has nowhere to go back to: the counter is the whole
            screen, not one table among several. A back button that leads
            nowhere is a button somebody presses once and distrusts after. */}
        {ctx.module !== 'craft' && <Button variant="ghost" onClick={onBack}>← Tables</Button>}
        <strong>
          {ctx.module === 'craft' ? 'Counter sale' : isTakeaway ? 'Takeaway order' : `Table ${table.label}`}
        </strong>
        <div className="row">
          {existing.length > 0 && (
            <Button
              variant="primary"
              onClick={() => setPaying(true)}
              disabled={!ctx.shift || !ctx.profile?.can_mark_paid}
            >
              Take payment · {formatMoney(billTotal, ctx.settings)}
            </Button>
          )}
        </div>
      </div>

      {ctx.shift && !usable && (
        <div style={{ padding: '0.6rem 1rem' }}>
          <Notice tone="warn">
            {shiftAgeMessage(age, SHIFT_MAX_HOURS, ctx.module)}
            {shelvedHere.length > 0 && (
              <div style={{ marginTop: '0.35rem' }}>
                {/* The cooking carries on; the money is what waits. Said here
                    rather than only when somebody presses the button, so
                    nobody promises a customer a receipt they cannot print. */}
                {shelvedHere.length === 1 ? 'One order here came' : `${shelvedHere.length} orders here came`}
                {' '}in after that and cannot be paid on this shift. Close it, open a fresh one, and they will
                be waiting on it.
              </div>
            )}
          </Notice>
        </div>
      )}

      {!ctx.shift && (
        <div style={{ padding: '0.6rem 1rem' }}>
          {/* A shop has no kitchen to fall back on. Where a restaurant can
              keep cooking and settle up later, a counter sale with no shift
              open is a sale that cannot be completed at all, so the message
              says the one useful thing: open a shift. */}
          <Notice tone="warn">
            {ctx.module === 'craft'
              ? 'No shift is open, so nothing can be sold. Open one above to start taking money.'
              : 'No shift is open, so payment cannot be recorded. Orders can still be sent to the kitchen.'}
          </Notice>
        </div>
      )}

      <div className="pos-body order-layout">
        <div>
          <div className="pos-tabs" style={{ marginBottom: '0.8rem', flexWrap: 'wrap' }}>
            {sections.map((s) => (
              <button key={s.category.$id} className={sectionId === s.category.$id ? 'on' : ''} onClick={() => setSectionId(s.category.$id)}>
                {s.category.name}
                {!s.open && ' ·'}
              </button>
            ))}
          </div>
          <div className="menu-grid">
            {(sections.find((s) => s.category.$id === sectionId)?.entries ?? []).map((entry) => (
              <button
                key={entry.item.$id}
                className="menu-card"
                disabled={entry.soldOut}
                onClick={() => addItem(entry.item.$id)}
              >
                <div className="n">{entry.item.name}</div>
                <div className="p">
                  {/* With sizes there is no single price, and printing the
                      product's own would be printing a number nothing sells
                      for. The range is the honest answer at a glance. */}
                  {priceLabel(entry, ctx.settings)}
                  {entry.groups.length > 0 && ' ·opts'}
                </div>
              </button>
            ))}
          </div>
          <p className="small dim" style={{ marginTop: '0.8rem' }}>
            Items with options are added with their defaults. Change them from the bill, or take the order on the
            customer's phone for the full choice.
          </p>
        </div>

        <Card title={ctx.module === 'craft' ? 'Sale' : 'Bill'} pad>
          <div className="bill">
            {existing.map((o) => (
              <div key={o.$id} style={{ marginBottom: '0.7rem' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <Badge tone={o.status === 'READY' ? 'ok' : 'default'}>{o.order_no} · {o.status.toLowerCase()}</Badge>
                  <span className="small">{formatMoney(o.total, ctx.settings)}</span>
                </div>
                {(existingItems[o.$id] ?? []).map((i) => (
                  <div className="bill-line" key={i.$id}>
                    <span>{i.qty}× {i.name_snapshot}</span>
                    <span>{formatMoney(i.line_total, ctx.settings)}</span>
                  </div>
                ))}
              </div>
            ))}

            {cart.length > 0 && (
              <>
                <div className="small dim" style={{ margin: '0.5rem 0 0.2rem' }}>Not yet sent</div>
                {cart.map((l) => (
                  <div className="bill-line" key={l.key}>
                    <span>
                      {l.qty}× {l.name}
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setCart((c) => c.flatMap((x) => (x.key === l.key ? (x.qty > 1 ? [{ ...x, qty: x.qty - 1 }] : []) : [x])))}
                      >
                        −
                      </button>
                    </span>
                    <span>{formatMoney(lineTotal(l), ctx.settings)}</span>
                  </div>
                ))}
                <div className="bill-total grand">
                  <span>{ctx.module === 'craft' ? 'To pay' : 'New items'}</span>
                  <span>{formatMoney(newTotals.total, ctx.settings)}</span>
                </div>
                <Button variant="primary" onClick={send} loading={sending} style={{ width: '100%', marginTop: '0.7rem' }}>
                  {/* A shop has no kitchen to send anything to. The one thing
                      that happens next at a counter is being charged, so the
                      button says that and does it. */}
                  {ctx.module === 'craft'
                    ? `Take payment · ${formatMoney(newTotals.total, ctx.settings)}`
                    : 'Send to kitchen'}
                </Button>
              </>
            )}

            {existing.length > 0 && cart.length === 0 && (
              <>
                {discount > 0 && (
                  <div className="bill-total">
                    <span className="dim">{discountLabel || 'Discount'}</span>
                    <span>−{formatMoney(discount, ctx.settings)}</span>
                  </div>
                )}
                <div className="bill-total grand">
                  <span>Total due</span>
                  <span>{formatMoney(Math.max(0, billTotal - discount), ctx.settings)}</span>
                </div>
                {isEnabled(ctx.features, 'discounts') && (
                  <Button style={{ width: '100%', marginTop: '0.6rem' }} onClick={() => setShowDiscount(true)}>
                    Apply discount
                  </Button>
                )}
              </>
            )}

            {existing.length === 0 && cart.length === 0 && (
              <p className="dim small" style={{ margin: 0 }}>Tap dishes to build the order.</p>
            )}
          </div>
        </Card>
      </div>

      {showDiscount && (
        <DiscountModal
          ctx={ctx}
          subtotal={billTotal}
          onClose={() => setShowDiscount(false)}
          onApply={(amount, label) => {
            setDiscount(amount);
            setDiscountLabel(label);
            setShowDiscount(false);
          }}
        />
      )}

      {pickingSize && (() => {
        const entry = ctx.menu.byId[pickingSize];
        const sizes = (entry?.variants ?? []).filter((v) => v.active);
        return (
          <Modal title={entry?.item.name ?? 'Which one?'} onClose={() => setPickingSize(null)}>
            <p className="small dim" style={{ marginTop: 0 }}>Which one is the customer buying?</p>
            <div className="menu-grid">
              {sizes.map((v) => (
                <button
                  key={v.$id}
                  className="menu-card"
                  // Sold out rather than hidden: a customer asking for the
                  // large should be told there is none, not left wondering why
                  // it is missing from a list they can see over the counter.
                  disabled={v.on_hand <= 0}
                  onClick={() => addItem(pickingSize, v.$id)}
                >
                  <div className="n">{v.label}</div>
                  <div className="p">
                    {formatMoney(v.price, ctx.settings)}
                    {v.on_hand <= 0 ? ' · none left' : v.on_hand <= 2 ? ` · ${v.on_hand} left` : ''}
                  </div>
                </button>
              ))}
            </div>
          </Modal>
        );
      })()}

      {paying && (() => {
        /* A shop counter splits one basket between a note and a card far more
           often than a restaurant table does, so the two sides ask the question
           differently: the till asks which method and how much, the counter
           asks how much on each. Two components rather than one with branches,
           so neither can quietly change the other. */
        const props = {
          ctx,
          methods,
          orders: existing,
          amountDue: Math.max(0, billTotal - discount),
          onClose: () => setPaying(false),
          onDone: async () => {
            setPaying(false);
            if (!isTakeaway) await db.updateDocument(DB_ID, 'tables', table.$id, { status: 'dirty' }).catch(() => undefined);
            onToast('Payment recorded');
            // The shop till stays where it is, ready for the next customer.
            // Sending it "back" would land it on a screen that does not exist.
            if (ctx.module === 'craft') { setCart([]); setExisting([]); setExistingItems({}); } else onBack();
          },
          onError: (m: string) => onToast(m, 'err'),
        };
        return ctx.module === 'craft' ? <CounterPaymentModal {...props} /> : <PaymentModal {...props} />;
      })()}
    </div>
  );
}

/** Staff-applied discount, capped by what this member of staff may authorise. */
function DiscountModal({
  ctx, subtotal, onClose, onApply,
}: {
  ctx: PosContext;
  subtotal: number;
  onClose: () => void;
  onApply: (amount: number, label: string) => void;
}) {
  const [percent, setPercent] = useState('10');
  const [error, setError] = useState<string | null>(null);
  const ceilingBp = ctx.profile?.can_discount_up_to_bp ?? 0;
  const managerAboveBp = featureConfig(ctx.features, 'discounts', 'manager_pin_above_bp', 2000);

  const apply = () => {
    const bp = Math.round(Number(percent || 0) * 100);
    if (!Number.isFinite(bp) || bp <= 0) { setError('Enter a percentage.'); return; }
    if (bp > 10000) { setError('A discount cannot exceed 100%.'); return; }
    if (bp > ceilingBp) {
      setError(`You can authorise up to ${(ceilingBp / 100).toFixed(0)}%. A manager must approve more than that.`);
      return;
    }
    if (bp > managerAboveBp) {
      setError(`Anything above ${(managerAboveBp / 100).toFixed(0)}% needs a manager. Ask them to apply it.`);
      return;
    }
    onApply(Math.round((subtotal * bp) / 10000), `${percent}% discount`);
  };

  return (
    <Modal
      title="Apply discount"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={apply}>Apply</Button>
        </>
      }
    >
      <p className="small dim" style={{ marginTop: 0 }}>
        Discounts can only be applied before the bill is marked paid. Afterwards, use a refund, which leaves its own
        trail.
      </p>
      <Field label="Percentage off" error={error}>
        <Input value={percent} inputMode="decimal" onChange={(e) => setPercent(e.target.value)} />
      </Field>
      <p className="small dim">
        Your limit is {(ceilingBp / 100).toFixed(0)}%. Every discount is recorded against your name.
      </p>
    </Modal>
  );
}

/**
 * Taking money at the shop counter, where one basket is often paid two ways.
 *
 * The restaurant's box asks which method and how much. That is wrong for a
 * counter: somebody pays part in cash and the rest on the card machine in one
 * movement, and asking twice means two trips through the same form with a
 * queue behind them. So every method gets its own box and the cashier types
 * what went on each.
 *
 * Three rules, in the order they matter:
 *
 *   1. Nothing over the total. More money than the bill is a typo, not a tip;
 *      the tip has its own box.
 *   2. Less than the total is allowed, and is a part payment: the bill stays
 *      open and visible on the counter for the rest. It is never silently
 *      accepted, the cashier has to say they meant it.
 *   3. Exactly the total needs no confirming at all.
 *
 * There is no "cash given" box here on purpose. That question exists to work
 * out change, and change is a cash-drawer conversation, not a split. Where a
 * customer hands over a large note the cashier types what the sale took, and
 * the change is the note minus that, which they are holding in their hand.
 */
function CounterPaymentModal({
  ctx, methods, orders, amountDue, onClose, onDone, onError,
}: {
  ctx: PosContext;
  methods: PaymentMethod[];
  orders: Order[];
  amountDue: number;
  onClose: () => void;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const decimals = ctx.settings.currency_decimals ?? 2;
  /** What went on each method, as typed. Blank is not zero; it is untouched. */
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [tip, setTip] = useState(toInput(0, decimals));
  const [email, setEmail] = useState('');
  /** Ticked by the cashier when the customer is knowingly paying part of it. */
  const [confirmShort, setConfirmShort] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const money = (n: number) => formatMoney(n, ctx.settings);
  const amountOf = (id: string) => parseMoney(amounts[id] ?? '', decimals) ?? 0;
  const entered = methods.reduce((sum, m) => sum + amountOf(m.$id), 0);
  const over = entered > amountDue;
  const shortBy = Math.max(0, amountDue - entered);
  const askEmail =
    isEnabled(ctx.features, 'receipts') && featureConfig(ctx.features, 'receipts', 'allow_staff_enter_email', true);

  /** Put the whole bill on one method, the overwhelmingly common case. */
  const allOn = (methodId: string) =>
    setAmounts(Object.fromEntries(methods.map((m) => [m.$id, m.$id === methodId ? toInput(amountDue, decimals) : ''])));

  /** Fill whatever is left onto a method, for the second half of a split. */
  const restOn = (methodId: string) =>
    setAmounts((a) => ({ ...a, [methodId]: toInput(amountOf(methodId) + shortBy, decimals) }));

  const confirm = async () => {
    if (!ctx.shift) { setError('No shift is open.'); return; }
    const late = orders.find((o) => mustWaitForNextShift(o, ctx.shift));
    if (late) {
      setError(
        `${late.order_no} was rung up after this shift had already run past a day, so it cannot be paid on `
        + 'it. Close the shift and open a fresh one; it will be waiting there.',
      );
      return;
    }
    if (entered <= 0) { setError('Enter how much was paid, on the cash or the card line.'); return; }
    if (over) {
      setError(
        `That comes to ${money(entered)}, which is ${money(entered - amountDue)} more than the sale. ` +
        'Correct the amounts, or put the extra in the tip box.',
      );
      return;
    }
    if (shortBy > 0 && !confirmShort) {
      setError(
        `That comes to ${money(entered)}, ${money(shortBy)} short of ${money(amountDue)}. ` +
        'Tick the box to record it as a part payment, or correct the amounts.',
      );
      return;
    }
    for (const m of methods) {
      if (amountOf(m.$id) > 0 && m.requires_reference && !(refs[m.$id] ?? '').trim()) {
        setError(`Enter the reference for the ${m.name} payment.`);
        return;
      }
    }

    setBusy(true);
    setError(null);
    try {
      // How much of the tender each order carries. Worked out once, then
      // filled method by method, so the two never disagree by a rounding step.
      const owing = sharesFor(orders, entered);
      const tipMinor = parseMoney(tip, decimals) ?? 0;
      let tipPlaced = false;

      for (const m of methods) {
        let left = amountOf(m.$id);
        if (left <= 0) continue;
        for (const [index, order] of orders.entries()) {
          if (left <= 0) break;
          const share = Math.min(owing[index], left);
          if (share <= 0) continue;
          owing[index] -= share;
          left -= share;
          await recordPayment({
            venueId: ctx.venue.$id,
            order,
            shiftId: ctx.shift.$id,
            methodId: m.$id,
            methodKind: m.kind,
            amount: share,
            // The tip belongs to the tender, not to each row, so it goes on
            // the first one written rather than once per method per order.
            tip: tipPlaced ? 0 : tipMinor,
            // No change at the counter: there is no tendered figure to take it
            // off. See the note at the top of this component.
            changeGiven: 0,
            reference: (refs[m.$id] ?? '').trim(),
            takenBy: ctx.userId,
            orderStatus: 'CLOSED',
            customerEmail: email,
          });
          tipPlaced = true;
        }
      }

      if (shortBy > 0) {
        onError(`${money(entered)} taken · ${money(shortBy)} still to pay on this sale.`);
      }
      onDone();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not record the payment.';
      onError(message);
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Take payment"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={confirm} loading={busy}>
            {shortBy > 0 && entered > 0 ? 'Take part payment' : 'Mark as paid'}
          </Button>
        </>
      }
    >
      <div className="bill-total grand" style={{ marginTop: 0 }}>
        <span>To pay</span>
        <span>{money(amountDue)}</span>
      </div>

      <p className="small dim" style={{ marginTop: '0.2rem' }}>
        Put what the customer paid against each one. Split it however they paid it; the amounts have to add up to the
        sale.
      </p>

      <div className="stack" style={{ gap: '0.55rem', marginBottom: '0.8rem' }}>
        {methods.map((m) => (
          <div key={m.$id}>
            <div className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
              <span style={{ flex: 1 }}>{m.name}</span>
              <Input
                value={amounts[m.$id] ?? ''}
                inputMode="decimal"
                placeholder={toInput(0, decimals)}
                style={{ width: '8rem', textAlign: 'right' }}
                aria-label={`${m.name} (${ctx.settings.currency_symbol})`}
                onChange={(e) => setAmounts((a) => ({ ...a, [m.$id]: e.target.value }))}
              />
              <Button size="sm" variant="ghost" onClick={() => allOn(m.$id)}>All</Button>
              {shortBy > 0 && entered > 0 && (
                <Button size="sm" variant="ghost" onClick={() => restOn(m.$id)}>Rest</Button>
              )}
            </div>
            {amountOf(m.$id) > 0 && m.requires_reference && (
              <Field label={`${m.name} reference`} hint="From the card machine or the mobile money message.">
                <Input value={refs[m.$id] ?? ''} onChange={(e) => setRefs((r) => ({ ...r, [m.$id]: e.target.value }))} />
              </Field>
            )}
          </div>
        ))}
      </div>

      {/* The running answer, always on screen, so nobody has to add up two
          boxes in their head with a customer waiting. */}
      <div className="bill-total" style={{ fontWeight: 600 }}>
        <span>Entered</span>
        <span>{money(entered)}</span>
      </div>

      {over && (
        <Notice>
          That is {money(entered - amountDue)} more than the sale. Correct the amounts, or put the extra in the tip
          box below.
        </Notice>
      )}

      {shortBy > 0 && entered > 0 && (
        <Notice tone="warn">
          <div><strong>{money(shortBy)} short of {money(amountDue)}.</strong></div>
          <label className="row" style={{ gap: '0.45rem', marginTop: '0.45rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={confirmShort}
              onChange={(e) => setConfirmShort(e.target.checked)}
            />
            <span className="small">
              Yes, they are paying {money(entered)} now. The rest stays owing on this sale.
            </span>
          </label>
        </Notice>
      )}

      {asksForTip(ctx.settings, 'till') && (
        <Field label={`Tip (${ctx.settings.currency_symbol})`} hint="Kept apart from the sale. Not taxed as sales.">
          <Input value={tip} inputMode="decimal" onChange={(e) => setTip(e.target.value)} />
        </Field>
      )}

      {askEmail && (
        <Field label="Email the receipt to" hint="Optional. Leave blank to skip, no receipt is sent.">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      )}

      {error && <Notice>{error}</Notice>}
    </Modal>
  );
}

/** Records how a bill was settled. No money moves through this app. */
function PaymentModal({
  ctx, methods, orders, amountDue, onClose, onDone, onError,
}: {
  ctx: PosContext;
  methods: PaymentMethod[];
  orders: Order[];
  amountDue: number;
  onClose: () => void;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const decimals = ctx.settings.currency_decimals ?? 2;
  const [methodId, setMethodId] = useState(methods[0]?.$id ?? '');
  const [amount, setAmount] = useState(toInput(amountDue, decimals));
  const [tip, setTip] = useState(toInput(0, decimals));
  const [reference, setReference] = useState('');
  const [email, setEmail] = useState('');
  /**
   * What the customer physically handed over, which is not the same number as
   * what is going against the bill.
   *
   * They were one box before, so working out change meant typing the tendered
   * amount into "amount taken", which then looked like an overpayment and made
   * a part payment impossible to record at the same time. Two boxes, two
   * questions: how much of this bill is being settled, and what was handed
   * over to settle it.
   */
  const [cash, setCash] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const method = methods.find((m) => m.$id === methodId);
  const paid = parseMoney(amount, decimals) ?? 0;
  const tendered = parseMoney(cash, decimals) ?? 0;
  const isCash = method?.kind === 'cash';
  // Change comes off what was handed over, never off the bill. A customer
  // paying half a bill with a large note is still owed change.
  const change = isCash && tendered > paid ? tendered - paid : 0;
  const short = isCash && cash.trim() !== '' && tendered > 0 && tendered < paid;
  const askEmail = isEnabled(ctx.features, 'receipts') && featureConfig(ctx.features, 'receipts', 'allow_staff_enter_email', true);

  const confirm = async () => {
    if (!ctx.shift) { setError('No shift is open.'); return; }
    // Taken after the shift should have closed. See the notice on the order
    // screen: the food happens, the money waits for the next shift.
    const late = orders.find((o) => mustWaitForNextShift(o, ctx.shift));
    if (late) {
      setError(
        `${late.order_no} came in after this shift had already run past a day, so it cannot be paid on it. `
        + 'Close the shift and open a fresh one; it will be waiting there.',
      );
      return;
    }
    if (!methodId) { setError('Choose how it was paid.'); return; }
    // Less than the full amount is allowed and is not an error: a table
    // splitting the bill pays it in pieces. What is not allowed is nothing.
    if (paid <= 0) { setError('Enter how much is being paid.'); return; }
    // Cash that does not cover what is being recorded is a typo somewhere. The
    // drawer will not balance either way; better to catch it at the counter.
    if (short) {
      setError('The cash given is less than the amount being paid. Correct one of them.');
      return;
    }
    if (method?.requires_reference && !reference.trim()) { setError('Enter the reference from the card machine.'); return; }

    setBusy(true);
    setError(null);
    try {
      // What was actually handed over, not what the bill came to, the two
      // differ whenever somebody pays part of it, and recording the bill total
      // against a part payment would mark the whole thing settled.
      const taken = Math.min(paid, amountDue);
      const shares = sharesFor(orders, taken);

      for (const [index, order] of orders.entries()) {
        const share = shares[index];
        await recordPayment({
          venueId: ctx.venue.$id,
          order,
          shiftId: ctx.shift.$id,
          methodId,
          methodKind: method?.kind ?? 'cash',
          amount: share,
          // The tip belongs to the tender, not to each order, so it goes on
          // the first row only rather than being counted once per order.
          tip: index === 0 ? parseMoney(tip, decimals) ?? 0 : 0,
          // On the first order only; the change was given once, not once per
          // order on a bill that covers several.
          changeGiven: index === 0 ? change : 0,
          reference: reference.trim(),
          takenBy: ctx.userId,
          orderStatus: 'CLOSED',
          customerEmail: email,
        });
      }
      if (paid < amountDue) {
        onError(
          `${formatMoney(paid, ctx.settings)} taken · ` +
          `${formatMoney(amountDue - paid, ctx.settings)} still to pay on this bill.`,
        );
      }
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not record the payment.');
      setError(e instanceof Error ? e.message : 'Could not record the payment.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Take payment"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={confirm} loading={busy}>
            {paid > 0 && paid < amountDue ? 'Take part payment' : 'Mark as paid'}
          </Button>
        </>
      }
    >
      <div className="bill-total grand" style={{ marginTop: 0 }}>
        <span>Due</span>
        <span>{formatMoney(amountDue, ctx.settings)}</span>
      </div>
      {paid > 0 && paid < amountDue && (
        <p className="small" style={{ color: 'var(--warn)', marginTop: '0.3rem' }}>
          {formatMoney(amountDue - paid, ctx.settings)} will still be owed after this.
        </p>
      )}

      <Field label="Paid by">
        <Select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
          {methods.map((m) => <option key={m.$id} value={m.$id}>{m.name}</option>)}
        </Select>
      </Field>

      <div className="grid-2">
        <Field
          label={`Amount taken (${ctx.settings.currency_symbol})`}
          hint="Less than the total is fine, the bill stays open for whoever is paying the rest."
        >
          <Input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {isCash && (
          <Field
            label={`Cash given (${ctx.settings.currency_symbol})`}
            hint="What the customer handed over. Leave blank if it was the exact amount."
          >
            <Input value={cash} inputMode="decimal" onChange={(e) => setCash(e.target.value)} />
          </Field>
        )}
        {asksForTip(ctx.settings, 'till') && (
          <Field label={`Tip (${ctx.settings.currency_symbol})`} hint="Not taxed as sales.">
            <Input value={tip} inputMode="decimal" onChange={(e) => setTip(e.target.value)} />
          </Field>
        )}
      </div>

      {/* Quick ways to fill the two boxes, because a counter is not the place
          to do arithmetic. Part of the bill, all of it, or the note in the
          customer's hand. */}
      <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
        <Button size="sm" onClick={() => setAmount(toInput(amountDue, decimals))}>
          Pay all · {formatMoney(amountDue, ctx.settings)}
        </Button>
        <Button size="sm" onClick={() => setAmount(toInput(Math.round(amountDue / 2), decimals))}>
          Half
        </Button>
        {isCash && (
          <Button size="sm" onClick={() => setCash(toInput(paid, decimals))}>Exact cash</Button>
        )}
      </div>

      {change > 0 && (
        <Notice tone="ok">Change to give: <strong>{formatMoney(change, ctx.settings)}</strong></Notice>
      )}
      {short && (
        <Notice tone="warn">
          The cash given is less than the amount being paid. Change one of them before recording it.
        </Notice>
      )}

      {method?.requires_reference && (
        <Field label="Reference" hint="From the card machine or mobile money confirmation.">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      )}


      {askEmail && (
        <Field label="Email the receipt to" hint="Optional. Leave blank to skip, no receipt is sent.">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      )}

      {error && <Notice>{error}</Notice>}
    </Modal>
  );
}
