/**
 * Follow-ups: what somebody has to chase, and by when.
 *
 * Most are raised by the server's hourly sweep and closed by it when the thing
 * they are about is done: a count difference nobody has reviewed, a shift
 * closed with no count, a put-back not returned, deductions not yet sent to
 * HIVE. Anybody on To do can add their own ("Recount the spirits shelf with
 * Kojo, Saturday"). A note on a count difference is a follow-up of kind
 * 'note', done the moment it is written and kept for good.
 *
 * Pure: the rules for what is due and how it reads. Reading and writing are
 * in follow-ups-store.ts; the sweep is functions/notify/src/follow-ups.js.
 */

export type FollowUpKind = 'task' | 'note';
export type FollowUpRef = 'charge' | 'shift' | 'count' | 'month' | 'other';
export type FollowUpFor = 'auditor' | 'manager' | 'admin' | 'person';

export interface FollowUp {
  $id: string;
  $createdAt?: string;
  venue_id: string;
  kind: FollowUpKind;
  title: string;
  note?: string | null;
  ref_kind?: FollowUpRef | null;
  ref_id?: string | null;
  ref_label?: string | null;
  for_role?: FollowUpFor | null;
  for_id?: string | null;
  for_name?: string | null;
  /** YYYY-MM-DD, the venue's own day. */
  due_on?: string | null;
  status: 'open' | 'done';
  done_at?: string | null;
  done_by?: string | null;
  done_name?: string | null;
  done_note?: string | null;
  created_by?: string | null;
  created_name?: string | null;
  /** Set on the ones the sweep raised. */
  auto_key?: string | null;
  reminded_on?: string | null;
}

/** Who the system means by "system": a follow-up it raised or closed. */
export const FOLLOW_UP_SYSTEM = 'system';

/** Today as YYYY-MM-DD in this browser's time, which is the venue's for anybody standing in it. */
export function dayOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** A day so many days after another, both YYYY-MM-DD. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, (m || 1) - 1, d || 1) + n * 86_400_000);
  return t.toISOString().slice(0, 10);
}

/** Whole days from one YYYY-MM-DD to another. */
export function daysApart(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export type FollowUpStage = 'overdue' | 'today' | 'later' | 'someday' | 'done';

/** Where a follow-up stands on this day. */
export function followUpStage(f: Pick<FollowUp, 'status' | 'due_on'>, today: string): FollowUpStage {
  if (f.status === 'done') return 'done';
  if (!f.due_on) return 'someday';
  if (f.due_on < today) return 'overdue';
  if (f.due_on === today) return 'today';
  return 'later';
}

/** "Overdue 2 days", "Due today", "Due Sat 28 Nov", "No day set". */
export function dueWords(f: Pick<FollowUp, 'status' | 'due_on'>, today: string): string {
  const stage = followUpStage(f, today);
  if (stage === 'done') return 'Done';
  if (stage === 'someday' || !f.due_on) return 'No day set';
  if (stage === 'today') return 'Due today';
  if (stage === 'overdue') {
    const n = daysApart(f.due_on, today);
    return `Overdue ${n} day${n === 1 ? '' : 's'}`;
  }
  if (daysApart(today, f.due_on) === 1) return 'Due tomorrow';
  const d = new Date(`${f.due_on}T12:00:00`);
  return `Due ${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}`;
}

/** The tone a due date is shown in. */
export const dueTone = (f: Pick<FollowUp, 'status' | 'due_on'>, today: string): 'danger' | 'warn' | 'default' | 'ok' => {
  const stage = followUpStage(f, today);
  return stage === 'overdue' ? 'danger' : stage === 'today' ? 'warn' : stage === 'done' ? 'ok' : 'default';
};

/** Overdue first, oldest first; then today, then by day; no day last. */
export function sortFollowUps<T extends Pick<FollowUp, 'due_on' | 'title'>>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const da = a.due_on || '9999-99-99';
    const db = b.due_on || '9999-99-99';
    return da.localeCompare(db) || a.title.localeCompare(b.title);
  });
}

/** "Raised automatically · for the auditor", "Added by Adwoa · for Kojo". */
export function whoseWords(f: Pick<FollowUp, 'auto_key' | 'created_name' | 'for_role' | 'for_name'>): string {
  const by = f.auto_key ? 'Raised automatically' : `Added by ${f.created_name || 'somebody'}`;
  const forWho = f.for_role === 'person' ? f.for_name || 'one person'
    : f.for_role === 'auditor' ? 'the auditor'
      : f.for_role === 'manager' ? 'a manager'
        : f.for_role === 'admin' ? 'an admin'
          : 'anybody';
  return `${by} · for ${forWho}`;
}

/** Whether a follow-up is this person's to do: theirs by name, or their role's. */
export function isMine(
  f: Pick<FollowUp, 'for_role' | 'for_id'>,
  who: { $id?: string; role?: string | null } | null | undefined,
): boolean {
  if (!who) return false;
  if (f.for_role === 'person') return !!who.$id && f.for_id === who.$id;
  if (!f.for_role) return true;
  if (who.role === 'admin') return true;
  if (f.for_role === 'manager') return who.role === 'manager';
  return f.for_role === who.role;
}

export interface NewFollowUp {
  title: string;
  note?: string;
  dueOn?: string;
  forRole?: FollowUpFor;
  forId?: string;
  forName?: string;
}

/** Why this follow-up cannot be added, or null. */
export function followUpProblem(f: NewFollowUp, today: string): string | null {
  if (f.title.trim().length < 3) return 'Say what needs doing.';
  if (f.title.trim().length > 300) return 'Keep it to one line; put the rest in the note.';
  if (f.dueOn && !/^\d{4}-\d{2}-\d{2}$/.test(f.dueOn)) return 'Choose the day it is due.';
  if (f.dueOn && f.dueOn < today) return 'That day has passed. Choose today or later.';
  if (f.forRole === 'person' && !f.forId) return 'Choose who it is for.';
  return null;
}

/** Why it cannot be closed, or null. Closing says what was done. */
export function closeProblem(note: string): string | null {
  return note.trim().length < 3 ? 'Say in a line what was done.' : null;
}

/** Done in the last seven days, newest first. */
export function doneLately<T extends Pick<FollowUp, 'status' | 'done_at' | 'kind'>>(rows: T[], now: Date, days = 7): T[] {
  const since = now.getTime() - days * 86_400_000;
  return rows
    .filter((f) => f.kind === 'task' && f.status === 'done' && !!f.done_at && Date.parse(f.done_at) >= since)
    .sort((a, b) => (b.done_at ?? '').localeCompare(a.done_at ?? ''));
}
