/**
 * An order bought out of a float in Insight: received without any drawer,
 * box or bank here paying for it, and the books owing it to the float.
 * The server's half is tested in functions/notify/insight-floats.test.mjs.
 * Every name is made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spendSource, spendWords, SOURCE_WORDS } from '../spend-kind.ts';
import { spendFrom, outFilters, moneyOutRows, OUT_FROM_WORDS } from '../money-out.ts';
import { spendChanges } from '../spend-history.ts';
import { ACCOUNTS, SYSTEM_ACCOUNT_CODES as CORE_CODES } from '../accounts.ts';
import { ACCOUNTS as SERVER } from '../../../../functions/notify/src/books.js';
import { SYSTEM_ACCOUNT_CODES, SEED_ACCOUNTS, COLLECTIONS } from '../../../../scripts/schema.mjs';
import { paidFromFloat, floatPaidWords, unmatchedLines, floatOrderProblem, lineForItem } from '../purchase-orders.ts';
import type { PoLine } from '../purchase-orders.ts';

const line = (o: Partial<PoLine> = {}): PoLine => ({
  ingredient_id: '', name: 'Tonic water 330ml, crate of 24', unit: '', buy_key: 'unit', buy_label: '', per: 1, qty: 4, unit_cost: 16000, received_qty: 0, ...o,
});

test('a float is a source of its own, in words everywhere a source is said', () => {
  assert.equal(SOURCE_WORDS.float, 'Paid from a float, in Insight');
  assert.deepEqual(spendWords({ source: 'float', from_takings: false }, [{ stocked: true }]), { kind: 'Stock bought', source: 'Paid from a float, in Insight' });
  // Never worked out from the other fields: it is only ever written.
  assert.equal(spendSource({ from_takings: false }), 'own');
  assert.equal(spendFrom({ $id: 'e', $createdAt: '2026-11-01', amount: 100, source: 'float', from_takings: false }), 'float');
  assert.equal(OUT_FROM_WORDS.float, 'From floats, in Insight');
  const rows = moneyOutRows([{ $id: 'e', $createdAt: '2026-11-01', amount: 100, source: 'float', from_takings: false, approval_status: 'approved' }], []);
  assert.deepEqual(outFilters(rows).map((f) => f.value), ['all', 'float']);
  assert.deepEqual(
    spendChanges({ amount: 100, source: 'drawer' }, { amount: 100, source: 'float' }, { money: (n) => String(n) }),
    ['Came out of the drawer → a float, in Insight'],
  );
});

test('a spend paid from a float is in the schema, and comes off no drawer', () => {
  const spends = COLLECTIONS.find((c) => c.id === 'shift_expenses');
  const source = spends?.attributes.find((a) => a[0] === 'source');
  assert.ok((source?.[2] as string[]).includes('float'));
  const orders = COLLECTIONS.find((c) => c.id === 'stock_orders');
  for (const key of ['insight_key', 'insight_ref', 'insight_from', 'receipt_file_id', 'paid_by']) {
    const a = orders?.attributes.find((x) => x[0] === key);
    assert.ok(a, key);
    assert.equal(a?.[3], false, `${key} is optional`);
  }
});

test('2310 Paid from floats is one account on both sides of the books, protected and seeded', () => {
  assert.equal(ACCOUNTS.floatsPayable, '2310');
  assert.equal(SERVER.floatsPayable, '2310');
  assert.ok(CORE_CODES.includes('2310'));
  assert.ok(SYSTEM_ACCOUNT_CODES.includes('2310'));
  assert.deepEqual(SEED_ACCOUNTS.find((a) => a[0] === '2310'), ['2310', 'Paid from floats (Insight)', 'liability']);
});

test('an order from a float says so, and is not received until each line is an item', () => {
  assert.equal(paidFromFloat({ paid_by: 'float' }), true);
  assert.equal(paidFromFloat({ insight_key: 'insight-float:1' }), true);
  assert.equal(paidFromFloat({}), false);
  assert.equal(paidFromFloat(null), false);
  assert.equal(floatPaidWords("Esi Test's float"), "Paid from Esi Test's float, in Insight");
  assert.equal(floatPaidWords(''), 'Paid from a float, in Insight');

  const lines = [line(), line({ ingredient_id: 'i1', name: 'Lime' }), line({ qty: 0 })];
  assert.equal(unmatchedLines(lines).length, 1);
  assert.match(floatOrderProblem(lines) ?? '', /Pick the stock item for the line/);
  assert.equal(floatOrderProblem([line({ ingredient_id: 'i1' })]), null);
  assert.equal(floatOrderProblem([line({ qty: 0 })]), 'Nothing on it to receive.');
});

test('picking the item keeps what was bought and paid, in its pack', () => {
  const picked = lineForItem(line(), { $id: 'i1', name: 'Tonic water 330ml', unit: 'bottle', pack_size: 24, pack_name: 'crate' });
  assert.deepEqual(picked, {
    ingredient_id: 'i1', name: 'Tonic water 330ml', unit: 'bottle', buy_key: 'pack', buy_label: 'crates', per: 24,
    qty: 4, unit_cost: 16000, received_qty: 0, bought_as: 'Tonic water 330ml, crate of 24',
  });
  const loose = lineForItem(line({ bought_as: 'Limes' }), { $id: 'i3', name: 'Lime', unit: 'piece' });
  assert.deepEqual([loose.buy_key, loose.per, loose.buy_label, loose.bought_as], ['unit', 1, 'pieces', 'Limes']);
});
