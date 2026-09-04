/**
 * What one line in a petty cash box actually was.
 *
 * The list answers "how much went out and when", which is the question a
 * COUNT asks. It is not the question anybody has when they look at a row and
 * do not recognise it — and that is the question that gets asked, because a
 * line reading "Spent · BISTRO-26/08/2026 · GH₵1,560.00" is a note somebody
 * typed in a hurry and nothing else. Who spent it, on what, out of which
 * shift, whether anybody approved it, and whether the money came back through
 * the books at all: all of that is already recorded and none of it was
 * reachable from the screen it belongs on.
 *
 * A movement and its expense are two different records and this shows both,
 * labelled as such. They can disagree — an expense corrected weeks later
 * leaves the original movement written and a correcting one beside it, which
 * is deliberate (see spendCorrections) and reads as a mystery unless the panel
 * says so.
 *
 * Pure. Imports nothing at runtime.
 */

/** One labelled fact, as it reads on the panel. */
export interface DetailRow {
  label: string;
  value: string;
  /** A second line under it, where the value alone would be misread. */
  hint?: string;
}

/** The movement, as far as this question is concerned. */
export interface DetailMovement {
  $id: string;
  kind: string;
  amount: number;
  occurred_at?: string;
  $createdAt?: string;
  note?: string;
  created_by?: string;
  ref_type?: string;
  ref_id?: string;
  entry_id?: string;
}

/** The expense behind a spend, where there is one. */
export interface DetailExpense {
  $id: string;
  amount?: number;
  category?: string;
  category_key?: string;
  payee?: string;
  paid_to_kind?: string;
  supplier_id?: string;
  paid_to_staff_id?: string;
  module?: string;
  shift_id?: string;
  note?: string;
  receipt_file_id?: string;
  created_by?: string;
  approved_by?: string;
  approval_status?: string;
  occurred_at?: string;
  $createdAt?: string;
}

export interface DetailNames {
  /** Staff and supplier names by id, so a panel shows people rather than ids. */
  people: Record<string, string>;
  suppliers: Record<string, string>;
  /** Category keys to the words an admin chose for them. */
  categories: Record<string, string>;
  shifts: Record<string, string>;
}

const EMPTY: DetailNames = { people: {}, suppliers: {}, categories: {}, shifts: {} };

/** A name, or an honest admission that the id no longer resolves. */
const nameOf = (id: string | undefined, book: Record<string, string>): string | null => {
  if (!id) return null;
  return book[id] ?? 'Somebody no longer on the staff list';
};

/** When it happened, in the reader's own time. */
export function whenWords(
  at: string | undefined,
  fallback?: string,
  format: (d: Date) => string = (d) => d.toLocaleString(),
): string {
  const raw = at || fallback;
  if (!raw) return 'Not recorded';
  const t = Date.parse(raw);
  return Number.isFinite(t) ? format(new Date(t)) : raw;
}

/** The heading: what this row was, and which way the money went. */
export function movementTitle(m: DetailMovement, kindLabel: string): string {
  return `${kindLabel} · ${m.amount >= 0 ? 'into the box' : 'out of the box'}`;
}

/**
 * What is known about the movement itself.
 *
 * Always available, because the movement is the row that was clicked. Shown
 * even when the expense behind it cannot be found, which is the case where a
 * panel with nothing in it would be worst.
 */
export function movementRows(opts: {
  movement: DetailMovement;
  kindLabel: string;
  names?: DetailNames;
  money: (amount: number) => string;
  formatDate?: (d: Date) => string;
}): DetailRow[] {
  const { movement: m, names = EMPTY } = opts;
  const rows: DetailRow[] = [
    {
      label: m.amount >= 0 ? 'Into the box' : 'Out of the box',
      value: opts.money(Math.abs(m.amount)),
    },
    { label: 'What', value: opts.kindLabel },
    { label: 'When', value: whenWords(m.occurred_at, m.$createdAt, opts.formatDate) },
  ];

  const by = nameOf(m.created_by, names.people);
  if (by) rows.push({ label: 'Recorded by', value: by });
  if (m.note) rows.push({ label: 'Note on the movement', value: m.note });

  /*
    Whether it reached the books, said plainly.

    A spend that posted no journal entry is money out of a box that the
    accounts have never heard of, and it will not appear in any report the
    owner reads. That is worth a line of its own rather than a missing one.
  */
  if (m.kind === 'spend') {
    rows.push(m.entry_id
      ? { label: 'In the books', value: 'Yes', hint: 'A journal entry was posted for this.' }
      : {
        label: 'In the books',
        value: 'No entry was posted',
        hint: 'The money left the box, but the accounts have no record of it. Re-saving the expense posts it.',
      });
  }

  return rows;
}

