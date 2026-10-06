import test from 'node:test';
import assert from 'node:assert/strict';
import { countDifferencesHtml, differenceTotals } from '../count-report.ts';

const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;

test('the document lists each count with who counted it and every line at selling price', () => {
  const html = countDifferencesHtml({
    business: 'Abibifo Bistro & Craft',
    counts: [{
      title: 'Bar count, counted in on BAR20260925-8ds8',
      countedBy: 'Regina',
      at: '2026-09-25T18:24:00.000Z',
      lines: [
        { name: 'Club · Large', expected: 70, counted: 64, delta: -6, unitPrice: 3_000, worth: -18_000, valuedAt: 'selling' },
        { name: 'Sobolo <sorrel>', expected: 6, counted: 20, delta: 14, unitPrice: 500, worth: 7_000, valuedAt: 'selling' },
        { name: 'Sugar', expected: 5, counted: 3, delta: -2, unitPrice: 1_200, worth: -2_400, valuedAt: 'cost' },
      ],
    }],
    money,
    madeAt: '2026-10-05T09:00:00.000Z',
    madeBy: 'Owner',
    when: (iso) => iso.slice(0, 10),
  });
  assert.match(html, /Counted by <strong>Regina<\/strong>/);
  assert.match(html, /Club · Large/);
  assert.match(html, /Sobolo &lt;sorrel&gt;/, 'names are escaped');
  assert.match(html, /−GH₵180\.00/);
  assert.match(html, /\+GH₵70\.00/);
  assert.match(html, /Short<strong>GH₵204\.00<\/strong>/);
  assert.match(html, /valued at what one sells for/);
  assert.match(html, /\* Nothing on the menu sells this/);
  assert.match(html, /Made 2026-10-05 by Owner/);
});

test('short and over are added up apart, and netted', () => {
  assert.deepEqual(differenceTotals([{ worth: -18_000 }, { worth: 7_000 }, { worth: -2_400 }]), { short: 20_400, over: 7_000, net: -13_400 });
  assert.deepEqual(differenceTotals([]), { short: 0, over: 0, net: 0 });
});
