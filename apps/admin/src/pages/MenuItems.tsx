import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Spinner, Textarea, Toggle, Badge, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import {
  formatMoney, parseMoney, toInput, previewUrl, Query, loadConsignors, loadVariants, canEditCatalogue,
  loadVariantTypes,
} from '@snpos/core';
import type { Category, MenuItem, Ingredient, Recipe, Doc, Consignor, VariantType } from '@snpos/core';
import { ConsignmentFields, draftVariantsFrom, type DraftVariant } from '../components/ConsignmentFields';
import { KeyedListManager } from '../components/KeyedList';
import { ImageField } from '../components/ImageField';
import { RecipeEditor, draftFrom, type DraftRecipe } from '../components/RecipeEditor';
import { StationPicker, useStations, legacyStationFor } from '../components/StationPicker';
import { useSession } from '../session';

interface ItemCategory extends Doc { menu_item_id: string; category_id: string; sort: number; active: boolean }
interface AddonGroup extends Doc { name: string; required: boolean; sort: number }
interface ItemAddonGroup extends Doc { menu_item_id: string; group_id: string; sort: number }

/**
 * The catalogue, for one side of the business at a time.
 *
 * Same screen, same job, a name, a price, a picture, a category, scoped so
 * the kitchen and the shop never share a list. What differs is which extra
 * fields matter: a dish has a prep time and a station, a consigned piece has a
 * maker and a commission, and neither wants the other's questions.
 */
