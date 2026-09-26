import test from 'node:test';
import assert from 'node:assert/strict';
import { healthFindings, healthSummary, HEALTH_GRACE, sizesMispricedFrom } from '../health-rules.ts';
import type { HealthFacts } from '../health-rules.ts';
import * as server from '../../../../functions/notify/src/health.js';

const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;
const NOW = '2026-09-09T03:00:00.000Z';

const clean: HealthFacts = {
  now: NOW,
  schema: 'current',
  unpostedShifts: [],
  emptyEntries: [],
  unbalancedEntries: [],
  unpostedSpends: [],
  stockSpendsWithoutLines: [],
  staleSpends: 0,
  halfCounts: [],
  staleCounts: 0,
  paidOrdersNoPayment: [],
  overpaidOrders: [],
  settledOnPaper: [],
  ordersNotAddingUp: [],
  sizesMispriced: [],
  ordersNoLines: [],
  unledgeredPayouts: [],
  unpostedPayouts: [],
  unpostedWaste: 0,
  openShiftsOverDay: [],
  clearing: { card: 0, momo: 0 },
  trialBalanced: true,
  failedReceipts: 0,
  failedSummaries: 0,
  failedBookingNotices: 0,
  lastHealthRun: '2026-09-08T02:05:00.000Z',
  lastBackup: '2026-09-08T23:10:00.000Z',
  lastDigest: '2026-09-08T23:05:00.000Z',
};

test('a clean night is every question answered "None" and nothing to fix', () => {
  const findings = healthFindings(clean, { money });
  assert.ok(findings.every((f) => f.level === 'ok'), findings.filter((f) => f.level !== 'ok').map((f) => f.key).join(','));
  assert.deepEqual(healthSummary(findings), { blocks: 0, warns: 0, words: 'Everything adds up.' });
  // Every question is asked every time, so the page can show what was checked.
  assert.equal(findings.length, 23);
});

test('what stops the books being trusted is a block; what is waiting on somebody is a warning', () => {
  const f: HealthFacts = {
    ...clean,
    unpostedShifts: [{ code: 'BIST-08', closedAt: '2026-09-07T22:00:00Z' }],
    unbalancedEntries: [{ id: 'e1', date: '2026-09-04T12:00:00Z', memo: 'Shift sales', off: -300 }],
    unpostedSpends: [{ id: 's1', amount: 1_200 }, { id: 's2', amount: 660 }],
    paidOrdersNoPayment: [{ orderNo: 'ORD-412', total: 8_500 }],
    unledgeredPayouts: [{ reference: 'PAY-0012', amount: 14_000 }],
    staleSpends: 3,
    openShiftsOverDay: [{ code: 'BAR-02', openedAt: '2026-09-07T17:00:00Z' }],
    clearing: { card: 0, momo: 12_400 },
  };
  const findings = healthFindings(f, { money });
  const by = Object.fromEntries(findings.map((x) => [x.key, x]));
  assert.equal(by.shifts_unposted.level, 'block');
  assert.match(by.shifts_unposted.detail, /BIST-08 \(2026-09-07\)/);
  assert.equal(by.entries_broken.level, 'block');
  assert.match(by.entries_broken.detail, /2026-09-04 Shift sales: off by GH₵3\.00/);
  assert.equal(by.spends_unposted.count, 2);
  assert.match(by.spends_unposted.detail, /GH₵18\.60/);
  assert.equal(by.orders_no_payment.level, 'block');
  assert.equal(by.payouts.level, 'block');
  assert.equal(by.spends_stale.level, 'warn');
  assert.equal(by.shifts_open.level, 'warn');
  assert.equal(by.clearing.level, 'info');
  assert.equal(by.clearing.goto, '/accounting');
  assert.deepEqual(healthSummary(findings), {
    blocks: 5, warns: 2, words: '5 things need fixing, and 2 things are waiting on somebody.',
  });
});

test('a payout on the shop’s books but not the maker’s ledger is the worse of the two', () => {
  const ledgerOnly = healthFindings({ ...clean, unpostedPayouts: [{ reference: 'PAY-1', amount: 5 }] }, { money });
  assert.equal(ledgerOnly.find((x) => x.key === 'payouts')?.level, 'warn');
  const makerOwed = healthFindings({ ...clean, unledgeredPayouts: [{ reference: 'PAY-1', amount: 5 }] }, { money });
  assert.equal(makerOwed.find((x) => x.key === 'payouts')?.level, 'block');
});

