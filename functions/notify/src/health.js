/**
 * Records that do not add up, checked every night. The server's copy.
 *
 * The questions are packages/core/src/health-rules.ts; this file carries
 * the same questions (a parity test in core holds the two together) and
 * the reading of the rows the notify function does at its hour. The Health
 * page in the admin app asks the same questions when it is opened, so what
 * an owner reads in the morning email and what they see on the page are
 * the same list.
 *
 * Imports nothing, so scripts/e2e can run it against the in-memory database
 * exactly as the function runs it against the real one. The nightly run that
 * calls it, with its email and its once-a-day guard, is in health-night.js.
 */

/** Mirrors HEALTH_GRACE in packages/core/src/health-rules.ts. */
export const HEALTH_GRACE = { postingHours: 2, spendDays: 3, countDays: 7, shiftHours: 24, jobHours: 36 };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const day = (iso) => (iso || '').slice(0, 10);
const hoursSince = (iso, now) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? (Date.parse(now) - t) / 3_600_000 : Number.POSITIVE_INFINITY;
};
const none = (key, title) => ({ key, level: 'ok', title, detail: 'None', count: 0 });

/** Mirrors healthFindings in packages/core/src/health-rules.ts. */
export function healthFindings(f, w) {
  const out = [];

  if (f.schema === 'behind') {
    out.push({
      key: 'schema', level: 'block', title: 'The database is behind the apps', count: 1,
      detail: 'A provision run has not happened since the schema changed. Some new things will not save until it does.',
      goto: 'provision', action: 'How to provision',
    });
  } else if (f.schema === 'unknown') {
    out.push({ key: 'schema', level: 'warn', title: 'The database could not be read', count: 1, detail: 'The settings row did not load, so nothing below is certain.' });
  } else {
    out.push({ key: 'schema', level: 'ok', title: 'The database matches the apps', count: 0, detail: 'Provisioned to this version.' });
  }

  out.push(f.unpostedShifts.length > 0
    ? {
      key: 'shifts_unposted', level: 'block', title: 'Shifts closed but not on the books', count: f.unpostedShifts.length,
      detail: f.unpostedShifts.slice(0, 4).map((s) => `${s.code} (${day(s.closedAt)})`).join(', ')
        + (f.unpostedShifts.length > 4 ? ', …' : '') + '. The hourly sweep should have posted these; if they stay, the background job is not running.',
      goto: '/accounting', action: 'Open the books',
    }
    : none('shifts_unposted', 'Shifts closed but not on the books'));

  const broken = [...f.emptyEntries.map((e) => ({ ...e, why: 'no lines' })), ...f.unbalancedEntries.map((e) => ({ ...e, why: `off by ${w.money(Math.abs(e.off))}` }))];
  out.push(broken.length > 0
    ? {
      key: 'entries_broken', level: 'block', title: 'Journal entries that do not add up', count: broken.length,
      detail: broken.slice(0, 4).map((e) => `${day(e.date)} ${e.memo || 'entry'}: ${e.why}`).join('; ') + (broken.length > 4 ? '; …' : ''),
      goto: '/accounting', action: 'Open the journal',
    }
    : none('entries_broken', 'Journal entries that do not add up'));

  out.push(f.unpostedSpends.length > 0
    ? {
      key: 'spends_unposted', level: 'block', title: 'Spends not on the books', count: f.unpostedSpends.length,
      detail: `${plural(f.unpostedSpends.length, 'spend', 'spends')} recorded and never posted, ${w.money(f.unpostedSpends.reduce((s, e) => s + e.amount, 0))}. The hourly sweep should have posted these.`,
      goto: '/expenses', action: 'Open spends',
    }
    : none('spends_unposted', 'Spends not on the books'));

  out.push(f.stockSpendsWithoutLines.length > 0
    ? {
      key: 'spends_no_lines', level: 'warn', title: 'Stock spends with nothing on a shelf', count: f.stockSpendsWithoutLines.length,
      detail: `${plural(f.stockSpendsWithoutLines.length, 'spend says', 'spends say')} stock was bought but no line reached a shelf, ${w.money(f.stockSpendsWithoutLines.reduce((s, e) => s + e.amount, 0))}. The stock figure is short by whatever was bought.`,
      goto: '/expenses', action: 'Open spends',
    }
    : none('spends_no_lines', 'Stock spends with nothing on a shelf'));

  out.push(f.halfCounts.length > 0
    ? {
      key: 'counts_half', level: 'block', title: 'Counts half applied', count: f.halfCounts.length,
      detail: f.halfCounts.slice(0, 3).map((c) => `${day(c.countedAt)}: ${c.applied} of ${c.lines} lines moved the shelf`).join('; ') + '. Approve again to finish them.',
      goto: '/waiting?show=count', action: 'Open waiting',
    }
    : none('counts_half', 'Counts half applied'));

  out.push(f.paidOrdersNoPayment.length > 0
    ? {
      key: 'orders_no_payment', level: 'block', title: 'Orders marked paid with no payment', count: f.paidOrdersNoPayment.length,
      detail: f.paidOrdersNoPayment.slice(0, 4).map((o) => `${o.orderNo} ${w.money(o.total)}`).join(', ') + (f.paidOrdersNoPayment.length > 4 ? ', …' : '') + '. The drawer count expects nothing for these.',
      goto: '/orders', action: 'Open orders',
    }
    : none('orders_no_payment', 'Orders marked paid with no payment'));

  out.push(f.ordersNoLines.length > 0
    ? {
      key: 'orders_no_lines', level: 'warn', title: 'Orders with no lines', count: f.ordersNoLines.length,
      detail: f.ordersNoLines.slice(0, 5).map((o) => o.orderNo).join(', ') + (f.ordersNoLines.length > 5 ? ', …' : ''),
      goto: '/orders', action: 'Open orders',
    }
    : none('orders_no_lines', 'Orders with no lines'));

  const payoutTrouble = f.unledgeredPayouts.length + f.unpostedPayouts.length;
  out.push(payoutTrouble > 0
    ? {
      key: 'payouts', level: f.unledgeredPayouts.length > 0 ? 'block' : 'warn', title: 'Payouts that did not reach the ledger', count: payoutTrouble,
      detail: [
        f.unledgeredPayouts.length > 0 ? `${plural(f.unledgeredPayouts.length, 'payout', 'payouts')} never reduced what the maker is owed (${f.unledgeredPayouts.slice(0, 3).map((p) => p.reference).join(', ')})` : '',
        f.unpostedPayouts.length > 0 ? `${plural(f.unpostedPayouts.length, 'payout is', 'payouts are')} not on the shop's books` : '',
      ].filter(Boolean).join('; ') + '.',
      goto: '/payouts', action: 'Open payouts',
    }
    : none('payouts', 'Payouts that did not reach the ledger'));

  out.push(f.unpostedWaste > 0
    ? { key: 'waste', level: 'warn', title: 'Write-offs not on the books', count: f.unpostedWaste, detail: `${plural(f.unpostedWaste, 'write-off', 'write-offs')} with a value that never reached the books.`, goto: '/waste', action: 'Open waste' }
    : none('waste', 'Write-offs not on the books'));

  out.push(f.trialBalanced
    ? { key: 'trial', level: 'ok', title: 'The books balance', count: 0, detail: 'Every debit has its credit.' }
    : { key: 'trial', level: 'block', title: 'The books do not balance', count: 1, detail: 'Debits and credits do not agree across the journal. An entry above is the usual cause.', goto: '/accounting', action: 'Open the trial balance' });

  out.push(f.staleSpends > 0
    ? { key: 'spends_stale', level: 'warn', title: `Spends waiting more than ${HEALTH_GRACE.spendDays} days`, count: f.staleSpends, detail: `${plural(f.staleSpends, 'spend', 'spends')} nobody has approved or refused.`, goto: '/waiting?show=spend', action: 'Open waiting' }
    : none('spends_stale', `Spends waiting more than ${HEALTH_GRACE.spendDays} days`));
  out.push(f.staleCounts > 0
    ? { key: 'counts_stale', level: 'warn', title: `Counts waiting more than ${HEALTH_GRACE.countDays} days`, count: f.staleCounts, detail: `${plural(f.staleCounts, 'count', 'counts')} nobody has approved or refused. The shelf still says what it said before them.`, goto: '/waiting?show=count', action: 'Open waiting' }
    : none('counts_stale', `Counts waiting more than ${HEALTH_GRACE.countDays} days`));
  out.push(f.openShiftsOverDay.length > 0
    ? { key: 'shifts_open', level: 'warn', title: 'Shifts open longer than a day', count: f.openShiftsOverDay.length, detail: f.openShiftsOverDay.map((s) => `${s.code} since ${day(s.openedAt)}`).join(', ') + '. Nothing on them can be posted until they close.', goto: '/shifts', action: 'Open shifts' }
    : none('shifts_open', 'Shifts open longer than a day'));
  out.push(f.clearing.card + f.clearing.momo > 0
    ? { key: 'clearing', level: 'info', title: 'Card and mobile money not yet settled', count: 1, detail: `MoMo ${w.money(f.clearing.momo)} · Card ${w.money(f.clearing.card)} waiting on the provider.`, goto: '/accounting', action: 'Match settlements' }
    : none('clearing', 'Card and mobile money not yet settled'));

  const quiet = hoursSince(f.lastHealthRun, f.now) > HEALTH_GRACE.jobHours;
  out.push(quiet
    ? { key: 'job_health', level: 'warn', title: 'The nightly check has not run', count: 1, detail: f.lastHealthRun ? `Last ran ${day(f.lastHealthRun)}. The notify job may be stopped, or not deployed.` : 'It has never run. The notify job may not be deployed.', goto: 'functions', action: 'How to deploy' }
    : { key: 'job_health', level: 'ok', title: 'The nightly check ran', count: 0, detail: `Last ran ${day(f.lastHealthRun ?? '')}.` });
  out.push(hoursSince(f.lastBackup, f.now) > HEALTH_GRACE.jobHours
    ? { key: 'job_backup', level: 'warn', title: 'No recent copy of the data', count: 1, detail: f.lastBackup ? `Last copy ${day(f.lastBackup)}.` : 'No copy has ever been made. Add an address under Settings, Reports and backups by email.', goto: '/settings', action: 'Open settings' }
    : { key: 'job_backup', level: 'ok', title: 'A copy of the data was made', count: 0, detail: `Last copy ${day(f.lastBackup ?? '')}.` });
  const failedMail = f.failedReceipts + f.failedSummaries;
  out.push(failedMail > 0
    ? { key: 'mail', level: 'info', title: 'Emails that failed this week', count: failedMail, detail: [f.failedReceipts > 0 ? plural(f.failedReceipts, 'receipt', 'receipts') : '', f.failedSummaries > 0 ? plural(f.failedSummaries, 'report', 'reports') : ''].filter(Boolean).join(', ') + '. Each row says why under Reports.', goto: '/reports', action: 'Open reports' }
    : none('mail', 'Emails that failed this week'));

  return out;
}

