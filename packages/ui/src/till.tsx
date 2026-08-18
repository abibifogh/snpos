import { useEffect, useState } from 'react';
import { Button, Field, FormError, Input, Modal, Notice, Select, Textarea } from './components';
import {
  db, DB_ID, ID, saveDropping, formatMoney, parseMoney, toInput, loadIngredients, loadPaymentMethods,
  PAID_TO_KINDS, payeeLabel, legacyExpenseCategory, loadPaidToOptions, receiveStock, uploadFile,
  buyOptions, convertPurchase, describePurchase, hasPack, categoriesForSide, canSeePrivateExpenses,
  expenseMethods, recordHandover, handoversForShift, HANDOVER_DESTINATIONS, destinationLabel,
  fromTakings, postExpense, accountForExpense,
  expenseDraftKey, readExpenseDraft, saveExpenseDraft, clearExpenseDraft,
} from '@snpos/core';
import type {
  PaymentMethod, Settings, StaffProfile, PaidToKind, Supplier, ExpenseCategoryDoc, Ingredient,
  CashHandover, HandoverDestination, Module, ShiftExpense,
} from '@snpos/core';

/**
 * The two things a person standing at a till does with cash that is not a sale:
 * pays something out of the drawer, and hands what is left to somebody else.
 *
 * Shared between the kitchen screen and the terminal. They were the kitchen's
 * alone, which meant the shop counter could take money all day and had nowhere
 * to record the taxi that took the delivery, so the drawer was short every
 * night for a reason nobody had written down.
 */

/**
 * One item on a shop run, while it is being typed.
 *
 * Quantity and what was PAID for it, which is what a market receipt says and
 * what the person remembers: "five kilos of rice, a hundred and twenty". The
 * price per kilo is arithmetic done afterwards, and asking for it up front
 * asked somebody standing at a till to do a division in their head and then
 * type the answer — which is how a hundred and twenty cedis of rice gets
 * recorded as six hundred.
 */
/**
 * `buyKey` says whether the quantity is packs or counting units — a bar buys a
 * bottle and pours shots, so "1" can mean one bottle and twenty-eight on the
 * shelf. Absent means the pack when the item has one. See packs.ts.
 */
interface DraftLine { ingredientId: string; qtyText: string; totalText: string; buyKey?: 'pack' | 'unit' }

/**
 * Said when the spend saved but the answer to "where did the money come from"
 * could not be kept, because the database has not been provisioned since that
 * question was added. Named rather than typed twice: it is the same sentence
 * whether an expense is being recorded or corrected.
 */
const CANNOT_STORE_SOURCE =
  'Spend recorded, but where the money came from could not be saved. '
  + 'Run "Provision Appwrite" in GitHub Actions, then set it again from the admin app.';

/**
 * Money out, recorded where it was spent rather than remembered until later.
 *
 * Asks the same "paid to" question the admin form asks, from the same shared
 * list. It used to ask for a name in a box and file everything as "other",
 * which meant the same purchase looked like two different things depending on
 * which screen it was entered from.
 */
