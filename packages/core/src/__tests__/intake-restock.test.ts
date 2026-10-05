import test from 'node:test';
import assert from 'node:assert/strict';
import { restockChoices, restockedBy } from '../intake-restock.ts';

const items = [
  { $id: 'soap', name: 'Moringa Soap', price: 7_500, on_hand: 4, module: 'craft', consignor_id: 'abi', active: true },
  { $id: 'oil', name: 'Castor oil', price: 10_000, on_hand: 0, module: 'craft', consignor_id: 'abi', active: true },
  { $id: 'basket', name: 'Woven basket', price: 20_000, module: 'craft', consignor_id: 'ama', active: true },
  { $id: 'old', name: 'Retired soap', price: 5_000, module: 'craft', consignor_id: 'abi', active: false },
  { $id: 'jollof', name: 'Jollof', price: 9_000, module: 'kitchen', active: true },
];
const sizes = [
  { $id: 'oil-s', menu_item_id: 'oil', label: 'Small', price: 6_000, on_hand: 2, active: true, sort: 1 },
  { $id: 'oil-l', menu_item_id: 'oil', label: 'Large', price: 10_000, on_hand: 1, active: true, sort: 2 },
  { $id: 'oil-x', menu_item_id: 'oil', label: 'Gone', price: 1, active: false, sort: 3 },
];

test('a delivery offers only this maker\'s own products, each size on its own', () => {
  const choices = restockChoices(items, sizes, 'abi');
  assert.deepEqual(choices.map((c) => [c.key, c.label, c.price, c.onHand]), [
    ['oil|oil-l', 'Castor oil · Large', 10_000, 1],
    ['oil|oil-s', 'Castor oil · Small', 6_000, 2],
    ['soap', 'Moringa Soap', 7_500, 4],
  ]);
  // Somebody else's basket is not this maker's to restock, nor a retired one, nor a dish.
  assert.deepEqual(restockChoices(items, sizes, 'ama').map((c) => c.key), ['basket']);
  assert.deepEqual(restockChoices(items, sizes, ''), []);
});

test('what a delivery restocked is read from its own movements, apart from what it created', () => {
  const moves = [
    { menu_item_id: 'new-piece', type: 'intake', qty_delta: 3 },
    { menu_item_id: 'soap', type: 'intake', qty_delta: 10 },
    { menu_item_id: 'oil', variant_id: 'oil-l', type: 'intake', qty_delta: 5 },
    { menu_item_id: 'oil', variant_id: 'oil-l', type: 'adjustment', qty_delta: -1 },
    // A sale is not part of the delivery.
    { menu_item_id: 'soap', type: 'sale', qty_delta: -1 },
  ];
  assert.deepEqual(restockedBy(moves, new Set(['new-piece'])), [
    { menuItemId: 'soap', variantId: undefined, qty: 10 },
    { menuItemId: 'oil', variantId: 'oil-l', qty: 4 },
  ]);
  // Undone: added and taken back, nothing left to show.
  assert.deepEqual(restockedBy([
    { menu_item_id: 'soap', type: 'intake', qty_delta: 10 },
    { menu_item_id: 'soap', type: 'adjustment', qty_delta: -10 },
  ], new Set()), []);
});
