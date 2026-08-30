import { useEffect, useMemo, useState } from 'react';
import { Button, Card, MenuGrid } from '@snpos/ui';
import {
  listAll, marginOf, menuEngineering, whatToActOn, soldAtALoss,
  QUADRANT_MEANING, quadrantLabel,
  type MenuRow, type DishTrade, type CostedItem,
} from '@snpos/core';

/**
 * Which dishes earn their place.
 *
 * The rest of the Reports page answers "what happened": takings, covers,
 * busiest hours. This answers "so what": every dish measured against what the
 * rest of the menu manages, which is the only comparison that turns a figure
 * into a decision. A margin of 38% is neither good nor bad until you know the
 * kitchen's other dishes return 61%.
 *
 * The arithmetic is in `@snpos/core/menu-engineering`, tested without a
 * database, because somebody is going to take a dish off the menu over it.
 * This file only fetches, formats and lays out.
 */

interface Recipe { $id: string; menu_item_id?: string; ingredient_id: string; qty_per_unit: number; wastage_bp: number }
interface Ingredient { $id: string; base_unit_cost: number }
interface Item { $id: string; name: string; module?: string }

export function MenuEngineeringPanel({
  sold,
  money,
  side,
}: {
  /** Aggregated paid, non-void lines for the visible period. */
  sold: DishTrade[];
  money: (n: number) => string;
  side: string;
}) {
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  // Loaded once and reused. Costing forty dishes by asking per dish is forty
  // round trips to draw one table.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [r, i, m] = await Promise.all([
          listAll<Recipe>('recipes'),
          listAll<Ingredient>('ingredients'),
          listAll<Item>('menu_items'),
        ]);
        if (!alive) return;
        setRecipes(r); setIngredients(i); setItems(m);
      } catch (e) {
        if (alive) setFailed(e instanceof Error ? e.message : 'Could not load the recipes.');
      }
    })();
    return () => { alive = false; };
  }, []);

  const costs = useMemo<CostedItem[]>(() => {
    if (!recipes) return [];
    const byItem = new Map<string, Recipe[]>();
    for (const r of recipes) {
      if (!r.menu_item_id) continue;   // add-on recipes cost an option, not a dish
      const list = byItem.get(r.menu_item_id) ?? [];
      list.push(r);
      byItem.set(r.menu_item_id, list);
    }
    return items.map((it) => {
      const lines = (byItem.get(it.$id) ?? []).map((r) => ({
        ingredientId: r.ingredient_id, qtyPerUnit: r.qty_per_unit, wastageBp: r.wastage_bp,
      }));
      // marginOf is asked for the cost only; the price it is given here is
      // irrelevant, because the analysis uses what was actually taken per
      // plate rather than the list price.
      const m = marginOf(0, lines, ingredients);
      return { menuItemId: it.$id, unitCost: m.cost, unknown: m.unknown };
    });
  }, [recipes, ingredients, items]);

  const analysis = useMemo(() => menuEngineering(sold, costs), [sold, costs]);

  if (failed) return <Card title="Which dishes earn their place"><p className="dim">{failed}</p></Card>;
  if (!recipes) return <Card title="Which dishes earn their place"><p className="dim">Working out what everything costs…</p></Card>;

  const { benchmarks, totals, uncosted } = analysis;
  const act = whatToActOn(analysis);
  const losses = soldAtALoss(analysis);
  const shown = showAll ? analysis.rows : analysis.rows.slice(0, 12);

  return (
    <Card title="Which dishes earn their place">
      <p className="dim" style={{ marginTop: 0 }}>
        Every dish on two axes: how often it sold, and what was left after the recipe.
        The dashed lines are this menu&rsquo;s own averages, so a dot&rsquo;s corner is the decision.
        {side !== 'all' ? ' Limited to the side you are looking at.' : ''}
      </p>

      {analysis.tooThin ? (
        <p className="notice notice-info">{analysis.tooThin}</p>
      ) : (
        <>
          {/* The headline figure, and it is deliberately the prize rather than
              a total. "You took 40,000" is on the page already; "8,600 of it is
              sitting in dishes priced below what the rest of the menu manages"
              is the sentence that starts a conversation. */}
          <div className="stat-row">
            <Stat label="Kept, all dishes" value={money(totals.contribution)} />
            <Stat label="Average plate keeps" value={money(benchmarks!.contribution)} />
            <Stat
              label="On the table"
              value={money(totals.upside)}
              note={`if every dish matched the average`}
            />
            <Stat label="Costed dishes" value={`${benchmarks!.items}`} note={`${totals.plates} plates`} />
          </div>

          <MenuGrid rows={analysis.rows} benchmarks={benchmarks!} money={money} />

          {losses.length > 0 && (
            <div className="notice notice-err" style={{ marginTop: '1rem' }}>
              <strong>{losses.length} {losses.length === 1 ? 'dish is' : 'dishes are'} selling below cost.</strong>{' '}
              Every plate of {losses.map((r) => r.name).join(', ')} loses money, so a busy night makes it worse.
              {' '}That is {money(Math.abs(losses.reduce((t, r) => t + r.totalContribution, 0)))} over this period.
            </div>
          )}

          {act.length > 0 && (
            <>
              <h4 style={{ margin: '1.25rem 0 0.4rem' }}>Worth an afternoon, in this order</h4>
              <p className="dim" style={{ margin: '0 0 0.6rem' }}>
                Ranked by what closing the gap is worth at the volume actually sold — not by
                which margin looks worst. A dish twenty points down that sells twice a week is
                a smaller prize than one five points down that sells sixty times.
              </p>
              <ol className="act-list">
                {act.map((r) => (
                  <li key={r.menuItemId}>
                    <strong>{r.name}</strong> — {money(r.upside)} on the table.{' '}
                    <span className="dim">
                      Keeps {money(r.contribution)} a plate against {money(benchmarks!.contribution)};
                      sold {r.qty} times. {QUADRANT_MEANING[r.quadrant!]}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}

          {/* The table is not an afterthought: it is how this chart is read by
              anybody who cannot separate the colours, and how anybody at all
              reads the exact figures. */}
          <h4 style={{ margin: '1.25rem 0 0.4rem' }}>Every costed dish</h4>
          <div className="table-wrap">
            <table className="data menu-table">
              <thead>
                <tr>
                  <th>Dish</th><th className="num">Sold</th><th className="num">Each</th>
                  <th className="num">Costs</th><th className="num">Keeps</th><th className="num">Margin</th>
                  <th className="num">Kept in total</th><th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => <Row key={r.menuItemId} r={r} money={money} />)}
              </tbody>
            </table>
          </div>
          {analysis.rows.length > 12 && (
            <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer' : `Show all ${analysis.rows.length}`}
            </Button>
          )}
        </>
      )}

      {uncosted.rows.length > 0 && (
        <div className="notice notice-info" style={{ marginTop: '1rem' }}>
          <strong>
            {uncosted.rows.length} {uncosted.rows.length === 1 ? 'dish has' : 'dishes have'} no recipe
            {uncosted.revenueBp > 0 && <> — {(uncosted.revenueBp / 100).toFixed(0)}% of the takings</>}.
          </strong>{' '}
          They are left out of everything above rather than counted as costing nothing, which would
          have made them look like the most profitable things you sell and pulled the average up for
          everyone else. Add a recipe under Menu items and they join the grid:{' '}
          {uncosted.rows.slice(0, 6).map((r) => r.name).join(', ')}
          {uncosted.rows.length > 6 ? `, and ${uncosted.rows.length - 6} more` : ''}.
        </div>
      )}
    </Card>
  );
}

function Row({ r, money }: { r: MenuRow; money: (n: number) => string }) {
  return (
    <tr>
      <td>{r.name}</td>
      <td className="num">{r.qty}</td>
      <td className="num">{money(r.unitPrice)}</td>
      <td className="num">{money(r.unitCost)}</td>
      <td className={`num${r.contribution < 0 ? ' bad' : ''}`}>{money(r.contribution)}</td>
      <td className={`num${r.contribution < 0 ? ' bad' : ''}`}>{(r.marginBp / 100).toFixed(0)}%</td>
      <td className={`num${r.totalContribution < 0 ? ' bad' : ''}`}>{money(r.totalContribution)}</td>
      <td><span className={`q-tag q-${r.quadrant}`}>{quadrantLabel(r.quadrant)}</span></td>
    </tr>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}
