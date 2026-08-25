/**
 * One change to a shelf figure at a time, and an admin says yes or no.
 *
 * The craft shop's count already worked this way: somebody walks the shelves,
 * writes down what is there, and nothing moves until an admin signs it off.
 * The products page did not. It has a box saying how many are on the shelf, and
 * anybody who may edit the catalogue could type over it — no movement written,
 * no trail, and no second pair of eyes.
 *
 * That is the one write in the shop that can make stock disappear with no sale
 * behind it, which is exactly what the count was built to control, so it should
 * not have a side door standing open next to it.
 *
 * The rule, in one sentence: a shelf figure that has been changed is FROZEN
 * until an admin has decided about the change. Not "the change lands and gets
 * reviewed later" — a figure that is already wrong is one the till sells
 * against, and nothing is gained by writing it down before somebody has agreed
 * with it. So the change waits, the piece cannot be changed again while it
 * waits, and an admin approving or turning it down is what releases it.
 *
 * Frozen for everybody, admins included. It reads as strict and it is the only
 * version that cannot deadlock or be walked around: the admin's way past is one
 * tap away at the approvals desk, and a control an admin can silently overwrite
 * from the other screen is a control that is not there.
 *
 * Pure. Nothing here reads or writes anything.
 */

import type { PendingCountLine } from './stocktake';

/**
 * One sellable thing on a shelf: a product, or one of its sizes.
 *
 * A basket in three sizes is three shelves, three figures and three separate
 * decisions, which is why the key carries the size and not just the product.
 */
export interface ShelfPiece {
  menuItemId: string;
  variantId?: string;
  name: string;
  variantLabel?: string;
  onHand: number;
}

/**
 * How a piece is named to itself.
 *
 * The empty half matters: a product with no sizes has its own figure, and its
 * key must not collide with a size of the same product that arrives later.
 */
export const pieceKey = (menuItemId: string, variantId?: string): string =>
  `${menuItemId}:${variantId ?? ''}`;

/**
 * A change to one shelf figure that an admin has not decided about yet.
 *
 * The line says what the change is; the two fields beside it come from the
 * count it belongs to, and are carried here so a screen showing "you cannot
 * change this" can say who is being waited for and since when. A message that
 * withholds that is a message people bring to the owner rather than act on.
 */
export interface WaitingChange {
  line: PendingCountLine;
  countId: string;
  /** The user who sent it. */
  by: string;
  at: string;
}

/**
 * Every piece with a change waiting on it, by key.
 *
 * Built from the lines of counts that are still pending. Lines already applied
 * are not waiting for anything — a count left half-finished by a failure has
 * its applied lines marked, and those pieces are free.
 */
export function frozenPieces(changes: WaitingChange[]): Map<string, WaitingChange> {
  const frozen = new Map<string, WaitingChange>();
  for (const change of changes) {
    if (change.line.applied) continue;
    const key = pieceKey(change.line.menu_item_id, change.line.variant_id || undefined);
    const held = frozen.get(key);
    // The OLDEST wins. Two waiting on one piece should not happen — this is
    // what stops it — but where a pair does exist, the first one sent is the
    // one that has to be cleared first, and naming the other would send
    // somebody to the desk to approve a change that will not release anything.
    if (!held || change.at < held.at) frozen.set(key, change);
  }
  return frozen;
}

/** The change waiting on this piece, or nothing. */
export const frozenBy = (
  frozen: Map<string, WaitingChange>,
  menuItemId: string,
  variantId?: string,
): WaitingChange | null => frozen.get(pieceKey(menuItemId, variantId)) ?? null;

/**
 * What to say on a box somebody cannot type in.
 *
 * A disabled field with nothing beside it is read as a fault in the system, and
 * it is read that way every time until somebody says otherwise. So it says the
 * figure that is waiting, who is waiting for it, and where the answer comes
 * from — which is the whole of what anybody standing there needs.
 */
export function waitingWords(change: WaitingChange, who?: string): string {
  const { line } = change;
  const moved = line.counted - line.expected;
  const direction = moved > 0 ? `up ${moved}` : `down ${-moved}`;
  return `${who ? `${who} changed` : 'Changed'} this from ${line.expected} to ${line.counted} `
    + `(${direction}), and it is waiting for an admin. It cannot be changed again until that is `
    + 'approved or turned down under Count the shelf → Approvals.';
}

/**
 * Why this figure cannot stand, or nothing.
 *
 * Refusals only where the result would be wrong. A shelf figure is a count of
 * whole objects that are either there or not, so a fraction and a negative are
 * both meaningless rather than merely unusual.
 *
 * Typing the same figure back is NOT a problem — it is the ordinary case of
 * somebody editing a price and leaving the count alone. Whether there is
 * anything to send is `shelfMoved`'s question, asked separately so that a save
 * touching nothing on the shelf is never held up by this at all.
 */
export function shelfChangeProblem(typed: string): string | null {
  const text = typed.trim();
  if (text === '') return 'Say how many are on the shelf.';
  const n = Number(text);
  if (!Number.isFinite(n)) return 'That is not a number.';
  if (n < 0) return 'A shelf cannot hold less than nothing.';
  if (!Number.isInteger(n)) return 'Pieces are counted whole. Enter a round number.';
  return null;
}

/**
 * Has the shelf figure actually moved?
 *
 * Asked separately from whether it is valid, because a save that touches the
 * price and leaves the count alone must not queue a change for an admin to
 * approve. Most edits to a product are not about the shelf at all.
 */
export function shelfMoved(was: number, typed: string): boolean {
  const text = typed.trim();
  if (text === '') return false;
  const n = Number(text);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n !== was;
}

/**
 * Does this edit have to go past an admin?
 *
 * Three things have to be true at once, and each of them is there to keep this
 * out of the way of work it has no business in:
 *
 *   - THE CRAFT SHOP. A kitchen's rice is counted by weight against a recipe
 *     and a bar's bottles are counted twice a shift by the person answerable
 *     for them. Neither has a piece count on a product, and neither should
 *     inherit a shop's control.
 *   - A PRODUCT THAT ALREADY EXISTS. The figure on a new piece is not an
 *     adjustment, it is what arrived — there is no previous number to disagree
 *     with, so there is nothing to approve.
 *   - THE FIGURE MOVED. See above.
 */
export function needsApproval(opts: {
  module?: string;
  existing: boolean;
  was: number;
  typed: string;
}): boolean {
  if ((opts.module ?? 'kitchen') !== 'craft') return false;
  if (!opts.existing) return false;
  return shelfMoved(opts.was, opts.typed);
}

/**
 * The sentence said back to whoever sent the change.
 *
 * Written so nobody stands there wondering whether it worked. The shelf has
 * NOT moved, and saying "saved" would be a lie that gets found out at the till.
 */
export function sentWords(name: string, was: number, now: number): string {
  return `${name} is waiting for an admin: ${was} → ${now}. The shelf still says ${was} until it is `
    + 'approved, and nobody can change this piece again while it waits.';
}
