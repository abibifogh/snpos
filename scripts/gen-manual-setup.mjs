/**
 * Generates docs/15-manual-console-setup.md — a complete click-by-click guide
 * for building the schema by hand in the Appwrite console.
 *
 * Derived from schema.mjs so it can never drift from what provision.mjs does.
 * Re-run with: node scripts/gen-manual-setup.mjs
 */
import { writeFileSync } from 'node:fs';
import {
  DB_ID, TEAMS, BUCKETS, COLLECTIONS, FEATURES, SEED_ACCOUNTS, SEED_PAYMENT_METHODS,
} from './schema.mjs';

const TYPE_LABEL = { s: 'String', i: 'Integer', f: 'Float', b: 'Boolean', d: 'Datetime', e: 'Enum' };

/** Console-friendly description of one attribute tuple. */
function describe([key, type, arg, required = false, def]) {
  const isArray = type.endsWith('[]');
  const base = type.replace('[]', '');
  const label = TYPE_LABEL[base] || base;

  let size = '';
  if (base === 's') size = `size ${arg}`;
  else if (base === 'e') size = arg.map((v) => (v === '' ? '(blank)' : v)).join(', ');

  // Appwrite forbids a default on a required attribute — mirror provision.mjs.
  const shown = required ? '—' : def === undefined ? '—' : String(def);
  return {
    key,
    type: label,
    size,
    required: required ? '**Yes**' : 'No',
    def: shown,
    array: isArray ? 'Yes' : 'No',
  };
}

const roleLabel = (r) =>
  r === 'any' ? 'Any' : r === 'users' ? 'All users' : r.startsWith('team:') ? `Team: ${r.slice(5)}` : r;

function permLine(perms) {
  const parts = [];
  for (const action of ['read', 'create', 'update', 'delete']) {
    const roles = perms[action] || [];
    parts.push(
      `**${action[0].toUpperCase() + action.slice(1)}**: ` +
        (roles.length ? roles.map(roleLabel).join(', ') : '_none — server only_'),
    );
  }
  return parts.join(' · ');
}

const out = [];
const p = (s = '') => out.push(s);

const totalAttrs = COLLECTIONS.reduce((n, c) => n + c.attributes.length, 0);
const totalIdx = COLLECTIONS.reduce((n, c) => n + (c.indexes || []).length, 0);

p('# 15 — Manual setup in the Appwrite console');
p('');
p('Everything to create by hand, in order. Generated from `scripts/schema.mjs`,');
p('so it matches exactly what `npm run provision` would have built.');
p('');
p('> **Before you start, read this.**');
p('>');
p(`> This is **${COLLECTIONS.length} collections, ${totalAttrs} fields and ${totalIdx} indexes**. Entered by hand at a`);
p('> realistic pace that is somewhere between 8 and 15 hours of clicking, and a');
p('> single mistyped field name will surface later as a broken screen rather than');
p('> an error at the time. The script does the same work in about four minutes and');
p('> is safe to re-run.');
p('>');
p('> If the terminal is the obstacle, the shortest path is still');
p('> `npm run provision` on any computer (see doc 08, Stage 2) — it needs Node');
p('> installed and nothing else. This document exists because you asked for it, and');
p('> it is complete and correct; it is just the expensive way to get there.');
p('>');
p('> **Work top to bottom.** Later steps reference IDs created in earlier ones.');
p('');
p('**Conventions used below**');
p('');
p('- **ID** means the "Collection ID" / "Attribute Key" field — type it exactly,');
p('  lowercase, underscores not spaces. The apps look these up by ID.');
p('- **Required** columns marked **Yes** must be ticked. Appwrite will not let you');
p('  set a default on a required field — that is expected, not a mistake.');
p('- **Default `—`** means leave the default box empty.');
p('- **Array Yes** means tick "Array".');
p('- Enum values are comma-separated; enter them one per row in the console.');
p('  A value shown as `(blank)` means add an empty option.');
p('');
p('---');
p('');

