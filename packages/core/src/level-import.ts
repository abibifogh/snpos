/**
 * Setting opening levels for two places from one spreadsheet.
 *
 * A bar moving in has stock in a store room and stock behind the bar, and
 * counting forty items twice on day one is the kind of task that gets done
 * badly or not at all. Every system that holds stock per location can export
 * exactly this, so the shape is: one row per thing, one column per place.
 *
 * Deliberately SET rather than add. This is an opening balance, not a
 * delivery: running it twice must leave the same answer, because somebody
 * will run it twice — the first time to see what happens, and once more after
 * fixing a column. A file that added would silently double the shop.
 *
 * Pure. What a row means, and what it does to a place that already has a
 * level, can be checked without a database.
 */

import type { ImportColumn, ImportProblem } from './stock-import';

export const LEVEL_COLUMNS: ImportColumn[] = [
  { key: 'name', heading: 'name', required: true,
    help: 'Must match a bottle or mixer you already have. Spelling is matched loosely; case does not matter.' },
  { key: 'unit', heading: 'unit',
    help: 'Only read back to you as a check. The unit already set on the item is the one that counts.' },
];

/**
 * The place columns are not fixed.
 *
 * A business with a store and a bar has two; one with a cellar as well has
 * three. Naming them in the schema would mean editing the code to add a room,
 * so instead any column whose heading matches a place you have set up becomes
 * that place's opening level, and anything else is ignored and said so.
 */
export const LEVEL_TEMPLATE_HEADINGS = ['name', 'unit', 'Store room', 'The bar'];

export const LEVEL_TEMPLATE_ROWS: string[][] = [
  ['Havana Club Bottle', 'shot', '120', '28'],
  ['Tonic', 'bottle', '48', '13'],
  ['Lime', 'each', '0', '20'],
];

export interface LevelRow {
  ingredientId: string;
  name: string;
  /** What each named place should be set to. Places absent from the file are left alone. */
  levels: { locationId: string; locationName: string; qty: number }[];
  line: number;
}

export interface LevelImportContext {
  ingredients: { $id: string; name: string; unit: string }[];
  locations: { $id: string; name: string }[];
}

export interface LevelImportResult {
  rows: LevelRow[];
  problems: ImportProblem[];
  /** Headings that matched a place, and headings that matched nothing. */
  matchedPlaces: string[];
  ignoredColumns: string[];
  /** Names in the file with no ingredient behind them. */
  unknownItems: string[];
}

const clean = (s?: string) => (s ?? '').trim();
const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function readLevelImport(rows: string[][], ctx: LevelImportContext): LevelImportResult {
  const problems: ImportProblem[] = [];
  const empty: LevelImportResult = {
    rows: [], problems, matchedPlaces: [], ignoredColumns: [], unknownItems: [],
  };

  if (rows.length === 0) {
    problems.push({ line: 1, message: 'The file is empty.' });
    return empty;
  }

  const heading = rows[0].map((h) => clean(h));
  const nameAt = heading.findIndex((h) => key(h) === 'name');
  if (nameAt < 0) {
    problems.push({ line: 1, message: 'The heading row has no "name" column.' });
    return empty;
  }

  const byName = new Map(ctx.ingredients.map((i) => [key(i.name), i]));
  const placeByName = new Map(ctx.locations.map((l) => [key(l.name), l]));

  // Which columns are places, worked out from the headings against the places
  // that actually exist. A column called "store_was_negative" is not a room.
  const placeCols: { index: number; locationId: string; locationName: string }[] = [];
  const ignored: string[] = [];
  heading.forEach((h, i) => {
    if (i === nameAt || key(h) === 'unit' || h === '') return;
    const place = placeByName.get(key(h)) ?? placeByName.get(key(h.replace(/_/g, ' ')));
    if (place) placeCols.push({ index: i, locationId: place.$id, locationName: place.name });
    else ignored.push(h);
  });

  if (placeCols.length === 0) {
    problems.push({
      line: 1,
      message: 'None of the columns match a place you have set up. '
        + `Places available: ${ctx.locations.map((l) => l.name).join(', ') || 'none yet'}.`,
    });
    return { ...empty, ignoredColumns: ignored };
  }

  const out: LevelRow[] = [];
  const unknown: string[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const line = r + 1;
    if (row.every((cell) => clean(cell) === '')) continue;

    const name = clean(row[nameAt]);
    if (!name) { problems.push({ line, message: 'No name on this row.' }); continue; }

    const ingredient = byName.get(key(name));
    if (!ingredient) {
      // Named rather than counted, and NOT a hard failure for the whole file:
      // a stock export routinely carries things the bar does not stock, and
      // refusing the lot over one of them would be refusing the useful part.
      unknown.push(name);
      problems.push({
        line,
        message: `"${name}" is not one of your bottles or mixers. Add it first, or take the row out.`,
      });
      continue;
    }

    const levels: LevelRow['levels'] = [];
    let bad = false;
    for (const col of placeCols) {
      const text = clean(row[col.index]);
      // Blank leaves that place alone. Nought is a real answer and empties it,
      // which is the same distinction the count sheets draw: a blank cell is
      // somebody not saying, and nought is somebody saying none.
      if (text === '') continue;
      const qty = Number(text);
      if (!Number.isFinite(qty)) {
        problems.push({ line, message: `${name}: "${text}" under ${col.locationName} is not a number.` });
        bad = true;
        break;
      }
      if (qty < 0) {
        problems.push({
          line,
          message: `${name}: ${col.locationName} cannot hold less than none. `
            + 'A negative in a stock export usually means sales recorded against stock that was never booked in — '
            + 'worth fixing at the source rather than importing.',
        });
        bad = true;
        break;
      }
      levels.push({ locationId: col.locationId, locationName: col.locationName, qty });
    }

    if (bad || levels.length === 0) continue;
    out.push({ ingredientId: ingredient.$id, name: ingredient.name, levels, line });
  }

  return {
    rows: out,
    problems,
    matchedPlaces: placeCols.map((c) => c.locationName),
    ignoredColumns: ignored,
    unknownItems: unknown,
  };
}

/** What the import will come to, for showing before it is run. */
export function levelTotals(rows: LevelRow[]): { place: string; items: number; units: number }[] {
  const by = new Map<string, { items: number; units: number }>();
  for (const row of rows) {
    for (const l of row.levels) {
      const at = by.get(l.locationName) ?? { items: 0, units: 0 };
      by.set(l.locationName, { items: at.items + 1, units: at.units + l.qty });
    }
  }
  return [...by.entries()].map(([place, v]) => ({ place, ...v }));
}
