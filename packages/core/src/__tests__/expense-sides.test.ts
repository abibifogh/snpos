import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categoriesForSide, canSeePrivateExpenses, CATEGORY_SIDES,
  expenseMethodsFor, mayComeFromShift, expenseSides, defaultExpenseSide, asksMoneySource,
  ingredientsForSide,
} from '../expense-rules.ts';

const rows = [
  { key: 'transport', module: 'general' },
  { key: 'bar_stock', module: 'bar' },
  { key: 'kitchen_stock', module: 'kitchen' },
  { key: 'craft_stock', module: 'craft' },
  { key: 'supplies' },                                  // written before sides existed
  { key: 'old_bar', module: 'bar', active: false },     // archived
  { key: 'rent', module: 'admin_only' },
];

test('a side sees its own and the shared ones, and nobody else’s', () => {
  assert.deepEqual(
    categoriesForSide(rows, 'bar').map((r) => r.key),
    ['transport', 'bar_stock', 'supplies'],
  );
  assert.deepEqual(
    categoriesForSide(rows, 'kitchen').map((r) => r.key),
    ['transport', 'kitchen_stock', 'supplies'],
  );
});

test('a category with no side reads as everywhere, not as the kitchen’s', () => {
  // Every category written before sides existed was used by all three.
  // Narrowing them to the kitchen would empty the other two lists overnight.
  for (const side of ['kitchen', 'bar', 'craft']) {
    assert.ok(categoriesForSide(rows, side).some((r) => r.key === 'supplies'), side);
  }
});

test('archived categories stay out unless asked for', () => {
  assert.equal(categoriesForSide(rows, 'bar').some((r) => r.key === 'old_bar'), false);
  assert.equal(
    categoriesForSide(rows, 'bar', { includeArchived: true }).some((r) => r.key === 'old_bar'),
    true,
  );
});

test('the sides on offer start with the shared one', () => {
  // "Everywhere" is the right default for anything somebody adds in a hurry:
  // a category on the wrong side is invisible, which reads as a bug.
  assert.equal(CATEGORY_SIDES[0].value, 'general');
  assert.deepEqual(
    CATEGORY_SIDES.map((s) => s.value),
    ['general', 'kitchen', 'bar', 'craft', 'admin_only'],
  );
});

test('the rent stays off the till', () => {
  // The point of the setting: real spending that has to be recorded and that
  // a bartender should not read off a dropdown while a customer waits.
  for (const side of ['kitchen', 'bar', 'craft']) {
    assert.equal(categoriesForSide(rows, side).some((r) => r.key === 'rent'), false, side);
  }
});

test('an admin-only category shows on every side, once it is allowed', () => {
  // Not one trade's — it is the office's — so it turns up wherever the person
  // who may see it happens to be working.
  for (const side of ['kitchen', 'bar', 'craft']) {
    assert.equal(
      categoriesForSide(rows, side, { canSeePrivate: true }).some((r) => r.key === 'rent'),
      true,
      side,
    );
  }
});

test('an admin-only category is still archived when archived', () => {
  const archived = [{ key: 'legal', module: 'admin_only', active: false }];
  assert.deepEqual(categoriesForSide(archived, 'bar', { canSeePrivate: true }), []);
});

test('admins always see them; everybody else only when granted', () => {
  assert.equal(canSeePrivateExpenses({ role: 'admin' }), true);
  assert.equal(canSeePrivateExpenses({ role: 'manager' }), false);
  assert.equal(canSeePrivateExpenses({ role: 'manager', can_see_private_expenses: true }), true);
  assert.equal(canSeePrivateExpenses({ role: 'waiter', can_see_private_expenses: false }), false);
  // Nobody signed in is nobody allowed.
  assert.equal(canSeePrivateExpenses(null), false);
  assert.equal(canSeePrivateExpenses(undefined), false);
});


