/**
 * Closing a month is a checklist, not a date.
 *
 * The lock used to be a date somebody typed. Nothing asked whether the
 * shifts in that month had been settled, whether a count was still waiting
 * for an admin, or whether a spend filed on the 30th had been approved — so a
 * month could be closed over figures that were about to change, and the
 * change then had nowhere to land. That is how "the report said one thing in
 * October and another in December" happens.
 *
 * So the lock is refused until the things that would move the month's
 * figures are finished, and it says which. Two strengths of item:
 *
 *   BLOCK   the figures WILL change. An unsettled shift, a count or a spend
 *           still waiting for a decision, a trial balance that does not add
 *           up. Locking over these locks in a number somebody has already
 *           found to be wrong.
 *
 *   WARN    the figures are right and something is still owed. Card money the
 *           provider has not settled yet, tips not handed over, tax not
 *           remitted, makers not paid, a side not counted this month. None of
 *           these change what the month earned; they are money in transit.
 *           The month can close over them — a September settlement that lands
 *           in October belongs in October — and the lock says so, so nobody
 *           locks in ignorance.
 *
 * Pure. Imports nothing at runtime.
 */

export interface CloseShift {
  $id: string;
  code?: string;
  status?: string;
  opened_at?: string;
  closed_at?: string;
  $createdAt?: string;
  /** Set when somebody settled it. */
  locked_at?: string | null;
  module?: string;
}

export interface CloseFacts {
  /** The last day being closed, YYYY-MM-DD. */
  through: string;
  /** The first day of the period, YYYY-MM-DD, for "counted this month". */
  from: string;
  shifts: CloseShift[];
  /** Bar and store-room count lines held for an admin. */
  pendingBarLines: number;
  /** Shop stocktakes waiting. */
  pendingShopCounts: number;
  pendingSpends: number;
  pendingSpendValue: number;
  pendingShelfChanges: number;
  hanging: { card: number; momo: number; tips: number; tax: number };
  owedToMakers: number;
  /** The last day each side was counted, YYYY-MM-DD, or nothing. */
  lastCounted: Record<string, string | undefined>;
  trialBalanced: boolean;
}

export type CloseState = 'ok' | 'warn' | 'block';

export interface CloseItem {
  key: string;
  title: string;
  detail: string;
  state: CloseState;
  /** Where to go to fix it. */
  goto?: 'shifts' | 'waiting' | 'settle' | 'payouts' | 'counts' | 'journal';
}

const SIDE_WORDS: Record<string, string> = { kitchen: 'Bistro', bar: 'Bar', craft: 'Craft shop' };
const day = (iso?: string) => (iso ?? '').slice(0, 10);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The shifts that belong to the period being closed. */
export function shiftsInPeriod(shifts: CloseShift[], through: string): CloseShift[] {
  return shifts.filter((s) => {
    const started = day(s.opened_at || s.$createdAt);
    return !!started && started <= through;
  });
}

