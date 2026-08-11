import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSale, rateFor } from '../consignment-math.ts';
import { computeTotals } from '../pricing.ts';
import { estimateMinutes, queueMinutes } from '../orders-time.ts';
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
