/**
 * Reading a quantity somebody has typed.
 *
 * The plus and minus buttons are right for a guest ordering two of something
 * and hopeless for a hotel ordering forty: nobody taps a button forty times,
 * and somebody who tries will lose count. So the number between them is a box
 * that can be typed into, and this is what turns what was typed into a figure
 * the order can carry.
 *
 * Deliberately forgiving about the typing and strict about the result. A box
 * that refuses a keystroke mid-word — because "4" on the way to "40" is under
 * the minimum, or because the field is briefly empty while somebody clears it
 * — is a box people fight. It accepts anything while the cursor is in it and
 * settles the figure when they leave.
 *
 * Pure. Imports nothing at runtime.
 */

/**
 * As many of one dish as anybody will order.
 *
 * Not a rule about the kitchen; a guard against the stray keystroke. A party
 * of forty is ordinary and a party of four hundred is a stadium, but "12" with
 * a finger resting on the key is 1222222 and that reaches the pass as a
 * ticket, the books as a figure, and the shelf as a hole.
 */
export const QTY_MOST = 999;

/**
 * The number in a box, or null while there is not one yet.
 *
 * Null means "they are still typing" and the caller should leave the quantity
 * where it is, not treat it as nought. An empty box is a moment in the middle
 * of changing a number, and taking the line off the order at that moment is
 * the thing that makes a field impossible to edit.
 */
export function readQty(text: string, most: number = QTY_MOST): number | null {
  const digits = (text ?? '').replace(/[^\d]/g, '');
  if (digits === '') return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(Math.round(n), Math.max(1, most)));
}

/**
 * What the box should hold once somebody has left it.
 *
 * An empty box, or one holding nought, becomes the smallest allowed — except
 * where nought is allowed, which is how a line is taken off an order by
 * typing over it rather than pressing minus until it disappears.
 */
export function settleQty(text: string, opts: { least?: number; most?: number } = {}): number {
  const least = Math.max(0, opts.least ?? 1);
  const read = readQty(text, opts.most ?? QTY_MOST);
  return read === null || read < least ? least : read;
}
