import {
  ACCOUNTS, shiftEntries, takingsByKind, cashVarianceOf, payoutLines, wasteLines,
  debitsForSpend, spendPostingLines, sameDebits, parseLevies, splitTax, vatBpOf, makersShareOf, isLocked,
} from './books.js';

/**
 * The books, written by the server.
 *
 * Every event that puts money on the books — a shift closing, a spend being
 * recorded or corrected or refused, a maker being paid, stock written off —
 * used to be posted by the browser that caused it, best effort, after the
 * event itself was saved. A till that lost its connection in between, or a
 * cashier who shut the lid, left the month short by that night and nothing
 * anywhere said so.
 *
 * So the browser writes the event and this writes the books, from the event,
 * when Appwrite says it happened. Each posting is keyed by what caused it,
 * so an event delivered twice posts once, and the hourly sweep can run over
 * everything recent and touch only what is missing.
 *
 * The lines themselves are decided in books.js, which is a copy of the rules
 * in packages/core held there by a parity test. This file only reads the
 * rows, hands them over, and writes what comes back.
 *
 * Everything takes a `ctx` of { db, DB_ID, Query, log } rather than importing
 * the SDK, so the same code runs end to end against the in-memory database
 * in scripts/e2e.
 */

const SYSTEM = 'system';

/* --------------------------------------------------------------- reading */

async function listAll(ctx, collection, queries = []) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const page = await ctx.db.listDocuments(ctx.DB_ID, collection, [
      ...queries, ctx.Query.limit(100), ctx.Query.offset(offset),
    ]);
    out.push(...page.documents);
    if (page.documents.length < 100 || out.length >= page.total) return out;
  }
}

/** The day the books are closed through, or nothing. */
async function lockedThrough(ctx, venueId) {
  const locks = await ctx.db.listDocuments(ctx.DB_ID, 'accounting_locks', [
    ctx.Query.equal('venue_id', venueId), ctx.Query.limit(100),
  ]).catch(() => ({ documents: [] }));
  const latest = locks.documents.sort((a, b) => String(b.locked_at || '').localeCompare(String(a.locked_at || '')))[0];
  return latest?.locked_through ? String(latest.locked_through).slice(0, 10) : '';
}

/** The entry that answers to a key, if one does. A superseded one no longer answers. */
async function entryFor(ctx, venueId, sourceId) {
  const found = await ctx.db.listDocuments(ctx.DB_ID, 'journal_entries', [
    ctx.Query.equal('venue_id', venueId), ctx.Query.equal('source_id', sourceId), ctx.Query.limit(1),
  ]).catch(() => ({ documents: [] }));
  return found.documents[0] || null;
}

const linesOf = (ctx, entryId) => listAll(ctx, 'journal_lines', [ctx.Query.equal('entry_id', entryId)]);

/* --------------------------------------------------------------- writing */

class Locked extends Error {
  constructor(date, through) {
    super(`The books are closed through ${through}; nothing can be posted on ${date.slice(0, 10)}.`);
    this.locked = true;
    this.through = through;
  }
}

/**
 * Post a balanced entry, or refuse.
 *
 * The same two refusals as the browser's postEntry: an entry that does not
 * balance, and one dated inside a closed period. Nothing is written for either.
 */
async function postEntry(ctx, opts, lines) {
  const kept = lines.filter((l) => l.debit !== 0 || l.credit !== 0);
  const debits = kept.reduce((s, l) => s + l.debit, 0);
  const credits = kept.reduce((s, l) => s + l.credit, 0);
  if (debits !== credits) throw new Error(`Entry does not balance: debits ${debits} vs credits ${credits}.`);
  if (kept.length === 0) throw new Error('An entry needs at least one line.');

  const date = new Date(opts.date || Date.now()).toISOString();
  const through = await lockedThrough(ctx, opts.venueId);
  if (isLocked(date, through)) throw new Locked(date, through);

  const entry = await ctx.db.createDocument(ctx.DB_ID, 'journal_entries', 'unique()', {
    venue_id: opts.venueId,
    date,
    source: opts.source,
    source_id: opts.sourceId || '',
    shift_id: opts.shiftId || '',
    memo: opts.memo || '',
    posted_by: opts.postedBy || SYSTEM,
  });
  for (const l of kept) {
    await ctx.db.createDocument(ctx.DB_ID, 'journal_lines', 'unique()', {
      venue_id: opts.venueId,
      entry_id: entry.$id,
      account_code: l.account_code,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo || '',
    });
  }
  return entry;
}

