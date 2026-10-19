import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appTitle, pageTitle, APP_NAMES, PRODUCT_NAME, type AppKey } from '../brand.ts';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

test('an app is called the product then the app, with no comma', () => {
  assert.equal(appTitle('pos'), `${PRODUCT_NAME} Till`);
  assert.equal(appTitle('admin'), `${PRODUCT_NAME} Admin`);
  for (const app of Object.keys(APP_NAMES) as AppKey[]) assert.doesNotMatch(appTitle(app), /,/);
});

test('a page title puts the page first so tabs can be told apart', () => {
  assert.equal(pageTitle('Orders', 'admin'), `Orders · ${PRODUCT_NAME} Admin`);
  assert.equal(pageTitle('', 'admin'), `${PRODUCT_NAME} Admin`);
  assert.equal(pageTitle(null, 'admin'), `${PRODUCT_NAME} Admin`);
  assert.equal(pageTitle('Admin', 'admin'), `${PRODUCT_NAME} Admin`, 'never "Admin · NiceOps Admin"');
});

test('each staff app\'s index.html carries the same title as the code', () => {
  for (const app of ['admin', 'pos', 'kitchen'] as const) {
    const title = read('apps', app, 'index.html').match(/<title>([^<]*)<\/title>/)?.[1];
    assert.equal(title, appTitle(app), `apps/${app}/index.html`);
  }
});

test('the installed app names match too', () => {
  const sync = read('scripts', 'sync-sw.mjs');
  for (const app of ['admin', 'pos', 'kitchen'] as const) {
    assert.match(sync, new RegExp(`name: '${appTitle(app)}'`), `scripts/sync-sw.mjs names ${app}`);
    assert.match(sync, new RegExp(`short: '${APP_NAMES[app]}'`), `scripts/sync-sw.mjs short name for ${app}`);
  }
});
