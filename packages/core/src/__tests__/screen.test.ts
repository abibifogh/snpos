import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isScreenMode, secondsLeft, returningLine, SCREEN_RETURN_SECONDS,
} from '../screen.ts';

test('a screen says so in the address', () => {
  assert.equal(isScreenMode('?screen=1'), true);
  assert.equal(isScreenMode('?v=abc&screen=1'), true);
  assert.equal(isScreenMode('?screen=true'), true);
});

test('anything else is somebody’s own phone', () => {
  // The safe answer. Being wrong this way costs a tap; being wrong the other
  // way snatches the status from somebody watching their own food.
  assert.equal(isScreenMode(''), false);
  assert.equal(isScreenMode('?v=abc'), false);
  assert.equal(isScreenMode('?screen=0'), false);
  assert.equal(isScreenMode('?screen='), false);
});

test('the countdown is measured from a fixed start, not ticked down', () => {
  // A tab throttled in the background otherwise sits on "3 seconds" for a
  // minute and a half.
  const started = 1_000_000;
  assert.equal(secondsLeft(started, started), 20);
  assert.equal(secondsLeft(started, started + 5_000), 15);
  assert.equal(secondsLeft(started, started + 19_500), 1);
});

test('it never counts past zero', () => {
  const started = 1_000_000;
  assert.equal(secondsLeft(started, started + 20_000), 0);
  assert.equal(secondsLeft(started, started + 999_000), 0);
});

test('the wait is long enough to read an order number and no longer', () => {
  assert.equal(SCREEN_RETURN_SECONDS, 20);
});

test('the screen says what it is about to do', () => {
  // Changing on its own with no warning reads as a fault, and the customer
  // still reading their order number has no idea what happened to it.
  assert.equal(returningLine(20), 'Returning to the menu in 20 seconds. Touch the screen to stay.');
  assert.equal(returningLine(1), 'Returning to the menu in 1 second. Touch the screen to stay.');
  assert.equal(returningLine(0), 'Returning to the menu…');
});
