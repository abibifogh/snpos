/**
 * What a dish is safe for, said on the menu.
 *
 * A hotel booking a party of twelve does not know its guests. What it knows
 * is that somebody in the group is vegan, somebody cannot have gluten, and
 * that a platter ordered without checking is a platter sent back. So the
 * group menu says, on each dish, what it is: vegan, vegetarian, gluten free,
 * and the rest — chosen from one list, so "gluten free" is spelled one way on
 * every dish and can be searched for as one thing.
 *
 * Stored on the dish as `tags`, the keys below. The words shown are looked up
 * here, so renaming one is a change in one place and not a pass over every
 * dish in the database.
 *
 * Pure. Imports nothing at runtime.
 */

export interface DietaryTag {
  /** What is written on the dish: 'gluten_free'. Never shown. */
  key: string;
  /** What the guest reads: 'Gluten free'. */
  label: string;
  /**
   * A warning rather than a reassurance.
   *
   * "Contains nuts" and "spicy" are the opposite kind of statement from
   * "vegan": they tell somebody to stay away, not that they may come in. The
   * menu colours them differently for that reason.
   */
  caution?: boolean;
}

/**
 * The list an admin picks from.
 *
 * In the order a guest scanning for their own restriction expects: the diets
 * first, then the things left out, then the warnings.
 */
export const DIETARY_TAGS: readonly DietaryTag[] = [
  { key: 'vegetarian', label: 'Vegetarian' },
  { key: 'vegan', label: 'Vegan' },
  { key: 'pescatarian', label: 'Pescatarian' },
  { key: 'halal', label: 'Halal' },
  { key: 'gluten_free', label: 'Gluten free' },
  { key: 'dairy_free', label: 'Dairy free' },
  { key: 'nut_free', label: 'Nut free' },
  { key: 'contains_nuts', label: 'Contains nuts', caution: true },
  { key: 'contains_shellfish', label: 'Contains shellfish', caution: true },
  { key: 'spicy', label: 'Spicy', caution: true },
];

const byKey = new Map(DIETARY_TAGS.map((t) => [t.key, t]));

export const isDietaryTag = (key: string): boolean => byKey.has(key);

/**
 * The words for a dish's tags, in the list's order rather than the order
 * they were ticked.
 *
 * A tag this list does not know is kept and shown as it was written, with
 * underscores turned to spaces and a capital: a dish tagged somewhere else
 * must not lose what was said about it because the word is not one of ours.
 */
export function dietaryLabels(tags: readonly string[] | undefined | null): DietaryTag[] {
  if (!tags || tags.length === 0) return [];
  const wanted = new Set(tags.map((t) => t.trim()).filter(Boolean));
  const known = DIETARY_TAGS.filter((t) => wanted.has(t.key));
  const strange = [...wanted]
    .filter((k) => !byKey.has(k))
    .map((k) => ({ key: k, label: k.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) }));
  return [...known, ...strange];
}

/** "Vegan · Gluten free", or nothing. For a line under a dish, or an email. */
export const dietarySummary = (tags: readonly string[] | undefined | null): string =>
  dietaryLabels(tags).map((t) => t.label).join(' · ');

/**
 * Tick or untick one tag.
 *
 * Some pairs cannot both be true, and the pad does the obvious thing rather
 * than letting a dish be "nut free" and "contains nuts" at once: ticking one
 * unticks its opposite.
 */
const OPPOSITES: Record<string, string> = {
  nut_free: 'contains_nuts',
  contains_nuts: 'nut_free',
};

export function toggleDietaryTag(tags: readonly string[] | undefined | null, key: string): string[] {
  const current = (tags ?? []).filter(Boolean);
  if (current.includes(key)) return current.filter((t) => t !== key);
  const without = OPPOSITES[key] ? current.filter((t) => t !== OPPOSITES[key]) : current;
  // Kept in the list's order, so two admins ticking the same boxes in a
  // different order save the same row.
  const next = new Set([...without, key]);
  return [
    ...DIETARY_TAGS.map((t) => t.key).filter((k) => next.has(k)),
    ...[...next].filter((k) => !byKey.has(k)),
  ];
}
