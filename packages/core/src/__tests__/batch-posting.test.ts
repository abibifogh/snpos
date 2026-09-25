import test from 'node:test';
import assert from 'node:assert/strict';
import { postBatchRow } from '../../../../functions/notify/src/books-post.js';
import { storedInputs } from '../batch-rules.ts';

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

const sugar = {
  ingredientId: 'sugar', name: 'Sugar', unit: 'kg', module: 'kitchen', locationId: 'k', available: 9, unitCost: 1_200, qtyText: '3',
};
const hibiscus = { ...sugar, ingredientId: 'hib', name: 'Hibiscus', unitCost: 4_000, qtyText: '2' };

const batch = (over: Record<string, unknown> = {}) => ({
  $id: 'b1', $createdAt: '2026-09-25T10:00:00.000Z', venue_id: 'main', module: 'bar',
  made_name: 'Sobolo', made_qty: 24, unit: 'bottle', made_by: 'u1',
  inputs: storedInputs([sugar, hibiscus]),
  ...over,
});

test('kitchen ingredients made into a bar drink move their value to the bar\'s inventory', async () => {
  const { ctx, tables } = ledger();
  const out = await postBatchRow(ctx, batch());
  assert.equal(out.posted, true);

  assert.equal(tables.journal_entries.length, 1);
  const entry = tables.journal_entries[0];
  assert.equal(entry?.source_id, 'batch:b1');
  assert.equal(entry?.memo, 'Made here: 24 bottle Sobolo');

  assert.deepEqual(
    tables.journal_lines.map((l) => [l.account_code, l.debit, l.credit]),
    [['1210', 11_600, 0], ['1200', 0, 11_600]],
  );
});

test('asked twice, it is posted once', async () => {
  // The event and the hourly sweep both arrive for the same batch.
  const { ctx, tables } = ledger();
  await postBatchRow(ctx, batch());
  const again = await postBatchRow(ctx, batch());
  assert.equal(again.skipped, 'already posted');
  assert.equal(tables.journal_entries.length, 1);
});

test('a batch made from its own side\'s stock posts nothing', async () => {
  // Value moving within one inventory account changes no account.
  const { ctx, tables } = ledger();
  const out = await postBatchRow(ctx, batch({ inputs: storedInputs([{ ...sugar, module: 'bar' }]) }));
  assert.equal(out.skipped, 'nothing crosses sides');
  assert.equal(tables.journal_entries.length, 0);
});

test('a batch with nothing listed posts nothing', async () => {
  const { ctx, tables } = ledger();
  assert.equal((await postBatchRow(ctx, batch({ inputs: '[]' }))).skipped, 'nothing crosses sides');
  assert.equal(tables.journal_entries.length, 0);
});

test('a batch dated inside a closed month is refused, not slipped in', async () => {
  const { ctx, tables } = ledger([{ $id: 'l1', venue_id: 'main', locked_through: '2026-09-30', locked_at: '2026-10-01' }]);
  const out = await postBatchRow(ctx, batch());
  assert.equal(out.skipped, 'locked');
  assert.equal(tables.journal_entries.length, 0);
});