/** Mirrors healthSummary in packages/core/src/health-rules.ts. */
export function healthSummary(findings) {
  const blocks = findings.filter((x) => x.level === 'block').length;
  const warns = findings.filter((x) => x.level === 'warn').length;
  const words = blocks > 0
    ? `${plural(blocks, 'thing needs', 'things need')} fixing${warns > 0 ? `, and ${plural(warns, 'thing is', 'things are')} waiting on somebody` : ''}.`
    : warns > 0
      ? `Nothing is broken. ${plural(warns, 'thing is', 'things are')} waiting on somebody.`
      : 'Everything adds up.';
  return { blocks, warns, words };
}

/* ------------------------------------------------------------- the facts */

async function listAll(ctx, collection, queries = []) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const page = await ctx.db.listDocuments(ctx.DB_ID, collection, [...queries, ctx.Query.limit(100), ctx.Query.offset(offset)]);
    out.push(...page.documents);
    if (page.documents.length < 100 || out.length >= page.total) return out;
  }
}

async function listByIds(ctx, collection, field, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const out = [];
  // Appwrite caps a value list; a hundred at a time is well inside it.
  for (let i = 0; i < unique.length; i += 100) {
    out.push(...await listAll(ctx, collection, [ctx.Query.equal(field, unique.slice(i, i + 100))]));
  }
  return out;
}

