/**
 * Booking a list of makers in from a spreadsheet.
 *
 * A shop opening its doors has a book of thirty consignors already, and the
 * alternative to this is somebody typing thirty forms and getting four
 * commission rates wrong — which is the one field where a mistake follows
 * every sale that maker ever makes and is only noticed when they query a
 * statement months later.
 *
 * Same three-step shape as the stock upload: read the file, show what was
 * understood, then write. Nothing is written until it has been read back,
 * because a bulk write that goes straight from a file picker to the database
 * is one nobody can check before it happens.
 *
 * Pure. Every judgement about what a row says is made here and can be tested
 * without a database in front of it.
 */

import type { ImportColumn, ImportProblem } from './stock-import';

export const MAKER_COLUMNS: ImportColumn[] = [
  { key: 'code', heading: 'code', required: true,
    help: 'Short and human, it goes on labels: AKO, MB2. Must be unique.' },
  { key: 'name', heading: 'name', required: true,
    help: "The maker's full name, as it should appear on their statement." },
  { key: 'phone', heading: 'phone', help: 'Optional.' },
  { key: 'email', heading: 'email', help: 'Optional. Where a statement would be sent.' },
  { key: 'commissionPercent', heading: 'commission_percent',
    help: 'What the SHOP keeps out of each sale, as a percentage. 30 means the maker gets 70.' },
  { key: 'commissionAmount', heading: 'commission_amount',
    help: 'Or a fixed amount per piece. Fill in one of these two, never both.' },
  { key: 'payoutMethod', heading: 'payout_method',
    help: 'cash, momo, bank or other. Blank means momo.' },
  { key: 'payoutDetails', heading: 'payout_details',
    help: 'The mobile money number or account to pay into.' },
  { key: 'address', heading: 'address', help: 'Optional.' },
  { key: 'notes', heading: 'notes', help: 'Anything worth remembering about the arrangement.' },
];

export const MAKER_HEADINGS = MAKER_COLUMNS.map((c) => c.heading);

/**
 * Filled in, not blank.
 *
 * The first question anybody has is what a row is meant to look like, and an
 * empty grid answers it by making them guess. Two rows, showing the two ways
 * commission is agreed: a percentage, and a flat amount per piece.
 */
export const MAKER_TEMPLATE_ROWS: string[][] = [
  ['AKO', 'Akosua Mensah', '0244123456', 'akosua@example.com', '30', '', 'momo', '0244123456', 'Accra', 'Baskets and mats'],
  ['MB2', 'Kwame Boateng', '0201234567', '', '', '15.00', 'cash', '', '', 'Flat 15 a piece, agreed Jan'],
];

const PAYOUT_METHODS = ['cash', 'momo', 'bank', 'other'] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

export interface ImportMaker {
  code: string;
  name: string;
  phone: string;
  email: string;
  /** What the shop keeps, in basis points. Null means "use the house default". */
  commissionBp: number | null;
  /** Or a flat amount per piece, in minor units. Zero means the rate applies. */
  commissionFlat: number;
  payoutMethod: PayoutMethod;
  payoutDetails: string;
  address: string;
  notes: string;
  /** True when a consignor with this code already exists and will be updated. */
  updates: boolean;
  line: number;
}

export interface MakerImportContext {
  existing: { $id: string; code: string; name: string }[];
  decimals: number;
}

export interface MakerImportResult {
  makers: ImportMaker[];
  problems: ImportProblem[];
  /** How many of these are new, and how many are corrections to somebody on file. */
  newCount: number;
  updateCount: number;
}

const clean = (s?: string) => (s ?? '').trim();

/** A money figure as typed, in minor units. Null when it is not a number. */
function money(text: string, decimals: number): number | null {
  const cleaned = text.replace(/[^0-9.,-]/g, '').replace(',', '.');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 10 ** decimals);
}

/**
 * Read the file, and say what is wrong with it rather than what is wrong with
 * the person who wrote it.
 *
 * Every problem carries the line number, because "commission_percent must be
 * between 0 and 100" is useless against a file of forty rows and precise
 * against line 23.
 */
