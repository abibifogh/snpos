/**
 * The people who have bought something, assembled from the orders.
 *
 * There is a `customers` collection in the schema and nothing has ever written
 * a row to it. That is worth saying plainly rather than quietly reading from
 * it and showing an empty page: the customer details this business actually
 * holds are on the ORDERS — a name typed at the counter, a phone number taken
 * for a takeaway, an email given to have a receipt sent. Building the view from
 * the orders means it shows what is really there on the first day, with no
 * migration and nothing to backfill.
 *
 * WHAT THIS IS NOT. It is not a marketing list. Every address in here was given
 * for a reason — to collect an order, to get a receipt — and none of it is
 * consent to be sent anything else. There is deliberately no "email everyone"
 * button here, and the screen says so where somebody would look for one.
 *
 * Pure. Nothing here reads or writes.
 */

export interface CustomerOrder {
  $id: string;
  $createdAt: string;
  customer_name?: string;
  customer_phone?: string;
  customer_email?: string;
  total: number;
  payment_status?: string;
  status?: string;
  module?: string;
  venue_id?: string;
  order_no?: string;
  channel?: string;
}

export interface CustomerRecord {
  /** How this person is identified. See identityKey. */
  key: string;
  name: string;
  email: string;
  phone: string;
  /** Orders that were really sold — cancelled and rejected ones are not. */
  orders: number;
  /** What they have actually paid, in minor units. */
  spent: number;
  firstSeen: string;
  lastSeen: string;
  /** Which sides of the business they buy from. */
  modules: string[];
  /** The orders themselves, newest first, for the detail view. */
  history: CustomerOrder[];
}

/** An order that never happened does not count towards anybody's history. */
const CANCELLED = ['CANCELLED', 'REJECTED'];

export const isRealSale = (o: CustomerOrder): boolean => !CANCELLED.includes(o.status ?? '');

const cleanEmail = (s?: string): string => (s ?? '').trim().toLowerCase();

/** Every digit, and nothing else. */
export const phoneDigits = (s?: string): string => (s ?? '').replace(/\D/g, '');

/**
 * The digits that actually identify a phone number.
 *
 * "024 123 4567", "+233 24 123 4567" and "0241234567" are one person, and
 * anybody typing at a counter will produce all three. Stripping punctuation is
 * not enough — the country code and the trunk zero are digits, so the three
 * still differ — and filing them as three customers with a third of the
 * history each is worse than not grouping at all, because it looks like it
 * worked.
 *
 * So the last nine digits win, which is the national number in Ghana and in
 * most places that use nine. A shorter string, which is what a half-typed
 * search box holds, only loses its leading zeros. Serving a country with a
 * different length is the one thing that would need changing here.
 */
export function phoneKey(s?: string): string {
  const d = phoneDigits(s);
  return d.length > 9 ? d.slice(-9) : d.replace(/^0+/, '');
}

/** Kept for anything that wants the raw digits rather than the identity. */
export const cleanPhone = phoneDigits;

/**
 * Everything on this order that could identify a person.
 *
 * BOTH, not the better of the two. An order carrying a phone number and an
 * email is the thing that proves those two belong to one person, and picking
 * only the stronger one throws that proof away: somebody who left a number on
 * Monday and both on Friday would come back as two customers, each with half
 * their spending, with a shared phone number sitting in plain sight on both.
 */
export function identitiesOf(o: CustomerOrder): string[] {
  const out: string[] = [];
  const email = cleanEmail(o.customer_email);
  if (email) out.push(`e:${email}`);
  const phone = phoneKey(o.customer_phone);
  if (phone) out.push(`p:${phone}`);
  return out;
}

/**
 * How one order is filed when it is the first the system has seen of somebody.
 *
 * Email first, then phone, and NEVER a name on its own. Two people called
 * Kwame are two people, "walk in" is not a customer, and a blank name is not a
 * match with every other blank name — merging on names would build one
 * enormous record holding most of the business's takings and call it a regular.
 *
 * Returns an empty string for an order carrying no contact detail at all.
 * Those are most orders in most restaurants and they are not customers in any
 * useful sense; the caller drops them.
 */
export const identityKey = (o: CustomerOrder): string => identitiesOf(o)[0] ?? '';

/**
 * Build one record per person from a pile of orders.
 *
 * Records join whenever an order shares ANY identifier with one already built,
 * and two records that turn out to be one person are merged the moment an
 * order arrives carrying both of their identifiers. That last case is the
 * whole reason this is not a simple group-by: the joining evidence usually
 * arrives after the two halves already exist.
 *
 * The name kept is the most recent non-blank one. People correct their own
 * spelling, give a fuller name the second time, or are typed in wrongly once,
 * and the newest is the best guess at what they would want to be called.
 *
 * Two records can STILL describe one person — somebody who gave only a phone
 * number once and only an email another time has nothing shared between those
 * two orders. That limitation is worth stating rather than papering over with
 * a guess from names: a wrong merge silently attributes one person's spending
 * to another, and there is no way to see that it has happened.
 */
