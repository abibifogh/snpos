/**
 * Cleaning routines and the lists filed against them, read and written.
 * The rules are in cleaning.ts.
 */
import { db, DB_ID, Query, listAll, saveDropping } from './client';
import {
  routineFrom, routineRow, readAnswers, needsReview, cleanDay, cleanProgress,
} from './cleaning';
import type { CleanAnswer, CleanKind, CleanRoutine, CleanSide } from './cleaning';

/** A side's routine, or its defaults (switched off) when none has been saved. */
export async function loadRoutine(side: CleanSide): Promise<CleanRoutine> {
  const row = await db.getDocument(DB_ID, 'clean_routines', side).catch(() => null) as Parameters<typeof routineFrom>[1];
  return routineFrom(side, row);
}

/** Both sides' routines, for the admin page. */
export async function loadRoutines(): Promise<Record<CleanSide, CleanRoutine>> {
  const [kitchen, bar] = await Promise.all([loadRoutine('kitchen'), loadRoutine('bar')]);
  return { kitchen, bar };
}

/** Save a side's routine: on or off, the lists, the deep-clean day. */
export async function saveRoutine(r: CleanRoutine, by: string): Promise<void> {
  const fields = { ...routineRow(r), updated_by: by };
  const exists = await db.getDocument(DB_ID, 'clean_routines', r.side).then(() => true).catch(() => false);
  // One row per side, its id the side, so reading it back is one lookup.
  if (exists) await db.updateDocument(DB_ID, 'clean_routines', r.side, fields);
  else await db.createDocument(DB_ID, 'clean_routines', r.side, fields);
}

export interface CleanLog {
  $id: string;
  $createdAt?: string;
  venue_id: string;
  side: CleanSide;
  kind: CleanKind;
  day: string;
  shift_id?: string;
  by_id?: string;
  by_name?: string;
  finished_at: string;
  answers: CleanAnswer[];
  done: number;
  of: number;
  required_left: number;
  out_of_range: number;
  skip_reason?: string;
  deep?: boolean;
  review: 'none' | 'pending' | 'seen';
  reviewed_by?: string;
}

type LogRow = Omit<CleanLog, 'answers'> & { answers?: string };
const fromRow = (r: LogRow): CleanLog => ({ ...r, answers: readAnswers(r.answers) });

/** Whether this side has filed this list today. Unknown (offline) counts as filed, so nobody is held up. */
export async function filedToday(venueId: string, side: CleanSide, kind: CleanKind, now = new Date()): Promise<boolean> {
  try {
    const rows = await db.listDocuments(DB_ID, 'clean_logs', [
      Query.equal('venue_id', venueId), Query.equal('side', side), Query.equal('kind', kind),
      Query.equal('day', cleanDay(now)), Query.limit(1),
    ]);
    return rows.documents.length > 0;
  } catch {
    return true;
  }
}

/** File a finished (or skipped) list. Goes to Approvals when something was missed or out of range. */
export async function fileClean(opts: {
  venueId: string;
  side: CleanSide;
  kind: CleanKind;
  answers: CleanAnswer[];
  deep: boolean;
  shiftId?: string;
  byId?: string;
  byName?: string;
  skipReason?: string;
  now?: Date;
}): Promise<{ id: string; review: boolean }> {
  const now = opts.now ?? new Date();
  const p = cleanProgress(opts.answers);
  const review = needsReview(opts.answers, !!opts.skipReason);
  const { id } = await saveDropping('clean_logs', null, {
    venue_id: opts.venueId,
    side: opts.side,
    kind: opts.kind,
    day: cleanDay(now),
    shift_id: opts.shiftId ?? '',
    by_id: opts.byId ?? '',
    by_name: (opts.byName ?? '').slice(0, 120),
    finished_at: now.toISOString(),
    answers: JSON.stringify(opts.answers),
    done: p.done,
    of: p.of,
    required_left: p.requiredLeft,
    out_of_range: p.outOfRange,
    skip_reason: (opts.skipReason ?? '').slice(0, 300),
    deep: opts.deep,
    review: review ? 'pending' : 'none',
  });
  return { id, review };
}

/** The filed lists waiting for a manager to see them. */
export async function pendingCleanLogs(): Promise<CleanLog[]> {
  const rows = await listAll<LogRow>('clean_logs', [Query.equal('review', 'pending')]);
  return rows.map(fromRow);
}

/** Seen: the record stays exactly as it was, and leaves Approvals. */
export async function markCleanSeen(id: string, by: string): Promise<void> {
  await saveDropping('clean_logs', id, { review: 'seen', reviewed_by: by, reviewed_at: new Date().toISOString() });
}

/** The lists filed since a day, newest first, for the cleaning log. */
export async function cleanLogsSince(venueId: string, fromDay: string): Promise<CleanLog[]> {
  const rows = await listAll<LogRow>('clean_logs', [Query.equal('venue_id', venueId), Query.greaterThanEqual('day', fromDay)]);
  return rows.map(fromRow).sort((a, b) => b.finished_at.localeCompare(a.finished_at));
}

