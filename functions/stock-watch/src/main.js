import { Client, Databases, Query } from 'node-appwrite';
import nodemailer from 'nodemailer';

/**
 * Watches for dishes that have been off the menu too long.
 *
 * Taking something off mid-service is right and normal. Leaving it off for two
 * days is either a supply problem nobody escalated or a tap nobody remembered
 * to press, and both look identical from the kitchen — the only place the
 * difference shows is on a screen nobody is looking at.
 *
 * Runs hourly rather than every minute: this is a slow problem, and an hourly
 * check is enough to catch it while costing almost nothing.
 */

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

export default async ({ res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const db = new Databases(client);
  const DB_ID = process.env.DB_ID || 'snpos';

  const flags = await db.listDocuments(DB_ID, 'feature_flags', [
    Query.equal('key', 'item_availability'), Query.limit(5),
  ]);
  const flag = flags.documents.find((f) => !f.venue_id);
  if (!flag?.enabled) return res.json({ ok: true, skipped: 'feature off' });

  const config = JSON.parse(flag.config || '{}');
  const hours = Number(config.alert_after_hours ?? 24);
  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();

  // Still off, past the wait, and not yet mentioned. Told once: an admin who
  // has been told will act or decide not to, and repeating it hourly until
  // they do is how a warning turns into noise that gets filtered.
  const open = await db.listDocuments(DB_ID, 'item_availability', [
    Query.isNull('restored_at'),
    Query.isNull('alerted_at'),
    Query.lessThan('marked_off_at', cutoff),
    Query.limit(50),
  ]);

  if (open.total === 0) return res.json({ ok: true, nothing: true });

  const settings = await db.getDocument(DB_ID, 'settings', 'main');
  const transport = mailer();

  let to = String(config.alert_emails || '').split(/[,;\s]+/).filter(Boolean);
  if (to.length === 0) {
    const subs = await db.listDocuments(DB_ID, 'report_subscriptions', [
      Query.equal('active', true), Query.limit(50),
    ]).catch(() => ({ documents: [] }));
    to = subs.documents.map((x) => x.email).filter(Boolean);
  }

  if (!transport || to.length === 0) {
    error(`${open.total} items off over ${hours}h but ${!transport ? 'SMTP is not configured' : 'no recipients are set'}.`);
    return res.json({ ok: false, error: 'cannot send' });
  }

  const rows = open.documents
    .map((r) => {
      const hrsOff = Math.floor((Date.now() - new Date(r.marked_off_at).getTime()) / 3600_000);
      return `<li><strong>${r.name_snapshot}</strong> — off for ${hrsOff} hours${
        r.reason ? `, "${r.reason}"` : ''
      }${r.marked_off_name ? ` (${r.marked_off_name})` : ''}</li>`;
    })
    .join('');

  try {
    await transport.sendMail({
      from: `"${settings.email_from_name || settings.restaurant_name}" <${settings.email_from_address || process.env.SMTP_USER}>`,
      to: to.join(','),
      subject: `${open.total} ${open.total === 1 ? 'dish has' : 'dishes have'} been off the menu over ${hours} hours`,
      html: shell(
        'Still off the menu',
        `<p style="margin:0 0 12px">These were taken off during service and have not been put back:</p>
         <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.7">${rows}</ul>
         <p style="margin:18px 0 0;color:#5d6b7a;font-size:13px">
           Either the supply has not arrived, or somebody forgot to put them back. Both are worth a minute.
         </p>`,
        settings.primary_color || '#0f766e',
      ),
    });

    const now = new Date().toISOString();
    for (const r of open.documents) {
      await db.updateDocument(DB_ID, 'item_availability', r.$id, { alerted_at: now }).catch(() => undefined);
    }
    log(`Alerted about ${open.total} items off over ${hours}h.`);
    return res.json({ ok: true, alerted: open.total });
  } catch (e) {
    error(`Could not send the availability alert: ${e.message}`);
    return res.json({ ok: false, error: e.message });
  }
};
