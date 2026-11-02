/**
 * What each member of staff has on, for the group hub's Team page.
 *
 * Insight (the hub) builds one page per business of who is doing what: what
 * each person has coming up, is in the middle of, has finished, has let run
 * over, has asked somebody else for, and what is holding them back. This is
 * the POS's half, one signed, read-only path:
 *
 *   POST /team/activity   { emails: [...], from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
 *
 * It answers, for every email asked about, whether the POS knows them and
 * their items: shifts they opened or closed, spends they recorded, orders to
 * suppliers they made, counts they took (bar, kitchen, store room and shop)
 * and what they were charged for a count difference. Everything still open
 * now, plus anything made, due or finished in the period.
 *
 * WHO. A person is a POS login with that email and a staff profile (by the
 * login's id, or by the email). Rows name people by their login's id, and on
 * a shared till sometimes by their profile's id, so both are looked for.
 *
 * READ ONLY. Nothing is written, not even an audit row: this is a report.
 *
 * READ ONCE. Each collection is read for the whole team at once, a hundred
 * ids at a time: once for what changed since the start of the period, once
 * for what is still open. Never a read per person.
 *
 * SIGNED like the Approvals paths (see insight-approvals.js): X-Till-At and
 * X-Till-Sig, HMAC-SHA256 with INSIGHT_SSO_SECRET over "till-link", the
 * time, the path and the body, each on its own line, within five minutes.
 *
 * See docs/22-insight-team.md.
 */
import { signedByHub } from './insight-approvals.js';

const PATH = '/team/activity';
export const MAX_EMAILS = 200;
export const MAX_DAYS = 100;
const DAY_MS = 86_400_000;
/** Appwrite takes at most a hundred values in one equal(). */
const CHUNK = 100;

const fail = (message, status) => Object.assign(new Error(message), { status });

/** Every document matching, a page at a time. */
async function listAll(db, DB_ID, Query, table, queries = []) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 50; page += 1) {
    const q = [...queries, Query.limit(100), ...(cursor ? [Query.cursorAfter(cursor)] : [])];
    const { documents } = await db.listDocuments(DB_ID, table, q);
    out.push(...documents);
    if (documents.length < 100) break;
    cursor = documents[documents.length - 1].$id;
  }
  return out;
}

const chunks = (list, size = CHUNK) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/** Rows from several reads, each once. */
const unique = (rows) => [...new Map(rows.map((r) => [r.$id, r])).values()];

/* ------------------------------------------------------------- dates */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (s) => DATE.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const ms = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};
/** The day something happened. The business is in Accra, which keeps UTC all year. */
export const dayOf = (iso) => {
  const t = ms(iso);
  return t === null ? null : new Date(t).toISOString().slice(0, 10);
};
const iso = (v) => (ms(v) === null ? null : new Date(ms(v)).toISOString());
/** Days between two moments, to a tenth, never negative. 0 when either is unknown. */
export const daysBetween = (a, b) => {
  const x = ms(a);
  const y = ms(b);
  if (x === null || y === null) return 0;
  return Math.max(0, Math.round(((y - x) / DAY_MS) * 10) / 10);
};

/** The period asked for, checked: both days real, in order, at most MAX_DAYS. */
export function periodOf(body) {
  const from = String(body?.from || '');
  const to = String(body?.to || '');
  if (!validDay(from) || !validDay(to)) throw fail('from and to must be days, YYYY-MM-DD.', 400);
  if (from > to) throw fail('from must not be after to.', 400);
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (days > MAX_DAYS) throw fail(`At most ${MAX_DAYS} days at a time.`, 400);
  return { from, to, fromIso: `${from}T00:00:00.000Z`, toIso: `${to}T23:59:59.999Z` };
}

/** The emails asked about, lower case, each once. */
export function emailsOf(body) {
  if (!Array.isArray(body?.emails)) throw fail('Whose activity? Send emails as a list.', 400);
  if (body.emails.length > MAX_EMAILS) throw fail(`At most ${MAX_EMAILS} people at a time.`, 400);
  return [...new Set(body.emails.map((e) => String(e ?? '').trim().toLowerCase()).filter(Boolean))];
}

/* ------------------------------------------------------------ people */

/**
 * The people asked about: each email's login and staff profile, or not found.
 * Logins are looked up a hundred emails at a time, profiles likewise.
 */
