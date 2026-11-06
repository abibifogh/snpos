/**
 * Bar count differences on somebody's account, not final: the server's half.
 *
 * With Count differences switched on (feature count_charges), a bar count
 * takes effect the moment it is saved and the till writes one
 * approval_notices row of kind 'count_charge'. This is what happens next,
 * and it happens here because nobody below an admin may write staff_charges:
 *
 *   raiseCountCharge  the notice lands: work out who answers for the count,
 *                     net what was over against what was short at selling
 *                     price, and put it on their account as NOT FINAL with
 *                     a deadline. Tell them, and tell the managers.
 *   applyReply        a charge_replies row lands: the person's answer, a
 *                     manager's decision, or a decision taken back. Checked
 *                     here, then written onto the charge.
 *   sweepCountCharges hourly: anything accepted or unanswered past its
 *                     deadline is deducted; each morning the managers are
 *                     reminded of what waits for them; put-backs on closed
 *                     shifts the event missed are settled.
 *   settlePutbacks    a shift closes: what was put back into its drawer is
 *                     settled as paid back.
 *
 * The rules that decide money are kept here, beside the code that writes it,
 * and mirrored for the screens in packages/core/src/count-charges.ts. The
 * core tests check the two agree.
 *
 * Takes everything it touches as arguments, so the tests can run it against
 * a small fake database. See count-charges.test.mjs.
 */

export const ANSWER_HOURS = 24;
export const SYSTEM = 'system';

/* =============================================================== rules */

/**
 * What one unit of a shelf item sells for, from the drinks that pour it. The
 * same rule as sellingPricePerUnit in packages/core/src/staff-charges.ts: the
 * drink or size that takes only this item, closest to one unit per drink,
 * the cheaper of two equally close.
 */
export function sellingPricePerUnit(ingredientId, recipes, items, variants) {
  const takes = new Map();
  for (const r of recipes) {
    if (r.addon_option_id || !(Number(r.qty_per_unit ?? 0) > 0)) continue;
    const key = `${r.menu_item_id ?? ''}|${r.variant_id ?? ''}`;
    if (!takes.has(key)) takes.set(key, new Set());
    takes.get(key).add(r.ingredient_id);
  }
  let best = null;
  for (const r of recipes) {
    if (r.ingredient_id !== ingredientId || r.addon_option_id) continue;
    const q = Number(r.qty_per_unit ?? 0);
    if (!(q > 0)) continue;
    if ((takes.get(`${r.menu_item_id ?? ''}|${r.variant_id ?? ''}`)?.size ?? 0) !== 1) continue;
    const item = items.find((i) => i.$id === r.menu_item_id);
    const size = r.variant_id ? variants.find((v) => v.$id === r.variant_id) : undefined;
    const price = size ? size.price : item?.price;
    if (typeof price !== 'number' || !(price > 0)) continue;
    const distance = Math.abs(Math.log(q));
    const each = Math.round(price / q);
    if (!best || distance < best.distance - 1e-9 || (Math.abs(distance - best.distance) <= 1e-9 && each < best.price)) {
      best = { price: each, distance };
    }
  }
  return best ? best.price : null;
}

/** Over set against short, at the price given. See nettedCount in core. */
export function nettedCount(diffs) {
  const lines = [];
  let short = 0;
  let over = 0;
  for (const d of diffs) {
    const qty = Number((d.variance || 0).toFixed(4));
    if (qty === 0) continue;
    const price = Math.max(0, Math.round(d.price || 0));
    const amount = Math.round(Math.abs(qty) * price) * Math.sign(qty);
    if (amount < 0) short += -amount;
    else over += amount;
    lines.push({
      name: d.name, qty, unit_price: price, amount, basis: d.basis ?? 'selling',
      ...(d.ingredientId ? { ingredient_id: d.ingredientId } : {}),
    });
  }
  lines.sort((a, b) => a.amount - b.amount);
  return { lines, short, over, owed: Math.max(0, short - over) };
}

