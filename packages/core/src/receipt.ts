import { db, DB_ID, Query, listAll } from './client';
import { formatMoney } from './money';
import { downloadUrl } from './files';
import { addonNames } from './orders-time';
import type { Settings, Venue, Doc } from './types';
import type { Order, OrderItem } from './orders';

/**
 * A printable receipt, in the shape people expect from a till.
 *
 * Built as a self-contained HTML document rather than as React, because it is
 * not part of any page; it goes into a print window, and from there to paper
 * or to "Save as PDF". That route is the reason there is no PDF library here:
 * every browser already has a very good one, it handles fonts and page breaks
 * properly, and it costs nothing to ship.
 *
 * Sized for 80mm roll paper, which is also what makes it read like a receipt
 * rather than like a letter when it is saved as a PDF.
 */

export interface ReceiptLine {
  name: string;
  qty: number;
  unitPrice: string;
  lineTotal: string;
  /** Add-ons, notes, the small print under a line. */
  detail?: string;
}

export interface ReceiptPayment {
  method: string;
  amount: string;
  change?: string;
}

export interface ReceiptData {
  restaurantName: string;
  venueName?: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
  /** Business or tax number, printed under the name if there is one. */
  taxNumber?: string;
  logoUrl?: string;
  tagline?: string;

  orderNo: string;
  placedAt: string;
  servedBy?: string;
  seating?: string;
  customerName?: string;

