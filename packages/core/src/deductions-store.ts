import { Query, listAll, listByIds } from './client';
import { pendingBarChecks } from './stock';
import { loadSellingPrices } from './staff-charges-store';
import { isStoreCount } from './bar-count';
import type { WaitingCount } from './deductions-report';

/**
 * Bar counts that found a shortage nobody has approved, each put against
 * whoever answers for it: the shift closing for a closing count, the bar shift
 * before it for an opening count. The same rule a count charge follows; see
 * count-charges.ts. Priced at selling price, falling back to cost where
 * nothing on the menu sells the item alone.
 */
export async function loadWaitingCounts(): Promise<WaitingCount[]> {
  const lines = (await pendingBarChecks())
    .filter((l) => (l.module ?? 'bar') === 'bar' && l.shift_id && !isStoreCount(l.shift_id) && Number(l.variance_qty ?? 0) !== 0);
  if (lines.length === 0) return [];

  type ShiftRow = { $id: string; opened_by?: string; opened_at?: string; module?: string };
  type Person = { $id: string; user_id?: string; display_name?: string };
  type Ing = { $id: string; name?: string; base_unit_cost?: number };
  const shiftIds = [...new Set(lines.map((l) => l.shift_id as string))];
  const ingIds = [...new Set(lines.map((l) => l.ingredient_id))];
  const [shifts, people, ings, prices] = await Promise.all([
    listByIds<ShiftRow>('shifts', '$id', shiftIds),
    listAll<Person>('staff_profiles'),
    listByIds<Ing>('ingredients', '$id', ingIds),
    loadSellingPrices(ingIds).catch(() => ({} as Record<string, { price: number }>)),
  ]);
  // Bar shifts from a little before the earliest, so an opening count can find the one before it.
  const earliest = shifts.map((s) => s.opened_at ?? '').filter(Boolean).sort()[0] ?? '';
  const since = earliest ? new Date(new Date(earliest).getTime() - 7 * 86_400_000).toISOString() : '';
  const barShifts = since
    ? await listAll<ShiftRow>('shifts', [Query.equal('module', 'bar'), Query.greaterThanEqual('opened_at', since)]).catch(() => [] as ShiftRow[])
    : [];
  const personFor = (who?: string) => people.find((p) => p.user_id === who || p.$id === who);

  const groups = new Map<string, typeof lines>();
  for (const l of lines) {
    const key = `${l.shift_id}|${l.phase ?? 'close'}`;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const out: WaitingCount[] = [];
  for (const [key, rows] of groups) {
    const [shiftId, phaseRaw] = key.split('|');
    const phase = phaseRaw === 'open' ? 'open' : 'close';
    const shift = shifts.find((s) => s.$id === shiftId);
    const answerable = phase === 'close' ? shift : barShifts
      .filter((s) => shift?.opened_at && (s.opened_at ?? '') < shift.opened_at && s.$id !== shiftId)
      .sort((a, b) => (b.opened_at ?? '').localeCompare(a.opened_at ?? ''))[0];
    const person = personFor(answerable?.opened_by);
    out.push({
      personId: person?.$id ?? '',
      name: person?.display_name ?? 'Nobody on record',
      at: rows.map((r) => r.$createdAt ?? '').sort()[0] ?? '',
      phase,
      lines: rows.map((r) => {
        const ing = ings.find((i) => i.$id === r.ingredient_id);
        return {
          name: ing?.name ?? 'An item',
          variance: Number(r.variance_qty ?? 0),
          price: prices[r.ingredient_id]?.price ?? Math.round(ing?.base_unit_cost ?? 0),
        };
      }),
    });
  }
  return out;
}
