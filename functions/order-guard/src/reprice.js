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
 * WAS THIS RUNG UP AT A TILL? Then what the till charged stands.
 *
 * Repricing is a guard against a customer's phone, which sends its own figures
 * and must never be trusted. A till is not a customer's phone: it is staff,
 * signed in, charging the price on the screen in front of them, and the
 * customer pays that figure there and then. Rewriting it a second later does
 * not protect anybody — it makes the record disagree with the money.
 *
 * That is exactly what happened to Club · Large. The till charged GH₵30, the
 * customer paid GH₵30, and this rewrote the line to GH₵25 a second later: 126
 * bills, a month of sales, understated by GH₵5 a bottle while every drawer
 * balanced. Whatever the next pricing rule the server gets wrong turns out to
 * be — a venue price, a size, a choice with a quantity — it must not be able
 * to do that again to a sale somebody has already been charged for.
 *
 * How a till's order is known: it names the shift it was rung up on. A phone
 * has no shift — a guest cannot read the shifts, so cannot name one — and
 * never sends one; the till always does when a shift is open. The shift is
 * read on the server and must exist, in the same venue, so a made-up id does
 * not count. A till order sent with no shift open is checked like any other.
 *
 * A difference is still written down (see the caller), so a till showing a
 * stale price can be found and put right; it just is not "corrected" onto a
 * bill somebody has already paid.
 *
 * @param {any} order
 * @param {any} [shift] the shift the order names, read by the server, or null
 */
export function tillSale(order, shift = null) {
  if (!order || !shift) return false;
  if (order.channel !== 'waiter' && order.channel !== 'counter') return false;
  if (!order.shift_id || shift.$id !== order.shift_id) return false;
  return (shift.venue_id || '') === (order.venue_id || '');
}

/**
 * What the choices on a line add per unit, priced from the database.
 *
 * Each choice counted as many times as it was chosen, the way the till adds
 * them up. This used to count every choice once, so "extra shot × 2" was
 * charged one shot by the server and two by the till.
 *
 * @param {Array<{ qty?: number }>} chosen what the line says was chosen
 * @param {Array<{ price_delta?: number } | null>} options each choice as read from the database, same order
 */
export function addonsPriced(chosen, options) {
  let total = 0;
  chosen.forEach((a, i) => {
    const qty = Number(a?.qty ?? 1);
    total += (Number(options[i]?.price_delta) || 0) * (Number.isFinite(qty) && qty > 0 ? qty : 1);
  });
  return total;
}

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
 * @param {any} [opts.variant] the size or variant the line was sold as, or null where it could not be read
 */
export function linePrice({ item, menuItem = null, overridePrice, addonTotal = 0, variant = null }) {
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

  /*
    A SIZE IS PRICED AS ITSELF, NOT AS THE DRINK.

    The till charges a size its own full price — a large Club is GH₵30, not
    the plain Club's GH₵25 plus something. This used to price every line from
    the drink alone, so a large Club rung up at 30 was rewritten to 25 a
    second after the sale, and every size that cost more than its drink was
    undercharged on a bill that looked right line by line.

    A size that cannot be read is treated like a dish that cannot be read:
    the line keeps what it was sold for. Falling back to the drink's price is
    exactly the mistake this replaces.
  */
  if (item.variant_id) {
    if (!variant) {
      return {
        amount: soldFor(item),
        rewrite: null,
        correction: `${item.name_snapshot || 'a line'}: its size could not be read, kept at what it was sold for`,
      };
    }
  }

  // The size's own price where there is one, which is what the till charged;
  // otherwise this venue's price for the drink, then the menu's.
  const base = item.variant_id && variant
    ? variant.price
    : typeof overridePrice === 'number' ? overridePrice : menuItem.price;
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
