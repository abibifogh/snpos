import { useEffect, useState } from 'react';
import { Button, Field, FormError, Input, Modal, Notice, Select, Textarea } from './components';
import {
  db, DB_ID, ID, formatMoney, parseMoney, toInput, loadIngredients, loadPaymentMethods,
  PAID_TO_KINDS, payeeLabel, legacyExpenseCategory, loadPaidToOptions, receiveStock, uploadFile,
  expenseMethods, recordHandover, handoversForShift, HANDOVER_DESTINATIONS, destinationLabel,
} from '@snpos/core';
import type {
  PaymentMethod, Settings, StaffProfile, PaidToKind, Supplier, ExpenseCategoryDoc, Ingredient,
  CashHandover, HandoverDestination, Module,
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

/** One item on a shop run, while it is being typed. */
interface DraftLine { ingredientId: string; qtyText: string; costText: string }

/**
 * Money out, recorded where it was spent rather than remembered until later.
 *
 * Asks the same "paid to" question the admin form asks, from the same shared
 * list. It used to ask for a name in a box and file everything as "other",
 * which meant the same purchase looked like two different things depending on
 * which screen it was entered from.
 */
export function ExpenseModal({
  module, venueId, shiftId, settings, userId, onClose, onDone,
}: {
  module: Module;
  venueId: string;
  shiftId: string;
  settings: Settings;
  userId: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [categories, setCategories] = useState<ExpenseCategoryDoc[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [categoryKey, setCategoryKey] = useState('');
  const [methodId, setMethodId] = useState('');
  const [amountText, setAmountText] = useState('');
  /**
   * Anything on the receipt that is not one of the items.
   *
   * Only ever added to a total that came from items; where the amount is typed
   * by hand there is nothing to add it to and nothing to reconcile.
   */
  const [extraText, setExtraText] = useState('');
  const [paidToKind, setPaidToKind] = useState<PaidToKind>('open_market');
  const [supplierId, setSupplierId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [payee, setPayee] = useState('');
  const [noteText, setNoteText] = useState('');
  // What was actually bought. A shop run is rarely one thing, and an expense
  // recorded as a single number tells you money left without telling you what
  // came back with it.
  const [lines, setLines] = useState<DraftLine[]>([{ ingredientId: '', qtyText: '', costText: '' }]);
  const [receipt, setReceipt] = useState<{ file: File; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decimals = settings.currency_decimals ?? 2;

  /**
   * Whether spending can be itemised into stock.
   *
   * Only in the kitchen. Ingredients are recipes and shelves, and the shop's
   * goods arrive from consignors through a delivery, not out of the drawer, so
   * offering a rice-and-tomatoes list to a craft cashier would be offering
   * somebody else's larder.
   */
  const stocks = module !== 'craft';

  useEffect(() => {
    (async () => {
      const [opts, m, ing] = await Promise.all([
        loadPaidToOptions(),
        loadPaymentMethods(venueId),
        stocks ? loadIngredients(venueId).catch(() => [] as Ingredient[]) : Promise.resolve([] as Ingredient[]),
      ]);
      setCategories(opts.categories);
      setSuppliers(opts.suppliers);
      setStaff(opts.staff);
      setCategoryKey(opts.categories[0]?.key ?? 'other');
      // Only what an expense is allowed to be paid out of ever reaches the
      // form, so the restriction cannot be got round by leaving the dropdown
      // where it was.
      const allowed = expenseMethods(m, settings);
      setMethods(allowed);
      setMethodId(allowed.find((x) => x.kind === 'cash')?.$id ?? allowed[0]?.$id ?? '');
      setIngredients(ing.filter((i) => i.active).sort((a, b) => a.name.localeCompare(b.name)));
    })().catch(() => undefined);
  }, [venueId, settings.expense_paid_from, stocks]);

  const filledLines = stocks ? lines.filter((l) => l.ingredientId && Number(l.qtyText) > 0) : [];

  /**
   * Lines add up to the total, so nobody types it twice.
   *
   * Kept editable when there are no lines at all, plenty of spending (a taxi,
   * a gas refill) has nothing to put into stock.
   */
  const linesTotal = filledLines.reduce(
    (sum, l) => sum + Math.round(Number(l.qtyText) * (parseMoney(l.costText, decimals) ?? 0)),
    0,
  );

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
    setLine(index, {
      ingredientId,
      /* Prefilled only where there is a real price to prefill. An ingredient
         with no cost recorded used to drop "0.00" into the box, which then had
         to be cleared before the true price could be typed — the one keystroke
         a form should never ask for. */
      costText:
        ing && ing.base_unit_cost > 0 && !lines[index].costText
          ? toInput(ing.base_unit_cost, decimals)
          : lines[index].costText,
    });
    if (ing?.expense_category_key) setCategoryKey(ing.expense_category_key);
    // Always keep one blank row at the end, so adding another is just typing.
    setLines((rows) =>
      rows.some((r, i) => i !== index && !r.ingredientId)
        ? rows
        : [...rows, { ingredientId: '', qtyText: '', costText: '' }],
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
      if (parseMoney(l.costText, decimals) === null) {
        setError('One of the items does not have a valid unit cost.');
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

      const expense = await db.createDocument(DB_ID, 'shift_expenses', ID.unique(), {
        venue_id: venueId,
        shift_id: shiftId,
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
        receipt_file_id: receiptFileId,
        created_by: userId,
        approval_status: 'pending',
      });

      // Each line is recorded and then delivered into stock. From where the
      // person is standing these are one action, so a line that fails to stock
      // says so rather than disappearing quietly.
      let stockFailures = 0;
      for (const l of filledLines) {
        const ing = ingredients.find((i) => i.$id === l.ingredientId);
        if (!ing) continue;
        const qty = Number(l.qtyText);
        const unitCost = parseMoney(l.costText, decimals) ?? ing.base_unit_cost;
        try {
          await db.createDocument(DB_ID, 'expense_items', ID.unique(), {
            expense_id: expense.$id,
            ingredient_id: ing.$id,
            name_snapshot: ing.name,
            qty,
            unit_cost: unitCost,
            line_total: Math.round(qty * unitCost),
            stocked: true,
          });
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
        } catch {
          stockFailures += 1;
        }
      }

      onDone(
        stockFailures > 0
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
      title="Record spend"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy}>Save</Button>
        </>
      }
    >
      <FormError message={error} />
      <p className="small dim" style={{ marginTop: 0 }}>
        Cash paid out of the drawer now, so the drawer still balances at the end of the night.
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
          {lines.map((l, i) => (
            <div className="row" key={i} style={{ gap: '0.35rem', alignItems: 'flex-start' }}>
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
                placeholder="Qty"
                style={{ flex: 1 }}
                onChange={(e) => setLine(i, { qtyText: e.target.value })}
              />
              <Input
                value={l.costText}
                inputMode="decimal"
                placeholder={`Cost / ${ingredients.find((x) => x.$id === l.ingredientId)?.unit ?? 'unit'}`}
                style={{ flex: 1 }}
                onChange={(e) => setLine(i, { costText: e.target.value })}
              />
              {lines.length > 1 && (
                <Button size="sm" variant="ghost" onClick={() => setLines((r) => r.filter((_, x) => x !== i))}>
                  ×
                </Button>
              )}
            </div>
          ))}
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
          hint="Added up from the items above. Anything else goes in the box beside it."
        >
          <div className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
            {/* Blank while it is nothing. "0.00" in a box reads as a figure
                somebody entered, and this one is worked out; showing zero
                where nothing has been added yet says the form did the sum
                and got nought, which is not what happened. */}
            <Input value={linesTotal > 0 ? toInput(linesTotal, decimals) : ''} disabled style={{ flex: 2 }} />
            <span aria-hidden style={{ fontWeight: 650 }}>+</span>
            {/*
              The bit that never fits on a line.

              A shop run comes back with a total that is a few cedis above the
              things in the bag: a taxi both ways, a tip to the boy who
              carried it, a small item nobody wants to itemise. Without
              somewhere to put it, the choice was to invent a stock line that
              did not exist or to leave the drawer short by three cedis every
              time. Both of those are worse than a small box.

              Deliberately narrow and deliberately blank. It is for the
              remainder, not for the shopping, and a box that starts at 0.00
              invites somebody to type the whole total into it.
            */}
            <Input
              value={extraText}
              inputMode="decimal"
              placeholder="Extra"
              aria-label="Anything else, added to the total"
              style={{ flex: 1 }}
              onChange={(e) => setExtraText(e.target.value)}
            />
          </div>
          {extra > 0 && (
            <span className="small" style={{ fontWeight: 600 }}>
              Total {formatMoney(linesTotal + extra, settings)}
            </span>
          )}
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
      {methods.length === 1 ? (
        <Field label="Paid from" hint="Set by an admin under Settings.">
          <Input value={methods[0].name} disabled />
        </Field>
      ) : (
        <Field label="Paid from">
          <Select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
            {methods.map((m) => <option key={m.$id} value={m.$id}>{m.name}</option>)}
          </Select>
        </Field>
      )}
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
      <Field label="Receipt" hint="Optional. Take a photo of it now if there is one.">
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