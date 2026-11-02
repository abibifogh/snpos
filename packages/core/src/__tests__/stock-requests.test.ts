import test from 'node:test';
import assert from 'node:assert/strict';
import {
  askList, heldItems, readAskLines, draftPlans, requestWords, requestStage, askProblem, buyWord, qtyWords, leftWords,
  askedByWords,
} from '../stock-requests.ts';
import { isRunningLow, suggestLine } from '../purchase-orders.ts';
import type { OrderableItem, PoLine } from '../purchase-orders.ts';
import { canOrderStock } from '../access.ts';
import { mayOrder, askRecipients, askToTell, askSubject, askBody } from '../../../../functions/notify/src/stock-ask.js';

const item = (o: Partial<OrderableItem> & { $id: string; name: string }): OrderableItem => ({
  unit: 'kg', current_qty: 0, par_level: 10, module: 'kitchen', active: true, ...o,
});

const ITEMS: OrderableItem[] = [
  item({ $id: 'rice', name: 'Jasmine rice', current_qty: 6, par_level: 75, pack_size: 25, pack_name: 'sack', supplier_id: 'mak', last_unit_cost: 1920 }),
  item({ $id: 'oil', name: 'Vegetable oil', unit: 'L', current_qty: 4, par_level: 50, pack_size: 25, pack_name: 'jerrycan', supplier_id: 'mak', last_unit_cost: 2880 }),
  item({ $id: 'tom', name: 'Tomatoes', current_qty: 0, par_level: 40, pack_size: 20, pack_name: 'crate', supplier_id: 'kan', last_unit_cost: 1900 }),
  item({ $id: 'onion', name: 'Onions', current_qty: 5, par_level: 30, pack_size: 10, pack_name: 'bag', supplier_id: 'kan' }),
  item({ $id: 'gari', name: 'Gari', current_qty: 18, par_level: 20 }),
  item({ $id: 'foil', name: 'Foil', unit: 'roll', current_qty: 0, par_level: 6 }),
  item({ $id: 'gin', name: 'Gin', unit: 'bottle', current_qty: 1, par_level: 12, module: 'bar' }),
];
const SUPPLIERS = [{ $id: 'mak', name: 'Makola Wholesale' }, { $id: 'kan', name: 'Kaneshie Market' }];
const low = (i: OrderableItem) => isRunningLow(i, 3000);

test('the sheet opens on what is low, filled in to bring it back to full, and only this side', () => {
  const list = askList(ITEMS, 'kitchen', new Map(), low, suggestLine);
  // Run out first, then by name.
  assert.deepEqual(list.low.map((l) => l.ingredient_id), ['foil', 'tom', 'rice', 'onion', 'oil']);
  const rice = list.low.find((l) => l.ingredient_id === 'rice')!;
  assert.deepEqual([rice.qty, rice.buy_label, rice.left, rice.full], [3, 'sacks', 6, 75], '69 kg short is three sacks');
  assert.deepEqual(list.others.map((l) => l.ingredient_id), ['gari']);
  assert.ok(![...list.low, ...list.others].some((l) => l.ingredient_id === 'gin'), 'the bar is not the kitchen');
  assert.deepEqual(askList(ITEMS, 'bar', new Map(), low, suggestLine).low.map((l) => l.ingredient_id), ['gin']);
});

test('what is already ordered or asked for is shown, not offered twice', () => {
  const order = (status: string, lines: Partial<PoLine>[], expected_on = '') => ({
    status, expected_on, lines: lines.map((l) => ({ ...suggestLine(ITEMS[0]), received_qty: 0, ...l }) as PoLine),
  });
  const held = heldItems(
    [
      order('sent', [{ ingredient_id: 'onion', qty: 2 }], '2026-11-03'),
      order('received', [{ ingredient_id: 'rice', qty: 3 }]),
      order('part', [{ ingredient_id: 'oil', qty: 2, received_qty: 2 }]),
    ],
    [{ status: 'asked', by_name: 'Abena', lines: readAskLines(JSON.stringify([{ ingredient_id: 'tom', name: 'Tomatoes', qty: 2 }])) }],
    (d) => (d ? `due ${d}` : ''),
  );
  assert.equal(held.get('onion')?.why, 'On order, due 2026-11-03');
  assert.equal(held.get('tom')?.why, 'Asked for by Abena');
  assert.ok(!held.has('rice'), 'arrived');
  assert.ok(!held.has('oil'), 'everything on that line has come');
  const list = askList(ITEMS, 'kitchen', held, low, suggestLine);
  assert.deepEqual(list.held.map((h) => h.ingredient_id), ['onion', 'tom']);
  assert.ok(!list.low.some((l) => l.ingredient_id === 'onion' || l.ingredient_id === 'tom'));
});

