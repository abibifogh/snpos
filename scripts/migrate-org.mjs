#!/usr/bin/env node
/**
 * Turn one restaurant into the first hotel on a shared system.
 *
 *   node scripts/migrate-org.mjs --name "Abibi Fo Bistro" --slug abibifo --email you@example.com
 *   node scripts/migrate-org.mjs --dry-run            # count what would change
 *
 * What it does, in this order and no other:
 *
 *   1. Creates the Appwrite team that will own this hotel's data.
 *   2. Creates the `organisations` row pointing at that team.
 *   3. Stamps `org_id` onto every existing document in every collection.
 *   4. Rewrites each document's permissions so only that team may read it.
 *
 * Safe to re-run. Every step checks before it acts, and a document that
 * already carries the right org is skipped, so a run that dies halfway
 * through a connection wobble is fixed by running it again, not by unpicking
 * anything.
 *
 * Nothing is deleted and nothing is moved. If this goes wrong the data is
 * exactly where it was; only two fields on each row will have changed.
 */
import 'dotenv/config';
import { Client, Databases, Teams, ID, Permission, Role, Query } from 'node-appwrite';
import { DB_ID, COLLECTIONS, ORG_EXEMPT } from './schema.mjs';

const { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY } = process.env;
if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY) {
  console.error('Missing APPWRITE_ENDPOINT / APPWRITE_PROJECT_ID / APPWRITE_API_KEY.');
  process.exit(1);
}

const args = Object.fromEntries(
  process.argv.slice(2).reduce((out, arg, i, all) => {
    if (!arg.startsWith('--')) return out;
    const key = arg.slice(2);
    const next = all[i + 1];
    out.push([key, !next || next.startsWith('--') ? true : next]);
    return out;
  }, []),
);

const DRY = !!args['dry-run'];
const NAME = args.name || process.env.RESTAURANT_NAME || 'My Restaurant';
const SLUG = String(args.slug || 'main').toLowerCase().replace(/[^a-z0-9-]/g, '');
const EMAIL = args.email || process.env.ADMIN_EMAIL || '';

if (!DRY && !EMAIL) {
  console.error('Give the owner\'s email: --email you@example.com');
  process.exit(1);
}

const client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const db = new Databases(client);
const teams = new Teams(client);

const log = (icon, msg) => console.log(`${icon} ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every document in a collection, a page at a time. */
async function* everyDocument(collectionId) {
  let cursor = null;
  for (;;) {
    const queries = [Query.limit(100), ...(cursor ? [Query.cursorAfter(cursor)] : [])];
    let page;
    try {
      page = await db.listDocuments(DB_ID, collectionId, queries);
    } catch (e) {
      log('  !', `${collectionId}: ${e.message}`);
      return;
    }
    if (page.documents.length === 0) return;
    for (const doc of page.documents) yield doc;
    if (page.documents.length < 100) return;
    cursor = page.documents[page.documents.length - 1].$id;
  }
}

async function main() {
  log('▸', DRY ? 'Dry run; nothing will be written' : `Making "${NAME}" the first organisation`);

  // ---- the team ----------------------------------------------------------
  const teamId = `org-${SLUG}`;
  if (!DRY) {
    try {
      await teams.create(teamId, `${NAME} (organisation)`);
      log('  +', `team ${teamId}`);
    } catch (e) {
      if (e?.code !== 409) throw e;
      log('  =', `team ${teamId} already there`);
    }
  }

  // ---- the organisation row ---------------------------------------------
  let orgId = null;
  if (!DRY) {
    const existing = await db
      .listDocuments(DB_ID, 'organisations', [Query.equal('slug', SLUG), Query.limit(1)])
      .catch(() => ({ documents: [] }));

    if (existing.documents.length) {
      orgId = existing.documents[0].$id;
      log('  =', `organisation ${SLUG} already there`);
    } else {
      const trialEnds = new Date(Date.now() + 90 * 86_400_000).toISOString();
      const doc = await db.createDocument(DB_ID, 'organisations', ID.unique(), {
        name: NAME,
        slug: SLUG,
        team_id: teamId,
        // The first hotel is the one that built the thing. It is not on trial.
        status: 'active',
        plan: 'founder',
        trial_ends_at: trialEnds,
        owner_email: EMAIL,
        tools: ['pos'],
        note: 'The original installation, migrated to a shared system.',
      });
      orgId = doc.$id;
      log('  +', `organisation ${SLUG} (${orgId})`);
    }
  }

  // ---- stamp everything --------------------------------------------------
  const readers = orgId ? [Permission.read(Role.team(teamId)), Permission.update(Role.team(teamId)), Permission.delete(Role.team(teamId))] : [];

  let touched = 0;
  let skipped = 0;
  let failed = 0;

  for (const col of COLLECTIONS) {
    if (ORG_EXEMPT.includes(col.id)) continue;

    let n = 0;
    for await (const doc of everyDocument(col.id)) {
      if (doc.org_id === orgId && orgId) { skipped++; continue; }
      n++;
      if (DRY) { touched++; continue; }

      try {
        // The permissions go on in the same call as the field. Two calls would
        // leave a window in which a row is stamped but still readable by
        // everybody, and that window is exactly what this exists to close.
        //
        // A guest's own read permission on their order is deliberately dropped:
        // those orders are hours old by the time this runs, and a stale guest
        // grant on a shared database outlives the meal by years.
        await db.updateDocument(DB_ID, col.id, doc.$id, { org_id: orgId }, readers);
        touched++;
      } catch (e) {
        failed++;
        if (failed < 10) log('  !', `${col.id}/${doc.$id}: ${e.message}`);
      }
      // Free-tier projects rate-limit hard; this is a background job, not a
      // race. Better to take ten minutes than to be throttled into failure.
      if (touched % 50 === 0) await sleep(250);
    }
    if (n > 0) log('  ·', `${col.id}: ${n}`);
  }

  console.log('');
  log('✓', DRY
    ? `${touched} documents would be stamped`
    : `${touched} stamped, ${skipped} already done, ${failed} failed`);

  if (!DRY && failed > 0) {
    log('!', 'Some rows did not take. Run this again, it resumes where it left off.');
    process.exit(1);
  }
  if (!DRY) {
    console.log('');
    log('▸', 'Next: add yourself to the organisation team in the Appwrite console,');
    log(' ', `   then switch the apps from { mode: 'single' } to the org lookup.`);
  }
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
});
