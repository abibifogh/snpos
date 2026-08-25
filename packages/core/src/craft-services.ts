/**
 * Work the shop does, as opposed to things the shop sells.
 *
 * Alterations, sewing, a repair, a fitting. They are rung up at the same
 * counter, on the same till, into the same takings, by the same person — so
 * the obvious thing to do is add them to the catalogue as products, and that is
 * what anybody would do. It then goes wrong in four places at once, quietly,
 * over weeks:
 *
 *   - EVERY SALE TAKES ONE OFF A SHELF THAT IS NOT THERE. A service has no
 *     count, so the count starts at nothing and goes to minus one, minus two,
 *     minus forty. Nobody notices, because nobody counts alterations.
 *   - IT APPEARS ON EVERY COUNT SHEET. Somebody walking the shelves with a
 *     clipboard is asked how many alterations are on the shelf, which has no
 *     answer, so they write nothing or they write a number, and both are
 *     wrong.
 *   - IT RUNS OUT. The moment anything reads the count to decide whether a
 *     thing can be sold, a service that has been sold once can never be sold
 *     again.
 *   - IT IS COUNTED AS UNSOLD STOCK. A maker's "still with us" valuation adds
 *     up what is on the shelf at retail, and a service sitting at minus forty
 *     drags a real number somewhere meaningless.
 *
 * So a craft product can say it is a service, and the shop's stock machinery
 * leaves it alone entirely. It is still sold, still priced, still on a
 * receipt, still counted in the takings, and still credited to whoever did the
 * work — a seamstress with a commission arrangement is paid for a sale exactly
 * as a basket-maker is, because that runs off the sale and not off the shelf.
 *
 * The distinction is what a thing IS, not how it is counted, which is why it
 * is a flag on the product rather than a cadence setting somewhere. "This is
 * work, not goods" is a sentence a shopkeeper can answer. "Do not deplete on
 * sale" is not.
 *
 * Pure. Nothing here reads or writes anything.
 */

/**
 * Anything that might be a service.
 *
 * Deliberately loose. This is asked by the till, the shop floor, the count
 * sheet, the accounts and a server function, and every one of them holds a
 * different shape of the same row — a full product, a sale line, a fragment
 * read back from the database. Requiring one type would mean converting at
 * five call sites, and a conversion that gets it wrong sells a service that
 * runs out.
 */
export interface MaybeService {
  module?: string;
  is_service?: boolean;
}

/**
 * Is this work rather than goods?
 *
 * ONLY THE SHOP. A dish is not a service and neither is a drink: the kitchen
 * counts ingredients against recipes and the bar pours from bottles, and
 * neither has a piece count on a product for this to be about. A flag set on a
 * kitchen row — by an import, by a copied record, by a mistake — must not
 * quietly change how a dish behaves.
 *
 * Absent is goods. Every craft product written before this existed is a thing
 * on a shelf, which is what it was.
 */
export const isService = (item: MaybeService | null | undefined): boolean =>
  (item?.module ?? 'kitchen') === 'craft' && item?.is_service === true;

/**
 * Does this have a shelf at all?
 *
 * The question every piece of stock machinery should be asking, in one place,
 * so the count sheet, the sale, the valuation and the approval cannot end up
 * disagreeing about it. A thing with no shelf is not counted, not depleted,
 * not valued and never sold out.
 */
export const hasShelf = (item: MaybeService | null | undefined): boolean =>
  (item?.module ?? 'kitchen') === 'craft' && !isService(item);

/**
 * What the form says instead of asking for a count.
 *
 * Said rather than the box merely disappearing. A field that vanishes when a
 * switch is flipped reads as something breaking, and the person who flipped it
 * turns it back off to see whether that fixes it.
 */
export const NO_SHELF_WORDS =
  'Work, not goods. There is no shelf to count, nothing comes off when it sells, it never runs out, '
  + 'and it stays off the count sheet. It is still priced, rung up, counted in the takings and credited '
  + 'to whoever did the work.';

/**
 * How the two are told apart on a list.
 *
 * A shop's catalogue with alterations sitting between two baskets, looking
 * exactly like a basket, is one where somebody eventually tries to count the
 * alterations.
 */
export const SERVICE_LABEL = 'Service';

/**
 * Why this cannot be made a service, or nothing.
 *
 * The one refusal worth making. A product with pieces standing on a shelf is a
 * thing that exists; calling it work would strand that stock — no count sheet
 * would ever ask about it again, no sale would take it off, and it would sit
 * in the shop for ever at whatever number it happened to hold. If a product
 * has genuinely become a service, the honest route is to sell or write off
 * what is there and then say so.
 *
 * Sizes are checked too. A product whose own count is nothing can still have
 * three sizes with eleven pieces between them.
 */
export function serviceProblem(opts: {
  onHand: number;
  variantsOnHand?: number[];
}): string | null {
  const shelf = opts.onHand + (opts.variantsOnHand ?? []).reduce((n, x) => n + x, 0);
  if (shelf > 0) {
    return `There ${shelf === 1 ? 'is 1 piece' : `are ${shelf} pieces`} of this on the shelf. Work has no shelf, `
      + 'so making this a service would strand that stock where nothing counts it and nothing sells it. '
      + 'Sell or write off what is there first.';
  }
  return null;
}
