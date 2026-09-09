/**
 * Things sitting and waiting for an admin to agree to them.
 *
 * The system grew several of these, one at a time, and each one is right on
 * its own: a count that found a difference does not move the shelf until
 * somebody who can see the whole business agrees, because the person holding
 * the clipboard should not also be the person who signs it off. What none of
 * them has is a way of telling that admin. Every one of these queues is a
 * screen you have to remember to open, and the failure is silent in the worst
 * direction — a shelf that has not been corrected reads as a shelf that is
 * fine, and a count nobody answered reads as a count nobody took.
 *
 * WHY THIS IS A SWEEP AND NOT AN EVENT.
 *
 * A count of forty bottles with six differences writes six rows in the same
 * second. Sending on the event would send six emails, which is not six times
 * as useful, it is one email that gets a rule made for it in somebody's inbox.
 * So the queues are gathered on the hourly run and go out as one message: what
 * is waiting, how much it is worth, and how long it has been sitting.
 *
 * The cost is that a count taken at nine is emailed at ten rather than at
 * nine, and that is the right trade for something whose whole nature is that
 * it waits for a person.
 *
 * AND WHY IT SAYS SOMETHING ONCE.
 *
 * Each row is stamped when it has been mentioned. An admin who has been told
 * will act or decide not to; repeating it every hour until they do is how a
 * warning becomes noise that gets filtered, which is the same reasoning as the
 * availability sweep next door.
 *
 * Plain JavaScript importing nothing at runtime, so the decisions below can be
 * tested without a database or a mail server. See approvals.test.ts.
 */

/** How long a difference may sit before it is worth an email. */
export const APPROVAL_GRACE_MS = 15 * 60 * 1000;

/**
 * One thing waiting, whichever queue it came from.
 *
 * @typedef {object} Waiting
 * @property {string} id
 * @property {'bar_count'|'shop_count'|'expense'} queue
 * @property {string} what        What it is, in the words of the screen it is on.
 * @property {string} who         Who put it there, where that is known.
 * @property {number} value       What is at stake, in minor units. Zero where nothing is.
 * @property {string} since       ISO, when it started waiting.
 * @property {number} lines       How many rows it covers. One for a single thing.
 */

/** Bar and store-room counts: many rows to one count, so they are grouped. */
export function fromBarChecks(rows, names = {}) {
  /** @type {Map<string, Waiting>} */
  const byCount = new Map();

  for (const r of rows) {
    // A row with no difference never waited for anybody. Only the held ones.
    if (r.applied !== false) continue;
    if (r.approved_at || r.rejected_at) continue;

    const key = `${r.shift_id || 'no-shift'}|${r.phase || 'close'}`;
    const at = byCount.get(key) ?? {
      id: key,
      queue: 'bar_count',
      what: `Bar count, ${r.phase === 'open' ? 'counting in' : 'counting out'}`,
      who: names[r.checked_by] || '',
      value: 0,
      since: r.$createdAt || '',
      lines: 0,
    };
    at.value += Math.abs(r.variance_value || 0);
    at.lines += 1;
    // The oldest row in the group is when the count started waiting.
    if (r.$createdAt && (!at.since || r.$createdAt < at.since)) at.since = r.$createdAt;
    byCount.set(key, at);
  }

  return [...byCount.values()];
}

/** The craft shop's stocktake: already one document per count. */
export function fromShopCounts(rows, names = {}) {
  return rows
    .filter((r) => r.status === 'pending')
    .map((r) => ({
      id: r.$id,
      queue: 'shop_count',
      what: 'Shop stocktake',
      who: names[r.counted_by] || '',
      value: Math.abs(r.missing_value || 0),
      since: r.counted_at || r.$createdAt || '',
      lines: r.line_count || 0,
    }));
}

/** Spending that was recorded needing somebody's agreement. */
export function fromExpenses(rows, names = {}) {
  return rows
    .filter((r) => r.approval_status === 'pending')
    .map((r) => ({
      id: r.$id,
      queue: 'expense',
      what: `Spend${r.payee ? ` to ${r.payee}` : ''}`,
      who: names[r.created_by] || '',
      value: Math.abs(r.amount || 0),
      since: r.$createdAt || '',
      lines: 1,
    }));
}

/** How long it has been, in the words somebody would use. */
export function waitedWords(ms) {
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days} ${days === 1 ? 'day' : 'days'}`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const mins = Math.max(1, Math.round(ms / 60_000));
  return `${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
}

/**
 * What is worth sending, oldest first.
 *
 * Anything filed in the last few minutes is left for the next run. A count
 * being written row by row would otherwise be emailed half-finished, and the
 * person who took it is very often still standing at the shelf.
 */
export function worthSending(items, now = Date.now(), graceMs = APPROVAL_GRACE_MS) {
  return items
    .filter((i) => {
      const t = Date.parse(i.since);
      return !Number.isFinite(t) || now - t >= graceMs;
    })
    .sort((a, b) => (a.since || '').localeCompare(b.since || ''));
}

const QUEUE_NAMES = {
  bar_count: 'Bar counts',
  shop_count: 'Shop stocktakes',
  expense: 'Spending',
};

/**
 * Where in the admin an admin goes to deal with it.
 *
 * One place for all of them now: Money, Waiting for you lists every held
 * count, spend and shelf change with the buttons to decide it, so the email
 * sends everybody to the same page whatever is waiting.
 */
const QUEUE_WHERE = {
  bar_count: 'Money, Waiting for you',
  shop_count: 'Money, Waiting for you',
  expense: 'Money, Waiting for you',
};

