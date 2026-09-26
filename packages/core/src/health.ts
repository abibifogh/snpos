import { db, DB_ID, Query, listAll, listByIds } from './client';
import { hanging } from './ledger';
import type { JournalEntry, JournalLine } from './ledger';
import { schemaState } from './schema-status';
import { SCHEMA_VERSION } from './schema-version';
import { HEALTH_GRACE, sizesMispricedFrom } from './health-rules';
import type { HealthFacts } from './health-rules';
import { isLivePayment } from './shift-rules';

/**
 * The facts the health rules are asked about, read from the rows.
 *
 * The questions are in health-rules.ts and import nothing; this is the part
 * that goes and gets the answers. Bounded windows everywhere a table grows
 * without limit — a month of spends, a week of orders — because a check that
 * reads a year of orders on every open is a check nobody opens. The server
 * reads the same facts nightly; see functions/notify/src/health.js.
 */
export async function healthFacts(venueId: string, now: Date = new Date()): Promise<HealthFacts> {
  const nowIso = now.toISOString();
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  const olderThan = (iso: string | undefined, hours: number) => {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) && t < now.getTime() - hours * 3_600_000;
  };

  const settings = await db.getDocument(DB_ID, 'settings', 'main').catch(() => null) as { schema_version?: string } | null;

  const [shifts, entries, lines, spends, counts, checks, orders, payouts, wastes, reports, receipts, notices, owed] = await Promise.all([
    listAll<{ $id: string; code: string; status: string; closed_at?: string; opened_at?: string; posted_to_ledger?: boolean }>('shifts', [Query.equal('venue_id', venueId)]),
    listAll<JournalEntry>('journal_entries', [Query.equal('venue_id', venueId)]),
    listAll<JournalLine>('journal_lines', [Query.equal('venue_id', venueId)]),
    listAll<{ $id: string; amount: number; kind?: string; approval_status?: string; $createdAt: string }>('shift_expenses', [Query.greaterThanEqual('$createdAt', ago(30 * 24))]),
    listAll<{ $id: string; counted_at: string; status: string }>('stock_counts', [Query.equal('status', 'pending')]).catch(() => []),
    listAll<{ shift_id?: string; phase?: string; $createdAt: string; rejected_at?: string | null }>('shift_stock_checks', [Query.equal('applied', false)]).catch(() => []),
    listAll<{ $id: string; order_no: string; status: string; payment_status?: string; total: number; subtotal?: number }>('orders', [Query.equal('venue_id', venueId), Query.greaterThanEqual('$createdAt', ago(7 * 24))]),
    listAll<{ $id: string; reference: string; amount: number; status: string; $createdAt: string }>('consignor_payouts', [Query.greaterThanEqual('$createdAt', ago(30 * 24))]).catch(() => []),
    listAll<{ $id: string; value: number; $createdAt: string }>('waste_log', [Query.greaterThanEqual('$createdAt', ago(30 * 24))]).catch(() => []),
    listAll<{ kind: string; $createdAt: string; delivery_status: string }>('summary_reports', [Query.greaterThanEqual('$createdAt', ago(60 * 24))]).catch(() => []),
    listAll<{ status: string }>('receipts', [Query.greaterThanEqual('$createdAt', ago(7 * 24))]).catch(() => []),
    listAll<{ status: string; stage: string }>('order_notices', [Query.greaterThanEqual('$createdAt', ago(7 * 24))]).catch(() => []),
    hanging(venueId).catch(() => ({ card: 0, momo: 0 })),
  ]);

  // --- the books: every entry with its lines
  const byEntry = new Map<string, JournalLine[]>();
  for (const l of lines) byEntry.set(l.entry_id, [...(byEntry.get(l.entry_id) ?? []), l]);
  const emptyEntries: HealthFacts['emptyEntries'] = [];
  const unbalancedEntries: HealthFacts['unbalancedEntries'] = [];
  for (const e of entries) {
    const ls = byEntry.get(e.$id) ?? [];
    if (ls.length === 0) { emptyEntries.push({ id: e.$id, date: e.date, memo: e.memo ?? '' }); continue; }
    const off = ls.reduce((s, l) => s + l.debit - l.credit, 0);
    if (off !== 0) unbalancedEntries.push({ id: e.$id, date: e.date, memo: e.memo ?? '', off });
  }
  const keys = new Set(entries.filter((e) => !e.reversed_by).map((e) => e.source_id ?? ''));
  const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0);

  // --- shifts
  const unpostedShifts = shifts
    .filter((s) => s.status === 'closed' && !s.posted_to_ledger && olderThan(s.closed_at, HEALTH_GRACE.postingHours) && !keys.has(s.$id))
    .map((s) => ({ code: s.code, closedAt: s.closed_at ?? '' }));
  const openShiftsOverDay = shifts
    .filter((s) => s.status === 'open' && olderThan(s.opened_at, HEALTH_GRACE.shiftHours))
    .map((s) => ({ code: s.code, openedAt: s.opened_at ?? '' }));

  // --- spends
  const live = spends.filter((e) => e.amount > 0 && e.approval_status !== 'rejected');
  const unpostedSpends = live
    .filter((e) => olderThan(e.$createdAt, HEALTH_GRACE.postingHours) && !keys.has(`expense:${e.$id}`))
    .map((e) => ({ id: e.$id, amount: e.amount }));
  const stockSpends = live.filter((e) => e.kind === 'stock');
  const items = await listByIds<{ expense_id: string }>('expense_items', 'expense_id', stockSpends.map((e) => e.$id)).catch(() => []);
  const withLines = new Set(items.map((i) => i.expense_id));
  const stockSpendsWithoutLines = stockSpends.filter((e) => !withLines.has(e.$id)).map((e) => ({ id: e.$id, amount: e.amount }));
  const staleSpends = spends.filter((e) => e.approval_status === 'pending' && olderThan(e.$createdAt, HEALTH_GRACE.spendDays * 24)).length;

  // --- counts
  const countLines = await listByIds<{ count_id: string; applied?: boolean }>('stock_count_lines', 'count_id', counts.map((c) => c.$id)).catch(() => []);
  const halfCounts: HealthFacts['halfCounts'] = [];
  for (const c of counts) {
    const ls = countLines.filter((l) => l.count_id === c.$id);
    const applied = ls.filter((l) => l.applied).length;
    if (applied > 0 && applied < ls.length) halfCounts.push({ id: c.$id, countedAt: c.counted_at, applied, lines: ls.length });
  }
  const staleShop = counts.filter((c) => olderThan(c.counted_at, HEALTH_GRACE.countDays * 24)).length;
  const staleBar = new Set(
    checks.filter((r) => !r.rejected_at && olderThan(r.$createdAt, HEALTH_GRACE.countDays * 24)).map((r) => `${r.shift_id ?? ''}|${r.phase ?? 'close'}`),
  ).size;

  // --- orders
  const real = orders.filter((o) => o.status !== 'CANCELLED');
  const paid = real.filter((o) => o.payment_status === 'paid');
  /*
    Every real order's payments, not only those already marked paid.

    It used to fetch them for the PAID ones alone, which can answer "is this
    bill's money missing" and cannot answer the opposite — a bill whose money
    is all there and which says partial anyway. That is ORD0889, and looking
    only where the answer was already known is why nothing found it.
  */
  const payments = await listByIds<{ order_id: string; status?: string; amount?: number }>('payments', 'order_id', real.map((o) => o.$id)).catch(() => []);
  const paidFor = new Set(payments.filter(isLivePayment).map((p) => p.order_id));
  const paidOrdersNoPayment = paid.filter((o) => !paidFor.has(o.$id)).map((o) => ({ orderNo: o.order_no, total: o.total }));
  /*
    A bill with more money against it than it came to.

    The same order paid twice, which is what a till that fails open on a bad
    connection produces: the balance cannot be read, the sale goes through
    anyway — correctly, a restaurant must be able to sell in a power cut —
    and the cashier presses again because nothing on screen moved. The server
    voids these as they arrive now, but anything that went through before
    that is sitting in a night's takings with nothing pointing at it.
  */
  const takenOn = new Map<string, number>();
  for (const p of payments.filter(isLivePayment)) {
    takenOn.set(p.order_id, (takenOn.get(p.order_id) ?? 0) + (p.amount ?? 0));
  }
  const overpaidOrders = paid
    .filter((o) => (takenOn.get(o.$id) ?? 0) > o.total)
    .map((o) => ({ orderNo: o.order_no, total: o.total, taken: takenOn.get(o.$id) ?? 0 }));
  /*
    A bill whose money is all there, still reading as owed for.

    ORD0889: GH₵210, paid in full, showing "partial". The till works this out
    by reading every payment back the moment it records one, and a read that
    failed came back as an empty list — indistinguishable from a bill nobody
    has paid a penny on. It wrote that down, and nothing ever asked again.

    The server settles this on every payment now, so it cannot happen again;
    this is what finds the ones it already happened to. A block, because the
    money is in the drawer and the bill says it is not.
  */
  const settledOnPaper = real.filter(
    (o) => o.payment_status !== 'paid'
      && o.payment_status !== 'refunded'
      && (o.total ?? 0) > 0
      && (takenOn.get(o.$id) ?? 0) >= (o.total ?? 0),
  ).map((o) => ({ orderNo: o.order_no, total: o.total, taken: takenOn.get(o.$id) ?? 0 }));
  const orderLines = await listByIds<{ order_id: string; line_total?: number; status?: string }>('order_items', 'order_id', real.map((o) => o.$id)).catch(() => []);
  const withItems = new Set(orderLines.map((l) => l.order_id));
  const ordersNoLines = real.filter((o) => !withItems.has(o.$id)).map((o) => ({ orderNo: o.order_no }));
  /*
    A bill that does not add up to its own items.

    ORD0866: a quesadilla at 90 and a kelewele at 40, total 90. The server
    reprices every line and used to SKIP any line whose dish it could not
    read — the line stayed on the bill, kept its price on screen, and left the
    total. Nothing said so, and nobody would look at a bill whose items each
    have a price beside them.

    Dropping a line cannot happen now, but every order it already happened to
    is still sitting there undercharged, and the only way to find one was to
    add a column up by hand.
  */
  const soldOn = new Map<string, number>();
  for (const l of orderLines) {
    if (l.status === 'void') continue;
    soldOn.set(l.order_id, (soldOn.get(l.order_id) ?? 0) + (l.line_total ?? 0));
  }
  const ordersNotAddingUp = real
    /*
      Only where there is a figure to compare against. An order with no
      subtotal at all is a different and louder problem than one whose subtotal
      disagrees with its lines, and reading "missing" as nought would report
      every such row as underpriced by its whole value.
    */
    .filter((o) => withItems.has(o.$id) && typeof o.subtotal === 'number'
      && (soldOn.get(o.$id) ?? 0) !== o.subtotal)
    .map((o) => ({ orderNo: o.order_no, subtotal: o.subtotal ?? 0, lines: soldOn.get(o.$id) ?? 0 }));

  /*
    Sizes charged at the plain item's price, from the server's own log of
    every price it rewrote. Further back than a week, because the fault ran
    for as long as sizes have been sold, and only the orders it touched are
    read — the log names them. See sizesMispricedFrom.
  */
  const audits = await listAll<{ entity_id?: string; after?: string }>('audit_log', [
    Query.equal('action', 'order_price_corrected'),
    Query.equal('venue_id', venueId),
    Query.greaterThanEqual('$createdAt', ago(HEALTH_GRACE.sizeLookbackDays * 24)),
  ]).catch(() => []);
  const corrected = [...new Set(audits.map((a) => a.entity_id ?? '').filter(Boolean))];
  const [sizeLines, sizeOrders] = await Promise.all([
    listByIds<{ order_id: string; name_snapshot?: string; variant_id?: string; list_price?: number; status?: string }>(
      'order_items', 'order_id', corrected,
    ).catch(() => []),
    listByIds<{ $id: string; order_no?: string; payment_status?: string; status?: string }>('orders', '$id', corrected)
      .catch(() => []),
  ]);
  const sizesMispriced = sizesMispricedFrom({ audits, lines: sizeLines, orders: sizeOrders });

  // --- payouts and waste
  const recorded = payouts.filter((p) => p.status === 'recorded' && olderThan(p.$createdAt, 1));
  const ledger = await listByIds<{ payout_id: string }>('consignor_ledger', 'payout_id', recorded.map((p) => p.$id)).catch(() => []);
  const ledgered = new Set(ledger.map((l) => l.payout_id));
  const unledgeredPayouts = recorded.filter((p) => !ledgered.has(p.$id)).map((p) => ({ reference: p.reference, amount: p.amount }));
  const unpostedPayouts = recorded.filter((p) => !keys.has(`payout:${p.$id}`)).map((p) => ({ reference: p.reference, amount: p.amount }));
  const unpostedWaste = wastes.filter((w) => w.value > 0 && olderThan(w.$createdAt, HEALTH_GRACE.postingHours) && !keys.has(`waste:${w.$id}`)).length;

  // --- the jobs
  const latest = (kind: string) => reports.filter((r) => r.kind === kind).map((r) => r.$createdAt).sort().pop();
  const weekAgo = ago(7 * 24);

  return {
    now: nowIso,
    schema: schemaState(settings, SCHEMA_VERSION),
    unpostedShifts,
    emptyEntries,
    unbalancedEntries,
    unpostedSpends,
    stockSpendsWithoutLines,
    staleSpends,
    halfCounts,
    staleCounts: staleShop + staleBar,
    paidOrdersNoPayment,
    overpaidOrders,
    settledOnPaper,
    ordersNoLines,
    ordersNotAddingUp,
    sizesMispriced,
    unledgeredPayouts,
    unpostedPayouts,
    unpostedWaste,
    openShiftsOverDay,
    clearing: { card: owed.card, momo: owed.momo },
    trialBalanced: totalDebit === totalCredit,
    failedReceipts: receipts.filter((r) => r.status === 'failed' || r.status === 'bounced').length,
    failedBookingNotices: notices.filter((n) => n.stage === 'group_placed' && n.status === 'failed').length,
    failedSummaries: reports.filter((r) => r.$createdAt >= weekAgo && r.delivery_status === 'failed' && r.kind !== 'health').length,
    lastHealthRun: latest('health'),
    lastBackup: latest('backup'),
    lastDigest: latest('daily_digest'),
  };
}

/** The last nightly check, as it was written down. */
export async function lastHealthReport(venueId: string): Promise<{ at: string; findings: unknown[]; words: string } | null> {
  const res = await db.listDocuments(DB_ID, 'summary_reports', [
    Query.equal('venue_id', venueId), Query.equal('kind', 'health'), Query.orderDesc('$createdAt'), Query.limit(1),
  ]).catch(() => ({ documents: [] as unknown[] }));
  const row = res.documents[0] as { $createdAt: string; payload?: string } | undefined;
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload || '{}');
    return { at: row.$createdAt, findings: payload.findings ?? [], words: payload.words ?? '' };
  } catch {
    return { at: row.$createdAt, findings: [], words: '' };
  }
}
