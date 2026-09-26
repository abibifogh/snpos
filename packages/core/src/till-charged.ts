/**
 * Putting back what the customer was actually charged.
 *
 * Until order-guard learned to leave a till's prices alone (see tillSale in
 * reprice.js), the server re-priced every order a second after it was sent.
 * Where its rule was wrong — a Club · Large rung up at GH₵30 and rewritten to
 * the plain Club's GH₵25 — the customer had already been asked for, and paid,
 * the till's figure. The drawer balanced; the bill, the item reports and the
 * tax on it said something else.
 *
 * The server logged every rewrite ("Club · Large: sent 3000, actual 2500") on
 * an `order_price_corrected` entry, and the payments say what was paid. A line
 * is put back only where BOTH agree: the log says the till sent more than the
 * server kept, and the bill's payments reach the till's figure. A bill paid at
 * the lower figure is left alone — that customer was charged less, and the
 * record says so truthfully.
 *
 * Only bills rung up at a till. A phone order corrected by the server was the
 * guard doing its job, and its customer paid the corrected figure.
 *
 * Pure.
 */

export interface RewriteLog { entity_id?: string; after?: string | null }

export interface RestorableOrder {
  $id: string;
  order_no?: string;
  status?: string;
  channel?: string;
  total: number;
  shift_id?: string | null;
}

export interface RestorableLine {
  $id: string;
  order_id: string;
  name_snapshot: string;
  qty: number;
  line_total: number;
  status?: string;
  list_price?: number | null;
}

export interface RestorePayment { order_id: string; amount: number; status?: string }

/** One line going back to what the till charged. */
export interface Restore {
  lineId: string;
  orderId: string;
  orderNo: string;
  shiftId: string;
  name: string;
  qty: number;
  from: number;
  to: number;
}

/** What the server rewrote, per order: name, what the till sent, what was kept. */
export function rewritesByOrder(logs: RewriteLog[]): Map<string, { name: string; sent: number; kept: number }[]> {
  const out = new Map<string, { name: string; sent: number; kept: number }[]>();
  for (const a of logs) {
    const orderId = a.entity_id ?? '';
    if (!orderId) continue;
    let corrections: unknown = [];
    try { corrections = (JSON.parse(a.after || '{}') as { corrections?: unknown }).corrections ?? []; } catch { continue; }
    if (!Array.isArray(corrections)) continue;
    for (const c of corrections) {
      const m = /^(.*): sent (-?\d+), actual (-?\d+)$/.exec(String(c));
      if (!m) continue;
      const sent = Number(m[2]);
      const kept = Number(m[3]);
      if (sent === kept) continue;
      out.set(orderId, [...(out.get(orderId) ?? []), { name: m[1] ?? '', sent, kept }]);
    }
  }
  return out;
}

// Mirrors isLivePayment in shift-rules.ts: money voided or refunded was not kept.
const LIVE_OUT = new Set(['voided', 'refunded']);

/** Every line to put back, and nothing a payment does not vouch for. */
export function restorePlan(input: {
  logs: RewriteLog[];
  orders: RestorableOrder[];
  lines: RestorableLine[];
  payments: RestorePayment[];
}): Restore[] {
  const rewrites = rewritesByOrder(input.logs);
  const out: Restore[] = [];

  for (const order of input.orders) {
    if (order.status === 'CANCELLED' || order.status === 'REJECTED') continue;
    if (order.channel !== 'waiter' && order.channel !== 'counter') continue;
    const said = rewrites.get(order.$id);
    if (!said) continue;

    const lines = input.lines.filter(
      (l) => l.order_id === order.$id && l.status !== 'void' && typeof l.list_price !== 'number',
    );
    const used = new Set<string>();
    const found: Restore[] = [];
    for (const r of said) {
      // Upwards only: a till that charged LESS than the menu was paid less,
      // and putting the higher figure on the bill would claim money that
      // never came in.
      if (r.sent <= r.kept) continue;
      // Still what the server kept. A line changed since — a quantity
      // corrected, a price put right by hand — is somebody's later decision.
      const line = lines.find((l) => !used.has(l.$id) && l.name_snapshot === r.name && l.line_total === r.kept);
      if (!line) continue;
      used.add(line.$id);
      found.push({
        lineId: line.$id, orderId: order.$id, orderNo: order.order_no ?? order.$id, shiftId: order.shift_id ?? '',
        name: line.name_snapshot, qty: line.qty, from: r.kept, to: r.sent,
      });
    }
    if (found.length === 0) continue;

    // The money has to be there. What was paid must reach the bill as the
    // till had it; a bill paid at the server's figure is left as it was.
    const taken = input.payments
      .filter((p) => p.order_id === order.$id && !LIVE_OUT.has(p.status ?? ''))
      .reduce((s, p) => s + (p.amount || 0), 0);
    const missing = found.reduce((s, f) => s + (f.to - f.from), 0);
    if (taken < order.total + missing) continue;

    out.push(...found);
  }
  return out.sort((a, b) => a.orderNo.localeCompare(b.orderNo));
}

/** "126 bills, 212 sold, GH₵1,060.00 of sales the records were missing." */
export function restoreWords(plan: Restore[], money: (n: number) => string): string {
  if (plan.length === 0) return 'Nothing to put back: every bill already says what its customer paid.';
  const bills = new Set(plan.map((p) => p.orderId)).size;
  const qty = plan.reduce((s, p) => s + p.qty, 0);
  const sum = plan.reduce((s, p) => s + (p.to - p.from), 0);
  const names = [...new Set(plan.map((p) => p.name))];
  return `${bills} ${bills === 1 ? 'bill' : 'bills'}, ${qty} sold (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''}), `
    + `${money(sum)} of sales the records were missing. The customers paid these figures, so no drawer changes.`;
}
