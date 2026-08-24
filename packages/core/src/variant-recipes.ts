/**
 * A size that is its own thing on the shelf.
 *
 * A cocktail's recipe belongs to the drink: a mojito is a mojito however it is
 * rung up. A bottled drink's sizes are not like that. A small Club and a large
 * Club are two different objects, bought separately, stacked separately,
 * counted separately, and running out of one tells you nothing about the
 * other. Same for a bottle against a crate of the same beer.
 *
 * Recipes could only be attached to the DRINK, so both sizes poured the same
 * measure of the same thing: selling a large took a small off the shelf, and
 * the count drifted by exactly the difference every time somebody bought the
 * wrong one. Nothing reported it, because as far as the books were concerned
 * one drink had left.
 *
 * So a recipe may now name a variant, and where it does it applies to that
 * variant alone. Everything without one keeps applying to the whole drink,
 * which is what every recipe written until now meant.
 *
 * Pure. Imports nothing at runtime.
 */

// One shape for a recipe row across the codebase. Defined beside the reader
// that a bartender sees; re-declaring it here would let the two drift.
import type { RecipeRow } from './recipe-card';

/**
 * The rows that apply to what was actually sold.
 *
 * A variant's own rows win outright rather than adding to the drink's. A
 * large Club is a large Club; it is not a small Club plus something. Where a
 * drink has a general recipe AND its large has its own, taking both would
 * pour the small as well and leave the bar short by one every time.
 *
 * A variant with nothing of its own falls back to the drink's, so putting
 * sizes on an existing cocktail does not silently stop it depleting.
 */
export function recipeFor(
  rows: RecipeRow[],
  menuItemId: string,
  variantId?: string,
): RecipeRow[] {
  const mine = rows.filter((r) => r.menu_item_id === menuItemId && !r.addon_option_id);
  if (variantId) {
    const own = mine.filter((r) => r.variant_id === variantId);
    if (own.length > 0) return own;
  }
  // The drink's own, meaning rows tied to no particular size.
  return mine.filter((r) => !r.variant_id);
}

/** Does this variant carry its own stock, or lean on the drink's? */
export const hasOwnRecipe = (rows: RecipeRow[], menuItemId: string, variantId: string): boolean =>
  rows.some((r) => r.menu_item_id === menuItemId && r.variant_id === variantId && !r.addon_option_id);

/**
 * What to call the stock item behind a size.
 *
 * The drink and the size together, because "Large" on a stock list is not
 * findable and "Club" appearing three times is worse. Kept under the column's
 * limit, trimming the drink rather than the size: two rows reading
 * "Club Beer Origina… · Large" and "… · Small" can still be told apart, and
 * two both ending "…" cannot.
 */
export function ingredientNameFor(drink: string, variant: string, max = 120): string {
  const size = (variant ?? '').trim();
  const name = (drink ?? '').trim();
  if (!size) return name.slice(0, max);
  const joiner = ' · ';
  const room = max - joiner.length - size.length;
  if (room < 1) return `${name} ${size}`.trim().slice(0, max);
  return `${name.length > room ? `${name.slice(0, room - 1)}…` : name}${joiner}${size}`;
}

/**
 * How much of its own stock item one of these uses.
 *
 * One. A size that is its own product on the shelf is consumed one for one
 * when it sells — a large Club takes one large Club. Anything else is a
 * cocktail, whose recipe is written out by hand because there is nothing to
 * infer.
 */
export const OWN_STOCK_QTY = 1;

/**
 * What the count sheet will actually ask for, said before somebody counts.
 *
 * Counting works on stock items, not on what a drink is called. A size only
 * reaches the count sheet if it has a stock item of its own — see the toggle
 * this returns the words for — and until it does, a drink with a small and a
 * large is one line on the sheet however carefully the sizes were set up.
 *
 * Nothing said so. The sizes were on the menu, priced, selling, and the person
 * counting the bar saw "Club (bottled)" once and had nowhere to put the number
 * of large ones. From the catalogue everything looked finished.
 *
 * Returns nothing when there is nothing to warn about: no sizes, not a bar
 * drink, or every size already carrying its own shelf.
 */
export function countedAsWarning(
  drink: string,
  variants: { label: string; ownStock: boolean }[],
  module?: string,
): string | null {
  if (module !== 'bar' || variants.length === 0) return null;
  const shared = variants.filter((v) => !v.ownStock).map((v) => v.label.trim() || 'one size');
  if (shared.length === 0) return null;

  const names = shared.length === 1
    ? shared[0]
    : `${shared.slice(0, -1).join(', ')} and ${shared[shared.length - 1]}`;
  const name = drink.trim() || 'this drink';

  return `${names} ${shared.length === 1 ? 'draws' : 'draw'} on ${name}'s own stock, so the count sheet `
    + `asks for ${name} once rather than for each size. Turn on "Counted separately" for a size that is its `
    + 'own thing on the shelf — a small and a large bottle are bought, stacked and counted apart.';
}

/**
 * The drink's own stock row, once every size has a shelf of its own.
 *
 * A bottled drink that sells only as sizes stops being sold as itself, so its
 * own stock item is never poured from again. Left on the count sheet it is a
 * line that can only ever be right by accident: whatever is counted against it
 * is a surplus that never moves, and a surplus nobody can explain is what
 * teaches people to stop trusting the sheet.
 */
export function drinkStockIsSpare(
  variants: { ownStock: boolean }[],
  module?: string,
): boolean {
  return module === 'bar' && variants.length > 0 && variants.every((v) => v.ownStock);
}
