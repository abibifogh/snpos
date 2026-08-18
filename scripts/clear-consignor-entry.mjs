#!/usr/bin/env node
/**
 * Take entries off a maker's statement, when there is no order left to undo.
 *
 *   npm run consignor:clear -- --who=Ato              show what is there
 *   npm run consignor:clear -- --who=Ato --apply      remove them
 *   npm run consignor:clear -- --who=Ato --orphans    only ones with no order
 *
 * The ordinary way to take a sale back is to cancel or delete the order,
 * which unwinds everything with it. This is for when that is not possible:
 * the order has already gone, or was never findable, and the credit is still
 * sitting on somebody's statement with nothing behind it to act on.
 *
 * It exists because the ledger cannot be touched from the admin screens at
 * all — no create, update or delete permission for anybody, deliberately,
 * since it is what a maker is paid from. That is right, and it means an entry
 * with no order behind it has no way out except this.
 *
 * An entry that has already been PAID OUT is refused. The payout points at
 * it; removing it would leave real money sitting against nothing and the
 * statement would stop adding up. Reverse the payout first, or leave it.
 */
import 'dotenv/config';
import { Client, Databases, Query } from 'node-appwrite';
import { DB_ID } from './schema.mjs';

const { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY } = process.env;
if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY) {
  console.error('Missing APPWRITE_ENDPOINT / APPWRITE_PROJECT_ID / APPWRITE_API_KEY in .env');
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const orphansOnly = args.includes('--orphans');
const who = (args.find((a) => a.startsWith('--who=')) ?? '').slice(6).trim();

if (!who) {
  console.error('Say whose statement: --who="Ato"');
  process.exit(1);
}

const client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const db = new Databases(client);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, label, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e?.message || '';
      if (!/fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|rate limit|too many/i.test(msg) || i >= tries) {
        throw new Error(`${label}: ${msg}`);
      }
      await sleep(1000 * 2 ** i);
    }
  }
}

async function allDocuments(colId, queries = []) {
  const out = [];
  let cursor = null;
  for (;;) {
    const q = [...queries, Query.limit(100), Query.orderAsc('$createdAt')];
    if (cursor) q.push(Query.cursorAfter(cursor));
    const page = await retry(() => db.listDocuments(DB_ID, colId, q), `reading ${colId}`);
    out.push(...page.documents);
    if (page.documents.length < 100) return out;
    cursor = page.documents[page.documents.length - 1].$id;
  }
}

const consignors = await allDocuments('consignors');
const match = consignors.filter((c) => (c.name ?? '').toLowerCase().includes(who.toLowerCase()));

if (match.length === 0) {
  console.error(`No maker matching "${who}". There are: ${consignors.map((c) => c.name).join(', ')}`);
  process.exit(1);
}
if (match.length > 1) {
  console.error(`"${who}" matches ${match.length}: ${match.map((c) => c.name).join(', ')}. Be more specific.`);
  process.exit(1);
}

const maker = match[0];
const entries = await allDocuments('consignor_ledger', [Query.equal('consignor_id', maker.$id)]);
const orders = await allDocuments('orders');
const liveOrders = new Set(orders.map((o) => o.$id));

console.log(`▸ ${maker.name}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}\n`);

const money = (n) => `GHS ${((n ?? 0) / 100).toFixed(2)}`;
let balance = 0;
for (const e of entries) balance += e.amount ?? 0;
console.log(`  Currently owed: ${money(balance)}\n`);

const going = [];
const refused = [];
for (const e of entries) {
  const hasOrder = e.order_id && liveOrders.has(e.order_id);
  const orphan = !hasOrder;
  const mark = [
    e.kind,
    e.description || '(no description)',
    money(e.amount),
    hasOrder ? 'order still exists' : 'no order behind it',
    (e.payout_id || '').trim() ? 'ALREADY PAID OUT' : '',
  ].filter(Boolean).join(' · ');

  if ((e.payout_id || '').trim()) { refused.push({ e, mark }); continue; }
  if (orphansOnly && !orphan) continue;
  going.push({ e, mark });
}

if (going.length) {
  console.log(`These ${going.length} would be removed:\n`);
  for (const g of going) console.log(`  ${g.mark}`);
  const after = balance - going.reduce((n, g) => n + (g.e.amount ?? 0), 0);
  console.log(`\n  Balance afterwards: ${money(after)}\n`);
}

if (refused.length) {
  console.log(`These ${refused.length} cannot be removed — the maker has been paid for them:\n`);
  for (const r of refused) console.log(`  ${r.mark}`);
  console.log('\n  Removing one would leave a payout covering a sale that does not exist.');
  console.log('  Reverse the payout first if it genuinely has to go.\n');
}

if (going.length === 0) {
  console.log('▸ Nothing to remove.');
  process.exit(0);
}

if (!apply) {
  console.log('▸ Nothing was changed. Re-run with --apply to remove them.');
  process.exit(0);
}

let done = 0;
const failures = [];
for (const g of going) {
  try {
    await retry(() => db.deleteDocument(DB_ID, 'consignor_ledger', g.e.$id), `removing ${g.e.$id}`);
    // The order behind it, where one is still there. Leaving it would put the
    // credit back the next time anything re-reads the sale.
    if (g.e.order_id && liveOrders.has(g.e.order_id)) {
      for (const line of await allDocuments('order_items', [Query.equal('order_id', g.e.order_id)])) {
        await retry(() => db.deleteDocument(DB_ID, 'order_items', line.$id), 'removing line').catch(() => undefined);
      }
      for (const p of await allDocuments('payments', [Query.equal('order_id', g.e.order_id)])) {
        await retry(() => db.deleteDocument(DB_ID, 'payments', p.$id), 'removing payment').catch(() => undefined);
      }
      await retry(() => db.deleteDocument(DB_ID, 'orders', g.e.order_id), 'removing order').catch(() => undefined);
      liveOrders.delete(g.e.order_id);
    }
    done += 1;
  } catch (e) {
    failures.push({ mark: g.mark, error: e.message });
  }
}

console.log(`▸ ${done} removed from ${maker.name}'s statement.`);
if (failures.length) {
  console.error(`\n✗ ${failures.length} could not be removed:`);
  for (const f of failures) console.error(`    ${f.mark}: ${f.error}`);
  process.exit(1);
}
console.log('✓ done');
