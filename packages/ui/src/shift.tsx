import { Badge, Button, Field, Input, Notice, Textarea } from './components';

/**
 * The close-shift form, shared by the terminal and the kitchen screen.
 *
 * Three rules are baked in here rather than left to each screen, because a
 * rule that only one screen enforces is not a rule:
 *
 *   1. Nothing closes over an unpaid bill or food still on the pass.
 *   2. Staff enter only what they physically hold. Everything they are
 *      measured against is computed.
 *   3. A difference must be explained before the shift can close. Not to
 *      accuse anyone, drawers drift honestly, but because the explanation is
 *      available now and gone by morning.
 */

export interface CountRow {
  methodId: string;
  name: string;
  expected: number;
  countedText: string;
}

export interface BlockerRow {
  id: string;
  label: string;
  reason: 'unpaid' | 'uncollected';
}

export interface StockRow {
  $id: string;
  name: string;
  critical: boolean;
  /** What the shelf should hold when it is properly stocked. */
  parLevel?: number;
  /** At or below this, it counts as low. */
  lowAt?: number;
  unit?: string;
  /** What the system believes is left, for comparison against the shelf. */
  onHand?: number;
  /** The heading this belongs under, Sauces, Protein, Staples. */
  group?: string;
  /** The rule in the restaurant's own words, written by an admin. */
  guide?: string;
}

/**
 * The shift's day in four numbers, shown before anybody counts anything.
 *
 * The table below it answers "does each drawer hold what it should", which is
 * a checking question. This answers the one the person closing actually has in
 * their head: what came in, what went out, and where that leaves us. Without
 * it, the only figure on the screen was a per-drawer expectation with the
 * float and the spending already folded invisibly into it, so a good night and
 * a night where half the takings were paid straight back out looked identical.
 */
export interface ShiftFlow {
  /** What each drawer started with. Not takings. */
  opening: number;
  /**
   * Where that opening figure came from, in words. See floatOrigin.
   *
   * The float is the one number on this screen that nobody present chose, and
   * when it is wrong it is wrong by the whole amount: a drawer that was
   * emptied overnight but opened on yesterday's count reads short by exactly
   * that much, and the person counting has no way to tell why. Saying where it
   * came from turns "the till is short" into a question with an answer.
   */
  openingFrom?: string;
  /** Sales taken during the shift, tips excluded. */
  sales: number;
  tips: number;
  /** Everything paid out of the drawers during the shift. */
  out: number;
  /**
   * Of the shift's spending, what came from petty cash rather than the till.
   *
   * Spent by the business, but out of money this shift never took, so it is
   * not part of what the count is measured against. Shown anyway: it is real
   * spending and it belongs in front of whoever is closing, and an owner
   * reading the summary needs to see it went out.
   */
  ownMoney?: number;
}

const TONE = { OK: 'ok', LOW: 'warn', OUT: 'danger' } as const;

/**
 * Read a typed amount, or nothing.
 *
 * A blank box is genuinely different from a zero: one means "not counted yet",
 * the other means "there is none left". Returning null for blank keeps the two
 * apart all the way through, so a shift cannot close on an unanswered row by
 * treating it as empty shelf.
 */
