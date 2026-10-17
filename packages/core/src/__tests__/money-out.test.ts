import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moneyOutRows, spendFrom, inPeriod, outFilter, outFilters, outTotal, periodStart } from '../money-out.ts';

const spend = (o: Record<string, unknown>) => ({ $id: 's', $createdAt: '2026-10-12T10:40:00Z', amount: 1000, approval_status: 'approved', ...o });

test('each spend says where its money came from, old rows and new', () => {
  assert.equal(spendFrom(spend({ pay_later: true, source: 'own' })), 'owed');
  assert.equal(spendFrom(spend({ imprest_float_id: 'box' })), 'box');
  assert.equal(spendFrom(spend({ source: 'bank' })), 'bank');
  // Written before the source field: read from the method and the drawer flag.
  assert.equal(spendFrom(spend({}), 'mobile_money'), 'bank');
  assert.equal(spendFrom(spend({ from_takings: false })), 'own');
  assert.equal(spendFrom(spend({})), 'drawer');
});

test('spends and maker payouts are one list, newest first', () => {
  const rows = moneyOutRows(
    [spend({ $id: 'a', approval_status: 'pending', payee: 'Kasapreko' }), spend({ $id: 'b', $createdAt: '2026-10-11T09:15:00Z', imprest_float_id: 'k' })],
    [{ $id: 'p', consignor_id: 'ama', paid_at: '2026-10-13T08:00:00Z', amount: 840, method: 'bank' }],
    { makerName: (id) => (id === 'ama' ? 'Ama Weaves' : undefined) },
  );
  assert.deepEqual(rows.map((r) => [r.id, r.from, r.state, r.to]), [
    ['p', 'maker', 'paid', 'Ama Weaves'],
    ['a', 'drawer', 'waiting', 'Kasapreko'],
    ['b', 'box', 'approved', ''],
  ]);
  assert.deepEqual(outFilter(rows, 'waiting').map((r) => r.id), ['a']);
  assert.deepEqual(outFilters(rows).map((f) => f.label), ['All', 'From drawers', 'From petty cash', 'Maker payouts', 'Waiting to approve']);
});

test('the total leaves out what was refused or reversed', () => {
  const rows = moneyOutRows(
    [spend({ $id: 'a' }), spend({ $id: 'r', approval_status: 'rejected' })],
    [{ $id: 'p', consignor_id: 'x', paid_at: '2026-10-12T00:00:00Z', amount: 500, method: 'cash', status: 'reversed' }],
  );
  assert.equal(outTotal(rows), 1000);
});

test('a week starts on Monday, a month on the first', () => {
  const sat = new Date(2026, 9, 17, 15, 0);
  assert.equal(periodStart('week', sat)?.getDate(), 12);
  assert.equal(periodStart('month', sat)?.getDate(), 1);
  assert.equal(periodStart('all', sat), null);
  const rows = moneyOutRows([spend({ $id: 'old', $createdAt: new Date(2026, 9, 10).toISOString() }), spend({ $id: 'new', $createdAt: new Date(2026, 9, 13).toISOString() })], []);
  assert.deepEqual(inPeriod(rows, 'week', sat).map((r) => r.id), ['new']);
  assert.equal(inPeriod(rows, 'month', sat).length, 2);
});
