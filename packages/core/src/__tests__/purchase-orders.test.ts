import test from 'node:test';
import assert from 'node:assert/strict';
import { orderRoles, orderRolesValue, orderChoice, canOrderStock } from '../access.ts';
import {
  isRunningLow, suggestLine, suggestions, orderTotal, orderNeedsApproval, orderProblem, nextPoNo, orderMessage,
  receiveInto, stillToCome, submittedStatus, readLines, canApproveOrders, isOpenOrder, isEditableOrder,
  PO_STATUS_WORDS, type OrderableItem,
  itemsFor, newSupplierProblem,
} from '../purchase-orders.ts';
import { waitingList, waitingCounts } from '../waiting.ts';
import { purchaseOrderPdf, quantityWords } from '../../../../functions/notify/src/po-pdf.js';

const club = (over: Partial<OrderableItem> = {}): OrderableItem => ({
  $id: 'club', name: 'Club Large', unit: 'bottle', current_qty: 4, par_level: 36, low_threshold: 12,
  supplier_id: 'gbl', pack_size: 12, pack_name: 'crate', base_unit_cost: 1_800, last_unit_cost: 1_900, ...over,
});

test('running low is out, or at or below the item’s own low line', () => {
  assert.equal(isRunningLow(club()), true);
  assert.equal(isRunningLow(club({ current_qty: 12 })), true);
  assert.equal(isRunningLow(club({ current_qty: 13 })), false);
  assert.equal(isRunningLow(club({ current_qty: 0, low_threshold: 0 })), true, 'out is always low');
  // No low line of its own: a share of the full level, as levelOf works it out.
  assert.equal(isRunningLow(club({ low_threshold: null, current_qty: 10 }), 3000), true);
  assert.equal(isRunningLow(club({ low_threshold: null, current_qty: 11 }), 3000), false);
  // Overheads nobody counts, and archived items, are never suggested.
  assert.equal(isRunningLow(club({ counted_at_close: false })), false);
  assert.equal(isRunningLow(club({ active: false })), false);
});

test('a suggestion brings it back to full, in whole packs, at what it last cost', () => {
  const l = suggestLine(club());
  // 36 full − 4 left = 32 bottles, which is 3 crates of 12 (2.67 rounded up).
  assert.deepEqual([l.qty, l.buy_key, l.buy_label, l.per, l.unit_cost], [3, 'pack', 'crates', 12, 22_800]);
  assert.equal(orderTotal([l]), 68_400);
  // Not bought in packs: in its own unit.
  const rice = suggestLine({ $id: 'rice', name: 'Rice', unit: 'kg', current_qty: 3, par_level: 25, base_unit_cost: 1_200 });
  assert.deepEqual([rice.qty, rice.buy_key, rice.buy_label, rice.unit_cost], [22, 'unit', 'kg', 1_200]);
  // No full level set: one pack, for somebody to change, rather than nothing.
  assert.equal(suggestLine(club({ par_level: 0 })).qty, 1);
});

test('suggestions are grouped by supplier, with anything unsupplied kept rather than dropped', () => {
  const items = [
    club(),
    club({ $id: 'star', name: 'Star Large', current_qty: 30 }),
    club({ $id: 'malt', name: 'Malt', current_qty: 1, supplier_id: 'gbl' }),
    club({ $id: 'gas', name: 'Gas', supplier_id: '', current_qty: 0, pack_size: 0, unit: 'cylinder', par_level: 2 }),
  ];
  const g = suggestions(items, [{ $id: 'gbl', name: 'Guinness Ghana' }]);
  assert.deepEqual(g.map((x) => [x.supplierName, x.lines.map((l) => l.name)]), [
    ['Guinness Ghana', ['Club Large', 'Malt']],
    ['No supplier set', ['Gas']],
  ]);
});

