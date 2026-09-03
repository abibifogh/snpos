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
  module?: string;
}

/** A shelf, by the only thing that can identify one across a broken link: its name. */
export interface ShelfRow {
  $id: string;
  name: string;
  module?: string;
  active?: boolean;
}

/**
 * A size with no link at all, and a shelf standing there with its name on it.
 *
 * The third shape of the fault, and the one that repointing cannot reach. A
 * size that sold eight bottles has no link of its own — never had one, or the
 * only link belongs to a different size that was deleted — so there is nothing
 * to repoint. But the shelf it should pour from is not missing: it is sitting
 * on the count sheet called "Club · Large", which is exactly the name the
 * system gives a size's own shelf when it makes one.
 *
 * Matching on that name is not a guess. It is the same name the system writes
 * — see ingredientNameFor, which shelfNameFor below mirrors — and it is taken
 * only when exactly one shelf answers to it.
 *
 * Taken for RETIRED sizes too, which is the point. Retiring a size does not
 * unmake the sales it already took, and those sales still have to come off the
 * shelf they came off in real life.
 */
export interface Adopt {
  menuItemId: string;
  variantId: string;
  ingredientId: string;
  /** The shelf's name, which is also the size's. */
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
  adopt: Adopt[];
  undecided: Undecided[];
}

/** Two names are the same name whatever the case or spacing. */
const norm = (s?: string): string => (s ?? '').trim().toLowerCase();

/**
 * The same name again, with the punctuation taken out.
 *
 * "Club · Large" is what the system writes. A shelf somebody typed themselves
 * is "Club - Large", or "Club Large", or "Club (Large)", and refusing to see
 * those means the repair silently does nothing on exactly the bars where
 * somebody set the shelves up by hand — which is most of them.
 *
 * Still exact about the WORDS. Only spacing and punctuation are ignored, so
 * "Club Large" and "Club Larger" remain two different shelves.
 */
const loose = (s?: string): string =>
  (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** A sold line, for repairing from what actually left rather than the catalogue. */
export interface SoldLink {
  menu_item_id: string;
  variant_id?: string;
  name_snapshot?: string;
  variant_label?: string;
  status?: string;
}

/**
 * What a size's own shelf is called.
 *
 * Mirrors ingredientNameFor, which is what actually names one when the system
 * makes it. This file is pure and may not import that one at runtime, so the
 * rule is written twice and a parity test fails the build if they drift — two
 * spellings of one shelf name would mean a repair that silently matches
 * nothing on exactly the drinks it exists for.
 */
export function shelfNameFor(drink: string, size: string, max = 120): string {
  const label = (size ?? '').trim();
  const name = (drink ?? '').trim();
  if (!label) return name.slice(0, max);
  const joiner = ' · ';
  const room = max - joiner.length - label.length;
  if (room < 1) return `${name} ${label}`.trim().slice(0, max);
  return `${name.length > room ? `${name.slice(0, room - 1)}…` : name}${joiner}${label}`;
}

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
  shelves: ShelfRow[] = [],
  /** What actually sold, for sizes the catalogue no longer has a row for. */
  sold: SoldLink[] = [],
): RelinkPlan {
  const sizeById = new Map(sizes.map((v) => [v.$id, v]));
  const nameOf = new Map(items.map((i) => [i.$id, i.name]));

  const liveByItem = new Map<string, LinkSize[]>();
  const allByItem = new Map<string, LinkSize[]>();
  for (const v of sizes) {
    const key = v.menu_item_id ?? '';
    if (!key) continue;
    allByItem.set(key, [...(allByItem.get(key) ?? []), v]);
    if (v.active === false) continue;
    liveByItem.set(key, [...(liveByItem.get(key) ?? []), v]);
  }

  // Shelves by name, and only the bar's live ones. A name answered by two
  // shelves identifies neither, so it is not used at all.
  const shelfByName = new Map<string, ShelfRow[]>();
  for (const s of shelves) {
    if (s.active === false) continue;
    if (s.module && s.module !== 'bar') continue;
    const key = loose(s.name);
    if (!key) continue;
    shelfByName.set(key, [...(shelfByName.get(key) ?? []), s]);
  }

  /** The one shelf answering to this name, or nothing. Never a choice of two. */
  const shelfNamed = (...candidates: string[]): ShelfRow | null => {
    for (const c of candidates) {
      const key = loose(c);
      if (!key) continue;
      const hits = shelfByName.get(key) ?? [];
      if (hits.length === 1) return hits[0];
    }
    return null;
  };

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
  const adopt: Adopt[] = [];
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

  /*
    A SIZE WITH NO LINK AT ALL, AND A SHELF WITH ITS NAME ON IT.

    Repointing needs a link to repoint. The size that sold eight large Clubs
    has none — the drink had two Larges, the link belonged to the one that was
    deleted, and deleting it took the link with it. Nothing above can reach
    that, and it is the case that started all of this.

    But the shelf is not missing. It is on the count sheet, called "Club ·
    Large", which is the name the system itself gives a size's own shelf. So a
    size with no link of its own, whose name matches exactly one live bar
    shelf, is given that shelf.

    Retired sizes included, deliberately. Retiring a size does not unmake the
    sales it already took, and those bottles came off a real shelf in real
    life whatever the catalogue says now.
  */
  /*
    A DRINK THAT ALREADY POURS IS NOT TOUCHED.

    A gin's single and double come out of the same bottle: the drink has a
    recipe of its own, every size falls back to it, and nothing is broken. Give
    one of those sizes a shelf of its own and the fallback stops applying —
    that size would pour some other shelf instead of the gin, quietly, from a
    repair that was supposed to be safe.

    So the only drinks reached here are the ones with nothing to fall back on,
    which are exactly the ones reported as pouring nothing.
  */
  const pours = (itemId: string): boolean =>
    (rowsByItem.get(itemId) ?? []).some((r) => !r.variant_id)
    || release.some((r) => r.menuItemId === itemId);

  for (const item of items) {
    if (item.module && item.module !== 'bar') continue;
    if (pours(item.$id)) continue;
    const rows = rowsByItem.get(item.$id) ?? [];
    for (const v of allByItem.get(item.$id) ?? []) {
      if (rows.some((r) => r.variant_id === v.$id)) continue;
      // Already being pointed at by a link repaired above.
      if (repoint.some((r) => r.menuItemId === item.$id && r.toVariantId === v.$id)) continue;

      const label = (v.label ?? '').trim();
      if (!label) continue;
      const shelf = shelfNamed(shelfNameFor(item.name, label));
      if (!shelf) continue;

      adopt.push({ menuItemId: item.$id, variantId: v.$id, ingredientId: shelf.$id, name: shelf.name });
    }
  }

  /*
    AND FROM WHAT ACTUALLY SOLD, when the catalogue has nothing left to go on.

    Everything above reads the catalogue: a size has to still be there, even
    switched off, for its shelf to be found. A size deleted outright leaves no
    row at all — and the sale still names it, still happened, and still took a
    bottle off a real shelf.

    The sale line carries the drink and the size as they read on the receipt,
    which is the same pair the shelf is named after. So a sold size with no
    link and no size row is matched the same way: by name, one shelf or none.
  */
  const linked = new Set<string>([
    ...recipes.filter((r) => r.variant_id && !r.addon_option_id).map((r) => `${r.menu_item_id}|${r.variant_id}`),
    ...adopt.map((a) => `${a.menuItemId}|${a.variantId}`),
    ...repoint.filter((r) => r.toVariantId).map((r) => `${r.menuItemId}|${r.toVariantId}`),
  ]);

  for (const line of sold) {
    if (line.status === 'void') continue;
    if (!line.variant_id) continue;
    // Same guard as above: a drink with something to fall back on is pouring
    // already, and giving one of its sizes a shelf would stop that.
    if (pours(line.menu_item_id)) continue;
    const key = `${line.menu_item_id}|${line.variant_id}`;
    if (linked.has(key)) continue;

    const base = (line.name_snapshot ?? '').trim();
    const label = (line.variant_label ?? '').trim();
    if (!base && !label) continue;

    /*
      Two spellings tried, in order. A drink called "Club" with a size called
      "Large" is on a shelf called "Club · Large"; a drink somebody already
      named "Club · Large" is on a shelf called that, and asking for
      "Club · Large · Large" would find nothing. Trying both is how the
      doubled-up name is handled without writing that rule out a third time.
    */
    const shelf = label ? shelfNamed(shelfNameFor(base, label), base) : shelfNamed(base);
    if (!shelf) continue;

    linked.add(key);
    adopt.push({
      menuItemId: line.menu_item_id,
      variantId: line.variant_id,
      ingredientId: shelf.$id,
      name: shelf.name,
    });
  }

  /*
    A drink that got a shelf out of the step above is no longer waiting on
    somebody. Leaving it on the "left alone" list beside a repair that just
    worked is the kind of contradiction that makes a screen unreadable.
  */
  const helped = new Set(adopt.map((a) => a.menuItemId));
  return { repoint, release, adopt, undecided: undecided.filter((u) => !helped.has(u.menuItemId)) };
}

