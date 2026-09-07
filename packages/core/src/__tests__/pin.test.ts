import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pinChecksWork, pinUnavailableWords, hashPin, verifyPin, encodePin, pinProblem,
} from '../pin.ts';

test('a device that cannot check PINs says so instead of throwing into nothing', async () => {
  /**
   * The failure that is invisible in the worst way. `crypto.subtle` exists
   * only in a secure context — https, or localhost — so on a till opened over
   * plain http every PIN check throws before it compares anything. The throw
   * escaped into a promise nobody awaited, so the pad took the digits and did
   * NOTHING: no unlock, no "not recognised", no error at all.
   *
   * From the counter that is indistinguishable from a PIN that has stopped
   * working — and the same PIN works on any device that opens the same site
   * over https, which sends everybody looking at the person rather than the
   * page they are standing in front of.
   */
  const real = globalThis.crypto;
  try {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    assert.equal(pinChecksWork(), false);
    await assert.rejects(() => hashPin('1234', 'salt'), /PIN_CHECKS_UNAVAILABLE/);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
  }
  assert.equal(pinChecksWork(), true);
});

test('the words name the cause and the fix, and clear the person standing there', () => {
  /*
    "Something went wrong" sends somebody to reset a PIN that was never the
    problem, which is the first thing anybody tries and does not work either.
  */
  const words = pinUnavailableWords('pos.niceoperation.com');
  assert.match(words, /cannot check PINs/);
  assert.match(words, /insecure address/);
  assert.match(words, /https:\/\/pos\.niceoperation\.com/);
  assert.match(words, /Nothing is wrong with the PIN itself/);
  // And it still reads as a sentence with no host to name.
  assert.match(pinUnavailableWords(), /Open it on its https address and try again/);
});

test('a PIN of any allowed length round-trips', async () => {
  // Four to six digits, which is what the staff form accepts.
  for (const pin of ['1379', '13795', '137952']) {
    const stored = await encodePin(pin);
    assert.equal(await verifyPin(pin, stored), true, `should verify ${pin}`);
    assert.equal(await verifyPin('0000', stored), false);
  }
});

test('a stored value that is not a PIN is refused rather than crashed on', async () => {
  // A row with nothing in the field, or something hand-edited, must be a "no"
  // and not an exception that takes the whole check down with it.
  assert.equal(await verifyPin('1234', undefined), false);
  assert.equal(await verifyPin('1234', ''), false);
  assert.equal(await verifyPin('1234', 'no-dollar-sign'), false);
});

test('the PINs everybody picks first are refused', () => {
  assert.equal(pinProblem('1379'), null);
  assert.match(String(pinProblem('123')), /4 to 6 digits/);
  assert.match(String(pinProblem('1111')), /same digit/);
  assert.match(String(pinProblem('3456')), /consecutive/);
  assert.match(String(pinProblem('2580')), /too common/);
});
