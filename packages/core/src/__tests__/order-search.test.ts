import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tidyQuery, digitsOf, orderNoMatches, searchOrders, orderNoCandidates,
  worthLookingUp, lookingWords, foundWords,
} from '../order-search.ts';

/*
  Somebody is holding a receipt, or reading a number down a telephone, and
  needs THAT order. Everything here is shaped by how a number gets off paper
  and into a box, which is never the way it is stored.
*/

const order = (order_no: string) => ({ order_no });

test('a number read off a receipt finds the order it is printed on', () => {
  // Nobody types ORD0866. They type 866.
  assert.equal(orderNoMatches('ORD0866', '866'), true);
  assert.equal(orderNoMatches('ORD0866', '0866'), true);
  assert.equal(orderNoMatches('ORD0866', 'ORD0866'), true);
  assert.equal(orderNoMatches('ORD0866', 'ord0866'), true, 'case is not a question anybody means to ask');
});

test('the punctuation a paste brings with it is thrown away', () => {
  for (const typed of [' ORD0866 ', 'ORD 0866', '#ORD0866', 'ord-0866', 'ORD/0866']) {
    assert.equal(orderNoMatches('ORD0866', typed), true, typed);
  }
});

test('a part of the number matches while somebody is still typing', () => {
  assert.equal(orderNoMatches('ORD0866', '86'), true);
  assert.equal(orderNoMatches('ORD0866', 'ORD'), true);
});

test('leading noughts are dropped on both sides', () => {
  /*
    So that changing the padding in the settings never makes an old order
    unfindable by the number printed on its own receipt.
  */
  assert.equal(orderNoMatches('ORD000866', '866'), true);
  assert.equal(orderNoMatches('ORD866', '0866'), true);
  assert.equal(digitsOf('ORD0866'), '866');
  assert.equal(digitsOf('ORD0000'), '0', 'a number of noughts is still a number');
});

test('a different order is not offered as an answer', () => {
  assert.equal(orderNoMatches('ORD0912', '866'), false);
  assert.equal(orderNoMatches('S0866', 'ORD0866'), false, 'a shop sale is not the bistro sale of that number');
  assert.equal(orderNoMatches(undefined, '866'), false);
});

test('an empty box is not a filter', () => {
  // Otherwise clearing the search empties the page instead of restoring it.
  assert.equal(orderNoMatches('ORD0866', ''), true);
  assert.equal(orderNoMatches('ORD0866', '   '), true);
  const all = [order('ORD0866'), order('ORD0912')];
  assert.deepEqual(searchOrders(all, ''), all);
});

test('the list keeps the order it arrived in', () => {
  // It was already sorted by whatever the person chose. Re-ordering by how
  // well something matched would throw that away for no gain.
  const all = [order('ORD0866'), order('ORD0912'), order('ORD0868')];
  assert.deepEqual(searchOrders(all, '86').map((o) => o.order_no), ['ORD0866', 'ORD0868']);
});

test('tidying is the same question asked of a stored number and a typed one', () => {
  assert.equal(tidyQuery(' ord 0866 '), 'ORD0866');
  assert.equal(tidyQuery(''), '');
});

/* ------------------------------------------- going beyond the loaded dates */

test('a bare number is turned into the exact numbers worth asking for', () => {
  /*
    A key index answers `equal`, not "contains", so a look beyond the loaded
    dates has to name the number exactly. Somebody typing 866 means one of a
    handful of things, and asking for all of them in one query is cheaper than
    making them work out which prefix they want.
  */
  const c = orderNoCandidates('866', ['ORD', 'S', 'BAR'], 4);
  assert.ok(c.includes('ORD0866'));
  assert.ok(c.includes('S0866'));
  assert.ok(c.includes('BAR0866'));
  // A side with no prefix of its own writes a bare number.
  assert.ok(c.includes('0866'));
});

test('an order number pasted whole is asked for exactly as typed', () => {
  // So it works whatever the prefixes happen to be now, including a run from
  // before somebody changed them.
  assert.ok(orderNoCandidates('ORD0866', ['ORD']).includes('ORD0866'));
  assert.ok(orderNoCandidates(' ord-0866 ', ['ORD']).includes('ORD0866'), 'tidied first');
});

test('both padded and unpadded go in', () => {
  // A business that changed its padding has both shapes in the same table.
  const c = orderNoCandidates('866', ['ORD'], 4);
  assert.ok(c.includes('ORD0866'));
  assert.ok(c.includes('ORD866'));
});

test('the list of guesses is capped', () => {
  // Appwrite caps how many values one `equal` may carry, and a hundred
  // near-identical guesses is a slow query answering nothing extra.
  const many = Array.from({ length: 40 }, (_, i) => `P${i}`);
  assert.ok(orderNoCandidates('866', many).length <= 25);
});

test('nothing is asked for on an empty box', () => {
  assert.deepEqual(orderNoCandidates('', ['ORD']), []);
});

test('one character is somebody who has started typing, not a search', () => {
  // A query per keystroke against every order ever taken is a page that gets
  // slower the harder you try to use it.
  assert.equal(worthLookingUp('8'), false);
  assert.equal(worthLookingUp('86'), true);
  assert.equal(worthLookingUp('  '), false);
});

test('a row from outside the chosen dates says that it is', () => {
  /*
    A row appearing in a list that the dates above say cannot contain it is
    the kind of thing that makes somebody distrust both.
  */
  assert.match(foundWords('866', 1), /1 order found outside the dates/);
  assert.match(foundWords('866', 3), /3 orders found outside the dates/);
  assert.match(foundWords('866', 3), /Widen the dates/);
});

test('not found anywhere says so, and names the one innocent explanation', () => {
  const words = foundWords('866', 0);
  assert.match(words, /No order anywhere is numbered/);
  assert.match(words, /offline/, 'a till that could not reach the database is the honest other answer');
});

test('the waiting line says which query it is waiting on', () => {
  assert.match(lookingWords(' 866 '), /866/);
  assert.match(lookingWords('866'), /every date/);
});

test('a prefix that was typed is honoured, because the runs are per side', () => {
  /*
    Order numbers are unique per venue but the RUNS are per side, so the
    shop's S0866 and the bistro's ORD0866 are two different bills wearing the
    same number. Somebody who typed ORD has said which one they want.
  */
  assert.equal(orderNoMatches('S0866', 'ORD0866'), false);
  assert.equal(orderNoMatches('ORD0866', 'S0866'), false);
  assert.equal(orderNoMatches('S0866', '866'), true, 'no prefix typed, so no prefix demanded');
  // Matched from the left, so it narrows while somebody is still typing.
  assert.equal(orderNoMatches('BAR0866', 'B'), true);
  assert.equal(orderNoMatches('ORD0866', 'B'), false);
});

test('the prefix without the padding is how people actually type it', () => {
  assert.equal(orderNoMatches('ORD0866', 'ord866'), true);
  assert.equal(orderNoMatches('ORD0866', 'ORD866'), true);
});

test('a prefix on its own asks for everything in that run', () => {
  assert.equal(orderNoMatches('ORD0866', 'ORD'), true);
  assert.equal(orderNoMatches('ORD0912', 'ORD'), true);
  assert.equal(orderNoMatches('S0866', 'ORD'), false);
});
