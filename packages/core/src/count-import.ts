/**
 * A shelf count arriving as a spreadsheet.
 *
 * Somebody walks the shop with a clipboard or a tablet and types into the sheet
 * they already use. The count screen is good for counting AT the shelf; it is
 * not good for a shop that counts on paper on Sunday and types it up on Monday,
 * and telling that shop to retype four hundred lines into a web form is telling
 * them not to count.
 *
 * What this does NOT do is bypass the count. The file FILLS THE SHEET, and the
 * sheet is then reviewed, confirmed and approved exactly as a typed count is.
 * An upload that wrote straight to the shelves would be a way to move four
 * hundred pieces with nobody having looked at the total, which is precisely
 * what the approval step exists to prevent.
 *
 * Pure. What a row means, what it matches, and what is missing can all be
 * checked without a database.
 */

import type { ImportProblem } from './stock-import';
import type { CountLine, CountReason } from './stocktake';

export const COUNT_COLUMNS = [
  { key: 'name', heading: 'product', required: true,
    help: 'Must match a piece on the shelf. Spelling is matched loosely; case does not matter.' },
  { key: 'size', heading: 'size',
    help: 'Only where the piece has sizes. Leave blank for a piece that does not.' },
  { key: 'owner', heading: 'owner',
    help: 'The maker whose work it is. Used to tell two pieces with the same name apart, and to create the piece if you ask for it.' },
  { key: 'category', heading: 'category',
    help: 'Only used when a piece is being created. Ignored otherwise.' },
  { key: 'counted', heading: 'counted', required: true,
    help: 'How many are actually there. Blank leaves the line uncounted; 0 writes it off.' },
  { key: 'reason', heading: 'reason',
    help: 'Why it differs: miscount, damaged, missing, returned. Blank means a miscount.' },
  { key: 'price', heading: 'price',
    help: 'Only used when a piece is being created.' },
] as const;

export const COUNT_HEADINGS = COUNT_COLUMNS.map((c) => c.heading);

export const COUNT_TEMPLATE_ROWS: string[][] = [
  ['Large indigo bowl', '', 'Ama Serwaa', 'Pottery', '4', '', ''],
  ['Woven basket', 'Small', 'Kofi Mensah', 'Baskets', '11', '', ''],
  ['Woven basket', 'Large', 'Kofi Mensah', 'Baskets', '2', 'damaged', ''],
];

/** The words somebody actually types for a reason, mapped to the four we keep. */
const REASON_WORDS: Record<string, CountReason> = {
  '': 'counted',
  miscount: 'counted', counted: 'counted', count: 'counted', ok: 'counted', correction: 'counted',
  damaged: 'damaged', damage: 'damaged', broken: 'damaged', broke: 'damaged',
  lost: 'lost', missing: 'lost', stolen: 'lost', gone: 'lost',
  returned: 'returned', return: 'returned', 'went back': 'returned', collected: 'returned',
};

export interface CountImportContext {
  /** The count sheet as it stands, which is what a row is matched against. */
  lines: CountLine[];
  owners: { $id: string; name: string }[];
  categories: { $id: string; name: string }[];
  decimals: number;
}

/** A row that found its line on the sheet. */
export interface MatchedCount {
  line: CountLine;
  counted: number;
  reason: CountReason;
  row: number;
}

/** A row naming a piece the shop does not have. */
export interface MissingProduct {
  name: string;
  size: string;
  ownerName: string;
  categoryName: string;
  price: number;
  counted: number;
  rows: number[];
}

export interface CountImportResult {
  matched: MatchedCount[];
  missingProducts: MissingProduct[];
  /** Owners named in the file that the shop does not have. */
  missingOwners: string[];
  problems: ImportProblem[];
  /** Lines on the sheet the file said nothing about, which stay uncounted. */
  untouched: number;
  /** Rows naming the same line twice, which is nearly always a copied row. */
  duplicates: string[];
}

const clean = (s?: string) => (s ?? '').trim();
const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Product plus size plus owner, which is what makes a shelf line unique. */
const lineKey = (name: string, size: string, owner: string) =>
  `${key(name)}|${key(size)}|${key(owner)}`;

function money(text: string, decimals: number): number {
  const cleaned = text.replace(/[^0-9.,-]/g, '').replace(',', '.');
  if (cleaned === '') return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10 ** decimals) : 0;
}

