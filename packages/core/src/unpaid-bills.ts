/**
 * Every bill still owed on, in one place a cashier can pay it from.
 *
 * A bar or shop sale is saved with no table, because it has none. So once the
 * screen it was rung up on moved on — the next customer, a reload, the payment
 * sheet closed — nothing on any till could find it again: the drink was poured,
 * the order sat unpaid, and the only place it showed was Admin's Orders page,
 * where nobody taking money ever is. A takeaway left unpaid went the same way,
 * and so did a customer's own order from their phone.
 *
 * Nothing has to be done to park one. An order that is sent and not paid is
 * here by being unpaid; paying it takes it off. Read from the orders
 * themselves, so every till sees the same list and nothing lives on one device.
 *
 * Left out: a bill on a running account (the tab carries it and Settle a tab
 * takes the money), a pre-order not yet released to the pass (nobody is
 * waiting at the counter for it), and anything cancelled or closed.
 *
 * Pure.
 */

/** An order, as far as this list reads it. */
export interface BillLike {
  $id: string;
  $createdAt?: string;
  order_no?: string;
  status?: string;
  payment_status?: string;
  tab_id?: string | null;
  module?: string | null;
  table_id?: string | null;
  channel?: string;
  fulfilment?: string | null;
  customer_name?: string | null;
  placed_by?: string | null;
  total?: number;
}

const GONE = new Set(['REJECTED', 'CANCELLED', 'CLOSED', 'SCHEDULED']);

/** Still owed on, and waiting for somebody at a till to take the money. */
export const isUnpaidBill = (o: BillLike): boolean =>
  (o.payment_status === 'unpaid' || o.payment_status === 'partial')
  && !GONE.has(o.status ?? '')
  && !o.tab_id;

/** This side's unpaid bills, oldest first: the one waiting longest is paid first. */
export function unpaidBillsFor<T extends BillLike>(orders: T[], module: string): T[] {
  return orders
    .filter((o) => isUnpaidBill(o) && (o.module || 'kitchen') === module)
    .sort((a, b) => (a.$createdAt ?? '').localeCompare(b.$createdAt ?? '')
      || (a.order_no ?? '').localeCompare(b.order_no ?? ''));
}

/**
 * Put one changed order into the list, or take it out.
 *
 * For the live feed: an order paid on another till leaves every till's list
 * the moment it is paid, and a new one arrives the moment it is sent.
 */
export function withBill<T extends BillLike>(list: T[], order: T, module: string): T[] {
  const without = list.filter((o) => o.$id !== order.$id);
  return unpaidBillsFor([...without, order], module);
}

/** Where it was ordered, in the words on the floor. */
export function billPlace(o: BillLike, tableLabels: Record<string, string> = {}): string {
  const label = o.table_id ? tableLabels[o.table_id] : undefined;
  if (label) return `Table ${label}`;
  if (o.channel === 'qr') return o.fulfilment === 'takeaway' ? 'Phone order · takeaway' : 'Phone order';
  if (o.channel === 'delivery' || o.fulfilment === 'delivery') return 'Delivery';
  if (o.module === 'bar') return 'Bar';
  if (o.module === 'craft') return 'Counter';
  return 'Takeaway';
}

/** Who it is for, when anybody said. */
export const billWho = (o: BillLike): string =>
  (o.customer_name || '').trim() || (o.placed_by ? `rung up by ${o.placed_by}` : '');

/** "3 unpaid · GH₵145.00", or nothing when there are none. */
export function unpaidWords(list: BillLike[], money: (n: number) => string): string {
  if (list.length === 0) return '';
  const sum = list.reduce((s, o) => s + (o.total ?? 0), 0);
  return `${list.length} unpaid · ${money(sum)}`;
}

/**
 * After a counter sale is rung up, does it wait here or go to Unpaid?
 *
 * Somebody who can take the money is asked for it on the spot, as before.
 * Somebody who cannot — a bartender without the right to record payments, or
 * a till with no shift open — would otherwise be left with a bill on screen
 * that the next customer's sale gets piled onto. So it goes to Unpaid on its
 * own and the counter is clear for the next person.
 */
export const parksAfterSend = (opts: { counterSale: boolean; canTakePayment: boolean }): boolean =>
  opts.counterSale && !opts.canTakePayment;