/** Undo an entry by posting its opposite, dated today. Refused if already undone. */
async function reverseEntry(ctx, entry, opts) {
  if (entry.reversed_by) return null;
  const lines = await linesOf(ctx, entry.$id);
  if (lines.length === 0) return null;
  const reversal = await postEntry(ctx, {
    venueId: entry.venue_id,
    date: opts.date,
    source: 'reversal',
    sourceId: entry.$id,
    memo: opts.memo || `Reversal of ${entry.memo || entry.source}`,
    postedBy: opts.postedBy,
  }, lines.map((l) => ({ account_code: l.account_code, debit: l.credit, credit: l.debit, memo: l.memo })));
  await ctx.db.updateDocument(ctx.DB_ID, 'journal_entries', reversal.$id, { reversal_of: entry.$id }).catch(() => undefined);
  await ctx.db.updateDocument(ctx.DB_ID, 'journal_entries', entry.$id, { reversed_by: reversal.$id }).catch(() => undefined);
  return reversal.$id;
}

/** The first day after the lock, as a date at noon, for a correction that cannot land where it belongs. */
const firstOpenDay = (through) => {
  const d = new Date(`${through}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
};

/**
 * Bring an entry into line with what it should say.
 *
 * Edited in place in an open month, with what it said before written to the
 * audit log. In a closed month the entry is left as it was and two new ones
 * land on the first open day: a reversal, and a fresh entry keyed the same
 * way, so the next correction finds the fresh one. The browser's correctEntry
 * does exactly this.
 */
async function correctEntry(ctx, entry, next, by) {
  const through = await lockedThrough(ctx, entry.venue_id);
  const old = await linesOf(ctx, entry.$id);

  if (!isLocked(entry.date, through)) {
    for (const l of old) await ctx.db.deleteDocument(ctx.DB_ID, 'journal_lines', l.$id);
    for (const l of next.lines) {
      await ctx.db.createDocument(ctx.DB_ID, 'journal_lines', 'unique()', {
        venue_id: entry.venue_id, entry_id: entry.$id,
        account_code: l.account_code, debit: l.debit, credit: l.credit, memo: l.memo || '',
      });
    }
    await ctx.db.updateDocument(ctx.DB_ID, 'journal_entries', entry.$id, { memo: next.memo });
    await ctx.db.createDocument(ctx.DB_ID, 'audit_log', 'unique()', {
      venue_id: entry.venue_id,
      actor_id: by || SYSTEM,
      action: 'journal_edited',
      entity_type: 'journal_entry',
      entity_id: entry.$id,
      before: JSON.stringify({ memo: entry.memo, lines: old.map((l) => [l.account_code, l.debit, l.credit]) }).slice(0, 4000),
      after: JSON.stringify({ memo: next.memo, lines: next.lines.map((l) => [l.account_code, l.debit, l.credit]) }).slice(0, 4000),
      reason: 'The spend it was posted from was corrected.',
      shift_id: entry.shift_id || '',
    }).catch(() => undefined);
    return { mode: 'edited', entryId: entry.$id };
  }

  const postOn = firstOpenDay(through);
  await reverseEntry(ctx, entry, {
    postedBy: by, date: postOn,
    memo: `Reversal of ${entry.memo || entry.source} (${entry.date.slice(0, 10)}), corrected after the month was closed`,
  });
  const fresh = await postEntry(ctx, {
    venueId: entry.venue_id, date: postOn, source: entry.source, sourceId: entry.source_id,
    shiftId: entry.shift_id, memo: `${next.memo} (corrects ${entry.date.slice(0, 10)})`, postedBy: by,
  }, next.lines);
  await ctx.db.updateDocument(ctx.DB_ID, 'journal_entries', entry.$id, { source_id: `${entry.source_id || 'entry'}:superseded` })
    .catch(() => undefined);
  return { mode: 'reversed', entryId: fresh.$id };
}

/* ---------------------------------------------------------- shift close */

/**
 * A closed shift, on the books.
 *
 * The figures come off the shift row the till wrote at close — its tax,
 * discounts, cost of sales, what it counted and what it expected — and its
 * payments. Keyed by the shift, so the update event that fires on every later
 * touch of the row (a summary sent, a note added) finds the entries already
 * there and does nothing.
 */
export async function postShiftClose(ctx, shift) {
  if (!shift || shift.status !== 'closed') return { skipped: 'not closed' };
  const venueId = shift.venue_id || 'main';

  const already = await ctx.db.listDocuments(ctx.DB_ID, 'journal_entries', [
    ctx.Query.equal('venue_id', venueId), ctx.Query.equal('source_id', shift.$id),
    ctx.Query.equal('source', 'shift_close'), ctx.Query.limit(1),
  ]).catch(() => ({ total: 0 }));

  let posted = [];
  if (already.total === 0) {
    const [payments, methods, settings] = await Promise.all([
      listAll(ctx, 'payments', [ctx.Query.equal('shift_id', shift.$id)]),
      listAll(ctx, 'payment_methods', [ctx.Query.equal('venue_id', venueId)]),
      ctx.db.getDocument(ctx.DB_ID, 'settings', 'main').catch(() => ({})),
    ]);
    const module = shift.module || 'kitchen';

    let makersShare = 0;
    if (module === 'craft') {
      const orders = (await listAll(ctx, 'orders', [ctx.Query.equal('shift_id', shift.$id)]))
        .filter((o) => o.status === 'SERVED' || o.status === 'CLOSED');
      const lines = orders.length
        ? await listAll(ctx, 'order_items', [ctx.Query.equal('order_id', orders.map((o) => o.$id))])
        : [];
      const consignors = await listAll(ctx, 'consignors').catch(() => []);
      makersShare = makersShareOf(lines.filter((l) => !!l.consignor_id), consignors, settings);
    }

    const tax = shift.tax_total || 0;
    const figures = {
      takings: takingsByKind(payments, methods),
      tips: shift.tip_total || 0,
      tax,
      taxParts: splitTax(tax, { vatBp: vatBpOf(settings), levies: parseLevies(settings.levies) }),
      discounts: shift.discount_total || 0,
      cogs: shift.cogs_total || 0,
      cashVariance: cashVarianceOf(shift.counted, shift.expected),
      module,
      makersShare,
    };

    try {
      for (const e of shiftEntries(figures)) {
        const entry = await postEntry(ctx, {
          venueId, date: shift.closed_at, source: 'shift_close', sourceId: shift.$id,
          shiftId: shift.$id, memo: e.memo, postedBy: shift.closed_by,
        }, e.lines);
        posted.push(entry.$id);
      }
    } catch (e) {
      if (e.locked) {
        ctx.log(`Shift ${shift.code || shift.$id} closed inside a locked period (through ${e.through}); not posted.`);
        return { skipped: 'locked', through: e.through };
      }
      throw e;
    }
  }

  // The spends on it, each by its own id. Most are already there.
  const spends = await listAll(ctx, 'shift_expenses', [ctx.Query.equal('shift_id', shift.$id)]);
  let spendsPosted = 0;
  for (const s of spends) {
    const r = await postSpend(ctx, s).catch((e) => ({ error: e.message }));
    if (r.posted) spendsPosted += 1;
  }

  if (!shift.posted_to_ledger) {
    await ctx.db.updateDocument(ctx.DB_ID, 'shifts', shift.$id, { posted_to_ledger: true }).catch(() => undefined);
  }
  if (posted.length) ctx.log(`Posted shift ${shift.code || shift.$id}: ${posted.length} entries, ${spendsPosted} spends.`);
  return { ok: true, posted: posted.length, spends: spendsPosted, skipped: posted.length ? undefined : 'already posted' };
}

/* --------------------------------------------------------------- spends */

/**
 * Where a spend's money came out of.
 *
 * A petty cash box named on the row is the box's account. Otherwise the row
 * says: a transfer came from the bank, and anything else from the till's
 * cash, whether it was the drawer's money or somebody's own to be paid back.
 */
async function spendFromAccount(ctx, expense) {
  if (expense.imprest_float_id) {
    const box = await ctx.db.getDocument(ctx.DB_ID, 'imprest_floats', expense.imprest_float_id).catch(() => null);
    return { account: box?.account_code || ACCOUNTS.pettyCash, memo: box ? `Paid from ${box.name}` : 'Paid from petty cash' };
  }
  if (expense.source === 'bank') return { account: ACCOUNTS.bank, memo: 'Paid from the bank' };
  return { account: ACCOUNTS.cash, memo: 'Money paid out' };
}

/**
 * One spend, on the books, or brought into line with what it now says.
 *
 * Posted when it does not exist; corrected when its figure, its category or
 * where the money came from has changed; reversed when it has been refused.
 * Nothing at all when the entry already says the right thing, which is the
 * ordinary case: most saves change a note, not a number.
 */
export async function postSpend(ctx, expense) {
  const venueId = expense.venue_id || 'main';
  const key = `expense:${expense.$id}`;
  const existing = await entryFor(ctx, venueId, key);

  if (expense.approval_status === 'rejected') {
    if (!existing || existing.reversed_by) return { skipped: 'refused, nothing on the books' };
    try {
      await reverseEntry(ctx, existing, { postedBy: expense.approved_by || SYSTEM, memo: `Refused: ${existing.memo || 'money paid out'}` });
    } catch (e) {
      if (e.locked) return { skipped: 'locked', through: e.through };
      throw e;
    }
    /*
      The reversed entry stops answering to the spend's key.

      Only once the reversal has actually been written, so a refusal blocked
      by a closed month leaves everything as it was and can be tried again.

      Renaming does two things. A refusal undone finds nothing on the books
      and posts afresh below, rather than meeting a reversed entry and being
      left alone — which is what used to happen, and left an approved spend
      costing the month nothing. And it keeps that guard meaning what it
      says for an entry somebody reversed BY HAND in the books: that one
      keeps the spend's key, so a later touch of the row still leaves it
      alone. Same shape as the supersede in correctEntry.
    */
    await ctx.db.updateDocument(ctx.DB_ID, 'journal_entries', existing.$id, { source_id: `${key}:refused` })
      .catch(() => undefined);
    ctx.log(`Reversed the refused spend ${expense.$id}.`);
    return { ok: true, reversed: true };
  }

  if (!(expense.amount > 0)) return { skipped: 'nothing to post' };

  const [items, categories, from] = await Promise.all([
    listAll(ctx, 'expense_items', [ctx.Query.equal('expense_id', expense.$id)]).catch(() => []),
    listAll(ctx, 'expense_categories').catch(() => []),
    spendFromAccount(ctx, expense),
  ]);
  const categoryAccount = categories.find((c) => c.key === (expense.category_key || expense.category))?.account_code;
  const debits = debitsForSpend(expense, items, categoryAccount);
  const lines = spendPostingLines(debits, from.account);
  if (lines.length === 0) return { skipped: 'nothing to post' };

  try {
    if (!existing) {
      const entry = await postEntry(ctx, {
        venueId, date: expense.$createdAt, source: 'expense', sourceId: key,
        shiftId: expense.shift_id, memo: from.memo, postedBy: expense.created_by,
      }, lines);
      return { ok: true, posted: true, entryId: entry.$id };
    }

    const have = await linesOf(ctx, existing.$id);
    const haveDebits = have.filter((l) => l.debit > 0).map((l) => ({ account_code: l.account_code, amount: l.debit }));
    const haveCredit = have.find((l) => l.credit > 0);
    const same = sameDebits(haveDebits, debits) && haveCredit?.account_code === from.account && have.length === lines.length;
    if (same) return { skipped: 'already posted' };
    if (existing.reversed_by) return { skipped: 'reversed by hand; left alone' };

    const done = await correctEntry(ctx, existing, { memo: from.memo, lines }, expense.created_by);
    ctx.log(`Corrected the posting for spend ${expense.$id} (${done.mode}).`);
    return { ok: true, corrected: done.mode, entryId: done.entryId };
  } catch (e) {
    if (e.locked) return { skipped: 'locked', through: e.through };
    throw e;
  }
}

/* ------------------------------------------------------------- payouts */

/** A maker paid, on the shop's books; or a payout reversed, taken off them. */
export async function postPayoutRow(ctx, payout) {
  const venueId = payout.venue_id || 'main';
  const key = `payout:${payout.$id}`;
  const existing = await entryFor(ctx, venueId, key);

  if (payout.status === 'reversed') {
    if (!existing || existing.reversed_by) return { skipped: 'nothing to reverse' };
    try {
      await reverseEntry(ctx, existing, { postedBy: SYSTEM, memo: `Payout reversed: ${payout.reversed_reason || existing.memo}` });
    } catch (e) {
      if (e.locked) return { skipped: 'locked', through: e.through };
      throw e;
    }
    return { ok: true, reversed: true };
  }

  if (existing) return { skipped: 'already posted' };
  const lines = payoutLines(payout);
  if (lines.length === 0) return { skipped: 'nothing to post' };
  try {
    const entry = await postEntry(ctx, {
      venueId, date: payout.paid_at, source: 'adjustment', sourceId: key,
      memo: `Paid a maker${payout.reference ? ` · ${payout.reference}` : ''}`, postedBy: payout.paid_by,
    }, lines);
    return { ok: true, posted: true, entryId: entry.$id };
  } catch (e) {
    if (e.locked) return { skipped: 'locked', through: e.through };
    throw e;
  }
}

/* ---------------------------------------------------------------- waste */

/** Stock written off, on the books. */
export async function postWasteRow(ctx, waste) {
  const venueId = waste.venue_id || 'main';
  if (!(waste.value > 0)) return { skipped: 'no value' };
  const key = `waste:${waste.$id}`;
  if (await entryFor(ctx, venueId, key)) return { skipped: 'already posted' };

  const ing = waste.ingredient_id
    ? await ctx.db.getDocument(ctx.DB_ID, 'ingredients', waste.ingredient_id).catch(() => null)
    : null;
  const what = `${waste.qty} ${waste.unit}${ing ? ` ${ing.name}` : ''}, ${String(waste.reason || 'waste').replace(/_/g, ' ')}`;
  try {
    const entry = await postEntry(ctx, {
      venueId, date: waste.$createdAt, source: 'adjustment', sourceId: key,
      shiftId: waste.shift_id, memo: `Written off: ${what}`, postedBy: waste.recorded_by,
    }, wasteLines({ value: waste.value, module: ing?.module }));
    return { ok: true, posted: true, entryId: entry.$id };
  } catch (e) {
    if (e.locked) return { skipped: 'locked', through: e.through };
    throw e;
  }
}

/* ---------------------------------------------------------------- sweep */

/**
 * Everything recent, checked. The net under the events.
 *
 * An event can be missed — a function that was not subscribed, a deploy in
 * the middle of a close — so once an hour every closed shift not yet marked
 * posted, and every spend, payout and write-off of the last week, is run
 * through the same code. Each is keyed, so what is already there is left
 * alone and only the gaps are filled.
 */
export async function sweepBooks(ctx, now = Date.now()) {
  const since = new Date(now - 7 * 86_400_000).toISOString();
  const out = { shifts: 0, spends: 0, payouts: 0, waste: 0, locked: 0, errors: [] };

  const attempt = async (kind, fn) => {
    try {
      const r = await fn();
      if (r?.posted || r?.reversed || r?.corrected) out[kind] += 1;
      if (r?.skipped === 'locked') out.locked += 1;
    } catch (e) {
      out.errors.push(`${kind}: ${e.message}`);
    }
  };

  const shifts = await listAll(ctx, 'shifts', [ctx.Query.equal('status', 'closed'), ctx.Query.notEqual('posted_to_ledger', true)])
    .catch(() => []);
  for (const s of shifts.slice(0, 50)) await attempt('shifts', () => postShiftClose(ctx, s));

  for (const s of await listAll(ctx, 'shift_expenses', [ctx.Query.greaterThanEqual('$createdAt', since)]).catch(() => [])) {
    await attempt('spends', () => postSpend(ctx, s));
  }
  for (const p of await listAll(ctx, 'consignor_payouts', [ctx.Query.greaterThanEqual('$createdAt', since)]).catch(() => [])) {
    await attempt('payouts', () => postPayoutRow(ctx, p));
  }
  for (const w of await listAll(ctx, 'waste_log', [ctx.Query.greaterThanEqual('$createdAt', since)]).catch(() => [])) {
    await attempt('waste', () => postWasteRow(ctx, w));
  }

  const filled = out.shifts + out.spends + out.payouts + out.waste;
  if (filled || out.errors.length) ctx.log(`Books sweep: filled ${filled}, locked ${out.locked}, errors ${out.errors.length}.`);
  return { ok: out.errors.length === 0, ...out };
}
