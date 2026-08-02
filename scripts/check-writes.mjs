#!/usr/bin/env node
/**
 * Does every write include the fields the database insists on?
 *
 * Written after "Missing required attribute change_given" reached a cook
 * standing at the pass trying to settle a bill. The till had always sent that
 * field; the kitchen screen was a second piece of code writing the same row and
 * omitted it. Nothing in a typecheck or a build could see the problem, because
 * the shape of an Appwrite document is not a TypeScript type — it is a
 * declaration in schema.mjs that the compiler never reads.
 *
 * So this reads it instead: every `createDocument(DB_ID, '<collection>', …)` in
 * the source, matched against the required attributes of that collection.
 *
 * Deliberately simple and slightly stupid. It reads the object literal at the
 * call site and nothing else, so a payload built up in a variable is skipped
 * rather than guessed at. A check that quietly misses some cases is worth
 * having; a check that invents failures gets switched off within a week.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { COLLECTIONS } from './schema.mjs';

const ROOTS = ['apps', 'packages', 'functions'];

/** Required attributes have no default — provisioning drops it — so every
 *  create must carry them itself. */
const required = new Map(
  COLLECTIONS.map((c) => [c.id, c.attributes.filter((a) => a[3] === true).map((a) => a[0])]).filter(
    ([, keys]) => keys.length > 0,
  ),
);

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) yield path;
  }
}

/** The balanced object literal starting at the opening brace. */
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

const problems = [];

for (const root of ROOTS) {
  for (const file of sourceFiles(root)) {
    const src = readFileSync(file, 'utf8');
    const re = /createDocument\(\s*DB_ID,\s*'([a-z_]+)'\s*,[^,]+,\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
      const keys = required.get(m[1]);
      if (!keys) continue;

      const body = objectAt(src, m.index + m[0].length - 1);
      // A spread means the payload is assembled elsewhere; this check cannot
      // see into it and says so by staying quiet rather than guessing.
      if (!body || body.includes('...')) continue;

      const present = new Set([...body.matchAll(/(?:^|[{\s,])([a-z_][a-z0-9_]*)\s*[:,}]/g)].map((x) => x[1]));
      const missing = keys.filter((k) => !present.has(k));
      if (missing.length) {
        problems.push({ file, line: src.slice(0, m.index).split('\n').length, collection: m[1], missing });
      }
    }
  }
}

if (problems.length === 0) {
  console.log(`✓ every write carries its required fields (${required.size} collections checked)`);
  process.exit(0);
}

console.error('These writes are missing fields the database requires:\n');
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}`);
  console.error(`    ${p.collection} needs: ${p.missing.join(', ')}\n`);
}
console.error('Appwrite rejects the whole document, so this fails for the person using it,');
console.error('not for you. Add the fields, or move the write into a shared function that');
console.error('already has them right.');
process.exit(1);
