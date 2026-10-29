import { db, DB_ID, Query, listAll, listByIds, saveDropping } from './client';
import type { CountDraftLine } from './expense-draft';

/**
 * The database half of the shop's shift count. The rules are in shop-count.ts.
 */

/**
 * What left a shelf or arrived on one since this shift opened.
 *
 * Sold: every line on this shift's orders that was not voided. Arrived: a
 * piece added to the shop since the shift opened, which is how a delivery
 * reaches the shelf. Keyed `menuItemId:variantId`, the same key the sheet
 * uses. A read that fails gives an empty set, so the count still opens; the
 * other two parts still ask for something.
 */
export async function movedThisShift(shiftId: string): Promise<Set<string>> {
  const moved = new Set<string>();
  if (!shiftId) return moved;
  try {
    const orders = await listAll<{ $id: string }>('orders', [Query.equal('shift_id', shiftId)]);
    const items = await listByIds<{ menu_item_id: string; variant_id?: string; status?: string }>(
      'order_items', 'order_id', orders.map((o) => o.$id),
    );
    for (const i of items) if (i.status !== 'void') moved.add(`${i.menu_item_id}:${i.variant_id ?? ''}`);

    const shift = await db.getDocument(DB_ID, 'shifts', shiftId).catch(() => null) as { opened_at?: string } | null;
    if (shift?.opened_at) {
      const added = await listAll<{ $id: string }>('menu_items', [
        Query.equal('module', 'craft'), Query.greaterThanEqual('$createdAt', shift.opened_at),
      ]).catch(() => [] as { $id: string }[]);
      const ids = new Set(added.map((a) => a.$id));
      const sizes = ids.size
        ? await listByIds<{ $id: string; menu_item_id: string }>('product_variants', 'menu_item_id', [...ids]).catch(() => [])
        : [];
      for (const id of ids) moved.add(`${id}:`);
      for (const v of sizes) moved.add(`${v.menu_item_id}:${v.$id}`);
    }
  } catch {
    // An empty set, not a failed count: see above.
  }
  return moved;
}

/** One count in progress, as kept on the server. */
export interface ServerCountDraft {
  lines: Record<string, CountDraftLine>;
  done: number;
  total: number;
  savedByName: string;
  savedAt: string;
}

/** One draft per shift and end. Appwrite ids are at most 36 characters. */
export const countDraftId = (shiftId: string, phase: 'open' | 'close'): string =>
  `${shiftId}-${phase}`.slice(0, 36);

/** The count in progress for this shift and end, or null. Never throws. */
export async function loadServerDraft(shiftId: string, phase: 'open' | 'close'): Promise<ServerCountDraft | null> {
  if (!shiftId) return null;
  try {
    const d = await db.getDocument(DB_ID, 'count_drafts', countDraftId(shiftId, phase)) as unknown as {
      lines?: string; done?: number; total?: number; saved_by_name?: string; saved_at?: string; $updatedAt?: string;
    };
    let lines: Record<string, CountDraftLine> = {};
    try {
      const v = JSON.parse(d.lines || '{}');
      if (v && typeof v === 'object' && !Array.isArray(v)) lines = v;
    } catch { /* an unreadable draft is an empty one */ }
    return {
      lines,
      done: d.done ?? 0,
      total: d.total ?? 0,
      savedByName: d.saved_by_name ?? '',
      savedAt: d.saved_at || d.$updatedAt || '',
    };
  } catch {
    return null;
  }
}

/**
 * Keep the count as it stands. Written over the last one, created the first
 * time. Returns whether it landed, so the screen can say "saved" honestly.
 */
export async function saveServerDraft(input: {
  venueId: string;
  shiftId: string;
  phase: 'open' | 'close';
  lines: Record<string, CountDraftLine>;
  done: number;
  total: number;
  userId: string;
  userName?: string;
}): Promise<boolean> {
  if (!input.shiftId) return false;
  const id = countDraftId(input.shiftId, input.phase);
  const body = {
    venue_id: input.venueId,
    side: 'craft',
    shift_id: input.shiftId,
    phase: input.phase,
    lines: JSON.stringify(input.lines),
    done: input.done,
    total: input.total,
    saved_by: input.userId,
    saved_by_name: input.userName ?? '',
    saved_at: new Date().toISOString(),
  };
  try {
    await saveDropping('count_drafts', id, body);
    return true;
  } catch {
    // Not there yet, the first time: create it. If that is refused too (it
    // exists and the update failed for another reason), say it did not land.
    try {
      await db.createDocument(DB_ID, 'count_drafts', id, body);
      return true;
    } catch {
      return false;
    }
  }
}

/** The count has been filed: the draft has done its job. Never throws. */
export async function clearServerDraft(shiftId: string, phase: 'open' | 'close'): Promise<void> {
  if (!shiftId) return;
  await db.deleteDocument(DB_ID, 'count_drafts', countDraftId(shiftId, phase)).catch(() => undefined);
}
