/**
 * Whether a dish can go straight into the basket, or has to be asked about.
 *
 * There is an Add button on every row of the menu now, which is what anybody
 * ordering twelve of the same wrap wants. But some dishes cannot be added
 * without a decision — a size, a protein, a side that the kitchen needs told
 * — and adding one of those silently would send the pass a ticket with a hole
 * in it.
 *
 * So the same rule decides two things: whether Add adds, and whether the
 * sheet will let you press its own Add. Written once here because two copies
 * of it would disagree the first time somebody changed a group from optional
 * to required, and the disagreement would be a ticket the kitchen cannot cook
 * rather than an error anybody sees.
 *
 * Pure. Imports nothing at runtime.
 */

export interface ChoiceGroup {
  $id: string;
  name: string;
  required: boolean;
  min_select: number;
}

export interface ChoiceOption {
  $id: string;
  default_selected?: boolean;
}

export type ChoiceSet = { group: ChoiceGroup; options: ChoiceOption[] }[];

/**
 * The choices this menu is allowed to offer.
 *
 * Some options only make sense for a party ordering days ahead: a platter
 * size, a chafing dish, rice by the tray, a whole fish for the table. Put
 * those in front of a walk-in and you get a ticket the kitchen cannot cook in
 * the ten minutes somebody is standing at the counter. Others run the other
 * way — a group buying forty covers can have a choice the à la carte menu
 * does not carry at all.
 *
 * So an option can be marked for the group menu, and this is the one place
 * that decides whether it is shown. Everything downstream reads the filtered
 * set — what the sheet offers, what Add sends straight through, what counts
 * as an unanswered question — so there is no way for the menu to show a
 * choice the basket would then reject, or to demand one it never displayed.
 *
 * A GROUP LEFT WITH NOTHING IN IT GOES TOO, and that is the part worth being
 * careful about. "Choose a platter size" with every size hidden is not an
 * empty list, it is a required question with no possible answer: the sheet
 * would refuse to add the dish and give a reason nobody can act on. An
 * invisible group asks nothing.
 *
 * Pure, like the rest of this file.
 */
export function choicesWhere<G extends ChoiceGroup, O extends ChoiceOption & { group_only?: boolean }>(
  groups: { group: G; options: O[] }[],
  where: { group: boolean },
): { group: G; options: O[] }[] {
  if (where.group) return groups;
  return groups
    .map(({ group, options }) => ({ group, options: options.filter((o) => !o.group_only) }))
    .filter(({ options }) => options.length > 0);
}

/**
 * What a dish arrives with before anybody touches it.
 *
 * The options marked as the usual answer. A dish whose one required choice
 * has a default is already answered, and making somebody open a sheet to
 * agree with it is a tap spent on nothing.
 */
export function defaultPicks(groups: ChoiceSet): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const { group, options } of groups) {
    out[group.$id] = options.filter((o) => o.default_selected).map((o) => o.$id);
  }
  return out;
}

/**
 * The first choice that has not been made properly, named as the guest sees it.
 *
 * Two rules, and they are different. A REQUIRED group must be answered at
 * all. An optional group with a minimum is "if you are having any, have at
 * least this many" — untouched is fine, half-answered is not, which is how a
 * "pick 2 sides" group ends up on a ticket with one.
 */
export function unmetChoice(groups: ChoiceSet, chosen: Record<string, string[]>): string | null {
  for (const { group } of groups) {
    const picked = (chosen[group.$id] ?? []).length;
    if (group.required && picked < Math.max(1, group.min_select)) return group.name;
    if (!group.required && group.min_select > 0 && picked > 0 && picked < group.min_select) return group.name;
  }
  return null;
}

/** What to say about it, in the guest's words rather than the database's. */
export function unmetChoiceWords(groups: ChoiceSet, chosen: Record<string, string[]>): string | null {
  const name = unmetChoice(groups, chosen);
  if (!name) return null;
  const group = groups.find((g) => g.group.name === name)?.group;
  if (group && !group.required && group.min_select > 0) {
    return `Choose at least ${group.min_select} from ${name.toLowerCase()}.`;
  }
  return `Please choose ${name.toLowerCase()}.`;
}

/**
 * Does adding this dish need a decision first?
 *
 * Asked of the defaults, not of an empty basket, so a dish whose choices are
 * all pre-answered adds in one tap and a dish that genuinely needs asking
 * opens the sheet. Sizes always need asking: where a dish has them, the
 * item's own price is not what anything sells for.
 */
export function needsChoosing(
  groups: ChoiceSet,
  variants: { $id: string }[] = [],
): boolean {
  if (variants.length > 0) return true;
  return unmetChoice(groups, defaultPicks(groups)) !== null;
}