export function readMakerImport(rows: string[][], ctx: MakerImportContext): MakerImportResult {
  const problems: ImportProblem[] = [];
  const makers: ImportMaker[] = [];

  if (rows.length === 0) {
    return { makers, problems: [{ line: 1, message: 'The file is empty.' }], newCount: 0, updateCount: 0 };
  }

  const heading = rows[0].map((h) => clean(h).toLowerCase());
  const index = new Map(MAKER_COLUMNS.map((c) => [c.key, heading.indexOf(c.heading)]));

  for (const c of MAKER_COLUMNS) {
    if (c.required && (index.get(c.key) ?? -1) < 0) {
      problems.push({ line: 1, message: `The heading row has no "${c.heading}" column.` });
    }
  }
  if (problems.length > 0) return { makers, problems, newCount: 0, updateCount: 0 };

  const at = (row: string[], key: string) => {
    const i = index.get(key) ?? -1;
    return i < 0 ? '' : clean(row[i]);
  };

  // Codes seen in THIS file, so two rows claiming AKO are caught before one
  // silently overwrites the other.
  const seen = new Map<string, number>();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const line = r + 1;
    // A blank line in the middle of a spreadsheet is somebody's spacing, not a
    // maker with no name.
    if (row.every((cell) => clean(cell) === '')) continue;

    const code = at(row, 'code').toUpperCase();
    const name = at(row, 'name');

    if (!code) { problems.push({ line, message: 'No code. It goes on labels, so every maker needs one.' }); continue; }
    if (!name) { problems.push({ line, message: `${code} has no name.` }); continue; }
    if (code.length > 24) { problems.push({ line, message: `"${code}" is too long for a code; keep it under 24 characters.` }); continue; }

    const twin = seen.get(code);
    if (twin) {
      problems.push({ line, message: `${code} is already used on line ${twin} of this file.` });
      continue;
    }
    seen.set(code, line);

    const percentText = at(row, 'commissionPercent');
    const flatText = at(row, 'commissionAmount');

    if (percentText && flatText) {
      problems.push({
        line,
        message: `${code} has both a percentage and a fixed amount. Only one of the two can apply, so fill in one.`,
      });
      continue;
    }

    let commissionBp: number | null = null;
    if (percentText) {
      const pct = Number(percentText.replace('%', '').trim());
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        problems.push({ line, message: `${code}: "${percentText}" is not a percentage between 0 and 100.` });
        continue;
      }
      commissionBp = Math.round(pct * 100);
    }

    let commissionFlat = 0;
    if (flatText) {
      const amount = money(flatText, ctx.decimals);
      if (amount === null) {
        problems.push({ line, message: `${code}: "${flatText}" is not an amount.` });
        continue;
      }
      commissionFlat = amount;
    }

    const methodText = at(row, 'payoutMethod').toLowerCase();
    if (methodText && !PAYOUT_METHODS.includes(methodText as PayoutMethod)) {
      problems.push({
        line,
        message: `${code}: "${methodText}" is not a way of paying. Use cash, momo, bank or other.`,
      });
      continue;
    }

    makers.push({
      code,
      name,
      phone: at(row, 'phone'),
      email: at(row, 'email'),
      commissionBp,
      commissionFlat,
      payoutMethod: (methodText || 'momo') as PayoutMethod,
      payoutDetails: at(row, 'payoutDetails'),
      address: at(row, 'address'),
      notes: at(row, 'notes'),
      /*
        A code already on file is a correction, not a duplicate.

        Refusing it would make the file useless for the commonest second use of
        this screen: the shop renegotiated with four makers and wants to put
        the new rates in. Saying which rows are corrections, before anything is
        written, is what makes that safe rather than surprising.
      */
      updates: ctx.existing.some((e) => e.code.toUpperCase() === code),
      line,
    });
  }

  return {
    makers,
    problems,
    newCount: makers.filter((m) => !m.updates).length,
    updateCount: makers.filter((m) => m.updates).length,
  };
}
