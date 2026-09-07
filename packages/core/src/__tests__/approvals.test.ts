import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_GRACE_MS, fromBarChecks, fromShopCounts, fromExpenses,
  waitedWords, worthSending, approvalSubject, approvalBody,
  countLines, countSubject, countBody,
  // Plain JavaScript, deliberately importing nothing at runtime so the
  // decisions can be tested from here without a database or a mail server.
} from '../../../../functions/notify/src/approvals.js';

const NOW = Date.parse('2026-09-06T12:00:00.000Z');
const hoursAgo = (n: number) => new Date(NOW - n * 3_600_000).toISOString();
const money = (n: number) => `GH¢${(n / 100).toFixed(2)}`;
const names = { u1: 'Regina', u2: 'Betty' };

test('a count of forty bottles with six differences is ONE thing waiting', () => {
  /**
   * The reason this is a sweep and not an event. Six rows land in the same
   * second; sending on each would send six emails, which is not six times as
   * useful — it is one email that gets a rule made for it in somebody's inbox.
   */
  const rows = Array.from({ length: 6 }, (_, i) => ({
    $id: `r${i}`,
    shift_id: 'sh1',
    phase: 'close',
    applied: false,
    variance_value: 1000,
    checked_by: 'u1',
    $createdAt: hoursAgo(3),
  }));
  const waiting = fromBarChecks(rows, names);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].lines, 6);
  assert.equal(waiting[0].value, 6000);
  assert.equal(waiting[0].who, 'Regina');
  assert.match(waiting[0].what, /counting out/);
});

test('counting in and counting out are two different counts', () => {
  // They are two separate claims about the shelf, made by two different people
  // at two ends of a night, and one being agreed says nothing about the other.
  const rows = [
    { $id: 'a', shift_id: 'sh1', phase: 'open', applied: false, variance_value: 500, $createdAt: hoursAgo(9) },
    { $id: 'b', shift_id: 'sh1', phase: 'close', applied: false, variance_value: 700, $createdAt: hoursAgo(2) },
  ];
  assert.equal(fromBarChecks(rows).length, 2);
});

test('a row that found no difference never waited for anybody', () => {
  /*
    A count that matched is recorded as counted and moves nothing. Emailing an
    admin about it would put the ordinary case in front of them every night,
    which is how the unusual one stops being read.
  */
  assert.deepEqual(fromBarChecks([
    { $id: 'a', shift_id: 'sh1', applied: true, variance_value: 0, $createdAt: hoursAgo(2) },
  ]), []);
});

test('a count already agreed or refused is finished with', () => {
  const decided = [
    { $id: 'a', shift_id: 'sh1', applied: false, approved_at: hoursAgo(1), $createdAt: hoursAgo(3) },
    { $id: 'b', shift_id: 'sh2', applied: false, rejected_at: hoursAgo(1), $createdAt: hoursAgo(3) },
  ];
  assert.deepEqual(fromBarChecks(decided), []);
});

test('the shop stocktake and a spend come through with what is at stake', () => {
  const shop = fromShopCounts([{
    $id: 'c1', status: 'pending', counted_by: 'u2', counted_at: hoursAgo(20),
    line_count: 40, missing_value: 25_000,
  }], names);
  assert.deepEqual(
    [shop[0].what, shop[0].who, shop[0].value, shop[0].lines],
    ['Shop stocktake', 'Betty', 25_000, 40],
  );

  const spend = fromExpenses([{
    $id: 'e1', approval_status: 'pending', amount: 12_000, payee: 'Kaneshie Market',
    created_by: 'u1', $createdAt: hoursAgo(2),
  }], names);
  assert.equal(spend[0].what, 'Spend to Kaneshie Market');
  assert.equal(spend[0].value, 12_000);

  // And what has already been decided is not chased.
  assert.deepEqual(fromShopCounts([{ $id: 'c2', status: 'approved' }]), []);
  assert.deepEqual(fromExpenses([{ $id: 'e2', approval_status: 'approved' }]), []);
});

test('something filed a moment ago is left for the next run', () => {
  /**
   * A count is written row by row, and the person who took it is very often
   * still standing at the shelf. Emailing it half-finished is worse than
   * emailing it an hour late.
   */
  const fresh = { id: 'a', queue: 'bar_count', what: 'Bar count', who: '', value: 1, since: hoursAgo(0.1), lines: 1 };
  const settled = { ...fresh, id: 'b', since: hoursAgo(3) };
  assert.deepEqual(worthSending([fresh, settled], NOW).map((i: { id: string }) => i.id), ['b']);
  // The edge, either side of it.
  const at = (ms: number) => worthSending(
    [{ ...fresh, since: new Date(NOW - ms).toISOString() }], NOW,
  ).length;
  assert.equal(at(APPROVAL_GRACE_MS - 1000), 0);
  assert.equal(at(APPROVAL_GRACE_MS + 1000), 1);
});

test('the oldest first, because it is the one that has been ignored longest', () => {
  const items = [
    { id: 'new', queue: 'expense', what: 'Spend', who: '', value: 1, since: hoursAgo(2), lines: 1 },
    { id: 'old', queue: 'bar_count', what: 'Bar count', who: '', value: 1, since: hoursAgo(30), lines: 1 },
  ];
  assert.deepEqual(worthSending(items, NOW).map((i: { id: string }) => i.id), ['old', 'new']);
});

test('the subject says what it is when there is one, and how many when there are more', () => {
  assert.equal(approvalSubject([]), '');
  assert.equal(
    approvalSubject([{ id: 'a', queue: 'bar_count', what: 'Bar count, counting out', who: '', value: 0, since: '', lines: 1 }]),
    'Bar count, counting out is waiting for your approval',
  );
  assert.match(
    approvalSubject([{ id: 'a' }, { id: 'b' }, { id: 'c' }] as never),
    /^3 things are waiting/,
  );
});

