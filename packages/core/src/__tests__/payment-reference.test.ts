import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceRequired, referenceProblem, referenceWords } from '../payment-reference.ts';

const card = { kind: 'card', name: 'Visa machine' };
const cash = { kind: 'cash', name: 'Cash' };
const momo = { kind: 'mobile_money', name: 'Momo' };

test('a card always needs the machine’s number, ticked or not', () => {
  /*
    The flag is a setting somebody can forget. A card sale without its trace
    number cannot be matched to the bank however the method was configured,
    so the flag does not get a say for a card.
  */
  assert.equal(referenceRequired(card), true);
  assert.equal(referenceRequired({ ...card, requires_reference: false }), true);
  assert.equal(referenceProblem({ ...card, requires_reference: false }, ''), referenceProblem(card, ''));
  assert.match(String(referenceProblem(card, '')), /STAN/);
  assert.match(String(referenceProblem(card, '   ')), /card machine/);
  assert.equal(referenceProblem(card, '004521'), null);
});

test('cash never needs one', () => {
  assert.equal(referenceRequired(cash), false);
  assert.equal(referenceProblem(cash, ''), null);
});

test('everything else follows the method, which is how it already worked', () => {
  assert.equal(referenceRequired(momo), false);
  assert.equal(referenceProblem(momo, ''), null);

  const asked = { ...momo, requires_reference: true };
  assert.equal(referenceRequired(asked), true);
  assert.match(String(referenceProblem(asked, '')), /Enter the reference for the Momo/);
  assert.equal(referenceProblem(asked, 'MP2609.1234'), null);
});

test('no method chosen is not a missing reference', () => {
  // The screen has its own complaint for that, and two at once helps nobody.
  assert.equal(referenceRequired(null), false);
  assert.equal(referenceProblem(null, ''), null);
  assert.equal(referenceProblem(undefined, ''), null);
});

test('the box asks for the same thing wherever it appears', () => {
  // It said "Reference" on one screen, "Visa machine reference" on another
  // and "if there is one" on a third, for the same number.
  assert.match(referenceWords(card).label, /STAN/);
  assert.match(referenceWords(card).hint, /matches this sale to the bank/);
  assert.equal(referenceWords(momo).label, 'Transaction ID');
  assert.equal(referenceWords({ kind: 'bank', name: 'Transfer' }).label, 'Transfer reference');
  // A method with no name still asks for something readable.
  assert.equal(referenceWords({ kind: 'bank' }).label, 'Payment reference');
});

test('a message names the machine, not the field', () => {
  /*
    The person reading it is standing in front of a card terminal and a
    screen, and only one of them has the number on it.
  */
  const said = String(referenceProblem(card, ''));
  assert.match(said, /printout/);
  assert.match(said, /cannot be matched to the bank/);
});
