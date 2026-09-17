import test from 'node:test';
import assert from 'node:assert/strict';
import { passTakesPayment, passHoldsCash } from '../pass-shape.ts';

/*
  Two questions that were one switch.

  "Does the pass take money" and "does the kitchen have a drawer" were the same
  flag, so a kitchen that wanted to count its own float had to turn its pass
  into a till — and one that did not had its drawer counted on the TILL, by
  whoever was standing there, for money they had not touched all night.
*/

const flags = (...on: string[]) =>
  Object.fromEntries(on.map((k) => [k, { enabled: true }]));

test('a kitchen can hold cash without becoming a till', () => {
  // The whole point. This was impossible before.
  const f = flags('kitchen_cash');
  assert.equal(passHoldsCash(f), true);
  assert.equal(passTakesPayment(f), false, 'and it still settles nothing');
});

test('a pass that takes money necessarily holds some', () => {
  /*
    Combined mode alone must still give the screen its float. Otherwise
    switching the smaller flag off would take the drawer away from a pass that
    is ringing up sales into it.
  */
  const f = flags('combined_mode');
  assert.equal(passTakesPayment(f), true);
  assert.equal(passHoldsCash(f), true);
});

test('both on is both', () => {
  const f = flags('combined_mode', 'kitchen_cash');
  assert.equal(passTakesPayment(f), true);
  assert.equal(passHoldsCash(f), true);
});

test('neither on is a pass that only cooks', () => {
  assert.equal(passTakesPayment({}), false);
  assert.equal(passHoldsCash({}), false);
});

test('a flag that is present and off is off', () => {
  // A row exists for every flag, so "missing" and "switched off" are different
  // shapes and both have to read as no.
  const off = { kitchen_cash: { enabled: false }, combined_mode: { enabled: false } };
  assert.equal(passHoldsCash(off), false);
  assert.equal(passTakesPayment(off), false);
});

test('anything other than a true is not a yes', () => {
  // Appwrite hands config back as it finds it; a string "true" is not one.
  const odd = { kitchen_cash: {} } as Record<string, { enabled?: boolean }>;
  assert.equal(passHoldsCash(odd), false);
  assert.equal(passHoldsCash({ kitchen_cash: undefined }), false);
});
