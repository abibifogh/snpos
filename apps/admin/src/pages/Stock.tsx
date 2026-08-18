import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Toggle, Badge, useToast, ViewTabs} from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import {
  formatMoney, parseMoney, toInput, levelOf, saveDropping,
  purchasesFor, priceHistory, priceMoveNote, packProblem, hasPack, packSize,
  matches, sortStock, stockState, STOCK_SORTS, STOCK_STATES,
} from '@snpos/core';
import type { StockSort, StockState, Module, Ingredient, Recipe, MenuItem, Doc, Settings, PurchaseRow } from '@snpos/core';
import { KeyedListManager, useKeyedList, nameForKey } from '../components/KeyedList';
import { StockImport } from '../components/StockImport';
import { useSession } from '../session';

interface Supplier extends Doc { venue_id: string; name: string; contact?: string; phone?: string; email?: string; active: boolean }

/**
 * Every unit the database accepts, which is not the same as every unit a
 * kitchen uses.
 *
 * This list used to stop at "pack", from before the bar existed. The database
 * has taken bottles, cases, shots and centilitres since — so a spirit imported
 * as shots could be stored but never chosen here, and opening the ingredient
 * to change anything else showed an empty unit box that would write back a
 * wrong one on save.
 *
 * Kept in the same order as the enum in scripts/schema.mjs, which is the one
 * that decides what can actually be saved.
 */
const UNITS = ['g', 'kg', 'ml', 'l', 'each', 'pack', 'bottle', 'case', 'shot', 'cl'];

/**
 * How often somebody walks past this and writes a number down.
 *
 * Two booleans underneath — one saying whether it is on the shift-end check at
 * all, one saying whether the bar counts it twice a day — but one question on
 * screen, because they are the same question asked at two frequencies and two
 * toggles left nobody sure which won.
 */
type Cadence = 'shift' | 'close' | 'never';

const countCadence = (i: { counted_at_close?: boolean; count_each_shift?: boolean }): Cadence => {
  if (i.counted_at_close === false) return 'never';
  return i.count_each_shift ? 'shift' : 'close';
};

const cadenceFields = (c: Cadence) => ({
  counted_at_close: c !== 'never',
  // Never means there is no shelf, so it cannot also be counted every shift.
  count_each_shift: c === 'shift',
});

/** The pack's name for a label, before anybody has given it one. */
const plainPack = (name?: string) => {
  const n = (name ?? '').trim();
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : 'One purchase';
};

/** Said with their own numbers in it, so the setting explains itself. */
const packHint = (ing: { unit?: string; pack_name?: string; pack_size?: number }, symbol: string) => {
  const size = Number(ing.pack_size ?? 0);
  const unit = ing.unit ?? 'unit';
  const name = (ing.pack_name ?? '').trim() || 'purchase';
  // The worked example is the house's own: a 750ml bottle poured as 5cl
  // measures is fifteen. A number picked out of the air here is a number
  // somebody copies.
  if (!(size > 1)) return `Leave at 0 if you buy it by the ${unit}. A 750ml bottle poured as 5cl measures would be 15.`;
  return `Buying 1 ${name} adds ${size} ${unit} to stock, and a price of ${symbol}280 a ${name} `
    + `is stored as ${symbol}${(280 / size).toFixed(2)} a ${unit}.`;
};

/**
 * A worked example in the placeholder, chosen to suit the unit.
 *
 * An empty box with the word "guide" over it gets left empty. An empty box
 * showing "OK = 10 pcs or more · Low = under 10 pcs" gets filled in, because
 * the shape of the answer is already there and only the numbers have to be
 * thought about.
 */
const guideExample = (unit?: string) => {
  if (unit === 'kg' || unit === 'g') return 'OK = half a bucket or more · Low = under half';
  if (unit === 'l' || unit === 'ml') return 'OK = 1 bottle or more · Low = under 1 bottle';
  if (unit === 'pack') return 'OK = 3 packs or more · Low = under 3 packs';
  return 'OK = 10 pcs or more · Low = under 10 pcs';
};

/**
 * Ingredients, for whichever side keeps them.
 *
 * A bar's bottles and a kitchen's larder are the same kind of record — a thing
 * on a shelf with a unit, a cost and a level — so they share this screen. What
 * they do not share is each other's lists, which is what `module` is for: a
 * bar counting rice and a kitchen counting gin are both counting somebody
 * else's larder.
 */
