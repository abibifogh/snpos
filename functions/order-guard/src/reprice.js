/**
 * What one line of an order is really worth, on the server.
 *
 * Repricing exists because a customer's phone sends its own figures and must
 * never be trusted: it is the one thing standing between the menu price and
 * whatever a guest's browser felt like claiming. Every line is worked out
 * again from the database and the order's total is rewritten from the sum.
 *
 * WHICH MAKES A DROPPED LINE A SILENT UNDERCHARGE. A line that contributes
 * nothing to that sum does not disappear from the order — it still shows on
 * the bill, the kitchen still cooks it, the customer still eats it — it simply
 * stops being charged for, and the order's total is rewritten as though it
 * were never there. That is money out of the till, on a screen where
 * everything looks right: the dishes are listed, each has a price beside it,
 * and only the number at the bottom is wrong.
 *
 * It happened. An order for a quesadilla and a kelewele, GH₵90 and GH₵40,
 * came to GH₵90, because the kelewele's menu item could not be read and the
 * line was skipped. A dish deleted or re-created since the sale does that
 * every time; so does a single failed read, because a read that throws and a
 * dish that no longer exists are the same `null` here.
 *
 * So NOTHING IS EVER DROPPED. A line whose dish cannot be read is kept at
 * what it was sold for, which is the figure the rest of this system already
 * treats as the truth about a completed sale — the same reasoning that stops
 * a bill discounted tonight from repricing itself against a menu that has
 * changed since. The worst case becomes "this line was not re-checked", which
 * is a note for somebody to read, instead of "this line was free", which is
 * not.
 *
 * Pure. Parameters are described by the fields they read, so the arithmetic
 * can be checked without a database.
 */

/**
 * A line that was taken off before anything was cooked. Worth nothing, owed nothing.
 * @param {any} item
 */
export const isVoid = (item) => item?.status === 'void';

/**
 * What a line was sold for, as stored on it.
 * @param {any} item
 */
const soldFor = (item) => Number(item?.line_total) || 0;

/**
 * What to charge for one line, and what to say about it.
 *
 * Returns `amount` — what this line adds to the subtotal, ALWAYS a number and
 * never nothing — plus `rewrite` when the stored line should be corrected on
 * the way past, and `correction` when somebody should be told why.
 *
 * @param {object} opts
 * @param {any} opts.item the order line, as stored
 * @param {any} [opts.menuItem] the dish, or null where it could not be read
 * @param {number} [opts.overridePrice] this venue's own price, where it has one
 * @param {number} [opts.addonTotal] what the choices on this line add per unit
 */
export function linePrice({ item, menuItem = null, overridePrice, addonTotal = 0 }) {
  if (isVoid(item)) return { amount: 0, rewrite: null, correction: null };

  /*
    The dish cannot be read: deleted, re-created under a new id, or a read
    that simply failed. Keep the line at what it was sold for.

    This is the whole fix. It used to `continue`, which meant the line stayed
    on the order and left the total — so a customer was charged for one dish
    out of two and the bill on screen did not add up to its own items.
  */
  if (!menuItem) {
    return {
      amount: soldFor(item),
      rewrite: null,
      correction: `${item.name_snapshot || 'a line'}: not on the menu now, kept at what it was sold for`,
    };
  }

  /*
    A price somebody with permission changed at the till stands.

    `list_price` is only ever set by the till, which checks the permission
    first, and carries what the line SHOULD have cost, so the decision stays
    readable afterwards. Without this the guard would put the line back to the
    shelf price a second after the sale.
  */
  if (typeof item.list_price === 'number') {
    return { amount: soldFor(item), rewrite: null, correction: null };
  }

  const base = typeof overridePrice === 'number' ? overridePrice : menuItem.price;
  const unit = (Number(base) || 0) + (Number(addonTotal) || 0);
  const line = unit * (Number(item.qty) || 0);

  if (line === soldFor(item)) return { amount: line, rewrite: null, correction: null };

  return {
    amount: line,
    rewrite: { unit_price: unit, line_total: line },
    correction: `${item.name_snapshot || 'a line'}: sent ${soldFor(item)}, actual ${line}`,
  };
}

/**
 * How long this line takes to cook, for the quote.
 *
 * From the dish where it can be read, and from the line's own snapshot where
 * it cannot — the prep time is written onto the line when the order is placed
 * for exactly this reason. Counted once per line rather than per portion:
 * three of the same thing goes in one pan.
 */
/**
 * @param {any} item
 * @param {any} [menuItem]
 */
export const linePrep = (item, menuItem = null) =>
  Number(menuItem?.prep_minutes ?? item?.prep_minutes ?? 15) || 15;