export async function findPeople({ users, db, DB_ID, Query }, emails) {
  const userByEmail = new Map();
  for (const part of chunks(emails)) {
    const found = await users.list([Query.equal('email', part), Query.limit(CHUNK)]);
    for (const u of found.users || []) {
      const e = String(u.email || '').toLowerCase();
      if (part.includes(e) && !userByEmail.has(e)) userByEmail.set(e, u);
    }
  }
  const userIds = [...userByEmail.values()].map((u) => u.$id);
  const profiles = [];
  for (const part of chunks(userIds)) profiles.push(...await listAll(db, DB_ID, Query, 'staff_profiles', [Query.equal('user_id', part)]));
  for (const part of chunks(emails)) profiles.push(...await listAll(db, DB_ID, Query, 'staff_profiles', [Query.equal('email', part)]));
  const all = unique(profiles);
  // The profile that is theirs: by login first, an active one before an old one.
  const rank = (p, user) => (p.user_id === user.$id ? 0 : 2) + (p.active === false ? 1 : 0);

  const people = new Map();
  for (const email of emails) {
    const user = userByEmail.get(email);
    const profile = user
      ? all.filter((p) => p.user_id === user.$id || (String(p.email || '').toLowerCase() === email && (!p.user_id || p.user_id === user.$id)))
        .sort((a, b) => rank(a, user) - rank(b, user))[0]
      : null;
    people.set(email, user && profile
      ? { email, found: true, user, profile, ids: [user.$id, profile.$id].filter(Boolean) }
      : { email, found: false, ids: [] });
  }
  return people;
}

/* ---------------------------------------------------- building items */

const SIDES = ['kitchen', 'bar', 'craft'];
const sideOf = (m, fallback = null) => (SIDES.includes(m) ? m : fallback);
const place = (side) => (side === 'kitchen' ? 'Kitchen' : side === 'craft' ? 'Shop' : 'Bar');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Every field the contract has, so no item is missing one. */
const item = (fields) => ({
  id: '', app: 'pos', kind: '', title: '', status: 'open', routine: false, asked: false, decision: null,
  due: null, created_at: null, started_at: null, done_at: null,
  waiting_on: null, waiting_since: null, waited_days: 0, reopened: 0,
  category: null, money_issue: false, amount: null, link: null,
  ...fields,
});

const linkTo = (appUrl, hash) => (appUrl ? `${String(appUrl).replace(/\/+$/, '')}/#${hash}` : null);

/** A shift, for the person who opened it or closed it. */
export function shiftItem(s, { appUrl = '' } = {}) {
  const side = sideOf(s.module, 'kitchen');
  const closed = s.status === 'closed';
  return item({
    id: `shift:${s.$id}`,
    kind: 'shift',
    title: `${place(side)} shift`,
    status: closed ? 'done' : 'doing',
    routine: closed,
    due: dayOf(s.opened_at),
    created_at: iso(s.$createdAt),
    started_at: iso(s.opened_at),
    done_at: closed ? iso(s.closed_at) : null,
    reopened: s.status === 'reopened' ? 1 : 0,
    category: side,
    link: linkTo(appUrl, '/shifts'),
  });
}

const SPEND_DECISION = { pending: 'waiting', approved: 'approved', rejected: 'refused' };

/**
 * A spend recorded at the till. Asked for when it needs somebody else's
 * approval; `decidedAt` is when that came, from the audit trail.
 */
export function spendItem(x, { appUrl = '', decidedAt = null, now = new Date().toISOString() } = {}) {
  const decision = SPEND_DECISION[x.approval_status] ?? null;
  const waiting = decision === 'waiting';
  const decided = decision === 'approved' || decision === 'refused';
  const by = x.payee || x.category_key || x.category || 'from the drawer';
  const when = decided ? (decidedAt || x.$updatedAt || null) : null;
  return item({
    id: `spend:${x.$id}`,
    kind: 'spend',
    title: `Spend · ${by}`,
    status: waiting ? 'open' : 'done',
    asked: waiting || (decided && (!x.approved_by || x.approved_by !== x.created_by)),
    decision,
    created_at: iso(x.$createdAt),
    started_at: iso(x.$createdAt),
    done_at: waiting ? null : iso(when || x.$createdAt),
    waiting_on: waiting ? `Approval of the spend to ${by}` : null,
    waiting_since: waiting ? iso(x.$createdAt) : null,
    waited_days: waiting ? daysBetween(x.$createdAt, now) : decided ? daysBetween(x.$createdAt, when) : 0,
    category: sideOf(x.module, 'kitchen'),
    amount: Number(x.amount) || 0,
    link: linkTo(appUrl, waiting ? '/waiting?show=spend' : '/expenses'),
  });
}