// ---------------------------------------------------------------- Stage 1
p('## Stage 1 — Project settings');
p('');
p('In your existing project (ID `6a6e308e00234b152989`, Frankfurt region):');
p('');
p('1. **Settings → Platforms → Add platform → Web app**, four times:');
p('');
p('   | Name | Hostname (for now) |');
p('   | --- | --- |');
p('   | `menu` | `localhost` |');
p('   | `pos` | `localhost` |');
p('   | `kds` | `localhost` |');
p('   | `admin` | `localhost` |');
p('');
p('   Add the real domains later. Appwrite rejects connections from any origin');
p('   not listed here, so skipping this makes everything fail with a CORS error.');
p('');
p('2. **Auth → Settings**:');
p('   - Enable **Email/Password**.');
p('   - Enable **Anonymous** — the customer QR menu needs it; without it, guests');
p('     cannot order at all.');
p('   - Set **Session length** to 1 year (staff devices stay logged in).');
p('   - Disable every provider you do not use.');
p('');
p('3. **Settings → API keys → Create API key**, name `server-functions`, scopes:');
p('   `databases.read`, `databases.write`, `collections.read`, `collections.write`,');
p('   `attributes.read`, `attributes.write`, `indexes.read`, `indexes.write`,');
p('   `documents.read`, `documents.write`, `users.read`, `users.write`,');
p('   `teams.read`, `teams.write`, `files.read`, `files.write`.');
p('   Copy the secret immediately — it is shown once.');
p('');
p('---');
p('');

// ---------------------------------------------------------------- Stage 2
p('## Stage 2 — Teams');
p('');
p('**Auth → Teams → Create team**, five times. The Team ID matters — permissions');
p('below refer to it.');
p('');
p('| Team ID | Name |');
p('| --- | --- |');
for (const t of TEAMS) p(`| \`${t.id}\` | ${t.name} |`);
p('');
p('---');
p('');

// ---------------------------------------------------------------- Stage 3
p('## Stage 3 — Storage buckets');
p('');
p('**Storage → Create bucket**, three times.');
p('');
for (const b of BUCKETS) {
  p(`### Bucket \`${b.id}\` — ${b.name}`);
  p('');
  p(`- **Maximum file size**: ${Math.round(b.maxSize / 1024 / 1024)} MB`);
  p(`- **Allowed file extensions**: ${b.extensions.join(', ')}`);
  p(`- **Permissions** — Read: ${b.read.map(roleLabel).join(', ')} · Create/Update/Delete: ${b.write.map(roleLabel).join(', ')}`);
  p('- Leave encryption and antivirus on (the defaults).');
  p('');
}
p('---');
p('');

// ---------------------------------------------------------------- Stage 4
p('## Stage 4 — Database');
p('');
p(`**Databases → Create database** → Name \`NiceOps POS\`, **Database ID \`${DB_ID}\`**.`);
p('');
p('The ID must be exactly this — the apps read it from `DB_ID` in the settings');
p('file and will not find anything otherwise.');
p('');
p('---');
p('');

// ---------------------------------------------------------------- Stage 5
p('## Stage 5 — Collections');
p('');
p('For each collection below:');
p('');
p('1. **Create collection** with the exact **Collection ID** shown.');
p('2. Open **Settings → Permissions** and set the four rows as listed.');
p('3. Add every attribute from the table, in order.');
p('4. Add every index from the index table.');
p('');
p('Attributes are created asynchronously. If an index refuses to save with');
p('"attribute not available", wait ten seconds and try again — the attribute is');
p('still being built.');
p('');
p(`There are ${COLLECTIONS.length} collections. A progress checklist is at the end of this document.`);
p('');