const isLivePayment = (p) => p.status !== 'voided' && p.status !== 'refunded';

/**
 * Mirrors healthFacts in packages/core/src/health.ts: the same windows, the
 * same questions of the same rows. `expectedSchema` is what the deployed
 * apps were built with, which the function cannot know; the nightly run
 * reads the stamp and reports 'current' when there is one — a database with
 * no stamp at all is behind, whatever the apps say.
 */
export async function healthFacts(ctx, venueId, now = new Date()) {
  const nowIso = now.toISOString();
  const ago = (hours) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  const olderThan = (iso, hours) => {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) && t < now.getTime() - hours * 3_600_000;
  };
  const Q = ctx.Query;

  const settings = await ctx.db.getDocument(ctx.DB_ID, 'settings', 'main').catch(() => null);

  const [shifts, entries, lines, spends, counts, checks, orders, payouts, wastes, reports, receipts] = await Promise.all([
    listAll(ctx, 'shifts', [Q.equal('venue_id', venueId)]),
    listAll(ctx, 'journal_entries', [Q.equal('venue_id', venueId)]),
    listAll(ctx, 'journal_lines', [Q.equal('venue_id', venueId)]),
    listAll(ctx, 'shift_expenses', [Q.greaterThanEqual('$createdAt', ago(30 * 24))]),
    listAll(ctx, 'stock_counts', [Q.equal('status', 'pending')]).catch(() => []),
    listAll(ctx, 'shift_stock_checks', [Q.equal('applied', false)]).catch(() => []),
    listAll(ctx, 'orders', [Q.equal('venue_id', venueId), Q.greaterThanEqual('$createdAt', ago(7 * 24))]),
    listAll(ctx, 'consignor_payouts', [Q.greaterThanEqual('$createdAt', ago(30 * 24))]).catch(() => []),
    listAll(ctx, 'waste_log', [Q.greaterThanEqual('$createdAt', ago(30 * 24))]).catch(() => []),
    listAll(ctx, 'summary_reports', [Q.greaterThanEqual('$createdAt', ago(60 * 24))]).catch(() => []),
    listAll(ctx, 'receipts', [Q.greaterThanEqual('$createdAt', ago(7 * 24))]).catch(() => []),
  ]);

  const byEntry = new Map();
  for (const l of lines) byEntry.set(l.entry_id, [...(byEntry.get(l.entry_id) ?? []), l]);
  const emptyEntries = [];
  const unbalancedEntries = [];
  for (const e of entries) {
    const ls = byEntry.get(e.$id) ?? [];
    if (ls.length === 0) { emptyEntries.push({ id: e.$id, date: e.date, memo: e.memo ?? '' }); continue; }
    const off = ls.reduce((s, l) => s + l.debit - l.credit, 0);
    if (off !== 0) unbalancedEntries.push({ id: e.$id, date: e.date, memo: e.memo ?? '', off });
  }
  const keys = new Set(entries.filter((e) => !e.reversed_by).map((e) => e.source_id ?? ''));
  const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
  const balance = (code) => lines.filter((l) => l.account_code === code).reduce((s, l) => s + l.debit - l.credit, 0);

  const unpostedShifts = shifts
    .filter((s) => s.status === 'closed' && !s.posted_to_ledger && olderThan(s.closed_at, HEALTH_GRACE.postingHours) && !keys.has(s.$id))
    .map((s) => ({ code: s.code, closedAt: s.closed_at ?? '' }));
  const openShiftsOverDay = shifts
    .filter((s) => s.status === 'open' && olderThan(s.opened_at, HEALTH_GRACE.shiftHours))
    .map((s) => ({ code: s.code, openedAt: s.opened_at ?? '' }));

  const live = spends.filter((e) => e.amount > 0 && e.approval_status !== 'rejected');
  const unpostedSpends = live
    .filter((e) => olderThan(e.$createdAt, HEALTH_GRACE.postingHours) && !keys.has(`expense:${e.$id}`))
    .map((e) => ({ id: e.$id, amount: e.amount }));
  const stockSpends = live.filter((e) => e.kind === 'stock');
  const items = await listByIds(ctx, 'expense_items', 'expense_id', stockSpends.map((e) => e.$id)).catch(() => []);
  const withLines = new Set(items.map((i) => i.expense_id));
  const stockSpendsWithoutLines = stockSpends.filter((e) => !withLines.has(e.$id)).map((e) => ({ id: e.$id, amount: e.amount }));
  const staleSpends = spends.filter((e) => e.approval_status === 'pending' && olderThan(e.$createdAt, HEALTH_GRACE.spendDays * 24)).length;

  const countLines = await listByIds(ctx, 'stock_count_lines', 'count_id', counts.map((c) => c.$id)).catch(() => []);
  const halfCounts = [];
  for (const c of counts) {
    const ls = countLines.filter((l) => l.count_id === c.$id);
    const applied = ls.filter((l) => l.applied).length;
    if (applied > 0 && applied < ls.length) halfCounts.push({ id: c.$id, countedAt: c.counted_at, applied, lines: ls.length });
  }
  const staleShop = counts.filter((c) => olderThan(c.counted_at, HEALTH_GRACE.countDays * 24)).length;
  const staleBar = new Set(
    checks.filter((r) => !r.rejected_at && olderThan(r.$createdAt, HEALTH_GRACE.countDays * 24)).map((r) => `${r.shift_id ?? ''}|${r.phase ?? 'close'}`),
  ).size;

  const real = orders.filter((o) => o.status !== 'CANCELLED');
  const paid = real.filter((o) => o.payment_status === 'paid');
  const payments = await listByIds(ctx, 'payments', 'order_id', paid.map((o) => o.$id)).catch(() => []);
  const paidFor = new Set(payments.filter(isLivePayment).map((p) => p.order_id));
  const paidOrdersNoPayment = paid.filter((o) => !paidFor.has(o.$id)).map((o) => ({ orderNo: o.order_no, total: o.total }));
  const orderLines = await listByIds(ctx, 'order_items', 'order_id', real.map((o) => o.$id)).catch(() => []);
  const withItems = new Set(orderLines.map((l) => l.order_id));
  const ordersNoLines = real.filter((o) => !withItems.has(o.$id)).map((o) => ({ orderNo: o.order_no }));

  const recorded = payouts.filter((p) => p.status === 'recorded' && olderThan(p.$createdAt, 1));
  const ledger = await listByIds(ctx, 'consignor_ledger', 'payout_id', recorded.map((p) => p.$id)).catch(() => []);
  const ledgered = new Set(ledger.map((l) => l.payout_id));
  const unledgeredPayouts = recorded.filter((p) => !ledgered.has(p.$id)).map((p) => ({ reference: p.reference, amount: p.amount }));
  const unpostedPayouts = recorded.filter((p) => !keys.has(`payout:${p.$id}`)).map((p) => ({ reference: p.reference, amount: p.amount }));
  const unpostedWaste = wastes.filter((w) => w.value > 0 && olderThan(w.$createdAt, HEALTH_GRACE.postingHours) && !keys.has(`waste:${w.$id}`)).length;

  const latest = (kind) => reports.filter((r) => r.kind === kind).map((r) => r.$createdAt).sort().pop();
  const weekAgo = ago(7 * 24);

  return {
    now: nowIso,
    schema: !settings ? 'unknown' : settings.schema_version ? 'current' : 'behind',
    unpostedShifts,
    emptyEntries,
    unbalancedEntries,
    unpostedSpends,
    stockSpendsWithoutLines,
    staleSpends,
    halfCounts,
    staleCounts: staleShop + staleBar,
    paidOrdersNoPayment,
    ordersNoLines,
    unledgeredPayouts,
    unpostedPayouts,
    unpostedWaste,
    openShiftsOverDay,
    clearing: { card: Math.max(0, balance('1010')), momo: Math.max(0, balance('1020')) },
    trialBalanced: totalDebit === totalCredit,
    failedReceipts: receipts.filter((r) => r.status === 'failed' || r.status === 'bounced').length,
    failedSummaries: reports.filter((r) => r.$createdAt >= weekAgo && r.delivery_status === 'failed' && r.kind !== 'health').length,
    lastHealthRun: latest('health'),
    lastBackup: latest('backup'),
    lastDigest: latest('daily_digest'),
  };
}

