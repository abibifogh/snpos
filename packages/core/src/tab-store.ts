/**
 * Reading and writing tabs, and the code that releases a shift.
 *
 * The rules are next door in tabs.ts, where they can be checked without a
 * database. This does the fetching and the writing and nothing else.
 */

import { db, DB_ID, ID, Query, listAll, listByIds } from './client';
import { encodePin, verifyPin } from './pin';
import { makeCloseCode, codeUsable, tabOrdersOnShift } from './tabs';
import type { TabRow, TabOrder, IssuedCode } from './tabs';
import { liveOrders } from './orders';
import type { Order } from './orders';

export interface Tab extends TabRow {
  $createdAt: string;
  venue_id?: string;
  contact_name?: string;
  note?: string;
  opened_by?: string;
  opened_at?: string;
  closed_by?: string;
  closed_at?: string;
  close_note?: string;
}

/** Every tab, newest first. The list is short by nature; a business with two
 * hundred open accounts has a different problem than this screen solves. */
export const loadTabs = (venueId?: string): Promise<Tab[]> =>
  listAll<Tab>('tabs', venueId ? [Query.equal('venue_id', venueId)] : []).then((rows) =>
    rows.sort((a, b) => b.$createdAt.localeCompare(a.$createdAt)),
  );

/** The ones still taking orders, for the till's picker. */
export const loadOpenTabs = (venueId?: string): Promise<Tab[]> =>
  loadTabs(venueId).then((rows) => rows.filter((t) => t.status === 'open')
    .sort((a, b) => a.name.localeCompare(b.name)));

/** What is on a tab. Every order ever put on it, whatever became of them. */
export const ordersOnTab = (tabId: string): Promise<Order[]> =>
  listAll<Order>('orders', [Query.equal('tab_id', tabId)])
    .then((rows) => rows.sort((a, b) => b.$createdAt.localeCompare(a.$createdAt)));

/** What has actually been taken against a set of orders, for the owing sum. */
export async function paidOnOrders(orderIds: string[]): Promise<Record<string, number>> {
  if (orderIds.length === 0) return {};
  const rows = await listByIds<{ order_id: string; amount: number; status?: string }>(
    'payments', 'order_id', orderIds,
  ).catch(() => []);
  const paid: Record<string, number> = {};
  for (const p of rows) {
    // A voided payment is not money the business holds, wherever the question
    // is asked from. The same predicate the shift close uses.
    if (p.status === 'voided' || p.status === 'refunded') continue;
    paid[p.order_id] = (paid[p.order_id] ?? 0) + p.amount;
  }
  return paid;
}

export async function openTab(input: {
  venueId: string;
  name: string;
  reference?: string;
  contactName?: string;
  contactPhone?: string;
  note?: string;
  limitAmount?: number;
  by: string;
}): Promise<Tab> {
  const doc = await db.createDocument(DB_ID, 'tabs', ID.unique(), {
    venue_id: input.venueId,
    name: input.name.trim(),
    reference: input.reference?.trim() ?? '',
    contact_name: input.contactName?.trim() ?? '',
    contact_phone: input.contactPhone?.trim() ?? '',
    note: input.note?.trim() ?? '',
    status: 'open',
    limit_amount: Math.max(0, Math.round(input.limitAmount ?? 0)),
    opened_by: input.by,
    opened_at: new Date().toISOString(),
  });
  return doc as unknown as Tab;
}

/**
 * Close a tab.
 *
 * The orders on it are NOT touched. Settling a tab is recording payment
 * against its bills, which happens through the ordinary payment path so the
 * money lands in a shift like any other money — a tab that closed its own
 * orders would take the takings with it and nothing would ever be counted.
 */
export const closeTab = (tabId: string, by: string, note = '', status: 'settled' | 'void' = 'settled') =>
  db.updateDocument(DB_ID, 'tabs', tabId, {
    status,
    closed_by: by,
    closed_at: new Date().toISOString(),
    close_note: note.trim(),
  });

