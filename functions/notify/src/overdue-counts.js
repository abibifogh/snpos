/**
 * Stock counts that have been holding a difference for more than a day.
 *
 * A count that finds a difference waits for an admin before the shelf moves,
 * and the admin is told when it is filed. That first word is not enough on
 * its own, and the reason is what waiting COSTS: until somebody agrees or
 * refuses, the stock figure is one a count has already found to be wrong, and
 * every count after it is measured against that figure. The same missing
 * bottles are found again on the next count, and the next, each time on
 * somebody else's shift — see the walk-through that prompted this in the bar
 * counts screen's history. A day is long enough for that to have started.
 *
 * SO THIS IS THE SECOND WORD, AND IT IS SAID ONCE. Each count is stamped when
 * it has been escalated. An admin told twice — once at filing, once a day
 * later — has been told; telling them every hour after that is how a warning
 * becomes something a phone learns to hide.
 *
 * Plain JavaScript importing nothing but its neighbour, so the decisions can
 * be tested without a database, a mail server or a push service.
 */

import { fromBarChecks, fromShopCounts, waitedWords } from './approvals.js';

/** How long a held difference may sit before it is escalated. */
export const OVERDUE_MS = 24 * 60 * 60 * 1000;

/**
 * The counts past the line, oldest first, from the rows of both queues.
 *
 * A row already escalated is left out here as well as in the query that read
 * it. The query does the real work; this is so a database that has not been
 * provisioned with the stamp — where the query cannot filter on it — still
 * cannot produce the same alert every hour.
 */
/**
 * @param {object} input
 * @param {Array<Record<string, any>>} [input.checks]      Held shift_stock_checks rows.
 * @param {Array<Record<string, any>>} [input.shopCounts]  Pending stock_counts rows.
 * @param {Record<string, string>} [input.names]           Staff names by profile id.
 * @param {number} [input.now]
 */
export function overdueCounts({ checks = [], shopCounts = [], names = {}, now = Date.now() }) {
  const fresh = (r) => !r.overdue_alerted_at;
  return [
    ...fromBarChecks(checks.filter(fresh), names),
    ...fromShopCounts(shopCounts.filter(fresh), names),
  ]
    .filter((i) => {
      const t = Date.parse(i.since);
      // A count with no readable date is not assumed old. Escalating it would
      // be a guess, and a wrong escalation is exactly what teaches somebody to
      // ignore the right ones.
      return Number.isFinite(t) && now - t >= OVERDUE_MS;
    })
    .sort((a, b) => a.since.localeCompare(b.since));
}

/**
 * The rows to stamp once the alert has gone: every row belonging to an
 * overdue count, and none belonging to a count that is not overdue yet.
 *
 * A bar count is many rows — one per line with a difference — and stamping
 * only some of them would bring the rest back in the next hour's alert as if
 * they were a count of their own.
 */
/**
 * @param {Array<{ id: string, queue: string }>} items
 * @param {{ checks?: Array<Record<string, any>>, shopCounts?: Array<Record<string, any>> }} rows
 */
export function rowsToStamp(items, { checks = [], shopCounts = [] }) {
  const barKeys = new Set(items.filter((i) => i.queue === 'bar_count').map((i) => i.id));
  const shopIds = new Set(items.filter((i) => i.queue === 'shop_count').map((i) => i.id));
  return {
    checks: checks
      .filter((r) => barKeys.has(`${r.shift_id || 'no-shift'}|${r.phase || 'close'}`))
      .map((r) => r.$id),
    shopCounts: shopCounts.filter((r) => shopIds.has(r.$id)).map((r) => r.$id),
  };
}

/**
 * Who is told: the admins, by their own addresses and devices.
 *
 * Not the report list the first word goes to. Agreeing or refusing a count is
 * an admin's decision and nobody else's, so a day later the alert goes to the
 * people who can actually act on it rather than the people who read reports.
 *
 * @param {Array<{ role?: string, active?: boolean, email?: string, user_id?: string }>} staff
 */
export function adminRecipients(staff = []) {
  const admins = staff.filter((p) => p.role === 'admin' && p.active !== false);
  return {
    emails: [...new Set(admins.map((p) => String(p.email || '').trim()).filter((e) => e.includes('@')))],
    userIds: [...new Set(admins.map((p) => p.user_id).filter(Boolean))],
  };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The subject line. The age is in it because the age is the news. */
export function overdueSubject(items) {
  if (items.length === 1) {
    return `${items[0].what} has been waiting for your decision for over a day`;
  }
  return `${plural(items.length, 'stock count has', 'stock counts have')} been waiting over a day`;
}

/**
 * What goes on a phone's lock screen.
 *
 * Short, because a lock screen cuts off after two lines, and the one number
 * that matters first: how many, and what is at stake. The tag means a second
 * alert replaces the first on the screen rather than stacking beside it.
 */
export function overduePush(items, money, now = Date.now()) {
  const worth = items.reduce((n, i) => n + (i.value || 0), 0);
  const oldest = items[0];
  const age = oldest ? waitedWords(now - Date.parse(oldest.since)) : '';
  return {
    title: items.length === 1 ? `${oldest.what} waiting ${age}` : `${items.length} stock counts waiting over a day`,
    body: `${worth > 0 ? `${money(worth)} in differences. ` : ''}`
      + 'The stock figures stay wrong until you agree or refuse.',
    url: '#/waiting?show=count',
    tag: 'overdue-counts',
  };
}

/**
 * The email. Each count, what it is worth, who counted it and how long it has
 * sat — and why a day matters, which is the part that decides whether anybody
 * opens the page.
 */
export function overdueBody(items, money, now = Date.now(), link = '') {
  const lis = items
    .map((r) => {
      const bits = [
        r.value > 0 ? money(r.value) : null,
        r.lines > 1 ? `${r.lines} lines` : null,
        r.who ? `counted by ${r.who}` : null,
      ].filter(Boolean);
      return `<li><strong>${r.what}</strong>${bits.length ? ` — ${bits.join(', ')}` : ''}`
        + `<br><span style="color:#b4530a">Waiting ${waitedWords(now - Date.parse(r.since))}</span></li>`;
    })
    .join('');

  return '<p style="margin:0 0 12px">These counts found a difference and have been waiting for a decision for '
    + 'more than a day:</p>'
    + `<ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.7">${lis}</ul>`
    + '<p style="margin:18px 0 0;font-size:14px">'
    + '<strong>Why a day matters.</strong> Until a count is agreed or refused the stock figure is the old one, '
    + 'and the next count is measured against it — so the same difference turns up again on the next count, '
    + 'on somebody else\'s shift. Approve one copy of a difference, not every count it appears on: approving '
    + 'two takes it off the shelf twice.'
    + '</p>'
    + (link
      ? `<p style="margin:18px 0 0"><a href="${link}" style="color:#0f766e;font-weight:600">`
        + 'Open Waiting for you</a></p>'
      : '<p style="margin:18px 0 0;color:#5d6b7a;font-size:13px">Under Money, Waiting for you.</p>');
}
