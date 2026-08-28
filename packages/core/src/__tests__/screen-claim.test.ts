import test from 'node:test';
import assert from 'node:assert/strict';
import { screenClaim } from '../idle.ts';

const none = { tokenMatched: false, declared: false, turnedOff: false };

test('the home-screen icon is enough to be a screen', () => {
  /**
   * The whole point. Adding the screen link to the home screen throws the
   * token away — every browser starts an installed app at the manifest's
   * address — so the icon on the counter was opening the ordinary walk-in
   * menu: no invitation, no staying awake, and a growing list of strangers'
   * orders on a tablet that belongs to nobody.
   */
  const v = screenClaim({ ...none, declared: true });
  assert.equal(v.screen, true);
});

test('but only a token may say which counter it is', () => {
  /*
    A declaration says THAT this is a screen and never which one. Letting it
    write a venue down would let a home-screen launch — which carries no token
    at all — overwrite the answer the setup link gave, and a two-branch
    business would find its counter screen serving the other branch's menu.
  */
  assert.equal(screenClaim({ ...none, declared: true }).rememberVenue, false);
  assert.equal(screenClaim({ ...none, tokenMatched: true }).rememberVenue, true);
});

test('an address with nothing to say leaves the device as it was', () => {
  /**
   * The commonest address of all, and the reason this is remembered rather
   * than read every time. A bookmark saved without its query string, a browser
   * restoring a tab, somebody tapping the venue's own link to check something
   * — any of those would otherwise quietly turn the counter display back into
   * a phone menu, and none of them announces itself.
   */
  assert.equal(screenClaim(none).screen, null);
  assert.equal(screenClaim(none).rememberVenue, false);
});

test('turning it off wins over everything claiming it on', () => {
  // A way out that can be outvoted is not a way out. This is the only route
  // back for a tablet that has been told it is a screen.
  assert.equal(screenClaim({ tokenMatched: true, declared: true, turnedOff: true }).screen, false);
  assert.equal(screenClaim({ tokenMatched: true, declared: true, turnedOff: true }).rememberVenue, false);
});
