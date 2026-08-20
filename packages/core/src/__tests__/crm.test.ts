import test from 'node:test';
import assert from 'node:assert/strict';
import {
  identityKey, identitiesOf, phoneKey, cleanPhone, buildCustomers, sortCustomers, searchCustomers,
  summarise, anonymousCount, isRegular, contactable, toSheet, isRealSale,
  type CustomerOrder,
} from '../crm.ts';

const order = (over: Partial<CustomerOrder> = {}): CustomerOrder => ({
  $id: 'o1',
  $createdAt: '2026-08-01T10:00:00.000Z',
  total: 5_000,
  payment_status: 'paid',
  status: 'CLOSED',
  ...over,
});

test('one phone number typed three ways is one person', () => {
  /**
   * "024 123 4567", "+233 24 123 4567" and "0241234567" all get typed at a
   * counter. Comparing the raw text files them as three customers with a third
   * of the history each — worse than not grouping at all, because it looks
   * like it worked.
   */
  assert.equal(cleanPhone('024 123 4567'), '0241234567');
  assert.equal(cleanPhone('+233-24-123-4567'), '233241234567');
  /*
    Stripping punctuation is not enough: the country code and the trunk zero
    are digits too, so the raw forms still differ. The last nine are what
    identify the number.
  */
  assert.equal(phoneKey('024 123 4567'), '241234567');
  assert.equal(phoneKey('+233-24-123-4567'), '241234567');
  assert.equal(phoneKey('0241234567'), '241234567');
  const a = identityKey(order({ customer_phone: '024 123 4567' }));
  const b = identityKey(order({ customer_phone: '+233 24 123 4567' }));
  assert.equal(a, b);
});

test('an order carrying both details keeps both, not the better of the two', () => {
  /**
   * An order with a phone number AND an email is the thing that proves those
   * two belong to one person. Keeping only the stronger one throws that proof
   * away, and somebody who left a number on Monday and both on Friday comes
   * back as two customers with half their spending each.
   */
  assert.deepEqual(
    identitiesOf(order({ customer_email: 'Ama@Example.com', customer_phone: '024 000 0000' })),
    ['e:ama@example.com', 'p:240000000'],
  );
  // The first is the one a new record is filed under, so it has to be stable.
  assert.equal(identityKey(order({ customer_email: 'Ama@Example.com' })), 'e:ama@example.com');
  assert.equal(identityKey(order({ customer_phone: '0240000000' })), 'p:240000000');
});

test('a name alone is never an identity', () => {
  /**
   * Two people called Kwame are two people, and a blank name is not a match
   * with every other blank name. Merging on names would build one enormous
   * record holding most of the business's takings and call it a regular.
   */
  assert.equal(identityKey(order({ customer_name: 'Kwame' })), '');
  assert.equal(identityKey(order({})), '');
  assert.equal(buildCustomers([order({ customer_name: 'Kwame' }), order({ customer_name: 'Kwame' })]).length, 0);
});

test('a person is built from their orders, oldest first', () => {
  const rows = buildCustomers([
    order({ $id: 'a', $createdAt: '2026-06-01T10:00:00.000Z', customer_email: 'ama@x.com', customer_name: 'Ama', total: 3_000 }),
    order({ $id: 'b', $createdAt: '2026-08-01T10:00:00.000Z', customer_email: 'ama@x.com', customer_name: 'Ama Serwaa', total: 7_000 }),
  ]);
  assert.equal(rows.length, 1);
  const [ama] = rows;
  assert.equal(ama.orders, 2);
  assert.equal(ama.spent, 10_000);
  assert.equal(ama.firstSeen, '2026-06-01T10:00:00.000Z');
  assert.equal(ama.lastSeen, '2026-08-01T10:00:00.000Z');
  // The newest name wins: people correct their own spelling, or give a fuller
  // name the second time.
  assert.equal(ama.name, 'Ama Serwaa');
  // Newest first for reading.
  assert.deepEqual(ama.history.map((o) => o.$id), ['b', 'a']);
});

