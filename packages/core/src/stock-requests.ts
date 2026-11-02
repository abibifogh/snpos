/**
 * Stock the kitchen or the bar asks for, from its own screen.
 *
 * A cook sees what is running low as it runs low, and the only way to say so
 * was to find a manager. This is the saying: a list, started from what is
 * already low, in the packs each thing comes in, sent to whoever orders. It
 * is a REQUEST, not an order. Nothing is bought from the pass, the pass never
 * sees a price, and who may make and send orders is exactly as it was
 * (canOrderStock). A manager turns a request into draft orders, one per
 * supplier, from Approvals, or sends it back with a reason.
 *
 * Off until an admin switches on the "stock_requests" feature.
 *
 * Pure. Imports nothing at runtime. The reading and writing is in
 * stock-requests-store.ts.
 */
import type { OrderableItem, OrderSupplier, PoLine } from './purchase-orders';

/** The two sides with a screen to ask from: the pass and the bar's till. */
export type AskSide = 'kitchen' | 'bar';

export type RequestStatus = 'asked' | 'ordered' | 'declined';

/** One thing asked for. No price: the pass never sees one. */
export interface AskLine {
  ingredient_id: string;
  name: string;
  /** What it is counted in on the shelf: kg, bottle. */
  unit: string;
  /** What it is bought in, plural: sacks, crates. */
  buy_label: string;
  buy_key: 'pack' | 'unit';
  /** How many counting units one of those is. */
  per: number;
  /** How many of the buying unit are asked for. */
  qty: number;
  /** On the shelf when asked, and its full level, so the manager sees why. */
  left: number;
  full: number;
}

export interface StockRequest {
  $id: string;
  $createdAt?: string;
  venue_id: string;
  side: AskSide;
  by_id?: string;
  by_name?: string;
  lines: AskLine[];
  note?: string;
  status: RequestStatus;
  /** The draft orders it became, comma separated. */
  order_ids?: string;
  decided_by?: string;
  decided_by_name?: string;
  decided_at?: string;
  decided_note?: string;
}

export const ASK_SIDE_WORDS: Record<AskSide, string> = { kitchen: 'kitchen', bar: 'bar' };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "sack" for one of "sacks", for "1 sack". Packs are stored plural. */
export function buyWord(line: Pick<AskLine, 'buy_label'>, qty: number): string {
  const w = (line.buy_label || 'units').trim();
  if (qty !== 1) return w;
  if (/(sh|ch|x|ss)es$/.test(w)) return w.slice(0, -2);
  // Measures are the same either way: 1 kg, 2 kg.
  if (/^(kg|g|l|ml|cl)$/i.test(w)) return w;
  return w.endsWith('s') ? w.slice(0, -1) : w;
}

/** "3 sacks" */
export const qtyWords = (l: Pick<AskLine, 'qty' | 'buy_label'>): string => `${l.qty} ${buyWord(l, l.qty)}`;

/** "6 kg left of 75", or "Run out". Measures are not made plural. */
export function leftWords(l: Pick<AskLine, 'left' | 'full' | 'unit'>): string {
  if (!(l.left > 0)) return 'Run out';
  const u = (l.unit || '').trim();
  const unit = /^(kg|g|l|ml|cl)$/i.test(u) || l.left === 1 || /s$/.test(u) ? u : `${u}s`;
  const left = Math.round(l.left * 100) / 100;
  return l.full > 0 ? `${left} ${unit} left of ${l.full}` : `${left} ${unit} left`;
}

/**
 * The line to ask for an item: enough to bring it back to its full level, in
 * whole packs. The same rule as an order suggestion (suggestLine), so the
 * manager sees the amount the Purchase orders page would have offered.
 */
export function askLine(i: OrderableItem, suggest: (i: OrderableItem) => PoLine): AskLine {
  const s = suggest(i);
  return {
    ingredient_id: i.$id,
    name: i.name,
    unit: i.unit,
    buy_label: s.buy_label,
    buy_key: s.buy_key,
    per: s.per,
    qty: s.qty,
    left: Math.max(0, i.current_qty ?? 0),
    full: i.par_level ?? 0,
  };
}

