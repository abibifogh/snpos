/**
 * Who somebody is, from an id, in words a screen can show.
 *
 * Four screens built the same map from the staff list and each fell back
 * differently: an id, "Unknown", a dash. A raw id on a screen is worse than
 * nothing, because it looks like data and somebody tries to make sense of
 * it; saying the profile is gone is the true answer.
 *
 * Pure. Imports nothing at runtime.
 */

export const GONE_STAFF = 'Somebody no longer on the staff list';

/** Ids to names, by profile id and by the user id the profile belongs to. */
export function nameBook(profiles: { $id: string; user_id?: string; display_name: string }[]): Map<string, string> {
  const book = new Map<string, string>();
  for (const p of profiles) {
    book.set(p.$id, p.display_name);
    if (p.user_id) book.set(p.user_id, p.display_name);
  }
  return book;
}

/**
 * The name, or the honest answer.
 *
 * An empty book is not the same as a missing profile: the list is fetched
 * after the first paint, and calling somebody gone because a read has not
 * landed yet would be a lie that corrects itself a second later.
 */
export function nameFrom(book: Map<string, string> | null | undefined, id: string | undefined | null, blank = '—'): string {
  if (!id) return blank;
  if (!book || book.size === 0) return '…';
  return book.get(id) ?? GONE_STAFF;
}
