/**
 * Booking a drinks list in from a spreadsheet, recipes and all.
 *
 * A bar opening has sixty lines on its board and a dozen cocktails behind it,
 * and the alternative to this is somebody typing them for an afternoon. The
 * part that makes it worth doing properly is the recipe: a cocktail without
 * one still sells, still takes money, and takes nothing off the shelf — so a
 * bar that imported its list and not its recipes would count perfectly and
 * find a variance every night, with the gin apparently pouring itself.
 *
 * One row per ingredient of a drink, sharing the drink's name, which is the
 * same shape the craft stock upload uses for sizes and for the same reason: a
 * spreadsheet is a flat grid, and a nested one is a spreadsheet nobody can
 * edit in the app they actually have.
 *
 * Pure. Every judgement about what a row says is made here and can be checked
 * without a database.
 */

import type { ImportColumn, ImportProblem } from './stock-import';

export const DRINK_COLUMNS: ImportColumn[] = [
  { key: 'name', heading: 'name', required: true,
    help: 'What the drink is called. Rows sharing a name become one drink with several ingredients.' },
  { key: 'category', heading: 'category', required: true,
    help: 'Beers, Spirits, Cocktails. Created for you if it does not exist yet.' },
  { key: 'price', heading: 'price',
    help: 'What it sells for. Needed once per drink; leave it blank on the extra ingredient rows.' },
  { key: 'description', heading: 'description', help: 'Optional. Shown to customers on the menu.' },
  { key: 'prepMinutes', heading: 'prep_minutes',
    help: 'How long it takes to make. Blank means 2, which is about right for a poured drink.' },
  { key: 'ingredient', heading: 'ingredient',
    help: 'What comes off the shelf. Must already exist under Bottles & mixers. Blank for a drink with no recipe.' },
  { key: 'quantity', heading: 'ingredient_qty',
    help: 'How much of it, in that ingredient\'s own unit. 0.05 of a bottle, 50 of ml, whichever you set it up in.' },
  { key: 'wastage', heading: 'wastage_percent',
    help: 'Spillage and over-pour, as a percentage. Blank means none. 5 is a sensible starting point for spirits.' },
  { key: 'barcode', heading: 'barcode', help: 'Optional. Scanned at the till.' },
];

export const DRINK_HEADINGS = DRINK_COLUMNS.map((c) => c.heading);

/**
 * Filled in, showing both shapes.
 *
 * A bottled beer, which is one row and no recipe; and a cocktail, which is
 * three rows sharing a name. The first question anybody has is what a row is
 * supposed to look like, and an empty grid answers it by making them guess.
 */
export const DRINK_TEMPLATE_ROWS: string[][] = [
  ['Club Beer', 'Beers', '15.00', 'Cold, 625ml', '1', '', '', '', ''],
  ['Gin and tonic', 'Cocktails', '35.00', 'Double, with lime', '2', 'Gin', '0.05', '5', ''],
  ['Gin and tonic', 'Cocktails', '', '', '', 'Tonic water', '1', '', ''],
  ['Gin and tonic', 'Cocktails', '', '', '', 'Lime', '0.25', '', ''],
];

export interface DrinkRecipeLine {
  ingredientId: string;
  ingredientName: string;
  qtyPerUnit: number;
  wastageBp: number;
  line: number;
}

export interface ImportDrink {
  name: string;
  categoryName: string;
  /** Empty when the category does not exist yet and will be created. */
  categoryId: string;
  description: string;
  price: number;
  prepMinutes: number;
  barcode: string;
  recipe: DrinkRecipeLine[];
  /** True when a drink of this name already exists and will be updated. */
  updates: boolean;
  lines: number[];
}

export interface DrinkImportContext {
  categories: { $id: string; name: string }[];
  ingredients: { $id: string; name: string }[];
  existing: { $id: string; name: string }[];
  decimals: number;
}

export interface DrinkImportResult {
  drinks: ImportDrink[];
  problems: ImportProblem[];
  /** Categories the file mentions that do not exist yet. Created on save. */
  newCategories: string[];
  recipeLines: number;
}

const clean = (s?: string) => (s ?? '').trim();
/** Loose matching: case and spacing are not what somebody meant to get wrong. */
const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

function money(text: string, decimals: number): number | null {
  const cleaned = text.replace(/[^0-9.,-]/g, '').replace(',', '.');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 10 ** decimals);
}

/**
 * Read the file, and say what is wrong with it rather than with the person who
 * wrote it. Every problem carries its line number.
 */
