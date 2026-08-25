import test from 'node:test';
import assert from 'node:assert/strict';
import { looksUnreachable, unreachableMessage } from '../unreachable.ts';

test('nothing coming back is told apart from a refusal', () => {
  /*
    A refusal arrives with a status and a reason and is worth repeating as-is.
    This is the other case: the request did not complete at all, and the
    browser reports the same thing for several unrelated causes.
  */
  assert.equal(looksUnreachable('Failed to fetch'), true);
  assert.equal(looksUnreachable('NetworkError when attempting to fetch resource'), true);
  assert.equal(looksUnreachable('Load failed'), true);
  assert.equal(looksUnreachable('fetch failed'), true);

  assert.equal(looksUnreachable('Invalid credentials'), false);
  assert.equal(looksUnreachable('Document with the requested ID could not be found'), false);
});

test('a till that has worked before is never sent to register its address', () => {
  /**
   * The failure this was written for. The flag was a variable reset by every
   * page load, on the reasoning that by the time anything fails a read has
   * already succeeded — true everywhere except the one screen where this
   * message matters most, the sign-in page, where nothing has been read yet.
   *
   * So a till selling for months, reloaded on a morning when the wifi was
   * down, was told its address had never worked and sent to the Appwrite
   * console to register a platform that had been registered since the day it
   * was set up. The real cause was in the same sentence, reading as an
   * afterthought.
   */
  const words = unreachableMessage('pos.niceoperation.com', true);
  // Not the words "needs registering" — the message says "nothing needs
  // registering" — but the INSTRUCTION to go and do it, and the place it
  // would send them.
  assert.doesNotMatch(words, /it needs registering/);
  assert.doesNotMatch(words, /Settings → Platforms/);
  assert.match(words, /nothing needs registering/);
  assert.match(words, /pos\.niceoperation\.com/);
});

test('the causes are named in the order somebody should work down them', () => {
  /**
   * The order IS the usefulness. A person at a dead till starts at the top,
   * and a tablet loses wifi far more often than a project gets suspended,
   * which happens far more often than Appwrite has an outage.
   */
  const words = unreachableMessage('pos.niceoperation.com', true);
  const online = words.indexOf('online');
  const limits = words.indexOf('plan');
  const outage = words.indexOf('Appwrite itself');
  assert.ok(online > 0 && online < limits, 'is the device online comes first');
  assert.ok(limits < outage, 'then the project, then Appwrite itself');
});

test('an address that has never answered is told the likeliest thing first', () => {
  // On the day somebody sets a new one up, the address not being registered is
  // the commonest cause by a long way, and it is the one nobody thinks of.
  const words = unreachableMessage('pos.niceoperation.com', false);
  assert.match(words, /needs registering/);
  assert.match(words, /Settings → Platforms/);
  // And the other causes are still named, because "never worked" is a guess
  // that is wrong on the first reload of a working till.
  assert.match(words, /plan limits/);
  assert.match(words, /online/);
});

test('the message reads as a sentence with no hostname to put in it', () => {
  // Rendered somewhere without a browser, or with the accessor blocked. A
  // message with an empty gap in it reads as something broken.
  for (const ever of [true, false]) {
    const words = unreachableMessage('', ever);
    assert.doesNotMatch(words, /\s\.|""/, 'no empty gap where a name should be');
    assert.match(words, /this address/);
  }
});

test('it always says nothing was lost', () => {
  /*
    The question somebody actually has at a dead till is whether the sale they
    were halfway through has gone. A message about platform registration that
    does not answer it leaves them retyping a bill to be safe.
  */
  assert.match(unreachableMessage('pos.niceoperation.com', true), /safe to try again/);
});
