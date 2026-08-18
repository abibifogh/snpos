#!/usr/bin/env node
/**
 * Find craft products entered twice, and clear up the copies.
 *
 *   npm run dedupe:craft              show what it WOULD do, change nothing
 *   npm run dedupe:craft -- --apply   actually do it
 *
 * Dry run by default, and that is not politeness. Thirteen other tables point
 * at a product — sales, consignor ledgers, stock moves, counts — so the wrong
 * deletion here does not fail loudly, it surfaces weeks later as a maker's
 * statement that will not add up.
 *
 * The rule, from the shop: where the same piece appears twice, keep the one
 * with the picture. Where that rule cannot decide — no copy has a picture, or
 * more than one does — the group is reported and left exactly as it is.
 * Guessing would delete a real piece on a coin toss.
 *
 * Two makers with the same product name are NOT duplicates. In a consignment
 * shop that is ordinary: Ama's beaded necklace and Kofi's beaded necklace are
 * two pieces belonging to two people. Grouping is by name AND owner unless
 * --across-owners says the shop owns its stock.
 */
import 'dotenv/config';
import { Client, Databases, Query } from 'node-appwrite';
import { DB_ID } from './schema.mjs';
import { findDuplicates, removalKind, describeGroup, hasImage } from '../packages/core/src/duplicates.ts';

const { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY } = process.env;
if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY) {
  console.error('Missing APPWRITE_ENDPOINT / APPWRITE_PROJECT_ID / APPWRITE_API_KEY in .env');
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const acrossOwners = args.includes('--across-owners');

const client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const db = new Databases(client);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, label, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e?.message || '';
      const transient = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|rate limit|too many/i.test(msg);
      if (!transient || i >= tries) throw new Error(`${label}: ${msg}`);
      await sleep(1000 * 2 ** i);
    }
  }
}

/** Every row of a collection, paged by cursor so each is read once. */
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

console.log(`▸ ${apply ? 'Clearing up' : 'Checking'} craft duplicates on ${APPWRITE_PROJECT_ID}\n`);

/* ------------------------------------------------------------- what is there */

const items = await allDocuments('menu_items');
/*
  Filtered in code, not in the query.

  `Query.equal('module','craft')` misses every row written before the module
  column existed — the field is simply absent on them, so the database does not
  match them, and they are exactly the old rows most likely to have been
  imported twice. This has caught the project out before.
*/
const craft = items.filter((r) => r.module === 'craft');
console.log(`  ${craft.length} craft products, out of ${items.length} altogether`);

/* --------------------------------------------------- what is attached to what */

/*
  Which products carry history.

  Read once, up front, rather than asked per candidate: a shop with a thousand
  pieces would otherwise make thousands of separate calls, and read allowance
  is the thing that took this system down this morning.
*/
const attached = new Set();
const sources = [
  ['order_items', 'menu_item_id'],
  ['consignor_ledger', 'menu_item_id'],
  ['product_moves', 'menu_item_id'],
  ['stock_count_lines', 'menu_item_id'],
  ['product_variants', 'menu_item_id'],
  ['waste_log', 'menu_item_id'],
];
for (const [col, field] of sources) {
  try {
    for (const row of await allDocuments(col)) {
      if (row[field]) attached.add(row[field]);
    }
  } catch (e) {
    // A collection that is empty or not yet provisioned tells us nothing, but
    // one that FAILED to read would make every product look historyless — and
    // that is the exact mistake that turns an archive into a deletion.
    if (!/could not be found|not found/i.test(e.message)) {
      console.error(`\n✗ Could not read ${col}: ${e.message}`);
      console.error('  Without it, a product that has been sold would look untouched and be deleted.');
      console.error('  Stopping rather than guessing.');
      process.exit(1);
    }
  }
}
console.log(`  ${attached.size} products have sales, stock moves or counts against them\n`);

const hasHistory = (id) => attached.has(id);

/* ------------------------------------------------------------- what to change */

const groups = findDuplicates(craft, { module: 'craft', acrossOwners, hasHistory });

if (groups.length === 0) {
  console.log('✓ No duplicates found.');
  process.exit(0);
}

const decided = groups.filter((g) => !g.skipped);
const skipped = groups.filter((g) => g.skipped);

if (decided.length) {
  console.log(`These ${decided.length} will be cleared up:\n`);
  for (const g of decided) {
    console.log(`  ${describeGroup(g, hasHistory)}`);
    for (const r of g.rows) {
      const role = r === g.keep ? 'KEEP  ' : `${removalKind(r, hasHistory(r.$id)).toUpperCase().padEnd(6)}`;
      const marks = [
        hasImage(r) ? 'picture' : 'no picture',
        (r.on_hand ?? 0) > 0 ? `${r.on_hand} on the shelf` : null,
        hasHistory(r.$id) ? 'has sales/stock history' : null,
      ].filter(Boolean);
      console.log(`      ${role} ${r.$id}  ${marks.join(', ')}`);
    }
    console.log('');
  }
}

if (skipped.length) {
  console.log(`These ${skipped.length} need you to look at them — nothing will be touched:\n`);
  for (const g of skipped) console.log(`  ${describeGroup(g, hasHistory)}`);
  console.log('');
}

if (!apply) {
  console.log('▸ Nothing was changed. Re-run with --apply to go ahead.');
  process.exit(0);
}

/* ------------------------------------------------------------------- doing it */

let deleted = 0;
let archived = 0;
const failures = [];

for (const g of decided) {
  for (const row of g.drop) {
    const kind = removalKind(row, hasHistory(row.$id));
    try {
      if (kind === 'delete') {
        await retry(() => db.deleteDocument(DB_ID, 'menu_items', row.$id), `deleting ${row.$id}`);
        deleted += 1;
      } else {
        /*
          Archived, not deleted, and renamed so the two are tellable apart.

          A row with a sale against it cannot go: the sale, the consignor's
          commission and the stock count all point at this id. Taking it off
          the shelf is the whole of what was wanted; destroying the record it
          belongs to was never part of it.
        */
        await retry(
          () => db.updateDocument(DB_ID, 'menu_items', row.$id, {
            active: false,
            name: row.name.endsWith(' (duplicate)') ? row.name : `${row.name} (duplicate)`.slice(0, 160),
          }),
          `archiving ${row.$id}`,
        );
        archived += 1;
      }
    } catch (e) {
      failures.push({ id: row.$id, name: row.name, error: e.message });
    }
  }
}

console.log(`▸ ${deleted} deleted, ${archived} archived, ${skipped.length} left for you.`);
if (failures.length) {
  console.error(`\n✗ ${failures.length} could not be changed:`);
  for (const f of failures) console.error(`    ${f.name} (${f.id}): ${f.error}`);
  process.exit(1);
}
console.log('✓ done');
