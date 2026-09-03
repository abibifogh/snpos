/**
 * Reading and writing time off.
 *
 * The rules are next door in leave.ts, which has no database in it. This is
 * the part that has to survive two people tapping at the same moment.
 *
 * There are no transactions here, so a plain read-then-write cannot promise
 * the cap. Two waiters asking for the same Saturday a second apart both read
 * "two off, room for one", both write, and the day ends at four. On a rota
 * that is not a rounding error: it is a floor with nobody on it.
 *
 * So the day is checked AGAIN after writing, against what is actually there,
 * and the rule is first asked, first held. A row that turns out not to be
 * among the first `cap` on its day refuses itself and says why. That is not as
 * good as a transaction and it is honest: the loser finds out immediately, in
 * the same words they would have got had they been a second slower, rather
 * than a fortnight later when somebody notices the rota.
 */
import { db, DB_ID, ID, Query, listAll, saveDropping } from './client';
import { checkLeave, holdsAPlace, dayWords } from './leave';
import type { LeaveDay, LeaveKind, LeaveCheck, LeaveStatus } from './leave';
import type { Doc } from './types';

export type FiledLeave = LeaveDay & Doc & { venue_id: string };

/**
 * The order requests are honoured in: whoever asked first.
 *
 * The server's own creation stamp leads, because it is the one thing no device
 * can get wrong. asked_at and then the row id settle a tie, and both are fixed
 * at writing and identical for everybody reading — which is what lets two
 * devices work this out separately and agree.
 */
const inAskOrder = (a: FiledLeave, b: FiledLeave): number =>
  (a.$createdAt ?? '').localeCompare(b.$createdAt ?? '')
  || (a.asked_at ?? '').localeCompare(b.asked_at ?? '')
  || a.$id.localeCompare(b.$id);

/** Every leave row touching a stretch of days. */
export const loadLeave = (venueId: string, fromDay: string, toDay: string): Promise<FiledLeave[]> =>
  listAll<FiledLeave>('staff_leave', [
    Query.equal('venue_id', venueId),
    Query.greaterThanEqual('day', fromDay),
    Query.lessThanEqual('day', toDay),
  ]).catch(() => [] as FiledLeave[]);

/** One person's own, from a day onwards. */
export const loadMyLeave = (venueId: string, staffId: string, fromDay: string): Promise<FiledLeave[]> =>
  listAll<FiledLeave>('staff_leave', [
    Query.equal('venue_id', venueId),
    Query.equal('staff_id', staffId),
    Query.greaterThanEqual('day', fromDay),
  ]).catch(() => [] as FiledLeave[]);

export interface RequestResult extends LeaveCheck {
  /** The rows that actually landed. */
  booked: FiledLeave[];
  /** Days lost to somebody else in the same moment. See the note above. */
  lostToRace: string[];
  /** Days the database refused outright, which is not a cap problem. */
  failed: string[];
}

/**
 * Ask for time off.
 *
 * Checked before writing so the ordinary case gives an immediate, accurate
 * refusal with the day named, and checked again after writing so the rare
 * simultaneous case cannot quietly break the cap.
 */