const ORDER_STATUS = { draft: 'open', waiting: 'open', ready: 'open', sent: 'doing', part: 'doing', received: 'done', cancelled: 'cancelled', refused: 'cancelled' };

/**
 * An order to a supplier. Asked for when it went over the limit: waiting, or
 * decided by somebody other than the person who made it. `refusedTimes` is
 * how many refusals the audit trail has for it.
 */
export function orderItem(o, { appUrl = '', refusedTimes = 0, now = new Date().toISOString() } = {}) {
  const status = ORDER_STATUS[o.status] ?? 'open';
  const waiting = o.status === 'waiting';
  const refused = o.status === 'refused';
  // A decision another person made, before it went on to be sent or received.
  const decidedByOther = !!o.approved_at && !!o.approved_by && o.approved_by !== o.created_by;
  const decision = waiting ? 'waiting' : refused ? 'refused' : decidedByOther ? 'approved' : null;
  // Refused, changed and asked again: the earlier decision is still on the row.
  const askedAgain = waiting && !!o.approved_at;
  const reopened = Math.max(refusedTimes - (refused ? 1 : 0), askedAgain ? 1 : 0, 0);
  // Since it was asked: when the admins were told, else when it was made. Asked again, since the refusal.
  const since = askedAgain ? o.approved_at : (o.admin_told_at || o.$createdAt);
  const name = o.po_no || 'Purchase order';
  return item({
    id: `order:${o.$id}`,
    kind: 'order',
    title: `${name} · ${o.supplier_name || 'a supplier'}`,
    status,
    asked: waiting || refused || decidedByOther,
    decision,
    due: validDay(o.expected_on) ? o.expected_on : null,
    created_at: iso(o.$createdAt),
    started_at: iso(o.sent_at),
    done_at: o.status === 'received' ? iso(o.received_at || o.$updatedAt)
      : refused ? iso(o.approved_at || o.$updatedAt)
        : o.status === 'cancelled' ? iso(o.$updatedAt) : null,
    waiting_on: waiting ? `Approval of ${name} (over the limit)` : null,
    waiting_since: waiting ? iso(since) : null,
    waited_days: waiting ? daysBetween(since, now) : (decision ? daysBetween(o.admin_told_at || o.$createdAt, o.approved_at) : 0),
    reopened,
    category: sideOf(o.module, 'kitchen'),
    amount: Number(o.total) || 0,
    link: linkTo(appUrl, `/purchase-orders?show=${o.$id}`),
  });
}

/**
 * One count of a shelf: one shift, one end of it, the lines one person
 * filed. Held while any difference waits for an admin. `chargeIds` are the
 * charges this person carries, so a shortage put down to them shows.
 */
