import { useEffect, useRef, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Textarea, Badge, useToast, ViewTabs} from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import {
  formatMoney, parseMoney, toInput, uploadFile, downloadUrl, deleteFile, receiveStock, Query,
  PAID_TO_KINDS, payeeLabel as sharedPayeeLabel, legacyExpenseCategory as legacyFor,
  isPostableExpenseAccount, expenseMethodsFor, mayComeFromShift, expenseSides,
  defaultExpenseSide, MODULE_LABELS, modulesOf, recomputeClosedShift,
  repostExpense, accountForExpense,
  balancesFor, accountFor, settleBoxSpend, boxesFor, boxOverdrawn,
  buyOptions, convertPurchase, describePurchase, hasPack, categoriesForSide, canSeePrivateExpenses,
} from '@snpos/core';
import type {
  Module, Doc, Ingredient, PaidToKind, BuyOption, ExpenseCategoryDoc, ImprestFloatDoc,
} from '@snpos/core';
import { KeyedListManager, useKeyedList, nameForKey } from '../components/KeyedList';
import { AccountsManager } from '../components/AccountsManager';
import { ExpenseAnalysisTab } from '../components/ExpenseAnalysis';
import { useSession } from '../session';
import { SideFilter, onSide, narrowSide, type Side } from '../components/SideFilter';

interface Expense extends Doc {
  venue_id: string;
  shift_id?: string;
  category: string;
  category_key?: string;
  payee?: string;
  paid_to_kind?: 'supplier' | 'staff' | 'open_market' | 'other';
  module?: Module;
  supplier_id?: string;
  paid_to_staff_id?: string;
  amount: number;
  paid_from_method_id: string;
  /** Whether the drawer is short by this. See fromTakings in core. */
  from_takings?: boolean;
  /** Which petty cash box paid for it, when a box did. */
  imprest_float_id?: string;
  note?: string;
  receipt_file_id?: string;
  created_by: string;
  approval_status: string;
}

interface ExpenseItem extends Doc {
  expense_id: string;
  ingredient_id: string;
  name_snapshot: string;
  qty: number;
  unit_cost: number;
  line_total: number;
  stocked: boolean;
}

interface PaymentMethod extends Doc { name: string; kind: string; enabled: boolean; venue_id: string }
interface VenueRow extends Doc { name: string }
interface Supplier extends Doc { name: string; active: boolean }
interface Staff extends Doc { display_name: string; active: boolean }
interface AccountRow extends Doc { code: string; name: string; type: string; active?: boolean }

/** A line being entered, before it becomes an expense_item. */
/**
 * The price per unit, worked back from what was paid.
 *
 * Shared shape with the kitchen screen's form, and the same arithmetic, so the
 * same market run entered from either device produces the same unit cost. A
 * recipe costs a portion of rice; nobody types that figure because it is a
 * division, and a division done under time pressure is a mistake waiting.
 */
export function unitCostOf(d: { qtyText: string; totalText: string }, decimals: number): number {
  const qty = Number(d.qtyText);
  const total = parseMoney(d.totalText, decimals) ?? 0;
  return qty > 0 ? Math.round(total / qty) : 0;
}

/**
 * Which unit a line is being bought in.
 *
 * Defaults to the pack when the item has one, because setting a pack size up
 * is somebody saying "this is how it arrives". Falls back to the first option,
 * which for everything without a pack is the only option.
 */
export function optionFor(ing: { unit: string; pack_size?: number; pack_name?: string }, key?: 'pack' | 'unit'): BuyOption {
  const opts = buyOptions(ing);
  return opts.find((o) => o.key === key) ?? opts[0];
}

interface DraftItem {
  ingredient_id: string;
  qtyText: string;
  /**
   * Whether the quantity above is packs or counting units.
   *
   * A bar buys a bottle of Havana Club and pours it as shots, so "1" means one
   * bottle here and twenty-eight on the shelf. Absent means the pack, when the
   * item has one — buying by the pack is the reason somebody set one up. Items
   * with no pack only ever have the one answer. See packs.ts.
   */
  buyKey?: 'pack' | 'unit';
  /**
   * What was PAID for this line, not the price per unit.
   *
   * The same question the kitchen screen asks, and for the same reason: a
   * market receipt says "five kilos of rice, a hundred and twenty", and asking
   * for the price per kilo asks somebody to do a division in their head and
   * type the answer — which is how a hundred and twenty cedis of rice gets
   * recorded as six hundred. The unit price is shown as it is worked out, so
   * the figure stock keeps is visible without anybody calculating it.
   */
  totalText: string;
}

/** Receipts may be photographed or scanned, so accept images and PDFs. */
const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

