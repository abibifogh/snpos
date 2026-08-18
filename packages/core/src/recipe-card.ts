/**
 * A drink's recipe, as a bartender needs to read it.
 *
 * The recipe already exists — it is what depletes stock when a cocktail sells,
 * and what the margin columns cost. It has never been visible to the person
 * actually making the drink, who has been working from memory or from a card
 * taped inside a cupboard. A new bartender, or a regular one on a drink that
 * sells twice a month, is guessing.
 *
 * This is the same data, read out. Nothing here decides anything; it turns
 * stored quantities into a line somebody can pour from.
 *
 * Pure. Imports nothing at runtime.
 */

export interface RecipeRow {
  menu_item_id?: string;
  addon_option_id?: string;
  ingredient_id: string;
  qty_per_unit?: number;
}

export interface NamedIngredient {
  $id: string;
  name: string;
  unit?: string;
  active?: boolean;
}

export interface PourLine {
  name: string;
  /** "5cl", "2 shots", "8 leaves" — already worded. */
  measure: string;
}

/**
 * A quantity as a bartender would say it.
 *
 * Trailing zeros go: stored quantities come from arithmetic, so a 5cl pour can
 * arrive as 5.0000001 or 2.5 as 2.4999999, and a measure printed to seven
 * decimal places is one nobody reads. Two decimals is finer than any bar
 * measures to.
 *
 * Units that are really nouns get pluralised — "8 leaves", "2 shots" — because
 * "8 leaf" reads as a typo and slows somebody down mid-service. Units that are
 * abbreviations do not: "5cl", never "5cls".
 */
const SPELT_OUT = new Set(['shot', 'leaf', 'slice', 'wedge', 'dash', 'piece', 'sprig', 'cube', 'drop', 'bottle', 'can']);
const PLURALS: Record<string, string> = { leaf: 'leaves' };

export function formatMeasure(qty: number, unit?: string): string {
  const n = Number.isFinite(qty) ? qty : 0;
  const rounded = Math.round(n * 100) / 100;
  const amount = String(rounded);
  const u = (unit ?? '').trim();
  if (!u) return amount;

  const base = u.toLowerCase();
  if (!SPELT_OUT.has(base)) return `${amount}${u}`;
  if (rounded === 1) return `${amount} ${u}`;
  return `${amount} ${PLURALS[base] ?? `${u}s`}`;
}

/**
 * What goes into one of these.
 *
 * Kept in the order the recipe was written, which is the order somebody
 * building the drink entered it — spirits first, then the mixers, then the
 * garnish, usually. Re-sorting alphabetically would scramble a sequence that
 * carries meaning for free.
 *
 * An ingredient that has since been deleted shows as a line with no name
 * rather than vanishing: a recipe quietly one item short is worse than one
 * that says something is missing.
 */
export function pourList(
  itemId: string,
  recipes: RecipeRow[],
  ingredients: NamedIngredient[],
): PourLine[] {
  const byId = new Map(ingredients.map((i) => [i.$id, i]));
  return recipes
    // Only the drink's own recipe. Rows carrying an addon_option_id belong to
    // an extra somebody chose, not to the drink as it stands.
    .filter((r) => r.menu_item_id === itemId && !r.addon_option_id)
    .map((r) => {
      const ing = byId.get(r.ingredient_id);
      return {
        name: ing?.name ?? 'An ingredient that no longer exists',
        measure: formatMeasure(r.qty_per_unit ?? 0, ing?.unit),
      };
    });
}

/** Does this drink have anything to show? */
export const hasRecipe = (itemId: string, recipes: RecipeRow[]): boolean =>
  recipes.some((r) => r.menu_item_id === itemId && !r.addon_option_id);

/**
 * Is this a drink somebody MAKES, rather than one they hand over?
 *
 * Nearly everything behind a bar has a recipe, because that is how stock comes
 * off: a bottled beer's "recipe" is one bottle of itself. So "has a recipe"
 * put a question mark on every tile, including the beers, where the answer was
 * always going to be the name of the thing you are already holding. A hint
 * that appears everywhere is one nobody reads.
 *
 * Cocktails and spirits are the two that need it: a cocktail because it is
 * built, a spirit because it is measured and the measure is the thing people
 * get wrong.
 *
 * Matched on the category's NAME, because the categories are the shop's own
 * and there is no field saying which of them are made to order. It follows
 * whatever the bar calls its shelves, and it follows a rename — which is the
 * right trade for not making somebody set a flag on sixty rows, but it does
 * mean a house that calls them "Mixed drinks" gets nothing until this list
 * learns the word.
 */
const MADE_TO_ORDER = ['cocktail', 'spirit', 'shot', 'mixed drink'];

export const isMadeToOrder = (categoryName?: string): boolean => {
  const name = (categoryName ?? '').toLowerCase();
  return MADE_TO_ORDER.some((word) => name.includes(word));
};

/** Should the tile offer a look at the recipe? Both things have to be true. */
export const showsRecipe = (
  itemId: string,
  recipes: RecipeRow[],
  categoryName?: string,
): boolean => isMadeToOrder(categoryName) && hasRecipe(itemId, recipes);
