#!/usr/bin/env node
/**
 * Does every write match what the database will actually accept?
 *
 * Two ways to get this wrong, and this project has now shipped both:
 *
 *   "Missing required attribute change_given", a field the database insists
 *   on, left out of a payload. Reached a cook trying to settle a bill.
 *
 *   "Unknown attribute: served_at", a field the code invented and
 *   the schema never had. Reached the same cook a day later.
 *
 * Neither is visible to a typecheck. The shape of an Appwrite document lives
 * in schema.mjs, which the compiler never reads, so both compile, build,
 * deploy, and fail for the person using the app rather than the person who
 * wrote it. This reads the schema and checks the source against it.
 *
 * Deliberately simple and slightly stupid: it reads the object literal at the
 * call site and skips anything assembled elsewhere or spread in. A check that
 * quietly misses some cases is worth having; a check that invents failures
 * gets switched off within a week.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { COLLECTIONS, SYSTEM_ACCOUNT_CODES, FEATURES, TEAMS, BUCKETS } from './schema.mjs';
import { schemaFingerprint } from './schema-fingerprint.mjs';

/**
 * `scripts` is here because seeding and importing write real rows too.
 *
 * A one-shot importer is exactly where a wrong field name survives: it is run
 * once, by somebody who is not watching closely, against a live database — and
 * Appwrite rejects the whole document for one unknown attribute, so the run
 * reports failures with no clue which field caused them.
 */
const ROOTS = ['apps', 'packages', 'functions', 'scripts'];

/** Appwrite fills these in itself; code may send them back on an update. */
const SYSTEM_KEYS = new Set(['$id', '$createdAt', '$updatedAt', '$permissions', '$collectionId', '$databaseId']);

const schema = new Map(
  COLLECTIONS.map((c) => [
    c.id,
    {
      all: new Set(c.attributes.map((a) => a[0])),
      // Required attributes get no default, provisioning drops it, so every
      // create must carry them itself.
      required: c.attributes.filter((a) => a[3] === true).map((a) => a[0]),
      /*
        The fixed lists, so a value that can never be stored is caught here.

        This checker knew which FIELDS existed and nothing about what may go in
        them, which let `reject_reason_code: 'admin_cancelled'` ship — a value
        the database has never accepted, so cancelling an order was refused
        every single time with a message about an invalid format. Nothing in
        the build had an opinion; the first thing that did was a person trying
        to cancel an order.
      */
      enums: new Map(
        c.attributes.filter((a) => a[1] === 'e' && Array.isArray(a[2])).map((a) => [a[0], a[2]]),
      ),
    },
  ]),
);

function* sourceFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) yield path;
  }
}

