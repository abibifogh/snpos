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
  assert.match(words, /nothing to register/);
  assert.match(words, /pos\.niceoperation\.com/);
});

test('the connection is named before the service, wherever both are possible', () => {
  /**
   * The order IS the usefulness. A person at a dead till starts at the top,
   * and a tablet's own connection fails far more often than the service does —
   * so a message that leads with an outage sends somebody to check the one
   * thing they cannot do anything about.
   *
   * Where the browser knows there is no network the question does not arise at
   * all: that branch names one cause and stops. This is the other branch, the
   * one where the device believes it is online and may well be wrong.
   */
  const words = unreachableMessage('pos.niceoperation.com', true, true);
  const connection = words.indexOf('connection is not');
  const service = words.indexOf('service itself');
  assert.ok(connection > 0, 'the connection is questioned at all');
  assert.ok(connection < service, 'and before the service is blamed');
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

test('it always answers "has my sale gone?"', () => {
  /*
    The question somebody actually has at a dead till. A message about platform
    registration that does not answer it leaves them retyping a bill to be
    safe — and now that writes really are queued and replayed, the answer is
    better than it was: the sale is kept and sends itself.
  */
  assert.match(unreachableMessage('pos.niceoperation.com', true, true), /kept here and sends itself/);

  /*
    Not on the offline branch, and on purpose: that message is one sentence at
    the owner's asking. The till says the same thing more usefully anyway — the
    strip across the top counts what is waiting to send, which is a live number
    rather than a promise in an error box.
  */
  assert.equal(unreachableMessage('pos.niceoperation.com', true, false), 'The internet is down on this device.');
});

test('a device with no network is told that, and nothing else', () => {
  /**
   * The commonest cause by a long way, and the one that used to be third on a
   * list of three. Somebody stood at a working till read about Appwrite plan
   * limits and outages while the router was rebooting downstairs.
   *
   * The browser knows this for free, at the moment the failure is caught, so
   * the whole message is now the answer — one sentence, at the owner's asking.
   * Anything after it is either obvious to whoever is standing there or is
   * about something that cannot be the cause.
   */
  const words = unreachableMessage('pos.niceoperation.com', true, false);
  assert.equal(words, 'The internet is down on this device.');
});

test('nothing that cannot possibly be wrong is mentioned to an offline device', () => {
  /*
    Every extra name here is one more thing for somebody to go and check for no
    reason. A tablet off the wifi has nothing to do with an address, a project
    or a plan.
  */
  const words = unreachableMessage('pos.niceoperation.com', true, false);
  for (const wrong of [/Appwrite/, /paused/, /plan limits/, /register/i, /pos\.niceoperation/]) {
    assert.doesNotMatch(words, wrong);
  }
});

test('a browser claiming to be online is not taken as proof', () => {
  /**
   * Browsers report true for any network at all — a wifi with no route out, a
   * guest network waiting to be signed into. So a true only narrows things
   * down, and the message must not announce a service outage on the strength
   * of it.
   */
  const words = unreachableMessage('pos.niceoperation.com', true, true);
  assert.match(words, /thinks it is online/);
  assert.match(words, /wifi with no internet behind it/);
  // Still says the address is fine, which is the one thing genuinely known.
  assert.match(words, /nothing to register/);
});

test('with nothing known about the network, the old ordering stands', () => {
  // Not in a browser, or a browser that will not say. Guessing would be worse
  // than naming the possibilities in the order they actually go wrong.
  const words = unreachableMessage('pos.niceoperation.com', true, undefined);
  assert.match(words, /Cannot reach the system/);
});

test('an address that has never worked still leads with registering it', () => {
  // Unchanged, and deliberately: on a new setup the address not being
  // registered is the likeliest cause by a long way, and being offline does
  // not stop that from also being true.
  const words = unreachableMessage('pos.niceoperation.com', false);
  assert.match(words, /Settings → Platforms/);
});
