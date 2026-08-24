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
import { COLLECTIONS, SYSTEM_ACCOUNT_CODES } from './schema.mjs';

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
// must not delete; ledger.ts names them so postings can refer to them by
// meaning. They live in different languages and cannot import each other, so
// the only thing keeping them together is this check. Drift here would let an
// admin remove an account a shift close writes to, and it would surface as a
// shift that will not close, not as an error anybody could act on.
{
  const ledger = readFileSync(new URL('../packages/core/src/ledger.ts', import.meta.url), 'utf8');
  const block = /export const ACCOUNTS = \{([\s\S]*?)\} as const;/.exec(ledger);
  const inCode = new Set([...(block?.[1] ?? '').matchAll(/'(\d+)'/g)].map((m) => m[1]));
  const inSchema = new Set(SYSTEM_ACCOUNT_CODES);
  const onlyCode = [...inCode].filter((c) => !inSchema.has(c));
  const onlySchema = [...inSchema].filter((c) => !inCode.has(c));
  if (onlyCode.length || onlySchema.length) {
    console.error('SYSTEM_ACCOUNT_CODES and ACCOUNTS disagree:\n');
    if (onlyCode.length) console.error(`  posted to in ledger.ts but not protected in schema.mjs: ${onlyCode.join(', ')}`);
    if (onlySchema.length) console.error(`  protected in schema.mjs but not posted to in ledger.ts: ${onlySchema.join(', ')}`);
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
