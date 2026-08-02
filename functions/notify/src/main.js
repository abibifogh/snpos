import { Client, Databases, Query } from 'node-appwrite';
import nodemailer from 'nodemailer';

/**
 * Sends receipts and shift summaries.
 *
 * Triggered by database events rather than run on a timer, so a receipt goes
 * out the moment a bill is marked paid and a summary the moment a shift is
 * closed — with nobody's browser involved.
 *
 * Events:
 *   databases.*.collections.orders.documents.*.update  → receipt
 *   databases.*.collections.shifts.documents.*.update  → shift summary
 */

const money = (minor, s) => {
  const d = s.currency_decimals ?? 2;
  const v = (minor / 10 ** d).toFixed(d);
  return s.symbol_position === 'after' ? `${v}${s.currency_symbol}` : `${s.currency_symbol}${v}`;
};

/** SMTP works with any provider. Absent config is reported, never guessed at. */
function mailer() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

const shell = (title, body, brand) => `<!doctype html>
<html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#16202b">
<div style="max-width:520px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e3e7ec">
<div style="background:${brand};color:#fff;padding:18px 22px"><h1 style="margin:0;font-size:19px">${title}</h1></div>
<div style="padding:22px">${body}</div>
</div></body></html>`;

const row = (label, value, bold = false) =>
  `<tr><td style="padding:5px 0;color:#5d6b7a">${label}</td>
   <td style="padding:5px 0;text-align:right;${bold ? 'font-weight:700;font-size:17px' : ''}">${value}</td></tr>`;

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const db = new Databases(client);
  const DB_ID = process.env.DB_ID || 'snpos';

  const events = (req.headers['x-appwrite-event'] || '').split(',');
  const doc = req.bodyJson ?? (req.body ? JSON.parse(req.body) : null);
  if (!doc) return res.json({ ok: true, skipped: 'no document' });

  const transport = mailer();
  const settings = await db.getDocument(DB_ID, 'settings', 'main');
  const from = `"${settings.email_from_name || settings.restaurant_name}" <${settings.email_from_address || process.env.SMTP_USER}>`;
  const brand = settings.primary_color || '#0f766e';

  const featureConfig = async (key, option, fallback) => {
    try {
      const rows = await db.listDocuments(DB_ID, 'feature_flags', [Query.equal('key', key), Query.limit(5)]);
      const flag = rows.documents.find((f) => !f.venue_id);
      if (!flag?.enabled) return null;
      return JSON.parse(flag.config || '{}')[option] ?? fallback;
    } catch {
      return fallback;
    }
  };

  try {
    // ---------------------------------------------------------- receipt
    if (events.some((e) => e.includes('collections.orders')) && doc.payment_status === 'paid') {
      const already = await db.listDocuments(DB_ID, 'receipts', [
        Query.equal('order_id', doc.$id),
        Query.limit(1),
      ]);
      // An update event fires on every edit; without this a customer would be
      // emailed their receipt again each time the order is touched.
      if (already.total > 0) return res.json({ ok: true, skipped: 'receipt already handled' });

      const delivery = await featureConfig('receipts', 'receipt_delivery', 'email');
      if (delivery === null) return res.json({ ok: true, skipped: 'receipts feature off' });

      if (!doc.customer_email) {
        await db.createDocument(DB_ID, 'receipts', 'unique()', {
          venue_id: doc.venue_id, order_id: doc.$id, channel: 'none',
          status: 'skipped', skip_reason: 'no_email', attempts: 0,
        });
        return res.json({ ok: true, skipped: 'no email given' });
      }

      const items = await db.listDocuments(DB_ID, 'order_items', [
        Query.equal('order_id', doc.$id), Query.limit(100),
      ]);

      const lines = items.documents
        .filter((i) => i.status !== 'void')
        .map((i) => row(`${i.qty}× ${i.name_snapshot}`, money(i.line_total, settings)))
        .join('');

      const totals =
        (doc.discount_total ? row('Discount', `−${money(doc.discount_total, settings)}`) : '') +
        (doc.service_total ? row('Service', money(doc.service_total, settings)) : '') +
        (doc.tax_total ? row(`Tax${settings.tax_inclusive ? ' (included)' : ''}`, money(doc.tax_total, settings)) : '') +
        row('Total', money(doc.total, settings), true);

      const html = shell(
        settings.restaurant_name,
        `<p style="margin:0 0 4px">Thank you — here is your receipt.</p>
         <p style="margin:0 0 16px;color:#5d6b7a;font-size:14px">Order ${doc.order_no} · ${new Date(doc.$createdAt).toLocaleString()}</p>
         <table style="width:100%;border-collapse:collapse;font-size:15px">${lines}
         <tr><td colspan="2" style="border-top:1px solid #e3e7ec;padding-top:8px"></td></tr>${totals}</table>
         <p style="margin:20px 0 0;color:#5d6b7a;font-size:13px">Paid in person. This is a record of your order, not a request for payment.</p>`,
        brand,
      );

      const receipt = await db.createDocument(DB_ID, 'receipts', 'unique()', {
        venue_id: doc.venue_id, order_id: doc.$id, channel: 'email',
        to_email: doc.customer_email, status: 'queued', attempts: 1,
        email_source: doc.email_source || 'staff_entered',
      });

      if (!transport) {
        await db.updateDocument(DB_ID, 'receipts', receipt.$id, {
          status: 'failed', last_error: 'No SMTP configured on the function.',
        });
        error('Receipt not sent: SMTP_HOST / SMTP_USER / SMTP_PASS are not set.');
        return res.json({ ok: false, error: 'smtp not configured' });
      }

      try {
        const info = await transport.sendMail({
          from, to: doc.customer_email,
          subject: `Your receipt from ${settings.restaurant_name} · ${doc.order_no}`,
          html,
        });
        await db.updateDocument(DB_ID, 'receipts', receipt.$id, {
          status: 'sent', sent_at: new Date().toISOString(), provider_ref: info.messageId || '',
        });
        log(`Receipt sent for ${doc.order_no}`);
      } catch (e) {
        await db.updateDocument(DB_ID, 'receipts', receipt.$id, { status: 'failed', last_error: e.message });
        error(`Receipt failed for ${doc.order_no}: ${e.message}`);
      }
      return res.json({ ok: true });
    }

    // ----------------------------------------------------- shift summary
    if (events.some((e) => e.includes('collections.shifts')) && doc.status === 'closed') {
      const already = await db.listDocuments(DB_ID, 'summary_reports', [
        Query.equal('shift_id', doc.$id), Query.limit(1),
      ]);
      if (already.total > 0) return res.json({ ok: true, skipped: 'summary already sent' });

      const threshold = await featureConfig('shift_summary', 'persistent_stock_threshold', 3);
      if (threshold === null) return res.json({ ok: true, skipped: 'summary feature off' });

      const [ingredients, waste, expenses, subs] = await Promise.all([
        db.listDocuments(DB_ID, 'ingredients', [Query.equal('venue_id', doc.venue_id), Query.limit(500)]),
        db.listDocuments(DB_ID, 'waste_log', [Query.equal('shift_id', doc.$id), Query.limit(100)]),
        db.listDocuments(DB_ID, 'shift_expenses', [Query.equal('shift_id', doc.$id), Query.limit(100)]),
        db.listDocuments(DB_ID, 'report_subscriptions', [Query.equal('active', true), Query.limit(50)]),
      ]);

      // The two stock sections, kept apart on purpose: a first-time flag is
      // routine restocking, the same item low for the fourth shift running is
      // a different problem wearing the same clothes.
      const low = ingredients.documents.filter((i) => i.active && (i.consecutive_low_count || 0) > 0);
      const fresh = low.filter((i) => (i.consecutive_low_count || 0) === 1);
      const persistent = low.filter((i) => (i.consecutive_low_count || 0) >= threshold);

      const variance = Object.values(JSON.parse(doc.variance || '{}')).reduce((a, b) => a + b, 0);
      const wasteValue = waste.documents.reduce((a, w) => a + (w.value || 0), 0);
      const expenseTotal = expenses.documents.reduce((a, e) => a + e.amount, 0);

      const section = (title, rows) =>
        rows.length
          ? `<h3 style="margin:20px 0 6px;font-size:15px">${title}</h3>
             <ul style="margin:0;padding-left:18px;color:#16202b;font-size:14px;line-height:1.7">${rows.join('')}</ul>`
          : '';

      const html = shell(
        `Shift ${doc.code} closed`,
        `<table style="width:100%;border-collapse:collapse;font-size:15px">
           ${row('Sales', money(doc.sales_total || 0, settings))}
           ${row('Covers', String(doc.covers || 0))}
           ${row('Discounts given', money(doc.discount_total || 0, settings))}
           ${row('Expenses', money(expenseTotal, settings))}
           ${row('Waste', money(wasteValue, settings))}
           ${row('Cash difference', variance === 0 ? 'Balanced' : `${variance > 0 ? '+' : ''}${money(variance, settings)}`, variance !== 0)}
         </table>
         ${section(
           'Stock flagged for the first time',
           fresh.map((i) => `<li>${i.name} — ${i.current_qty} ${i.unit} left</li>`),
         )}
         ${section(
           `Low for ${threshold} shifts or more`,
           persistent.map(
             (i) =>
               `<li><strong>${i.name}</strong> — ${i.consecutive_low_count} shifts running${
                 i.consecutive_low_since
                   ? `, since ${new Date(i.consecutive_low_since).toLocaleDateString()}`
                   : ''
               }</li>`,
           ),
         )}
         ${persistent.length ? '<p style="margin:14px 0 0;font-size:13px;color:#b54708">Items low this many shifts running are usually a supply problem or stock leaving unrecorded — worth a look rather than another reorder.</p>' : ''}`,
        brand,
      );

      const recipients = subs.documents
        .filter((s) => s.channel === 'email' && (s.events || []).includes('shift_close'))
        .map((s) => s.destination);

      const report = await db.createDocument(DB_ID, 'summary_reports', 'unique()', {
        venue_id: doc.venue_id, kind: 'shift_close', shift_id: doc.$id,
        period_start: doc.opened_at, period_end: doc.closed_at || new Date().toISOString(),
        payload: JSON.stringify({
          sales: doc.sales_total, covers: doc.covers, variance, waste: wasteValue, expenses: expenseTotal,
        }),
        new_stock_ids: fresh.map((i) => i.$id),
        persistent_stock_ids: persistent.map((i) => i.$id),
        delivery_status: 'queued',
        delivered_to: recipients.join(', '),
      });

      if (!transport || recipients.length === 0) {
        await db.updateDocument(DB_ID, 'summary_reports', report.$id, {
          delivery_status: 'failed',
          last_error: !transport ? 'No SMTP configured' : 'No recipients configured',
        });
        log(`Summary stored but not sent: ${!transport ? 'no SMTP' : 'no recipients'}`);
        return res.json({ ok: true, stored: true, sent: false });
      }

      try {
        await transport.sendMail({
          from, to: recipients.join(','),
          subject: `${settings.restaurant_name} — shift ${doc.code} closed`,
          html,
        });
        await db.updateDocument(DB_ID, 'summary_reports', report.$id, {
          delivery_status: 'sent', sent_at: new Date().toISOString(),
        });
        log(`Summary sent to ${recipients.length} recipient(s)`);
      } catch (e) {
        await db.updateDocument(DB_ID, 'summary_reports', report.$id, {
          delivery_status: 'failed', last_error: e.message,
        });
        error(`Summary failed: ${e.message}`);
      }
      return res.json({ ok: true });
    }

    return res.json({ ok: true, skipped: 'event not handled' });
  } catch (e) {
    error(`notify failed: ${e.message}`);
    return res.json({ ok: false, error: e.message }, 500);
  }
};