/** Already on its way, or already asked for: not asked for twice. */
export interface Held {
  /** "PO-0041, due tomorrow" or "Asked by Abena". */
  why: string;
}

/**
 * What each item is already held by: an order not yet arrived, or a request
 * nobody has decided. Ordering rice on Monday and seeing the pass ask for it
 * again on Tuesday, before the sacks came, is how it gets bought twice.
 */
export function heldItems(
  orders: { po_no?: string; status?: string; expected_on?: string; lines: PoLine[] }[],
  requests: Pick<StockRequest, 'status' | 'by_name' | 'lines'>[],
  dueWords: (day?: string) => string,
): Map<string, Held> {
  const held = new Map<string, Held>();
  for (const o of orders) {
    if (!['draft', 'waiting', 'ready', 'sent', 'part'].includes(o.status ?? '')) continue;
    for (const l of o.lines) {
      if (!l.ingredient_id || (l.received_qty ?? 0) >= l.qty) continue;
      const due = o.expected_on ? dueWords(o.expected_on) : '';
      held.set(l.ingredient_id, { why: o.status === 'sent' || o.status === 'part' ? `On order${due ? `, ${due}` : ''}` : 'Being ordered' });
    }
  }
  for (const r of requests) {
    if (r.status !== 'asked') continue;
    for (const l of r.lines) {
      if (!held.has(l.ingredient_id)) held.set(l.ingredient_id, { why: `Asked for${r.by_name ? ` by ${r.by_name}` : ''}` });
    }
  }
  return held;
}

export interface AskList {
  /** Running low and free to ask for, filled in to bring each back to full. */
  low: AskLine[];
  /** Running low, but already ordered or asked for. Shown, not offered. */
  held: (AskLine & Held)[];
  /** Everything else on this side's list, to search and add. */
  others: AskLine[];
}

/** The list the sheet opens on, for one side. */
export function askList(
  items: OrderableItem[],
  side: AskSide,
  held: Map<string, Held>,
  isLow: (i: OrderableItem) => boolean,
  suggest: (i: OrderableItem) => PoLine,
): AskList {
  const mine = items
    .filter((i) => i.active !== false && (i.module ?? 'kitchen') === side)
    .sort((a, b) => a.name.localeCompare(b.name));
  const out: AskList = { low: [], held: [], others: [] };
  for (const i of mine) {
    const line = askLine(i, suggest);
    const h = held.get(i.$id);
    if (isLow(i)) {
      if (h) out.held.push({ ...line, ...h });
      else out.low.push(line);
    } else if (!h) {
      out.others.push(line);
    }
  }
  // What has run out first: it is the line most likely to stop a dish.
  out.low.sort((a, b) => (a.left > 0 ? 1 : 0) - (b.left > 0 ? 1 : 0) || a.name.localeCompare(b.name));
  return out;
}

/** Why this request cannot be sent, or null when it can. */
export function askProblem(lines: Pick<AskLine, 'qty'>[], note: string): string | null {
  if (lines.some((l) => l.qty > 0)) return null;
  return note.trim() ? null : 'Tick something to ask for, or write what is needed in the note.';
}

/** Lines read back from the stored JSON. Junk is dropped rather than shown. */
export function readAskLines(raw: string | null | undefined): AskLine[] {
  try {
    const v = JSON.parse(raw || '[]');
    if (!Array.isArray(v)) return [];
    return v
      .filter((l) => l && typeof l.name === 'string' && Number(l.qty) > 0)
      .map((l) => ({
        ingredient_id: String(l.ingredient_id ?? ''),
        name: String(l.name),
        unit: String(l.unit ?? ''),
        buy_label: String(l.buy_label ?? ''),
        buy_key: l.buy_key === 'pack' ? 'pack' : 'unit',
        per: Number(l.per) > 0 ? Number(l.per) : 1,
        qty: Number(l.qty),
        left: Number(l.left) || 0,
        full: Number(l.full) || 0,
      }));
  } catch {
    return [];
  }
}

