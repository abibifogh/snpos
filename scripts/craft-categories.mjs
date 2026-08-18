#!/usr/bin/env node
/**
 * Craft products whose category has gone missing, and putting them back.
 *
 *   npm run craft:categories             report only, change nothing
 *   npm run craft:categories -- --apply  put back the ones it can work out
 *
 * A product's category is REQUIRED, so it is never empty. It can still be
 * wrong in three ways that all look the same on the screen — a piece that
 * appears under nothing:
 *
 *   DANGLING  it points at a category row that no longer exists
 *   ARCHIVED  it points at one that has been switched off
 *   FOREIGN   it points at the kitchen's or the bar's, not the shop's
 *
 * Merging the doubled catalogue could have caused the third. Two imports four
 * days apart made their own categories, one row survived each pair, and the
 * survivor kept its own — so a piece can now sit under a grouping the other
 * import created and this side no longer lists.
 *
 * What it can put back, it works out from `menu_item_categories`: a product
 * can belong to several groupings, those links survived the merge, and where
 * exactly one of them is a live craft category that is the answer with no
 * guessing involved. Anything less certain is listed for a person, because
 * filing somebody's handmade piece under the wrong shelf silently is worse
 * than leaving it visible and wrong.
 */
import 'dotenv/config';
import { Client, Databases, Query } from 'node-appwrite';
import { DB_ID } from './schema.mjs';

const { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY } = process.env;
if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY) {
  console.error('Missing APPWRITE_ENDPOINT / APPWRITE_PROJECT_ID / APPWRITE_API_KEY in .env');
  process.exit(1);
}

const apply = process.argv.slice(2).includes('--apply');

const client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const db = new Databases(client);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, label, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e?.message || '';
      if (!/fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|rate limit|too many/i.test(msg) || i >= tries) {
        throw new Error(`${label}: ${msg}`);
      }
      await sleep(1000 * 2 ** i);
    }
  }
}

/** Every row, paged by cursor so each is read once. */
async function allDocuments(colId) {
  const out = [];
  let cursor = null;
  for (;;) {
    const q = [Query.limit(100), Query.orderAsc('$createdAt')];
    if (cursor) q.push(Query.cursorAfter(cursor));
    const page = await retry(() => db.listDocuments(DB_ID, colId, q), `reading ${colId}`);
    out.push(...page.documents);
    if (page.documents.length < 100) return out;
    cursor = page.documents[page.documents.length - 1].$id;
  }
}

console.log(`▸ ${apply ? 'Putting back' : 'Checking'} craft categories on ${APPWRITE_PROJECT_ID}\n`);

const [items, categories, links] = await Promise.all([
  allDocuments('menu_items'),
  allDocuments('categories'),
  allDocuments('menu_item_categories').catch(() => []),
]);

// Filtered in code, not in the query: a row written before the module column
// existed has no value for it, and the database will not match those.
const craft = items.filter((r) => r.module === 'craft');
const byId = new Map(categories.map((c) => [c.$id, c]));
const craftCats = categories.filter((c) => c.module === 'craft' && c.active !== false);

console.log(`  ${craft.length} craft products, ${craftCats.length} live craft categories\n`);

/** Why this product shows under nothing, or null when it is fine. */
const faultOf = (item) => {
  const cat = byId.get(item.category_id);
  if (!cat) return 'points at a category that no longer exists';
  if (cat.active === false) return `sits under "${cat.name}", which is archived`;
  if ((cat.module ?? 'kitchen') !== 'craft') return `sits under "${cat.name}", which belongs to the ${cat.module ?? 'kitchen'}`;
  return null;
};

const broken = craft.map((i) => ({ item: i, why: faultOf(i) })).filter((r) => r.why);

if (broken.length === 0) {
  console.log('✓ Every craft product sits under a live craft category.');
  process.exit(0);
}

/*
  The answer from the links, where there is one beyond doubt.

  A product can belong to several groupings; those rows survived the merge and
  were re-pointed onto the surviving product. Exactly one live craft grouping
  among them is the answer. Two is a choice, and a choice is a person's.
*/
const liveCraft = new Set(craftCats.map((c) => c.$id));
const candidatesFor = (itemId) => [...new Set(
  links
    .filter((l) => l.menu_item_id === itemId && l.active !== false && liveCraft.has(l.category_id))
    .map((l) => l.category_id),
)];

const fixable = [];
const needsAPerson = [];
for (const row of broken) {
  const options = candidatesFor(row.item.$id);
  if (options.length === 1) fixable.push({ ...row, to: options[0] });
  else needsAPerson.push({ ...row, options });
}

if (fixable.length) {
  console.log(`These ${fixable.length} can be put back, from a grouping they already belong to:\n`);
  for (const f of fixable) {
    console.log(`  ${f.item.name}`);
    console.log(`      ${f.why}`);
    console.log(`      → ${byId.get(f.to)?.name}`);
  }
  console.log('');
}

if (needsAPerson.length) {
  console.log(`These ${needsAPerson.length} need you to choose — nothing will be touched:\n`);
  for (const n of needsAPerson) {
    const opts = n.options.length
      ? `could be ${n.options.map((id) => byId.get(id)?.name).join(' or ')}`
      : 'belongs to no other grouping, so there is nothing to work it out from';
    console.log(`  ${n.item.name}: ${n.why}; ${opts}.`);
  }
  console.log('');
  console.log('  Set these from Admin → Products, opening each one and choosing its category.');
  console.log('');
}

if (!apply) {
  console.log('▸ Nothing was changed. Re-run with --apply to put back the ones above.');
  process.exit(0);
}

let done = 0;
const failures = [];
for (const f of fixable) {
  try {
    await retry(
      () => db.updateDocument(DB_ID, 'menu_items', f.item.$id, { category_id: f.to }),
      `filing ${f.item.name}`,
    );
    done += 1;
  } catch (e) {
    failures.push({ name: f.item.name, error: e.message });
  }
}

console.log(`▸ ${done} put back, ${needsAPerson.length} left for you.`);
if (failures.length) {
  console.error(`\n✗ ${failures.length} could not be filed:`);
  for (const f of failures) console.error(`    ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log('✓ done');
