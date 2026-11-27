/**
 * Follow-ups the system raises itself, closes itself, and emails each morning.
 *
 * Run on the hourly timer. Each kind of follow-up has a key that names what
 * it is about (review:<charge>, nocount:<shift>:close, hive:2026-11), so it
 * is raised once however often the sweep runs, and closed by the sweep when
 * the thing is done: the difference decided, the count filed, the month sent.
 *
 *   review    a count difference waiting on a decision (explained, offered
 *             back, or a decision taken back): for the auditor
 *   confirm   an auditor's recommendation above their limit: for a manager
 *   putback   a put-back agreed two days ago and not yet in a drawer: auditor
 *   nocount   a shift that opened or closed without its count: auditor
 *   approval  a count waiting on approval for more than a day: manager
 *   overtime  a shift open past its time limit: manager
 *   hive      final deductions for a month not yet sent to HIVE: admin
 *
 * Each morning, at the hour set on Count differences, everybody with
 * something due or overdue gets one email listing it. Anything two days
 * overdue also goes to the admins. Each follow-up is named once a day.
 *
 * Pure rules first (wantedFollowUps), then the database. See core/follow-ups.ts.
 */

export const SYSTEM = 'system';
const SHIFT_LIMIT_HOURS = 24;
const DAY = 86_400_000;

/** YYYY-MM-DD where the business is. */
export function localDay(at, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: timeZone || 'UTC' }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

export function localHour(at, timeZone) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: timeZone || 'UTC' }).format(new Date(at)));
  } catch {
    return new Date(at).getUTCHours();
  }
}

export function addDays(day, n) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1) + n * DAY).toISOString().slice(0, 10);
}

const lastDayOf = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** The sides that count in at open and out at close. Same as countsInAtOpen in core. */
export function countsAtEnd(module, settings) {
  const m = module || 'kitchen';
  return m === 'bar' || m === 'craft' || (m === 'kitchen' && settings?.kitchen_stock_check === 'count');
}

const wantsManager = (c) => c.answer === 'explain' || c.answer === 'putback';
const isFinalDeduction = (c) => (c.decision === 'deduct' || (c.decision === 'part' && (c.decided_amount || 0) > 0));

/**
 * What should be open right now, from the facts. Each is
 * { auto_key, title, ref_kind, ref_id, ref_label, for_role, due_on }.
 */
