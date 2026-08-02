import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Spinner, Textarea, Toggle, Badge, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import { formatMoney, parseMoney, toInput, previewUrl, Query } from '@snpos/core';
import type { Category, MenuItem, Doc } from '@snpos/core';
import { ImageField } from '../components/ImageField';
import { StationPicker, useStations, legacyStationFor } from '../components/StationPicker';
import { useSession } from '../session';

interface ItemCategory extends Doc { menu_item_id: string; category_id: string; sort: number; active: boolean }
interface AddonGroup extends Doc { name: string; required: boolean; sort: number }
interface ItemAddonGroup extends Doc { menu_item_id: string; group_id: string; sort: number }

export function MenuItemsPage() {
  const { settings } = useSession();
  const toast = useToast();
  const stations = useStations();
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [links, setLinks] = useState<ItemCategory[]>([]);
  const [addonGroups, setAddonGroups] = useState<AddonGroup[]>([]);
  const [itemAddons, setItemAddons] = useState<ItemAddonGroup[]>([]);
  // Chosen in the editor; written as join rows on save.
  const [pickedCategories, setPickedCategories] = useState<string[]>([]);
  const [pickedAddons, setPickedAddons] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<Partial<MenuItem> | null>(null);
  const [priceText, setPriceText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const decimals = settings?.currency_decimals ?? 2;

  const load = async () => {
    const [i, c, l, g, ia] = await Promise.all([
      listAll<MenuItem>('menu_items'),
      listAll<Category>('categories'),
      listAll<ItemCategory>('menu_item_categories'),
      listAll<AddonGroup>('addon_groups'),
      listAll<ItemAddonGroup>('menu_item_addon_groups'),
    ]);
    setItems(i.sort((a, b) => a.sort - b.sort));
    setCategories(c.sort((a, b) => a.sort - b.sort));
    setLinks(l);
    setAddonGroups(g.sort((a, b) => a.sort - b.sort));
    setItemAddons(ia);
  };
  useEffect(() => { load().catch((e) => setError(humanError(e))); }, []);

  const byCategory = useMemo(() => Object.fromEntries(categories.map((c) => [c.$id, c.name])), [categories]);
  const visible = useMemo(
    () => (items ?? []).filter((i) => !filter || i.name.toLowerCase().includes(filter.toLowerCase())),
    [items, filter],
  );

  /** Every category a dish belongs to: its primary, plus any extra links. */
  const categoriesFor = (item: MenuItem): string[] => {
    const extra = links.filter((l) => l.menu_item_id === item.$id && l.active !== false).map((l) => l.category_id);
    return [...new Set([item.category_id, ...extra].filter(Boolean))];
  };

  /**
   * Open the editor.
   *
   * A copy is deliberately opened rather than saved straight away: two dishes
   * called "Jollof (copy)" on the live menu is worse than one extra tap, and it
   * gives you the chance to change the one thing that differs before customers
   * ever see it.
   */
  const open = (item?: MenuItem, copy = false) => {
    const base: Partial<MenuItem> = item
      ? { ...item, ...(copy ? { $id: undefined, name: `${item.name} (copy)` } : {}) }
      : {
          name: '', description: '', price: 0, category_id: categories[0]?.$id ?? '',
          active: true, prep_minutes: 10, station: 'inherit', sort: (items?.length ?? 0) + 1,
          track_stock: false, image_focal_x: 0.5, image_focal_y: 0.5,
        };
    // An older dish only has the built-in `station`; carry it across so opening
    // a dish to change its price cannot silently move it to another station.
    base.station_key = item ? item.station_key || (item.station !== 'inherit' ? item.station : '') : '';
    setEditing(base);
    setPriceText(toInput(base.price ?? 0, decimals));
    setPickedCategories(item ? categoriesFor(item) : categories[0] ? [categories[0].$id] : []);
    setPickedAddons(item ? itemAddons.filter((a) => a.menu_item_id === item.$id).map((a) => a.group_id) : []);
    setError(null);
  };

  /**
   * Reconcile the join rows to match what was ticked.
   *
   * Only the difference is written — leaving untouched rows alone keeps their
   * per-category sort order, which a delete-and-recreate would throw away.
   */
  const syncLinks = async (itemId: string) => {
    const wantCats = pickedCategories.slice(1); // the primary lives on the item itself
    const haveCats = links.filter((l) => l.menu_item_id === itemId);
    await Promise.all([
      ...wantCats
        .filter((c) => !haveCats.some((h) => h.category_id === c))
        .map((c) => db.createDocument(DB_ID, 'menu_item_categories', ID.unique(), { menu_item_id: itemId, category_id: c, sort: 0, active: true })),
      ...haveCats
        .filter((h) => !wantCats.includes(h.category_id))
        .map((h) => db.deleteDocument(DB_ID, 'menu_item_categories', h.$id)),
    ]);

    const haveAddons = itemAddons.filter((a) => a.menu_item_id === itemId);
    await Promise.all([
      ...pickedAddons
        .filter((g) => !haveAddons.some((h) => h.group_id === g))
        .map((g, i) => db.createDocument(DB_ID, 'menu_item_addon_groups', ID.unique(), { menu_item_id: itemId, group_id: g, sort: i })),
      ...haveAddons
        .filter((h) => !pickedAddons.includes(h.group_id))
        .map((h) => db.deleteDocument(DB_ID, 'menu_item_addon_groups', h.$id)),
    ]);
  };

  const save = async () => {
    if (!editing?.name?.trim()) { setError('This dish needs a name.'); return; }
    if (pickedCategories.length === 0) { setError('Choose at least one category.'); return; }
    const price = parseMoney(priceText, decimals);
    if (price === null || price < 0) { setError('Enter a valid price, for example 25.00'); return; }

    setBusy(true);
    setError(null);
    // The first ticked category is the primary one: it gives the dish a home
    // and decides the default kitchen station.
    const primary = pickedCategories[0];
    const payload = {
      category_id: primary,
      name: editing.name.trim(),
      description: editing.description ?? '',
      price,
      active: editing.active ?? true,
      prep_minutes: Number(editing.prep_minutes ?? 10),
      // Blank means "wherever its main category goes". `station` is the old
      // built-in enum the database still requires; `station_key` is the one the
      // kitchen screen actually reads.
      station: editing.station_key ? legacyStationFor(editing.station_key) : 'inherit',
      station_key: editing.station_key ?? '',
      sort: Number(editing.sort ?? 0),
      track_stock: editing.track_stock ?? false,
      image_id: editing.image_id ?? '',
      image_focal_x: editing.image_focal_x ?? 0.5,
      image_focal_y: editing.image_focal_y ?? 0.5,
      sku: editing.sku ?? '',
    };
    try {
      const itemId = editing.$id
        ? (await db.updateDocument(DB_ID, 'menu_items', editing.$id, payload)).$id
        : (await db.createDocument(DB_ID, 'menu_items', ID.unique(), payload)).$id;

      await syncLinks(itemId);
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
      const [cats, addons] = await Promise.all([
        db.listDocuments(DB_ID, 'menu_item_categories', [Query.equal('menu_item_id', item.$id), Query.limit(100)]),
        db.listDocuments(DB_ID, 'menu_item_addon_groups', [Query.equal('menu_item_id', item.$id), Query.limit(100)]),
      ]);
      await Promise.all([
        ...cats.documents.map((d) => db.deleteDocument(DB_ID, 'menu_item_categories', d.$id)),
        ...addons.documents.map((d) => db.deleteDocument(DB_ID, 'menu_item_addon_groups', d.$id)),
      ]);
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
                  <th style={{ width: '3.5rem' }} />
                  <th>Name</th>
                  <th>Categories</th>
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
                      {previewUrl(i.image_id, 'menu', settings, 96, 96) ? (
                        <img
                          src={previewUrl(i.image_id, 'menu', settings, 96, 96) as string}
                          alt=""
                          style={{ width: 40, height: 40, borderRadius: 6, objectFit: 'cover', display: 'block' }}
                        />
                      ) : (
                        <div style={{ width: 40, height: 40, borderRadius: 6, background: 'var(--surface-2)' }} />
                      )}
                    </td>
                    <td>
                      <div style={{ fontWeight: 550 }}>{i.name}</div>
                      {i.description && <div className="small dim">{i.description.slice(0, 70)}{i.description.length > 70 ? '…' : ''}</div>}
                    </td>
                    <td className="dim small">
                      {categoriesFor(i).length === 0 ? (
                        <Badge tone="danger">No category</Badge>
                      ) : (
                        categoriesFor(i).map((c) => (
                          <span key={c} className="badge" style={{ marginRight: '0.25rem' }}>{byCategory[c] ?? 'unknown'}</span>
                        ))
                      )}
                    </td>
                    <td className="num">{settings ? formatMoney(i.price, settings) : i.price}</td>
                    <td className="num dim">{i.prep_minutes}m</td>
                    <td>{i.active ? <Badge tone="ok">Active</Badge> : <Badge>Hidden</Badge>}</td>
                    <td className="num">
                      <Button size="sm" variant="ghost" onClick={() => open(i)}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => open(i, true)} title="Copy this dish, options and all">
                        Duplicate
                      </Button>
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
          <ImageField
            fileId={editing.image_id}
            purpose="menu"
            settings={settings}
            onChange={(id) => setEditing({ ...editing, image_id: id ?? '' })}
          />

          <Field
            label="Categories"
            hint="A dish can sit in several. It shows in each one during that category's own available hours, so the same dish can appear at lunch and again at dinner. The first one ticked is its main category and sets the default kitchen station."
          >
            <div className="stack" style={{ gap: '0.35rem', marginTop: '0.2rem' }}>
              {categories.map((c) => {
                const on = pickedCategories.includes(c.$id);
                const isPrimary = pickedCategories[0] === c.$id;
                return (
                  <div className="row" key={c.$id}>
                    <Toggle
                      checked={on}
                      onChange={(v) =>
                        setPickedCategories((p) => (v ? [...p, c.$id] : p.filter((x) => x !== c.$id)))
                      }
                      label={c.name}
                    />
                    {isPrimary && <Badge tone="ok">Main</Badge>}
                  </div>
                );
              })}
            </div>
          </Field>

          <div className="grid-2">
            <Field label={`Price (${settings?.currency_symbol ?? ''})`}>
              <Input value={priceText} inputMode="decimal" onChange={(e) => setPriceText(e.target.value)} />
            </Field>
            <Field label="Prep time (minutes)" hint="Used to estimate waits and to time pre-orders.">
              <Input type="number" min="0" value={editing.prep_minutes ?? 10} onChange={(e) => setEditing({ ...editing, prep_minutes: Number(e.target.value) })} />
            </Field>
            <StationPicker
              stations={stations}
              value={editing.station_key ?? ''}
              onChange={(key) => setEditing({ ...editing, station_key: key })}
              inheritLabel="Same as its main category"
            />
          </div>
          <Field>
            <Toggle checked={editing.active ?? true} onChange={(v) => setEditing({ ...editing, active: v })} label="Active — shown on the menu" />
          </Field>
          <Field hint="Only for items made from ingredients you count. Leave off for drinks you buy in.">
            <Toggle checked={editing.track_stock ?? false} onChange={(v) => setEditing({ ...editing, track_stock: v })} label="Track ingredient stock for this item" />
          </Field>

          <Field
            label="Option groups"
            hint={
              addonGroups.length === 0
                ? 'None built yet. Create them under Menu → Options — for example “Choose your protein”.'
                : 'Choices the customer makes for this dish. Build and price them under Menu → Options.'
            }
          >
            <div className="stack" style={{ gap: '0.35rem', marginTop: '0.2rem' }}>
              {addonGroups.map((g) => (
                <Toggle
                  key={g.$id}
                  checked={pickedAddons.includes(g.$id)}
                  onChange={(v) => setPickedAddons((p) => (v ? [...p, g.$id] : p.filter((x) => x !== g.$id)))}
                  label={
                    <>
                      {g.name} {g.required && <Badge tone="warn">Required</Badge>}
                    </>
                  }
                />
              ))}
            </div>
          </Field>
        </Modal>
      )}
    </>
  );
}
