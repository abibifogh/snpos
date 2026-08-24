import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readLevelImport, levelTotals, LEVEL_TEMPLATE_ROWS,
  levelPayload, readLevelPayload, rowsFromPayload, restoreProblem,
} from '../level-import.ts';

const ctx = {
  ingredients: [
    { $id: 'i1', name: 'Havana Club Bottle', unit: 'shot' },
    { $id: 'i2', name: 'Tonic', unit: 'bottle' },
    { $id: 'i3', name: 'Lime', unit: 'each' },
  ],
  locations: [{ $id: 'L1', name: 'Store room' }, { $id: 'L2', name: 'The bar' }],
};
const file = (...rows: string[][]) => [['name', 'unit', 'Store room', 'The bar'], ...rows];

test('the shipped template is a file this can actually read', () => {
  const r = readLevelImport(file(...LEVEL_TEMPLATE_ROWS), ctx);
  assert.deepEqual(r.problems, []);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.matchedPlaces, ['Store room', 'The bar']);
});

test('place columns are matched by name, not fixed in the code', () => {
  /**
   * A business with a cellar as well gets a third column by naming it, not by
   * anybody editing anything. Columns that match nothing are named rather than
   * silently skipped — one somebody meant as a place and misspelled looks
   * identical to one they meant as a note.
   */
  const r = readLevelImport(
    [['name', 'The bar', 'Cellar', 'store_was_negative'], ['Tonic', '13', '5', '-108']],
    ctx,
  );
  assert.deepEqual(r.matchedPlaces, ['The bar']);
  assert.deepEqual(r.ignoredColumns, ['Cellar', 'store_was_negative']);
  assert.deepEqual(r.rows[0].levels, [{ locationId: 'L2', locationName: 'The bar', qty: 13 }]);
});

test('blank leaves a place alone; nought empties it', () => {
  /**
   * The same distinction the count sheets draw, and for the same reason: a
   * blank cell is somebody not saying, and nought is somebody saying none.
   * Conflating them would empty every room a file did not mention.
   */
  const r = readLevelImport(file(['Tonic', 'bottle', '', '0']), ctx);
  assert.deepEqual(r.rows[0].levels, [{ locationId: 'L2', locationName: 'The bar', qty: 0 }]);
  assert.equal(r.rows[0].levels.length, 1, 'the store is not touched');
});

test('a row that names nothing we stock is skipped, not fatal', () => {
  /**
   * A stock export routinely carries things the bar does not stock, and
   * refusing the whole file over one of them would be refusing the useful part.
   */
  const r = readLevelImport(file(
    ['Havana Club Bottle', 'shot', '120', '28'],
    ['Empty crates', 'each', '40', '0'],
  ), ctx);
  assert.equal(r.rows.length, 1, 'the good row still goes in');
  assert.deepEqual(r.unknownItems, ['Empty crates']);
  assert.match(r.problems[0].message, /not one of your bottles or mixers/);
});

test('a negative opening level is refused with the reason', () => {
  // Almost always sales recorded against stock never booked in. Importing it
  // would carry somebody else's unresolved problem across as fact.
  const r = readLevelImport(file(['Tonic', 'bottle', '-108', '13']), ctx);
  assert.equal(r.rows.length, 0);
  assert.match(r.problems[0].message, /cannot hold less than none/);
});

test('a file naming no places at all says which places exist', () => {
  const r = readLevelImport([['name', 'qty'], ['Tonic', '13']], ctx);
  assert.equal(r.rows.length, 0);
  assert.match(r.problems[0].message, /Store room, The bar/);
});

test('the totals are shown before anything is written', () => {
  const r = readLevelImport(file(
    ['Havana Club Bottle', 'shot', '120', '28'],
    ['Tonic', 'bottle', '48', '13'],
  ), ctx);
  assert.deepEqual(levelTotals(r.rows), [
    { place: 'Store room', items: 2, units: 168 },
    { place: 'The bar', items: 2, units: 41 },
  ]);
});

