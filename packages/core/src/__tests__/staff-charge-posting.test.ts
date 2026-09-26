import test from 'node:test';
import assert from 'node:assert/strict';
import { postStaffChargeRow, postStaffSettleRow } from '../../../../functions/notify/src/books-post.js';

/*
  The server's posting, driven through the real postEntry against a ledger
  held in memory. The rules are tested elsewhere; this is the part that
  writes, and the part that must post a batch once however many times it is
  asked.
*/

type Row = Record<string, unknown> & { $id: string };

function ledger(locks: Row[] = []) {
  const tables: Record<string, Row[]> = { journal_entries: [], journal_lines: [], accounting_locks: locks };
  let n = 0;
  const Query = {
    equal: (f: string, v: unknown) => ({ f, v }),
    limit: () => null,
    offset: () => null,
  };
  const db = {
    async listDocuments(_db: string, table: string, queries: ({ f: string; v: unknown } | null)[]) {
      const eq = queries.filter((q): q is { f: string; v: unknown } => !!q && 'f' in q);
      const docs = (tables[table] ?? []).filter((r) => eq.every((q) => r[q.f] === q.v));
      return { documents: docs, total: docs.length };
    },
    async createDocument(_db: string, table: string, _id: string, data: Record<string, unknown>) {
      n += 1;
      const row = { $id: `${table}-${n}`, ...data };
      (tables[table] ??= []).push(row);
      return row;
    },
  };
  return { ctx: { db, DB_ID: 'snpos', Query, log: () => {} }, tables };
}


const charge = {
  $id: 'c1', venue_id: 'main', person_name: 'Regina', item_name: 'Club · Large', qty: 6, amount: 18_000,
  charged_at: '2026-09-26T16:40:00.000Z', charged_by: 'owner',
};

test('a charge is posted as owed by staff, once however many times it is asked', async () => {
  const { ctx, tables } = ledger();
  assert.equal((await postStaffChargeRow(ctx, charge)).posted, true);
  assert.equal((await postStaffChargeRow(ctx, charge)).skipped, 'already posted');
  assert.equal(tables.journal_entries.length, 1);
  assert.equal(tables.journal_entries[0]?.source_id, 'staffcharge:c1');
  assert.equal(tables.journal_entries[0]?.memo, 'Charged to Regina: 6 Club · Large');
  assert.deepEqual(tables.journal_lines.map((l) => [l.account_code, l.debit, l.credit]), [['1300', 18_000, 0], ['4910', 0, 18_000]]);
});

test('cash paid back lands in the drawer\'s account against the shift it went into', async () => {
  const { ctx, tables } = ledger();
  const paid = { $id: 's1', venue_id: 'main', kind: 'cash', amount: 10_000, shift_id: 'sh9', recorded_at: '2026-09-27T10:00:00.000Z' };
  assert.equal((await postStaffSettleRow(ctx, paid)).posted, true);
  assert.equal((await postStaffSettleRow(ctx, paid)).skipped, 'already posted');
  assert.equal(tables.journal_entries[0]?.shift_id, 'sh9');
  assert.deepEqual(tables.journal_lines.map((l) => [l.account_code, l.debit, l.credit]), [['1000', 10_000, 0], ['1300', 0, 10_000]]);
});

test('nothing is posted for nothing, or inside a closed month', async () => {
  assert.equal((await postStaffChargeRow(ledger().ctx, { ...charge, amount: 0 })).skipped, 'no value');
  const { ctx, tables } = ledger([{ $id: 'l1', venue_id: 'main', locked_through: '2026-09-30', locked_at: '2026-10-01' }]);
  assert.equal((await postStaffChargeRow(ctx, charge)).skipped, 'locked');
  assert.equal(tables.journal_entries.length, 0);
});
