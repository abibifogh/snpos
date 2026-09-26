import test from 'node:test';
import assert from 'node:assert/strict';
import { linePrice, linePrep, isVoid, tillSale, addonsPriced } from '../../../../functions/order-guard/src/reprice.js';

/*
  ORD0866. A quesadilla at GH₵90 and a kelewele at GH₵40, both on the bill,
  both cooked, both eaten — and a total of GH₵90.

  The server reprices every line from the database, because a customer's phone
  sends its own figures and must never be trusted. A line whose dish it could
  not read was SKIPPED: it stayed on the order, kept its price on screen, and
  contributed nothing to the total that was then written over the order. The
  bill did not add up to its own items and nothing anywhere said so.

  A dish deleted or re-created since the sale does that every time. So does one
  failed read, because a read that throws and a dish that no longer exists come
  back as the same null.
*/

const item = (over: Record<string, unknown> = {}) => ({
  $id: 'i1',
  name_snapshot: 'Kelewele',
  menu_item_id: 'm-kelewele',
  qty: 1,
  unit_price: 4000,
  line_total: 4000,
  status: 'queued',
  ...over,
});

test('THE BUG: a line whose dish cannot be read is still charged for', () => {
  const priced = linePrice({ item: item(), menuItem: null });
  assert.equal(priced.amount, 4000, 'kept at what it was sold for, not dropped to nothing');
  assert.equal(priced.rewrite, null, 'and nothing is rewritten from a menu that cannot be read');
  assert.match(String(priced.correction), /not on the menu now/i);
  assert.match(String(priced.correction), /Kelewele/, 'and it names the dish');
});

test('ORD0866 adds up again', () => {
  // The whole order, priced the way the server prices it.
  const lines = [
    { it: item({ $id: 'i0', name_snapshot: 'Veggie quesadilla', menu_item_id: 'm-q', line_total: 9000 }), menu: { price: 9000 } },
    { it: item(), menu: null as null | { price: number } },
  ];
  const subtotal = lines.reduce(
    (sum, l) => sum + linePrice({ item: l.it, menuItem: l.menu }).amount,
    0,
  );
  assert.equal(subtotal, 13_000, 'GH₵130.00, which is what the two lines say');
});

test('no live line can ever contribute nothing', () => {
  /*
    The invariant the fault broke. Whatever is wrong with a line — no dish, no
    price, a shape nobody expected — it is never silently free.
  */
  const awkward = [
    { item: item(), menuItem: null },
    { item: item({ qty: 0 }), menuItem: null },
    { item: item({ line_total: undefined }), menuItem: null },
    { item: item({ name_snapshot: '' }), menuItem: null },
    { item: item({ menu_item_id: '' }), menuItem: null },
  ];
  for (const one of awkward) {
    const priced = linePrice(one);
    assert.equal(typeof priced.amount, 'number', 'always a number');
    assert.ok(Number.isFinite(priced.amount), `finite, got ${priced.amount}`);
    assert.ok(priced.amount >= 0, 'never negative');
  }
});

/* ------------------------------------------- what repricing is actually for */

test('a phone claiming its own price is put right', () => {
  // The reason this code exists at all.
  const priced = linePrice({ item: item({ line_total: 100 }), menuItem: { price: 4000 } });
  assert.equal(priced.amount, 4000);
  assert.deepEqual(priced.rewrite, { unit_price: 4000, line_total: 4000 });
  assert.match(String(priced.correction), /sent 100, actual 4000/);
});

test('a correct line is left alone, and says nothing', () => {
  const priced = linePrice({ item: item(), menuItem: { price: 4000 } });
  assert.equal(priced.amount, 4000);
  assert.equal(priced.rewrite, null, 'no pointless write');
  assert.equal(priced.correction, null, 'and no note about a line that was right');
});

test('quantity is multiplied, add-ons are added to the unit', () => {
  const priced = linePrice({
    item: item({ qty: 3, line_total: 0 }),
    menuItem: { price: 4000 },
    addonTotal: 500,
  });
  assert.equal(priced.amount, 13_500, '(4000 + 500) x 3');
});

