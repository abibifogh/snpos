import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSale, rateFor, flatFor } from '../consignment-math.ts';
import { computeTotals } from '../pricing.ts';
import { estimateMinutes, queueMinutes, waitIncludingOpening } from '../orders-time.ts';
import { minutesUntilOpen, parseWindows } from '../availability.ts';
import * as guard from '../../../../functions/order-guard/src/money.js';
import type { CartLine } from '../pricing.ts';

/**
 * The browser and the server each do this arithmetic, because a Vite bundle and
 * an Appwrite function cannot share a module. Two copies drift. This is the
 * only thing standing between that drift and somebody being paid the wrong
 * amount for a year, so it runs both against the same inputs and fails the
 * build the moment they disagree.
 */

const line = (unit: number, qty = 1, prep?: number): CartLine => ({
  key: `k${unit}`, menu_item_id: `m${unit}`, name: 'x',
  unit_price: unit, qty, addons: [], ...(prep === undefined ? {} : { prep_minutes: prep }),
});

test('the commission split agrees, everywhere', () => {
  for (let gross = 0; gross <= 20000; gross += 13) {
    for (const bp of [0, 1, 500, 2500, 3000, 3333, 4999, 7500, 10000]) {
      assert.deepEqual(
        splitSale(gross, bp),
        guard.splitSale(gross, bp),
        `core and order-guard disagree on ${gross} at ${bp}bp`,
      );
    }
  }
});

test('a flat commission splits the same on both sides', () => {
  for (let gross = 0; gross <= 20000; gross += 97) {
    for (const flat of [1, 50, 200, 1500, 9000]) {
      for (const qty of [1, 2, 7]) {
        assert.deepEqual(
          splitSale(gross, 3000, flat, qty),
          guard.splitSale(gross, 3000, flat, qty),
          `core and order-guard disagree on ${gross} at a flat ${flat} x${qty}`,
        );
      }
    }
  }
});

test('which flat amount applies agrees', () => {
  const cases: [unknown, unknown][] = [
    [{ commission_flat: 150 }, { commission_flat: 300 }],
    [{}, { commission_flat: 300 }],
    [{ commission_flat: 0 }, { commission_flat: 300 }],
    [{ commission_flat: undefined }, null],
    [{}, {}],
    [null, null],
  ];
  for (const [item, consignor] of cases) {
    assert.equal(
      flatFor(item as never, consignor as never),
      guard.flatFor(item, consignor),
      `core and order-guard disagree on ${JSON.stringify({ item, consignor })}`,
    );
  }
});

test('the rate chosen agrees, including the awkward cases', () => {
  const cases: [unknown, unknown, unknown][] = [
    [{ commission_bp: 1000 }, { commission_bp: 2000 }, { default_commission_bp: 3000 }],
    [{}, { commission_bp: 2000 }, { default_commission_bp: 3000 }],
    [{}, {}, { default_commission_bp: 3000 }],
    [{}, {}, {}],
    [{ commission_bp: 0 }, { commission_bp: 2000 }, {}],
    [{ commission_bp: undefined }, null, null],
  ];
  for (const [item, consignor, settings] of cases) {
    assert.equal(
      rateFor(item as never, consignor as never, settings as never),
      guard.rateFor(item, consignor, settings),
      `core and order-guard disagree on ${JSON.stringify({ item, consignor, settings })}`,
    );
  }
});

test('order totals agree, inclusive and exclusive, with and without a discount', () => {
  const shapes = [
    { tax_rate_bp: 0, tax_inclusive: false, service_charge_bp: 0 },
    { tax_rate_bp: 1500, tax_inclusive: false, service_charge_bp: 0 },
    { tax_rate_bp: 1500, tax_inclusive: true, service_charge_bp: 0 },
    { tax_rate_bp: 1250, tax_inclusive: false, service_charge_bp: 1000 },
    { tax_rate_bp: 1250, tax_inclusive: true, service_charge_bp: 1000 },
  ];
  for (const settings of shapes) {
    for (const subtotal of [0, 1, 99, 100, 333, 1000, 12345]) {
      for (const discount of [0, 1, 50, subtotal]) {
        const mine = computeTotals({
          lines: [line(subtotal)],
          discount,
          settings: settings as never,
        });
        const theirs = guard.totalsFor(subtotal, Math.min(discount, subtotal), settings);
        assert.equal(mine.total, theirs.total, `total differs: ${JSON.stringify({ settings, subtotal, discount })}`);
        assert.equal(mine.tax_total, theirs.tax, 'tax differs');
        assert.equal(mine.service_total, theirs.service, 'service differs');
      }
    }
  }
});

