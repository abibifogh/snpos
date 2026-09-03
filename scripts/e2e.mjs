#!/usr/bin/env node
/**
 * The bar, end to end, with an in-memory database.
 *
 * Every other test in this repo is of a PURE module, which is the right shape
 * for a rule and no use whatever for the question that actually cost a week:
 * does pressing the button on the screen make the number on the count sheet
 * change? Four separate repairs went out for one fault — sizes duplicating,
 * links pointing at sizes that were gone, sales matching nothing — and each one
 * was reasoned about, tested as a rule, shipped, and did not fix it, because
 * nothing anywhere ran the whole path.
 *
 * So this runs the real stock.ts: the real count sheet, the real repair, the
 * real catch-up, against a database that lives in a Map. Nothing is stubbed
 * except Appwrite.
 *
 * It works by copying packages/core/src to a temporary directory, dropping a
 * fake Appwrite in place of client.ts, and rewriting the extensionless imports
 * so node can load the TypeScript directly. Ugly, and much less ugly than
 * threading a database handle through ninety files to make them testable.
 */
import { cp, mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const work = await mkdtemp(join(tmpdir(), 'snpos-e2e-'));

try {
  await cp(join(root, 'packages/core/src'), join(work, 'core'), {
    recursive: true,
    filter: (src) => !src.includes('__tests__'),
  });

  // The database, replaced by one that lives in memory.
  await cp(join(here, 'e2e/fake-appwrite.ts'), join(work, 'core/client.ts'));
  await cp(join(here, 'e2e/shelves.ts'), join(work, 'shelves.ts'));

  /*
    `from './menu'` is what Vite resolves and what node does not. Rewritten on
    the copy rather than in the source, because adding extensions everywhere to
    please a test runner is a change to ninety files for the benefit of one.
  */
  for (const name of await readdir(join(work, 'core'))) {
    if (!name.endsWith('.ts')) continue;
    const path = join(work, 'core', name);
    const text = await readFile(path, 'utf8');
    await writeFile(path, text
      .replace(/(from '\.\/[A-Za-z0-9_.-]+)'/g, "$1.ts'")
      .replace(/(import\('\.\/[A-Za-z0-9_.-]+)'/g, "$1.ts'")
      .replace(/\.ts\.ts'/g, ".ts'"));
  }

  const code = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', join(work, 'shelves.ts')],
      { stdio: 'inherit' },
    );
    child.on('close', resolve);
  });

  if (code !== 0) {
    console.error('\nEnd-to-end checks failed.');
    process.exit(code ?? 1);
  }
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
}
