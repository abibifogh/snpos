/**
 * Close the day: one list that says whether a day's money and stock are put
 * away.
 *
 * Each of these jobs already existed, on four different pages — Shifts for
 * the drawers, Waiting for you for the counts and spends, Settle up for the
 * bank, Petty cash for the boxes — and nothing said whether a given day was
 * finished. This puts them in one place, in the order they are done, each
 * linked to where it is done. It decides nothing itself.
 *
 * Pure. Imports nothing at runtime. The facts are read in close-day-store.ts.
 */

export interface CloseDayShift {
  $id: string;
  code?: string;
  module?: string;
  status?: string;
  variance?: string;
  variance_note?: string;
  cash_kept?: number | null;
}

export interface CloseDayFacts {
  shifts: CloseDayShift[];
  /** Count lines still waiting, on those shifts. */
  pendingCountLines: number;
  /** Spends still waiting, on those shifts, and what they come to. */
  pendingSpends: number;
  pendingSpendTotal: number;
  /** Cash taken to the bank at those closes, not yet confirmed with a slip. */
  cashAwaitingBank: number;
  /** What the safe holds. */
  inSafe: number;
  /** Card and mobile money not yet matched to the bank, overall. */
  momoHanging: number;
  cardHanging: number;
  /** Petty cash boxes and when each was last counted. */
  boxes: { name: string; lastCounted?: string; balance?: number; level?: number }[];
  now: number;
}

export interface CloseDayRow {
  key: 'shifts' | 'counts' | 'cash' | 'settle' | 'spends' | 'petty';
  label: string;
  /** Done, still to do, or nothing to do today. */
  state: 'done' | 'todo' | 'none';
  detail: string;
  /** Where it is done. */
  to: string;
  action?: string;
}

/** A box counted more than this long ago is due. */
const BOX_DUE_MS = 7 * 86_400_000;

export function closeDayChecklist(f: CloseDayFacts, money: (n: number) => string): CloseDayRow[] {
  const open = f.shifts.filter((s) => s.status === 'open');
  const closed = f.shifts.filter((s) => s.status === 'closed');
  const rows: CloseDayRow[] = [];

  rows.push(f.shifts.length === 0
    ? { key: 'shifts', label: 'Shifts closed', state: 'none', detail: 'No shift was opened on this day.', to: '/shifts' }
    : open.length > 0
      ? { key: 'shifts', label: 'Shifts closed', state: 'todo', detail: `${open.map((s) => s.code).join(', ')} still open.`, to: '/shifts', action: 'Shifts' }
      : { key: 'shifts', label: 'Shifts closed', state: 'done', detail: `${closed.map((s) => s.code).join(', ')} closed.`, to: '/shifts' });

  rows.push(f.pendingCountLines > 0
    ? { key: 'counts', label: 'Counts agreed', state: 'todo', detail: `${f.pendingCountLines} count difference${f.pendingCountLines === 1 ? '' : 's'} still to decide.`, to: '/waiting?show=count', action: 'Waiting for you' }
    : { key: 'counts', label: 'Counts agreed', state: f.shifts.length ? 'done' : 'none', detail: f.shifts.length ? 'Every count difference is decided.' : 'Nothing was counted.', to: '/waiting?show=count' });

  const noPlan = closed.filter((s) => typeof s.cash_kept !== 'number');
  rows.push(f.cashAwaitingBank > 0
    ? { key: 'cash', label: 'Cash put away', state: 'todo', detail: `${money(f.cashAwaitingBank)} taken to the bank, not yet confirmed with a slip.${f.inSafe > 0 ? ` ${money(f.inSafe)} in the safe.` : ''}`, to: '/accounting?tab=settle', action: 'Settle up' }
    : closed.length === 0
      ? { key: 'cash', label: 'Cash put away', state: 'none', detail: 'No shift has closed yet.', to: '/accounting?tab=settle' }
      : { key: 'cash', label: 'Cash put away', state: 'done', detail: noPlan.length
        ? `Closed without saying where the cash went: ${noPlan.map((s) => s.code).join(', ')}.`
        : `Every close said where its cash went.${f.inSafe > 0 ? ` ${money(f.inSafe)} is in the safe, to bank when convenient.` : ''}`, to: '/accounting?tab=settle' });

  const hanging = f.momoHanging + f.cardHanging;
  rows.push(hanging > 0
    ? { key: 'settle', label: 'MoMo and card settled', state: 'todo', detail: `${f.momoHanging ? `MoMo ${money(f.momoHanging)}` : ''}${f.momoHanging && f.cardHanging ? ' and ' : ''}${f.cardHanging ? `card ${money(f.cardHanging)}` : ''} taken, not yet matched to what reached the bank.`, to: '/accounting?tab=settle', action: 'Settle up' }
    : { key: 'settle', label: 'MoMo and card settled', state: 'done', detail: 'Everything taken by MoMo and card is matched to the bank.', to: '/accounting?tab=settle' });

  rows.push(f.pendingSpends > 0
    ? { key: 'spends', label: 'Spends agreed', state: 'todo', detail: `${f.pendingSpends} spend${f.pendingSpends === 1 ? '' : 's'}, ${money(f.pendingSpendTotal)}, still to look at.`, to: '/waiting?show=spend', action: 'Waiting for you' }
    : { key: 'spends', label: 'Spends agreed', state: f.shifts.length ? 'done' : 'none', detail: f.shifts.length ? 'Every spend from the drawers is agreed.' : 'Nothing was spent from a drawer.', to: '/waiting?show=spend' });

  const due = f.boxes.filter((b) => !b.lastCounted || f.now - new Date(b.lastCounted).getTime() > BOX_DUE_MS);
  rows.push(f.boxes.length === 0
    ? { key: 'petty', label: 'Petty cash counted', state: 'none', detail: 'No petty cash boxes.', to: '/imprest' }
    : due.length > 0
      ? { key: 'petty', label: 'Petty cash counted', state: 'todo', detail: due.map((b) => `${b.name} ${b.lastCounted ? `last counted ${Math.floor((f.now - new Date(b.lastCounted).getTime()) / 86_400_000)} days ago` : 'never counted'}`).join(' · '), to: '/imprest', action: 'Count box' }
      : { key: 'petty', label: 'Petty cash counted', state: 'done', detail: 'Every box counted in the last week.', to: '/imprest' });

  return rows;
}

/** "3 of 6 done", counting only the rows there is something to do on. */
export function closeDayProgress(rows: CloseDayRow[]): { done: number; of: number } {
  const live = rows.filter((r) => r.state !== 'none');
  return { done: live.filter((r) => r.state === 'done').length, of: live.length };
}
