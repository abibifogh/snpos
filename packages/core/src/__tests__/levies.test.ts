import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GHANA_LEVIES, LEVY_ACCOUNTS, OTHER_LEVIES_ACCOUNT, parseLevies, serialiseLevies,
  taxBreakdown, splitTax, taxWords, levyAccount, vatBpOf, showsTaxParts,
} from '../pricing.ts';
import { ACCOUNTS } from '../accounts.ts';

const ghana = [...GHANA_LEVIES];

test('added on top, Ghana stacks VAT on the levies', () => {
  /*
    A 10,000 bill: NHIL 250, GETFund 250, tourism 100, then VAT at 15% on
    10,600, which is 1,590. Every part is its own line on its own return.
  */
  const t = taxBreakdown({ taxable: 10_000, vatBp: 1500, inclusive: false, levies: ghana });
  assert.deepEqual(t.parts.map((p) => [p.key, p.amount, p.account_code]), [
    ['nhil', 250, '2110'], ['getfund', 250, '2120'], ['tourism', 100, '2130'], ['vat', 1590, '2100'],
  ]);
  assert.equal(t.total, 2_190);
});

test('included in the price, the same stack worked backwards, and the parts add up', () => {
  const t = taxBreakdown({ taxable: 12_190, vatBp: 1500, inclusive: true, levies: ghana });
  assert.equal(t.total, 2_190);
  assert.equal(t.parts.reduce((s, p) => s + p.amount, 0), t.total);
  assert.deepEqual(t.parts.map((p) => p.amount), [250, 250, 100, 1590]);
});

test('with no levies it is exactly the single rate the system always had', () => {
  // The old formulas, so nothing already priced changes by a pesewa.
  for (let taxable = 0; taxable <= 5000; taxable += 37) {
    for (const rate of [0, 125, 1500, 1750]) {
      const oldExclusive = Math.round((taxable * rate) / 10000);
      const oldInclusive = Math.round(taxable - (taxable * 10000) / (10000 + rate));
      assert.equal(taxBreakdown({ taxable, vatBp: rate, inclusive: false, levies: [] }).total, oldExclusive);
      assert.equal(taxBreakdown({ taxable, vatBp: rate, inclusive: true, levies: [] }).total, oldInclusive);
    }
  }
});

test('a stored tax total comes apart into the same parts it was built from', () => {
  for (let taxable = 100; taxable <= 30_000; taxable += 1_313) {
    const built = taxBreakdown({ taxable, vatBp: 1500, inclusive: false, levies: ghana });
    const split = splitTax(built.total, { vatBp: 1500, levies: ghana });
    assert.equal(split.reduce((s, p) => s + p.amount, 0), built.total);
    // The parts agree to a pesewa or two of rounding, never more.
    for (const p of built.parts) {
      const again = split.find((q) => q.key === p.key)?.amount ?? 0;
      assert.ok(Math.abs(again - p.amount) <= 2, `${p.key}: ${p.amount} vs ${again}`);
    }
  }
  assert.deepEqual(splitTax(0, { vatBp: 1500, levies: ghana }), []);
  assert.deepEqual(splitTax(1500, { vatBp: 1500, levies: [] }).map((p) => [p.key, p.amount]), [['vat', 1500]]);
});

test('settings keep the list as text, and unreadable text is no levies', () => {
  const text = serialiseLevies([...ghana, { key: 'covid', name: 'COVID levy', rate_bp: 0 }, { key: ' ', name: '', rate_bp: 100 }]);
  assert.deepEqual(parseLevies(text), ghana);
  assert.deepEqual(parseLevies(''), []);
  assert.deepEqual(parseLevies('not json'), []);
  assert.deepEqual(parseLevies('{"key":"x"}'), []);
});

test('each levy has its own account; a levy the chart does not know goes to other levies, never to VAT', () => {
  assert.equal(levyAccount('nhil'), '2110');
  assert.equal(levyAccount('local_council'), OTHER_LEVIES_ACCOUNT);
  assert.notEqual(levyAccount('local_council'), LEVY_ACCOUNTS.vat);
});

test('the copy of the account codes matches the chart', () => {
  assert.deepEqual(
    [LEVY_ACCOUNTS.vat, LEVY_ACCOUNTS.nhil, LEVY_ACCOUNTS.getfund, LEVY_ACCOUNTS.tourism, OTHER_LEVIES_ACCOUNT],
    [ACCOUNTS.taxPayable, ACCOUNTS.nhilPayable, ACCOUNTS.getfundPayable, ACCOUNTS.tourismPayable, ACCOUNTS.otherLeviesPayable],
  );
});

test('the word on the receipt', () => {
  assert.equal(taxWords(ghana), 'VAT and levies');
  assert.equal(taxWords([], 'GHS'), 'VAT');
  assert.equal(taxWords([], 'USD'), 'Tax');
});

test('a business that does not charge VAT is not told it does', () => {
  // The whole point: a receipt that says VAT where none was charged is a
  // document a customer could take to the revenue authority.
  assert.equal(taxWords(ghana, 'GHS', false), 'Levies');
  assert.equal(taxWords([ghana[0]], 'GHS', false), 'NHIL');
  assert.equal(taxWords(ghana, 'GHS', true), 'VAT and levies');
});

test('the VAT switch decides the rate, and the rate is kept while it is off', () => {
  assert.equal(vatBpOf({ tax_rate_bp: 1500 }), 1500);
  assert.equal(vatBpOf({ tax_rate_bp: 1500, vat_charged: true }), 1500);
  assert.equal(vatBpOf({ tax_rate_bp: 1500, vat_charged: false }), 0);
  // An old settings row has no such field, and charges VAT as it always did.
  assert.equal(vatBpOf({ tax_rate_bp: 1250, vat_charged: undefined }), 1250);
  assert.equal(vatBpOf({}), 0);
});

test('switching VAT off leaves the levies charging', () => {
  const off = taxBreakdown({ taxable: 10000, vatBp: vatBpOf({ tax_rate_bp: 1500, vat_charged: false }), inclusive: false, levies: ghana });
  // NHIL 2.5 + GETFund 2.5 + tourism 1 = 6% of 100.00, and no VAT part.
  assert.equal(off.total, 600);
  assert.equal(off.parts.some((p) => p.key === 'vat'), false);
  assert.deepEqual(off.parts.map((p) => p.key), ['nhil', 'getfund', 'tourism']);
});

test('the receipt lists each charge unless the business asked for one line', () => {
  const parts = splitTax(2100, { vatBp: 1500, levies: ghana });
  assert.equal(parts.length, 4);
  assert.equal(showsTaxParts(parts, 'separate'), true);
  assert.equal(showsTaxParts(parts, undefined), true);
  assert.equal(showsTaxParts(parts, 'combined'), false);
  // One charge is one line whichever way it is set.
  assert.equal(showsTaxParts(splitTax(1500, { vatBp: 1500, levies: [] }), 'separate'), false);
});
