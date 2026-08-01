#!/usr/bin/env node
/**
 * Creates the first admin account, adds it to the admins team and writes its
 * staff profile.
 *
 *   npm run seed:admin -- --email you@example.com --name "Owner"
 *
 * Safe to re-run: reuses an existing account rather than failing, and only
 * fills in whichever of the three pieces is missing.
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { Client, Users, Teams, Databases, ID, Query } from 'node-appwrite';
import { DB_ID } from './schema.mjs';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
if (!values.email) {
  console.error('Usage: npm run seed:admin -- --email you@example.com --name "Owner"');
  process.exit(1);
}

const { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY } = process.env;
if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY) {
  console.error('Missing APPWRITE_ENDPOINT / APPWRITE_PROJECT_ID / APPWRITE_API_KEY in .env');
  process.exit(1);
}

const client = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const users = new Users(client);
const teams = new Teams(client);
const db = new Databases(client);

const displayName = values.name || 'Admin';
let password = null;

// ---- the account -----------------------------------------------------------
let user;
const found = await users.list([Query.equal('email', values.email)]);
if (found.total > 0) {
  user = found.users[0];
  console.log(`= Account already exists: ${values.email}`);
} else {
  password = randomBytes(12).toString('base64url');
  user = await users.create(ID.unique(), values.email, undefined, password, displayName);
  console.log(`+ Account created: ${values.email}`);
}

// ---- admins team membership ------------------------------------------------
// Pass the user ID only. Supplying an email here would start Appwrite's
// invitation flow, which needs a redirect URL and sends mail we don't want.
try {
  await teams.createMembership('admins', ['owner'], undefined, user.$id, undefined, undefined, displayName);
  console.log('+ Added to the admins team');
} catch (e) {
  if (e?.code === 409) console.log('= Already in the admins team');
  else throw e;
}

// ---- staff profile ---------------------------------------------------------
const profiles = await db.listDocuments(DB_ID, 'staff_profiles', [Query.equal('user_id', user.$id)]);
if (profiles.total > 0) {
  console.log('= Staff profile already present');
} else {
  await db.createDocument(DB_ID, 'staff_profiles', ID.unique(), {
    user_id: user.$id,
    display_name: displayName,
    role: 'admin',
    active: true,
    can_open_shift: true,
    can_close_shift: true,
    can_void: true,
    can_discount_up_to_bp: 10000,
    can_mark_paid: true,
    can_apply_discount_codes: true,
    can_record_waste: true,
    venue_ids: [], // empty = every venue
  });
  console.log('+ Staff profile created');
}

console.log(`\n✓ Admin ready: ${values.email}`);
if (password) {
  console.log(`\n  TEMPORARY PASSWORD:  ${password}\n`);
  console.log('  Copy it now — it is not stored and cannot be shown again.');
  console.log('  Change it at first login, then enable MFA.');
} else {
  console.log('  Existing account left untouched, including its password.');
  console.log('  Reset it from the Appwrite console if you no longer have it.');
}
