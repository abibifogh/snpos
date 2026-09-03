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

/* -------------------------------------------------- a count left half done */

/**
 * Where a half-finished count is kept, and whose it is.
 *
 * Per shift and per phase, so counting in and counting out are two separate
 * pieces of work and neither can restore the other's numbers. The room is in
 * it too: a bar sheet and a store-room sheet are different shelves, and
 * pouring one into the other would be worse than losing both.
 *
 * Not per person, unlike an expense draft. A count belongs to the bar rather
 * than to whoever started it — the whole point of counting in and out is that
 * one person hands over to the next, and a bartender who takes over half way
 * should find the numbers already on the sheet rather than a blank one.
 */
export const countDraftKey = (shiftId: string, phase: string, locationId = ''): string =>
  `snpos.count.${shiftId || 'none'}.${phase}.${locationId}`;

/** What was typed against one shelf. */
export interface CountDraftLine {
  countedText?: string;
  note?: string;
}

/**
 * What was typed, by stock item.
 *
 * Text, not numbers, and deliberately: a half-typed "0." is not nought, and
 * turning it into one while somebody is still typing is how a shelf holding
 * twelve gets recorded as empty.
 *
 * Stamped with the time it was last touched, so the sheet can say what it is
 * offering back. "There are numbers here already" is a different message from
 * "these are the numbers you typed four minutes ago", and only one of them
 * tells somebody whether to trust them.
 */
export interface CountDraft {
  savedAt?: number;
  lines: Record<string, CountDraftLine>;
}

/**
 * How long a kept count is still the count somebody was taking.
 *
 * Three days. Long enough that no single walk of a store room outlives it —
 * they are done across an afternoon, not a fortnight — and short enough that a
 * draft nobody ever filed does not surface weeks later next to a shelf that
 * has been sold from a hundred times since.
 *
 * A bar's draft is keyed by shift and could not leak anyway. A store room's is
 * not, because a stocktake belongs to no shift, and that is the one this
 * protects.
 */
export const COUNT_DRAFT_GOOD_FOR_MS = 3 * 24 * 60 * 60 * 1000;

/** Anything typed at all. An empty draft is not worth keeping or announcing. */
export function countWorthKeeping(draft: CountDraft | null | undefined): boolean {
  if (!draft?.lines) return false;
  return Object.values(draft.lines).some(
    (l) => (l?.countedText ?? '').trim() !== '' || (l?.note ?? '').trim() !== '',
  );
}

/** How many shelves have something typed against them. */
export const countDraftLines = (draft: CountDraft | null | undefined): number =>
  Object.values(draft?.lines ?? {}).filter(
    (l) => (l?.countedText ?? '').trim() !== '' || (l?.note ?? '').trim() !== '',
  ).length;

export function saveCountDraft(store: DraftStore | null | undefined, key: string, draft: CountDraft): void {
  if (!store) return;
  try {
    if (countWorthKeeping(draft)) store.setItem(key, JSON.stringify(draft));
    else store.removeItem(key);
  } catch {
    // A count that cannot be kept is a count somebody types again. Refusing
    // to let them count at all would be the worse answer.
  }
}

export function readCountDraft(
  store: DraftStore | null | undefined,
  key: string,
  now = Date.now(),
): CountDraft | null {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    /*
      A draft written before the shape had a date on it is still somebody's
      count. Read rather than discarded: the version that introduced this could
      otherwise throw away the sheet of whoever happened to be half way through
      a count when it deployed, which is the exact fault it exists to prevent.
    */
    const record = parsed as Record<string, unknown>;
    const draft: CountDraft = Array.isArray(record.lines) || typeof record.lines !== 'object' || !record.lines
      ? { lines: record as Record<string, CountDraftLine> }
      : { savedAt: typeof record.savedAt === 'number' ? record.savedAt : undefined,
        lines: record.lines as Record<string, CountDraftLine> };

    if (!countWorthKeeping(draft)) return null;
    if (draft.savedAt && now - draft.savedAt > COUNT_DRAFT_GOOD_FOR_MS) return null;
    return draft;
  } catch {
    return null;
  }
}

/** "four minutes ago", for a sentence about work somebody left behind. */
export function sinceWords(ms: number): string {
  if (ms < 90_000) return 'a moment ago';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/**
 * What to say about numbers already on a sheet that was expected to be blank.
 *
 * They are either a relief or a warning, and which one depends on knowing whose
 * they are and how old. A count from four minutes ago is the one you were
 * taking; a count from yesterday morning is a shelf that has been sold from
 * since, and filing it unchecked would be worse than starting again.
 */
export function countRestoredWords(
  draft: CountDraft | null | undefined,
  now = Date.now(),
): string | null {
  const typed = countDraftLines(draft);
  if (typed === 0) return null;
  const when = draft?.savedAt ? ` ${sinceWords(now - draft.savedAt)}` : '';
  return `Picking up where this sheet was left: ${typed} ${typed === 1 ? 'line' : 'lines'} typed${when} `
    + 'and kept on this device. Check they still match the shelf before filing, or press "Clear all" to '
    + 'start again.';
}

/** Asked before wiping somebody's work, and it says exactly what goes. */
export function clearAllWarning(typed: number): string {
  return `Clear all ${typed} ${typed === 1 ? 'figure' : 'figures'} typed on this sheet and start again? `
    + 'Nothing that has already been filed is affected.';
}

/**
 * Put a saved draft back onto a freshly loaded sheet.
 *
 * The SHEET decides what is on it, never the draft: a bottle added to the bar
 * this morning has to appear, and one taken off has to go, whatever was typed
 * yesterday. So the lines come from the sheet and only the typing is restored.
 */
export function restoreCount<T extends { ingredientId: string; countedText?: string; note?: string }>(
  lines: T[],
  draft: CountDraft | null | undefined,
): T[] {
  if (!draft?.lines) return lines;
  return lines.map((l) => {
    const kept = draft.lines[l.ingredientId];
    if (!kept) return l;
    return {
      ...l,
      countedText: kept.countedText ?? l.countedText,
      note: kept.note ?? l.note,
    };
  });
}

/** The typing on a sheet, ready to be kept. */
export function draftFromCount(
  lines: { ingredientId: string; countedText?: string; note?: string }[],
  now = Date.now(),
): CountDraft {
  const out: CountDraft = { savedAt: now, lines: {} };
  for (const l of lines) {
    if ((l.countedText ?? '').trim() === '' && (l.note ?? '').trim() === '') continue;
    out.lines[l.ingredientId] = { countedText: l.countedText, note: l.note };
  }
  return out;
}

/** Done with, so it stops being offered back. */
export function clearCountDraft(store: DraftStore | null | undefined, key: string): void {
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    // A draft that will not clear reappears once and is typed over. Nothing
    // depends on it having gone.
  }
}
