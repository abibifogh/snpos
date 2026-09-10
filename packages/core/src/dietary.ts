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

/* ------------------------------------------- what a dish can be made into */

/**
 * A dish that is nearly right for somebody.
 *
 * Red red is vegetarian but for the momoni in it, and a guest reading a menu
 * has no way to know that a kitchen would happily leave it out. They order
 * something else, or they ask and the answer depends on who is on. Either way
 * a dish that would have suited them did not get sold.
 *
 * So an ingredient can be marked as one that may be left out, and told what
 * the dish becomes without it. That single fact does all the work: the card
 * can say "vegetarian on request" before anybody opens it, the dish itself
 * offers one switch, and the filter at the top of the menu can count a dish
 * as vegetarian-if-asked without pretending it already is.
 *
 * Stored on the dish as JSON, like its availability, so this needs no table
 * of its own and a dish with nothing removable carries nothing at all.
 *
 * Pure. Imports nothing at runtime.
 */
export interface Omission {
  /** Stable id, so a choice survives the dish being reloaded. */
  key: string;
  /** What is left out, in the guest's words: 'momoni (salted fish)'. */
  name: string;
  /** What the dish becomes without it: dietary tag keys it then earns. */
  earns: string[];
  /**
   * The recipe line this is, where the dish has a recipe.
   *
   * Set means leaving it out should not take that ingredient off the shelf.
   * Absent means the omission is only words, which is right for a dish whose
   * stock is not tracked.
   */
  ingredientId?: string;
}

/** Settings and dishes keep the list as JSON text. Anything unreadable is none. */
export function parseOmissions(raw?: string | null): Omission[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((o): o is Omission => !!o && typeof o === 'object' && typeof (o as Omission).name === 'string')
      .map((o, i) => ({
        key: String(o.key || `o${i}`),
        name: String(o.name).trim(),
        earns: Array.isArray(o.earns) ? o.earns.map(String).filter(Boolean) : [],
        ingredientId: o.ingredientId ? String(o.ingredientId) : undefined,
      }))
      .filter((o) => o.name !== '');
  } catch {
    return [];
  }
}

export const serialiseOmissions = (list: Omission[]): string =>
  JSON.stringify(list
    .filter((o) => o.name.trim() !== '')
    .map((o) => ({
      key: o.key,
      name: o.name.trim(),
      earns: [...new Set(o.earns)],
      ...(o.ingredientId ? { ingredientId: o.ingredientId } : {}),
    })));

/**
 * The tags a dish would earn if everything removable were left out.
 *
 * Not what it IS — what it could be. Anything it already is stays out, so a
 * dish already tagged vegetarian does not also offer to become vegetarian.
 */
export function couldBe(tags: readonly string[] | undefined | null, omissions: Omission[]): string[] {
  const already = new Set((tags ?? []).map((t) => t.trim()).filter(Boolean));
  const earned = new Set<string>();
  for (const o of omissions) for (const t of o.earns) if (!already.has(t)) earned.add(t);
  return DIETARY_TAGS.filter((t) => earned.has(t.key)).map((t) => t.key);
}

/**
 * The tags a dish has once these omissions are actually chosen.
 *
 * A tag is earned only when EVERY omission that offers it has been taken. Two
 * things standing between a dish and "vegan" means leaving out one of them
 * does not make it vegan, and a menu that said otherwise would be worse than
 * one that said nothing.
 */
export function tagsWithout(
  tags: readonly string[] | undefined | null,
  omissions: Omission[],
  chosen: readonly string[],
): string[] {
  const taken = new Set(chosen);
  const has = new Set((tags ?? []).map((t) => t.trim()).filter(Boolean));
  const offered = new Set<string>();
  for (const o of omissions) for (const t of o.earns) offered.add(t);
  for (const tag of offered) {
    const needed = omissions.filter((o) => o.earns.includes(tag));
    if (needed.length > 0 && needed.every((o) => taken.has(o.key))) has.add(tag);
  }
  return [...has];
}

/** "Vegetarian on request", or nothing. The pill on the card. */
export function couldBeWords(tags: readonly string[] | undefined | null, omissions: Omission[]): string {
  const labels = dietaryLabels(couldBe(tags, omissions)).filter((t) => !t.caution);
  if (labels.length === 0) return '';
  return `${labels.map((t) => t.label).join(' or ')} on request`;
}

/**
 * "Leave out momoni. Makes it vegetarian." The line beside the switch.
 *
 * The name is used exactly as it was typed, with no "the" put in front of it.
 * An owner writing "the fish" is as likely as one writing "fish", and a
 * prepended article turns the first into "leave out the the fish". Their
 * words, their sentence.
 */
export function omissionWords(o: Omission): string {
  const labels = dietaryLabels(o.earns).filter((t) => !t.caution).map((t) => t.label.toLowerCase());
  const becomes = labels.length === 0
    ? ''
    : ` Makes it ${labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`}.`;
  return `Leave out ${o.name}.${becomes}`;
}

/**
 * Whether a dish belongs under a chip somebody has tapped.
 *
 * A dish that already is counts, and so does one that could be. The two are
 * told apart on screen rather than here, because a guest filtering to vegan
 * wants to see both and wants to know which is which.
 */
export function matchesDiet(
  tags: readonly string[] | undefined | null,
  omissions: Omission[],
  wanted: string,
): 'is' | 'could' | null {
  if (!wanted) return 'is';
  const has = new Set((tags ?? []).map((t) => t.trim()).filter(Boolean));
  if (has.has(wanted)) return 'is';
  return couldBe(tags, omissions).includes(wanted) ? 'could' : null;
}

/**
 * The chips worth showing at the top of a menu.
 *
 * Only the diets something on this menu actually satisfies, or could. A chip
 * for a diet no dish here meets sends a guest to an empty page, which reads
 * as "nothing for you" rather than "nothing today", and the cautions are left
 * out entirely: nobody filters a menu down to the things that are spicy.
 */
export function dietChips(
  dishes: { tags?: string[]; omissions: Omission[] }[],
): DietaryTag[] {
  const seen = new Set<string>();
  for (const d of dishes) {
    for (const t of d.tags ?? []) seen.add(t);
    for (const t of couldBe(d.tags, d.omissions)) seen.add(t);
  }
  return DIETARY_TAGS.filter((t) => !t.caution && seen.has(t.key));
}