export function wantedFollowUps(facts, { now, timeZone, money, settings = {} }) {
  const out = [];
  const today = localDay(now, timeZone);
  const t = new Date(now).getTime();
  const name = (id) => facts.people?.find((p) => p.user_id === id || p.$id === id)?.display_name || 'whoever ran it';

  for (const c of facts.charges || []) {
    if (c.decision === 'pending' && c.recommended_decision) {
      out.push({
        auto_key: `confirm:${c.$id}`,
        title: `Confirm ${c.recommended_name || 'the auditor'}'s recommendation on ${c.person_name}'s count difference (${money(c.amount)})`,
        ref_kind: 'charge', ref_id: c.$id, ref_label: c.person_name, for_role: 'manager',
        due_on: addDays(localDay(c.recommended_at || c.charged_at, timeZone), 1),
      });
    } else if (c.decision === 'pending' && (wantsManager(c) || c.reopened_by)) {
      out.push({
        auto_key: `review:${c.$id}`,
        title: `Decide ${c.person_name}'s count difference (${money(c.amount)})`,
        ref_kind: 'charge', ref_id: c.$id, ref_label: c.person_name, for_role: 'auditor',
        due_on: addDays(localDay(c.charged_at, timeZone), 1),
      });
    }
    if (c.decision === 'putback' && c.status === 'open' && c.decided_at && t - new Date(c.decided_at).getTime() > 2 * DAY) {
      out.push({
        auto_key: `putback:${c.$id}`,
        title: `Check ${c.person_name} put back ${money(Math.max(0, (c.amount || 0) - (c.settled_total || 0)))} as agreed`,
        ref_kind: 'charge', ref_id: c.$id, ref_label: c.person_name, for_role: 'auditor',
        due_on: addDays(localDay(c.decided_at, timeZone), 2),
      });
    }
  }

  // Counts nobody filed. The rows say which ends of which shifts were counted.
  const counted = new Set((facts.countedEnds || []).map((x) => `${x.shift_id}|${x.phase}`));
  for (const s of facts.shifts || []) {
    if (!countsAtEnd(s.module, settings)) continue;
    const code = s.code || 'A shift';
    if (s.opened_at && t - new Date(s.opened_at).getTime() > 60 * 60_000 && !counted.has(`${s.$id}|open`)) {
      out.push({
        auto_key: `nocount:${s.$id}:open`,
        title: `${code} opened with no start-of-shift count: ask ${name(s.opened_by)}`,
        ref_kind: 'shift', ref_id: s.$id, ref_label: code, for_role: 'auditor',
        due_on: localDay(s.opened_at, timeZone),
      });
    }
    if (s.status === 'closed' && s.closed_at && !counted.has(`${s.$id}|close`)) {
      out.push({
        auto_key: `nocount:${s.$id}:close`,
        title: `${code} closed with no end-of-shift count: ask ${name(s.closed_by || s.opened_by)}`,
        ref_kind: 'shift', ref_id: s.$id, ref_label: code, for_role: 'auditor',
        due_on: localDay(s.closed_at, timeZone),
      });
    }
  }

  // Counts waiting on approval for more than a day.
  for (const w of facts.waitingCounts || []) {
    if (t - new Date(w.at).getTime() <= DAY) continue;
    out.push({
      auto_key: `approval:${w.key}`,
      title: `Approve or refuse ${w.label}`,
      ref_kind: 'count', ref_id: w.ref_id || '', ref_label: w.label, for_role: 'manager',
      due_on: addDays(localDay(w.at, timeZone), 1),
    });
  }

  // Shifts open past their limit.
  for (const s of facts.openShifts || []) {
    const limit = SHIFT_LIMIT_HOURS + Math.max(0, Math.min(24, Math.round(Number(s.extended_hours) || 0)));
    const hours = (t - new Date(s.opened_at).getTime()) / 3_600_000;
    if (!(hours > limit)) continue;
    out.push({
      auto_key: `overtime:${s.$id}`,
      title: `${s.code || 'A shift'} has been open ${Math.floor(hours)} hours: close it, or give it more time`,
      ref_kind: 'shift', ref_id: s.$id, ref_label: s.code || '', for_role: 'manager',
      due_on: today,
    });
  }

  // Final deductions not yet sent to HIVE: last month's, and this month's from the 25th.
  const thisMonth = today.slice(0, 7);
  const byMonth = new Map();
  for (const c of facts.decided || []) {
    if (!isFinalDeduction(c) || c.hive_sent_at || !c.decided_at) continue;
    const m = localDay(c.decided_at, timeZone).slice(0, 7);
    byMonth.set(m, (byMonth.get(m) || 0) + 1);
  }
  for (const [month, n] of byMonth) {
    if (month === thisMonth && Number(today.slice(8, 10)) < 25) continue;
    if (month > thisMonth) continue;
    const label = new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    out.push({
      auto_key: `hive:${month}`,
      title: `Send ${label} deductions to HIVE (${n} not sent)`,
      ref_kind: 'month', ref_id: month, ref_label: label, for_role: 'admin',
      due_on: lastDayOf(month),
    });
  }
  return out;
}

/**
 * Who each follow-up goes to by email this morning. Returns a map of
 * address → follow-ups. Two days overdue also goes to the admins.
 */
