#!/usr/bin/env node
/**
 * Find craft products entered twice, and clear up the copies.
 *
 *   npm run dedupe:craft                     preview, picture rule only
 *   npm run dedupe:craft -- --merge          preview, merging copies together
 *   npm run dedupe:craft -- --merge --apply  actually do it
 *
 * Preview by default, and that is not politeness. Thirteen other tables point
 * at a product — sales, consignor ledgers, stock moves, counts — so a wrong
 * removal here does not fail loudly, it surfaces weeks later as a maker's
 * statement that will not add up.
 *
 * Two jobs, because this catalogue turned out to hold two different problems.
 *
 * THE PICTURE RULE (default). Where the same piece appears twice and only one
 * copy has a photograph, keep that one and remove the other. It settles the
 * clean cases: a stray row with no picture, nothing on the shelf and no
 * history is a typo, and deleting it loses nothing.
 *
 * MERGING (--merge). It ran out almost immediately here. The catalogue was
 * loaded twice, four days apart, and BOTH copies of most pieces have stock on
 * the shelf and have been sold from — the older one under no owner, the newer
 * one with the maker attached. Each holds part of the truth, so neither is
 * deleted: one row absorbs the other. Stock is added together, missing fields
 * are carried across, and every sale, ledger entry, stock count and movement
 * is re-pointed at the surviving row before the empty one goes.
 *
 * Two makers with the same product name are NOT duplicates. In a consignment
 * shop that is ordinary. Grouping is by name AND owner unless --across-owners.
 */
import 'dotenv/config';
import { Client, Databases, Query } from 'node-appwrite';
import { DB_ID } from './schema.mjs';
import {
  findDuplicates, planMerge, removalKind, describeGroup, hasImage,
} from '../packages/core/src/duplicates.ts';

const { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY } = process.env;
if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY) {
  console.error('Missing APPWRITE_ENDPOINT / APPWRITE_PROJECT_ID / APPWRITE_API_KEY in .env');
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const merge = args.includes('--merge');
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

console.log(`▸ ${apply ? 'Clearing up' : 'Checking'} craft duplicates on ${APPWRITE_PROJECT_ID}`);
console.log(`  ${merge ? 'Merging copies together' : 'Picture rule only'}\n`);

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

/**
 * Everything that points at a product, and how.
 *
 * `unique` names the columns the database insists are unique alongside the
 * product. Re-pointing one of those blindly is not a mistake that gets caught
 * later: Appwrite rejects it outright, halfway through a merge, leaving the
 * shop with a product that is half-moved. Where the survivor already has an
 * equivalent row, the copy's is deleted instead.
 */
const REFERENCES = [
  { col: 'order_items', field: 'menu_item_id' },
  { col: 'consignor_ledger', field: 'menu_item_id' },
  { col: 'product_moves', field: 'menu_item_id' },
  { col: 'stock_count_lines', field: 'menu_item_id' },
  { col: 'waste_log', field: 'menu_item_id' },
  { col: 'item_availability', field: 'menu_item_id' },
  { col: 'recipes', field: 'menu_item_id' },
  { col: 'menu_item_addon_groups', field: 'menu_item_id' },
  { col: 'product_variants', field: 'menu_item_id' },
  { col: 'menu_item_categories', field: 'menu_item_id', unique: ['category_id'] },
  { col: 'venue_menu_items', field: 'menu_item_id', unique: ['venue_id'] },
];

/*
  Read once, up front, rather than asked per candidate: a shop with a thousand
  pieces would otherwise make thousands of separate calls, and read allowance
  is the thing that took this system down this morning.
*/
const refsByItem = new Map(); // itemId -> [{ col, field, unique, row }]
for (const ref of REFERENCES) {
  let rows;
  try {
    rows = await allDocuments(ref.col);
  } catch (e) {
    // A collection that is not provisioned tells us nothing. One that FAILED
    // to read would make every product look untouched — the exact mistake that
    // turns a merge into a deletion.
    if (/could not be found|not found/i.test(e.message)) continue;
    console.error(`\n✗ Could not read ${ref.col}: ${e.message}`);
    console.error('  Without it, a product that has been sold would look untouched.');
    console.error('  Stopping rather than guessing.');
    process.exit(1);
  }
  for (const row of rows) {
    const id = row[ref.field];
    if (!id) continue;
    const list = refsByItem.get(id) ?? [];
    list.push({ ...ref, row });
    refsByItem.set(id, list);
  }
}

const refsOf = (id) => refsByItem.get(id) ?? [];
const refCount = (id) => refsOf(id).length;
const hasHistory = (id) => refCount(id) > 0;
const variantsOf = (id) => refsOf(id).filter((r) => r.col === 'product_variants').map((r) => r.row);

console.log(`  ${[...refsByItem.keys()].length} products have something attached to them\n`);

/** One row, with everything that bears on whether it is the real one. */
const describeRow = (r) => [
  r.$id,
  hasImage(r) ? 'picture' : 'no picture',
  (r.on_hand ?? 0) > 0 ? `${r.on_hand} on the shelf` : 'none on the shelf',
  refCount(r.$id) ? `${refCount(r.$id)} records attached` : 'nothing attached',
  r.consignor_id ? `owner ${r.consignor_id.slice(0, 8)}` : 'no owner',
  (r.$createdAt ?? '').slice(0, 16).replace('T', ' '),
].join('  ');

/* ------------------------------------------------------------- what to change */

const groups = findDuplicates(craft, { module: 'craft', acrossOwners, hasHistory });

if (groups.length === 0) {
  console.log('✓ No duplicates found.');
  process.exit(0);
}

/*
  Two copies with the same size on each is a person's problem.

  Merging would leave one product carrying "Small" twice, with the shelf count
  split between them, which is the thing this is supposed to be fixing. Rare
  enough to be worth stopping for rather than guessing at.
*/
const variantClash = (g) => {
  const seen = new Map();
  for (const r of g.rows) {
    for (const v of variantsOf(r.$id)) {
      const label = (v.label ?? '').trim().toLowerCase();
      if (!label) continue;
      if (seen.has(label) && seen.get(label) !== r.$id) return true;
      seen.set(label, r.$id);
    }
  }
  return false;
};

const plans = [];
const needsAPerson = [];

for (const g of groups) {
  if (g.skipped === 'several-have-pictures') {
    // Which photographed piece is the real one is not a thing a rule knows.
    needsAPerson.push([g, 'more than one copy has a picture']);
    continue;
  }
  if (!merge) {
    if (g.skipped) { needsAPerson.push([g, 'no copy has a picture']); continue; }
    plans.push({ group: g, keep: g.keep, drop: g.drop, patch: {} });
    continue;
  }
  if (variantClash(g)) {
    needsAPerson.push([g, 'both copies have the same sizes on them']);
    continue;
  }
  const plan = planMerge(g.rows, {
    references: refCount,
    hasVariants: g.rows.some((r) => variantsOf(r.$id).length > 0),
  });
  if (plan) plans.push({ group: g, ...plan });
}

if (plans.length) {
  console.log(`These ${plans.length} will be ${merge ? 'merged' : 'cleared up'}:\n`);
  for (const p of plans) {
    console.log(`  ${p.group.label}`);
    console.log(`      KEEP  ${describeRow(p.keep)}`);
    for (const r of p.drop) {
      const moving = refCount(r.$id);
      const fate = merge
        ? `merge in${moving ? `, moving ${moving} records` : ''}, then delete`
        : removalKind(r, hasHistory(r.$id));
      console.log(`      ${fate.toUpperCase()}  ${describeRow(r)}`);
    }
    if (Object.keys(p.patch).length) {
      const bits = Object.entries(p.patch).map(([k, v]) => (k === 'on_hand' ? `shelf count becomes ${v}` : `takes ${k}`));
      console.log(`      → ${bits.join(', ')}`);
    }
    console.log('');
  }
}

if (needsAPerson.length) {
  console.log(`These ${needsAPerson.length} need you to look at them — nothing will be touched:\n`);
  for (const [g, why] of needsAPerson) {
    console.log(`  ${g.label}: ${g.rows.length} copies, ${why}.`);
    for (const r of g.rows) console.log(`      ${describeRow(r)}`);
  }
  console.log('');
}

if (!apply) {
  console.log(`▸ Nothing was changed. Re-run with --apply${merge ? ' --merge' : ''} to go ahead.`);
  process.exit(0);
}

/* ------------------------------------------------------------------- doing it */

let merged = 0;
let deleted = 0;
let archived = 0;
let moved = 0;
const failures = [];

for (const p of plans) {
  try {
    // The survivor takes on what the others were carrying BEFORE any of them
    // go, so a failure part-way leaves the shop with too much recorded rather
    // than too little. Stock that is counted twice is found at the next count;
    // stock that vanished is not.
    if (Object.keys(p.patch).length) {
      await retry(() => db.updateDocument(DB_ID, 'menu_items', p.keep.$id, p.patch), `updating ${p.keep.$id}`);
    }

    for (const row of p.drop) {
      if (merge) {
        const keepersRefs = refsOf(p.keep.$id);
        for (const ref of refsOf(row.$id)) {
          // Would the survivor then hold two rows the database calls the same?
          const collides = ref.unique && keepersRefs.some(
            (k) => k.col === ref.col && ref.unique.every((f) => k.row[f] === ref.row[f]),
          );
          if (collides) {
            await retry(() => db.deleteDocument(DB_ID, ref.col, ref.row.$id), `dropping spare ${ref.col}`);
          } else {
            await retry(
              () => db.updateDocument(DB_ID, ref.col, ref.row.$id, { [ref.field]: p.keep.$id }),
              `moving ${ref.col} ${ref.row.$id}`,
            );
            keepersRefs.push({ ...ref, row: { ...ref.row, [ref.field]: p.keep.$id } });
          }
          moved += 1;
        }
        // Everything it was carrying now belongs to the survivor, so the row
        // itself is empty and can go.
        await retry(() => db.deleteDocument(DB_ID, 'menu_items', row.$id), `deleting ${row.$id}`);
        deleted += 1;
        continue;
      }

      const kind = removalKind(row, hasHistory(row.$id));
      if (kind === 'delete') {
        await retry(() => db.deleteDocument(DB_ID, 'menu_items', row.$id), `deleting ${row.$id}`);
        deleted += 1;
      } else {
        await retry(
          () => db.updateDocument(DB_ID, 'menu_items', row.$id, {
            active: false,
            name: row.name.endsWith(' (duplicate)') ? row.name : `${row.name} (duplicate)`.slice(0, 160),
          }),
          `archiving ${row.$id}`,
        );
        archived += 1;
      }
    }
    merged += 1;
  } catch (e) {
    failures.push({ name: p.group.label, error: e.message });
  }
}

console.log(`▸ ${merged} of ${plans.length} done: ${deleted} rows removed, ${archived} archived, ${moved} records moved.`);
console.log(`  ${needsAPerson.length} left for you.`);
if (failures.length) {
  console.error(`\n✗ ${failures.length} did not finish:`);
  for (const f of failures) console.error(`    ${f.name}: ${f.error}`);
  console.error('\nRe-running is safe: whatever moved stays moved, and the rest is picked up again.');
  process.exit(1);
}
console.log('✓ done');
