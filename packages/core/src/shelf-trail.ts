/**
 * Where a shelf figure came from.
 *
 * "Malt was 30 yesterday, one sold, and the count today expects 30." Nothing
 * on any screen could answer that: the figure is the end of a chain of
 * movements — sold, bought in, a count difference approved, moved from the
 * store — and none of them were visible. So this lays the chain out, newest
 * first, with what the shelf held after each step, and puts the counts beside
 * it, including the ones still waiting for approval, which move nothing until
 * somebody agrees to them and are the commonest reason a figure looks stuck.
 *
 * Pure. Imports nothing at runtime.
 */

export interface TrailMove {
  $id: string;
  $createdAt: string;
  type: string;
  qty_delta: number;
  location_id?: string | null;
  note?: string | null;
  ref_type?: string | null;
  shift_id?: string | null;
}

export interface TrailCheck {
  $id: string;
  $createdAt: string;
  shift_id?: string | null;
  phase?: 'open' | 'close' | null;
  counted_qty?: number | null;
  theoretical_qty?: number | null;
  variance_qty?: number | null;
  applied?: boolean | null;
  rejected_at?: string | null;
  undone_at?: string | null;
  charge_id?: string | null;
}

export interface TrailRow {
  id: string;
  at: string;
  what: string;
  /** How much it moved, where it moved anything. */
  change?: number;
  /** What that place held straight after, where it can be known. */
  after?: number;
  where: string;
  note?: string;
  /** A count still waiting: the reason a figure has not moved. */
  waiting?: boolean;
}

export const MOVE_WORDS: Record<string, string> = {
  sale_depletion: 'Sold',
  purchase: 'Bought in',
  waste: 'Written off',
  adjustment: 'Adjusted',
  count_correction: 'Count difference applied',
  transfer: 'Moved',
  made: 'Made here',
  used_to_make: 'Used to make something',
};

const round = (n: number) => Number(n.toFixed(4));

/**
 * The trail, newest first.
 *
 * What a place held after each movement is worked backwards from what it holds
 * now: the level now, less every later movement at that place. Movements with
 * no place were written against the item's single figure, and are walked back
 * from that.
 */
export function shelfTrail(input: {
  moves: TrailMove[];
  checks: TrailCheck[];
  /** What each place holds now, by place id. */
  levels: Record<string, number>;
  /** The item's single figure, for movements with no place. */
  total: number;
  placeNames: Record<string, string>;
  shiftCodes?: Record<string, string>;
}): TrailRow[] {
  const running: Record<string, number> = { ...input.levels };
  const noPlace = '';
  running[noPlace] = input.total;

  const moves = [...input.moves].sort((a, b) => b.$createdAt.localeCompare(a.$createdAt));
  const rows: TrailRow[] = [];
  for (const m of moves) {
    const loc = m.location_id || noPlace;
    const after = running[loc];
    if (after !== undefined) running[loc] = round(after - (m.qty_delta || 0));
    rows.push({
      id: m.$id,
      at: m.$createdAt,
      what: MOVE_WORDS[m.type] ?? m.type,
      change: round(m.qty_delta || 0),
      after: after === undefined ? undefined : round(after),
      where: loc ? (input.placeNames[loc] ?? 'A place no longer listed') : 'Everywhere',
      note: m.note || undefined,
    });
  }

  for (const c of input.checks) {
    const shift = c.shift_id ? input.shiftCodes?.[c.shift_id] : undefined;
    const variance = c.variance_qty ?? 0;
    const state = c.undone_at ? 'taken back'
      : c.charge_id ? 'charged to a person'
        : c.rejected_at ? 'refused, so the shelf was left as it was'
          : c.applied === false ? 'WAITING FOR APPROVAL, so the shelf has not moved'
            : variance === 0 ? 'matched' : 'applied';
    rows.push({
      id: c.$id,
      at: c.$createdAt,
      what: `Counted ${c.phase === 'open' ? 'in' : 'out'}${shift ? ` on ${shift}` : ''}`,
      where: 'Count',
      note: `Found ${c.counted_qty ?? 0}, the shelf said ${c.theoretical_qty ?? 0}`
        + `${variance ? ` (${variance > 0 ? '+' : ''}${round(variance)})` : ''}: ${state}.`,
      waiting: c.applied === false && !c.rejected_at && !c.undone_at && !c.charge_id && variance !== 0,
    });
  }

  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

/** The one line above the trail when a count is holding the figure. */
export function trailWarning(rows: TrailRow[]): string | null {
  const waiting = rows.filter((r) => r.waiting);
  if (waiting.length === 0) return null;
  return `${waiting.length === 1 ? 'A count of this is' : `${waiting.length} counts of this are`} waiting for `
    + 'approval. Until it is approved, refused or charged on Waiting for you, the shelf figure — and so what '
    + 'the next count expects — has not moved for it.';
}
