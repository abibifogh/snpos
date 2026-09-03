/**
 * Shelf links left pointing at a size that is gone.
 *
 * A recipe row may name a size, and where it does it applies to that size
 * alone — see variant-recipes. Nothing has ever tidied those rows up when the
 * size itself goes away, and a size goes away easily: switching one off,
 * deleting one from the edit form, or switching one off and adding it back
 * (which is a NEW size with a new id) all leave the link naming something that
 * is no longer there.
 *
 * A link like that is not merely untidy. It is invisible and it silently stops
 * the drink pouring:
 *
 *   - The drink still has sizes, and the sold size has no link of its own, so
 *     it falls back to the drink's own rows — of which there are none, because
 *     the only row there is belongs to the size that was replaced.
 *
 *   - Or the drink has NO sizes any more and sells plain, with no size on the
 *     line at all — and every row it has is tied to a size, so again there is
 *     nothing to fall back on.
 *
 * Both end the same way: the till takes the money, no bottle comes off any
 * shelf, and the count reads as a shortage on the night somebody counts it.
 * That is the second of these — a Sprite with no sizes at all sitting in the
 * "sold, nothing came off a shelf" list, which reads as nonsense until you know
 * the drink used to have sizes.
 *
 * What can be repaired without guessing:
 *
 *   REPOINT — the size that vanished has a live size of the same name on the
 *   same drink. That is a size switched off and added again, and re-pointing
 *   the link at the new one restores exactly what was meant.
 *
 *   RELEASE — the drink has no live sizes at all and exactly one leftover
 *   link. It sells plain now, and one link is unambiguous: hand it back to the
 *   drink, which is what every recipe written before sizes existed meant.
 *
 * Everything else is left alone and named. A drink with two leftover links and
 * no sizes could pour from either shelf, and picking one for somebody is how a
 * repair becomes a new fault nobody can see.
 *
 * Pure. Imports nothing at runtime.
 */

/** A recipe row, as far as this question is concerned. */
export interface LinkRow {
  $id: string;
  menu_item_id?: string;
  variant_id?: string;
  addon_option_id?: string;
  ingredient_id?: string;
}

/** A size. */
export interface LinkSize {
  $id: string;
  menu_item_id?: string;
  label?: string;
  /** Absent means live, because that is what a missing flag has always meant. */
  active?: boolean;
}

/** A drink, for naming what was repaired. */
export interface LinkItem {
  $id: string;
  name: string;
}

/** Point it at the size that replaced the old one, or hand it back to the drink. */
export type RelinkAction = 'repoint' | 'release';

export interface Relink {
  recipeId: string;
  menuItemId: string;
  action: RelinkAction;
  /** The live size to point at. Only on a repoint. */
  toVariantId?: string;
  /** What to call it in the report. */
  name: string;
}

/** A leftover link that cannot be repaired without guessing. */
export interface Undecided {
  recipeId: string;
  menuItemId: string;
  name: string;
  why: string;
}

export interface RelinkPlan {
  repoint: Relink[];
  release: Relink[];
  undecided: Undecided[];
}

/** Two names are the same name whatever the case or spacing. */
const norm = (s?: string): string => (s ?? '').trim().toLowerCase();

/**
 * What can be put right, what must be asked about, and nothing done yet.
 *
 * Worked out before anything is written so the screen can say what it is about
 * to do. A repair that reports itself only after the fact is one nobody dares
 * press twice.
 */