test('one order per supplier and department: the bar\'s Club and the kitchen\'s oil are two orders', () => {
  const items = [
    club({ supplier_id: 'gbl', module: 'bar' }),
    club({ $id: 'oil', name: 'Oil', supplier_id: 'gbl', module: 'kitchen', current_qty: 0 }),
    club({ $id: 'old', name: 'Salt', supplier_id: 'gbl', current_qty: 0 }),
  ];
  const g = suggestions(items, [{ $id: 'gbl', name: 'Guinness Ghana' }]);
  assert.deepEqual(g.map((x) => [x.module, x.lines.map((l) => l.name)]).sort(), [
    ['bar', ['Club Large']],
    ['kitchen', ['Oil', 'Salt']],
  ]);
});

test('an order offers its own department\'s items, and a new supplier must be new', () => {
  const items = [
    { $id: 'a', module: 'bar' }, { $id: 'b', module: 'kitchen' }, { $id: 'c' }, { $id: 'd', module: 'bar', active: false },
  ];
  assert.deepEqual(itemsFor(items, 'bar').map((i) => i.$id), ['a']);
  assert.deepEqual(itemsFor(items, 'kitchen').map((i) => i.$id), ['b', 'c'], 'no side is the kitchen\'s');
  assert.equal(itemsFor(items, 'craft').length, 0);
  const list = [{ name: 'Kasapreko' }];
  assert.match(newSupplierProblem('  ', list) ?? '', /name/);
  assert.match(newSupplierProblem('kasapreko ', list) ?? '', /already on the list/);
  assert.equal(newSupplierProblem('Accra Wholesale', list), null);
});

test('approval only above the limit, and never for an admin’s own order', () => {
  assert.equal(orderNeedsApproval(150_000, 100_000), true);
  assert.equal(orderNeedsApproval(100_000, 100_000), false);
  assert.equal(orderNeedsApproval(5_000_000, 0), false, 'a limit of nought means none wait');
  assert.equal(submittedStatus(150_000, 100_000, false), 'waiting');
  assert.equal(submittedStatus(150_000, 100_000, true), 'ready');
  assert.equal(submittedStatus(50_000, 100_000, false), 'ready');
});

test('an order needs a supplier and something on it', () => {
  const l = suggestLine(club());
  assert.match(orderProblem({ supplier_name: '', lines: [l] }) ?? '', /Choose who/);
  assert.match(orderProblem({ supplier_name: 'GBL', lines: [{ ...l, qty: 0 }] }) ?? '', /at least one/);
  assert.equal(orderProblem({ supplier_name: 'GBL', lines: [l] }), null);
});

test('orders are numbered on from the highest', () => {
  assert.equal(nextPoNo([]), 'PO-0001');
  assert.equal(nextPoNo(['PO-0003', 'PO-0010', 'PO-0002']), 'PO-0011');
});

test('the message says what is wanted, in packs, and leaves the prices to the PDF', () => {
  const text = orderMessage({
    po_no: 'PO-0007', supplier_name: 'Guinness Ghana', lines: [suggestLine(club()), { ...suggestLine(club({ $id: 'm', name: 'Malt' })), qty: 1 }],
    note: 'Deliver to the back door.', expected_on: '2026-10-20',
  }, 'Abibifo', 'Kofi');
  assert.match(text, /^Hello Guinness Ghana,/);
  assert.match(text, /order PO-0007/);
  assert.match(text, /• Club Large: 3 crates \(12 bottles each\)/);
  assert.match(text, /• Malt: 1 crate \(12 bottles each\)/);
  assert.match(text, /Needed by 20 October 2026\./);
  assert.match(text, /Deliver to the back door\./);
  assert.doesNotMatch(text, /GH|228/);
  assert.match(text, /Kofi$/);
});

