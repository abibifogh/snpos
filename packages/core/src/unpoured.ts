/**
 * Sales that took nothing off any shelf.
 *
 * There was already a check for this, and it asked the wrong question. It
 * looked at the CATALOGUE — does anything on the menu name this bottle — and
 * answered yes whenever a recipe existed at all. A bar can have a perfectly
 * good recipe and still pour nothing, because what the server actually matches
 * is narrower than "a recipe exists":
 *
 *   A drink with SIZES pours from the size's own recipe. If the size has none,
 *   it falls back to the drink's own — and if the drink's only recipes are
 *   attached to OTHER sizes, there is no fallback and nothing comes off. That
 *   happens on its own: a size switched off and added again is a new size with
 *   a new id, and the recipe still names the old one. Nothing says so.
 *
 * So this asks the ground-truth question instead: for the drinks that actually
 * sold, did the same rule the server uses find anything to pour? Eight large
 * Clubs sold and eight still on the shelf is not a counting problem, and the
 * bar staff should not be the ones to notice it.
 *
 * Mirrors recipeFor exactly. The two drifting apart would be worse than not
 * checking at all, because this would then report a fault that is not there.
 *
 * Pure. Imports nothing at runtime.
 */

/** A sold line, as far as this question is concerned. */
export interface SoldRow {
  menu_item_id: string;
  variant_id?: string;
  name_snapshot?: string;
  variant_label?: string;
  qty?: number;
  status?: string;
}

/** A recipe row. */
export interface PourRule {
  menu_item_id?: string;
  variant_id?: string;
  addon_option_id?: string;
  ingredient_id: string;
  qty_per_unit?: number;
}

/** A drink, as far as this question is concerned. */
export interface SoldItem {
  $id: string;
  name: string;
  module?: string;
}

export type UnpouredReason =
  /** Nothing on the drink names any ingredient at all. */
  | 'no-recipe'
  /** The drink has recipes, but every one belongs to a different size. */
  | 'size-has-no-recipe'
  /**
   * The drink has recipes, every one is tied to a size, and this was sold
   * with no size at all. That is a drink that USED to have sizes: the sizes
   * went, the links stayed, and now nothing matches. From the screen it reads
   * as nonsense — a drink with no sizes blamed for a size — so it is its own
   * reason with its own words. See shelf-relink.
   */
  | 'sold-without-a-size'
  /** The drink is not on the bar's side, so the bar's pour skips it. */
  | 'not-on-the-bar';

export interface Unpoured {
  /** Drink and size together, as it reads on a receipt. */
  name: string;
  qty: number;
  reason: UnpouredReason;
  /** So a fix can be offered against the right rows. */
  menuItemId: string;
  variantId?: string;
}

/**
 * Whether the server would find anything to pour for this line.
 *
 * The same three steps, in the same order, as recipeFor and as the function
 * in order-guard: the size's own rows win outright; failing that, the rows
 * tied to no size; and an add-on's rows pour through whatever they were added
 * to.
 */
export function poursSomething(line: SoldRow, recipes: PourRule[]): boolean {
  const mine = recipes.filter(
    (r) => r.menu_item_id === line.menu_item_id && !r.addon_option_id && (r.qty_per_unit ?? 0) > 0,
  );
  if (mine.length === 0) return false;
  if (line.variant_id) {
    const own = mine.filter((r) => r.variant_id === line.variant_id);
    if (own.length > 0) return true;
  }
  return mine.some((r) => !r.variant_id);
}

/** Drink and size as one name, without saying the size twice. */
export function soldName(line: Pick<SoldRow, 'name_snapshot' | 'variant_label'>): string {
  const base = (line.name_snapshot ?? '').trim() || 'Something no longer named';
  const label = line.variant_label?.trim();
  if (!label) return base;
  /*
    A drink already called "Club · Large" with a size called "Large" reads as
    "Club · Large · Large". The size is in the name because somebody typed it
    there, and repeating it is the kind of small wrongness that makes a screen
    look untrustworthy on the day it is reporting something true.
  */
  const suffix = ` · ${label}`;
  return base.endsWith(suffix) || base === label ? base : `${base}${suffix}`;
}

/**
 * What sold and took nothing off a shelf, most sold first.
 *
 * Grouped by drink and size, because the answer is a shopping list of things
 * to go and fix, not a list of order lines.
 */
export function unpouredSales(
  lines: SoldRow[],
  recipes: PourRule[],
  items: SoldItem[],
): Unpoured[] {
  const byId = new Map(items.map((i) => [i.$id, i]));
  const out = new Map<string, Unpoured>();

  for (const line of lines) {
    if (line.status === 'void') continue;
    if ((line.qty ?? 0) <= 0) continue;

    const item = byId.get(line.menu_item_id);
    // A drink that is not on the bar's side is skipped by the bar's pour
    // before recipes are even looked at, so that is the reason to give.
    const onTheBar = item?.module === 'bar';
    if (onTheBar && poursSomething(line, recipes)) continue;

    const mine = recipes.filter(
      (r) => r.menu_item_id === line.menu_item_id && !r.addon_option_id && (r.qty_per_unit ?? 0) > 0,
    );
    const reason: UnpouredReason = !onTheBar && item
      ? 'not-on-the-bar'
      : mine.length === 0
        ? 'no-recipe'
        // Every row it has is tied to a size. Whether that is this size's
        // fault or the drink's depends on whether a size was sold at all.
        : line.variant_id ? 'size-has-no-recipe' : 'sold-without-a-size';

    const key = `${line.menu_item_id}|${line.variant_id ?? ''}`;
    const at = out.get(key) ?? {
      name: soldName(line),
      qty: 0,
      reason,
      menuItemId: line.menu_item_id,
      variantId: line.variant_id || undefined,
    };
    at.qty += line.qty ?? 0;
    out.set(key, at);
  }

  return [...out.values()].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
}

/** What to do about it, in the words of whoever has to do it. */
export function unpouredWords(reason: UnpouredReason, name: string): string {
  switch (reason) {
    case 'not-on-the-bar':
      return `${name} is not set to the bar, so selling it takes nothing off any shelf. Open it in `
        + 'Drinks & cocktails and set which side of the business it belongs to.';
    case 'sold-without-a-size':
      return `${name} has no sizes, but everything saying what it pours is still tied to a size it used to `
        + 'have — so a plain sale matches nothing and no bottle comes off. Press "Reconnect the shelves" '
        + 'below, which hands the link back to the drink.';
    case 'size-has-no-recipe':
      return `${name} has sizes, and this size is not linked to a shelf — the drink's other sizes are, so `
        + 'there is nothing for it to fall back on. This happens on its own when a size is switched off and '
        + 'added again: the link still names the size that was replaced. Press "Reconnect the shelves" below, '
        + 'which points it back at the size that replaced it.';
    default:
      return `Nothing on ${name} says what it pours, so selling it takes nothing off any shelf. Open it in `
        + 'Drinks & cocktails and say how much of which bottle each one uses.';
  }
}

/** The one line at the top, so a bar sees it without reading the table. */
export function unpouredSummary(rows: Unpoured[]): string | null {
  if (rows.length === 0) return null;
  const drinks = rows.reduce((n, r) => n + r.qty, 0);
  return `${drinks} ${drinks === 1 ? 'drink' : 'drinks'} sold on this shift took nothing off any shelf, across `
    + `${rows.length} ${rows.length === 1 ? 'line' : 'lines'}. Their counts will read as though nothing was `
    + 'sold, so the difference below is not a shortage — it is what went out.';
}
