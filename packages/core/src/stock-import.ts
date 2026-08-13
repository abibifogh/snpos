/**
 * Reading a spreadsheet of shop stock, and deciding whether it is any good.
 *
 * A shop that has just taken in ninety pieces is not going to type ninety
 * forms. So it fills in a template and this reads it back.
 *
 * Everything here is pure. It takes rows of strings and the lists they have to
 * match against, and returns either products ready to write or a list of what
 * is wrong and on which line. Nothing is written from this file, which is what
 * lets the difficult part, the validating, be tested exhaustively without a
 * database.
 *
 * ## Nothing is imported until everything is right
 *
 * The alternative, importing the good rows and reporting the bad ones, sounds
 * kinder and is not. It leaves a shop half-loaded, with no way to tell by
 * looking which pieces made it, and the natural next move is to fix the file
 * and upload it again, which duplicates everything that worked the first time.
 * One file, one answer: all of it or none of it.
 *
 * ## One row per thing that has its own price
 *
 * A basket in three sizes is three rows sharing a name. They become one
 * product with three sizes, because that is what the till has to sell. A
 * product with no sizes is a single row and needs no variant columns at all.
 */

/* ------------------------------------------------------------- the template */

export interface ImportColumn {
  key: string;
  /** The heading as it appears in the file. */
  heading: string;
  required?: boolean;
  /** What to write in it, in the shop's words. */
  help: string;
}

export const IMPORT_COLUMNS: ImportColumn[] = [
  { key: 'name', heading: 'name', required: true,
    help: 'What the piece is called. Rows sharing a name become one product with sizes.' },
  { key: 'category', heading: 'category', required: true,
    help: 'Must already exist under Craft shop, Categories. Spelling is matched loosely, case does not matter.' },
  { key: 'price', heading: 'price',
    help: 'What it sells for. Leave blank only when the sizes below carry their own prices.' },
  { key: 'quantity', heading: 'quantity',
    help: 'How many came in. Blank means 1. Ignored when the row has a size.' },
  { key: 'consignor', heading: 'consignor_code',
    help: "The maker's short code. Blank means the shop owns it outright and nobody is credited." },
  { key: 'commissionPercent', heading: 'commission_percent',
    help: "What the shop keeps, as a percentage. Blank uses the maker's usual terms." },
  { key: 'commissionAmount', heading: 'commission_amount',
    help: 'Or a fixed amount per piece. Fill in one of these two, never both.' },
  { key: 'barcode', heading: 'barcode', help: 'Optional. Scanned at the till.' },
  { key: 'variantType', heading: 'size_type',
    help: 'What kind of variation this is: size, colour, finish. Blank if the piece has none.' },
  { key: 'variantLabel', heading: 'size_label',
    help: 'Small, Large, Blue. Blank if the piece has no sizes.' },
  { key: 'variantPrice', heading: 'size_price', help: "This size's own price." },
  { key: 'variantQuantity', heading: 'size_quantity', help: 'How many of this size came in.' },
  { key: 'variantBarcode', heading: 'size_barcode', help: "Optional, this size's own barcode." },
  { key: 'oneOff', heading: 'one_off',
    help: 'yes for a single unrepeatable piece. Blank or no otherwise.' },
  { key: 'makerNote', heading: 'maker_note', help: "Anything the maker said about it. Shown to staff." },
  { key: 'description', heading: 'description', help: 'Optional. Shown to customers.' },
];

export const IMPORT_HEADINGS = IMPORT_COLUMNS.map((c) => c.heading);

/**
 * The file somebody downloads, already filled in with examples.
 *
 * Examples rather than an empty grid, because the first question anybody has
 * is what a row is supposed to look like, and a blank template answers it by
 * making them guess. The three rows show the two shapes: a plain piece, and a
 * piece in two sizes sharing a name.
 */
export const TEMPLATE_ROWS: string[][] = [
  ['Woven raffia basket', 'Baskets', '120.00', '4', 'AKO', '', '', '', '', '', '', '', '', '', 'Dyed with local indigo', ''],
  ['Beaded necklace', 'Jewellery', '', '', 'AKO', '25', '', '', 'size', 'Short', '80.00', '3', '', '', '', ''],
  ['Beaded necklace', 'Jewellery', '', '', 'AKO', '25', '', '', 'size', 'Long', '110.00', '2', '', '', '', ''],
];

/* -------------------------------------------------------------- the reading */

/** What a row was understood to say, before it is judged. */
interface RawRow {
  line: number;
  values: Record<string, string>;
}

export interface ImportVariant {
  kindKey: string;
  label: string;
  price: number;
  quantity: number;
  barcode: string;
}

export interface ImportProduct {
  name: string;
  categoryId: string;
  categoryName: string;
  description: string;
  price: number;
  quantity: number;
  consignorId: string;
  consignorName: string;
  commissionBp: number | null;
  commissionFlat: number;
  barcode: string;
  oneOff: boolean;
  makerNote: string;
  variants: ImportVariant[];
  /** The lines of the file this came from, for the message when it is wrong. */
  lines: number[];
}

