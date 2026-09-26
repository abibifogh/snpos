import { Client, Databases, Query, Users } from 'node-appwrite';
import nodemailer from 'nodemailer';
import { receiptPdf } from './receipt-pdf.js';
import { bookingSittings, bookingSheetPdf } from './booking-sheet.js';
import { ordersForSide, shelfCheckSummary } from './shift-shape.js';
import { houseRecipients, sendToEach } from './house.js';
import { isApproval } from './booking-approval.js';
import { voucherPdf } from './voucher-pdf.js';
import {
  voucherHeadline, voucherValidity, voucherTerms, voucherCodeWords, voucherHasCode, voucherPrintProblem,
} from './voucher-words.js';
import { tradeWords, offSubject } from './words.js';
import { dailyDigest, nightlyBackup, deliveryFrom } from './daily.js';
import { ensureLogin, revokeLogin } from './staff.js';
import { handleReports } from './reports.js';
import { handleSso } from './sso.js';
import {
  fromBarChecks, fromShopCounts, fromExpenses, worthSending, approvalSubject, approvalBody,
  countLines, countSubject, countBody, countPlace,
} from './approvals.js';
import {
  postShiftClose, postSpend, postPayoutRow, postWasteRow, postBatchRow, postStaffChargeRow, postStaffSettleRow, sweepBooks,
} from './books-post.js';
import { nightlyReconcile } from './health-night.js';
import { send as pushSend } from './webpush.js';
import {
  overdueCounts, rowsToStamp, adminRecipients, overdueSubject, overduePush, overdueBody, OVERDUE_MS,
} from './overdue-counts.js';

/**
 * Everything that sends an email.
 *
 * Mostly event-driven, so a receipt goes out the moment a bill is marked paid
 * and a summary the moment a shift is closed, with nobody's browser involved.
 * It also runs hourly for the one thing no event can tell you: that something
 * has NOT happened.
 *
 * Events (a document arrives):
 *   orders.*.update          → group-order alert, accepted/ready notice, receipt
 *   shifts.*.update          → shift summary
 *   staff_profiles.*.create  → make their account, send a sign-in link
 *   staff_profiles.*.update  → keep their team in step, resend a link if asked
 *   staff_profiles.*.delete  → cancel that person's login
 *   item_availability.*.create → a dish has run out, tell an admin now
 *   approval_notices.*.create  → a count found a difference, tell an admin now
 *   push_subscriptions.*.create/update → a device turned notifications on, prove it works
 *   production_batches.*.create → a drink made here from another side's stock, on the books
 *   staff_charges.*.create     → a count difference charged to somebody, on the books
 *   staff_charge_settlements.*.create → paid, taken from pay, found or written off, on the books
 *   shifts.*.update            → the shift's takings, costs and drawer, on the books
 *   shift_expenses.*.create/update → the spend on the books, corrected, or reversed if refused
 *   consignor_payouts.*.create/update → the payout on the shop's books
 *   waste_log.*.create         → the write-off on the books
 *
 * Schedule, hourly (no document arrives):
 *   dishes still off the menu past the configured wait
 *   shifts left open longer than a day
 *   counts and spending waiting for an admin to agree to them
 *   anything closed, spent, paid or written off that the books have not got
 *   and, at two in the morning, the health check: records that do not add up
 *
 * The hourly sweep lives here rather than in a function of its own because
 * Appwrite's free plan allows four functions and this project has four. It
 * also belongs here: this is the file that knows how to send an email, and a
 * fifth function would have been a second copy of that knowledge.
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

/**
 * Somebody's own words, safe to drop into an email.
 *
 * A guest's note and an admin's "what changed" both end up inside HTML, and
 * both are typed by a person. An ampersand in a hotel's name is enough to
 * mangle the rest of a message without this.
 */
const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

/**
 * The page a guest opens to answer something about their booking.
 *
 * Empty where the site's address was never configured, so a caller can put a
 * sentence in place of a button rather than send a link to nowhere. One
 * builder, because two would drift and a guest following a stale link is a
 * guest who rings instead.
 */
const bookingLink = (booking) => {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  return base && booking?.$id ? `${base}/menu/?change=${booking.$id}` : '';
};

// Defaulted, because several callers pass two arguments and every one of them
// was rendering "background:undefined" behind the heading.
const shell = (title, body, brand = '#0f766e') => `<!doctype html>
<html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#16202b">
<div style="max-width:520px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e3e7ec">
<div style="background:${brand};color:#fff;padding:18px 22px"><h1 style="margin:0;font-size:19px">${title}</h1></div>
<div style="padding:22px">${body}</div>
</div></body></html>`;

const row = (label, value, bold = false) =>
  `<tr><td style="padding:5px 0;color:#5d6b7a">${label}</td>
   <td style="padding:5px 0;text-align:right;${bold ? 'font-weight:700;font-size:17px' : ''}">${value}</td></tr>`;


/**
 * What each side of the business is called in an email.
 *
 * Written once because the ternaries that did this were each written when
 * there were two sides, so the bar came out as "(bistro)" wherever one of them
 * had not been revisited.
 */
const SIDE_NAME = {
  kitchen: ' (bistro)',
  bar: ' (bar)',
  craft: ' (craft shop)',
};

/**
 * Who to tell about stock.
 *
 * The addresses typed into the feature's own box win. Otherwise it falls back
 * to the report recipients, the people who already get the shift summary are
 * the people who care that the chicken has run out.
 *
 * This used to read `x.email` from those rows. The field is called
 * `destination`, so the fallback quietly returned nobody: unless somebody had
 * filled in the feature box, every stock alert this system ever produced was
 * addressed to an empty list and reported as sent.
 */
async function alertRecipients({ db, DB_ID, configured }) {
  const explicit = String(configured || '').split(/[,;\s]+/).filter(Boolean);
  if (explicit.length) return explicit;

  const subs = await db
    .listDocuments(DB_ID, 'report_subscriptions', [
      Query.equal('channel', 'email'),
      Query.equal('active', true),
      Query.limit(100),
    ])
    .catch(() => ({ documents: [] }));

  const rows = subs.documents.filter((r) => r.destination);
  // Anybody who asked for stock alerts specifically; everybody on the list if
  // nobody did. Sending to the whole list is the recoverable mistake here, 
  // sending to nobody is the one that goes unnoticed for a month.
  const asked = rows.filter((r) => (r.events || []).includes('stock_alert'));
  return [...new Set((asked.length ? asked : rows).map((r) => r.destination))];
}

/**
 * Dishes still off the menu past the configured wait.
 *
 * Taking something off mid-service is right and normal. Leaving it off for two
 * days is either a supply problem nobody escalated or a tap nobody remembered
 * to press, and both look identical from the kitchen, the only place the
 * difference shows is a screen nobody is looking at.
 *
 * Each one is mentioned once. An admin who has been told will act or decide
 * not to; repeating it hourly until they do is how a warning becomes noise
 * that gets filtered.
 */
