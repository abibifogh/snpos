/**
 * Orders bought out of a float in Insight, as far as the POS can tell: a
 * signed request makes a draft order once, matched to the stock it can be
 * sure of; Insight can ask where its orders have got to, and take one back
 * while it is still a draft. And the spend that receives one comes off no
 * drawer: the books owe it to the float. A small fake database; every name
 * is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleInsightFloats, matchItem, orderLines, normalName } from './src/insight-floats.js';
import { postSpend } from './src/books-post.js';
import { ACCOUNTS } from './src/books.js';
import { orderToTell } from './src/po-notice.js';

const SECRET = 'shared-with-the-hub';
const sign = (path, text, at = Date.now()) => ({ 'x-till-at': String(at), 'x-till-sig': createHmac('sha256', SECRET).update(`till-link\n${at}\n${path}\n${text}`).digest('hex') });

const Query = {
  equal: (field, value) => ({ field, value }),
  limit: () => ({ limit: true }),
  offset: () => ({ offset: true }),
  cursorAfter: () => ({ cursor: true }),
};

function world({ provisioned = true } = {}) {
  let n = 0;
  const tables = {
    ingredients: [
      { $id: 'i1', venue_id: 'main', module: 'bar', name: 'Tonic water 330ml', unit: 'bottle', pack_size: 24, pack_name: 'crate', active: true },
      { $id: 'i2', venue_id: 'main', module: 'bar', name: 'Tonic water', unit: 'bottle', active: true },
      { $id: 'i3', venue_id: 'main', module: 'bar', name: 'Lime', unit: 'piece', active: true },
      { $id: 'i4', venue_id: 'main', name: 'Lime', unit: 'kg', active: true },
      { $id: 'i5', venue_id: 'main', module: 'bar', name: 'Club Soda', unit: 'bottle', active: true },
      { $id: 'i6', venue_id: 'main', module: 'bar', name: 'Soda Water', unit: 'bottle', active: true },
    ],
    suppliers: [{ $id: 's1', name: 'A Drinks Depot', email: 'depot@example.test', phone: '000', active: true }],
    stock_orders: [{ $id: 'old', venue_id: 'main', po_no: 'PO-0141', status: 'received' }],
    audit_log: [],
    journal_entries: [],
    journal_lines: [],
    expense_items: [],
    expense_categories: [],
  };
  const insightFields = ['insight_key', 'insight_ref', 'insight_from', 'receipt_file_id', 'paid_by'];
  const db = {
    async listDocuments(_d, table, queries = []) {
      if (!provisioned && table === 'stock_orders' && queries.some((q) => q.field === 'insight_key')) throw new Error('Attribute not found in schema: insight_key');
      let rows = tables[table] || [];
      for (const q of queries) if (q.field) rows = rows.filter((r) => (Array.isArray(q.value) ? q.value.includes(r[q.field]) : r[q.field] === q.value));
      return { documents: rows, total: rows.length };
    },
    async getDocument(_d, table, id) {
      if (table === 'settings') return { currency_symbol: 'GH₵' };
      const row = (tables[table] || []).find((r) => r.$id === id);
      if (!row) throw new Error('Document not found');
      return row;
    },
    async updateDocument(_d, table, id, data) {
      const row = tables[table].find((r) => r.$id === id);
      Object.assign(row, data);
      return row;
    },
    async createDocument(_d, table, _id, data) {
      if (!provisioned && table === 'stock_orders') {
        const extra = insightFields.find((k) => k in data);
        if (extra) throw new Error(`Invalid document structure: Unknown attribute: "${extra}"`);
      }
      n += 1;
      const row = { $id: `${table}-${n}`, $createdAt: '2026-10-31T10:00:00.000Z', ...data };
      (tables[table] ||= []).push(row);
      return row;
    },
  };
  const stored = [];
  const storage = {
    async createFile(bucket, _id, file, perms) { stored.push({ bucket, file, perms }); return { $id: `file-${stored.length}` }; },
  };
  const makeFile = async (buffer, name) => ({ name, size: buffer.length });
  return { tables, db, storage, makeFile, stored };
}

async function call(w, path, body, headers = null) {
  const text = JSON.stringify(body);
  let out = null;
  const res = { json: (b, status = 200) => { out = { status, body: b }; return out; } };
  const handled = await handleInsightFloats({
    req: { path, method: 'POST', bodyText: text, headers: headers || sign(path, text) },
    res, db: w.db, DB_ID: 'snpos', Query, storage: w.storage, makeFile: w.makeFile,
    env: { INSIGHT_SSO_SECRET: SECRET, APP_URL: 'https://pos.example.test/' },
  });
  return handled ? out : null;
}

const order = (o = {}) => ({
  key: 'insight-float:123', module: 'bar', ref: 'FLT/ESI/007', holder: 'Esi Test', supplier: 'a drinks depot',
  day: '2026-10-31', total: 64000, description: 'Tonic water',
  lines: [{ name: 'Tonic water 330ml, crate of 24', qty: 4, amount: 64000 }],
  hint: 'for the weekend', by: 'Kofi Test', ...o,
});

test('names are matched carefully, or not at all', () => {
  const items = world().tables.ingredients.filter((i) => i.module === 'bar');
  assert.equal(normalName('Tonic Water (330ml)'), 'tonic water 330ml');
  assert.equal(matchItem('TONIC WATER', items)?.$id, 'i2', 'the same name first');
  assert.equal(matchItem('Tonic water 330ml, crate of 24', items)?.$id, 'i1', 'the item with most words in the line');
  assert.equal(matchItem('Limes from the market', items), null, 'one short word in a long line is not enough');
  assert.equal(matchItem('Lime', items)?.$id, 'i3');
  assert.equal(matchItem('Soda', items), null, 'two sodas: no answer rather than the wrong one');
  assert.equal(matchItem('Something else', items), null);
});

test('lines keep what was bought and paid; a matched one comes in its pack', () => {
  const items = world().tables.ingredients.filter((i) => i.module === 'bar');
  const [crate, odd] = orderLines({ lines: [{ name: 'Tonic water 330ml, crate of 24', qty: 4, amount: 64000 }, { name: 'Ice', qty: 3, amount: 1000 }] }, items);
  assert.deepEqual(crate, {
    ingredient_id: 'i1', name: 'Tonic water 330ml', unit: 'bottle', buy_key: 'pack', buy_label: 'crates', per: 24,
    qty: 4, unit_cost: 16000, received_qty: 0, bought_as: 'Tonic water 330ml, crate of 24',
  });
  assert.equal(odd.ingredient_id, '');
  assert.equal(odd.name, 'Ice');
  assert.equal(odd.unit_cost, 333);
  // No lines: one, from the description and the total.
  assert.deepEqual(orderLines({ description: 'Tonic water', total: 5000 }, items).map((l) => [l.name, l.qty, l.unit_cost]), [['Tonic water', 1, 5000]]);
});

test('only the hub, and only these paths', async () => {
  const w = world();
  assert.equal(await call(w, '/approvals/list', {}), null, 'not its path: left for the next');
  assert.equal((await call(w, '/floats/po', order(), { 'x-till-at': '1', 'x-till-sig': 'no' })).status, 401);
  const stale = sign('/floats/po', JSON.stringify(order()), Date.now() - 10 * 60 * 1000);
  assert.equal((await call(w, '/floats/po', order(), stale)).status, 401);
  assert.equal(w.tables.stock_orders.length, 1, 'nothing written');
});

test('a draft order is made once, matched, with its receipt, and needs nobody to approve it', async () => {
  const w = world();
  const receipt = { mime: 'image/jpeg', data: Buffer.from('a photo').toString('base64') };
  const made = await call(w, '/floats/po', order({ receipt }));
  assert.equal(made.status, 200);
  const o = w.tables.stock_orders.find((r) => r.insight_key === 'insight-float:123');
  assert.deepEqual(made.body, {
    ok: true, id: o.$id, poNo: 'PO-0142', status: 'draft', total: 64000, module: 'bar',
    url: `https://pos.example.test/#/purchase-orders?show=${o.$id}`,
  });
  assert.equal(o.status, 'draft');
  assert.equal(o.supplier_id, 's1');
  assert.equal(o.supplier_name, 'A Drinks Depot');
  assert.equal(o.created_by, 'insight');
  assert.equal(o.created_by_name, "Insight (Esi Test's float)");
  assert.equal(o.insight_from, "Esi Test's float");
  assert.equal(o.insight_ref, 'FLT/ESI/007');
  assert.equal(o.paid_by, 'float');
  assert.equal(o.receipt_file_id, 'file-1');
  assert.equal(w.stored[0].bucket, 'receipts');
  assert.deepEqual(w.stored[0].perms, ['read("team:managers")', 'read("team:admins")']);
  assert.match(o.note, /^From Insight: Esi Test's float · FLT\/ESI\/007 · bought 2026-10-31 · sent by Kofi Test/);
  assert.match(o.note, /They said: “for the weekend”/);
  assert.equal(JSON.parse(o.lines)[0].ingredient_id, 'i1');
  assert.deepEqual([w.tables.audit_log[0].device, w.tables.audit_log[0].actor_id], ['Insight', 'insight']);
  // Not told to the admins as an order to send, and the hourly run is not either.
  assert.equal(orderToTell({ ...o, status: 'ready' }), false);
  assert.equal(orderToTell({ status: 'ready', po_no: 'PO-1' }), true);

  // Asked again: the same order, unchanged.
  const again = await call(w, '/floats/po', order({ total: 1 }));
  assert.equal(again.body.id, o.$id);
  assert.equal(again.body.total, 64000);
  assert.equal(w.tables.stock_orders.length, 2);
});

test('what does not match is kept as written, and a total the lines do not make is said', async () => {
  const w = world();
  const made = await call(w, '/floats/po', order({
    key: 'insight-float:124', supplier: '', total: 70000,
    lines: [{ name: 'Tonic water 330ml, crate of 24', qty: 4, amount: 64000 }, { name: 'Ice blocks', qty: 2, amount: 5000 }],
  }));
  const o = w.tables.stock_orders.find((r) => r.$id === made.body.id);
  assert.equal(made.body.total, 70000);
  assert.equal(o.supplier_id, '');
  assert.equal(o.supplier_name, 'Supplier to confirm');
  assert.equal(JSON.parse(o.lines)[1].ingredient_id, '');
  assert.match(o.note, /The receipt says GH₵700\.00; the lines come to GH₵690\.00\./);
  // An unknown supplier is kept by name, never added.
  const other = await call(w, '/floats/po', order({ key: 'insight-float:125', supplier: 'A Market Stall' }));
  assert.equal(w.tables.stock_orders.find((r) => r.$id === other.body.id).supplier_name, 'A Market Stall');
  assert.equal(w.tables.suppliers.length, 1);
});

test('a receipt that is too big or of the wrong kind is left out, and the order made anyway', async () => {
  const w = world();
  const big = await call(w, '/floats/po', order({ key: 'k-big', receipt: { mime: 'image/jpeg', data: 'A'.repeat(5 * 1024 * 1024 + 1) } }));
  assert.equal(big.status, 200);
  const odd = await call(w, '/floats/po', order({ key: 'k-odd', receipt: { mime: 'text/html', data: 'PGI+' } }));
  assert.equal(odd.status, 200);
  const broken = world();
  broken.storage.createFile = async () => { throw new Error('bucket full'); };
  const made = await call(broken, '/floats/po', order({ key: 'k-broken', receipt: { mime: 'image/png', data: 'AAAA' } }));
  assert.equal(made.status, 200);
  assert.equal(broken.tables.stock_orders.find((r) => r.$id === made.body.id).receipt_file_id, '');
  assert.equal(w.stored.length, 0);
});

test('a database not yet provisioned for it still takes the order', async () => {
  const w = world({ provisioned: false });
  const made = await call(w, '/floats/po', order());
  assert.equal(made.status, 200);
  assert.equal(made.body.status, 'draft');
  assert.match(made.body.warning, /Run Provision/);
});

test('bad requests are refused in words', async () => {
  const w = world();
  assert.equal((await call(w, '/floats/po', order({ key: '' }))).status, 400);
  assert.equal((await call(w, '/floats/po', order({ module: 'spa' }))).status, 400);
  assert.equal((await call(w, '/floats/po', order({ total: 12.5 }))).status, 400);
  assert.equal((await call(w, '/floats/po/status', { ids: 'nope' })).status, 400);
  assert.equal((await call(w, '/floats/po/status', { ids: Array.from({ length: 101 }, (_, i) => `x${i}`) })).status, 400);
});

test('where they have got to; ids not found are left out', async () => {
  const w = world();
  const made = await call(w, '/floats/po', order());
  Object.assign(w.tables.stock_orders.find((r) => r.$id === made.body.id), { status: 'received', received_at: '2026-11-01T09:00:00.000Z' });
  const { status, body } = await call(w, '/floats/po/status', { ids: [made.body.id, 'nobody'] });
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, orders: [{ id: made.body.id, poNo: 'PO-0142', status: 'received', total: 64000, receivedAt: '2026-11-01T09:00:00.000Z', module: 'bar' }] });
});

test('taken back only while it is still a draft from Insight', async () => {
  const w = world();
  const made = await call(w, '/floats/po', order());
  const row = w.tables.stock_orders.find((r) => r.$id === made.body.id);

  row.status = 'ready';
  const busy = await call(w, '/floats/po/cancel', { id: row.$id, by: 'Kofi Test', note: 'Wrong side' });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error, 'PO-0142 is already being received in the POS: cancel it there first.');
  assert.equal((await call(w, '/floats/po/cancel', { id: 'old', by: 'Kofi Test' })).status, 409, 'not one of Insight\'s');
  assert.equal((await call(w, '/floats/po/cancel', { id: 'nobody' })).status, 404);

  row.status = 'draft';
  const done = await call(w, '/floats/po/cancel', { id: row.$id, by: 'Kofi Test', note: 'Wrong side' });
  assert.deepEqual(done.body, { ok: true, status: 'cancelled' });
  assert.deepEqual([row.status, row.decided_note], ['cancelled', 'Wrong side']);
  const trail = w.tables.audit_log.at(-1);
  assert.deepEqual([trail.action, trail.device, trail.actor_id, trail.reason], ['po_cancelled', 'Insight', 'insight', 'By Kofi Test in Insight: Wrong side']);

  // Cancelled, the same key may make a fresh one.
  const fresh = await call(w, '/floats/po', order());
  assert.notEqual(fresh.body.id, row.$id);
  assert.equal(fresh.body.poNo, 'PO-0143');
});

test('a spend paid from a float credits 2310 Paid from floats, not the cash', async () => {
  const w = world();
  const ctx = { db: w.db, DB_ID: 'snpos', Query, log: () => undefined };
  const spend = { $id: 'e1', venue_id: 'main', $createdAt: '2026-11-01T10:00:00.000Z', amount: 64000, module: 'bar', source: 'float', from_takings: false, category_key: 'other', created_by: 'u1' };
  const out = await postSpend(ctx, spend);
  assert.equal(out.posted, true);
  const credit = w.tables.journal_lines.find((l) => l.credit > 0);
  assert.deepEqual([credit.account_code, credit.credit], [ACCOUNTS.floatsPayable, 64000]);
  assert.equal(ACCOUNTS.floatsPayable, '2310');
  assert.equal(w.tables.journal_entries[0].memo, 'Paid from a float, in Insight');
});
