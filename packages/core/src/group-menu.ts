import type { CartLine } from './pricing';

/**
 * The group menu's own headings.
 *
 * The ordinary menu is divided the way a kitchen's week is divided — "Everyday
 * offerings", "Monday special", "Tuesday special" — which is exactly right for
 * a walk-in, who can only be served what is being cooked today. It is no use
 * at all to somebody booking forty covers for a Tuesday three weeks out: they
 * are not shopping by day, they are counting wraps against the guests who
 * wanted wraps.
 *
 * So a dish can carry a heading used on the group menu and nowhere else, and
 * an owner can divide the group menu into Wraps, Sandwiches and Mains without
 * touching the categories the bistro runs on. A dish with no heading falls
 * under the category it already sits in, so this starts working the moment the
 * first heading is typed and never leaves a dish homeless.
 *
 * Pure. Imports nothing at runtime.
 */

/** Where a dish goes when nobody has given it a heading and it has no home. */
export const UNGROUPED = 'Everything else';

export interface Headed<T> {
  heading: string;
  entries: T[];
}

/**
 * Gather things under their headings, keeping the order they first appeared.
 *
 * First-seen rather than alphabetical, because the order dishes are listed in
 * is the owner's decision — they sorted the menu — and the alphabet would
 * throw that away and put Desserts before Mains.
 */
export function byHeading<T>(items: T[], headingOf: (item: T) => string): Headed<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const heading = (headingOf(item) || '').trim() || UNGROUPED;
    const list = groups.get(heading) ?? [];
    list.push(item);
    groups.set(heading, list);
  }
  return [...groups.entries()]
    .map(([heading, entries]) => ({ heading, entries }))
    // Only the catch-all is moved, and only to the end. Anything an owner
    // named keeps the place their menu order gave it.
    .sort((a, b) => Number(a.heading === UNGROUPED) - Number(b.heading === UNGROUPED));
}

/** How many portions are under one heading, for the count beside it. */
export const portionsIn = (group: Headed<CartLine>): number =>
  group.entries.reduce((n, l) => n + Math.max(0, l.qty), 0);

/* ------------------------------------------ keeping the headings tidy */

/**
 * The headings in use, and how many dishes are under each.
 *
 * A heading is not a record anywhere — it is a word typed on a dish, and the
 * set of them is whatever the dishes happen to say. That is what makes them
 * cheap to start using and what makes them drift: "Wraps" and "wraps" are two
 * headings, and a heading with a typo in it sits on the group menu until
 * somebody finds which dish carries it.
 *
 * So they are counted here and can be renamed as a set. Renaming is also how
 * two are merged, which is the fix for the typo: rename "wraps" to "Wraps"
 * and the dishes join the ones already there.
 */
export function headingsInUse(
  items: { group_heading?: string }[],
): { heading: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const i of items) {
    const h = (i.group_heading ?? '').trim();
    if (h) counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([heading, count]) => ({ heading, count }))
    .sort((a, b) => a.heading.localeCompare(b.heading));
}

/**
 * What is wrong with a heading somebody has typed, or null.
 *
 * Renaming to a heading that already exists is allowed and is the whole point
 * — it is how two are merged — so the only refusals are the ones that would
 * lose work or do nothing.
 */
export function headingProblem(name: string, from?: string): string | null {
  const trimmed = (name ?? '').trim();
  if (!trimmed) {
    return 'Give the heading a name. To take it off the dishes instead, use Remove.';
  }
  if (trimmed.length > 80) return 'That is too long for a heading. Keep it to a few words.';
  if (from !== undefined && trimmed === from.trim()) return 'That is the name it already has.';
  return null;
}

/** Which dishes a rename would touch. Matched exactly, spacing aside. */
export function itemsUnder<T extends { group_heading?: string }>(items: T[], heading: string): T[] {
  const want = (heading ?? '').trim();
  return items.filter((i) => (i.group_heading ?? '').trim() === want);
}

/** "9 dishes move to Wraps" — said before it happens, not after. */
export function renameWords(count: number, to: string): string {
  return `${count} dish${count === 1 ? '' : 'es'} will be listed under "${to.trim()}" on the group menu.`;
}
