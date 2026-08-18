import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffFields, describeChanges, fitForLog, PRODUCT_WATCH } from '../changes.ts';

const money = (v: number) => `GHS ${(v / 100).toFixed(2)}`;

test('only what moved is recorded', () => {
  const before = { name: 'Mojito', price: 4000, active: true, description: 'Rum, mint' };
  const after = { name: 'Mojito', price: 4500, active: true, description: 'Rum, mint' };
  const changes = diffFields(before, after, PRODUCT_WATCH);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], { field: 'price', label: 'Price', from: 4000, to: 4500 });
});

test('saving without changing anything logs nothing', () => {
  const row = { name: 'Mojito', price: 4000, active: true };
  assert.deepEqual(diffFields(row, { ...row }, PRODUCT_WATCH), []);
});

test('blank, absent and empty are the same absence', () => {
  // Otherwise opening a record and saving it untouched writes
  // "Description: nothing to nothing" every time.
  const before = { description: null, sku: undefined };
  const after = { description: '', sku: '' };
  assert.deepEqual(diffFields(before, after, PRODUCT_WATCH), []);
});

test('a field the save did not mention is not a field set to nothing', () => {
  // A partial update touches a subset on purpose. Treating the missing ones as
  // cleared would log a dozen false changes on every small edit.
  const before = { name: 'Mojito', price: 4000, description: 'Rum, mint' };
  const changes = diffFields(before, { price: 4500 }, PRODUCT_WATCH);
  assert.deepEqual(changes.map((c) => c.field), ['price']);
});

test('a brand new record shows what it was created with', () => {
  const changes = diffFields(null, { name: 'Mojito', price: 4000 }, PRODUCT_WATCH);
  assert.deepEqual(changes.map((c) => c.field), ['name', 'price']);
  assert.equal(changes[0].from, undefined);
});

test('the line reads the way somebody would say it', () => {
  const changes = diffFields({ price: 4000, active: true }, { price: 4500, active: false }, PRODUCT_WATCH);
  assert.equal(
    describeChanges(changes, { money }),
    'Price: GHS 40.00 → GHS 45.00; On the menu: yes → no',
  );
});

test('money is only formatted where it is money', () => {
  const changes = diffFields({ prep_minutes: 2 }, { prep_minutes: 5 }, PRODUCT_WATCH);
  assert.equal(describeChanges(changes, { money }), 'Prep time: 2 → 5', 'not GHS 0.05');
});

test('an id can be shown as the thing it points at', () => {
  const changes = diffFields({ category_id: 'a' }, { category_id: 'b' }, PRODUCT_WATCH);
  const said = describeChanges(changes, {
    nameFor: (f, v) => (f === 'category_id' ? ({ a: 'Beer', b: 'Cocktails' } as Record<string, string>)[String(v)] : undefined),
  });
  assert.equal(said, 'Category: Beer → Cocktails');
});

test('nothing reads as nothing rather than as undefined', () => {
  const changes = diffFields({ description: 'Old' }, { description: '' }, PRODUCT_WATCH);
  assert.equal(describeChanges(changes), 'Description: Old → nothing');
});

test('an oversized change is trimmed rather than losing the whole record', () => {
  // Appwrite refuses the entire document when a string is too long, so a
  // product with a long description could take the audit row down with it —
  // losing the record of the change because the change was big.
  const huge = [{ field: 'description', label: 'Description', from: 'x'.repeat(9000), to: 'y' }];
  const packed = fitForLog(huge, 500);
  assert.ok(packed.length <= 500, `was ${packed.length}`);
  assert.match(packed, /truncated/);
});

test('an ordinary change is stored whole, not mangled', () => {
  const packed = fitForLog([{ field: 'price', label: 'Price', from: 4000, to: 4500 }]);
  assert.deepEqual(JSON.parse(packed), [{ field: 'price', label: 'Price', from: 4000, to: 4500 }]);
});
