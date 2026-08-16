import test from 'node:test';
import assert from 'node:assert/strict';
import { readMakerImport, MAKER_HEADINGS, MAKER_TEMPLATE_ROWS } from '../maker-import.ts';

const ctx = (existing: { $id: string; code: string; name: string }[] = []) => ({ existing, decimals: 2 });
const withHeadings = (...rows: string[][]) => [MAKER_HEADINGS, ...rows];

test('the shipped template is a file this can actually read', () => {
  // A template that does not survive its own importer is worse than none: the
  // first thing anybody does is download it, fill it in, and upload it back.
  const result = readMakerImport(withHeadings(...MAKER_TEMPLATE_ROWS), ctx());
  assert.deepEqual(result.problems, []);
  assert.equal(result.makers.length, 2);
  assert.equal(result.makers[0].commissionBp, 3000, '30% kept by the shop');
  assert.equal(result.makers[1].commissionFlat, 1500, 'a flat 15.00 a piece');
  assert.equal(result.makers[1].commissionBp, null);
});

test('a code already on file is a correction, not a duplicate', () => {
  /**
   * The commonest second use of this screen: the shop renegotiated with four
   * makers and wants the new rates in. Refusing the row would make the file
   * useless for that; saying which rows are corrections before anything is
   * written is what makes it safe rather than surprising.
   */
  const result = readMakerImport(
    withHeadings(['AKO', 'Akosua Mensah', '', '', '25', '', '', '', '', '']),
    ctx([{ $id: 'c1', code: 'ako', name: 'Akosua Mensah' }]),
  );
  assert.deepEqual(result.problems, []);
  assert.equal(result.makers[0].updates, true, 'matched regardless of case');
  assert.equal(result.updateCount, 1);
  assert.equal(result.newCount, 0);
});

test('two rows claiming one code are caught before either is written', () => {
  const result = readMakerImport(
    withHeadings(
      ['AKO', 'Akosua Mensah', '', '', '30', '', '', '', '', ''],
      ['ako', 'Akosua M.', '', '', '25', '', '', '', '', ''],
    ),
    ctx(),
  );
  assert.equal(result.makers.length, 1, 'the second is refused, not silently applied over the first');
  assert.match(result.problems[0].message, /already used on line 2/);
  assert.equal(result.problems[0].line, 3);
});

test('a rate and a flat amount cannot both apply', () => {
  /**
   * The one field where a mistake follows every sale that maker ever makes and
   * is only noticed when they query a statement months later. Two answers to
   * "what does the shop keep" is not something to resolve by guessing.
   */
  const result = readMakerImport(
    withHeadings(['AKO', 'Akosua', '', '', '30', '15.00', '', '', '', '']),
    ctx(),
  );
  assert.equal(result.makers.length, 0);
  assert.match(result.problems[0].message, /Only one of the two can apply/);
});

test('nonsense is named with its line number', () => {
  const result = readMakerImport(
    withHeadings(
      ['', 'No code here', '', '', '', '', '', '', '', ''],
      ['MB2', '', '', '', '', '', '', '', '', ''],
      ['MB3', 'Fine', '', '', '150', '', '', '', '', ''],
      ['MB4', 'Fine', '', '', '', '', 'cheque', '', '', ''],
    ),
    ctx(),
  );
  assert.equal(result.makers.length, 0);
  assert.deepEqual(result.problems.map((p) => p.line), [2, 3, 4, 5]);
  assert.match(result.problems[0].message, /No code/);
  assert.match(result.problems[1].message, /has no name/);
  assert.match(result.problems[2].message, /not a percentage between 0 and 100/);
  assert.match(result.problems[3].message, /not a way of paying/);
});

test('a blank line in the middle of a spreadsheet is spacing, not a maker', () => {
  const result = readMakerImport(
    withHeadings(
      ['AKO', 'Akosua', '', '', '30', '', '', '', '', ''],
      ['', '', '', '', '', '', '', '', '', ''],
      ['MB2', 'Kwame', '', '', '30', '', '', '', '', ''],
    ),
    ctx(),
  );
  assert.deepEqual(result.problems, []);
  assert.equal(result.makers.length, 2);
});

test('a missing heading stops the whole file rather than half-reading it', () => {
  const result = readMakerImport([['name', 'phone'], ['Akosua', '024']], ctx());
  assert.equal(result.makers.length, 0);
  assert.match(result.problems[0].message, /no "code" column/);
});

test('a blank rate means "leave their terms alone"', () => {
  // Absent is the only reading that makes a partial file safe: one put together
  // to correct four phone numbers must not reset everybody to the house rate.
  const result = readMakerImport(
    withHeadings(['AKO', 'Akosua', '0244', '', '', '', '', '', '', '']),
    ctx([{ $id: 'c1', code: 'AKO', name: 'Akosua' }]),
  );
  assert.equal(result.makers[0].commissionBp, null);
  assert.equal(result.makers[0].commissionFlat, 0);
});

test('an empty file says so rather than reporting nothing to do', () => {
  const result = readMakerImport([], ctx());
  assert.match(result.problems[0].message, /empty/);
});
