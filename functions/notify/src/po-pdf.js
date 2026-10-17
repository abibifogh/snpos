/**
 * A purchase order, as a PDF.
 *
 * One builder for both copies: the one the office downloads and the one the
 * notify job attaches to the email. Two would agree on the day they were
 * written and drift the first time one changed. It takes plain data and
 * returns bytes, with no Buffer, so the browser can run it too.
 *
 * Laid out the way a supplier reads an order: who it is from and to, the
 * order number to quote, what is wanted and how many, an expected price, and
 * when it is needed by. See packages/core/src/purchase-orders.ts.
 */

import { Doc } from './pdf-doc.js';

const INK = '#1a2230';
const QUIET = '#66727f';
const LINE = '#dde3ea';

const clean = (s) => String(s ?? '').trim();

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "2026-10-20" as "20 October 2026", as neededByWords does in core. */
const dayWords = (day) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(day));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : clean(day);
};

function readLines(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const plural = (w) => {
  const s = clean(w) || 'unit';
  return /s$|kg$|ml$|cl$|g$|l$/i.test(s) ? s : `${s}s`;
};

/** "3 crates (12 bottles each)", "5 kg". The same words as the message. */
export function quantityWords(l) {
  const qty = Number(l.qty) || 0;
  if (l.buy_key === 'pack') {
    const label = qty === 1 ? clean(l.buy_label).replace(/s$/, '') : clean(l.buy_label);
    return `${qty} ${label} (${l.per} ${plural(l.unit)} each)`;
  }
  return `${qty} ${qty === 1 ? clean(l.unit) : plural(l.unit)}`;
}

/**
 * @param {object} input
 * @param {Record<string, any>} input.order  The purchase_orders row.
 * @param {Record<string, any>} [input.settings]
 * @param {string} [input.accent]
 */
export function purchaseOrderPdf({ order, settings = {}, accent = '#0f766e' }) {
  const decimals = settings.currency_decimals ?? 2;
  const code = settings.currency_code || '';
  const money = (n) => `${code} ${((n || 0) / 10 ** decimals).toFixed(decimals)}`.trim();
  const lines = readLines(order.lines).filter((l) => (Number(l.qty) || 0) > 0);

  const doc = new Doc();
  doc.fill(0, doc.height - 8, doc.width, 8, accent);
  doc.gap(-14);
  doc.text(clean(settings.restaurant_name) || 'Purchase order', { size: 19, font: 'bold' });
  doc.text(`Purchase order ${clean(order.po_no)}`, { size: 12, font: 'bold', colour: accent });
  doc.rule({ colour: accent, thickness: 1.4, above: 8, below: 12 });

  const made = order.$createdAt ? new Date(order.$createdAt) : new Date();
  const facts = [
    ['To', clean(order.supplier_name) || '-'],
    ['Order number', clean(order.po_no) || '-'],
    ['Date', made.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })],
    ...(clean(order.expected_on) ? [['Needed by', dayWords(order.expected_on)]] : []),
    ...(clean(order.created_by_name) ? [['Ordered by', clean(order.created_by_name)]] : []),
    ...(clean(settings.email_from_address) ? [['Reply to', clean(settings.email_from_address)]] : []),
  ];
  for (const [k, v] of facts) doc.pair(k, v, { size: 10, colour: INK, valueFont: 'bold' });
  doc.gap(10);

  doc.band('What we would like', { colour: accent, right: 'Expected price' });
  for (const l of lines) {
    doc.pair(`${clean(l.name)}`, money(Math.round((l.qty || 0) * (l.unit_cost || 0))), { size: 10.5, font: 'bold' });
    doc.text(`${quantityWords(l)}${l.unit_cost ? ` · ${money(l.unit_cost)} each` : ''}`, {
      size: 9, colour: QUIET, x: doc.left + 12,
    });
    doc.rule({ colour: LINE, above: 4, below: 4 });
  }
  if (lines.length === 0) doc.text('Nothing on this order.', { size: 10, font: 'italic', colour: QUIET });

  doc.gap(4);
  doc.pair('Expected total', money(order.total), { size: 12, font: 'bold', valueFont: 'bold' });
  doc.gap(10);

  if (clean(order.note)) {
    doc.text('Notes', { size: 10.5, font: 'bold' });
    doc.text(clean(order.note), { size: 10, colour: INK });
    doc.gap(8);
  }

  doc.text(
    'Prices are what we expect to pay. Please tell us before delivering if any have changed, and quote the '
      + 'order number on your invoice.',
    { size: 9, colour: QUIET },
  );

  return doc.build({
    foot: (page, total) => `${clean(order.po_no)} · ${clean(order.supplier_name)} · page ${page} of ${total}`,
  });
}
