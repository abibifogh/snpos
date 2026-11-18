import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chargeRow, waitingRow, deductionRows, deductionTotals, deductionPeople, deductionPeriod, deductionsCsv, deductionsHtml,
} from '../deductions-report.ts';

const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;
const when = (iso: string) => iso.slice(0, 10);
const lines = JSON.stringify([
  { name: 'Club lager 625ml', qty: -2, amount: -3000 }, { name: 'Gin 25cl', qty: -1, amount: -2600 }, { name: 'Malt', qty: 1, amount: 1000 },
]);
const charge = (over: Record<string, unknown> = {}) => ({
  $id: 'c1', person_id: 'p-regina', person_name: 'Regina Asante', item_name: 'Bar count: 2 Club lager 625ml, 1 Gin 25cl',
  qty: 1, unit_price: 4600, amount: 4600, charged_at: '2026-11-17T22:40:00.000Z', settled_total: 0, status: 'open',
  phase: 'close', lines, ...over,
});

test('each kind of charge reads as what it is', () => {
  const pending = chargeRow(charge({ decision: 'pending', answer: 'explain' }) as never, [], money, when)!;
  assert.equal(pending.kind, 'notfinal');
  assert.equal(pending.items, '2 Club lager 625ml, 1 Gin 25cl', 'the short lines, not the over');
  assert.match(pending.note, /Explained, waiting for a manager/);
  assert.equal(pending.taken, 0);

  const part = chargeRow(charge({ decision: 'part', decided_amount: 3000, decided_name: 'Ama Owusu', decided_note: 'One broke' }) as never, [], money, when)!;
  assert.equal(part.kind, 'final');
  assert.equal(part.taken, 3000);
  assert.match(part.note, /Deducted GH₵30\.00 of GH₵46\.00 by Ama Owusu, the rest waived: "One broke"/);

  assert.equal(chargeRow(charge({ decision: 'deduct' }) as never, [], money, when)!.taken, 4600);
  assert.equal(chargeRow(charge({ decision: 'deduct', decided_by: 'system', decided_name: 'No answer by the deadline' }) as never, [], money, when)!.note,
    'Deducted: no answer by the deadline.', 'the clock is not a person');
  assert.equal(chargeRow(charge({ decision: 'waived' }) as never, [], money, when)!.kind, 'off');
  assert.equal(chargeRow(charge({ decision: 'putback' }) as never, [], money, when)!.kind, 'notfinal');
  assert.equal(chargeRow(charge({ decision: 'putback', status: 'settled' }) as never, [], money, when)!.kind, 'off');
  assert.equal(chargeRow(charge({ direction: 'credit' }) as never, [], money, when), null, 'a credit is not a deduction');
});

test('a charge made by hand is deducted, less anything written off', () => {
  const manual = charge({ lines: null, item_name: 'Club · Large', qty: 6, amount: 18000, module: 'bar', settled_total: 6000 });
  const row = chargeRow(manual as never, [{ $id: 's1', charge_id: 'c1', kind: 'pay', amount: 6000, recorded_at: '' }], money, when)!;
  assert.equal(row.kind, 'final');
  assert.equal(row.items, '6 Club · Large');
  assert.equal(row.taken, 18000);
  assert.match(row.note, /taken from pay; GH₵120\.00 still owed/);
  const gone = chargeRow({ ...manual, settled_total: 18000 } as never, [{ $id: 's2', charge_id: 'c1', kind: 'written_off', amount: 18000, recorded_at: '' }], money, when)!;
  assert.equal(gone.kind, 'off');
});

