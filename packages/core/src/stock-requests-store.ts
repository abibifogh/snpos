/**
 * Stock requests, read and written. The rules are in stock-requests.ts.
 */
import { db, DB_ID, Query, listAll, saveDropping } from './client';
import { loadPurchaseOrders, loadOrderables, savePurchaseOrder } from './purchase-orders-store';
import { isRunningLow, suggestLine, readLines, neededByWords } from './purchase-orders';
import type { OrderableItem, OrderSupplier } from './purchase-orders';
import {
  askList, heldItems, readAskLines, draftPlans, askedByWords,
} from './stock-requests';
import type { AskLine, AskList, AskSide, DraftPlan, StockRequest } from './stock-requests';

type Row = Omit<StockRequest, 'lines'> & { lines?: string };
const fromRow = (r: Row): StockRequest => ({ ...r, lines: readAskLines(r.lines) });

/** Every request this venue has made, newest first. */
const allRequests = (venueId: string): Promise<StockRequest[]> =>
  listAll<Row>('stock_requests', [Query.equal('venue_id', venueId)])
    .then((rows) => rows.map(fromRow).sort((a, b) => (b.$createdAt ?? '').localeCompare(a.$createdAt ?? '')));

/**
 * What the sheet opens on: this side's low items, those already on their way,
 * and the rest of its list to search. `lowBp` is the business's default low
 * line (settings.low_stock_default_bp).
 */
export async function loadAskList(venueId: string, side: AskSide, lowBp = 3000): Promise<AskList> {
  const [{ items }, orders, requests] = await Promise.all([
    loadOrderables(venueId),
    loadPurchaseOrders(venueId).catch(() => []),
    allRequests(venueId).catch(() => [] as StockRequest[]),
  ]);
  const held = heldItems(
    orders.filter((o) => (o.module ?? 'kitchen') === side).map((o) => ({ ...o, lines: readLines(o.lines) })),
    requests.filter((r) => r.side === side),
    (d) => (d ? `due ${neededByWords(d)}` : ''),
  );
  return askList(items as OrderableItem[], side, held, (i) => isRunningLow(i, lowBp), suggestLine);
}

/** Send what was asked for. Goes to Approvals for whoever orders stock. */
export async function fileStockRequest(input: {
  venueId: string;
  side: AskSide;
  lines: AskLine[];
  note: string;
  byId?: string;
  byName?: string;
}): Promise<string> {
  const lines = input.lines.filter((l) => l.qty > 0);
  const { id } = await saveDropping('stock_requests', null, {
    venue_id: input.venueId,
    side: input.side,
    by_id: input.byId ?? '',
    by_name: (input.byName ?? '').slice(0, 120),
    lines: JSON.stringify(lines),
    note: input.note.trim().slice(0, 1000),
    status: 'asked',
  });
  return id;
}

/** This side's recent requests and the orders behind them, for "Asked before". */
export async function recentRequests(venueId: string, side: AskSide, limit = 12): Promise<{
  requests: StockRequest[];
  orders: { $id: string; status?: string }[];
}> {
  const [requests, orders] = await Promise.all([
    allRequests(venueId),
    loadPurchaseOrders(venueId).catch(() => []),
  ]);
  return { requests: requests.filter((r) => r.side === side).slice(0, limit), orders };
}

/** The requests nobody has decided, for Approvals. */
export async function pendingStockRequests(): Promise<StockRequest[]> {
  const rows = await listAll<Row>('stock_requests', [Query.equal('status', 'asked')]);
  return rows.map(fromRow);
}

/** One request as the drafts it would make, priced, for Approvals. */
export async function requestPlans(venueId: string, lines: AskLine[]): Promise<{
  plans: DraftPlan[];
  items: OrderableItem[];
  suppliers: OrderSupplier[];
}> {
  const { items, suppliers } = await loadOrderables(venueId);
  return { plans: draftPlans(lines, items as OrderableItem[], suppliers, suggestLine), items: items as OrderableItem[], suppliers };
}

/**
 * Make the orders: one draft per supplier, each marked with where it came
 * from, and the request marked ordered. Drafts, so whoever orders still
 * checks, sends and receives each one exactly as they would any other.
 * `lines` is the request as the manager left it, amounts changed or not.
 */
export async function orderFromRequest(input: {
  request: StockRequest;
  lines: AskLine[];
  approveOver: number;
  isAdmin: boolean;
  by: string;
  byName?: string;
}): Promise<{ orders: number }> {
  const r = input.request;
  const { plans } = await requestPlans(r.venue_id, input.lines);
  const asked = askedByWords(r.side, r.by_name);
  const note = [asked, (r.note ?? '').trim() ? `“${(r.note ?? '').trim()}”` : ''].filter(Boolean).join('. ');
  const ids: string[] = [];
  for (const p of plans) {
    const o = await savePurchaseOrder({
      venueId: r.venue_id,
      module: r.side,
      supplier: p.supplier
        ? { $id: p.supplier.$id, name: p.supplier.name, email: p.supplier.email, phone: p.supplier.phone }
        : { name: '' },
      lines: p.lines,
      note,
      submit: false,
      approveOver: input.approveOver,
      isAdmin: input.isAdmin,
      by: input.by,
      byName: input.byName,
      origin: { request_id: r.$id, asked_by: asked },
    });
    ids.push(o.$id);
  }
  await saveDropping('stock_requests', r.$id, {
    status: 'ordered',
    order_ids: ids.join(','),
    decided_by: input.by,
    decided_by_name: (input.byName ?? '').slice(0, 120),
    decided_at: new Date().toISOString(),
  });
  return { orders: ids.length };
}

/** Not now: nothing is ordered, and the side sees why on "Asked before". */
export async function declineStockRequest(input: { id: string; by: string; byName?: string; reason: string }): Promise<void> {
  await saveDropping('stock_requests', input.id, {
    status: 'declined',
    decided_by: input.by,
    decided_by_name: (input.byName ?? '').slice(0, 120),
    decided_at: new Date().toISOString(),
    decided_note: input.reason.trim().slice(0, 500),
  });
}

/** For the e2e and anything else that needs one row. */
export const loadStockRequest = (id: string): Promise<StockRequest> =>
  (db.getDocument(DB_ID, 'stock_requests', id) as unknown as Promise<Row>).then(fromRow);