test('a spend receives an order in counting units, and the order knows what is still to come', () => {
  const lines = [suggestLine(club()), suggestLine({ $id: 'rice', name: 'Rice', unit: 'kg', current_qty: 0, par_level: 10 })];
  // Two crates of Club arrive (24 bottles); no rice yet.
  const first = receiveInto(lines, [{ ingredient_id: 'club', qty: 24 }, { ingredient_id: 'tonic', qty: 6 }]);
  assert.equal(first.status, 'part');
  assert.deepEqual(first.lines.map((l) => l.received_qty), [2, 0]);
  assert.deepEqual(stillToCome(first.lines).map((l) => l.ingredient_id), ['club', 'rice']);
  // The rest: the third crate, and the rice. More than ordered is capped at what was ordered.
  const second = receiveInto(first.lines, [{ ingredient_id: 'club', qty: 20 }, { ingredient_id: 'rice', qty: 10 }]);
  assert.equal(second.status, 'received');
  assert.deepEqual(second.lines.map((l) => l.received_qty), [3, 10]);
});

test('who may order, approve, and what can still be changed', () => {
  assert.equal(canOrderStock({ role: 'admin' }), true);
  assert.equal(canOrderStock({ role: 'manager' }), true, 'managers by default');
  assert.equal(canOrderStock({ role: 'manager', can_order_stock: false }), false, 'switched off before the role setting');
  assert.equal(canOrderStock({ role: 'cashier' }), false);
  assert.equal(canOrderStock({ role: 'cashier', can_order_stock: true }), true, 'switched on before the role setting');
  assert.equal(canApproveOrders({ role: 'manager' }), true);
  assert.equal(canApproveOrders({ role: 'cashier' }), false);
  assert.deepEqual(['ready', 'sent', 'part', 'draft', 'received'].map(isOpenOrder), [true, true, true, false, false]);
  assert.deepEqual(['draft', 'refused', 'sent', 'received'].map(isEditableOrder), [true, true, false, false]);
  assert.equal(PO_STATUS_WORDS.waiting.label, 'Waiting for approval');
  assert.deepEqual(readLines('not json'), []);
});

test('an order over the limit is on Approvals, counted under its own chip', () => {
  const items = waitingList({
    barCounts: [], shopCounts: [], spends: [], tabShifts: [],
    orders: [{ $id: 'o1', po_no: 'PO-0007', supplier_name: 'Guinness Ghana', total: 150_000, lines: JSON.stringify([suggestLine(club())]), $createdAt: '2026-10-17T09:00:00Z' }],
    money: (n) => `GH₵${(n / 100).toFixed(2)}`,
  });
  assert.equal(items[0]!.title, 'PO-0007 to Guinness Ghana, GH₵1500.00');
  assert.match(items[0]!.detail, /1 item, over the amount that needs approval/);
  assert.deepEqual(items[0]!.ref, { kind: 'order', orderId: 'o1' });
  assert.equal(waitingCounts(items).order, 1);
});

test('the PDF names the supplier, the number, each item in packs, and the total', () => {
  const pdf = Array.from(purchaseOrderPdf({
    order: { po_no: 'PO-0007', supplier_name: 'Guinness Ghana', lines: JSON.stringify([suggestLine(club())]), total: 68_400, note: 'Back door', expected_on: '2026-10-20', created_by_name: 'Kofi' },
    settings: { restaurant_name: 'Abibifo', currency_code: 'GHS', currency_decimals: 2 },
  }) as Uint8Array, (b) => String.fromCharCode(b)).join('');
  for (const w of ['Purchase order PO-0007', 'Guinness Ghana', 'Club Large', 'GHS 684.00', 'Back door', 'Needed by']) {
    assert.ok(pdf.includes(w), `the PDF says "${w}"`);
  }
  // Brackets are escaped inside a PDF string.
  assert.match(pdf, /3 crates \\\(12 bottles each\\\)/);
  assert.equal(quantityWords({ qty: 1, buy_key: 'pack', buy_label: 'crates', per: 12, unit: 'bottle' }), '1 crate (12 bottles each)');
  assert.equal(quantityWords({ qty: 5, buy_key: 'unit', unit: 'kg' }), '5 kg');
});

