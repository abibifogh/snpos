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
 * can say "open to make it vegetarian" before anybody opens it, the dish itself
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

/**
 * What is stopping these being saved, in the owner's words.
 *
 * `serialiseOmissions` drops a row with no name, and it has to — a switch on
 * the customer's menu labelled "Leave out ." is worse than no switch. But
 * dropping it in silence is how somebody ticks "makes it vegetarian", presses
 * save, sees the form close happily, and finds nothing has changed. They then
 * report, correctly, that the feature does not work.
 *
 * So the row is refused instead, and named.
 */
export function omissionProblem(list: Omission[]): string | null {
  const blank = list.find((o) => !o.name.trim());
  if (blank) {
    return blank.earns.length > 0
      ? `Say what can be left out to make this ${dietaryLabels(blank.earns)[0]?.label.toLowerCase() ?? 'suitable'}`
        + ' — the guest needs to read what they are asking for.'
      : 'One of the things that can be left out has no name. Give it one, or remove the row.';
  }
  const useless = list.find((o) => o.earns.length === 0);
  if (useless) {
    return `Tick what the dish becomes without ${useless.name.trim()}. `
      + 'Left blank it is a switch that changes nothing a guest can see.';
  }
  return null;
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

/**
 * "Open to make it vegan", or nothing. The pill on the card.
 *
 * It said "Vegan on request", which is what a menu printed on paper says and
 * is wrong on a screen. "On request" tells a guest to ask somebody — so they
 * looked for a box to type it in, or waited to tell a waiter who was never
 * coming, when the thing they had to do was tap the dish and turn a switch on.
 *
 * So it names the action instead of describing the outcome: open it, and the
 * switch is in there.
 */
export function couldBeWords(tags: readonly string[] | undefined | null, omissions: Omission[]): string {
  const labels = dietaryLabels(couldBe(tags, omissions)).filter((t) => !t.caution);
  if (labels.length === 0) return '';
  return `Open to make it ${labels.map((t) => t.label.toLowerCase()).join(' or ')}`;
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

/* ------------------------------- what a choice does to what a dish is */

/**
 * A dish is only as suitable as the last thing added to it.
 *
 * A vegan bowl with cheese on it is not a vegan bowl, and until now the menu
 * would have gone on saying vegan the whole way to the pass. The dish's tags
 * describe the dish as listed; the moment somebody ticks an option, the plate
 * is a different plate.
 *
 * So an option carries the same tags a dish does — what IT is — and a chosen
 * one can only take tags away. Nothing an option says can add a diet: cheese
 * marked vegetarian does not make a beef stew vegetarian, and the intersection
 * is the only honest arithmetic here.
 *
 * Cautions run the other way and are added, not intersected. "Contains nuts"
 * on a satay sauce is true of any plate it goes on, whatever the plate was
 * before.
 */
export interface OptionDiet {
  /** Named in the warning, so the guest knows which choice is in question. */
  name: string;
  tags?: string[];
  /**
   * This choice is not food.
   *
   * "Extra napkin", "no ice", "well done". Ticking every dietary box on one of
   * those would be a lie by a different route, and leaving them all unticked
   * would strip a dish of everything it is. So they are marked as changing
   * nothing, and change nothing.
   */
  diet_neutral?: boolean;
}

const isCaution = (key: string): boolean => !!byKey.get(key)?.caution;

/**
 * Has anybody actually judged this option?
 *
 * An option with no tags and no neutral mark has never been looked at, and
 * every option in an existing menu is in that state. Treating "not assessed"
 * as "meets nothing" would empty every dish of every claim the first time a
 * guest ticked anything — so it strips nothing, and is reported instead, to
 * be said out loud where it matters and listed in Admin so it can be fixed.
 */
export const dietAssessed = (o: OptionDiet): boolean =>
  !!o.diet_neutral || (o.tags ?? []).some((t) => !isCaution(t));

/**
 * What the plate is, once these options are on it.
 *
 * `unknown` names the chosen options nobody has judged yet. They leave the
 * tags alone, because guessing in either direction is worse: guessing "safe"
 * risks somebody's health, and guessing "unsafe" would empty a menu that is
 * perfectly correct until the day its owner gets round to the options.
 */
export function tagsWithOptions(
  tags: readonly string[] | undefined | null,
  options: OptionDiet[],
): { tags: string[]; unknown: string[] } {
  let diets = (tags ?? []).map((t) => t.trim()).filter(Boolean).filter((t) => !isCaution(t));
  const cautions = new Set((tags ?? []).map((t) => t.trim()).filter(Boolean).filter(isCaution));
  const unknown: string[] = [];

  for (const o of options) {
    if (o.diet_neutral) continue;
    if (!dietAssessed(o)) { unknown.push(o.name); continue; }
    const its = new Set((o.tags ?? []).map((t) => t.trim()).filter(Boolean));
    // Only what BOTH are. A choice can never add a diet to a dish.
    diets = diets.filter((t) => its.has(t));
    for (const t of its) if (isCaution(t)) cautions.add(t);
  }

  const all = new Set([...diets, ...cautions]);
  return {
    tags: [
      ...DIETARY_TAGS.map((t) => t.key).filter((k) => all.has(k)),
      ...[...all].filter((k) => !byKey.has(k)),
    ],
    unknown,
  };
}

/**
 * What a choice has cost the dish, in the guest's words.
 *
 * Said at the moment of choosing rather than discovered at the table. A vegan
 * who ticks an option and watches the word "Vegan" disappear has been told
 * something; one who does not notice has been misled by a screen that knew.
 */
export function dietLostWords(before: readonly string[], after: readonly string[]): string {
  const had = new Set(after);
  const lost = dietaryLabels(before.filter((t) => !had.has(t))).filter((t) => !t.caution);
  if (lost.length === 0) return '';
  const words = lost.map((t) => t.label.toLowerCase());
  const said = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
  return `With what you have chosen, this is no longer ${said}.`;
}

/** "We cannot say whether Extra cheese is vegan." The honest gap. */
export function dietUnknownWords(unknown: readonly string[]): string {
  if (unknown.length === 0) return '';
  const list = unknown.length === 1
    ? unknown[0]
    : `${unknown.slice(0, -1).join(', ')} and ${unknown[unknown.length - 1]}`;
  return `We have not recorded what ${list} ${unknown.length === 1 ? 'is' : 'are'} suitable for. `
    + 'Please ask a member of staff if it matters.';
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

/* =========================== checking a menu against itself =========== */

/**
 * Checking a menu's dietary tags against itself.
 *
 * These tags are the one thing on the system that can put somebody in
 * hospital. Everything else is money, and money can be corrected the next
 * morning. A dish wrongly marked nut free is read by somebody who is trusting
 * it, and they will not check twice.
 *
 * Nobody can tell from the outside whether "Red red is pescatarian" is true —
 * that is the kitchen's knowledge and this system has no way to taste the
 * food. What CAN be checked is whether the menu contradicts itself, and that
 * catches a surprising amount: a tag that implies another and stands alone, a
 * pair that cannot both be true, the same dish tagged two ways in two places,
 * a dish on the group menu with nothing said about it at all, and a choice
 * that silently strips a claim off a plate.
 *
 * Every finding names the dish and says what to do. None of them guesses at
 * what the food actually contains.
 *
 * Pure. Imports nothing at runtime, like the rest of this file.
 */

/**
 * A tag that is true necessarily makes another true.
 *
 * These are claims about who a dish SUITS, not about what is in it. A vegan
 * dish suits a vegetarian and it suits a pescatarian, because both of those
 * people eat everything a vegan eats and more. A dish marked vegan and not
 * vegetarian is not wrong about the food — it is missing from the vegetarian
 * filter, so a guest who needs it never sees it.
 */
export const DIET_IMPLIES: Record<string, string[]> = {
  vegan: ['vegetarian', 'pescatarian', 'dairy_free'],
  vegetarian: ['pescatarian'],
};

/** Two things that cannot both be true of one plate. */
export const DIET_EXCLUDES: [string, string][] = [
  ['nut_free', 'contains_nuts'],
  ['vegan', 'contains_shellfish'],
  ['vegetarian', 'contains_shellfish'],
];

export type DietFindingKind =
  | 'contradiction'
  | 'implied'
  | 'untagged'
  | 'disagrees'
  | 'option-unassessed'
  | 'option-strips';

export interface DietFinding {
  kind: DietFindingKind;
  /** Worst first: a contradiction is wrong, a gap is only incomplete. */
  severity: 'wrong' | 'gap';
  /** The dish, named as the guest sees it. */
  dish: string;
  itemId: string;
  says: string;
  /** What to do about it, in the owner's words. */
  fix: string;
}

const label = (key: string): string => dietaryLabels([key])[0]?.label ?? key;
const clean = (tags?: string[]): string[] => (tags ?? []).map((t) => t.trim()).filter(Boolean);

export interface ReviewDish {
  $id: string;
  name: string;
  tags?: string[];
  group_only?: boolean;
  group_heading?: string;
}

/** What one dish's own tags say about each other. */
export function reviewDish(dish: ReviewDish): DietFinding[] {
  const out: DietFinding[] = [];
  const has = new Set(clean(dish.tags));
  const at = { dish: dish.name, itemId: dish.$id };

  for (const [a, b] of DIET_EXCLUDES) {
    if (has.has(a) && has.has(b)) {
      out.push({
        ...at,
        kind: 'contradiction',
        severity: 'wrong',
        says: `Marked both ${label(a).toLowerCase()} and ${label(b).toLowerCase()}.`,
        fix: 'Both cannot be true. Untick whichever is wrong — a guest is reading one of them.',
      });
    }
  }

  for (const [tag, implied] of Object.entries(DIET_IMPLIES)) {
    if (!has.has(tag)) continue;
    for (const need of implied) {
      if (has.has(need)) continue;
      out.push({
        ...at,
        kind: 'implied',
        severity: 'gap',
        says: `Marked ${label(tag).toLowerCase()} but not ${label(need).toLowerCase()}.`,
        fix: `Anything ${label(tag).toLowerCase()} is also ${label(need).toLowerCase()}. `
          + `Without it this dish is missing from the ${label(need).toLowerCase()} filter, `
          + 'so the guests who need it never see it.',
      });
    }
  }

  if (has.size === 0) {
    out.push({
      ...at,
      kind: 'untagged',
      severity: 'gap',
      says: 'Nothing is said about what this suits.',
      fix: 'A party booking for guests they have never met reads the tags and orders round them. '
        + 'A dish with none is a dish they will not risk.',
    });
  }

  return out;
}

/**
 * The same dish, tagged two ways.
 *
 * Not a duplicate-name check for its own sake: a menu may sell "Fries" at the
 * bar and in the bistro quite deliberately. What matters is that the two rows
 * disagree about who the food suits, because then the answer a guest gets
 * depends on which one they happened to tap.
 */
export function reviewAgreement(dishes: ReviewDish[]): DietFinding[] {
  const byName = new Map<string, ReviewDish[]>();
  for (const d of dishes) {
    const key = d.name.trim().toLowerCase();
    if (!key) continue;
    byName.set(key, [...(byName.get(key) ?? []), d]);
  }

  const out: DietFinding[] = [];
  for (const [, group] of byName) {
    if (group.length < 2) continue;
    const shape = (d: ReviewDish) => [...clean(d.tags)].sort().join('|');
    const first = shape(group[0]);
    if (group.every((d) => shape(d) === first)) continue;
    for (const d of group) {
      out.push({
        dish: d.name,
        itemId: d.$id,
        kind: 'disagrees',
        severity: 'wrong',
        says: `"${d.name}" appears ${group.length} times with different dietary tags.`,
        fix: 'Whichever a guest taps is the answer they get. Make them agree, or give them different names.',
      });
    }
  }
  return out;
}

/**
 * Choices that can quietly take a claim off a plate.
 *
 * The hardest of these to spot by reading the menu, because the dish is
 * correctly tagged and the option is correctly tagged and the fault only
 * exists when somebody ticks the box. An option nobody has judged is worse
 * again: it takes nothing away by design — see dietAssessed — so a vegan bowl
 * with unjudged cheese on it still says vegan.
 */
export function reviewOptions(
  dishes: ReviewDish[],
  optionsFor: (itemId: string) => OptionDiet[],
): DietFinding[] {
  const out: DietFinding[] = [];
  for (const d of dishes) {
    const claims = clean(d.tags).filter((t) => !dietaryLabels([t])[0]?.caution);
    if (claims.length === 0) continue;

    const options = optionsFor(d.$id);
    const unjudged = options.filter((o) => !dietAssessed(o)).map((o) => o.name);
    if (unjudged.length > 0) {
      out.push({
        dish: d.name,
        itemId: d.$id,
        kind: 'option-unassessed',
        severity: 'wrong',
        says: `${unjudged.length} choice${unjudged.length === 1 ? '' : 's'} on this dish `
          + `${unjudged.length === 1 ? 'has' : 'have'} nothing said about them: ${unjudged.join(', ')}.`,
        fix: 'Until they are judged they take nothing away, so this dish goes on claiming '
          + `${dietaryLabels(claims).map((t) => t.label.toLowerCase()).join(', ')} with them on it. `
          + 'Set them under Options, or mark them as not food.',
      });
      continue;
    }

    const strips = options.filter((o) => {
      if (o.diet_neutral) return false;
      const its = new Set(clean(o.tags));
      return claims.some((c) => !its.has(c));
    });
    if (strips.length > 0) {
      out.push({
        dish: d.name,
        itemId: d.$id,
        kind: 'option-strips',
        severity: 'gap',
        says: `${strips.map((o) => o.name).join(', ')} will take a dietary claim off this dish when chosen.`,
        fix: 'Nothing to fix if that is right — the menu says so as it is ticked. Listed so you can check it is.',
      });
    }
  }
  return out;
}

/** Worst first, then by dish, so a list is read from the top and acted on. */
export function worstDietFirst(findings: DietFinding[]): DietFinding[] {
  const rank = (f: DietFinding) => (f.severity === 'wrong' ? 0 : 1);
  return [...findings].sort((a, b) => rank(a) - rank(b) || a.dish.localeCompare(b.dish));
}

/** The whole review, in the order it should be read. */
export function reviewMenu(
  dishes: ReviewDish[],
  optionsFor: (itemId: string) => OptionDiet[] = () => [],
): DietFinding[] {
  return worstDietFirst([
    ...dishes.flatMap(reviewDish),
    ...reviewAgreement(dishes),
    ...reviewOptions(dishes, optionsFor),
  ]);
}

/** "3 wrong, 6 worth a look" — the headline above the list. */
export function reviewSummary(findings: DietFinding[], checked: number): string {
  if (checked === 0) return 'No dishes to check.';
  if (findings.length === 0) {
    return `All ${checked} dish${checked === 1 ? '' : 'es'} checked. Nothing contradicts itself.`;
  }
  const wrong = findings.filter((f) => f.severity === 'wrong').length;
  const gaps = findings.length - wrong;
  const parts = [
    wrong > 0 ? `${wrong} to put right` : '',
    gaps > 0 ? `${gaps} worth a look` : '',
  ].filter(Boolean);
  return `${checked} dish${checked === 1 ? '' : 'es'} checked: ${parts.join(', ')}.`;
}

/** Every diet a menu claims anywhere, for a coverage count. */
export function dietsClaimed(dishes: ReviewDish[]): { key: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const d of dishes) for (const t of clean(d.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return DIETARY_TAGS.filter((t) => counts.has(t.key))
    .map((t) => ({ key: t.key, label: t.label, count: counts.get(t.key) ?? 0 }));
}
