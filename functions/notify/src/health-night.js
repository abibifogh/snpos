import { Query } from 'node-appwrite';
import { localHour, localDay, recipientsFor } from './daily.js';
import { healthFacts, healthFindings, healthSummary } from './health.js';

/** Two in the morning, where the restaurant is: after the last close, before the first open. */
export const HEALTH_HOUR = 2;

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** The email: what needs fixing, then what is waiting. Nothing that is fine. */
export function healthBody(findings, summary, appUrl) {
  const rows = findings.filter((x) => x.level !== 'ok').map((x) =>
    `<li style="margin:0 0 10px"><strong>${esc(x.title)}</strong>${x.count > 1 ? ` (${x.count})` : ''}<br>`
    + `<span style="color:#5d6b7a">${esc(x.detail)}</span></li>`);
  return `<p style="margin:0 0 14px;font-size:15px">${esc(summary.words)}</p>`
    + `<ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.5">${rows.join('')}</ul>`
    + (appUrl ? `<p style="margin:18px 0 0;color:#5d6b7a;font-size:13px">Each one has a button under Admin, Health: <a href="${esc(appUrl)}/admin/#/health">${esc(appUrl)}/admin/#/health</a></p>` : '');
}

/**
 * Every night at two, ask the questions, write the answers down, and email
 * whoever gets the daily summary if anything needs fixing.
 *
 * Written down whether or not anybody is emailed: the row is what the Health
 * page shows as "last check", and what the page's own "nightly check has not
 * run" finding is measured against. Once per local day, however many times
 * the hourly timer lands on the hour.
 */
export async function nightlyReconcile({ db, DB_ID, settings, transport, from, shell, log, error, now = new Date() }) {
  const tz = settings.timezone || 'UTC';
  if (localHour(tz) !== HEALTH_HOUR) return { skipped: 'not the hour' };
  const day = localDay(tz);

  const venues = await db.listDocuments(DB_ID, 'venues', [Query.limit(25)]);
  const venue = venues.documents[0];
  if (!venue) return { skipped: 'no venue' };

  const already = await db.listDocuments(DB_ID, 'summary_reports', [
    Query.equal('kind', 'health'), Query.equal('venue_id', venue.$id), Query.orderDesc('$createdAt'), Query.limit(1),
  ]).catch(() => ({ documents: [] }));
  if (already.documents[0] && JSON.parse(already.documents[0].payload || '{}').day === day) {
    return { skipped: 'already checked today' };
  }

  const money = (minor) => {
    const d = settings.currency_decimals ?? 2;
    const v = (minor / 10 ** d).toFixed(d);
    return settings.symbol_position === 'after' ? `${v}${settings.currency_symbol}` : `${settings.currency_symbol}${v}`;
  };
  const facts = await healthFacts({ db, DB_ID, Query, log }, venue.$id, now);
  const findings = healthFindings(facts, { money });
  const summary = healthSummary(findings);
  log(`Health: ${summary.words}`);

  const to = summary.blocks > 0 ? await recipientsFor(db, DB_ID, 'daily_digest') : [];
  const report = await db.createDocument(DB_ID, 'summary_reports', 'unique()', {
    venue_id: venue.$id,
    kind: 'health',
    period_start: new Date(now.getTime() - 86_400_000).toISOString(),
    period_end: now.toISOString(),
    payload: JSON.stringify({ day, words: summary.words, blocks: summary.blocks, warns: summary.warns, findings }).slice(0, 20000),
    delivery_status: 'queued',
    delivered_to: to.join(', '),
  });

  if (summary.blocks === 0) {
    await db.updateDocument(DB_ID, 'summary_reports', report.$id, { delivery_status: 'sent' }).catch(() => undefined);
    return { ok: true, blocks: 0, warns: summary.warns, emailed: false };
  }
  if (!transport || to.length === 0) {
    await db.updateDocument(DB_ID, 'summary_reports', report.$id, {
      delivery_status: 'failed',
      last_error: !transport ? 'No SMTP configured' : 'Nobody is subscribed to the daily summary, so nobody was told.',
    }).catch(() => undefined);
    return { ok: true, blocks: summary.blocks, emailed: false };
  }
  try {
    await transport.sendMail({
      from, to: to.join(','),
      subject: `${settings.restaurant_name}: ${summary.blocks === 1 ? 'one thing needs' : `${summary.blocks} things need`} fixing`,
      html: shell('Health check', healthBody(findings, summary, process.env.APP_URL || ''), settings.primary_color || '#0f766e'),
    });
    await db.updateDocument(DB_ID, 'summary_reports', report.$id, { delivery_status: 'sent', sent_at: now.toISOString() }).catch(() => undefined);
    return { ok: true, blocks: summary.blocks, emailed: true };
  } catch (e) {
    await db.updateDocument(DB_ID, 'summary_reports', report.$id, { delivery_status: 'failed', last_error: e.message }).catch(() => undefined);
    error(`Health email failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}