export function ExpensesPage() {
  const { settings, user, profile } = useSession();
  const toast = useToast();
  const decimals = settings?.currency_decimals ?? 2;
  const fileInput = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<'expenses' | 'analysis' | 'categories' | 'accounts'>('expenses');
  const [rows, setRows] = useState<Expense[] | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [side, setSide] = useState<Side>('all');
  const mods = modulesOf(settings);
  /**
   * The sides an expense may be filed under: every trade the business runs.
   *
   * From one list rather than written out at the dropdown, which is how the
   * bar came to be missing from it entirely.
   */
  const sides = expenseSides(mods, ['kitchen', 'craft', 'bar'] as Module[]);
  const [venues, setVenues] = useState<VenueRow[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const { rows: categories, reload: reloadCategories } = useKeyedList('expense_categories');
  /**
   * The categories this person may file against, for the side being recorded.
   *
   * Admin only ones are here for admins and for anybody an admin has granted
   * them under Staff; a manager who does not do the books never sees the rent.
   */
  const myCategories = (mod?: Module) =>
    categoriesForSide(categories ?? [], mod ?? 'kitchen', {
      canSeePrivate: canSeePrivateExpenses(profile),
    });

  const [editing, setEditing] = useState<Partial<Expense> | null>(null);
  /**
   * The petty cash boxes, and what is in each.
   *
   * "Petty cash" on this form used to be a label and nothing more: it kept the
   * spend off the shift's drawer, correctly, and then stopped. No box was
   * named, so no box was ever lighter for it — the tin's own record and the
   * money actually in it drifted apart by every expense recorded here, and the
   * reconciliation that exists to catch a shortage was quietly counting those
   * as shortages too.
   */
  const [boxes, setBoxes] = useState<ImprestFloatDoc[]>([]);
  const [boxBalances, setBoxBalances] = useState<Record<string, number>>({});
  const [amountText, setAmountText] = useState('');
  const [draftItems, setDraftItems] = useState<DraftItem[]>([]);
  const [savedItems, setSavedItems] = useState<ExpenseItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [e, m, v, s, p, i, a, tins] = await Promise.all([
      listAll<Expense>('shift_expenses'),
      listAll<PaymentMethod>('payment_methods'),
      listAll<VenueRow>('venues'),
      listAll<Supplier>('suppliers'),
      listAll<Staff>('staff_profiles'),
      listAll<Ingredient>('ingredients'),
      listAll<AccountRow>('accounts'),
      // Loaded with everything else rather than when the dropdown is touched:
      // what a box holds decides whether this spend can come out of it, and
      // finding that out after the form is filled in is finding it out late.
      // Every venue's, filtered to the one being recorded when it is offered —
      // this page lists spending across all of them at once.
      listAll<ImprestFloatDoc>('imprest_floats').catch(() => [] as ImprestFloatDoc[]),
    ]);
    setRows(e.sort((a2, b) => b.$createdAt.localeCompare(a2.$createdAt)));
    /*
      Every method, because this is the office.

      This used to obey the till's cash-only rule, on the reasoning that a rule
      holding on one of two screens is not a rule. That was the wrong reading:
      the two screens are not recording the same event. At the till, money is
      leaving a drawer that gets counted the same night, and the count is what
      makes a wrong entry visible — which is exactly why cash only belongs
      there. Here the spend already happened and may never have touched a
      drawer, so the restriction only forced a bank transfer to be filed as
      cash against a drawer that never held it. See expenseMethodsFor.
    */
    setMethods(expenseMethodsFor(m.filter((x) => x.enabled), settings ?? undefined, 'office'));
    setVenues(v);
    setSuppliers(s.filter((x) => x.active !== false).sort((a2, b) => a2.name.localeCompare(b.name)));
    setStaff(p.filter((x) => x.active !== false).sort((a2, b) => a2.display_name.localeCompare(b.display_name)));
    setIngredients(i.filter((x) => x.active).sort((a2, b) => a2.name.localeCompare(b.name)));
    // Expense lines only, minus the two the system fills in by itself. See
    // isPostableExpenseAccount, offering "Food sales" as a destination for a
    // gas refill is offering a way to make the books wrong.
    // Archived ones drop out too: an account the house has retired should not
    // be offered as somewhere to file next week's gas. Categories already
    // pointing at one keep pointing at it, which KeyedListManager handles by
    // keeping the chosen account on its list whether or not it is on offer.
    setAccounts(
      a.filter((a2) => isPostableExpenseAccount(a2) && a2.active !== false)
        .sort((a2, b) => a2.code.localeCompare(b.code)),
    );
    /*
      The boxes this person may spend out of.

      Whoever holds a box, plus anybody who may fund them — an admin doing the
      books after the fact is not locked out of a tin they are answerable for.
      See boxesFor: a custodian sees their own box and no others, because a
      list of every tin in the building is somebody else's business.
    */
    const live = boxesFor(profile, tins.filter((f) => f.active !== false));
    setBoxes(live);
    setBoxBalances(await balancesFor(live).catch(() => ({})));
  };
  useEffect(() => { load().catch((err) => setError(humanError(err))); }, []);


  const open = async (row?: Expense) => {
    setEditing(
      row ?? {
        venue_id: venues[0]?.$id ?? 'main',
        // The first one still in use, not simply the first one. A new expense
        // defaulting to a category the house archived is a wrong answer that
        // looks like a chosen one.
        category_key: categories?.find((c) => c.active !== false)?.key ?? 'other',
        paid_to_kind: 'supplier',
        payee: '',
        note: '',
        paid_from_method_id: methods[0]?.$id ?? '',
        approval_status: 'pending',
        /*
          The side the list is already filtered to.

          Somebody who has narrowed the page to the bar and pressed Record
          expense has said which side they mean. Asking again is asking a
          question they have answered, and the answer that gets left in place
          is whichever one happened to be first — which is how a bar expense
          ends up in the kitchen's books by nobody's decision.
        */
        module: defaultExpenseSide(narrowSide(side, profile, settings), sides),
        /*
          And not off a shift's drawer, because none is involved.

          An expense typed up here on Thursday for a Tuesday market run comes
          out of no drawer being counted tonight. Defaulting to the shift made
          some cashier short by money they never handled.
        */
        from_takings: false,
      },
    );
    // Blank for a new expense, not "0.00". A pre-filled zero has to be cleared
    // before anything can be typed, and on a phone that means a long-press and
    // a select-all, so what actually gets recorded is 250.00 turned into
    // 0.00250 by somebody in a hurry.
    setAmountText(row ? toInput(row.amount, decimals) : '');
    setDraftItems([]);
    setError(null);

    // Lines already recorded against this expense are shown but not re-entered:
    // stock was raised for them once and must not be raised again.
    setSavedItems(
      row
        ? await listAll<ExpenseItem>('expense_items', [Query.equal('expense_id', row.$id)]).catch(() => [])
        : [],
    );
  };

  const attach = async (file: File) => {
    if (!RECEIPT_TYPES.includes(file.type)) {
      setError('Attach a photo (JPG, PNG or WebP) or a PDF.');
      return;
    }
    if (file.size > MAX_RECEIPT_BYTES) {
      setError(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 10 MB.`);
      return;
    }
    setUploading(true);
    setError(null);
    try {
      // Receipts are uploaded manager-readable, never public, see uploadFile.
      const { fileId } = await uploadFile(file, 'receipt', settings);
      setEditing((x) => (x ? { ...x, receipt_file_id: fileId } : x));
    } catch (e) {
      setError(humanError(e));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  /**
   * The category the stock lines imply.
   *
   * Ingredients each name what buying them counts as, so listing what was
   * bought is usually enough to say what the money was. Only claimed when
   * every line agrees, a trip that bought rice and a new gas bottle is two
   * categories, and guessing one of them would be worse than asking.
   */
  /**
   * The boxes on offer for the expense being recorded, and the one chosen.
   *
   * Narrowed by venue and by side: a shop tin is not where the kitchen's gas
   * came from, and offering it is how a spend ends up against the wrong tin
   * and two boxes fail their next count. A box with no side on it serves
   * everybody, which is how a single office tin works in practice.
   */
  const boxesOnOffer = editing
    ? boxes.filter((b) => b.venue_id === (editing.venue_id ?? 'main')
      && (!b.module || b.module === (editing.module ?? 'kitchen')))
    : [];
  const fromBox = !!editing && editing.from_takings === false;
  const chosenBox = fromBox
    ? boxesOnOffer.find((b) => b.$id === editing?.imprest_float_id) ?? null
    : null;

  const impliedCategory = (() => {
    const keys = draftItems
      .filter((d) => d.ingredient_id)
      .map((d) => ingredients.find((i) => i.$id === d.ingredient_id)?.expense_category_key)
      .filter(Boolean) as string[];
    if (keys.length === 0) return null;
    return keys.every((k) => k === keys[0]) ? keys[0] : null;
  })();

  // Follow the stock lines as they are typed. Only ever moves the category to
  // what the ingredients say; never blanks a choice somebody made by hand.
  useEffect(() => {
    if (impliedCategory && editing && editing.category_key !== impliedCategory) {
      setEditing((e) => (e ? { ...e, category_key: impliedCategory } : e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [impliedCategory]);

  /** What the itemised lines add up to, for comparing against the total paid. */
  /** Lines with an item and a quantity: the ones that count towards the total. */
  const lineCount = draftItems.filter((d) => d.ingredient_id && Number(d.qtyText) > 0).length;

  const draftTotal = draftItems.reduce((sum, d) => {
    const qty = Number(d.qtyText || 0);
    const cost = unitCostOf(d, decimals);
    return sum + Math.round(qty * cost);
  }, 0);

  const save = async () => {
    // Listed items decide the total; the box is only for spending with nothing
    // to itemise, a taxi or a gas refill.
    const amount = lineCount > 0 ? draftTotal : parseMoney(amountText, decimals);
    if (amount === null || amount <= 0) {
      setError(lineCount > 0
        ? 'The items come to nothing. Enter what was paid for each.'
        : 'Enter the amount spent, for example 45.00');
      return;
    }
    if (!editing?.paid_from_method_id) { setError('Choose how it was paid.'); return; }
    if (!editing.category_key) { setError('Choose a category.'); return; }

    const filled = draftItems.filter((d) => d.ingredient_id && Number(d.qtyText) > 0);
    for (const d of filled) {
      if (parseMoney(d.totalText, decimals) === null) {
        setError('One of the stock lines does not say what was paid for it.');
        return;
      }
    }

    setBusy(true);
    setError(null);
    try {
      const kind = editing.paid_to_kind ?? 'other';
      const payload = {
        venue_id: editing.venue_id ?? 'main',
        shift_id: editing.shift_id ?? '',
        // The old fixed column, kept valid; category_key is the real answer.
        category: legacyFor(editing.category_key),
        category_key: editing.category_key,
        paid_to_kind: kind,
        supplier_id: kind === 'supplier' ? editing.supplier_id ?? '' : '',
        paid_to_staff_id: kind === 'staff' ? editing.paid_to_staff_id ?? '' : '',
        payee: payeeLabel(kind, editing),
        amount,
        paid_from_method_id: editing.paid_from_method_id,
        // Absent means yes, for every row written before the question existed.
        from_takings: editing.from_takings !== false,
        // Which tin paid, when one did. Blank on a shift spend, and blanked
        // deliberately when one is moved back onto the shift.
        imprest_float_id: editing.from_takings === false ? editing.imprest_float_id ?? '' : '',
        // Which side's books this comes out of. Defaults to the kitchen for a
        // business that runs one side, where the question has one answer.
        module: editing.module ?? 'kitchen',
        note: editing.note ?? '',
        receipt_file_id: editing.receipt_file_id ?? '',
        created_by: user?.$id ?? '',
        approval_status: editing.approval_status ?? 'pending',
      };
      const expenseId = editing.$id
        ? (await db.updateDocument(DB_ID, 'shift_expenses', editing.$id, payload)).$id
        : (await db.createDocument(DB_ID, 'shift_expenses', ID.unique(), payload)).$id;

      /**
       * A shift that has already closed is worked out again.
       *
       * Its expected figures and its over-or-short were written at the moment
       * it closed and do not recompute themselves. Without this, saying "that
       * taxi was my own money" a week later corrects the expense and leaves
       * the shift still reporting a shortage nobody caused, which is the whole
       * reason somebody went looking for the setting.
       *
       * What was counted is never touched. A person counted that, it is the
       * one figure here that was never derived, and nothing found out
       * afterwards changes what was in the till that night.
       */
      // On the books, keyed by the expense's own id so it cannot be posted
      // twice however many routes reach it. An expense recorded here, outside
      // any shift, used to reach the ledger through no route at all.
      const paidFromBox = payload.imprest_float_id
        ? boxes.find((b) => b.$id === payload.imprest_float_id) ?? null
        : null;
      void accountForExpense(payload)
        .then(async (accountCode) => {
          // Corrections included, unlike postExpense, which is once-only by
          // design. See repostExpense: an amount fixed a week later used to
          // leave the books on the old figure with nothing to show for it.
          const entryId = await repostExpense(payload.venue_id, {
            expenseId,
            amount,
            accountCode,
            postedBy: user?.$id ?? '',
            shiftId: payload.shift_id || undefined,
            // Credited to the tin, not to the till. Crediting cash for money
            // that never left a drawer is how a box quietly empties while the
            // balance sheet says the business still holds it.
            fromAccount: paidFromBox ? accountFor(paidFromBox) : undefined,
            memo: paidFromBox ? `Paid from ${paidFromBox.name}` : undefined,
          });

          /*
            And the box's own record, brought into line with whatever this
            expense now says.

            Corrections included: an amount changed, a different tin named, or
            a spend moved back onto the shift all have to reach the box, and
            none of them does on its own. See settleBoxSpend — it writes only
            the difference, so saving an unchanged expense moves nothing.
          */
          await settleBoxSpend({
            venueId: payload.venue_id,
            expenseId,
            boxId: payload.imprest_float_id || null,
            amount,
            userId: user?.$id ?? '',
            note: payload.payee || payload.note,
            entryId: entryId ?? undefined,
          });
        })
        .catch(() => undefined);

      let recomputed = false;
      if (payload.shift_id) {
        recomputed = (await recomputeClosedShift(payload.shift_id).catch(() => null)) !== null;
      }

      // Each line is written, then delivered into stock. Recording it and
      // raising the stock are one action from the user's point of view, so a
      // line that fails to stock says so rather than being quietly dropped.
      let stockFailures = 0;
      for (const d of filled) {
        const ing = ingredients.find((i) => i.$id === d.ingredient_id);
        if (!ing) continue;
        /*
          What was typed is in what they bought — bottles, crates — and what
          stock keeps is in what it counts. Both the quantity and the price
          convert, and the price is the half that matters: a GHS 300 bottle
          recorded as GHS 300 a shot values the shelf at twenty-eight times
          what is on it, and every dish costing downstream inherits it.

          An item with no pack converts by one, which is every kitchen
          ingredient there has ever been.
        */
        const option = optionFor(ing, d.buyKey);
        // Worked out from what was paid rather than typed. See unitCostOf.
        const perBought = unitCostOf(d, decimals);
        const line = convertPurchase({
          qty: Number(d.qtyText),
          costPerBought: perBought,
          per: option.per,
        });
        const qty = line.qty;
        const unitCost = perBought > 0 ? line.unitCost : ing.base_unit_cost;
        try {
          await db.createDocument(DB_ID, 'expense_items', ID.unique(), {
            expense_id: expenseId,
            ingredient_id: ing.$id,
            name_snapshot: ing.name,
            qty,
            unit_cost: unitCost,
            // What was handed over, not the rounded per-shot cost multiplied
            // back up: those differ by a pesewa a shot, and the receipt is the
            // truth.
            line_total: line.lineTotal || Math.round(qty * unitCost),
            // An overhead is used up in the buying. See the note in the till
            // form: raising a quantity nobody counts creates a balance that
            // only ever goes up, and puts four hundred cedis of taxi rides on
            // the books as something the restaurant owns.
            stocked: ing.counted_at_close !== false,
          });
          if (ing.counted_at_close === false) continue;
          await receiveStock({
            venueId: payload.venue_id,
            ingredient: ing,
            qty,
            unitCost,
            refType: 'expense',
            refId: expenseId,
            shiftId: payload.shift_id,
            createdBy: user?.$id ?? '',
            note: payload.payee ? `Bought from ${payload.payee}` : 'Expense',
          });
        } catch {
          stockFailures += 1;
        }
      }

      setEditing(null);
      await load();
      toast(
        stockFailures > 0
          ? `Expense saved, but ${stockFailures} stock line${stockFailures > 1 ? 's' : ''} did not go through`
          : filled.length
            ? `Expense recorded and ${filled.length} item${filled.length > 1 ? 's' : ''} added to stock`
            : recomputed
              ? 'Expense saved, and that shift has been worked out again'
              : 'Expense recorded',
        stockFailures > 0 ? 'err' : 'ok',
      );
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: Expense) => {
    if (!confirm(`Delete this ${settings ? formatMoney(row.amount, settings) : ''} expense? Stock already added from it stays where it is, remove that separately if it was wrong.`)) return;
    try {
      if (row.receipt_file_id) await deleteFile(row.receipt_file_id, 'receipt', settings).catch(() => undefined);
      const items = await listAll<ExpenseItem>('expense_items', [Query.equal('expense_id', row.$id)]).catch(() => []);
      await Promise.all(items.map((i) => db.deleteDocument(DB_ID, 'expense_items', i.$id).catch(() => undefined)));
      await db.deleteDocument(DB_ID, 'shift_expenses', row.$id);
      await load();
      toast('Deleted');
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  const methodName = (id: string) => methods.find((m) => m.$id === id)?.name ?? '-';

  /** A readable "paid to", worked out the same way the kitchen works it out. */
  function payeeLabel(kind: PaidToKind, e: Partial<Expense>): string {
    return sharedPayeeLabel(kind, {
      supplierName: suppliers.find((s) => s.$id === e.supplier_id)?.name,
      staffName: staff.find((s) => s.$id === e.paid_to_staff_id)?.display_name,
      payee: e.payee,
    });
  }

  return (
    <>
      <div className="spread">
        <h1>Expenses</h1>
        {tab === 'expenses' && <SideFilter value={side} onChange={setSide} settings={settings} profile={profile} />}
        {tab === 'expenses' && (
          <Button variant="primary" onClick={() => void open()} disabled={methods.length === 0}>
            Record expense
          </Button>
        )}
      </div>

      <ViewTabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'expenses', label: 'Expenses' },
          { value: 'analysis', label: 'Analysis' },
          { value: 'categories', label: 'Categories' },
          { value: 'accounts', label: 'Accounts' },
        ]}
      />

      {tab === 'analysis' ? (
        /* The list says what was spent. This says what that means — on what, by
           which trade, whether it is going up, and how much has nothing behind
           it. Its own component because it reads its own two windows and would
           otherwise double the size of this file. */
        <ExpenseAnalysisTab categories={(categories ?? []) as unknown as ExpenseCategoryDoc[]} />
      ) : tab === 'accounts' ? (
        <AccountsManager />
      ) : tab === 'categories' ? (
        <KeyedListManager
          collection="expense_categories"
          singular="category"
          sharedValue="general"
          accounts={accounts.map((a) => ({ code: a.code, name: a.name }))}
          onChanged={reloadCategories}
          hint="Your own list. Each one posts to a line of the accounts, which is what decides where the money shows up in Reports. Nothing there that fits? Add it under the Accounts tab. Rename freely; expenses already filed under a category stay with it."
        />
      ) : (
        <>
          <p className="dim small" style={{ marginTop: 0 }}>
            Money paid out, supplies, transport, repairs. Attach the receipt as a photo or PDF; receipts are visible
            to managers and admins only, never to customers or other staff.
          </p>

          {error && !editing && <Notice>{error}</Notice>}

          <Card pad={false}>
            {!rows ? (
              <div className="card-pad"><Spinner /></div>
            ) : rows.length === 0 ? (
              <Empty title="No expenses recorded">Record what you spend and it lands in the accounts and the shift close.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Category</th>
                      <th>Paid to</th>
                      <th>Method</th>
                      <th className="num">Amount</th>
                      <th>Receipt</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.filter((r) => onSide(r, narrowSide(side, profile, settings))).map((r) => (
                      <tr key={r.$id}>
                        <td className="dim small">{new Date(r.$createdAt).toLocaleDateString()}</td>
                        <td>{nameForKey(categories, r.category_key || r.category)}</td>
                        <td className="dim">
                          {r.payee || '-'}
                          {r.paid_to_kind === 'open_market' && <div className="small dim">Open market</div>}
                          {r.paid_to_kind === 'staff' && <div className="small dim">Staff</div>}
                        </td>
                        {/* Which drawer, and whose money. "Cash" alone does not
                            say whether a shift is short by this or a tin is. */}
                        <td className="dim small">
                          {methodName(r.paid_from_method_id)}
                          {r.from_takings === false && (
                            <div className="small dim">
                              {boxes.find((b) => b.$id === r.imprest_float_id)?.name ?? 'Petty cash'}
                            </div>
                          )}
                        </td>
                        <td className="num">{settings ? formatMoney(r.amount, settings) : r.amount}</td>
                        <td>
                          {r.receipt_file_id ? (
                            <a href={downloadUrl(r.receipt_file_id, 'receipt', settings)} target="_blank" rel="noreferrer">
                              View
                            </a>
                          ) : (
                            <Badge tone="warn">None</Badge>
                          )}
                        </td>
                        <td className="num">
                          <Button size="sm" variant="ghost" onClick={() => void open(r)}>Edit</Button>
                          <Button size="sm" variant="ghost" onClick={() => remove(r)}>Delete</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      {editing && (
        <Modal
          title={editing.$id ? 'Edit expense' : 'Record expense'}
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
            {/* Hidden once the stock lines answer it. Each ingredient already
                carries its category, set when it was added, so asking again
                invites a second and different answer for the same purchase.
                Still asked when there is nothing listed, a taxi or a repair
                has no ingredient to take the answer from. */}
            <Field
              label="Category"
              hidden={!!impliedCategory}
              hint={
                categories && categories.length === 0
                  ? 'None set up, add some under the Categories tab.'
                  : undefined
              }
            >
              <Select
                value={editing.category_key ?? ''}
                onChange={(e) => setEditing({ ...editing, category_key: e.target.value })}
              >
                {/* This side's spending, plus what belongs to everybody. An
                    expense being recorded against the bar has no business
                    offering "Kitchen gas". Anything marked admin only is here
                    for admins and for whoever an admin has granted it. */}
                {myCategories(editing.module).map((c) => (
                  <option key={c.key} value={c.key}>{c.name}</option>
                ))}
                {/* A category already chosen keeps showing even if it belongs
                    to another side, so changing the side on an expense does not
                    silently refile it. */}
                {editing.category_key
                  && !myCategories(editing.module).some((c) => c.key === editing.category_key) && (
                  <option value={editing.category_key}>
                    {nameForKey(categories, editing.category_key)} (another side)
                  </option>
                )}
              </Select>
            </Field>
            <Field label="Paid to" hint="Not every purchase has a supplier behind it.">
              <Select
                value={editing.paid_to_kind ?? 'supplier'}
                onChange={(e) => setEditing({ ...editing, paid_to_kind: e.target.value as Expense['paid_to_kind'] })}
              >
                {PAID_TO_KINDS.map((k) => <option key={k.v} value={k.v}>{k.l}</option>)}
              </Select>
            </Field>
            {/*
              EVERY SIDE THE BUSINESS RUNS, from the one list that names them.

              This offered two options, hard-coded, from when there were two
              sides — so a bar expense could not be filed as the bar's at all.
              It went into the books as the kitchen's, and stayed there.

              Shown only where there is a choice: a business running one trade
              has one answer, and a dropdown that cannot change anything is a
              control people learn to scroll past.
            */}
            {sides.length > 1 && (
              <Field label="Which side" hint="Whose books this comes out of.">
                <Select
                  value={editing.module ?? sides[0]}
                  onChange={(e) => {
                    const to = e.target.value as Module;
                    /*
                      The category follows the side.

                      Categories already say which side they are shown on, and
                      the list honours it — but the chosen one was left behind
                      when the side changed, so an expense filed to the bar
                      could sit under a bistro-only heading. The list below it
                      then showed a category the dropdown said was another
                      side's, which is a form arguing with itself.

                      Only moved when it has to be. Anything marked
                      "Everywhere" is valid on every side and stays exactly
                      where somebody put it.
                    */
                    const stillFits = myCategories(to).some((c) => c.key === editing.category_key);
                    setEditing({
                      ...editing,
                      module: to,
                      category_key: stillFits
                        ? editing.category_key
                        : myCategories(to).find((c) => c.active !== false)?.key ?? editing.category_key,
                    });
                  }}
                >
                  {sides.map((m) => <option key={m} value={m}>{MODULE_LABELS[m]}</option>)}
                </Select>
              </Field>
            )}
            {/*
              Every method, because this is the office and not the till.

              The cash-only rule belongs to the till, where money physically
              leaves a drawer somebody counts the same night — that count is
              the safeguard, and it is a good rule there. None of it is true
              here: the spend already happened, it may never have touched a
              drawer, and an owner paying a supplier by transfer was being made
              to file it as cash against a drawer that never held it.

              A bank account is a payment method with "counted at close" turned
              off, set up once under Setup. See expenseMethodsFor.
            */}
            <Field
              label="Paid from"
              hint={methods.length <= 1
                ? 'Add more ways of paying — a bank account, mobile money — under Setup, payment methods.'
                : undefined}
            >
              <Select
                value={editing.paid_from_method_id ?? ''}
                onChange={(e) => setEditing({ ...editing, paid_from_method_id: e.target.value })}
                disabled={methods.length <= 1}
              >
                {methods.map((m) => <option key={m.$id} value={m.$id}>{m.name}</option>)}
              </Select>
            </Field>
            {/*
              The setting somebody comes here to change.

              A cook records this at the till and can get it wrong in either
              direction: money from their own pocket filed as the drawer's, or
              the drawer's money filed as their own. Both leave a shift
              reporting an over-or-short that nobody caused.

              Changing it here reaches back. If the shift has already closed,
              its expected figures and its over-or-short are worked out again
              from the rows as they now stand — see recomputeClosedShift. What
              was physically counted that night is never touched.
            */}
            <Field
              label="Where the money came from"
              hint={editing.from_takings !== false
                ? 'Taken off what that shift\'s drawer should have held.'
                : 'Recorded as spent, but not taken off that shift\'s drawer.'}
            >
              <Select
                value={editing.from_takings !== false ? 'shift' : 'petty'}
                onChange={(e) => {
                  const shift = e.target.value === 'shift';
                  setEditing({
                    ...editing,
                    from_takings: shift,
                    // Back on the shift, so no box paid for it. Leaving the id
                    // behind would keep charging a tin for a spend the drawer
                    // is now short by, and both would be wrong at once.
                    imprest_float_id: shift ? '' : (editing.imprest_float_id || boxesOnOffer[0]?.$id || ''),
                  });
                }}
              >
                {/*
                  A DRAWER IS ONLY OFFERED WHERE A DRAWER IS ACTUALLY INVOLVED.

                  At the till it always is. Here it is not: an expense typed up
                  on Thursday for a Tuesday market run comes out of no drawer
                  being counted tonight, and filing it against one makes that
                  shift short by money its cashier never handled — a shortage
                  the system invented, with somebody's name against it.

                  Kept when EDITING a row that already says the shift paid,
                  because that is the reason this field is on this screen at
                  all: a cook can get it wrong in either direction, and an
                  admin has to be able to put it right. Taking the option away
                  from a correction would make the mistake permanent.
                */}
                {mayComeFromShift('office', editing.from_takings !== false) && (
                  <option value="shift">The shift</option>
                )}
                <option value="petty">Petty cash</option>
              </Select>
            </Field>
            {/*
              Which tin, and not just "petty cash".

              Saying the money did not come off the shift is only half the
              answer. Until this was asked, no box was ever named, so no box
              was ever lighter for it: the tin's record and the money in it
              drifted apart by every expense recorded on this screen, and the
              count that exists to catch a shortage counted those as one.
            */}
            {fromBox && boxesOnOffer.length > 0 && (
              <Field
                label={boxesOnOffer.length > 1 ? 'Which petty cash box' : 'The petty cash box'}
                hint={chosenBox && settings
                  ? `${formatMoney(boxBalances[chosenBox.$id] ?? 0, settings)} in it, `
                    + `of ${formatMoney(chosenBox.fixed_amount, settings)}.`
                  : 'Pick the tin the money actually came out of.'}
              >
                <Select
                  value={editing.imprest_float_id ?? ''}
                  onChange={(e) => setEditing({ ...editing, imprest_float_id: e.target.value })}
                >
                  <option value="">Choose</option>
                  {boxesOnOffer.map((b) => (
                    <option key={b.$id} value={b.$id}>
                      {b.name} · {settings ? formatMoney(boxBalances[b.$id] ?? 0, settings) : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>

          {/* No tin to name, so the spend is recorded as it always was: off the
              books' cash, not off any box. Said rather than left as a missing
              dropdown somebody assumes they have already answered. */}
          {fromBox && boxesOnOffer.length === 0 && (
            <Notice>
              There is no petty cash box set up for this side. The spend will be recorded as not coming off the
              shift, and no box will be lighter for it. Set one up under <strong>Petty cash</strong>.
            </Notice>
          )}

          {/* More than is in it. Not refused — the money has already been
              spent and refusing to record it only hides that — but said. */}
          {chosenBox && settings && boxOverdrawn(
            lineCount > 0 ? draftTotal : (parseMoney(amountText, decimals) ?? 0),
            boxBalances[chosenBox.$id] ?? 0,
          ) && (
            <Notice tone="warn">
              That is more than {chosenBox.name} holds ({formatMoney(boxBalances[chosenBox.$id] ?? 0, settings)}).
              Recording it will leave the box overdrawn, which its next count will show as money owed to it.
            </Notice>
          )}

          {editing.paid_to_kind === 'supplier' && (
            <Field label="Which supplier" hint="Add and edit suppliers under Stock → Suppliers.">
              <Select
                value={editing.supplier_id ?? ''}
                onChange={(e) => setEditing({ ...editing, supplier_id: e.target.value })}
              >
                <option value="">Choose</option>
                {suppliers.map((s) => <option key={s.$id} value={s.$id}>{s.name}</option>)}
              </Select>
            </Field>
          )}

          {editing.paid_to_kind === 'staff' && (
            <Field label="Which member of staff" hint="For money handed to someone to go and buy, or a staff advance.">
              <Select
                value={editing.paid_to_staff_id ?? ''}
                onChange={(e) => setEditing({ ...editing, paid_to_staff_id: e.target.value })}
              >
                <option value="">Choose</option>
                {staff.map((s) => <option key={s.$id} value={s.$id}>{s.display_name}</option>)}
              </Select>
            </Field>
          )}

          {/* Only where a name is the thing that is missing. A supplier and a
              member of staff have both been picked from a list already, and the
              open market has no name to give. */}
          {(editing.paid_to_kind === 'other' || editing.paid_to_kind === 'staff') && (
            <Field
              label="Name"
              hint={editing.paid_to_kind === 'staff'
                ? 'Optional. Only if the person is not in the list above.'
                : 'Whoever received the money.'}
            >
              <Input value={editing.payee ?? ''} onChange={(e) => setEditing({ ...editing, payee: e.target.value })} />
            </Field>
          )}

          {venues.length > 1 && (
            <Field label="Venue">
              <Select value={editing.venue_id ?? ''} onChange={(e) => setEditing({ ...editing, venue_id: e.target.value })}>
                {venues.map((v) => <option key={v.$id} value={v.$id}>{v.name}</option>)}
              </Select>
            </Field>
          )}

          <StockLines
            ingredients={ingredients}
            saved={savedItems}
            draft={draftItems}
            setDraft={setDraftItems}
            decimals={decimals}
            symbol={settings?.currency_symbol ?? ''}
            draftTotal={draftTotal}
            paidTotal={parseMoney(amountText, decimals) ?? 0}
            money={(n) => (settings ? formatMoney(n, settings) : String(n))}
          />

          {/*
              WHAT IT CAME TO, ASKED AFTER WHAT WAS BOUGHT.

              It used to sit at the top, so a form filled in the order it reads
              asked for a total before anything it could be a total of — and
              then quietly turned into a sum once the items went in underneath.
              Somebody who typed a figure first watched their own number be
              replaced, which reads as the form losing it.

              So it comes last, where the answer is already known. Typed only
              when there is nothing to add up: a taxi fare and a month's rent
              have no lines behind them and still have to be recordable. Once
              lines exist the total is their sum, because offering a box beside
              them invites two answers to one question, differing by a typo
              nobody notices until a month-end.
            */}
            {lineCount > 0 ? (
              <Field label={`Amount (${settings?.currency_symbol ?? ''})`} hint="Added up from the items above.">
                <Input value={toInput(draftTotal, decimals)} disabled />
              </Field>
            ) : (
              <Field
                label={`Amount (${settings?.currency_symbol ?? ''})`}
                hint="Nothing listed above, so say what it came to."
              >
                <Input value={amountText} inputMode="decimal" onChange={(e) => setAmountText(e.target.value)} />
              </Field>
            )}


          <Field label="Note">
            <Textarea value={editing.note ?? ''} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
          </Field>

          <Field label="Receipt" hint="A photo or PDF. Visible to managers and admins only.">
            <div className="row">
              <Button size="sm" type="button" loading={uploading} onClick={() => fileInput.current?.click()}>
                {editing.receipt_file_id ? 'Replace receipt' : 'Attach receipt'}
              </Button>
              {editing.receipt_file_id && (
                <>
                  <a
                    className="small"
                    href={downloadUrl(editing.receipt_file_id, 'receipt', settings)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View attached
                  </a>
                  <Button
                    size="sm"
                    variant="ghost"
                    type="button"
                    onClick={async () => {
                      const id = editing.receipt_file_id as string;
                      setEditing({ ...editing, receipt_file_id: '' });
                      await deleteFile(id, 'receipt', settings).catch(() => undefined);
                    }}
                  >
                    Remove
                  </Button>
                </>
              )}
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              style={{ display: 'none' }}
              onChange={(e) => e.target.files?.[0] && attach(e.target.files[0])}
            />
          </Field>
        </Modal>
      )}
    </>
  );
}

/**
 * What was bought, if it was stock.
 *
 * Optional on purpose: a taxi fare has no ingredients. But when the money did
 * buy rice and tomatoes, listing them here means the shopping trip and the
 * stock delivery are one piece of work instead of two, and nobody has to
 * remember to go and type the same numbers into Stock afterwards.
 */
function StockLines({
  ingredients,
  saved,
  draft,
  setDraft,
  decimals,
  symbol,
  draftTotal,
  paidTotal,
  money,
}: {
  ingredients: Ingredient[];
  saved: { $id: string; name_snapshot: string; qty: number; line_total: number }[];
  draft: DraftItem[];
  setDraft: (f: (d: DraftItem[]) => DraftItem[]) => void;
  decimals: number;
  symbol: string;
  draftTotal: number;
  paidTotal: number;
  money: (n: number) => string;
}) {
  const setLine = (i: number, patch: Partial<DraftItem>) =>
    setDraft((d) => d.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));

  const ingOf = (id: string) => ingredients.find((x) => x.$id === id);
  const unitOf = (id: string) => ingOf(id)?.unit ?? '';

  return (
    <Field
      label="Stock bought"
      hint={
        ingredients.length === 0
          ? 'No ingredients set up yet. Add them under Stock, and you will be able to list them here.'
          : 'Optional. Anything you list is added to stock straight away, so you do not have to enter it twice.'
      }
    >
      {saved.length > 0 && (
        <div className="small dim" style={{ marginBottom: '0.5rem' }}>
          Already added to stock from this expense:{' '}
          {saved.map((s) => `${s.qty} × ${s.name_snapshot}`).join(', ')}. Adding more below adds to stock again.
        </div>
      )}

      {draft.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Ingredient</th>
                <th style={{ width: '6.5rem' }}>Quantity</th>
                <th style={{ width: '9rem' }}>Total paid ({symbol})</th>
                <th style={{ width: '2.5rem' }} />
              </tr>
            </thead>
            <tbody>
              {draft.map((d, i) => (
                <tr key={i}>
                  <td>
                    {/* Nothing is prefilled from the last price. What was paid
                        this time is the one thing the person has in front of
                        them, and a box that arrives with last month's figure in
                        it is a box that gets left alone. */}
                    <Select
                      value={d.ingredient_id}
                      onChange={(e) => setLine(i, { ingredient_id: e.target.value })}
                    >
                      <option value="">Choose</option>
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
                      {/* An item bought in packs gets a choice; everything else
                          gets its unit as a label, because a picker with one
                          option is a question with no information in it. */}
                      {ingOf(d.ingredient_id) && hasPack(ingOf(d.ingredient_id)!) ? (
                        <Select
                          value={optionFor(ingOf(d.ingredient_id)!, d.buyKey).key}
                          onChange={(e) => setLine(i, { buyKey: e.target.value as 'pack' | 'unit' })}
                        >
                          {buyOptions(ingOf(d.ingredient_id)!).map((o) => (
                            <option key={o.key} value={o.key}>{o.label}</option>
                          ))}
                        </Select>
                      ) : (
                        <span className="small dim">{unitOf(d.ingredient_id)}</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <Input
                      value={d.totalText}
                      inputMode="decimal"
                      placeholder="0.00"
                      onChange={(e) => setLine(i, { totalText: e.target.value })}
                    />
                    {/* Shown as it is worked out, never typed. The figure stock
                        keeps is a portion of rice, not a trip to the market. */}
                    {unitCostOf(d, decimals) > 0 && (
                      <div className="small dim" style={{ marginTop: '0.2rem' }}>
                        {money(unitCostOf(d, decimals))} per{' '}
                        {optionFor(ingOf(d.ingredient_id) ?? { unit: '' }, d.buyKey).label.replace(/s$/, '')
                          || unitOf(d.ingredient_id) || 'unit'}
                      </div>
                    )}
                    {/* The whole risk of packs is buying two bottles and
                        getting fifty-six of something unexpected, so the sum
                        is said out loud rather than done quietly. A sentence
                        that looks wrong here means the pack size is wrong,
                        and that is far cheaper to find now. */}
                    {(() => {
                      const ing = ingOf(d.ingredient_id);
                      if (!ing) return null;
                      const opt = optionFor(ing, d.buyKey);
                      const perBought = unitCostOf(d, decimals);
                      const said = describePurchase({
                        qty: Number(d.qtyText) || 0,
                        option: opt,
                        ing,
                        money,
                        unitCost: perBought > 0 ? Math.round(perBought / opt.per) : undefined,
                      });
                      return said ? (
                        <div className="small" style={{ marginTop: '0.2rem', fontWeight: 550 }}>{said}</div>
                      ) : null;
                    })()}
                  </td>
                  <td className="num">
                    <Button size="sm" variant="ghost" type="button" onClick={() => setDraft((x) => x.filter((_, idx) => idx !== i))}>
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
          onClick={() => setDraft((d) => [...d, { ingredient_id: '', qtyText: '', totalText: '' }])}
        >
          Add stock item
        </Button>
        {draft.length > 0 && (
          <span className="small dim">
            Lines come to {money(draftTotal)}
            {paidTotal > 0 && draftTotal !== paidTotal && ` · you entered ${money(paidTotal)} paid`}
          </span>
        )}
      </div>

      {draft.length > 0 && paidTotal > 0 && draftTotal > paidTotal && (
        <div style={{ marginTop: '0.5rem' }}>
          <Notice tone="warn">
            The items add up to more than the amount paid. That is allowed, part of a delivery may be on credit, but
            it is worth a second look.
          </Notice>
        </div>
      )}
    </Field>
  );
}