export function closeChecklist(f: CloseFacts): CloseItem[] {
  const items: CloseItem[] = [];
  const inPeriod = shiftsInPeriod(f.shifts, f.through);

  // --- shifts
  const stillOpen = inPeriod.filter((s) => s.status === 'open' || s.status === 'closing');
  const unsettled = inPeriod.filter((s) => (s.status === 'closed' || s.status === 'reopened') && !s.locked_at);
  const settledCount = inPeriod.length - stillOpen.length - unsettled.length;
  if (stillOpen.length > 0) {
    items.push({
      key: 'shifts', title: 'Every shift closed and settled', state: 'block', goto: 'shifts',
      detail: `${plural(stillOpen.length, 'shift is', 'shifts are')} still open (${stillOpen.map((s) => s.code ?? s.$id).slice(0, 3).join(', ')}). Nothing that is still trading can be closed over.`,
    });
  } else if (unsettled.length > 0) {
    items.push({
      key: 'shifts', title: 'Every shift closed and settled', state: 'block', goto: 'shifts',
      detail: `${plural(unsettled.length, 'shift has', 'shifts have')} not been settled (${unsettled.map((s) => s.code ?? s.$id).slice(0, 3).join(', ')}${unsettled.length > 3 ? ', …' : ''}). An unsettled night can still be corrected, so its figures are not final.`,
    });
  } else {
    items.push({
      key: 'shifts', title: 'Every shift closed and settled', state: 'ok',
      detail: inPeriod.length === 0 ? 'No shifts in this period.' : `${settledCount} of ${inPeriod.length} closed and settled.`,
    });
  }

  // --- things waiting for an admin
  const waitingCounts = f.pendingBarLines + f.pendingShopCounts;
  items.push(waitingCounts > 0
    ? {
        key: 'counts', title: 'Counts approved', state: 'block', goto: 'waiting',
        detail: [
          f.pendingBarLines > 0 ? `${plural(f.pendingBarLines, 'bar count line', 'bar count lines')}` : '',
          f.pendingShopCounts > 0 ? `${plural(f.pendingShopCounts, 'shop stocktake', 'shop stocktakes')}` : '',
        ].filter(Boolean).join(' and ') + ' still waiting. The stock figures are the old ones until you decide.',
      }
    : { key: 'counts', title: 'Counts approved', state: 'ok', detail: 'Nothing waiting.' });

  items.push(f.pendingSpends > 0
    ? {
        key: 'spends', title: 'Spends approved', state: 'block', goto: 'waiting',
        detail: `${plural(f.pendingSpends, 'spend', 'spends')} waiting, ${f.pendingSpendValue} in minor units. A refused spend comes off the month.`,
      }
    : { key: 'spends', title: 'Spends approved', state: 'ok', detail: 'Nothing waiting.' });

  if (f.pendingShelfChanges > 0) {
    items.push({
      key: 'shelf', title: 'Shelf changes decided', state: 'warn', goto: 'waiting',
      detail: `${plural(f.pendingShelfChanges, 'shelf change', 'shelf changes')} waiting. They move stock, not money, so the month can close over them.`,
    });
  } else {
    items.push({ key: 'shelf', title: 'Shelf changes decided', state: 'ok', detail: 'Nothing waiting.' });
  }

  // --- money in transit
  const clearing = f.hanging.card + f.hanging.momo;
  items.push(clearing > 0
    ? {
        key: 'clearing', title: 'Card and mobile money settled to the bank', state: 'warn', goto: 'settle',
        detail: `Card ${f.hanging.card} and mobile money ${f.hanging.momo} (minor units) not yet settled. A settlement that lands next month belongs to next month; the month can close.`,
      }
    : { key: 'clearing', title: 'Card and mobile money settled to the bank', state: 'ok', detail: 'Nothing waiting on a provider.' });

  items.push(f.hanging.tips > 0
    ? { key: 'tips', title: 'Tips paid to staff', state: 'warn', goto: 'settle', detail: `${f.hanging.tips} (minor units) still owed to staff.` }
    : { key: 'tips', title: 'Tips paid to staff', state: 'ok', detail: 'Nothing owed.' });

  items.push(f.hanging.tax > 0
    ? { key: 'tax', title: 'Tax remitted', state: 'warn', goto: 'settle', detail: `${f.hanging.tax} (minor units) collected and not yet remitted.` }
    : { key: 'tax', title: 'Tax remitted', state: 'ok', detail: 'Nothing owed.' });

  items.push(f.owedToMakers > 0
    ? { key: 'makers', title: 'Makers paid up to date', state: 'warn', goto: 'payouts', detail: `${f.owedToMakers} (minor units) owed to makers.` }
    : { key: 'makers', title: 'Makers paid up to date', state: 'ok', detail: 'Nothing owed.' });

  // --- counted this month, for every side that traded
  const sides = [...new Set(inPeriod.map((s) => s.module ?? 'kitchen'))];
  const uncounted = sides.filter((m) => {
    const last = f.lastCounted[m];
    return !last || last < f.from || last > f.through;
  });
  items.push(uncounted.length > 0
    ? {
        key: 'counted', title: 'Stock counted this month', state: 'warn', goto: 'counts',
        detail: `${uncounted.map((m) => SIDE_WORDS[m] ?? m).join(', ')} not counted between ${f.from} and ${f.through}. Cost of sales rests on the recipes alone.`,
      }
    : {
        key: 'counted', title: 'Stock counted this month', state: 'ok',
        detail: sides.length === 0 ? 'No side traded.' : sides.map((m) => `${SIDE_WORDS[m] ?? m} ${f.lastCounted[m]}`).join(' · '),
      });

  // --- the books add up
  items.push(f.trialBalanced
    ? { key: 'trial', title: 'Trial balance balances', state: 'ok', detail: 'Debits and credits agree.' }
    : { key: 'trial', title: 'Trial balance balances', state: 'block', goto: 'journal', detail: 'Debits and credits do not agree. An entry is missing a line; find it in the journal before closing.' });

  return items;
}

export function mayLock(items: CloseItem[]): { ok: boolean; blocking: CloseItem[]; warnings: CloseItem[] } {
  const blocking = items.filter((i) => i.state === 'block');
  const warnings = items.filter((i) => i.state === 'warn');
  return { ok: blocking.length === 0, blocking, warnings };
}

/** "4 of 9 done", for the header. */
export function closeProgress(items: CloseItem[]): string {
  const done = items.filter((i) => i.state === 'ok').length;
  return `${done} of ${items.length} done`;
}

/** What to say before locking over warnings. */
export function lockOverWarningsWords(warnings: CloseItem[], through: string): string {
  if (warnings.length === 0) return `Close the books up to ${through}?`;
  return `Close the books up to ${through} with ${plural(warnings.length, 'thing', 'things')} still in transit? `
    + warnings.map((w) => w.title.toLowerCase()).join('; ')
    + '. None of these change what the month earned; each will land in the month it happens.';
}