export function countItem(lines, { appUrl = '', shift = null, chargeIds = new Set(), charges = [], now = new Date().toISOString() } = {}) {
  const first = lines[0];
  const shiftId = String(first.shift_id || '');
  const phase = first.phase || 'close';
  const store = shiftId.startsWith('store:');
  const side = sideOf(first.module, sideOf(shift?.module, 'bar'));
  const at = lines.map((l) => l.$createdAt).filter(Boolean).sort()[0] || null;
  const pending = lines.filter((l) => l.applied === false && !l.rejected_at && !l.undone_at);
  const moved = lines.filter((l) => Number(l.variance_qty || 0) !== 0 && l.applied !== false && !l.rejected_at);
  const latest = (key) => lines.map((l) => l[key]).filter(Boolean).sort().at(-1) || null;
  const approvedAt = latest('approved_at');
  const rejectedAt = latest('rejected_at');
  const undoneAt = latest('undone_at');
  const held = pending.length > 0;
  const decision = held ? 'waiting'
    : rejectedAt && moved.length === 0 ? 'refused'
      : approvedAt ? 'approved' : null;
  const decidedAt = decision === 'refused' ? rejectedAt : decision === 'approved' ? approvedAt : null;
  // Done again after a refusal: lines filed after a refusal of the same count.
  const refusals = [...new Set(lines.map((l) => l.rejected_at).filter(Boolean).map((t) => String(t).slice(0, 16)))];
  const reopened = refusals.filter((r) => lines.some((l) => !l.rejected_at && l.$createdAt && String(l.$createdAt).slice(0, 16) > r)).length;
  const heldSince = held ? pending.map((l) => l.$createdAt).filter(Boolean).sort()[0] || at : null;
  return item({
    id: `count:${shiftId}|${phase}`,
    kind: 'count',
    title: store ? 'Store room count' : `${place(side)} count`,
    status: undoneAt ? 'cancelled' : held ? 'open' : 'done',
    routine: !held && !undoneAt,
    decision,
    due: store ? dayOf(at) : dayOf(shift?.opened_at) || dayOf(at),
    created_at: iso(at),
    started_at: iso(at),
    done_at: held ? null : iso(undoneAt || decidedAt || at),
    waiting_on: held ? `Count held: ${plural(pending.length, 'line differs', 'lines differ')}, an admin decides` : null,
    waiting_since: held ? iso(heldSince) : null,
    waited_days: held ? daysBetween(heldSince, now) : decidedAt ? daysBetween(at, decidedAt) : 0,
    reopened,
    category: side,
    money_issue: lines.some((l) => l.charge_id && chargeIds.has(l.charge_id))
      || charges.some((ch) => chargeIds.has(ch.$id) && ch.direction !== 'credit' && ch.count_ref === `${shiftId}|${phase}`),
    amount: null,
    link: held ? linkTo(appUrl, '/waiting?show=count') : null,
  });
}

const SHOP_DECISION = { pending: 'waiting', approved: 'approved', rejected: 'refused' };

/** A count of the shop's shelf, which waits for an admin whenever it found a difference. */
export function shopCountItem(c, { appUrl = '', shift = null, chargeIds = new Set(), charges = [], now = new Date().toISOString() } = {}) {
  const held = c.status === 'pending';
  const at = c.counted_at || c.$createdAt;
  const decision = SHOP_DECISION[c.status] ?? null;
  const lines = Number(c.line_count) || 0;
  return item({
    id: `shop_count:${c.$id}`,
    kind: 'shop_count',
    title: c.note === 'Changed on the products page.' ? 'Shop shelf change' : 'Shop count',
    status: held ? 'open' : 'done',
    routine: !held,
    // Only a count that found a difference waits for anybody.
    decision: lines > 0 || c.reviewed_at ? decision : null,
    due: dayOf(shift?.opened_at) || dayOf(at),
    created_at: iso(c.$createdAt),
    started_at: iso(at),
    done_at: held ? null : iso(c.reviewed_at || at),
    waiting_on: held ? `Shop count held: ${plural(lines, 'line differs', 'lines differ')}, an admin decides` : null,
    waiting_since: held ? iso(at) : null,
    waited_days: held ? daysBetween(at, now) : c.reviewed_at ? daysBetween(at, c.reviewed_at) : 0,
    category: 'craft',
    money_issue: charges.some((ch) => chargeIds.has(ch.$id) && ch.direction !== 'credit' && ch.count_ref === c.$id),
    link: held ? linkTo(appUrl, '/waiting?show=count') : null,
  });
}

/** A count difference charged to the person (or a surplus credited to them). */
export function chargeItem(ch, { appUrl = '' } = {}) {
  const credit = ch.direction === 'credit';
  const settled = ch.status === 'settled';
  const what = String(ch.item_name || '').trim();
  return item({
    id: `charge:${ch.$id}`,
    kind: 'charge',
    title: `${credit ? 'Credited for a count surplus' : 'Charged for a count difference'}${what ? ` · ${what}` : ''}`,
    status: settled ? 'done' : 'open',
    created_at: iso(ch.charged_at || ch.$createdAt),
    started_at: iso(ch.charged_at || ch.$createdAt),
    done_at: settled ? iso(ch.$updatedAt) : null,
    category: sideOf(ch.module, 'bar'),
    money_issue: !credit,
    amount: Number(ch.amount) || 0,
    link: linkTo(appUrl, '/staff-owing'),
  });
}

/** Whether an item belongs on the page: still open, or made, due or finished in the period. */
export function inPeriod(it, { from, to }) {
  if (it.status === 'open' || it.status === 'doing') return true;
  const days = [it.due, dayOf(it.created_at), dayOf(it.started_at), dayOf(it.done_at)].filter(Boolean);
  return days.some((d) => d >= from && d <= to);
}

