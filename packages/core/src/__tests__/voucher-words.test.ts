import test from 'node:test';
import assert from 'node:assert/strict';
import {
  voucherHeadline, voucherDays, voucherHours, voucherTerms,
  voucherValidity, voucherCodeWords, voucherHasCode, voucherPrintProblem,
  voucherEmailProblem, looksLikeEmail, mayBeOffered, splitAddresses,
} from '../voucher-words.ts';
import type { PrintableVoucher } from '../voucher-words.ts';

/*
  A voucher printed and handed over is read by somebody who has never seen the
  admin screen. "percent · 2000 · max 5000" means nothing to them; what they
  need is a headline they can read across a room and the conditions they would
  otherwise discover at the till with a queue behind them.
*/

const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;
const dateWords = (s: string) => new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const voucher = (over: Partial<PrintableVoucher> = {}): PrintableVoucher => ({
  name: 'Friends & Family', kind: 'percent', value: 3000, ...over,
});

test('the headline says what it is worth, in the words of the offer', () => {
  assert.equal(voucherHeadline(voucher(), money), '30% OFF');
  assert.equal(voucherHeadline(voucher({ kind: 'amount', value: 5_000 }), money), 'GH₵50.00 OFF');
  assert.equal(voucherHeadline(voucher({ kind: 'free_delivery' }), money), 'FREE DELIVERY');
  assert.equal(voucherHeadline(voucher({ kind: 'free_item' }), money), 'A FREE ITEM');
});

test('half a percent is said as half a percent', () => {
  // Stored in basis points precisely so it can be, and "12.5% OFF" printed as
  // "13% OFF" is a figure the till will not agree with.
  assert.equal(voucherHeadline(voucher({ value: 1_250 }), money), '12.5% OFF');
  assert.equal(voucherHeadline(voucher({ value: 2_000 }), money), '20% OFF');
});

test('an offer nobody recognises still gets a headline rather than a blank', () => {
  assert.equal(voucherHeadline(voucher({ kind: 'something_new' }), money), 'A DISCOUNT');
});

/* ------------------------------------------------------- when it runs */

