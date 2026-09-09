/**
 * What a spend was, and where the money came from, in two words each.
 *
 * A spend row carried the answers to both questions in five fields that had
 * to be read together: whether any of its lines went on a shelf, whether it
 * was "off the drawer", which petty cash box it named, and what kind of
 * method paid it. Every screen that wanted to say "stock, from the bank"
 * worked that out on its own, and three of them disagreed.
 *
 * So the two answers are written on the row when it is saved, and read back
 * as words. The rules that derive them live here, so the till and the admin
 * form cannot answer differently.
 *
 * Pure. Imports nothing at runtime.
 */

/** Stock went on a shelf; an overhead was used up in the buying. */
export type SpendKind = 'stock' | 'overhead';

/**
 * Where the money left from.
 *
 *   drawer  the till's cash, which the count at close expects less of
 *   box     a petty cash box, which is counted on its own schedule
 *   bank    a transfer or card, which no drawer count ever sees
 *   own     somebody's own pocket, to be paid back — the drawer is not short
 */
export type SpendSource = 'drawer' | 'box' | 'bank' | 'own';

export const KIND_WORDS: Record<SpendKind, string> = {
  stock: 'Stock bought',
  overhead: 'An overhead',
};

export const SOURCE_WORDS: Record<SpendSource, string> = {
  drawer: 'From the drawer',
  box: 'From a petty cash box',
  bank: 'From the bank',
  own: 'Own money, to be paid back',
};

/** A spend with any line on a shelf is a stock purchase, whatever else is on it. */
export const spendKind = (items: { stocked?: boolean }[]): SpendKind =>
  items.some((i) => i.stocked !== false) && items.length > 0 ? 'stock' : 'overhead';

/**
 * Where the money came from, from what the row says.
 *
 * A box named wins over everything: the money left the tin. Then a method
 * that is not cash is the bank, however the drawer question was answered —
 * a transfer cannot come out of a drawer. Then the drawer question decides
 * between the till and somebody's pocket.
 */
export function spendSource(e: {
  imprest_float_id?: string | null;
  from_takings?: boolean;
  methodKind?: string | null;
}): SpendSource {
  if (e.imprest_float_id) return 'box';
  if (e.methodKind && e.methodKind !== 'cash') return 'bank';
  return e.from_takings === false ? 'own' : 'drawer';
}

/** The words for a row, old or new: rows written before the fields existed still read. */
export function spendWords(e: {
  kind?: string | null;
  source?: string | null;
  imprest_float_id?: string | null;
  from_takings?: boolean;
}, items: { stocked?: boolean }[] = [], methodKind?: string | null): { kind: string; source: string } {
  const kind = (e.kind as SpendKind) || spendKind(items);
  const source = (e.source as SpendSource) || spendSource({ ...e, methodKind });
  return { kind: KIND_WORDS[kind] ?? KIND_WORDS.overhead, source: SOURCE_WORDS[source] ?? SOURCE_WORDS.drawer };
}
