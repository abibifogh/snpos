import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ledgerFate, offsetCount, stockToReturn, reversalProblem, describeReversal,
} from '../sale-reversal.ts';

test('a consignment credit is removed, not reversed', () => {
  // "Sale 49" and "Refund -49" for something that never left the shelf is a
  // statement a maker has to read twice and the shop has to explain. The
  // honest record of a sale that did not happen is no line at all.
  const actions = ledgerFate([{ $id: 'a', amount: 4900 }]);
  assert.equal(actions[0].action, 'delete');
});

test('a credit already paid out is offset instead, never deleted', () => {
  // The payout points at it. Delete the line and the payout covers a sale that
  // does not exist: the statement stops adding up and real money that left the
  // shop has nothing to sit against.
  const [action] = ledgerFate([{ $id: 'a', amount: 4900, payout_id: 'p1' }]);
  assert.equal(action.action, 'offset');
  assert.equal(action.action === 'offset' && action.amount, -4900);
  assert.match(action.action === 'offset' ? action.why : '', /already paid out/);
});

test('a blank payout id does not count as paid', () => {
  assert.equal(ledgerFate([{ $id: 'a', amount: 1, payout_id: '   ' }])[0].action, 'delete');
  assert.equal(ledgerFate([{ $id: 'a', amount: 1, payout_id: '' }])[0].action, 'delete');
});

test('a mixed order is handled entry by entry', () => {
  const actions = ledgerFate([
    { $id: 'a', amount: 4900 },
    { $id: 'b', amount: 2500, payout_id: 'p1' },
    { $id: 'c', amount: 1000 },
  ]);
  assert.deepEqual(actions.map((a) => a.action), ['delete', 'offset', 'delete']);
  assert.equal(offsetCount(actions), 1);
});

test('what goes back on the shelf', () => {
  const back = stockToReturn([
    { $id: 'l1', menu_item_id: 'bowl', qty: 2 },
    { $id: 'l2', menu_item_id: 'mug', variant_id: 'v1', qty: 1 },
  ]);
  assert.deepEqual(back, [
    { lineId: 'l1', menuItemId: 'bowl', variantId: undefined, qty: 2 },
    { lineId: 'l2', menuItemId: 'mug', variantId: 'v1', qty: 1 },
  ]);
});

test('a voided line puts nothing back', () => {
  // It took nothing off the shelf, so returning it invents stock: the count
  // reads one high and the next stocktake shows a loss nobody can explain.
  assert.deepEqual(stockToReturn([{ $id: 'l', menu_item_id: 'x', qty: 1, status: 'void' }]), []);
});

test('a zero-quantity line puts nothing back', () => {
  assert.deepEqual(stockToReturn([{ $id: 'l', menu_item_id: 'x', qty: 0 }]), []);
});

test('a missing quantity is one, not nothing', () => {
  assert.equal(stockToReturn([{ $id: 'l', menu_item_id: 'x' }])[0].qty, 1);
});

test('a sale on a closed shift is refused, with the reason', () => {
  // The drawer has been counted against these orders. Removing one leaves the
  // count disagreeing with what is behind it.
  const why = reversalProblem({ $id: 'o' }, { status: 'closed' });
  assert.match(why ?? '', /closed and counted/);
});

test('a sale on an open shift is allowed', () => {
  assert.equal(reversalProblem({ $id: 'o' }, { status: 'open' }), null);
  assert.equal(reversalProblem({ $id: 'o' }, null), null);
});

test('a sale already taken back is not taken back twice', () => {
  assert.match(reversalProblem({ $id: 'o', status: 'void' }, null) ?? '', /already been taken back/);
});

test('a sale that no longer exists says so', () => {
  assert.match(reversalProblem(null, null) ?? '', /no longer exists/);
});

test('the admin is told what is about to happen', () => {
  const said = describeReversal('erase', {
    lines: 1,
    ledger: ledgerFate([{ $id: 'a', amount: 4900 }]),
    paid: 4900,
  });
  assert.match(said, /deleted outright/);
  assert.match(said, /payment record goes with it/);
  assert.match(said, /1 item\(s\) go back on the shelf/);
  assert.match(said, /removed from the maker's statement entirely/);
});

test('a refund keeps the order, an erase does not', () => {
  const parts = { lines: 0, ledger: [], paid: 0 };
  assert.match(describeReversal('refund', parts), /kept, marked void/);
  assert.match(describeReversal('erase', parts), /deleted outright/);
});

test('being unable to remove a paid entry is said, not hidden', () => {
  const said = describeReversal('refund', {
    lines: 1,
    ledger: ledgerFate([{ $id: 'a', amount: 4900, payout_id: 'p1' }]),
    paid: 4900,
  });
  assert.match(said, /already been paid/);
  assert.match(said, /opposite entry/);
});

test('an unpaid sale is not described as refunding a payment', () => {
  const said = describeReversal('refund', { lines: 1, ledger: [], paid: 0 });
  assert.equal(/payment/.test(said), false);
});
