import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Toggle, Badge, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import {
  formatMoney, parseMoney, toInput, levelOf, saveDropping,
  purchasesFor, priceHistory, priceMoveNote,
} from '@snpos/core';
import type { Module, Ingredient, Recipe, MenuItem, Doc, Settings, PurchaseRow } from '@snpos/core';
import { KeyedListManager, useKeyedList, nameForKey } from '../components/KeyedList';
import { StockImport } from '../components/StockImport';
import { useSession } from '../session';

interface Supplier extends Doc { venue_id: string; name: string; contact?: string; phone?: string; email?: string; active: boolean }

const UNITS = ['g', 'kg', 'ml', 'l', 'each', 'pack'];

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

  const [tab, setTab] = useState<'ingredients' | 'suppliers' | 'categories'>('ingredients');
  const [ingredients, setIngredients] = useState<Ingredient[] | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [dishes, setDishes] = useState<MenuItem[]>([]);
  const { rows: categories } = useKeyedList('ingredient_categories');
  const { rows: expenseCategories } = useKeyedList('expense_categories');
  const [editing, setEditing] = useState<Partial<Ingredient> | null>(null);
  const [editingSupplier, setEditingSupplier] = useState<Partial<Supplier> | null>(null);
  const [importing, setImporting] = useState(false);
  const [costText, setCostText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
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

  const archivedCount = (ingredients ?? []).filter((i) => !i.active).length;
  const shownIngredients = (ingredients ?? []).filter((i) => showArchived || i.active);

  const lowDefaultBp = settings?.low_stock_default_bp ?? 3000;
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
        expense_category_key: editing.expense_category_key ?? '',
        check_guide: (editing.check_guide ?? '').trim(),
        counted_at_close: editing.counted_at_close !== false,
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
        <h1>Stock</h1>
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
            <Button variant="primary" onClick={() => (tab === 'ingredients' ? open() : setEditingSupplier({ name: '', active: true }))}>
              {tab === 'ingredients' ? 'Add ingredient' : 'Add supplier'}
            </Button>
          </div>
        )}
      </div>

      <div className="pos-tabs" style={{ display: 'flex', gap: '0.4rem' }}>
        <Button size="sm" variant={tab === 'ingredients' ? 'primary' : 'default'} onClick={() => setTab('ingredients')}>Ingredients</Button>
        <Button size="sm" variant={tab === 'suppliers' ? 'primary' : 'default'} onClick={() => setTab('suppliers')}>Suppliers</Button>
        <Button size="sm" variant={tab === 'categories' ? 'primary' : 'default'} onClick={() => setTab('categories')}>Categories</Button>
      </div>

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

      {tab === 'categories' ? (
        <KeyedListManager
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
            <Field label={`Cost per ${editing.unit ?? 'unit'} (${settings?.currency_symbol ?? ''})`} hint="Used to value stock and work out what each dish costs you.">
              <Input value={costText} inputMode="decimal" onChange={(e) => setCostText(e.target.value)} />
            </Field>
            <Field label="Currently in stock">
              <Input type="number" step="any" value={editing.current_qty ?? 0} onChange={(e) => setEditing({ ...editing, current_qty: Number(e.target.value) })} />
            </Field>
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
              hint="Which expense category a delivery of this lands under, so recording one does not also ask somebody to classify it."
            >
              <Select
                value={editing.expense_category_key ?? ''}
                onChange={(e) => setEditing({ ...editing, expense_category_key: e.target.value })}
              >
                <option value="">Ask each time</option>
                {(expenseCategories ?? []).filter((c) => c.active !== false).map((c) => (
                  <option key={c.key} value={c.key}>{c.name}</option>
                ))}
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

          {/* Written in the units on the shelf, not the units in the database.
              Par levels are kilograms and litres; shelves hold buckets, crates
              and half a bottle. Whoever knows the kitchen writes the rule once,
              and everybody closing a shift reads the same one. */}
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
          <Field hint="Turn this off for things with nothing on a shelf: transport, delivery fees, repairs. They can still be entered on an expense.">
            <Toggle
              checked={editing.counted_at_close !== false}
              onChange={(v) => setEditing({ ...editing, counted_at_close: v })}
              label="Counted at the end of a shift"
            />
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