test('a venue price override beats the menu price', () => {
  const priced = linePrice({ item: item(), menuItem: { price: 4000 }, overridePrice: 3500 });
  assert.equal(priced.amount, 3500);
});

test('an override of zero is a real price, not a missing one', () => {
  // A dish given away at one venue. `?? menuItem.price` would have been right
  // here and `|| menuItem.price` catastrophically wrong, so it is pinned.
  const priced = linePrice({ item: item(), menuItem: { price: 4000 }, overridePrice: 0 });
  assert.equal(priced.amount, 0);
});

test('a price a member of staff set at the till stands', () => {
  /*
    A chipped piece, a maker's price for a friend. Without this the guard puts
    the line back to the shelf price a second after the sale, and the till
    appears to forget what it was just told.
  */
  const priced = linePrice({
    item: item({ line_total: 2500, list_price: 4000 }),
    menuItem: { price: 4000 },
  });
  assert.equal(priced.amount, 2500, 'what it was actually sold for');
  assert.equal(priced.rewrite, null);
});

test('a staff price of zero is still a decision somebody made', () => {
  const priced = linePrice({ item: item({ line_total: 0, list_price: 4000 }), menuItem: { price: 4000 } });
  assert.equal(priced.amount, 0);
  assert.equal(priced.rewrite, null, 'not re-priced back up to the menu');
});

/* ------------------------------------------------------------ lines that are off */

test('a voided line is worth nothing and is not a correction', () => {
  const priced = linePrice({ item: item({ status: 'void' }), menuItem: { price: 4000 } });
  assert.equal(priced.amount, 0);
  assert.equal(priced.rewrite, null);
  assert.equal(priced.correction, null, 'nothing to tell anybody: it was taken off deliberately');
  assert.equal(isVoid(item({ status: 'void' })), true);
  assert.equal(isVoid(item()), false);
});

/* --------------------------------------------------------------- the quote */

test('cooking time comes from the line when the dish cannot be read', () => {
  /*
    The prep time is snapshotted onto the line when the order is placed, for
    exactly this case. Falling back to a flat fifteen would re-quote a
    forty-minute dish as a quarter of an hour.
  */
  assert.equal(linePrep(item({ prep_minutes: 40 }), null), 40);
  assert.equal(linePrep(item({ prep_minutes: 40 }), { prep_minutes: 25 }), 25, 'the dish wins where it is readable');
  assert.equal(linePrep(item(), null), 15, 'and a sane default where neither says');
  assert.equal(linePrep(item({ prep_minutes: 0 }), null), 15, 'nought minutes is missing, not instant');
});

/* ------------------------------------------------------------ sizes */

test('a size is charged its own price, not the drink\'s', () => {
  /*
    The real one: Club is GH₵25, a large Club GH₵30. The till charged 30 and
    the server rewrote it to 25 a second later, because it priced every line
    from the drink alone.
  */
  const club = { price: 2_500 };
  const large = { price: 3_000 };
  const line = { name_snapshot: 'Club · Large', variant_id: 'v-large', qty: 1, unit_price: 3_000, line_total: 3_000 };
  const priced = linePrice({ item: line, menuItem: club, variant: large });
  assert.equal(priced.amount, 3_000);
  assert.equal(priced.rewrite, null, 'nothing to correct: the till had it right');
  assert.equal(priced.correction, null);
});

test('a size sent at the wrong price is corrected to the size\'s price', () => {
  // The guard still does its job: a phone claiming less is put right — to
  // the SIZE's price.
  const line = { name_snapshot: 'Club · Large', variant_id: 'v-large', qty: 2, unit_price: 100, line_total: 200 };
  const priced = linePrice({ item: line, menuItem: { price: 2_500 }, variant: { price: 3_000 } });
  assert.equal(priced.amount, 6_000);
  assert.deepEqual(priced.rewrite, { unit_price: 3_000, line_total: 6_000 });
});

test('a size costing LESS than the drink is not overcharged either', () => {
  const line = { name_snapshot: 'Club · Small', variant_id: 'v-small', qty: 1, unit_price: 2_000, line_total: 2_000 };
  assert.equal(linePrice({ item: line, menuItem: { price: 2_500 }, variant: { price: 2_000 } }).amount, 2_000);
});

