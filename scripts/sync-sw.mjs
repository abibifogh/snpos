/**
 * Put the shared service worker where each app's build can serve it.
 *
 * A service worker only controls pages inside its own folder, so every app
 * needs its own copy at its own root. Copying at build time rather than
 * checking in four files means there is still only one to edit, four copies of
 * a caching policy would drift, and a stale one is invisible until somebody is
 * looking at last week's app on a dead connection.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'packages/ui/src/sw.js');

for (const app of ['admin', 'menu', 'kitchen', 'pos']) {
  const dir = join(root, 'apps', app, 'public');
  mkdirSync(dir, { recursive: true });
  copyFileSync(source, join(dir, 'sw.js'));
}
console.log('service worker copied into all four apps');
