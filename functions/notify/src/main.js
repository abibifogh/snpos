import { Client, Databases, Query, Users } from 'node-appwrite';
import nodemailer from 'nodemailer';
import { receiptPdf } from './receipt-pdf.js';
import { tradeWords, offSubject } from './words.js';
import { dailyDigest, nightlyBackup } from './daily.js';
import { ensureLogin, revokeLogin } from './staff.js';
import { handleReports } from './reports.js';
import { handleSso } from './sso.js';

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
 *
 * Schedule, hourly (no document arrives):
 *   dishes still off the menu past the configured wait
 *   shifts left open longer than a day
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

const shell = (title, body, brand) => `<!doctype html>
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
async function sweepUnavailable({ db, DB_ID, settings, transport, log, error }) {
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
  log(`Alerted about ${open.total} dishes off over ${hours}h.`);
  return { alerted: open.total };
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
      ['availability', () => sweepUnavailable({ db, DB_ID, settings, transport, log, error })],
      ['stale_shifts', () => sweepStaleShifts({ db, DB_ID, settings, transport, from, shell, log, error })],
      ['daily', () => dailyDigest({ db, DB_ID, settings, transport, from, shell, row, money, log, error })],
      ['backup', () => nightlyBackup({ db, DB_ID, settings, transport, from, shell, log, error })],
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

    // -------------------------------------------------- a dish has run out
    // Sent the moment it happens, not on the hourly sweep.
    //
    // The sweep exists for the opposite problem, something that has been off
    // for two days and nobody noticed. This is the other end: a dish going off
    // during service is a buying decision somebody may still be able to act on
    // within the hour, and by the time an hourly job runs, the trip to the
    // market has been missed.
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

    // ------------------------------------------------- group order placed
    // A party of twenty is a kitchen planning decision, not just another
    // ticket, so somebody is told the moment it arrives rather than when the
    // pass fills up.
    if (events.some((e) => e.includes('collections.orders')) && doc.is_group) {
      const wanted = await featureConfig('group_orders', 'notify_on_placed', true);
      if (wanted) {
        const already = await db.listDocuments(DB_ID, 'order_notices', [
          Query.equal('order_id', doc.$id),
          Query.equal('stage', 'group_placed'),
          Query.limit(1),
        ]).catch(() => ({ total: 0 }));

        if (already.total === 0) {
          const configured = await featureConfig('group_orders', 'notify_emails', '');
          let to = String(configured || '')
            .split(/[,;\s]+/)
            .filter(Boolean);
          if (to.length === 0) {
            // Falls back to whoever gets the shift summary, so turning this on
            // does not require setting up a second list of addresses.
            const subs = await db.listDocuments(DB_ID, 'report_subscriptions', [
              Query.equal('active', true), Query.limit(50),
            ]).catch(() => ({ documents: [] }));
            to = subs.documents.map((x) => x.email).filter(Boolean);
          }

          await db.createDocument(DB_ID, 'order_notices', 'unique()', {
            venue_id: doc.venue_id, order_id: doc.$id, stage: 'group_placed',
            to_email: to.join(','),
            status: transport && to.length ? 'queued' : 'failed',
            last_error: !transport ? 'No SMTP configured on the function.' : to.length ? '' : 'No recipients configured.',
          }).catch(() => undefined);

          if (transport && to.length) {
            const label = await featureConfig('group_orders', 'reservation_label', 'Reservation');
            try {
              await transport.sendMail({
                from,
                to: to.join(','),
                subject: `Group order ${doc.order_no}${doc.group_size ? ` · ${doc.group_size} people` : ''}`,
                html: shell(
                  'A group has ordered',
                  `<table style="width:100%;border-collapse:collapse;font-size:15px">
                     ${row('Order', doc.order_no)}
                     ${row('People', String(doc.group_size || '-'))}
                     ${row(label, doc.group_reference || '-')}
                     ${row('Booked by', doc.group_contact_name || doc.customer_name || '-')}
                     ${row('Total', money(doc.total, settings), true)}
                   </table>
                   <p style="margin:18px 0 0;color:#5d6b7a;font-size:13px">The kitchen has it on the pass now.</p>`,
                  brand,
                ),
              });
              log(`Group notice sent for ${doc.order_no}`);
            } catch (e) {
              error(`Group notice failed for ${doc.order_no}: ${e.message}`);
            }
          }
        }
      }
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
        (doc.tax_total ? row(`Tax${settings.tax_inclusive ? ' (included)' : ''}`, money(doc.tax_total, settings)) : '') +
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
      const already = await db.listDocuments(DB_ID, 'summary_reports', [
        Query.equal('shift_id', doc.$id), Query.limit(1),
      ]);
      if (already.total > 0) return res.json({ ok: true, skipped: 'summary already sent' });

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
        return res.json({ ok: true, skipped: 'summary feature off' });
      }

      // The shift's own clock, used for anything a customer could have started.
      // A QR order has no shift stamped on it, the phone that placed it has no
      // idea one is open, so scoping "what happened tonight" by shift_id alone
      // would leave the busiest orders out of the count.
      const openedAt = doc.opened_at;
      const closedAt = doc.closed_at || new Date().toISOString();

      const [ingredients, waste, expenses, subs, offItems, inWindow, settledHere, payments, staff] = await Promise.all([
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
      ]);

      // Created during the shift, or settled by it. Merged by id so an order
      // that is both is still one order.
      const orders = { documents: [...new Map(
        [...inWindow.documents, ...settledHere.documents].map((o) => [o.$id, o]),
      ).values()] };

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
      const side = doc.module || 'kitchen';
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
        return res.json({ ok: true, stored: true, sent: false });
      }

      try {
        await transport.sendMail({
          from, to: recipients.join(','),
          // Which side, in the subject line. Three trades closing three
          // shifts a day produced three near-identical subjects, and an owner
          // had to open one to find out whose it was.
          subject: `${settings.restaurant_name}, shift ${doc.code} closed${SIDE_NAME[side] || ''}`,
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