export async function requestLeave(opts: {
  venueId: string;
  staffId: string;
  staffName: string;
  days: string[];
  kind: LeaveKind;
  reason?: string;
  cap: number;
  /** Set where a manager is filing it for somebody and it needs no approval. */
  approvedBy?: string;
  showNames?: boolean;
}): Promise<RequestResult> {
  const days = [...new Set(opts.days)].sort();
  if (days.length === 0) {
    return { allowed: [], refused: [], booked: [], lostToRace: [], failed: [] };
  }

  const existing = await loadLeave(opts.venueId, days[0], days[days.length - 1]);
  const check = checkLeave({
    days, staffId: opts.staffId, existing, cap: opts.cap, showNames: opts.showNames,
  });

  const requestId = ID.unique();
  const askedAt = new Date().toISOString();
  const booked: FiledLeave[] = [];
  const failed: string[] = [];

  for (const day of check.allowed) {
    try {
      const { id } = await saveDropping('staff_leave', null, {
        venue_id: opts.venueId,
        request_id: requestId,
        staff_id: opts.staffId,
        staff_name: opts.staffName,
        day,
        kind: opts.kind,
        status: opts.approvedBy ? 'approved' : 'requested',
        reason: opts.reason ?? '',
        asked_at: askedAt,
        decided_by: opts.approvedBy ?? '',
        decided_at: opts.approvedBy ? askedAt : '',
      });
      booked.push({
        $id: id, venue_id: opts.venueId, request_id: requestId, staff_id: opts.staffId,
        staff_name: opts.staffName, day, kind: opts.kind,
        status: opts.approvedBy ? 'approved' : 'requested', asked_at: askedAt,
      } as FiledLeave);
    } catch {
      failed.push(day);
    }
  }

  /*
    AND NOW THE SAME QUESTION, ASKED OF WHAT IS ACTUALLY THERE.

    First asked, first held — decided on the SERVER's own creation stamp, not
    on the one the device wrote. A till with a wrong clock could otherwise
    claim priority over a request made an hour earlier, and clocks on shared
    tablets are wrong often enough that this would happen. asked_at and the
    row id break a tie under it, so two devices settling this independently
    reach the same answer instead of each deciding it won.

    Every row on the day is judged, not only the ones this call wrote. Judging
    only our own would let a pair of simultaneous writers each find themselves
    inside the limit while pushing somebody who asked yesterday outside it, and
    nobody would ever look at that row again.
  */
  const lostToRace: string[] = [];
  if (booked.length > 0) {
    const after = await loadLeave(opts.venueId, days[0], days[days.length - 1]);
    const mine = new Set(booked.map((b) => b.$id));

    for (const day of [...new Set(booked.map((b) => b.day))]) {
      const queue = after.filter((r) => r.day === day && holdsAPlace(r)).sort(inAskOrder);
      for (const row of queue.slice(opts.cap)) {
        /*
          Only our own rows are refused here.

          Somebody else's request being over the limit is a fact this call has
          no business deciding — their own write settles it the same way, and
          two callers both refusing the same third row would write the same
          refusal twice. What matters is that the ORDER is worked out from
          every row on the day, which it now is.
        */
        if (!mine.has(row.$id)) continue;
        await db.updateDocument(DB_ID, 'staff_leave', row.$id, {
          status: 'refused',
          decided_by: '',
          decided_at: new Date().toISOString(),
          decided_note: `${dayWords(day)} filled up at the same moment this was asked for. `
            + `At most ${opts.cap} can be off on one day.`,
        }).catch(() => undefined);
        lostToRace.push(day);
      }
    }
  }

  const kept = booked.filter((b) => !lostToRace.includes(b.day));
  return {
    allowed: kept.map((b) => b.day),
    refused: [
      ...check.refused,
      ...lostToRace.map((day) => ({
        day,
        reason: `${dayWords(day)} filled up at the same moment you asked. At most ${opts.cap} can be off on `
          + 'one day, and somebody else reached it first. Pick another day.',
      })),
    ].sort((a, b) => a.day.localeCompare(b.day)),
    booked: kept,
    lostToRace,
    failed,
  };
}

/**
 * Agree to, or turn down, one day.
 *
 * Approving is checked against the cap again rather than waved through. An
 * admin who raised nothing and lowered nothing cannot make a fourth place
 * appear by pressing approve, and finding that out here is better than finding
 * it out from a rota.
 */
export async function decideLeave(opts: {
  venueId: string;
  rowId: string;
  to: Extract<LeaveStatus, 'approved' | 'refused'>;
  userId: string;
  note?: string;
  cap: number;
}): Promise<{ ok: boolean; problem: string | null }> {
  const row = await db.getDocument(DB_ID, 'staff_leave', opts.rowId).catch(() => null) as FiledLeave | null;
  if (!row) return { ok: false, problem: 'That request could not be found.' };

  if (opts.to === 'approved' && !holdsAPlace(row)) {
    const sameDay = await loadLeave(opts.venueId, row.day, row.day);
    const held = sameDay.filter((r) => holdsAPlace(r) && r.$id !== row.$id);
    if (held.length >= opts.cap) {
      return {
        ok: false,
        problem: `${dayWords(row.day)} already has ${held.length} of ${opts.cap} off. Refuse one of those `
          + 'first, or raise the limit under Settings.',
      };
    }
  }

  const done = await db.updateDocument(DB_ID, 'staff_leave', opts.rowId, {
    status: opts.to,
    decided_by: opts.userId,
    decided_at: new Date().toISOString(),
    decided_note: opts.note ?? '',
  }).then(() => true).catch(() => false);

  return done
    ? { ok: true, problem: null }
    : { ok: false, problem: 'That could not be saved. Try again.' };
}

/**
 * Take back a request you made.
 *
 * Marked withdrawn rather than deleted. The day it freed up is a fact somebody
 * else's request now depends on, and a row that vanishes takes the reason with
 * it — "why did Regina not get the twelfth" has to stay answerable.
 */
export async function withdrawLeave(rowId: string, staffId: string): Promise<boolean> {
  const row = await db.getDocument(DB_ID, 'staff_leave', rowId).catch(() => null) as FiledLeave | null;
  if (!row || row.staff_id !== staffId) return false;
  return db.updateDocument(DB_ID, 'staff_leave', rowId, {
    status: 'withdrawn',
    decided_by: staffId,
    decided_at: new Date().toISOString(),
  }).then(() => true).catch(() => false);
}
