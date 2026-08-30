/**
 * Where one thing went, over a period somebody chooses.
 *
 * Every screen in this system answers a question about a NIGHT: what a shift
 * took, what a day sold, what a count found. None of them answers a question
 * about a THING — "how many of these have we actually sold this month, and who
 * sold them" — and that is the question behind almost every awkward
 * conversation: a dish that never seems to move, a bottle that empties faster
 * than the till says, a craft piece a maker is asking after.
 *
 * The answer has to carry more than a number, because a number invites the
 * wrong argument. Twelve sold is a statistic; twelve sold, four of them by one
 * person on one evening, three of those unpaid, is a fact somebody can act on.
 * So every line names the order, the moment, the person and whether the money
 * arrived — the four things asked in the follow-up question, put on the screen
 * before it has to be asked.
 *
 * Pure. Imports nothing at runtime.
 */

/** A sale line, as far as this is concerned. */
export interface HistoryLine {
  $id: string;
  order_id: string;
  menu_item_id: string;
  name_snapshot: string;
  qty: number;
  line_total: number;
  status?: string;
  variant_label?: string;
}

/** The bill it was on. */
export interface HistoryOrder {
  $id: string;
  $createdAt: string;
  order_no: string;
  status: string;
  payment_status: string;
  /** Who rang it up. An id until it is looked up. */
  placed_by?: string;
  /** Who took the money, where that is a different person. */
  marked_paid_by?: string;
  table_id?: string;
  module?: string;
}

/** One row of the history, with nothing left to look up. */
export interface HistoryRow {
  lineId: string;
  orderId: string;
  orderNo: string;
  at: string;
  qty: number;
  value: number;
  /** What it was called on the bill, which is not always today's name. */
  name: string;
  soldBy: string;
  status: string;
  paymentStatus: string;
  /** True where this line was taken off the bill after the fact. */
  voided: boolean;
}

/**
 * The rows, newest first.
 *
 * A voided line is KEPT and marked, not dropped. "It was rung up and then
 * taken off" is a different fact from "it was never rung up", and it is the
 * more interesting of the two — a line voided four times in a week is the
 * thing somebody opened this screen to find.
 */
export function historyRows(
  lines: HistoryLine[],
  orders: HistoryOrder[],
  nameOf: (id: string | undefined) => string,
): HistoryRow[] {
  const byId = new Map(orders.map((o) => [o.$id, o]));
  const rows: HistoryRow[] = [];

  for (const line of lines) {
    const order = byId.get(line.order_id);
    // A line whose bill is outside the period, or was deleted outright, has
    // no date and no number and would sort to nowhere. Left out rather than
    // shown as a row of dashes.
    if (!order) continue;
    rows.push({
      lineId: line.$id,
      orderId: order.$id,
      orderNo: order.order_no,
      at: order.$createdAt,
      qty: line.qty,
      value: line.line_total,
      name: line.variant_label ? `${line.name_snapshot} · ${line.variant_label}` : line.name_snapshot,
      soldBy: nameOf(order.placed_by),
      status: order.status,
      paymentStatus: order.payment_status,
      voided: line.status === 'void',
    });
  }

  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

export interface HistoryTotals {
  /** Rung up and not taken off. What was actually sold. */
  qty: number;
  value: number;
  /** Of that, what has not been paid for. */
  unpaidQty: number;
  unpaidValue: number;
  /** Rung up and then taken off again. */
  voidedQty: number;
  /** How many separate bills it appeared on. */
  bills: number;
}

/**
 * The figures at the top.
 *
 * Voided lines are counted apart rather than deducted quietly, because "we
 * sold ten" and "we sold ten and cancelled four" are answers to the same
 * question that lead to different days.
 */
export function historyTotals(rows: HistoryRow[]): HistoryTotals {
  const totals: HistoryTotals = {
    qty: 0, value: 0, unpaidQty: 0, unpaidValue: 0, voidedQty: 0, bills: 0,
  };
  const bills = new Set<string>();

  for (const row of rows) {
    if (row.voided) {
      totals.voidedQty += row.qty;
      continue;
    }
    // A bill that was called off sold nothing, whatever is written on it.
    if (row.status === 'CANCELLED' || row.status === 'REJECTED') continue;

    bills.add(row.orderId);
    totals.qty += row.qty;
    totals.value += row.value;
    if (row.paymentStatus !== 'paid' && row.paymentStatus !== 'refunded') {
      totals.unpaidQty += row.qty;
      totals.unpaidValue += row.value;
    }
  }

  totals.bills = bills.size;
  return totals;
}

/** How many went out on each day of the period, oldest first. */
export function byDay(rows: HistoryRow[]): { day: string; qty: number; value: number }[] {
  const days = new Map<string, { qty: number; value: number }>();
  for (const row of rows) {
    if (row.voided || row.status === 'CANCELLED' || row.status === 'REJECTED') continue;
    const day = row.at.slice(0, 10);
    const at = days.get(day) ?? { qty: 0, value: 0 };
    at.qty += row.qty;
    at.value += row.value;
    days.set(day, at);
  }
  return [...days.entries()]
    .map(([day, v]) => ({ day, ...v }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** Who sold it, most first. The question after "how many". */
export function byPerson(rows: HistoryRow[]): { who: string; qty: number; value: number }[] {
  const people = new Map<string, { qty: number; value: number }>();
  for (const row of rows) {
    if (row.voided || row.status === 'CANCELLED' || row.status === 'REJECTED') continue;
    const at = people.get(row.soldBy) ?? { qty: 0, value: 0 };
    at.qty += row.qty;
    at.value += row.value;
    people.set(row.soldBy, at);
  }
  return [...people.entries()]
    .map(([who, v]) => ({ who, ...v }))
    .sort((a, b) => b.qty - a.qty || a.who.localeCompare(b.who));
}

/**
 * What to say when there is nothing.
 *
 * An empty table is ambiguous in a way that matters here: it could mean this
 * never sells, or it could mean the period is wrong, and those lead somewhere
 * completely different.
 */
export function emptyHistoryWords(days: number): string {
  return `Nothing was sold in the ${days === 1 ? 'day' : `${days} days`} chosen. Either none went out, or the `
    + 'period is not the one you meant — try a wider one before reading anything into it.';
}

/** Whole days between two dates, inclusive, for the sentence above. */
export function daysBetween(fromDay: string, toDay: string): number {
  const from = Date.parse(`${fromDay}T00:00:00Z`);
  const to = Date.parse(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 0;
  return Math.round((to - from) / 86_400_000) + 1;
}