  lines: ReceiptLine[];
  subtotal: string;
  discount?: string;
  discountLabel?: string;
  service?: string;
  tax?: string;
  taxLabel?: string;
  taxInclusive?: boolean;
  tip?: string;
  total: string;
  payments: ReceiptPayment[];
  /** Blank when the bill has not been settled. */
  unpaid?: boolean;
  footer?: string;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The barcode strip along the bottom.
 *
 * Drawn from the order number rather than fetched, so a receipt saved as a PDF
 * still looks right with no network. It is decorative, a real scannable
 * symbology would need a checksum and a fixed character set, and nothing in
 * this system scans receipts. Deliberately not pretending otherwise.
 */
function barStrip(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const bars: string[] = [];
  for (let i = 0; i < 48; i++) {
    hash = (hash * 1103515245 + 12345) >>> 0;
    const w = 1 + ((hash >>> 8) % 3);
    bars.push(`<i style="width:${w}px"></i>`);
    bars.push(`<i style="width:${1 + ((hash >>> 16) % 2)}px;background:transparent"></i>`);
  }
  return `<div class="bars">${bars.join('')}</div>`;
}

export function buildReceiptHtml(d: ReceiptData): string {
  const row = (label: string, value: string, opts: { big?: boolean; strong?: boolean } = {}) => `
    <div class="tot ${opts.big ? 'big' : ''} ${opts.strong ? 'strong' : ''}">
      <span>${esc(label)}</span><span>${esc(value)}</span>
    </div>`;

  const when = new Date(d.placedAt);
  const stamp = `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;

  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>Receipt ${esc(d.orderNo)}</title>
<style>
  @page { size: 80mm auto; margin: 4mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto;
    max-width: 72mm;
    padding: 6px 0 18px;
    font-family: "Helvetica Neue", Arial, sans-serif;
    font-size: 12px;
    line-height: 1.45;
    color: #000;
    background: #fff;
    -webkit-font-smoothing: antialiased;
  }
  .mid { text-align: center; }
  .logo { width: 74px; height: 74px; border-radius: 50%; object-fit: cover; margin: 0 auto 8px; display: block; }
  .name { font-size: 15px; font-weight: 700; letter-spacing: 0.04em; }
  .tagline { font-family: Georgia, "Times New Roman", serif; font-style: italic; font-size: 17px; margin: 10px 0 14px; }
  .meta { font-size: 11px; line-height: 1.5; }
  .rule { border-top: 1px solid #000; margin: 10px 0 8px; }
  .dash { border-top: 1px dashed #999; margin: 8px 0; }
  .kind { text-align: center; font-size: 11.5px; margin: 10px 0 6px; }

  .line { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 2px; }
  .line .what { flex: 1; }
  .line .amt { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .detail { font-size: 10.5px; color: #333; padding-left: 8px; }
  .qtyline { font-size: 10.5px; color: #333; padding-left: 8px; }

  .tot { display: flex; justify-content: space-between; gap: 8px; font-variant-numeric: tabular-nums; margin: 2px 0; }
  .tot.strong { font-weight: 700; }
  .tot.big { font-size: 19px; font-weight: 700; margin: 6px 0; }

  .stamp { display: flex; justify-content: space-between; font-size: 10.5px; margin-top: 14px; gap: 6px; }
  .bars { display: flex; align-items: flex-end; height: 42px; margin: 6px 0 2px; justify-content: center; }
  .bars i { display: block; height: 100%; background: #000; }
  .saleno { text-align: center; font-size: 10.5px; letter-spacing: 0.06em; }
  .unpaid {
    text-align: center; border: 2px solid #000; padding: 5px; margin: 10px 0;
    font-weight: 700; letter-spacing: 0.08em;
  }
  @media screen {
    body { box-shadow: 0 2px 18px rgba(0,0,0,0.18); padding: 16px 12px 24px; margin-top: 18px; border-radius: 3px; }
  }
</style></head>
<body>
  <div class="mid">
    ${d.logoUrl ? `<img class="logo" src="${esc(d.logoUrl)}" alt="">` : ''}
    ${d.tagline ? `<div class="tagline">${esc(d.tagline)}</div>` : ''}
    <div class="name">${esc(d.venueName || d.restaurantName)}</div>
    <div class="meta">
      ${d.taxNumber ? `<div>${esc(d.taxNumber)}</div>` : ''}
      ${d.address ? `<div>${esc(d.address)}</div>` : ''}
      ${d.email ? `<div>${esc(d.email)}</div>` : ''}
      ${d.website ? `<div>${esc(d.website)}</div>` : ''}
      ${d.phone ? `<div>Phone&nbsp;&nbsp;${esc(d.phone)}</div>` : ''}
    </div>
  </div>

  <div class="kind">Tax Invoice / Receipt</div>
  <div class="rule"></div>

  ${d.lines
    .map(
      (l) => `
    <div class="line">
      <span class="what">${esc(l.name)}</span>
      <span class="amt">${esc(l.lineTotal)}</span>
    </div>
    ${l.qty > 1 ? `<div class="qtyline">${l.qty} @ ${esc(l.unitPrice)}</div>` : ''}
    ${l.detail ? `<div class="detail">${esc(l.detail)}</div>` : ''}`,
    )
    .join('')}

  <div class="rule"></div>
  ${row('Sub Total', d.subtotal)}
  ${d.discount ? row(d.discountLabel || 'Discount', `−${d.discount}`) : ''}
  ${d.service ? row('Service', d.service) : ''}
  ${d.tip ? row('Tip', d.tip) : ''}
  ${!d.taxInclusive && d.tax ? row(d.taxLabel || 'Tax', d.tax) : ''}
  ${row('Total', d.total, { big: true })}
  ${d.payments.map((p) => row(`Tendered ${p.method}`, p.amount)).join('')}
  ${d.payments.find((p) => p.change) ? row('Change', d.payments.find((p) => p.change)!.change!, { big: true }) : ''}
  ${d.taxInclusive && d.tax ? row(`${d.taxLabel || 'Tax'} Total`, d.tax) : ''}

  ${d.unpaid ? '<div class="unpaid">NOT YET PAID</div>' : ''}

  <div class="dash"></div>
  <div class="meta">
    ${d.seating ? `<div>${esc(d.seating)}</div>` : ''}
    ${d.customerName ? `<div>${esc(d.customerName)}</div>` : ''}
  </div>

  <div class="stamp">
    <span>${esc(stamp)}</span>
    <span>${esc(d.servedBy || '')}</span>
  </div>
  ${barStrip(d.orderNo)}
  <div class="saleno">Order No. ${esc(d.orderNo)}</div>
  ${d.footer ? `<div class="mid meta" style="margin-top:10px">${esc(d.footer)}</div>` : ''}
</body></html>`;
}

/**
 * Put a document in front of the browser's print dialog, where "Save as PDF"
 * lives.
 *
 * A hidden iframe rather than a popup window: popups get blocked, and a blocked
 * popup looks to the person pressing the button exactly like nothing happening.
 * The iframe is removed once printing is done or cancelled.
 */
export function openPrintable(html: string, filename: string): void {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);

  const doc = frame.contentWindow?.document;
  if (!doc) { frame.remove(); return; }
  doc.open();
  doc.write(html);
  doc.close();

  // The browser names the saved PDF after the document title.
  doc.title = filename;

  const go = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } finally {
      // Long enough for the dialog to take its own copy of the document.
      setTimeout(() => frame.remove(), 60_000);
    }
  };

  // Images have to have loaded, or the receipt prints without its logo.
  if (doc.readyState === 'complete') setTimeout(go, 250);
  else frame.onload = () => setTimeout(go, 250);
}

// ---------------------------------------------------------------------------
//  Turning an order into one of the above
// ---------------------------------------------------------------------------

interface PaymentRow extends Doc {
  order_id: string;
  method_id: string;
  method_kind_snapshot: string;
  amount: number;
  tip: number;
  change_given: number;
  taken_by: string;
}

/**
 * Everything a receipt needs, gathered in one place.
 *
 * Written once and called from both the customer's phone and the admin app, so
 * the copy a guest downloads and the copy an owner reprints are the same
 * document, which is the entire point of a receipt.
 */
