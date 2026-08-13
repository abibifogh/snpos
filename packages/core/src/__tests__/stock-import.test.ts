import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toCsv } from '../csv.ts';
import { readImport, IMPORT_HEADINGS, TEMPLATE_ROWS } from '../stock-import.ts';
import type { ImportContext } from '../stock-import.ts';

/**
 * A bulk upload is only as good as what it refuses. Everything here is about
 * the file being wrong, because the file usually is.
 */

const ctx: ImportContext = {
  categories: [{ $id: 'cat-b', name: 'Baskets' }, { $id: 'cat-j', name: 'Jewellery' }],
  consignors: [{ $id: 'con-a', code: 'AKO', name: 'Ama Kofi' }, { $id: 'con-b', code: 'YAW', name: 'Yaw Mensah' }],
  variantTypes: [{ key: 'size', name: 'Sizes' }, { key: 'colour', name: 'Colours' }],
  decimals: 2,
};

/** Build a file the way a spreadsheet would, then read it back. */
const file = (rows: string[][]) => parseCsv(toCsv(IMPORT_HEADINGS, rows));

/** One row, with only the columns a test cares about filled in. */
function row(over: Record<string, string> = {}): string[] {
  const base: Record<string, string> = {
    name: 'Woven basket', category: 'Baskets', price: '120.00', quantity: '3',
    consignor_code: 'AKO',
  };
  const all = { ...base, ...over };
  return IMPORT_HEADINGS.map((h) => all[h] ?? '');
}

test('the shipped template is a file this can actually read', () => {
  // If the example rows do not survive their own validator, the first thing
  // anybody does with this feature fails.
  const result = readImport(file(TEMPLATE_ROWS), ctx);
  assert.deepEqual(result.problems, []);
  assert.equal(result.products.length, 2, 'the two necklace rows are one product');

  const necklace = result.products.find((p) => p.name === 'Beaded necklace');
  assert.ok(necklace);
  assert.equal(necklace.variants.length, 2);
  assert.equal(necklace.quantity, 5, 'three short and two long');
  assert.equal(necklace.price, 8000, 'the cheapest size, since the range starts there');
  assert.equal(necklace.commissionBp, 2500);
});

test('a plain piece reads as one product', () => {
  const r = readImport(file([row()]), ctx);
  assert.deepEqual(r.problems, []);
  assert.equal(r.products.length, 1);
  assert.equal(r.products[0].price, 12000);
  assert.equal(r.products[0].quantity, 3);
  assert.equal(r.products[0].categoryId, 'cat-b');
  assert.equal(r.products[0].consignorId, 'con-a');
  assert.equal(r.pieceCount, 3);
});

test('rows sharing a name become one product with sizes', () => {
  const r = readImport(file([
    row({ price: '', quantity: '', size_type: 'size', size_label: 'Small', size_price: '80', size_quantity: '2' }),
    row({ price: '', quantity: '', size_type: 'size', size_label: 'Large', size_price: '150', size_quantity: '1' }),
  ]), ctx);
  assert.deepEqual(r.problems, []);
  assert.equal(r.products.length, 1);
  assert.equal(r.products[0].variants.length, 2);
  assert.equal(r.products[0].quantity, 3);
  assert.equal(r.products[0].price, 8000);
});

test('the same name from two makers stays two products', () => {
  // Otherwise one maker is credited for the other's work, which is the single
  // worst thing this file could do.
  const r = readImport(file([
    row({ name: 'Small bowl', consignor_code: 'AKO' }),
    row({ name: 'Small bowl', consignor_code: 'YAW' }),
  ]), ctx);
  assert.deepEqual(r.problems, []);
  assert.equal(r.products.length, 2);
  assert.deepEqual(r.products.map((p) => p.consignorId).sort(), ['con-a', 'con-b']);
});

test('a category that does not exist is named, and so are the ones that do', () => {
  const r = readImport(file([row({ category: 'Pottery' })]), ctx);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].message, /Pottery/);
  assert.match(r.problems[0].message, /Baskets, Jewellery/, 'says what it could have been');
  assert.equal(r.products.length, 1, 'still described, so the whole file can be reviewed at once');
});