test('days are named, and every day is said by saying nothing', () => {
  assert.equal(voucherDays(['mon', 'tue', 'wed']), 'Mon, Tue and Wed');
  assert.equal(voucherDays(['fri']), 'Fri');
  assert.equal(voucherDays([]), '', 'no restriction is not a restriction worth printing');
  assert.equal(voucherDays(undefined), '');
  assert.equal(voucherDays(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']), '', 'all seven is every day');
});

test('hours need both ends to mean anything', () => {
  assert.equal(voucherHours(voucher({ time_start: '12:00', time_end: '16:00' })), '12:00 to 16:00');
  assert.equal(voucherHours(voucher({ time_start: '12:00' })), '', 'half a window is no window');
});

test('validity reads as a date, whichever ends are set', () => {
  assert.match(voucherValidity(voucher({ ends_at: '2026-12-31' }), dateWords), /^Until 31 Dec 2026$/);
  assert.match(voucherValidity(voucher({ starts_at: '2026-10-01' }), dateWords), /^From 1 Oct 2026$/);
  assert.match(
    voucherValidity(voucher({ starts_at: '2026-10-01', ends_at: '2026-12-31' }), dateWords),
    /1 Oct 2026 .+ 31 Dec 2026/,
  );
  assert.equal(voucherValidity(voucher(), dateWords), 'No end date');
});

/* ------------------------------------------------------ the small print */

test('every reason somebody could be refused is printed', () => {
  /*
    The whole point of the small print. Each of these is a moment at the
    counter where a customer is told no in front of other customers, and each
    is avoidable by having told them on the paper.
  */
  const lines = voucherTerms(voucher({
    min_order_total: 5_000,
    max_discount_amount: 10_000,
    days_of_week: ['mon', 'tue'],
    time_start: '12:00',
    time_end: '16:00',
    first_order_only: true,
    usage_limit_per_customer: 1,
    requires_manager: true,
  }), money);
  const all = lines.join(' ');
  assert.match(all, /Spend at least GH₵50\.00/);
  assert.match(all, /most it takes off is GH₵100\.00/);
  assert.match(all, /Mon and Tue only, between 12:00 to 16:00/);
  assert.match(all, /First order only/);
  assert.match(all, /Once per customer/);
  assert.match(all, /manager has to approve/);
});

test('a plain voucher carries only the line every voucher carries', () => {
  const lines = voucherTerms(voucher(), money);
  assert.equal(lines.length, 1);
  assert.match(lines[0] as string, /One voucher per bill/);
});

test('a cap is only printed where a cap can apply', () => {
  // A cap on a fixed amount off is meaningless — the amount IS the cap — and
  // printing it invites the question of which of the two figures wins.
  const capped = voucherTerms(voucher({ kind: 'amount', value: 5_000, max_discount_amount: 10_000 }), money);
  assert.equal(capped.some((l) => /most it takes off/.test(l)), false);
});

test('what is LEFT is printed, not what it started as', () => {
  /*
    A voucher limited to fifty with forty-eight gone is worth printing as two.
    A customer holding one that promises fifty when there are two left is the
    complaint this avoids.
  */
  const lines = voucherTerms(voucher({ usage_limit_total: 50, used_count: 48 }), money);
  assert.match(lines.join(' '), /2 of these left/);
  assert.doesNotMatch(lines.join(' '), /50/);
});

test('a used-up voucher says so rather than promising nothing left', () => {
  const lines = voucherTerms(voucher({ usage_limit_total: 50, used_count: 50 }), money);
  assert.match(lines.join(' '), /All of these have now been used/);
});

/* ------------------------------------------------------------- the code */

test('the code is printed as it will be typed', () => {
  assert.equal(voucherCodeWords(voucher({ code: ' fandf30 ' })), 'FANDF30');
  assert.equal(voucherHasCode(voucher({ code: 'fandf30' })), true);
});

test('a staff-only voucher says what to do instead of showing an empty box', () => {
  // There is no code to hunt for, and a blank panel would have somebody
  // turning the paper over looking for one.
  assert.equal(voucherCodeWords(voucher()), 'ASK A MEMBER OF STAFF');
  assert.equal(voucherCodeWords(voucher({ code: '   ' })), 'ASK A MEMBER OF STAFF');
  assert.equal(voucherHasCode(voucher({ code: '  ' })), false);
});

/* --------------------------------------------- what should not be handed out */

test('a voucher that would be refused at the till is not printed', () => {
  const now = new Date('2026-09-21T10:00:00Z');
  assert.match(String(voucherPrintProblem(voucher({ active: false }), now)), /switched off/i);
  assert.match(String(voucherPrintProblem(voucher({ ends_at: '2026-09-01' }), now)), /already ended/i);
  assert.match(
    String(voucherPrintProblem(voucher({ usage_limit_total: 10, used_count: 10 }), now)),
    /used up/i,
  );
});

test('a live voucher prints', () => {
  const now = new Date('2026-09-21T10:00:00Z');
  assert.equal(voucherPrintProblem(voucher({ active: true, ends_at: '2026-12-31' }), now), null);
  assert.equal(voucherPrintProblem(voucher({ usage_limit_total: 10, used_count: 9 }), now), null);
  // No end date is not an expired one.
  assert.equal(voucherPrintProblem(voucher(), now), null);
});

test('an unreadable end date does not stop a voucher printing', () => {
  // Date.parse hands back NaN, and treating that as "ended" would refuse to
  // print a perfectly good voucher over a typo in a field nobody looks at.
  const now = new Date('2026-09-21T10:00:00Z');
  assert.equal(voucherPrintProblem(voucher({ ends_at: 'not a date' }), now), null);
});

/* ------------------------------------------ who an offer may be sent to */

test('an offer only goes to somebody who agreed to be sent offers', () => {
  /*
    A VOUCHER IS MARKETING. Somebody who gave an address to get a receipt has
    not asked for offers, and sending them one anyway is what gets a
    restaurant's mail marked as spam — after which the receipts stop arriving
    too.
  */
  assert.match(
    String(voucherEmailProblem({ name: 'Ama', email: 'ama@x.com', marketing_opt_in: false })),
    /has not agreed to be sent offers/,
  );
  assert.equal(voucherEmailProblem({ email: 'ama@x.com', marketing_opt_in: true }), null);
});

test('a nonsense address is caught before a row is written', () => {
  assert.match(String(voucherEmailProblem({ email: 'ama at example', marketing_opt_in: true })), /email address/);
  assert.match(String(voucherEmailProblem({ marketing_opt_in: true })), /email address/);
  assert.equal(looksLikeEmail('ama@example.com'), true);
  assert.equal(looksLikeEmail('ama@example'), false, 'no dot is not an address');
  assert.equal(looksLikeEmail(''), false);
});

test('the customer list offers only those who may be written to', () => {
  const rows = [
    { name: 'Zoe', email: 'zoe@x.com', marketing_opt_in: true },
    { name: 'Ama', email: 'ama@x.com', marketing_opt_in: true },
    { name: 'Kofi', email: 'kofi@x.com', marketing_opt_in: false },
    { name: 'Nobody', marketing_opt_in: true },
    // Never agreed either way, which is not agreement.
    { name: 'Quiet', email: 'quiet@x.com' },
  ];
  assert.deepEqual(mayBeOffered(rows).map((r) => r.name), ['Ama', 'Zoe'], 'opted in only, in name order');
});

test('a pasted list comes apart however it was separated', () => {
  // People paste. Commas, semicolons, spaces and new lines all turn up.
  assert.deepEqual(
    splitAddresses('ama@x.com, kofi@x.com;  zoe@x.com\nyaw@x.com'),
    ['ama@x.com', 'kofi@x.com', 'zoe@x.com', 'yaw@x.com'],
  );
  assert.deepEqual(splitAddresses('  '), []);
  // The same person twice is one message.
  assert.deepEqual(splitAddresses('Ama@X.com, ama@x.com'), ['ama@x.com']);
});

/* --------------------------------------- the copy the mail job actually runs */

/*
  The notify job cannot import this file: a function is deployed on its own
  with no workspace around it. So functions/notify/src/voucher-words.js is a
  deliberate hand copy, and if the two drift a voucher a customer is EMAILED
  says something different from the one this page PRINTED — a difference
  discovered at the counter, where it is somebody else's problem.
*/
test('the mail job says exactly what the printed voucher says', async () => {
  const job = await import('../../../../functions/notify/src/voucher-words.js');
  const cases: PrintableVoucher[] = [
    voucher(),
    voucher({ kind: 'amount', value: 5_000 }),
    voucher({ kind: 'free_delivery' }),
    voucher({ kind: 'free_item' }),
    voucher({ value: 1_250 }),
    voucher({
      min_order_total: 5_000, max_discount_amount: 10_000, days_of_week: ['mon', 'tue'],
      time_start: '12:00', time_end: '16:00', first_order_only: true,
      usage_limit_per_customer: 2, usage_limit_total: 50, used_count: 48, requires_manager: true,
    }),
    voucher({ code: 'fandf30' }),
    voucher({ starts_at: '2026-10-01', ends_at: '2026-12-31' }),
  ];
  for (const v of cases) {
    assert.equal(job.voucherHeadline(v, money), voucherHeadline(v, money), v.kind);
    assert.deepEqual(job.voucherTerms(v, money), voucherTerms(v, money));
    assert.equal(job.voucherValidity(v, dateWords), voucherValidity(v, dateWords));
    assert.equal(job.voucherCodeWords(v), voucherCodeWords(v));
    assert.equal(job.voucherHasCode(v), voucherHasCode(v));
  }
  const now = new Date('2026-09-21T10:00:00Z');
  for (const v of [voucher({ active: false }), voucher({ ends_at: '2026-09-01' }), voucher()]) {
    assert.equal(job.voucherPrintProblem(v, now), voucherPrintProblem(v, now));
  }
});
