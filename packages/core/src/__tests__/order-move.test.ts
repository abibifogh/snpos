import test from 'node:test';
import assert from 'node:assert/strict';
// Plain JavaScript, importing nothing at runtime.
import { movedOrderRow } from '../../../../scripts/order-move.mjs';

const keys = ['org_id', 'venue_id', 'po_no', 'module', 'supplier_name', 'status', 'lines', 'total', 'note'];

test('an order is copied with only the columns the new collection has', () => {
  const old = {
    $id: 'o1', $permissions: ['read("team:staff")'], venue_id: 'main', po_no: 'PO-0003', module: 'bar',
    supplier_name: 'Accra Brewery', status: 'draft', lines: '[]', total: 720000, note: null,
    // The older design's columns, which stock_orders does not have.
    po_number: null, subtotal: 0, ordered_by: '',
  };
  assert.deepEqual(movedOrderRow(old, keys), {
    venue_id: 'main', po_no: 'PO-0003', module: 'bar', supplier_name: 'Accra Brewery',
    status: 'draft', lines: '[]', total: 720000,
  });
});

test('the older design\'s part_received becomes part; anything unknown becomes a draft', () => {
  const base = { venue_id: 'main', po_no: 'PO-0001' };
  assert.equal(movedOrderRow({ ...base, status: 'part_received' }, keys)?.status, 'part');
  assert.equal(movedOrderRow({ ...base, status: 'waiting' }, keys)?.status, 'waiting');
  assert.equal(movedOrderRow({ ...base, status: 'something else' }, keys)?.status, 'draft');
  assert.equal(movedOrderRow({ ...base }, keys)?.status, 'draft');
});

test('a row the older design wrote, with no order number or venue, is left behind', () => {
  assert.equal(movedOrderRow({ venue_id: 'main', po_number: 'X-1', status: 'draft' }, keys), null);
  assert.equal(movedOrderRow({ po_no: 'PO-0001', status: 'draft' }, keys), null);
  assert.equal(movedOrderRow(null, keys), null);
});
