import { listAll, listByIds } from './client';
import { nameBook, namesByBothIds } from './staff-words';
import type { StaffProfile } from './types';

/** Every staff member's name, by id. Fails soft to an empty book. */
export const loadStaffNames = async (): Promise<Map<string, string>> =>
  nameBook(await listAll<StaffProfile>('staff_profiles').catch(() => [] as StaffProfile[]));

/**
 * The names for a handful of ids, whichever kind of id they are.
 *
 * A person is two ids in this database: the staff profile document, and the
 * login it belongs to. Records written by a screen carry `created_by` as the
 * LOGIN's id, while anything pointing at a colleague — who a payout went to,
 * who approved something — carries the PROFILE's. Both turn up in the same
 * row.
 *
 * A panel that asked `staff_profiles` for one of them by document id got
 * nothing back for every record ever written by a member of staff, and said
 * so in the worst possible words: "Somebody no longer on the staff list",
 * about people still working there. Reported, reasonably, as staff having
 * vanished from the system.
 *
 * So both columns are asked, and the answer is keyed under both ids, which is
 * what nameBook has always done for the screens that load the whole list.
 * Failing soft: a panel with a name missing is better than a panel that will
 * not open.
 */
export async function staffNamesByIds(ids: (string | undefined | null)[]): Promise<Record<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (want.length === 0) return {};

  const [byDoc, byLogin] = await Promise.all([
    listByIds<StaffProfile>('staff_profiles', '$id', want).catch(() => [] as StaffProfile[]),
    listByIds<StaffProfile>('staff_profiles', 'user_id', want).catch(() => [] as StaffProfile[]),
  ]);

  return namesByBothIds([...byDoc, ...byLogin]);
}