export function ExpenseModal({
  module, venueId, shiftId, settings, userId, expense, askPaidFrom = true, onClose, onDone,
}: {
  module: Module;
  venueId: string;
  shiftId: string;
  settings: Settings;
  userId: string;
  /**
   * Whether to ask which drawer the money came out of.
   *
   * Off on the kitchen screen. A cook pays for a market run out of the cash in
   * front of them and out of nothing else, so the question has one answer, and
   * a field with one answer in the middle of a form is a thing people stop
   * reading — which is how the field below it stops being read too. The value
   * is still recorded; it is simply not asked for.
   *
   * On at the till and in the admin form, where somebody genuinely may have
   * paid a supplier by transfer.
   */
  askPaidFrom?: boolean;
  /**
   * An expense already recorded, being corrected.
   *
   * A figure typed wrongly at eight o'clock used to stand until an admin
   * noticed, which is usually after the drawer has been counted against it.
   * The person who was there is the person who knows what the receipt said.
   *
   * Only offered while the shift is open. Once it has closed the number has
   * been counted against and changing it has consequences elsewhere, which is
   * a decision for an admin.
   */
  expense?: ShiftExpense | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const editing = expense ?? null;
  const [categories, setCategories] = useState<ExpenseCategoryDoc[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [categoryKey, setCategoryKey] = useState(editing?.category_key || editing?.category || '');
  const [methodId, setMethodId] = useState(editing?.paid_from_method_id ?? '');
  const [amountText, setAmountText] = useState(
    editing ? toInput(editing.amount, settings.currency_decimals ?? 2) : '',
  );
  /**
   * Anything on the receipt that is not one of the items.
   *
   * Switched off at the owner's request, so nothing sets this and `extra` is
   * always nought. Kept rather than torn out: the arithmetic, the validation
   * and the note it writes are all correct and were tested, and putting the
   * box back is one input. Ripping it out would mean writing it again.
   */
  const [extraText] = useState('');
  const [paidToKind, setPaidToKind] = useState<PaidToKind>(editing?.paid_to_kind ?? 'open_market');
  const [supplierId, setSupplierId] = useState(editing?.supplier_id ?? '');
  const [staffId, setStaffId] = useState(editing?.paid_to_staff_id ?? '');
  const [payee, setPayee] = useState(editing?.paid_to_kind === 'supplier' ? '' : editing?.payee ?? '');
  const [noteText, setNoteText] = useState(editing?.note ?? '');
  /**
   * Was this paid with money taken during the shift?
   *
   * Yes for anything out of the till, which is most of it and so the default.
   * No when it came from petty cash: the business still spent it, but this
   * shift never took it, and deducting it makes the count come up short by an
   * amount that was never there. Being chased over a shortage that did not
   * happen is exactly what teaches people to stop recording expenses.
   */
  const [fromDrawer, setFromDrawer] = useState<boolean>(editing ? fromTakings(editing) : true);
  // What was actually bought. A shop run is rarely one thing, and an expense
  // recorded as a single number tells you money left without telling you what
  // came back with it.
  const [lines, setLines] = useState<DraftLine[]>([{ ingredientId: '', qtyText: '', totalText: '' }]);
  const [receipt, setReceipt] = useState<{ file: File; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when this form opened onto work somebody had already started. */
  const [restored, setRestored] = useState(false);

  const decimals = settings.currency_decimals ?? 2;

  /**
   * Where a half-typed spend is kept while somebody deals with an order.
   *
   * Only for a NEW expense. A correction is opened from a row that already
   * exists and already holds the answers, so there is nothing to recover and
   * restoring over it would replace a real record's figures with a stale draft.
   */
  const draftKey = expenseDraftKey(venueId, shiftId, userId);
  const store = typeof window === 'undefined' ? null : window.localStorage;

  useEffect(() => {
    if (editing) return;
    const draft = readExpenseDraft(store, draftKey);
    if (!draft) return;
    if (draft.categoryKey) setCategoryKey(draft.categoryKey);
    if (draft.methodId) setMethodId(draft.methodId);
    if (draft.amountText !== undefined) setAmountText(draft.amountText);
    if (draft.paidToKind) setPaidToKind(draft.paidToKind as PaidToKind);
    if (draft.supplierId !== undefined) setSupplierId(draft.supplierId);
    if (draft.staffId !== undefined) setStaffId(draft.staffId);
    if (draft.payee !== undefined) setPayee(draft.payee);
    if (draft.noteText !== undefined) setNoteText(draft.noteText);
    if (draft.fromDrawer !== undefined) setFromDrawer(draft.fromDrawer);
    if (draft.lines?.length) setLines(draft.lines);
    setRestored(true);
    // Opening is the only moment this runs. Re-reading on every keystroke would
    // fight the person typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Written on every change rather than on the way out.
   *
   * A modal has more exits than it has buttons: the ✕, Escape, the tab being
   * closed, the tablet going to sleep, the browser deciding to reload a page it
   * has been sitting on all evening. Saving on close covers one of those.
   */
  useEffect(() => {
    if (editing) return;
    saveExpenseDraft(store, draftKey, {
      categoryKey, methodId, amountText, paidToKind, supplierId, staffId,
      payee, noteText, fromDrawer, lines,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryKey, methodId, amountText, paidToKind, supplierId, staffId, payee, noteText, fromDrawer, lines]);

  /**
   * Start again, deliberately.
   *
   * Cancel does NOT clear the draft, which is the whole point: the commonest
   * way out of this form is somebody leaving to accept an order, and a Cancel
   * that threw the work away would put them back where they started. So
   * throwing it away is its own act, offered next to the message that says
   * work was recovered.
   */
  const startAgain = () => {
    clearExpenseDraft(store, draftKey);
    setCategoryKey(categories[0]?.key ?? 'other');
    setAmountText('');
    setPaidToKind('open_market');
    setSupplierId('');
    setStaffId('');
    setPayee('');
    setNoteText('');
    setFromDrawer(true);
    setLines([{ ingredientId: '', qtyText: '', totalText: '' }]);
    setReceipt(null);
    setError(null);
    setRestored(false);
  };

  /**
   * Whether spending can be itemised into stock.
   *
   * Only in the kitchen. Ingredients are recipes and shelves, and the shop's
   * goods arrive from consignors through a delivery, not out of the drawer, so
   * offering a rice-and-tomatoes list to a craft cashier would be offering
   * somebody else's larder.
   *
   * And never while correcting an expense. Its items were delivered into stock
   * when it was recorded, and re-listing them here would deliver them a second
   * time; unpicking that properly is a reversal, which is an admin's job and
   * not a cook's. A correction changes the figures on the expense, and what
   * already reached the shelf stays reached.
   */
  const stocks = module !== 'craft' && !editing;

  useEffect(() => {
    (async () => {
      const [opts, m, ing] = await Promise.all([
        loadPaidToOptions(),
        loadPaymentMethods(venueId),
        /*
          This side's larder only.

          A bartender recording a crate of tonic was scrolling past the
          kitchen's rice, tomatoes and gas to find it, and the list a cook sees
          had the bar's forty bottles in it. Worse than slow: the wrong Soda is
          one tap away from the right one, and a delivery booked against the
          other side's shelf is a shortage on one and a surplus on the other,
          discovered weeks later at a count.
        */
        stocks
          ? loadIngredients(venueId, module).catch(() => [] as Ingredient[])
          : Promise.resolve([] as Ingredient[]),
      ]);
      /*
        This side's spending only, plus the ones that belong to everybody.
        A bartender should not scroll past "Kitchen gas" to find tonic.

        And nothing marked admin only, unless this is an admin or somebody an
        admin has let in. Rent and the owner's drawings are real spending that
        has to be recorded; they are not something the floor should read off a
        dropdown while a customer waits.
      */
      const me = opts.staff.find((s) => s.user_id === userId);
      const mine = categoriesForSide(opts.categories, module, {
        canSeePrivate: canSeePrivateExpenses(me),
      });
      setCategories(mine);
      setSuppliers(opts.suppliers);
      setStaff(opts.staff);
      /*
        Only chosen when there is nothing there already.

        An edit knows its own answers, and so does a restored draft — this
        loads after the form has opened, so setting a default outright would
        wait a beat and then quietly refile somebody's recovered market run
        under whatever happens to be first in the list. Functional, so it reads
        the value as it is at that moment rather than as it was on mount.
      */
      if (!editing) setCategoryKey((cur) => cur || mine[0]?.key || 'other');
      // Only what an expense is allowed to be paid out of ever reaches the
      // form, so the restriction cannot be got round by leaving the dropdown
      // where it was.
      const allowed = expenseMethods(m, settings);
      setMethods(allowed);
      // Same reason as the category above: a restored draft already has one.
      if (!editing) {
        setMethodId((cur) => cur || allowed.find((x) => x.kind === 'cash')?.$id || allowed[0]?.$id || '');
      }
      setIngredients(ing.filter((i) => i.active).sort((a, b) => a.name.localeCompare(b.name)));
    })().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId, settings.expense_paid_from, stocks, module]);

  const filledLines = stocks ? lines.filter((l) => l.ingredientId && Number(l.qtyText) > 0) : [];

  /**
   * Lines add up to the total, so nobody types it twice.
   *
   * Kept editable when there are no lines at all, plenty of spending (a taxi,
   * a gas refill) has nothing to put into stock.
   */
  const linesTotal = filledLines.reduce((sum, l) => sum + (parseMoney(l.totalText, decimals) ?? 0), 0);

  /**
   * The price per unit, worked back from what was paid.
   *
   * This is the figure stock keeps, because a recipe costs a portion of rice
   * and not a trip to the market. Nobody types it: it is a division, and a
   * division at a counter at nine o'clock at night is a mistake waiting to
   * happen.
   */
  const unitCostOf = (l: DraftLine): number => {
    const qty = Number(l.qtyText);
    const total = parseMoney(l.totalText, decimals) ?? 0;
    return qty > 0 ? Math.round(total / qty) : 0;
  };

  /**
   * Which unit a line is being bought in. Defaults to the pack, because
   * setting a pack size up is somebody saying "this is how it arrives".
   */
  const buyOptionFor = (ing: { unit: string; pack_size?: number; pack_name?: string }, key?: 'pack' | 'unit') => {
    const opts = buyOptions(ing);
    return opts.find((o) => o.key === key) ?? opts[0];
  };

  /** The remainder, and only ever a positive one. */
  const extra = Math.max(0, parseMoney(extraText, decimals) ?? 0);

  const setLine = (index: number, patch: Partial<DraftLine>) =>
    setLines((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  /**
   * Choosing an ingredient answers the category question by itself.
   *
   * Rice is always Supplies. Asking somebody to say so on every delivery is how
   * you end up with half the shop runs filed under "other".
   */
  const pickIngredient = (index: number, ingredientId: string) => {
    const ing = ingredients.find((i) => i.$id === ingredientId);
    // Nothing is prefilled. What was paid at the market today is not something
    // this system knows, and a figure it guessed at would be a figure somebody
    // saved without reading.
    setLine(index, { ingredientId });
    if (ing?.expense_category_key) setCategoryKey(ing.expense_category_key);
    // Always keep one blank row at the end, so adding another is just typing.
    setLines((rows) =>
      rows.some((r, i) => i !== index && !r.ingredientId)
        ? rows
        : [...rows, { ingredientId: '', qtyText: '', totalText: '' }],
    );
  };

  const save = async () => {
    // The lines win when there are any: they are the itemised truth, and a
    // total that disagrees with them is a total somebody mistyped. Plus
    // whatever was on the receipt and not in the bag, which is money that
    // genuinely left the drawer and has to be recorded as such.
    const amount = filledLines.length > 0 ? linesTotal + extra : parseMoney(amountText, decimals);
    if (amount === null || amount <= 0) { setError('Enter the amount spent.'); return; }
    if (filledLines.length > 0 && extraText.trim() !== '' && parseMoney(extraText, decimals) === null) {
      setError('The extra amount is not a number. Clear it or correct it.');
      return;
    }
    if (!methodId) { setError('Choose how it was paid.'); return; }
    if (paidToKind === 'supplier' && !supplierId) { setError('Choose which supplier was paid.'); return; }
    // Either the person from the list, or their name typed in. Somebody who
    // has left, or a casual hand for the day, is still somebody the money went
    // to, and refusing to record that is how it becomes an unexplained
    // shortage instead.
    if (paidToKind === 'staff' && !staffId && !payee.trim()) {
      setError('Choose which member of staff took the money, or type their name.');
      return;
    }
    for (const l of filledLines) {
      if (parseMoney(l.totalText, decimals) === null) {
        setError('One of the items does not have a valid amount paid.');
        return;
      }
    }

    setBusy(true);
    setError(null);
    try {
      // The receipt goes up first. If the upload fails the expense is still
      // recorded, a missing photo is a nuisance, a missing expense is a hole
      // in the drawer nobody can explain.
      let receiptFileId = '';
      if (receipt) {
        receiptFileId = (await uploadFile(receipt.file, 'receipt', settings).catch(() => null))?.fileId ?? '';
      }

      const fields = {
        // Which side's books this comes out of. Carried on the row rather than
        // read back from the shift, because an expense outlives the shift it
        // was recorded in and still belongs to one side.
        module,
        category: legacyExpenseCategory(categoryKey),
        category_key: categoryKey,
        paid_to_kind: paidToKind,
        supplier_id: paidToKind === 'supplier' ? supplierId : '',
        paid_to_staff_id: paidToKind === 'staff' ? staffId : '',
        payee: payeeLabel(paidToKind, {
          supplierName: suppliers.find((s) => s.$id === supplierId)?.name,
          staffName: staff.find((s) => s.$id === staffId)?.display_name,
          payee,
        }),
        amount,
        paid_from_method_id: methodId,
        /**
         * The remainder explains itself, in the record rather than in
         * somebody's memory.
         *
         * The items are stored line by line and the total is stored once. Left
         * unsaid, an extra makes those two disagree, and whoever checks the
         * books in a month finds a total three cedis above the things it is
         * made of and no way to tell a taxi from a typing mistake.
         */
        note: [
          noteText.trim(),
          extra > 0 && filledLines.length > 0
            ? `Includes ${formatMoney(extra, settings)} not itemised.`
            : '',
        ].filter(Boolean).join(' · ').slice(0, 500), // the column's own limit
        from_takings: fromDrawer,
      };

      /**
       * A correction changes the figures and leaves everything else alone.
       *
       * Not the receipt photo, not who recorded it, and not the approval it is
       * waiting on: none of those are what somebody is fixing when they notice
       * the amount is wrong, and quietly resetting them would lose work that
       * was done properly the first time.
       */
      if (editing) {
        const { dropped } = await saveDropping('shift_expenses', editing.$id, fields);
        onDone(dropped.includes('from_takings') ? CANNOT_STORE_SOURCE : 'Spend corrected');
        return;
      }

      /**
       * Saved even if the database has not caught up with the form.
       *
       * `from_takings` is newer than some projects, and Appwrite refuses a
       * whole write for one attribute it does not recognise — so recording a
       * taxi failed outright with "unknown attribute", which is the form
       * refusing to do its job over a detail. The spend matters more than the
       * detail: it is written without the field, and the message says the
       * answer to that one question could not be kept.
       */
      const { id: expenseId, dropped } = await saveDropping('shift_expenses', null, {
        venue_id: venueId,
        shift_id: shiftId,
        ...fields,
        receipt_file_id: receiptFileId,
        created_by: userId,
        approval_status: 'pending',
      });
      const expense = { $id: expenseId };
      const lostSource = dropped.includes('from_takings');

      /**
       * On the books straight away, not at shift close.
       *
       * Expenses used to reach the ledger only when a shift closed, so one
       * recorded outside a shift never reached it at all. Keyed by the
       * expense's own id, so the shift close doing it again later is a no-op
       * rather than a second charge.
       *
       * Best effort on purpose. The spend is recorded either way, and an
       * expense missing from the ledger is a bookkeeping job; an expense that
       * would not save is a hole in the drawer nobody can explain.
       */
      void accountForExpense({ category_key: categoryKey })
        .then((accountCode) => postExpense(venueId, {
          expenseId,
          amount,
          accountCode,
          postedBy: userId,
          shiftId: shiftId || undefined,
        }))
        .catch(() => undefined);

      // Each line is recorded and then delivered into stock. From where the
      // person is standing these are one action, so a line that fails to stock
      // says so rather than disappearing quietly.
      let stockFailures = 0;
      for (const l of filledLines) {
        const ing = ingredients.find((i) => i.$id === l.ingredientId);
        if (!ing) continue;
        /*
          Typed in what they bought, stored in what it is counted in. The price
          converts as well as the quantity, and the price is the half that
          matters: a GHS 300 bottle recorded as GHS 300 a shot values the shelf
          at twenty-eight times what is on it. No pack means a conversion of
          one, which is every kitchen ingredient there has ever been.
        */
        const opt = buyOptionFor(ing, l.buyKey);
        // Worked out from what was paid, not typed. See unitCostOf.
        const perBought = unitCostOf(l);
        const converted = convertPurchase({
          qty: Number(l.qtyText),
          costPerBought: perBought,
          per: opt.per,
        });
        const qty = converted.qty;
        const unitCost = converted.unitCost;
        const lineTotal = parseMoney(l.totalText, decimals) ?? 0;
        /**
         * Overheads are spent the moment they are bought.
         *
         * Anything nobody counts at the end of a shift — transport, a delivery
         * fee, gas for the van, a repair — is used up in the buying. There is
         * no shelf for it, so raising a stock quantity would create a balance
         * that only ever goes up: nothing depletes it, no recipe draws on it,
         * and the value sits in the books as though the restaurant owned four
         * hundred cedis of taxi rides.
         *
         * The line is still written, so the shop run still breaks down into
         * what it was actually spent on, and it is marked as not stocked so
         * anybody reading it later can see which of the two it was.
         */
        const overhead = ing.counted_at_close === false;
        try {
          await db.createDocument(DB_ID, 'expense_items', ID.unique(), {
            expense_id: expense.$id,
            ingredient_id: ing.$id,
            name_snapshot: ing.name,
            qty,
            unit_cost: unitCost,
            // What was actually handed over, not the rounded unit price
            // multiplied back up: those differ by a pesewa or two on anything
            // that does not divide evenly, and the receipt is the truth.
            line_total: lineTotal,
            stocked: !overhead,
          });
          if (!overhead) {
            await receiveStock({
              venueId,
              ingredient: ing,
              qty,
              unitCost,
              refType: 'expense',
              refId: expense.$id,
              shiftId,
              createdBy: userId,
              note: payee.trim() ? `Bought from ${payee.trim()}` : 'Expense',
            });
          }
        } catch {
          stockFailures += 1;
        }
      }

      // Saved for real, so the unfinished copy has nothing left to protect.
      clearExpenseDraft(store, draftKey);

      onDone(
        lostSource
          ? CANNOT_STORE_SOURCE
          : stockFailures > 0
          ? `Spend recorded, but ${stockFailures} item${stockFailures > 1 ? 's' : ''} did not reach stock`
          : filledLines.length
            ? `Spend recorded and ${filledLines.length} item${filledLines.length > 1 ? 's' : ''} added to stock`
            : 'Spend recorded',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record that.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? 'Correct this spend' : 'Record spend'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy}>
            {editing ? 'Save the correction' : 'Save'}
          </Button>
        </>
      }
    >
      <FormError message={error} />
      {/*
        Said, not silent.

        Recovered work that appears without explanation reads as the form
        having gone wrong — somebody opens it expecting blank boxes and finds
        an amount and a payee already in them, and the safe assumption is that
        it belongs to somebody else. Naming it, and putting the way out beside
        it, is what makes the figures trustworthy enough to save.
      */}
      {restored && (
        <div style={{ marginBottom: '0.8rem' }}>
          <Notice tone="info">
            Picked up where you left off.{' '}
            <button
              type="button"
              onClick={startAgain}
              style={{
                background: 'none', border: 'none', padding: 0, font: 'inherit',
                color: 'inherit', textDecoration: 'underline', cursor: 'pointer',
              }}
            >
              Start again
            </button>
          </Notice>
        </div>
      )}
      <p className="small dim" style={{ marginTop: 0 }}>
        {editing
          ? 'Fix what was typed wrongly. What was added to stock stays as it is.'
          : 'Money paid out now, so the drawer still balances at the end of the night.'}
      </p>

      {/* What was bought, before what it cost. A shop run is several things,
          and listing them here is what puts them into stock, otherwise
          somebody has to enter the same delivery twice.

          Not on the shop counter: see `stocks` above. */}
      {stocks && <Field
        label="What was bought"
        hint="Leave empty for spending with nothing to stock: transport, gas, repairs."
      >
        <div className="stack" style={{ gap: '0.45rem' }}>
          {lines.map((l, i) => {
            const picked = ingredients.find((x) => x.$id === l.ingredientId);
            const unit = picked?.unit ?? 'unit';
            const opt = buyOptionFor(picked ?? { unit }, l.buyKey);
            const per = unitCostOf(l);
            return (
              <div key={i}>
                <div className="row" style={{ gap: '0.35rem', alignItems: 'flex-start' }}>
                  <Select
                    value={l.ingredientId}
                    onChange={(e) => pickIngredient(i, e.target.value)}
                    style={{ flex: 2 }}
                  >
                    <option value="">Item</option>
                    {ingredients.map((ing) => (
                      <option key={ing.$id} value={ing.$id}>{ing.name} ({ing.unit})</option>
                    ))}
                  </Select>
                  <Input
                    value={l.qtyText}
                    inputMode="decimal"
                    placeholder={`How many ${opt.label}`}
                    style={{ flex: 1 }}
                    onChange={(e) => setLine(i, { qtyText: e.target.value })}
                  />
                  {/* Only shown for something bought in packs. A picker with
                      one option is a question with no information in it, and
                      this form is used standing up under time pressure. */}
                  {picked && hasPack(picked) && (
                    <Select
                      value={opt.key}
                      style={{ flex: 1 }}
                      onChange={(e) => setLine(i, { buyKey: e.target.value as 'pack' | 'unit' })}
                    >
                      {buyOptions(picked).map((o) => (
                        <option key={o.key} value={o.key}>{o.label}</option>
                      ))}
                    </Select>
                  )}
                  {/* What was handed over for this item. The market's own
                      figure, which is the one the person remembers. */}
                  <Input
                    value={l.totalText}
                    inputMode="decimal"
                    placeholder="Paid"
                    style={{ flex: 1 }}
                    onChange={(e) => setLine(i, { totalText: e.target.value })}
                  />
                  {lines.length > 1 && (
                    <Button size="sm" variant="ghost" onClick={() => setLines((r) => r.filter((_, x) => x !== i))}>
                      ×
                    </Button>
                  )}
                </div>
                {/* The division, done and shown. Stock is costed per unit, so
                    this figure is what the recipes will use, and a price that
                    looks wrong to somebody who was at the market is caught
                    here rather than in a costing report next month. */}
                {per > 0 && (
                  <div className="small dim" style={{ marginTop: '0.15rem' }}>
                    {formatMoney(per, settings)} per {opt.label.replace(/s$/, '') || unit}
                  </div>
                )}
                {/* Two bottles becoming fifty-six shots is the one thing that
                    can go badly wrong here, so it is said rather than done
                    quietly. A sentence that reads wrong means the pack size is
                    wrong, which is much cheaper to find now than at a count. */}
                {picked && (() => {
                  const said = describePurchase({
                    qty: Number(l.qtyText) || 0,
                    option: opt,
                    ing: picked,
                    money: (m) => formatMoney(m, settings),
                    unitCost: per > 0 ? Math.round(per / opt.per) : undefined,
                  });
                  return said ? (
                    <div className="small" style={{ marginTop: '0.15rem', fontWeight: 550 }}>{said}</div>
                  ) : null;
                })()}
              </div>
            );
          })}
        </div>
      </Field>}

      {/* Not asked once items are chosen. Each ingredient already carries the
          category it belongs to, set when an admin added it, so asking again
          is asking the same question twice and inviting two answers.
          Still asked for spending with nothing to stock: a taxi, gas, a
          repair, because there is nothing to take the answer from. */}
      {filledLines.length === 0 && (
        <Field label="What for">
          <Select value={categoryKey} onChange={(e) => setCategoryKey(e.target.value)}>
            {categories.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
            {/* An expense filed under a category that has since been archived
                keeps showing it. The list here is only what is still on offer,
                and a select whose value is not among its options displays the
                first one instead — so opening somebody's old expense to fix
                the amount would quietly refile it. */}
            {categoryKey && !categories.some((c) => c.key === categoryKey) && (
              <option value={categoryKey}>{categoryKey} (no longer used)</option>
            )}
          </Select>
        </Field>
      )}
      {filledLines.length > 0 && (
        <p className="small dim">
          Filed under <strong>{categories.find((c) => c.key === categoryKey)?.name ?? categoryKey}</strong>, from the
          items above.
        </p>
      )}

      {filledLines.length > 0 ? (
        <Field
          label={`Amount (${settings.currency_symbol ?? ''})`}
          hint="Added up from the items above."
        >
          {/* Blank while it is nothing. "0.00" in a box reads as a figure
              somebody entered, and this one is worked out; showing zero where
              nothing has been added yet says the form did the sum and got
              nought, which is not what happened.

              There was a small box beside this for anything on the receipt
              that was not one of the items — a taxi, a tip to the boy who
              carried it. Switched off at the owner's request; the code for it
              is still here, minus its box, so putting it back is a matter of
              rendering one input again. Until then `extra` is always nought
              and the total is the items and nothing else. */}
          <Input value={linesTotal > 0 ? toInput(linesTotal, decimals) : ''} disabled />
        </Field>
      ) : (
        <Field label={`Amount (${settings.currency_symbol ?? ''})`}>
          {/*
            No autoFocus.

            Opening a form used to open the keyboard with it, before anybody
            had decided what they were recording, and on a landscape till that
            is half the screen gone at the moment somebody is trying to read
            the form. The amount is rarely the first thing typed anyway; it is
            near the bottom of what a person actually chooses. The keyboard
            arrives when a box is touched, which is when it is wanted.
          */}
          <Input value={amountText} inputMode="decimal" onChange={(e) => setAmountText(e.target.value)} />
        </Field>
      )}
      {/* One option is not a choice. When the restaurant pays for shop runs out
          of the drawer and nothing else, the default, a dropdown with a
          single line in it is a question that wastes a tap and implies there is
          something to decide. It says what happened instead. */}
      {/* Not asked on the kitchen screen: see askPaidFrom. The answer is still
          recorded — it defaults to the cash drawer, which is where a cook's
          market money comes from — it is just not put in front of somebody
          who has no other answer to give. */}
      {askPaidFrom && (methods.length === 1 ? (
        <Field label="Paid from" hint="Set by an admin under Settings.">
          <Input value={methods[0].name} disabled />
        </Field>
      ) : (
        <Field label="Paid from">
          <Select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
            {methods.map((m) => <option key={m.$id} value={m.$id}>{m.name}</option>)}
          </Select>
        </Field>
      ))}
      {/*
        Whose money it was.

        Asked plainly and asked every time, because the two cases look
        identical on a form and are completely different at closing time.
        Money from the drawer must come off what the drawer should hold. Money
        from somebody's own pocket must not: the till never had it, and
        deducting it makes the count come up short by an amount that was never
        there, which is somebody being accused of losing money they actually
        lent the business.

        Yes is the default and the common case. Answering no records the spend
        exactly as before; it only stops it being taken off the count.
      */}
      <Field
        label="Where did the money come from"
        hint={fromDrawer
          ? 'Taken off what your drawer should hold at the end of the shift.'
          : 'Recorded as money the business spent. Not taken off your drawer.'}
      >
        <Select
          value={fromDrawer ? 'shift' : 'petty'}
          onChange={(e) => setFromDrawer(e.target.value === 'shift')}
        >
          <option value="shift">From my shift</option>
          <option value="petty">From petty cash</option>
        </Select>
      </Field>

      <Field label="Paid to" hint="Not every purchase has a supplier behind it.">
        <Select value={paidToKind} onChange={(e) => setPaidToKind(e.target.value as PaidToKind)}>
          {PAID_TO_KINDS.map((k) => <option key={k.v} value={k.v}>{k.l}</option>)}
        </Select>
      </Field>
      {paidToKind === 'supplier' && (
        <Field label="Which supplier" hint="Suppliers are added by an admin under Stock.">
          <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">Choose</option>
            {suppliers.map((s) => <option key={s.$id} value={s.$id}>{s.name}</option>)}
          </Select>
        </Field>
      )}
      {paidToKind === 'staff' && (
        <Field label="Which member of staff" hint="For money handed to someone to go and buy, or a staff advance.">
          <Select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">Choose</option>
            {staff.map((s) => <option key={s.$id} value={s.$id}>{s.display_name}</option>)}
          </Select>
        </Field>
      )}
      {/* Only where a name is the thing that is missing.
          A supplier and a member of staff have both already been picked from a
          list, and the open market has no name to give: asking for one there
          was asking a question with no answer, which is how a form teaches
          people to skip past its boxes. */}
      {(paidToKind === 'other' || paidToKind === 'staff') && (
        <Field
          label="Name"
          hint={paidToKind === 'staff'
            ? 'Optional. Only if the person is not in the list above.'
            : 'Whoever received the money.'}
        >
          <Input value={payee} onChange={(e) => setPayee(e.target.value)} />
        </Field>
      )}
      {/* Photographed here, at the moment the money changes hands. A receipt
          "attached later from the admin app" is a receipt in somebody's
          pocket at the end of the night. */}
      {/* Not offered on a correction: the photo already attached is the one
          taken when the money changed hands, and replacing it from a form
          headed "correct this" is how the original disappears. */}
      <Field label="Receipt" hidden={!!editing} hint="Optional. Take a photo of it now if there is one.">
        {receipt ? (
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="small">{receipt.name}</span>
            <Button size="sm" variant="ghost" onClick={() => setReceipt(null)}>Remove</Button>
          </div>
        ) : (
          <input
            type="file"
            accept="image/*,application/pdf"
            capture="environment"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 10 * 1024 * 1024) { setError('That photo is over 10MB. Take a smaller one.'); return; }
              setReceipt({ file, name: file.name });
            }}
          />
        )}
      </Field>

      <Field label="Note" hint="Optional.">
        <Textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} />
      </Field>
    </Modal>
  );
}
/**
 * Cash leaving one person's hands.
 *
 * Opened by whoever is handing over, on the screen they are already standing
 * at, because the moment cash moves is the only moment anybody will write it
 * down. A form somebody has to find later is a form that gets filled in from
 * memory, or not at all.
 *
 * Both names are asked for. One name is a claim; two is a record, and the
 * conversation this is meant to settle is always between two people.
 */
export function HandoverModal({
  venueId, shiftId, settings, who, onClose, onDone,
}: {
  venueId: string;
  shiftId?: string;
  settings: Settings;
  who: StaffProfile | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const decimals = settings.currency_decimals ?? 2;
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [amountText, setAmountText] = useState('');
  const [methodId, setMethodId] = useState('');
  const [destination, setDestination] = useState<HandoverDestination>('manager');
  const [receivedById, setReceivedById] = useState('');
  const [note, setNote] = useState('');
  const [mine, setMine] = useState<CashHandover[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [opts, m] = await Promise.all([loadPaidToOptions(), loadPaymentMethods(venueId)]);
      setStaff(opts.staff.filter((s) => s.active !== false));
      const cash = m.filter((x) => x.kind === 'cash');
      setMethods(cash.length ? cash : m);
      setMethodId((cash[0] ?? m[0])?.$id ?? '');
      if (shiftId) {
        // What this person has already handed over on this shift. Shown so a
        // second trip to the safe is obviously a second trip, rather than
        // somebody wondering whether the first one saved.
        const rows = await handoversForShift(shiftId).catch(() => [] as CashHandover[]);
        setMine(rows.filter((r) => r.staff_id === (who?.$id ?? '')));
      }
    })().catch(() => undefined);
  }, [venueId, shiftId, who?.$id]);

  const save = async () => {
    const amount = parseMoney(amountText, decimals);
    if (amount === null || amount <= 0) { setError('Enter how much you are handing over.'); return; }
    if (!who) { setError('This device does not know who you are. Sign in again.'); return; }
    // "A manager" with no manager named is the entry nobody can follow up.
    if ((destination === 'manager' || destination === 'owner') && !receivedById) {
      setError('Say who is taking it.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const method = methods.find((m) => m.$id === methodId);
      const taker = staff.find((s) => s.$id === receivedById) ?? null;
      await recordHandover({
        venueId,
        shiftId,
        staff: who,
        amount,
        methodId,
        methodName: method?.name,
        destination,
        receivedBy: taker,
        note: note.trim(),
      });
      onDone(
        `${formatMoney(amount, settings)} handed to ${taker?.display_name ?? destinationLabel(destination).toLowerCase()}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record that.');
      setBusy(false);
    }
  };

  const already = mine.filter((r) => r.status !== 'corrected').reduce((s, r) => s + r.amount, 0);

  return (
    <Modal
      title="Hand over cash"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy}>Record it</Button>
        </>
      }
    >
      <FormError message={error} />

      <p className="small dim" style={{ marginTop: 0 }}>
        This writes down that you handed the money over. It does not move anything and it does not close the
        shift; it is so there is a record of what you finished with, in your name.
      </p>

      {already > 0 && (
        <Notice tone="info">
          You have already handed over {formatMoney(already, settings)} on this shift. This adds to that.
        </Notice>
      )}

      <Field label={`How much (${settings.currency_symbol ?? ''})`}>
        <Input value={amountText} inputMode="decimal" autoFocus onChange={(e) => setAmountText(e.target.value)} />
      </Field>

      {methods.length > 1 && (
        <Field label="Out of">
          <Select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
            {methods.map((m) => <option key={m.$id} value={m.$id}>{m.name}</option>)}
          </Select>
        </Field>
      )}

      <Field label="Where is it going?">
        <Select value={destination} onChange={(e) => setDestination(e.target.value as HandoverDestination)}>
          {HANDOVER_DESTINATIONS.map((d) => <option key={d.v} value={d.v}>{d.l}</option>)}
        </Select>
      </Field>

      <Field
        label="Who is taking it?"
        hint="The person receiving it, so both sides of the handover are on the record."
      >
        <Select value={receivedById} onChange={(e) => setReceivedById(e.target.value)}>
          <option value="">Nobody, it went to the safe</option>
          {staff.filter((s) => s.$id !== who?.$id).map((s) => (
            <option key={s.$id} value={s.$id}>{s.display_name}</option>
          ))}
        </Select>
      </Field>

      <Field label="Anything to add">
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}
