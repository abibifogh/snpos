import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, reachWords, reachLabel, isOursToFix } from '../reachability.ts';

test('no network at all is the tablet, and nothing else', () => {
  /**
   * The one answer that saves the most time, because it is the commonest and
   * the cheapest to act on. Everything else on the list — a paused project,
   * an outage — is somebody looking in the wrong place while a tablet sits off
   * the wifi.
   */
  assert.equal(diagnose({ online: false, answered: null }), 'device-offline');
  // Even if a probe somehow answered. The browser saying it has no network at
  // all is the strongest signal available and it is not overruled by a request
  // that may have been served from a cache.
  assert.equal(diagnose({ online: false, answered: true }), 'device-offline');
});

test('a network with nothing answering is between here and Appwrite', () => {
  assert.equal(diagnose({ online: true, answered: false }), 'no-server');
  assert.match(reachWords('no-server'), /hotspot/);
});

test('a server that answers clears the shop of blame entirely', () => {
  /**
   * The answer worth separating hardest. It is the only one where nothing
   * about the shop's equipment or its line is wrong, so every minute spent
   * restarting a router is a minute wasted — and it is the one nobody guesses,
   * because a screen saying "could not connect" reads like a connection fault.
   */
  const reach = diagnose({ online: true, answered: true });
  assert.equal(reach, 'server-answers');

  const words = reachWords(reach, 'cloud.appwrite.io');
  assert.match(words, /connection is fine/);
  assert.match(words, /paused/);
  assert.match(words, /plan limits/);
  assert.match(words, /cloud\.appwrite\.io/);
  assert.equal(isOursToFix(reach), false, 'nothing here for the shop to fix');
});

test('a check that could not be made says so rather than guessing', () => {
  /*
    A probe that never ran is not evidence of anything. Reporting it as an
    outage would send somebody to the Appwrite console over a network that
    dropped for two seconds.
  */
  assert.equal(diagnose({ online: true, answered: null }), 'unknown');
  assert.match(reachWords('unknown'), /Try it again/);
});

test('the browser saying it is online is not taken as proof', () => {
  /**
   * Browsers report true for any network at all — a wifi with no route out, a
   * guest network waiting to be signed into. So a true here only means "worth
   * asking further", which is exactly what the probe then does.
   */
  assert.notEqual(diagnose({ online: true, answered: false }), 'server-answers');
});

test('each answer says whose problem it is', () => {
  assert.equal(isOursToFix('device-offline'), true);
  assert.equal(isOursToFix('no-server'), true);
  assert.equal(isOursToFix('server-answers'), false);
  // Unknown is nobody's yet, and must not accuse either side.
  assert.equal(isOursToFix('unknown'), false);
});

test('every answer has a short label and none of them repeat', () => {
  const all = ['device-offline', 'no-server', 'server-answers', 'unknown'] as const;
  for (const r of all) assert.ok(reachLabel(r).length > 0, `${r} has no label`);
  assert.equal(new Set(all.map(reachLabel)).size, all.length);
});
