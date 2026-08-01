#!/usr/bin/env node
/**
 * Creates the first admin account, adds it to the admins team and writes its
 * staff profile.
 *
 *   pnpm seed:admin --email you@example.com --name "Owner"
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { Client, Users, Teams, Databases, ID } from 'node-appwrite';
import { DB_ID } from './schema.mjs';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
if (!values.email) {
  console.error('Usage: pnpm seed:admin --email you@example.com --name "Owner"');
  process.exit(1);
}

const client = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

const users = new Users(client);
const teams = new Teams(client);
const db = new Databases(client);

const password = randomBytes(12).toString('base64url');
const displayName = values.name || 'Admin';

const user = await users.create(ID.unique(), values.email, undefined, password, displayName);
await teams.createMembership('admins', ['owner'], values.email, user.$id, undefined, undefined, displayName);

await db.createDocument(DB_ID, 'staff_profiles', ID.unique(), {
  user_id: user.$id,
  display_name: displayName,
  role: 'admin',
  active: true,
  can_open_shift: true,
  can_close_shift: true,
  can_void: true,
  can_discount_up_to_bp: 10000,
});

console.log(`✓ Admin created: ${values.email}`);
console.log(`  Temporary password: ${password}`);
console.log('  Change it at first login, then enable MFA.');
