import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pieceKey, frozenPieces, frozenBy, waitingWords, shelfChangeProblem, shelfMoved,
  needsApproval, sentWords,
  type WaitingChange,
} from '../shelf-approval.ts';
import type { PendingCountLine } from '../stocktake.ts';

const line = (over: Partial<PendingCountLine> = {}): PendingCountLine => ({
  $id: 'l1',
  count_id: 'c1',
  menu_item_id: 'p1',
  name_snapshot: 'Raffia basket',
  expected: 5,
  counted: 3,
  delta: -2,
  reason: 'counted',
  unit_price: 12000,
  ...over,
});

const change = (over: Partial<WaitingChange> = {}): WaitingChange => ({
  line: line(),
  countId: 'c1',
  by: 'u1',
  at: '2026-08-25T09:00:00.000Z',
  ...over,
});

test('a product and one of its sizes are different shelves', () => {
  /**
   * A basket in three sizes is three figures and three separate decisions.
   * Keying on the product alone would freeze all of them the moment one was
   * changed, and — worse — would let a change to the LARGE release a change to
   * the small, because they would look like the same thing waiting.
   */
  assert.notEqual(pieceKey('p1'), pieceKey('p1', 'v1'));
  assert.notEqual(pieceKey('p1', 'v1'), pieceKey('p1', 'v2'));
  // The empty half is what stops a product's own figure colliding with a size
  // added to it later.
  assert.equal(pieceKey('p1'), pieceKey('p1', undefined));
  assert.equal(pieceKey('p1'), 'p1:');
});

test('a change already applied is not waiting for anybody', () => {
  /*
    A count stopped half way through by a failure stays pending, with the lines
    that DID land marked applied. Those pieces have already moved; holding them
    would leave a shelf nobody can correct and an approval that releases
    nothing.
  */
  const frozen = frozenPieces([
    change({ line: line({ applied: true }) }),
    change({ line: line({ menu_item_id: 'p2', applied: false }) }),
  ]);
  assert.equal(frozenBy(frozen, 'p1'), null);
  assert.ok(frozenBy(frozen, 'p2'));
});

test('where two are waiting on one piece, the older one holds it', () => {
  /**
   * This should not happen — stopping it is the whole point — but if a pair
   * ever exists, naming the newer one would send somebody to the approvals
   * desk to sign off a change that then releases nothing, because the older
   * one is still there.
   */
  const older = change({ at: '2026-08-01T00:00:00.000Z', countId: 'first' });
  const newer = change({ at: '2026-08-20T00:00:00.000Z', countId: 'second' });
  assert.equal(frozenBy(frozenPieces([newer, older]), 'p1')?.countId, 'first');
  assert.equal(frozenBy(frozenPieces([older, newer]), 'p1')?.countId, 'first');
});

test('the frozen box says what is waiting, who for, and where the answer is', () => {
  /*
    A disabled field with nothing beside it is read as a fault in the system,
    and it is read that way every time until somebody says otherwise.
  */
  const words = waitingWords(change(), 'Ama');
  assert.match(words, /Ama changed/);
  assert.match(words, /from 5 to 3/);
  assert.match(words, /down 2/);
  assert.match(words, /Approvals/);

  // Nobody named is still a sentence rather than "undefined changed this".
  assert.match(waitingWords(change()), /^Changed this from 5 to 3/);
  // A surplus reads as a surplus.
  assert.match(waitingWords(change({ line: line({ expected: 3, counted: 5 }) })), /up 2/);
});

test('a shelf holds whole pieces, or none', () => {
  assert.equal(shelfChangeProblem('4'), null);
  assert.equal(shelfChangeProblem('0'), null, 'an empty shelf is an answer');
  assert.match(shelfChangeProblem('') ?? '', /Say how many/);
  assert.match(shelfChangeProblem('  ') ?? '', /Say how many/);
  assert.match(shelfChangeProblem('lots') ?? '', /not a number/);
  assert.match(shelfChangeProblem('-1') ?? '', /less than nothing/);
  assert.match(shelfChangeProblem('3.5') ?? '', /round number/);
});

test('typing the same figure back is not a change', () => {
  /**
   * Most edits to a product are not about the shelf at all. Somebody
   * correcting a price must not queue an approval for a count they never
   * touched — an approvals desk full of changes that change nothing is one
   * people wave through, and then they wave through the one that mattered.
   */
  assert.equal(shelfMoved(5, '5'), false);
  assert.equal(shelfMoved(5, ''), false, 'blank is not a change either');
  assert.equal(shelfMoved(5, '   '), false);
  assert.equal(shelfMoved(5, '3'), true);
  assert.equal(shelfMoved(5, '3.5'), false, 'and a half is not a shelf');
  assert.equal(shelfMoved(5, '-1'), false);
});

test('only the shop, only an existing piece, only a figure that moved', () => {
  const asked = { module: 'craft', existing: true, was: 5, typed: '3' };
  assert.equal(needsApproval(asked), true);

  // A kitchen counts rice by weight against a recipe and a bar counts bottles
  // twice a shift. Neither has a piece count on a product to control.
  assert.equal(needsApproval({ ...asked, module: 'kitchen' }), false);
  assert.equal(needsApproval({ ...asked, module: 'bar' }), false);
  assert.equal(needsApproval({ ...asked, module: undefined }), false);

  // The figure on a NEW piece is what arrived, not a disagreement with
  // anything. There is nothing for an admin to approve.
  assert.equal(needsApproval({ ...asked, existing: false }), false);

  assert.equal(needsApproval({ ...asked, typed: '5' }), false);
});

test('what is said back does not use the word "saved"', () => {
  /**
   * The shelf has NOT moved. Somebody who reads "Saved" walks away believing
   * the count is right and finds out it is not from a till that will not sell
   * a piece it says is there.
   */
  const words = sentWords('Raffia basket', 5, 3);
  assert.doesNotMatch(words, /saved/i);
  assert.match(words, /waiting for an admin/);
  assert.match(words, /shelf still says 5/);
});