/** The balanced object literal starting at an opening brace. */
function objectAt(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * Top-level keys of an object literal.
 *
 * A small state machine rather than a regular expression, because the naive
 * version reads values as keys: in `{ expense_id: expenseId }` the identifier
 * after the colon looks exactly like a shorthand key. So this tracks whether
 * the parser is at a position where a key may begin, the start of the object,
 * or just after a top-level comma, and only reads an identifier there.
 *
 * Returns null when the literal contains anything it cannot account for, so an
 * unusual payload is skipped rather than misreported.
 */
/**
 * The keys of a write, and any values written as a plain string.
 *
 * Only literals. A value that comes from a variable cannot be checked here and
 * is not guessed at — this reports what it can prove, and says nothing about
 * the rest.
 */
function topLevelKeys(body) {
  const keys = new Set();
  const literals = new Map();
  let depth = 0;
  let expectKey = false;
  let i = 0;

  while (i < body.length) {
    const ch = body[i];
    const two = body.slice(i, i + 2);

    if (two === '//') {
      i = body.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (two === '/*') {
      const close = body.indexOf('*/', i);
      if (close === -1) break;
      i = close + 2;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < body.length && body[i] !== quote) i += body[i] === '\\' ? 2 : 1;
      i += 1;
      // A quoted key is still a key: '{ "foo": 1 }'.
      if (expectKey && depth === 1) {
        const rest = body.slice(i).match(/^\s*:/);
        if (rest) {
          const raw = body.slice(0, i);
          const m = /(['"`])([^'"`]*)\1\s*$/.exec(raw);
          if (m) keys.add(m[2]);
          expectKey = false;
        }
      }
      continue;
    }

    if (ch === '{' || ch === '[' || ch === '(') {
      depth += 1;
      if (depth === 1) expectKey = true;
      i += 1;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === ',' && depth === 1) {
      expectKey = true;
      i += 1;
      continue;
    }

    if (expectKey && depth === 1 && !/\s/.test(ch)) {
      const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*([:,}])/.exec(body.slice(i));
      if (m) {
        keys.add(m[1]);
        // `field: 'value'`, and only that. Anything else — a variable, a
        // ternary, a template — is left alone rather than half-read.
        const lit = /^[A-Za-z_$][A-Za-z0-9_$]*\s*:\s*(['"])([^'"\\]*)\1\s*[,}]/.exec(body.slice(i));
        if (lit) literals.set(m[1], lit[2]);
        expectKey = false;
        // Step past the name only; the value is walked normally so nested
        // objects still adjust the depth.
        i += m[1].length;
        continue;
      }
      // A computed key, a spread, or something else this cannot read.
      if (ch === '[' || body.startsWith('...', i)) return null;
      expectKey = false;
    }

    i += 1;
  }

  keys.literals = literals;
  return keys;
}

const problems = [];

for (const root of ROOTS) {
  for (const file of sourceFiles(root)) {
    const src = readFileSync(file, 'utf8');
    // createDocument(DB_ID, 'x', id, {…})  and  updateDocument(DB_ID, 'x', id, {…})
    const re = /(create|update)Document\(\s*DB_ID,\s*'([a-z_]+)'\s*,[^,]+,\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
      const [, verb, collection] = m;
      const def = schema.get(collection);
      if (!def) continue;

      const body = objectAt(src, m.index + m[0].length - 1);
      if (!body) continue;

      const keys = topLevelKeys(body);
      if (!keys) continue;
      const line = src.slice(0, m.index).split('\n').length;

      // A spread hides fields this cannot see, so "is anything required
      // missing?" becomes unanswerable. "Is anything here made up?" does not:
      // every key it CAN see is still a key being sent. Skipping the whole
      // payload was how `served_at`, a field the schema never had, written
      // beside a spread, reached a cook at the pass.
      const spread = body.includes('...');

      const unknown = [...keys].filter((k) => !def.all.has(k) && !SYSTEM_KEYS.has(k));
      if (unknown.length) problems.push({ file, line, collection, kind: 'unknown', fields: unknown });

      /*
        A value the column will never accept.

        Appwrite refuses the whole document, so this is not a field quietly
        going missing — it is a button that does nothing and an error about an
        "invalid format" in front of somebody trying to work. Checked only for
        values written as plain strings, which is where this class of mistake
        actually lives: somebody adds a case to the code and not to the list.
      */
      for (const [field, value] of keys.literals ?? []) {
        const allowed = def.enums.get(field);
        if (allowed && !allowed.includes(value)) {
          problems.push({
            file, line, collection, kind: 'enum',
            fields: [`${field}: '${value}' — must be one of (${allowed.join(', ')})`],
          });
        }
      }

      // Only a create must carry every required field; an update touches a
      // subset on purpose.
      if (verb === 'create' && !spread) {
        const missing = def.required.filter((k) => !keys.has(k));
        if (missing.length) problems.push({ file, line, collection, kind: 'missing', fields: missing });
      }
    }
  }
}

// The two lists of account codes have to agree.
//
// schema.mjs marks accounts as system so provisioning knows which ones an admin
// must not delete; accounts.ts names them so postings can refer to them by
// meaning. They live in different languages and cannot import each other, so
// the only thing keeping them together is this check. Drift here would let an
// admin remove an account a shift close writes to, and it would surface as a
// shift that will not close, not as an error anybody could act on.
{
  const accounts = readFileSync(new URL('../packages/core/src/accounts.ts', import.meta.url), 'utf8');
  const block = /export const ACCOUNTS = \{([\s\S]*?)\} as const;/.exec(accounts);
  const inCode = new Set([...(block?.[1] ?? '').matchAll(/'(\d+)'/g)].map((m) => m[1]));
  const inSchema = new Set(SYSTEM_ACCOUNT_CODES);
  const onlyCode = [...inCode].filter((c) => !inSchema.has(c));
  const onlySchema = [...inSchema].filter((c) => !inCode.has(c));
  if (onlyCode.length || onlySchema.length) {
    console.error('SYSTEM_ACCOUNT_CODES and ACCOUNTS disagree:\n');
    if (onlyCode.length) console.error(`  posted to in accounts.ts but not protected in schema.mjs: ${onlyCode.join(', ')}`);
    if (onlySchema.length) console.error(`  protected in schema.mjs but not posted to in accounts.ts: ${onlySchema.join(', ')}`);
    console.error('\nAn account the code posts to must be protected, or an admin can delete it.');
    process.exit(1);
  }
}

/**
 * Every index must point at a column that exists.
 *
 * Appwrite builds indexes last, so one naming a missing attribute does not fail
 * until provisioning is most of the way through, and it takes the whole run
 * down with it. It happened: an index meant for `orders` was pasted onto
 * `receipts` as well, which has no `module` column, and provisioning stopped
 * dead on a live project.
 *
 * It is entirely detectable from the schema file, which makes shipping it
 * twice a choice.
 */
const indexFaults = [];
for (const col of COLLECTIONS) {
  const columns = new Set(col.attributes.map(([key]) => key));
  const names = new Set();
  for (const [name, , cols] of col.indexes ?? []) {
    if (names.has(name)) indexFaults.push(`${col.id}#${name} is declared twice`);
    names.add(name);
    for (const c of cols) {
      // $createdAt and friends are Appwrite's own and are always there.
      if (c.startsWith('$')) continue;
      if (!columns.has(c)) indexFaults.push(`${col.id}#${name} indexes "${c}", which ${col.id} does not have`);
    }
  }
}

/**
 * A function that writes to the database, and nothing calls it.
 *
 * The most convincing kind of broken feature: it is written, it is exported,
 * it reads correctly, it has been reviewed and it has been fixed — and it has
 * never run. Two were found here at once. `flagVariances` raised stock
 * variance flags nobody had ever seen, and had two wrong enum values
 * corrected in it a week earlier, which corrected nothing because the function
 * was unreachable. `creditForOrder` credited makers for a sale from the
 * browser, where the ledger deliberately allows no writes at all, so wiring it
 * up would have failed on permissions the moment anybody tried.
 *
 * Only writers, and only in core. A pure helper nobody uses is dead weight; a
 * WRITER nobody uses is a feature the code claims to have. And only core,
 * because an app's own component is reached from JSX in ways a grep cannot
 * see.
 *
 * Deliberately blunt: a name mentioned anywhere else at all counts as used,
 * including in a test. Something exercised only by a test is a different
 * argument, and a check that starts having opinions about that is a check
 * somebody switches off.
 */
const WRITES = /db\.(create|update|delete)Document|saveDropping|createOrQueue|updateOrQueue/;

const unusedWriters = [];
{
  const all = [];
  for (const root of ROOTS) for (const f of sourceFiles(root)) all.push([f, readFileSync(f, 'utf8')]);

  for (const [file, text] of all) {
    if (!file.startsWith(join('packages', 'core', 'src')) || file.includes('__tests__')) continue;
    for (const m of text.matchAll(/export (?:async )?function (\w+)/g)) {
      // The body, up to whatever is exported next.
      const after = text.indexOf('\nexport ', m.index + 1);
      const body = text.slice(m.index, after === -1 ? undefined : after);
      if (!WRITES.test(body)) continue;
      const named = new RegExp(`\\b${m[1]}\\b`);
      if (!all.some(([other, otherText]) => other !== file && named.test(otherText))) {
        unusedWriters.push(`${file} → ${m[1]}`);
      }
    }
  }
}

if (unusedWriters.length) {
  console.error('These write to the database and nothing calls them:\n');
  for (const f of unusedWriters) console.error(`  ${f}`);
  console.error('\nA writer nobody calls is a feature the code claims to have. Either wire it up');
  console.error('or delete it — leaving it is how a fix gets made to something that never runs.');
  process.exit(1);
}

/**
 * Every field a document type declares must exist on its collection.
 *
 * The generalisation of the settings check below, and it exists for the same
 * reason: `idle_minutes` and `margin_warn_bp` were declared on the ORDERS
 * collection, a few hundred lines from where they belonged. Provisioning
 * created them faithfully in the wrong place and reported everything present,
 * while the screen that writes them was told the database had never heard of
 * either — and the message it could give sent somebody to a workflow that had
 * nothing to add.
 *
 * A type is the list of what the code believes it can store. Where that list
 * and the collection disagree, one of them is wrong and neither says so.
 *
 * Only the types that mirror a collection exactly, named here rather than
 * guessed at: several interfaces in this codebase deliberately describe a
 * VIEW of a row — a few fields of it, joined with something else — and holding
 * those to the same rule would be inventing failures.
 *
 * The other direction is never an error. A column the type has stopped using
 * is ordinary history, and removing one from a live database is a decision
 * somebody makes on purpose.
 */
const MIRRORED = [
  ['Settings', 'settings'],
  ['Venue', 'venues'],
  ['StationDoc', 'stations'],
  ['Category', 'categories'],
  ['MenuItem', 'menu_items'],
  ['FeatureFlag', 'feature_flags'],
  ['StaffProfile', 'staff_profiles'],
];

const typeFaults = [];
{
  const types = readFileSync('packages/core/src/types.ts', 'utf8');
  for (const [name, collectionId] of MIRRORED) {
    const block = new RegExp(`export interface ${name} extends Doc \\{([\\s\\S]*?)\\n\\}`).exec(types);
    const col = COLLECTIONS.find((c) => c.id === collectionId);
    if (!block || !col) {
      typeFaults.push(`${name} or ${collectionId} has moved; this check can no longer find it`);
      continue;
    }
    const columns = new Set(col.attributes.map(([key]) => key));
    // Field lines only: `name?: type;` at one level of indentation. Comments,
    // blank lines and anything nested are skipped by the same pattern.
    for (const line of block[1].split('\n')) {
      const field = /^ {2}([a-z_][A-Za-z0-9_]*)\??:/.exec(line);
      if (!field) continue;
      if (!columns.has(field[1])) typeFaults.push(`${collectionId} has no ${field[1]}, and ${name} declares it`);
    }
  }
}

if (typeFaults.length) {
  console.error('These fields exist in the code and nowhere in the database:\n');
  for (const f of typeFaults) console.error(`  ${f}`);
  console.error('\nAppwrite refuses the whole document for one of these, so the save fails for');
  console.error('the person using the app. Add them to the right collection in scripts/schema.mjs');
  console.error('— and check they are not already on the wrong one.');
  process.exit(1);
}

/**
 * Every setting the code knows about must exist on the settings collection.
 *
 * The one write in this system that the check above cannot see. Settings are
 * saved as one assembled object — the page builds a patch from the form and
 * hands it over — so there is no object literal at the call site to read, and
 * a field written there is invisible to a checker that reads call sites.
 *
 * That is where two of them went missing. `idle_minutes` and `margin_warn_bp`
 * were declared inside the ORDERS collection, a few hundred lines from where
 * they belonged, so provisioning created them faithfully in the wrong place
 * and reported everything present. The settings screen was told the database
 * had never heard of either, and the message it showed — run provisioning and
 * save again — sent somebody to a workflow that had nothing to add. Twice.
 *
 * The Settings interface is the list of what the code believes it can store,
 * and it is checked against what the collection actually holds. The other
 * direction is not an error: a column the type has stopped using is ordinary
 * history, and removing it from a live database is a separate decision.
 */
const settingsFaults = [];
{
  const types = readFileSync('packages/core/src/types.ts', 'utf8');
  const block = /export interface Settings extends Doc \{([\s\S]*?)\n\}/.exec(types);
  const col = COLLECTIONS.find((c) => c.id === 'settings');
  if (block && col) {
    const columns = new Set(col.attributes.map(([key]) => key));
    // Field lines only: `name?: type;` at one level of indentation. Comments,
    // blank lines and anything nested are skipped by the same pattern.
    for (const line of block[1].split('\n')) {
      const field = /^ {2}([a-z_][A-Za-z0-9_]*)\??:/.exec(line);
      if (!field) continue;
      if (!columns.has(field[1])) settingsFaults.push(field[1]);
    }
  }
}

if (settingsFaults.length) {
  console.error('The settings collection has no room for these, and the code writes them:\n');
  for (const f of settingsFaults) console.error(`  ${f}`);
  console.error('\nSaving them is refused by the database, and the admin screen can only say');
  console.error('so and suggest provisioning — which will not help, because provisioning does');
  console.error('what scripts/schema.mjs says. Add them to the settings collection there.');
  process.exit(1);
}

/**
 * A new setting must be optional, or provisioning breaks the row it is added to.
 *
 * This one cost a failed deploy. `settings.vat_charged` shipped as required.
 * On a blank database that is fine, the seed writes a value. On a database
 * that already had a settings row, the row predates the attribute and so has
 * no value for it, Appwrite calls the whole document invalid, and the next
 * write to it fails — which was provisioning's own final act, stamping the
 * schema version. A required attribute may not carry a default either, so
 * there is nothing for the old row to fall back on.
 *
 * The settings row is the one document that always already exists, on every
 * install, from the first provisioning run onwards. So an attribute added to
 * it from now on has to be optional, however tempting `required` looks.
 *
 * The attributes that were required before this rule existed are listed and
 * left alone: they were there when the row was created and the seed has
 * always written them. The list does not grow.
 */
const SETTINGS_REQUIRED_FROM_THE_START = new Set([
  'org_id', 'restaurant_name', 'timezone', 'currency_code', 'currency_symbol', 'currency_decimals',
  'symbol_position', 'primary_color', 'secondary_color', 'tax_rate_bp', 'tax_inclusive',
  'service_charge_bp', 'shift_float_policy', 'shift_float_default', 'kitchen_ack_sla_seconds',
  'kitchen_ping_max_level', 'require_reject_reason', 'qr_orders_need_approval',
  'low_stock_default_bp', 'stock_variance_threshold_bp', 'stock_variance_value_floor',
  'expense_approval_threshold', 'cash_variance_tolerance', 'terminal_idle_lock_seconds',
]);

{
  const col = COLLECTIONS.find((c) => c.id === 'settings');
  const newlyRequired = (col?.attributes ?? [])
    .filter(([key, , , required]) => required === true && !SETTINGS_REQUIRED_FROM_THE_START.has(key))
    .map(([key]) => key);

  if (newlyRequired.length) {
    console.error('These settings are required, and a settings row that already exists has no value for them:\n');
    for (const f of newlyRequired) console.error(`  ${f}`);
    console.error('\nProvisioning would add the column and then fail on the next write to the row,');
    console.error('with "Invalid document structure: Missing required attribute". Mark them');
    console.error('optional in scripts/schema.mjs and give them a default. Absent then has to');
    console.error('mean something sensible in the code that reads them, which it should anyway.');
    process.exit(1);
  }
}

/**
 * A hook must not sit below a screen's loading guard.
 *
 * This one took the whole customer menu down for a release. A component that
 * returns a spinner while it is loading, and then calls useMemo further down,
 * runs one hook fewer on its first render than on its second — and React does
 * not warn, it stops the app dead with "Rendered more hooks than during the
 * previous render". Every screen here has that shape: read, show a spinner,
 * then render. So the mistake is one keystroke away at all times, and nothing
 * else in the build catches it. There is no eslint in this repo, and the
 * type checker has no opinion about hook order.
 *
 * Deliberately blunt. It looks for a guard at the top level of a component —
 * an `if` that returns — and then for any hook call at that same level below
 * it. That is the shape that breaks. A hook nested inside another function is
 * indented further and is not this bug.
 */
const HOOK = /^ {2}(?:const\s+[^=]+=\s*)?use[A-Z]\w*[<(]/;
const INLINE_GUARD = /^ {2}if\s*\(.*\)\s*return\b/;
const OPEN_GUARD = /^ {2}if\s*\(.*\)\s*\{\s*$/;

const hookFaults = [];
for (const file of [...sourceFiles('apps'), ...sourceFiles('packages')].filter((f) => f.endsWith('.tsx'))) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let guard = 0;
  let inGuardBlock = false;
  let blockReturns = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // A new top-level function starts the reckoning again.
    if (/^(export\s+)?(default\s+)?function\s/.test(line)) {
      guard = 0;
      inGuardBlock = false;
    }

    if (inGuardBlock) {
      if (/^\s+return\b/.test(line)) blockReturns = true;
      if (/^ {2}\}/.test(line)) {
        if (blockReturns) guard = i + 1;
        inGuardBlock = false;
      }
      continue;
    }

    if (INLINE_GUARD.test(line)) { guard = i + 1; continue; }
    if (OPEN_GUARD.test(line)) { inGuardBlock = true; blockReturns = false; continue; }

    if (guard && HOOK.test(line)) {
      hookFaults.push({ file, line: i + 1, guard, text: line.trim().slice(0, 60) });
    }
  }
}

if (hookFaults.length) {
  console.error('These hooks are called below a return, so they do not run on every render:\n');
  for (const f of hookFaults) {
    console.error(`  ${f.file}:${f.line}  ${f.text}`);
    console.error(`    a return above it at line ${f.guard} means this is skipped on some renders`);
  }
  console.error('\nReact counts hooks and refuses to carry on when the count changes, which takes');
  console.error('the whole screen down rather than just this part of it. Move the hook above the');
  console.error('guard and read whatever it needs through the state that may still be loading.');
  process.exit(1);
}

/**
 * The apps must know the schema's current fingerprint.
 *
 * packages/core/src/schema-version.ts is generated from the schema, and the
 * apps read it to say when the database is behind. A schema change committed
 * without regenerating it ships apps that believe an old shape is current, so
 * the one screen built to catch a forgotten provision run would stay quiet.
 */
{
  const want = schemaFingerprint({ COLLECTIONS, FEATURES, SYSTEM_ACCOUNT_CODES, TEAMS, BUCKETS });
  let have = '';
  try {
    have = /SCHEMA_VERSION = '([0-9a-f]+)'/.exec(readFileSync('packages/core/src/schema-version.ts', 'utf8'))?.[1] ?? '';
  } catch { /* missing is stale */ }
  if (have !== want) {
    console.error(`The schema changed (fingerprint ${want}) but packages/core/src/schema-version.ts says '${have || 'nothing'}'.`);
    console.error('Run:  npm run gen:schema   and commit the result, so the apps can tell when the database is behind.');
    process.exit(1);
  }
}

if (indexFaults.length) {
  console.error('These indexes cannot be built:\n');
  for (const f of indexFaults) console.error(`  ${f}`);
  console.error('\nProvisioning would stop part-way through, on a live project.');
  process.exit(1);
}

if (problems.length === 0) {
  console.log(`✓ every write matches the schema (${schema.size} collections checked, ${
    COLLECTIONS.reduce((n, c) => n + (c.indexes?.length ?? 0), 0)} indexes verified)`);
  process.exit(0);
}

console.error('These writes do not match the schema:\n');
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}`);
  console.error(
    p.kind === 'missing'
      ? `    ${p.collection} requires, and this create omits: ${p.fields.join(', ')}\n`
      : p.kind === 'enum'
        ? `    ${p.collection} will not store this value: ${p.fields.join(', ')}\n`
        : `    ${p.collection} has no such field: ${p.fields.join(', ')}\n`,
  );
}
console.error('Appwrite rejects the whole document either way, so this fails for the person');
console.error('using the app, not for you. Add the field or the value to scripts/schema.mjs,');
console.error('or stop writing it.');
process.exit(1);
