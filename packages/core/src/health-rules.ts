/**
 * Records that do not add up, and jobs that have gone quiet.
 *
 * Every screen in this system trusts that the rows behind it are whole: a
 * closed shift has its entries, a paid order has its payment, a maker's
 * payout has its ledger line. Each of those is written in two or three
 * steps by a browser that can lose its connection between any of them, and
 * a half-written record does not announce itself — it is found weeks later
 * as a figure somebody cannot explain.
 *
 * So the same questions are asked every night by the server and whenever
 * somebody opens the Health page, and the answers are listed with what to
 * do about each. The questions live here, with nothing else in the way; the
 * reading of the rows is in health.ts (browser) and functions/notify/src/
 * health.js (server), and a parity test holds the server's copy of these
 * rules to this file.
 *
 * Pure. Imports nothing at runtime.
 */

export type SchemaWord = 'current' | 'behind' | 'unknown';

export interface HealthFacts {
  /** When the facts were read, ISO. */
  now: string;
  schema: SchemaWord;
  /** Closed shifts the books have not got, past the grace the sweep is allowed. */
  unpostedShifts: { code: string; closedAt: string }[];
  /** Journal entries with no lines at all, or whose lines do not balance. */
  emptyEntries: { id: string; date: string; memo: string }[];
  unbalancedEntries: { id: string; date: string; memo: string; off: number }[];
  /** Spends recorded and not on the books, past the grace. */
  unpostedSpends: { id: string; amount: number }[];
  /** Spends that say stock was bought, with no line that reached a shelf. */
  stockSpendsWithoutLines: { id: string; amount: number }[];
  /** Spends still waiting for somebody, older than the wait allowed. */
  staleSpends: number;
  /** Shop counts left half applied: some lines moved the shelf, some did not. */
  halfCounts: { id: string; countedAt: string; applied: number; lines: number }[];
  /** Counts of either kind waiting longer than the wait allowed. */
  staleCounts: number;
  /** Paid orders with no payment row behind them. */
  paidOrdersNoPayment: { orderNo: string; total: number }[];
  /**
   * Bills with more money against them than they came to.
   *
   * The same order paid twice. The server voids these as they arrive now, so
   * this is looking for the ones that went through before it did.
   */
  overpaidOrders: { orderNo: string; total: number; taken: number }[];
  settledOnPaper: { orderNo: string; total: number; taken: number }[];
  ordersNotAddingUp: { orderNo: string; subtotal: number; lines: number }[];
  /** Orders with no lines on them. */
  ordersNoLines: { orderNo: string }[];
  /** Lines sold as a size and rewritten by the server to the plain item's price. See sizesMispricedFrom. */
  sizesMispriced: SizeMispriced[];
  /** Payouts recorded and never reaching the maker's ledger, or the books. */
  unledgeredPayouts: { reference: string; amount: number }[];
  unpostedPayouts: { reference: string; amount: number }[];
  /** Write-offs with a value that never reached the books. */
  unpostedWaste: number;
  /** Shifts open longer than a day. */
  openShiftsOverDay: { code: string; openedAt: string }[];
  /** Card and mobile money not yet settled to the bank. */
  clearing: { card: number; momo: number };
  /** Whether every debit has its credit. */
  trialBalanced: boolean;
  /** Emails that failed in the last week. */
  failedReceipts: number;
  failedSummaries: number;
  /**
   * Group booking notices that did not reach the house.
   *
   * Its own count rather than folded into the receipts, because it is a
   * different kind of failure: a receipt that fails annoys one customer who
   * already has their food, while a booking notice that fails means a party
   * of forty believes the restaurant knows and the restaurant does not.
   */
  failedBookingNotices: number;
  /** When each background job last left a trace. Absent is never. */
  lastHealthRun?: string;
  lastBackup?: string;
  lastDigest?: string;
}

export type HealthLevel = 'block' | 'warn' | 'ok' | 'info';

export interface HealthFinding {
  key: string;
  level: HealthLevel;
  title: string;
  /** What was found, or "None". */
  detail: string;
  count: number;
  /** Where to go to deal with it. */
  goto?: string;
  /** The button's words, when there is somewhere to go. */
  action?: string;
}

export interface HealthWords {
  money: (minor: number) => string;
}

/** How long a thing may sit before it is a finding rather than a moment in flight. */
export const HEALTH_GRACE = {
  /** A close is posted by the event within seconds, or by the sweep within the hour. */
  postingHours: 2,
  /** A spend nobody has looked at. */
  spendDays: 3,
  /** A count nobody has decided. */
  countDays: 7,
  /** A shift still open. */
  shiftHours: 24,
  /** The nightly job, silent. */
  jobHours: 36,
  /** How far back to look for sizes charged at the plain item's price. */
  sizeLookbackDays: 90,
} as const;

/** One line sold as a size and charged the plain item's price instead. */
export interface SizeMispriced {
  orderNo: string;
  /** "Club · Large", as it was sold. */
  name: string;
  /** What the server wrote the line to. */
  charged: number;
  /** What the till had it at: the size's own price. */
  shouldBe: number;
  /** Paid already — nothing left to put right on the bill, only to know about. */
  paid: boolean;
}

