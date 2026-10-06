import test from 'node:test';
import assert from 'node:assert/strict';
import { owingStatement, statementPeople, owingStatementHtml, balanceWords } from '../owing-statement.ts';
import { owingByPerson, type StaffCharge, type StaffSettlement } from '../staff-charges.ts';

const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;
const charge = (over: Partial<StaffCharge>): StaffCharge => ({
  $id: 'c', person_id: 'regina', person_name: 'Regina', item_name: 'Club · Large', qty: 1, unit_price: 3_000, amount: 3_000,
  charged_at: '2026-09-10T10:00:00.000Z', settled_total: 0, status: 'open', ...over,
});
const settle = (over: Partial<StaffSettlement>): StaffSettlement => ({
  $id: 's', charge_id: 'c', kind: 'cash', amount: 0, recorded_at: '2026-09-20T10:00:00.000Z', ...over,
});

// August: six Club short. September: GH₵50 paid, a gin surplus credited and
// set against the rest, two Malt short. October: Malt taken from pay.
const charges = [
  charge({ $id: 'aug', qty: 6, amount: 18_000, charged_at: '2026-08-28T18:00:00.000Z', settled_total: 18_000, status: 'settled' }),
  charge({ $id: 'gin', item_name: 'Gin', direction: 'credit', qty: 1, unit_price: 2_000, amount: 2_000, charged_at: '2026-09-12T18:00:00.000Z', settled_total: 2_000, status: 'settled' }),
  charge({ $id: 'malt', item_name: 'Malt', qty: 2, unit_price: 1_000, amount: 2_000, charged_at: '2026-09-25T18:00:00.000Z', settled_total: 2_000, status: 'settled' }),
  charge({ $id: 'kofi', person_id: 'kofi', person_name: 'Kofi', item_name: 'Water', amount: 500, unit_price: 500, charged_at: '2026-07-01T10:00:00.000Z' }),
];
const settlements = [
  settle({ $id: 's1', charge_id: 'aug', kind: 'cash', amount: 5_000, recorded_at: '2026-09-05T10:00:00.000Z' }),
  settle({ $id: 's2', charge_id: 'aug', kind: 'credit', credit_id: 'gin', amount: 2_000, recorded_at: '2026-09-12T18:00:01.000Z' }),
  settle({ $id: 's3', charge_id: 'aug', kind: 'written_off', amount: 11_000, note: 'Breakage', recorded_at: '2026-09-15T10:00:00.000Z' }),
  settle({ $id: 's4', charge_id: 'malt', kind: 'pay', amount: 2_000, recorded_at: '2026-10-01T10:00:00.000Z' }),
];
const september = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T23:59:59.999Z' };

test('a statement opens on what was owed, runs line by line, and closes on what is owed', () => {
  const s = owingStatement({ personId: 'regina', charges, settlements, money, ...september });
  assert.equal(s.name, 'Regina');
  assert.equal(s.opening, 18_000);
  // The credit's matching against the Club is not a line of its own.
  assert.deepEqual(s.lines.map((l) => [l.kind, l.owed, l.off, l.balance]), [
    ['cash', 0, 5_000, 13_000],
    ['credited', 0, 2_000, 11_000],
    ['written_off', 0, 11_000, 0],
    ['charged', 2_000, 0, 2_000],
  ]);
  assert.equal(s.closing, 2_000);
  assert.equal(s.charged, 2_000);
  assert.equal(s.credited, 2_000);
  assert.deepEqual(s.putRight, { cash: 5_000, pay: 0, found: 0, written_off: 11_000 });
  assert.match(s.lines[2]!.detail, /Breakage/);
  assert.match(s.lines[3]!.detail, /Malt × 2 short at GH₵10.00 \(selling price\)/);
});

test('over all time the statement agrees with Staff owing', () => {
  const all = owingStatement({ personId: 'regina', charges, settlements, money, from: '2000-01-01', to: '2100-01-01' });
  assert.equal(all.opening, 0);
  assert.equal(all.closing, owingByPerson(charges).find((p) => p.personId === 'regina')!.left);
  // Credit not yet used shows below nothing, as Staff owing's credit waiting.
  const spare = owingStatement({
    personId: 'regina', charges: [charge({ $id: 'x', direction: 'credit', amount: 700 })], settlements: [], money, from: '2000-01-01', to: '2100-01-01',
  });
  assert.equal(spare.closing, -700);
  assert.equal(balanceWords(spare.closing, money), 'GH₵7.00 credit');
});

test('everyone with something in the period, or owing going into it, gets a statement', () => {
  const people = statementPeople(charges, settlements, september.from, september.to, money);
  // Kofi did nothing in September but still owed going in.
  assert.deepEqual(people.map((p) => [p.name, p.opening, p.closing]), [['Kofi', 500, 500], ['Regina', 18_000, 2_000]]);
  const october = statementPeople(charges, settlements, '2026-10-02T00:00:00.000Z', '2026-10-31T23:59:59.999Z', money);
  // Regina owed nothing going in and nothing happened: left out.
  assert.deepEqual(october.map((p) => p.name), ['Kofi']);
});

test('the document carries each person, the period and the balances', () => {
  const html = owingStatementHtml({
    business: 'Abibifo <Bistro>', statements: statementPeople(charges, settlements, september.from, september.to, money),
    periodWords: '1 Sep 2026 to 30 Sep 2026', money, when: (iso) => iso.slice(0, 10), madeAt: '2026-10-06T09:00:00.000Z', madeBy: 'Ama',
  });
  assert.match(html, /Abibifo &lt;Bistro&gt;/);
  assert.match(html, /Regina/);
  assert.match(html, /Kofi/);
  assert.match(html, /GH₵180.00 owed/);
  assert.match(html, /At the end<strong>GH₵20.00 owed/);
  assert.match(html, /Written off GH₵110.00/);
  assert.match(html, /by Ama/);
  assert.match(owingStatementHtml({ business: '', statements: [], periodWords: '', money, when: (i) => i, madeAt: '' }), /Nobody owed anything/);
});