test('matching is loose about case and spacing, strict about meaning', () => {
  const r = readLevelImport([['name', ' the BAR '], ['  tonic ', '13']], ctx);
  assert.deepEqual(r.problems, []);
  assert.equal(r.rows[0].ingredientId, 'i2');
  assert.equal(r.rows[0].name, 'Tonic', 'the stored spelling wins, not the file’s');
});

/* --------------------------------------------- keeping what was uploaded */

test('an upload is stored as the figures it set, not as the moves it made', () => {
  /*
    THE WHOLE POINT.

    A movement says how far a shelf moved. Working the uploaded figure back
    from that means knowing what the shelf held beforehand — which is exactly
    the thing that has changed since, or nobody would be restoring anything.
  */
  const rows = [
    { ingredientId: 'gin', name: 'Gin', line: 2, levels: [
      { locationId: 'store', locationName: 'Store room', qty: 120 },
      { locationId: 'bar', locationName: 'The bar', qty: 15 },
    ] },
  ];
  assert.deepEqual(levelPayload(rows), [
    { i: 'gin', l: 'store', q: 120 },
    { i: 'gin', l: 'bar', q: 15 },
  ]);
});

test('a stored upload reads back into rows the applier understands', () => {
  const stored = [{ i: 'gin', l: 'bar', q: 15 }, { i: 'gin', l: 'store', q: 120 }];
  const rows = rowsFromPayload(stored, {
    ingredients: [{ $id: 'gin', name: 'Gin' }],
    locations: [{ $id: 'bar', name: 'The bar' }, { $id: 'store', name: 'Store room' }],
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].levels.map((l) => [l.locationName, l.qty]), [['The bar', 15], ['Store room', 120]]);
});

test('a room renamed since restores under the name it has now', () => {
  // The name is looked up fresh rather than stored, so an upload cannot rename
  // things back to what they were called on the day.
  const rows = rowsFromPayload([{ i: 'gin', l: 'bar', q: 15 }], {
    ingredients: [{ $id: 'gin', name: 'Havana Club' }],
    locations: [{ $id: 'bar', name: 'The front bar' }],
  });
  assert.equal(rows[0].name, 'Havana Club');
  assert.equal(rows[0].levels[0].locationName, 'The front bar');
});

test('anything since deleted is dropped rather than restored into nothing', () => {
  /*
    A figure put into a room that no longer exists is a level nothing can ever
    count — it would sit in the totals and never appear on a sheet.
  */
  const rows = rowsFromPayload([{ i: 'gin', l: 'gone', q: 15 }, { i: 'rum', l: 'bar', q: 4 }], {
    ingredients: [{ $id: 'gin', name: 'Gin' }, { $id: 'rum', name: 'Rum' }],
    locations: [{ $id: 'bar', name: 'The bar' }],
  });
  assert.deepEqual(rows.map((r) => r.ingredientId), ['rum']);
});

test('an upload whose every line has gone says so rather than doing nothing', () => {
  const stored = [{ i: 'gin', l: 'gone', q: 15 }];
  const rows = rowsFromPayload(stored, { ingredients: [], locations: [] });
  assert.match(restoreProblem(stored, rows) ?? '', /no longer exists|removed since/);
  assert.match(restoreProblem([], []) ?? '', /nothing in it/);
  // And one that still resolves is allowed through.
  assert.equal(restoreProblem(stored, [{ ingredientId: 'gin', name: 'Gin', levels: [], line: 0 }]), null);
});

test('a payload that cannot be read is no upload at all', () => {
  // Rather than throwing in the middle of a restore. A row somebody edited by
  // hand, or written by an older version, must not take the screen down.
  assert.deepEqual(readLevelPayload('not json'), []);
  assert.deepEqual(readLevelPayload(undefined), []);
  assert.deepEqual(readLevelPayload('{"i":"gin"}'), []);
  assert.deepEqual(readLevelPayload('[{"i":"gin","l":"bar","q":15},{"i":1}]'), [{ i: 'gin', l: 'bar', q: 15 }]);
});
