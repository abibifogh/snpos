import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupRows, sortRows, toggleGroup, cycleSort, sortPosition, sortDir, flatten, NONE,
} from '../grouping.ts';

interface Row { day: string; who: string; amount: number }

const rows: Row[] = [
  { day: 'Mon', who: 'Ama', amount: 30 },
  { day: 'Mon', who: 'Kofi', amount: 20 },
  { day: 'Tue', who: 'Ama', amount: 100 },
  { day: 'Mon', who: 'Ama', amount: 5 },
];

const valueOf = (r: Row, key: string) => String((r as unknown as Record<string, unknown>)[key] ?? '');
const compare = (a: Row, b: Row, key: string) =>
  (key === 'amount' ? a.amount - b.amount : String(a[key as 'day']).localeCompare(String(b[key as 'day'])));

test('one grouping makes one level', () => {
  const tree = groupRows(rows, [{ key: 'day', label: 'Day' }], valueOf)!;
  assert.deepEqual(tree.map((n) => n.value), ['Mon', 'Tue']);
  assert.equal(tree[0].rows.length, 3);
  assert.equal(tree[0].children, null);
});

test('two groupings nest, in the order they were chosen', () => {
  const tree = groupRows(rows, [
    { key: 'day', label: 'Day' },
    { key: 'who', label: 'Who' },
  ], valueOf)!;
  assert.deepEqual(tree.map((n) => n.value), ['Mon', 'Tue']);
  assert.deepEqual(tree[0].children!.map((n) => n.value), ['Ama', 'Kofi']);
  assert.equal(tree[0].children![0].rows.length, 2);
});

test('the other order is a different question, and gives a different answer', () => {
  // Days-inside-people and people-inside-days are both useful and they are not
  // the same shape. Sorting the choices into something tidy would lose one.
  const tree = groupRows(rows, [
    { key: 'who', label: 'Who' },
    { key: 'day', label: 'Day' },
  ], valueOf)!;
  assert.deepEqual(tree.map((n) => n.value), ['Ama', 'Kofi']);
  assert.deepEqual(tree[0].children!.map((n) => n.value), ['Mon', 'Tue']);
});

test('no grouping at all is no tree', () => {
  assert.equal(groupRows(rows, [], valueOf), null);
});

test('a parent holds every row beneath it, through the nesting', () => {
  const tree = groupRows(rows, [
    { key: 'day', label: 'Day' },
    { key: 'who', label: 'Who' },
  ], valueOf)!;
  const mon = tree[0];
  assert.equal(mon.rows.length, 3);
  assert.equal(mon.children!.reduce((n, c) => n + c.rows.length, 0), 3);
});

test('rows with no answer are grouped, and go last', () => {
  // A screen led by "—" looks broken, and those rows are the least
  // interesting on it.
  const mixed = [{ day: '', who: 'Ama', amount: 1 }, ...rows];
  const tree = groupRows(mixed, [{ key: 'day', label: 'Day' }], valueOf)!;
  assert.deepEqual(tree.map((n) => n.value), ['Mon', 'Tue', NONE]);
});

test('group paths are stable, so an open group stays open', () => {
  const a = groupRows(rows, [{ key: 'day', label: 'Day' }], valueOf)!;
  const b = groupRows(rows, [{ key: 'day', label: 'Day' }], valueOf)!;
  assert.deepEqual(a.map((n) => n.path), b.map((n) => n.path));
});

test('a nested path is distinct from its parent’s', () => {
  const tree = groupRows(rows, [
    { key: 'day', label: 'Day' },
    { key: 'who', label: 'Who' },
  ], valueOf)!;
  assert.notEqual(tree[0].path, tree[0].children![0].path);
  assert.ok(tree[0].children![0].path.startsWith(tree[0].path));
});

/* ------------------------------------------------------------------ sorting */

test('the first sort decides and the rest break ties', () => {
  const out = sortRows(rows, [
    { key: 'day', label: 'Day', dir: 'asc' },
    { key: 'amount', label: 'Amount', dir: 'desc' },
  ], compare);
  assert.deepEqual(out.map((r) => `${r.day}${r.amount}`), ['Mon30', 'Mon20', 'Mon5', 'Tue100']);
});

test('reversing one sort does not disturb the other', () => {
  const out = sortRows(rows, [
    { key: 'day', label: 'Day', dir: 'asc' },
    { key: 'amount', label: 'Amount', dir: 'asc' },
  ], compare);
  assert.deepEqual(out.map((r) => `${r.day}${r.amount}`), ['Mon5', 'Mon20', 'Mon30', 'Tue100']);
});

test('sorting never reorders the array it was given', () => {
  // A table rendering from the same array reorders itself under somebody
  // mid-scroll.
  const original = [...rows];
  sortRows(rows, [{ key: 'amount', label: 'Amount', dir: 'asc' }], compare);
  assert.deepEqual(rows, original);
});

test('no sort chosen leaves the order alone', () => {
  assert.deepEqual(sortRows(rows, [], compare), rows);
});

/* ------------------------------------------------------------------ choosing */

test('choosing a grouping twice moves it to the end, rather than removing it', () => {
  // Almost never a request to remove — the chip has an × for that — and very
  // often somebody trying to change the order.
  const day = { key: 'day', label: 'Day' };
  const who = { key: 'who', label: 'Who' };
  const both = toggleGroup(toggleGroup([], day), who);
  assert.deepEqual(both.map((c) => c.key), ['day', 'who']);
  assert.deepEqual(toggleGroup(both, day).map((c) => c.key), ['who']);
});

test('a column header cycles off, up, down, off', () => {
  let sorts = cycleSort([], 'amount', 'Amount');
  assert.equal(sortDir(sorts, 'amount'), 'asc');
  sorts = cycleSort(sorts, 'amount', 'Amount');
  assert.equal(sortDir(sorts, 'amount'), 'desc');
  sorts = cycleSort(sorts, 'amount', 'Amount');
  assert.equal(sortDir(sorts, 'amount'), null);
});

test('a second column is added as a tie-breaker, not a replacement', () => {
  const sorts = cycleSort(cycleSort([], 'day', 'Day'), 'amount', 'Amount');
  assert.deepEqual(sorts.map((s) => s.key), ['day', 'amount']);
  assert.equal(sortPosition(sorts, 'day'), 1);
  assert.equal(sortPosition(sorts, 'amount'), 2);
});

test('a column not being sorted on has no position', () => {
  assert.equal(sortPosition([], 'day'), 0);
  assert.equal(sortDir([], 'day'), null);
});

/* ---------------------------------------------------------------- flattening */

test('flattening gives back the rows in the order the groups put them', () => {
  // What an export needs: the grouping decided the order, and a spreadsheet
  // that disagreed with the screen would disagree about what "the first
  // twenty" means.
  const tree = groupRows(rows, [{ key: 'day', label: 'Day' }], valueOf);
  assert.deepEqual(flatten(tree, rows).map((r) => r.day), ['Mon', 'Mon', 'Mon', 'Tue']);
});

test('flattening an ungrouped list is the list', () => {
  assert.deepEqual(flatten(null, rows), rows);
});
