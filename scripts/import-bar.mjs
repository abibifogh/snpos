#!/usr/bin/env node
/**
 * Puts the bar's whole list into Appwrite from the three files in data/bar.
 *
 *   npm run import:bar            -- says what it would do, writes nothing
 *   npm run import:bar -- --write -- does it
 *
 * The alternative is somebody opening three upload screens and answering the
 * same questions three times, in the right order, without a mistake. This is
 * that, once, from a button.
 *
 * SAFE TO RE-RUN. Everything is matched by name and updated rather than added
 * again, and the opening levels are SET rather than added — so running it
 * twice leaves the same bar, not two of them. Somebody will run it twice.
 *
 * Reads the parsing from the same pure modules the upload screens use, so a
 * file that imports here imports there and neither can drift from the other.
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client, Databases, ID, Query } from 'node-appwrite';
import { readDrinkImport } from '../packages/core/src/drink-import.ts';
import { readLevelImport } from '../packages/core/src/level-import.ts';
import { packProblem } from '../packages/core/src/packs.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, '..', 'data', 'bar');

const write = process.argv.includes('--write');
const VENUE = 'main';
const MODULE = 'bar';
const DECIMALS = 2;

const { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY } = process.env;
if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY) {
  console.error('Missing APPWRITE_ENDPOINT / APPWRITE_PROJECT_ID / APPWRITE_API_KEY.');
  process.exit(1);
}
const DB_ID = process.env.DB_ID || 'snpos';

const client = new Client()
  .setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const db = new Databases(client);

/** Every row of a collection, past Appwrite's page limit. */
async function all(collection, queries = []) {
  const out = [];
  let cursor = null;
  for (;;) {
    const page = await db.listDocuments(DB_ID, collection, [
      ...queries, Query.limit(100), ...(cursor ? [Query.cursorAfter(cursor)] : []),
    ]);
    out.push(...page.documents);
    if (page.documents.length < 100) break;
    cursor = page.documents[page.documents.length - 1].$id;
  }
  return out;
}

const key = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const csv = (name) => {
  const path = join(DATA, name);
  if (!existsSync(path)) { console.error(`Missing ${path}`); process.exit(1); }
  return parse(readFileSync(path, 'utf8'));
};