export function MenuItemsPage({ module = 'kitchen' }: { module?: 'kitchen' | 'craft' }) {
  /**
   * What this side of the business calls the thing on the shelf.
   *
   * A shop assistant reading "Dishes & drinks" above a page of woven baskets
   * is being asked to translate on every visit, and the translation is not the
   * screen's to ask for.
   */
  const W = module === 'craft'
    ? { title: 'Products', one: 'product', many: 'products', first: 'Add your first piece, with its price.' }
    : { title: 'Dishes & drinks', one: 'dish', many: 'dishes', first: 'Add your first dish or drink, with its price.' };
  const { settings, profile } = useSession();
  const mayEdit = canEditCatalogue(profile);
  const toast = useToast();
  const stations = useStations();
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [links, setLinks] = useState<ItemCategory[]>([]);
  const [addonGroups, setAddonGroups] = useState<AddonGroup[]>([]);
  const [itemAddons, setItemAddons] = useState<ItemAddonGroup[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [draftRecipes, setDraftRecipes] = useState<DraftRecipe[]>([]);
  const [removedRecipeIds, setRemovedRecipeIds] = useState<string[]>([]);
  // Chosen in the editor; written as join rows on save.
  const [pickedCategories, setPickedCategories] = useState<string[]>([]);
  const [pickedAddons, setPickedAddons] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<Partial<MenuItem> | null>(null);
  const [priceText, setPriceText] = useState('');
  /**
   * Kept as text, like every other number on a form here.
   *
   * Bound straight to a number, backspacing the last digit produced an empty
   * string, Number('') came back as 0, and the box refilled itself with the
   * zero somebody had just deleted. Nobody can type over that.
   */
  const [onHandText, setOnHandText] = useState('0');
  const [consignors, setConsignors] = useState<Consignor[]>([]);
  const [variantTypes, setVariantTypes] = useState<VariantType[]>([]);
  const [tab, setTab] = useState<'items' | 'types'>('items');
  const [variants, setVariants] = useState<DraftVariant[]>([]);
  const [removedVariantIds, setRemovedVariantIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const decimals = settings?.currency_decimals ?? 2;

  const load = async () => {
    const [i, c, l, g, ia, ing, r] = await Promise.all([
      listAll<MenuItem>('menu_items'),
      listAll<Category>('categories'),
      listAll<ItemCategory>('menu_item_categories'),
      listAll<AddonGroup>('addon_groups'),
      listAll<ItemAddonGroup>('menu_item_addon_groups'),
      listAll<Ingredient>('ingredients'),
      listAll<Recipe>('recipes'),
    ]);
    // Rows written before modules existed have none, and were kitchen rows.
    const mine = (x: { module?: string }) => (x.module ?? 'kitchen') === module;
    setItems(i.filter(mine).sort((a, b) => a.sort - b.sort));
    setCategories(c.filter(mine).sort((a, b) => a.sort - b.sort));
    setLinks(l);
    setAddonGroups(g.sort((a, b) => a.sort - b.sort));
    setItemAddons(ia);
    setIngredients(ing.filter((x) => x.active).sort((a, b) => a.name.localeCompare(b.name)));
    setRecipes(r);
    // Only the shop needs these, and only the shop pays for the round trip.
    if (module === 'craft') {
      const [people, types] = await Promise.all([loadConsignors().catch(() => []), loadVariantTypes()]);
      setConsignors(people);
      setVariantTypes(types);
    }
  };
  useEffect(() => { load().catch((e) => setError(humanError(e))); }, [module]);

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
          name: '', description: '', price: 0, category_id: '',
          active: true, prep_minutes: 10, station: 'inherit', sort: (items?.length ?? 0) + 1,
          track_stock: false, image_focal_x: 0.5, image_focal_y: 0.5,
        };
    // An older dish only has the built-in `station`; carry it across so opening
    // a dish to change its price cannot silently move it to another station.
    base.station_key = item ? item.station_key || (item.station !== 'inherit' ? item.station : '') : '';
    setEditing(base);
    setPriceText(toInput(base.price ?? 0, decimals));
    setOnHandText(String(base.on_hand ?? 0));
    // Nothing pre-ticked on a new dish.
    //
    // It used to tick whichever category sorted first, which quietly filed
    // every new dish under "Everyday", and because a pre-ticked box is one
    // nobody reads, a Thursday special added on Thursday ended up in both,
    // showing every day of the week. Choosing where a dish goes is the whole
    // job here; it should not have a default.
    setPickedCategories(item ? categoriesFor(item) : []);
    setPickedAddons(item ? itemAddons.filter((a) => a.menu_item_id === item.$id).map((a) => a.group_id) : []);
    // A copy takes the recipe with it but none of the row ids, so saving writes
    // a second recipe rather than moving the original's.
    setDraftRecipes(
      item
        ? recipes
            .filter((r) => r.menu_item_id === item.$id)
            .map(draftFrom)
            .map((d) => (copy ? { ...d, $id: undefined } : d))
        : [],
    );
    setRemovedRecipeIds([]);
    // Sizes come from the database rather than from the row in the list, since
    // nothing else on this page needs them. A copy takes the sizes but not
    // their ids, so saving writes new rows instead of moving the original's.
    setRemovedVariantIds([]);
    setVariants([]);
    if (module === 'craft' && item?.$id) {
      void loadVariants(item.$id)
        .then((rows) => {
          const drafts = draftVariantsFrom(rows, decimals);
          setVariants(copy ? drafts.map((d) => ({ ...d, $id: undefined })) : drafts);
        })
        .catch(() => undefined);
    }
    setError(null);
  };

  /**
   * Reconcile the join rows to match what was ticked.
   *
   * Only the difference is written, leaving untouched rows alone keeps their
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

    for (const id of removedRecipeIds) {
      await db.deleteDocument(DB_ID, 'recipes', id).catch(() => undefined);
    }
    await Promise.all(
      draftRecipes
        .filter((d) => d.ingredient_id && Number(d.qtyText) > 0)
        .map((d) => {
          const body = {
            menu_item_id: itemId,
            addon_option_id: '',
            ingredient_id: d.ingredient_id,
            qty_per_unit: Number(d.qtyText),
            wastage_bp: Math.round(Number(d.wastageText || 0) * 100),
          };
          return d.$id
            ? db.updateDocument(DB_ID, 'recipes', d.$id, body)
            : db.createDocument(DB_ID, 'recipes', ID.unique(), body);
        }),
    );

    // ------------------------------------------------------------- sizes
    //
    // A size that has already sold something is switched off rather than
    // deleted. Its id is on sale lines, on movements and on somebody's
    // statement, and deleting it would leave those pointing at nothing, the
    // shop would be unable to say what the customer actually bought.
    for (const id of removedVariantIds) {
      await db.updateDocument(DB_ID, 'product_variants', id, { active: false }).catch(() => undefined);
    }
    for (const v of variants) {
      if (!v.label.trim()) continue;
      const price = parseMoney(v.priceText, decimals);
      if (price === null) continue;
      const body = {
        venue_id: 'main',
        menu_item_id: itemId,
        label: v.label.trim(),
        // The legacy enum only has to stay valid; kind_key is what is read.
        kind: (['size', 'colour', 'finish'] as string[]).includes(v.kindKey) ? v.kindKey : 'other',
        kind_key: v.kindKey,
        price,
        sku: v.sku.trim(),
        barcode: v.barcode.trim(),
        on_hand: Number(v.onHandText || 0),
        sort: variants.indexOf(v),
        active: v.active,
      };
      if (v.$id) await db.updateDocument(DB_ID, 'product_variants', v.$id, body);
      else await db.createDocument(DB_ID, 'product_variants', ID.unique(), body);
    }
  };

  const save = async () => {
    if (!mayEdit) { setError('Only a manager or the owner can change what is for sale.'); return; }
    const thing = W.one;
    if (!editing?.name?.trim()) { setError(`This ${thing} needs a name.`); return; }
    if (pickedCategories.length === 0) {
      setError(`Tick at least one category; that is where this ${thing} appears.`);
      return;
    }
    // A size with no price would sell for nothing and be blamed on the till.
    const badSize = variants.find((v) => v.label.trim() && parseMoney(v.priceText, decimals) === null);
    if (badSize) { setError(`"${badSize.label}" needs a price.`); return; }
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
      module,
      // Consignment. Blank on every kitchen row, and nothing reads them there.
      consignor_id: editing.consignor_id ?? '',
      commission_bp: editing.commission_bp ?? undefined,
      barcode: editing.barcode ?? '',
      // Written explicitly. The count is what the shop floor reads, and
      // leaving it out of the payload left new pieces at whatever the column
      // defaulted to rather than what somebody typed.
      on_hand: Number(onHandText || 0),
      is_one_off: editing.is_one_off ?? false,
      maker_note: editing.maker_note ?? '',
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
      {/* The kinds of variation this shop sells by are the shop's own list, so
          they are edited where the products that use them are, rather than
          buried in a settings page nobody opens twice. */}
      {module === 'craft' && (
        <div className="row" style={{ gap: '0.4rem', marginBottom: '0.8rem' }}>
          <Button size="sm" variant={tab === 'items' ? 'primary' : 'default'} onClick={() => setTab('items')}>
            Products
          </Button>
          <Button size="sm" variant={tab === 'types' ? 'primary' : 'default'} onClick={() => setTab('types')}>
            Variant types
          </Button>
        </div>
      )}

      {module === 'craft' && tab === 'types' ? (
        <KeyedListManager
          collection="variant_types"
          singular="variant type"
          hint="The kinds of variation your products come in. A pottery studio sells by glaze, a weaver by width. Rename freely: products already using one stay with it."
          onChanged={() => void loadVariantTypes().then(setVariantTypes)}
        />
      ) : (
      <>
      <div className="spread">
        <h1>{W.title}</h1>
        {/* Reading and changing are different jobs. Somebody who opens this
            page twenty times a day to check a price needs to create a product
            roughly never, and every person who can create one is a person whose
            slip reaches the shop floor at a price customers get charged. */}
        {mayEdit && (
          <Button variant="primary" onClick={() => open()} disabled={categories.length === 0}>
            Add {W.one}
          </Button>
        )}
      </div>

      {categories.length === 0 && (
        <Notice tone="warn">Create at least one category first, every {W.one} belongs to one.</Notice>
      )}
      {error && !editing && <Notice>{error}</Notice>}

      {items && items.length > 0 && (
        <Input placeholder="Search by name…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      )}

      <Card pad={false}>
        {!items ? (
          <div className="card-pad"><Spinner /></div>
        ) : visible.length === 0 ? (
          <Empty title={items.length === 0 ? `No ${W.many} yet` : 'Nothing matches that search'}>
            {items.length === 0 && W.first}
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
                      {(() => {
                        const n = recipes.filter((r) => r.menu_item_id === i.$id).length;
                        if (n > 0) return <span className="small dim">{n} ingredient{n > 1 ? 's' : ''}</span>;
                        // Only worth flagging when the dish claims to track stock:
                        // a bottled drink has no recipe and needs none.
                        return i.track_stock ? <Badge tone="warn">No recipe</Badge> : null;
                      })()}
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
                      <Button size="sm" variant="ghost" onClick={() => open(i)}>
                        {mayEdit ? 'Edit' : 'View'}
                      </Button>
                      {mayEdit && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => open(i, true)} title={`Copy this ${W.one}, options and all`}>
                            Duplicate
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => remove(i)}>Delete</Button>
                        </>
                      )}
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
              {mayEdit && <Button variant="primary" onClick={save} loading={busy}>Save</Button>}
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
            hint={module === 'craft'
              ? 'A product appears under every category ticked here. The first one ticked is its main category.'
              : 'A dish appears under every category ticked here. Tick two and it shows twice, so a Thursday special should be ticked for Thursday only, not for Thursday and Everyday. The first one ticked is its main category and sets the default kitchen station.'}
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
            <Field
              label={`Price (${settings?.currency_symbol ?? ''})`}
              hint={module === 'craft' && variants.length > 0 ? 'Ignored, each size below carries its own price.' : undefined}
            >
              <Input value={priceText} inputMode="decimal" onChange={(e) => setPriceText(e.target.value)} />
            </Field>
            {module === 'kitchen' && (
              <Field label="Prep time (minutes)" hint="Used to estimate waits and to time pre-orders.">
                <Input type="number" min="0" value={editing.prep_minutes ?? 10} onChange={(e) => setEditing({ ...editing, prep_minutes: Number(e.target.value) })} />
              </Field>
            )}
            {module === 'kitchen' && (
              <StationPicker
                stations={stations}
                value={editing.station_key ?? ''}
                onChange={(key) => setEditing({ ...editing, station_key: key })}
                inheritLabel="Same as its main category"
              />
            )}
          </div>
          <Field>
            <Toggle checked={editing.active ?? true} onChange={(v) => setEditing({ ...editing, active: v })} label={module === 'craft' ? 'For sale' : 'Active, shown on the menu'} />
          </Field>
          {module === 'kitchen' && (
            <Field hint="Only for items made from ingredients you count. Leave off for drinks you buy in.">
              <Toggle checked={editing.track_stock ?? false} onChange={(v) => setEditing({ ...editing, track_stock: v })} label="Track ingredient stock for this item" />
            </Field>
          )}

          {module === 'craft' && (
            <ConsignmentFields
              editing={editing}
              setEditing={setEditing}
              onHandText={onHandText}
              setOnHandText={setOnHandText}
              variantTypes={variantTypes}
              consignors={consignors}
              variants={variants}
              setVariants={setVariants}
              removedVariantIds={removedVariantIds}
              setRemovedVariantIds={setRemovedVariantIds}
              symbol={settings?.currency_symbol ?? ''}
              decimals={decimals}
            />
          )}

          {/* Recipes and option groups are the kitchen's. A woven basket is not
              made from ingredients the shop counts, and "Choose your protein"
              has no meaning on a shelf. Both were showing on the craft form and
              both were noise there. */}
          {module === 'kitchen' && (
          <>
          <RecipeEditor
            ingredients={ingredients}
            draft={draftRecipes}
            setDraft={(f) =>
              setDraftRecipes((d) => {
                const next = f(d);
                // Anything that disappeared and had been saved must be deleted
                // on save, not merely forgotten about.
                const gone = d.filter((x) => x.$id && !next.some((y) => y.$id === x.$id));
                if (gone.length) setRemovedRecipeIds((r) => [...r, ...gone.map((x) => x.$id as string)]);
                return next;
              })
            }
            price={parseMoney(priceText, decimals) ?? 0}
            settings={settings}
          />

          {editing.track_stock && draftRecipes.length === 0 && (
            <div style={{ marginBottom: '1rem' }}>
              <Notice tone="warn">
                Stock tracking is on but nothing is listed above, so selling this will take nothing off the shelf. Add
                what a portion uses, or turn the tracking off.
              </Notice>
            </div>
          )}

          <Field
            label="Option groups"
            hint={
              addonGroups.length === 0
                ? 'None built yet. Create them under Menu → Options, for example “Choose your protein”.'
                : `Choices the customer makes for this ${W.one}. Build and price them under Kitchen → Options.`
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
          </>
          )}
        </Modal>
      )}
      </>
      )}
    </>
  );
}
