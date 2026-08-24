import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expenseDraftKey, draftWorthKeeping, saveExpenseDraft, readExpenseDraft, clearExpenseDraft,
  type DraftStore, type ExpenseDraft,
  countDraftKey, saveCountDraft, readCountDraft, restoreCount, draftFromCount,
} from '../expense-draft.ts';

/** A store that behaves, and one that does not. */
const memory = (): DraftStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
};

const hostile = (): DraftStore => ({
  getItem() { throw new Error('storage is off'); },
  setItem() { throw new Error('quota'); },
  removeItem() { throw new Error('nope'); },
});

test('a draft belongs to one person on one shift', () => {
  /**
   * Two cooks share a kitchen screen. A draft that survived a handover would
   * put one person's half-typed market run in front of the next person to open
   * the form, who would either save somebody else's figures or clear it and
   * learn not to trust the feature. And a draft from last night belongs to a
   * drawer that has already been counted.
   */
  const a = expenseDraftKey('v1', 'shift-1', 'ama');
  assert.notEqual(a, expenseDraftKey('v1', 'shift-1', 'kofi'), 'not shared between people');
  assert.notEqual(a, expenseDraftKey('v1', 'shift-2', 'ama'), 'not carried across shifts');
  assert.notEqual(a, expenseDraftKey('v2', 'shift-1', 'ama'), 'not carried across venues');
  // Missing pieces still produce a usable key rather than colliding on ''.
  assert.equal(expenseDraftKey('v1', '', ''), 'snpos.expense-draft.v1.none.anon');
});

test('an untouched form is not unfinished work', () => {
  /**
   * The category and the payment method are filled in for you when the form
   * opens. Counting them would make every form somebody opened and closed look
   * like recovered work, and "Picked up where you left off" in front of
   * somebody who left nothing off teaches them the message means nothing.
   */
  assert.equal(draftWorthKeeping(null), false);
  assert.equal(draftWorthKeeping({}), false);
  assert.equal(draftWorthKeeping({ categoryKey: 'gas', methodId: 'cash-1' }), false);
  assert.equal(draftWorthKeeping({ amountText: '   ' }), false, 'whitespace is not typing');
  assert.equal(
    draftWorthKeeping({ lines: [{ ingredientId: '', qtyText: '', totalText: '' }] }),
    false,
    'the empty line the form always starts with',
  );
});

test('anything actually typed is worth keeping', () => {
  assert.equal(draftWorthKeeping({ amountText: '120' }), true);
  assert.equal(draftWorthKeeping({ payee: 'Mama Efua' }), true);
  assert.equal(draftWorthKeeping({ noteText: 'gas refill' }), true);
  assert.equal(draftWorthKeeping({ supplierId: 's1' }), true);
  assert.equal(draftWorthKeeping({ staffId: 'p1' }), true);
  assert.equal(
    draftWorthKeeping({ lines: [{ ingredientId: 'rice', qtyText: '', totalText: '' }] }),
    true,
    'a line with an item chosen and nothing else is still work',
  );
});

test('a draft survives the round trip, and saving nothing clears it', () => {
  const store = memory();
  const key = expenseDraftKey('v1', 's1', 'ama');
  const draft: ExpenseDraft = {
    categoryKey: 'market', amountText: '120', payee: 'Mama Efua', fromDrawer: true,
    lines: [{ ingredientId: 'rice', qtyText: '5', totalText: '120' }],
  };

  saveExpenseDraft(store, key, draft);
  assert.deepEqual(readExpenseDraft(store, key), draft);

  // Emptying the form clears the draft rather than storing a blank one, so
  // reopening does not announce recovered work that is not there.
  saveExpenseDraft(store, key, { categoryKey: 'market' });
  assert.equal(readExpenseDraft(store, key), null);
  assert.equal(store.data.has(key), false);
});

test('a saved expense takes its draft with it', () => {
  const store = memory();
  const key = expenseDraftKey('v1', 's1', 'ama');
  saveExpenseDraft(store, key, { amountText: '120' });
  clearExpenseDraft(store, key);
  assert.equal(readExpenseDraft(store, key), null);
});

test('unreadable storage never stops somebody recording money that left the till', () => {
  /**
   * Private browsing, a full disk, a device being awkward. Losing a draft is a
   * nuisance; a form that throws while somebody is typing an amount is a hole
   * in the drawer nobody can explain.
   */
  const bad = hostile();
  assert.doesNotThrow(() => saveExpenseDraft(bad, 'k', { amountText: '5' }));
  assert.doesNotThrow(() => clearExpenseDraft(bad, 'k'));
  assert.equal(readExpenseDraft(bad, 'k'), null);

  // No storage at all, which is what a server render has.
  assert.doesNotThrow(() => saveExpenseDraft(null, 'k', { amountText: '5' }));
  assert.equal(readExpenseDraft(undefined, 'k'), null);
});

test('rubbish in storage is ignored rather than restored', () => {
  const store = memory();
  for (const junk of ['not json', 'null', '"a string"', '[1,2,3]', '{}']) {
    store.data.set('k', junk);
    assert.equal(readExpenseDraft(store, 'k'), null, `restored from ${junk}`);
  }
});

/* ------------------------------------------------ a count left half done */

test('counting in and counting out keep separate drafts', () => {
  /*
    Two different pieces of work on the same shift. Restoring one onto the
    other would put last night's closing numbers into this morning's opening
    sheet, which is a shortage nobody caused.
  */
  assert.notEqual(countDraftKey('shift1', 'open'), countDraftKey('shift1', 'close'));
  assert.notEqual(countDraftKey('shift1', 'open', 'bar'), countDraftKey('shift1', 'open', 'store'));
});

test('what was typed survives leaving the sheet', () => {
  const store = memory();
  const key = countDraftKey('shift1', 'open');
  saveCountDraft(store, key, draftFromCount([
    { ingredientId: 'gin', countedText: '12' },
    { ingredientId: 'rum', countedText: '' },
  ]));
  // No `note` key at all: JSON drops undefined, and the round trip is what
  // the sheet actually gets back.
  assert.deepEqual(readCountDraft(store, key), { gin: { countedText: '12' } });
});

test('an empty sheet is not a draft', () => {
  // Nothing typed is nothing to recover, and announcing a recovered count
  // that is blank teaches people to distrust the recovery.
  const store = memory();
  const key = countDraftKey('shift1', 'open');
  saveCountDraft(store, key, draftFromCount([{ ingredientId: 'gin', countedText: '  ' }]));
  assert.equal(readCountDraft(store, key), null);
});

test('the sheet decides what is on it, the draft only what was typed', () => {
  /*
    A bottle added to the bar this morning has to appear even though nothing
    was typed against it yesterday, and one taken off has to go however
    carefully it was counted. The draft restores typing, never lines.
  */
  const restored = restoreCount(
    [{ ingredientId: 'gin', countedText: '' }, { ingredientId: 'tonic', countedText: '' }],
    { gin: { countedText: '12' }, vodka: { countedText: '9' } },
  );
  assert.deepEqual(restored.map((r) => r.ingredientId), ['gin', 'tonic']);
  assert.equal(restored[0].countedText, '12');
  assert.equal(restored[1].countedText, '');
});

test('a count of nought is kept, because nought is an answer', () => {
  // "There are none" is the finding that matters most on a bar sheet, and
  // treating it as nothing typed would throw away exactly that.
  const store = memory();
  const key = countDraftKey('shift1', 'close');
  saveCountDraft(store, key, draftFromCount([{ ingredientId: 'gin', countedText: '0' }]));
  assert.deepEqual(readCountDraft(store, key), { gin: { countedText: '0' } });
});
