/**
 * The reporting API's arithmetic and its shapes, with nothing else in them.
 *
 * Imports nothing on purpose, so what an outside system will actually receive
 * can be checked without a database and without Appwrite. The half that talks
 * to the database lives in reports.js.
 *
 * Two rules run through all of it.
 *
 * Money is an integer in minor units, everywhere, exactly as it is stored.
 * Dividing by a hundred here would hand somebody a float and invite them to
 * add floats together, which is how a report ends up disagreeing with a till by
 * a pesewa a line. The currency and its decimals travel in every response so
 * the receiving system can format without guessing.
 *
 * Nothing personal leaves. A customer's email and phone number are on an order
 * because a receipt has to reach them; they are not analysis, and an analytics
 * system that holds them is a place they can leak from. Names stay, because
 * "who orders the most" is a real question.
 */

/* ----------------------------------------------------------------- access */

/**
 * Is this request allowed?
 *
 * Compared over the full length rather than with a plain ===, which returns as
 * soon as two characters differ and so leaks, in its timing, how much of a
 * guess was right. That is a thin attack and this is a thin defence, but it
 * costs one loop.
 *
 * A missing secret is a closed door, never an open one. A reporting API that
 * quietly serves everything because nobody set a key is worse than one that
 * does not work.
 */
export function authorised(header, secret) {
  if (!secret || typeof secret !== 'string' || secret.length < 16) return false;
  // Trimmed before the prefix is stripped, not after. A header arriving with a
  // leading space is a proxy's doing, not a wrong key, and answering it with
  // "not authorised" is an hour of somebody's life for nothing.
  const given = String(header || '').trim().replace(/^Bearer\s+/i, '').trim();
  if (given.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i += 1) diff |= given.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------ the request */

const DAY = 86_400_000;

/** A date that is either a plain day or a full timestamp, or nothing. */
function readDate(value, endOfDay = false) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  // A plain "2026-08-01" means the whole of that day, not its first instant,
  // or a report "to the 12th" silently loses the 12th.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    : raw;
  const at = new Date(iso);
  return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}

/**
 * The window being asked about.
 *
 * Defaults to the last thirty days rather than to everything. A caller that
 * forgets the dates gets a useful answer instead of the whole history, and a
 * scheduled job that forgets them every five minutes does not pull the entire
 * database each time.
 */
export function readRange(query = {}, now = new Date()) {
  const to = readDate(query.to, true) ?? now.toISOString();
  const from = readDate(query.from) ?? new Date(new Date(to).getTime() - 30 * DAY).toISOString();
  // Backwards is a typo, not a request for nothing.
  return from <= to ? { from, to } : { from: to, to: from };
}

/** How many rows per page. Bounded, so one call cannot ask for everything. */
export function readLimit(value, fallback = 100, max = 500) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

/** Which side of the business, when the caller says. */
export function readModule(value) {
  const m = String(value || '').trim().toLowerCase();
  return m === 'kitchen' || m === 'craft' ? m : null;
}

/* -------------------------------------------------------------- the rows */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v) => (v === undefined || v === null ? '' : String(v));

/**
 * A sale, as an outside system should see it.
 *
 * Field names are the ones this system stores, not prettier ones. A report
 * whose column is called `total` and a database whose column is called `total`
 * can be reconciled by anybody; renaming things at the boundary means every
 * question has to be translated twice.
 */
export const shapeOrder = (o) => ({
  id: o.$id,
  created_at: o.$createdAt,
  order_no: str(o.order_no),
  venue_id: str(o.venue_id),
  module: str(o.module) || 'kitchen',
  channel: str(o.channel),
  fulfilment: str(o.fulfilment),
  status: str(o.status),
  payment_status: str(o.payment_status),
  table_id: str(o.table_id),
  shift_id: str(o.shift_id),
  // Set only on an order a shift ran past its limit to take. Worth having:
  // it explains a sale sitting on a night after the one it was ordered on.
  shelved_from_shift: str(o.shelved_from_shift),
  guest_count: num(o.guest_count),
  subtotal: num(o.subtotal),
  discount_total: num(o.discount_total),
  service_total: num(o.service_total),
  tax_total: num(o.tax_total),
  tip_total: num(o.tip_total),
  total: num(o.total),
  is_group: !!o.is_group,
  is_preorder: !!o.is_preorder,
  scheduled_for: str(o.scheduled_for),
  placed_by: str(o.placed_by),
  customer_name: str(o.customer_name),
  accepted_at: str(o.accepted_at),
  served_at: str(o.served_at),
  marked_paid_at: str(o.marked_paid_at),
  quoted_wait_minutes: num(o.quoted_wait_minutes),
  prep_minutes: num(o.prep_minutes),
});

