import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Select, Notice, Spinner, Textarea, Toggle, Badge, useToast, ViewTabs,
  PickerMenu, PickerItem, FacetChips, GroupedRows,
} from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError, saveDropping } from '../lib';
import {
  formatMoney, parseMoney, toInput, previewUrl, Query, loadConsignors, loadVariants, canEditCatalogue, canDeleteCatalogue,
  loadVariantTypes,
  matches, sortItems, ITEM_SORTS,
  marginOf, marginIsThin, bpAsPercent, MARGIN_WARN_BP_DEFAULT,
  diffFields, describeChanges, fitForLog, PRODUCT_WATCH,
  hasOwnRecipe, sizesNeedOwnStock, giveSizeItsOwnStock, repairSizeStock, newShelfCadence,
  groupRows, sortRows, toggleGroup, cycleSort, sortDir, sortPosition,
  pendingShelfLines, submitShelfChange, frozenPieces, frozenBy, needsApproval, shelfChangeProblem, sentWords,
  isService, SERVICE_LABEL,
} from '@snpos/core';
import type { ItemSort, Module, Category, MenuItem, Ingredient, Recipe, Doc, Consignor, VariantType, GroupChoice, SortChoice, WaitingChange, StaffProfile, ProductVariant } from '@snpos/core';
import { ConsignmentFields, draftVariantsFrom, type DraftVariant } from '../components/ConsignmentFields';
// Which sizes this drink still sells, and what makes two of them a clash.
import { liveSizes, retiredSizes, sizeProblem, retiredWords } from '@snpos/core';
import { ReassignSupplier } from '../components/ReassignSupplier';
import { KeyedListManager } from '../components/KeyedList';
import { SalesHistory } from '../components/SalesHistory';
import { ImageField } from '../components/ImageField';
import { RecipeEditor, draftFrom, type DraftRecipe } from '../components/RecipeEditor';
import { StationPicker, useStations, legacyStationFor } from '../components/StationPicker';
import { StockUpload } from '../components/StockUpload';
import { DrinkUpload } from '../components/DrinkUpload';
import { useSession } from '../session';

interface ItemCategory extends Doc { menu_item_id: string; category_id: string; sort: number; active: boolean }
interface AddonGroup extends Doc { name: string; required: boolean; sort: number; module?: string }
interface ItemAddonGroup extends Doc { menu_item_id: string; group_id: string; sort: number }

/**
 * The catalogue, for one side of the business at a time.
 *
 * Same screen, same job, a name, a price, a picture, a category, scoped so
 * the kitchen and the shop never share a list. What differs is which extra
 * fields matter: a dish has a prep time and a station, a consigned piece has a
 * maker and a commission, and neither wants the other's questions.
 */
