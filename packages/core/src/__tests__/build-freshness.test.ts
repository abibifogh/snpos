import test from 'node:test';
import assert from 'node:assert/strict';
import { scriptFrom, buildName, pageIsStale, STALE_WORDS } from '../build-freshness.ts';

const page = (extra = '') => `<!doctype html><html><head>
  <link rel="stylesheet" href="/admin/assets/index-BWz3OkG6.css">
  ${extra}
  <script type="module" crossorigin src="/admin/assets/index-BiJKO9wz.js"></script>
</head><body><div id="root"></div></body></html>`;

test('the app’s own bundle is picked out of the page the server is serving', () => {
  assert.equal(scriptFrom(page()), '/admin/assets/index-BiJKO9wz.js');
  // Attribute order and quoting are the bundler's business, not ours.
  assert.equal(
    scriptFrom('<script src=\'/x/main-abc.js\' type=module></script>'),
    '/x/main-abc.js',
  );
});

test('a script that is not the app is not mistaken for it', () => {
  // An inline module, and an ordinary script with a src. Neither is the build.
  assert.equal(scriptFrom('<script type="module">console.log(1)</script>'), null);
  assert.equal(scriptFrom('<script src="/analytics.js"></script>'), null);
  assert.equal(scriptFrom('<html><body>no scripts at all</body></html>'), null);
  // The app's own one still wins when something else is on the page first.
  assert.equal(
    scriptFrom(page('<script src="/analytics.js"></script>')),
    '/admin/assets/index-BiJKO9wz.js',
  );
});

test('a build is known by the hash in its name, not by how it was addressed', () => {
  // The same build, reached four ways. None of these is a different build.
  const one = 'index-BiJKO9wz.js';
  assert.equal(buildName('/admin/assets/index-BiJKO9wz.js'), one);
  assert.equal(buildName('https://pos.example.com/admin/assets/index-BiJKO9wz.js'), one);
  assert.equal(buildName('./assets/index-BiJKO9wz.js'), one);
  assert.equal(buildName('/admin/assets/index-BiJKO9wz.js?v=2'), one);

  assert.equal(
    pageIsStale('https://pos.example.com/admin/assets/index-BiJKO9wz.js', './assets/index-BiJKO9wz.js'),
    false,
  );
});

test('a different bundle means the page in front of somebody is the old one', () => {
  assert.equal(pageIsStale('/admin/assets/index-OLD11111.js', '/admin/assets/index-NEW22222.js'), true);
});

test('not knowing reads as fresh, never as stale', () => {
  /*
    The bar has to be worth believing on the day it appears. Shown on a hiccup
    — an unreachable server, a host that serves something we cannot read — it
    teaches everybody to reload for nothing and then to ignore it.
  */
  assert.equal(pageIsStale(null, '/a/index-NEW.js'), false);
  assert.equal(pageIsStale('/a/index-OLD.js', null), false);
  assert.equal(pageIsStale(null, null), false);
  assert.equal(pageIsStale('', ''), false);
  assert.equal(pageIsStale('/a/', '/b/'), false);
});

test('the words say what is wrong and that reloading ends it', () => {
  assert.match(STALE_WORDS, /older copy/);
  assert.match(STALE_WORDS, /reload/i);
});
