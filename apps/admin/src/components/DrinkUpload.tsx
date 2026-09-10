import { Badge, Notice } from '@snpos/ui';
import { formatMoney, readDrinkImport, importDrinks, DRINK_COLUMNS, DRINK_HEADINGS, DRINK_TEMPLATE_ROWS } from '@snpos/core';
import type { Settings, Module, DrinkImportResult } from '@snpos/core';
import { ImportDialog } from './ImportDialog';

/**
 * A bar's drinks list from a spreadsheet: one row per drink, or several rows
 * sharing a name for a cocktail, one line per thing that comes off the shelf.
 */
export function DrinkUpload({
  categories, ingredients, existing, settings, module = 'bar', onClose, onDone,
}: {
  categories: { $id: string; name: string }[];
  ingredients: { $id: string; name: string }[];
  existing: { $id: string; name: string }[];
  settings: Settings;
  module?: Module;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const decimals = settings.currency_decimals ?? 2;
  const money = (n: number) => formatMoney(n, settings);

  return (
    <ImportDialog<DrinkImportResult>
      title="Upload a drinks list"
      intro={<p style={{ marginTop: 0 }}>
        A spreadsheet saved as CSV. One row per drink, or several rows sharing a name for a cocktail — one line
        per thing that comes off the shelf. Nothing is written until you have seen what was understood.
      </p>}
      template={{ name: 'drinks-template', headings: DRINK_HEADINGS, rows: DRINK_TEMPLATE_ROWS }}
      columns={DRINK_COLUMNS}
      read={(grid) => readDrinkImport(grid, { categories, ingredients, existing, decimals })}
      problems={(r) => r.problems}
      count={(r) => r.drinks.length}
      action={(n) => (n ? `Save ${n}` : 'Save')}
      body={(r) => (
        <>
          <Notice tone="ok">
            <strong>{r.drinks.length} drink{r.drinks.length === 1 ? '' : 's'} read</strong>
            {r.recipeLines > 0 && `, with ${r.recipeLines} recipe line${r.recipeLines === 1 ? '' : 's'}`}.
          </Notice>
          {r.newCategories.length > 0 && (
            /* Said before it happens. Creating a category is a small thing and
               a surprising one, and "why is there a category called Clasics"
               is a question a typo asks a week later. */
            <Notice tone="warn">
              {r.newCategories.length} new categor{r.newCategories.length === 1 ? 'y' : 'ies'} will be created:{' '}
              {r.newCategories.join(', ')}. Check the spelling.
            </Notice>
          )}
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Drink</th><th>Category</th><th className="num">Price</th><th>Comes off the shelf</th><th /></tr></thead>
              <tbody>
                {r.drinks.map((d) => (
                  <tr key={d.name}>
                    <td style={{ fontWeight: 550 }}>{d.name}</td>
                    <td className="dim small">{d.categoryName}{!d.categoryId && <Badge tone="warn"> new</Badge>}</td>
                    <td className="num">{money(d.price)}</td>
                    <td className="small dim">
                      {d.recipe.length === 0 ? <span>nothing — sold as it comes</span> : d.recipe.map((x) => `${x.qtyPerUnit} × ${x.ingredientName}`).join(', ')}
                    </td>
                    <td>{d.updates ? <Badge tone="warn">updates</Badge> : <Badge tone="ok">new</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.drinks.some((d) => d.updates && d.recipe.length > 0) && (
            <p className="small dim">
              An updated drink&rsquo;s recipe is replaced, not added to. A file saying what is in a cocktail now is
              somebody correcting it, and merging the old lines in would leave two measures pouring where you typed one.
            </p>
          )}
        </>
      )}
      write={async (r) => {
        const result = await importDrinks({ drinks: r.drinks, existing, module });
        await onDone(`${result.drinks} drink${result.drinks === 1 ? '' : 's'} added` + (result.updated ? `, ${result.updated} updated` : ''));
        return (
          <>
            <Notice tone="ok">
              <strong>{result.drinks} drink{result.drinks === 1 ? '' : 's'}</strong>
              {result.updated > 0 && `, ${result.updated} updated`}
              {result.categories > 0 && `, in ${result.categories} new categor${result.categories === 1 ? 'y' : 'ies'}`}.
            </Notice>
            {result.recipeLines > 0 && (
              <p className="small dim">
                {result.recipeLines} recipe line{result.recipeLines === 1 ? '' : 's'} written. Those come off the
                shelf as each drink is paid for, so the bottles move during service rather than at the end of it.
              </p>
            )}
          </>
        );
      }}
      onClose={onClose}
    />
  );
}
