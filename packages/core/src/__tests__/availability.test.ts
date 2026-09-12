import test from 'node:test';
import assert from 'node:assert/strict';
import { openNow } from '../availability.ts';

test('which sections are on is asked of the clock, not of when the menu loaded', () => {
  /*
    The counter screen is switched on and left. A menu read on Thursday evening
    carried "Thursday special is open" around as a fact and went on offering it
    all through Friday, because nothing asked the question a second time.
  */
  const sections = [
    { category: { name: 'Thursday special', availability: JSON.stringify({ thu: [['09:00', '22:00']] }) } },
    { category: { name: 'Friday special', availability: JSON.stringify({ fri: [['09:00', '22:00']] }) } },
    { category: { name: 'Everyday', availability: '' } },
  ];

  const thursday = openNow(sections, new Date('2026-09-10T19:00:00'));
  assert.deepEqual(thursday.map((s) => s.open), [true, false, true]);

  // The same list, the next evening. Nothing was re-read from the database.
  const friday = openNow(sections, new Date('2026-09-11T19:00:00'));
  assert.deepEqual(friday.map((s) => s.open), [false, true, true]);

  // A section with no rule is always on, which is most of any menu.
  assert.equal(openNow(sections, new Date('2026-09-13T04:00:00'))[2].open, true);
});
