import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUSY_DEFAULTS, busyFromQueue, busyLevel, overrideLive, overrideEnds,
  holdsOrders, extraMinutes, guestWords, staffWords, LEVEL_WORDS, levelTone, worseThan,
} from '../busy.ts';
import type { BusyConfig } from '../busy.ts';

const cfg: BusyConfig = { ...BUSY_DEFAULTS };
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

test('the ticket count trips the two levels, and only at the lines set', () => {
  assert.equal(busyFromQueue(0, cfg), 'normal');
  assert.equal(busyFromQueue(11, cfg), 'normal');
  assert.equal(busyFromQueue(12, cfg), 'busy');
  assert.equal(busyFromQueue(19, cfg), 'busy');
  assert.equal(busyFromQueue(20, cfg), 'paused');
  assert.equal(busyFromQueue(400, cfg), 'paused');
});

test('with auto-trip off the count never decides anything', () => {
  const manual = { ...cfg, autoTrip: false };
  assert.equal(busyFromQueue(999, manual), 'normal');
  // A level set by hand still stands: switching auto off is asking to decide
  // it yourself, not asking for the kitchen never to be busy.
  assert.equal(busyLevel({ waiting: 999, cfg: manual, override: { level: 'paused', at: at(1) } }), 'paused');
});

test('a hand beats the count, in both directions', () => {
  // Fourteen tickets up and a cook who says they are fourteen salads.
  assert.equal(busyLevel({ waiting: 14, cfg, override: { level: 'normal', at: at(1) } }), 'normal');
  // An empty pass and a fryer that has just died.
  assert.equal(busyLevel({ waiting: 0, cfg, override: { level: 'paused', at: at(1) } }), 'paused');
});

test('a level set by hand lapses, so nobody leaves ordering switched off overnight', () => {
  const fresh = { level: 'paused' as const, at: at(10) };
  const stale = { level: 'paused' as const, at: at(120) };
  assert.equal(overrideLive(fresh, cfg), true);
  assert.equal(overrideLive(stale, cfg), false);
  // Lapsed, the count takes over again.
  assert.equal(busyLevel({ waiting: 0, cfg, override: stale }), 'normal');
  assert.equal(busyLevel({ waiting: 25, cfg, override: stale }), 'paused');
});

test('a business can ask for a hand-set level that never lapses', () => {
  const never = { ...cfg, overrideMinutes: 0 };
  assert.equal(overrideLive({ level: 'paused', at: at(10_000) }, never), true);
  assert.equal(overrideEnds({ level: 'paused', at: at(10) }, never), null);
});

test('nonsense in the override is ignored rather than believed', () => {
  assert.equal(overrideLive(null, cfg), false);
  assert.equal(overrideLive(undefined, cfg), false);
  assert.equal(overrideLive({ level: 'paused', at: 'not a date' }, cfg), false);
  assert.equal(overrideEnds({ level: 'busy', at: 'not a date' }, cfg), null);
});

test('holding orders is a separate choice from saying you are busy', () => {
  assert.equal(holdsOrders('paused', cfg), true);
  assert.equal(holdsOrders('busy', cfg), false);
  assert.equal(holdsOrders('normal', cfg), false);
  assert.equal(holdsOrders('paused', { ...cfg, holdWhenPaused: false }), false);
});

test('the quote grows once the kitchen is under it, and paused is not better than busy', () => {
  assert.equal(extraMinutes('normal', cfg), 0);
  assert.equal(extraMinutes('busy', cfg), 15);
  assert.equal(extraMinutes('paused', cfg), 15);
});

test('a customer is told nothing while the kitchen is coping', () => {
  assert.equal(guestWords('normal', cfg), '');
  assert.equal(guestWords('busy', cfg), cfg.guestMessage);
  assert.match(guestWords('paused', cfg), /order at the counter/);
  // Told it is busy, but still able to order, where the business chose that.
  assert.equal(guestWords('paused', { ...cfg, holdWhenPaused: false }), cfg.guestMessage);
});

test('the pass is told which of the two set the level', () => {
  assert.match(staffWords({ waiting: 3, cfg }), /3 tickets waiting/);
  assert.match(staffWords({ waiting: 1, cfg }), /1 ticket waiting/);
  assert.match(staffWords({ waiting: 14, cfg }), /12 is the line/);
  assert.match(staffWords({ waiting: 22, cfg }), /20 is the line/);
  // Set by hand says so, and says when it lapses.
  const words = staffWords({ waiting: 0, cfg, override: { level: 'paused', at: at(0) } });
  assert.match(words, /set by hand until \d\d:\d\d/);
  assert.match(words, new RegExp(LEVEL_WORDS.paused));
});

test('the levels have an order and a colour', () => {
  assert.equal(worseThan('paused', 'busy'), true);
  assert.equal(worseThan('busy', 'paused'), false);
  assert.equal(worseThan('busy', 'normal'), true);
  assert.equal(levelTone('normal'), 'ok');
  assert.equal(levelTone('busy'), 'warn');
  assert.equal(levelTone('paused'), 'danger');
});
