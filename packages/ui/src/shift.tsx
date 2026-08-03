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
 *      accuse anyone — drawers drift honestly — but because the explanation is
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
}

export function ShiftCloseForm({
  blockers,
  rows,
  onCount,
  stock,
  levels,
  onLevel,
  note,
  onNote,
  symbol,
  money,
  tolerance,
}: {
  blockers: BlockerRow[];
  rows: CountRow[];
  onCount: (methodId: string, text: string) => void;
  stock: StockRow[];
  levels: Record<string, 'OK' | 'LOW' | 'OUT'>;
  onLevel: (id: string, level: 'OK' | 'LOW' | 'OUT') => void;
  note: string;
  onNote: (v: string) => void;
  symbol: string;
  money: (n: number) => string;
  tolerance: number;
}) {
  if (blockers.length > 0) {
    const unpaid = blockers.filter((b) => b.reason === 'unpaid');
    const uncollected = blockers.filter((b) => b.reason === 'uncollected');
    return (
      <>
        <Notice>
          <strong>This shift cannot close yet.</strong> Settle or void everything below first — an order left open
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

  /**
   * Is anything over or short right now?
   *
   * Worked out the same way each row's badge is, so the explanation box and
   * the red numbers can never disagree. A drawer nobody has counted yet is not
   * a difference — it is an unanswered question, and the close is blocked on it
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
                      <span className="dim">—</span>
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
          <p className="small dim" style={{ marginTop: 0 }}>
            A quick look at the shelf, not a full count. Anything marked <strong>low</strong> or <strong>out</strong>{' '}
            goes into tonight's summary — and if the same thing keeps coming up, that becomes its own warning.
          </p>
          {/* Three people will otherwise use three different meanings of "low",
              and the report that comes out the other end is worth nothing.
              One sentence each, phrased as the question to ask yourself. */}
          <div className="stock-key">
            <div><Badge tone="ok">OK</Badge> Enough to get through tomorrow's service without thinking about it.</div>
            <div><Badge tone="warn">LOW</Badge> Enough for tonight, but it needs ordering — you would not want to start another service on what is left.</div>
            <div><Badge tone="danger">OUT</Badge> None left, or too little to serve. Mark this even if the system thinks there is some — the shelf wins.</div>
          </div>
          {stock.map((i) => (
            <div
              className="row"
              key={i.$id}
              style={{ justifyContent: 'space-between', padding: '0.4rem 0', borderBottom: '1px solid var(--border)' }}
            >
              {/* The numbers, next to the name. Asking somebody to judge "low"
                  against nothing means judging it against memory, and memory at
                  the end of a fourteen-hour day is not a measurement. */}
              <span>
                <span>{i.name}</span>
                {i.critical && <Badge tone="warn"> critical</Badge>}
                {(i.lowAt !== undefined || i.parLevel !== undefined) && (
                  <div className="small dim">
                    {i.lowAt !== undefined && <>low at {i.lowAt}{i.unit ? ` ${i.unit}` : ''}</>}
                    {i.lowAt !== undefined && i.parLevel !== undefined && ' · '}
                    {i.parLevel !== undefined && <>full shelf {i.parLevel}{i.unit ? ` ${i.unit}` : ''}</>}
                    {i.onHand !== undefined && <> · system says {i.onHand}{i.unit ? ` ${i.unit}` : ''}</>}
                  </div>
                )}
              </span>
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
            </div>
          ))}
        </>
      )}
    </>
  );
}
