#!/usr/bin/env node
/**
 * Idempotent Appwrite provisioner for SNPOS.
 *
 *   cp .env.example .env && edit, then:  npm run provision
 *
 * Safe to re-run: creates what is missing, skips what exists, never drops.
 */
import 'dotenv/config';
import { Client, Databases, Storage, Teams, ID, Permission, Role } from 'node-appwrite';
import { DB_ID, TEAMS, BUCKETS, COLLECTIONS, FEATURES, SEED_ACCOUNTS, SEED_PAYMENT_METHODS } from './schema.mjs';

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

/** Run fn, tolerating "already exists". */
async function ensure(label, fn) {
  try {
    await fn();
    created++;
    log('  +', label);
  } catch (e) {
    if (exists(e)) {
      skipped++;
      return;
    }
    throw new Error(`${label}: ${e.message}`);
  }
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

/** Poll until every listed attribute reports status "available". */
async function waitForAttributes(colId, keys, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { attributes } = await db.listAttributes(DB_ID, colId);
    const byKey = Object.fromEntries(attributes.map((a) => [a.key, a.status]));
    const pending = keys.filter((k) => byKey[k] !== 'available');
    if (pending.length === 0) return;
    await sleep(1500);
  }
  throw new Error(`Timed out waiting for attributes on ${colId}`);
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
  await ensure(`database ${DB_ID}`, () => db.create(DB_ID, 'SNPOS'));

  // ---- collections -------------------------------------------------------
  for (const col of COLLECTIONS) {
    const perms = toPermissions(col.perms, teamIds);
    try {
      await db.createCollection(DB_ID, col.id, col.name, perms, true /* documentSecurity */);
      created++;
      log('  +', `collection ${col.id}`);
    } catch (e) {
      if (!exists(e)) throw e;
      // Keep permissions in sync on re-runs.
      await db.updateCollection(DB_ID, col.id, col.name, perms, true);
      skipped++;
    }

    const existing = new Set((await db.listAttributes(DB_ID, col.id)).attributes.map((a) => a.key));
    for (const attr of col.attributes) {
      if (existing.has(attr[0])) continue;
      await ensure(`${col.id}.${attr[0]}`, () => createAttribute(col.id, attr));
    }

    if (col.indexes?.length) {
      await waitForAttributes(col.id, col.attributes.map((a) => a[0]));
      const haveIdx = new Set((await db.listIndexes(DB_ID, col.id)).indexes.map((i) => i.key));
      for (const [key, type, attrs, orders] of col.indexes) {
        if (haveIdx.has(key)) continue;
        await ensure(`${col.id}#${key}`, () => db.createIndex(DB_ID, col.id, key, type, attrs, orders));
      }
    }
  }
  log('✓', `Collections (${COLLECTIONS.length})`);

  // ---- buckets -----------------------------------------------------------
  for (const b of BUCKETS) {
    const perms = toPermissions({ read: b.read, create: b.write, update: b.write, delete: b.write }, teamIds);
    await ensure(`bucket ${b.id}`, () =>
      storage.createBucket(b.id, b.name, perms, false, true, b.maxSize, b.extensions, 'gzip', false, true),
    );
  }
  log('✓', 'Buckets');

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
    }),
  );

  await waitForAttributes('accounts', ['code', 'name', 'type', 'system']);
  for (const [code, name, type] of SEED_ACCOUNTS) {
    await ensure(`account ${code}`, () =>
      db.createDocument(DB_ID, 'accounts', ID.unique(), { code, name, type, system: true }),
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
  const haveMethods = (await db.listDocuments(DB_ID, 'payment_methods')).documents.map((d) => d.name);
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

  // Feature switchboard. Seeded at group level (blank venue_id) so an admin
  // can override any of it per venue later without touching these rows.
  await waitForAttributes('feature_flags', ['key', 'venue_id', 'enabled', 'config']);
  const haveFlags = (await db.listDocuments(DB_ID, 'feature_flags')).documents.map((d) => d.key);
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
  const havePoints = (await db.listDocuments(DB_ID, 'pickup_points')).documents.length;
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

  log('▸', `Done — ${created} created, ${skipped} already present.`);
  log('▸', 'Next: npm run seed:admin -- --email you@example.com --name "Owner"');
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`);
  console.error('  Re-running is safe — Appwrite creates attributes asynchronously and a cold project sometimes needs a second pass.');
  process.exit(1);
});
