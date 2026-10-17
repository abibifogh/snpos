import { listAll, listByIds } from './client';
import { paidOnOrders } from './tab-store';
import { owedTabs } from './receivables';
import type { OwedTab } from './receivables';
import type { TabRow, TabOrder } from './tabs';

/**
 * What customers owe on tabs, read fresh. Every tab, not only open ones: a
 * tab closed with something still on it is still owed. A void tab was
 * written off and is not.
 */
export async function loadReceivables(): Promise<OwedTab[]> {
  const tabs = (await listAll<TabRow>('tabs')).filter((t) => t.status !== 'void');
  if (tabs.length === 0) return [];
  const orders = await listByIds<TabOrder>('orders', 'tab_id', tabs.map((t) => t.$id));
  const paid = await paidOnOrders(orders.map((o) => o.$id));
  return owedTabs(tabs, orders, (id) => paid[id] ?? 0);
}