/** Quoted fields and embedded commas, which every export produces. */
function parse(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const say = [];
const note = (s) => { say.push(s); console.log(s); };
const step = (s) => console.log(`\n── ${s}`);

// ---- 1. the two places ------------------------------------------------------
// Named here rather than asked for, because the opening-levels file is headed
// with these same two names and the two have to agree or nothing lands.
step('Places');
// `kind` is store or counter, and nothing else — the bar IS the counter. Its
// own name says which room it is; the kind only says whether stock is put down
// there or poured from there.
const PLACES = [
  { name: 'Store room', kind: 'store' },
  { name: 'The bar', kind: 'counter' },
];
let locations = await all('stock_locations', [Query.equal('venue_id', VENUE)]);
for (const p of PLACES) {
  if (locations.some((l) => key(l.name) === key(p.name))) { note(`  ${p.name} — already there`); continue; }
  if (write) {
    const made = await db.createDocument(DB_ID, 'stock_locations', ID.unique(), {
      venue_id: VENUE, name: p.name, kind: p.kind, module: MODULE, active: true, sort: 0,
    });
    locations.push(made);
  }
  note(`  ${p.name} — ${write ? 'made' : 'would make'}`);
}
if (!write && locations.length === 0) locations = PLACES.map((p, i) => ({ $id: `pretend-${i}`, name: p.name }));

// ---- 2. bottles and mixers --------------------------------------------------
step('Bottles and mixers');
const ingRows = csv('ingredients.csv');
const ingHead = ingRows[0].map(key);
const col = (r, h) => (r[ingHead.indexOf(h)] ?? '').trim();

let ingredients = await all('ingredients', [Query.equal('venue_id', VENUE)]);
let added = 0, changed = 0;
const refused = [];

for (let i = 1; i < ingRows.length; i++) {
  const r = ingRows[i];
  const name = col(r, 'name');
  if (!name) continue;
  const unit = col(r, 'unit').toLowerCase() || 'each';
  const packName = col(r, 'bought_as');
  const packSize = Number(col(r, 'units_per_purchase') || 0);

  // A bad pack size is not a small mistake: it multiplies that shelf by itself
  // and divides its cost by the same, and nothing downstream looks wrong until
  // a count. Refused by name rather than defaulted.
  const bad = packProblem(packSize, unit, packName);
  if (bad) { refused.push(`${name}: ${bad}`); continue; }

  const payload = {
    venue_id: VENUE,
    name,
    unit,
    base_unit_cost: Math.round(Number(col(r, 'cost_per_unit') || 0) * 10 ** DECIMALS),
    module: MODULE,
    current_qty: Number(col(r, 'in_stock') || 0),
    par_level: Number(col(r, 'par_level') || 0),
    critical: /^(y|yes|true|1)$/i.test(col(r, 'critical')),
    category: col(r, 'category'),
    pack_size: packSize,
    pack_name: packName,
    active: true,
  };

  const found = ingredients.find((x) => key(x.name) === key(name));
  if (found) {
    // Levels are not touched on an update. What is on the shelf is the count's
    // business, and an import that quietly reset it would undo a stocktake.
    const { current_qty, ...rest } = payload;
    if (write) await db.updateDocument(DB_ID, 'ingredients', found.$id, rest);
    changed++;
  } else {
    if (write) {
      const made = await db.createDocument(DB_ID, 'ingredients', ID.unique(), payload);
      ingredients.push(made);
    } else ingredients.push({ $id: `pretend-${name}`, name, unit });
    added++;
  }
}
note(`  ${added} to add, ${changed} to update`);
if (refused.length) {
  note(`  ${refused.length} refused:`);
  for (const m of refused) note(`    ${m}`);
}

// ---- 3. the drinks list, recipes and all ------------------------------------
step('Drinks');
let categories = await all('categories', [Query.equal('module', MODULE)]).catch(() => []);
const existingItems = await all('menu_items', [Query.equal('module', MODULE)]).catch(() => []);

const parsedDrinks = readDrinkImport(csv('drinks.csv'), {
  categories: categories.map((c) => ({ $id: c.$id, name: c.name })),
  ingredients: ingredients.map((i) => ({ $id: i.$id, name: i.name })),
  existing: existingItems.map((m) => ({ $id: m.$id, name: m.name })),
  decimals: DECIMALS,
});

note(`  ${parsedDrinks.drinks.length} drinks, ${parsedDrinks.recipeLines} recipe lines`);
if (parsedDrinks.newCategories.length) note(`  new categories: ${parsedDrinks.newCategories.join(', ')}`);
if (parsedDrinks.problems.length) {
  note(`  ${parsedDrinks.problems.length} problems:`);
  for (const p of parsedDrinks.problems.slice(0, 20)) note(`    line ${p.line}: ${p.message}`);
}

if (write) {
  const made = new Map();
  for (const d of parsedDrinks.drinks) {
    let categoryId = d.categoryId || made.get(key(d.categoryName)) || '';
    if (!categoryId) {
      const c = await db.createDocument(DB_ID, 'categories', ID.unique(), {
        name: d.categoryName, sort: 0, active: true, station: 'bar',
        // Required. Appwrite rejects the whole document without it, which
        // would have failed every category and therefore every drink.
        unavailable_display: 'grey',
        module: MODULE,
      });
      categoryId = c.$id;
      made.set(key(d.categoryName), categoryId);
    }

    const payload = {
      category_id: categoryId,
      name: d.name,
      description: d.description,
      price: d.price,
      prep_minutes: d.prepMinutes,
      station: 'bar',
      active: true,
      module: MODULE,
      ...(d.barcode ? { sku: d.barcode } : {}),
    };

    const found = existingItems.find((m) => key(m.name) === key(d.name));
    let itemId;
    if (found) {
      await db.updateDocument(DB_ID, 'menu_items', found.$id, payload);
      itemId = found.$id;
      // Out with the old recipe first. Merging would leave two measures
      // pouring where somebody typed one.
      const old = await all('recipes', [Query.equal('menu_item_id', itemId)]).catch(() => []);
      for (const o of old) await db.deleteDocument(DB_ID, 'recipes', o.$id).catch(() => undefined);
    } else {
      itemId = (await db.createDocument(DB_ID, 'menu_items', ID.unique(), payload)).$id;
    }

    // The join the menu actually reads. Without it a drink exists and shows
    // nowhere, which looks exactly like the import having failed.
    const links = await all('menu_item_categories', [Query.equal('menu_item_id', itemId)]).catch(() => []);
    if (!links.some((l) => l.category_id === categoryId)) {
      await db.createDocument(DB_ID, 'menu_item_categories', ID.unique(), {
        menu_item_id: itemId, category_id: categoryId, sort: 0, active: true,
      }).catch(() => undefined);
    }

    for (const r of d.recipe) {
      await db.createDocument(DB_ID, 'recipes', ID.unique(), {
        menu_item_id: itemId,
        ingredient_id: r.ingredientId,
        qty_per_unit: r.qtyPerUnit,
        wastage_bp: r.wastageBp,
      });
    }
  }
  note('  written');
}

// ---- 4. what is on each shelf on day one ------------------------------------
step('Opening levels');
const levelRead = readLevelImport(csv('opening-levels.csv'), {
  ingredients: ingredients.map((i) => ({ $id: i.$id, name: i.name, unit: i.unit ?? 'each' })),
  locations: locations.map((l) => ({ $id: l.$id, name: l.name })),
});
note(`  ${levelRead.rows.length} items across ${levelRead.matchedPlaces.join(' and ') || 'nothing'}`);
if (levelRead.problems.length) {
  note(`  ${levelRead.problems.length} skipped:`);
  for (const p of levelRead.problems.slice(0, 20)) note(`    line ${p.line}: ${p.message}`);
}

if (write) {
  // No venue_id on a level: it is identified by which thing and which place,
  // and both of those already belong to one venue.
  const levels = await all('stock_levels').catch(() => []);
  for (const row of levelRead.rows) {
    let total = 0;
    for (const l of row.levels) {
      const found = levels.find((x) => x.ingredient_id === row.ingredientId && x.location_id === l.locationId);
      const before = found ? found.qty : 0;
      if (found) await db.updateDocument(DB_ID, 'stock_levels', found.$id, { qty: l.qty });
      else {
        await db.createDocument(DB_ID, 'stock_levels', ID.unique(), {
          ingredient_id: row.ingredientId, location_id: l.locationId, qty: l.qty,
        });
      }
      // A movement for the difference, so the history explains the jump rather
      // than just showing it a year from now.
      if (l.qty !== before) {
        await db.createDocument(DB_ID, 'stock_movements', ID.unique(), {
          venue_id: VENUE,
          ingredient_id: row.ingredientId,
          type: 'count_correction',
          qty_delta: Number((l.qty - before).toFixed(4)),
          unit_cost: 0,
          location_id: l.locationId,
          ref_type: 'import',
          ref_id: 'opening-levels',
          note: 'Opening level set from the bar import',
        }).catch(() => undefined);
      }
      total += l.qty;
    }
    // The total follows from the places; it is never a second record of the
    // same fact.
    await db.updateDocument(DB_ID, 'ingredients', row.ingredientId, {
      current_qty: Number(total.toFixed(4)),
    }).catch(() => undefined);
  }
  note('  set');
}

console.log(
  write
    ? '\nDone. Re-running this changes nothing, which is the point.'
    : '\nNothing was written. Add --write to do it for real.',
);