export const reopenTab = (tabId: string) =>
  db.updateDocument(DB_ID, 'tabs', tabId, { status: 'open', closed_at: '', closed_by: '', close_note: '' });

/** Put an order onto a tab. The order stays unpaid; the tab carries it. */
export const postOrderToTab = (orderId: string, tabId: string) =>
  db.updateDocument(DB_ID, 'orders', orderId, { tab_id: tabId });

/** Take it back off, for an order put on the wrong account. */
export const unpostOrder = (orderId: string) =>
  db.updateDocument(DB_ID, 'orders', orderId, { tab_id: '' });

/* ------------------------------------------------- the closing code */

export interface CloseCode extends IssuedCode {
  $id: string;
  code_hash: string;
  issued_by?: string;
  used_by?: string;
  tab_orders?: number;
  tab_value?: number;
}

/** What this shift has going home on a tab, for the admin about to release it. */
export async function tabExposure(
  shiftId: string,
  module: string,
  venueId: string,
): Promise<{ orders: TabOrder[]; value: number }> {
  const all = await liveOrders(venueId).catch(() => []);
  const orders = tabOrdersOnShift(all as unknown as TabOrder[], shiftId, module);
  return { orders, value: orders.reduce((sum, o) => sum + o.total, 0) };
}

/**
 * Issue a code for one shift, and hand back the digits to read out.
 *
 * The digits are returned and never stored. Only their hash goes to the
 * database, so an admin who loses the number issues another rather than
 * looking the old one up — which is the same reason a PIN cannot be read back.
 */
export async function issueCloseCode(input: {
  shiftId: string;
  module: string;
  by: string;
  tabOrders: number;
  tabValue: number;
}): Promise<string> {
  const code = makeCloseCode((n) => crypto.getRandomValues(new Uint8Array(n)));
  await db.createDocument(DB_ID, 'shift_close_codes', ID.unique(), {
    shift_id: input.shiftId,
    module: input.module,
    code_hash: await encodePin(code),
    issued_by: input.by,
    issued_at: new Date().toISOString(),
    tab_orders: input.tabOrders,
    tab_value: input.tabValue,
  });
  return code;
}

/** Codes issued for this shift, newest first. */
export const codesForShift = (shiftId: string): Promise<CloseCode[]> =>
  listAll<CloseCode>('shift_close_codes', [Query.equal('shift_id', shiftId)])
    .then((rows) => rows.sort((a, b) => b.issued_at.localeCompare(a.issued_at)))
    .catch(() => []);

/**
 * Check a typed code and, if it is good, spend it.
 *
 * Marked used as part of accepting it rather than after the shift closes. A
 * close can fail for a dozen reasons and a code left unspent by one of them is
 * a code that works twice — which is exactly what one use is meant to prevent.
 *
 * Returns null when the shift may close, or the reason it may not.
 */
export async function spendCloseCode(input: {
  entered: string;
  shiftId: string;
  module: string;
  by: string;
}): Promise<string | null> {
  const codes = await codesForShift(input.shiftId);
  const now = Date.now();

  // Newest first, so a fresh code works even where an old one is still lying
  // about unused. Every candidate is checked rather than only the newest: an
  // admin who issued twice must not have made the first one wrong.
  for (const candidate of codes) {
    if (codeUsable(candidate, input.shiftId, input.module, now)) continue;
    if (!(await verifyPin(input.entered.trim(), candidate.code_hash))) continue;
    await db.updateDocument(DB_ID, 'shift_close_codes', candidate.$id, {
      used_at: new Date().toISOString(),
      used_by: input.by,
    });
    return null;
  }

  /*
    Nothing matched. The reason given is the best one available: where a code
    exists for this shift but could not be used, say WHY — expired, already
    spent — rather than "wrong code", which sends somebody to re-read digits
    that were right.
  */
  const mine = codes.filter((c) => c.shift_id === input.shiftId);
  if (mine.length === 0) return 'No code has been issued for this shift yet. Ask an admin for one.';
  const why = codeUsable(mine[0], input.shiftId, input.module, now);
  return why ?? 'That code is not right. Check the digits with the admin who gave it to you.';
}
