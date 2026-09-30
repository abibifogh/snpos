import { db, DB_ID, ID } from './client';
import type { SpendSnapshot } from './spend-history';
export { spendSnapshot } from './spend-history';

/**
 * A spend looked at, and kept or refused.
 *
 * Every spend recorded at the till was written as "pending" and nothing in
 * the system ever changed that: there was no button. The email said three
 * spends were waiting, the expenses page showed them like any other row, and
 * the month closed over them. This is the button.
 *
 * Approving is a stamp: who, and that it was looked at. Refusing is the same
 * stamp with the other word, and the server takes it from there — it reverses
 * the entry it posted for the spend, so a refused taxi is not a cost of the
 * month. See functions/notify/src/books-post.js. The row stays, marked,
 * because a spend somebody turned down is a better record than a gap; and the
 * shift it was on keeps counting it, because the money did leave the drawer.
 * See refuseSpendWords for what the page says about that.
 */
export async function decideSpend(opts: {
  expenseId: string;
  decision: 'approved' | 'rejected';
  by: string;
}): Promise<void> {
  const row = await db.updateDocument(DB_ID, 'shift_expenses', opts.expenseId, {
    approval_status: opts.decision,
    approved_by: opts.by,
  }) as unknown as { venue_id?: string; shift_id?: string };
  await logSpendChange({
    venueId: row.venue_id ?? 'main',
    expenseId: opts.expenseId,
    shiftId: row.shift_id,
    actorId: opts.by,
    action: opts.decision === 'approved' ? 'spend_approved' : 'spend_refused',
  });
}

/**
 * Write down one thing done to a spend: who, and from what to what.
 *
 * Best effort and never fatal. The change has already happened; a trail that
 * could not be written must not undo it. See spendHistory for how it is read.
 */
export async function logSpendChange(opts: {
  venueId: string;
  expenseId: string;
  shiftId?: string | null;
  actorId: string;
  role?: string;
  action: 'spend_edited' | 'spend_approved' | 'spend_refused' | 'spend_deleted';
  before?: SpendSnapshot;
  after?: SpendSnapshot;
  reason?: string;
}): Promise<void> {
  await db.createDocument(DB_ID, 'audit_log', ID.unique(), {
    venue_id: opts.venueId,
    actor_id: opts.actorId || 'unknown',
    actor_role: opts.role ?? '',
    action: opts.action,
    entity_type: 'shift_expenses',
    entity_id: opts.expenseId,
    before: opts.before ? JSON.stringify(opts.before).slice(0, 4000) : '',
    after: opts.after ? JSON.stringify(opts.after).slice(0, 4000) : '',
    reason: (opts.reason ?? '').slice(0, 500),
    shift_id: opts.shiftId ?? '',
  }).catch(() => undefined);
}