export function buildCustomers(orders: CustomerOrder[]): CustomerRecord[] {
  const byIdent = new Map<string, CustomerRecord>();
  let records: CustomerRecord[] = [];

  // Oldest first, so "first seen" falls out of the order they are walked in
  // and the newest name is simply the last one written.
  const walk = [...orders].sort((a, b) => a.$createdAt.localeCompare(b.$createdAt));

  for (const o of walk) {
    const idents = identitiesOf(o);
    if (idents.length === 0) continue;

    const hits = [...new Set(idents.map((i) => byIdent.get(i)).filter((r): r is CustomerRecord => !!r))];
    let record = hits[0];

    if (!record) {
      record = {
        key: idents[0],
        name: '',
        email: '',
        phone: '',
        orders: 0,
        spent: 0,
        firstSeen: o.$createdAt,
        lastSeen: o.$createdAt,
        modules: [],
        history: [],
      };
      records.push(record);
    }

    /*
      Two halves of one person, joined by the order that names both.

      Folded into the oldest of them, which keeps the first-seen date honest,
      and everything pointing at either now points at the survivor.
    */
    for (const other of hits.slice(1)) {
      record.orders += other.orders;
      record.spent += other.spent;
      if (other.firstSeen < record.firstSeen) record.firstSeen = other.firstSeen;
      if (other.lastSeen > record.lastSeen) record.lastSeen = other.lastSeen;
      if (!record.email) record.email = other.email;
      if (!record.phone) record.phone = other.phone;
      if (!record.name) record.name = other.name;
      for (const m of other.modules) if (!record.modules.includes(m)) record.modules.push(m);
      record.history = [...other.history, ...record.history]
        .sort((a, b) => b.$createdAt.localeCompare(a.$createdAt));
      records = records.filter((r) => r !== other);
      for (const [k, v] of byIdent) if (v === other) byIdent.set(k, record);
    }

    const name = (o.customer_name ?? '').trim();
    if (name) record.name = name;
    // A detail given later fills in one that was never given, and never
    // overwrites one that was: a person is identified by these, and replacing
    // one would change who the record is about.
    if (!record.email) record.email = cleanEmail(o.customer_email);
    if (!record.phone) record.phone = (o.customer_phone ?? '').trim();

    if (isRealSale(o)) {
      record.orders += 1;
      // Only money that actually came in. An unpaid bill is not spending, and
      // counting it would make a walkout look like the best customer here.
      if (o.payment_status === 'paid') record.spent += o.total;
      if (o.$createdAt > record.lastSeen) record.lastSeen = o.$createdAt;
      const side = o.module ?? 'kitchen';
      if (!record.modules.includes(side)) record.modules.push(side);
    }

    record.history.unshift(o);
    for (const i of idents) byIdent.set(i, record);
  }

  return records;
}

/* ------------------------------------------------------ reading the records */

export type CustomerSort = 'recent' | 'spend' | 'orders' | 'name';

export function sortCustomers(rows: CustomerRecord[], by: CustomerSort): CustomerRecord[] {
  const out = [...rows];
  if (by === 'spend') return out.sort((a, b) => b.spent - a.spent);
  if (by === 'orders') return out.sort((a, b) => b.orders - a.orders);
  if (by === 'name') return out.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  return out.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/** Name, email or phone, matched the way somebody actually types a search. */
export function searchCustomers(rows: CustomerRecord[], term: string): CustomerRecord[] {
  const q = term.trim().toLowerCase();
  if (!q) return rows;
  /*
    A number is searched by the SAME key the identity uses.

    "024 123" must find a number stored as "+233 24 123 4567", and comparing
    raw digits cannot: the country code is in the way. Both sides go through
    phoneKey, so a search behaves the way the matching does.
  */
  const digits = phoneKey(q);
  return rows.filter((r) =>
    r.name.toLowerCase().includes(q)
    || r.email.includes(q)
    || (digits.length >= 3 && phoneKey(r.phone).includes(digits)),
  );
}

/**
 * Somebody who has come back.
 *
 * Two visits is the line, and it is deliberately low. The useful question a
 * small business asks of this list is "who has been here before", not "who is
 * in the top decile" — and a threshold high enough to feel meaningful would
 * report almost nobody in a place that has been trading a few months.
 */
export const REGULAR_AT = 2;

export const isRegular = (r: CustomerRecord): boolean => r.orders >= REGULAR_AT;

/** Whether there is any way to reach this person at all. */
export const contactable = (r: CustomerRecord): boolean => !!r.email || !!r.phone;

export interface CustomerTotals {
  people: number;
  withEmail: number;
  withPhone: number;
  returning: number;
  spent: number;
}

export function summarise(rows: CustomerRecord[]): CustomerTotals {
  return {
    people: rows.length,
    withEmail: rows.filter((r) => !!r.email).length,
    withPhone: rows.filter((r) => !!r.phone).length,
    returning: rows.filter(isRegular).length,
    spent: rows.reduce((s, r) => s + r.spent, 0),
  };
}

/**
 * How many orders in the window carried no contact detail at all.
 *
 * Shown beside the list because without it the page lies by omission. A
 * restaurant serving four hundred covers a month and holding nine email
 * addresses should see that it holds nine out of four hundred, not a tidy list
 * of nine that reads like the whole customer base.
 */
export function anonymousCount(orders: CustomerOrder[]): number {
  return orders.filter((o) => isRealSale(o) && !identityKey(o)).length;
}

/**
 * The list as a spreadsheet, in the order the columns are read on screen.
 *
 * Headings and rows separately, the shape toCsv takes. The money is left in
 * minor units and named so — a column that silently divides by a hundred is
 * one somebody will add up against a report that did not.
 */
export function toSheet(rows: CustomerRecord[]): { headers: string[]; rows: unknown[][] } {
  return {
    headers: ['Name', 'Email', 'Phone', 'Orders', 'Spent (minor units)', 'First seen', 'Last seen', 'Buys'],
    rows: rows.map((r) => [
      r.name,
      r.email,
      r.phone,
      r.orders,
      r.spent,
      r.firstSeen.slice(0, 10),
      r.lastSeen.slice(0, 10),
      r.modules.join(' / '),
    ]),
  };
}
