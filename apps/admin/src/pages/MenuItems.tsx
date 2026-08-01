import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Textarea, Toggle, Badge, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import { formatMoney, parseMoney, toInput } from '@snpos/core';
import type { Category, MenuItem, Station } from '@snpos/core';
import { useSession } from '../session';

const STATIONS: (Station | 'inherit')[] = ['inherit', 'hot', 'cold', 'bar', 'dessert'];

export function MenuItemsPage() {
  const { settings } = useSession();
  const toast = useToast();
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<Partial<MenuItem> | null>(null);
  const [priceText, setPriceText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const decimals = settings?.currency_decimals ?? 2;

  const load = async () => {
    const [i, c] = await Promise.all([listAll<MenuItem>('menu_items'), listAll<Category>('categories')]);
    setItems(i.sort((a, b) => a.sort - b.sort));
    setCategories(c.sort((a, b) => a.sort - b.sort));
  };
  useEffect(() => { load().catch((e) => setError(humanError(e))); }, []);

  const byCategory = useMemo(() => Object.fromEntries(categories.map((c) => [c.$id, c.name])), [categories]);
  const visible = useMemo(
    () => (items ?? []).filter((i) => !filter || i.name.toLowerCase().includes(filter.toLowerCase())),
    [items, filter],
  );

  const open = (item?: MenuItem) => {
    const base: Partial<MenuItem> = item ?? {
      name: '', description: '', price: 0, category_id: categories[0]?.$id ?? '',
      active: true, prep_minutes: 10, station: 'inherit', sort: (items?.length ?? 0) + 1,
      track_stock: false, image_focal_x: 0.5, image_focal_y: 0.5,
    };
    setEditing(base);
    setPriceText(toInput(base.price ?? 0, decimals));
    setError(null);
  };

  const save = async () => {
    if (!editing?.name?.trim()) { setError('This dish needs a name.'); return; }
    if (!editing.category_id) { setError('Choose a category. Create one first if the list is empty.'); return; }
    const price = parseMoney(priceText, decimals);
    if (price === null || price < 0) { setError('Enter a valid price, for example 25.00'); return; }

    setBusy(true);
    setError(null);
    const payload = {
      category_id: editing.category_id,
      name: editing.name.trim(),
      description: editing.description ?? '',
      price,
      active: editing.active ?? true,
      prep_minutes: Number(editing.prep_minutes ?? 10),
      station: editing.station ?? 'inherit',
      sort: Number(editing.sort ?? 0),
      track_stock: editing.track_stock ?? false,
      image_focal_x: editing.image_focal_x ?? 0.5,
      image_focal_y: editing.image_focal_y ?? 0.5,
      sku: editing.sku ?? '',
    };
    try {
      if (editing.$id) await db.updateDocument(DB_ID, 'menu_items', editing.$id, payload);
      else await db.createDocument(DB_ID, 'menu_items', ID.unique(), payload);
      setEditing(null);
      await load();
      toast('Saved');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: MenuItem) => {
    if (!confirm(`Delete "${item.name}"? Past orders keep their own copy of the name and price, so your records stay intact.`)) return;
    try {
      await db.deleteDocument(DB_ID, 'menu_items', item.$id);
      await load();
      toast('Deleted');
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  return (
    <>
      <div className="spread">
        <h1>Dishes &amp; drinks</h1>
        <Button variant="primary" onClick={() => open()} disabled={categories.length === 0}>Add item</Button>
      </div>

      {categories.length === 0 && (
        <Notice tone="warn">Create at least one category first — every dish belongs to one.</Notice>
      )}
      {error && !editing && <Notice>{error}</Notice>}

      {items && items.length > 0 && (
        <Input placeholder="Search by name…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      )}

      <Card pad={false}>
        {!items ? (
          <div className="card-pad"><Spinner /></div>
        ) : visible.length === 0 ? (
          <Empty title={items.length === 0 ? 'No dishes yet' : 'Nothing matches that search'}>
            {items.length === 0 && 'Add your first dish or drink, with its price.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Category</th>
                  <th className="num">Price</th>
                  <th className="num">Prep</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((i) => (
                  <tr key={i.$id}>
                    <td>
                      <div style={{ fontWeight: 550 }}>{i.name}</div>
                      {i.description && <div className="small dim">{i.description.slice(0, 70)}{i.description.length > 70 ? '…' : ''}</div>}
                    </td>
                    <td className="dim">{byCategory[i.category_id] ?? <Badge tone="danger">No category</Badge>}</td>
                    <td className="num">{settings ? formatMoney(i.price, settings) : i.price}</td>
                    <td className="num dim">{i.prep_minutes}m</td>
                    <td>{i.active ? <Badge tone="ok">Active</Badge> : <Badge>Hidden</Badge>}</td>
                    <td className="num">
                      <Button size="sm" variant="ghost" onClick={() => open(i)}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(i)}>Delete</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <Modal
          title={editing.$id ? 'Edit item' : 'Add item'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={save} loading={busy}>Save</Button>
            </>
          }
        >
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
          <Field label="Name">
            <Input value={editing.name ?? ''} autoFocus onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </Field>
          <Field label="Description" hint="Optional. What the customer reads on their phone.">
            <Textarea value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
          </Field>
          <div className="grid-2">
            <Field label="Category">
              <Select value={editing.category_id ?? ''} onChange={(e) => setEditing({ ...editing, category_id: e.target.value })}>
                {categories.map((c) => <option key={c.$id} value={c.$id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label={`Price (${settings?.currency_symbol ?? ''})`}>
              <Input value={priceText} inputMode="decimal" onChange={(e) => setPriceText(e.target.value)} />
            </Field>
            <Field label="Prep time (minutes)" hint="Used to estimate waits and to time pre-orders.">
              <Input type="number" min="0" value={editing.prep_minutes ?? 10} onChange={(e) => setEditing({ ...editing, prep_minutes: Number(e.target.value) })} />
            </Field>
            <Field label="Kitchen station">
              <Select value={editing.station ?? 'inherit'} onChange={(e) => setEditing({ ...editing, station: e.target.value as Station | 'inherit' })}>
                {STATIONS.map((s) => <option key={s} value={s}>{s === 'inherit' ? 'Same as category' : s}</option>)}
              </Select>
            </Field>
          </div>
          <Field>
            <Toggle checked={editing.active ?? true} onChange={(v) => setEditing({ ...editing, active: v })} label="Active — shown on the menu" />
          </Field>
          <Field hint="Only for items made from ingredients you count. Leave off for drinks you buy in.">
            <Toggle checked={editing.track_stock ?? false} onChange={(v) => setEditing({ ...editing, track_stock: v })} label="Track ingredient stock for this item" />
          </Field>
        </Modal>
      )}
    </>
  );
}