export function morningRecipients(due, people, today) {
  const active = (people || []).filter((p) => p.active !== false && p.email);
  const emails = (roles) => active.filter((p) => roles.includes(p.role)).map((p) => String(p.email).trim());
  const admins = emails(['admin']);
  const auditors = emails(['auditor']);
  const managers = emails(['manager']);
  const out = new Map();
  const add = (to, f) => { for (const a of to) out.set(a, [...(out.get(a) || []), f]); };
  for (const f of due) {
    let to;
    if (f.for_role === 'person') to = active.filter((p) => p.$id === f.for_id).map((p) => p.email);
    else if (f.for_role === 'auditor') to = auditors.length ? auditors : [...managers, ...admins];
    else if (f.for_role === 'manager') to = managers.length ? managers : admins;
    else to = admins;
    const late = f.due_on && f.due_on <= addDays(today, -2);
    add([...new Set([...to, ...(late ? admins : [])])], f);
  }
  return out;
}

/* ============================================================ database */

async function listAll(ctx, table, queries = []) {
  const { db, DB_ID, Query } = ctx;
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

const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

export async function sweepFollowUps(ctx, { now = new Date().toISOString(), settings = {}, remindHour = 8 } = {}) {
  const { Query } = ctx;
  const tz = settings.timezone || ctx.timeZone || 'UTC';
  const t = new Date(now).getTime();
  const week = new Date(t - 7 * DAY).toISOString();

  // Nothing to do until the database has follow-ups.
  let existing;
  try {
    existing = await listAll(ctx, 'follow_ups', [Query.equal('status', 'open'), Query.equal('kind', 'task')]);
  } catch {
    return { skipped: 'no follow_ups collection' };
  }
  const auto = existing.filter((f) => f.auto_key);

  // Shifts to check for missing counts: the last week, and any an open follow-up still names.
  const named = auto.filter((f) => f.auto_key.startsWith('nocount:')).map((f) => f.ref_id).filter(Boolean);
  const [recent, people, pending, putbacks, decided, checks, openShifts, shopWaiting] = await Promise.all([
    listAll(ctx, 'shifts', [Query.greaterThanEqual('opened_at', week)]).catch(() => []),
    listAll(ctx, 'staff_profiles').catch(() => []),
    listAll(ctx, 'staff_charges', [Query.equal('decision', 'pending')]).catch(() => []),
    listAll(ctx, 'staff_charges', [Query.equal('decision', 'putback'), Query.equal('status', 'open')]).catch(() => []),
    listAll(ctx, 'staff_charges', [Query.equal('decision', ['deduct', 'part'])]).catch(() => []),
    listAll(ctx, 'shift_stock_checks', [Query.equal('applied', false)]).catch(() => []),
    listAll(ctx, 'shifts', [Query.equal('status', 'open')]).catch(() => []),
    listAll(ctx, 'stock_counts', [Query.equal('status', 'pending')]).catch(() => []),
  ]);
  const extra = named.filter((id) => !recent.some((s) => s.$id === id));
  const older = extra.length ? await listAll(ctx, 'shifts', [Query.equal('$id', extra.slice(0, 100))]).catch(() => []) : [];
  const shifts = [...recent, ...older];
  const ids = shifts.map((s) => s.$id);
  const countedEnds = [];
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    const [stock, shop] = await Promise.all([
      listAll(ctx, 'shift_stock_checks', [Query.equal('shift_id', part)]).catch(() => []),
      listAll(ctx, 'stock_counts', [Query.equal('shift_id', part)]).catch(() => []),
    ]);
    for (const r of [...stock, ...shop]) if (r.shift_id && r.phase) countedEnds.push({ shift_id: r.shift_id, phase: r.phase });
  }

  // Counts waiting on approval, one per count.
  const waitingCounts = [];
  const groups = new Map();
  for (const l of checks.filter((x) => x.applied === false && !x.rejected_at)) {
    const key = `${l.shift_id}|${l.phase || 'close'}`;
    const g = groups.get(key) || { key, at: l.$createdAt, shift_id: l.shift_id, phase: l.phase || 'close' };
    if ((l.$createdAt || '') < (g.at || '')) g.at = l.$createdAt;
    groups.set(key, g);
  }
  const codeOf = (id) => [...shifts, ...openShifts].find((s) => s.$id === id)?.code;
  for (const g of groups.values()) {
    const store = String(g.shift_id || '').startsWith('store:');
    waitingCounts.push({
      key: g.key, at: g.at, ref_id: store ? '' : g.shift_id,
      label: store ? 'the store-room count' : `the ${g.phase === 'open' ? 'start' : 'end'}-of-shift count on ${codeOf(g.shift_id) || 'a shift'}`,
    });
  }
  for (const c of shopWaiting) {
    waitingCounts.push({ key: `shop:${c.$id}`, at: c.counted_at || c.$createdAt, ref_id: c.$id, label: 'the shop stocktake' });
  }

  const wanted = wantedFollowUps(
    { charges: [...pending, ...putbacks], decided, shifts, countedEnds, waitingCounts, openShifts, people },
    { now, timeZone: tz, money: ctx.money || ((n) => String(n)), settings },
  );
  const want = new Map(wanted.map((w) => [w.auto_key, w]));

  // Raise what is new; close what is done. A follow-up a person closed stays
  // closed; one the system closed comes back if its reason does.
  let raised = 0;
  let closed = 0;
  const keys = wanted.map((w) => w.auto_key);
  const known = [];
  for (let i = 0; i < keys.length; i += 100) {
    known.push(...await listAll(ctx, 'follow_ups', [Query.equal('auto_key', keys.slice(i, i + 100))]).catch(() => []));
  }
  for (const w of wanted) {
    const doc = known.find((k) => k.auto_key === w.auto_key);
    if (doc && (doc.status === 'open' || doc.done_by !== SYSTEM)) continue;
    const write = doc
      ? ctx.db.updateDocument(ctx.DB_ID, 'follow_ups', doc.$id, {
        status: 'open', done_at: null, done_by: '', done_name: '', done_note: '', title: w.title, due_on: w.due_on,
      })
      : ctx.db.createDocument(ctx.DB_ID, 'follow_ups', ctx.newId(), {
        venue_id: 'main', kind: 'task', status: 'open', note: '', for_id: '', for_name: '',
        created_by: SYSTEM, created_name: 'The system', ...w,
      });
    await write.then(() => { raised += 1; }).catch((e) => ctx.error?.(`Could not raise ${w.auto_key}: ${e.message}`));
  }
  for (const f of auto) {
    if (want.has(f.auto_key)) continue;
    await ctx.db.updateDocument(ctx.DB_ID, 'follow_ups', f.$id, {
      status: 'done', done_at: now, done_by: SYSTEM, done_name: 'The system', done_note: 'Dealt with: the system saw it was done.',
    }).then(() => { closed += 1; }).catch(() => undefined);
  }

  // The morning email.
  let emailed = 0;
  const today = localDay(now, tz);
  if (ctx.send && localHour(now, tz) >= remindHour) {
    const open = await listAll(ctx, 'follow_ups', [Query.equal('status', 'open'), Query.equal('kind', 'task')]).catch(() => []);
    const due = open.filter((f) => f.due_on && f.due_on <= today && f.reminded_on !== today);
    if (due.length) {
      const sorted = [...due].sort((a, b) => a.due_on.localeCompare(b.due_on));
      for (const [to, list] of morningRecipients(sorted, people, today)) {
        await ctx.send({
          to: [to],
          subject: `${list.length} follow-up${list.length === 1 ? '' : 's'} due today`,
          title: 'Due and overdue',
          body: list.map((f) => `<p style="margin:0 0 8px"><b>${esc(f.title)}</b><br><span style="color:#5d6b7a">${
            f.due_on < today ? `Overdue since ${esc(f.due_on)}` : 'Due today'}</span></p>`).join('')
            + '<p style="margin:12px 0 0;color:#5d6b7a">Open them under Today › To do, on the To follow up tab.</p>',
        }).then(() => { emailed += 1; }).catch((e) => ctx.error?.(`Could not email ${to} the follow-ups: ${e.message}`));
      }
      for (const f of due) {
        await ctx.db.updateDocument(ctx.DB_ID, 'follow_ups', f.$id, { reminded_on: today }).catch(() => undefined);
      }
    }
  }
  return { raised, closed, emailed };
}
