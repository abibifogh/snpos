#!/usr/bin/env node
/**
 * Idempotent Appwrite provisioner for SNPOS.
 *
 *   cp .env.example .env && edit, then:  npm run provision
 *
 * Safe to re-run: creates what is missing, skips what exists, never drops.
 */
import 'dotenv/config';
import { Client, Databases, Storage, Teams, ID, Permission, Role, Query } from 'node-appwrite';
import {
  DB_ID, TEAMS, BUCKETS, COLLECTIONS, FEATURES,
  SEED_ACCOUNTS, SEED_PAYMENT_METHODS, SEED_EXPENSE_CATEGORIES, SEED_INGREDIENT_CATEGORIES,
  SYSTEM_ACCOUNT_CODES,
} from './schema.mjs';

const { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY } = process.env;
if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY) {
  console.error('Missing APPWRITE_ENDPOINT / APPWRITE_PROJECT_ID / APPWRITE_API_KEY. Copy .env.example to .env.');
  process.exit(1);
}

const client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const db = new Databases(client);
const storage = new Storage(client);
const teams = new Teams(client);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (e) => e?.code === 409;
let created = 0;
let skipped = 0;

const log = (icon, msg) => console.log(`${icon} ${msg}`);

/** True when the failure is a dropped connection rather than a rejection. */
const isTransient = (e) =>
  /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|502|503|504/i.test(e?.message || '');

/**
 * Retry a call through transient network failures.
 *
 * Free-tier connections drop regularly, and a provisioning run makes hundreds
 * of calls, without this, one dropped socket half an hour in throws away the
 * whole run.
 */
async function retry(fn, label = '', tries = 5) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransient(e) || i >= tries) throw e;
      const wait = 1000 * 2 ** i;
      log('  …', `${label || 'call'} failed (${e.message}); retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

/**
 * Page through a list endpoint.
 *
 * Appwrite returns 25 rows by default. Reading only the first page made every
 * attribute past the 25th look missing, so a wide collection waited forever for
 * fields that already existed, and re-runs kept recreating them.
 */
async function listAll(fetchPage, key) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const page = await fetchPage([Query.limit(100), Query.offset(offset)]);
    out.push(...page[key]);
    if (page[key].length < 100 || out.length >= page.total) return out;
  }
}

const allAttributes = (colId) => listAll((q) => retry(() => db.listAttributes(DB_ID, colId, q), `list ${colId}`), 'attributes');
const allIndexes = (colId) => listAll((q) => retry(() => db.listIndexes(DB_ID, colId, q), `indexes ${colId}`), 'indexes');
const allDocuments = (colId) => listAll((q) => retry(() => db.listDocuments(DB_ID, colId, q), `docs ${colId}`), 'documents');

/** True when the failure is a plan/quota ceiling rather than a real fault. */
const isPlanLimit = (e) => /maximum number of|limit.*reached|upgrade to increase/i.test(e?.message || '');

/** Run fn, tolerating "already exists". */
async function ensure(label, fn) {
  try {
    await retry(fn, label);
    created++;
    log('  +', label);
  } catch (e) {
    if (exists(e)) {
      skipped++;
      return;
    }
    if (isPlanLimit(e)) {
      throw new Error(
        `${label}: ${e.message}\n` +
          `  This is an Appwrite plan ceiling, not a fault in the schema. Either free up\n` +
          `  an unused resource in the console, or upgrade the project's plan, then re-run.`,
      );
    }
    throw new Error(`${label}: ${e.message}`);
  }
}

/**
 * Create only if it is genuinely missing.
 *
 * `ensure` relies on a 409 conflict to detect "already there", but Appwrite
 * checks plan limits BEFORE it checks the ID, so re-creating something that
 * already exists on a capped plan fails with "maximum number of databases
 * reached" instead. Looking first avoids depending on which check wins.
 */
async function ensureExists(label, getFn, createFn) {
  try {
    await retry(getFn, label);
    skipped++;
    return;
  } catch (e) {
    if (e?.code !== 404) throw new Error(`${label} (checking): ${e.message}`);
  }
  await ensure(label, createFn);
}

