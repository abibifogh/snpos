import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Toggle, Badge, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import { formatMoney, parseMoney, toInput, levelOf } from '@snpos/core';
import type { Ingredient, Recipe, MenuItem, Doc } from '@snpos/core';
import { KeyedListManager, useKeyedList, nameForKey } from '../components/KeyedList';
import { StockImport } from '../components/StockImport';
import { useSession } from '../session';

interface Supplier extends Doc { venue_id: string; name: string; contact?: string; phone?: string; email?: string; active: boolean }

const UNITS = ['g', 'kg', 'ml', 'l', 'each', 'pack'];

export function StockPage() {
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

  const load = async () => {
    const [i, s, r, d] = await Promise.all([
      listAll<Ingredient>('ingredients'),
      listAll<Supplier>('suppliers'),
      listAll<Recipe>('recipes'),
      listAll<MenuItem>('menu_items'),
    ]);
    setIngredients(i.sort((a, b) => a.name.localeCompare(b.name)));
    setSuppliers(s.sort((a, b) => a.name.localeCompare(b.name)));
    setRecipes(r);
    setDishes(d);
  };
  useEffect(() => { load().catch((e) => setError(humanError(e))); }, []);

  const lowDefaultBp = settings?.low_stock_default_bp ?? 3000;
  const alerts = useMemo(
    () => (ingredients ?? []).filter((i) => i.active && levelOf(i, lowDefaultBp) !== 'ok'),
    [ingredients, lowDefaultBp],
  );

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
        active: editing.active ?? true,
      };
      Object.keys(payload).forEach((k) => (payload as Record<string, unknown>)[k] === undefined && delete (payload as Record<string, unknown>)[k]);

      if (editing.$id) await db.updateDocument(DB_ID, 'ingredients', editing.$id, payload);
      else await db.createDocument(DB_ID, 'ingredients', ID.unique(), payload);
      setEditing(null);
      await load();
      toast('Saved');
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

  const supplierName = (id?: string) => suppliers.find((s) => s.$id === id)?.name ?? '—';

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
              Some have been low for three shifts or more — that is a supply problem or something leaving unrecorded,
              not ordinary restocking.
            </>
          )}
        </Notice>
      )}

      {tab === 'categories' ? (
        <KeyedListManager
          collection="ingredient_categories"
          singular="category"
          hint="Your own groupings — Produce, Dry goods, Drinks, whatever suits how you shop. Used to sort the ingredient list; nothing breaks if you leave them alone."
        />
      ) : (
      <Card pad={false}>
        {!ingredients ? (
          <div className="card-pad"><Spinner /></div>
        ) : tab === 'ingredients' ? (
          ingredients.length === 0 ? (
            <Empty title="No ingredients yet">
              Add what you buy and count. Link them to dishes as recipes, and the system can tell you what you should
              have used versus what you actually did.
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
                  {ingredients.map((i) => {
                    const level = levelOf(i, lowDefaultBp);
                    const run = i.consecutive_low_count ?? 0;
                    return (
                      <tr key={i.$id}>
                        <td>
                          <div style={{ fontWeight: 550 }}>{i.name}</div>
                          {i.critical && <span className="badge badge-warn">Critical</span>}
                        </td>
                        <td className="dim small">{nameForKey(categories, i.category) === '—' ? '' : nameForKey(categories, i.category)}</td>
                        <td className="dim small">{supplierName(i.supplier_id)}</td>
                        <td className="small">{usedIn(i.$id)}</td>
                        <td className="num">{i.current_qty} {i.unit}</td>
                        <td className="num dim">{i.par_level} {i.unit}</td>
                        <td className="num">{settings ? formatMoney(i.base_unit_cost, settings) : i.base_unit_cost}</td>
                        <td>
                          {level === 'out' ? <Badge tone="danger">Out</Badge> : level === 'low' ? <Badge tone="warn">Low</Badge> : <Badge tone="ok">OK</Badge>}
                          {run >= 3 && <div className="small dim">{run} shifts running</div>}
                        </td>
                        <td className="num"><Button size="sm" variant="ghost" onClick={() => open(i)}>Edit</Button></td>
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
                    <td className="dim">{s.contact || '—'}</td>
                    <td className="dim">{s.phone || '—'}</td>
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

      {importing && (
        <StockImport
          existing={ingredients ?? []}
          suppliers={suppliers}
          categories={categories}
          expenseCategories={expenseCategories}
          settings={settings}
          venueId="main"
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
                <option value="">— none —</option>
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
                <option value="">— ask each time —</option>
                {(expenseCategories ?? []).filter((c) => c.active !== false).map((c) => (
                  <option key={c.key} value={c.key}>{c.name}</option>
                ))}
              </Select>
            </Field>
            <Field
              label="Category"
              hint={categories && categories.length === 0 ? 'None set up — add some under the Categories tab.' : 'Optional. Groups the shopping list.'}
            >
              <Select value={editing.category ?? ''} onChange={(e) => setEditing({ ...editing, category: e.target.value })}>
                <option value="">— none —</option>
                {(categories ?? []).filter((c) => c.active !== false).map((c) => (
                  <option key={c.key} value={c.key}>{c.name}</option>
                ))}
                {editing.category && !(categories ?? []).some((c) => c.key === editing.category) && (
                  <option value={editing.category}>{editing.category} (typed in before)</option>
                )}
              </Select>
            </Field>
          </div>
          <Field hint="Critical items are called out first when they run low, ahead of everything else.">
            <Toggle checked={editing.critical ?? false} onChange={(v) => setEditing({ ...editing, critical: v })} label="Critical — service stops without it" />
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