/** What the expense behind a spend says. */
export function expenseRows(opts: {
  expense: DetailExpense;
  names?: DetailNames;
  money: (amount: number) => string;
  formatDate?: (d: Date) => string;
}): DetailRow[] {
  const { expense: e, names = EMPTY } = opts;
  const rows: DetailRow[] = [];

  if (e.amount !== undefined) rows.push({ label: 'Amount', value: opts.money(e.amount) });

  const category = (e.category_key && names.categories[e.category_key])
    || (e.category_key ? 'A category that has since been removed' : null)
    || (e.category ? e.category.replace(/_/g, ' ') : null);
  if (category) rows.push({ label: 'What for', value: category });

  const paidTo = nameOf(e.supplier_id, names.suppliers)
    ?? nameOf(e.paid_to_staff_id, names.people)
    ?? (e.payee || null);
  if (paidTo) {
    rows.push({
      label: 'Paid to',
      value: paidTo,
      hint: e.supplier_id ? 'A supplier' : e.paid_to_staff_id ? 'A member of staff' : undefined,
    });
  }

  if (e.module) rows.push({ label: 'Which side', value: e.module });
  if (e.shift_id) {
    rows.push({
      label: 'Shift',
      value: names.shifts[e.shift_id] ?? 'A shift that is no longer listed',
    });
  }

  const by = nameOf(e.created_by, names.people);
  if (by) rows.push({ label: 'Spent by', value: by });

  rows.push({ label: 'Recorded', value: whenWords(e.occurred_at, e.$createdAt, opts.formatDate) });

  /*
    Approval, and only where it means something.

    "Not required" on every row would train somebody to skip the line on the
    day it says "waiting", which is the one day it matters.
  */
  if (e.approval_status === 'pending') {
    rows.push({ label: 'Approval', value: 'Waiting for somebody to approve it' });
  } else if (e.approval_status === 'approved') {
    rows.push({
      label: 'Approval',
      value: nameOf(e.approved_by, names.people) ?? 'Approved',
    });
  } else if (e.approval_status === 'rejected') {
    rows.push({ label: 'Approval', value: 'Turned down' });
  }

  if (e.note) rows.push({ label: 'Note on the expense', value: e.note });

  return rows;
}

/**
 * The movement says one figure and the expense says another.
 *
 * Not a fault. An expense corrected after the fact leaves the original
 * movement written and a correcting one beside it — see spendCorrections,
 * where that is argued for. But somebody reading one row of the pair sees a
 * figure that does not match the expense it names, and without this that is a
 * discrepancy they will go looking for.
 */
export function amountDisagreesWords(
  movement: DetailMovement,
  expense: DetailExpense | null,
  money: (amount: number) => string,
): string | null {
  if (!expense || expense.amount === undefined) return null;
  if (movement.kind !== 'spend') return null;
  const moved = Math.abs(movement.amount);
  if (moved === expense.amount) return null;
  return `This movement took ${money(moved)} out of the box and the expense now says ${money(expense.amount)}. `
    + 'That is what a correction looks like: the original movement stays written and the difference is '
    + 'recorded as its own line, so the box’s history still adds up. Both lines are in the list.';
}

/**
 * Why there is nothing more to show, in the words of whoever clicked.
 *
 * Four different reasons, and they are not interchangeable. "No detail" on a
 * top-up is correct and unremarkable; on a spend it means a record has gone
 * missing, and those two must not read the same.
 */
export function noDetailWords(movement: DetailMovement, found: boolean): string | null {
  if (movement.kind === 'top_up') {
    return 'A top-up is money moved between two places the business already owns, so there is no expense and '
      + 'no receipt behind it.';
  }
  if (movement.kind === 'return') {
    return 'Money taken back out of the box and returned to where it came from. There is no expense behind it.';
  }
  if (movement.kind === 'adjust') {
    return 'This is what a count found — the difference between what the box held and what it should have '
      + 'held. It is filed against the count rather than against an expense.';
  }
  if (!movement.ref_id) {
    return 'This spend was recorded straight against the box, with no expense behind it, so there is nothing '
      + 'more on file and no receipt to attach. Record it as an expense to give it a category and a payee.';
  }
  if (!found) {
    return 'The expense this points at could not be found. It may have been deleted after the money left the '
      + 'box — the movement stays, which is why the box still adds up, but what it was for is no longer '
      + 'recorded anywhere.';
  }
  return null;
}