export interface ImportProblem {
  /** The line in the file, counting the heading as line 1. */
  line: number;
  message: string;
}

export interface ImportContext {
  categories: { $id: string; name: string }[];
  consignors: { $id: string; code: string; name: string }[];
  variantTypes: { key: string; name: string }[];
  decimals: number;
}

export interface ImportResult {
  products: ImportProduct[];
  problems: ImportProblem[];
  /** Pieces altogether, so somebody can check the file against the crate. */
  pieceCount: number;
}

/**
 * Money from a spreadsheet cell.
 *
 * Deliberately stricter than the parser used on forms, and this file imports
 * nothing so that stays true. A form field strips whatever is not a digit,
 * which is right when somebody is typing into a box with a currency symbol
 * beside it: "GH 12" is twelve. A cell is different. A cell reading "12 each"
 * or "120 or 130" is somebody leaving themselves a note, and reading it as 12
 * would put a price on the shop floor that nobody chose. So the whole cell has
 * to be a number, give or take a symbol, spaces and thousands separators.
 */
function readMoney(text: string, decimals: number): number | null {
  const raw = text.trim().replace(/[\s,'\u00a0]/g, '').replace(/^[^\d.-]+/, '');
  if (raw === '' || !/^-?\d*\.?\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10 ** decimals);
}

/** Loose matching, because nobody types a category name twice the same way. */
const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const yes = (s: string) => ['yes', 'y', 'true', '1'].includes(s.trim().toLowerCase());

/** A whole number of things, or null when it is not one. */
function readQty(text: string, fallback: number | null = null): number | null {
  const raw = text.trim();
  if (raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

/**
 * Turn a parsed file into products, or into a list of what is wrong with it.
 *
 * Headings are matched by name rather than by position, so a column moved or
 * an extra column added by a spreadsheet does not silently shift every value
 * one to the left. A missing heading is reported once, at the top, rather than
 * as a fault on every row.
 */
export function readImport(rows: string[][], ctx: ImportContext): ImportResult {
  const problems: ImportProblem[] = [];
  const empty: ImportResult = { products: [], problems, pieceCount: 0 };

  if (rows.length === 0) {
    problems.push({ line: 1, message: 'The file is empty.' });
    return empty;
  }

  const headings = rows[0].map(loose);
  const index: Record<string, number> = {};
  for (const col of IMPORT_COLUMNS) {
    const at = headings.indexOf(loose(col.heading));
    if (at >= 0) index[col.key] = at;
  }

  const missing = IMPORT_COLUMNS.filter((c) => c.required && index[c.key] === undefined);
  if (missing.length > 0) {
    problems.push({
      line: 1,
      message:
        `The heading row is missing: ${missing.map((c) => c.heading).join(', ')}. ` +
        'Download the template and paste your rows into it.',
    });
    return empty;
  }

  const body = rows.slice(1);
  if (body.length === 0) {
    problems.push({ line: 1, message: 'The file has headings but no rows.' });
    return empty;
  }

  const raw: RawRow[] = body.map((cells, i) => ({
    line: i + 2,
    values: Object.fromEntries(
      IMPORT_COLUMNS.map((c) => [c.key, index[c.key] === undefined ? '' : (cells[index[c.key]] ?? '').trim()]),
    ),
  }));

  /* ------------------------------------------------------- group by product */
  //
  // Name and maker together, so two makers who both call something "Small bowl"
  // stay two products credited to two people.
  const groups = new Map<string, RawRow[]>();
  for (const row of raw) {
    const name = row.values.name;
    if (!name) {
      problems.push({ line: row.line, message: 'No name. Every row needs one, including each size of a piece.' });
      continue;
    }
    const key = `${loose(name)}::${loose(row.values.consignor)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const products: ImportProduct[] = [];

  for (const rowsFor of groups.values()) {
    const first = rowsFor[0];
    const v = first.values;
    const lines = rowsFor.map((r) => r.line);
    const fault = (message: string, line = first.line) => problems.push({ line, message });

    /* ------------------------------------------------------------ category */
    /**
     * Every row of a piece has to say the same thing about the piece.
     *
     * Only the first row's category, maker and commission were read, so a
     * different category typed on the second size of a basket was accepted and
     * thrown away without a word. Silently ignoring what somebody wrote is the
     * fastest way to make a bulk upload untrustworthy: the file says one thing,
     * the shop floor shows another, and nothing explains the gap.
     */
    for (const other of rowsFor.slice(1)) {
      for (const [key, label] of [
        ['category', 'category'],
        ['consignor', 'consignor_code'],
        ['commissionPercent', 'commission_percent'],
        ['commissionAmount', 'commission_amount'],
      ] as const) {
        if (loose(other.values[key]) !== loose(v[key])) {
          problems.push({
            line: other.line,
            message:
              `This row says ${label} is "${other.values[key] || '(blank)'}" but line ${first.line} says ` +
              `"${v[key] || '(blank)'}" for the same piece. Every row of a piece has to agree.`,
          });
        }
      }
    }

    const category = ctx.categories.find((c) => loose(c.name) === loose(v.category));
    if (!v.category) fault('No category.');
    else if (!category) {
      fault(
        `There is no craft shop category called "${v.category}". ` +
        `The ones that exist are: ${ctx.categories.map((c) => c.name).join(', ') || 'none yet'}.`,
      );
    }

    /* ------------------------------------------------------------ consignor */
    let consignor: { $id: string; code: string; name: string } | undefined;
    if (v.consignor) {
      consignor = ctx.consignors.find((c) => loose(c.code) === loose(v.consignor));
      if (!consignor) fault(`There is no consignor with the code "${v.consignor}".`);
    }

    /* ----------------------------------------------------------- commission */
    let commissionBp: number | null = null;
    let commissionFlat = 0;
    if (v.commissionPercent && v.commissionAmount) {
      fault('Both a commission percentage and a commission amount. Fill in one, not both.');
    } else if (v.commissionPercent) {
      const pct = Number(v.commissionPercent);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) fault('The commission percentage has to be between 0 and 100.');
      else commissionBp = Math.round(pct * 100);
    } else if (v.commissionAmount) {
      const flat = readMoney(v.commissionAmount, ctx.decimals);
      if (flat === null || flat <= 0) fault('The commission amount is not a number.');
      else commissionFlat = flat;
    }
    if (!v.consignor && (v.commissionPercent || v.commissionAmount)) {
      fault('A commission with no consignor code. Nobody would be credited it.');
    }

    /* -------------------------------------------------------------- sizes */
    const sized = rowsFor.filter((r) => r.values.variantLabel);
    const variants: ImportVariant[] = [];
    const seen = new Set<string>();

    for (const r of sized) {
      const label = r.values.variantLabel;
      if (seen.has(loose(label))) {
        problems.push({ line: r.line, message: `"${label}" appears twice on the same piece.` });
        continue;
      }
      seen.add(loose(label));

      const price = readMoney(r.values.variantPrice, ctx.decimals);
      if (price === null || price < 0) {
        problems.push({ line: r.line, message: `"${label}" needs its own price in size_price.` });
        continue;
      }
      const qty = readQty(r.values.variantQuantity, 1);
      if (qty === null) {
        problems.push({ line: r.line, message: `"${label}" has a quantity that is not a whole number.` });
        continue;
      }

      // A kind that has not been set up is not a reason to refuse a delivery.
      // It falls back to the first one the shop has, and says so once.
      const wanted = loose(r.values.variantType);
      const kind = ctx.variantTypes.find((t) => loose(t.key) === wanted || loose(t.name) === wanted);
      if (r.values.variantType && !kind) {
        problems.push({
          line: r.line,
          message:
            `"${r.values.variantType}" is not one of the kinds of variation this shop uses ` +
            `(${ctx.variantTypes.map((t) => t.key).join(', ') || 'none set up'}).`,
        });
        continue;
      }

      variants.push({
        kindKey: kind?.key ?? ctx.variantTypes[0]?.key ?? 'size',
        label,
        price,
        quantity: qty,
        barcode: r.values.variantBarcode,
      });
    }

    // Rows that carry a size and rows that do not, under one name, is somebody
    // filling the template in two different ways at once, and the count would
    // be double-read.
    if (variants.length > 0 && sized.length !== rowsFor.length) {
      fault('Some rows for this piece have a size and some do not. Give every row a size, or none of them.');
    }

    /* -------------------------------------------------------------- price */
    let price = 0;
    let quantity = 0;
    // Judged on what the rows CLAIM to be, not on what survived. A size whose
    // price was unreadable has already been reported; adding "and it has no
    // price either" is two messages for one mistake, and the second one sends
    // somebody to the wrong column.
    if (sized.length === 0) {
      const parsedPrice = readMoney(v.price, ctx.decimals);
      if (parsedPrice === null || parsedPrice < 0) fault('No price. A piece with no sizes needs one.');
      else price = parsedPrice;

      const qty = readQty(v.quantity, 1);
      if (qty === null) fault('The quantity is not a whole number.');
      else quantity = qty;
    } else if (variants.length > 0) {
      // The product's own price is only ever shown as the bottom of a range,
      // so it takes the cheapest size rather than a figure nobody typed.
      price = Math.min(...variants.map((x) => x.price));
      quantity = variants.reduce((n, x) => n + x.quantity, 0);
    }

    products.push({
      name: v.name,
      categoryId: category?.$id ?? '',
      categoryName: category?.name ?? v.category,
      description: v.description,
      price,
      quantity,
      consignorId: consignor?.$id ?? '',
      consignorName: consignor?.name ?? '',
      commissionBp,
      commissionFlat,
      barcode: v.barcode,
      oneOff: yes(v.oneOff) || (variants.length === 0 && quantity === 1 && yes(v.oneOff)),
      makerNote: v.makerNote,
      variants,
      lines,
    });
  }

  return {
    products,
    problems: problems.sort((a, b) => a.line - b.line),
    pieceCount: products.reduce((n, p) => n + p.quantity, 0),
  };
}
