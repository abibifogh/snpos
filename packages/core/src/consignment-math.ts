/**
 * The consignment arithmetic, with nothing else in it.
 *
 * Separated from `consignment.ts` for one reason: that file opens a database
 * connection the moment it is imported, so none of the money logic inside it
 * could be checked without a live Appwrite project. The figures a maker is paid
 * from are the last thing in this system that should only be testable by
 * selling something.
 *
 * Every function here is pure. Parameters are described by the fields they
 * actually read rather than by the full row shape, so this file imports nothing
 * and can never grow a dependency on the database by accident.
 */

/* ------------------------------------------------------------------ rates */

/**
 * Which commission rate applies to one sale.
 *
 * Three places can set it, most specific first: the piece, the consignor, then
 * the shop's default. The order matters, a shop negotiates a lower rate on a
 * large commissioned work without wanting that to become everybody's rate, and
 * getting it backwards would silently pay the wrong people the wrong amount for
 * as long as nobody checked.
 */
export function rateFor(
  item: { commission_bp?: number | null } | null | undefined,
  consignor: { commission_bp?: number | null } | null | undefined,
  settings?: { default_commission_bp?: number | null } | null,
): number {
  const candidates = [item?.commission_bp, consignor?.commission_bp, settings?.default_commission_bp];
  for (const bp of candidates) {
    if (typeof bp === 'number' && Number.isFinite(bp) && bp >= 0) return bp;
  }
  return 3000;
}

export interface Split {
  /** What the customer paid for this line. */
  gross: number;
  /** What the shop keeps. */
  commission: number;
  /** What the consignor is owed. */
  consignor: number;
  /** The rate used, so it can be written down beside the numbers. */
  bp: number;
}

/**
 * Divide one sale between the shop and the maker.
 *
 * The commission is rounded and the consignor gets the remainder, rather than
 * both being rounded independently. Two roundings of the same amount do not
 * have to add back up to it, and a shop that keeps one pesewa more than it
 * should on every sale of an odd-priced item will eventually be asked about it
 * by somebody with a calculator. Whatever is left after the shop's share is the
 * maker's share, by construction.
 *
 * A discount reduces what the customer paid, so it reduces both sides in
 * proportion. The shop does not fund a sale out of somebody else's work, and it
 * does not pass the whole cost of its own promotion to them either. Pass the
 * line's actual money, after discount.
 */
export function splitSale(gross: number, commissionBp: number): Split {
  const bp = Math.max(0, Math.min(10000, Math.round(commissionBp)));
  const commission = Math.round((gross * bp) / 10000);
  return { gross, commission, consignor: gross - commission, bp };
}

/* ---------------------------------------------------------------- ledgers */

export type LedgerKind = 'sale' | 'refund' | 'payout' | 'adjustment' | 'fee';

/** The fields a statement reads. Any row carrying these will do. */
export interface LedgerLike {
  entry_at: string;
  kind: LedgerKind;
  amount: number;
  description?: string;
  qty?: number;
  gross?: number;
  commission?: number;
}

/**
 * What a set of ledger entries comes to.
 *
 * Summed rather than read from anywhere, everywhere, always. The balance is a
 * conclusion, not a stored fact: a number somebody can edit is a number that
 * eventually disagrees with the maker's own notebook, and in that argument the
 * shop has no evidence.
 */
export const balanceOf = (entries: { amount: number }[]): number =>
  entries.reduce((sum, e) => sum + e.amount, 0);

export interface StatementLine {
  at: string;
  kind: LedgerKind;
  description: string;
  qty: number;
  gross: number;
  commission: number;
  /** What this line did to the balance. */
  amount: number;
}

export interface Statement<C = unknown> {
  consignor: C;
  from: string;
  to: string;
  /** What was owed before the first line of this statement. */
  openingBalance: number;
  lines: StatementLine[];
  soldCount: number;
  grossSales: number;
  commissionKept: number;
  earned: number;
  paidOut: number;
  adjustments: number;
  /** What is owed at the end of the period. */
  closingBalance: number;
}

export const labelForKind = (kind: LedgerKind): string =>
  kind === 'sale' ? 'Sale'
    : kind === 'refund' ? 'Refund'
      : kind === 'payout' ? 'Payment to you'
        : kind === 'fee' ? 'Fee'
          : 'Adjustment';

/**
 * A consignor's statement for a period.
 *
 * Built from the ledger and nothing else, which is what lets it be checked. The
 * opening balance is every entry before the window, so the statement adds up on
 * its own. A period statement whose figures only reconcile against a different
 * document is a statement that starts an argument rather than settling one.
 *
 * Dates are inclusive at both ends: somebody asking for March means March, and
 * losing the 31st to an off-by-one is the kind of error only noticed by the
 * person it costs.
 *
 * Generic in the consignor so this file needs no knowledge of what one is; it
 * is carried through to the result untouched.
 */
export function buildStatement<C>(
  consignor: C,
  entries: LedgerLike[],
  from: Date,
  to: Date,
): Statement<C> {
  const start = from.toISOString();
  // To the last instant of the closing day, so entries on it are included.
  const endOfDay = new Date(to);
  endOfDay.setHours(23, 59, 59, 999);
  const end = endOfDay.toISOString();

  const before = entries.filter((e) => e.entry_at < start);
  const within = entries
    .filter((e) => e.entry_at >= start && e.entry_at <= end)
    .sort((a, b) => a.entry_at.localeCompare(b.entry_at));

  const openingBalance = balanceOf(before);

  const lines: StatementLine[] = within.map((e) => ({
    at: e.entry_at,
    kind: e.kind,
    description: e.description || labelForKind(e.kind),
    qty: e.qty ?? 0,
    gross: e.gross ?? 0,
    commission: e.commission ?? 0,
    amount: e.amount,
  }));

  const sales = within.filter((e) => e.kind === 'sale');
  const refunds = within.filter((e) => e.kind === 'refund');

  return {
    consignor,
    from: start,
    to: end,
    openingBalance,
    lines,
    soldCount: sales.reduce((n, e) => n + (e.qty ?? 1), 0),
    grossSales:
      sales.reduce((n, e) => n + (e.gross ?? 0), 0) + refunds.reduce((n, e) => n + (e.gross ?? 0), 0),
    commissionKept:
      sales.reduce((n, e) => n + (e.commission ?? 0), 0)
      + refunds.reduce((n, e) => n + (e.commission ?? 0), 0),
    earned: [...sales, ...refunds].reduce((n, e) => n + e.amount, 0),
    // Stored negative; reported as the positive amount that was handed over.
    paidOut: -within.filter((e) => e.kind === 'payout').reduce((n, e) => n + e.amount, 0),
    adjustments: within
      .filter((e) => e.kind === 'adjustment' || e.kind === 'fee')
      .reduce((n, e) => n + e.amount, 0),
    closingBalance: openingBalance + balanceOf(within),
  };
}

/* ------------------------------------------------------------------ stock */

/**
 * How much of a product is on the shelf.
 *
 * With variants the count lives on each one and the product's own figure means
 * nothing, so there is one place to ask and a screen cannot pick the wrong one.
 */
export const onHandFor = (
  item: { on_hand?: number },
  variants: { on_hand?: number; active: boolean }[] = [],
): number =>
  variants.length
    ? variants.filter((v) => v.active).reduce((n, v) => n + (v.on_hand ?? 0), 0)
    : item.on_hand ?? 0;