export const shapeOrderItem = (i) => ({
  id: i.$id,
  created_at: i.$createdAt,
  order_id: str(i.order_id),
  menu_item_id: str(i.menu_item_id),
  name: str(i.name_snapshot),
  variant_label: str(i.variant_label),
  station_key: str(i.station_key),
  qty: num(i.qty),
  unit_price: num(i.unit_price),
  line_total: num(i.line_total),
  status: str(i.status),
  course: num(i.course),
  prep_minutes: num(i.prep_minutes),
  consignor_id: str(i.consignor_id),
  commission_bp: num(i.commission_bp),
  commission_flat: num(i.commission_flat),
});

export const shapePayment = (p) => ({
  id: p.$id,
  created_at: p.$createdAt,
  venue_id: str(p.venue_id),
  order_id: str(p.order_id),
  shift_id: str(p.shift_id),
  method_id: str(p.method_id),
  method_kind: str(p.method_kind_snapshot),
  amount: num(p.amount),
  tip: num(p.tip),
  change_given: num(p.change_given),
  status: str(p.status),
  taken_by: str(p.taken_by),
  refund_of: str(p.refund_of),
});

export const shapeExpense = (e) => ({
  id: e.$id,
  created_at: e.$createdAt,
  venue_id: str(e.venue_id),
  shift_id: str(e.shift_id),
  module: str(e.module) || 'kitchen',
  category_key: str(e.category_key) || str(e.category),
  paid_to_kind: str(e.paid_to_kind),
  payee: str(e.payee),
  supplier_id: str(e.supplier_id),
  paid_to_staff_id: str(e.paid_to_staff_id),
  amount: num(e.amount),
  paid_from_method_id: str(e.paid_from_method_id),
  approval_status: str(e.approval_status),
  note: str(e.note),
});