test('categories and codes are matched loosely, because nobody types them twice the same', () => {
  const r = readImport(file([row({ category: ' baskets ', consignor_code: 'ako' })]), ctx);
  assert.deepEqual(r.problems, []);
  assert.equal(r.products[0].categoryId, 'cat-b');
  assert.equal(r.products[0].consignorId, 'con-a');
});

test('an unknown consignor code is refused rather than credited to nobody', () => {
  const r = readImport(file([row({ consignor_code: 'ZZZ' })]), ctx);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].message, /ZZZ/);
});

test('the shop can own stock outright, with no maker and no commission', () => {
  const r = readImport(file([row({ consignor_code: '' })]), ctx);
  assert.deepEqual(r.problems, []);
  assert.equal(r.products[0].consignorId, '');
});

test('a commission with nobody to pay it is a mistake worth catching', () => {
  const r = readImport(file([row({ consignor_code: '', commission_percent: '30' })]), ctx);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].message, /nobody would be credited/i);
});

test('a percentage and an amount together is refused, since only one can apply', () => {
  const r = readImport(file([row({ commission_percent: '30', commission_amount: '5' })]), ctx);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].message, /one, not both/i);
});

test('commission comes through as basis points or as minor units', () => {
  const pct = readImport(file([row({ commission_percent: '33.5' })]), ctx);
  assert.equal(pct.products[0].commissionBp, 3350);
  assert.equal(pct.products[0].commissionFlat, 0);

  const flat = readImport(file([row({ commission_amount: '2.50' })]), ctx);
  assert.equal(flat.products[0].commissionFlat, 250);
  assert.equal(flat.products[0].commissionBp, null, 'blank means the maker\'s usual rate, not zero percent');
});

test('a percentage outside nought to a hundred is refused', () => {
  assert.equal(readImport(file([row({ commission_percent: '130' })]), ctx).problems.length, 1);
  assert.equal(readImport(file([row({ commission_percent: '-5' })]), ctx).problems.length, 1);
});

test('a piece with no sizes needs a price, and a size needs its own', () => {
  const noPrice = readImport(file([row({ price: '' })]), ctx);
  assert.equal(noPrice.problems.length, 1);
  assert.match(noPrice.problems[0].message, /no price/i);

  const noSizePrice = readImport(file([
    row({ price: '', size_type: 'size', size_label: 'Small', size_price: '' }),
  ]), ctx);
  assert.equal(noSizePrice.problems.length, 1);
  assert.match(noSizePrice.problems[0].message, /size_price/);
  assert.equal(noSizePrice.products.length, 1, 'still listed, so the whole file is reviewed at once');
});

test('quantities have to be whole things', () => {
  assert.equal(readImport(file([row({ quantity: '2.5' })]), ctx).problems.length, 1);
  assert.equal(readImport(file([row({ quantity: '-1' })]), ctx).problems.length, 1);
  assert.equal(readImport(file([row({ quantity: 'a few' })]), ctx).problems.length, 1);
  // Blank is one, which is what a single piece of work usually is.
  assert.equal(readImport(file([row({ quantity: '' })]), ctx).products[0].quantity, 1);
});

test('the same size twice on one piece is caught', () => {
  const r = readImport(file([
    row({ price: '', size_type: 'size', size_label: 'Small', size_price: '80', size_quantity: '1' }),
    row({ price: '', size_type: 'size', size_label: 'small', size_price: '90', size_quantity: '1' }),
  ]), ctx);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].message, /twice/i);
});

test('mixing sized and unsized rows under one name is refused', () => {
  // Otherwise the count is read twice: once off the product and once off the
  // sizes, and the shelf ends up holding more than arrived.
  const r = readImport(file([
    row({ size_type: 'size', size_label: 'Small', size_price: '80', size_quantity: '1' }),
    row({}),
  ]), ctx);
  assert.ok(r.problems.some((p) => /some rows.*have a size/i.test(p.message)));
});

test('a kind of variation the shop does not use is named', () => {
  const r = readImport(file([
    row({ price: '', size_type: 'weight', size_label: 'Heavy', size_price: '80', size_quantity: '1' }),
  ]), ctx);
  assert.ok(r.problems.some((p) => /weight/.test(p.message)));
});

test('a row with no name says so, and does not become a product', () => {
  const r = readImport(file([row({ name: '' }), row()]), ctx);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].message, /no name/i);
  assert.equal(r.products.length, 1);
});

