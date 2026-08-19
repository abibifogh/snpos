import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tradeWords, offCountLine, offSubject } from '../words.ts';

test('a shop counter does not talk about dishes or menus', () => {
  // The bug as reported: marking a luggage strap sold out said "2 dishes are
  // off the menu" and "the kitchen screen will not show them".
  assert.equal(offCountLine(2, 'craft'), '2 pieces are off the shelf.');
  assert.equal(offSubject('Luggage strap', 'craft'), 'Off the shelf: Luggage strap');
  assert.equal(/kitchen|menu|dish/.test(tradeWords('craft').consequence), false);
});

test('a bar has no kitchen screen', () => {
  // Saying it does sends a bartender looking for one, and teaches them the
  // message was not written about them.
  assert.equal(/kitchen/.test(tradeWords('bar').consequence), false);
  assert.equal(offCountLine(1, 'bar'), '1 drink is off the menu.');
});

test('the kitchen keeps the words it always had', () => {
  assert.equal(offCountLine(2, 'kitchen'), '2 dishes are off the menu.');
  assert.equal(offSubject('Jollof', 'kitchen'), 'Off the menu: Jollof');
  assert.match(tradeWords('kitchen').consequence, /kitchen screen/);
});

test('one of something reads as one, not as none', () => {
  assert.equal(offCountLine(1, 'kitchen'), '1 dish is off the menu.');
  assert.equal(offCountLine(1, 'craft'), '1 piece is off the shelf.');
});

test('a side nobody named is the kitchen, as everywhere else', () => {
  assert.deepEqual(tradeWords(undefined), tradeWords('kitchen'));
  assert.deepEqual(tradeWords('something else'), tradeWords('kitchen'));
});

test('a subject line starts with a capital', () => {
  assert.ok(/^[A-Z]/.test(offSubject('X', 'craft')));
  assert.ok(/^[A-Z]/.test(offSubject('X', 'bar')));
});

test('each side has its own name for its catalogue', () => {
  assert.equal(tradeWords('kitchen').title, 'Dishes & drinks');
  assert.equal(tradeWords('bar').title, 'Drinks & cocktails');
  assert.equal(tradeWords('craft').title, 'Products');
});

test('a piece sells out, a dish runs out', () => {
  // There was only ever the one of it, so "run out" is the wrong idea.
  assert.match(tradeWords('craft').ranOut, /sold out/);
  assert.match(tradeWords('kitchen').ranOut, /run out/);
});
