import { db, DB_ID, ID, Query, listAll } from './client';

/**
 * Reading handovers back is arithmetic, so it lives next door in a file that
 * imports nothing and can be tested. Re-exported so callers need not care.
 */
export { byStaff, totalHandedOver } from './handover-math';
export type { StaffCashLine, HandoverLike } from './handover-math';
import type { Doc, StaffProfile } from './types';

/**
 * Cash leaving one person's hands and entering another's.
 *
 * A shift is not a person. Three people can work one shift, take money in turn
 * out of the same drawer and leave at different times, and the shift close,
 * which happens once at the end, cannot say who left with what. So "what did
 * Ama end with?" had no answer anywhere in the system, and the only record was
 * whatever a manager wrote on a pad.
 *
 * Each handover names both halves of the exchange: who gave it and who took it.
 * One name is a claim; two is a record.
 */

export type HandoverDestination = 'manager' | 'safe' | 'next_shift' | 'bank' | 'owner' | 'other';

export interface CashHandover extends Doc {
  venue_id?: string;
  shift_id?: string;
  staff_id: string;
  staff_name?: string;
  amount: number;
  method_id?: string;
  method_name?: string;
  destination: HandoverDestination;
  received_by?: string;
  received_by_name?: string;
  note?: string;
  handed_at: string;
  corrects_id?: string;
  status: 'recorded' | 'corrected';
}

export const HANDOVER_DESTINATIONS: { v: HandoverDestination; l: string }[] = [
  { v: 'manager', l: 'A manager' },
  { v: 'safe', l: 'The safe' },
  { v: 'next_shift', l: 'The next shift' },
  { v: 'owner', l: 'The owner' },
  { v: 'bank', l: 'Straight to the bank' },
  { v: 'other', l: 'Somewhere else' },
];

export const destinationLabel = (d: HandoverDestination): string =>
  HANDOVER_DESTINATIONS.find((x) => x.v === d)?.l ?? 'Somewhere else';

/**
 * Write down that cash changed hands.
 *
 * Never edits an earlier one. A handover somebody can quietly revise afterwards
 * is not evidence of anything, so a mistake is fixed by recording a correction
 * that points at the original, and both stay on the record. That is the whole
 * difference between a log and a note.
 */
export async function recordHandover(opts: {
  venueId: string;
  shiftId?: string;
  staff: Pick<StaffProfile, '$id' | 'display_name'> & { user_id?: string };
  amount: number;
  methodId?: string;
  methodName?: string;
  destination: HandoverDestination;
  receivedBy?: Pick<StaffProfile, '$id' | 'display_name'> | null;
  note?: string;
  correctsId?: string;
  at?: Date;
}): Promise<CashHandover> {
  if (!(opts.amount > 0)) throw new Error('Enter how much is being handed over.');

  const row = (await db.createDocument(DB_ID, 'cash_handovers', ID.unique(), {
    venue_id: opts.venueId,
    shift_id: opts.shiftId ?? '',
    staff_id: opts.staff.$id,
    // Snapshotted, so a handover still reads after somebody has left and their
    // profile has been switched off or renamed.
    staff_name: opts.staff.display_name,
    amount: opts.amount,
    method_id: opts.methodId ?? '',
    method_name: opts.methodName ?? '',
    destination: opts.destination,
    received_by: opts.receivedBy?.$id ?? '',
    received_by_name: opts.receivedBy?.display_name ?? '',
    note: opts.note ?? '',
    handed_at: (opts.at ?? new Date()).toISOString(),
    corrects_id: opts.correctsId ?? '',
    status: 'recorded',
  })) as unknown as CashHandover;

  // The row being corrected is marked, not changed. Its figure stays exactly
  // as it was written; that is what makes the correction meaningful.
  if (opts.correctsId) {
    await db
      .updateDocument(DB_ID, 'cash_handovers', opts.correctsId, { status: 'corrected' })
      .catch(() => undefined);
  }

  return row;
}

export const handoversForShift = (shiftId: string) =>
  listAll<CashHandover>('cash_handovers', [Query.equal('shift_id', shiftId)]).then((rows) =>
    rows.sort((a, b) => a.handed_at.localeCompare(b.handed_at)),
  );

export const handoversForStaff = (staffId: string) =>
  listAll<CashHandover>('cash_handovers', [Query.equal('staff_id', staffId)]).then((rows) =>
    rows.sort((a, b) => b.handed_at.localeCompare(a.handed_at)),
  );