/** JSON kept as JSON, because a string of JSON is not data anybody can group by. */
const parsed = (text) => {
  try {
    const v = JSON.parse(text || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};

export const shapeShift = (s) => ({
  id: s.$id,
  created_at: s.$createdAt,
  venue_id: str(s.venue_id),
  code: str(s.code),
  module: str(s.module) || 'kitchen',
  status: str(s.status),
  opened_at: str(s.opened_at),
  opened_by: str(s.opened_by),
  closed_at: str(s.closed_at),
  closed_by: str(s.closed_by),
  sales_total: num(s.sales_total),
  expense_total: num(s.expense_total),
  tax_total: num(s.tax_total),
  tip_total: num(s.tip_total),
  discount_total: num(s.discount_total),
  cogs_total: num(s.cogs_total),
  covers: num(s.covers),
  opening_floats: parsed(s.opening_floats),
  expected: parsed(s.expected),
  counted: parsed(s.counted),
  variance: parsed(s.variance),
  variance_note: str(s.variance_note),
});

export const shapeProduct = (m) => ({
  id: m.$id,
  created_at: m.$createdAt,
  name: str(m.name),
  category_id: str(m.category_id),
  module: str(m.module) || 'kitchen',
  price: num(m.price),
  active: m.active !== false,
  on_hand: num(m.on_hand),
  prep_minutes: num(m.prep_minutes),
  consignor_id: str(m.consignor_id),
  intake_id: str(m.intake_id),
  commission_bp: num(m.commission_bp),
  commission_flat: num(m.commission_flat),
});

export const shapeConsignor = (c) => ({
  id: c.$id,
  created_at: c.$createdAt,
  code: str(c.code),
  name: str(c.name),
  commission_bp: num(c.commission_bp),
  commission_flat: num(c.commission_flat),
  payout_method: str(c.payout_method),
  active: c.active !== false,
});

export const shapeLedger = (l) => ({
  id: l.$id,
  created_at: l.$createdAt,
  consignor_id: str(l.consignor_id),
  entry_at: str(l.entry_at),
  kind: str(l.kind),
  // Positive increases what the shop owes the maker; negative reduces it. The
  // balance is the sum of these and is never stored anywhere.
  amount: num(l.amount),
  description: str(l.description),
  order_id: str(l.order_id),
  menu_item_id: str(l.menu_item_id),
  qty: num(l.qty),
  gross: num(l.gross),
  commission: num(l.commission),
  commission_bp: num(l.commission_bp),
  commission_flat: num(l.commission_flat),
  payout_id: str(l.payout_id),
});

export const shapeIntake = (i) => ({
  id: i.$id,
  created_at: i.$createdAt,
  reference: str(i.reference),
  consignor_id: str(i.consignor_id),
  received_at: str(i.received_at),
  piece_count: num(i.piece_count),
  total_retail: num(i.total_retail),
  total_due: num(i.total_due),
  status: str(i.status),
});

export const shapeMove = (m) => ({
  id: m.$id,
  created_at: m.$createdAt,
  menu_item_id: str(m.menu_item_id),
  variant_id: str(m.variant_id),
  consignor_id: str(m.consignor_id),
  type: str(m.type),
  qty_delta: num(m.qty_delta),
  unit_price: num(m.unit_price),
  ref_type: str(m.ref_type),
  ref_id: str(m.ref_id),
  shift_id: str(m.shift_id),
});

/* ------------------------------------------------------------- the totals */

/**
 * The headline figures for a window, from the rows themselves.
 *
 * Worked out here rather than read off the shift rows, so the answer covers
 * exactly the window asked about, which almost never lines up with a shift.
 * Cancelled, rejected and unfired pre-orders are left out of sales: a ticket
 * nobody cooked sold nothing.
 *
 * `net_sales` is what was actually taken, minus what was paid out again. It is
 * not profit; nothing here knows what anything cost to make.
 *
 * The shapes are spelled out because the empty defaults below say nothing on
 * their own: an empty list with no annotation is a list of nothing, and
 * anything handed to it afterwards is the wrong type. That is a note to the
 * checker rather than a change of behaviour, and it doubles as the only
 * written record of which fields these totals actually depend on.
 *
 * @param {{
 *   orders?: { status: string, payment_status: string, module: string, total: number,
 *              guest_count: number, discount_total: number, tax_total: number,
 *              service_total: number }[],
 *   payments?: { status: string, method_kind: string, amount: number, tip: number }[],
 *   expenses?: { amount: number }[],
 * }} rows
 */
export function summarise({ orders = [], payments = [], expenses = [] }) {
  const counted = orders.filter((o) => !['CANCELLED', 'REJECTED', 'SCHEDULED'].includes(o.status));
  const paid = payments.filter((p) => p.status !== 'voided' && p.status !== 'refunded');

  const byMethod = {};
  for (const p of paid) {
    const key = p.method_kind || 'unknown';
    byMethod[key] = (byMethod[key] ?? 0) + p.amount;
  }

  const byModule = {};
  for (const o of counted) {
    const key = o.module || 'kitchen';
    byModule[key] = byModule[key] ?? { orders: 0, total: 0 };
    byModule[key].orders += 1;
    byModule[key].total += o.total;
  }

  const takings = paid.reduce((n, p) => n + p.amount, 0);
  const out = expenses.reduce((n, e) => n + e.amount, 0);

  return {
    orders: counted.length,
    orders_paid: counted.filter((o) => o.payment_status === 'paid').length,
    orders_unpaid: counted.filter((o) => o.payment_status !== 'paid').length,
    covers: counted.reduce((n, o) => n + o.guest_count, 0),
    gross_sales: counted.reduce((n, o) => n + o.total, 0),
    discounts: counted.reduce((n, o) => n + o.discount_total, 0),
    tax: counted.reduce((n, o) => n + o.tax_total, 0),
    service: counted.reduce((n, o) => n + o.service_total, 0),
    takings,
    tips: paid.reduce((n, p) => n + p.tip, 0),
    expenses: out,
    net_sales: takings - out,
    average_order: counted.length ? Math.round(counted.reduce((n, o) => n + o.total, 0) / counted.length) : 0,
    by_method: byMethod,
    by_module: byModule,
  };
}