/** Is there anything here to do? */
export const relinkIsEmpty = (plan: RelinkPlan): boolean =>
  plan.repoint.length === 0 && plan.release.length === 0
  && plan.adopt.length === 0 && plan.undecided.length === 0;

/**
 * What the repair did, in the words of whoever pressed it.
 *
 * Says what was left alone as loudly as what was fixed. A repair that reports
 * only its successes is one that quietly leaves a drink pouring nothing.
 */
export function relinkWords(plan: RelinkPlan): string {
  const fixed = plan.repoint.length + plan.release.length + plan.adopt.length;
  const parts: string[] = [];

  if (plan.repoint.length > 0) {
    parts.push(`${plan.repoint.length} ${plan.repoint.length === 1 ? 'link was' : 'links were'} pointed back at `
      + 'the size that replaced the old one');
  }
  if (plan.release.length > 0) {
    parts.push(`${plan.release.length} ${plan.release.length === 1 ? 'was' : 'were'} handed back to the drink, `
      + 'which no longer has sizes');
  }
  if (plan.adopt.length > 0) {
    parts.push(`${plan.adopt.length} ${plan.adopt.length === 1 ? 'size was' : 'sizes were'} joined to the shelf `
      + `already carrying ${plan.adopt.length === 1 ? 'its' : 'their'} name `
      + `(${plan.adopt.slice(0, 3).map((a) => a.name).join(', ')}${plan.adopt.length > 3 ? ', and more' : ''})`);
  }

  if (fixed === 0) {
    return plan.undecided.length === 0
      ? 'Every size is joined to a shelf that still exists. Nothing needed changing.'
      : `${plan.undecided.length} shelf ${plan.undecided.length === 1 ? 'link points' : 'links point'} at a size `
        + 'that is gone, and none of them can be repaired without guessing. They are listed below.';
  }

  const head = `${fixed} shelf ${fixed === 1 ? 'link' : 'links'} put right: ${parts.join('; ')}.`;
  return plan.undecided.length > 0
    ? `${head} ${plan.undecided.length} ${plan.undecided.length === 1 ? 'was' : 'were'} left alone — see below.`
    : head;
}
