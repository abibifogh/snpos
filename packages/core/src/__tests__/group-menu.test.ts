import test from 'node:test';
import assert from 'node:assert/strict';
import {
  byHeading, portionsIn, UNGROUPED, headingsInUse, headingProblem, itemsUnder, renameWords,
} from '../group-menu.ts';

const dish = (name: string, heading: string) => ({ name, heading });

test('dishes read under the headings the owner gave them, in menu order', () => {
  /*
    Not alphabetical. The order the dishes are listed in is a decision somebody
    made when they sorted the menu, and the alphabet would throw it away and
    put Desserts above Mains.
  */
  const got = byHeading(
    [dish('chicken wrap', 'Wraps'), dish('club', 'Sandwiches'), dish('beef wrap', 'Wraps'), dish('jollof', 'Mains')],
    (d) => d.heading,
  );
  assert.deepEqual(got.map((g) => g.heading), ['Wraps', 'Sandwiches', 'Mains']);
  assert.deepEqual(got[0].entries.map((d) => d.name), ['chicken wrap', 'beef wrap']);
});

test('a dish nobody gave a heading is shown, not lost', () => {
  const got = byHeading([dish('jollof', 'Mains'), dish('mystery', ''), dish('other', '   ')], (d) => d.heading);
  assert.deepEqual(got.map((g) => g.heading), ['Mains', UNGROUPED]);
  assert.equal(got[1].entries.length, 2);
});

test('the catch-all goes last, and nothing else is moved', () => {
  const got = byHeading([dish('a', ''), dish('b', 'Mains'), dish('c', 'Wraps')], (d) => d.heading);
  assert.deepEqual(got.map((g) => g.heading), ['Mains', 'Wraps', UNGROUPED]);
});

test('a heading counts its portions, not its lines', () => {
  const line = (name: string, qty: number) => ({ key: name, menu_item_id: name, name, unit_price: 100, qty, addons: [] });
  const got = byHeading([line('wrap', 9), line('other wrap', 4)], () => 'Wraps');
  assert.equal(portionsIn(got[0]), 13);
  // A quantity typed down to nothing cannot make a heading count backwards.
  assert.equal(portionsIn(byHeading([line('wrap', -3)], () => 'Wraps')[0]), 0);
});

test('the headings in use are counted from the dishes themselves', () => {
  /*
    A heading is not a record anywhere — it is a word typed on a dish — which
    is what makes them cheap to start using and what makes them drift.
  */
  const items = [
    { group_heading: 'Wraps' }, { group_heading: 'Mains' }, { group_heading: 'Wraps' },
    { group_heading: '' }, { group_heading: '  ' }, {},
    { group_heading: '  Mains  ' },
  ];
  assert.deepEqual(headingsInUse(items), [
    { heading: 'Mains', count: 2 },
    { heading: 'Wraps', count: 2 },
  ]);
  assert.deepEqual(headingsInUse([]), []);
});

test('renaming into a heading that exists is the point, not a clash', () => {
  // It is how "wraps" and "Wraps" stop being two headings.
  assert.equal(headingProblem('Wraps', 'wraps'), null);
  assert.equal(headingProblem('  Wraps  ', 'Wraps'), 'That is the name it already has.');
  assert.match(String(headingProblem('', 'Wraps')), /Give the heading a name/);
  assert.match(String(headingProblem('   ')), /Give the heading a name/);
  assert.match(String(headingProblem('x'.repeat(81))), /too long/);
  assert.equal(headingProblem('Wraps'), null);
});

test('a rename touches exactly the dishes under that heading, and says how many', () => {
  const items = [
    { $id: 'a', group_heading: 'wraps' },
    { $id: 'b', group_heading: 'Wraps' },
    { $id: 'c', group_heading: ' wraps ' },
    { $id: 'd', group_heading: '' },
  ];
  assert.deepEqual(itemsUnder(items, 'wraps').map((i) => i.$id), ['a', 'c']);
  assert.deepEqual(itemsUnder(items, 'Wraps').map((i) => i.$id), ['b']);
  assert.match(renameWords(2, ' Wraps '), /2 dishes will be listed under "Wraps"/);
  assert.match(renameWords(1, 'Mains'), /1 dish will be listed/);
});
