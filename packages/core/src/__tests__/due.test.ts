import test from 'node:test';
import assert from 'node:assert/strict';
import { amountDueOn, unrungProblem, overpaying } from '../due.ts';

const money = (n: number) => `GHS ${(n / 100).toFixed(2)}`;

test('what is due is the bills, and only the bills', () => {
  /**
   * The failure this exists for. A bracelet rung up at GH₵20 and a lip balm
   * still sitting in the cart at GH₵10: the till asked for GH₵30, then filed
   * all thirty against the bracelet, because a payment can only ever be spread
   * across bills that exist.
   *
   * The visible half was a sale showing 30 paid against a 20 total. The half
   * that matters more is that the lip balm left the shop having never been
   * rung up — off nobody's shelf, on nobody's count sheet, and never paid to
   * whoever made it.
   *
   * There is deliberately nowhere to pass a cart to this function.
   */
  assert.equal(amountDueOn([{ $id: 'o1', total: 2_000 }]), 2_000);
  assert.equal(amountDueOn([{ $id: 'o1', total: 2_000 }, { $id: 'o2', total: 10_400 }]), 12_400);
  assert.equal(amountDueOn([]), 0);
});

test('a bill half settled asks for the other half', () => {
  const orders = [{ $id: 'o1', total: 10_000 }];
  assert.equal(amountDueOn(orders, [{ order_id: 'o1', amount: 4_000 }]), 6_000);
  assert.equal(amountDueOn(orders, [
    { order_id: 'o1', amount: 4_000 },
    { order_id: 'o1', amount: 6_000 },
  ]), 0);
});

test('a tip does not pay down the bill', () => {
  /*
    A tip was never owed. Counting it against the bill would leave the bill
    short by the tip and ask the next person to pay that much a second time.
  */
  assert.equal(amountDueOn([{ $id: 'o1', total: 10_000 }], [{ order_id: 'o1', amount: 4_000, tip: 500 }]), 6_000);
});

test('money that went back out has not been paid', () => {
  const orders = [{ $id: 'o1', total: 10_000 }];
  assert.equal(amountDueOn(orders, [{ order_id: 'o1', amount: 10_000, status: 'refunded' }]), 10_000);
  assert.equal(amountDueOn(orders, [{ order_id: 'o1', amount: 10_000, status: 'voided' }]), 10_000);
  // A row with no status at all is a real payment: the field arrived after the
  // rows did, and reading its absence as voided would erase a night's takings.
  assert.equal(amountDueOn(orders, [{ order_id: 'o1', amount: 10_000 }]), 0);
});

test('another bill\'s payments do not settle this one', () => {
  assert.equal(
    amountDueOn([{ $id: 'o1', total: 10_000 }], [{ order_id: 'o-other', amount: 10_000 }]),
    10_000,
  );
});

test('an overpaid bill owes nothing rather than owing backwards', () => {
  // A negative amount due would be filled into the "how much" box and taken as
  // a payment of minus something, which no drawer can hold.
  assert.equal(amountDueOn([{ $id: 'o1', total: 2_000 }], [{ order_id: 'o1', amount: 3_000 }]), 0);
});

test('the counter says what to do, not merely that it will not', () => {
  /**
   * The cashier has a customer in front of them and the thing to do is one tap
   * away. A refusal that does not say which tap is a refusal people work
   * around.
   */
  assert.equal(unrungProblem(0, 0, money), null);

  const one = unrungProblem(1, 1_000, money) ?? '';
  assert.match(one, /1 item on the counter has not been rung up/);
  assert.match(one, /GHS 10\.00/);
  assert.match(one, /Charge it first/);
  // And why it matters, because "the total will be wrong" is not the reason
  // that would make somebody stop and do it.
  assert.match(one, /never leaves the shelf/);

  const many = unrungProblem(3, 4_500, money) ?? '';
  assert.match(many, /3 items on the counter have not been rung up/);
  assert.match(many, /Charge them first/);
  assert.match(many, /never leave the shelf/);
});

test('paying more than a bill owes is measured, not waved through', () => {
  /**
   * The last line of defence, and it has to measure against the BILL. The
   * screen that produced the overpayment was capping the figure too — against
   * a number with the un-rung cart folded into it, so the cap agreed with the
   * mistake and let it through.
   */
  assert.equal(overpaying(2_000, 2_000), 0);
  assert.equal(overpaying(2_000, 1_500), 0, 'a part payment is not an overpayment');
  assert.equal(overpaying(2_000, 3_000), 1_000);
  // Nothing left to pay, so anything at all is too much.
  assert.equal(overpaying(0, 100), 100);
});
