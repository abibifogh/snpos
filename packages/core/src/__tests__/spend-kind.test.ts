import test from 'node:test';
import assert from 'node:assert/strict';
import { spendKind, spendSource, spendWords } from '../spend-kind.ts';

test('a spend with any line on a shelf is stock; one with none is an overhead', () => {
  assert.equal(spendKind([{ stocked: true }, { stocked: false }]), 'stock');
  assert.equal(spendKind([{ stocked: false }]), 'overhead');
  assert.equal(spendKind([]), 'overhead');
  // Absent means stocked, as it always has on expense lines.
  assert.equal(spendKind([{}]), 'stock');
});

test('where the money came from: the box wins, then the bank, then the drawer question', () => {
  assert.equal(spendSource({ imprest_float_id: 'box1', from_takings: false }), 'box');
  assert.equal(spendSource({ methodKind: 'bank', from_takings: true }), 'bank');
  assert.equal(spendSource({ methodKind: 'mobile_money' }), 'bank');
  assert.equal(spendSource({ methodKind: 'cash', from_takings: true }), 'drawer');
  assert.equal(spendSource({ methodKind: 'cash' }), 'drawer');
  assert.equal(spendSource({ from_takings: false }), 'own');
});

test('a row written before the fields existed still reads', () => {
  const words = spendWords({ from_takings: false, imprest_float_id: '' }, [{ stocked: true }], 'cash');
  assert.deepEqual(words, { kind: 'Stock bought', source: 'Own money, to be paid back' });
  // And a row that carries them is read as written, whatever its lines say.
  assert.deepEqual(spendWords({ kind: 'overhead', source: 'bank' }, [{ stocked: true }]), { kind: 'An overhead', source: 'From the bank' });
});
