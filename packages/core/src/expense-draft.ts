/**
 * What somebody had typed into the spend form when they walked away from it.
 *
 * A cook recording a market run is interrupted constantly — an order lands and
 * has to be accepted, the pass needs looking at, somebody wants a receipt. The
 * form was a modal, and leaving it threw away the amount, the payee, the note
 * and every line already entered. So the honest options were "finish this now"
 * or "lose it", and what people actually do when handed those two is stop
 * recording expenses. A drawer short by a taxi fare nobody wrote down is the
 * predictable end of it.
 *
 * Kept on the device rather than in the database, deliberately. This is an
 * unfinished thought, not a record: half an expense written to `shift_expenses`
 * would appear on the shift's spending, get counted against the drawer, and
 * reach the books — all before anybody decided it was real. The moment it is
 * real it is saved properly and the draft is thrown away.
 *
 * Pure. The storage itself is passed in, so the rules about what is worth
 * keeping and which shift a draft belongs to can be tested without a browser.
 */

export interface ExpenseDraft {
  categoryKey?: string;
  methodId?: string;
  amountText?: string;
  paidToKind?: string;
  supplierId?: string;
  staffId?: string;
  payee?: string;
  noteText?: string;
  fromDrawer?: boolean;
  lines?: { ingredientId: string; qtyText: string; totalText: string }[];
}

/**
 * Which draft belongs to whom.
 *
 * Scoped to the shift AND the person. Two cooks share a kitchen screen, and a
 * draft that survived a handover would put one person's half-typed market run
 * in front of the next person to open the form — who would either save
 * somebody else's figures or, more likely, clear it and learn not to trust the
 * feature.
 *
 * The shift is in the key for the same reason: a draft left over from last
 * night belongs to a drawer that has already been counted.
 */
export const expenseDraftKey = (venueId: string, shiftId: string, userId: string): string =>
  `snpos.expense-draft.${venueId}.${shiftId || 'none'}.${userId || 'anon'}`;

/**
 * Is there anything here worth keeping?
 *
 * A form somebody opened and closed without typing is not a draft, and
 * restoring one would put "Picked up where you left off" in front of somebody
 * who left nothing off — which teaches them the message means nothing.
 *
 * The category and the payment method are excluded on purpose: both are filled
 * in for you when the form opens, so counting them would make every untouched
 * form look like unfinished work.
 */
export function draftWorthKeeping(draft: ExpenseDraft | null | undefined): boolean {
  if (!draft) return false;
  if ((draft.amountText ?? '').trim() !== '') return true;
  if ((draft.payee ?? '').trim() !== '') return true;
  if ((draft.noteText ?? '').trim() !== '') return true;
  if ((draft.supplierId ?? '') !== '') return true;
  if ((draft.staffId ?? '') !== '') return true;
  return (draft.lines ?? []).some(
    (l) => l.ingredientId !== '' || l.qtyText.trim() !== '' || l.totalText.trim() !== '',
  );
}

/** Somewhere to put a draft. `localStorage` satisfies this; so does a stub. */
export interface DraftStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Keep it, or clear it when there is nothing to keep.
 *
 * Never throws. Storage is full, or private browsing has switched it off, or
 * the device is being awkward — none of which is a reason to stop somebody
 * recording money that left the till.
 */
export function saveExpenseDraft(store: DraftStore | null | undefined, key: string, draft: ExpenseDraft): void {
  if (!store) return;
  try {
    if (draftWorthKeeping(draft)) store.setItem(key, JSON.stringify(draft));
    else store.removeItem(key);
  } catch {
    // Losing a draft is a nuisance; refusing to record the spend is worse.
  }
}

export function readExpenseDraft(store: DraftStore | null | undefined, key: string): ExpenseDraft | null {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const draft = parsed as ExpenseDraft;
    // A stored draft with nothing in it is the same as no draft. It should not
    // happen — saving clears instead — but a half-written value from an older
    // version must not announce itself as recovered work.
    return draftWorthKeeping(draft) ? draft : null;
  } catch {
    return null;
  }
}

export function clearExpenseDraft(store: DraftStore | null | undefined, key: string): void {
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    // Nothing to do about it, and nothing that depends on it.
  }
}