test('a request becomes one draft per supplier, priced at what was last paid', () => {
  const lines = askList(ITEMS, 'kitchen', new Map(), low, suggestLine).low;
  const plans = draftPlans(lines, ITEMS, SUPPLIERS, suggestLine);
  assert.deepEqual(plans.map((p) => p.supplier?.name ?? 'none'), ['Makola Wholesale', 'Kaneshie Market', 'none']);
  const mak = plans[0];
  assert.deepEqual(mak.lines.map((l) => [l.name, l.qty, l.unit_cost]), [['Jasmine rice', 3, 48000], ['Vegetable oil', 2, 72000]]);
  assert.equal(mak.total, 2 * 72000 + 3 * 48000);
  // The manager's amounts win, and a nought leaves the line off.
  const changed = draftPlans(lines.map((l) => (l.ingredient_id === 'oil' ? { ...l, qty: 0 } : l)), ITEMS, SUPPLIERS, suggestLine);
  assert.deepEqual(changed[0].lines.map((l) => l.name), ['Jasmine rice']);
  // A stock item deleted since keeps its words, with no price.
  const gone = draftPlans([{ ...lines[0], ingredient_id: 'nope' }], ITEMS, SUPPLIERS, suggestLine);
  assert.deepEqual([gone[0].supplier, gone[0].lines[0].unit_cost], [null, 0]);
});

test('the words: Approvals, the pass, and where a request has got to', () => {
  const lines = askList(ITEMS, 'kitchen', new Map(), low, suggestLine).low;
  const w = requestWords({ side: 'kitchen', lines, note: 'Pepper sauce too' });
  assert.equal(w.title, 'The kitchen needs 5 items');
  assert.match(w.detail, /^Foil, 6 rolls; Tomatoes, 2 crates; Jasmine rice, 3 sacks, and 2 more\. Note: “Pepper sauce too”$/);
  assert.equal(requestWords({ side: 'bar', lines: [], note: 'Limes' }).title, 'A note from the bar');
  assert.equal(buyWord({ buy_label: 'boxes' }, 1), 'box');
  assert.equal(suggestLine({ $id: 'c', name: 'Chicken', unit: 'kg', current_qty: 3, par_level: 30, pack_size: 10, pack_name: 'box' }).buy_label, 'boxes');
  assert.equal(qtyWords({ qty: 1, buy_label: 'sacks' }), '1 sack');
  assert.equal(leftWords({ left: 6, full: 75, unit: 'kg' }), '6 kg left of 75');
  assert.equal(leftWords({ left: 18, full: 150, unit: 'egg' }), '18 eggs left of 150');
  assert.equal(leftWords({ left: 0, full: 40, unit: 'kg' }), 'Run out');
  assert.equal(askProblem([], ''), 'Tick something to ask for, or write what is needed in the note.');
  assert.equal(askProblem([], 'Limes'), null);
  assert.equal(askedByWords('kitchen', 'Kofi'), 'Asked by the kitchen · Kofi');

  const orders = [{ $id: 'a', status: 'received' }, { $id: 'b', status: 'sent' }, { $id: 'c', status: 'cancelled' }];
  assert.equal(requestStage({ status: 'asked' }, orders), 'asked');
  assert.equal(requestStage({ status: 'declined' }, orders), 'declined');
  assert.equal(requestStage({ status: 'ordered', order_ids: 'a,b' }, orders), 'ordered');
  assert.equal(requestStage({ status: 'ordered', order_ids: 'a,c' }, orders), 'arrived', 'a cancelled order is not waited for');
  assert.deepEqual(readAskLines('not json'), []);
  assert.deepEqual(readAskLines('[{"name":"Rice","qty":0},{"nope":1}]'), []);
});

test('the server emails exactly whoever the app lets order', () => {
  const roleSets = [undefined, '["manager"]', '["cook","cashier"]', '[]', 'junk'];
  const people = (['admin', 'manager', 'cashier', 'waiter', 'cook'] as const).flatMap((role) =>
    [undefined, 'yes', 'no', 'group'].flatMap((order_stock) =>
      [undefined, true, false].map((can_order_stock) => ({ role, order_stock, can_order_stock }))));
  for (const po_order_roles of roleSets) {
    for (const p of people) {
      assert.equal(mayOrder(p, { po_order_roles }), canOrderStock(p as never, { po_order_roles }), JSON.stringify({ p, po_order_roles }));
    }
  }
  const profiles = [
    { $id: 'a', role: 'admin', email: 'owner@x.gh' },
    { $id: 'm', user_id: 'mu', role: 'manager', email: 'ama@x.gh' },
    { $id: 'c', role: 'cook', email: 'kofi@x.gh' },
    { $id: 'off', role: 'manager', email: 'gone@x.gh', active: false },
  ];
  assert.deepEqual(askRecipients(profiles, {}, 'mu'), ['owner@x.gh'], 'not whoever asked');
  assert.deepEqual(askRecipients(profiles, { po_order_roles: '["manager","cook"]' }, 'c'), ['owner@x.gh', 'ama@x.gh']);
  assert.equal(askToTell({ status: 'asked' }), true);
  assert.equal(askToTell({ status: 'asked', told_at: '2026-11-02T08:00:00Z' }), false);
  assert.equal(askToTell({ status: 'ordered' }), false);
  const doc = { side: 'kitchen', by_name: 'Kofi', note: 'Sauce <bottles>', lines: JSON.stringify([{ name: 'Rice', qty: 1, buy_label: 'sacks', unit: 'kg', left: 6 }]) };
  assert.equal(askSubject(doc), 'The kitchen needs 1 item · Kofi');
  const esc = (s: unknown) => String(s ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  assert.match(askBody(doc, esc), /<strong>Rice<\/strong>: 1 sack/);
  assert.match(askBody(doc, esc), /Sauce &lt;bottles&gt;/);
});
