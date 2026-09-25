import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OVERDUE_MS, overdueCounts, rowsToStamp, adminRecipients, overdueSubject, overduePush, overdueBody,
} from '../../../../functions/notify/src/overdue-counts.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const hoursAgo = (n: number) => new Date(NOW - n * 3_600_000).toISOString();
const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;

/** A held line on a bar count: a difference nobody has agreed or refused. */
const line = (over: Record<string, unknown> = {}) => ({
  $id: `c${Math.random()}`,
  shift_id: 'sh1',
  phase: 'close',
  applied: false,
  variance_value: 1_000,
  checked_by: 'p1',
  $createdAt: hoursAgo(25),
  ...over,
});

test('a count held for more than a day is escalated', () => {
  const items = overdueCounts({ checks: [line()], now: NOW });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.queue, 'bar_count');
});

test('one held for less than a day is left alone', () => {
  // It was told about when it was filed. A day is the point at which the same
  // difference has started turning up again on the next count.
  assert.deepEqual(overdueCounts({ checks: [line({ $createdAt: hoursAgo(23) })], now: NOW }), []);
  assert.equal(OVERDUE_MS, 24 * 3_600_000);
});

test('exactly a day is overdue', () => {
  assert.equal(overdueCounts({ checks: [line({ $createdAt: hoursAgo(24) })], now: NOW }).length, 1);
});

test('a count already escalated is not escalated again', () => {
  /*
    Said once. An admin told at filing and again a day later has been told;
    every hour after that is how a warning becomes something a phone learns
    to hide. Filtered here as well as in the query, so a database without the
    stamp cannot produce the same alert every hour.
  */
  const items = overdueCounts({ checks: [line({ overdue_alerted_at: hoursAgo(1) })], now: NOW });
  assert.deepEqual(items, []);
});

test('only differences still waiting count, not ones decided', () => {
  const items = overdueCounts({
    checks: [
      line({ approved_at: hoursAgo(2) }),
      line({ rejected_at: hoursAgo(2) }),
      line({ applied: true }),
    ],
    now: NOW,
  });
  assert.deepEqual(items, []);
});

test('the lines of one count are one alert, dated from the oldest', () => {
  const items = overdueCounts({
    checks: [line({ $createdAt: hoursAgo(30) }), line({ $createdAt: hoursAgo(29) }), line({ $createdAt: hoursAgo(31) })],
    now: NOW,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.lines, 3);
  assert.equal(items[0]?.since, hoursAgo(31));
  assert.equal(items[0]?.value, 3_000);
});

test('a shop stocktake waiting a day is escalated too', () => {
  const items = overdueCounts({
    shopCounts: [{ $id: 's1', status: 'pending', missing_value: 5_000, counted_at: hoursAgo(26), line_count: 4 }],
    now: NOW,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.queue, 'shop_count');
});

test('a count with no readable date is not guessed to be old', () => {
  // A wrong escalation is what teaches somebody to ignore the right ones.
  assert.deepEqual(overdueCounts({ checks: [line({ $createdAt: '' })], now: NOW }), []);
});

test('oldest first', () => {
  const items = overdueCounts({
    checks: [line({ shift_id: 'new', $createdAt: hoursAgo(25) }), line({ shift_id: 'old', $createdAt: hoursAgo(50) })],
    now: NOW,
  });
  assert.deepEqual(items.map((i) => i.id), ['old|close', 'new|close']);
});

/* ------------------------------------------------------------ what is stamped */

test('every line of an escalated count is stamped, and nothing of a count not yet due', () => {
  /*
    A bar count is one row per difference. Stamping only some would bring the
    rest back next hour as though they were a count of their own.
  */
  const old1 = line({ $id: 'a', shift_id: 'old' });
  const old2 = line({ $id: 'b', shift_id: 'old' });
  const fresh = line({ $id: 'c', shift_id: 'fresh', $createdAt: hoursAgo(2) });
  const shopOld = { $id: 's-old', status: 'pending', counted_at: hoursAgo(30) };
  const shopNew = { $id: 's-new', status: 'pending', counted_at: hoursAgo(3) };

  const checks = [old1, old2, fresh];
  const shopCounts = [shopOld, shopNew];
  const items = overdueCounts({ checks, shopCounts, now: NOW });
  const stamp = rowsToStamp(items, { checks, shopCounts });

  assert.deepEqual(stamp.checks.sort(), ['a', 'b']);
  assert.deepEqual(stamp.shopCounts, ['s-old']);
});

/* --------------------------------------------------------------- who is told */

test('the alert goes to the admins, who are the only people who can act on it', () => {
  const r = adminRecipients([
    { role: 'admin', active: true, email: 'owner@example.com', user_id: 'u1' },
    { role: 'admin', active: true, email: '', user_id: 'u2' },
    { role: 'manager', active: true, email: 'mgr@example.com', user_id: 'u3' },
    { role: 'admin', active: false, email: 'gone@example.com', user_id: 'u4' },
  ]);
  assert.deepEqual(r.emails, ['owner@example.com']);
  // An admin with no address still gets it on their devices.
  assert.deepEqual(r.userIds, ['u1', 'u2']);
});

test('an address that is not one is not sent to', () => {
  assert.deepEqual(adminRecipients([{ role: 'admin', email: 'not an address', user_id: 'u1' }]).emails, []);
});

/* ------------------------------------------------------------------- wording */

test('the subject says how long, because the age is the news', () => {
  const one = overdueCounts({ checks: [line()], now: NOW });
  assert.match(overdueSubject(one), /waiting for your decision for over a day/);
  const two = overdueCounts({ checks: [line(), line({ shift_id: 'sh2' })], now: NOW });
  assert.match(overdueSubject(two), /^2 stock counts have been waiting over a day/);
});

test('the lock screen carries what is at stake and where to go', () => {
  const items = overdueCounts({ checks: [line({ variance_value: 7_000 })], now: NOW });
  const p = overduePush(items, money, NOW);
  assert.match(p.title, /waiting 1 day/);
  assert.match(p.body, /GH₵70\.00 in differences/);
  assert.equal(p.url, '#/waiting?show=count');
  // A second alert replaces the first on the screen rather than stacking.
  assert.equal(p.tag, 'overdue-counts');
});

test('the email explains why a day matters, including the double-approval trap', () => {
  const items = overdueCounts({ checks: [line()], now: NOW });
  const html = overdueBody(items, money, NOW, 'https://pos.example.com/admin/#/waiting?show=count');
  assert.match(html, /same difference turns up again on the next count/);
  assert.match(html, /approving two takes it off the shelf twice/);
  assert.match(html, /href="https:\/\/pos\.example\.com\/admin\/#\/waiting\?show=count"/);
  // Without a configured address it says where, rather than linking nowhere.
  assert.match(overdueBody(items, money, NOW, ''), /Under Money, Waiting for you/);
});
