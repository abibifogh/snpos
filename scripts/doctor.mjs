#!/usr/bin/env node
/**
 * Read-only health check. Creates and changes nothing.
 *
 *   npm run doctor
 *
 * Prints what actually exists in Appwrite and, for anything not yet usable,
 * the status Appwrite reports for it — which is the difference between "still
 * building", "wedged", and "rejected".
 */
import 'dotenv/config';
import { Client, Databases, Storage, Teams, Query } from 'node-appwrite';
import { DB_ID, TEAMS, BUCKETS, COLLECTIONS } from './schema.mjs';

const { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY } = process.env;
if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY) {
  console.error('Missing APPWRITE_ENDPOINT / APPWRITE_PROJECT_ID / APPWRITE_API_KEY in .env');
  process.exit(1);
}

const client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const db = new Databases(client);
const storage = new Storage(client);
const teams = new Teams(client);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry transient network failures — free-tier connections drop regularly. */
async function retry(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const transient = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(e?.message || '');
      if (!transient || i >= tries) throw e;
      await sleep(1000 * 2 ** i);
    }
  }
}

/** Page through a list endpoint — Appwrite returns only 25 rows by default. */
async function listAll(fetchPage, key) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const page = await fetchPage([Query.limit(100), Query.offset(offset)]);
    out.push(...page[key]);
    if (page[key].length < 100 || out.length >= page.total) return out;
  }
}

console.log(`▸ Checking ${APPWRITE_PROJECT_ID} at ${APPWRITE_ENDPOINT}\n`);

// ---- teams -----------------------------------------------------------------
let teamsOk = 0;
for (const t of TEAMS) {
  try {
    await retry(() => teams.get(t.id));
    teamsOk++;
  } catch {
    /* missing */
  }
}
console.log(`Teams:   ${teamsOk}/${TEAMS.length}`);

// ---- buckets ---------------------------------------------------------------
let bucketsOk = 0;
for (const b of BUCKETS) {
  try {
    await retry(() => storage.getBucket(b.id));
    bucketsOk++;
  } catch {
    /* missing */
  }
}
console.log(`Buckets: ${bucketsOk}/${BUCKETS.length}`);

// ---- database --------------------------------------------------------------
try {
  await retry(() => db.get(DB_ID));
  console.log(`Database \`${DB_ID}\`: present\n`);
} catch {
  console.log(`Database \`${DB_ID}\`: MISSING — nothing else can exist yet.\n`);
  process.exit(0);
}

// ---- collections -----------------------------------------------------------
const missing = [];
const incomplete = [];
const unhealthy = [];
let complete = 0;

for (const col of COLLECTIONS) {
  let attrs;
  try {
    await retry(() => db.getCollection(DB_ID, col.id));
    attrs = await listAll((q) => retry(() => db.listAttributes(DB_ID, col.id, q)), 'attributes');
  } catch {
    missing.push(col.id);
    continue;
  }

  const byKey = Object.fromEntries(attrs.map((a) => [a.key, a.status]));
  const wanted = col.attributes.map((a) => a[0]);
  const absent = wanted.filter((k) => !(k in byKey));
  const notReady = wanted.filter((k) => k in byKey && byKey[k] !== 'available');

  // Anything Appwrite will never finish on its own needs a human.
  const bad = notReady.filter((k) => byKey[k] === 'failed' || byKey[k] === 'stuck');
  if (bad.length) unhealthy.push({ id: col.id, bad: bad.map((k) => `${k} → ${byKey[k]}`) });

  let idxOk = 0;
  try {
    const have = new Set((await listAll((q) => retry(() => db.listIndexes(DB_ID, col.id, q)), 'indexes')).map((i) => i.key));
    idxOk = (col.indexes || []).filter((i) => have.has(i[0])).length;
  } catch {
    /* leave at 0 */
  }

  const wantIdx = (col.indexes || []).length;
  if (absent.length === 0 && notReady.length === 0 && idxOk === wantIdx) {
    complete++;
  } else {
    incomplete.push({
      id: col.id,
      have: wanted.length - absent.length,
      want: wanted.length,
      building: notReady.length,
      idxOk,
      wantIdx,
      statuses: [...new Set(notReady.map((k) => byKey[k]))],
    });
  }
}

console.log(`Collections complete: ${complete}/${COLLECTIONS.length}`);
if (missing.length) console.log(`  not created yet (${missing.length}): ${missing.join(', ')}`);

if (incomplete.length) {
  console.log(`\n  In progress or partial (${incomplete.length}):`);
  for (const c of incomplete) {
    const s = c.statuses.length ? ` [${c.statuses.join(', ')}]` : '';
    console.log(`    ${c.id}: ${c.have}/${c.want} fields, ${c.building} not ready${s}, ${c.idxOk}/${c.wantIdx} indexes`);
  }
}

if (unhealthy.length) {
  console.log(`\n✗ Needs attention — these will not finish on their own:`);
  for (const u of unhealthy) console.log(`    ${u.id}: ${u.bad.join(', ')}`);
  console.log(`\n  Delete the affected collection in the Appwrite console, then re-run`);
  console.log(`  \`npm run provision\` — it will rebuild it cleanly.`);
} else if (incomplete.length || missing.length) {
  console.log(`\n▸ Nothing is broken. Re-run \`npm run provision\` to continue where it stopped.`);
} else {
  console.log(`\n✓ Everything present and available.`);
}