let n = 0;
for (const c of COLLECTIONS) {
  n += 1;
  p('---');
  p('');
  p(`### ${n}. \`${c.id}\` — ${c.name}`);
  p('');
  p(permLine(c.perms));
  p('');
  p(`**Attributes** (${c.attributes.length})`);
  p('');
  p('| Key | Type | Size / Enum values | Required | Default | Array |');
  p('| --- | --- | --- | --- | --- | --- |');
  for (const a of c.attributes) {
    const d = describe(a);
    p(`| \`${d.key}\` | ${d.type} | ${d.size || '—'} | ${d.required} | ${d.def} | ${d.array} |`);
  }
  p('');
  if (c.indexes && c.indexes.length) {
    p(`**Indexes** (${c.indexes.length})`);
    p('');
    p('| Index key | Type | Attributes (in this order) |');
    p('| --- | --- | --- |');
    for (const [key, type, cols] of c.indexes) {
      p(`| \`${key}\` | ${type} | ${cols.map((x) => `\`${x}\``).join(', ')} |`);
    }
    p('');
  } else {
    p('**Indexes**: none.');
    p('');
  }
}

// ---------------------------------------------------------------- Stage 6
p('---');
p('');
p('## Stage 6 — Seed documents');
p('');
p('These rows must exist before the apps will run. Create them from');
p('**Databases → snpos → [collection] → Add document**.');
p('');

p('### 6.1 `settings` — one document, ID `main`');
p('');
p('Set the **Document ID** to `main` manually (do not let it auto-generate).');
p('Fill every required field; the values below are sensible starting points and');
p('can all be changed later in the admin screens.');
p('');
p('| Field | Value |');
p('| --- | --- |');
const settingsSeed = [
  ['restaurant_name', 'My Restaurant'], ['timezone', 'Africa/Accra'], ['currency_code', 'GHS'],
  ['currency_symbol', 'GH₵'], ['currency_decimals', '2'], ['symbol_position', 'before'],
  ['primary_color', '#0F766E'], ['secondary_color', '#F59E0B'], ['tax_rate_bp', '0'],
  ['tax_inclusive', 'true'], ['service_charge_bp', '0'], ['shift_float_policy', 'zero'],
  ['shift_float_default', '0'], ['kitchen_ack_sla_seconds', '60'], ['kitchen_ping_max_level', '4'],
  ['require_reject_reason', 'true'], ['qr_orders_need_approval', 'false'],
  ['low_stock_default_bp', '3000'], ['stock_variance_threshold_bp', '1000'],
  ['stock_variance_value_floor', '2000'], ['expense_approval_threshold', '20000'],
  ['cash_variance_tolerance', '500'], ['terminal_idle_lock_seconds', '180'],
];
for (const [k, v] of settingsSeed) p(`| \`${k}\` | \`${v}\` |`);
p('');
p('Leave the rest blank for now.');
p('');

p('### 6.2 `venues` — one document, ID `main`');
p('');
p('Set the **Document ID** to `main`.');
p('');
p('| Field | Value |');
p('| --- | --- |');
p('| `name` | `My Restaurant` |');
p('| `slug` | `main` |');
p('| `timezone` | `Africa/Accra` |');
p('| `active` | `true` |');
p('| `sort` | `0` |');
p('| `shift_float_policy` | `inherit` |');
p('| `shift_float_default` | `0` |');
p('');
p('Add `opening_hours` later from the admin screens — it is JSON and far easier');
p('to set there than by hand here.');
p('');

p('### 6.3 `accounts` — 20 documents (chart of accounts)');
p('');
p('Auto-generated Document IDs are fine. Set `system` to `true` on all of them.');
p('');
p('| code | name | type |');
p('| --- | --- | --- |');
for (const [code, name, type] of SEED_ACCOUNTS) p(`| \`${code}\` | ${name} | \`${type}\` |`);
p('');

p('### 6.4 `payment_methods` — 2 documents');
p('');
p('| venue_id | name | kind | sort | opens_cash_drawer | requires_reference | counted_at_close | enabled | gateway | surcharge_bp |');
p('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const m of SEED_PAYMENT_METHODS) {
  p(
    `| \`main\` | ${m.name} | \`${m.kind}\` | ${m.sort} | ${m.opens_cash_drawer ? 'true' : 'false'} | ` +
      `${m.requires_reference ? 'true' : 'false'} | ${m.counted_at_close ? 'true' : 'false'} | true | \`none\` | 0 |`,
  );
}
p('');

p('### 6.5 `pickup_points` — 1 document');
p('');
p('| Field | Value |');
p('| --- | --- |');
p('| `venue_id` | `main` |');
p('| `name` | `Front counter` |');
p('| `kind` | `counter` |');
p('| `lead_minutes` | `0` |');
p('| `accepts_delivery` | `false` |');
p('| `active` | `true` |');
p('| `sort` | `0` |');
p('');

p(`### 6.6 \`feature_flags\` — ${FEATURES.length} documents`);
p('');
p('One per feature. Leave `venue_id` **blank** — that makes each row the');
p('group-wide default. `config` is a JSON string: copy the whole block from the');
p('`config` column into the field as-is, including the outer braces.');
p('');
p('| key | enabled | config (paste as one line) |');
p('| --- | --- | --- |');
for (const f of FEATURES) {
  p(`| \`${f.key}\` | \`${f.enabled}\` | \`${JSON.stringify(f.config)}\` |`);
}
p('');
p('If pasting that much JSON is painful, you can set `config` to `{}` for now and');
p('edit the options in the admin screens once the apps are running — the code');
p('falls back to the defaults in `scripts/schema.mjs` for anything missing.');
p('');

// ---------------------------------------------------------------- Stage 7
p('---');
p('');
p('## Stage 7 — First admin user');
p('');
p('1. **Auth → Users → Create user** with your email, a name, and a password.');
p('2. Copy the resulting **User ID**.');
p('3. **Auth → Teams → admins → Add membership** → that user.');
p('4. **Databases → snpos → staff_profiles → Add document**:');
p('');
p('| Field | Value |');
p('| --- | --- |');
p('| `user_id` | the User ID from step 2 |');
p('| `display_name` | your name |');
p('| `role` | `admin` |');
p('| `active` | `true` |');
p('| `can_open_shift` | `true` |');
p('| `can_close_shift` | `true` |');
p('| `can_void` | `true` |');
p('| `can_discount_up_to_bp` | `10000` |');
p('| `venue_ids` | leave empty — empty means all venues |');
p('');
p('**Verify:** you can log into the admin app and see Settings.');
p('');

// ---------------------------------------------------------------- checklist
p('---');
p('');
p('## Progress checklist');
p('');
p('Tick these off as you go — it is a long job and losing your place is the main');
p('way mistakes creep in.');
p('');
p('- [ ] Stage 1 — platforms, auth, API key');
p('- [ ] Stage 2 — 5 teams');
p('- [ ] Stage 3 — 3 buckets');
p('- [ ] Stage 4 — database `snpos`');
p('');
p('**Stage 5 — collections**');
p('');
let i = 0;
for (const c of COLLECTIONS) {
  i += 1;
  p(`- [ ] ${String(i).padStart(2, ' ')}. \`${c.id}\` (${c.attributes.length} fields, ${(c.indexes || []).length} indexes)`);
}
p('');
p('**Stage 6 — seed documents**');
p('');
p('- [ ] `settings/main`');
p('- [ ] `venues/main`');
p('- [ ] 20 × `accounts`');
p('- [ ] 2 × `payment_methods`');
p('- [ ] 1 × `pickup_points`');
p(`- [ ] ${FEATURES.length} × \`feature_flags\``);
p('');
p('**Stage 7**');
p('');
p('- [ ] admin user + team membership + `staff_profiles` row');
p('');
p('---');
p('');
p('## When you are done');
p('');
p('Sanity-check before building on top of it:');
p('');
p(`1. The \`${DB_ID}\` database lists **${COLLECTIONS.length} collections**.`);
p('2. `settings/main` exists and `shift_float_policy` reads `zero`.');
p('3. `venues/main` exists and is active.');
p(`4. \`feature_flags\` holds **${FEATURES.length} rows**, each with a blank \`venue_id\`.`);
p('5. `accounts` holds **20 rows**.');
p('');
p('If you later get access to a terminal, running `npm run provision` against');
p('this same project is still safe — it creates only what is missing and reports');
p('the rest as already present. It is a good way to catch anything mistyped here.');
p('');

writeFileSync(new URL('../docs/15-manual-console-setup.md', import.meta.url), out.join('\n'));
console.log(`Wrote docs/15-manual-console-setup.md — ${COLLECTIONS.length} collections, ${totalAttrs} attributes, ${totalIdx} indexes.`);
