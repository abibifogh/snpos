#!/usr/bin/env node
/**
 * Does every write match what the database will actually accept?
 *
 * Two ways to get this wrong, and this project has now shipped both:
 *
 *   "Missing required attribute change_given"  — a field the database insists
 *   on, left out of a payload. Reached a cook trying to settle a bill.
 *
 *   "Unknown attribute: served_at"             — a field the code invented and
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
import { COLLECTIONS } from './schema.mjs';

const ROOTS = ['apps', 'packages', 'functions'];

/** Appwrite fills these in itself; code may send them back on an update. */
const SYSTEM_KEYS = new Set(['$id', '$createdAt', '$updatedAt', '$permissions', '$collectionId', '$databaseId']);

const schema = new Map(
  COLLECTIONS.map((c) => [
    c.id,
    {
      all: new Set(c.attributes.map((a) => a[0])),
      // Required attributes get no default — provisioning drops it — so every
      // create must carry them itself.
      required: c.attributes.filter((a) => a[3] === true).map((a) => a[0]),
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
 * the parser is at a position where a key may begin — the start of the object,
 * or just after a top-level comma — and only reads an identifier there.
 *
 * Returns null when the literal contains anything it cannot account for, so an
 * unusual payload is skipped rather than misreported.
 */
function topLevelKeys(body) {
  const keys = new Set();
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
      // payload was how `served_at` — a field the schema never had, written
      // beside a spread — reached a cook at the pass.
      const spread = body.includes('...');

      const unknown = [...keys].filter((k) => !def.all.has(k) && !SYSTEM_KEYS.has(k));
      if (unknown.length) problems.push({ file, line, collection, kind: 'unknown', fields: unknown });

      // Only a create must carry every required field; an update touches a
      // subset on purpose.
      if (verb === 'create' && !spread) {
        const missing = def.required.filter((k) => !keys.has(k));
        if (missing.length) problems.push({ file, line, collection, kind: 'missing', fields: missing });
      }
    }
  }
}

if (problems.length === 0) {
  console.log(`✓ every write matches the schema (${schema.size} collections checked)`);
  process.exit(0);
}

console.error('These writes do not match the schema:\n');
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}`);
  console.error(
    p.kind === 'missing'
      ? `    ${p.collection} requires, and this create omits: ${p.fields.join(', ')}\n`
      : `    ${p.collection} has no such field: ${p.fields.join(', ')}\n`,
  );
}
console.error('Appwrite rejects the whole document either way, so this fails for the person');
console.error('using the app, not for you. Add the field to scripts/schema.mjs, or stop');
console.error('writing it.');
process.exit(1);