export const answerDeadline = (chargedAt, hours = ANSWER_HOURS) =>
  new Date(new Date(chargedAt).getTime() + Math.max(1, Number(hours) || ANSWER_HOURS) * 3_600_000).toISOString();

const wantsManager = (c) => c.answer === 'explain' || c.answer === 'putback';

/** Deducted at the deadline if accepted or unanswered. See autoDecision in core. */
export function autoDecision(c, now) {
  if (c.decision !== 'pending' || !c.answer_by) return null;
  if (c.reopened_by) return null;
  if (new Date(now).getTime() < new Date(c.answer_by).getTime()) return null;
  return wantsManager(c) ? null : 'deduct';
}

export function answerProblem(c, answer, note) {
  if (c.decision !== 'pending') return 'A manager has already decided this one.';
  if (!['accept', 'putback', 'explain'].includes(answer)) return 'Choose an answer first.';
  if (answer === 'explain' && String(note || '').trim().length < 3) return 'Say what happened, so the manager can decide.';
  return null;
}

export function decisionProblem(c, decision, amount, note) {
  if (c.decision !== 'pending') return 'This has already been decided. Undo that first.';
  if (!['deduct', 'part', 'waived', 'putback'].includes(decision)) return 'That is not a decision.';
  if (decision === 'part') {
    if (!Number.isFinite(amount) || !(amount > 0)) return 'Say how much to deduct.';
    if (amount >= (c.amount || 0)) return 'That is all of it. Use Deduct instead.';
    if (String(note || '').trim().length < 3) return 'Say why only part is deducted. They will see it.';
  }
  if (decision === 'waived' && String(note || '').trim().length < 3) return 'Say why it is waived. They will see it.';
  if (decision === 'putback' && c.answer !== 'putback') return 'Only when they have offered to put it back.';
  return null;
}

export function undoProblem(c) {
  if (!c.decision || c.decision === 'pending') return 'There is no decision to undo.';
  if (c.hive_sent_at) return 'This has gone to HIVE, so it is final.';
  if (c.decision === 'putback' && (c.putback_shift_id || c.status === 'settled')) return 'It has been put back already.';
  return null;
}

/**
 * The settlements a decision makes, so the charge is closed on the books.
 * Deduct: taken from pay. Part: that much from pay, the rest written off.
 * Waived: written off. Put back: nothing yet, until the drawer has it.
 */
export function decisionSettlements(c, decision, amount) {
  const left = Math.max(0, (c.amount || 0) - (c.settled_total || 0));
  if (left === 0) return [];
  if (decision === 'deduct') return [{ kind: 'pay', amount: left }];
  if (decision === 'part') {
    const take = Math.max(0, Math.min(left, Math.round(amount)));
    return [{ kind: 'pay', amount: take }, { kind: 'written_off', amount: left - take }].filter((s) => s.amount > 0);
  }
  if (decision === 'waived') return [{ kind: 'written_off', amount: left }];
  return [];
}

/**
 * Whether a row was written by this account.
 *
 * Appwrite lets an account grant a permission only to roles it holds itself,
 * so a row readable by user:X can only have been written by X (or by the
 * server). Used to know a decision came from the manager it names.
 */
export function writtenBy(row, userId) {
  if (!userId) return false;
  const perms = Array.isArray(row?.$permissions) ? row.$permissions : [];
  return perms.some((p) => String(p).replace(/\s+/g, '') === `read("user:${userId}")`);
}

/** The hour it is now where the business is. */
export function localHour(now, timeZone) {
  try {
    const h = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: timeZone || 'UTC' }).format(new Date(now));
    return Number(h);
  } catch {
    return new Date(now).getUTCHours();
  }
}

/** Today's date where the business is, as YYYY-MM-DD. */
export function localDay(now, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: timeZone || 'UTC' }).format(new Date(now));
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

const parse = (text, fallback) => {
  try { const v = JSON.parse(text || ''); return v ?? fallback; } catch { return fallback; }
};