export function MenuItemsPage({ module = 'kitchen' }: { module?: Module }) {
  /**
   * What this side of the business calls the thing on the shelf.
   *
   * A shop assistant reading "Dishes & drinks" above a page of woven baskets
   * is being asked to translate on every visit, and the translation is not the
   * screen's to ask for. The bar had the same complaint for the same reason:
   * it was written when there were two sides, so a third fell through to the
   * kitchen's words and offered to "Add dish" on a page of cocktails.
   */
  const W = module === 'craft'
    ? { title: 'Products', one: 'product', many: 'products', first: 'Add your first piece, with its price.' }
    : module === 'bar'
      ? { title: 'Drinks & cocktails', one: 'drink', many: 'drinks', first: 'Add your first drink, with its price.' }
      : { title: 'Dishes & drinks', one: 'dish', many: 'dishes', first: 'Add your first dish or drink, with its price.' };
  const { settings, profile, user } = useSession();
  const mayEdit = canEditCatalogue(profile);
  const mayDelete = canDeleteCatalogue(profile);
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
  const [onlyCategory, setOnlyCategory] = useState('');
  /**
   * Archived items are out of the way, not gone.
   *
   * A seasonal cocktail comes back next year with its recipe, its price and
   * its history. Deleting it to get it off the board throws all three away,
   * and the only alternative on offer was deleting it.
   */
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = (items ?? []).filter((i) => !i.active).length;

  /** Costings are an owner's business, not a cook's. */
  const isAdmin = profile?.role === 'admin';
  const warnBp = settings?.margin_warn_bp ?? MARGIN_WARN_BP_DEFAULT;

  /**
   * What this item costs and keeps, at today's ingredient prices.
   *
   * Worked out from the recipes already loaded for this page rather than
   * asking again per row: a bar with eighty drinks would otherwise make eighty
   * queries to draw one table.
   */
  const marginFor = (item: MenuItem) =>
    marginOf(
      item.price,
      recipes
        .filter((r) => r.menu_item_id === item.$id)
        .map((r) => ({ ingredientId: r.ingredient_id, qtyPerUnit: r.qty_per_unit, wastageBp: r.wastage_bp })),
      ingredients,
    );
  const [sortBy, setSortBy] = useState<ItemSort>('menu');
  /*
    Grouping and sorting, stacked in the order they were chosen.

    A consignment shop's first question about its own catalogue is whose it
    is: what has Ama got with us, what is left of Kofi's, who is the shelf of
    unsold baskets actually owed to. That was answerable only by reading two
    hundred rows and remembering.
  */
  const [groups, setGroups] = useState<GroupChoice[]>([]);
  const [sorts, setSorts] = useState<SortChoice[]>([]);
  const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set());
  const [listMenu, setListMenu] = useState<'group' | 'sort' | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadingDrinks, setUploadingDrinks] = useState(false);
  const [editing, setEditing] = useState<Partial<MenuItem> | null>(null);
  /**
   * Which row's sales history is open.
   *
   * The name is carried alongside the id so the panel can head itself without
   * looking the row up again — and so it still says what it is about after the
   * list behind it has been filtered or reloaded.
   */
  const [historyFor, setHistoryFor] = useState<{ id: string; name: string } | null>(null);
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
  /**
   * Whether this side sells the same thing in more than one size.
   *
   * The shop does — a basket in three sizes is three prices — and so does the
   * bar, which was the omission: a spirit as a single and a double, a wine by
   * the glass and the carafe. A kitchen does not; a dish that comes in two
   * sizes is two dishes, or an option group.
   */
  const hasSizes = module === 'craft' || module === 'bar';
  /*
    A supplier being changed on a product that already has a history.

    Changing the field alone silently picks one of four answers — the one where
    the stock moves and the past does not — and it is the answer somebody wants
    least often. So the save stops and asks, and the server does the work,
    because the consignor ledger cannot be written from here at all.
  */
  const [reassigning, setReassigning] = useState<{ itemId: string; from: string; to: string } | null>(null);
  const [tab, setTab] = useState<'items' | 'types'>('items');
  const [variants, setVariants] = useState<DraftVariant[]>([]);
  const [removedVariantIds, setRemovedVariantIds] = useState<string[]>([]);
  /**
   * Sizes kept only because sales already went through them.
   *
   * Held whole rather than counted, so one can be put back. Retiring a size is
   * one press and undoing it was nothing at all — somebody who removes the
   * wrong one of two identical rows is left rebuilding it by hand, which makes
   * a new size with a new id and starts the whole tangle again.
   */
  const [retired, setRetired] = useState<ProductVariant[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Shelf changes an admin has not decided about yet.
   *
   * A changed shelf figure does not land here — it waits, and the piece it
   * belongs to cannot be changed again until somebody has said yes or no. See
   * shelf-approval for why, and the save path below for what happens instead.
   */
  const [waiting, setWaiting] = useState<WaitingChange[]>([]);
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  /**
   * What each size's shelf said when this form was opened.
   *
   * Needed because the draft row holds what has been TYPED, and "has this
   * changed" cannot be answered from that alone. Read from the rows the form
   * loaded rather than fetched again on save: a second read would be a round
   * trip to learn something already on screen, and it would also quietly
   * compare against a figure that moved while somebody was typing.
   */
  const [variantWas, setVariantWas] = useState<Record<string, number>>({});
  const frozen = useMemo(() => frozenPieces(waiting), [waiting]);
  const whoChanged = (id: string) =>
    staff.find((s) => s.user_id === id || s.$id === id)?.display_name ?? 'Somebody';
  /**
   * How many of a product's sizes are held.
   *
   * The list has no shelf column and the sizes are not loaded for it, so this
   * counts what is waiting rather than looking at any product row. It is what
   * lets the badge appear against a basket whose LARGE is held and whose own
   * figure is not.
   */
  const variantsFrozenFor = (itemId: string) =>
    waiting.filter((w) => w.line.menu_item_id === itemId && w.line.variant_id).length;

  /**
   * The people who can be named against a product's price.
   *
   * Admins are left out. They always may, and a ticked box that cannot be
   * unticked teaches people that the boxes do not mean anything. Somebody who
   * has left is left out too — an old name in a permission list is a question
   * nobody can answer a year later.
   */
  const repriceStaff = useMemo(
    () => staff
      .filter((s) => s.active !== false && s.role !== 'admin')
      .sort((a, b) => (a.display_name ?? '').localeCompare(b.display_name ?? '')),
    [staff],
  );

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
    /*
      This side's choices only.

      Every group used to show on every side, so a gin and tonic was offered
      "Rare, medium, well done" and a steak "Single or double". A list that
      offers nonsense is one people stop reading, including the lines on it
      that were right.
    */
    setAddonGroups(g.filter(mine).sort((a, b) => a.sort - b.sort));
    setItemAddons(ia);
    // This side's shelves only, so a drinks file cannot be told to pour rice
    // and a dish cannot be given gin.
    setIngredients(ing.filter((x) => x.active && mine(x)).sort((a, b) => a.name.localeCompare(b.name)));
    setRecipes(r);
    /*
      Sizes are the bar's problem as much as the shop's.

      A spirit sells as a single and a double, a beer by the bottle and the
      crate, a wine by the glass and the carafe — the same shape as a basket
      in three sizes, and each with its own price. Only consignors are the
      shop's alone.
    */
    if (module === 'craft' || module === 'bar') {
      const types = await loadVariantTypes().catch(() => []);
      setVariantTypes(types.filter((t) => (t.module ?? 'craft') === module));
    }
    // Every side. The shop reads these to say who is waiting on a shelf
    // change; all three read them for the per-product price permission, and a
    // bar that could not name anybody would have a box with nothing in it.
    setStaff(await listAll<StaffProfile>('staff_profiles').catch(() => []));
    if (module === 'craft') {
      setConsignors(await loadConsignors().catch(() => []));
      // Never fatal. A page that will not open because it could not find out
      // what is waiting is worse than one that opens with nothing held.
      setWaiting(await pendingShelfLines().catch(() => []));
    }
  };
  useEffect(() => { load().catch((e) => setError(humanError(e))); }, [module]);

  const byCategory = useMemo(() => Object.fromEntries(categories.map((c) => [c.$id, c.name])), [categories]);
  /**
   * Narrowed, then ordered.
   *
   * Seventy-nine drinks in one fixed order with a name box over the top is
   * fine at ten rows and useless at eighty: "what is the dearest thing on the
   * board" and "show me the beers" both meant scrolling and reading.
   */
  const visible = useMemo(
    () => sortItems(
      (items ?? [])
        .filter((i) => showArchived || i.active)
        .filter((i) => matches(i.name, filter))
        // A dish can sit in several categories, so the filter asks whether it
        // is in this one at all rather than whether it is its primary.
        .filter((i) => !onlyCategory
          || i.category_id === onlyCategory
          || links.some((l) => l.menu_item_id === i.$id && l.category_id === onlyCategory && l.active !== false))
        .map((i) => ({ ...i, categoryName: byCategory[i.category_id] ?? '' })),
      sortBy,
    ),
    [items, filter, onlyCategory, sortBy, links, byCategory, showArchived],
  );

  /**
   * What this side can be grouped and sorted by.
   *
   * The owner only where there is one. On a kitchen or a bar nothing has a
   * maker, so offering it would be a control that empties the list into a
   * single group called "—".
   */
  const GROUPABLE: GroupChoice[] = [
    ...(module === 'craft' ? [{ key: 'owner', label: 'Owner' }] : []),
    { key: 'category', label: 'Category' },
    { key: 'status', label: 'Status' },
  ];
  const SORTABLE = [
    ...(module === 'craft' ? [{ key: 'owner', label: 'Owner' }] : []),
    { key: 'name', label: 'Name' },
    { key: 'category', label: 'Category' },
    { key: 'price', label: 'Price' },
    ...(module === 'craft' ? [{ key: 'on_hand', label: 'On the shelf' }] : []),
  ];

  const ownerName = (id?: string) => consignors.find((c) => c.$id === id)?.name ?? '';

  const groupValue = (i: MenuItem & { categoryName?: string }, key: string): string => {
    if (key === 'owner') return ownerName(i.consignor_id) || 'The shop’s own';
    if (key === 'category') return i.categoryName || byCategory[i.category_id] || '';
    if (key === 'status') return i.active ? (module === 'craft' ? 'For sale' : 'Active') : 'Archived';
    return String((i as unknown as Record<string, unknown>)[key] ?? '');
  };

  const compareItems = (a: MenuItem, b: MenuItem, key: string): number => {
    if (key === 'price') return (a.price ?? 0) - (b.price ?? 0);
    if (key === 'on_hand') return (a.on_hand ?? 0) - (b.on_hand ?? 0);
    if (key === 'owner') return ownerName(a.consignor_id).localeCompare(ownerName(b.consignor_id));
    if (key === 'category') return (byCategory[a.category_id] ?? '').localeCompare(byCategory[b.category_id] ?? '');
    return (a.name ?? '').localeCompare(b.name ?? '');
  };

  // Sorted first, then grouped, so the order holds inside every group.
  const ordered = useMemo(
    () => (sorts.length ? sortRows(visible, sorts, compareItems) : visible),
    [visible, sorts],
  );
  const tree = useMemo(() => groupRows(ordered, groups, groupValue), [ordered, groups, consignors]);

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
    setVariantWas({});
    if (hasSizes && item?.$id) {
      void loadVariants(item.$id)
        .then((all) => {
          /*
            ONLY THE SIZES THIS DRINK STILL SELLS.

            A size that has already sold something is switched off rather than
            deleted — its id is on order lines and stock movements — and this
            form asked for every size the drink had ever had and drew them all
            the same way. A retired Large beside the Large that replaced it
            showed as two Larges with nothing to tell them apart, which is
            exactly what got reported as a duplicate.

            The retired ones are left alone rather than hidden and forgotten:
            the count is said under the list, because somebody who finds no
            trace of a size they retired assumes it was lost and adds it again.
          */
          const rows = liveSizes(all);
          setRetired(retiredSizes(all));
          return rows;
        })
        .then((rows) => {
          // A copy is a new product with new sizes, so none of these figures
          // is a previous figure to disagree with.
          setVariantWas(copy ? {} : Object.fromEntries(rows.map((r) => [r.$id, r.on_hand ?? 0])));
          const drafts = draftVariantsFrom(rows, decimals).map((d) => ({
            // A size already bound to its own ingredient keeps the toggle on,
            // so opening a drink and saving it again does not make a second
            // stock item for a shelf that already exists.
            ...d,
            /*
              And a drink that pours nothing has its sizes as the stock.

              Off by default was the wrong answer twice: a bottled beer with a
              small and a large, both leaning on a drink that has no recipe,
              so nothing depletes and the count sheet asks for the drink once.
              The toggle was there and the warning was there, and neither is
              much use to somebody setting up ten drinks who has no reason to
              expect a stock question inside a price editor.

              A drink WITH a recipe is left alone — it already says what it
              pours, and a gin's double comes out of the same bottle as its
              single. See sizesNeedOwnStock.
            */
            ownStock: (!!d.$id && hasOwnRecipe(recipes, item.$id, d.$id))
              || sizesNeedOwnStock(recipes, item.$id, module),
          }));
          setVariants(copy ? drafts.map((d) => ({ ...d, $id: undefined })) : drafts);
        })
        .catch(() => undefined);
    }
    setError(null);
  };

  /** A size's shelf figure that has to go past an admin before it moves. */
  interface ShelfChange { variantId: string; label: string; price: number; was: number; now: number }

  /**
   * Reconcile the join rows to match what was ticked.
   *
   * Only the difference is written, leaving untouched rows alone keeps their
   * per-category sort order, which a delete-and-recreate would throw away.
   *
   * Returns the shelf changes it did NOT write, so the save can send them to be
   * approved and say so. Collected here rather than sent from here: this
   * function's job is to make the database match the form, and a screen that
   * announced an approval halfway through saving a product would be announcing
   * it before the product it belongs to exists.
   */
  const syncLinks = async (itemId: string): Promise<ShelfChange[]> => {
    const shelfChanges: ShelfChange[] = [];
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
    /*
      A SIZE THAT FAILS TO RETIRE MUST SAY SO.

      This swallowed its error, and a swallowed error here is the worst kind:
      the form closes, says it saved, and the size is still on the menu and
      still sellable. Somebody removes it, reopens the drink, finds it there,
      removes it again — and nothing anywhere is wrong as far as any screen is
      concerned.
    */
    const notRetired: string[] = [];
    for (const id of removedVariantIds) {
      const done = await db.updateDocument(DB_ID, 'product_variants', id, { active: false })
        .then(() => true)
        .catch(() => false);
      if (!done) notRetired.push(id);
    }
    if (notRetired.length > 0) {
      // Thrown rather than returned: this runs inside the save, and the save's
      // own handler is what puts a message in front of somebody.
      throw new Error(
        `${notRetired.length} size${notRetired.length === 1 ? '' : 's'} could not be removed and ${notRetired.length === 1 ? 'is' : 'are'} `
        + 'still on the menu. Everything else was saved. Try again, and if it keeps happening the database is '
        + 'refusing the change and an admin should be told.',
      );
    }
    for (const v of variants) {
      if (!v.label.trim()) continue;
      const price = parseMoney(v.priceText, decimals);
      if (price === null) continue;
      /*
        THE SHELF FIGURE IS NOT SAVED WITH THE REST OF THE SIZE.

        On a size that already exists and whose count has moved, the number is
        left exactly as it is and the change is sent to be approved instead —
        see the shelf changes collected below. Everything else about the size
        still saves normally, so somebody correcting a price and a count in one
        go gets the price immediately and the count when an admin agrees.

        A NEW size keeps its figure, because it is what arrived rather than a
        disagreement with anything.
      */
      const held = v.$id ? Object.prototype.hasOwnProperty.call(variantWas, v.$id) : false;
      const wasOnShelf = v.$id ? variantWas[v.$id] ?? 0 : 0;
      // A size of a service is a rate for work, not a number of things.
      const shelfWaits = !isService({ module, is_service: editing?.is_service }) && needsApproval({
        module,
        existing: held,
        was: wasOnShelf,
        typed: v.onHandText,
      });
      if (shelfWaits) {
        shelfChanges.push({
          variantId: v.$id as string,
          label: v.label.trim(),
          price,
          was: wasOnShelf,
          now: Number(v.onHandText.trim()),
        });
      }
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
        on_hand: shelfWaits ? wasOnShelf : Number(v.onHandText || 0),
        sort: variants.indexOf(v),
        active: v.active,
      };
      const variantId = v.$id
        ? (await db.updateDocument(DB_ID, 'product_variants', v.$id, body)).$id
        : (await db.createDocument(DB_ID, 'product_variants', ID.unique(), body)).$id;

      /*
        A size that is its own thing on the shelf gets its own stock item.

        A small Club and a large Club are two objects: bought separately,
        stacked separately, counted separately at the bar and in the store, and
        running out of one says nothing about the other. Giving each its own
        ingredient is what makes it countable in both places at all, since
        counting works on ingredients and their locations.

        Not for every size, which is why it is a toggle rather than automatic.
        A double gin pours twice from the same bottle; inventing a "Gin ·
        Double" stock item would put a second, wrong number beside the one
        that is actually true.

        Created once. Afterwards the recipe binds the size to its stock item
        and this leaves both alone, so renaming a drink does not orphan the
        shelf it was counted on.
      */
      if (module === 'bar' && v.ownStock && !hasOwnRecipe(recipes, itemId, variantId)) {
        /*
          One implementation, shared with the repair on the list behind this
          form. Two ways in — saving a drink, and fixing every drink at once —
          and a second copy of "what a size's shelf looks like" is how the two
          end up disagreeing about the unit, the side, or whether it is counted
          each shift.

          Not swallowed. A size that silently fails to get its shelf behaves
          exactly like one nobody asked for: on the menu, priced, selling, and
          absent from every count, with nothing anywhere saying why.
        */
        await giveSizeItsOwnStock({
          venueId: 'main',
          menuItemId: itemId,
          variantId,
          drinkName: editing?.name ?? '',
          sizeLabel: v.label,
          kindKey: v.kindKey,
          /*
            Whatever the rest of this bar does.

            Worked out from the shelves that are not sizes, because ticking a
            shelf nobody asked to tick — in a bar that has ticked nothing —
            makes that one shelf the entire closing count and drops every
            other bottle off the sheet. See newShelfCadence.
          */
          countEachShift: newShelfCadence(
            ingredients.filter((i) => !recipes.some((r) => r.variant_id && r.ingredient_id === i.$id)),
          ),
        });
      }
    }

    return shelfChanges;
  };

  const [repairing, setRepairing] = useState(false);
  /**
   * Put every size that has no shelf onto one.
   *
   * Says what it did in figures, including nothing: "no drinks needed this"
   * is a useful answer, and a button that goes quiet is one people press
   * again to find out whether it worked.
   */
  const repairSizes = async () => {
    setRepairing(true);
    try {
      const { fixed, failed, realigned } = await repairSizeStock('main');
      await load();
      if (fixed === 0 && failed === 0 && realigned === 0) {
        toast('Every size already has its own shelf. Nothing needed changing.');
        return;
      }
      toast(
        `${fixed} size${fixed === 1 ? '' : 's'} now counted separately`
        + `${failed > 0 ? `, and ${failed} could not be` : ''}`
        + `${realigned > 0 ? `, and ${realigned} put back in step with the rest of the bar` : ''}. `
        + 'They start at nothing, so count the bar in to say what is there.',
        failed > 0 ? 'err' : undefined,
      );
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setRepairing(false);
    }
  };

  const save = async () => {
    if (!mayEdit) { setError('Only a manager or the owner can change what is for sale.'); return; }
    /*
      Has the supplier moved on a product that already exists?

      Only then is there a question to ask. A NEW piece has no history and no
      stock, so setting its supplier is just setting it; and a product whose
      supplier is unchanged is not being reassigned however else it is edited.
    */
    const before = editing?.$id ? (items ?? []).find((i) => i.$id === editing.$id) ?? null : null;
    const supplierChanged = module === 'craft'
      && !!before
      && (editing?.consignor_id ?? '') !== (before.consignor_id ?? '');
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
    /*
      Two sizes with one name is not a naming preference.

      The till draws a button per size, so the customer gets two identical
      ones — and only one of the two is bound to a shelf, which makes the
      other a drink that sells and pours nothing. Refused rather than warned
      about, because there is no version of this somebody meant.
    */
    const sizeClash = sizeProblem(variants.filter((v) => v.label.trim()));
    if (sizeClash) { setError(sizeClash); return; }

    /*
      The shelf figure, which is not simply a field on this form.

      Checked here so a bad one is refused before anything is written rather
      than being quietly rounded into a change an admin is then asked to
      approve. "Three and a half baskets" is not a shelf.
    */
    // A service has no shelf, so none of this applies to it — see
    // craft-services. Checking it would refuse a blank box on a thing that has
    // no count to put in one.
    const isWork = isService({ module, is_service: editing.is_service });
    if (module === 'craft' && !isWork && variants.length === 0) {
      const bad = shelfChangeProblem(onHandText);
      if (bad) { setError(bad); return; }
    }
    const badShelf = variants.find((v) => v.label.trim() && shelfChangeProblem(v.onHandText));
    if (module === 'craft' && !isWork && badShelf) {
      setError(`"${badShelf.label}" on the shelf: ${shelfChangeProblem(badShelf.onHandText)}`);
      return;
    }

    /*
      IS THE PRODUCT'S OWN SHELF FIGURE BEING CHANGED?

      If it is, it does not save with the rest — it goes to an admin, and the
      figure on the shelf stays exactly where it was until they agree. A price
      corrected in the same breath still saves immediately, which is the point
      of deciding this per field rather than refusing the whole save.
    */
    const shelfWas = before?.on_hand ?? 0;
    const ownShelfWaits = !isWork && needsApproval({
      module,
      existing: !!before && variants.length === 0,
      was: shelfWas,
      typed: onHandText,
    });

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
      /*
        Consignment. Blank on every kitchen row, and nothing reads them there.

        The supplier is deliberately NOT written here when it has changed on a
        product that already exists — see the check above the save. Writing it
        would answer, silently and always the same way, a question with four
        answers.
      */
      consignor_id: supplierChanged ? (before?.consignor_id ?? '') : (editing.consignor_id ?? ''),
      commission_bp: editing.commission_bp ?? undefined,
      // Zero means "no flat amount on this piece, use the percentage". Written
      // either way so switching a piece back to a share actually clears it.
      commission_flat: editing.commission_flat ?? 0,
      barcode: editing.barcode ?? '',
      // Written explicitly. The count is what the shop floor reads, and
      // leaving it out of the payload left new pieces at whatever the column
      // defaulted to rather than what somebody typed.
      //
      // Except where it is waiting for an admin, and then the old figure is
      // written back deliberately rather than left out: leaving it out would
      // save nothing here and be right, but it would also mean the one line
      // that keeps the shelf still depends on a field being absent, which is
      // the kind of thing a later edit removes without noticing.
      on_hand: ownShelfWaits ? shelfWas : Number(onHandText || 0),
      is_one_off: editing.is_one_off ?? false,
      maker_note: editing.maker_note ?? '',
      // Work rather than goods. Written on every side so switching a product
      // back to goods actually clears it; false is the honest value for a dish
      // and for a bottle, and nothing outside the shop reads it at all.
      is_service: editing.is_service ?? false,
      // Who may change this price at the till. Written even when empty, so
      // taking the last person off a product actually takes them off it.
      price_editors: editing.price_editors ?? [],
    };
    try {
      /**
       * Saved field by field rather than all or nothing.
       *
       * Appwrite refuses an entire document when one attribute is unknown, and
       * this payload carries fields that arrive with a release: a database
       * provisioned before the last deploy has never heard of them. Without
       * this, a craft-shop column would take down saving a plate of jollof,
       * because the payload is one payload for both sides. The restaurant is
       * the part already earning and it must not be able to break on the way
       * past somewhere it has no business being.
       *
       * Whatever could not be stored is named rather than swallowed.
       */
      // As it stood before this save. Read from what is already on screen
      // rather than fetched again: the list was loaded from the same records,
      // and a second read here would be a round trip to learn what we have.
      const was = (items ?? []).find((i) => i.$id === editing.$id) as unknown as Record<string, unknown> | undefined;

      const { id: itemId, dropped } = await saveDropping('menu_items', editing.$id ?? null, payload);

      /*
        What changed, and who changed it.

        Only the fields that moved, with the old value beside the new one: a
        log that stores the whole row twice answers "did anything change" and
        leaves the reader to find the one field that did. The questions people
        actually bring are narrow — who put the price up, when did this stop
        being sold — and those are answered by a list of differences.

        Never fatal. A save that went through must not be undone by its own
        bookkeeping, and a missing audit row is worth less than the sale.
      */
      void logProductChange(itemId, editing.$id ? (was ?? null) : null, payload);

      const sizeShelves = await syncLinks(itemId);

      /*
        The shelf changes, sent to be approved.

        After the product itself, deliberately. A change pointing at a product
        that failed to save would sit in an admin's queue naming a piece that
        does not exist, and there is no good answer to that at the desk.

        The product's own figure and each size's are separate changes rather
        than one, because they are approved separately: a basket's small may be
        obviously right and its large obviously a typo, and an admin who can
        only take both or neither will take both.
      */
      const sent: string[] = [];
      if (ownShelfWaits) {
        await submitShelfChange({
          venueId: 'main',
          userId: user?.$id ?? '',
          counted: Number(onHandText.trim()),
          piece: {
            menuItemId: itemId,
            name: payload.name,
            consignorId: editing.consignor_id || undefined,
            consignorName: consignors.find((c) => c.$id === editing.consignor_id)?.name,
            onHand: shelfWas,
            unitPrice: price,
          },
        });
        sent.push(sentWords(payload.name, shelfWas, Number(onHandText.trim())));
      }
      for (const change of sizeShelves) {
        await submitShelfChange({
          venueId: 'main',
          userId: user?.$id ?? '',
          counted: change.now,
          piece: {
            menuItemId: itemId,
            variantId: change.variantId,
            name: payload.name,
            variantLabel: change.label,
            consignorId: editing.consignor_id || undefined,
            consignorName: consignors.find((c) => c.$id === editing.consignor_id)?.name,
            onHand: change.was,
            unitPrice: change.price,
          },
        });
        sent.push(sentWords(`${payload.name} · ${change.label}`, change.was, change.now));
      }

      // Everything else about the product is saved; the supplier is the one
      // thing still to settle, and it needs an answer this form cannot guess.
      const ask = supplierChanged
        ? { itemId, from: before?.consignor_id ?? '', to: editing.consignor_id ?? '' }
        : null;
      setEditing(null);
      await load();
      if (ask) setReassigning(ask);
      if (dropped.length > 0) {
        toast(
          `Saved, but ${dropped.join(', ')} could not be stored. Run Provision, then save this again.`,
          'err',
        );
      }
      /*
        Said instead of "Saved", not after it.

        A shelf change that has NOT taken effect must not be reported with the
        word that means it has. Somebody who reads "Saved" walks away believing
        the count is right, and finds out it is not from a till that will not
        sell a piece it says is there.
      */
      toast(sent.length > 0 ? sent.join(' ') : 'Saved', sent.length > 0 ? 'err' : undefined);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Off the board, keeping everything about it.
   *
   * The status column already showed Active or Hidden; what was missing was
   * any way to change it without opening the item, and any way to stop the
   * archived ones filling the list once there were a few.
   */
  const setArchived = async (item: MenuItem, archived: boolean) => {
    try {
      await db.updateDocument(DB_ID, 'menu_items', item.$id, { active: !archived });
      void logProductChange(
        item.$id,
        { active: item.active },
        { active: !archived },
        archived ? 'product.archived' : 'product.restored',
      );
      setItems((rows) => (rows ?? []).map((r) => (r.$id === item.$id ? { ...r, active: !archived } : r)));
      toast(archived ? `${item.name} archived` : `${item.name} is back on the list`);
    } catch (e) {
      setError(humanError(e));
    }
  };

  /**
   * The change, written down.
   *
   * Split out because three paths reach it — saving, archiving and deleting —
   * and a log that only covers one of them is a log that answers "who removed
   * this" with silence.
   */
  const logProductChange = async (
    itemId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
    action = 'product.updated',
  ) => {
    const changes = diffFields(before, after, PRODUCT_WATCH);
    if (changes.length === 0) return;
    await db.createDocument(DB_ID, 'audit_log', ID.unique(), {
      venue_id: 'main',
      actor_id: user?.$id ?? '',
      actor_role: profile?.role ?? '',
      action,
      entity_type: 'menu_item',
      entity_id: itemId,
      before: fitForLog(changes.map((c) => ({ [c.field]: c.from }))),
      after: fitForLog(changes.map((c) => ({ [c.field]: c.to }))),
      reason: describeChanges(changes, {
        money: (v) => (settings ? formatMoney(v, settings) : String(v)),
        nameFor: (f, v) => (f === 'category_id' ? byCategory[String(v)] : undefined),
      }).slice(0, 500),
    }).catch(() => undefined);
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
      {hasSizes && (
        <ViewTabs
          value={tab}
          onChange={setTab}
          options={[
            { value: 'items', label: W.many.charAt(0).toUpperCase() + W.many.slice(1) },
            { value: 'types', label: 'Variant types' },
          ]}
        />
      )}

      {hasSizes && tab === 'types' ? (
        <KeyedListManager
          collection="variant_types"
          singular="variant type"
          // Each side's own list. A bar measures in singles and doubles and a
          // shop in small, medium and large; one list holding both is a list
          // where neither side can find its own.
          module={module}
          hint={module === 'bar'
            ? 'The ways a drink comes: single and double, glass and carafe, bottle and crate. Each one carries its own price on the drink itself. Rename freely; drinks already using one stay with it.'
            : 'The kinds of variation your products come in. A pottery studio sells by glaze, a weaver by width. Rename freely: products already using one stay with it.'}
          onChanged={() => void loadVariantTypes()
            .then((t) => setVariantTypes(t.filter((x) => (x.module ?? 'craft') === module)))}
        />
      ) : (
      <>
      <div className="spread">
        <h1>{W.title}</h1>
        {/* Reading and changing are different jobs. Somebody who opens this
            page twenty times a day to check a price needs to create a product
            roughly never, and every person who can create one is a person whose
            slip reaches the shop floor at a price customers get charged. */}
        <div className="row" style={{ gap: '0.4rem' }}>
          {/* Only the shop. A restaurant's dishes come with recipes, stations
              and option groups, none of which fit in a row of a spreadsheet,
              so an upload here would be a worse version of the form. */}
          {mayEdit && module === 'craft' && (
            <Button onClick={() => setUploading(true)} disabled={categories.length === 0}>
              Upload a spreadsheet
            </Button>
          )}
          {/* The bar's own, which the kitchen's dishes could not use: a drinks
              file carries its recipe, and a recipe is exactly what a bar
              cannot be asked to type sixty times. Categories are created from
              the file too, because a bar setting itself up has neither yet. */}
          {mayEdit && module === 'bar' && (
            <Button onClick={() => setUploadingDrinks(true)}>Upload a drinks list</Button>
          )}
          {/*
            The drinks set up before a size could have a shelf of its own.

            Opening each one and saving it does the same job — and asking a
            house with thirty drinks to do that is how the same report came
            back twice. Only touches what is unambiguous: a bar drink with
            sizes and no recipe of its own, which pours nothing and therefore
            IS its sizes. See repairSizeStock.
          */}
          {mayEdit && module === 'bar' && (
            <Button
              onClick={() => void repairSizes()}
              loading={repairing}
              title="Give every size its own shelf, for drinks set up before that was possible"
            >
              Count sizes separately
            </Button>
          )}
          {mayEdit && (
            <Button variant="primary" onClick={() => open()} disabled={categories.length === 0}>
              Add {W.one}
            </Button>
          )}
        </div>
      </div>

      {categories.length === 0 && (
        <Notice tone="warn">Create at least one category first, every {W.one} belongs to one.</Notice>
      )}
      {error && !editing && <Notice>{error}</Notice>}

      {items && items.length > 0 && (
        <div className="row row-wrap" style={{ gap: '0.5rem', alignItems: 'center' }}>
          <Input
            placeholder="Search by name…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ flex: '1 1 14rem' }}
          />
          <Select value={onlyCategory} onChange={(e) => setOnlyCategory(e.target.value)}>
            <option value="">Every category</option>
            {categories.map((c) => <option key={c.$id} value={c.$id}>{c.name}</option>)}
          </Select>
          <Select value={sortBy} onChange={(e) => setSortBy(e.target.value as ItemSort)}>
            {ITEM_SORTS.map((s2) => <option key={s2.value} value={s2.value}>{s2.label}</option>)}
          </Select>

          {/* Ticking one that is already on moves it to the end of the order
              rather than removing it; the chip has an × for removing. */}
          <PickerMenu
            label="Group by"
            count={groups.length}
            open={listMenu === 'group'}
            onOpen={(o) => setListMenu(o ? 'group' : null)}
          >
            {GROUPABLE.map((g) => (
              <PickerItem
                key={g.key}
                label={g.label}
                on={groups.some((c) => c.key === g.key)}
                position={groups.findIndex((c) => c.key === g.key) + 1}
                onClick={() => setGroups(toggleGroup(groups, g))}
              />
            ))}
          </PickerMenu>

          <PickerMenu
            label="Sort"
            count={sorts.length}
            open={listMenu === 'sort'}
            onOpen={(o) => setListMenu(o ? 'sort' : null)}
          >
            {SORTABLE.map((s2) => (
              <PickerItem
                key={s2.key}
                label={s2.label}
                on={!!sortDir(sorts, s2.key)}
                dir={sortDir(sorts, s2.key)}
                position={sortPosition(sorts, s2.key)}
                onClick={() => setSorts(cycleSort(sorts, s2.key, s2.label))}
              />
            ))}
          </PickerMenu>
          {archivedCount > 0 && (
            <Button onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
            </Button>
          )}
          {(filter || onlyCategory || sortBy !== 'menu') && (
            <span className="small dim">
              {visible.length} of {items.length}
            </span>
          )}
        </div>
      )}

      {/* What is applied, in order. The menus say what is available; these say
          what is ON, and the sequence is the whole point of stacking them. */}
      <FacetChips
        facets={[
          ...groups.map((g) => ({ kind: 'Group', label: g.label })),
          ...sorts.map((s2) => ({ kind: 'Sort', label: s2.label, detail: s2.dir === 'asc' ? '↑' : '↓' })),
        ]}
        onRemove={(i) => {
          if (i < groups.length) setGroups(groups.filter((_, n) => n !== i));
          else setSorts(sorts.filter((_, n) => n !== i - groups.length));
        }}
        onClear={() => { setGroups([]); setSorts([]); }}
      />

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
                  {/* An owner's columns. A cook does not price the menu, and a
                      costing on a screen used at the pass is a number that
                      gets read out to the wrong person. */}
                  {isAdmin && <th className="num">Costs</th>}
                  {isAdmin && <th className="num">Margin</th>}
                  <th className="num">Prep</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <GroupedRows
                  nodes={tree}
                  rows={ordered}
                  columns={isAdmin ? 9 : 7}
                  closed={closedGroups}
                  onToggle={(path) => setClosedGroups((c) => {
                    const next = new Set(c);
                    if (next.has(path)) next.delete(path); else next.add(path);
                    return next;
                  })}
                  rowKey={(i) => i.$id}
                  /* What a shop actually wants to know about a maker's group:
                     how much of their stock is standing on the shelf. */
                  summary={(rs) => (module === 'craft'
                    ? `${rs.reduce((n, i) => n + (i.on_hand ?? 0), 0)} on the shelf`
                    : null)}
                  renderRow={(i) => (
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
                        /*
                          A drink with no recipe pours nothing.

                          It still sells and still takes money, and the shelf
                          never moves — so it counts perfectly every night
                          while the gin apparently pours itself. That is worth
                          saying on every drink, not only on the ones that
                          claim to track stock, because a bar item's whole
                          point is that it comes off a bottle.

                          A dish is flagged only when it says it tracks stock:
                          a plate of bread does not need a recipe to be right.
                        */
                        if (module === 'bar') return <Badge tone="warn">No recipe, pours nothing</Badge>;
                        return i.track_stock ? <Badge tone="warn">No recipe</Badge> : null;
                      })()}
                      {/*
                        A shelf change nobody has decided about.

                        On the list rather than only inside the form, because
                        the person who needs to see it is the admin walking
                        past — and they have no reason to open a product whose
                        price they are not changing.
                      */}
                      {module === 'craft' && (frozenBy(frozen, i.$id)
                        || variantsFrozenFor(i.$id) > 0) && (
                        <Badge tone="warn">Shelf change waiting for an admin</Badge>
                      )}
                      {/* Told apart on the list. A catalogue with alterations
                          sitting between two baskets, looking exactly like a
                          basket, is one where somebody tries to count them. */}
                      {isService(i) && <Badge>{SERVICE_LABEL}</Badge>}
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
                    {isAdmin && (() => {
                      const m = marginFor(i);
                      return (
                        <>
                          <td className="num dim">
                            {m.unknown ? '—' : (settings ? formatMoney(m.cost, settings) : m.cost)}
                          </td>
                          <td className="num">
                            {m.unknown ? (
                              // Not a thin margin: an unanswered question.
                              // Colouring it would train people past the colour
                              // on the ones that are real.
                              <span className="dim" title="No recipe, so there is nothing to cost">—</span>
                            ) : (
                              <Badge tone={marginIsThin(m, warnBp) ? 'danger' : 'ok'}>
                                {bpAsPercent(m.bp)}
                              </Badge>
                            )}
                          </td>
                        </>
                      );
                    })()}
                    <td className="num dim">{i.prep_minutes}m</td>
                    {/*
                      One word for one state.

                      This column said "Hidden", the filter said "Archived" and
                      the form said "For sale", for the same thing — so the
                      Archive button beside it did not obviously produce any of
                      them, and somebody looking for a way to archive a product
                      could press it and not believe they had. The list agrees
                      with the filter now, and the shop gets the shop's words.
                    */}
                    <td>
                      {i.active
                        ? <Badge tone="ok">{module === 'craft' ? 'For sale' : 'Active'}</Badge>
                        : <Badge>Archived</Badge>}
                    </td>
                    <td className="num">
                      <Button size="sm" variant="ghost" onClick={() => open(i)}>
                        {mayEdit ? 'Edit' : 'View'}
                      </Button>
                      {/* Beside Edit rather than inside it, because "how many
                          of these have we actually sold" is a question asked
                          about a row on this list, not about a form. */}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setHistoryFor({ id: i.$id, name: i.name })}
                        title="Every sale of this, over a period you choose"
                      >
                        History
                      </Button>
                      {mayEdit && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => open(i, true)} title={`Copy this ${W.one}, options and all`}>
                            Duplicate
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void setArchived(i, i.active)}
                            title={i.active
                              ? 'Take it off the board, keeping its recipe, price and history'
                              : 'Put it back on the board'}
                          >
                            {i.active ? 'Archive' : 'Restore'}
                          </Button>
                          {/* Archiving is the day-to-day answer and anybody
                              who may edit can do it. Deleting takes the
                              recipe, the options and the place on every menu
                              with it, so it waits for an admin's say-so. */}
                          {mayDelete && (
                            <Button size="sm" variant="ghost" onClick={() => remove(i)}>Delete</Button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                  )}
                />
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {uploading && settings && (
        <StockUpload
          venueId="main"
          categories={categories}
          consignors={consignors}
          variantTypes={variantTypes}
          settings={settings}
          userId={user?.$id ?? ''}
          onClose={() => setUploading(false)}
          onDone={async (m) => { await load(); toast(m); }}
        />
      )}

      {uploadingDrinks && settings && (
        <DrinkUpload
          categories={categories}
          ingredients={ingredients}
          existing={items ?? []}
          settings={settings}
          module="bar"
          onClose={() => setUploadingDrinks(false)}
          onDone={async (m) => { await load(); toast(m); }}
        />
      )}

      {reassigning && (() => {
        const item = (items ?? []).find((i) => i.$id === reassigning.itemId);
        if (!item) return null;
        return (
          <ReassignSupplier
            item={item}
            fromId={reassigning.from}
            toId={reassigning.to}
            consignors={consignors}
            userId={user?.$id ?? ''}
            onClose={() => setReassigning(null)}
            onDone={async (message) => {
              setReassigning(null);
              await load();
              toast(message);
            }}
          />
        );
      })()}

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
              hint={hasSizes && variants.length > 0 ? 'Ignored, each size below carries its own price.' : undefined}
            >
              <Input value={priceText} inputMode="decimal" onChange={(e) => setPriceText(e.target.value)} />
            </Field>
            {/*
              WHO MAY CHANGE THIS PRICE AT THE TILL.

              Beside the price, because that is what it is about, rather than
              buried in a permissions screen nobody opens while thinking about
              a product.

              Named people, on this product only. The grant on a staff record
              covers the whole board — any price, any item — which is a
              manager's permission and the wrong shape for the thing a shop
              actually asks for: the display pieces get haggled over, so the
              counter that sells them should be able to drop the price of one
              of those and nothing else.

              Admins are not listed. They always may, and a ticked box that
              cannot be unticked teaches people that the boxes do not mean
              anything.
            */}
            <Field
              label="Who may change this price at the till"
              hint={
                repriceStaff.length === 0
                  ? 'Nobody has a staff record to name yet.'
                  : 'On this item only, and only for that one sale. Anybody already allowed to change any price '
                    + 'on the till can do this whether or not they are named here.'
              }
            >
              <div className="stack" style={{ gap: '0.35rem', marginTop: '0.2rem' }}>
                {repriceStaff.length === 0 ? (
                  <span className="small dim">Add staff under Setup → Staff.</span>
                ) : repriceStaff.map((s) => (
                  <div className="row" key={s.$id}>
                    <Toggle
                      checked={(editing.price_editors ?? []).includes(s.$id)}
                      onChange={(v) => setEditing({
                        ...editing,
                        price_editors: v
                          ? [...new Set([...(editing.price_editors ?? []), s.$id])]
                          : (editing.price_editors ?? []).filter((x) => x !== s.$id),
                      })}
                      label={s.display_name || 'Unnamed'}
                    />
                    {s.can_change_line_price && <Badge tone="ok">Any price already</Badge>}
                  </div>
                ))}
              </div>
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

          {hasSizes && (
            <ConsignmentFields
              module={module}
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
              frozen={frozen}
              whoChanged={whoChanged}
            />
          )}

          {/*
            Said rather than silently missing, and undoable.

            Somebody who finds no trace of a size they retired assumes it was
            lost and adds it again — which makes a new size with a new id, no
            recipe, and the same tangle over. Putting the original back keeps
            its id, so the sales already made on it and the shelf it pours from
            stay attached.
          */}
          {retired.length > 0 && (
            <div style={{ margin: '0.6rem 0 0' }}>
              <p className="small dim" style={{ margin: 0 }}>{retiredWords(retired.length)}</p>
              <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.35rem' }}>
                {retired.map((v) => (
                  <Button
                    key={v.$id}
                    size="sm"
                    variant="ghost"
                    loading={restoring === v.$id}
                    title="Put this size back on the menu, with everything it was already linked to"
                    onClick={async () => {
                      setRestoring(v.$id);
                      try {
                        await db.updateDocument(DB_ID, 'product_variants', v.$id, { active: true });
                        setRetired((rows) => rows.filter((r) => r.$id !== v.$id));
                        setVariants((rows) => [
                          ...rows,
                          ...draftVariantsFrom([{ ...v, active: true }], decimals).map((d) => ({
                            ...d,
                            // Whether it already has a shelf of its own decides
                            // the toggle, exactly as it does on load.
                            ownStock: hasOwnRecipe(recipes, editing?.$id ?? '', v.$id),
                          })),
                        ]);
                        toast(`${v.label} put back`);
                      } catch (e) {
                        setError(humanError(e));
                      } finally {
                        setRestoring(null);
                      }
                    }}
                  >
                    Put back &ldquo;{v.label}&rdquo;
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/*
            Recipes and option groups belong to anything that is MADE.

            A woven basket is not, which is why the craft form does without
            them: it is not built from ingredients the shop counts, and "Choose
            your protein" has no meaning on a shelf.

            A cocktail very much is. This read `module === 'kitchen'`, written
            when there were two sides, so the bar fell through to the excluded
            one — and there was no way to say what goes into a Mojito from the
            screen that exists to describe drinks. The recipes were only there
            at all because the importer wrote them, and nothing on the drink
            could show or change them.
          */}
          {module !== 'craft' && (
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
                ? 'None built yet. Create them under Menu → Options, for example “Single or double”.'
                : `Choices the customer makes for this ${W.one}. Build and price them under Menu → Options.`
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

      {historyFor && (
        <SalesHistory
          kind="item"
          id={historyFor.id}
          name={historyFor.name}
          settings={settings}
          onClose={() => setHistoryFor(null)}
        />
      )}
    </>
  );
}
