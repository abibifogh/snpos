import { useState } from 'react';
import { Badge, Button, Modal, Notice } from '@snpos/ui';
import {
  parseCsv, toCsv, downloadCsv, formatMoney,
  readDrinkImport, importDrinks, DRINK_COLUMNS, DRINK_HEADINGS, DRINK_TEMPLATE_ROWS,
} from '@snpos/core';
import type { Settings, Module, DrinkImportResult } from '@snpos/core';
import { humanError } from '../lib';

/**
 * A drinks list from a spreadsheet, recipes and all.
 *
 * A bar opening has sixty lines on its board and a dozen cocktails behind it.
 * The part that makes this worth building properly is the recipe: a cocktail
 * without one still sells, still takes money, and takes nothing off the shelf,
 * so a bar that imported its list and not its recipes would count perfectly
 * and find a variance every night with the gin apparently pouring itself.
 *
 * Three steps, and the middle one does the work — including saying which
 * categories will be created and which drinks are corrections to something
 * already on the board.
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
  const [read, setRead] = useState<DrinkImportResult | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<
    { drinks: number; updated: number; categories: number; recipeLines: number } | null
  >(null);

  const decimals = settings.currency_decimals ?? 2;
  const money = (n: number) => formatMoney(n, settings);

  const template = () => downloadCsv('drinks-template', toCsv(DRINK_HEADINGS, DRINK_TEMPLATE_ROWS));

  const take = async (f: File) => {
    setError(null);
    setRead(null);
    setFileName(f.name);
    try {
      setRead(readDrinkImport(parseCsv(await f.text()), { categories, ingredients, existing, decimals }));
    } catch (e) {
      setError(humanError(e));
    }
  };

  const write = async () => {
    if (!read || read.problems.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await importDrinks({ drinks: read.drinks, existing, module });
      setOutcome(result);
      await onDone(
        `${result.drinks} drink${result.drinks === 1 ? '' : 's'} added`
        + (result.updated ? `, ${result.updated} updated` : ''),
      );
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  if (outcome) {
    return (
      <Modal wide title="Uploaded" onClose={onClose}
        footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <Notice tone="ok">
          <strong>{outcome.drinks} drink{outcome.drinks === 1 ? '' : 's'}</strong>
          {outcome.updated > 0 && `, ${outcome.updated} updated`}
          {outcome.categories > 0 && `, in ${outcome.categories} new categor${outcome.categories === 1 ? 'y' : 'ies'}`}.
        </Notice>
        {outcome.recipeLines > 0 && (
          <p className="small dim">
            {outcome.recipeLines} recipe line{outcome.recipeLines === 1 ? '' : 's'} written. Those come off the
            shelf as each drink is paid for, so the bottles move during service rather than at the end of it.
          </p>
        )}
      </Modal>
    );
  }

  const problems = read?.problems ?? [];

  return (
    <Modal
      wide
      title="Upload a drinks list"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void write()}
            loading={busy}
            disabled={!read || problems.length > 0 || read.drinks.length === 0}
          >
            {read && problems.length === 0 && read.drinks.length > 0 ? `Save ${read.drinks.length}` : 'Save'}
          </Button>
        </>
      }
    >
      {error && <div style={{ marginBottom: '0.9rem' }}><Notice>{error}</Notice></div>}

      <p className="small dim" style={{ marginTop: 0 }}>
        A spreadsheet saved as CSV. One row per drink, or several rows sharing a name for a cocktail — one line
        per thing that comes off the shelf. Nothing is written until you have seen what was understood.
      </p>

      <div className="row" style={{ gap: '0.5rem', marginBottom: '0.9rem', flexWrap: 'wrap' }}>
        <Button onClick={template}>Download the template</Button>
        <label className="btn" style={{ cursor: 'pointer' }}>
          Choose a file
          <input
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void take(f); }}
          />
        </label>
        {fileName && <span className="small dim" style={{ alignSelf: 'center' }}>{fileName}</span>}
      </div>

      {!read && (
        <>
          <h3 style={{ margin: '1.1rem 0 0.35rem', fontSize: '0.95rem' }}>What each column is for</h3>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Column</th><th>What to write in it</th></tr></thead>
              <tbody>
                {DRINK_COLUMNS.map((c) => (
                  <tr key={c.key}>
                    <td><code>{c.heading}</code>{c.required && <Badge tone="warn"> needed</Badge>}</td>
                    <td className="small dim">{c.help}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {problems.length > 0 && (
        <>
          <Notice>
            {/* Nothing is written while anything is wrong. Half a list is worse
                than none: the bar would not know where it stopped. */}
            <strong>{problems.length} thing{problems.length === 1 ? '' : 's'} to fix.</strong> Nothing has been
            saved. Correct these in the file and choose it again.
          </Notice>
          <ul className="small">
            {problems.slice(0, 20).map((p, i) => <li key={i}>Line {p.line}: {p.message}</li>)}
            {problems.length > 20 && <li className="dim">and {problems.length - 20} more</li>}
          </ul>
        </>
      )}

      {read && problems.length === 0 && (
        <>
          <Notice tone="ok">
            <strong>{read.drinks.length} drink{read.drinks.length === 1 ? '' : 's'} read</strong>
            {read.recipeLines > 0 && `, with ${read.recipeLines} recipe line${read.recipeLines === 1 ? '' : 's'}`}.
          </Notice>
          {read.newCategories.length > 0 && (
            /* Said before it happens. Creating a category is a small thing and
               a surprising one, and "why is there a category called Clasics"
               is a question a typo asks a week later. */
            <Notice tone="warn">
              {read.newCategories.length} new categor{read.newCategories.length === 1 ? 'y' : 'ies'} will be
              created: {read.newCategories.join(', ')}. Check the spelling.
            </Notice>
          )}
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Drink</th><th>Category</th><th className="num">Price</th><th>Comes off the shelf</th><th /></tr>
              </thead>
              <tbody>
                {read.drinks.map((d) => (
                  <tr key={d.name}>
                    <td style={{ fontWeight: 550 }}>{d.name}</td>
                    <td className="dim small">
                      {d.categoryName}
                      {!d.categoryId && <Badge tone="warn"> new</Badge>}
                    </td>
                    <td className="num">{money(d.price)}</td>
                    <td className="small dim">
                      {d.recipe.length === 0
                        ? <span>nothing — sold as it comes</span>
                        : d.recipe.map((r) => `${r.qtyPerUnit} × ${r.ingredientName}`).join(', ')}
                    </td>
                    <td>{d.updates ? <Badge tone="warn">updates</Badge> : <Badge tone="ok">new</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {read.drinks.some((d) => d.updates && d.recipe.length > 0) && (
            <p className="small dim">
              An updated drink&rsquo;s recipe is replaced, not added to. A file saying what is in a cocktail now is
              somebody correcting it, and merging the old lines in would leave two measures pouring where you
              typed one.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
