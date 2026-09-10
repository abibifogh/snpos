import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { schemaState, schemaWords } from '../schema-status.ts';
import { SCHEMA_VERSION } from '../schema-version.ts';

test('the database is current only when the row carries this build’s fingerprint', () => {
  assert.equal(schemaState({ schema_version: 'abc123' }, 'abc123'), 'current');
  assert.equal(schemaState({ schema_version: 'old' }, 'abc123'), 'behind');
  // A database provisioned before the stamp existed has no field at all.
  assert.equal(schemaState({}, 'abc123'), 'behind');
  assert.equal(schemaState({ schema_version: null }, 'abc123'), 'behind');
  assert.equal(schemaState(null, 'abc123'), 'unknown');
  assert.equal(schemaState(undefined, 'abc123'), 'unknown');
});

test('only a database that is behind gets words, and the owner’s name the step', () => {
  assert.equal(schemaWords('current', { owner: true }), null);
  assert.equal(schemaWords('unknown', { owner: false }), null);
  assert.match(schemaWords('behind', { owner: true }) ?? '', /Provision Appwrite/);
  assert.match(schemaWords('behind', { owner: false }) ?? '', /waiting on the owner/);
  assert.doesNotMatch(schemaWords('behind', { owner: false }) ?? '', /Actions/);
});

test('the generated fingerprint is the schema’s own', () => {
  /*
    The apps read schema-version.ts; provisioning reads schema.mjs. They
    agree only while somebody has re-run the generator after a schema change,
    which check:writes enforces; this holds the same line from the tests.
  */
  const fresh = execFileSync(process.execPath, ['-e', `
    import('./scripts/schema.mjs').then(async (s) => {
      const { schemaFingerprint } = await import('./scripts/schema-fingerprint.mjs');
      process.stdout.write(schemaFingerprint(s));
    });
  `], { encoding: 'utf8' }).trim();
  assert.equal(SCHEMA_VERSION, fresh, 'run npm run gen:schema');
  assert.match(readFileSync('packages/core/src/schema-version.ts', 'utf8'), /GENERATED/);
});
