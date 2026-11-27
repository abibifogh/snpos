import { db, DB_ID, ID, Query, listAll } from './client';
import { followUpProblem, closeProblem, dayOf } from './follow-ups';
import type { FollowUp, FollowUpRef, NewFollowUp } from './follow-ups';

/**
 * Reading and writing follow-ups and notes. The rules are in follow-ups.ts.
 *
 * Nothing here is fatal when the collection is not there yet: a database not
 * updated since follow-ups arrived reads as having none, and adding one says
 * the database needs updating rather than failing in Appwrite's words.
 */

const notProvisioned = (e: unknown): Error => {
  const why = e instanceof Error ? e.message : String(e);
  return new Error(/could not be found|not found/i.test(why)
    ? 'Follow-ups need a database update before they can be used. Ask an admin to run it.'
    : why);
};

/** Every open follow-up, and what was closed in the last fortnight. */
export async function loadFollowUps(venueId: string): Promise<FollowUp[]> {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const [open, done] = await Promise.all([
    listAll<FollowUp>('follow_ups', [Query.equal('venue_id', venueId), Query.equal('status', 'open'), Query.equal('kind', 'task')]),
    listAll<FollowUp>('follow_ups', [
      Query.equal('venue_id', venueId), Query.equal('status', 'done'), Query.equal('kind', 'task'),
      Query.greaterThanEqual('done_at', since),
    ]),
  ]).catch(() => [[], []] as FollowUp[][]);
  return [...open, ...done];
}

/** Everything written about one thing: its notes and follow-ups, oldest first. */
export async function followUpsAbout(refKind: FollowUpRef, refIds: string[]): Promise<FollowUp[]> {
  if (refIds.length === 0) return [];
  const rows: FollowUp[] = [];
  for (let i = 0; i < refIds.length; i += 100) {
    rows.push(...await listAll<FollowUp>('follow_ups', [
      Query.equal('ref_kind', refKind), Query.equal('ref_id', refIds.slice(i, i + 100)),
    ]).catch(() => [] as FollowUp[]));
  }
  return rows.sort((a, b) => (a.$createdAt ?? '').localeCompare(b.$createdAt ?? ''));
}

export interface Author { profileId: string; name: string }

/** Add a follow-up. Checked first; see followUpProblem. */
export async function addFollowUp(
  venueId: string,
  f: NewFollowUp & { refKind?: FollowUpRef; refId?: string; refLabel?: string },
  by: Author,
): Promise<FollowUp> {
  const problem = followUpProblem(f, dayOf(new Date()));
  if (problem) throw new Error(problem);
  return db.createDocument(DB_ID, 'follow_ups', ID.unique(), {
    venue_id: venueId,
    kind: 'task',
    title: f.title.trim().slice(0, 300),
    note: (f.note ?? '').trim().slice(0, 2000),
    ref_kind: f.refKind ?? 'other',
    ref_id: f.refId ?? '',
    ref_label: (f.refLabel ?? '').slice(0, 160),
    for_role: f.forRole ?? 'auditor',
    for_id: f.forId ?? '',
    for_name: (f.forName ?? '').slice(0, 120),
    due_on: f.dueOn ?? '',
    status: 'open',
    created_by: by.profileId,
    created_name: by.name.slice(0, 120),
  }).then((d) => d as unknown as FollowUp).catch((e) => { throw notProvisioned(e); });
}

/** A note on something: done the moment it is written, kept for good. */
export async function addNote(
  venueId: string,
  about: { refKind: FollowUpRef; refId: string; refLabel?: string },
  text: string,
  by: Author,
): Promise<FollowUp> {
  const body = text.trim();
  if (body.length < 3) throw new Error('Write the note first.');
  const now = new Date().toISOString();
  return db.createDocument(DB_ID, 'follow_ups', ID.unique(), {
    venue_id: venueId,
    kind: 'note',
    title: body.slice(0, 300),
    note: body.length > 300 ? body.slice(0, 2000) : '',
    ref_kind: about.refKind,
    ref_id: about.refId,
    ref_label: (about.refLabel ?? '').slice(0, 160),
    status: 'done',
    done_at: now,
    done_by: by.profileId,
    done_name: by.name.slice(0, 120),
    created_by: by.profileId,
    created_name: by.name.slice(0, 120),
  }).then((d) => d as unknown as FollowUp).catch((e) => { throw notProvisioned(e); });
}

/** Close a follow-up, saying what was done. */
export async function closeFollowUp(id: string, note: string, by: Author): Promise<void> {
  const problem = closeProblem(note);
  if (problem) throw new Error(problem);
  await db.updateDocument(DB_ID, 'follow_ups', id, {
    status: 'done',
    done_at: new Date().toISOString(),
    done_by: by.profileId,
    done_name: by.name.slice(0, 120),
    done_note: note.trim().slice(0, 500),
  });
}

/** Open a closed one again, when it turns out not to be done. */
export async function reopenFollowUp(id: string): Promise<void> {
  await db.updateDocument(DB_ID, 'follow_ups', id, {
    status: 'open', done_at: null, done_by: '', done_name: '', done_note: '',
  });
}