/** Map our role strings to Appwrite Permission entries. */
function toPermissions({ read = [], create = [], update = [], delete: del = [] }, teamIds) {
  const role = (r) => {
    if (r === 'any') return Role.any();
    if (r === 'users') return Role.users();
    if (r.startsWith('team:')) return Role.team(teamIds[r.slice(5)]);
    throw new Error(`Unknown role ${r}`);
  };
  return [
    ...read.map((r) => Permission.read(role(r))),
    ...create.map((r) => Permission.create(role(r))),
    ...update.map((r) => Permission.update(role(r))),
    ...del.map((r) => Permission.delete(role(r))),
  ];
}

/** Create one attribute from the compact schema tuple. */
async function createAttribute(colId, tuple) {
  const [key, type, arg, required = false, def] = tuple;
  // Appwrite forbids a default on a required attribute.
  const d = required ? undefined : def;
  const isArray = type.endsWith('[]');
  const base = type.replace('[]', '');

  switch (base) {
    case 's':
      return db.createStringAttribute(DB_ID, colId, key, arg, required, d, isArray);
    case 'i':
      return db.createIntegerAttribute(DB_ID, colId, key, required, undefined, undefined, d, isArray);
    case 'f':
      return db.createFloatAttribute(DB_ID, colId, key, required, undefined, undefined, d, isArray);
    case 'b':
      return db.createBooleanAttribute(DB_ID, colId, key, required, d, isArray);
    case 'd':
      return db.createDatetimeAttribute(DB_ID, colId, key, required, d, isArray);
    case 'e':
      return db.createEnumAttribute(DB_ID, colId, key, arg, required, d, isArray);
    default:
      throw new Error(`Unknown attribute type "${type}" for ${colId}.${key}`);
  }
}

/**
 * Make an attribute optional when the schema says it should be.
 *
 * Attributes that already exist are otherwise left alone, Appwrite will not
 * rebuild one, and re-creating it would throw the column's data away. That is
 * right for size, type and defaults, but it left one kind of drift stuck:
 * a field that used to be required and no longer is.
 *
 * `staff_profiles.user_id` is the case that mattered. A profile is written when
 * somebody is invited, before an account exists to point at, so the field has
 * to be allowed to stay empty. On a database provisioned while it was still
 * required, adding anybody at all failed with "Missing required attribute".
 *
 * Only ever relaxed, never tightened. Making a field required would fail on any
 * row that has left it empty, and taking a whole provisioning run down for it
 * would be worse than the drift.
 */
async function relaxIfNowOptional(colId, tuple, live) {
  const [key, type, arg, required = false, def] = tuple;
  if (required || !live.required) return false;
  if (type.endsWith('[]')) return false;

  const base = type.replace('[]', '');
  const d = def ?? null;
  try {
    switch (base) {
      case 's': await db.updateStringAttribute(DB_ID, colId, key, false, d, arg); break;
      case 'i': await db.updateIntegerAttribute(DB_ID, colId, key, false, live.min, live.max, d); break;
      case 'f': await db.updateFloatAttribute(DB_ID, colId, key, false, live.min, live.max, d); break;
      case 'b': await db.updateBooleanAttribute(DB_ID, colId, key, false, d); break;
      case 'd': await db.updateDatetimeAttribute(DB_ID, colId, key, false, d); break;
      case 'e': await db.updateEnumAttribute(DB_ID, colId, key, arg, false, d); break;
      default: return false;
    }
    log('  ~', `${colId}.${key} is no longer required`);
    return true;
  } catch (e) {
    log('  !', `could not relax ${colId}.${key}: ${e.message}`);
    return false;
  }
}

/**
 * Poll until every listed attribute reports status "available".
 *
 * Appwrite builds attributes in a background queue, so a wide collection on a
 * cold or throttled project can take minutes. The budget scales with the number
 * of attributes rather than being a flat minute, and progress is printed so a
 * long wait doesn't look like a hang.
 */