test('the queue and the quoted wait agree', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const pending = [
    { status: 'PENDING', prep_minutes: 15, $createdAt: '2026-06-01T11:00:00.000Z' },
    { status: 'ACCEPTED', prep_minutes: 20, accepted_at: '2026-06-01T11:50:00.000Z', $createdAt: '2026-06-01T11:40:00.000Z' },
    { status: 'READY', prep_minutes: 30, accepted_at: '2026-06-01T11:00:00.000Z', $createdAt: '2026-06-01T10:00:00.000Z' },
    { status: 'PREPARING', eta_minutes: 25, accepted_at: '2026-06-01T11:59:00.000Z', $createdAt: '2026-06-01T11:55:00.000Z' },
  ];
  const ahead = queueMinutes(pending, now);
  assert.equal(ahead, guard.queueMinutes(pending, now));

  for (const prep of [1, 5, 12, 40, 90]) {
    assert.equal(
      estimateMinutes([line(0, 1, prep)], ahead),
      guard.quotedWait(prep, ahead),
      `quoted wait differs at ${prep} minutes prep`,
    );
  }
});

test('neither side ever quotes past the cap', () => {
  assert.equal(estimateMinutes([line(0, 1, 500)], 900), 60);
  assert.equal(guard.quotedWait(500, 900), 60);
  assert.equal(guard.MAX_ETA_MINUTES, 60);
});

test('both sides agree on how long until the kitchen opens', () => {
  /**
   * The guard recomputes the quoted wait a moment after an order lands. If its
   * copy of this disagreed with the browser's, an order placed before opening
   * would be quoted eighty minutes at the door and silently rewritten to
   * twenty a second later — leaving the customer's screen, the kitchen ticket
   * and the promise all saying different things about the same order.
   */
  const hours = {
    mon: [['13:00', '22:00']], tue: [['13:00', '22:00']], wed: [['13:00', '22:00']],
    thu: [['13:00', '22:00']], fri: [['13:00', '22:00']], sat: [['13:00', '22:00']],
    sun: [['13:00', '22:00']],
  };
  const raw = JSON.stringify(hours);

  for (const [h, m] of [[12, 0], [9, 30], [13, 1], [21, 59], [22, 0], [23, 45]]) {
    const at = new Date(2026, 7, 12, h, m, 0, 0);
    assert.equal(
      minutesUntilOpen(parseWindows(raw), at),
      guard.minutesUntilOpen(guard.parseWindows(raw), at),
      `disagreed at ${h}:${m}`,
    );
    /*
      Compared as the two sides actually decide it, not as two functions with
      the same name. Core branches at the call site — estimateMinutes when the
      doors are open, waitIncludingOpening when they are shut — and the guard
      branches inside one function. Comparing only the like-named functions
      would agree on twenty minutes and quietly disagree on five hundred,
      which is the case where the cap is the whole question.
    */
    for (const cook of [20, 500]) {
      const doors = minutesUntilOpen(parseWindows(raw), at);
      const mine = doors > 0 ? waitIncludingOpening(cook, doors) : estimateMinutes([{ prep_minutes: cook }]);
      const theirs = guard.waitIncludingOpening(cook, 0, guard.parseWindows(raw), at);
      assert.equal(theirs.total, mine, `total disagreed at ${h}:${m} for ${cook} minutes of cooking`);
      assert.equal(theirs.doors, doors, `the door share disagreed at ${h}:${m}`);
    }
  }

  // No hours configured means open, on both sides, and never "closed for ever".
  assert.equal(minutesUntilOpen(parseWindows(undefined)), 0);
  assert.equal(guard.minutesUntilOpen(guard.parseWindows(undefined)), 0);
});

test('both sides refuse to charge door-waiting as stove time', () => {
  /**
   * The guard recomputes the queue from every live ticket. If its idea of what
   * a ticket ahead costs the stove disagreed with the browser's, the wait a
   * customer was quoted at the door would be rewritten a second later — and
   * the disagreement compounds, because each pre-order behind inherits it.
   */
  const cases = [
    { prep_minutes: 20, eta_minutes: 80, placed_while_closed: true },
    { eta_minutes: 80, placed_while_closed: true },
    { eta_minutes: 40 },
    { prep_minutes: 25, eta_minutes: 100 },
    {},
  ];
  for (const o of cases) {
    const pending = [{ ...o, status: 'PENDING', $createdAt: new Date().toISOString() }];
    assert.equal(
      queueMinutes(pending, Date.now()),
      guard.queueMinutes(pending, Date.now()),
      `disagreed on ${JSON.stringify(o)}`,
    );
  }
});
