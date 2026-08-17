import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readXlsx, looksLikeXlsx } from '../xlsx.ts';

/**
 * A real .xlsx, not a mock: deflate-compressed, with shared strings, a sparse
 * row, an inline string, a split text run and an escaped ampersand. Every one
 * of those is something Excel does routinely and a naive reader gets wrong.
 */
const bytes = readFileSync(new URL('./fixtures/count.xlsx', import.meta.url));
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

test('a real spreadsheet reads back as a grid', async () => {
  const grid = await readXlsx(buffer);
  assert.deepEqual(grid[0], ['product', 'size', 'owner', 'counted']);
});

test('a skipped cell keeps its column rather than shifting the row left', async () => {
  const grid = await readXlsx(buffer);
  // Row 2 has no B. Losing the gap would read the owner as the size, and put
  // a maker's name in the size column on every row of a real export.
  assert.deepEqual(grid[1], ['Large indigo bowl', '', 'Ama & Co', '4']);
});

test('escaped characters come back as themselves', async () => {
  const grid = await readXlsx(buffer);
  assert.equal(grid[1][2], 'Ama & Co');
});

test('an inline string and a split run both read as plain text', async () => {
  const grid = await readXlsx(buffer);
  // "Woven basket" is stored as two runs because somebody bolded half of it.
  assert.equal(grid[2][0], 'Woven basket');
  assert.equal(grid[2][1], 'Small');
  assert.equal(grid[2][3], '11');
});

test('trailing empty rows are dropped', async () => {
  const grid = await readXlsx(buffer);
  // The file has a fourth, empty row — Excel adds them freely.
  assert.equal(grid.length, 3);
});

test('a file that is not a spreadsheet is refused in words', async () => {
  const notZip = new TextEncoder().encode('product,counted\nBowl,4\n');
  await assert.rejects(
    () => readXlsx(notZip.buffer as ArrayBuffer),
    /not a spreadsheet/,
  );
});

test('a spreadsheet is told apart from a csv by its first two bytes', () => {
  assert.equal(looksLikeXlsx(buffer), true);
  assert.equal(looksLikeXlsx(new TextEncoder().encode('product,counted').buffer as ArrayBuffer), false);
});