test('a bar count nobody has approved is shown against whoever ran the shift, over set against short', () => {
  const row = waitingRow({
    personId: 'p-kojo', name: 'Kojo Mensah', at: '2026-11-14T22:00:00.000Z', phase: 'close',
    lines: [{ name: 'Star lager', variance: -4, price: 1500 }, { name: 'Malt', variance: 1, price: 1000 }],
  })!;
  assert.equal(row.kind, 'approval');
  assert.equal(row.amount, 5000);
  assert.match(row.note, /Kojo ran that shift/);
  assert.equal(waitingRow({ personId: '', name: 'x', at: '', phase: 'close', lines: [{ name: 'Malt', variance: 2, price: 1000 }] }), null, 'only over: nothing owed');
});

test('the period, the person and the kinds chosen decide what is in the report; totals stay apart', () => {
  const charges = [
    charge({ $id: 'a', decision: 'deduct' }),
    charge({ $id: 'b', decision: 'pending' }),
    charge({ $id: 'c', decision: 'waived' }),
    charge({ $id: 'd', decision: 'deduct', charged_at: '2026-10-30T22:00:00.000Z' }),
    charge({ $id: 'e', decision: 'deduct', person_id: 'p-chichi', person_name: 'Chichi Obi', amount: 1500 }),
  ];
  const waiting = [{ personId: 'p-kojo', name: 'Kojo Mensah', at: '2026-11-14T22:00:00.000Z', phase: 'close' as const, lines: [{ name: 'Star', variance: -4, price: 1500 }] }];
  const opts = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-30T23:59:59.999Z', notFinal: true, approval: true, off: false };
  const rows = deductionRows(charges as never, [], waiting, opts, money, when);
  assert.deepEqual(rows.map((r) => [r.name, r.kind]), [
    ['Chichi Obi', 'final'], ['Kojo Mensah', 'approval'], ['Regina Asante', 'final'], ['Regina Asante', 'notfinal'],
  ]);
  assert.deepEqual(deductionTotals(rows), { deducted: 6100, notFinal: 4600, approval: 6000, off: 0 });
  assert.equal(deductionPeople(rows).length, 3);
  const regina = deductionRows(charges as never, [], waiting, { ...opts, personId: 'p-regina', notFinal: false, approval: false }, money, when);
  assert.deepEqual(regina.map((r) => r.kind), ['final'], 'one person, deducted only');
});

test('quick periods are whole local days', () => {
  const now = new Date(2026, 10, 18, 15, 0); // Wednesday 18 Nov
  const d = (x: Date) => `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`;
  assert.deepEqual([d(deductionPeriod('week', now).from), d(deductionPeriod('week', now).to)], ['2026-11-16', '2026-11-18']);
  assert.deepEqual([d(deductionPeriod('lastweek', now).from), d(deductionPeriod('lastweek', now).to)], ['2026-11-9', '2026-11-15']);
  assert.deepEqual([d(deductionPeriod('month', now).from), d(deductionPeriod('lastmonth', now).to)], ['2026-11-1', '2026-10-31']);
});

test('the spreadsheet and the PDF carry the same lines, a page each', () => {
  const rows = deductionRows([charge({ decision: 'deduct' }), charge({ $id: 'e', decision: 'pending', person_id: 'p-c', person_name: 'Chichi Obi' })] as never, [], [],
    { from: '2026-11-01', to: '2026-11-30T23:59', notFinal: true, approval: true, off: false }, money, when);
  const csv = deductionsCsv(rows);
  assert.match(csv, /"Date","Person","What was short"/);
  assert.match(csv, /"2026-11-17","Regina Asante","2 Club lager 625ml, 1 Gin 25cl","Bar count, closing","Deducted","46\.00","46\.00"/);
  const html = deductionsHtml({ business: 'Abibifo', periodWords: '1 to 30 Nov', rows, include: { notFinal: true, approval: true, off: false }, money, day: when, madeAt: '2026-11-18T09:00:00Z', madeBy: 'Ama Owusu (manager)' });
  assert.equal((html.match(/<section>/g) ?? []).length, 2);
  assert.match(html, /section \+ section \{ page-break-before: always; \}/);
  assert.match(html, /by Ama Owusu \(manager\)/);
});
