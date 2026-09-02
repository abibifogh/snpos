/**
 * Which sizes a drink actually has, and which are only history.
 *
 * A size that has already sold something is switched off rather than deleted:
 * its id is on order lines, on stock movements and on somebody's statement,
 * and removing the row would leave every one of those pointing at nothing.
 * That is right, and it has one consequence nobody handled — the edit form
 * asked for every size the drink had ever had and drew them all the same way.
 *
 * So a drink with a Large that was retired and a Large that replaced it showed
 * TWO Larges, identical apart from a toggle, with nothing saying which was
 * which. Somebody looking at that reasonably reports it as a duplicate. It is
 * worse than a display fault: the two carry different ids, the recipe binds
 * one of them, and the till sells the other — which is a drink that pours
 * nothing and a count that reads as a shortage.
 *
 * Pure. Imports nothing at runtime.
 */

/** A size, as far as this question is concerned. */
export interface SizeRow {
  $id?: string;
  label: string;
  /** Absent means yes. Every row written before the flag existed was live. */
  active?: boolean;
}

/** Still sold. Absent is live, because that is what a missing flag has always meant. */
export const isLiveSize = (size: SizeRow): boolean => size.active !== false;

/** The sizes a form may edit. Retired ones are history and are left alone. */
export const liveSizes = <T extends SizeRow>(sizes: T[]): T[] => sizes.filter(isLiveSize);

/** The ones kept only because their ids are on sales that already happened. */
export const retiredSizes = <T extends SizeRow>(sizes: T[]): T[] => sizes.filter((s) => !isLiveSize(s));

/**
 * Two live sizes of one drink sharing a name.
 *
 * Not the retired ones — a Large that replaced a retired Large is the ordinary
 * way this works and is not a fault. Two LIVE Larges is: the till shows the
 * customer two identical buttons, and whichever they press decides whether
 * anything comes off a shelf.
 *
 * Compared without case or surrounding space, because "Large" and "large " are
 * the same size to everybody except a database.
 */
export function duplicateSizeLabels(sizes: SizeRow[]): string[] {
  const seen = new Map<string, string>();
  const dupes = new Set<string>();
  for (const size of liveSizes(sizes)) {
    const key = size.label.trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) dupes.add(seen.get(key) as string);
    else seen.set(key, size.label.trim());
  }
  return [...dupes];
}

/**
 * Why this set of sizes cannot be saved, or null.
 *
 * Refused rather than warned about. Two sizes with one name is not a thing
 * anybody means, and letting it save produces exactly the mess this file
 * exists to explain: a recipe bound to one and a till selling the other.
 */
export function sizeProblem(sizes: SizeRow[]): string | null {
  const dupes = duplicateSizeLabels(sizes);
  if (dupes.length === 0) return null;
  const names = dupes.map((d) => `"${d}"`).join(', ');
  return `This drink has two sizes called ${names}. Give them different names, or remove one — two sizes with `
    + 'one name show as two identical buttons at the till, and only one of them is linked to a shelf.';
}

/**
 * What to say about the sizes kept only for history.
 *
 * Shown, not hidden, and shown as what they are. Somebody who retired a size
 * last month and finds no trace of it assumes the system lost it.
 */
export function retiredWords(count: number): string | null {
  if (count <= 0) return null;
  return `${count} older ${count === 1 ? 'size has' : 'sizes have'} been retired and ${count === 1 ? 'is' : 'are'} `
    + 'not shown. They are kept because sales already went through them, and nothing new can be sold on them.';
}