async function sweepUnavailable({ db, DB_ID, settings, transport, from, log, error }) {
  const flags = await db.listDocuments(DB_ID, 'feature_flags', [
    Query.equal('key', 'item_availability'), Query.limit(5),
  ]);
  const flag = flags.documents.find((f) => !f.venue_id);
  if (!flag?.enabled) return { skipped: 'feature off' };

  const config = JSON.parse(flag.config || '{}');
  const hours = Number(config.alert_after_hours ?? 24);
  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();

  const open = await db.listDocuments(DB_ID, 'item_availability', [
    Query.isNull('restored_at'),
    Query.isNull('alerted_at'),
    Query.lessThan('marked_off_at', cutoff),
    Query.limit(50),
  ]);
  if (open.total === 0) return { nothing: true };

  const to = await alertRecipients({ db, DB_ID, configured: config.alert_emails });

  if (!transport || to.length === 0) {
    error(`${open.total} dishes off over ${hours}h but ${!transport ? 'SMTP is not configured' : 'no recipients are set'}.`);
    return { ok: false, error: 'cannot send' };
  }

  const rows = open.documents
    .map((r) => {
      const off = Math.floor((Date.now() - new Date(r.marked_off_at).getTime()) / 3600_000);
      return `<li><strong>${r.name_snapshot}</strong>, off for ${off} hours${
        r.reason ? `, "${r.reason}"` : ''
      }${r.marked_off_name ? ` (${r.marked_off_name})` : ''}</li>`;
    })
    .join('');

  await transport.sendMail({
    /*
      The from-address, and no falling back to the login.

      On Resend that login is the literal word "resend"; on Brevo it is an
      account number. Either produces a From header that is not an address at
      all, and a provider handed one of those either refuses the message or
      takes it and drops it. The caller already refuses to do anything without
      a from-address — see the guard above — so this is the last place that
      still had an opinion of its own about what to use instead.
    */
    from,
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
  log(`Alerted about ${open.total} dishes off over ${hours}h.`);
  return { alerted: open.total };
}

/**
 * A count that found a difference, told about the moment it is filed.
 *
 * The hourly sweep below catches everything eventually, and eventually is the
 * wrong answer here: a bar that has come up short may be money missing, and
 * the person who counted it is still on the premises. This is the other end of
 * the same pair as the availability alert next door.
 *
 * One row arrives per COUNT rather than per line — see approval_notices for
 * why that had to be so — which is what makes an event safe to send on at all.
 */
async function noticeSent({ db, DB_ID, settings, transport, from, doc, log, error }) {
  if (doc.sent_at) return { already: true };
  if (doc.kind !== 'bar_count') return { skipped: doc.kind };

  const shiftId = doc.shift_id || doc.ref_id || '';
  const held = await db.listDocuments(DB_ID, 'shift_stock_checks', [
    Query.equal('shift_id', shiftId),
    Query.equal('phase', doc.phase || 'close'),
    Query.equal('applied', false),
    Query.limit(100),
  ]).catch(() => ({ documents: [] }));

  /*
    The rows decide what the email says, and the notice decides that there is
    one. If an admin has already dealt with the count in the seconds between
    filing and this running, there is nothing left to tell anybody about.
  */
  const shelfIds = [...new Set(held.documents.map((r) => r.ingredient_id).filter(Boolean))];
  const shelves = {};
  if (shelfIds.length > 0) {
    const rows = await db.listDocuments(DB_ID, 'ingredients', [
      Query.equal('$id', shelfIds), Query.limit(100),
    ]).catch(() => ({ documents: [] }));
    for (const r of rows.documents) shelves[r.$id] = r.name || '';
  }

  const lines = countLines(held.documents, shelves);
  if (lines.length === 0) return { nothing: true };

  let who = '';
  if (doc.counted_by) {
    const p = await db.getDocument(DB_ID, 'staff_profiles', doc.counted_by).catch(() => null);
    who = p?.display_name || '';
  }

  const to = await alertRecipients({ db, DB_ID, configured: '' });
  if (!transport || to.length === 0) {
    const why = !transport ? 'SMTP is not configured' : 'no recipients are set';
    error(`A bar count found ${lines.length} differences but ${why}.`);
    await db.updateDocument(DB_ID, 'approval_notices', doc.$id, { send_error: why }).catch(() => undefined);
    return { ok: false, error: why };
  }

  const shortValue = lines.reduce((sum, l) => sum + (l.variance < 0 ? l.value : 0), 0);
  // Whose shelf: the kitchen counts in on the same sheet as the bar. From the
  // rows, which say; rows from before they did are the bar's.
  const side = held.documents.find((r) => r.module)?.module || 'bar';
  await transport.sendMail({
    from,
    to: to.join(','),
    subject: countSubject({
      phase: doc.phase, lines: lines.length, shortValue, side, money: (n) => money(n, settings),
    }),
    html: shell(
      `A ${countPlace(side)} count needs your approval`,
      countBody({ lines, who, phase: doc.phase, side, money: (n) => money(n, settings) }),
      settings.primary_color || '#0f766e',
    ),
  });

  /*
    Stamped after it has gone, and the count's own rows stamped too.

    The second part is what keeps the hourly sweep quiet about a count it has
    already been told about — two emails for one count would teach somebody to
    ignore both.
  */
  const now = new Date().toISOString();
  await db.updateDocument(DB_ID, 'approval_notices', doc.$id, { sent_at: now, send_error: '' })
    .catch(() => undefined);
  for (const r of held.documents) {
    await db.updateDocument(DB_ID, 'shift_stock_checks', r.$id, { alerted_at: now }).catch(() => undefined);
  }

  log(`Told ${to.length} recipient(s) about ${lines.length} differences on a ${countPlace(side)} count.`);
  return { alerted: lines.length };
}

/**
 * Things waiting for an admin to agree to them.
 *
 * The system grew several of these one at a time, and each is right on its
 * own: a count that found a difference does not move the shelf until somebody
 * who can see the whole business agrees, because the person holding the
 * clipboard should not also sign it off. What none of them had was a way of
 * telling that admin. Each queue is a screen you have to remember to open, and
 * the failure is silent in the worst direction — a shelf that has not been
 * corrected reads as a shelf that is fine.
 *
 * One email, gathered, rather than one per row: a count of forty bottles with
 * six differences writes six rows in the same second. See approvals.js, where
 * that reasoning and the wording live and are tested.
 *
 * Said once. Each row is stamped when it has been mentioned; an admin who has
 * been told will act or decide not to, and repeating it hourly is how a
 * warning becomes noise that gets filtered.
 */
async function sweepApprovals({ db, DB_ID, settings, transport, from, log, error }) {
  const [checks, shopCounts, expenses] = await Promise.all([
    db.listDocuments(DB_ID, 'shift_stock_checks', [
      Query.equal('applied', false), Query.isNull('alerted_at'), Query.limit(200),
    ]).catch(() => ({ documents: [] })),
    db.listDocuments(DB_ID, 'stock_counts', [
      Query.equal('status', 'pending'), Query.isNull('alerted_at'), Query.limit(50),
    ]).catch(() => ({ documents: [] })),
    db.listDocuments(DB_ID, 'shift_expenses', [
      Query.equal('approval_status', 'pending'), Query.isNull('alerted_at'), Query.limit(50),
    ]).catch(() => ({ documents: [] })),
  ]);

  const raw = [...checks.documents, ...shopCounts.documents, ...expenses.documents];
  if (raw.length === 0) return { nothing: true };

  /*
    Names, so the email says who counted rather than an id.

    Read once for everybody mentioned rather than per row. A raw id in an email
    is worse than no name at all: it looks like data, so somebody tries to make
    sense of it.
  */
  const ids = [...new Set(raw.map((r) => r.checked_by || r.counted_by || r.created_by).filter(Boolean))];
  const names = {};
  if (ids.length > 0) {
    const staff = await db.listDocuments(DB_ID, 'staff_profiles', [
      Query.equal('$id', ids), Query.limit(100),
    ]).catch(() => ({ documents: [] }));
    for (const p of staff.documents) names[p.$id] = p.display_name || '';
  }

  const items = worthSending([
    ...fromBarChecks(checks.documents, names),
    ...fromShopCounts(shopCounts.documents, names),
    ...fromExpenses(expenses.documents, names),
  ]);
  if (items.length === 0) return { waiting: raw.length, tooFresh: true };

  const to = await alertRecipients({ db, DB_ID, configured: '' });
  if (!transport || to.length === 0) {
    error(`${items.length} things are waiting for approval but ${
      !transport ? 'SMTP is not configured' : 'no recipients are set'}.`);
    return { ok: false, error: 'cannot send' };
  }

  await transport.sendMail({
    from,
    to: to.join(','),
    subject: approvalSubject(items),
    html: shell(
      'Waiting for your approval',
      approvalBody(items, (n) => money(n, settings)),
      settings.primary_color || '#0f766e',
    ),
  });

  /*
    Stamped only after it has actually gone.

    The other order marks everything and then fails to send, which loses the
    one message this exists to deliver and loses it silently — the rows now
    look like rows somebody has already been told about.
  */
  const now = new Date().toISOString();
  let marked = 0;
  for (const [collection, rows] of [
    ['shift_stock_checks', checks.documents],
    ['stock_counts', shopCounts.documents],
    ['shift_expenses', expenses.documents],
  ]) {
    for (const r of rows) {
      const ok = await db.updateDocument(DB_ID, collection, r.$id, { alerted_at: now })
        .then(() => true)
        .catch(() => false);
      if (ok) marked += 1;
    }
  }
  if (marked < raw.length) {
    // Loud, because the consequence is an email every hour about the same
    // things until somebody notices. Almost always an un-provisioned database.
    error(`Told about ${items.length} approvals but could only mark ${marked} of ${raw.length} rows. `
      + 'Run Provision Appwrite so alerted_at exists, or this will repeat every hour.');
  }
  log(`Told ${to.length} recipient(s) about ${items.length} things waiting for approval.`);
  return { alerted: items.length };
}

/* ---------------------------------------------------------------- push */

/**
 * This server's push key pair, or null when there is none yet.
 *
 * Made once by provisioning. Null means Provision has not run since push was
 * added — said by the caller, never guessed around: signing with a key made
 * up here would produce messages no subscription accepts.
 */
async function loadPushKeys({ db, DB_ID }) {
  const row = await db.getDocument(DB_ID, 'push_keys', 'vapid').catch(() => null);
  return row?.public_key && row?.private_key
    ? { publicKey: row.public_key, privateKey: row.private_key }
    : null;
}

/** Who a push service reaches if this server misbehaves: the app, or the house mailbox. */
const pushSubject = (settings) => {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (base.startsWith('https://')) return base;
  return settings.email_from_address ? `mailto:${settings.email_from_address}` : undefined;
};

/**
 * Send one notification to every device of the given people.
 *
 * Each device on its own and each result kept: a subscription that has GONE
 * (the browser was reset, or the permission taken away) is deleted, because
 * it will never work again and would otherwise be tried first on every alert
 * for ever. One that merely FAILED is kept — a push service having a bad hour
 * is not a reason to make somebody turn notifications on again.
 */
async function pushToUsers({ db, DB_ID, settings, userIds, payload, keys, log, error }) {
  const out = { sent: 0, gone: 0, failed: 0, devices: 0 };
  if (!keys || userIds.length === 0) return out;

  const subs = await db.listDocuments(DB_ID, 'push_subscriptions', [
    Query.equal('user_id', userIds), Query.limit(100),
  ]).catch((e) => { error(`Could not read push subscriptions: ${e.message}`); return { documents: [] }; });

  /*
    Narrowed again here, not only in the query. What is sent is about the
    business's stock and money, and whether it reaches a phone that is not an
    admin's should not rest on one query being built correctly.
  */
  const mine = subs.documents.filter((s) => userIds.includes(s.user_id));
  out.devices = mine.length;
  for (const sub of mine) {
    const r = await pushSend({ subscription: sub, payload, keys, subject: pushSubject(settings) });
    out[r.outcome] += 1;
    if (r.outcome === 'gone') {
      await db.deleteDocument(DB_ID, 'push_subscriptions', sub.$id).catch(() => undefined);
      log(`Removed a device that no longer accepts notifications (${r.status}).`);
    } else {
      await db.updateDocument(DB_ID, 'push_subscriptions', sub.$id, r.outcome === 'sent'
        ? { last_sent_at: new Date().toISOString(), last_error: '' }
        : { last_error: `${r.status || 'network'}: ${r.detail || 'no reason given'}`.slice(0, 300) })
        .catch(() => undefined);
      if (r.outcome === 'failed') error(`Push to a device failed (${r.status}): ${r.detail || ''}`);
    }
  }
  return out;
}

/**
 * Stock counts that have held a difference for more than a day.
 *
 * The second word, after the one sent when the count was filed, and to the
 * admins specifically: agreeing or refusing a count is theirs to do. By email
 * and on every device an admin has turned notifications on for. See
 * overdue-counts.js for what is overdue, what is said and why a day.
 *
 * STAMPED ONLY ONCE SOMETHING GOT THROUGH. If neither the email nor a single
 * device took it, nothing is marked, and the next hour tries again — the
 * alternative is a count marked as escalated to nobody, which is exactly the
 * silence this exists to break.
 */
async function sweepOverdueCounts({ db, DB_ID, settings, transport, from, log, error }) {
  const cutoff = new Date(Date.now() - OVERDUE_MS).toISOString();
  const [checks, shopCounts, staff] = await Promise.all([
    db.listDocuments(DB_ID, 'shift_stock_checks', [
      Query.equal('applied', false),
      Query.isNull('overdue_alerted_at'),
      Query.lessThan('$createdAt', cutoff),
      Query.limit(500),
    ]).catch(() => ({ documents: [] })),
    db.listDocuments(DB_ID, 'stock_counts', [
      Query.equal('status', 'pending'), Query.isNull('overdue_alerted_at'), Query.limit(100),
    ]).catch(() => ({ documents: [] })),
    db.listDocuments(DB_ID, 'staff_profiles', [Query.limit(200)]).catch(() => ({ documents: [] })),
  ]);

  const names = {};
  for (const p of staff.documents) names[p.$id] = p.display_name || '';

  const items = overdueCounts({ checks: checks.documents, shopCounts: shopCounts.documents, names });
  if (items.length === 0) return { nothing: true };

  const admins = adminRecipients(staff.documents);
  const say = (n) => money(n, settings);

  /* ---- email: to the admins; to the count list only if no admin has an address */
  let emailed = false;
  let to = admins.emails;
  if (to.length === 0) {
    to = await alertRecipients({ db, DB_ID, configured: '' });
    if (to.length) log('No admin has an email address on their staff profile, so this went to the count alert list.');
  }
  if (transport && to.length > 0) {
    const base = (process.env.APP_URL || '').replace(/\/+$/, '');
    try {
      await transport.sendMail({
        from,
        to: to.join(','),
        subject: overdueSubject(items),
        html: shell(
          'Still waiting for your decision',
          overdueBody(items, say, Date.now(), base ? `${base}/admin/#/waiting?show=count` : ''),
          settings.primary_color || '#0f766e',
        ),
      });
      emailed = true;
    } catch (e) {
      error(`Overdue count email failed: ${e.message}`);
    }
  }

  /* ---- push: every device of every admin */
  const keys = await loadPushKeys({ db, DB_ID });
  if (!keys) log('No push key yet, so no devices were notified. Run Provision Appwrite once to make one.');
  const pushed = await pushToUsers({
    db, DB_ID, settings, userIds: admins.userIds, payload: overduePush(items, say), keys, log, error,
  });

  if (!emailed && pushed.sent === 0) {
    error(`${items.length} stock count(s) waiting over a day, but nobody could be told: `
      + `${!transport ? 'no SMTP' : to.length === 0 ? 'no recipients' : 'the email failed'}, and `
      + `${pushed.devices === 0 ? 'no admin device has notifications on' : `${pushed.devices} device(s) refused it`}.`
      + ' Trying again next hour.');
    return { ok: false, waiting: items.length };
  }

  const stamp = rowsToStamp(items, { checks: checks.documents, shopCounts: shopCounts.documents });
  const now = new Date().toISOString();
  let marked = 0;
  for (const [collection, ids] of [['shift_stock_checks', stamp.checks], ['stock_counts', stamp.shopCounts]]) {
    for (const id of ids) {
      const ok = await db.updateDocument(DB_ID, collection, id, { overdue_alerted_at: now })
        .then(() => true).catch(() => false);
      if (ok) marked += 1;
    }
  }
  const total = stamp.checks.length + stamp.shopCounts.length;
  if (marked < total) {
    error(`Escalated ${items.length} overdue count(s) but could only mark ${marked} of ${total} rows. `
      + 'Run Provision Appwrite so overdue_alerted_at exists, or this will repeat every hour.');
  }

  log(`Overdue counts: ${items.length}. Emailed: ${emailed ? to.length : 0}. `
    + `Devices: ${pushed.sent} sent, ${pushed.gone} gone, ${pushed.failed} failed.`);
  return { escalated: items.length, emailed, pushed };
}

/**
 * A device has just turned notifications on, or asked for a test.
 *
 * The first message a device gets is the proof the whole chain works — the
 * key, the subscription, the push service and the service worker that shows
 * it. Sent on the create, so pressing "Turn on" is answered by a notification
 * within seconds rather than by a wait for a count to go stale.
 *
 * Answered only while a test is actually asked for. The function's own write
 * back to the row is an update event too, and clearing the request is what
 * stops that update from sending a second message.
 */
async function answerDevice({ db, DB_ID, settings, doc, log, error }) {
  if (!doc?.test_requested_at) return { nothing: true };
  const keys = await loadPushKeys({ db, DB_ID });
  if (!keys) {
    const why = 'This server has no push key yet. Run Provision Appwrite once, then turn notifications on again.';
    await db.updateDocument(DB_ID, 'push_subscriptions', doc.$id, { test_requested_at: null, last_error: why })
      .catch(() => undefined);
    error(why);
    return { ok: false, error: why };
  }

  const r = await pushSend({
    subscription: doc,
    keys,
    subject: pushSubject(settings),
    payload: {
      title: 'Notifications are on',
      body: 'This device will be told when a stock count has waited more than a day for your decision.',
      url: '#/account',
      tag: 'push-test',
    },
  });

  if (r.outcome === 'gone') {
    await db.deleteDocument(DB_ID, 'push_subscriptions', doc.$id).catch(() => undefined);
  } else {
    await db.updateDocument(DB_ID, 'push_subscriptions', doc.$id, {
      test_requested_at: null,
      ...(r.outcome === 'sent'
        ? { last_sent_at: new Date().toISOString(), last_error: '' }
        : { last_error: `${r.status || 'network'}: ${r.detail || 'no reason given'}`.slice(0, 300) }),
    }).catch(() => undefined);
  }
  (r.outcome === 'sent' ? log : error)(`Test notification: ${r.outcome} (${r.status}).`);
  return { outcome: r.outcome };
}

/**
 * Shifts that have been open longer than a day.
 *
 * The till itself refuses to take money against one past the limit, so the
 * money is safe. What it cannot do is find the person: whoever left it open
 * has gone home, and the next cashier arrives to a counter that will not sell
 * and no idea why. This tells a manager, who can close it.
 *
 * Nothing is closed here. Closing a shift means writing down what was counted
 * in the drawer, and a program that has never seen the drawer would be
 * inventing that figure, which is worse than a shift left open.
 *
 * Alerted on the hour it crosses the limit, then once a day after that. There
 * is nowhere on a shift to record that it has been mentioned, and adding a
 * column for it would be a schema change for a nag; the hourly clock is enough
 * to keep this from becoming noise.
 */
async function sweepStaleShifts({ db, DB_ID, settings, transport, from, shell, log, error }) {
  const LIMIT_HOURS = 24;

  const open = await db.listDocuments(DB_ID, 'shifts', [
    Query.equal('status', 'open'),
    Query.limit(50),
  ]);

  const stale = open.documents
    .map((s) => ({ shift: s, hours: (Date.now() - new Date(s.opened_at).getTime()) / 3_600_000 }))
    .filter(({ hours }) => hours >= LIMIT_HOURS)
    // On the hour it passes a day, then the same hour each day after. Anything
    // else and a shift nobody closes sends twenty four emails a day.
    .filter(({ hours }) => (hours - LIMIT_HOURS) % 24 < 1);

  if (stale.length === 0) return { nothing: true };

  const to = await alertRecipients({ db, DB_ID });
  if (!transport || to.length === 0) {
    error(`${stale.length} shift(s) open over ${LIMIT_HOURS}h but ${!transport ? 'SMTP is not configured' : 'no recipients are set'}.`);
    return { ok: false, error: 'cannot send' };
  }

  const rows = stale
    .map(({ shift, hours }) =>
      `<li><strong>${shift.code}</strong>, open for ${Math.floor(hours)} hours` +
      `${SIDE_NAME[shift.module || 'kitchen'] || SIDE_NAME.kitchen}</li>`)
    .join('');

  await transport.sendMail({
    from,
    to: to.join(','),
    subject: `${stale.length} shift${stale.length === 1 ? '' : 's'} left open over a day`,
    html: shell(
      'A shift is still open',
      `<p style="margin:0 0 12px">These have been open longer than ${LIMIT_HOURS} hours:</p>
       <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.7">${rows}</ul>
       <p style="margin:18px 0 0;color:#5d6b7a;font-size:13px">
         The kitchen carries on cooking and taking money. Anything that came in after the day was up
         belongs to the night before, so count the drawer, close it and open a fresh one; whatever is
         still unpaid moves across. Nothing has been closed automatically, because that would record a
         cash count nobody made.
       </p>`,
      settings.primary_color || '#0f766e',
    ),
  });

  log(`Alerted about ${stale.length} shift(s) open over ${LIMIT_HOURS}h.`);
  return { alerted: stale.length };
}

/**
 * Everything flagged, in one table, colour-coded.
 *
 * This used to be two lists, "flagged for the first time" and "low for three
 * shifts or more", built as `count === 1` and `count >= threshold`. Nothing
 * rendered the middle. An ingredient on its SECOND consecutive shift appeared
 * in neither, so an item a cook marked OUT last night could vanish from the
 * email entirely, and the shift it went missing was the shift somebody most
 * needed to see it.
 *
 * Neither list said whether an item was low or out, either. The quantity was
 * there and the severity was not, which is the wrong way round: "0 kg left"
 * needs reading, "Out" does not.
 *
 * Colour carries the urgency and a word carries the meaning. Every mail client
 * strips something, several of them strip background colours, and a table that
 * says nothing once the colour is gone is a table that says nothing.
 */
const STOCK_TONES = {
  // Third state first: an item low for three shifts running is a different
  // problem from an item low tonight, whichever of low or out it currently is.
  persistent: { bg: '#e8f1fc', bar: '#1c5cab', label: 'Keeps running out' },
  out:        { bg: '#fdeceb', bar: '#b42318', label: 'Out' },
  low:        { bg: '#fff6e0', bar: '#b26a00', label: 'Low' },
};

function stockTable(items, threshold, settings) {
  if (items.length === 0) return '';

  const rows = items
    .map((i) => {
      const runs = i.consecutive_low_count || 1;
      // last_low_severity is what the cook actually reported. Falling back to
      // the quantity covers a row written before that field existed.
      const severity = i.last_low_severity || (Number(i.current_qty) > 0 ? 'low' : 'out');
      const tone = runs >= threshold ? STOCK_TONES.persistent : STOCK_TONES[severity] || STOCK_TONES.low;

      // Print the quantity only when it backs up what was reported.
      //
      // A cook tapping LOW does not change the running figure, that only moves
      // when a recipe depletes it or somebody counts. So the book can happily
      // say "12 kg" on a row the kitchen has just flagged as low, and printing
      // it there makes the alert look like a mistake and teaches people to
      // ignore the table. A dash says what is true: nobody counted this one.
      const lowAt = i.low_threshold ?? (Number(i.par_level || 0) * (settings?.low_stock_default_bp ?? 3000)) / 10000;
      const onHand = Number(i.current_qty ?? 0);
      const agrees = severity === 'out' ? onHand <= 0 : onHand <= lowAt;
      const qty = agrees ? `${onHand}${i.unit ? ` ${i.unit}` : ''}` : ', ';

      return `<tr style="background:${tone.bg}">
        <td style="padding:9px 10px;border-left:4px solid ${tone.bar};font-weight:600">${i.name}</td>
        <td style="padding:9px 10px;white-space:nowrap">
          ${severity === 'out' ? '<strong>Out</strong>' : 'Low'}
          ${runs >= threshold ? `<span style="color:#1c5cab;font-weight:600"> · ${runs} shifts running</span>` : ''}
        </td>
        <td style="padding:9px 10px;text-align:right;white-space:nowrap;color:#5d6b7a">${qty}</td>
      </tr>`;
    })
    .join('');

  return `<h3 style="margin:22px 0 8px;font-size:15px">Stock (${items.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead>
        <tr style="color:#5d6b7a;font-size:12px;text-transform:uppercase;letter-spacing:0.04em">
          <th style="text-align:left;padding:0 10px 6px">Item</th>
          <th style="text-align:left;padding:0 10px 6px">State</th>
          <th style="text-align:right;padding:0 10px 6px">Left</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin:10px 0 0;font-size:12px;color:#5d6b7a">
      <span style="background:${STOCK_TONES.low.bg};border-left:3px solid ${STOCK_TONES.low.bar};padding:2px 6px">Low</span>
      <span style="background:${STOCK_TONES.out.bg};border-left:3px solid ${STOCK_TONES.out.bar};padding:2px 6px;margin-left:6px">Out</span>
      <span style="background:${STOCK_TONES.persistent.bg};border-left:3px solid ${STOCK_TONES.persistent.bar};padding:2px 6px;margin-left:6px">${threshold}+ shifts running</span>
    </p>`;
}

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const db = new Databases(client);
  const DB_ID = process.env.DB_ID || 'snpos';

  const events = (req.headers['x-appwrite-event'] || '').split(',').filter(Boolean);

  /**
   * Somebody arriving from the group hub already signed in.
   *
   * First, alongside the reporting API and for the same reason: a request from
   * the outside world must not be able to fall through into anything that
   * sends email or reads the whole database. Returns null when the request is
   * not for it, and has already answered when it is.
   *
   * It lives in this function rather than one of its own because the plan
   * allows four functions and this project has four — the same arithmetic that
   * put the hourly sweep and the reporting API here.
   */
  const handedOver = await handleSso({ req, res, users: new Users(client), log, error });
  if (handedOver) return handedOver;

  /**
   * The reporting API, before anything else happens.
   *
   * First on purpose. Everything below this line either sends email or reads
   * the whole database on a timer, and a request from the outside world must
   * not be able to reach any of it by accident. This returns null when the
   * request is not for the API, and has already answered when it is not.
   */
  const reported = await handleReports({ req, res, db, DB_ID, log, error });
  if (reported) return reported;

  /**
   * What kind of invocation this is, according to Appwrite rather than
   * according to a guess.
   *
   * The hourly sweep used to be "there is no document", which was true while
   * the only ways in were an event and the timer. Opening an HTTP door makes
   * it false: an empty POST from anywhere would have looked exactly like the
   * timer and started sending email. So the trigger is read directly, and an
   * unrecognised request does nothing at all.
   */
  const trigger = String(req.headers['x-appwrite-trigger'] || '').toLowerCase();

  /**
   * An HTTP request that got past both doors is knocking on neither.
   *
   * Everything below this line is an event or the timer. The sweep already
   * refused an HTTP call with no body; a call *with* a body used to fall
   * straight through to the event handling, which was only safe while nothing
   * outside could invoke this function at all.
   *
   * Accepting a hand-off from the group hub means it can be — the person
   * following that link has no account here yet by definition, so the function
   * has to answer to `any`. So the case is now closed rather than assumed: two
   * paths are for the outside world, both have already answered, and anything
   * else arriving over HTTP gets a 404 before a database is read or an email
   * is composed.
   */
  if (trigger === 'http') {
    return res.json({ ok: false, error: 'Nothing to do.' }, 404);
  }

  const doc = req.bodyJson ?? (req.body ? JSON.parse(req.body) : null);

  const transport = mailer();
  const settings = await db.getDocument(DB_ID, 'settings', 'main');

  /*
    A DEVICE TURNING NOTIFICATIONS ON, before the email check below.

    It sends no email, so a business that has not finished setting up its
    mail should not find that its phones cannot be told anything either. The
    two are independent channels and the second must not wait on the first.
  */
  if (trigger === 'event' && events.some((e) => e.includes('collections.push_subscriptions'))) {
    try {
      return res.json(await answerDevice({ db, DB_ID, settings, doc, log, error }));
    } catch (e) {
      error(`Device test failed: ${e.message}`);
      return res.json({ ok: false, error: e.message });
    }
  }
  // No silent fallback to SMTP_USER. On Brevo that login is something like
  // 9a1b2c001@smtp-brevo.com, never a verified sender, so falling back to it
  // produces mail the provider accepts and then drops, which looks like
  // success everywhere except the customer's inbox.
  /*
    REFUSED, not warned about and then sent anyway.

    This used to log a complaint and carry on with SMTP_USER, which on Resend
    or Brevo is a login rather than a verified sender — so the provider took
    the message, dropped it, and every screen in this system reported success.
    Mail that vanishes silently is the worst failure this function can have,
    because nobody goes looking for it: the staff profile saved, no error
    appeared, and the invitation simply never existed.

    Stopping here instead means the function's log says exactly one thing, in
    words somebody can act on, and the admin screen shows the send as failed
    rather than as done.
  */
  if (!settings.email_from_address) {
    const why = 'No from-address is set, so nothing can be sent. Set it under Admin, Settings, Email — it has '
      + 'to be an address the mail provider has verified for your domain, such as pos@yourdomain.com.';
    error(why);
    return res.json({ ok: false, error: why }, 500);
  }
  const from = `"${settings.email_from_name || settings.restaurant_name}" <${settings.email_from_address}>`;
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

  /**
   * Everyone here who should hear about a group, worked out one way.
   *
   * Three messages need this list — a booking, a change asked for, a booking
   * called off — and each used to build it for itself. All three could come
   * out empty, and all three did: the guest got every confirmation and nobody
   * here got anything, because `email` is optional on a staff profile and the
   * script that creates the first admin never wrote one. See house.js, which
   * now also reads the address off the sign-in account when the profile has
   * none, so nothing has to be edited for this to start working.
   */
  const houseList = async () => houseRecipients({
    db,
    users: new Users(client),
    DB_ID,
    Query,
    configured: await featureConfig('group_orders', 'notify_emails', ''),
    fallback: settings.email_from_address,
    log,
  });

  /**
   * Everything a booking notice needs saying about a booking, built once.
   *
   * Both the notice sent when a booking arrives and the one an admin asks for
   * again read the same booking and describe it the same way. Two copies of
   * this would agree today and drift the first time one was edited, and the
   * drift would be invisible: a resent notice that quietly says less than the
   * original is worse than no resend at all.
   */
  const bookingFacts = async (booking) => {
    const money = (n) => `${booking.currency_code || ''}${((n || 0) / 100).toFixed(2)}`;
    const when = (iso) => {
      const d = new Date(iso);
      return Number.isFinite(d.getTime()) ? d.toLocaleString() : '';
    };
    const label = await featureConfig('group_orders', 'reservation_label', 'Reservation');
    const spread = booking.first_at === booking.last_at
      ? when(booking.first_at)
      : `${when(booking.first_at)} to ${when(booking.last_at)}`;

    const facts = `<table style="width:100%;border-collapse:collapse;font-size:15px">
         ${row('Booked by', booking.contact_name || '-')}
         ${row(label, booking.reference || '-')}
         ${row('People', String(booking.size || '-'))}
         ${row('Sittings', `${booking.sittings || 0} · ${booking.portions || 0} portions`)}
         ${row('When', spread)}
         ${row('Orders', booking.order_nos || '-')}
         ${row('Total', money(booking.total))}
       </table>`;

    /*
      What the party said about the booking as a whole, in their own words.

      Its own block rather than a table row: "the coach leaves at two, so we
      cannot run late" is a sentence, and a sentence in a value column is a
      sentence nobody reads. Headed differently for the two readers, because
      quoting somebody's own note back at them as "they said" is strange.
    */
    const saidIt = String(booking.note || '').trim();
    const noteBlock = (heading) => (saidIt
      ? `<p style="margin:14px 0 4px;font-weight:600">${heading}</p>
         <p style="margin:0;padding:2px 0 2px 12px;border-left:3px solid ${brand};white-space:pre-wrap">${
           saidIt.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>`
      : '');

    return { facts, noteBlock, label };
  };

  /**
   * Tell the house about a booking, one recipient at a time.
   *
   * ONE MESSAGE EACH, not one message addressed to everybody. Sending to a
   * joined list is all-or-nothing at the provider: one address it dislikes
   * and the whole thing is refused, so every other person loses a message
   * because of somebody else's typo. See sendToEach.
   *
   * Used by the notice a booking sends when it arrives and by the one an
   * admin asks for again, so a resend is the same message and reaches the
   * same people by the same rules.
   */
  const tellTheHouse = async (booking, { again = false } = {}) => {
    const { facts, noteBlock, label } = await bookingFacts(booking);
    const house = await houseList();
    log(`Group booking ${booking.$id}: ${house.why}`);
    if (!transport) return { ...house, sent: [], failed: [], why: 'No SMTP is configured on the function.' };
    if (house.to.length === 0) return { ...house, sent: [], failed: [] };

    const sheet = await bookingSheet(label);
    const outcome = await sendToEach({
      to: house.to,
      log,
      send: (address) => transport.sendMail({
        from,
        to: address,
        subject: `${again ? 'Group booking (sent again)' : 'Group booking'} · ${
          booking.contact_name || 'a party'}${booking.size ? ` · ${booking.size} people` : ''}`,
        html: shell(
          again ? 'A group booked — sending this again' : 'A group has booked',
          (again
            ? '<p style="margin:0 0 10px;color:#5d6b7a;font-size:14px">Asked for again from Admin. The booking '
              + 'itself has not changed.</p>'
            : '')
          + facts + noteBlock('They also said') + (sheet
            ? `<p style="margin:16px 0 0;color:#5d6b7a;font-size:14px">Attached is the full sheet: every
               sitting, every choice, everything left out, the notes in the guests' own words, and what each
               plate is suitable for. Print it for the pass.</p>`
            : ''),
        ),
        attachments: sheet,
      }),
    });
    return { ...house, ...outcome };
  };

  /**
   * The booking sheet, as a real PDF, for whichever email is going out.
   *
   * An email body can hold a summary and no more: sittings, portions, a
   * total. What a party of forty actually consists of — every dish, every
   * choice ticked, everything left out, the notes in the guests' own words
   * and what each plate is then suitable for — is a document, and the kitchen
   * needs it on paper by the pass. See booking-sheet.js.
   *
   * Undefined on any failure, never a throw. A booking notice that arrives
   * without its attachment is worth far more than one that never arrives
   * because building a PDF went wrong.
   */
  const bookingSheet = async (label) => {
    if (!doc?.$id) return undefined;
    try {
      const [sittings, venue] = await Promise.all([
        bookingSittings({ db, DB_ID, Query, booking: doc }),
        db.getDocument(DB_ID, 'venues', doc.venue_id).catch(() => null),
      ]);
      if (sittings.length === 0) {
        error(`Booking ${doc.$id} has no orders to write a sheet from.`);
        return undefined;
      }
      const stem = String(doc.reference || doc.contact_name || doc.$id)
        .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'booking';
      return [{
        filename: `group-booking-${stem}.pdf`,
        // The builder returns bytes so the same one can run in a browser;
        // nodemailer wants a Buffer, and this is the only place that cares.
        content: Buffer.from(bookingSheetPdf({
          settings, venue, booking: doc, sittings, label, accent: brand,
        })),
        contentType: 'application/pdf',
      }];
    } catch (e) {
      error(`Group booking sheet failed for ${doc.$id}, sending without it: ${e.message}`);
      return undefined;
    }
  };

  // ---------------------------------------------- hourly sweep (no document)
  // Nothing arrived, so this is the timer. The only thing worth checking on a
  // clock is the absence of an event: a dish taken off the menu that nobody
  // has put back.
  if (!doc && trigger !== 'event') {
    // Only the clock runs the sweep. Anything else that reaches here without a
    // document is somebody knocking on a door that is not for them.
    if (trigger && trigger !== 'schedule') {
      return res.json({ ok: false, error: 'Nothing to do.' }, 400);
    }
    const results = {};
    // Each is tried on its own. A failing backup must not stop the daily
    // summary going out, and neither must stop the availability sweep, three
    // unrelated jobs sharing a timer because the plan allows four functions.
    for (const [name, job] of [
      // First, because the others read what it writes: a daily digest that
      // runs before the books are filled reports a night that is not there.
      ['books', () => sweepBooks({ db, DB_ID, Query, log })],
      ['availability', () => sweepUnavailable({ db, DB_ID, settings, transport, from, log, error })],
      ['stale_shifts', () => sweepStaleShifts({ db, DB_ID, settings, transport, from, shell, log, error })],
      ['approvals', () => sweepApprovals({ db, DB_ID, settings, transport, from, log, error })],
      // After the first word, so a count filed an hour ago is never escalated
      // before it has been announced. See overdue-counts.js.
      ['overdue_counts', () => sweepOverdueCounts({ db, DB_ID, settings, transport, from, log, error })],
      ['daily', () => dailyDigest({ db, DB_ID, settings, transport, from, shell, row, money, log, error })],
      ['backup', () => nightlyBackup({ db, DB_ID, settings, transport, from, shell, log, error })],
      // Last, after the books have been swept: what is still wrong once everything that can be filled has been.
      ['health', () => nightlyReconcile({ db, DB_ID, settings, transport, from, shell, log, error })],
    ]) {
      try {
        results[name] = await job();
      } catch (e) {
        error(`${name} sweep failed: ${e.message}`);
        results[name] = { ok: false, error: e.message };
      }
    }
    return res.json({ ok: true, ...results });
  }

  try {
    // ------------------------------------------------ staff member removed
    // Nothing to email; this one takes an access away rather than sending
    // anything. It lives here because the plan allows four functions and a
    // fifth would exist only to hold twenty lines.
    if (events.some((e) => e.includes('collections.staff_profiles'))) {
      const gone = events.some((e) => e.endsWith('.delete'));
      return res.json(
        gone
          ? await revokeLogin({ client, db, DB_ID, doc, log, error })
          : await ensureLogin({ client, db, DB_ID, doc, settings, transport, from, shell, log, error }),
      );
    }

    // ------------------------------------------------ the books, from events
    // A spend, a payout or a write-off is posted from its own row, the
    // moment Appwrite says the row exists or changed. The browser that wrote
    // the row does not write the books; see books-post.js for why.
    const books = { db, DB_ID, Query, log };
    if (events.some((e) => e.includes('collections.shift_expenses'))) {
      return res.json(await postSpend(books, doc));
    }
    if (events.some((e) => e.includes('collections.consignor_payouts'))) {
      return res.json(await postPayoutRow(books, doc));
    }
    if (events.some((e) => e.includes('collections.waste_log'))) {
      return res.json(await postWasteRow(books, doc));
    }
    // A batch made here from another side's stock moves value between
    // inventories. See postBatchRow.
    if (events.some((e) => e.includes('collections.production_batches'))) {
      return res.json(await postBatchRow(books, doc));
    }
    // Checked before staff_charges: that name is the start of this one.
    if (events.some((e) => e.includes('collections.staff_charge_settlements'))) {
      return res.json(await postStaffSettleRow(books, doc));
    }
    if (events.some((e) => e.includes('collections.staff_charges.'))) {
      return res.json(await postStaffChargeRow(books, doc));
    }

    // -------------------------------------------------- a dish has run out
    // Sent the moment it happens, not on the hourly sweep.
    //
    // The sweep exists for the opposite problem, something that has been off
    // for two days and nobody noticed. This is the other end: a dish going off
    // during service is a buying decision somebody may still be able to act on
    // within the hour, and by the time an hourly job runs, the trip to the
    // market has been missed.
    // ------------------------------------- a count found a difference
    // Sent the moment it is filed, for the same reason as the dish above: an
    // hour late is the wrong answer when money may be missing and the person
    // who counted it has not gone home yet.
    if (events.some((e) => e.includes('collections.approval_notices'))
      && events.some((e) => e.endsWith('.create'))) {
      return res.json(await noticeSent({ db, DB_ID, settings, transport, from, doc, log, error }));
    }

    /*
      A VOUCHER ON ITS WAY TO A CUSTOMER.

      Asked for on the Vouchers page as a row per address — never one row
      carrying a list, because a message addressed to several people is
      all-or-nothing at the provider and one bad address would lose it for
      everybody. Each row is sent on its own and records what happened to it,
      so the screen can say which ones arrived rather than "it went".

      The slip is built by the same generator Admin downloads from, so what
      lands in an inbox is the voucher that page showed. See voucher-pdf.js.
    */
    if (events.some((e) => e.includes('collections.voucher_sends'))
        && events.some((e) => e.endsWith('.create'))) {
      const fail = async (why) => {
        error(`Voucher to ${doc.to_email} not sent: ${why}`);
        await db.updateDocument(DB_ID, 'voucher_sends', doc.$id, {
          status: 'failed', last_error: String(why).slice(0, 500),
        }).catch(() => undefined);
        return res.json({ sent: false, why });
      };

      if (!transport) return fail('no SMTP is configured on the function');

      const v = await db.getDocument(DB_ID, 'discounts', doc.discount_id).catch(() => null);
      if (!v) return fail('that voucher no longer exists');

      /*
        Checked again here, not only on the page that asked.

        A voucher can end, be switched off or be used up between somebody
        pressing send and the job reaching the row — and a voucher that would
        be refused at the till is worse than no voucher: the customer finds out
        at the counter, and somebody here has to explain it.
      */
      const unusable = voucherPrintProblem(v);
      if (unusable) return fail(unusable);

      const cash = (n) => money(n, settings);
      const day = (iso) => new Date(iso).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
      });

      let slip;
      try {
        slip = [{
          filename: `voucher-${String(v.code || v.name || v.$id).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase() || 'voucher'}.pdf`,
          content: Buffer.from(voucherPdf({
            settings,
            venue: null,
            vouchers: [v],
            accent: brand,
            headline: (x) => voucherHeadline(x, cash),
            validity: (x) => voucherValidity(x, day),
            terms: (x) => voucherTerms(x, cash),
            codeWords: voucherCodeWords,
            hasCode: voucherHasCode,
          })),
          contentType: 'application/pdf',
        }];
      } catch (e) {
        return fail(`the voucher could not be drawn: ${e.message}`);
      }

      const headline = voucherHeadline(v, cash);
      const hello = doc.to_name ? `Hello ${esc(doc.to_name)},` : 'Hello,';
      const gone = await transport.sendMail({
        from,
        to: doc.to_email,
        subject: `${headline} at ${settings.restaurant_name || 'our place'}`,
        html: shell(
          `${headline} — with our compliments`,
          `<p style="margin:0 0 10px">${hello}</p>
           <p style="margin:0 0 12px">Here is a voucher for <strong>${esc(v.name)}</strong>. It is attached,
           and you can show it on your phone — there is no need to print it.</p>`
          + (voucherHasCode(v)
            ? `<p style="margin:0 0 12px;padding:12px;background:#f4f6f8;border-radius:6px;text-align:center">
               <span style="color:#66727f;font-size:12px">USE THIS CODE</span><br>
               <strong style="font-size:22px;letter-spacing:2px">${esc(voucherCodeWords(v))}</strong></p>`
            : '<p style="margin:0 0 12px">Just mention it to a member of staff.</p>')
          + `<p style="margin:0 0 6px;color:#5d6b7a;font-size:14px"><strong>${esc(voucherValidity(v, day))}</strong></p>`
          + `<p style="margin:10px 0 0;color:#5d6b7a;font-size:13px">${
            voucherTerms(v, cash).map((t) => esc(t)).join('<br>')}</p>`,
          brand,
        ),
        attachments: slip,
      }).then(() => true).catch((e) => {
        error(`Voucher to ${doc.to_email} was refused: ${e.message}`);
        return e.message;
      });

      if (gone !== true) return fail(gone);

      await db.updateDocument(DB_ID, 'voucher_sends', doc.$id, {
        status: 'sent', sent_at: new Date().toISOString(), last_error: '',
      }).catch(() => undefined);
      log(`Voucher ${v.code || v.name} sent to ${doc.to_email}.`);
      return res.json({ sent: true, to: doc.to_email });
    }

    if (events.some((e) => e.includes('collections.item_availability')) && events.some((e) => e.endsWith('.create'))) {
      const configured = await featureConfig('item_availability', 'alert_emails', '');
      if (configured === null) return res.json({ sent: false, why: 'feature off' });
      const to = await alertRecipients({ db, DB_ID, configured });
      if (!transport || to.length === 0) {
        error(`${doc.name_snapshot} is unavailable but ${!transport ? 'SMTP is not configured' : 'no recipients are set'}.`);
        return res.json({ sent: false, why: 'nowhere to send it' });
      }
      const when = new Date(doc.marked_off_at || Date.now()).toLocaleString('en-GB', {
        timeZone: settings.timezone || 'UTC', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short',
      });
      /*
        Whose catalogue this came from, so the email talks about the right
        trade.

        A shop counter was emailed "Off the menu: Luggage strap" and told the
        kitchen screen would stop showing it. Somebody reading that reasonably
        concludes the system has acted on the wrong record, and stops trusting
        the next message too.

        One extra read, and only when an alert is actually being sent.
      */
      const soldItem = await db.getDocument(DB_ID, 'menu_items', doc.menu_item_id).catch(() => null);
      const w = tradeWords(soldItem?.module);
      await transport.sendMail({
        from,
        to: to.join(','),
        subject: offSubject(doc.name_snapshot, soldItem?.module),
        html: shell(
          w.ranOut,
          `<p style="margin:0 0 14px;font-size:17px"><strong>${doc.name_snapshot}</strong> has been taken ${w.off}.</p>
           <table style="width:100%;border-collapse:collapse;font-size:14px">
             ${row('Taken off by', doc.marked_off_name || 'a member of staff')}
             ${row('At', when)}
             ${doc.reason ? row('Reason', doc.reason) : ''}
           </table>
           <p style="margin:18px 0 0;color:#5d6b7a;font-size:13px">
             ${w.consequence.replace('them', 'it').replace('they will', 'it will')} It stays off until somebody
             puts it back.
           </p>`,
          brand,
        ),
      });
      log(`Run-out alert sent for ${doc.name_snapshot}.`);
      return res.json({ sent: true, item: doc.name_snapshot });
    }

    /*
      A group booking, once — not once per sitting.

      This used to hang off the ORDERS, so a hotel booking four sittings sent
      four "a group has ordered" emails, each describing a quarter of the
      arrangement. Four messages for one thing is the shape that teaches
      somebody to make a filter rule, and then the fifth one matters and
      nobody sees it.

      It hangs off the booking now, which is written last by the form once
      every sitting has landed. One booking, one message — and the same
      message goes to the person who booked, because a party of forty arranged
      three weeks ahead has nothing else to hold.
    */
    if (events.some((e) => e.includes('collections.group_bookings'))
        && events.some((e) => e.endsWith('.create'))) {
      const already = await db.listDocuments(DB_ID, 'order_notices', [
        Query.equal('order_id', doc.$id),
        Query.equal('stage', 'group_placed'),
        Query.limit(1),
      ]).catch(() => ({ total: 0 }));
      if (already.total > 0) return res.json({ already: true });

      /*
        Whoever runs the place, plus anybody named by hand.

        Admins by default rather than by configuration: a group booking is a
        planning decision and the person who has to make it is the person who
        owns the business. The configured list is added, not substituted, so
        naming an events address does not quietly stop the owner hearing.
      */
      const { facts, noteBlock, label } = await bookingFacts(doc);
      const sheet = await bookingSheet(label);

      /*
        The record, and afterwards what actually happened to it.

        It used to be written once as "queued" and never touched again, so a
        notice refused by the mail provider sat in the database looking
        exactly like one that arrived. The only account of the failure was a
        line in the function's log, which is not somewhere anybody looks — and
        "the admins did not get the email" is then a report with nothing to
        check it against.
      */
      const told = await tellTheHouse(doc);
      const houseTo = told.to;

      const notice = await db.createDocument(DB_ID, 'order_notices', 'unique()', {
        venue_id: doc.venue_id,
        order_id: doc.$id,
        stage: 'group_placed',
        // The column holds 160 characters; a long admin list must not lose
        // the whole row, which is what happened before it was cut.
        to_email: [...houseTo, doc.email].filter(Boolean).join(',').slice(0, 160),
        status: transport ? 'queued' : 'failed',
        last_error: transport ? '' : 'No SMTP configured on the function.',
      }).catch((e) => {
        error(`Could not record the group booking notice: ${e.message}`);
        return null;
      });

      /** What went wrong, in the words somebody would need to act on it. */
      const wrong = [];
      if (!houseTo.length) {
        log(told.why);
        wrong.push(told.why);
      }
      for (const f of told.failed) wrong.push(`${f.address} refused it: ${f.why}`);

      const settle = async () => {
        if (!notice) return;
        await db.updateDocument(DB_ID, 'order_notices', notice.$id, {
          status: wrong.length ? 'failed' : 'sent',
          last_error: wrong.join(' ').slice(0, 500),
        }).catch(() => undefined);
      };

      if (!transport) {
        log('A group booked, but no SMTP is configured on the function, so nobody was told.');
        return res.json({ sent: false, reason: 'no smtp' });
      }

      if (doc.email) {
        await transport.sendMail({
          from,
          to: doc.email,
          subject: `Your group booking${doc.reference ? ` · ${doc.reference}` : ''}`,
          html: shell(
            'Your booking is with us',
            `<p style="margin:0 0 10px">Thank you for your group order. Our bistro will check your order and
             revert. As soon as it is approved you will be emailed.</p>
             <p style="margin:0 0 10px">Here is the whole booking, so you have it on the day.</p>
             ${facts}
             ${noteBlock('Your note to us')}
             ${sheet
               ? `<p style="margin:14px 0 0;color:#5d6b7a;font-size:14px">The attached sheet lists every sitting
                  in full — each dish, the choices made, anything left out, your notes, and what each plate is
                  suitable for. Please check it and tell us if anything is wrong.</p>`
               : ''}
             <p style="margin:14px 0 0;color:#5d6b7a;font-size:14px">Each sitting reaches the kitchen in time to
             cook it and not before.</p>
             ${bookingLink(doc)
               ? `<p style="margin:14px 0 0"><a href="${bookingLink(doc)}"
                    style="color:#0f766e;font-weight:600">Need to change something?</a></p>`
               : '<p style="margin:14px 0 0;color:#5d6b7a;font-size:14px">If anything needs to change, ring us.</p>'}`,
          ),
          attachments: sheet,
        }).catch((e) => {
          error(`Group confirmation to the guest failed: ${e.message}`);
          wrong.push(`The confirmation to ${doc.email} was refused: ${e.message}`);
        });
      }

      await settle();
      return res.json({
        sent: wrong.length === 0,
        booking: doc.$id,
        to: houseTo.length + (doc.email ? 1 : 0),
        ...(wrong.length ? { problems: wrong } : {}),
      });
    }

    /*
      A booking agreed to, or turned down.

      The decision and the telling are one act: this watches the collection
      the decision is written to, so there is no way to approve a booking and
      not tell the party, and no way to tell them something that was not
      decided.
    */
    if (events.some((e) => e.includes('collections.group_bookings'))
        && events.some((e) => e.endsWith('.update'))) {
      /*
        SOMEBODY ASKING FOR THE NOTICE AGAIN, first of all.

        The first notice can fail, and did: a bad address in the staff list, a
        provider refusing one message, a manager added to the team after the
        booking came in. Until now there was no second chance — the message
        went once, to whoever it happened to reach, and a party of forty could
        be in the diary with nobody here having heard of it. The only fix was
        to go and look for a booking nobody could see.

        Handled before the decision branches below because it is not a
        decision: the booking has not changed, somebody simply wants telling
        again. The request is CLEARED first, so a failure cannot leave a field
        set that fires this every time the row is touched afterwards.
      */
      if (doc.notice_resend_at) {
        await db.updateDocument(DB_ID, 'group_bookings', doc.$id, { notice_resend_at: null })
          .catch((e) => error(`Could not clear the resend request on ${doc.$id}: ${e.message}`));

        if (!transport) {
          log(`Asked to send booking ${doc.$id} again, but no SMTP is configured.`);
          return res.json({ sent: false, reason: 'no smtp' });
        }

        const again = await tellTheHouse(doc, { again: true });

        /*
          AND THE PARTY, because a resend is usually a revision.

          The first notice went to both. A booking is sent again either
          because nobody here got it, or because something on it changed —
          and in the second case the guest is holding a sheet that is now
          wrong. Sending them the current one costs nothing and is the whole
          point of "the revised orders, by email, like the first".

          Its own send rather than another address on the house's message: it
          says something different, and a guest must never be shown who else
          was told.
        */
        let toGuest = null;
        if (doc.email) {
          const { facts, noteBlock, label } = await bookingFacts(doc);
          const sheet = await bookingSheet(label);
          toGuest = await transport.sendMail({
            from,
            to: doc.email,
            subject: `Your group booking, updated${doc.reference ? ` · ${doc.reference}` : ''}`,
            html: shell(
              'Your booking, as it stands now',
              `<p style="margin:0 0 10px">Here is your booking as we have it today. If anything on it has
               changed since you last heard from us, this is the version the kitchen is working to.</p>
               ${facts}
               ${noteBlock('Your note to us')}
               ${sheet
                 ? `<p style="margin:14px 0 0;color:#5d6b7a;font-size:14px">The attached sheet lists every
                    sitting in full — each dish, the choices made, anything left out, your notes, and what
                    each plate is suitable for. Please check it and tell us if anything is wrong.</p>`
                 : ''}`,
            ),
            attachments: sheet,
          }).then(() => true).catch((e) => {
            error(`Updated booking to the guest failed: ${e.message}`);
            return false;
          });
        }
        await db.createDocument(DB_ID, 'order_notices', 'unique()', {
          venue_id: doc.venue_id,
          order_id: doc.$id,
          stage: 'group_placed',
          to_email: again.to.join(',').slice(0, 160),
          status: again.failed.length || again.to.length === 0 ? 'failed' : 'sent',
          last_error: (again.to.length === 0 ? again.why : again.failed.map((f) => `${f.address}: ${f.why}`).join('; ')).slice(0, 500),
        }).catch(() => undefined);

        log(`Booking ${doc.$id} sent again: ${again.why}${
          toGuest === null ? '' : ` Guest: ${toGuest ? 'told' : 'refused'}.`}`);
        return res.json({
          sent: again.sent.length > 0 || toGuest === true,
          resent: true,
          to: again.sent,
          failed: again.failed,
          guest: toGuest,
        });
      }

      /*
        A REVISION GOING TO THE PARTY TO BE AGREED TO.

        A booking changed here is no longer the thing the party has a copy of.
        They are holding a sheet that is now wrong, and until they say
        otherwise nobody knows whether the change is what they asked for or
        merely what somebody here typed. A party of forty arriving to find
        Thursday lunch became Thursday dinner without their agreeing to it is
        a worse failure than the change never having been made.

        The request is CLEARED FIRST, like the resend above it, so a failure
        cannot leave a field set that fires this every time the row is touched
        afterwards. The stamp that says the party is waiting is written only
        once the email has actually gone: a row reading "waiting on the party"
        about a message that never left sends somebody to chase a guest who
        was never written to.
      */
      if (doc.approval_send_at) {
        await db.updateDocument(DB_ID, 'group_bookings', doc.$id, { approval_send_at: null })
          .catch((e) => error(`Could not clear the approval request on ${doc.$id}: ${e.message}`));

        if (!transport) {
          log(`Asked to send booking ${doc.$id} for approval, but no SMTP is configured.`);
          return res.json({ sent: false, reason: 'no smtp' });
        }
        if (!doc.email) {
          error(`Booking ${doc.$id} has no address to send a revision to.`);
          return res.json({ sent: false, reason: 'no address' });
        }

        const { facts, noteBlock, label } = await bookingFacts(doc);
        const sheet = await bookingSheet(label);
        const said = String(doc.approval_note || '').trim();

        const gone = await transport.sendMail({
          from,
          to: doc.email,
          subject: `Please check your group booking${doc.reference ? ` · ${doc.reference}` : ''}`,
          html: shell(
            'We have changed your booking — please check it',
            `<p style="margin:0 0 10px">We have made a change to your booking. Nothing is settled until you
             tell us it is right, so please look it over and let us know.</p>`
            + (said
              ? `<p style="margin:0 0 12px;padding:10px 12px;background:#fff7ed;border-radius:6px">
                 <strong>What changed:</strong> ${esc(said)}</p>`
              : '')
            + facts
            + noteBlock('Your note to us')
            + (sheet
              ? `<p style="margin:14px 0 0;color:#5d6b7a;font-size:14px">The attached sheet lists every
                 sitting in full — each dish, the choices made, anything left out, your notes, and what each
                 plate is suitable for. This is what the kitchen will cook from once you agree to it.</p>`
              : '')
            + (bookingLink(doc)
              ? `<p style="margin:18px 0 0"><a href="${bookingLink(doc)}" style="background:${brand};color:#fff;
                 padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">
                 Check it and tell us</a></p>
                 <p style="margin:10px 0 0;color:#5d6b7a;font-size:13px">If anything is wrong, the same page
                 lets you ask us to change it again.</p>`
              : `<p style="margin:18px 0 0;color:#5d6b7a;font-size:14px">Please reply to this email to tell us
                 whether it is right.</p>`),
          ),
          attachments: sheet,
        }).then(() => true).catch((e) => {
          error(`Approval request to the guest failed: ${e.message}`);
          return false;
        });

        /*
          Stamped only on success, which is what makes the status honest: it
          records that the party WAS ASKED, not that somebody here pressed a
          button. A failure leaves the booking where it was, and the button can
          be pressed again.
        */
        if (gone) {
          await db.updateDocument(DB_ID, 'group_bookings', doc.$id, {
            approval_requested_at: new Date().toISOString(),
          }).catch((e) => error(`Could not stamp the approval request on ${doc.$id}: ${e.message}`));
        }

        await db.createDocument(DB_ID, 'order_notices', 'unique()', {
          venue_id: doc.venue_id,
          order_id: doc.$id,
          stage: 'group_placed',
          to_email: String(doc.email).slice(0, 160),
          status: gone ? 'sent' : 'failed',
          last_error: gone ? '' : 'The revision could not be sent to the party.',
        }).catch(() => undefined);

        log(`Booking ${doc.$id} sent for approval: ${gone ? 'gone' : 'refused'}.`);
        return res.json({ sent: gone, approvalRequested: true, to: gone ? [doc.email] : [] });
      }

      /*
        A booking called off, which the HOUSE has to hear about above all.

        Written by order-guard once the last sitting has actually gone, so
        this fires once for the booking rather than once per sitting. Nobody
        was told at all before: the party pressed cancel, the sittings
        disappeared from the Orders page, and the only way anybody here found
        out was by noticing their absence.

        The house first, because a table held and a shop still to do are
        theirs; the party second, as a receipt for what they asked for.
      */
      if (doc.status === 'cancelled') {
        if (!transport) {
          log(`Booking ${doc.$id} was cancelled but no SMTP is configured, so nobody was told.`);
          return res.json({ sent: false });
        }
        const called = await houseList();
        const tell = called.to;
        log(`Booking ${doc.$id} cancelled: ${called.why}`);

        const when = (iso) => {
          const d = new Date(iso);
          return Number.isFinite(d.getTime()) ? d.toLocaleString() : '';
        };
        const gone = `<table style="width:100%;border-collapse:collapse;font-size:15px">
             ${row('Booked by', doc.contact_name || '-')}
             ${row('Reference', doc.reference || '-')}
             ${row('Was for', when(doc.first_at) || '-')}
             ${row('Sittings', `${doc.sittings || 0} · ${doc.portions || 0} portions`)}
             ${row('Orders', doc.order_nos || '-')}
             ${row('Was worth', `${doc.currency_code || ''}${((doc.total || 0) / 100).toFixed(2)}`)}
           </table>`;

        if (tell.length) {
          await transport.sendMail({
            from,
            to: tell.join(','),
            subject: `Group booking CANCELLED · ${doc.contact_name || doc.reference || 'a party'}`,
            html: shell(
              'A group has cancelled',
              `<p style="margin:0 0 10px">This booking is off. Every sitting under it has been cancelled and
               the kitchen's list no longer has them.</p>
               ${gone}
               <p style="margin:14px 0 0;color:#5d6b7a;font-size:14px">Anything held for them — a room, a
               table, a shop already done — is yours to release.</p>`,
            ),
          }).catch((e) => error(`Cancellation notice to the house failed: ${e.message}`));
        }

        if (doc.email) {
          await transport.sendMail({
            from,
            to: doc.email,
            subject: `Your group booking is cancelled${doc.reference ? ` · ${doc.reference}` : ''}`,
            html: shell(
              'Your booking is cancelled',
              `<p style="margin:0 0 10px">That is done — every sitting under this booking has been cancelled
               and nothing will be cooked. Nothing is owed.</p>
               ${gone}
               <p style="margin:14px 0 0;color:#5d6b7a;font-size:14px">If this was a mistake, please send us an
               email. It cannot be undone from the link.</p>`,
            ),
          }).catch((e) => error(`Cancellation notice to the guest failed: ${e.message}`));
        }

        log(`Booking ${doc.$id} cancelled; told ${tell.length + (doc.email ? 1 : 0)}`);
        return res.json({ sent: true, booking: doc.$id, status: 'cancelled' });
      }

      if (doc.status !== 'approved' && doc.status !== 'refused') return res.json({ ok: true, skipped: 'still waiting' });
      if (!doc.email) {
        log(`Booking ${doc.$id} was ${doc.status} but carries no email address, so nobody was told.`);
        return res.json({ sent: false });
      }
      if (!transport) {
        log(`Booking ${doc.$id} was ${doc.status} but no SMTP is configured, so the group was not told.`);
        return res.json({ sent: false });
      }

      const said = String(doc.decided_note || '').replace(/[<>&]/g, (c) => (
        { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
      const yes = doc.status === 'approved';
      // The confirmed sheet, so the party holds the same document the kitchen
      // is working to. Only on a yes: attaching a full menu to "we cannot
      // take this booking" would be a strange thing to receive.
      const agreed = yes
        ? await bookingSheet(await featureConfig('group_orders', 'reservation_label', 'Reservation'))
        : undefined;
      await transport.sendMail({
        from,
        to: doc.email,
        subject: yes
          ? `Your group booking is confirmed${doc.reference ? ` · ${doc.reference}` : ''}`
          : `About your group booking${doc.reference ? ` · ${doc.reference}` : ''}`,
        html: shell(
          yes ? 'Your booking is confirmed' : 'We cannot take this booking',
          yes
            ? `<p style="margin:0 0 10px">Good news — we have your booking and the kitchen has it in hand.
               ${doc.sittings || 0} sitting${doc.sittings === 1 ? '' : 's'}, ${doc.portions || 0} portions.</p>
               ${said ? `<p style="margin:0 0 10px">${said}</p>` : ''}
               ${agreed
                 ? `<p style="margin:0 0 10px;color:#5d6b7a;font-size:14px">The attached sheet is what the
                    kitchen is working to — every sitting, every choice and every dietary note.</p>`
                 : ''}
               <p style="margin:0;color:#5d6b7a;font-size:14px">Orders ${doc.order_nos || ''}. Nothing is owed
               until the day.</p>`
            : `<p style="margin:0 0 10px">We are sorry — we are not able to take this booking.</p>
               ${said ? `<p style="margin:0 0 10px">${said}</p>` : ''}
               <p style="margin:0;color:#5d6b7a;font-size:14px">Please ring us if you would like to talk about
               another date.</p>`,
        ),
        attachments: agreed,
      }).catch((e) => error(`Booking decision notice failed: ${e.message}`));

      return res.json({ sent: true, booking: doc.$id, status: doc.status });
    }

    /*
      A group asking for something to be changed.

      Straight to the people who can decide, because the alternative is a
      telephone call to whoever picks up, written on whatever is nearest. It
      is a REQUEST — nothing has changed, and the email says so, so nobody
      reads it as a done thing and stops looking.
    */
    if (events.some((e) => e.includes('collections.booking_changes'))) {
      /*
        THE PARTY AGREEING TO A REVISION, which is an answer rather than a
        request and is handled first.

        It arrives here because a guest cannot write to a booking row and
        should not be able to: a link that could edit a booking is a link that
        could empty a pass. So the answer comes in as a message, and this —
        which holds a server key — is what stamps the booking. That stamp is
        the only thing a browser can read to know where a revision has got to.

        Told to the house as its own message. "They have agreed" is the end of
        something somebody here started and has been waiting on; folding it in
        with the change requests would bury the one message that closes a loop
        among the ones that open them.
      */
      if (isApproval(doc)) {
        await db.updateDocument(DB_ID, 'group_bookings', doc.booking_id, {
          approval_given_at: new Date().toISOString(),
        }).catch((e) => error(`Could not stamp the approval on ${doc.booking_id}: ${e.message}`));

        /*
          Settled as it is read, because it is not waiting on anybody.

          Left open it would sit on the Waiting for you page as a job to do,
          and the job is done: the party agreed, and there is nothing for
          anybody here to decide.
        */
        await db.updateDocument(DB_ID, 'booking_changes', doc.$id, {
          status: 'done',
          decided_at: new Date().toISOString(),
        }).catch(() => undefined);

        const house = await houseList();
        log(`Booking ${doc.booking_id} agreed to by the party: ${house.why}`);
        if (!transport || house.to.length === 0) {
          return res.json({ sent: false, approved: true, reason: !transport ? 'no smtp' : house.why });
        }

        const said = String(doc.note || '').trim();
        const outcome = await sendToEach({
          to: house.to,
          log,
          send: (address) => transport.sendMail({
            from,
            to: address,
            subject: `Group booking agreed · ${doc.contact_name || doc.reference || doc.booking_id}`,
            html: shell(
              'The party has agreed to the revised booking',
              `<table style="width:100%;border-collapse:collapse;font-size:15px">
                 ${row('Booked by', doc.contact_name || '-')}
                 ${row('Reference', doc.reference || '-')}
                 ${row('First sitting', doc.first_at ? new Date(doc.first_at).toLocaleString() : '-')}
               </table>
               <p style="margin:14px 0 0">They have agreed to the booking as it now stands. The kitchen can
               work to the revised sheet.</p>`
              + (said
                ? `<p style="margin:14px 0 4px;font-weight:600">They also said</p>
                   <p style="margin:0;white-space:pre-wrap">${esc(said)}</p>`
                : ''),
              brand,
            ),
          }),
        });

        return res.json({ sent: outcome.sent.length > 0, approved: true, to: outcome.sent, failed: outcome.failed });
      }

      /*
        The same list as every other message to the house.

        This built its own, from the same two ingredients, and came out empty
        for the same reason: a change request reached nobody at all while the
        guest who asked for it was told their request had gone in. See
        house.js — the fallback and the account lookup apply here too, because
        a change asked for and not seen is a party arriving to the wrong food.
      */
      const asked = await houseList();
      const to = asked.to;
      log(`Change asked for on booking ${doc.booking_id}: ${asked.why}`);

      if (!transport || !to.length) {
        log(`A group asked for a change to booking ${doc.booking_id}, but ${
          !transport ? 'no SMTP is configured' : asked.why}, so nobody was told by email. `
          + 'It is on the Waiting for you page.');
        return res.json({ sent: false });
      }

      const KINDS = {
        numbers: 'How many people', timing: 'A day or a time', food: 'What was ordered',
        dietary: 'Something somebody cannot eat', cancel: 'Cancel all or part of it', other: 'Something else',
      };
      await transport.sendMail({
        from,
        to: to.join(','),
        subject: `Group booking change asked for · ${doc.contact_name || doc.reference || doc.booking_id}`,
        html: shell(
          'A group has asked for a change',
          `<table style="width:100%;border-collapse:collapse;font-size:15px">
             ${row('Booked by', doc.contact_name || '-')}
             ${row('Reference', doc.reference || '-')}
             ${row('About', KINDS[doc.kind] || doc.kind)}
             ${row('First sitting', doc.first_at ? new Date(doc.first_at).toLocaleString() : '-')}
           </table>
           <p style="margin:14px 0 4px;font-weight:600">What they asked for</p>
           <p style="margin:0;white-space:pre-wrap">${String(doc.note || '')
             .replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>
           <p style="margin:14px 0 0;color:#5d6b7a;font-size:14px">Nothing has changed. The kitchen is still
           working to what was ordered. Decide it on the Waiting for you page${
             doc.email ? `, and they are expecting an answer at ${doc.email}` : ''}.</p>`,
        ),
      }).catch((e) => error(`Change request notice failed: ${e.message}`));

      return res.json({ sent: true, change: doc.$id, to: to.length });
    }

    // ------------------------------------------------- order progress
    // Two moments a customer actually wants to hear about: somebody has taken
    // the order, and the food is ready. Sent before the receipt block because
    // an order can be accepted and paid in the same breath at a counter, and
    // "your food is ready" is worth more to them than arriving second.
    if (events.some((e) => e.includes('collections.orders'))) {
      const stage = doc.status === 'ACCEPTED' ? 'accepted' : doc.status === 'READY' ? 'ready' : null;

      /**
       * Every reason for not sending is said out loud.
       *
       * All of these used to be silence. An owner asking "why did my customer
       * not hear that their food was ready" had nowhere to look: the function
       * ran, decided not to send, and logged nothing, so the only way to find
       * out was to read this file. Three lines of logging turn that into one
       * glance at the executions list.
       */
      if (stage && !doc.customer_email) {
        log(
          `No ${stage} notice for ${doc.order_no}: the order has no customer email. `
          + 'Guests are asked for one only when the Receipts feature is on, and it is optional to them.',
        );
      }

      if (stage && doc.customer_email) {
        const wanted = await featureConfig('receipts', `notify_on_${stage}`, true);
        if (wanted === null) {
          log(
            `No ${stage} notice for ${doc.order_no}: the Receipts feature is switched off, which is what `
            + 'these notices hang from. Turn it on under Features to send them.',
          );
        } else if (wanted === false) {
          log(`No ${stage} notice for ${doc.order_no}: notify_on_${stage} is switched off under Features.`);
        } else {
          // One notification per stage per order. The update event fires on
          // every edit, and a customer told four times that their food is
          // ready stops reading anything we send.
          const already = await db.listDocuments(DB_ID, 'order_notices', [
            Query.equal('order_id', doc.$id),
            Query.equal('stage', stage),
            Query.limit(1),
          ]).catch(() => ({ total: 0 }));

          if (already.total > 0) {
            log(`No ${stage} notice for ${doc.order_no}: one has already been sent.`);
          }
          if (already.total === 0) {
            await db.createDocument(DB_ID, 'order_notices', 'unique()', {
              venue_id: doc.venue_id, order_id: doc.$id, stage,
              to_email: doc.customer_email, status: transport ? 'queued' : 'failed',
              last_error: transport ? '' : 'No SMTP configured on the function.',
            }).catch(() => undefined);

            if (transport) {
              const isGroup = !!doc.group_reference;
              // Where to come for it, in words. Absent for a table order, and
              // absent rather than wrong if the point has since been deleted.
              const collectAt = doc.pickup_point_id
                ? await db
                    .getDocument(DB_ID, 'pickup_points', doc.pickup_point_id)
                    .then((p) => p.name || '')
                    .catch(() => '')
                : '';
              const body =
                stage === 'accepted'
                  ? `<p style="margin:0 0 10px">We have your order. The kitchen will start on it shortly.</p>
                     <p style="margin:0;color:#5d6b7a;font-size:14px">Order ${doc.order_no}${
                       // Capped on the way out too. Mirrors MAX_ETA_MINUTES in
                       // packages/core/src/orders.ts, a row written before the
                       // cap existed must not put "about 95 minutes" in an
                       // email, where it cannot be corrected afterwards.
                       doc.eta_minutes > 0 ? ` · about ${Math.min(60, Math.round(doc.eta_minutes))} minutes` : ''
                     }</p>`
                  : `<p style="margin:0 0 10px">Your order is ready.</p>
                     <p style="margin:0;color:#5d6b7a;font-size:14px">Order ${doc.order_no}${
                       // Looked up by name. This read doc.pickup_point, which
                       // is not a column on an order, so the line never
                       // appeared; and the column that does exist holds an id,
                       // which is not something to put in front of a customer.
                       collectAt ? ` · collect at ${collectAt}` : ''
                     }</p>`;
              try {
                await transport.sendMail({
                  from,
                  to: doc.customer_email,
                  subject:
                    stage === 'accepted'
                      ? `${settings.restaurant_name}: order ${doc.order_no} accepted${isGroup ? ' (group)' : ''}`
                      : `${settings.restaurant_name}: order ${doc.order_no} is ready`,
                  html: shell(settings.restaurant_name, body, brand),
                });
                log(`${stage} notice sent for ${doc.order_no}`);
              } catch (e) {
                error(`${stage} notice failed for ${doc.order_no}: ${e.message}`);
              }
            } else {
              error('Order notice not sent: SMTP_HOST / SMTP_USER / SMTP_PASS are not set.');
            }
          }
        }
      }
    }

    // ---------------------------------------------------------- receipt
    if (events.some((e) => e.includes('collections.orders')) && doc.payment_status === 'paid') {
      const already = await db.listDocuments(DB_ID, 'receipts', [
        Query.equal('order_id', doc.$id),
        Query.limit(10),
      ]);

      // An update event fires on every edit, so without a guard a customer
      // would be emailed their receipt again every time the order is touched.
      //
      // Two things get past the guard, both deliberate:
      //   - somebody asked for it to be sent again, which is a request rather
      //     than a deletion because staff cannot delete a receipt record;
      //   - nothing was ever actually sent. A row saying "skipped, no email"
      //     is a record of not sending, and treating it as "done" is why an
      //     order that later gained an address never got its receipt.
      const resendRows = already.documents.filter((r) => r.resend_requested_at);
      const sentAlready = already.documents.some((r) => r.status === 'sent');
      if (sentAlready && resendRows.length === 0) {
        return res.json({ ok: true, skipped: 'receipt already sent' });
      }

      const delivery = await featureConfig('receipts', 'receipt_delivery', 'email');
      if (delivery === null) return res.json({ ok: true, skipped: 'receipts feature off' });

      if (!doc.customer_email) {
        // Recorded once, not once per edit, otherwise an order touched twenty
        // times leaves twenty rows saying the same thing.
        if (already.total === 0) {
          await db.createDocument(DB_ID, 'receipts', 'unique()', {
            venue_id: doc.venue_id, order_id: doc.$id, channel: 'none',
            status: 'skipped', skip_reason: 'no_email', attempts: 0,
          });
        }
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
        (doc.tax_total ? row(`${settings.levies ? 'VAT and levies' : 'Tax'}${settings.tax_inclusive ? ' (included)' : ''}`, money(doc.tax_total, settings)) : '') +
        row('Total', money(doc.total, settings), true);

      const html = shell(
        settings.restaurant_name,
        `<p style="margin:0 0 4px">Thank you, here is your receipt.</p>
         <p style="margin:0 0 16px;color:#5d6b7a;font-size:14px">Order ${doc.order_no} · ${new Date(doc.$createdAt).toLocaleString()}</p>
         <table style="width:100%;border-collapse:collapse;font-size:15px">${lines}
         <tr><td colspan="2" style="border-top:1px solid #e3e7ec;padding-top:8px"></td></tr>${totals}</table>
         <p style="margin:20px 0 0;color:#5d6b7a;font-size:13px">A printable copy is attached.</p>
         <p style="margin:8px 0 0;color:#5d6b7a;font-size:13px">Paid in person. This is a record of your order, not a request for payment.</p>`,
        brand,
      );

      // The same receipt the till prints, as a real PDF attachment. An email
      // body is fine to glance at; a PDF is what somebody forwards to their
      // accountant or keeps for an expense claim.
      let attachments;
      try {
        const [paid, allMethods] = await Promise.all([
          db.listDocuments(DB_ID, 'payments', [Query.equal('order_id', doc.$id), Query.limit(20)]),
          db.listDocuments(DB_ID, 'payment_methods', [Query.limit(50)]),
        ]);
        const venue = await db.getDocument(DB_ID, 'venues', doc.venue_id).catch(() => null);
        attachments = [{
          filename: `receipt-${doc.order_no}.pdf`,
          content: receiptPdf({
            settings,
            venue,
            order: doc,
            items: items.documents,
            payments: paid.documents,
            methods: allMethods.documents,
          }),
          contentType: 'application/pdf',
        }];
      } catch (e) {
        // A receipt that arrives without its attachment is worth far more than
        // one that never arrives because building a PDF went wrong.
        error(`Receipt PDF failed for ${doc.order_no}, sending without it: ${e.message}`);
      }

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
          attachments,
        });
        await db.updateDocument(DB_ID, 'receipts', receipt.$id, {
          status: 'sent', sent_at: new Date().toISOString(), provider_ref: info.messageId || '',
        });
        // The request has been honoured; clearing it stops the next edit to
        // this order sending the receipt all over again.
        for (const r of resendRows) {
          await db.updateDocument(DB_ID, 'receipts', r.$id, { resend_requested_at: null })
            .catch(() => undefined);
        }
        log(`Receipt ${resendRows.length ? 're-sent' : 'sent'} for ${doc.order_no}`);
      } catch (e) {
        await db.updateDocument(DB_ID, 'receipts', receipt.$id, { status: 'failed', last_error: e.message });
        error(`Receipt failed for ${doc.order_no}: ${e.message}`);
      }
      return res.json({ ok: true });
    }

    // ----------------------------------------------------- shift summary
    if (events.some((e) => e.includes('collections.shifts')) && doc.status === 'closed') {
      /*
        THE BOOKS FIRST, then the email about them.

        Keyed by the shift, so the update that marks it posted, and every
        later touch of the row, finds the entries there and does nothing.
        A failure here is logged and does not stop the summary: the hourly
        sweep will try the books again, and the summary reads the rows, not
        the books.
      */
      try {
        const booked = await postShiftClose(books, doc);
        if (booked.posted) log(`Books: shift ${doc.code} posted (${booked.posted} entries, ${booked.spends} spends).`);
        else if (booked.skipped === 'locked') error(`Books: shift ${doc.code} not posted, period locked through ${booked.through}.`);
      } catch (e) {
        error(`Books: shift ${doc.code} could not be posted: ${e.message}`);
      }

      /*
        Sent once, unless somebody asks for it again.

        `summary_resend_at` is an admin pressing "send the report again" on the
        shift. It lives there rather than on the report because nobody can
        write to summary_reports from a browser — that row is the record of
        what was sent — and because a shift update is already an event this job
        answers, so asking for a resend needs no new trigger.

        The flag is cleared once the mail is away, which is what makes it a
        request rather than a setting. Clearing it is itself a shift update, so
        this runs once more and takes the branch above: already sent, nothing
        asked for, nothing to do.
      */
      const resendWanted = !!doc.summary_resend_at;
      /*
        Cleared on the way out, whatever happened.

        Including when the send failed. The request has been answered — there
        is now a row saying what went wrong — and leaving the flag set would
        have this run again on the next touch of the shift, and again after
        that, quietly retrying something that is not going to start working
        until somebody changes a setting.
      */
      const clearResend = async () => {
        if (!resendWanted) return;
        await db.updateDocument(DB_ID, 'shifts', doc.$id, { summary_resend_at: null })
          .catch(() => undefined);
      };
      const already = await db.listDocuments(DB_ID, 'summary_reports', [
        Query.equal('shift_id', doc.$id), Query.limit(1),
      ]);
      if (already.total > 0 && !resendWanted) {
        return res.json({ ok: true, skipped: 'summary already sent' });
      }

      const threshold = await featureConfig('shift_summary', 'persistent_stock_threshold', 3);
      if (threshold === null) {
        /*
          Written down rather than returned quietly.

          This used to skip in silence, which from every screen in the system
          looks identical to the function never having run at all — and those
          two have completely different fixes. One is a switch somebody turned
          off; the other is a subscription that was never set. Leaving a row
          behind is what makes them tell apart.
        */
        await db.createDocument(DB_ID, 'summary_reports', 'unique()', {
          venue_id: doc.venue_id, kind: 'shift_close', shift_id: doc.$id,
          period_start: doc.opened_at, period_end: doc.closed_at || new Date().toISOString(),
          payload: '{}',
          delivery_status: 'failed',
          last_error: 'The shift summary is switched off under Admin, Features. Nothing was sent.',
        }).catch(() => undefined);
        log('Shift summary is switched off; recorded and not sent.');
        if (doc.summary_resend_at) {
          await db.updateDocument(DB_ID, 'shifts', doc.$id, { summary_resend_at: null })
            .catch(() => undefined);
        }
        return res.json({ ok: true, skipped: 'summary feature off' });
      }

      // The shift's own clock, used for anything a customer could have started.
      // A QR order has no shift stamped on it, the phone that placed it has no
      // idea one is open, so scoping "what happened tonight" by shift_id alone
      // would leave the busiest orders out of the count.
      const openedAt = doc.opened_at;
      const closedAt = doc.closed_at || new Date().toISOString();

      const [
        ingredients, waste, expenses, subs, offItems, inWindow, settledHere, payments, staff, shelfChecks,
      ] = await Promise.all([
        db.listDocuments(DB_ID, 'ingredients', [Query.equal('venue_id', doc.venue_id), Query.limit(500)]),
        db.listDocuments(DB_ID, 'waste_log', [Query.equal('shift_id', doc.$id), Query.limit(100)]),
        db.listDocuments(DB_ID, 'shift_expenses', [Query.equal('shift_id', doc.$id), Query.limit(100)]),
        db.listDocuments(DB_ID, 'report_subscriptions', [Query.equal('active', true), Query.limit(50)]),
        // Dishes staff took off the menu during this shift. What ran out is a
        // different signal from what was merely low: it stopped being sellable.
        db.listDocuments(DB_ID, 'item_availability', [
          Query.equal('shift_id', doc.$id), Query.limit(100),
        ]).catch(() => ({ documents: [] })),
        db.listDocuments(DB_ID, 'orders', [
          Query.equal('venue_id', doc.venue_id),
          Query.greaterThanEqual('$createdAt', openedAt),
          Query.lessThanEqual('$createdAt', closedAt),
          Query.limit(500),
        ]).catch(() => ({ documents: [] })),
        // And the ones the clock misses. An order placed before anybody opened
        // the till, every pre-order, and everything taken in the quiet half
        // hour before service, was created outside the window above, so it
        // appeared in no shift at all. Its money was still in the takings,
        // because a payment carries the shift it was collected in, which left
        // the summary counting revenue it could not show you the orders for.
        // Taking the payment is the moment the order gets stamped.
        db.listDocuments(DB_ID, 'orders', [
          Query.equal('shift_id', doc.$id), Query.limit(500),
        ]).catch(() => ({ documents: [] })),
        db.listDocuments(DB_ID, 'payments', [
          Query.equal('shift_id', doc.$id), Query.limit(500),
        ]).catch(() => ({ documents: [] })),
        db.listDocuments(DB_ID, 'staff_profiles', [Query.limit(200)]).catch(() => ({ documents: [] })),
        /*
          What somebody actually saw on the shelves as they closed up.

          The stock table below this only ever lists what is LOW or OUT, so a
          shift where everything was fine printed no stock section at all —
          which on the page is indistinguishable from the section being
          broken, or from nobody having been asked. Two very different things,
          one silence. This is the check itself: OK, LOW and OUT as they were
          tapped, counted from the rows the close wrote.
        */
        db.listDocuments(DB_ID, 'shift_stock_checks', [
          Query.equal('shift_id', doc.$id),
          Query.equal('phase', 'close'),
          Query.limit(500),
        ]).catch(() => ({ documents: [] })),
      ]);

      /**
       * Which trade this shift is. The bistro, the bar and the craft shop each
       * open and close their own, and one closing says nothing about another.
       */
      const side = doc.module || 'kitchen';

      /*
        Created during the shift, or settled by it — this side's only.

        The window query asks for every order at the venue between two times,
        and the bar is open during the bistro's hours. See ordersForSide.
      */
      const orders = { documents: ordersForSide(inWindow.documents, settledHere.documents, side) };

      // The two stock sections, kept apart on purpose: a first-time flag is
      // routine restocking, the same item low for the fourth shift running is
      // a different problem wearing the same clothes.
      const severityOf = (i) => i.last_low_severity || (Number(i.current_qty) > 0 ? 'low' : 'out');
      /*
        This side's larder only.

        The bistro's closing email listed the bar's bottles and the craft
        shop's supplies, because the query asked for every ingredient in the
        venue. An owner reading a bistro summary at midnight was being handed
        three trades' shortages under one heading, and the one that mattered
        was somewhere in the middle of it.

        Filtered here rather than in the query: rows written before `module`
        existed carry no value for it, so asking the database for
        module = kitchen would miss the entire original larder.
      */
      const low = ingredients.documents
        .filter((i) => (i.module || 'kitchen') === side)
        .filter((i) => i.active && (i.consecutive_low_count || 0) > 0)
        // Worst first: persistent, then out, then low, then alphabetical. An
        // owner reading this on a phone at midnight reads the top three rows.
        .sort((a, b) => {
          const rank = (i) =>
            ((i.consecutive_low_count || 0) >= threshold ? 0 : 2) + (severityOf(i) === 'out' ? 0 : 1);
          return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name));
        });
      const fresh = low.filter((i) => (i.consecutive_low_count || 0) === 1);
      const persistent = low.filter((i) => (i.consecutive_low_count || 0) >= threshold);

      /*
        The shelves as they were reported, counted.

        Said whatever the answer is, including "everything was fine", because
        the table below only prints exceptions and an empty exceptions table
        is silence. An owner cannot tell a good night from a broken report
        from a check nobody was asked to do, and all three were printing the
        same nothing.

        Built from the rows the close actually wrote rather than from the
        ingredients table, so it says what a person tapped that night and not
        what the running figures imply today.
      */
      const shelf = shelfCheckSummary(
        shelfChecks.documents,
        new Map(ingredients.documents.map((i) => [i.$id, i.name])),
      );
      const shelfLine = shelf.total === 0
        ? '<p style="margin:0;font-size:14px;color:#5d6b7a">No shelf check was filed with this close, so '
          + 'nothing here says what was on the shelves. It is asked for on the closing screen.</p>'
        : `<p style="margin:0;font-size:14px">
             <strong>${shelf.total}</strong> item${shelf.total === 1 ? '' : 's'} checked ·
             <span style="color:#12805c">${shelf.ok} ok</span> ·
             <span style="color:${shelf.low ? '#b26a00' : '#5d6b7a'}">${shelf.low} low</span> ·
             <span style="color:${shelf.out ? '#b42318' : '#5d6b7a'};font-weight:${shelf.out ? 700 : 400}">${shelf.out} out</span>
           </p>
           ${shelf.outNames.length ? `<p style="margin:6px 0 0;font-size:14px"><strong>Out:</strong> ${shelf.outNames.join(', ')}</p>` : ''}
           ${shelf.lowNames.length ? `<p style="margin:6px 0 0;font-size:14px;color:#5d6b7a"><strong>Low:</strong> ${shelf.lowNames.join(', ')}</p>` : ''}`;

      const variance = Object.values(JSON.parse(doc.variance || '{}')).reduce((a, b) => a + b, 0);
      const wasteValue = waste.documents.reduce((a, w) => a + (w.value || 0), 0);
      const expenseTotal = expenses.documents.reduce((a, e) => a + e.amount, 0);

      // ------------------------------------------------- who did what
      //
      // The totals say how the night went; this says who was in it. Not to
      // rank anybody, a cook on the pass and a cashier on the till leave very
      // different traces, but so that a question about one order has a name
      // attached to it the next morning, when nobody remembers.
      //
      // Staff are recorded by their Appwrite user id in some places and by
      // their profile row in others, so both are accepted as keys.
      const nameOf = (id) => {
        if (!id) return null;
        const p = staff.documents.find((s) => s.user_id === id || s.$id === id);
        return p ? p.display_name : null;
      };

      const activity = new Map();
      const rowFor = (id) => {
        const name = nameOf(id);
        if (!name) return null;
        if (!activity.has(name)) {
          activity.set(name, { accepted: 0, settled: 0, taken: 0, spent: 0, wasted: 0, off: 0 });
        }
        return activity.get(name);
      };

      for (const o of orders.documents) {
        const a = rowFor(o.accepted_by);
        if (a) a.accepted += 1;
        const s = rowFor(o.marked_paid_by);
        if (s) s.settled += 1;
      }
      for (const p of payments.documents) {
        const r = rowFor(p.taken_by);
        if (r) r.taken += (p.amount || 0) + (p.tip || 0);
      }
      for (const e of expenses.documents) {
        const r = rowFor(e.created_by);
        if (r) r.spent += e.amount || 0;
      }
      for (const w of waste.documents) {
        const r = rowFor(w.recorded_by);
        if (r) r.wasted += 1;
      }
      for (const o of offItems.documents) {
        const r = rowFor(o.marked_off_by);
        if (r) r.off += 1;
      }
      // Opening and closing are activity too, and the person who did them is
      // often the one with the answer about the drawer.
      rowFor(doc.opened_by);
      rowFor(doc.closed_by);

      const staffRows = [...activity.entries()]
        .sort((a, b) => b[1].taken - a[1].taken || a[0].localeCompare(b[0]))
        .map(([name, r]) => {
          const bits = [];
          if (r.accepted) bits.push(`${r.accepted} order${r.accepted === 1 ? '' : 's'} accepted`);
          if (r.settled) bits.push(`${r.settled} bill${r.settled === 1 ? '' : 's'} settled`);
          if (r.taken) bits.push(`${money(r.taken, settings)} taken`);
          if (r.spent) bits.push(`${money(r.spent, settings)} paid out`);
          if (r.wasted) bits.push(`${r.wasted} waste entr${r.wasted === 1 ? 'y' : 'ies'}`);
          if (r.off) bits.push(`${r.off} item${r.off === 1 ? '' : 's'} taken off`);
          return `<li><strong>${name}</strong>, ${bits.join(' · ') || 'on shift, nothing recorded against them'}</li>`;
        });

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
         ${section('Who did what', staffRows)}
         <h3 style="margin:20px 0 6px;font-size:15px">Shelves at close</h3>
         ${shelfLine}
         ${stockTable(low, threshold, settings)}
         ${section(
           'Taken off the menu during this shift',
           offItems.documents.map(
             (r) =>
               `<li><strong>${r.name_snapshot}</strong>${r.reason ? `, ${r.reason}` : ''}${
                 r.marked_off_name ? ` <span style="color:#5d6b7a">(${r.marked_off_name})</span>` : ''
               }${r.restored_at ? ' <span style="color:#12805c">· back on</span>' : ' <span style="color:#b42318">· still off</span>'}</li>`,
           ),
         )}
         ${doc.variance_note ? `<h3 style="margin:20px 0 6px;font-size:15px">Why the drawer was out</h3><p style="margin:0;font-size:14px">${doc.variance_note}</p>` : ''}
         ${persistent.length ? '<p style="margin:14px 0 0;font-size:13px;color:#b54708">Items low this many shifts running are usually a supply problem or stock leaving unrecorded, worth a look rather than another reorder.</p>' : ''}`,
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
        await clearResend();
        return res.json({ ok: true, stored: true, sent: false });
      }

      try {
        const info = await transport.sendMail({
          from, to: recipients.join(','),
          // Which side, in the subject line. Three trades closing three
          // shifts a day produced three near-identical subjects, and an owner
          // had to open one to find out whose it was.
          subject: `${settings.restaurant_name}, shift ${doc.code} closed${SIDE_NAME[side] || ''}`,
          html,
        });

        // Who the server actually took, and what it said. See deliveryFrom:
        // accepting the message for one of two recipients still resolves here,
        // and used to be filed as sent to both.
        const delivery = deliveryFrom(info, recipients);
        await db.updateDocument(DB_ID, 'summary_reports', report.$id, delivery).catch(() => undefined);
        log(`Summary accepted for ${delivery.delivered_to || 'nobody'} of ${recipients.length} asked`
          + `${info?.response ? ` — ${info.response}` : ''}`);
      } catch (e) {
        await db.updateDocument(DB_ID, 'summary_reports', report.$id, {
          delivery_status: 'failed', last_error: e.message,
        });
        error(`Summary failed: ${e.message}`);
      }
      await clearResend();
      return res.json({ ok: true, resent: resendWanted });
    }

    return res.json({ ok: true, skipped: 'event not handled' });
  } catch (e) {
    error(`notify failed: ${e.message}`);
    return res.json({ ok: false, error: e.message }, 500);
  }
};
