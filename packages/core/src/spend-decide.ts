import { db, DB_ID } from './client';
import { expenseEntry, reverseEntry } from './ledger';

/**
 * A spend looked at, and kept or refused.
 *
 * Every spend recorded at the till was written as "pending" and nothing in
 * the system ever changed that: there was no button. The email said three
 * spends were waiting, the expenses page showed them like any other row, and
 * the month closed over them. This is the button.
 *
 * Approving is a stamp: who, and that it was looked at. Refusing takes it
 * off the books too, by reversing the entry the till posted, so a refused
 * taxi is not a cost of the month. The row stays, marked, because a spend
 * somebody turned down is a better record than a gap — and the shift it was
 * on keeps counting it, because the money did leave the drawer. See
 * refuseSpendWords for what the page says about that.
 */
export async function decideSpend(opts: {
  venueId: string;
  expenseId: string;
  decision: 'approved' | 'rejected';
  by: string;
}): Promise<{ reversed: boolean }> {
  await db.updateDocument(DB_ID, 'shift_expenses', opts.expenseId, {
    approval_status: opts.decision,
    approved_by: opts.by,
  });
  if (opts.decision === 'approved') return { reversed: false };

  const entry = await expenseEntry(opts.venueId, opts.expenseId);
  if (!entry || entry.reversed_by) return { reversed: false };
  await reverseEntry(entry, {
    postedBy: opts.by,
    memo: `Refused: ${entry.memo || 'money paid out'}`,
  });
  return { reversed: true };
}