async function waitForAttributes(colId, keys, timeoutMs) {
  const budget = timeoutMs ?? Math.max(120000, keys.length * 8000);
  const deadline = Date.now() + budget;
  let lastReport = 0;

  while (Date.now() < deadline) {
    const attributes = await allAttributes(colId);
    const byKey = Object.fromEntries(attributes.map((a) => [a.key, a.status]));

    // `failed` and `stuck` never resolve on their own, waiting is pointless.
    const wedged = keys.filter((k) => byKey[k] === 'failed' || byKey[k] === 'stuck');
    if (wedged.length) {
      throw new Error(
        `${colId}: Appwrite reports ${wedged.map((k) => `${k} → ${byKey[k]}`).join(', ')}\n` +
          `  These will not finish on their own. Delete the \`${colId}\` collection in the\n` +
          `  Appwrite console, then re-run; it will be rebuilt cleanly.`,
      );
    }

    const pending = keys.filter((k) => byKey[k] !== 'available');
    if (pending.length === 0) return;

    if (Date.now() - lastReport > 15000) {
      lastReport = Date.now();
      const kinds = [...new Set(pending.map((k) => byKey[k] || 'missing'))].join(', ');
      log('  …', `waiting for ${colId}: ${pending.length} of ${keys.length} attributes [${kinds}]`);
    }
    await sleep(2000);
  }

  const attributes = await allAttributes(colId);
  const byKey = Object.fromEntries(attributes.map((a) => [a.key, a.status]));
  const stuck = keys.filter((k) => byKey[k] !== 'available').map((k) => `${k}(${byKey[k] || 'missing'})`);
  throw new Error(
    `Timed out after ${Math.round(budget / 1000)}s waiting for ${colId}: ${stuck.join(', ')}\n` +
      `  Appwrite is still building these. Re-run; it will resume from here.`,
  );
}

