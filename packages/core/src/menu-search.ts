/**
 * Searching the catalogue at the till. Pure: imports types only, so it can be
 * tested without a database.
 */
/** What a search reads of a catalogue entry. MenuEntry has all of it. */
export interface SearchableEntry {
  item: { $id: string; name: string; description?: string; sku?: string; barcode?: string; tags?: string[] };
  variants?: { label?: string; sku?: string; barcode?: string }[];
}

/** What a search reads of a section. MenuSection has all of it. */
export interface SearchableSection<E extends SearchableEntry = SearchableEntry> {
  category: { name: string };
  entries: E[];
}

/** Lower case, accents off, so "cafe" finds "Café" and "SHEA" finds "shea". */
const fold = (t: string | undefined | null): string =>
  (t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export interface MenuHit<E extends SearchableEntry, S extends SearchableSection<E>> {
  entry: E;
  /** The section it was found in, for its name and its rules. */
  section: S;
}

/**
 * The till's search: what matches what was typed, across every category.
 *
 * A counter with fourteen categories is a counter where the assistant
 * hunts. Every word typed must appear somewhere on the product (its name,
 * description, tags, sizes, code or barcode, or its category's name), in
 * any order. Best first: a code or barcode typed whole (a scanner types
 * one), then names that start with it, then names with a word that starts
 * with it, then the rest. Each product once, however many categories hold it.
 */
export function searchMenu<E extends SearchableEntry, S extends SearchableSection<E>>(sections: S[], term: string): MenuHit<E, S>[] {
  const q = fold(term).trim();
  if (!q) return [];
  const words = q.split(/\s+/);
  const seen = new Set<string>();
  const hits: (MenuHit<E, S> & { score: number })[] = [];
  for (const section of sections) {
    for (const entry of section.entries) {
      const it = entry.item;
      if (seen.has(it.$id)) continue;
      const name = fold(it.name);
      const codes = [it.sku, it.barcode, ...(entry.variants ?? []).flatMap((v) => [v.sku, v.barcode])]
        .map((c) => fold(c)).filter(Boolean);
      const hay = [
        name, fold(it.description), ...(it.tags ?? []).map(fold), fold(section.category.name),
        ...(entry.variants ?? []).map((v) => fold(v.label)), ...codes,
      ].join(' ');
      if (!words.every((w) => hay.includes(w))) continue;
      seen.add(it.$id);
      const score = codes.includes(q) ? 0
        : name.startsWith(q) ? 1
          : name.split(/[^a-z0-9]+/).some((w) => w.startsWith(words[0])) ? 2
            : name.includes(words[0]) ? 3 : 4;
      hits.push({ entry, section, score });
    }
  }
  return hits
    .sort((a, b) => a.score - b.score || a.entry.item.name.localeCompare(b.entry.item.name))
    .map(({ entry, section }) => ({ entry, section }));
}