test('a quiet job is noticed after a day and a half, and never having run says so', () => {
  const stale = healthFindings({ ...clean, lastHealthRun: '2026-09-07T02:00:00Z' }, { money });
  assert.equal(stale.find((x) => x.key === 'job_health')?.level, 'warn');
  const fresh = healthFindings({ ...clean, lastHealthRun: '2026-09-08T02:00:00Z' }, { money });
  assert.equal(fresh.find((x) => x.key === 'job_health')?.level, 'ok');
  const never = healthFindings({ ...clean, lastHealthRun: undefined, lastBackup: undefined }, { money });
  assert.match(never.find((x) => x.key === 'job_health')?.detail ?? '', /never run/);
  assert.match(never.find((x) => x.key === 'job_backup')?.detail ?? '', /No copy has ever been made/);
  assert.equal(HEALTH_GRACE.jobHours, 36);
});

test('the database being behind is the first thing said', () => {
  const findings = healthFindings({ ...clean, schema: 'behind' }, { money });
  assert.equal(findings[0].key, 'schema');
  assert.equal(findings[0].level, 'block');
  assert.equal(findings[0].goto, 'provision');
  assert.equal(healthSummary(findings).words, '1 thing needs fixing.');
  assert.equal(healthFindings({ ...clean, schema: 'unknown' }, { money })[0].level, 'warn');
});

test('the words say so when nothing is broken but something waits', () => {
  const findings = healthFindings({ ...clean, staleCounts: 2 }, { money });
  assert.equal(healthSummary(findings).words, 'Nothing is broken. 1 thing is waiting on somebody.');
  assert.match(findings.find((x) => x.key === 'counts_stale')?.detail ?? '', /2 counts/);
});

/* ---------------------------------------------------- the server's copy */

test('the nightly check asks the same questions and gives the same answers', () => {
  const cases: HealthFacts[] = [
    clean,
    { ...clean, schema: 'behind' },
    { ...clean, schema: 'unknown', lastHealthRun: undefined },
    {
      ...clean,
      unpostedShifts: [{ code: 'BIST-08', closedAt: '2026-09-07T22:00:00Z' }, { code: 'A', closedAt: '' }, { code: 'B', closedAt: '' }, { code: 'C', closedAt: '' }, { code: 'D', closedAt: '' }],
      emptyEntries: [{ id: 'e0', date: '2026-09-01', memo: '' }],
      unbalancedEntries: [{ id: 'e1', date: '2026-09-04T12:00:00Z', memo: 'Shift sales', off: 300 }],
      unpostedSpends: [{ id: 's1', amount: 1_200 }],
      stockSpendsWithoutLines: [{ id: 's3', amount: 900 }],
      halfCounts: [{ id: 'c1', countedAt: '2026-09-02T10:00:00Z', applied: 3, lines: 9 }],
      paidOrdersNoPayment: [{ orderNo: 'ORD-1', total: 100 }, { orderNo: 'ORD-2', total: 200 }, { orderNo: 'ORD-3', total: 300 }, { orderNo: 'ORD-4', total: 400 }, { orderNo: 'ORD-5', total: 500 }],
      ordersNoLines: [{ orderNo: 'ORD-9' }],
      sizesMispriced: [
        { orderNo: 'ORD1090', name: 'Club · Large', charged: 2_500, shouldBe: 3_000, paid: false },
        { orderNo: 'ORD1001', name: 'Club · Small', charged: 2_500, shouldBe: 2_000, paid: true },
      ],
      unledgeredPayouts: [{ reference: 'PAY-1', amount: 5 }],
      unpostedPayouts: [{ reference: 'PAY-2', amount: 6 }],
      unpostedWaste: 2,
      staleSpends: 1,
      staleCounts: 4,
      openShiftsOverDay: [{ code: 'BAR-02', openedAt: '2026-09-07T17:00:00Z' }],
      clearing: { card: 500, momo: 12_400 },
      trialBalanced: false,
      failedReceipts: 2,
      failedSummaries: 1,
      failedBookingNotices: 1,
      lastBackup: undefined,
    },
  ];
  for (const c of cases) {
    const mine = healthFindings(c, { money });
    const theirs = server.healthFindings(c, { money });
    assert.deepEqual(theirs, mine, JSON.stringify(c).slice(0, 80));
    assert.deepEqual(server.healthSummary(theirs), healthSummary(mine));
  }
  assert.deepEqual(server.HEALTH_GRACE, HEALTH_GRACE);
});