test('an admin picks the roles that order; a person can be an exception either way', () => {
  const cashiers = { po_order_roles: orderRolesValue(['cashier', 'manager']) };
  assert.deepEqual(orderRoles(null), ['manager'], 'nothing set is managers, as before');
  assert.deepEqual(orderRoles({ po_order_roles: '[]' }), [], 'none ticked is admins only');
  assert.deepEqual(orderRoles({ po_order_roles: 'not json' }), ['manager']);
  assert.deepEqual(orderRoles(cashiers), ['manager', 'cashier']);
  assert.equal(canOrderStock({ role: 'cashier' }, cashiers), true);
  assert.equal(canOrderStock({ role: 'cook' }, cashiers), false);
  assert.equal(canOrderStock({ role: 'manager' }, { po_order_roles: '[]' }), false);
  assert.equal(canOrderStock({ role: 'admin' }, { po_order_roles: '[]' }), true, 'an admin always');
  // The person's own answer beats the role, both ways.
  assert.equal(canOrderStock({ role: 'cook', order_stock: 'yes' }, cashiers), true);
  assert.equal(canOrderStock({ role: 'cashier', order_stock: 'no' }, cashiers), false);
  assert.equal(canOrderStock({ role: 'cashier', order_stock: 'group' }, cashiers), true);
  // The old switch was stamped with the role's default on every save, so a
  // stamped value is "as their role", not a decision.
  assert.equal(orderChoice({ role: 'manager', can_order_stock: true }), 'group');
  assert.equal(orderChoice({ role: 'cashier', can_order_stock: false }), 'group');
  assert.equal(canOrderStock({ role: 'cashier', can_order_stock: false }, cashiers), true);
});

test('a unit price can be finer than a pesewa, and a quantity can have decimals', async () => {
  const { parseUnitPrice, unitPriceInput, parseQty, poLineTotal: lineTotal, orderTotal: total } = await import('../purchase-orders.ts');
  assert.equal(parseUnitPrice('7.50'), 750);
  assert.equal(parseUnitPrice('0.355'), 35.5);
  assert.equal(parseUnitPrice('0,3555'), 35.55, 'a comma for the point, four places kept');
  assert.equal(parseUnitPrice('0.35559'), 35.56, 'and no more than four');
  assert.equal(parseUnitPrice('GH₵ 12'), 1200);
  assert.equal(parseUnitPrice(''), null);
  assert.equal(parseUnitPrice('.'), null);
  assert.equal(parseUnitPrice('-2'), null);
  assert.equal(unitPriceInput(750), '7.50');
  assert.equal(unitPriceInput(35.5), '0.355');
  assert.equal(unitPriceInput(35.55), '0.3555');
  assert.equal(parseQty('1.5'), 1.5);
  assert.equal(parseQty('2,25'), 2.25);
  assert.equal(parseQty('1.'), 1, 'half typed still reads');
  assert.equal(parseQty('abc'), null);
  // The line and the order still come to whole pesewas.
  const lines = [{ qty: 1000, unit_cost: 35.5 }, { qty: 1.5, unit_cost: 2099 }];
  assert.equal(lineTotal(lines[0]), 35500);
  assert.equal(lineTotal(lines[1]), 3149);
  assert.equal(total(lines), 38649);
});

test('the PDF prints a finer unit price as it was entered', () => {
  const bytes = purchaseOrderPdf({
    order: { po_no: 'PO-0009', supplier_name: 'Example Wholesale', lines: JSON.stringify([{ name: 'Sachet', unit: 'sachet', buy_key: 'unit', buy_label: 'sachets', per: 1, qty: 1000, unit_cost: 35.5 }]), total: 35500 },
    settings: { restaurant_name: 'Example', currency_code: 'GHS', currency_decimals: 2 },
  } as never);
  const text = new TextDecoder('latin1').decode(bytes);
  assert.match(text, /GHS 0\.355 each/);
});
