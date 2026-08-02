import { Button, Field, Input, Notice, Select } from '@snpos/ui';
import { formatMoney, recipeCost } from '@snpos/core';
import type { Ingredient, Recipe, Settings } from '@snpos/core';

/** A recipe line being edited. Quantities are held as typed text. */
export interface DraftRecipe {
  $id?: string;
  ingredient_id: string;
  qtyText: string;
  wastageText: string;
}

export const draftFrom = (r: Recipe): DraftRecipe => ({
  $id: r.$id,
  ingredient_id: r.ingredient_id,
  qtyText: String(r.qty_per_unit),
  wastageText: String((r.wastage_bp || 0) / 100),
});

/**
 * What one portion of a dish is made from.
 *
 * This is the link between the menu and the store room, and until it exists
 * nothing connects the two: selling a plate of jollof cannot take rice off the
 * shelf if nobody has said how much rice is in a plate of jollof. Everything
 * downstream — what a dish costs you, what stock you should have left at close,
 * where the gap between should-have and actually-have is — is built on these
 * numbers.
 *
 * It is optional. A bottle of Coke you buy in and sell on needs no recipe.
 */
export function RecipeEditor({
  ingredients,
  draft,
  setDraft,
  price,
  settings,
}: {
  ingredients: Ingredient[];
  draft: DraftRecipe[];
  setDraft: (f: (d: DraftRecipe[]) => DraftRecipe[]) => void;
  /** The dish's selling price, for showing the margin. */
  price: number;
  settings: Settings | null;
}) {
  const setLine = (i: number, patch: Partial<DraftRecipe>) =>
    setDraft((d) => d.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));

  const unitOf = (id: string) => ingredients.find((x) => x.$id === id)?.unit ?? '';

  const cost = recipeCost(
    draft
      .filter((d) => d.ingredient_id && Number(d.qtyText) > 0)
      .map((d) => ({
        $id: d.$id ?? '',
        $createdAt: '',
        $updatedAt: '',
        ingredient_id: d.ingredient_id,
        qty_per_unit: Number(d.qtyText),
        wastage_bp: Math.round(Number(d.wastageText || 0) * 100),
      })),
    ingredients,
  );
  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));
  const margin = price > 0 ? ((price - cost) / price) * 100 : 0;

  return (
    <Field
      label="What it's made from"
      hint={
        ingredients.length === 0
          ? 'No ingredients set up yet. Add them under Stock, then come back and say how much of each goes into this dish.'
          : 'How much of each ingredient one portion uses. This is what lets a sale take stock off the shelf, and what tells you the dish costs you.'
      }
    >
      {draft.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Ingredient</th>
                <th style={{ width: '7.5rem' }}>Per portion</th>
                <th style={{ width: '6.5rem' }}>Wastage %</th>
                <th style={{ width: '2.5rem' }} />
              </tr>
            </thead>
            <tbody>
              {draft.map((d, i) => (
                <tr key={i}>
                  <td>
                    <Select value={d.ingredient_id} onChange={(e) => setLine(i, { ingredient_id: e.target.value })}>
                      <option value="">— choose —</option>
                      {ingredients.map((x) => <option key={x.$id} value={x.$id}>{x.name}</option>)}
                    </Select>
                  </td>
                  <td>
                    <div className="row" style={{ gap: '0.3rem' }}>
                      <Input
                        type="number"
                        step="any"
                        min="0"
                        value={d.qtyText}
                        onChange={(e) => setLine(i, { qtyText: e.target.value })}
                      />
                      <span className="small dim">{unitOf(d.ingredient_id)}</span>
                    </div>
                  </td>
                  <td>
                    <Input
                      type="number"
                      step="any"
                      min="0"
                      value={d.wastageText}
                      onChange={(e) => setLine(i, { wastageText: e.target.value })}
                    />
                  </td>
                  <td className="num">
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      onClick={() => setDraft((x) => x.filter((_, idx) => idx !== i))}
                    >
                      ✕
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="row" style={{ marginTop: '0.5rem' }}>
        <Button
          size="sm"
          type="button"
          disabled={ingredients.length === 0}
          onClick={() => setDraft((d) => [...d, { ingredient_id: '', qtyText: '', wastageText: '0' }])}
        >
          Add ingredient
        </Button>
        {cost > 0 && (
          <span className="small dim">
            Costs you about {money(cost)} a portion
            {price > 0 && ` · ${margin.toFixed(0)}% margin at ${money(price)}`}
          </span>
        )}
      </div>

      {draft.length > 0 && (
        <p className="hint" style={{ marginTop: '0.5rem' }}>
          Wastage covers what is bought but never reaches the plate — trim, peel, spillage. 10% on an onion means a
          portion consumes a tenth more than it uses.
        </p>
      )}

      {cost > 0 && price > 0 && cost >= price && (
        <div style={{ marginTop: '0.5rem' }}>
          <Notice>
            The ingredients cost as much as the dish sells for. Check the quantities and the unit costs under Stock —
            usually one of them is out by a factor of a thousand, grams entered where kilos were meant.
          </Notice>
        </div>
      )}
    </Field>
  );
}