test('a bill paid more than once stops the books being trusted', () => {
  /*
    A GH₵270 order with three GH₵270 payments on it put the night's takings
    over by GH₵540. The server voids these as they arrive now; this is what
    finds the ones that went through before it did, and it is a BLOCK rather
    than a warning because a drawer counted against those rows cannot be
    reconciled until they are dealt with.
  */
  const findings = healthFindings(
    { ...clean, overpaidOrders: [{ orderNo: 'ORD0800', total: 27_000, taken: 81_000 }] },
    { money },
  );
  const found = findings.find((x) => x.key === 'orders_overpaid');
  assert.equal(found?.level, 'block');
  assert.equal(found?.count, 1);
  assert.match(found?.detail ?? '', /ORD0800 took GH₵810\.00 on a GH₵270\.00 bill/);
  assert.match(found?.detail ?? '', /void the payments that were recorded twice/);

  // And a clean night says so rather than staying silent.
  assert.equal(healthFindings(clean, { money }).find((x) => x.key === 'orders_overpaid')?.level, 'ok');
});

/* ------------------------------------------- sizes charged at the item's price */

/** The server's log entry for one order, as order-guard writes it. */
const audit = (orderId: string, orderNo: string, corrections: string[]) => ({
  entity_id: orderId, after: JSON.stringify({ order_no: orderNo, corrections }),
});

test('a size rewritten to the plain item\'s price is found from the server\'s own log', () => {
  /*
    ORD1090: Club is GH₵25, a large Club GH₵30. The till sent 3000; the server
    wrote 2500 and logged it. The log, not today's menu, is the evidence — a
    size whose price changed since the sale would look exactly like this.
  */
  const found = sizesMispricedFrom({
    audits: [audit('o1', 'ORD1090', ['Club · Large: sent 3000, actual 2500'])],
    lines: [{ order_id: 'o1', name_snapshot: 'Club · Large', variant_id: 'v-large' }],
    orders: [{ $id: 'o1', order_no: 'ORD1090', payment_status: 'unpaid', status: 'PENDING' }],
  });
  assert.deepEqual(found, [{ orderNo: 'ORD1090', name: 'Club · Large', charged: 2_500, shouldBe: 3_000, paid: false }]);
});

test('a line already put back to its size\'s price stops being reported', () => {
  const found = sizesMispricedFrom({
    audits: [audit('o1', 'ORD1090', ['Club · Large: sent 3000, actual 2500'])],
    lines: [{ order_id: 'o1', name_snapshot: 'Club · Large', variant_id: 'v-large', line_total: 3_000 }],
    orders: [{ $id: 'o1', order_no: 'ORD1090', payment_status: 'unpaid', status: 'PENDING' }],
  });
  assert.deepEqual(found, []);
});

test('a correction to a plain item is the guard doing its job, not this fault', () => {
  // A phone that claimed the wrong price for an unsized dish was right to be
  // corrected. Only lines sold as a size count here.
  const found = sizesMispricedFrom({
    audits: [audit('o1', 'ORD1', ['Kelewele: sent 100, actual 4000'])],
    lines: [{ order_id: 'o1', name_snapshot: 'Kelewele' }],
    orders: [{ $id: 'o1', order_no: 'ORD1', payment_status: 'paid' }],
  });
  assert.deepEqual(found, []);
});