/* ------------------------------------------------------------ reading */

/**
 * Rows of one collection that name any of these people in `field`: those
 * changed since the start of the period, and those still open. A hundred ids
 * per read; the same row from both reads once.
 */
async function rowsFor({ db, DB_ID, Query }, table, field, ids, since, open) {
  const out = [];
  for (const part of chunks(ids)) {
    out.push(...await listAll(db, DB_ID, Query, table, [Query.equal(field, part), Query.greaterThanEqual('$updatedAt', since)]));
    if (open) out.push(...await listAll(db, DB_ID, Query, table, [Query.equal(field, part), open]));
  }
  return unique(out);
}

/**
 * Everything of theirs, for each person: the items, in the hub's shape,
 * newest first. Each collection is read once for everybody.
 */
export async function teamActivity({ db, DB_ID, Query, people, period, appUrl = '', now = new Date().toISOString(), error }) {
  const found = [...people.values()].filter((p) => p.found);
  const ids = [...new Set(found.flatMap((p) => p.ids))];
  const profileIds = found.map((p) => p.profile.$id);
  const owner = new Map();
  for (const p of found) for (const id of p.ids) if (!owner.has(id)) owner.set(id, p.email);
  const since = period.fromIso;
  const ctx = { db, DB_ID, Query };
  const failed = [];
  const read = async (label, work) => {
    try { return await work(); } catch (e) { failed.push(label); error?.(`Team activity: ${label}: ${e.message}`); return []; }
  };

  const none = ids.length === 0;
  const [opened, closed, spends, orders, checks, shopCounts, charges] = none ? [[], [], [], [], [], [], []] : await Promise.all([
    read('shifts', () => rowsFor(ctx, 'shifts', 'opened_by', ids, since, Query.equal('status', ['open', 'closing', 'reopened']))),
    read('shifts', () => rowsFor(ctx, 'shifts', 'closed_by', ids, since, null)),
    read('spends', () => rowsFor(ctx, 'shift_expenses', 'created_by', ids, since, Query.equal('approval_status', 'pending'))),
    read('orders', () => rowsFor(ctx, 'stock_orders', 'created_by', ids, since, Query.equal('status', ['draft', 'waiting', 'ready', 'sent', 'part']))),
    read('counts', () => rowsFor(ctx, 'shift_stock_checks', 'checked_by', ids, since, Query.equal('applied', false))),
    read('shop counts', () => rowsFor(ctx, 'stock_counts', 'counted_by', ids, since, Query.equal('status', 'pending'))),
    read('charges', () => rowsFor(ctx, 'staff_charges', 'person_id', profileIds, since, Query.equal('status', 'open'))),
  ]);
  const shifts = unique([...opened, ...closed]);

  // The shifts the counts were taken on, for the day they were due.
  const shiftById = new Map(shifts.map((s) => [s.$id, s]));
  const wanted = [...new Set([...checks.map((c) => c.shift_id), ...shopCounts.map((c) => c.shift_id)]
    .filter((id) => id && !String(id).startsWith('store:') && !shiftById.has(id)))];
  for (const part of chunks(wanted)) {
    const more = await read('shifts', () => listAll(db, DB_ID, Query, 'shifts', [Query.equal('$id', part)]));
    for (const s of more) shiftById.set(s.$id, s);
  }

  // When decided spends were decided, and how often orders were refused, from the audit trail.
  const decidedSpends = spends.filter((x) => ['approved', 'rejected'].includes(x.approval_status)).map((x) => x.$id);
  const audited = [...decidedSpends, ...orders.map((o) => o.$id)];
  const trail = [];
  for (const part of chunks(audited)) {
    trail.push(...await read('audit', () => listAll(db, DB_ID, Query, 'audit_log', [
      Query.equal('action', ['spend_approved', 'spend_refused', 'po_refused']), Query.equal('entity_id', part),
    ])));
  }
  const decidedAt = new Map();
  const refusedTimes = new Map();
  for (const a of trail) {
    if (a.action === 'po_refused') refusedTimes.set(a.entity_id, (refusedTimes.get(a.entity_id) || 0) + 1);
    else if (!decidedAt.has(a.entity_id) || a.$createdAt > decidedAt.get(a.entity_id)) decidedAt.set(a.entity_id, a.$createdAt);
  }

  const items = new Map(found.map((p) => [p.email, []]));
  const add = (personId, it) => {
    const email = owner.get(personId);
    if (!email) return;
    const list = items.get(email);
    if (!list.some((x) => x.id === it.id)) list.push(it);
  };

  for (const s of shifts) {
    const it = shiftItem(s, { appUrl });
    add(s.opened_by, it);
    if (s.closed_by && owner.get(s.closed_by) !== owner.get(s.opened_by)) add(s.closed_by, it);
  }
  for (const x of spends) add(x.created_by, spendItem(x, { appUrl, decidedAt: decidedAt.get(x.$id), now }));
  for (const o of orders) add(o.created_by, orderItem(o, { appUrl, refusedTimes: refusedTimes.get(o.$id) || 0, now }));

  const chargesOf = new Map();
  for (const ch of charges) {
    const email = owner.get(ch.person_id);
    if (!email) continue;
    if (!chargesOf.has(email)) chargesOf.set(email, new Set());
    chargesOf.get(email).add(ch.$id);
    add(ch.person_id, chargeItem(ch, { appUrl }));
  }

  // Counts: the lines one person filed for one shift and one end of it.
  const groups = new Map();
  for (const l of checks) {
    const email = owner.get(l.checked_by);
    if (!email) continue;
    const key = `${email}\n${l.shift_id || ''}|${l.phase || 'close'}`;
    if (!groups.has(key)) groups.set(key, { by: l.checked_by, lines: [] });
    groups.get(key).lines.push(l);
  }
  for (const { by, lines } of groups.values()) {
    add(by, countItem(lines, { appUrl, shift: shiftById.get(lines[0].shift_id) || null, chargeIds: chargesOf.get(owner.get(by)) || new Set(), charges, now }));
  }
  for (const c of shopCounts) {
    add(c.counted_by, shopCountItem(c, { appUrl, shift: shiftById.get(c.shift_id) || null, chargeIds: chargesOf.get(owner.get(c.counted_by)) || new Set(), charges, now }));
  }

  const out = {};
  for (const [email, p] of people) {
    const list = p.found ? (items.get(email) || []).filter((it) => inPeriod(it, period)) : [];
    list.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    out[email] = { found: p.found, items: list };
  }
  return { people: out, failed: [...new Set(failed)] };
}