test('a cancelled order is not something anybody bought', () => {
  assert.equal(isRealSale(order({ status: 'CANCELLED' })), false);
  assert.equal(isRealSale(order({ status: 'REJECTED' })), false);
  const [r] = buildCustomers([
    order({ $id: 'a', customer_email: 'ama@x.com', total: 3_000 }),
    order({ $id: 'b', customer_email: 'ama@x.com', total: 9_000, status: 'CANCELLED' }),
  ]);
  assert.equal(r.orders, 1);
  assert.equal(r.spent, 3_000);
  // Still shown in their history, greyed out. It happened; it just did not sell.
  assert.equal(r.history.length, 2);
});

test('an unpaid bill is not spending', () => {
  // Counting it would make a walkout look like the best customer on the list.
  const [r] = buildCustomers([
    order({ $id: 'a', customer_email: 'ama@x.com', total: 3_000, payment_status: 'paid' }),
    order({ $id: 'b', customer_email: 'ama@x.com', total: 40_000, payment_status: 'unpaid' }),
  ]);
  assert.equal(r.orders, 2, 'both are real orders');
  assert.equal(r.spent, 3_000, 'only one is money');
});

test('a detail given later fills a gap and never overwrites an identity', () => {
  const [r] = buildCustomers([
    order({ $id: 'a', customer_phone: '0240000000' }),
    order({ $id: 'b', customer_phone: '0240000000', customer_email: 'ama@x.com' }),
  ]);
  assert.equal(r.key, 'p:240000000');
  assert.equal(r.phone, '0240000000', 'shown as it was typed, matched on its digits');
  assert.equal(r.email, 'ama@x.com', 'the email fills in a blank');
});

test('the sides somebody buys from are collected, not guessed', () => {
  const [r] = buildCustomers([
    order({ $id: 'a', customer_email: 'ama@x.com', module: 'kitchen' }),
    order({ $id: 'b', customer_email: 'ama@x.com', module: 'craft' }),
    order({ $id: 'c', customer_email: 'ama@x.com', module: 'kitchen' }),
    // No side at all is the kitchen, the same fallback the rest of the system
    // uses for rows written before the split.
    order({ $id: 'd', customer_email: 'ama@x.com' }),
  ]);
  assert.deepEqual(r.modules, ['kitchen', 'craft']);
});

test('orders with nobody attached are counted, so the page cannot lie by omission', () => {
  /**
   * A list of nine reads like the whole customer base until it says nine out
   * of what. Most orders in most restaurants are a walk-in who paid and left.
   */
  const rows = [
    order({ $id: 'a', customer_email: 'ama@x.com' }),
    order({ $id: 'b' }),
    order({ $id: 'c' }),
    order({ $id: 'd', status: 'CANCELLED' }),
  ];
  assert.equal(anonymousCount(rows), 2, 'the cancelled one is not an order anybody placed');
  assert.equal(buildCustomers(rows).length, 1);
});

test('search matches a name, an email, or a number however it was typed', () => {
  const people = buildCustomers([
    order({ $id: 'a', customer_email: 'ama@example.com', customer_name: 'Ama Serwaa' }),
    order({ $id: 'b', customer_phone: '+233 24 123 4567', customer_name: 'Kofi' }),
  ]);
  assert.equal(searchCustomers(people, 'serwaa').length, 1);
  assert.equal(searchCustomers(people, 'EXAMPLE').length, 1);
  assert.equal(searchCustomers(people, '241234567').length, 1, 'digits against digits');
  assert.equal(searchCustomers(people, '024 123').length, 1);
  assert.equal(searchCustomers(people, '').length, 2);
  // Too short to be a number: two digits would match half the list and read as
  // a broken search rather than a narrow one.
  assert.equal(searchCustomers(people, '24').length, 0);
});

test('the list can be ordered by the four questions people actually ask', () => {
  const people = buildCustomers([
    order({ $id: 'a', $createdAt: '2026-01-01T00:00:00.000Z', customer_email: 'b@x.com', customer_name: 'Bea', total: 90_000 }),
    order({ $id: 'b', $createdAt: '2026-08-01T00:00:00.000Z', customer_email: 'a@x.com', customer_name: 'Abe', total: 1_000 }),
    order({ $id: 'c', $createdAt: '2026-08-02T00:00:00.000Z', customer_email: 'a@x.com', customer_name: 'Abe', total: 1_000 }),
  ]);
  assert.deepEqual(sortCustomers(people, 'spend').map((r) => r.name), ['Bea', 'Abe']);
  assert.deepEqual(sortCustomers(people, 'orders').map((r) => r.name), ['Abe', 'Bea']);
  assert.deepEqual(sortCustomers(people, 'recent').map((r) => r.name), ['Abe', 'Bea']);
  assert.deepEqual(sortCustomers(people, 'name').map((r) => r.name), ['Abe', 'Bea']);
  // Sorting copies rather than reordering in place, so the source list a
  // screen holds is never quietly rearranged underneath it.
  assert.equal(people[0].name, 'Bea');
});

