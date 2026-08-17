/**
 * Ordering and narrowing a long catalogue.
 *
 * A bar's list is seventy-nine drinks and forty-four bottles, and both pages
 * showed them in one fixed order with a name search over the top. That is fine
 * at ten rows and useless at eighty: the questions somebody actually has —
 * what is nearly out, what is the most expensive thing on the board, what is
 * in this category — all mean scrolling and reading.
 *
 * The two lists want different orderings, because they answer different
 * questions. A drinks list is read by price and by category. A stock list is
 * read by how much is left, and nothing else comes close.
 *
 * Pure. Imports nothing, so what "lowest first" means can be checked without a
 * database or a browser.
 */

/** Loose, accent-blind matching, so "cafe" finds "Café". */
export function matches(text: string | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const t = (text ?? '').toLowerCase();
  const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return t.includes(q) || strip(t).includes(strip(q));
}

/* ------------------------------------------------------------------- drinks */

export type ItemSort = 'name' | 'price_low' | 'price_high' | 'category' | 'menu';

export const ITEM_SORTS: { value: ItemSort; label: string }[] = [
  { value: 'menu', label: 'The order they appear' },
  { value: 'name', label: 'Name, A to Z' },
  { value: 'price_low', label: 'Price, cheapest first' },
  { value: 'price_high', label: 'Price, dearest first' },
  { value: 'category', label: 'Category' },
];

export interface SortableItem {
  name: string;
  price: number;
  sort: number;
  categoryName?: string;
}

export function sortItems<T extends SortableItem>(rows: T[], by: ItemSort): T[] {
  const out = [...rows];
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  switch (by) {
    case 'name': return out.sort(byName);
    case 'price_low': return out.sort((a, b) => a.price - b.price || byName(a, b));
    case 'price_high': return out.sort((a, b) => b.price - a.price || byName(a, b));
    // Within a category, still by name: a category sorted by its own internal
    // ordering reads as random to somebody looking for one drink.
    case 'category':
      return out.sort((a, b) => (a.categoryName ?? '').localeCompare(b.categoryName ?? '') || byName(a, b));
    default: return out.sort((a, b) => a.sort - b.sort || byName(a, b));
  }
}

/* -------------------------------------------------------------------- stock */

export type StockSort = 'level' | 'name' | 'cost_high' | 'category';

export const STOCK_SORTS: { value: StockSort; label: string }[] = [
  // First, and the default, because it is the question the page exists to
  // answer. A stock list ordered by name makes somebody read all of it to
  // find out whether anything needs buying.
  { value: 'level', label: 'What is lowest' },
  { value: 'name', label: 'Name, A to Z' },
  { value: 'cost_high', label: 'Most expensive first' },
  { value: 'category', label: 'Category' },
];

export type StockState = 'any' | 'out' | 'low' | 'ok';

export const STOCK_STATES: { value: StockState; label: string }[] = [
  { value: 'any', label: 'Any level' },
  { value: 'out', label: 'Out' },
  { value: 'low', label: 'Low' },
  { value: 'ok', label: 'Fine' },
];

export interface SortableStock {
  name: string;
  current_qty: number;
  par_level: number;
  low_threshold?: number;
  base_unit_cost: number;
  category?: string;
}

/**
 * How close to empty, as a fraction of par.
 *
 * Fraction rather than raw quantity, because raw quantity sorts four hundred
 * grams of saffron below two crates of tonic and calls the saffron fine. What
 * matters is how much is left RELATIVE to how much this business likes to
 * keep, which is what par is for.
 *
 * No par set means there is no answer, so those sort last rather than first —
 * an item nobody has given a target is not evidence of a shortage.
 */
export function fillFraction(row: SortableStock): number {
  if (!(row.par_level > 0)) return Number.POSITIVE_INFINITY;
  return row.current_qty / row.par_level;
}

export function stockState(row: SortableStock, lowDefaultBp = 3000): StockState {
  if (row.current_qty <= 0) return 'out';
  const threshold = row.low_threshold ?? (row.par_level * lowDefaultBp) / 10_000;
  return row.current_qty <= threshold ? 'low' : 'ok';
}

export function sortStock<T extends SortableStock>(rows: T[], by: StockSort): T[] {
  const out = [...rows];
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  switch (by) {
    case 'name': return out.sort(byName);
    case 'cost_high': return out.sort((a, b) => b.base_unit_cost - a.base_unit_cost || byName(a, b));
    case 'category': return out.sort((a, b) => (a.category ?? '').localeCompare(b.category ?? '') || byName(a, b));
    default: return out.sort((a, b) => fillFraction(a) - fillFraction(b) || byName(a, b));
  }
}