test('choices go on top of the size\'s price, as the till adds them', () => {
  const line = { name_snapshot: 'Club · Large', variant_id: 'v', qty: 1, unit_price: 3_000, line_total: 3_500 };
  const priced = linePrice({ item: line, menuItem: { price: 2_500 }, variant: { price: 3_000 }, addonTotal: 500 });
  assert.equal(priced.amount, 3_500);
  assert.equal(priced.rewrite, null);
});

test('a venue\'s own price for the drink does not override a size', () => {
  // The till charges the size's price whatever the venue charges for the
  // plain drink, so the guard must agree with it.
  const line = { name_snapshot: 'Club · Large', variant_id: 'v', qty: 1, unit_price: 3_000, line_total: 3_000 };
  const priced = linePrice({ item: line, menuItem: { price: 2_500 }, overridePrice: 2_700, variant: { price: 3_000 } });
  assert.equal(priced.amount, 3_000);
});

test('a size that cannot be read keeps what it was sold for, never the drink\'s price', () => {
  // Falling back to the drink's price is exactly the mistake this replaces.
  const line = { name_snapshot: 'Club · Large', variant_id: 'v-gone', qty: 1, unit_price: 3_000, line_total: 3_000 };
  const priced = linePrice({ item: line, menuItem: { price: 2_500 }, variant: null });
  assert.equal(priced.amount, 3_000);
  assert.equal(priced.rewrite, null);
  assert.match(String(priced.correction), /size could not be read/);
});

test('a line with no size is priced from the drink as it always was', () => {
  const line = { name_snapshot: 'Club', qty: 1, unit_price: 2_500, line_total: 2_500 };
  assert.equal(linePrice({ item: line, menuItem: { price: 2_500 } }).amount, 2_500);
  assert.equal(linePrice({ item: line, menuItem: { price: 2_500 }, overridePrice: 2_700 }).amount, 2_700);
});

/* ------------------------------------------- what the till charged stands */

test('a bill rung up at the till keeps its price; a phone order is still checked', () => {
  /*
    Club · Large: the till charged GH₵30, the customer paid GH₵30, and the
    server rewrote the line to GH₵25 a second later. A month of sales was
    understated while every drawer balanced. A till names its shift; a phone
    cannot, because a guest cannot read the shifts.
  */
  const shift = { $id: 'sh1', venue_id: 'main' };
  const till = { channel: 'counter', shift_id: 'sh1', venue_id: 'main' };
  assert.equal(tillSale(till, shift), true);
  assert.equal(tillSale({ ...till, channel: 'waiter' }, shift), true);

  assert.equal(tillSale({ channel: 'qr', shift_id: '', venue_id: 'main' }, null), false, 'a phone at a table');
  assert.equal(tillSale({ channel: 'takeaway', shift_id: '', venue_id: 'main' }, null), false, 'a phone takeaway');
  // A phone claiming to be a till, with a shift id it cannot have read.
  assert.equal(tillSale({ channel: 'counter', shift_id: 'made-up', venue_id: 'main' }, null), false);
  // A real shift, but the order says it is a phone order.
  assert.equal(tillSale({ ...till, channel: 'qr' }, shift), false);
  // A shift from another venue does not vouch for this one.
  assert.equal(tillSale(till, { $id: 'sh1', venue_id: 'other' }), false);
  // A till order sent with no shift open is checked like any other.
  assert.equal(tillSale({ ...till, shift_id: '' }, null), false);
});

test('a choice picked twice is charged twice, as the till adds it', () => {
  // "Extra shot × 2" was one shot on the server and two on the till.
  assert.equal(addonsPriced([{ qty: 2 }, {}], [{ price_delta: 500 }, { price_delta: 300 }]), 1_300);
  // A choice that could not be read adds nothing rather than a guess.
  assert.equal(addonsPriced([{ qty: 1 }], [null]), 0);
  assert.equal(addonsPriced([], []), 0);
});