test('the totals count people, not orders', () => {
  const people = buildCustomers([
    order({ $id: 'a', customer_email: 'ama@x.com', total: 3_000 }),
    order({ $id: 'b', customer_email: 'ama@x.com', total: 3_000 }),
    order({ $id: 'c', customer_phone: '0240000000', total: 5_000 }),
  ]);
  const t = summarise(people);
  assert.equal(t.people, 2);
  assert.equal(t.withEmail, 1);
  assert.equal(t.withPhone, 1);
  assert.equal(t.returning, 1, 'only Ama has been in twice');
  assert.equal(t.spent, 11_000);
  assert.equal(isRegular(people[0]), true);
  assert.equal(contactable(people[1]), true);
});

test('the export names its money column rather than silently dividing it', () => {
  // A column that quietly turns minor units into major ones is one somebody
  // will add up against a report that did not.
  const sheet = toSheet(buildCustomers([order({ customer_email: 'ama@x.com', total: 12_345 })]));
  assert.equal(sheet.headers[4], 'Spent (minor units)');
  assert.equal(sheet.rows[0][4], 12_345);
  assert.equal(sheet.rows.length, 1);
});

test('two halves of one person are joined by the order that names both', () => {
  /**
   * The case that makes this more than a group-by: the joining evidence
   * usually arrives AFTER both halves already exist. Somebody leaves a phone
   * number for a takeaway, later gives only an email for a receipt, and later
   * still places an order carrying both. Without the merge they stay two
   * customers for ever, each with part of the story.
   */
  const rows = buildCustomers([
    order({ $id: 'a', $createdAt: '2026-06-01T00:00:00.000Z', customer_phone: '024 123 4567', total: 1_000 }),
    order({ $id: 'b', $createdAt: '2026-06-02T00:00:00.000Z', customer_email: 'ama@x.com', total: 2_000 }),
    // Nothing has linked them until now.
    order({
      $id: 'c',
      $createdAt: '2026-06-03T00:00:00.000Z',
      customer_phone: '+233 24 123 4567',
      customer_email: 'ama@x.com',
      customer_name: 'Ama',
      total: 4_000,
    }),
  ]);

  assert.equal(rows.length, 1, 'one person, not two');
  const [ama] = rows;
  assert.equal(ama.orders, 3);
  assert.equal(ama.spent, 7_000);
  assert.equal(ama.name, 'Ama');
  assert.equal(ama.firstSeen, '2026-06-01T00:00:00.000Z', 'the earlier half keeps the first-seen date');
  assert.equal(ama.lastSeen, '2026-06-03T00:00:00.000Z');
  // Their whole history, newest first, with nothing dropped in the merge.
  assert.deepEqual(ama.history.map((o) => o.$id), ['c', 'b', 'a']);
});

test('a phone number and an email that never appear together stay apart', () => {
  // Honest about the limit. Guessing from names would be worse: a wrong merge
  // credits one person's spending to another with nothing on screen to show it.
  const rows = buildCustomers([
    order({ $id: 'a', customer_phone: '0241234567', customer_name: 'Ama' }),
    order({ $id: 'b', customer_email: 'ama@x.com', customer_name: 'Ama' }),
  ]);
  assert.equal(rows.length, 2);
});

test('a search for a local number finds it stored in international form', () => {
  const people = buildCustomers([order({ customer_phone: '+233 24 123 4567', customer_name: 'Kofi' })]);
  assert.equal(searchCustomers(people, '024 123').length, 1);
  assert.equal(searchCustomers(people, '241234567').length, 1);
  assert.equal(searchCustomers(people, '0241234567').length, 1);
});
