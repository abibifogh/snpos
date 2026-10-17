/**
 * Owed to us: what customers owe on their tabs, by how long it has been owed.
 *
 * Each unpaid tab order is a debt from the day it was served. Grouped by
 * tab, oldest first, with the same age bands the bills we owe use, so the
 * two sides of the business's credit read the same way.
 *
 * Pure. Imports nothing at runtime. Loaded in receivables-store.ts.
 */
import type { TabRow, TabOrder } from './tabs';

export interface OwedOrder { order: TabOrder; owed: number; since: string }

export interface OwedTab {
  tab: TabRow;
  owed: number;
  /** When the oldest unpaid order on it was served. */
  oldest: string;
  orders: OwedOrder[];
}

/** Every tab with something still owed on it, most owed first. */
export function owedTabs(
  tabs: TabRow[],
  orders: TabOrder[],
  paidOn: (orderId: string) => number,
): OwedTab[] {
  const out: OwedTab[] = [];
  for (const tab of tabs) {
    const mine = orders
      .filter((o) => o.tab_id === tab.$id && o.status !== 'CANCELLED' && o.status !== 'REJECTED' && o.payment_status !== 'refunded')
      .map((o) => ({ order: o, owed: Math.max(0, o.total - paidOn(o.$id)), since: o.$createdAt }))
      .filter((x) => x.owed > 0)
      .sort((a, b) => a.since.localeCompare(b.since));
    if (mine.length === 0) continue;
    out.push({ tab, owed: mine.reduce((n, x) => n + x.owed, 0), oldest: mine[0].since, orders: mine });
  }
  return out.sort((a, b) => b.owed - a.owed || a.oldest.localeCompare(b.oldest));
}

/** Every unpaid order on every tab, as amounts with the day they became due. */
export const owedRows = (tabs: OwedTab[]): { amount: number; due: string }[] =>
  tabs.flatMap((t) => t.orders.map((o) => ({ amount: o.owed, due: o.since })));
