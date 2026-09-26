import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chargeLeft, chargeAmount, sellingPricePerUnit, chargeProblem, chargeWords, settleProblem, foundAmount, afterSettle,
  owingByPerson, owingTotals, owedWords, repaidByMethod,
  type StaffCharge,
} from '../staff-charges.ts';
import { staffChargeLines, staffSettleLines, BOOK_KEYS } from '../books.ts';
import * as server from '../../../../functions/notify/src/books.js';

const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;
const charge = (over: Partial<StaffCharge> = {}): StaffCharge => ({
  $id: 'c1', person_id: 'regina', person_user_id: 'u-regina', person_name: 'Regina',
  item_name: 'Club · Large', qty: 6, unit_price: 3_000, amount: 18_000,
  charged_at: '2026-09-26T16:40:00.000Z', settled_total: 0, status: 'open', ...over,
});

test('a Club · Large bottle sells for what the Large Club sells for', () => {
  const recipes = [
    { menu_item_id: 'club', variant_id: 'large', ingredient_id: 'club-l', qty_per_unit: 1 },
    // An add-on that uses it is not a sale of it.
    { menu_item_id: 'club', addon_option_id: 'x', ingredient_id: 'club-l', qty_per_unit: 1 },
  ];
  const items = [{ $id: 'club', name: 'Club', price: 2_500 }];
  const sizes = [{ $id: 'large', label: 'Large', price: 3_000 }];
  assert.deepEqual(sellingPricePerUnit('club-l', recipes, items, sizes), { price: 3_000, from: 'Club · Large' });
});

test('a bottle poured by measure is priced per bottle, from the drink closest to one', () => {
  // Gin by the shot: 1/15 of a bottle a shot at GH₵20 is GH₵300 a bottle.
  const recipes = [
    { menu_item_id: 'shot', ingredient_id: 'gin', qty_per_unit: 1 / 15 },
    { menu_item_id: 'bottle', ingredient_id: 'gin', qty_per_unit: 1 },
  ];
  const items = [{ $id: 'shot', name: 'Gin shot', price: 2_000 }, { $id: 'bottle', name: 'Gin bottle', price: 28_000 }];
  assert.deepEqual(sellingPricePerUnit('gin', recipes, items, []), { price: 28_000, from: 'Gin bottle' });
  assert.deepEqual(sellingPricePerUnit('gin', [recipes[0]!], items, []), { price: 30_000, from: 'Gin shot' });
  // Nothing sells it: no selling price, and the form offers cost.
  assert.equal(sellingPricePerUnit('sugar', recipes, items, []), null);
});

test('only what came up short can be charged, to somebody, at a price', () => {
  const ok = { personId: 'regina', qty: 6, short: 6, unitPrice: 3_000 };
  assert.equal(chargeProblem(ok), null);
  assert.match(chargeProblem({ ...ok, personId: '' }) ?? '', /Choose who/);
  assert.match(chargeProblem({ ...ok, qty: 7 }) ?? '', /Only 6 came up short/);
  assert.match(chargeProblem({ ...ok, qty: 0 }) ?? '', /how many/);
  assert.match(chargeProblem({ ...ok, short: 0 }) ?? '', /came up short/);
  assert.match(chargeProblem({ ...ok, unitPrice: 0 }) ?? '', /price/);
  assert.equal(chargeAmount(6, 3_000), 18_000);
});

test('before charging, it says what happens to the shelf and to them', () => {
  const words = chargeWords({ name: 'Club · Large', person: 'Regina', qty: 4, short: 6, expected: 70, counted: 64, unitPrice: 3_000, money });
  assert.equal(words[0], 'The shelf moves from 70 to 64 now, so the next count expects 64.');
  assert.match(words[1] ?? '', /Regina owes GH₵120\.00 \(4 × GH₵30\.00\)/);
  assert.match(words[2] ?? '', /other 2 short are applied as an ordinary loss/);
});

