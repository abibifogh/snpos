import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listedTotal, whyLoose, looseTakings, missingOrderIds, looseWords,
  type CountedPayment, type ListedOrder,
} from '../shift-reconcile.ts';
import { shiftStampForPayment } from '../shift-move.ts';

const live = (p: { status?: string }) => p.status !== 'voided' && p.status !== 'refunded';
const shift = { $id: 'sh-craft', module: 'craft' };
const pay = (over: Partial<CountedPayment> = {}): CountedPayment =>
  ({ $id: 'pay1', order_id: 'o1', amount: 10_400, ...over });
const order = (over: Partial<ListedOrder> = {}): ListedOrder =>
  ({ $id: 'o1', order_no: 'CR0001', status: 'CLOSED', module: 'craft', shift_id: 'sh-craft', ...over });

test('the sales on the list add up to what the eye adds up', () => {
  assert.equal(listedTotal([{ total: 10_400 }, { total: 90_000 }]), 100_400);
  assert.equal(listedTotal([]), 0);
  // A row with no total contributes nothing rather than NaN, which is worse
  // than a wrong number because nothing on screen looks like an error.
  assert.equal(listedTotal([{ total: 10_400 }, {}]), 10_400);
});

test('a shift whose payments all match its sales explains nothing', () => {
  /**
   * The ordinary case, and it has to stay silent. A panel that printed a
   * reconciliation note on every shift would be one people stop reading, which
   * costs the one shift where it mattered.
   */
  const { rows, amount } = looseTakings({
    payments: [pay(), pay({ $id: 'pay2', order_id: 'o2', amount: 90_000 })],
    orders: [order(), order({ $id: 'o2', order_no: 'CR0002' })],
    shift,
    live,
  });
  assert.deepEqual(rows, []);
  assert.equal(amount, 0);
});

test('money taken here for another trade\'s bill is named, not hidden', () => {
  /**
   * The failure this was written for. A craft shift showed GH₵1,260 in over
   * two orders totalling GH₵1,004, and there was nowhere on the screen to find
   * the missing GH₵256 — which turns into somebody being asked where the money
   * went.
   *
   * The money genuinely IS in this drawer and the sale genuinely IS the bar's.
   * Both are true, and the screen has to say so.
   */
  const { rows, amount } = looseTakings({
    payments: [pay(), pay({ $id: 'pay2', order_id: 'o-bar', amount: 25_600 })],
    orders: [order()],
    found: new Map([['o-bar', order({ $id: 'o-bar', order_no: 'BR0007', module: 'bar', shift_id: 'sh-bar' })]]),
    shift,
    live,
  });
  assert.equal(rows.length, 1);
  assert.equal(amount, 25_600);
  assert.match(rows[0].why, /bar bill settled at this counter/);
  assert.equal(rows[0].order?.order_no, 'BR0007');
});

test('tips are part of what is in the drawer', () => {
  const { amount } = looseTakings({
    payments: [pay({ order_id: 'gone', amount: 10_000, tip: 500 })],
    orders: [],
    shift,
    live,
  });
  assert.equal(amount, 10_500);
});

test('a payment that was voided or refunded is not in the drawer', () => {
  /*
    Money that was taken back was not taken. Counting a refunded payment as
    unexplained would invent a discrepancy on a shift that is perfectly
    correct — the worst kind of false alarm, because it appears on the screen
    somebody is counting cash against.
  */
  const { rows } = looseTakings({
    payments: [pay({ order_id: 'gone', status: 'refunded' }), pay({ $id: 'p2', order_id: 'gone2', status: 'voided' })],
    orders: [],
    shift,
    live,
  });
  assert.deepEqual(rows, []);
});

test('each reason is a different thing to do about it', () => {
  // Simply true, and needs nothing doing.
  assert.match(whyLoose(order({ module: 'bar' }), shift), /counts on the bar/);
  // Somebody's mistake to put right today.
  assert.match(whyLoose(order({ status: 'CANCELLED' }), shift), /was not handed back/);
  // The move took the sale and left the money.
  assert.match(whyLoose(order({ shift_id: 'sh-other' }), shift), /moved to another shift/);
  // The rarest and the most worth seeing.
  assert.match(whyLoose(null, shift), /no longer on file/);
});