test('the office may pay by any means; the till may not', () => {
  /**
   * The cash-only rule belongs to the till, and it is a good rule there: money
   * physically leaves a drawer somebody counts the same night, and that count
   * is what makes a wrong entry visible within hours.
   *
   * None of it is true in the office. The spend already happened, it may never
   * have touched a drawer, and there is no count tonight to catch anything —
   * so the restriction only forced an owner paying a supplier by transfer to
   * file it as cash against a drawer that never held it.
   */
  const methods = [
    { $id: 'm-cash', kind: 'cash' },
    { $id: 'm-bank', kind: 'bank' },
    { $id: 'm-momo', kind: 'mobile_money' },
  ];
  const cashOnly = { expense_paid_from: 'cash_only' as const };

  assert.deepEqual(expenseMethodsFor(methods, cashOnly, 'till').map((m) => m.$id), ['m-cash']);
  assert.deepEqual(expenseMethodsFor(methods, cashOnly, 'office').map((m) => m.$id),
    ['m-cash', 'm-bank', 'm-momo']);

  // And the setting still frees the till where a house genuinely pays that way.
  assert.equal(expenseMethodsFor(methods, { expense_paid_from: 'any' }, 'till').length, 3);
});

test('a drawer is only offered where a drawer is involved', () => {
  /**
   * An expense typed up in the office on Thursday for a Tuesday market run
   * comes out of no drawer being counted tonight. Filing it against one makes
   * that shift short by money its cashier never handled — a shortage the
   * system invented, with somebody's name against it.
   */
  assert.equal(mayComeFromShift('office', false), false);
  assert.equal(mayComeFromShift('till', false), true, 'at the till it always is');
});

test('correcting a shift expense keeps the option that makes it correctable', () => {
  /*
    The reason the field is on the admin screen at all: a cook can get it wrong
    in either direction, and somebody has to be able to put it right. Taking
    the option away from a correction would make the mistake permanent.
  */
  assert.equal(mayComeFromShift('office', true), true);
});

test('an expense can be filed under every side the business runs', () => {
  /**
   * This was two hard-coded options from when there were two sides, so a bar
   * expense could not be filed as the bar's at all — it went into the books as
   * the kitchen's and stayed there. Which also hid every bar-only category,
   * because the categories follow the side.
   */
  const order = ['kitchen', 'craft', 'bar'];
  assert.deepEqual(
    expenseSides({ kitchen: true, craft: true, bar: true }, order),
    ['kitchen', 'craft', 'bar'],
  );
  assert.deepEqual(expenseSides({ kitchen: true, craft: false, bar: true }, order), ['kitchen', 'bar']);
  assert.deepEqual(expenseSides({ kitchen: true, craft: false, bar: false }, order), ['kitchen']);
});

test('a new expense starts on the side the list is filtered to', () => {
  /**
   * Somebody who has narrowed the page to the bar and pressed Record expense
   * has already said which side they mean. Asking again is asking a question
   * they have answered, and what gets left in place is whichever side happened
   * to be first — which is how a bar expense lands in the kitchen's books by
   * nobody's decision.
   */
  const sides = ['kitchen', 'craft', 'bar'];
  assert.equal(defaultExpenseSide('bar', sides), 'bar');
  assert.equal(defaultExpenseSide('craft', sides), 'craft');

  // "All" is not an answer, so it falls through to the first side that runs.
  assert.equal(defaultExpenseSide('all', sides), 'kitchen');
  assert.equal(defaultExpenseSide(undefined, sides), 'kitchen');

  // A filter naming a side the business does not run is not an answer either.
  assert.equal(defaultExpenseSide('bar', ['kitchen']), 'kitchen');
  assert.equal(defaultExpenseSide('bar', []), undefined);
});

test('the side decides which categories are on offer, so it has to be set', () => {
  /**
   * The categories always honoured their "Shown on" setting. What went wrong is
   * that a new expense had no side on it, so the form read it as the kitchen —
   * and every bar-only and shop-only category was invisible on every new
   * expense, on a page where the bar could not be chosen anyway.
   */
  const cats = [
    { key: 'transport', module: 'general' },
    { key: 'bar_stock', module: 'bar' },
    { key: 'craft_stock', module: 'craft' },
  ];
  assert.deepEqual(
    categoriesForSide(cats, 'bar').map((c) => c.key),
    ['transport', 'bar_stock'],
  );
  assert.deepEqual(
    categoriesForSide(cats, 'kitchen').map((c) => c.key),
    ['transport'],
    'which is all a bar expense could ever see while the form said kitchen',
  );
});