test('putting it right: part payments, found pieces, and write-offs by an admin with a reason', () => {
  const base = { kind: 'cash' as const, amount: 10_000, left: 18_000, isAdmin: false, note: '' };
  assert.equal(settleProblem(base), null);
  assert.match(settleProblem({ ...base, amount: 20_000 }) ?? '', /more than is still owed/);
  assert.match(settleProblem({ ...base, left: 0 }) ?? '', /Nothing is owed/);
  assert.match(settleProblem({ ...base, kind: 'written_off' }) ?? '', /Only an admin/);
  assert.match(settleProblem({ ...base, kind: 'written_off', isAdmin: true }) ?? '', /Say why/);
  assert.equal(settleProblem({ ...base, kind: 'written_off', isAdmin: true, note: 'breakage, not theft' }), null);
  assert.match(settleProblem({ ...base, kind: 'found', qtyFound: 0 }) ?? '', /how many/);
  assert.match(settleProblem({ ...base, kind: 'found', qtyFound: 7, charged: 6 }) ?? '', /Only 6/);
  // Two found at GH₵30 takes GH₵60 off, never more than is left.
  assert.equal(foundAmount(2, 3_000, 18_000), 6_000);
  assert.equal(foundAmount(6, 3_000, 4_000), 4_000);
  assert.deepEqual(afterSettle(charge(), 10_000), { settled_total: 10_000, status: 'open' });
  assert.deepEqual(afterSettle(charge({ settled_total: 10_000 }), 9_000), { settled_total: 18_000, status: 'settled' });
  assert.equal(chargeLeft(charge({ settled_total: 10_000 })), 8_000);
});

test('the page reads by person, most owed first, and the totals add up', () => {
  const rows = [
    charge(),
    charge({ $id: 'c2', item_name: 'Castle Bridge Gin', qty: 2, unit_price: 500, amount: 1_000, settled_total: 1_000, status: 'settled' }),
    charge({ $id: 'c3', person_id: 'chichi', person_name: 'Chichi', amount: 15_318, charged_at: '2026-09-23T23:43:00.000Z' }),
  ];
  const people = owingByPerson(rows);
  assert.deepEqual(people.map((p) => [p.name, p.left, p.open, p.settledCount]), [['Regina', 18_000, 1, 1], ['Chichi', 15_318, 1, 0]]);
  const totals = owingTotals(rows, [{ $id: 's1', charge_id: 'c2', kind: 'cash', amount: 1_000, recorded_at: '2026-09-26T17:00:00.000Z' }], '2026-09-01T00:00:00.000Z');
  assert.deepEqual(totals, { owed: 33_318, people: 2, putRightThisMonth: 1_000 });
});

test('the till tells the person what they owe, and says nothing when they owe nothing', () => {
  assert.equal(owedWords([charge()], money), 'You owe GH₵180.00 from a count (6 Club · Large short). Speak to a manager to put it right.');
  assert.match(owedWords([charge(), charge({ $id: 'c2' })], money) ?? '', /GH₵360\.00 from counts \(2 count differences\)/);
  assert.equal(owedWords([charge({ settled_total: 18_000 })], money), null);
  assert.equal(owedWords([], money), null);
});

test('cash paid back into a drawer is what that drawer expects on top', () => {
  assert.deepEqual(repaidByMethod([
    { kind: 'cash', amount: 10_000, method_id: 'cash' },
    { kind: 'cash', amount: 500, method_id: 'cash' },
    { kind: 'pay', amount: 8_000, method_id: '' },
    { kind: 'found', amount: 6_000 },
  ]), { cash: 10_500 });
});

test('on the books: owed by staff, and each way of settling it', () => {
  assert.deepEqual(staffChargeLines(18_000).map((l) => [l.account_code, l.debit, l.credit]), [['1300', 18_000, 0], ['4910', 0, 18_000]]);
  assert.deepEqual(staffSettleLines('cash', 10_000).map((l) => [l.account_code, l.debit, l.credit]), [['1000', 10_000, 0], ['1300', 0, 10_000]]);
  assert.deepEqual(staffSettleLines('pay', 8_000).map((l) => [l.account_code, l.debit, l.credit]), [['6100', 8_000, 0], ['1300', 0, 8_000]]);
  for (const k of ['found', 'written_off']) {
    assert.deepEqual(staffSettleLines(k, 6_000).map((l) => [l.account_code, l.debit, l.credit]), [['4910', 6_000, 0], ['1300', 0, 6_000]]);
  }
  assert.deepEqual(staffChargeLines(0), []);
  assert.equal(BOOK_KEYS.staffCharge('c1'), 'staffcharge:c1');
  // The server posts exactly the same lines.
  for (const a of [0, 1, 18_000]) assert.deepEqual(server.staffChargeLines(a), staffChargeLines(a));
  for (const k of ['cash', 'pay', 'found', 'written_off']) {
    assert.deepEqual(server.staffSettleLines(k, 4_200), staffSettleLines(k, 4_200));
  }
});