/** One draft to make: a supplier and its lines, priced from what was last paid. */
export interface DraftPlan {
  supplier: OrderSupplier | null;
  lines: PoLine[];
  total: number;
}

/**
 * A request as the orders it becomes: one per supplier, and one for items
 * with no supplier set, so nothing asked for drops off for want of a name.
 * Priced at what was last paid for each, the same as an order suggestion.
 * Lines whose stock item has since been deleted keep their words and no price.
 */
export function draftPlans(
  lines: AskLine[],
  items: OrderableItem[],
  suppliers: OrderSupplier[],
  suggest: (i: OrderableItem) => PoLine,
): DraftPlan[] {
  const by = new Map<string, DraftPlan>();
  for (const l of lines) {
    if (!(l.qty > 0)) continue;
    const item = items.find((i) => i.$id === l.ingredient_id);
    const supplier = suppliers.find((s) => s.$id === item?.supplier_id) ?? null;
    const base = item ? suggest(item) : null;
    const line: PoLine = {
      ingredient_id: l.ingredient_id,
      name: l.name,
      unit: l.unit,
      buy_key: base?.buy_key ?? l.buy_key,
      buy_label: base?.buy_label ?? l.buy_label,
      per: base?.per ?? l.per,
      qty: l.qty,
      unit_cost: base?.unit_cost ?? 0,
      received_qty: 0,
    };
    const key = supplier?.$id ?? '';
    const plan = by.get(key) ?? { supplier, lines: [], total: 0 };
    plan.lines.push(line);
    plan.total += Math.round(line.qty * line.unit_cost);
    by.set(key, plan);
  }
  return [...by.values()].sort((a, b) => (a.supplier ? 0 : 1) - (b.supplier ? 0 : 1) || b.total - a.total);
}

/** The row on Approvals: what the side needs, in a line. */
export function requestWords(r: Pick<StockRequest, 'side' | 'lines' | 'note'>): { title: string; detail: string } {
  const n = r.lines.length;
  const title = n > 0
    ? `The ${ASK_SIDE_WORDS[r.side]} needs ${plural(n, 'item', 'items')}`
    : `A note from the ${ASK_SIDE_WORDS[r.side]}`;
  const shown = r.lines.slice(0, 3).map((l) => `${l.name}, ${qtyWords(l)}`);
  const more = n > 3 ? `, and ${n - 3} more` : '';
  const note = (r.note ?? '').trim();
  const detail = [shown.length ? `${shown.join('; ')}${more}.` : '', note ? `Note: “${note}”` : '']
    .filter(Boolean).join(' ');
  return { title, detail };
}

export type RequestStage = 'asked' | 'ordered' | 'arrived' | 'declined';

/** Where a request has got to, as the pass shows it. Arrived once every order it became has. */
export function requestStage(
  r: Pick<StockRequest, 'status' | 'order_ids'>,
  orders: { $id: string; status?: string }[],
): RequestStage {
  if (r.status === 'declined') return 'declined';
  if (r.status !== 'ordered') return 'asked';
  const ids = (r.order_ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const mine = orders.filter((o) => ids.includes(o.$id) && o.status !== 'cancelled');
  return mine.length > 0 && mine.every((o) => o.status === 'received') ? 'arrived' : 'ordered';
}

export const STAGE_WORDS: Record<RequestStage, string> = {
  asked: 'Asked',
  ordered: 'Ordered',
  arrived: 'Arrived',
  declined: 'Not now',
};

/** What the drafts say about where they came from, on Purchase orders and in the note. */
export const askedByWords = (side: AskSide, name?: string): string =>
  `Asked by the ${ASK_SIDE_WORDS[side]}${name ? ` · ${name}` : ''}`;