/** "2 Club lager, 1 Gin 25cl", for a subject line and the charge's name. */
export function shortWords(lines, max = 3) {
  const short = lines.filter((l) => l.amount < 0);
  const shown = short.slice(0, max).map((l) => `${Math.abs(l.qty)} ${l.name}`);
  return shown.join(', ') + (short.length > max ? ` and ${short.length - max} more` : '');
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

/** The feature's row, or null when it is off or missing. */
export async function countChargesConfig(ctx, venueId = '') {
  const rows = await listAll(ctx, 'feature_flags', [ctx.Query.equal('key', 'count_charges')]).catch(() => []);
  // A venue's own row wins over the group's, the way the apps read it. See loadFeatures.
  const group = rows.find((r) => !r.venue_id);
  const own = venueId ? rows.find((r) => r.venue_id === venueId) : null;
  const row = own ?? group ?? null;
  if (!row || !row.enabled) return null;
  const read = (r) => (typeof r?.config === 'string' ? parse(r.config, {}) : (r?.config || {}));
  const cfg = { ...read(group), ...read(own) };
  return {
    answerHours: Number(cfg.answer_hours) > 0 ? Number(cfg.answer_hours) : ANSWER_HOURS,
    remindHour: Number.isFinite(Number(cfg.remind_hour)) ? Number(cfg.remind_hour) : 8,
  };
}

/** The staff profile behind a shift's opened_by, which is an account id, or a profile's where there is none. */
async function profileFor(ctx, who) {
  if (!who) return null;
  const byUser = await listAll(ctx, 'staff_profiles', [ctx.Query.equal('user_id', who)]).catch(() => []);
  if (byUser[0]) return byUser[0];
  return ctx.db.getDocument(ctx.DB_ID, 'staff_profiles', who).catch(() => null);
}

/** The bar shift before this one: whoever handed this bar over. */
async function shiftBefore(ctx, shift) {
  const rows = await listAll(ctx, 'shifts', [
    ctx.Query.equal('module', shift.module || 'bar'),
    ctx.Query.lessThan('opened_at', shift.opened_at),
  ]).catch(() => []);
  return rows
    .filter((s) => s.$id !== shift.$id && s.opened_at < shift.opened_at)
    .sort((a, b) => b.opened_at.localeCompare(a.opened_at))[0] ?? null;
}

/** Selling price for each item, falling back to cost where nothing sells it. */
async function pricesFor(ctx, ingredientIds) {
  const ids = [...new Set(ingredientIds)];
  if (ids.length === 0) return {};
  const [ingredients, recipes] = await Promise.all([
    listAll(ctx, 'ingredients', [ctx.Query.equal('$id', ids)]).catch(() => []),
    listAll(ctx, 'recipes').catch(() => []),
  ]);
  const drinks = new Set(recipes.filter((r) => ids.includes(r.ingredient_id)).map((r) => r.menu_item_id ?? ''));
  const mine = recipes.filter((r) => drinks.has(r.menu_item_id ?? ''));
  const itemIds = [...new Set(mine.map((r) => r.menu_item_id).filter(Boolean))];
  const variantIds = [...new Set(mine.map((r) => r.variant_id).filter(Boolean))];
  const [items, variants] = await Promise.all([
    itemIds.length ? listAll(ctx, 'menu_items', [ctx.Query.equal('$id', itemIds)]).catch(() => []) : [],
    variantIds.length ? listAll(ctx, 'product_variants', [ctx.Query.equal('$id', variantIds)]).catch(() => []) : [],
  ]);
  const out = {};
  for (const id of ids) {
    const ing = ingredients.find((i) => i.$id === id);
    const selling = sellingPricePerUnit(id, mine, items, variants);
    out[id] = selling
      ? { price: selling, basis: 'selling', name: ing?.name || 'An item' }
      : { price: Math.round(ing?.base_unit_cost || 0), basis: 'cost', name: ing?.name || 'An item' };
  }
  return out;
}

/** Admins and managers with an email, for a reminder or a heads-up. */
async function managers(ctx) {
  const rows = await listAll(ctx, 'staff_profiles').catch(() => []);
  return [...new Set(rows
    .filter((p) => p.active !== false && ['admin', 'manager'].includes(p.role) && p.email)
    .map((p) => String(p.email).trim()))];
}

async function settle(ctx, charge, { kind, amount, shiftId = '', methodId = '', note = '', by = SYSTEM, now }) {
  return ctx.db.createDocument(ctx.DB_ID, 'staff_charge_settlements', ctx.newId(), {
    venue_id: charge.venue_id,
    charge_id: charge.$id,
    person_id: charge.person_id,
    kind,
    amount,
    qty_found: 0,
    shift_id: shiftId,
    method_id: methodId,
    note: String(note || '').slice(0, 300),
    recorded_by: by,
    recorded_at: now,
  }, charge.person_user_id ? [ctx.readableBy(charge.person_user_id)] : []);
}

/* ================================================== a count took effect */

/**
 * The lines this notice is about: the count filed with it, not an earlier
 * one of the same shift. A bar counted out twice files two notices, and the
 * second count's differences are against the shelf the first one set.
 */
function linesOfThisFiling(rows, notice, earlier) {
  const upTo = notice.$createdAt || '9999';
  const after = earlier?.$createdAt || '';
  return rows.filter((r) => (r.$createdAt || '') <= upTo && (r.$createdAt || '') > after
    && !r.rejected_by && Number(r.variance_qty || 0) !== 0);
}

export async function raiseCountCharge(ctx, notice, { now = new Date().toISOString() } = {}) {
  if (notice.kind !== 'count_charge') return { skipped: notice.kind };
  if (notice.sent_at) return { already: true };
  const cfg = await countChargesConfig(ctx, notice.venue_id || '');
  if (!cfg) return { skipped: 'feature off' };

  // Once per notice, however many times the event arrives.
  const made = await listAll(ctx, 'staff_charges', [ctx.Query.equal('line_id', notice.$id)]).catch(() => []);
  if (made.length) return { already: true, chargeId: made[0].$id };

  const shift = await ctx.db.getDocument(ctx.DB_ID, 'shifts', notice.shift_id).catch(() => null);
  if (!shift) return { skipped: 'no shift' };
  const phase = notice.phase === 'open' ? 'open' : 'close';

  const notices = await listAll(ctx, 'approval_notices', [ctx.Query.equal('shift_id', shift.$id)]).catch(() => []);
  const earlier = notices
    .filter((n) => n.kind === 'count_charge' && (n.phase || 'close') === phase && n.$id !== notice.$id
      && (n.$createdAt || '') < (notice.$createdAt || ''))
    .sort((a, b) => (b.$createdAt || '').localeCompare(a.$createdAt || ''))[0];
  const rows = await listAll(ctx, 'shift_stock_checks', [
    ctx.Query.equal('shift_id', shift.$id), ctx.Query.equal('phase', phase),
  ]).catch(() => []);
  // The latest line for each item, in case one was counted twice in the filing.
  const latest = new Map();
  for (const r of linesOfThisFiling(rows, notice, earlier).filter((x) => (x.module || 'bar') === 'bar')) {
    const had = latest.get(r.ingredient_id);
    if (!had || (r.$createdAt || '') >= (had.$createdAt || '')) latest.set(r.ingredient_id, r);
  }
  const lines = [...latest.values()];
  const done = async (extra) => {
    await ctx.db.updateDocument(ctx.DB_ID, 'approval_notices', notice.$id, { sent_at: now, send_error: '' }).catch(() => undefined);
    return extra;
  };
  if (lines.length === 0) return done({ nothing: true });

  const prices = await pricesFor(ctx, lines.map((l) => l.ingredient_id));
  const net = nettedCount(lines.map((l) => ({
    name: prices[l.ingredient_id]?.name || 'An item',
    variance: Number(l.variance_qty || 0),
    price: prices[l.ingredient_id]?.price || 0,
    basis: prices[l.ingredient_id]?.basis,
    ingredientId: l.ingredient_id,
  })));
  if (net.owed <= 0) return done({ nothing: true, over: net.over, short: net.short });

  // Closing: this shift's. Opening: the shift that handed it over.
  const answerable = phase === 'close' ? shift : await shiftBefore(ctx, shift);
  const person = answerable ? await profileFor(ctx, answerable.opened_by) : null;
  if (!person) {
    const why = answerable ? 'whoever ran that shift has no staff profile' : 'there is no earlier bar shift to answer for it';
    await ctx.db.updateDocument(ctx.DB_ID, 'approval_notices', notice.$id, { send_error: `Not charged: ${why}.`.slice(0, 300) }).catch(() => undefined);
    ctx.error?.(`A bar count came up ${net.owed} short but was not charged: ${why}.`);
    await tellManagers(ctx, { owed: net.owed, lines: net.lines, why, phase });
    return { ok: false, why };
  }

  const charge = await ctx.db.createDocument(ctx.DB_ID, 'staff_charges', ctx.newId(), {
    venue_id: notice.venue_id || shift.venue_id || 'main',
    person_id: person.$id,
    person_user_id: person.user_id || '',
    person_name: person.display_name || 'Staff',
    source: 'bar_count',
    count_ref: `${shift.$id}|${phase}`,
    line_id: notice.$id,
    module: 'bar',
    item_name: `Bar count: ${shortWords(net.lines)}`.slice(0, 200),
    qty: 1,
    unit_price: net.owed,
    amount: net.owed,
    price_basis: net.lines.some((l) => l.basis === 'cost') ? 'custom' : 'selling',
    note: net.over > 0 ? `Over on the same count, set against it: ${net.over}` : '',
    charged_by: SYSTEM,
    charged_at: now,
    settled_total: 0,
    status: 'open',
    direction: 'owed',
    decision: 'pending',
    shift_id: shift.$id,
    phase,
    counted_by: notice.counted_by || '',
    lines: JSON.stringify(net.lines).slice(0, 4000),
    answer_by: answerDeadline(now, cfg.answerHours),
  }, person.user_id ? [ctx.readableBy(person.user_id)] : []);

  for (const l of lines) {
    await ctx.db.updateDocument(ctx.DB_ID, 'shift_stock_checks', l.$id, { charge_id: charge.$id }).catch(() => undefined);
  }
  await done({});
  await tellPerson(ctx, charge, person);
  await tellManagers(ctx, { owed: net.owed, lines: net.lines, person, phase, deadline: charge.answer_by });
  ctx.log?.(`Count difference of ${net.owed} on ${person.display_name}'s account, not final.`);
  return { ok: true, chargeId: charge.$id, owed: net.owed, person: person.$id };
}

/* =================================================== answers, decisions */

async function finish(ctx, reply, error, now) {
  await ctx.db.updateDocument(ctx.DB_ID, 'charge_replies', reply.$id, error
    ? { error: String(error).slice(0, 300), done_at: now }
    : { error: '', done_at: now }).catch(() => undefined);
  return error ? { ok: false, error } : { ok: true };
}

/** A decision, by a manager or by the clock, written onto the charge. */
export async function decide(ctx, charge, { decision, amount = 0, note = '', by = SYSTEM, byName = '', now }) {
  const problem = decisionProblem(charge, decision, amount, note);
  if (problem) throw Object.assign(new Error(problem), { status: 409 });
  const parts = decisionSettlements(charge, decision, amount);
  let settled = charge.settled_total || 0;
  for (const p of parts) {
    await settle(ctx, charge, { kind: p.kind, amount: p.amount, note: note || (p.kind === 'pay' ? 'Taken from pay' : 'Waived'), by, now });
    settled += p.amount;
  }
  const taken = decision === 'deduct' ? (charge.amount || 0) : decision === 'part' ? Math.round(amount) : 0;
  const patch = {
    decision,
    decided_by: by,
    decided_name: String(byName || '').slice(0, 120),
    decided_at: now,
    decided_note: String(note || '').slice(0, 500),
    decided_amount: taken,
    settled_total: settled,
    status: settled >= (charge.amount || 0) ? 'settled' : 'open',
  };
  await ctx.db.updateDocument(ctx.DB_ID, 'staff_charges', charge.$id, patch);
  return { ...charge, ...patch };
}

/** Take a decision back. The settlements it made come off the books. */
export async function undo(ctx, charge, { by, now }) {
  const problem = undoProblem(charge);
  if (problem) throw Object.assign(new Error(problem), { status: 409 });
  const rows = await listAll(ctx, 'staff_charge_settlements', [ctx.Query.equal('charge_id', charge.$id)]).catch(() => []);
  let removed = 0;
  for (const r of rows.filter((x) => x.kind === 'pay' || x.kind === 'written_off')) {
    await ctx.db.deleteDocument(ctx.DB_ID, 'staff_charge_settlements', r.$id);
    if (ctx.unpostSettlement) await ctx.unpostSettlement(r).catch((e) => ctx.error?.(`Books: ${e.message}`));
    removed += r.amount || 0;
  }
  const settled = Math.max(0, (charge.settled_total || 0) - removed);
  const patch = {
    decision: 'pending', decided_by: '', decided_name: '', decided_at: null, decided_note: '', decided_amount: 0,
    settled_total: settled, status: 'open', reopened_by: by,
  };
  await ctx.db.updateDocument(ctx.DB_ID, 'staff_charges', charge.$id, patch);
  return { ...charge, ...patch };
}

/**
 * Somebody said something about a charge: check it, then make it so.
 *
 * An answer is taken from the person the charge is on, as the till says they
 * are: on a shared till that is who unlocked it with their PIN. It decides
 * nothing; at worst it sends the charge to a manager.
 *
 * A decision or an undo is taken only from an admin or a manager, and only
 * when the row proves which account wrote it. See writtenBy.
 */
export async function applyReply(ctx, reply, { now = new Date().toISOString() } = {}) {
  if (reply.done_at) return { already: true };
  const charge = await ctx.db.getDocument(ctx.DB_ID, 'staff_charges', reply.charge_id).catch(() => null);
  if (!charge || !charge.decision) return finish(ctx, reply, 'That count difference could not be found.', now);

  try {
    if (reply.kind === 'answer') {
      const theirs = (reply.by_profile && reply.by_profile === charge.person_id)
        || (reply.by_user && charge.person_user_id && reply.by_user === charge.person_user_id);
      if (!theirs) return finish(ctx, reply, `Only ${charge.person_name} can answer this one.`, now);
      const problem = answerProblem(charge, reply.answer, reply.note);
      if (problem) return finish(ctx, reply, problem, now);
      await ctx.db.updateDocument(ctx.DB_ID, 'staff_charges', charge.$id, {
        answer: reply.answer,
        answer_note: String(reply.note || '').slice(0, 1000),
        answered_at: now,
        answered_by: reply.by_profile || reply.by_user || '',
      });
      ctx.log?.(`${charge.person_name} answered a count difference: ${reply.answer}.`);
      return finish(ctx, reply, null, now);
    }

    if (!writtenBy(reply, reply.by_user)) return finish(ctx, reply, 'Who decided this could not be confirmed.', now);
    const decider = await profileFor(ctx, reply.by_user);
    if (!decider || decider.active === false || !['admin', 'manager'].includes(decider.role)) {
      return finish(ctx, reply, 'Only an admin or a manager can decide a count difference.', now);
    }
    if (reply.kind === 'undo') {
      await undo(ctx, charge, { by: reply.by_user, now });
    } else if (reply.kind === 'decide') {
      await decide(ctx, charge, {
        decision: reply.decision, amount: Number(reply.amount || 0), note: reply.note || '',
        by: reply.by_user, byName: decider.display_name || reply.by_name || '', now,
      });
    } else {
      return finish(ctx, reply, 'That is not something that can be done to a count difference.', now);
    }
    ctx.log?.(`${decider.display_name} ${reply.kind === 'undo' ? 'took back the decision on' : `decided (${reply.decision})`} ${charge.person_name}'s count difference.`);
    return finish(ctx, reply, null, now);
  } catch (e) {
    return finish(ctx, reply, e.message, now);
  }
}

/* ============================================================ put back */

/**
 * What a closed shift's drawer took in for count differences put back, each
 * settled as paid back in cash into that drawer. The till added each one to
 * what the drawer should hold; if the drawer still came up short, that is the
 * shift's own shortage, the way it always was.
 */
export async function settlePutbacks(ctx, shift, { now = new Date().toISOString() } = {}) {
  if (!shift || shift.status !== 'closed') return { skipped: 'not closed' };
  const wanted = parse(shift.putbacks, []);
  if (!Array.isArray(wanted) || wanted.length === 0) return { none: true };
  const already = await listAll(ctx, 'staff_charge_settlements', [ctx.Query.equal('shift_id', shift.$id)]).catch(() => []);
  let settled = 0;
  for (const p of wanted) {
    if (!p?.charge_id || already.some((s) => s.charge_id === p.charge_id && s.kind === 'cash')) continue;
    const charge = await ctx.db.getDocument(ctx.DB_ID, 'staff_charges', p.charge_id).catch(() => null);
    if (!charge || charge.decision !== 'putback' || charge.status !== 'open') continue;
    const left = Math.max(0, (charge.amount || 0) - (charge.settled_total || 0));
    const amount = Math.min(left, Math.max(0, Math.round(p.amount || 0)));
    if (amount <= 0) continue;
    await settle(ctx, charge, {
      kind: 'cash', amount, shiftId: shift.$id, methodId: p.method_id || '',
      note: `Put back at shift ${shift.code || ''}`.trim(), by: shift.closed_by || SYSTEM, now,
    });
    const total = (charge.settled_total || 0) + amount;
    await ctx.db.updateDocument(ctx.DB_ID, 'staff_charges', charge.$id, {
      settled_total: total,
      status: total >= (charge.amount || 0) ? 'settled' : 'open',
      putback_shift_id: shift.$id,
    });
    settled += 1;
  }
  if (settled) ctx.log?.(`Shift ${shift.code || shift.$id}: ${settled} count difference${settled === 1 ? '' : 's'} put back.`);
  return { settled };
}

/* ============================================================== hourly */

export async function sweepCountCharges(ctx, { now = new Date().toISOString(), settings = {} } = {}) {
  const pending = await listAll(ctx, 'staff_charges', [ctx.Query.equal('decision', 'pending')]).catch(() => []);
  let deducted = 0;
  for (const c of pending) {
    if (autoDecision(c, now) !== 'deduct') continue;
    try {
      await decide(ctx, c, {
        decision: 'deduct', now, by: SYSTEM,
        byName: c.answer === 'accept' ? 'Accepted, deducted at the deadline' : 'No answer by the deadline',
      });
      deducted += 1;
    } catch (e) {
      ctx.error?.(`Could not deduct ${c.person_name}'s count difference: ${e.message}`);
    }
  }

  // Put-backs on shifts closed lately, in case the close event was missed.
  const since = new Date(new Date(now).getTime() - 3 * 86_400_000).toISOString();
  const closed = await listAll(ctx, 'shifts', [ctx.Query.equal('status', 'closed'), ctx.Query.greaterThanEqual('closed_at', since)]).catch(() => []);
  let putBack = 0;
  for (const s of closed.filter((x) => x.putbacks && x.putbacks !== '[]')) {
    putBack += (await settlePutbacks(ctx, s, { now }).catch(() => ({ settled: 0 }))).settled || 0;
  }

  // Each morning, once: what waits for a manager.
  const cfg = await countChargesConfig(ctx).catch(() => null);
  const remindHour = cfg?.remindHour ?? 8;
  const today = localDay(now, settings.timezone);
  let reminded = 0;
  if (localHour(now, settings.timezone) >= remindHour) {
    const waiting = pending
      .filter((c) => c.decision === 'pending' && !autoDecision(c, now))
      .filter((c) => wantsManager(c) || c.reopened_by || new Date(c.answer_by || 0).getTime() <= new Date(now).getTime())
      .filter((c) => c.reminded_on !== today);
    if (waiting.length && ctx.send) {
      const to = await managers(ctx);
      if (to.length) {
        await ctx.send({
          to,
          subject: `${waiting.length} count difference${waiting.length === 1 ? '' : 's'} waiting for you to decide`,
          title: 'Count differences to decide',
          body: waiting.map((c) => `<p style="margin:0 0 8px"><b>${esc(c.person_name)}</b> · ${ctx.money(c.amount)} · ${
            c.answer === 'explain' ? `explained: “${esc(c.answer_note)}”` : c.answer === 'putback' ? 'offered to put it back' : 'reopened'}</p>`).join('')
            + '<p style="margin:12px 0 0;color:#5d6b7a">Decide under Approvals › Count differences.</p>',
        });
        for (const c of waiting) {
          await ctx.db.updateDocument(ctx.DB_ID, 'staff_charges', c.$id, { reminded_on: today }).catch(() => undefined);
        }
        reminded = waiting.length;
      }
    }
  }
  return { deducted, putBack, reminded };
}

/* ============================================================== emails */

const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

function linesTable(ctx, lines) {
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">${lines.map((l) => `<tr>
    <td style="padding:4px 0">${esc(l.name)}</td>
    <td style="padding:4px 0;text-align:right">${l.qty < 0 ? `${Math.abs(l.qty)} short` : `${l.qty} over`}</td>
    <td style="padding:4px 0;text-align:right">${l.amount < 0 ? '' : '−'}${ctx.money(Math.abs(l.amount))}</td></tr>`).join('')}</table>`;
}

async function tellPerson(ctx, charge, person) {
  if (!ctx.send || !person.email) return;
  const until = new Date(charge.answer_by).toLocaleString('en-GB', {
    weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: ctx.timeZone || 'UTC',
  });
  await ctx.send({
    to: [person.email],
    subject: `Not final: ${ctx.money(charge.amount)} from a bar count`,
    title: 'A bar count came up short',
    body: `<p style="margin:0 0 10px">${esc(person.display_name)}, the bar count ${charge.phase === 'open' ? 'taken when the next shift counted in' : 'at the close of your shift'} came up ${ctx.money(charge.amount)} short at selling price.</p>
      ${linesTable(ctx, parse(charge.lines, []))}
      <p style="margin:12px 0 0"><b>This is not final.</b> You have until <b>${esc(until)}</b> to accept it, explain what happened, or offer to put it back at your next shift. Answer on the till. A manager makes the final call.</p>`,
  }).catch((e) => ctx.error?.(`Could not email ${person.display_name} about a count difference: ${e.message}`));
}

async function tellManagers(ctx, { owed, lines, person, phase, deadline, why }) {
  if (!ctx.send) return;
  const to = await managers(ctx);
  if (to.length === 0) return;
  const whose = person ? `on ${esc(person.display_name)}'s account, not final yet` : `not charged to anybody, because ${esc(why)}`;
  await ctx.send({
    to,
    subject: person ? `${person.display_name}: ${ctx.money(owed)} short on the bar count, not final` : `Bar count ${ctx.money(owed)} short, not charged`,
    title: 'A bar count came up short',
    body: `<p style="margin:0 0 10px">The bar count ${phase === 'open' ? 'at opening' : 'at close'} came up ${ctx.money(owed)} short, ${whose}.</p>
      ${linesTable(ctx, lines)}
      ${deadline ? '<p style="margin:12px 0 0;color:#5d6b7a">They have until the deadline to answer. If they accept or say nothing it is deducted then; if they explain or offer to put it back, it waits for you under Approvals › Count differences.</p>' : ''}`,
  }).catch((e) => ctx.error?.(`Could not email managers about a count difference: ${e.message}`));
}
