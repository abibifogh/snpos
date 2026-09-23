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

/* ------------------------------------ one drawer, on one shift, term by term */

/**
 * THE OTHER HALF OF THE SAME PROBLEM, and the one somebody actually hits.
 *
 * Everything above explains a week's counted headline. This explains one
 * drawer on one night, which is the figure people argue about — and it had
 * exactly the fault this file was written to stop.
 *
 * Opening a method on a shift listed the payments and said "anything paid out
 * of it comes off again to give the expected figure". True, and useless: it
 * named a term without giving it. So a cash drawer showing 835 taken and 652
 * expected asked the reader to notice a gap of 183, guess what it was, and
 * take it on trust. The sentence explaining why two numbers differ has to
 * carry the number, or it is the same two unexplained figures with a sentence
 * between them.
 *
 * The same arithmetic as above, run the way the close itself runs it:
 *
 *     float  +  taken  −  paid out of this drawer  =  expected
 *
 * Only spending that came out of THIS drawer, by THIS method. Petty cash
 * (`from_takings: false`) is money the shift never took, so it never reduced
 * this drawer; deducting it would make the drawer look short by an amount that
 * was never in it, which is the accusation that stops people recording
 * expenses at all.
 *
 * Pure.
 */
export interface DrawerMakeup<T extends SpendRow> {
  float: number;
  taken: number;
  /** What left this drawer, and the rows behind it. */
  paidOut: number;
  spends: T[];
  /**
   * Whether the spending could be read at all.
   *
   * A failed read and a shift that spent nothing are the same empty list, and
   * telling them apart matters more here than almost anywhere: the second is
   * "nothing came out of this drawer", the first is "I do not know", and
   * saying the first when you mean the second is a confident sentence about
   * somebody's money that happens to be wrong.
   */
  known: boolean;
  /** float + taken − paidOut. What the stored figure ought to be. */
  works: number;
  /** The stored figure, as the close wrote it. */
  expected: number;
  /**
   * Stored minus worked-out. Nought on a shift nobody has touched since.
   *
   * Anything else is a real event: a spend recorded or reclassified after the
   * close, a payment moved onto the shift, a method deleted. The close stored
   * what it knew at the time and that figure never moves on its own, so the
   * two drifting apart is worth saying rather than papering over — the reader
   * would otherwise be shown an equation that does not add up and left to
   * decide which side to believe.
   */
  drift: number;
}

export function drawerMakeup<T extends SpendRow>(input: {
  methodId: string;
  float: number;
  taken: number;
  expected: number;
  /** Every spend on this shift. Narrowed here so no caller has to remember how. */
  spends: T[];
  /** False where the spending could not be read. Absent means it could. */
  spendsKnown?: boolean;
}): DrawerMakeup<T> {
  const known = input.spendsKnown !== false;
  const spends = input.spends.filter(
    (s) => s.paid_from_method_id === input.methodId && s.from_takings !== false,
  );
  const paidOut = spends.reduce((n, s) => n + s.amount, 0);
  const works = input.float + input.taken - paidOut;
  return {
    float: input.float,
    taken: input.taken,
    paidOut,
    spends,
    known,
    works,
    expected: input.expected,
    // Unknowable while the spending is unread. A drift worked out from a
    // paid-out figure of nought would be the size of the spending, reported as
    // if somebody had changed the shift.
    drift: known ? input.expected - works : 0,
  };
}

/**
 * The arithmetic as a sentence, with every term in it.
 *
 * Written so the figures can be checked against each other by eye. The terms
 * that are nought are left out — "a float of nothing, and nothing paid out"
 * is noise on the overwhelming majority of card drawers — except when they are
 * all nought, where saying so plainly is the answer to why taken and expected
 * are the same number.
 */
export function makeupWords(
  m: DrawerMakeup<SpendRow>,
  money: (n: number) => string,
  methodName: string,
): string {
  const bits: string[] = [`${money(m.taken)} taken through ${methodName}`];
  if (m.float !== 0) bits.push(`on top of a float of ${money(m.float)}`);

  /*
    Unread spending is said as unread. The arithmetic is not offered at all
    here, because the only figure it could be built from is a nought that
    means "not asked" — and the sentence would read as "nothing was paid out
    of this drawer", which is a different claim entirely.
  */
  if (!m.known) {
    return `${bits.join(', ')}. What was paid out of it could not be read, so the ${money(m.expected)} `
      + 'expected at close cannot be broken down here.';
  }

  if (m.paidOut !== 0) bits.push(`less ${money(m.paidOut)} paid out of the drawer`);

  const head = m.paidOut === 0 && m.float === 0
    ? `${bits[0]}, with no float and nothing paid out of it`
    : bits.join(', ');

  return `${head}. That is the ${money(m.works)} expected in it at close.`;
}

/**
 * What to say when the stored figure and the arithmetic disagree, or nothing.
 *
 * Named rather than hidden, and it names the likeliest cause, because the
 * reader's next question is always "so which one is right?".
 */
export function driftWords(
  m: DrawerMakeup<SpendRow>,
  money: (n: number) => string,
): string | null {
  if (m.drift === 0) return null;
  return `The close stored ${money(m.expected)} as expected, which is ${money(Math.abs(m.drift))} `
    + `${m.drift > 0 ? 'more' : 'less'} than these figures come to. A stored figure does not move on its own, `
    + 'so something on this shift changed after it closed — a spend recorded or refiled, or a payment moved '
    + 'onto it. The difference against the count was worked out from the stored figure.';
}
