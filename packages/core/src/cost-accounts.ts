/**
 * Which accounts add up to "Costs".
 *
 * The dashboard's Costs figure was every expense anybody recorded, and for a
 * lot of questions that is the wrong number. A restaurant asking "what did it
 * cost me to serve this month" means food, gas, the market run — the things
 * that move with how much was cooked. It does not mean the fridge that was
 * bought once, the rent that would have been due whether the doors opened or
 * not, or the owner's own drawings. Adding those in makes a good month look
 * like a bad one and makes the comparison against last month meaningless,
 * because the fridge was only in one of them.
 *
 * So the house chooses. Nothing here decides what a cost is; it only carries
 * the choice around and makes sure the money that was left out is still
 * visible rather than quietly gone.
 *
 * Imports nothing, so the arithmetic behind a headline figure can be checked
 * without a database.
 */

/** The account an expense lands on when its category names none. */
export const UNCATEGORISED_COST_CODE = '6090';

/**
 * The chosen accounts, read from what settings holds.
 *
 * Stored as a plain comma-separated list of codes rather than JSON: it is a
 * list of short strings, it is read by eye when somebody is debugging a
 * figure, and JSON would only add quotes to look at.
 */
export function parseCostAccounts(raw?: string): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(',').map((c) => c.trim()).filter((c) => c !== ''))];
}

export const serialiseCostAccounts = (codes: string[]): string =>
  [...new Set(codes.map((c) => c.trim()).filter((c) => c !== ''))].sort().join(',');

/**
 * Has the house actually chosen, or is this the default?
 *
 * An empty list means nobody has said, and that has to mean "count
 * everything" — the figure existed before this setting did, and a new setting
 * arriving must not silently rewrite last month's dashboard to zero.
 *
 * It follows that "count nothing" is not expressible, and that is the right
 * trade: a Costs figure of zero with expenses recorded is not a choice anybody
 * makes deliberately, and it is exactly what an accidental empty save would
 * produce.
 */
export const hasCostChoice = (chosen: string[]): boolean => chosen.length > 0;

export const countsAsCost = (accountCode: string, chosen: string[]): boolean =>
  !hasCostChoice(chosen) || chosen.includes(accountCode);

export interface CostRow {
  /** The account this expense lands on. */
  code: string;
  amount: number;
}

export interface CostSplit {
  /** What the Costs figure comes to. */
  counted: number;
  /** What was recorded in the period and deliberately left out of it. */
  excluded: number;
  /** How many expenses were left out, for saying so on the page. */
  excludedCount: number;
  /** Left-out totals by account, so the page can name what is missing. */
  excludedByCode: { code: string; amount: number }[];
}

/**
 * Costs, and what was left out of them.
 *
 * Both halves, always. A figure that quietly excludes money is a figure
 * somebody will one day compare against the bank and be unable to explain, so
 * the page that shows the total is given what it needs to show the rest.
 */
export function splitCosts(rows: CostRow[], chosen: string[]): CostSplit {
  let counted = 0;
  let excluded = 0;
  let excludedCount = 0;
  const byCode = new Map<string, number>();

  for (const r of rows) {
    if (countsAsCost(r.code, chosen)) {
      counted += r.amount;
    } else {
      excluded += r.amount;
      excludedCount += 1;
      byCode.set(r.code, (byCode.get(r.code) ?? 0) + r.amount);
    }
  }

  return {
    counted,
    excluded,
    excludedCount,
    excludedByCode: [...byCode.entries()]
      .map(([code, amount]) => ({ code, amount }))
      .sort((a, b) => b.amount - a.amount),
  };
}

/**
 * The account an expense belongs to.
 *
 * Its category decides, and a category with no account set — or an expense
 * with no category at all — falls to Other expenses rather than to nothing.
 * Falling to nothing would mean a code that matches no account, so the money
 * could never be selected into Costs however the house set it up, and would
 * simply never appear.
 */
export function costCodeFor(
  expense: { category_key?: string; category?: string },
  categories: { key: string; account_code?: string }[],
): string {
  const key = expense.category_key || expense.category;
  if (!key) return UNCATEGORISED_COST_CODE;
  return categories.find((c) => c.key === key)?.account_code || UNCATEGORISED_COST_CODE;
}

/**
 * A sensible starting selection, for an admin opening the picker for the
 * first time.
 *
 * Everything currently ticked, because that is what the figure has been
 * showing. Somebody who came here to remove rent should find rent ticked and
 * untick it, not find an empty list and have to reconstruct their own books
 * from memory to get back to where they started.
 */
export const startingCostChoice = (allCodes: string[], chosen: string[]): string[] =>
  hasCostChoice(chosen) ? chosen.filter((c) => allCodes.includes(c)) : [...allCodes];