export function relinkPlan(
  recipes: LinkRow[],
  sizes: LinkSize[],
  items: LinkItem[],
): RelinkPlan {
  const sizeById = new Map(sizes.map((v) => [v.$id, v]));
  const nameOf = new Map(items.map((i) => [i.$id, i.name]));

  const liveByItem = new Map<string, LinkSize[]>();
  for (const v of sizes) {
    if (v.active === false) continue;
    const key = v.menu_item_id ?? '';
    if (!key) continue;
    liveByItem.set(key, [...(liveByItem.get(key) ?? []), v]);
  }

  const rowsByItem = new Map<string, LinkRow[]>();
  for (const r of recipes) {
    // An add-on pours through whatever it was added to and never names a size.
    if (r.addon_option_id) continue;
    const key = r.menu_item_id ?? '';
    if (!key) continue;
    rowsByItem.set(key, [...(rowsByItem.get(key) ?? []), r]);
  }

  const repoint: Relink[] = [];
  const release: Relink[] = [];
  const undecided: Undecided[] = [];

  for (const [itemId, rows] of rowsByItem) {
    const live = liveByItem.get(itemId) ?? [];
    const general = rows.filter((r) => !r.variant_id);
    const orphans = rows.filter((r) => r.variant_id && !live.some((v) => v.$id === r.variant_id));
    if (orphans.length === 0) continue;

    const drink = nameOf.get(itemId) ?? 'A drink no longer named';
    const left: LinkRow[] = [];

    for (const r of orphans) {
      /*
        A size switched off and added again. The old row is still there, still
        carrying the name somebody typed, and a live size of that name on the
        same drink is the one that replaced it. This is the commonest cause by
        a distance and the only one that can be repaired outright.
      */
      const old = sizeById.get(r.variant_id as string);
      const match = old && norm(old.label) ? live.find((v) => norm(v.label) === norm(old.label)) : undefined;
      if (match) {
        repoint.push({
          recipeId: r.$id,
          menuItemId: itemId,
          action: 'repoint',
          toVariantId: match.$id,
          name: `${drink} · ${(old?.label ?? '').trim()}`,
        });
      } else {
        left.push(r);
      }
    }

    if (left.length === 0) continue;

    /*
      The drink sells plain now and has exactly one link. Unambiguous, and it
      is what every recipe written before sizes existed already meant: this
      drink pours this much of this bottle.
    */
    if (live.length === 0 && general.length === 0 && left.length === 1) {
      release.push({ recipeId: left[0].$id, menuItemId: itemId, action: 'release', name: drink });
      continue;
    }

    for (const r of left) {
      const why = live.length > 0
        ? `${drink} still has sizes, and none of them is named the same as the size this link was written for. `
          + 'Open the drink and set that size’s shelf by hand.'
        : left.length > 1
          ? `${drink} has ${left.length} shelf links left over from sizes it no longer has, and only one of them `
            + 'can become the drink’s own. Open the drink and say which bottle it pours.'
          : `${drink} already pours something of its own, so this leftover link was left where it is.`;
      undecided.push({ recipeId: r.$id, menuItemId: itemId, name: drink, why });
    }
  }

  return { repoint, release, undecided };
}

/** Is there anything here to do? */
export const relinkIsEmpty = (plan: RelinkPlan): boolean =>
  plan.repoint.length === 0 && plan.release.length === 0 && plan.undecided.length === 0;

/**
 * What the repair did, in the words of whoever pressed it.
 *
 * Says what was left alone as loudly as what was fixed. A repair that reports
 * only its successes is one that quietly leaves a drink pouring nothing.
 */
export function relinkWords(plan: RelinkPlan): string {
  const fixed = plan.repoint.length + plan.release.length;
  const parts: string[] = [];

  if (plan.repoint.length > 0) {
    parts.push(`${plan.repoint.length} ${plan.repoint.length === 1 ? 'was' : 'were'} pointed back at the size `
      + 'that replaced the old one');
  }
  if (plan.release.length > 0) {
    parts.push(`${plan.release.length} ${plan.release.length === 1 ? 'was' : 'were'} handed back to the drink, `
      + 'which no longer has sizes');
  }

  if (fixed === 0) {
    return plan.undecided.length === 0
      ? 'Every shelf link points at a size that still exists. Nothing needed changing.'
      : `${plan.undecided.length} shelf ${plan.undecided.length === 1 ? 'link points' : 'links point'} at a size `
        + 'that is gone, and none of them can be repaired without guessing. They are listed below.';
  }

  const head = `${fixed} shelf ${fixed === 1 ? 'link' : 'links'} pointed at a size that is gone: ${parts.join(', and ')}.`;
  return plan.undecided.length > 0
    ? `${head} ${plan.undecided.length} ${plan.undecided.length === 1 ? 'was' : 'were'} left alone — see below.`
    : head;
}
