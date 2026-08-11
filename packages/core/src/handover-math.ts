/**
 * Reading a set of handovers back.
 *
 * Split from `handover.ts` so the totals a manager is shown can be checked
 * without a database. Pure; parameters describe the fields they read.
 */

export interface HandoverLike {
  staff_id: string;
  staff_name?: string;
  amount: number;
  status?: 'recorded' | 'corrected';
}

export interface StaffCashLine<T = HandoverLike> {
  staffId: string;
  name: string;
  handedOver: number;
  entries: T[];
}

/**
 * What each person handed over, one line each.
 *
 * Corrected rows are kept in `entries` but left out of the total. Somebody
 * reading this wants one number per person; somebody querying that number wants
 * to see everything, including the entry that was wrong and the one that put it
 * right. Both are here rather than in two different screens.
 */
export function byStaff<T extends HandoverLike>(rows: T[]): StaffCashLine<T>[] {
  const lines = new Map<string, StaffCashLine<T>>();

  for (const r of rows) {
    const line: StaffCashLine<T> = lines.get(r.staff_id) ?? {
      staffId: r.staff_id,
      name: r.staff_name || 'Unknown',
      handedOver: 0,
      entries: [],
    };
    line.entries.push(r);
    if (r.status !== 'corrected') line.handedOver += r.amount;
    // A later row carries the more current spelling of somebody's name.
    if (r.staff_name) line.name = r.staff_name;
    lines.set(r.staff_id, line);
  }

  return [...lines.values()].sort((a, b) => b.handedOver - a.handedOver || a.name.localeCompare(b.name));
}

/** Everything handed over on a shift, ignoring corrected entries. */
export const totalHandedOver = (rows: HandoverLike[]): number =>
  rows.filter((r) => r.status !== 'corrected').reduce((sum, r) => sum + r.amount, 0);