export function readDrinkImport(rows: string[][], ctx: DrinkImportContext): DrinkImportResult {
  const problems: ImportProblem[] = [];

  if (rows.length === 0) {
    return { drinks: [], problems: [{ line: 1, message: 'The file is empty.' }], newCategories: [], recipeLines: 0 };
  }

  const heading = rows[0].map((h) => key(clean(h)));
  const index = new Map(DRINK_COLUMNS.map((c) => [c.key, heading.indexOf(c.heading)]));

  for (const c of DRINK_COLUMNS) {
    if (c.required && (index.get(c.key) ?? -1) < 0) {
      problems.push({ line: 1, message: `The heading row has no "${c.heading}" column.` });
    }
  }
  if (problems.length > 0) return { drinks: [], problems, newCategories: [], recipeLines: 0 };

  const at = (row: string[], k: string) => {
    const i = index.get(k) ?? -1;
    return i < 0 ? '' : clean(row[i]);
  };

  const categoryByName = new Map(ctx.categories.map((c) => [key(c.name), c]));
  const ingredientByName = new Map(ctx.ingredients.map((i) => [key(i.name), i]));
  const existingByName = new Map(ctx.existing.map((e) => [key(e.name), e]));

  const drafts = new Map<string, ImportDrink>();
  const newCategories = new Set<string>();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const line = r + 1;
    if (row.every((cell) => clean(cell) === '')) continue;

    const name = at(row, 'name');
    const categoryName = at(row, 'category');
    if (!name) { problems.push({ line, message: 'No name. Every row has to say which drink it belongs to.' }); continue; }
    if (!categoryName) { problems.push({ line, message: `${name} has no category.` }); continue; }

    const k = key(name);
    let draft = drafts.get(k);

    if (!draft) {
      const category = categoryByName.get(key(categoryName));
      if (!category) newCategories.add(categoryName);

      const priceText = at(row, 'price');
      const price = priceText ? money(priceText, ctx.decimals) : null;
      if (priceText && price === null) {
        problems.push({ line, message: `${name}: "${priceText}" is not a price.` });
        continue;
      }
      if (price === null) {
        problems.push({ line, message: `${name} has no price. The first row of a drink needs one.` });
        continue;
      }

      const prepText = at(row, 'prepMinutes');
      const prep = prepText ? Number(prepText) : 2;
      if (!Number.isFinite(prep) || prep < 0) {
        problems.push({ line, message: `${name}: "${prepText}" is not a number of minutes.` });
        continue;
      }

      draft = {
        name,
        categoryName,
        categoryId: category?.$id ?? '',
        description: at(row, 'description'),
        price,
        prepMinutes: Math.round(prep),
        barcode: at(row, 'barcode'),
        recipe: [],
        /*
          A drink already on the board is an update, not a duplicate.

          The second use of this screen is always "we changed the prices", and
          refusing the row would make the file useless for it. Which rows are
          corrections is shown before anything is written.
        */
        updates: existingByName.has(k),
        lines: [],
      };
      drafts.set(k, draft);
    }

    draft.lines.push(line);

    const ingredientName = at(row, 'ingredient');
    if (!ingredientName) continue;

    const ingredient = ingredientByName.get(key(ingredientName));
    if (!ingredient) {
      problems.push({
        line,
        message: `"${ingredientName}" is not one of your bottles or mixers. Add it under Bottles & mixers first, `
          + 'or correct the spelling.',
      });
      continue;
    }

    const qtyText = at(row, 'quantity');
    const qty = Number(qtyText);
    if (!qtyText || !Number.isFinite(qty) || qty <= 0) {
      problems.push({
        line,
        message: `${name} lists ${ingredientName} but not how much of it. A recipe line with no quantity `
          + 'takes nothing off the shelf, which is the same as not having one.',
      });
      continue;
    }

    const wastageText = at(row, 'wastage');
    const wastage = wastageText ? Number(wastageText.replace('%', '')) : 0;
    if (!Number.isFinite(wastage) || wastage < 0 || wastage > 100) {
      problems.push({ line, message: `${name}: "${wastageText}" is not a percentage between 0 and 100.` });
      continue;
    }

    // The same ingredient twice in one drink is almost always two rows meaning
    // one, and adding them would silently double the pour.
    if (draft.recipe.some((x) => x.ingredientId === ingredient.$id)) {
      problems.push({
        line,
        message: `${name} lists ${ingredientName} twice. Put the whole amount on one row.`,
      });
      continue;
    }

    draft.recipe.push({
      ingredientId: ingredient.$id,
      ingredientName: ingredient.name,
      qtyPerUnit: qty,
      wastageBp: Math.round(wastage * 100),
      line,
    });
  }

  const drinks = [...drafts.values()];
  return {
    drinks,
    problems,
    newCategories: [...newCategories],
    recipeLines: drinks.reduce((n, d) => n + d.recipe.length, 0),
  };
}