export function StockPage({ module = 'kitchen' }: { module?: Module }) {
  const { settings } = useSession();
  const toast = useToast();
  const decimals = settings?.currency_decimals ?? 2;

  const [tab, setTab] = useState<'ingredients' | 'suppliers' | 'categories' | 'packs'>('ingredients');
  const { rows: packKinds, reload: reloadPacks } = useKeyedList('pack_kinds');
  const [ingredients, setIngredients] = useState<Ingredient[] | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [dishes, setDishes] = useState<MenuItem[]>([]);
  const { rows: allCategories } = useKeyedList('ingredient_categories');
  /** This side's groupings only. A bar does not walk a larder of sauces. */
  const categories = (allCategories ?? []).filter((c) => (c.module ?? 'kitchen') === module);
  const { rows: expenseCategories } = useKeyedList('expense_categories');
  const [editing, setEditing] = useState<Partial<Ingredient> | null>(null);
  const [editingSupplier, setEditingSupplier] = useState<Partial<Supplier> | null>(null);
  const [importing, setImporting] = useState(false);
  const [costText, setCostText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  /** Typed as the price of a whole bottle, kept only to fill the per-shot box. */
  const [packCostText, setPackCostText] = useState('');
  const [q, setQ] = useState('');
  const [state, setState] = useState<StockState>('any');
  const [sortBy, setSortBy] = useState<StockSort>('level');

  /**
   * What this side calls the things on its shelves.
   *
   * "Add ingredient" over a page of gin is the same complaint the catalogue
   * page had: a screen written when there were two sides, read by a third.
   */
  const W = module === 'bar'
    ? { title: 'Bottles & mixers', add: 'Add a bottle or mixer' }
    : module === 'craft'
      ? { title: 'Supplies', add: 'Add a supply' }
      : { title: 'Stock', add: 'Add ingredient' };
  /** The ingredient whose purchase history is being read. */
  const [historyFor, setHistoryFor] = useState<Ingredient | null>(null);

  const load = async () => {
    const [i, s, r, d] = await Promise.all([
      listAll<Ingredient>('ingredients'),
      listAll<Supplier>('suppliers'),
      listAll<Recipe>('recipes'),
      listAll<MenuItem>('menu_items'),
    ]);
    // Rows written before the bar existed have no side, and were the
    // kitchen's, which is what they were.
    setIngredients(
      i.filter((x) => (x.module ?? 'kitchen') === module).sort((a, b) => a.name.localeCompare(b.name)),
    );
    setSuppliers(s.sort((a, b) => a.name.localeCompare(b.name)));
    setRecipes(r);
    setDishes(d);
  };
  useEffect(() => { load().catch((e) => setError(humanError(e))); }, []);

  const lowDefaultBp = settings?.low_stock_default_bp ?? 3000;
  /** The stock category for this side, so a delivery is not spending. */
  const defaultStockCategory =
    module === 'bar' ? 'bar_stock' : module === 'craft' ? 'craft_stock' : 'kitchen_stock';

  /**
   * Items whose purchases are not being treated as stock.
   *
   * Anything on a shelf should land on the balance sheet when bought and
   * become a cost when sold. One pointing at an expense category, or at
   * nothing, is written off on arrival instead.
   */
  const needCategory = (ingredients ?? []).filter(
    (i) => i.active && i.counted_at_close !== false && i.expense_category_key !== defaultStockCategory,
  );

  const [pointing, setPointing] = useState(false);
  const stockCategoryName =
    module === 'bar' ? 'Bar stock' : module === 'craft' ? 'Craft stock' : 'Kitchen stock';

  const pointAtStock = async () => {
    /*
      The category has to exist first.

      Pointing an item at a category the database does not have does not fail:
      it falls back to Other expenses, so every delivery is written off exactly
      as before while the screen says it was fixed. Worse than not doing it.
    */
    if (!(expenseCategories ?? []).some((c) => c.key === defaultStockCategory)) {
      setError(
        `"${stockCategoryName}" does not exist yet. Run Provision in GitHub Actions to add it, then do this — `
        + 'without it, purchases would keep landing under Other expenses.',
      );
      return;
    }
    if (!confirm(
      `Point ${needCategory.length} item${needCategory.length === 1 ? '' : 's'} at "${stockCategoryName}"?\n\n`
      + 'Buying them will then add to what the business owns and become a cost as they sell, rather than '
      + 'being written off on the day they arrive. Past entries are not changed.',
    )) return;
    setPointing(true);
    try {
      for (const i of needCategory) {
        await db.updateDocument(DB_ID, 'ingredients', i.$id, { expense_category_key: defaultStockCategory })
          .catch(() => undefined);
      }
      await load();
      toast(`${needCategory.length} pointed at ${stockCategoryName}`);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setPointing(false);
    }
  };

  const archivedCount = (ingredients ?? []).filter((i) => !i.active).length;
  /**
   * Narrowed, then ordered — by default, by what is closest to running out.
   *
   * A stock list ordered by name makes somebody read all of it to find out
   * whether anything needs buying, which is the only question the page is
   * really for.
   */
  const shownIngredients = useMemo(
    () => sortStock(
      (ingredients ?? [])
        .filter((i) => showArchived || i.active)
        .filter((i) => matches(i.name, q))
        .filter((i) => state === 'any' || stockState(i, lowDefaultBp) === state),
      sortBy,
    ),
    [ingredients, showArchived, q, state, sortBy, lowDefaultBp],
  );

  const alerts = useMemo(
    () => (ingredients ?? []).filter((i) => i.active && levelOf(i, lowDefaultBp) !== 'ok'),
    [ingredients, lowDefaultBp],
  );

  /**
   * An ingredient the kitchen has stopped buying.
   *
   * It goes off the count sheet at shift close, off the expense form's item
   * picker and off this list, and it stays on every expense, stock movement
   * and count it already appears in. That last part is the whole point:
   * deleting an ingredient would leave last quarter's food cost with lines
   * that no longer name anything.
   *
   * It also stays attached to any recipe that uses it, which is deliberate —
   * a dish quietly losing an ingredient would change what the kitchen is told
   * to make. If a dish still uses it, that is worth knowing before archiving,
   * so it is said rather than blocked.
   */
  const archiveIngredient = async (i: Ingredient, active: boolean) => {
    if (!active) {
      const dishNames = recipes
        .filter((r) => r.ingredient_id === i.$id)
        .map((r) => dishes.find((d) => d.$id === r.menu_item_id)?.name)
        .filter(Boolean) as string[];
      if (dishNames.length && !confirm(
        `${i.name} is still in ${dishNames.slice(0, 4).join(', ')}`
        + `${dishNames.length > 4 ? ` and ${dishNames.length - 4} more` : ''}. `
        + 'Archive it anyway? Those recipes keep it; it just stops being counted and stops being offered.',
      )) return;
    }
    try {
      await db.updateDocument(DB_ID, 'ingredients', i.$id, { active });
      await load();
      toast(active ? `${i.name} is back in use` : `${i.name} archived`);
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  const open = (i?: Ingredient) => {
    const base: Partial<Ingredient> = i ?? {
      venue_id: 'main', name: '', unit: 'kg', base_unit_cost: 0, current_qty: 0,
      par_level: 0, critical: false, active: true,
    };
    setEditing(base);
    setCostText(toInput(base.base_unit_cost ?? 0, decimals));
    // Cleared per item: it is a way of typing the box above, not a stored
    // figure, and carrying the last bottle's price into the next one would
    // quietly rewrite a cost somebody never touched.
    setPackCostText('');
    setError(null);
  };

  const save = async () => {
    if (!editing?.name?.trim()) { setError('Give the ingredient a name.'); return; }
    const cost = parseMoney(costText, decimals);
    if (cost === null || cost < 0) { setError('Enter a valid cost per unit.'); return; }

    setBusy(true);
    setError(null);
    try {
      const payload = {
        venue_id: editing.venue_id ?? 'main',
        name: editing.name.trim(),
        unit: editing.unit ?? 'kg',
        base_unit_cost: cost,
        current_qty: Number(editing.current_qty ?? 0),
        par_level: Number(editing.par_level ?? 0),
        low_threshold: editing.low_threshold != null ? Number(editing.low_threshold) : undefined,
        critical: editing.critical ?? false,
        supplier_id: editing.supplier_id ?? '',
        category: editing.category ?? '',
        /*
          Where buying this lands in the books.

          Defaulted per side rather than left blank: a bar ingredient with no
          category falls to "other" and is written off the day it is carried
          in, so the bar shows a bad week every time it restocks and a good
          one every week it does not. Stock belongs on the balance sheet until
          it is poured.
        */
        expense_category_key: editing.expense_category_key || defaultStockCategory,
        check_guide: (editing.check_guide ?? '').trim(),
        counted_at_close: editing.counted_at_close !== false,
        // How it arrives, when that differs from how it is counted. A bar buys
        // a bottle and pours shots; a kitchen buys rice by the kilo and leaves
        // both of these alone. See packs.ts.
        pack_size: Number(editing.pack_size ?? 0),
        pack_name: (editing.pack_name ?? '').trim(),
        count_each_shift: editing.count_each_shift === true,
        // Whose shelf, taken from the page rather than asked for. A bottle
        // added from the bar's screen belongs to the bar; nobody should have
        // to answer a question the screen already knows the answer to.
        module: editing.module ?? module,
        active: editing.active ?? true,
      };
      Object.keys(payload).forEach((k) => (payload as Record<string, unknown>)[k] === undefined && delete (payload as Record<string, unknown>)[k]);

      const { dropped } = await saveDropping('ingredients', editing.$id ?? null, payload);
      setEditing(null);
      await load();
      toast(
        dropped.includes('check_guide')
          ? 'Saved, but the shift-check guide needs one more field in the database. Run "Provision Appwrite" in GitHub Actions, then set it again.'
          : 'Saved',
        dropped.length ? 'err' : undefined,
      );
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const saveSupplier = async () => {
    if (!editingSupplier?.name?.trim()) { setError('Give the supplier a name.'); return; }
    setBusy(true);
    try {
      const payload = {
        venue_id: editingSupplier.venue_id ?? 'main',
        name: editingSupplier.name.trim(),
        contact: editingSupplier.contact ?? '',
        phone: editingSupplier.phone ?? '',
        email: editingSupplier.email ?? '',
        active: editingSupplier.active ?? true,
      };
      if (editingSupplier.$id) await db.updateDocument(DB_ID, 'suppliers', editingSupplier.$id, payload);
      else await db.createDocument(DB_ID, 'suppliers', ID.unique(), payload);
      setEditingSupplier(null);
      await load();
      toast('Supplier saved');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const supplierName = (id?: string) => suppliers.find((s) => s.$id === id)?.name ?? '-';

  /**
   * Which dishes this ingredient goes into.
   *
   * The link between stock and the menu is invisible until you can see it from
   * both ends, so it is shown here as well as in the dish editor. An
   * ingredient used in nothing is called out: it will never be depleted by a
   * sale, which is usually a recipe someone has not written yet rather than a
   * deliberate choice.
   */
  const usedIn = (ingredientId: string) => {
    const names = recipes
      .filter((r) => r.ingredient_id === ingredientId && r.menu_item_id)
      .map((r) => dishes.find((d) => d.$id === r.menu_item_id)?.name)
      .filter(Boolean) as string[];
    if (names.length === 0) return <span className="dim">No dish yet</span>;
    if (names.length <= 2) return <span className="dim">{names.join(', ')}</span>;
    return <span className="dim" title={names.join(', ')}>{names.slice(0, 2).join(', ')} +{names.length - 2}</span>;
  };

  return (
    <>
      <div className="spread">
        <h1>{W.title}</h1>
        {tab !== 'categories' && (
          <div className="row">
            {tab === 'ingredients' && archivedCount > 0 && (
              <Button onClick={() => setShowArchived((s) => !s)}>
                {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
              </Button>
            )}
            {tab === 'ingredients' && (
              <Button onClick={() => setImporting(true)}>Import from a spreadsheet</Button>
            )}
            {/*
              Only shown while there is something to fix, and it says how many.

              Items set up before stock had a home in the books point nowhere,
              so buying them is written off the day it arrives — the side shows
              a bad week whenever it restocks and a good one whenever it does
              not. New items default correctly; these are the ones that came
              first.
            */}
            {tab === 'ingredients' && needCategory.length > 0 && (
              <Button onClick={() => void pointAtStock()} loading={pointing}>
                Point {needCategory.length} at {stockCategoryName}
              </Button>
            )}
            <Button variant="primary" onClick={() => (tab === 'ingredients' ? open() : setEditingSupplier({ name: '', active: true }))}>
              {tab === 'ingredients' ? W.add : 'Add supplier'}
            </Button>
          </div>
        )}
      </div>

      <ViewTabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'ingredients', label: 'Ingredients' },
          { value: 'suppliers', label: 'Suppliers' },
          { value: 'categories', label: 'Categories' },
          { value: 'packs', label: 'Packs' },
        ]}
      />

      {error && !editing && !editingSupplier && <Notice>{error}</Notice>}

      {tab === 'ingredients' && alerts.length > 0 && (
        <Notice tone="warn">
          <strong>{alerts.length} item{alerts.length > 1 ? 's' : ''} low or out.</strong>{' '}
          {alerts.slice(0, 6).map((a) => a.name).join(', ')}
          {alerts.length > 6 && `, and ${alerts.length - 6} more`}.
          {alerts.some((a) => (a.consecutive_low_count ?? 0) >= 3) && (
            <>
              {' '}
              Some have been low for three shifts or more; that is a supply problem or something leaving unrecorded,
              not ordinary restocking.
            </>
          )}
        </Notice>
      )}

      {tab === 'ingredients' && (ingredients ?? []).length > 0 && (
        <div className="row row-wrap" style={{ gap: '0.5rem', alignItems: 'center', marginBottom: '0.8rem' }}>
          <Input
            placeholder="Search by name…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ flex: '1 1 14rem' }}
          />
          <Select value={state} onChange={(e) => setState(e.target.value as StockState)}>
            {STOCK_STATES.map((s2) => <option key={s2.value} value={s2.value}>{s2.label}</option>)}
          </Select>
          <Select value={sortBy} onChange={(e) => setSortBy(e.target.value as StockSort)}>
            {STOCK_SORTS.map((s2) => <option key={s2.value} value={s2.value}>{s2.label}</option>)}
          </Select>
          {(q || state !== 'any') && (
            <span className="small dim">
              {shownIngredients.length} of {(ingredients ?? []).filter((i) => showArchived || i.active).length}
            </span>
          )}
        </div>
      )}

      {tab === 'packs' ? (
        <KeyedListManager
          collection="pack_kinds"
          singular="pack"
          unitsLabel="How many it usually holds"
          hint="How things arrive: a bottle, a crate, a case. Crates are the reason the number lives on the item as well — some hold twelve and some twenty-four, so what is set here only saves typing the usual answer."
          onChanged={() => void reloadPacks()}
        />
      ) : tab === 'categories' ? (
        <KeyedListManager
          module={module}
          collection="ingredient_categories"
          singular="category"
          hint="Your own groupings, Produce, Dry goods, Drinks, whatever suits how you shop. Used to sort the ingredient list; nothing breaks if you leave them alone."
        />
      ) : (
      <Card pad={false}>
        {!ingredients ? (
          <div className="card-pad"><Spinner /></div>
        ) : tab === 'ingredients' ? (
          shownIngredients.length === 0 ? (
            <Empty title={ingredients.length === 0 ? 'No ingredients yet' : 'All archived'}>
              {ingredients.length === 0
                ? 'Add what you buy and count. Link them to dishes as recipes, and the system can tell you what you '
                  + 'should have used versus what you actually did.'
                : 'Every ingredient here has been archived. Show archived to bring one back.'}
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Ingredient</th><th>Category</th><th>Supplier</th><th>Used in</th>
                    <th className="num">In stock</th><th className="num">Par</th>
                    <th className="num">Unit cost</th><th>Level</th><th />
                  </tr>
                </thead>
                <tbody>
                  {shownIngredients.map((i) => {
                    const level = levelOf(i, lowDefaultBp);
                    const run = i.consecutive_low_count ?? 0;
                    return (
                      <tr key={i.$id} className={i.active ? undefined : 'dim'}>
                        <td>
                          <div style={{ fontWeight: 550 }}>{i.name}</div>
                          {i.critical && <span className="badge badge-warn">Critical</span>}
                          {!i.active && <Badge tone="warn">Archived</Badge>}
                          {/* A wrong pack size multiplies the shelf by itself
                              and is otherwise invisible until a count goes
                              badly, so it is shown where the list is read. */}
                          {i.count_each_shift && <Badge tone="ok">Counted every shift</Badge>}
                          {hasPack(i) && (
                            <div className="small dim">
                              bought by the {(i.pack_name || 'pack').trim()} of {packSize(i)} {i.unit}
                            </div>
                          )}
                        </td>
                        <td className="dim small">{nameForKey(categories, i.category) === ', ' ? '' : nameForKey(categories, i.category)}</td>
                        <td className="dim small">{supplierName(i.supplier_id)}</td>
                        <td className="small">{usedIn(i.$id)}</td>
                        <td className="num">{i.current_qty} {i.unit}</td>
                        <td className="num dim">{i.par_level} {i.unit}</td>
                        <td className="num">{settings ? formatMoney(i.base_unit_cost, settings) : i.base_unit_cost}</td>
                        <td>
                          {level === 'out' ? <Badge tone="danger">Out</Badge> : level === 'low' ? <Badge tone="warn">Low</Badge> : <Badge tone="ok">OK</Badge>}
                          {run >= 3 && <div className="small dim">{run} shifts running</div>}
                        </td>
                        <td className="num">
                          {/* Next to Edit, because "what has this been costing
                              me" is a question somebody has while looking at
                              the row, not one they go to another screen for. */}
                          <Button size="sm" variant="ghost" onClick={() => setHistoryFor(i)}>Prices</Button>
                          <Button size="sm" variant="ghost" onClick={() => open(i)}>Edit</Button>
                          <Button size="sm" variant="ghost" onClick={() => archiveIngredient(i, !i.active)}>
                            {i.active ? 'Archive' : 'Use again'}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : suppliers.length === 0 ? (
          <Empty title="No suppliers yet">Add who you buy from, then link ingredients to them.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Name</th><th>Contact</th><th>Phone</th><th>Status</th><th /></tr></thead>
              <tbody>
                {suppliers.map((s) => (
                  <tr key={s.$id}>
                    <td style={{ fontWeight: 550 }}>{s.name}</td>
                    <td className="dim">{s.contact || '-'}</td>
                    <td className="dim">{s.phone || '-'}</td>
                    <td>{s.active ? <Badge tone="ok">Active</Badge> : <Badge>Inactive</Badge>}</td>
                    <td className="num"><Button size="sm" variant="ghost" onClick={() => setEditingSupplier(s)}>Edit</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      )}

      {historyFor && settings && (
        <PriceHistoryModal
          ingredient={historyFor}
          settings={settings}
          onClose={() => setHistoryFor(null)}
        />
      )}

      {importing && (
        <StockImport
          existing={ingredients ?? []}
          suppliers={suppliers}
          categories={categories}
          expenseCategories={expenseCategories}
          settings={settings}
          venueId="main"
          module={module}
          onClose={() => setImporting(false)}
          onDone={async (m) => {
            setImporting(false);
            await load();
            toast(m);
          }}
        />
      )}

      {editing && (
        <Modal
          title={editing.$id ? `Edit ${editing.name}` : 'Add ingredient'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={save} loading={busy}>Save</Button>
            </>
          }
        >
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
          <div className="grid-2">
            <Field label="Name">
              <Input value={editing.name ?? ''} autoFocus onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="Unit" hint="How you count it. Recipes use the same unit.">
              <Select value={editing.unit ?? 'kg'} onChange={(e) => setEditing({ ...editing, unit: e.target.value })}>
                {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </Select>
            </Field>
            <Field
              label={`Cost per ${editing.unit ?? 'unit'} (${settings?.currency_symbol ?? ''})`}
              hint="Used to value stock and work out what each drink or dish costs you."
            >
              <Input value={costText} inputMode="decimal" onChange={(e) => setCostText(e.target.value)} />
            </Field>
            {/*
              Nobody knows the price of a shot.

              A spirit is bought by the bottle and its invoice says so, and the
              figure this form wants is per shot — so an admin was doing a
              division in their head, and a division done in a hurry is how a
              GHS 140 bottle becomes a GHS 140 shot and every cocktail poured
              from it reads as a loss. Type either, and the other follows.

              Only shown once a pack is set up, because without one the two
              questions are the same question.
            */}
            {hasPack(editing as { unit: string; pack_size?: number; pack_name?: string }) && (
              <Field
                label={`Or the cost per ${(editing.pack_name || 'pack').trim()} (${settings?.currency_symbol ?? ''})`}
                hint={`Divided by ${packSize(editing as { unit: string; pack_size?: number })} to give the figure above.`}
              >
                <Input
                  value={packCostText}
                  inputMode="decimal"
                  placeholder="What the whole one costs"
                  onChange={(e) => {
                    setPackCostText(e.target.value);
                    const whole = parseMoney(e.target.value, decimals);
                    const per = packSize(editing as { unit: string; pack_size?: number });
                    if (whole !== null && per > 0) setCostText(toInput(Math.round(whole / per), decimals));
                  }}
                />
              </Field>
            )}
            <Field label="Currently in stock">
              <Input type="number" step="any" value={editing.current_qty ?? 0} onChange={(e) => setEditing({ ...editing, current_qty: Number(e.target.value) })} />
            </Field>
            {/*
              How it arrives, when that is not how it is counted.

              The bar's case: a bottle of Havana Club is bought as a bottle and
              poured as shots. Without this, recording "1 bottle" puts one shot
              on the shelf and makes the price of a whole bottle the price of a
              single shot — which values the shelf at twenty-eight times what
              is really on it. Left at nought, nothing changes anywhere, which
              is what every kitchen ingredient wants.
            */}
            <Field
              label="Bought as"
              hint={`What one purchase is called, if you do not buy it by the ${editing.unit ?? 'unit'}. Manage the list under the Packs tab.`}
            >
              <Select
                value={editing.pack_name ?? ''}
                onChange={(e) => {
                  const name = e.target.value;
                  const kind = (packKinds ?? []).find((k) => k.name === name);
                  setEditing({
                    ...editing,
                    pack_name: name,
                    // A suggested size fills the box; anything already typed
                    // wins, because a crate of 24 is still a crate and the
                    // number in front of somebody is the one that counts.
                    pack_size: name === '' ? 0
                      : (editing.pack_size || (kind?.units ?? 0)),
                  });
                }}
              >
                <option value="">Bought by the {editing.unit ?? 'unit'}</option>
                {(packKinds ?? []).filter((k) => k.active !== false).map((k) => (
                  <option key={k.$id} value={k.name}>{k.name}</option>
                ))}
                {/* Whatever was typed before this became a list keeps working.
                    Dropping it would silently unset the pack on the next save
                    of an unrelated field, and every purchase after that would
                    book one shot instead of a bottle. */}
                {editing.pack_name
                  && !(packKinds ?? []).some((k) => k.name === editing.pack_name) && (
                  <option value={editing.pack_name}>{editing.pack_name} (set previously)</option>
                )}
              </Select>
            </Field>
            <Field
              label={`${plainPack(editing.pack_name)} holds how many ${editing.unit ?? 'unit'}?`}
              hint={packHint(editing, settings?.currency_symbol ?? '')}
            >
              <Input
                type="number"
                step="any"
                min="0"
                value={editing.pack_size ?? 0}
                onChange={(e) => setEditing({ ...editing, pack_size: Number(e.target.value) })}
              />
            </Field>
            {packProblem(Number(editing.pack_size ?? 0), editing.unit ?? '', editing.pack_name ?? '') && (
              <div style={{ gridColumn: '1 / -1' }}>
                <Notice tone="warn">
                  {packProblem(Number(editing.pack_size ?? 0), editing.unit ?? '', editing.pack_name ?? '')}
                </Notice>
              </div>
            )}
            <Field label="Par level" hint="The amount you like to keep on hand.">
              <Input type="number" step="any" value={editing.par_level ?? 0} onChange={(e) => setEditing({ ...editing, par_level: Number(e.target.value) })} />
            </Field>
            <Field label="Low warning at" hint={`Blank uses ${(lowDefaultBp / 100).toFixed(0)}% of par.`}>
              <Input
                type="number"
                step="any"
                value={editing.low_threshold ?? ''}
                onChange={(e) => setEditing({ ...editing, low_threshold: e.target.value === '' ? undefined : Number(e.target.value) })}
              />
            </Field>
            <Field label="Supplier">
              <Select value={editing.supplier_id ?? ''} onChange={(e) => setEditing({ ...editing, supplier_id: e.target.value })}>
                <option value="">None</option>
                {suppliers.map((s) => <option key={s.$id} value={s.$id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field
              label="Buying this counts as"
              hint={`Where buying this lands in the books. Stock belongs on the balance sheet until it sells, which is what "${stockCategoryName}" does.`}
            >
              <Select
                /*
                  Shown as it will be saved, not blank.

                  The default was only applied on the way out, so the box read
                  "Ask each time" while the save wrote something else — which
                  is the worst of both: nobody could see what it was set to,
                  and nobody believed it was set at all.
                */
                value={editing.expense_category_key || defaultStockCategory}
                onChange={(e) => setEditing({ ...editing, expense_category_key: e.target.value })}
              >
                <option value="">Ask each time</option>
                {(expenseCategories ?? []).filter((c) => c.active !== false).map((c) => (
                  <option key={c.key} value={c.key}>{c.name}</option>
                ))}
                {/* A category the database does not have yet still shows, so a
                    set value is visible rather than silently reading as blank
                    until somebody runs Provision. */}
                {(editing.expense_category_key || defaultStockCategory)
                  && !(expenseCategories ?? []).some(
                    (c) => c.key === (editing.expense_category_key || defaultStockCategory),
                  ) && (
                  <option value={editing.expense_category_key || defaultStockCategory}>
                    {stockCategoryName} (run Provision to add it)
                  </option>
                )}
              </Select>
            </Field>
            <Field
              label="Category"
              hint={categories && categories.length === 0 ? 'None set up, add some under the Categories tab.' : 'Optional. Groups the shopping list.'}
            >
              <Select value={editing.category ?? ''} onChange={(e) => setEditing({ ...editing, category: e.target.value })}>
                <option value="">None</option>
                {(categories ?? []).filter((c) => c.active !== false).map((c) => (
                  <option key={c.key} value={c.key}>{c.name}</option>
                ))}
                {editing.category && !(categories ?? []).some((c) => c.key === editing.category) && (
                  <option value={editing.category}>{editing.category} (typed in before)</option>
                )}
              </Select>
            </Field>
          </div>

          {/*
            Written in the units on the shelf, not the units in the database.
            Par levels are kilograms and litres; shelves hold buckets, crates
            and half a bottle. Whoever knows the kitchen writes the rule once,
            and everybody closing a shift reads the same one.

            Not the bar's question. A bar counts bottles and measures — the
            number IS the answer, and "OK = half a bucket or more" is a
            sentence about a larder. Asking it here only added a box nobody
            fills in on a form that is already long.
          */}
          {module !== 'bar' && (
            <Field
              label="Shift-check guide"
              hint="Shown under this ingredient when staff close a shift, so “low” means the same thing to everybody. Leave blank to show the numbers above instead."
            >
              <Input
                value={editing.check_guide ?? ''}
                maxLength={160}
                placeholder={guideExample(editing.unit)}
                onChange={(e) => setEditing({ ...editing, check_guide: e.target.value })}
              />
            </Field>
          )}

          {/*
            Not everything bought sits on a shelf.

            Transport, a delivery fee, gas for the van, a repair. Worth having
            as items so a shop run breaks down into what it was actually spent
            on rather than one lump called "other" — but there is nothing to
            walk over and look at, and putting them on the closing list asks a
            cook to count a taxi. A list with nonsense in it is a list people
            learn to tap through, which costs the count on the things that do
            matter.
          */}
          {/*
            One question, not two overlapping ones.

            A bar item had "counted at the end of a shift" and "counted at the
            start and end of every shift" sitting next to each other, which is
            two ways of asking how often somebody walks past it — and no way
            to tell from the labels which one won. How often IS the question,
            so it is asked once and the two flags follow from the answer.
          */}
          <Field
            label="How often is this counted?"
            hint={module === 'bar'
              ? 'Bottled drinks leave whole and are quick to see, so they are counted in and out every shift. "At stocktake" means exactly that and nothing else — spirits stay off the twice-daily sheet, because forty open bottles judged by eye at two in the morning produce numbers nobody believes.'
              : 'Choose Never for things with nothing on a shelf: transport, delivery fees, repairs. They can still be entered on an expense.'}
          >
            <Select
              value={countCadence(editing)}
              onChange={(e) => setEditing({ ...editing, ...cadenceFields(e.target.value as Cadence) })}
            >
              {module === 'bar' && <option value="shift">Every shift, in and out</option>}
              <option value="close">At stocktake</option>
              <option value="never">Never</option>
            </Select>
          </Field>

          <Field hint="Critical items are called out first when they run low, ahead of everything else.">
            <Toggle checked={editing.critical ?? false} onChange={(v) => setEditing({ ...editing, critical: v })} label="Critical, service stops without it" />
          </Field>
          <Field>
            <Toggle checked={editing.active ?? true} onChange={(v) => setEditing({ ...editing, active: v })} label="Active" />
          </Field>
        </Modal>
      )}

      {editingSupplier && (
        <Modal
          title={editingSupplier.$id ? `Edit ${editingSupplier.name}` : 'Add supplier'}
          onClose={() => setEditingSupplier(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditingSupplier(null)}>Cancel</Button>
              <Button variant="primary" onClick={saveSupplier} loading={busy}>Save</Button>
            </>
          }
        >
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
          <div className="grid-2">
            <Field label="Name"><Input value={editingSupplier.name ?? ''} autoFocus onChange={(e) => setEditingSupplier({ ...editingSupplier, name: e.target.value })} /></Field>
            <Field label="Contact person"><Input value={editingSupplier.contact ?? ''} onChange={(e) => setEditingSupplier({ ...editingSupplier, contact: e.target.value })} /></Field>
            <Field label="Phone"><Input value={editingSupplier.phone ?? ''} onChange={(e) => setEditingSupplier({ ...editingSupplier, phone: e.target.value })} /></Field>
            <Field label="Email"><Input type="email" value={editingSupplier.email ?? ''} onChange={(e) => setEditingSupplier({ ...editingSupplier, email: e.target.value })} /></Field>
          </div>
          <Field><Toggle checked={editingSupplier.active ?? true} onChange={(v) => setEditingSupplier({ ...editingSupplier, active: v })} label="Active" /></Field>
        </Modal>
      )}
    </>
  );
}

/**
 * What one ingredient has cost, purchase by purchase.
 *
 * A margin is eaten quietly. Nobody announces that rice has gone up eleven
 * percent since March — it arrives one delivery at a time, each unremarkable
 * next to the last, and the first anybody knows is a bad month with no single
 * cause to point at. Every purchase was already being recorded with what was
 * paid for it; this is the reading of it.
 *
 * Newest first on screen, because "what did I pay last time" is the question
 * somebody usually has, while the arithmetic underneath works oldest-first
 * because that is the direction a price moves in.
 */
function PriceHistoryModal({
  ingredient,
  settings,
  onClose,
}: {
  ingredient: Ingredient;
  settings: Settings;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<PurchaseRow[] | null>(null);

  useEffect(() => {
    purchasesFor(ingredient.$id)
      .then(setRows)
      .catch(() => setRows([]));
  }, [ingredient.$id]);

  const history = useMemo(() => priceHistory(rows ?? []), [rows]);
  const money = (n: number) => formatMoney(n, settings);
  const note = priceMoveNote(history);

  /**
   * A bar per purchase, drawn against the dearest one.
   *
   * Not a line chart. Nine purchases at irregular intervals are not a time
   * series, and drawing them as one implies the gaps are even and invites
   * somebody to read a slope that is not there. Bars in the order they
   * happened say the one true thing — this one cost more than that one —
   * without claiming anything about the shape between them.
   */
  const peak = history.dearest ?? 0;

  return (
    <Modal title={`${ingredient.name} · what it has cost`} onClose={onClose} wide
      footer={<Button onClick={onClose}>Close</Button>}>
      {!rows ? (
        <Spinner />
      ) : history.points.length === 0 ? (
        <Empty title="No purchases recorded yet">
          Prices appear here once this is listed on an expense or received as a delivery. Recording what was paid
          for each item on a market run is what fills this in.
        </Empty>
      ) : (
        <>
          <div className="grid-2" style={{ marginBottom: '0.9rem' }}>
            <Card title="Last paid">
              <p style={{ margin: 0, fontSize: '1.5rem', fontWeight: 650 }}>
                {money(history.latest ?? 0)}
              </p>
              <span className="dim small">per {ingredient.unit}</span>
            </Card>
            <Card title="Average">
              <p style={{ margin: 0, fontSize: '1.5rem', fontWeight: 650 }}>
                {money(history.averageUnitCost ?? 0)}
              </p>
              {/* Weighted by quantity, and said so: five sacks at 100 and one
                  at 200 is not an average of 150, and a recipe costed against
                  the wrong one is wrong everywhere it is used. */}
              <span className="dim small">per {ingredient.unit}, across everything bought</span>
            </Card>
          </div>

          {note && (
            <div style={{ marginBottom: '0.9rem' }}>
              <Notice tone={(history.moveBp ?? 0) > 500 ? 'warn' : 'info'}>
                <strong>{note}</strong>{' '}
                Cheapest {money(history.cheapest ?? 0)}, dearest {money(history.dearest ?? 0)}.{' '}
                {history.totalQty} {ingredient.unit} bought for {money(history.totalSpent)} in all.
              </Notice>
            </div>
          )}

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th className="num">Quantity</th>
                  <th className="num">Paid</th>
                  <th className="num">Per {ingredient.unit}</th>
                  <th>Against the one before</th>
                </tr>
              </thead>
              <tbody>
                {[...history.points].reverse().map((p, i) => (
                  <tr key={`${p.at}-${i}`}>
                    <td className="dim small">{new Date(p.at).toLocaleDateString()}</td>
                    <td className="num">{p.qty} {ingredient.unit}</td>
                    <td className="num">{money(p.total)}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{money(p.unitCost)}</td>
                    <td>
                      <div className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                        <span
                          aria-hidden
                          style={{
                            display: 'inline-block', height: '9px', borderRadius: '3px',
                            width: `${peak > 0 ? Math.max(3, (p.unitCost / peak) * 90) : 0}%`,
                            background: p.changeBp === null
                              ? 'var(--border)'
                              : p.changeBp > 0 ? 'var(--warn)' : 'var(--ok, #3f8f5f)',
                          }}
                        />
                        <span className="small dim" style={{ whiteSpace: 'nowrap' }}>
                          {p.changeBp === null
                            ? 'first one'
                            : p.changeBp === 0
                              ? 'same'
                              : `${p.changeBp > 0 ? '+' : '−'}${(Math.abs(p.changeBp) / 100).toFixed(0)}%`}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