test('a payment attached to no sale at all is shown rather than skipped', () => {
  /**
   * Money recorded against nothing is either a mistake being made repeatedly
   * or a sale that was deleted, and both are things somebody should be told
   * about the first time rather than the twentieth.
   */
  const { rows } = looseTakings({ payments: [pay({ order_id: '' })], orders: [], shift, live });
  assert.equal(rows.length, 1);
  assert.match(rows[0].why, /not attached to any sale/);
});

test('an ordinary shift reads nothing extra to explain itself', () => {
  /**
   * The lookup only covers payments that actually failed to match. A screen
   * that paid for an explanation it never needs would cost a read on every
   * shift in the building, all day — and read allowance is not an abstract
   * concern on this system.
   */
  assert.deepEqual(missingOrderIds([pay()], [order()]), []);
  assert.deepEqual(missingOrderIds([pay({ order_id: 'o-bar' })], [order()]), ['o-bar']);
  // Asked for once, however many payments settled the same bill.
  assert.deepEqual(
    missingOrderIds([pay({ order_id: 'o-bar' }), pay({ $id: 'p2', order_id: 'o-bar' })], []),
    ['o-bar'],
  );
  assert.deepEqual(missingOrderIds([pay({ order_id: '' })], []), [], 'nothing to look up');
});

test('the explanation reads as arithmetic somebody can follow', () => {
  // The person reading it is holding a pile of cash and comparing it to a
  // number, so it has to be addable by eye.
  const words = looseWords(100_400, 25_600, (n) => `GHS ${(n / 100).toFixed(2)}`);
  assert.match(words, /GHS 1004\.00/);
  assert.match(words, /GHS 256\.00/);
  assert.match(words, /GHS 1260\.00/);
});

test('settling a bar bill at the craft counter leaves the sale on the bar', () => {
  /**
   * THE ROOT CAUSE of the figures not adding up.
   *
   * Settling rewrote the order's shift to whichever till took the money. Across
   * two sides that orphaned the sale outright: belongsToShift refuses it on the
   * craft shift because it is a bar sale, and refuses it on the bar shift
   * because a stamp wins over the clock and the stamp now said craft. The order
   * appeared on neither list while its money sat in the craft takings.
   */
  assert.equal(
    shiftStampForPayment({
      order: { shift_id: 'sh-bar', module: 'bar' },
      shiftId: 'sh-craft',
      shiftModule: 'craft',
    }),
    null,
    'the sale stays with the bar',
  );
});

test('a handover within one side still moves the sale with the money', () => {
  /*
    The behaviour this must not break. An order rung up before a handover and
    paid after it belongs to the shift that actually holds the cash, and that
    is one trade's own business.
  */
  assert.equal(
    shiftStampForPayment({
      order: { shift_id: 'sh-morning', module: 'kitchen' },
      shiftId: 'sh-evening',
      shiftModule: 'kitchen',
    }),
    'sh-evening',
  );

  // An order with no shift at all is filed under whichever shift settled it —
  // the only shift with any claim on it.
  assert.equal(
    shiftStampForPayment({ order: {}, shiftId: 'sh-evening', shiftModule: 'craft' }),
    'sh-evening',
  );

  // Already here: nothing to write.
  assert.equal(
    shiftStampForPayment({ order: { shift_id: 'sh-evening' }, shiftId: 'sh-evening' }),
    null,
  );
});

test('a caller that does not say which side keeps working as it did', () => {
  // Handovers must not silently stop working for a screen that has not been
  // told about sides yet.
  assert.equal(
    shiftStampForPayment({ order: { shift_id: 'sh-a', module: 'bar' }, shiftId: 'sh-b' }),
    'sh-b',
  );
  assert.equal(shiftStampForPayment({ order: {}, shiftId: '' }), null, 'no shift to file under');
});
