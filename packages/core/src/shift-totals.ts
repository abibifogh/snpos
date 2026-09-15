/**
 * What a run of shifts came to.
 *
 * The Shifts page listed nights one under another and totalled nothing, so
 * "what did we take last week" meant reading a column and adding it up by
 * hand — which is both the commonest question anybody asks of that page and
 * the one it could not answer.
 *
 * ONE DECISION SHAPES ALL OF THIS: the totals are built from what was
 * COUNTED, not from what was expected. Expected is what the records say
 * should have been in the drawer; counted is what somebody's hand found in
 * it. Adding up the expected figures would produce a week that always
 * balances perfectly, which is a comforting number and a useless one.
 *
 * A shift still open has been counted by nobody, so it contributes nothing and
 * is reported separately. A total that quietly included tonight's half-finished
 * takings would change every time somebody refreshed the page.
 *
 * Pure. Nothing here reads or writes.
 */

export interface TotalledShift {
  $id: string;
  status?: string;
  opened_at?: string;
  /** JSON, per payment method id, written at close. */
  counted?: string;
  expected?: string;
  variance?: string;
  /**
   * JSON, per payment method id, written at OPEN.
   *
   * Not part of any total here, and read by the drill-down that explains one:
   * a drawer counted at close holds the money it started with, so the float is
   * the first thing that has to come off before the count says anything about
   * what was sold. See counted-breakdown.
   */
  opening_floats?: string;
  sales_total?: number;
  expense_total?: number;
}

export interface KindedMethod {
  $id: string;
  kind?: string;
}

/** The four buckets every payment method falls into. */
export type MoneyKind = 'cash' | 'card' | 'mobile_money' | 'other';

export const MONEY_KINDS: MoneyKind[] = ['cash', 'card', 'mobile_money', 'other'];

export const KIND_LABELS: Record<MoneyKind, string> = {
  cash: 'Cash',
  card: 'Card',
  mobile_money: 'Mobile money',
  other: 'Other',
};

const parseMap = (raw?: string): Record<string, number> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, number>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A count that will not parse is not a count of nothing; it is a row that
    // cannot be read. Returning an empty map leaves it out of the totals
    // rather than adding a wrong figure to them.
    return {};
  }
};

/**
 * Which bucket a payment method belongs in.
 *
 * A method that has since been deleted lands in "other" rather than being
 * dropped. Money that came in really came in, and a total quietly missing a
 * retired card machine is worse than one with a line called Other on it.
 */
export function kindOf(methodId: string, methods: KindedMethod[]): MoneyKind {
  const kind = methods.find((m) => m.$id === methodId)?.kind ?? 'other';
  return (MONEY_KINDS as string[]).includes(kind) ? (kind as MoneyKind) : 'other';
}

export type ByKind = Record<MoneyKind, number>;

const emptyByKind = (): ByKind => ({ cash: 0, card: 0, mobile_money: 0, other: 0 });

/** What was actually counted across these shifts, split by how it was paid. */
export function countedByKind(shifts: TotalledShift[], methods: KindedMethod[]): ByKind {
  const out = emptyByKind();
  for (const s of shifts) {
    for (const [methodId, amount] of Object.entries(parseMap(s.counted))) {
      out[kindOf(methodId, methods)] += amount;
    }
  }
  return out;
}

/**
 * What the records say each drawer should have held, split the same way.
 *
 * The counterpart to the figure above, and it exists because a correction had
 * nowhere to show. An admin who moves a payment from cash to card — the
 * commonest correction there is, and the reason changePaymentMethod exists at
 * all — changes what was EXPECTED, never what was counted: the money in the
 * drawer at close is a fact, and no later edit reaches back and changes what
 * somebody held in their hand.
 *
 * So the page showed one number that by design never moves, the admin made a
 * correction, nothing happened, and they reported it as broken. It was not,
 * but a page that only shows a figure no correction can touch is a page that
 * cannot be checked. Both are shown now, and the difference between them is
 * the whole point of counting.
 */
export function expectedByKind(shifts: TotalledShift[], methods: KindedMethod[]): ByKind {
  const out = emptyByKind();
  for (const s of shifts) {
    for (const [methodId, amount] of Object.entries(parseMap(s.expected))) {
      out[kindOf(methodId, methods)] += amount;
    }
  }
  return out;
}

export interface RangeTotals {
  /** Every shift in the range, including any still open. */
  shifts: number;
  closed: number;
  /** Open shifts contribute nothing and are named so the gap is visible. */
  open: number;
  /** What was physically counted, by kind. */
  counted: ByKind;
  /** Every kind added together. */
  countedTotal: number;
  /**
   * What the records say should have been there, by kind.
   *
   * The figure a correction moves. See expectedByKind.
   */
  expected: ByKind;
  expectedTotal: number;
  sales: number;
  expenses: number;
  /** Counted minus expected, summed. Negative is short. */
  variance: number;
}

/**
 * Add a run of shifts up.
 *
 * Expenses are passed in rather than read off `expense_total`, because that
 * field is a snapshot written at close and an expense reclassified afterwards
 * does not change it. The rows themselves are the truth, and this page already
 * holds them to show what each night spent.
 */
export function rangeTotals(opts: {
  shifts: TotalledShift[];
  methods: KindedMethod[];
  /** The expense rows belonging to these shifts. */
  expenses: { shift_id?: string; amount: number }[];
}): RangeTotals {
  const { shifts, methods, expenses } = opts;
  const closed = shifts.filter((s) => s.status === 'closed');
  const counted = countedByKind(closed, methods);
  const expected = expectedByKind(closed, methods);

  const ids = new Set(shifts.map((s) => s.$id));
  const spend = expenses
    .filter((e) => e.shift_id && ids.has(e.shift_id))
    .reduce((a, e) => a + (e.amount ?? 0), 0);

  let variance = 0;
  for (const s of closed) {
    variance += Object.values(parseMap(s.variance)).reduce((a, b) => a + b, 0);
  }

  return {
    shifts: shifts.length,
    closed: closed.length,
    open: shifts.length - closed.length,
    counted,
    countedTotal: MONEY_KINDS.reduce((a, k) => a + counted[k], 0),
    expected,
    expectedTotal: MONEY_KINDS.reduce((a, k) => a + expected[k], 0),
    sales: closed.reduce((a, s) => a + (s.sales_total ?? 0), 0),
    expenses: spend,
    variance,
  };
}

/**
 * Which kinds are worth putting on screen.
 *
 * A business that has never taken a card should not be shown a Card column
 * reading nought for ever — it is a permanent blank that makes the row harder
 * to read and answers a question nobody asked. Cash always shows: a total
 * without it looks broken rather than empty.
 *
 * A kind the RECORDS know about counts as well as one that was counted, and
 * that is not a nicety. Correct a payment from cash to card on a night where
 * no card was ever counted and the whole card column would be missing — so
 * the money would have moved into a bucket with nowhere on screen to show it,
 * which is the same invisible correction this was meant to fix.
 */
export function kindsWorthShowing(counted: ByKind, expected?: ByKind): MoneyKind[] {
  return MONEY_KINDS.filter(
    (k) => k === 'cash' || counted[k] !== 0 || (expected?.[k] ?? 0) !== 0,
  );
}
