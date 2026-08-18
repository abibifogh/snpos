#!/usr/bin/env node
/**
 * Take the whole database out of Appwrite, into files you can hold.
 *
 *   npm run export                  everything, into ./export/
 *   npm run export -- --out=/tmp/x  somewhere else
 *   npm run export -- --files       fetch the uploaded receipts and photos too
 *
 * Reads. Writes nothing back. Safe to run during service, though it is a lot
 * of reading, so prefer a quiet hour.
 *
 * Why this exists at all
 * ----------------------
 * For most of this project's life there was no way to get the data out. Every
 * order, every stock count, every month of accounts existed in exactly one
 * place, and the only thing standing between the restaurant and losing all of
 * it was somebody else's uptime and a subscription being paid on time.
 *
 * That is a bad position on an ordinary Tuesday. It is an unacceptable one
 * when the plan is to move hosting and then CANCEL the old account, because
 * cancelling deletes the data — so the last honest chance to check the new
 * system against the old one disappears at exactly the moment you would want
 * it. A migration without an export in hand is a one-way door.
 *
 * What comes out
 * --------------
 * One JSON file per collection, plus a manifest. JSON because it is the
 * format the data already is, and because it can be read by anything —
 * another database, a spreadsheet tool, a person with a text editor. Nothing
 * here is specific to Appwrite or to whatever replaces it.
 *
 * Appwrite's own fields ($id, $createdAt, $permissions...) are KEPT. $id is
 * what every row pointing at another row uses: strip it and the orders no
 * longer know their own lines. An import elsewhere can ignore what it does
 * not want; it cannot invent what was thrown away.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Client, Databases, Storage, Query } from 'node-appwrite';
import { DB_ID, BUCKETS, COLLECTIONS } from './schema.mjs';

const { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY } = process.env;
if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY) {
  console.error('Missing APPWRITE_ENDPOINT / APPWRITE_PROJECT_ID / APPWRITE_API_KEY in .env');
  process.exit(1);
}

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const outDir = arg('out', 'export');
const withFiles = args.includes('--files');

const client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const db = new Databases(client);
const storage = new Storage(client);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry transient failures, and back off properly on a rate limit.
 *
 * An export is the most read-heavy thing this project does, so it is the most
 * likely to meet a usage cap or a throttle part-way through. Half an export is
 * worse than none: it looks finished. So a refusal that might pass is waited
 * out rather than raced.
 */
async function retry(fn, label, tries = 6) {
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

/**
 * Every row in a collection, oldest first.
 *
 * Ordered by creation and paged by a CURSOR rather than an offset, because
 * offset paging re-reads from the top of the list each time — on a table of
 * eighty thousand orders that is its own reason to run out of allowance. A
 * cursor asks for "the next hundred after this one" and reads each row once.
 */
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

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync(outDir, { recursive: true });

console.log(`▸ Exporting ${APPWRITE_PROJECT_ID} to ${outDir}/\n`);

/* ------------------------------------------------------------------ the rows */

const manifest = {
  exported_at: new Date().toISOString(),
  endpoint: APPWRITE_ENDPOINT,
  project: APPWRITE_PROJECT_ID,
  database: DB_ID,
  collections: [],
  buckets: [],
  // Anything that could not be read, named. An export that quietly skipped a
  // collection would be trusted, and that is the whole danger.
  failures: [],
};

let total = 0;
for (const col of COLLECTIONS) {
  try {
    const rows = await allDocuments(col.id);
    writeFileSync(join(outDir, `${col.id}.json`), `${JSON.stringify(rows, null, 2)}\n`);
    manifest.collections.push({ id: col.id, name: col.name, rows: rows.length });
    total += rows.length;
    console.log(`  ${rows.length === 0 ? ' ' : '✓'} ${col.id.padEnd(28)} ${rows.length}`);
  } catch (e) {
    // A collection that does not exist yet is not a failure — the schema runs
    // ahead of what has been provisioned, routinely.
    const missing = /could not be found|not found/i.test(e.message);
    if (missing) {
      console.log(`  · ${col.id.padEnd(28)} not provisioned yet`);
      continue;
    }
    manifest.failures.push({ collection: col.id, error: e.message });
    console.log(`  ✗ ${col.id.padEnd(28)} ${e.message}`);
  }
}

/* -------------------------------------------------------------- the uploads */

/**
 * The receipts and photos, only when asked for.
 *
 * Off by default because it is slow and large, and because the rows are the
 * urgent part: a missing receipt photo is an inconvenience, a missing month of
 * sales is the business. Turn it on for the export you keep before cancelling
 * anything.
 */
if (withFiles) {
  console.log('');
  for (const b of BUCKETS) {
    const dir = join(outDir, 'files', b.id);
    mkdirSync(dir, { recursive: true });
    let got = 0;
    try {
      let cursor = null;
      for (;;) {
        const q = [Query.limit(100)];
        if (cursor) q.push(Query.cursorAfter(cursor));
        const page = await retry(() => storage.listFiles(b.id, q), `listing ${b.id}`);
        for (const f of page.files) {
          const bytes = await retry(() => storage.getFileDownload(b.id, f.$id), `file ${f.$id}`);
          // The SDK hands back an ArrayBuffer here and a stream there
          // depending on version; both end up on disk the same way.
          if (bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes)) {
            writeFileSync(join(dir, f.$id), Buffer.from(bytes));
          } else {
            await pipeline(Readable.fromWeb ? Readable.fromWeb(bytes) : bytes, createWriteStream(join(dir, f.$id)));
          }
          got += 1;
        }
        if (page.files.length < 100) break;
        cursor = page.files[page.files.length - 1].$id;
      }
      // The names live here: the files themselves are stored under ids, so
      // without this list a folder of downloads is unreadable.
      const index = await retry(() => storage.listFiles(b.id, [Query.limit(100)]), `indexing ${b.id}`);
      writeFileSync(join(dir, '_index.json'), `${JSON.stringify(index.files, null, 2)}\n`);
      manifest.buckets.push({ id: b.id, files: got });
      console.log(`  ✓ ${b.id.padEnd(28)} ${got} file(s)`);
    } catch (e) {
      manifest.failures.push({ bucket: b.id, error: e.message });
      console.log(`  ✗ ${b.id.padEnd(28)} ${e.message}`);
    }
  }
}

/* ---------------------------------------------------------------- the ledger */

writeFileSync(join(outDir, '_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(outDir, '_schema.json'), `${JSON.stringify(COLLECTIONS, null, 2)}\n`);

console.log(`\n▸ ${total} rows across ${manifest.collections.length} collections, at ${stamp}`);
if (manifest.failures.length) {
  console.error(`\n✗ ${manifest.failures.length} could not be read. This export is INCOMPLETE:`);
  for (const f of manifest.failures) console.error(`    ${f.collection ?? f.bucket}: ${f.error}`);
  console.error('\nDo not treat this as a backup, and do not cancel anything on the strength of it.');
  process.exit(1);
}
console.log('✓ complete');
