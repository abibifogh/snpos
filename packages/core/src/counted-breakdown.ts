/**
 * Getting from "what was in the drawer" back to "which sales put it there".
 *
 * The Shifts page totals a run of nights from what was COUNTED — somebody's
 * hand in a drawer — rather than from what the records expected, and that is
 * the right decision: adding up expected figures gives a week that always
 * balances, which is comforting and useless.
 *
 * It also means the headline is NOT the sum of the sales underneath it, and
 * the gap is not small. A cash drawer counted at GH₵5,525 holds the float it
 * started with, is missing whatever was spent out of it during the week, and
 * carries whatever it was over or short by. Listing the orders under that
 * figure and letting somebody assume they add up to it would repeat, on this
 * page, exactly the fault the till panel had: two numbers side by side that do
 * not agree, and nothing anywhere saying why.
 *
 * So the drill-down shows the arithmetic first and the sales second. Every
 * term comes from the same records the close itself used:
 *
 *     counted  −  floats carried in
 *              +  spending paid out of that drawer
 *              −  over-or-short
 *              =  taken on sales
 *
 * which is `expectedTakings` rearranged: it computes
 * `expected = float + taken − paidOut` and `variance = counted − expected`, so
 * `taken = counted − float + paidOut − variance` falls straight out.
 *
 * Card is the same arithmetic with most of the terms at nought, and it is
 * still worth showing them: "no float, nothing paid out, and it balanced" is
 * the answer to why the card figure equals its sales, and somebody who cannot
 * see that has to take it on trust.
 *
 * Pure. Nothing here reads or writes.
 */

import type { MoneyKind, TotalledShift } from './shift-totals';

export interface SpendRow {
  shift_id?: string;
  amount: number;
  paid_from_method_id?: string;
  /**
   * Absent means yes.
   *
   * Every row written before the question existed was money out of the drawer
   * and has been counted that way all along. Petty cash — `false` — is money
   * this shift never took, so it never reduced this drawer and must not appear
   * in this arithmetic either.
   */
  from_takings?: boolean;
}

/** The way from a counted figure back to the sales, term by term. */
export interface CountedParts {
  kind: MoneyKind;
  /** What hands actually found, summed over the closed shifts in range. */
  counted: number;
  /** Money that was in the drawer before anybody sold anything. */
  floats: number;
  /** Paid out of this drawer during the shifts. Positive means it left. */
  spent: number;
  /** Counted minus expected. Positive is over, negative is short. */
  variance: number;
  /** What the sales should therefore come to. */
  taken: number;
}

const parseMap = (raw?: string): Record<string, number> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, number>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A figure that will not parse is a row that cannot be read, not a nought.
    // Leaving it out keeps a wrong number out of an explanation.
    return {};
  }
};

/**
 * Walk one kind of money back from the count to the sales.
 *
 * CLOSED SHIFTS ONLY, matching the headline exactly. A shift still open has
 * been counted by nobody and contributes nothing to the figure being explained,
 * so including its payments here would produce an explanation with more sales
 * in it than the number it is explaining.
 */
export function countedParts(opts: {
  shifts: TotalledShift[];
  /**
   * Which bucket a payment method falls in.
   *
   * Passed in rather than worked out here, so there is exactly one answer to
   * that question in the system — `kindOf` — and this file has no runtime
   * import to go wrong. It also means a method that has since been deleted
   * lands wherever the caller says it lands, rather than in two different
   * places depending on which screen is asking.
   */
  kindFor: (methodId: string) => MoneyKind;
  expenses: SpendRow[];
  kind: MoneyKind;
}): CountedParts {
  const { kindFor, expenses, kind } = opts;
  const closed = opts.shifts.filter((s) => s.status === 'closed');
  const ids = new Set(closed.map((s) => s.$id));

  let counted = 0;
  let floats = 0;
  let variance = 0;
  for (const s of closed) {
    for (const [methodId, amount] of Object.entries(parseMap(s.counted))) {
      if (kindFor(methodId) === kind) counted += amount;
    }
    for (const [methodId, amount] of Object.entries(parseMap(s.opening_floats))) {
      if (kindFor(methodId) === kind) floats += amount;
    }
    for (const [methodId, amount] of Object.entries(parseMap(s.variance))) {
      if (kindFor(methodId) === kind) variance += amount;
    }
  }

  const spent = expenses
    .filter((e) => e.shift_id && ids.has(e.shift_id))
    .filter((e) => e.from_takings !== false)
    .filter((e) => kindFor(e.paid_from_method_id ?? '') === kind)
    .reduce((a, e) => a + (e.amount ?? 0), 0);

  return { kind, counted, floats, spent, variance, taken: counted - floats + spent - variance };
}

/**
 * The terms worth putting on screen, in the order they are read.
 *
 * A term at nought is KEPT where it is one of the two that explain a card
 * figure — "no float, nothing paid out" is the answer to why card counted
 * equals card sales — and dropped where it would be noise. The count and the
 * sales are always shown; they are the two ends of the sentence.
 */
export function partLines(parts: CountedParts): { label: string; amount: number; sign: 1 | -1 }[] {
  const rows: { label: string; amount: number; sign: 1 | -1 }[] = [
    { label: 'Counted at close', amount: parts.counted, sign: 1 },
  ];
  if (parts.floats !== 0) {
    rows.push({ label: 'Float it started with', amount: parts.floats, sign: -1 });
  }
  if (parts.spent !== 0) {
    rows.push({ label: 'Spent out of the drawer', amount: parts.spent, sign: 1 });
  }
  if (parts.variance !== 0) {
    rows.push({
      label: parts.variance > 0 ? 'Over at close' : 'Short at close',
      amount: Math.abs(parts.variance),
      sign: parts.variance > 0 ? -1 : 1,
    });
  }
  return rows;
}

/**
 * What is left over once the sales are added up, or nothing.
 *
 * The check on all of the above. If the payments of this kind do not come to
 * the figure the arithmetic predicted, something is unaccounted for — a
 * payment stamped to a shift whose sale sits elsewhere, an expense recorded
 * against the wrong drawer, a count typed against a method since deleted — and
 * the screen has to say so rather than showing a list that quietly falls short.
 *
 * A small tolerance would be wrong here. These are whole minor units and every
 * term is an integer, so any difference at all is a real difference.
 */
export function unexplained(parts: CountedParts, paymentsTotal: number): number {
  return parts.taken - paymentsTotal;
}

/**
 * The whole thing said as one sentence.
 *
 * For the top of the panel, so somebody who does not want to read a table
 * still learns why the two figures differ.
 */
export function partsWords(parts: CountedParts, money: (n: number) => string): string {
  const bits: string[] = [];
  if (parts.floats !== 0) bits.push(`${money(parts.floats)} of it was the float`);
  if (parts.spent !== 0) bits.push(`${money(parts.spent)} was spent out of the drawer`);
  if (parts.variance !== 0) {
    bits.push(parts.variance > 0
      ? `it came out ${money(parts.variance)} over`
      : `it came out ${money(-parts.variance)} short`);
  }
  if (bits.length === 0) {
    return `${money(parts.counted)} counted, and all of it came from the sales below.`;
  }
  const last = bits.pop() as string;
  const joined = bits.length ? `${bits.join(', ')} and ${last}` : last;
  return `${money(parts.counted)} was counted; ${joined}. That leaves ${money(parts.taken)} taken on the `
    + 'sales below.';
}