export function readCountImport(rows: string[][], ctx: CountImportContext): CountImportResult {
  const problems: ImportProblem[] = [];
  const empty: CountImportResult = {
    matched: [], missingProducts: [], missingOwners: [], problems,
    untouched: ctx.lines.length, duplicates: [],
  };

  if (rows.length === 0) {
    problems.push({ line: 1, message: 'The file is empty.' });
    return empty;
  }

  const heading = rows[0].map((h) => key(clean(h)));
  type ColumnKey = (typeof COUNT_COLUMNS)[number]['key'];
  const at = new Map<ColumnKey, number>(
    COUNT_COLUMNS.map((c) => [c.key, heading.indexOf(c.heading)] as const),
  );
  const cell = (row: string[], k: ColumnKey) => {
    const i = at.get(k) ?? -1;
    return i < 0 ? '' : clean(row[i]);
  };

  if ((at.get('name') ?? -1) < 0) {
    problems.push({
      line: 1,
      message: `The heading row has no "product" column. Expected: ${COUNT_HEADINGS.join(', ')}.`,
    });
    return empty;
  }
  if ((at.get('counted') ?? -1) < 0) {
    problems.push({ line: 1, message: 'The heading row has no "counted" column, so there is nothing to record.' });
    return empty;
  }

  // Two ways in: the exact line, and the piece's name on its own. The second
  // is what a shop with no sizes and one maker will actually send.
  const byExact = new Map<string, CountLine>();
  const byName = new Map<string, CountLine[]>();
  for (const l of ctx.lines) {
    byExact.set(lineKey(l.name, l.variantLabel ?? '', l.consignorName ?? ''), l);
    const k = key(l.name);
    (byName.get(k) ?? byName.set(k, []).get(k)!).push(l);
  }

  const ownerKnown = new Set(ctx.owners.map((o) => key(o.name)));
  const matched: MatchedCount[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const missingOwners = new Set<string>();
  const missing = new Map<string, MissingProduct>();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const line = r + 1;
    if (row.every((c) => clean(c) === '')) continue;

    const name = cell(row, 'name');
    if (!name) { problems.push({ line, message: 'No product name on this row.' }); continue; }

    const size = cell(row, 'size');
    const owner = cell(row, 'owner');
    const countedText = cell(row, 'counted');

    // Blank is not nought, the same rule the count screen follows. A row left
    // empty is a row somebody did not reach, and writing it off would be the
    // upload doing the one thing the whole count is careful not to do.
    if (countedText === '') continue;

    const counted = Number(countedText);
    if (!Number.isFinite(counted) || counted < 0) {
      problems.push({ line, message: `${name}: "${countedText}" is not a number of pieces.` });
      continue;
    }

    const reasonWord = key(cell(row, 'reason'));
    const reason = REASON_WORDS[reasonWord];
    if (reason === undefined) {
      problems.push({
        line,
        message: `${name}: "${cell(row, 'reason')}" is not a reason. Use miscount, damaged, missing or returned.`,
      });
      continue;
    }

    if (owner && !ownerKnown.has(key(owner))) missingOwners.add(owner);

    let found = byExact.get(lineKey(name, size, owner));
    if (!found) {
      const sameName = (byName.get(key(name)) ?? [])
        .filter((l) => (size ? key(l.variantLabel ?? '') === key(size) : true))
        .filter((l) => (owner ? key(l.consignorName ?? '') === key(owner) : true));

      if (sameName.length === 1) found = sameName[0];
      else if (sameName.length > 1) {
        // Named rather than guessed. Picking one would put somebody else's
        // shortage on a maker's statement, and it would look right.
        problems.push({
          line,
          message: `"${name}" matches ${sameName.length} lines on the shelf. `
            + 'Add the size or the owner to say which.',
        });
        continue;
      }
    }

    if (!found) {
      const k = lineKey(name, size, owner);
      const already = missing.get(k);
      if (already) { already.rows.push(line); already.counted += counted; continue; }
      missing.set(k, {
        name, size, ownerName: owner,
        categoryName: cell(row, 'category'),
        price: money(cell(row, 'price'), ctx.decimals),
        counted,
        rows: [line],
      });
      continue;
    }

    const id = `${found.menuItemId}|${found.variantId ?? ''}`;
    if (seen.has(id)) {
      duplicates.push(found.variantLabel ? `${found.name} (${found.variantLabel})` : found.name);
      continue;
    }
    seen.add(id);
    matched.push({ line: found, counted, reason, row: line });
  }

  return {
    matched,
    missingProducts: [...missing.values()],
    missingOwners: [...missingOwners],
    problems,
    untouched: ctx.lines.length - matched.length,
    duplicates,
  };
}

/**
 * The sheet with the file's answers written onto it.
 *
 * Returns a new list rather than editing in place, so the screen can show what
 * the upload would do before anybody commits to it — and so a second upload
 * over the top starts from what is on screen rather than from the shelf.
 */
export function applyCountImport(lines: CountLine[], matched: MatchedCount[]): CountLine[] {
  const byId = new Map(matched.map((m) => [`${m.line.menuItemId}|${m.line.variantId ?? ''}`, m]));
  return lines.map((l) => {
    const m = byId.get(`${l.menuItemId}|${l.variantId ?? ''}`);
    return m ? { ...l, countedText: String(m.counted), reason: m.reason } : l;
  });
}

/** What the upload comes to, for saying before it is applied. */
export function summariseImport(result: CountImportResult): {
  willFill: number; differences: number; missing: number; extra: number;
} {
  let differences = 0;
  let missing = 0;
  let extra = 0;
  for (const m of result.matched) {
    const delta = m.counted - m.line.onHand;
    if (delta === 0) continue;
    differences += 1;
    if (delta < 0) missing += -delta; else extra += delta;
  }
  return { willFill: result.matched.length, differences, missing, extra };
}