/**
 * SIZES CHARGED AT THE PLAIN ITEM'S PRICE, found from the server's own record.
 *
 * Until the fix in reprice.js, the server re-priced every new order from the
 * item alone and never read the size: a large Club rung up at GH₵30 was
 * rewritten to GH₵25 a second later. Every such rewrite was logged, as
 * "Club · Large: sent 3000, actual 2500", on an `order_price_corrected`
 * entry — and that log, not today's menu, is the evidence. A size's price
 * NOW is no guide to what it was, because a price changed since the sale
 * would look exactly like this.
 *
 * Only lines that were sold as a size count. A correction to a plain item is
 * the guard doing its job — a phone that claimed the wrong price — and has
 * nothing to do with this. A line whose price somebody changed by hand at the
 * till is left out too: that was a decision, not this fault.
 *
 * Pure.
 */
export function sizesMispricedFrom(input: {
  audits: { entity_id?: string; after?: string }[];
  lines: { order_id: string; name_snapshot?: string; variant_id?: string | null; list_price?: number | null; status?: string; line_total?: number }[];
  orders: { $id: string; order_no?: string; payment_status?: string; status?: string }[];
}): SizeMispriced[] {
  const orderById = new Map(input.orders.map((o) => [o.$id, o]));
  // What each such line is charged now, so one already put right (see
  // size-price.ts) stops being reported.
  const sized = new Map(
    input.lines
      .filter((l) => l.variant_id && l.status !== 'void' && typeof l.list_price !== 'number')
      .map((l) => [`${l.order_id}|${l.name_snapshot ?? ''}`, l.line_total]),
  );
  const out: SizeMispriced[] = [];
  const seen = new Set<string>();

  for (const a of input.audits) {
    const orderId = a.entity_id ?? '';
    const order = orderById.get(orderId);
    // A cancelled bill was never going to be collected; nothing was lost on it.
    if (!order || order.status === 'CANCELLED' || order.status === 'REJECTED') continue;
    let corrections: unknown = [];
    try { corrections = (JSON.parse(a.after || '{}') as { corrections?: unknown }).corrections ?? []; } catch { corrections = []; }
    if (!Array.isArray(corrections)) continue;

    for (const c of corrections) {
      const m = /^(.*): sent (-?\d+), actual (-?\d+)$/.exec(String(c));
      if (!m) continue;
      const [, name = '', sent, actual] = m;
      const key = `${orderId}|${name}`;
      if (!sized.has(key) || seen.has(key)) continue;
      if (Number(sent) === Number(actual)) continue;
      // Already put back to what the till charged.
      if (sized.get(key) === Number(sent)) continue;
      seen.add(key);
      out.push({
        orderNo: order.order_no ?? orderId,
        name,
        charged: Number(actual),
        shouldBe: Number(sent),
        paid: order.payment_status === 'paid',
      });
    }
  }
  // Still to be paid first: those are the ones that can still be put right.
  return out.sort((x, y) => Number(x.paid) - Number(y.paid) || x.orderNo.localeCompare(y.orderNo));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string) => (iso || '').slice(0, 10);
const hoursSince = (iso: string | undefined, now: string): number => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? (Date.parse(now) - t) / 3_600_000 : Number.POSITIVE_INFINITY;
};

const none = (key: string, title: string): HealthFinding => ({ key, level: 'ok', title, detail: 'None', count: 0 });

/**
 * The findings, in the order the page shows them: what stops the books being
 * trusted first, then what is waiting on somebody, then what is only worth
 * knowing.
 */
