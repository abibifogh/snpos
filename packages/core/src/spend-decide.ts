import { db, DB_ID } from './client';

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
  await db.updateDocument(DB_ID, 'shift_expenses', opts.expenseId, {
    approval_status: opts.decision,
    approved_by: opts.by,
  });
}