export function readCount(text?: string, allowDecimals = true): number | null {
  const raw = (text ?? '').trim();
  if (raw === '') return null;
  const n = Number(raw.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return allowDecimals ? n : Math.round(n);
}

/**
 * Turn what was typed into what gets saved.
 *
 * One implementation for both screens. The terminal and the kitchen display
 * ask the same question, and two copies of "is 0.5 low?" is two chances for
 * the same shelf to be filed differently depending on which device was nearest.
 *
 * `missing` is what has not been answered yet, so a shift cannot close on a
 * half-finished count, a blank row would otherwise be saved as OK and the
 * ingredient nobody looked at is exactly the one that runs out.
 */
export function resolveCounts(
  stock: StockRow[],
  text: Record<string, string>,
  allowDecimals = true,
): {
  counts: Record<string, number>;
  levels: Record<string, 'OK' | 'LOW' | 'OUT'>;
  missing: StockRow[];
} {
  const counts: Record<string, number> = {};
  const levels: Record<string, 'OK' | 'LOW' | 'OUT'> = {};
  const missing: StockRow[] = [];

  for (const i of stock) {
    const qty = readCount(text[i.$id], allowDecimals);
    if (qty === null) { missing.push(i); continue; }
    counts[i.$id] = qty;
    levels[i.$id] = qty <= 0 ? 'OUT' : i.lowAt !== undefined && qty <= i.lowAt ? 'LOW' : 'OK';
  }
  return { counts, levels, missing };
}

/**
 * What to put under an item's name.
 *
 * When staff tap a level, the written rule wins whenever there is one. It is in
 * the units on the shelf, buckets, crates, half a bottle, and it says the
 * same thing to everybody, which is the entire point of having written it down.
 * Falling back to the numbers is better than falling back to nothing, but only
 * just: "low at 4 kg" is a conversion somebody has to do in their head while
 * looking at a bucket.
 *
 * When staff type an amount, that reverses: the box takes a number in the
 * ingredient's own unit, so the number has to lead.
 */
function guideFor(i: StockRow, counting = false): string {
  const unit = i.unit ? ` ${i.unit}` : '';

  // When the answer is a number, the written rule leads with the number too.
  // A guide that says "half a bucket" above a box measured in kilograms invites
  // somebody to type 0.5, and the shelf and the system stop agreeing.
  if (counting) {
    const parts = [
      i.lowAt !== undefined ? `low at ${i.lowAt}${unit} or less` : null,
      i.parLevel !== undefined ? `full shelf ${i.parLevel}${unit}` : null,
      i.guide || null,
    ].filter(Boolean);
    return parts.join(' · ');
  }

  if (i.guide) return i.guide;
  const bits: string[] = [];
  if (i.lowAt !== undefined) bits.push(`OK = more than ${i.lowAt}${unit} · Low = ${i.lowAt}${unit} or less`);
  else if (i.parLevel !== undefined) bits.push(`A full shelf is ${i.parLevel}${unit}`);
  if (i.onHand !== undefined) bits.push(`system says ${i.onHand}${unit}`);
  return bits.join(' · ');
}

export function ShiftCloseForm({
  blockers,
  rows,
  onCount,
  stock,
  levels,
  onLevel,
  stockMode = 'levels',
  stockCounts = {},
  onStockCount,
  stockDecimals = true,
  note,
  onNote,
  symbol,
  money,
  tolerance,
  flow,
  shelving = [],
}: {
  blockers: BlockerRow[];
  rows: CountRow[];
  onCount: (methodId: string, text: string) => void;
  stock: StockRow[];
  levels: Record<string, 'OK' | 'LOW' | 'OUT'>;
  onLevel: (id: string, level: 'OK' | 'LOW' | 'OUT') => void;
  /** Tap a level, or type what is on the shelf and let the thresholds decide. */
  stockMode?: 'levels' | 'counts';
  stockCounts?: Record<string, string>;
  onStockCount?: (id: string, text: string) => void;
  /** Whether half and quarter amounts may be typed, or whole numbers only. */
  stockDecimals?: boolean;
  note: string;
  onNote: (v: string) => void;
  symbol: string;
  money: (n: number) => string;
  tolerance: number;
  /** Money in and money out for the shift. Omitted, the summary is not shown. */
  flow?: ShiftFlow;
  /**
   * Orders this shift ran past its limit to take, which will move to the next
   * shift rather than hold this one open. Named here so the close is not a
   * surprise: somebody is still owed for these and somebody else will collect.
   */
  shelving?: { id: string; label: string }[];
}) {
  if (blockers.length > 0) {
    const unpaid = blockers.filter((b) => b.reason === 'unpaid');
    const uncollected = blockers.filter((b) => b.reason === 'uncollected');
    return (
      <>
        <Notice>
          <strong>This shift cannot close yet.</strong> Settle or void everything below first, an order left open
          rolls into a shift that never sold it, and the money stops being traceable to anybody.
        </Notice>
        {unpaid.length > 0 && (
          <>
            <h3 style={{ margin: '1.1rem 0 0.4rem' }}>Not paid ({unpaid.length})</h3>
            <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
              {unpaid.map((b) => <li key={b.id}>{b.label}</li>)}
            </ul>
          </>
        )}
        {uncollected.length > 0 && (
          <>
            <h3 style={{ margin: '1.1rem 0 0.4rem' }}>Paid, but not collected ({uncollected.length})</h3>
            <p className="small dim" style={{ marginTop: 0 }}>
              Food still showing on the pass. Mark it collected if it went out.
            </p>
            <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
              {uncollected.map((b) => <li key={b.id}>{b.label}</li>)}
            </ul>
          </>
        )}
      </>
    );
  }

  const counting = stockMode === 'counts';

  /**
   * The status a typed amount lands on, or null while the box is empty.
   *
   * Worked out from the same threshold the alerts use, so what a cook sees at
   * the pass and what the morning report says can never disagree.
   */
  const countStatus = (i: StockRow, text?: string): 'OK' | 'LOW' | 'OUT' | null => {
    const qty = readCount(text, stockDecimals);
    if (qty === null) return null;
    if (qty <= 0) return 'OUT';
    // No threshold set is not a reason to refuse an answer. Anything present
    // is better than out, and the admin can sharpen it later.
    if (i.lowAt === undefined) return 'OK';
    return qty <= i.lowAt ? 'LOW' : 'OK';
  };

  /**
   * Is anything over or short right now?
   *
   * Worked out the same way each row's badge is, so the explanation box and
   * the red numbers can never disagree. A drawer nobody has counted yet is not
   * a difference; it is an unanswered question, and the close is blocked on it
   * separately.
   */
  const anythingOff = rows.some((r) => {
    const typed = r.countedText.trim();
    if (typed === '') return false;
    const counted = Math.round(Number(typed.replace(/[^0-9.-]/g, '')) * 100);
    return !Number.isNaN(counted) && counted !== r.expected;
  });

  return (
    <>
      {shelving.length > 0 && (
        <div style={{ marginBottom: '1rem' }}>
          <Notice tone="warn">
            <strong>
              {shelving.length === 1
                ? 'One order will move to the next shift.'
                : `${shelving.length} orders will move to the next shift.`}
            </strong>
            <div className="small" style={{ marginTop: '0.3rem' }}>
              They came in after this shift had already run past a day, so they are not this shift's to
              settle and do not hold it open. They are not cancelled: they appear on the pass the moment a
              new shift is opened, and are paid for there.
            </div>
            <ul style={{ margin: '0.45rem 0 0', paddingLeft: '1.2rem' }}>
              {shelving.map((b) => <li key={b.id} className="small">{b.label}</li>)}
            </ul>
          </Notice>
        </div>
      )}

      {flow && (
        <div className="table-wrap" style={{ marginBottom: '1rem' }}>
          <table className="data">
            <tbody>
              <tr>
                <td>
                  Started with
                  {flow.openingFrom && <div className="small dim">{flow.openingFrom}</div>}
                </td>
                <td className="num dim">{money(flow.opening)}</td>
              </tr>
              <tr>
                <td>Money in {flow.tips > 0 && <span className="dim small">sales, tips counted apart</span>}</td>
                <td className="num" style={{ fontWeight: 550 }}>
                  {money(flow.sales)}
                  {flow.tips > 0 && <div className="small dim">+ {money(flow.tips)} tips</div>}
                </td>
              </tr>
              <tr>
                <td>Money out <span className="dim small">paid out of the drawers</span></td>
                <td className="num" style={{ fontWeight: 550 }}>
                  {flow.out > 0 ? `− ${money(flow.out)}` : money(0)}
                </td>
              </tr>
              {/*
                Spent, owed back, and never in the drawer.

                Shown here and deliberately NOT subtracted. Somebody who paid
                for a taxi out of their own pocket wants to see it written down
                at the moment the shift is being counted, and an owner reading
                the summary needs to know it is owed — but taking it off the
                count would make the drawer look short by money that was never
                in it, and the person who lent it is then the person answering
                for the shortage.
              */}
              {(flow.ownMoney ?? 0) > 0 && (
                <tr>
                  <td>
                    Paid from petty cash
                    <span className="dim small">recorded as spent. Not taken off this shift</span>
                  </td>
                  <td className="num dim">{money(flow.ownMoney ?? 0)}</td>
                </tr>
              )}
              <tr>
                <td style={{ fontWeight: 650 }}>Should be in hand</td>
                <td className="num" style={{ fontWeight: 650 }}>
                  {money(flow.opening + flow.sales + flow.tips - flow.out)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <p className="small dim" style={{ marginTop: 0 }}>
        Count each drawer and enter what is actually in your hand. The system works out what should be there and shows
        you the difference as you type.
      </p>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Method</th>
              <th className="num">Should be</th>
              <th style={{ width: '9rem' }}>You counted ({symbol})</th>
              <th className="num">Difference</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const typed = r.countedText.trim();
              const counted = typed === '' ? null : Math.round(Number(typed.replace(/[^0-9.-]/g, '')) * 100);
              const diff = counted === null || Number.isNaN(counted) ? null : counted - r.expected;
              return (
                <tr key={r.methodId}>
                  <td>{r.name}</td>
                  <td className="num dim">{money(r.expected)}</td>
                  <td>
                    <Input
                      value={r.countedText}
                      inputMode="decimal"
                      onChange={(e) => onCount(r.methodId, e.target.value)}
                    />
                  </td>
                  <td className="num">
                    {diff === null ? (
                      <span className="dim">-</span>
                    ) : diff === 0 ? (
                      <Badge tone="ok">Exact</Badge>
                    ) : (
                      <Badge tone={Math.abs(diff) > tolerance ? 'danger' : 'warn'}>
                        {diff > 0 ? '+' : '−'}{money(Math.abs(diff))}
                      </Badge>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Only when something is actually out.
          A box asking you to explain a difference that is not there is a box
          you learn to scroll past, which is the last thing it should be on the
          night it does appear. */}
      {anythingOff && (
        <div style={{ marginTop: '0.9rem' }}>
          <Field
            label="Explain the difference"
            hint="A short answer now is worth more than a perfect one tomorrow."
          >
            <Textarea
              value={note}
              placeholder="Gave change from the wrong drawer, one card payment recorded twice, …"
              onChange={(e) => onNote(e.target.value)}
            />
          </Field>
        </div>
      )}

      {stock.length > 0 && (
        <>
          <h3 style={{ margin: '1.3rem 0 0.3rem' }}>Stock check</h3>
          {counting ? (
            <>
              <p className="small dim" style={{ marginTop: 0 }}>
                Count what is actually on the shelf and type it in. The system decides whether that is low from the
                levels set for each ingredient, so nobody has to judge it, and what you count is measured against what
                the recipes say should have gone, which is where waste shows up.
              </p>
              <div className="stock-key">
                <div>
                  Type the amount you can see, in the unit shown. A blank is not the same as zero, if there is none
                  left, type <strong>0</strong>.
                  {stockDecimals && ' Part amounts are fine: 0.5 for half, 0.25 for a quarter.'}
                </div>
              </div>
            </>
          ) : (
            <>
              <p className="small dim" style={{ marginTop: 0 }}>
                A quick look at the shelf, not a full count. Anything marked <strong>low</strong> or <strong>out</strong>{' '}
                goes into tonight's summary, and if the same thing keeps coming up, that becomes its own warning.
              </p>
              {/* Three people will otherwise use three different meanings of "low",
                  and the report that comes out the other end is worth nothing.
                  One sentence each, phrased as the question to ask yourself. */}
              <div className="stock-key">
                <div><Badge tone="ok">OK</Badge> Enough to get through tomorrow's service without thinking about it.</div>
                <div><Badge tone="warn">LOW</Badge> Enough for tonight, but it needs ordering; you would not want to start another service on what is left.</div>
                <div><Badge tone="danger">OUT</Badge> None left, or too little to serve. Mark this even if the system thinks there is some, the shelf wins.</div>
              </div>
            </>
          )}
          {stock.map((i, n) => {
            // A heading whenever the group changes. The list arrives already
            // in group order, so this is a comparison with the row above
            // rather than a second pass that could disagree with the first.
            const heading = i.group && i.group !== stock[n - 1]?.group ? i.group : null;
            const guide = guideFor(i, counting);
            return (
              <div key={i.$id}>
                {heading && <div className="stock-group">{heading}</div>}
                <div
                  className="row stock-line"
                  style={{ justifyContent: 'space-between', padding: '0.45rem 0', borderBottom: '1px solid var(--border)' }}
                >
                  {/* The rule, under the name. Asking somebody to judge "low"
                      against nothing means judging it against memory, and
                      memory at the end of a fourteen-hour day is not a
                      measurement. */}
                  <span>
                    <span>{i.name}</span>
                    {i.critical && <Badge tone="warn"> critical</Badge>}
                    {guide && <div className="small dim">{guide}</div>}
                  </span>
                  {counting ? (
                    <div className="row stock-count" style={{ gap: '0.45rem' }}>
                      <Input
                        value={stockCounts[i.$id] ?? ''}
                        inputMode="decimal"
                        placeholder=", "
                        aria-label={`How much ${i.name} is left`}
                        onChange={(e) =>
                          onStockCount?.(
                            i.$id,
                            // Filtered as it is typed rather than corrected on
                            // save, so a till with a numeric keypad and no
                            // decimal point cannot produce a figure the
                            // restaurant has said it does not use.
                            stockDecimals
                              ? e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1')
                              : e.target.value.replace(/\D/g, ''),
                          )
                        }
                      />
                      {i.unit && <span className="small dim">{i.unit}</span>}
                      {/* Shown as they type, not after saving. A cook who can
                          see the count land on LOW while the crate is in front
                          of them will recount; one who finds out tomorrow
                          cannot. */}
                      {countStatus(i, stockCounts[i.$id]) && (
                        <Badge tone={TONE[countStatus(i, stockCounts[i.$id])!]}>
                          {countStatus(i, stockCounts[i.$id])}
                        </Badge>
                      )}
                    </div>
                  ) : (
                    <div className="row" style={{ gap: '0.3rem' }}>
                      {(['OK', 'LOW', 'OUT'] as const).map((level) => (
                        <Button
                          key={level}
                          size="sm"
                          variant={levels[i.$id] === level ? (level === 'OK' ? 'primary' : 'danger') : 'default'}
                          onClick={() => onLevel(i.$id, level)}
                        >
                          {level}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}
