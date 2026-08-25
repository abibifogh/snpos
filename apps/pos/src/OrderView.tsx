import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Field, Input, Modal, Notice, Select, Badge, Spinner } from '@snpos/ui';
import {
  db, DB_ID, ID, Query, listAll, createOrder, computeTotals, lineTotal, formatMoney,
  parseMoney, toInput, isEnabled, featureConfig, visibleSections, recordPayment, asksForTip,
  variantPriceRange, shiftUsable, shiftAgeOf, shiftAgeMessage, SHIFT_MAX_HOURS, sharesFor, shouldWarnLateOrder,
  sellBlockedReason, previewUrl,
  findCode, codeProblem, discountAmount, needsManager, discountLabelFor,
  loadRecipes, loadIngredients, pourList, showsRecipe,
  park, unpark, parkProblem, parkKey, describeParked, autoLabel, isStale,
  cartKey, cartWorthHolding, restorableCart, restoredWords,
  chipColour, showsPicture, inkOn, downloadUrl, isService, canRepriceLine,
  amountDueOn, unrungProblem,
} from '@snpos/core';
import type {
  CartAddon, CartLine, Order, OrderItem, Doc, MenuEntry, Settings, DiscountRow,
  Recipe, Ingredient, MenuItem, TakenPayment,
} from '@snpos/core';
import { OptionSheet } from './OptionSheet';
import { COUNTER_TABLE_ID, BAR_COUNTER_TABLE_ID } from './App';
import type { ParkedSale } from '@snpos/core';
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
  // None of these is tied to a seat, and all create counter-channel orders.
  // They are still different places: see COUNTER_TABLE_ID. Leaving the bar out
  // of this made every drink poured at the bar look like a seated order, so it
  // asked for a table that does not exist and held the bill open against it.
  const isTakeaway = table.$id === 'takeaway'
    || table.$id === COUNTER_TABLE_ID
    || table.$id === BAR_COUNTER_TABLE_ID;

  /**
   * Rung up and paid for in one movement, with nowhere to send it.
   *
   * This is the shape of a sale, not the name of a module. A craft counter and
   * a bar are the same thing here — somebody is standing in front of you and
   * the next thing that happens is being charged — while a bar running a tab
   * against a table is the restaurant's shape, settled later.
   *
   * These checks all used to read `module === 'craft'`, which is why switching
   * the till to the bar produced the kitchen's screen: a bar is not a craft
   * shop, so every one of them fell through to the dining room.
   */
  const counterSale = ctx.module === 'craft' || table.$id === BAR_COUNTER_TABLE_ID;

  /** Where an order goes when it is not paid on the spot. */
  const pass = ctx.module === 'bar' ? 'the bar' : 'the kitchen';

  const [cart, setCart] = useState<CartLine[]>([]);
  /**
   * Sales put down so the next customer can be served.
   *
   * On this device only, and nothing is written to the database — see the note
   * in parking.ts. A parked sale is a basket somebody is still filling, and
   * turning it into a real unpaid order would put drinks on the bar screen
   * nobody has asked to be poured and hold the shift open on bills that do not
   * exist.
   */
  const [parked, setParked] = useState<ParkedSale[]>([]);
  const [showParked, setShowParked] = useState(false);
  const [parkLabel, setParkLabel] = useState('');
  const [parking, setParking] = useState(false);
  const [existing, setExisting] = useState<Order[]>([]);
  /**
   * Money already recorded against those bills.
   *
   * Only so the till can ask for what is LEFT. A table that settled half its
   * bill owes the other half, and a counter that asks for the whole thing
   * again either takes it twice or is refused outright by the write.
   */
  const [taken, setTaken] = useState<(TakenPayment & Doc)[]>([]);
  const [existingItems, setExistingItems] = useState<Record<string, OrderItem[]>>({});
  const [methods, setMethods] = useState<PaymentMethod[]>([]);

  /*
    Parked sales, read from and written to this device.

    Wrapped in try/catch at both ends. A browser with site data blocked throws
    on the accessor itself, and a till that will not open because it could not
    read a basket is a till nobody can sell from — the sale in front of
    somebody matters more than the ones put down earlier.
  */
  const parkStore = parkKey(ctx.venue.$id, ctx.module);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(parkStore);
      setParked(raw ? (JSON.parse(raw) as ParkedSale[]) : []);
    } catch {
      setParked([]);
    }
  }, [parkStore]);

  const writeParked = (next: ParkedSale[]) => {
    setParked(next);
    try {
      window.localStorage.setItem(parkStore, JSON.stringify(next));
    } catch {
      // Nothing to do and nothing worth interrupting a sale over. The list on
      // screen is still right for as long as this till stays open.
    }
  };


  const doPark = () => {
    const lines = cart.map((l) => ({
      key: l.key,
      menu_item_id: l.menu_item_id,
      name: l.name,
      unit_price: l.unit_price,
      qty: l.qty,
      // The whole add-on, ids included. A basket picked back up must be the
      // one that was put down; losing the option and group would produce a
      // bill that looks right on screen and orders the wrong thing.
      addons: (l.addons ?? []).map((a) => ({ ...a })),
      notes: l.notes,
      variant_id: l.variant_id,
      variant_label: l.variant_label,
      list_price: l.list_price,
    }));
    const problem = parkProblem(lines, parked);
    if (problem) { onToast(problem, 'err'); return; }

    writeParked(park(parked, {
      id: `p${Date.now()}`,
      label: parkLabel.trim() || autoLabel(lines),
      lines,
      discount,
      discountLabel,
      discountId,
      parkedAt: new Date().toISOString(),
      by: ctx.profile?.display_name,
    }));
    // The counter is cleared, which is the point: the next customer is served
    // on an empty till rather than on somebody else's basket. Clearing the cart
    // clears what was held with it — see the effect that writes it — because
    // the basket now lives on the parked list instead.
    setCart([]);
    setDiscount(0);
    setDiscountLabel('');
    setDiscountId('');
    setParkLabel('');
    setParking(false);
    onToast('Parked. Pick it back up from Parked sales.');
  };

  const doUnpark = (id: string) => {
    const { sale, rest } = unpark(parked, id);
    if (!sale) return;
    /*
      Refused while something is already on the counter.

      Merging two baskets would be a guess at what somebody meant, and the
      wrong guess charges a customer for another customer's shopping. Park
      what is there first, then pick this one up — two taps, and neither of
      them can go wrong.
    */
    if (cart.length > 0) {
      onToast('Park or clear the sale on the counter first, so the two do not get mixed up.', 'err');
      return;
    }
    setCart(sale.lines.map((l) => ({ ...l, addons: l.addons ?? [] })));
    setDiscount(sale.discount ?? 0);
    setDiscountLabel(sale.discountLabel ?? '');
    setDiscountId(sale.discountId ?? '');
    writeParked(rest);
    setShowParked(false);
    onToast(`${sale.label} is back on the counter.`);
  };
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [paying, setPaying] = useState(false);
  const [discount, setDiscount] = useState(0);
  const [discountLabel, setDiscountLabel] = useState('');
  /** Which code it came from, so the sale can be counted against that offer. */
  const [discountId, setDiscountId] = useState('');
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
  /*
    The bar's recipes, and the drink currently being looked at.

    Loaded once when the bar till opens, not on every peek: two reads at the
    start of a shift, then instant every time afterwards. Read allowance is not
    an abstract concern on this project — it took the whole system down one
    morning — and a bartender checking six drinks in a rush should not cost six
    round trips.

    Only for the bar. A kitchen till pays nothing for a feature it does not
    show.
  */
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [barIngredients, setBarIngredients] = useState<Ingredient[]>([]);
  const [peeking, setPeeking] = useState<MenuItem | null>(null);
  /**
   * A cart line whose price is being changed at the counter.
   *
   * Granted per person, off for everybody until an admin says otherwise. The
   * craft counter is where this actually matters: a piece with a chip in it, a
   * maker's price for a friend, a display item going for less than a new one.
   * A plate of jollof does not have that problem, which is why this is a
   * permission and not a button everybody gets.
   */
  const [repricing, setRepricing] = useState<CartLine | null>(null);
  /** The dish whose choices are being asked for, and the size already picked. */
  const [pickingOptions, setPickingOptions] = useState<{ menuItemId: string; variantId?: string } | null>(null);

  /*
    THE SALE ON THE COUNTER, KEPT ACROSS A RELOAD.

    Not parking — nobody chose this. A tablet sleeps and the browser discards
    the tab, an app is closed by a stray swipe, the till is reloaded to pick up
    a price change, and eleven lines rung up in front of a waiting customer
    were gone. See parking.ts for why it lives on the device and not in the
    database.

    Per table as well as per side: a bill on table four and one at the counter
    exist at the same time, and one key for both would put the counter's basket
    onto table four the moment somebody walked over.
  */
  const cartStore = cartKey(ctx.venue.$id, ctx.module, table.$id);
  /**
   * Whether the basket that was here has been dealt with.
   *
   * A ref rather than state: the restore must happen once, and it must not
   * happen again because a re-render made the cart briefly empty.
   */
  const restored = useRef(false);

  const forgetHeld = () => {
    try { window.localStorage.removeItem(cartStore); } catch { /* see below */ }
  };

  useEffect(() => {
    // A different table, or a different side, is a different basket.
    restored.current = false;
  }, [cartStore]);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    let held = null;
    try {
      held = restorableCart(window.localStorage.getItem(cartStore));
    } catch {
      // A browser with site data blocked throws on the accessor itself.
      return;
    }
    if (!held) return;
    /*
      Never over the top of something.

      By the time this runs the till may already have a basket on it — a sale
      picked up from Parked, a line added while the read was in flight — and
      merging two baskets charges a customer for another customer's shopping.
      The held one stays where it is and will be restored on the next empty
      counter instead.
    */
    if (cart.length > 0) return;
    setCart(held.lines.map((l) => ({ ...l, addons: l.addons ?? [] })));
    setDiscount(held.discount ?? 0);
    setDiscountLabel(held.discountLabel ?? '');
    setDiscountId(held.discountId ?? '');
    onToast(restoredWords(held));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartStore]);

  /*
    Written as it is typed, not on the way out.

    There is no way out to hook. The events that lose a cart — a tab closing, a
    tablet sleeping, a browser reloading a page it has sat on all afternoon —
    are exactly the ones that do not run any code first.

    An EMPTY cart clears the record rather than saving an empty one, so a sale
    that has been paid for and cleared does not come back on the next reload.
  */
  useEffect(() => {
    const lines = cart.map((l) => ({
      key: l.key,
      menu_item_id: l.menu_item_id,
      name: l.name,
      unit_price: l.unit_price,
      qty: l.qty,
      addons: l.addons,
      notes: l.notes,
      variant_id: l.variant_id,
      variant_label: l.variant_label,
      list_price: l.list_price,
    }));
    if (!cartWorthHolding(lines)) { forgetHeld(); return; }
    try {
      window.localStorage.setItem(cartStore, JSON.stringify({
        lines, discount, discountLabel, discountId, heldAt: new Date().toISOString(),
      }));
    } catch {
      // Nothing worth interrupting a sale over. The basket on screen is still
      // right for as long as this till stays open, which is the ordinary case.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, discount, discountLabel, discountId, cartStore]);

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

  /** The section on screen, needed for its name as well as its entries. */
  const shownSection = sections.find((s) => s.category.$id === sectionId) ?? null;

  /*
    The bar's recipes, once per shift.

    Deliberately not part of the load below: a failure here must not stop a
    till from taking money. Not knowing how a drink is made is an
    inconvenience; not being able to sell it is the business stopping. So it
    fails to an empty list, the question marks simply do not appear, and
    nothing else notices.
  */
  useEffect(() => {
    if (ctx.module !== 'bar' || recipes) return;
    (async () => {
      const [r, ing] = await Promise.all([
        loadRecipes().catch(() => [] as Recipe[]),
        loadIngredients(ctx.venue.$id).catch(() => [] as Ingredient[]),
      ]);
      setRecipes(r);
      // This side's shelves only, so a drink cannot name the kitchen's rice.
      setBarIngredients(ing.filter((i) => (i.module ?? 'kitchen') === 'bar'));
    })();
  }, [ctx.module, ctx.venue.$id, recipes]);

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
       * The bar is the same case, and for a sharper reason: a tab left open at
       * the counter is the normal way a bar works, not an error. Without this
       * the drink would be poured, the payment would fail, and the only screen
       * that could take the money would have forgotten the order existed.
       *
       * Restaurant takeaway keeps its old behaviour, where each order is
       * started fresh from the takeaway list.
       */
      if (!isTakeaway || ctx.module === 'craft' || ctx.module === 'bar') {
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
          /*
            What has already been paid on these bills.

            A table that settled half its bill an hour ago owes the other half,
            and a till that asks for the whole thing again either takes twice
            the money or — now that the write refuses an overpayment — cannot
            take any. Read here, with the lines, rather than per payment.
          */
          setTaken(
            await listAll<TakenPayment & Doc>('payments', [
              Query.equal('order_id', live.map((o) => o.$id)),
            ]).catch(() => []),
          );
        }
      }
      setSectionId(sections[0]?.category.$id ?? null);
      setLoading(false);
    })();
  }, [ctx.venue.$id, table.$id, isTakeaway, sections]);

  /**
   * `addons` undefined means the question has not been put yet; an array,
   * empty included, means it has been answered.
   *
   * The distinction matters for a group where everything is optional. Staff
   * who look at the choices and pick none have answered, and treating that
   * empty answer as "not asked" would put the same sheet back up, for ever.
   */
  const addItem = (menuItemId: string, variantId?: string, addons?: CartAddon[]) => {
    const entry = ctx.menu.byId[menuItemId];
    if (!entry) return;

    // Sizes have to be answered before a price exists. Asked once, here, so no
    // caller has to remember to.
    const sizes = (entry.variants ?? []).filter((v) => v.active);
    if (sizes.length > 0 && !variantId) { setPickingSize(menuItemId); return; }
    const size = variantId ? sizes.find((v) => v.$id === variantId) ?? null : null;

    /**
     * And the options, which this till never asked for at all.
     *
     * A dish set up with choices — spice level, which side, no onions — got
     * them on the customer's phone and not from a member of staff taking the
     * same order at the counter. So the kitchen ticket for a walk-in was
     * missing the one thing that says how to cook it, and it was missing
     * because it had never been asked, not because it was not being shown.
     *
     * Asked after the size, which is the order a person asks in: which one,
     * then how would you like it.
     */
    if (entry.groups.length > 0 && addons === undefined) {
      setPickingSize(null);
      setPickingOptions({ menuItemId, variantId: size?.$id });
      return;
    }
    const picked = addons ?? [];

    setPickingSize(null);
    setPickingOptions(null);
    setCart((c) => {
      // Only lines with nothing chosen on them merge. Two of the same dish
      // cooked differently are two instructions, and rolling them into "2×"
      // would send one of them out wrong.
      const twin = c.find(
        (l) =>
          l.menu_item_id === menuItemId &&
          (l.variant_id ?? '') === (size?.$id ?? '') &&
          l.addons.length === 0 &&
          picked.length === 0 &&
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
          addons: picked,
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

  /**
   * May the person at the till change the price of THIS line?
   *
   * Never inferred from the role. An admin who does not want their weekend
   * cashier discounting stock by hand should be able to say so, and a role is
   * too blunt an instrument for that.
   *
   * Asked per line rather than once for the whole till, because a shop can now
   * name people on a particular product: the display baskets get haggled over,
   * so the counter that sells them may drop a basket's price and nothing
   * else's. See canRepriceLine.
   *
   * The person is whoever entered a PIN, not whichever account this device was
   * signed in with months ago — ctx.profile is swapped when the till is
   * unlocked, so the permission follows the person standing there.
   */
  const canChangePrice = (line: { menu_item_id: string }) =>
    canRepriceLine(ctx.profile, ctx.menu.byId[line.menu_item_id]?.item);

  const newTotals = computeTotals({ lines: cart, settings: ctx.settings });

  // What is already owed, plus whatever is being added right now. For the
  // running total on screen, which is what somebody reads out to a customer.
  const billTotal = existing.reduce((s, o) => s + o.total, 0) + (cart.length ? newTotals.total : 0);

  /**
   * What may actually be TAKEN, which is not the same figure.
   *
   * Only bills that exist. The running total above includes what is still on
   * the counter, and money taken against that gets filed on the orders that do
   * exist — thirty cedis against a twenty cedi bracelet, while the lip balm
   * that made up the difference leaves the shop never rung up, never off the
   * shelf, and never paid to whoever made it. See due.ts.
   */
  const dueNow = amountDueOn(existing, taken);

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
  const shelvedHere = existing.filter((o) => shouldWarnLateOrder(o, ctx.shift));

  const send = async () => {
    if (cart.length === 0) return;
    // Starting NEW business on a shift that should have closed a day ago is
    // the thing being stopped. What is already on it can still be settled.
    /*
      Two different reasons, and they used to share one message.

      shiftAgeMessage describes a shift that has been open too long, and with
      NO shift open there is no age to describe — so it returned an empty
      string and the till put an empty red box in the corner of the screen.
      Something visibly went wrong and the person was handed nothing to act on.
    */
    const blocked = sellBlockedReason(ctx.shift, ctx.module);
    if (blocked) {
      onToast(blocked, 'err');
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
      /*
        The code's use, written down.

        Without this a discount is a number on one bill and nothing else: the
        offer's own counter never moves, so a code limited to fifty uses runs
        for ever, and nobody can answer what a promotion actually cost. Written
        after the order because it points at one, and never fatal — a sale that
        went through must not be undone by its own bookkeeping.
      */
      if (discountId && discount > 0) {
        await db.createDocument(DB_ID, 'discount_redemptions', ID.unique(), {
          venue_id: ctx.venue.$id,
          discount_id: discountId,
          code_snapshot: discountLabel,
          order_id: order.$id,
          amount: discount,
          stage: 'staff_post_accept',
          applied_by: ctx.userId,
          status: 'applied',
        }).catch(() => undefined);
        await db.getDocument(DB_ID, 'discounts', discountId)
          .then((d) => db.updateDocument(DB_ID, 'discounts', discountId, {
            used_count: ((d as unknown as { used_count?: number }).used_count ?? 0) + 1,
          }))
          .catch(() => undefined);
      }

      setExisting((e) => [...e, order]);
      const rows = await listAll<OrderItem>('order_items', [Query.equal('order_id', order.$id)]);
      setExistingItems((m) => ({ ...m, [order.$id]: rows }));
      setCart([]);
      setDiscount(0);
      setDiscountLabel('');
      setDiscountId('');
      if (!isTakeaway) await db.updateDocument(DB_ID, 'tables', table.$id, { status: 'ordered' }).catch(() => undefined);
      if (counterSale) {
        // Nothing is being sent anywhere. A counter sale is rung up and paid
        // for in one movement, so the till goes straight to taking the money
        // rather than announcing a kitchen that does not exist.
        onToast(`${order.order_no} rung up`);
        setPaying(true);
      } else {
        onToast(`Order ${order.order_no} sent to ${pass}`);
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
        {!counterSale && <Button variant="ghost" onClick={onBack}>← Tables</Button>}
        <strong>
          {ctx.module === 'craft' ? 'Counter sale'
            : counterSale ? 'Bar sale'
            : isTakeaway ? 'Takeaway order'
            : `Table ${table.label}`}
        </strong>
        <div className="row" style={{ gap: '0.35rem' }}>
          {/*
            Putting a bill down and picking it up again.

            Only where a sale is rung up and paid in one movement — a table
            already holds its own bill, so parking one would be two ways of
            doing the same thing and a way to lose a table's order. See
            counterSale.
          */}
          {counterSale && cart.length > 0 && (
            <Button onClick={() => { setParkLabel(''); setParking(true); }}>Park this sale</Button>
          )}
          {counterSale && parked.length > 0 && (
            <Button onClick={() => setShowParked(true)}>
              Parked · {parked.length}
            </Button>
          )}
          {existing.length > 0 && (
            <Button
              variant="primary"
              onClick={() => {
                /*
                  Refused while anything is still on the counter.

                  Not a fussy rule. The money would be taken against the bills
                  that exist, and the item that made up the difference would
                  leave the shop never rung up — off nobody's shelf, on nobody's
                  count sheet, and never paid to whoever made it. Ringing it up
                  is the button beside this one.
                */
                const problem = unrungProblem(
                  cart.reduce((n, l) => n + l.qty, 0),
                  newTotals.total,
                  (n) => formatMoney(n, ctx.settings),
                );
                if (problem) { onToast(problem, 'err'); return; }
                setPaying(true);
              }}
              disabled={!ctx.shift || !ctx.profile?.can_mark_paid}
            >
              {/* What is actually collectable, not the running total. Asking
                  for a figure the till will then refuse to take is worse than
                  showing the smaller one. */}
              Take payment · {formatMoney(Math.max(0, dueNow - discount), ctx.settings)}
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
                {/* Said, not enforced. Anything here can still be paid for; it
                    simply lands on the shift that is open at the time. */}
                {shelvedHere.length === 1 ? 'One order here came' : `${shelvedHere.length} orders here came`}
                {' '}in after that. Paying now records it against this shift; close first and it moves to the
                next one instead.
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
            {counterSale
              ? 'No shift is open, so nothing can be sold. Open one above to start taking money.'
              : `No shift is open, so payment cannot be recorded. Orders can still be sent to ${pass}.`}
          </Notice>
        </div>
      )}

      <div className="pos-body order-layout">
        <div>
          <div className="pos-tabs" style={{ marginBottom: '0.8rem', flexWrap: 'wrap' }}>
            {sections.map((s) => {
              /*
                The colour an admin gave this category, or nothing.

                Painted on every chip INCLUDING the selected one, and selection
                is shown as a ring instead. The first attempt left the selected
                chip alone so it kept the till's own highlight — which is a
                colour, and a category coloured the same as that highlight was
                then indistinguishable from the live tab. Signalling selection
                with colour cannot survive somebody choosing that colour.

                A ring is a shape, so it works on any colour and on none.

                A category with a picture gets its picture instead; see
                chipColour, which returns nothing for those.
              */
              const paint = chipColour(s.category);
              const chosen = sectionId === s.category.$id;
              const pic = showsPicture(s.category) && s.category.image_id
                ? downloadUrl(s.category.image_id, 'menu', ctx.settings)
                : null;
              return (
                <button
                  key={s.category.$id}
                  className={chosen ? 'on' : ''}
                  onClick={() => setSectionId(s.category.$id)}
                  style={paint
                    ? {
                      background: paint,
                      color: inkOn(paint),
                      borderColor: paint,
                      // The ring is drawn in the chip's own text colour, so it
                      // is legible on a dark swatch and on a light one without
                      // needing to know which this is.
                      boxShadow: chosen ? `inset 0 0 0 3px ${inkOn(paint)}` : undefined,
                      fontWeight: chosen ? 700 : undefined,
                    }
                    : undefined}
                >
                  {pic && <img className="chip-pic" src={pic} alt="" />}
                  {s.category.name}
                  {!s.open && ' ·'}
                </button>
              );
            })}
          </div>
          <div className={ctx.module === 'kitchen' ? 'menu-grid' : 'menu-grid with-pics'}>
            {(shownSection?.entries ?? []).map((entry) => {
              /*
                A shop sells things that look like something.

                On the kitchen side a name is enough — nobody serving needs a
                photograph of jollof to find it. A craft counter is the other
                way round: the stock is one-off pieces with names like "Bowl,
                medium" that three different makers all use, and the thing
                actually on the shelf is the only reliable way to tell them
                apart. So the picture leads here and the name follows it.

                Only where there is one. A grid of grey placeholder squares is
                worse than a grid of names, so an item with no photograph keeps
                the plain tile rather than being given an empty frame.
              */
              /*
                A picture wherever there is one, on both counters that sell
                things rather than cook them.

                This was the shop's alone. A bar has the same problem for the
                same reason: forty bottles whose names are three words of
                brand and one of size, told apart far faster by the label than
                by reading. The kitchen is the exception — nobody serving
                needs a photograph of jollof to find it.

                Still only where a picture exists. A grid of grey placeholders
                is worse than a grid of names.
              */
              const img = ctx.module === 'kitchen'
                ? null
                : previewUrl(entry.item.image_id, 'menu', ctx.settings, 240, 240);
              /*
                A bartender should be able to check how a drink is made.

                The recipe already exists — it is what depletes stock when a
                cocktail sells. It has just never been visible to the person
                actually making the drink, who works from memory or a card
                taped inside a cupboard. A new bartender, or a regular one on
                something that sells twice a month, is guessing.

                A corner button rather than a tap on the tile itself: the tile
                adds the drink to the bill, and that is the thing being done
                two hundred times a night. It must not become a two-step
                choice because of a feature used occasionally.
              */
              const peekable = ctx.module === 'bar'
                && showsRecipe(entry.item.$id, recipes ?? [], shownSection?.category.name);
              const card = (
                <button
                  key={peekable ? undefined : entry.item.$id}
                  className={img ? 'menu-card has-pic' : 'menu-card'}
                  disabled={entry.soldOut}
                  onClick={() => addItem(entry.item.$id)}
                >
                  {img && (
                    <img
                      className="pic"
                      src={img}
                      alt=""
                      loading="lazy"
                      style={{ objectPosition: `${(entry.item.image_focal_x ?? 0.5) * 100}% ${(entry.item.image_focal_y ?? 0.5) * 100}%` }}
                    />
                  )}
                  <div className="n">{entry.item.name}</div>
                  <div className="p">
                    {/* With sizes there is no single price, and printing the
                        product's own would be printing a number nothing sells
                        for. The range is the honest answer at a glance. */}
                    {priceLabel(entry, ctx.settings)}
                    {entry.groups.length > 0 && ' ·opts'}
                  </div>
                  {entry.soldOut && <span className="soldout">Sold</span>}
                </button>
              );

              if (!peekable) return card;
              return (
                <div className="menu-card-wrap" key={entry.item.$id}>
                  {card}
                  <button
                    className="recipe-peek"
                    // Sold out still shows the recipe. Knowing what went into
                    // a drink you cannot pour is how you tell a customer what
                    // else is like it.
                    onClick={() => setPeeking(entry.item)}
                    title={`How ${entry.item.name} is made`}
                    aria-label={`How ${entry.item.name} is made`}
                  >
                    ?
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <Card title={counterSale ? 'Sale' : 'Bill'} pad>
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
                  <div className="bill-line cart-line" key={l.key}>
                    <div className="what">
                      <div className="name">{l.name}</div>
                      {/* Read back before it is sent. Somebody who mis-taps a
                          spice level should see it here, not hear about it
                          from the customer after the plate has gone out. */}
                      {l.addons.length > 0 && (
                        <div className="small dim">{l.addons.map((a) => a.name).join(', ')}</div>
                      )}
                      {/* What it should have cost, kept beside what it is
                          costing. A price changed at the counter is a decision
                          somebody made, and it should be legible on the bill
                          rather than only in a report a month later. */}
                      {l.list_price !== undefined && l.list_price !== l.unit_price && (
                        <div className="small" style={{ color: 'var(--warn)' }}>
                          was {formatMoney(l.list_price, ctx.settings)} each
                        </div>
                      )}
                    </div>

                    {/*
                      A stepper, not a lone minus.

                      There was one ghost "−" tucked after the name, and it was
                      the only way to change a quantity: adding a second of
                      something meant going back to the grid and finding the
                      tile again. Two big targets side by side, with the count
                      between them, is what somebody standing at a counter with
                      a queue reaches for — and on a touch screen a 44px target
                      is the difference between one tap and three.
                    */}
                    <div className="qty-step">
                      <button
                        type="button"
                        aria-label={l.qty > 1 ? `One fewer ${l.name}` : `Remove ${l.name}`}
                        onClick={() => setCart((c) => c.flatMap((x) => (
                          x.key === l.key ? (x.qty > 1 ? [{ ...x, qty: x.qty - 1 }] : []) : [x]
                        )))}
                      >
                        −
                      </button>
                      <span className="n">{l.qty}</span>
                      <button
                        type="button"
                        aria-label={`One more ${l.name}`}
                        onClick={() => setCart((c) => c.map((x) => (
                          x.key === l.key ? { ...x, qty: x.qty + 1 } : x
                        )))}
                      >
                        +
                      </button>
                    </div>

                    {canChangePrice(l) ? (
                      <button
                        type="button"
                        className="line-price editable"
                        onClick={() => setRepricing(l)}
                        title="Change the price of this line"
                      >
                        {formatMoney(lineTotal(l), ctx.settings)}
                      </button>
                    ) : (
                      <span className="line-price">{formatMoney(lineTotal(l), ctx.settings)}</span>
                    )}
                  </div>
                ))}
                <div className="bill-total grand">
                  <span>{counterSale ? 'To pay' : 'New items'}</span>
                  <span>{formatMoney(newTotals.total, ctx.settings)}</span>
                </div>
                {/*
                  Reachable while the bill is being built, not only after.

                  The discount button sat under the ALREADY-SENT total, which
                  on the craft counter is a state that barely exists: a shop
                  sale is rung up and paid for in one movement, so the cart is
                  the normal case and the button was effectively unreachable at
                  the moment somebody wanted it — standing at the counter,
                  agreeing a price, before taking the money.
                */}
                {isEnabled(ctx.features, 'discounts') && (ctx.profile?.can_discount_up_to_bp ?? 0) > 0 && (
                  <Button style={{ width: '100%', marginTop: '0.5rem' }} onClick={() => setShowDiscount(true)}>
                    {discount > 0
                      ? `Discount applied · −${formatMoney(discount, ctx.settings)}`
                      : 'Apply discount'}
                  </Button>
                )}
                {discount > 0 && (
                  <div className="bill-total">
                    <span className="dim">{discountLabel || 'Discount'}</span>
                    <span>−{formatMoney(discount, ctx.settings)}</span>
                  </div>
                )}
                <Button variant="primary" onClick={send} loading={sending} style={{ width: '100%', marginTop: '0.7rem' }}>
                  {/* A shop has no kitchen to send anything to. The one thing
                      that happens next at a counter is being charged, so the
                      button says that and does it. */}
                  {counterSale
                    ? `Take payment · ${formatMoney(newTotals.total, ctx.settings)}`
                    : `Send to ${pass}`}
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
                {/* Hidden rather than shown-and-refusing when this person has
                    no discount allowance: a button that always says no is a
                    button somebody presses every shift and learns to distrust. */}
                {isEnabled(ctx.features, 'discounts') && (ctx.profile?.can_discount_up_to_bp ?? 0) > 0 && (
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
          applied={discount}
          onClose={() => setShowDiscount(false)}
          onApply={(amount, label, id) => {
            setDiscount(amount);
            setDiscountLabel(label);
            setDiscountId(id);
            setShowDiscount(false);
          }}
          onRemove={() => {
            setDiscount(0);
            setDiscountLabel('');
            setDiscountId('');
          }}
        />
      )}

      {peeking && (() => {
        const lines = pourList(peeking.$id, recipes ?? [], barIngredients);
        return (
          <Modal title={`How ${peeking.name} is made`} onClose={() => setPeeking(null)}>
            {/* The method, where somebody wrote one. A recipe is a list of
                measures; "muddle the mint first" is the part that is not in
                the quantities and the part a new bartender needs most. */}
            {peeking.description?.trim() && (
              <p className="small" style={{ marginTop: 0, whiteSpace: 'pre-wrap' }}>{peeking.description}</p>
            )}
            <table className="data">
              <thead>
                <tr>
                  <th>What</th>
                  <th className="num">How much</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  // Nothing here is unique — a drink can take two dashes of
                  // the same bitters — so the position is the only honest key.
                  // eslint-disable-next-line react/no-array-index-key
                  <tr key={`${l.name}-${i}`}>
                    <td>{l.name}</td>
                    <td className="num" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{l.measure}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small dim" style={{ marginBottom: 0 }}>
              What the books expect this drink to use. Pouring differently is what shows up as a gap at the
              next count.
            </p>
          </Modal>
        );
      })()}

      {pickingSize && (() => {
        const entry = ctx.menu.byId[pickingSize];
        const sizes = (entry?.variants ?? []).filter((v) => v.active);
        /*
          Work does not run out.

          A size of a service is a rate — "simple hem", "full alteration" —
          and its count is a number nothing keeps true. Reading it here would
          grey out the second alteration of the day and leave the counter
          unable to sell something the shop is perfectly able to do.
        */
        const work = isService(entry?.item);
        return (
          <Modal title={entry?.item.name ?? 'Which one?'} onClose={() => setPickingSize(null)}>
            <p className="small dim" style={{ marginTop: 0 }}>
              {work ? 'Which one is it?' : 'Which one is the customer buying?'}
            </p>
            <div className="menu-grid">
              {sizes.map((v) => (
                <button
                  key={v.$id}
                  className="menu-card"
                  // Sold out rather than hidden: a customer asking for the
                  // large should be told there is none, not left wondering why
                  // it is missing from a list they can see over the counter.
                  disabled={!work && v.on_hand <= 0}
                  onClick={() => addItem(pickingSize, v.$id)}
                >
                  <div className="n">{v.label}</div>
                  <div className="p">
                    {formatMoney(v.price, ctx.settings)}
                    {work ? '' : v.on_hand <= 0 ? ' · none left' : v.on_hand <= 2 ? ` · ${v.on_hand} left` : ''}
                  </div>
                </button>
              ))}
            </div>
          </Modal>
        );
      })()}

      {repricing && (
        <RepriceModal
          line={repricing}
          settings={ctx.settings}
          by={ctx.profile?.$id ?? ''}
          onClose={() => setRepricing(null)}
          onSet={(unitPrice) => {
            setCart((c) => c.map((x) => (x.key === repricing.key
              ? {
                ...x,
                unit_price: unitPrice,
                // What it SHOULD have cost, kept once and never overwritten by
                // a second edit — otherwise changing the price twice would
                // record the first new price as the shelf price, and the
                // decision stops being readable.
                list_price: x.list_price ?? x.unit_price,
                price_changed_by: ctx.profile?.$id ?? '',
              }
              : x)));
            setRepricing(null);
          }}
        />
      )}

      {pickingOptions && (() => {
        const entry = ctx.menu.byId[pickingOptions.menuItemId];
        if (!entry) return null;
        return (
          <OptionSheet
            entry={entry}
            settings={ctx.settings}
            onCancel={() => setPickingOptions(null)}
            onAdd={(addons) => {
              const { menuItemId, variantId } = pickingOptions;
              setPickingOptions(null);
              addItem(menuItemId, variantId, addons);
            }}
          />
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
          /*
            THE BILLS, NEVER THE COUNTER.

            This was `billTotal − discount`, and billTotal folds in the cart —
            so the till asked for money that no order accounted for and then
            filed it against the orders that existed. See due.ts for what that
            costs beyond the wrong figure.

            The discount still comes off: on a bill being settled later it has
            not been applied to any order yet. On a counter sale it has already
            gone into the order and been reset to nought by then, so this
            cannot take it off twice.
          */
          amountDue: Math.max(0, dueNow - discount),
          onClose: () => setPaying(false),
          onDone: async () => {
            setPaying(false);
            if (!isTakeaway) await db.updateDocument(DB_ID, 'tables', table.$id, { status: 'dirty' }).catch(() => undefined);
            onToast('Payment recorded');
            // The shop till stays where it is, ready for the next customer.
            // Sending it "back" would land it on a screen that does not exist.
            if (counterSale) { setCart([]); setExisting([]); setExistingItems({}); } else onBack();
          },
          onError: (m: string) => onToast(m, 'err'),
        };
        return counterSale ? <CounterPaymentModal {...props} /> : <PaymentModal {...props} />;
      })()}

      {/* Naming it before it goes down. Optional — the first thing in the
          basket is used when nobody types anything — because a customer is
          remembered by what they were buying, and a numbered list of
          anonymous baskets is one where the wrong basket gets picked up. */}
      {parking && (
        <Modal
          title="Park this sale"
          onClose={() => setParking(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setParking(false)}>Cancel</Button>
              <Button variant="primary" onClick={doPark}>Park it</Button>
            </>
          }
        >
          <p className="small dim" style={{ marginTop: 0 }}>
            The counter is cleared so you can serve the next customer, and this sale waits here until it is
            picked back up. Nothing is ordered and nothing is charged.
          </p>
          <Field
            label="Whose is it?"
            hint="Optional. A name, or what they are buying — whatever makes it recognisable when they come back."
          >
            <Input
              value={parkLabel}
              placeholder={autoLabel(cart.map((l) => ({
                key: l.key, menu_item_id: l.menu_item_id, name: l.name, unit_price: l.unit_price, qty: l.qty,
              })))}
              onChange={(e) => setParkLabel(e.target.value)}
            />
          </Field>
          <p className="small dim" style={{ marginBottom: 0 }}>
            Parked sales stay on this till and this device only. Another till will not show them.
          </p>
        </Modal>
      )}

      {showParked && (
        <Modal title="Parked sales" onClose={() => setShowParked(false)}>
          {parked.length === 0 ? (
            <p className="small dim" style={{ margin: 0 }}>Nothing is parked.</p>
          ) : (
            <div className="stack" style={{ gap: '0.5rem' }}>
              {parked.map((sale) => (
                <div key={sale.id} className="row" style={{ justifyContent: 'space-between', gap: '0.6rem' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      {sale.label}
                      {/* Said rather than removed. A basket from this morning
                          is still somebody's, and a till that quietly bins it
                          is one nobody trusts to hold anything. */}
                      {isStale(sale) && <> <Badge tone="warn">Been a while</Badge></>}
                    </div>
                    <div className="small dim">
                      {describeParked(sale, (n) => formatMoney(n, ctx.settings))}
                      {sale.by && ` · ${sale.by}`}
                    </div>
                  </div>
                  <div className="row" style={{ gap: '0.3rem' }}>
                    <Button size="sm" variant="primary" onClick={() => doUnpark(sale.id)}>Pick up</Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        // Cleared, not paid. Nothing was ever ordered, so
                        // there is nothing to refund or reverse — but it is
                        // still somebody's shopping, so it is a deliberate tap
                        // rather than a swipe.
                        writeParked(parked.filter((x) => x.id !== sale.id));
                        onToast(`${sale.label} cleared.`);
                      }}
                    >
                      Clear
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="small dim" style={{ marginBottom: 0, marginTop: '0.8rem' }}>
            These live on this till only, and nothing has been ordered or charged. Picking one up puts it back on
            the counter as it was.
          </p>
        </Modal>
      )}
    </div>
  );
}

/** Staff-applied discount, capped by what this member of staff may authorise. */
function DiscountModal({
  ctx, subtotal, applied, onClose, onApply, onRemove,
}: {
  ctx: PosContext;
  subtotal: number;
  /** What is already off this bill, so the box can offer to take it back. */
  applied: number;
  onClose: () => void;
  onApply: (amount: number, label: string, discountId: string) => void;
  onRemove: () => void;
}) {
  const [code, setCode] = useState('');
  const [rows, setRows] = useState<DiscountRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ceilingBp = ctx.profile?.can_discount_up_to_bp ?? 0;

  /*
    The codes are read here rather than kept with the menu.

    A code switched on mid-service should work on the next sale, not after
    somebody reloads the till, and this box is opened rarely enough that one
    read costs nothing.
  */
  useEffect(() => {
    listAll<DiscountRow & Doc>('discounts', [Query.equal('active', true)])
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  const apply = () => {
    setError(null);
    const found = findCode(rows ?? [], code);
    const ctxFor = { subtotal, at: new Date(), ceilingBp };

    const wrong = codeProblem(found, ctxFor);
    if (wrong || !found) { setError(wrong); return; }

    const senior = needsManager(found, ctxFor);
    if (senior) { setError(senior); return; }

    const off = discountAmount(found, subtotal);
    if (off <= 0) { setError('That code takes nothing off this basket.'); return; }
    onApply(off, discountLabelFor(found), found.$id);
  };

  return (
    <Modal
      title="Apply a discount"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {/* The way back. There was none: once a discount was on, the only
              button reopened this box and the only way out was cancelling,
              which changed nothing. A bill could not be put back to full
              price without starting it again. */}
          {applied > 0 && (
            <Button onClick={() => { onRemove(); onClose(); }}>Take the discount off</Button>
          )}
          <Button variant="primary" onClick={apply}>Apply</Button>
        </>
      }
    >
      <p className="small dim" style={{ marginTop: 0 }}>
        Discounts come from a code somebody set up beforehand, not from a figure typed at the till. They can only
        be applied before the bill is paid; afterwards, use a refund, which leaves its own trail.
      </p>

      <Field label="Discount code" error={error}>
        <Input
          value={code}
          autoFocus
          placeholder="OPEN10"
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
        />
      </Field>

      {rows !== null && rows.filter((d) => d.code && d.staff_applicable).length === 0 && (
        <Notice>
          No discount codes are set up yet. An admin can add them in the admin app, under Discounts.
        </Notice>
      )}

      <p className="small dim">
        Your limit is {(ceilingBp / 100).toFixed(0)}%. Every discount is recorded against your name and against
        the code it came from.
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
            // Which side's drawer this is. Settling a bar bill at the craft
            // counter must not move the bar's sale into the shop's books.
            shiftModule: ctx.module,
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
    if (!methodId) { setError('Choose how it was paid.'); return; }
    /**
     * Less than the full amount is allowed and is not an error: a table
     * splitting the bill pays it in pieces. What is not allowed is nothing —
     * unless there is nothing to pay, which is a different thing entirely.
     *
     * A bill discounted in full comes to nought, and demanding a figure for it
     * left a comped order with no way to be closed at all.
     */
    if (paid <= 0 && amountDue > 0) { setError('Enter how much is being paid.'); return; }
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
          // Which side's drawer this is. See shiftStampForPayment.
          shiftModule: ctx.module,
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

/**
 * Changing what one line costs, at the counter.
 *
 * The LINE, never the menu. An admin sets what a thing is worth and it stays
 * set; a till that could rewrite it would make one customer's haggle follow
 * every customer for the rest of the week. So this touches the sale in front
 * of somebody and nothing else, and the shelf price stays on screen the whole
 * time as the thing being departed from.
 *
 * Per unit rather than per line, because that is the number being argued about
 * at the counter — "call it forty each" — and because a line total divided by
 * three is arithmetic somebody has to do under a customer's eyes.
 */
function RepriceModal({
  line, settings, by, onClose, onSet,
}: {
  line: CartLine;
  settings: Settings;
  by: string;
  onClose: () => void;
  onSet: (unitPrice: number) => void;
}) {
  const shelf = line.list_price ?? line.unit_price;
  const [text, setText] = useState(toInput(line.unit_price, settings.currency_decimals ?? 2));
  const [error, setError] = useState<string | null>(null);

  const apply = () => {
    const value = parseMoney(text, settings.currency_decimals ?? 2);
    if (value === null || value < 0) { setError('Enter a price, or 0 to give it away.'); return; }
    onSet(value);
  };

  const off = shelf - (parseMoney(text, settings.currency_decimals ?? 2) ?? shelf);

  return (
    <Modal
      title={line.name}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {/* Always available, even at the shelf price. Somebody who opened
              this by mistake should be able to leave without hunting for the
              difference between Cancel and Save. */}
          <Button variant="primary" onClick={apply}>Use this price</Button>
        </>
      }
    >
      {error && <div style={{ marginBottom: '0.8rem' }}><Notice>{error}</Notice></div>}
      <p className="small dim" style={{ marginTop: 0 }}>
        This changes what the customer pays for this sale only. The price on the item stays{' '}
        {formatMoney(shelf, settings)} for everybody else.
      </p>
      <Field label="Price each" hint={line.qty > 1 ? `${line.qty} of them` : undefined}>
        <Input
          value={text}
          autoFocus
          inputMode="decimal"
          onChange={(e) => { setText(e.target.value); setError(null); }}
          onFocus={(e) => e.currentTarget.select()}
        />
      </Field>
      {off !== 0 && (
        <p className="small" style={{ color: off > 0 ? 'var(--warn)' : undefined, margin: 0 }}>
          {off > 0
            ? `${formatMoney(off, settings)} under the shelf price, each.`
            : `${formatMoney(-off, settings)} over the shelf price, each.`}
          {' '}Recorded against your name.
        </p>
      )}
      {/* Not decoration: the whole reason this is a permission rather than a
          button is that somebody has to be answerable for it afterwards. */}
      <input type="hidden" value={by} readOnly />
    </Modal>
  );
}
