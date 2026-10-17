import { db, DB_ID, ID, Query, listAll } from './client';
import { postEntry, lockPeriod } from './ledger';
import type { PostingLine } from './ledger';

/**
 * Opening balances, the year end and recurring entries: writing them.
 * The arithmetic is in ledger-reports.ts.
 */

/** The opening balances as one entry, keyed by its date so it posts once. */
export async function postOpeningBalances(venueId: string, opts: { date: string; userId: string }, lines: PostingLine[]) {
  return postEntry(venueId, {
    date: new Date(`${opts.date}T00:00:00`),
    source: 'adjustment',
    sourceId: `opening:${opts.date}`,
    memo: `Opening balances on ${opts.date}`,
    postedBy: opts.userId,
  }, lines);
}

/** Close a year into retained earnings, then close the books through that day. */
export async function closeYear(venueId: string, opts: { date: string; userId: string }, lines: PostingLine[]) {
  const entry = await postEntry(venueId, {
    date: new Date(`${opts.date}T23:59:00`),
    source: 'adjustment',
    sourceId: `year_end:${opts.date}`,
    memo: `Year end ${opts.date}: profit into retained earnings`,
    postedBy: opts.userId,
  }, lines);
  await lockPeriod(venueId, opts.date, { lockedBy: opts.userId, note: 'Year end' });
  return entry;
}

export interface RecurringEntry {
  $id: string;
  venue_id: string;
  name: string;
  lines: string;
  day_of_month: number;
  next_on: string;
  active?: boolean;
  last_posted_on?: string;
}

export const loadRecurring = (venueId: string): Promise<RecurringEntry[]> =>
  listAll<RecurringEntry>('recurring_entries', [Query.equal('venue_id', venueId)]);

export function saveRecurring(input: {
  venueId: string; name: string; lines: PostingLine[]; dayOfMonth: number; startOn: string; userId: string;
}) {
  return db.createDocument(DB_ID, 'recurring_entries', ID.unique(), {
    venue_id: input.venueId,
    name: input.name.trim().slice(0, 160),
    lines: JSON.stringify(input.lines.filter((l) => l.debit || l.credit)),
    day_of_month: Math.min(31, Math.max(1, Math.round(input.dayOfMonth))),
    next_on: input.startOn,
    active: true,
    created_by: input.userId,
  });
}

export const setRecurringActive = (id: string, active: boolean) =>
  db.updateDocument(DB_ID, 'recurring_entries', id, { active });

export const deleteRecurring = (id: string) => db.deleteDocument(DB_ID, 'recurring_entries', id);