async function main() {
  log('▸', `Provisioning ${APPWRITE_PROJECT_ID} at ${APPWRITE_ENDPOINT}`);

  // ---- teams -------------------------------------------------------------
  const teamIds = {};
  for (const t of TEAMS) {
    try {
      const team = await teams.create(t.id, t.name);
      teamIds[t.id] = team.$id;
      created++;
      log('  +', `team ${t.id}`);
    } catch (e) {
      if (!exists(e)) throw e;
      teamIds[t.id] = t.id;
      skipped++;
    }
  }
  log('✓', 'Teams');

  // ---- database ----------------------------------------------------------
  await ensureExists(
    `database ${DB_ID}`,
    () => db.get(DB_ID),
    () => db.create(DB_ID, 'SNPOS'),
  );

  // ---- collections -------------------------------------------------------
  for (const col of COLLECTIONS) {
    const perms = toPermissions(col.perms, teamIds);
    try {
      await retry(() => db.getCollection(DB_ID, col.id), `collection ${col.id}`);
      // Keep permissions in sync on re-runs.
      await retry(() => db.updateCollection(DB_ID, col.id, col.name, perms, true), `perms ${col.id}`);
      skipped++;
    } catch (e) {
      if (e?.code !== 404) throw new Error(`collection ${col.id} (checking): ${e.message}`);
      await ensure(`collection ${col.id}`, () =>
        db.createCollection(DB_ID, col.id, col.name, perms, true /* documentSecurity */),
      );
    }

    const live = Object.fromEntries((await allAttributes(col.id)).map((a) => [a.key, a]));
    for (const attr of col.attributes) {
      const already = live[attr[0]];
      if (already) {
        if (await relaxIfNowOptional(col.id, attr, already)) created++;
        continue;
      }
      await ensure(`${col.id}.${attr[0]}`, () => createAttribute(col.id, attr));
    }

    if (col.indexes?.length) {
      await waitForAttributes(col.id, col.attributes.map((a) => a[0]));
      const haveIdx = new Set((await allIndexes(col.id)).map((i) => i.key));
      for (const [key, type, attrs, orders] of col.indexes) {
        if (haveIdx.has(key)) continue;
        await ensure(`${col.id}#${key}`, () => db.createIndex(DB_ID, col.id, key, type, attrs, orders));
      }
    }
  }
  log('✓', `Collections (${COLLECTIONS.length})`);

  // ---- buckets -----------------------------------------------------------
  //
  // The design wants one bucket per purpose, so a public menu image and a
  // private expense receipt are separated by the bucket they live in. A plan
  // capped at one bucket makes that impossible, so we fall back to a single
  // shared bucket with FILE-level security: every upload carries its own
  // permissions, which preserves the property that matters (receipts are not
  // world-readable) even though the isolation is weaker.
  let storageMode = 'multi';
  let sharedBucketId = '';

  for (const b of BUCKETS) {
    const perms = toPermissions({ read: b.read, create: b.write, update: b.write, delete: b.write }, teamIds);
    try {
      await ensureExists(
        `bucket ${b.id}`,
        () => storage.getBucket(b.id),
        () => storage.createBucket(b.id, b.name, perms, false, true, b.maxSize, b.extensions, 'gzip', false, true),
      );
    } catch (e) {
      if (!isPlanLimit(e)) throw e;

      // Widen whichever bucket already exists to serve every purpose.
      sharedBucketId = BUCKETS[0].id;
      storageMode = 'single';
      const allExtensions = [...new Set(BUCKETS.flatMap((x) => x.extensions))];
      const maxSize = Math.max(...BUCKETS.map((x) => x.maxSize));
      const sharedPerms = toPermissions(
        {
          read: ['any'], // per-file permissions do the real gating
          create: ['team:cashiers', 'team:managers', 'team:admins'],
          update: ['team:managers', 'team:admins'],
          delete: ['team:managers', 'team:admins'],
        },
        teamIds,
      );
      await retry(
        () =>
          storage.updateBucket(
            sharedBucketId,
            'SNPOS files (shared)',
            sharedPerms,
            true /* fileSecurity, each file carries its own permissions */,
            true,
            maxSize,
            allExtensions,
            'gzip',
            false,
            true,
          ),
        `widen bucket ${sharedBucketId}`,
      );

      log('!', `Plan allows one storage bucket, so all files share \`${sharedBucketId}\`.`);
      log(' ', '  File-level security is on: uploads must set their own permissions.');
      log(' ', '  Menu images stay public; expense receipts stay manager-only.');
      log(' ', '  Upgrading the Appwrite plan later restores separate buckets, re-run then.');
      break;
    }
  }
  log('✓', `Buckets (${storageMode === 'single' ? '1 shared' : BUCKETS.length})`);

  // ---- seed data ---------------------------------------------------------
  await waitForAttributes('settings', COLLECTIONS.find((c) => c.id === 'settings').attributes.map((a) => a[0]));
  await ensure('settings/main', () =>
    db.createDocument(DB_ID, 'settings', 'main', {
      restaurant_name: process.env.RESTAURANT_NAME || 'My Restaurant',
      timezone: process.env.TIMEZONE || 'Africa/Accra',
      currency_code: process.env.CURRENCY_CODE || 'GHS',
      currency_symbol: process.env.CURRENCY_SYMBOL || 'GH₵',
      currency_decimals: 2,
      symbol_position: 'before',
      primary_color: '#0F766E',
      secondary_color: '#F59E0B',
      tax_rate_bp: 0,
      tax_inclusive: true,
      service_charge_bp: 0,
      shift_float_policy: 'zero', // never inherit the previous shift automatically
      shift_float_default: 0,
      kitchen_ack_sla_seconds: 60,
      kitchen_ping_max_level: 4,
      require_reject_reason: true,
      qr_orders_need_approval: false,
      order_number_prefix: 'ORD',
      low_stock_default_bp: 3000,
      stock_variance_threshold_bp: 1000,
      stock_variance_value_floor: 2000,
      expense_approval_threshold: 20000,
      cash_variance_tolerance: 500,
      terminal_idle_lock_seconds: 180,
      storage_mode: storageMode,
      shared_bucket_id: sharedBucketId,
    }),
  );

  await waitForAttributes('accounts', ['code', 'name', 'type', 'system']);
  // `system` marks the accounts the code itself posts to at shift close. The
  // rest are a convenient starting set, Supplies, Transport, Repairs, and a
  // restaurant whose real outgoings are gas refills and okada runs should be
  // able to rename or retire them without asking anybody.
  for (const [code, name, type] of SEED_ACCOUNTS) {
    await ensure(`account ${code}`, () =>
      db.createDocument(DB_ID, 'accounts', ID.unique(), {
        code, name, type, system: SYSTEM_ACCOUNT_CODES.includes(code),
      }),
    );
  }

  // First venue. Every operational record hangs off a venue, so this must exist
  // before payment methods, shifts or orders can be created.
  await waitForAttributes('venues', ['name', 'slug', 'timezone', 'active']);
  const VENUE_ID = process.env.DEFAULT_VENUE_ID || 'main';
  await ensure(`venue ${VENUE_ID}`, () =>
    db.createDocument(DB_ID, 'venues', VENUE_ID, {
      name: process.env.RESTAURANT_NAME || 'My Restaurant',
      slug: VENUE_ID,
      timezone: process.env.TIMEZONE || 'Africa/Accra',
      active: true,
      sort: 0,
      shift_float_policy: 'inherit', // uses the global 'zero' policy
      shift_float_default: 0,
    }),
  );

  await waitForAttributes('payment_methods', ['venue_id', 'name', 'kind', 'enabled', 'sort']);
  const haveMethods = (await allDocuments('payment_methods')).map((d) => d.name);
  for (const m of SEED_PAYMENT_METHODS) {
    if (haveMethods.includes(m.name)) continue;
    await ensure(`payment method ${m.name}`, () =>
      db.createDocument(DB_ID, 'payment_methods', ID.unique(), {
        venue_id: VENUE_ID,
        enabled: true,
        opens_cash_drawer: false,
        requires_reference: false,
        counted_at_close: true,
        gateway: 'none',
        surcharge_bp: 0,
        ...m,
      }),
    );
  }

  // Lists the restaurant will edit: seeded so the app works on day one, keyed
  // so that renaming one later does not orphan the records already filed
  // under it.
  await waitForAttributes('expense_categories', ['key', 'name', 'account_code', 'sort', 'active']);
  const haveExpenseCats = (await allDocuments('expense_categories')).map((d) => d.key);
  for (const c of SEED_EXPENSE_CATEGORIES) {
    if (haveExpenseCats.includes(c.key)) continue;
    await ensure(`expense category ${c.key}`, () =>
      db.createDocument(DB_ID, 'expense_categories', ID.unique(), { ...c, active: true }),
    );
  }

  await waitForAttributes('ingredient_categories', ['key', 'name', 'sort', 'active']);
  const haveIngredientCats = (await allDocuments('ingredient_categories')).map((d) => d.key);
  for (const c of SEED_INGREDIENT_CATEGORIES) {
    if (haveIngredientCats.includes(c.key)) continue;
    await ensure(`ingredient category ${c.key}`, () =>
      db.createDocument(DB_ID, 'ingredient_categories', ID.unique(), { ...c, active: true }),
    );
  }

  // Feature switchboard. Seeded at group level (blank venue_id) so an admin
  // can override any of it per venue later without touching these rows.
  await waitForAttributes('feature_flags', ['key', 'venue_id', 'enabled', 'config']);
  const haveFlags = (await allDocuments('feature_flags')).map((d) => d.key);
  for (const f of FEATURES) {
    if (haveFlags.includes(f.key)) continue;
    await ensure(`feature ${f.key}`, () =>
      db.createDocument(DB_ID, 'feature_flags', ID.unique(), {
        key: f.key,
        venue_id: '',
        enabled: f.enabled,
        config: JSON.stringify(f.config),
      }),
    );
  }

  // Every venue needs at least one pickup point before takeaway can be used.
  await waitForAttributes('pickup_points', ['venue_id', 'name', 'kind', 'active']);
  const havePoints = (await allDocuments('pickup_points')).length;
  if (!havePoints) {
    await ensure('pickup point Front counter', () =>
      db.createDocument(DB_ID, 'pickup_points', ID.unique(), {
        venue_id: VENUE_ID,
        name: 'Front counter',
        kind: 'counter',
        lead_minutes: 0,
        accepts_delivery: false,
        active: true,
        sort: 0,
      }),
    );
  }
  log('✓', 'Seed data');

  log('▸', `Done, ${created} created, ${skipped} already present.`);
  log('▸', 'Next: npm run seed:admin -- --email you@example.com --name "Owner"');
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`);
  console.error('  Re-running is safe, Appwrite creates attributes asynchronously and a cold project sometimes needs a second pass.');
  process.exit(1);
});
