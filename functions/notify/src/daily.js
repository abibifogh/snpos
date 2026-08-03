import { Query } from 'node-appwrite';
import { receiptPdf } from './receipt-pdf.js';

/**
 * The two things that happen once a day rather than once a shift.
 *
 * Both hang off the same hourly timer the availability sweep uses, because
 * this plan allows four functions and they are all spoken for. Each checks
 * whether it is its hour in the restaurant's own timezone — not the server's,
 * which is UTC and would fire the "end of day" report in the middle of dinner.
 */

/** The hour right now where the restaurant actually is. */
export function localHour(timezone) {
  try {
    return Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: 'numeric', hour12: false }).format(new Date()),
    );
  } catch {
    return new Date().getUTCHours();
  }
}

/** The day that is ending, as a local calendar date. */
export function localDay(timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Everyone signed up for a given report.
 *
 * An empty list is not an error and not a silence to be worked around — it is
 * an admin saying they do not want this one. It is only worth logging when
 * something was actually generated and had nowhere to go.
 */
async function recipientsFor(db, DB_ID, event) {
  const subs = await db
    .listDocuments(DB_ID, 'report_subscriptions', [Query.equal('active', true), Query.limit(50)])
    .catch(() => ({ documents: [] }));
  return subs.documents
    .filter((s) => s.channel === 'email' && (s.events || []).includes(event))
    .map((s) => s.destination)
    .filter(Boolean);
}

/**
 * The day's trading, in one email.
 *
 * Separate from the shift summary on purpose. A day with two shifts produces
 * two shift emails and no figure for the day, which is the number an owner
 * actually asks for.
 */
export async function dailyDigest({ db, DB_ID, settings, transport, from, shell, row, money, log, error }) {
  const tz = settings.timezone || 'UTC';
  if (localHour(tz) !== Number(settings.daily_report_hour ?? 23)) return { skipped: 'not the hour' };

  const to = await recipientsFor(db, DB_ID, 'daily_digest');
  if (to.length === 0) return { skipped: 'nobody subscribed to the daily summary' };

  const day = localDay(tz);
  const venues = await db.listDocuments(DB_ID, 'venues', [Query.limit(25)]);
  const venue = venues.documents[0];
  if (!venue) return { skipped: 'no venue' };

  // Sent once per day. The timer fires hourly and a clock change or a retry
  // must not produce two.
  const already = await db
    .listDocuments(DB_ID, 'summary_reports', [
      Query.equal('kind', 'daily_digest'),
      Query.equal('venue_id', venue.$id),
      Query.orderDesc('$createdAt'),
      Query.limit(1),
    ])
    .catch(() => ({ documents: [] }));
  if (already.documents[0] && JSON.parse(already.documents[0].payload || '{}').day === day) {
    return { skipped: 'already sent today' };
  }

  // The local day, converted once. Everything below is filtered on it.
  const start = new Date(`${day}T00:00:00`).toISOString();
  const end = new Date(`${day}T23:59:59.999`).toISOString();
  const between = [Query.greaterThanEqual('$createdAt', start), Query.lessThanEqual('$createdAt', end)];

  const [orders, payments, expenses, shifts, methods] = await Promise.all([
    db.listDocuments(DB_ID, 'orders', [Query.equal('venue_id', venue.$id), ...between, Query.limit(500)]),
    db.listDocuments(DB_ID, 'payments', [...between, Query.limit(500)]),
    db.listDocuments(DB_ID, 'shift_expenses', [...between, Query.limit(200)]),
    db.listDocuments(DB_ID, 'shifts', [Query.equal('venue_id', venue.$id), ...between, Query.limit(20)]),
    db.listDocuments(DB_ID, 'payment_methods', [Query.limit(50)]),
  ]);

  const paidOrders = orders.documents.filter((o) => o.payment_status === 'paid');
  const sales = paidOrders.reduce((s, o) => s + (o.total || 0), 0);
  const covers = paidOrders.reduce((s, o) => s + (o.guest_count || 1), 0);
  const tips = payments.documents.reduce((s, p) => s + (p.tip || 0), 0);
  const spend = expenses.documents.reduce((s, e) => s + (e.amount || 0), 0);
  const unpaid = orders.documents.filter(
    (o) => o.payment_status !== 'paid' && !['CANCELLED', 'REJECTED', 'SCHEDULED'].includes(o.status),
  );

  const byMethod = new Map();
  for (const p of payments.documents) {
    byMethod.set(p.method_id, (byMethod.get(p.method_id) || 0) + (p.amount || 0));
  }

  const variance = shifts.documents
    .filter((s) => s.status === 'closed')
    .reduce((sum, s) => {
      try {
        return sum + Object.values(JSON.parse(s.variance || '{}')).reduce((a, b) => a + b, 0);
      } catch {
        return sum;
      }
    }, 0);

  const section = (title, rows) =>
    rows.length
      ? `<h3 style="margin:20px 0 6px;font-size:15px">${title}</h3>
         <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.7">${rows.join('')}</ul>`
      : '';

  const html = shell(
    `${day} · takings`,
    `<table style="width:100%;border-collapse:collapse;font-size:15px">
       ${row('Sales', money(sales, settings))}
       ${row('Orders', String(paidOrders.length))}
       ${row('Covers', String(covers))}
       ${row('Average bill', money(paidOrders.length ? Math.round(sales / paidOrders.length) : 0, settings))}
       ${row('Tips', money(tips, settings))}
       ${row('Money paid out', money(spend, settings))}
       ${row('Shifts closed', String(shifts.documents.filter((s) => s.status === 'closed').length))}
       ${row(
         'Cash difference',
         variance === 0 ? 'Balanced' : `${variance > 0 ? '+' : ''}${money(variance, settings)}`,
         variance !== 0,
       )}
     </table>
     ${section(
       'Taken by',
       [...byMethod.entries()].map(
         ([id, amount]) =>
           `<li>${esc(methods.documents.find((m) => m.$id === id)?.name || 'Unknown')} — ${money(amount, settings)}</li>`,
       ),
     )}
     ${section(
       'Still unpaid at the end of the day',
       unpaid.map((o) => `<li>${esc(o.order_no)} — ${money(o.total, settings)}</li>`),
     )}
     ${
       unpaid.length
         ? '<p style="margin:14px 0 0;font-size:13px;color:#b54708">An order still unpaid after close is money that will not be chased tomorrow unless somebody writes it down tonight.</p>'
         : ''
     }`,
    settings.primary_color || '#0f766e',
  );

  const report = await db.createDocument(DB_ID, 'summary_reports', 'unique()', {
    venue_id: venue.$id,
    kind: 'daily_digest',
    period_start: start,
    period_end: end,
    payload: JSON.stringify({ day, sales, covers, tips, spend, variance, orders: paidOrders.length }),
    delivery_status: 'queued',
    delivered_to: to.join(', '),
  });

  if (!transport) {
    await db.updateDocument(DB_ID, 'summary_reports', report.$id, {
      delivery_status: 'failed',
      last_error: 'No SMTP configured',
    });
    error('Daily summary generated but SMTP is not configured.');
    return { ok: false, error: 'smtp' };
  }

  try {
    await transport.sendMail({
      from,
      to: to.join(','),
      subject: `${settings.restaurant_name} — ${day} · ${money(sales, settings)} taken`,
      html,
    });
    await db.updateDocument(DB_ID, 'summary_reports', report.$id, {
      delivery_status: 'sent',
      sent_at: new Date().toISOString(),
    });
    log(`Daily summary sent for ${day} to ${to.length}`);
    return { sent: to.length };
  } catch (e) {
    await db.updateDocument(DB_ID, 'summary_reports', report.$id, {
      delivery_status: 'failed',
      last_error: e.message,
    });
    error(`Daily summary failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
//  Backup
// ---------------------------------------------------------------------------

/** Excel is the target, so quote everything and neutralise formula prefixes. */
function csv(rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return '""';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@]/.test(s)) s = `\t${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

/** Every row of a collection, page by page — the default page size is 25. */
async function everything(db, DB_ID, collection) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 60; page++) {
    const queries = [Query.limit(100)];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const res = await db.listDocuments(DB_ID, collection, queries).catch(() => null);
    if (!res || res.documents.length === 0) break;
    out.push(...res.documents);
    if (res.documents.length < 100) break;
    cursor = res.documents[res.documents.length - 1].$id;
  }
  return out;
}

/**
 * What is worth being able to get back.
 *
 * Not the whole database: the menu can be retyped in an afternoon and the
 * settings in ten minutes. What cannot be reconstructed is what happened —
 * every order, every payment, every expense, every shift and every count. That
 * is what goes in the email.
 */
const BACKUP = [
  'orders', 'order_items', 'payments', 'shifts', 'shift_expenses', 'expense_items',
  'stock_movements', 'waste_log', 'ingredients', 'menu_items', 'categories',
  'staff_profiles', 'discounts', 'discount_redemptions', 'journal_entries', 'journal_lines',
  'audit_log', 'tables', 'venues', 'payment_methods',
];

/**
 * A copy of the records, emailed out every night.
 *
 * This plan has no backups of its own, and the admin app now has a button that
 * erases a period permanently. A restaurant should not be one mis-click or one
 * bad afternoon away from having no history at all, and an attachment sitting
 * in somebody's inbox is a real, boring, restorable copy.
 */
export async function nightlyBackup({ db, DB_ID, settings, transport, from, shell, log, error }) {
  const tz = settings.timezone || 'UTC';
  if (localHour(tz) !== Number(settings.daily_report_hour ?? 23)) return { skipped: 'not the hour' };

  const to = await recipientsFor(db, DB_ID, 'backup');
  if (to.length === 0) return { skipped: 'nobody subscribed to backups' };

  const day = localDay(tz);
  const venues = await db.listDocuments(DB_ID, 'venues', [Query.limit(5)]);
  const venue = venues.documents[0];
  if (!venue) return { skipped: 'no venue' };

  const already = await db
    .listDocuments(DB_ID, 'summary_reports', [
      Query.equal('kind', 'backup'),
      Query.orderDesc('$createdAt'),
      Query.limit(1),
    ])
    .catch(() => ({ documents: [] }));
  if (already.documents[0] && JSON.parse(already.documents[0].payload || '{}').day === day) {
    return { skipped: 'already backed up today' };
  }

  const attachments = [];
  const counts = {};
  let rowsTotal = 0;

  for (const collection of BACKUP) {
    const docs = await everything(db, DB_ID, collection);
    counts[collection] = docs.length;
    rowsTotal += docs.length;
    if (docs.length === 0) continue;

    // Every key any row uses, so a field only some rows carry is not lost.
    const headers = [...new Set(docs.flatMap((d) => Object.keys(d)))].filter(
      (k) => !k.startsWith('$') || k === '$id' || k === '$createdAt' || k === '$updatedAt',
    );
    attachments.push({
      filename: `${collection}.csv`,
      content: Buffer.from('﻿' + csv([headers, ...docs.map((d) => headers.map((h) => d[h]))]), 'utf8'),
      contentType: 'text/csv',
    });
  }

  const listed = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `<li>${esc(name)} — ${n}</li>`)
    .join('');

  const report = await db.createDocument(DB_ID, 'summary_reports', 'unique()', {
    venue_id: venue.$id,
    kind: 'backup',
    period_start: new Date(`${day}T00:00:00`).toISOString(),
    period_end: new Date().toISOString(),
    payload: JSON.stringify({ day, counts, rows: rowsTotal }).slice(0, 19000),
    delivery_status: 'queued',
    delivered_to: to.join(', '),
  });

  if (!transport) {
    await db.updateDocument(DB_ID, 'summary_reports', report.$id, {
      delivery_status: 'failed',
      last_error: 'No SMTP configured',
    });
    error('Backup built but SMTP is not configured.');
    return { ok: false, error: 'smtp' };
  }

  try {
    await transport.sendMail({
      from,
      to: to.join(','),
      subject: `${settings.restaurant_name} — backup ${day} (${rowsTotal} records)`,
      html: shell(
        `Backup · ${day}`,
        `<p style="margin:0 0 12px">A copy of everything the system holds, as spreadsheets. Keep the last one somewhere
          other than this inbox.</p>
         <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.6">${listed}</ul>
         <p style="margin:18px 0 0;color:#5d6b7a;font-size:13px">
           This is your only copy. The hosting plan keeps none, so if something is deleted by mistake, this email is
           what it comes back from.
         </p>`,
        settings.primary_color || '#0f766e',
      ),
      attachments,
    });
    await db.updateDocument(DB_ID, 'summary_reports', report.$id, {
      delivery_status: 'sent',
      sent_at: new Date().toISOString(),
    });
    log(`Backup sent for ${day}: ${rowsTotal} rows in ${attachments.length} files`);
    return { sent: to.length, rows: rowsTotal };
  } catch (e) {
    await db.updateDocument(DB_ID, 'summary_reports', report.$id, {
      delivery_status: 'failed',
      last_error: e.message,
    });
    error(`Backup failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}
