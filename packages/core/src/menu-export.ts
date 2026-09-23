/**
 * The catalogue, on its way out of the system.
 *
 * TWO FORMATS, ONE SET OF FACTS, and that is the whole reason this file
 * exists rather than each screen building its own columns. A price list handed
 * to an accountant and a menu printed for a folder disagreeing about what a
 * dish costs is the kind of thing nobody notices until somebody is charged the
 * wrong figure — so what a dish IS gets decided once, here, and the two
 * exports differ only in how much of it they carry.
 *
 * They differ on purpose, though. A CSV is read by a machine or by somebody
 * about to sort a column, so it carries everything, one row per dish, with the
 * money as a plain number nothing has to strip a currency symbol out of. A PDF
 * is read by a person, so it carries what a person wants and groups it the way
 * a menu is actually read.
 *
 * Pure. Nothing here reads or writes.
 */

/** Enough of a dish to export it. */
export interface ExportableItem {
  $id?: string;
  name: string;
  description?: string;
  price: number;
  sku?: string;
  barcode?: string;
  active: boolean;
  prep_minutes?: number;
  station?: string;
  tags?: string[];
  group_only?: boolean;
  track_stock?: boolean;
  on_hand?: number;
  is_service?: boolean;
  commission_bp?: number;
  commission_flat?: number;
  /** Filled in by the screen, which is the only place that knows the names. */
  categoryName?: string;
  consignorName?: string;
}

/** "Vegan, Contains nuts" — or nothing at all rather than an empty bracket. */
export const tagWords = (tags?: string[]): string =>
  (tags ?? []).filter(Boolean).join(', ');

/**
 * The columns of the spreadsheet, and a row per dish.
 *
 * MONEY AS A PLAIN NUMBER. A price written "GH₵45.00" is text: a spreadsheet
 * will not add it up, and the first thing anybody does with an exported price
 * list is add it up or sort by it. The currency belongs in the heading, where
 * it is said once and gets in nobody's way.
 *
 * The decimals are taken rather than assumed, because a business keeping three
 * of them must not have its prices quietly rounded to two on the way out.
 */
export function menuCsv(
  items: ExportableItem[],
  opts: { currency?: string; decimals?: number; craft?: boolean } = {},
): { headers: string[]; rows: unknown[][] } {
  const decimals = opts.decimals ?? 2;
  const as = (minor?: number) => ((minor ?? 0) / 10 ** decimals).toFixed(decimals);
  const cur = opts.currency ? ` (${opts.currency})` : '';

  const headers = [
    'Name',
    'Category',
    `Price${cur}`,
    'Description',
    'Code',
    'Tags',
    'On the menu',
    ...(opts.craft
      ? ['Maker', 'In stock', 'Commission %', `Flat commission${cur}`]
      : ['Prep minutes', 'Station']),
    'Group menu only',
  ];

  const rows = items.map((i) => [
    i.name,
    i.categoryName ?? '',
    as(i.price),
    i.description ?? '',
    i.sku || i.barcode || '',
    tagWords(i.tags),
    /*
      Said in words rather than as TRUE and FALSE. The commonest thing done
      with this file is to read it, and "Archived" answers the question a
      column of FALSEs makes somebody go and look up.
    */
    i.active ? 'Yes' : 'Archived',
    ...(opts.craft
      ? [
        i.consignorName ?? '',
        // A service has no shelf and never runs out; a blank says that better
        // than a nought, which reads as "none left".
        i.is_service ? '' : String(i.on_hand ?? 0),
        i.commission_bp ? (i.commission_bp / 100).toFixed(2) : '',
        i.commission_flat ? as(i.commission_flat) : '',
      ]
      : [String(i.prep_minutes ?? ''), i.station ?? '']),
    i.group_only ? 'Yes' : '',
  ]);

  return { headers, rows };
}

/**
 * One category's worth of the printed list.
 *
 * Named for the printout rather than `MenuSection`, which menu.ts already owns
 * for the thing a customer's screen is built from. Two exports with one name
 * in a package everything imports from is a collision waiting for whichever
 * file is compiled second.
 */
export interface PrintedSection {
  category: string;
  items: ExportableItem[];
}

/**
 * The printed list, grouped the way a menu is read.
 *
 * By category, categories in the order the screen was showing them, and dishes
 * within a category left in the order they arrived — which is whatever the
 * person exporting had already sorted them into. Re-sorting here would throw
 * away the one piece of intent the export has to go on.
 *
 * Anything with no category of its own is gathered at the end rather than
 * dropped: a dish missing from a printed menu is a dish nobody sells.
 */
export function menuSections(items: ExportableItem[]): PrintedSection[] {
  const order: string[] = [];
  const by = new Map<string, ExportableItem[]>();

  for (const i of items) {
    const key = (i.categoryName ?? '').trim();
    if (!by.has(key)) { by.set(key, []); order.push(key); }
    (by.get(key) as ExportableItem[]).push(i);
  }

  const named = order.filter((k) => k !== '');
  const loose = by.get('') ?? [];
  return [
    ...named.map((category) => ({ category, items: by.get(category) as ExportableItem[] })),
    ...(loose.length ? [{ category: 'Everything else', items: loose }] : []),
  ];
}

/**
 * What an exported list is called, so a file found in a folder says what it is.
 *
 * The date is in it because the commonest question about a price list on
 * somebody's desk is how old it is, and the side because a bistro's list and a
 * shop's list otherwise overwrite each other in the downloads folder.
 */
export const menuFileStem = (side: string, when: Date = new Date()): string =>
  `${side}-menu-${when.toISOString().slice(0, 10)}`;

/** Why there is nothing to export, or null. */
export const menuExportProblem = (items: ExportableItem[]): string | null =>
  (items.length === 0 ? 'Nothing to export — no items match the filters on screen.' : null);