test('a price somebody changed by hand, and a cancelled bill, are left out', () => {
  const found = sizesMispricedFrom({
    audits: [
      audit('o1', 'ORD1', ['Club · Large: sent 3000, actual 2500']),
      audit('o2', 'ORD2', ['Club · Large: sent 3000, actual 2500']),
    ],
    lines: [
      { order_id: 'o1', name_snapshot: 'Club · Large', variant_id: 'v', list_price: 3_000 },
      { order_id: 'o2', name_snapshot: 'Club · Large', variant_id: 'v' },
    ],
    orders: [
      { $id: 'o1', order_no: 'ORD1', payment_status: 'paid' },
      { $id: 'o2', order_no: 'ORD2', payment_status: 'unpaid', status: 'CANCELLED' },
    ],
  });
  assert.deepEqual(found, []);
});

test('the unpaid ones come first, because they can still be put right', () => {
  const found = sizesMispricedFrom({
    audits: [
      audit('o1', 'ORD1', ['Club · Large: sent 3000, actual 2500']),
      audit('o2', 'ORD2', ['Club · Large: sent 3000, actual 2500']),
    ],
    lines: [
      { order_id: 'o1', name_snapshot: 'Club · Large', variant_id: 'v' },
      { order_id: 'o2', name_snapshot: 'Club · Large', variant_id: 'v' },
    ],
    orders: [
      { $id: 'o1', order_no: 'ORD1', payment_status: 'paid' },
      { $id: 'o2', order_no: 'ORD2', payment_status: 'unpaid' },
    ],
  });
  assert.deepEqual(found.map((f) => f.orderNo), ['ORD2', 'ORD1']);
});

test('a log that cannot be read is skipped, not a crash', () => {
  assert.deepEqual(sizesMispricedFrom({
    audits: [{ entity_id: 'o1', after: 'not json' }, { entity_id: 'o1', after: '{"corrections":"x"}' }],
    lines: [], orders: [{ $id: 'o1', order_no: 'ORD1' }],
  }), []);
});

test('the finding blocks while a bill can still be corrected, and says what it cost', () => {
  const f = { ...clean, sizesMispriced: [
    { orderNo: 'ORD1090', name: 'Club · Large', charged: 2_500, shouldBe: 3_000, paid: false },
    { orderNo: 'ORD1001', name: 'Club · Large', charged: 2_500, shouldBe: 3_000, paid: true },
    { orderNo: 'ORD1002', name: 'Club · Small', charged: 2_500, shouldBe: 2_000, paid: true },
  ] };
  const sizes = healthFindings(f, { money }).find((x) => x.key === 'sizes_mispriced');
  assert.equal(sizes?.level, 'block');
  assert.equal(sizes?.count, 3);
  assert.match(sizes?.detail ?? '', /ORD1090 Club · Large charged GH₵25\.00, should be GH₵30\.00/);
  assert.match(sizes?.detail ?? '', /GH₵10\.00 undercharged and GH₵5\.00 overcharged/);
  // Cancel and ring up again: the till cannot change the price of an order
  // already placed, only of a basket before it is sent.
  assert.match(sizes?.detail ?? '', /1 bill is not paid yet: open each on Orders and press Correct the price/);

  // All paid: nothing left to correct, so a warning, and it says so.
  const allPaid = healthFindings({ ...clean, sizesMispriced: f.sizesMispriced.filter((s) => s.paid) }, { money })
    .find((x) => x.key === 'sizes_mispriced');
  assert.equal(allPaid?.level, 'warn');
  assert.match(allPaid?.detail ?? '', /All of them are paid. Where the customers paid the size’s price, put the bills back/);
});

test('the server finds the same sizes from the same log', () => {
  const input = {
    audits: [
      audit('o1', 'ORD1', ['Club · Large: sent 3000, actual 2500', 'Kelewele: sent 1, actual 2']),
      audit('o2', 'ORD2', ['Basket · Indigo: sent 9000, actual 8000']),
    ],
    lines: [
      { order_id: 'o1', name_snapshot: 'Club · Large', variant_id: 'v' },
      { order_id: 'o1', name_snapshot: 'Kelewele' },
      { order_id: 'o2', name_snapshot: 'Basket · Indigo', variant_id: 'w' },
    ],
    orders: [{ $id: 'o1', order_no: 'ORD1', payment_status: 'paid' }, { $id: 'o2', order_no: 'ORD2' }],
  };
  assert.deepEqual(server.sizesMispricedFrom(input), sizesMispricedFrom(input));
});