test('problems name the line in the file, counting the heading as line one', () => {
  const r = readImport(file([
    row({ name: 'One' }), row({ name: 'Two', category: 'Nowhere' }), row({ name: 'Three' }),
  ]), ctx);
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].line, 3, 'the second row of data is line 3');
});

test('rows of one piece that disagree are reported, not quietly ignored', () => {
  // Only the first row's category, maker and commission used to be read, so
  // anything different on a later row was accepted and thrown away in silence.
  const r = readImport(file([
    row({ price: '', category: 'Baskets', size_label: 'Small', size_price: '80', size_quantity: '1' }),
    row({ price: '', category: 'Jewellery', size_label: 'Large', size_price: '90', size_quantity: '1' }),
  ]), ctx);
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].line, 3);
  assert.match(r.problems[0].message, /category/);
  assert.match(r.problems[0].message, /has to agree/i);
});

test('a maker changing halfway down a piece is caught', () => {
  const r = readImport(file([
    row({ price: '', consignor_code: 'AKO', size_label: 'Small', size_price: '80', size_quantity: '1' }),
    row({ price: '', consignor_code: 'AKO', commission_percent: '40', size_label: 'Large', size_price: '90', size_quantity: '1' }),
  ]), ctx);
  assert.ok(r.problems.some((p) => /commission_percent/.test(p.message)));
});

test('a broken size is one message, not also a complaint about the price', () => {
  const r = readImport(file([
    row({ price: '', size_type: 'size', size_label: 'Small', size_price: 'ask' }),
  ]), ctx);
  assert.equal(r.problems.length, 1, 'one mistake, one message');
  assert.match(r.problems[0].message, /size_price/);
});

test('a file with the wrong headings is rejected once, not on every row', () => {
  const r = readImport([['thing', 'cost'], ['Basket', '10']], ctx);
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].line, 1);
  assert.match(r.problems[0].message, /name/);
  assert.match(r.problems[0].message, /template/i);
  assert.equal(r.products.length, 0, 'nothing is guessed at from a file of the wrong shape');
});

test('columns are found by name, so a reordered file still reads', () => {
  const swapped = [...IMPORT_HEADINGS].reverse();
  const values: Record<string, string> = {
    name: 'Woven basket', category: 'Baskets', price: '120.00', quantity: '3', consignor_code: 'AKO',
  };
  const r = readImport([swapped, swapped.map((h) => values[h] ?? '')], ctx);
  assert.deepEqual(r.problems, []);
  assert.equal(r.products[0].name, 'Woven basket');
  assert.equal(r.products[0].price, 12000);
});

test('an empty file and a headings-only file both say what is missing', () => {
  assert.match(readImport([], ctx).problems[0].message, /empty/i);
  assert.match(readImport([IMPORT_HEADINGS], ctx).problems[0].message, /no rows/i);
});

test('a name with a comma in it survives the round trip', () => {
  // The reason there is a real parser rather than a split on commas.
  const r = readImport(file([row({ name: 'Basket, large', maker_note: 'Says "handle with care"' })]), ctx);
  assert.deepEqual(r.problems, []);
  assert.equal(r.products[0].name, 'Basket, large');
  assert.equal(r.products[0].makerNote, 'Says "handle with care"');
});

test('a cell that is a note rather than a number is refused, not half read', () => {
  // A form field strips what is not a digit, which is right beside a currency
  // symbol. A cell reading "120 or 130" is somebody thinking aloud, and taking
  // 120 from it would put a price on the shop floor that nobody chose.
  for (const bad of ['120 or 130', '12 each', 'ask Ama', '1.2.3', '']) {
    const r = readImport(file([row({ price: bad })]), ctx);
    assert.equal(r.problems.length, 1, `"${bad}" should be refused`);
    assert.match(r.problems[0].message, /no price/i);
  }

  // What a spreadsheet actually produces still reads: symbols, spaces and
  // thousands separators.
  for (const [text, minor] of [['GH₵120', 12000], ['1,250.50', 125050], ['  99 ', 9900]] as const) {
    const r = readImport(file([row({ price: text })]), ctx);
    assert.deepEqual(r.problems, [], `"${text}" should read`);
    assert.equal(r.products[0].price, minor);
  }
});