/**
 * The path, for main.js. Returns null when the request is not for it, and
 * has already answered when it is.
 */
export async function handleInsightTeam({ req, res, db, DB_ID, users, Query, log, error, env = process.env, now }) {
  const path = String(req.path || '/').replace(/\/+$/, '') || '/';
  if (path !== PATH) return null;
  const send = (body, status = 200) => res.json(body, status);
  if (String(req.method || '').toUpperCase() !== 'POST') return send({ ok: false, error: 'POST only.' }, 405);
  const secret = env.INSIGHT_SSO_SECRET || '';
  if (!secret) return send({ ok: false, error: 'This POS is not connected to the group hub: INSIGHT_SSO_SECRET is not set.' }, 503);
  const bodyText = typeof req.bodyText === 'string' ? req.bodyText : typeof req.body === 'string' ? req.body : JSON.stringify(req.bodyJson ?? {});
  const header = (name) => req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  if (!signedByHub(secret, { at: header('x-till-at'), sig: header('x-till-sig'), path, bodyText })) {
    return send({ ok: false, error: 'That request did not come from the group hub.' }, 401);
  }
  let body;
  try { body = JSON.parse(bodyText || '{}'); } catch { return send({ ok: false, error: 'That was not JSON.' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return send({ ok: false, error: 'That was not a JSON object.' }, 400);
  try {
    const emails = emailsOf(body);
    const period = periodOf(body);
    const people = await findPeople({ users, db, DB_ID, Query }, emails);
    const out = await teamActivity({ db, DB_ID, Query, people, period, appUrl: env.APP_URL || '', now: now || new Date().toISOString(), error });
    log?.(`Team activity for ${emails.length} ${emails.length === 1 ? 'person' : 'people'}, ${period.from} to ${period.to}, from Insight.`);
    return send({ ok: true, people: out.people, ...(out.failed.length ? { failed: out.failed } : {}) });
  } catch (e) {
    if (!e.status) error?.(`Team activity from Insight: ${e.message}`);
    return send({ ok: false, error: e.message }, e.status || 500);
  }
}
