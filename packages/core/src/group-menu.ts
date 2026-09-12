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
