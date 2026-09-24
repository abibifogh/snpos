import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/*
  A HANDLER WITH NO TRIGGER IS CODE THAT NEVER RUNS, AND SAYS NOTHING.

  The notify function answers events by looking at which collection a
  document came from. Appwrite only calls it for the events listed against it
  in appwrite.json. The two are written in different files, and nothing tied
  them together — so emailing a voucher was built, tested end to end against
  a mocked event, and shipped with no event that could ever deliver it. Every
  voucher asked for would have sat as "queued" for ever, and the screen would
  have said it was on its way.

  This reads both files and refuses a handler whose trigger is missing.
*/

const root = new URL('../../../../', import.meta.url);
const main = readFileSync(new URL('functions/notify/src/main.js', root), 'utf8');
const config = JSON.parse(readFileSync(new URL('appwrite.json', root), 'utf8')) as {
  functions: { $id: string; events: string[] }[];
};
const notify = config.functions.find((f) => f.$id === 'notify');

/** Every collection main.js tests an incoming event against. */
const handled = [...new Set(
  [...main.matchAll(/e\.includes\('collections\.([a-z_]+)'\)/g)].map((m) => m[1] as string),
)];

test('the notify function is configured at all', () => {
  assert.ok(notify, 'appwrite.json has a notify function');
  assert.ok(handled.length > 5, 'and the handlers were found, so this test is actually checking something');
});

test('every collection the notify function handles has an event that calls it', () => {
  const missing = handled.filter(
    (c) => !(notify?.events ?? []).some((e) => e.includes(`.collections.${c}.documents.`)),
  );
  assert.deepEqual(missing, [], `handled in main.js but never triggered: ${missing.join(', ')}`);
});

test('a handler listening for creates is triggered on create', () => {
  /*
    The subtler half of the same mistake. A collection can be listed for
    updates while the handler waits for creates, and it looks configured.
  */
  const creates = [...main.matchAll(
    /e\.includes\('collections\.([a-z_]+)'\)\)\s*\n?\s*&& events\.some\(\(e\) => e\.endsWith\('\.create'\)\)/g,
  )].map((m) => m[1] as string);
  const missing = creates.filter(
    (c) => !(notify?.events ?? []).includes(`databases.snpos.collections.${c}.documents.*.create`),
  );
  assert.deepEqual(missing, [], `waits for a create that is never sent: ${missing.join(', ')}`);
});