test('the body groups by the screen that deals with it, and says where that is', () => {
  /**
   * An admin does not act on "seven things". They open one screen and clear
   * what is on it, then another. A flat list that mixes a bar count with a
   * taxi fare makes somebody sort it themselves.
   */
  const html = approvalBody([
    { id: 'a', queue: 'bar_count', what: 'Bar count, counting out', who: 'Regina', value: 6000, since: hoursAgo(30), lines: 6 },
    { id: 'b', queue: 'expense', what: 'Spend to Kaneshie Market', who: 'Betty', value: 12_000, since: hoursAgo(2), lines: 1 },
  ], money, NOW);

  assert.match(html, /Bar counts/);
  assert.match(html, /Bar, Counts and variances/);
  assert.match(html, /Spending/);
  assert.match(html, /Money, Expenses/);
  assert.match(html, /GH¢60.00, 6 lines, counted by Regina/);
  assert.match(html, /Waiting 1 day/);
  assert.match(html, /Waiting 2 hours/);
});

test('the body says WHY it matters, because otherwise it reads as tidying', () => {
  /**
   * An admin who does not know what "waiting" means here will assume it is
   * housekeeping and leave it. It is not: until somebody agrees, the shelf
   * figure is the old one, so every report built on it describes stock that is
   * not there.
   */
  const html = approvalBody(
    [{ id: 'a', queue: 'bar_count', what: 'Bar count', who: '', value: 0, since: hoursAgo(3), lines: 1 }],
    money,
    NOW,
  );
  assert.match(html, /stock figures still say what they said before it was taken/);
  assert.match(html, /working from a number somebody has already found to be wrong/);
});

test('how long it has waited, in the words somebody would use', () => {
  assert.equal(waitedWords(3 * 86_400_000), '3 days');
  assert.equal(waitedWords(86_400_000), '1 day');
  assert.equal(waitedWords(5 * 3_600_000), '5 hours');
  assert.equal(waitedWords(90_000), '2 minutes');
  assert.equal(waitedWords(1_000), '1 minute');
});

/* -------------------------- one count, told about the moment it is filed */

const shelves = { i1: 'Club · Large', i2: 'Tonic', i3: 'Sprite' };
const held = [
  { $id: 'a', ingredient_id: 'i2', applied: false, variance_qty: 1, variance_value: 300, counted_qty: 13, theoretical_qty: 12 },
  { $id: 'b', ingredient_id: 'i1', applied: false, variance_qty: -8, variance_value: 8000, counted_qty: 40, theoretical_qty: 48 },
  { $id: 'c', ingredient_id: 'i3', applied: true, variance_qty: 0, variance_value: 0 },
];

test('the biggest loss is first, not whichever shelf was walked first', () => {
  /*
    A list in the order the shelves happen to be counted buries eight missing
    bottles under a tonic that is one over.
  */
  const lines = countLines(held, shelves);
  assert.deepEqual(lines.map((l) => l.name), ['Club · Large', 'Tonic']);
  assert.equal(lines[0].variance, -8);
  assert.equal(lines[0].value, 8000);
});

test('a line that matched is not in the email, and one already decided is not either', () => {
  assert.equal(countLines(held, shelves).length, 2);
  assert.deepEqual(countLines([
    { $id: 'a', ingredient_id: 'i1', applied: false, approved_at: '2026-09-06T00:00:00Z', variance_qty: -8 },
    { $id: 'b', ingredient_id: 'i1', applied: false, rejected_at: '2026-09-06T00:00:00Z', variance_qty: -8 },
  ], shelves), []);
});

test('a shelf that has since been removed says so rather than showing an id', () => {
  // A raw id in an email looks like data, so somebody tries to make sense of it.
  const [line] = countLines([{ $id: 'a', ingredient_id: 'gone', applied: false, variance_qty: -1 }], shelves);
  assert.equal(line.name, 'A shelf no longer named');
});

test('the subject says how many, which end of the shift, and how much is short', () => {
  assert.equal(
    countSubject({ phase: 'close', lines: 2, shortValue: 8000, money }),
    '2 differences on the bar count (counting out), GH¢80.00 short',
  );
  assert.equal(
    countSubject({ phase: 'open', lines: 1, shortValue: 0, money }),
    '1 difference on the bar count (counting in)',
  );
});

test('the body names each shelf, what it should have been, and what was counted', () => {
  /**
   * The difference between an email that gets read and one that gets archived.
   * "Club · Large, 8 short" is a conversation somebody can have with the person
   * who counted it, tonight; "6 lines, GH₵60" is a number to look at later.
   */
  const html = countBody({ lines: countLines(held, shelves), who: 'Regina', phase: 'close', money });
  assert.match(html, /Regina counted the bar out at the end of the shift/);
  assert.match(html, /<strong>Club · Large<\/strong> — 8 short, GH¢80.00/);
  assert.match(html, /Should have been 48, counted 40/);
  assert.match(html, /<strong>Tonic<\/strong> — 1 over/);
});

test('the body says the shelf has NOT moved, which is the part that makes anybody act', () => {
  /*
    Somebody who believes the figures are already corrected has no reason to
    open anything.
  */
  const html = countBody({ lines: countLines(held, shelves), who: '', phase: 'close', money });
  assert.match(html, /<strong>The stock figures have not moved.<\/strong>/);
  assert.match(html, /Bar, Counts and variances/);
  // And with nobody named it still reads as a sentence.
  assert.match(html, /The bar was counted out/);
});