test('a bank account is for paying out, never for taking money', () => {
  /**
   * A supplier is paid by transfer and that has to be sayable on an expense.
   * Nobody settles a bar bill by transfer at the counter, so the same row must
   * not appear on the payment screen beside Cash and Card, where it would only
   * ever be the wrong answer — and where choosing it would put a sale's money
   * against a drawer nobody counts.
   *
   * The alternative was leaving it disabled, which hides it from the expense
   * form too; and the one after that was letting people file transfers as
   * cash, which is a shortage somebody has to account for at midnight.
   */
  const methods = [
    { $id: 'm-cash', kind: 'cash', enabled: true },
    { $id: 'm-bank', kind: 'bank', enabled: true, payouts_only: true },
  ];
  const takingMoney = methods.filter((m) => m.enabled && m.payouts_only !== true);
  assert.deepEqual(takingMoney.map((m) => m.$id), ['m-cash']);

  // And it IS on the office's list of ways money goes out.
  assert.deepEqual(
    expenseMethodsFor(methods.filter((m) => m.enabled), { expense_paid_from: 'cash_only' }, 'office')
      .map((m) => m.$id),
    ['m-cash', 'm-bank'],
  );
});


test('a method that is itself the answer is not asked the question again', () => {
  /**
   * "Paid from: Bank transfer" says where the money came from — the bank. The
   * form then asked again, offering a shift's drawer and a petty cash tin, and
   * both are wrong: a transfer never came off a drawer and never came out of a
   * tin. Whichever was left in place was false, and the screen went on to warn
   * that no tin was set up for a spend no tin should ever be lighter for.
   *
   * The distinction is not the word "bank". It is whether money only ever goes
   * OUT this way — an account rather than a drawer.
   */
  assert.equal(asksMoneySource({ payouts_only: true }), false);

  // Cash and mobile money genuinely could be either the shift's takings or a
  // tin, and which one decides whether a drawer is counted short tonight.
  assert.equal(asksMoneySource({ payouts_only: false }), true);
  assert.equal(asksMoneySource({}), true, 'absent means an ordinary method');
  assert.equal(asksMoneySource(undefined), true, 'nothing chosen yet still asks');
  assert.equal(asksMoneySource(null), true);
});


test('an expense can only be itemised into its own side\'s stock', () => {
  /**
   * The admin form offered every ingredient the business owns whichever side
   * was chosen, so a bar purchase listed rice beside the gin.
   *
   * Not a tidy-up matter. Picking the wrong side's ingredient raises THAT
   * side's stock and lands the delivery in THAT side's store room, because a
   * purchase goes wherever the ingredient's own side keeps things — so the
   * bar's money would buy gin onto the kitchen's shelf, and the bar's count
   * would come up short of a bottle nobody could account for.
   */
  const rows = [
    { $id: 'gin', module: 'bar' },
    { $id: 'rice', module: 'kitchen' },
    { $id: 'beads', module: 'craft' },
    { $id: 'salt' },
  ];

  assert.deepEqual(ingredientsForSide(rows, 'bar').map((i) => i.$id), ['gin']);
  assert.deepEqual(ingredientsForSide(rows, 'craft').map((i) => i.$id), ['beads']);
  // Rows written before sides existed are the kitchen's, which is what they
  // were — the same fallback the rest of the system uses.
  assert.deepEqual(ingredientsForSide(rows, 'kitchen').map((i) => i.$id), ['rice', 'salt']);
  assert.deepEqual(ingredientsForSide(rows, undefined).map((i) => i.$id), ['rice', 'salt']);
});

test('a line somebody already typed never goes blank underneath them', () => {
  /**
   * Filtering a chosen ingredient out of its own dropdown makes that row show
   * empty, and the next save writes whatever the blank resolves to — a screen
   * quietly changing an answer it was given. Older expenses recorded before
   * the sides were tidied are exactly where this happens.
   */
  const rows = [{ $id: 'gin', module: 'bar' }, { $id: 'rice', module: 'kitchen' }];
  assert.deepEqual(ingredientsForSide(rows, 'bar', ['rice']).map((i) => i.$id), ['gin', 'rice']);
  // Nothing chosen, nothing kept.
  assert.deepEqual(ingredientsForSide(rows, 'bar', [undefined, '']).map((i) => i.$id), ['gin']);
});