/** The subject line: what, how many, and nothing else. */
export function approvalSubject(items) {
  if (items.length === 0) return '';
  if (items.length === 1) {
    const [only] = items;
    return `${only.what} is waiting for your approval`;
  }
  return `${items.length} things are waiting for your approval`;
}

/**
 * The body, grouped by which screen deals with it.
 *
 * Grouped rather than listed flat because an admin does not act on "seven
 * things"; they open one screen and clear what is on it, then another. A list
 * that mixes a bar count with a taxi fare makes somebody sort it themselves.
 */
export function approvalBody(items, money, now = Date.now()) {
  const groups = new Map();
  for (const i of items) {
    groups.set(i.queue, [...(groups.get(i.queue) ?? []), i]);
  }

  const blocks = [];
  for (const [queue, rows] of groups) {
    const lis = rows
      .map((r) => {
        const waited = Number.isFinite(Date.parse(r.since))
          ? waitedWords(now - Date.parse(r.since))
          : 'a while';
        const bits = [
          r.value > 0 ? money(r.value) : null,
          r.lines > 1 ? `${r.lines} lines` : null,
          r.who ? `counted by ${r.who}` : null,
        ].filter(Boolean);
        return `<li><strong>${r.what}</strong>${bits.length ? ` — ${bits.join(', ')}` : ''}`
          + `<br><span style="color:#5d6b7a">Waiting ${waited}</span></li>`;
      })
      .join('');
    blocks.push(
      `<p style="margin:16px 0 6px;font-weight:600">${QUEUE_NAMES[queue] ?? queue}`
      + `<span style="font-weight:400;color:#5d6b7a"> · ${QUEUE_WHERE[queue] ?? ''}</span></p>`
      + `<ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.7">${lis}</ul>`,
    );
  }

  /*
    The sentence that says why it matters, once, at the end.

    An admin who does not know what "waiting" means here will assume it is a
    tidiness thing and leave it. It is not: until somebody agrees, the shelf
    figure is the OLD one, so every count and every report built on it is
    describing stock that is not there.
  */
  return `<p style="margin:0 0 4px">These are waiting for somebody who can see the whole business to `
    + `agree to them.</p>${blocks.join('')}`
    + '<p style="margin:18px 0 0;color:#5d6b7a;font-size:13px">'
    + 'Until a count is agreed, the stock figures still say what they said before it was taken — so the '
    + 'shelf, the reports and the next count are all working from a number somebody has already found to '
    + 'be wrong. Agreeing or refusing it takes a moment; leaving it does not.'
    + '</p>';
}

/* ------------------------------- one count, told about the moment it is filed */

/**
 * The lines a single count is holding, worst first.
 *
 * The hourly digest says "Bar count, 6 lines, GH₵60" because it is summarising
 * several things at once. This one is about ONE count and can afford to say
 * what was actually short, which is the difference between an email that gets
 * read and one that gets archived: "Club · Large, 8 short" is a conversation
 * somebody can have with the person who counted it, tonight.
 *
 * @param {Array} rows  Held shift_stock_checks for one shift and phase.
 * @param {Record<string,string>} shelves  Ingredient names by id.
 */
export function countLines(rows, shelves = {}) {
  return rows
    .filter((r) => r.applied === false && !r.approved_at && !r.rejected_at)
    .map((r) => ({
      name: shelves[r.ingredient_id] || 'A shelf no longer named',
      variance: r.variance_qty || 0,
      value: Math.abs(r.variance_value || 0),
      counted: r.counted_qty,
      expected: r.theoretical_qty,
    }))
    // Biggest loss first. A list in the order the shelves happen to be walked
    // buries the eight missing bottles under a tonic that is one over.
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}

/** What a single held count is called in a subject line. */
export function countSubject(opts) {
  const where = opts.phase === 'open' ? 'counting in' : 'counting out';
  const n = opts.lines;
  return `${n} ${n === 1 ? 'difference' : 'differences'} on the bar count (${where})`
    + `${opts.shortValue > 0 ? `, ${opts.money(opts.shortValue)} short` : ''}`;
}

/**
 * The body for one count.
 *
 * Says what is short and by how much, who counted it, and — the part that
 * decides whether anybody acts — that the shelf has NOT moved. Somebody who
 * thinks the figures have already been corrected has no reason to open
 * anything.
 */
export function countBody(opts) {
  const lis = opts.lines
    .map((l) => {
      const short = l.variance < 0;
      const many = Math.abs(l.variance);
      return `<li><strong>${l.name}</strong> — ${many} ${short ? 'short' : 'over'}`
        + `${l.value > 0 ? `, ${opts.money(l.value)}` : ''}`
        + (l.expected !== undefined && l.counted !== undefined
          ? `<br><span style="color:#5d6b7a">Should have been ${l.expected}, counted ${l.counted}</span>`
          : '')
        + '</li>';
    })
    .join('');

  return `<p style="margin:0 0 12px">${opts.who ? `${opts.who} counted the bar` : 'The bar was counted'}`
    + `${opts.phase === 'open' ? ' in at the start of the shift' : ' out at the end of the shift'}`
    + ' and found these differences:</p>'
    + `<ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.7">${lis}</ul>`
    + '<p style="margin:18px 0 0;color:#5d6b7a;font-size:13px">'
    + '<strong>The stock figures have not moved.</strong> A count that finds a difference waits for somebody '
    + 'who can see the whole business to agree to it, which is why this email exists. Until then the shelf '
    + 'still says what it said before the count — so the next count, and every report built on it, is working '
    + 'from a number this one has already found to be wrong. Agree or refuse it under Money, Waiting for you.'
    + '</p>';
}