export async function receiptForOrder(opts: {
  order: Order;
  settings: Settings;
  venue?: Venue | null;
  /** Passed in when the caller already has them, fetched when not. */
  items?: OrderItem[];
  staffName?: string;
  seating?: string;
}): Promise<ReceiptData> {
  const { order, settings, venue } = opts;
  const money = (n: number) => formatMoney(n, settings);

  const items =
    opts.items ??
    (await listAll<OrderItem>('order_items', [Query.equal('order_id', order.$id)]).catch(() => []));

  // A guest can read their own payments; if not, the receipt simply shows the
  // bill without a tender line rather than failing to open.
  const payments = await listAll<PaymentRow>('payments', [Query.equal('order_id', order.$id)]).catch(
    () => [] as PaymentRow[],
  );
  const methods = await listAll<{ $id: string; name: string }>('payment_methods').catch(
    () => [] as { $id: string; name: string }[],
  );

  const lines: ReceiptLine[] = items
    .filter((i) => i.status !== 'void')
    .map((i) => {
      // One reader for what was chosen, shared with the kitchen ticket, so a
      // receipt and a ticket can never disagree about what was ordered.
      let detail = addonNames(i.addons).join(', ');
      if (i.notes) detail = detail ? `${detail} · ${i.notes}` : i.notes;
      return {
        name: i.name_snapshot,
        qty: i.qty,
        unitPrice: money(i.unit_price),
        lineTotal: money(i.line_total),
        detail: detail || undefined,
      };
    });

  const logoId = settings.logo_light_id;

  return {
    restaurantName: settings.restaurant_name,
    venueName: venue?.name,
    address: venue?.address,
    phone: venue?.phone,
    email: settings.email_from_address,
    logoUrl: logoId ? downloadUrl(logoId, 'branding', settings) : undefined,
    orderNo: order.order_no,
    placedAt: order.$createdAt,
    servedBy: opts.staffName,
    seating: opts.seating,
    customerName: order.customer_name || undefined,
    lines,
    subtotal: money(order.subtotal),
    discount: order.discount_total > 0 ? money(order.discount_total) : undefined,
    service: order.service_total > 0 ? money(order.service_total) : undefined,
    tax: order.tax_total > 0 ? money(order.tax_total) : undefined,
    taxLabel: settings.currency_code === 'GHS' ? 'VAT' : 'Tax',
    taxInclusive: settings.tax_inclusive,
    tip: order.tip_total > 0 ? money(order.tip_total) : undefined,
    total: money(order.total),
    payments: payments.map((p) => ({
      method: methods.find((m) => m.$id === p.method_id)?.name ?? p.method_kind_snapshot ?? 'Payment',
      amount: money(p.amount + (p.tip ?? 0)),
      change: p.change_given > 0 ? money(p.change_given) : undefined,
    })),
    unpaid: order.payment_status !== 'paid',
    footer: 'Thank you.',
  };
}

export interface ReceiptRow extends Doc {
  venue_id: string;
  order_id: string;
  channel: string;
  to_email?: string;
  status: 'queued' | 'sent' | 'failed' | 'skipped' | 'bounced';
  sent_at?: string;
  resend_requested_at?: string;
}

/**
 * Ask for a receipt to be sent, or sent again.
 *
 * Staff can update a receipt row but not delete one, deliberately, an audit
 * trail the audited can remove is not an audit trail. So a resend is recorded
 * as a request against the existing rows, and the notify function acts on it
 * and clears it. An order that never had a receipt has no row to mark, and the
 * order update alone is enough for one to be made.
 *
 * The email is written to the order because that is where every other part of
 * the system looks for it, and because a customer who gives their address at
 * the counter should not have to give it again next time.
 */
export async function requestReceipt(opts: {
  order: Pick<Order, '$id' | 'customer_email'>;
  email: string;
  requestedBy: string;
}): Promise<void> {
  const email = opts.email.trim();
  if (!email) throw new Error('An email address is needed to send a receipt.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`"${email}" does not look like an email address.`);
  }

  const existing = await listAll<ReceiptRow>('receipts', [Query.equal('order_id', opts.order.$id)]).catch(
    () => [] as ReceiptRow[],
  );
  const now = new Date().toISOString();
  for (const row of existing) {
    await db
      .updateDocument(DB_ID, 'receipts', row.$id, {
        resend_requested_at: now,
        resend_requested_by: opts.requestedBy,
        to_email: email,
      })
      .catch(() => undefined);
  }

  // Written last, because this is the update the notify function listens for.
  // Doing it first would risk the function running before the rows above were
  // marked, and deciding there was nothing to resend.
  await db.updateDocument(DB_ID, 'orders', opts.order.$id, { customer_email: email });
}
