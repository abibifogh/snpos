import test from 'node:test';
import assert from 'node:assert/strict';
// Plain JavaScript, importing nothing at runtime.
import { leftoversToRelax, relaxCall } from '../../../../scripts/leftover-columns.mjs';

/*
  An older purchase_orders design had a required po_number. The current one
  numbers orders in po_no, so every new order was refused with "Missing
  required attribute po_number" until the old column stopped being required.
*/
const schema = [
  ['venue_id', 's', 64, true],
  ['po_no', 's', 24, true],
  ['supplier_id', 's', 64, false],
];

test('a required column the schema no longer has is found; known and optional ones are not', () => {
  const live = [
    { key: 'venue_id', type: 'string', required: true, size: 64 },
    { key: 'po_no', type: 'string', required: true, size: 24 },
    { key: 'supplier_id', type: 'string', required: true, size: 64 }, // in the schema: relaxIfNowOptional's job
    { key: 'po_number', type: 'string', required: true, size: 40 },
    { key: 'ordered_by', type: 'string', required: true, size: 64 },
    { key: 'subtotal', type: 'integer', required: true },
    { key: 'note', type: 'string', required: false, size: 1000 }, // left over but already optional
  ];
  assert.deepEqual(leftoversToRelax(schema, live).map((a: { key: string }) => a.key), ['po_number', 'ordered_by', 'subtotal']);
});

test('each kind of column is made optional with its own call, keeping what it already allows', () => {
  assert.deepEqual(relaxCall({ key: 'po_number', type: 'string', size: 40 }), ['updateStringAttribute', [false, null, 40]]);
  assert.deepEqual(
    relaxCall({ key: 'status', type: 'string', format: 'enum', elements: ['draft', 'sent'] }),
    ['updateEnumAttribute', [['draft', 'sent'], false, null]],
  );
  assert.deepEqual(relaxCall({ key: 'mail', type: 'string', format: 'email' }), ['updateEmailAttribute', [false, null]]);
  assert.deepEqual(relaxCall({ key: 'flag', type: 'boolean' }), ['updateBooleanAttribute', [false, null]]);
  assert.deepEqual(relaxCall({ key: 'at', type: 'datetime' }), ['updateDatetimeAttribute', [false, null]]);
  assert.deepEqual(relaxCall({ key: 'n', type: 'integer', min: 0, max: 100 }), ['updateIntegerAttribute', [false, 0, 100, null]]);
  assert.deepEqual(relaxCall({ key: 'f', type: 'double', min: 0, max: 1 }), ['updateFloatAttribute', [false, 0, 1, null]]);
});

test('an unbounded integer is sent back unbounded, not a shade outside the 64-bit range', () => {
  const huge = { key: 'subtotal', type: 'integer', min: -9223372036854775808, max: 9223372036854775807 };
  assert.deepEqual(relaxCall(huge), ['updateIntegerAttribute', [false, null, null, null]]);
});

test('an array or a relationship is left alone rather than guessed at', () => {
  assert.equal(relaxCall({ key: 'tags', type: 'string', array: true, size: 40 }), null);
  assert.equal(relaxCall({ key: 'rel', type: 'relationship' }), null);
});
