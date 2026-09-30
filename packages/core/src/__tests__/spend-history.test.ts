import test from 'node:test';
import assert from 'node:assert/strict';
import { spendChanges, spendHistory } from '../spend-history.ts';
import { spendSnapshot } from '../spend-history.ts';

const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;
const names = new Map([['regina', 'Regina'], ['owner', 'Owner']]);
const nameOf = (id?: string | null) => (id ? names.get(id) ?? '' : '');

test('a correction says each field that moved, from what to what', () => {
  const before = { amount: 40_000, category_key: 'supplies', payee: 'Makola', note: '', paid_from_method_id: 'cash', source: 'drawer' };
  const after = { amount: 45_000, category_key: 'transport', payee: 'Makola', note: 'taxi back', paid_from_method_id: 'momo', source: 'drawer' };
  assert.deepEqual(
    spendChanges(before, after, { money, methodName: (id) => ({ cash: 'Cash', momo: 'Mobile money' })[id] ?? id }),
    [
      'Amount GH₵400.00 → GH₵450.00',
      'Category supplies → transport',
      'Paid by Cash → Mobile money',
      'Note “—” → “taxi back”',
    ],
  );
  assert.deepEqual(spendChanges(before, before, { money }), [], 'nothing moved, nothing said');
});

test('the shopping list is compared too', () => {
  const was = { items: [{ name: 'Rice', qty: 2, line_total: 30_000 }] };
  const now = { items: [{ name: 'Rice', qty: 2, line_total: 30_000 }, { name: 'Onions', qty: 5, line_total: 5_000 }] };
  assert.deepEqual(spendChanges(was, now, { money }), [
    'Items 2 × Rice (GH₵300.00) → 2 × Rice (GH₵300.00), 5 × Onions (GH₵50.00)',
  ]);
});

test('the story reads newest first: recorded, corrected, approved', () => {
  const rows = spendHistory({
    spend: { $createdAt: '2026-09-29T10:00:00.000Z', created_by: 'regina', amount: 45_000 },
    audits: [
      {
        $id: 'a1', $createdAt: '2026-09-29T10:30:00.000Z', action: 'spend_edited', actor_id: 'regina',
        before: JSON.stringify({ amount: 40_000 }), after: JSON.stringify({ amount: 45_000 }),
      },
      { $id: 'a2', $createdAt: '2026-09-30T08:00:00.000Z', action: 'spend_approved', actor_id: 'owner' },
      // Anything else logged against the row is not part of this story.
      { $id: 'a3', $createdAt: '2026-09-30T09:00:00.000Z', action: 'journal_edited', actor_id: 'system' },
    ],
    nameOf,
    money,
  });
  assert.deepEqual(rows.map((r) => [r.what, r.who, r.changes]), [
    ['Approved', 'Owner', []],
    ['Changed', 'Regina', ['Amount GH₵400.00 → GH₵450.00']],
    ['Recorded, GH₵450.00', 'Regina', []],
  ]);
});

test('a snapshot keeps only what a change is judged on', () => {
  const snap = spendSnapshot({ amount: 100, category_key: 'supplies', receipt_file_id: 'x', created_by: 'y' } as never);
  assert.deepEqual(Object.keys(snap).sort(), ['amount', 'category', 'category_key', 'imprest_float_id', 'note', 'paid_from_method_id', 'payee', 'source']);
});
