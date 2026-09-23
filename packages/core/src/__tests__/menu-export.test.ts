import test from 'node:test';
import assert from 'node:assert/strict';
import {
  menuCsv, menuSections, menuFileStem, menuExportProblem, tagWords,
} from '../menu-export.ts';
import type { ExportableItem } from '../menu-export.ts';

/*
  A catalogue leaves this system for two kinds of reader: a spreadsheet, and a
  person holding a sheet of paper. They are built from one set of facts so a
  price list handed to an accountant and a menu pinned in the office cannot
  disagree about what a dish costs.
*/

const dish = (over: Partial<ExportableItem> = {}): ExportableItem => ({
  name: 'Jollof rice', price: 9_000, active: true, categoryName: 'Mains', ...over,
});

/* ------------------------------------------------------------ the spreadsheet */

test('a price is a number a spreadsheet can add up', () => {
  /*
    The first thing anybody does with an exported price list is sort by price
    or total it. "GH₵90.00" is text: a spreadsheet will do neither with it.
  */
  const { headers, rows } = menuCsv([dish()], { currency: 'GHS' });
  assert.equal(rows[0]?.[2], '90.00');
  assert.match(String(headers[2]), /GHS/, 'the currency is said once, in the heading');
});

test('a business keeping three decimals keeps them', () => {
  // Rounding somebody's prices on the way out is changing their figures.
  const { rows } = menuCsv([dish({ price: 9_125 })], { decimals: 3 });
  assert.equal(rows[0]?.[2], '9.125');
});

test('archived rows are named rather than left as a column of falses', () => {
  const { rows } = menuCsv([dish({ active: false })]);
  assert.equal(rows[0]?.[6], 'Archived');
  assert.equal(menuCsv([dish()]).rows[0]?.[6], 'Yes');
});

test('the kitchen and the shop are asked different questions', () => {
  /*
    A dish has a prep time and a station; a consigned piece has a maker, a
    shelf and a commission. Neither wants the other's columns, and a file full
    of blanks is a file somebody has to work out the shape of.
  */
  const kitchen = menuCsv([dish({ prep_minutes: 15, station: 'hot' })]).headers;
  assert.ok(kitchen.includes('Prep minutes'));
  assert.equal(kitchen.includes('Maker'), false);

  const shop = menuCsv([dish()], { craft: true }).headers;
  assert.ok(shop.includes('Maker'));
  assert.ok(shop.includes('In stock'));
  assert.equal(shop.includes('Station'), false);
});

test('a service has no shelf, and says so with a blank rather than a nought', () => {
  // Nought reads as "none left", which would have somebody reordering
  // something that is work rather than a thing.
  const { headers, rows } = menuCsv([dish({ is_service: true, on_hand: 0 })], { craft: true });
  assert.equal(rows[0]?.[headers.indexOf('In stock')], '');
  const piece = menuCsv([dish({ on_hand: 0 })], { craft: true });
  assert.equal(piece.rows[0]?.[headers.indexOf('In stock')], '0', 'a real piece at nought says nought');
});

test('a commission in basis points comes out as a percentage', () => {
  const { headers, rows } = menuCsv([dish({ commission_bp: 3_000 })], { craft: true });
  assert.equal(rows[0]?.[headers.indexOf('Commission %')], '30.00');
});

test('the code column takes whichever code the thing has', () => {
  assert.equal(menuCsv([dish({ sku: 'JR-1' })]).rows[0]?.[4], 'JR-1');
  assert.equal(menuCsv([dish({ barcode: '50123' })]).rows[0]?.[4], '50123');
  assert.equal(menuCsv([dish()]).rows[0]?.[4], '');
});

test('every row has a cell for every heading', () => {
  // A short row silently shifts every later column left, which is how a
  // station ends up in the prep-time column and nobody notices.
  const { headers, rows } = menuCsv([dish(), dish({ active: false })], { craft: true });
  for (const r of rows) assert.equal(r.length, headers.length);
});

/* ------------------------------------------------------------- the printout */

test('the printed list is grouped by category, in the order it was shown', () => {
  /*
    Not alphabetically. Whoever exported had already arranged the screen, and
    that arrangement is the only statement of intent this document has.
  */
  const out = menuSections([
    dish({ name: 'Kelewele', categoryName: 'Starters' }),
    dish({ name: 'Jollof', categoryName: 'Mains' }),
    dish({ name: 'Wings', categoryName: 'Starters' }),
  ]);
  assert.deepEqual(out.map((s) => s.category), ['Starters', 'Mains']);
  assert.deepEqual(out[0]?.items.map((i) => i.name), ['Kelewele', 'Wings'], 'and in the order they came');
});

test('a dish with no category is gathered rather than dropped', () => {
  // A dish missing from a printed menu is a dish nobody sells.
  const out = menuSections([dish({ categoryName: 'Mains' }), dish({ name: 'Orphan', categoryName: '' })]);
  assert.deepEqual(out.map((s) => s.category), ['Mains', 'Everything else']);
  assert.equal(out[1]?.items[0]?.name, 'Orphan');
});

test('nothing loose means no stray heading', () => {
  const out = menuSections([dish()]);
  assert.deepEqual(out.map((s) => s.category), ['Mains']);
});

test('an empty catalogue is an empty list, not a crash', () => {
  assert.deepEqual(menuSections([]), []);
  assert.deepEqual(menuCsv([]).rows, []);
});

/* ------------------------------------------------------------- the details */

test('tags read as words', () => {
  assert.equal(tagWords(['Vegan', 'Contains nuts']), 'Vegan, Contains nuts');
  assert.equal(tagWords([]), '');
  assert.equal(tagWords(undefined), '');
});

test('the file says which side and how old it is', () => {
  // A bistro's list and a shop's would otherwise overwrite each other in a
  // downloads folder, and nobody can tell last month's price list from this
  // month's by looking at it.
  const stem = menuFileStem('kitchen', new Date('2026-09-23T10:00:00Z'));
  assert.equal(stem, 'kitchen-menu-2026-09-23');
  assert.match(menuFileStem('craft', new Date('2026-09-23T10:00:00Z')), /^craft-/);
});

test('an export of nothing says so rather than handing over an empty file', () => {
  assert.match(String(menuExportProblem([])), /Nothing to export/);
  assert.equal(menuExportProblem([dish()]), null);
});