export function healthFindings(f: HealthFacts, w: HealthWords): HealthFinding[] {
  const out: HealthFinding[] = [];

  // --- the database itself
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

  // --- records that do not add up
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

  /*
    The opposite fault, and the one that inflates a night rather than
    shortening it. See surplusPayment in order-guard: these are voided as they
    arrive now, so anything listed here went through before that and is still
    sitting in somebody's takings.
  */
  out.push(f.overpaidOrders.length > 0
    ? {
      key: 'orders_overpaid', level: 'block', title: 'Bills paid more than once', count: f.overpaidOrders.length,
      detail: f.overpaidOrders.slice(0, 4).map((o) => `${o.orderNo} took ${w.money(o.taken)} on a ${w.money(o.total)} bill`).join(', ') + (f.overpaidOrders.length > 4 ? ', …' : '') + '. Open the order and void the payments that were recorded twice.',
      goto: '/orders', action: 'Open orders',
    }
    : none('orders_overpaid', 'Bills paid more than once'));

  /*
    A bill whose money is all there, still reading as owed for.

    ORD0889: GH₵210, paid in full, showing "partial". The money is in the
    drawer and the bill says it is not — which overstates what is still owed,
    holds an order on the pass that is finished, and blocks a shift close for a
    debt nobody has.

    A block rather than a warning, and not because anything is missing: it is
    the books disagreeing with the drawer, and the drawer is right.
  */
  out.push(f.settledOnPaper.length > 0
    ? {
      key: 'orders_settled_on_paper', level: 'block', title: 'Bills paid in full but not marked paid',
      count: f.settledOnPaper.length,
      detail: f.settledOnPaper.slice(0, 4).map((o) => `${o.orderNo} took ${w.money(o.taken)} on a ${w.money(o.total)} bill`).join(', ') + (f.settledOnPaper.length > 4 ? ', …' : '') + '. Open each one and press “Recheck total”: it puts the bill back in step with the money already against it.',
      goto: '/orders', action: 'Open orders',
    }
    : none('orders_settled_on_paper', 'Bills paid in full but not marked paid'));

  /*
    A bill that does not add up to its own items.

    ORD0866: a quesadilla at 90 and a kelewele at 40, charged as 90. The server
    reprices every line and used to SKIP any line whose dish it could not read,
    so the line stayed on the bill with its price beside it and left the total.
    Nothing said so, and nobody adds a bill up by hand when every item on it
    already shows a price.

    It cannot drop a line now — see reprice.js — but every order it already
    happened to is still there, undercharged, and this is the only thing that
    finds them. A block rather than a warning: it is money that was not taken.
  */
  out.push(f.ordersNotAddingUp.length > 0
    ? {
      key: 'orders_not_adding_up', level: 'block', title: 'Bills that do not add up to their items',
      count: f.ordersNotAddingUp.length,
      detail: f.ordersNotAddingUp.slice(0, 4).map((o) => `${o.orderNo} charged ${w.money(o.subtotal)} on ${w.money(o.lines)} of items`).join(', ') + (f.ordersNotAddingUp.length > 4 ? ', …' : '') + '. Open each one and press "Recheck total".',
      goto: '/orders', action: 'Open orders',
    }
    : none('orders_not_adding_up', 'Bills that do not add up to their items'));

  /*
    Sizes charged at the plain item's price. See sizesMispricedFrom.

    A block while any of them is still unpaid, because that bill can still be
    put right before the money is taken. Once they are all paid it is a
    warning: there is nothing left to correct, but the figure is money the
    business did not take (or took too much of) and somebody should know it.
  */
  const sizes = f.sizesMispriced;
  const under = sizes.reduce((n, s) => n + Math.max(0, s.shouldBe - s.charged), 0);
  const over = sizes.reduce((n, s) => n + Math.max(0, s.charged - s.shouldBe), 0);
  const unpaidSizes = sizes.filter((s) => !s.paid);
  out.push(sizes.length > 0
    ? {
      key: 'sizes_mispriced',
      level: unpaidSizes.length > 0 ? 'block' : 'warn',
      title: 'Sizes charged at the plain item’s price',
      count: sizes.length,
      detail: sizes.slice(0, 4).map((s) => `${s.orderNo} ${s.name} charged ${w.money(s.charged)}, should be ${w.money(s.shouldBe)}${s.paid ? ' (paid)' : ''}`).join('; ')
        + (sizes.length > 4 ? '; …' : '')
        + `. In the last ${HEALTH_GRACE.sizeLookbackDays} days: ${w.money(under)} undercharged`
        + `${over > 0 ? ` and ${w.money(over)} overcharged` : ''}.`
        + (unpaidSizes.length > 0
          ? ` ${plural(unpaidSizes.length, 'bill is', 'bills are')} not paid yet: open each on Orders and press Correct the price.`
          : ' All of them are paid, so there is nothing left to change; this is what it cost. Fixed for new orders.'),
      goto: '/orders', action: 'Open orders',
    }
    : none('sizes_mispriced', 'Sizes charged at the plain item’s price'));

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

  // --- waiting on somebody
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

  // --- the jobs
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
  /*
    Warn, not info.

    A booking notice that did not arrive is a party expecting food from a
    kitchen that has never heard of them. The commonest cause is that no
    admin or manager has an email address on their staff profile, so that is
    what the line says to go and check.
  */
  out.push(f.failedBookingNotices > 0
    ? { key: 'booking_mail', level: 'warn', title: 'Group bookings nobody here was told about', count: f.failedBookingNotices, detail: `${plural(f.failedBookingNotices, 'booking notice', 'booking notices')} did not get through this week. The usual cause is that no admin or manager has an email address on their staff profile. You can also name an address under Features, Group ordering.`, goto: '/staff', action: 'Open staff' }
    : none('booking_mail', 'Group bookings nobody here was told about'));

  return out;
}

/** The headline: how many things need fixing, and how many are only worth knowing. */
export function healthSummary(findings: HealthFinding[]): { blocks: number; warns: number; words: string } {
  const blocks = findings.filter((x) => x.level === 'block').length;
  const warns = findings.filter((x) => x.level === 'warn').length;
  const words = blocks > 0
    ? `${plural(blocks, 'thing needs', 'things need')} fixing${warns > 0 ? `, and ${plural(warns, 'thing is', 'things are')} waiting on somebody` : ''}.`
    : warns > 0
      ? `Nothing is broken. ${plural(warns, 'thing is', 'things are')} waiting on somebody.`
      : 'Everything adds up.';
  return { blocks, warns, words };
}
