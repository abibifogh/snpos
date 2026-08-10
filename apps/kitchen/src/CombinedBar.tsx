import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Field, FormError, Input, Modal, Notice, Select, Textarea, ShiftCloseForm } from '@snpos/ui';
import type { BlockerRow, CountRow, StockRow } from '@snpos/ui';
import { resolveCounts } from '@snpos/ui';
import { ShiftHistory } from './ShiftHistory';
import {
  db, DB_ID, ID, formatMoney, parseMoney, toInput, loadIngredients, stockCheckRows,
  loadPaymentMethods, openShift, loadOpenShift, shiftBlockers, expectedTakings, closeShift, openingFloats,
  recordPayment, amountOutstanding, PAID_TO_KINDS, payeeLabel, legacyExpenseCategory, loadPaidToOptions,
  receiveStock, uploadFile, asksForTip, expenseMethods,
} from '@snpos/core';
import type {
  PaymentMethod, Shift, Settings, Venue, StaffProfile, FeatureMap, Order,
  PaidToKind, Supplier, ExpenseCategoryDoc, Ingredient,
} from '@snpos/core';

/**
 * The till, on the kitchen screen.
 *
 * Combined mode exists for the shift where there is nobody on the floor: the
 * cook takes the order, cooks it, hands it over and settles the bill. Making
 * them walk to another device to open a shift or record the gas money would
 * defeat the point — so the whole till lives here too, driven by the same code
 * the terminal uses rather than a second version of it that drifts.
 */
export function CombinedBar({
  venue,
  settings,
  features,
  who,
  onToast,
}: {
  venue: Venue;
  settings: Settings;
  features: FeatureMap;
  who: StaffProfile | null;
  onToast: (m: string, tone?: 'ok' | 'err') => void;
}) {
  const [shift, setShift] = useState<Shift | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);
  const [spending, setSpending] = useState(false);
  const [history, setHistory] = useState(false);
  const [floats, setFloats] = useState<Record<string, string>>({});
  const [floatSource, setFloatSource] = useState('zero');
  const [floatNote, setFloatNote] = useState('');
  const [rows, setRows] = useState<CountRow[]>([]);
  const [blockers, setBlockers] = useState<BlockerRow[]>([]);
  const [note, setNote] = useState('');
  const [levels, setLevels] = useState<Record<string, 'OK' | 'LOW' | 'OUT'>>({});
  const [stockList, setStockList] = useState<StockRow[]>([]);
  // Typed amounts, kept as text so a half-finished "0." is not read as zero.
  const [stockCounts, setStockCounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decimals = settings.currency_decimals ?? 2;

  // Which question the restaurant has chosen to ask, and what the answers come
  // to. Worked out here rather than in the form so the close button and the
  // boxes on screen can never be judging different things.
  const counting = settings.stock_check_mode === 'counts';
  const stockDecimals = settings.stock_count_decimals !== false;
  const resolved = resolveCounts(stockList, stockCounts, stockDecimals);
  const tolerance = settings.cash_variance_tolerance ?? 500;
  const money = (n: number) => formatMoney(n, settings);

  const reload = useCallback(async () => {
    setShift(await loadOpenShift(venue.$id));
  }, [venue.$id]);

  useEffect(() => { void reload(); }, [reload]);

  const startOpen = async () => {
    const m = await loadPaymentMethods(venue.$id);
    setMethods(m);
    // Filled in from the restaurant's float policy rather than always starting
    // at zero, which turns yesterday's float into today's takings.
    const opening = await openingFloats(venue.$id, settings, m);
    setFloatSource(opening.source);
    setFloatNote(opening.note);
    setFloats(
      Object.fromEntries(
        m.map((x) => [x.$id, opening.source === 'prompt' ? '' : toInput(opening.floats[x.$id] ?? 0, decimals)]),
      ),
    );
    setOpening(true);
    setError(null);
  };

  const doOpen = async () => {
    setBusy(true);
    setError(null);
    try {
      await openShift({
        venueId: venue.$id,
        userId: who?.user_id || who?.$id || '',
        floats: Object.fromEntries(Object.entries(floats).map(([k, v]) => [k, parseMoney(v, decimals) ?? 0])),
        floatSource,
      });
      await reload();
      setOpening(false);
      onToast('Shift opened');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the shift.');
    } finally {
      setBusy(false);
    }
  };

  const startClose = async () => {
    if (!shift) return;
    setBusy(true);
    setError(null);
    try {
      const [m, blocking] = await Promise.all([loadPaymentMethods(venue.$id), shiftBlockers(venue.$id)]);
      setMethods(m);
      setBlockers(
        blocking.map((b) => ({
          id: b.order.$id,
          label: `${b.order.order_no} · ${money(b.order.total)}`,
          reason: b.reason,
        })),
      );
      const takings = await expectedTakings(shift, m);
      setRows(
        m
          .filter((x) => x.counted_at_close)
          .map((x) => ({ methodId: x.$id, name: x.name, expected: takings.byMethod[x.$id] ?? 0, countedText: '' })),
      );
      const list = await stockCheckRows(venue.$id);
      setStockList(list);
      setLevels(Object.fromEntries(list.map((i) => [i.$id, 'OK' as const])));
      setStockCounts({});
      setNote('');
      setClosing(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not prepare the close.');
    } finally {
      setBusy(false);
    }
  };

  const doClose = async () => {
    if (!shift || blockers.length > 0) return;
    if (rows.some((r) => parseMoney(r.countedText, decimals) === null)) {
      setError('Enter what you counted for every drawer.');
      return;
    }
    // A drawer cannot hold less than nothing. When one counts negative it is
    // not a variance, it is a missing expense — so say that rather than
    // recording an impossible figure.
    if (!settings.allow_negative_cash) {
      const short = rows.find((r) => (parseMoney(r.countedText, decimals) ?? 0) < 0);
      if (short) {
        setError(
          `${short.name} cannot finish below nothing. That almost always means money was paid out and not ` +
          'recorded — add the expense first, then close.',
        );
        return;
      }
    }
    if (counting && resolved.missing.length > 0) {
      const names = resolved.missing.slice(0, 3).map((i) => i.name).join(', ');
      setError(
        `Still to count: ${names}${resolved.missing.length > 3 ? ` and ${resolved.missing.length - 3} more` : ''}. ` +
        'Type 0 for anything that has run out — a blank row would be saved as if it were fine.',
      );
      return;
    }
    const off = rows.some((r) => (parseMoney(r.countedText, decimals) ?? 0) !== r.expected);
    if (off && !note.trim()) {
      setError('Something is over or short. Say what happened before closing — that answer is gone by tomorrow.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await closeShift({
        venueId: venue.$id,
        shift,
        userId: who?.user_id || who?.$id || '',
        settings,
        features,
        methods,
        counted: Object.fromEntries(rows.map((r) => [r.methodId, parseMoney(r.countedText, decimals) ?? 0])),
        varianceNote: note.trim(),
        levels: counting ? resolved.levels : levels,
        stockCounts: counting ? resolved.counts : undefined,
      });
      await reload();
      setClosing(false);
      if (result.ledgerError) onToast(`Shift closed, but the accounts entry failed: ${result.ledgerError}`, 'err');
      const total = Object.values(result.variance).reduce((a, b) => a + Math.abs(b), 0);
      const base = total === 0 ? 'Shift closed and balanced' : `Shift closed — ${money(total)} out`;
      onToast(result.stockNote ? `${base}. ${result.stockNote}` : base, total > tolerance ? 'err' : 'ok');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not close the shift.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="kds-till">
        {shift ? (
          <>
            <Badge tone="ok">Shift open</Badge>
            <span className="dim small">{shift.code}</span>
          </>
        ) : (
          <span className="small" style={{ color: 'var(--warn)' }}>
            No shift open — nothing can be marked paid until one is.
          </span>
        )}
        <span style={{ flex: 1 }} />
        {shift && (
          <>
            <Button size="sm" onClick={() => setHistory(true)}>This shift</Button>
            <Button size="sm" onClick={() => { setSpending(true); setError(null); }}>Record spend</Button>
          </>
        )}
        {shift ? (
          <Button size="sm" onClick={startClose} loading={busy && !closing} disabled={!who?.can_close_shift}>
            Close shift
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={startOpen} disabled={!who?.can_open_shift}>
            Open shift
          </Button>
        )}
      </div>

      {history && shift && (
        <ShiftHistory
          shift={shift}
          venue={venue}
          settings={settings}
          who={who}
          onClose={() => setHistory(false)}
          onToast={onToast}
        />
      )}

      {opening && (
        <Modal
          title="Open shift"
          onClose={() => setOpening(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpening(false)}>Cancel</Button>
              <Button variant="primary" onClick={doOpen} loading={busy}>Open shift</Button>
            </>
          }
        >
          <p className="small dim" style={{ marginTop: 0 }}>
            Count what is in the drawer now. A guess here becomes a false discrepancy at the end of the night.
          </p>
          {floatNote && <p className="small dim">{floatNote}</p>}
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
          {methods.map((m) => (
            <Field key={m.$id} label={`${m.name} float (${settings.currency_symbol})`}>
              <Input
                value={floats[m.$id] ?? ''}
                inputMode="decimal"
                onChange={(e) => setFloats({ ...floats, [m.$id]: e.target.value })}
              />
            </Field>
          ))}
        </Modal>
      )}

      {closing && (
        <Modal
          title="Close shift"
          wide
          onClose={() => setClosing(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setClosing(false)}>Cancel</Button>
              <Button variant="primary" onClick={doClose} loading={busy} disabled={blockers.length > 0}>
                {blockers.length > 0 ? 'Settle those orders first' : 'Close shift'}
              </Button>
            </>
          }
        >
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
          <ShiftCloseForm
            blockers={blockers}
            rows={rows}
            onCount={(id, text) => setRows((r) => r.map((x) => (x.methodId === id ? { ...x, countedText: text } : x)))}
            stock={stockList}
            levels={levels}
            onLevel={(id, level) => setLevels((l) => ({ ...l, [id]: level }))}
            stockMode={counting ? 'counts' : 'levels'}
            stockCounts={stockCounts}
            onStockCount={(id, text) => setStockCounts((c) => ({ ...c, [id]: text }))}
            stockDecimals={stockDecimals}
            note={note}
            onNote={setNote}
            symbol={settings.currency_symbol ?? ''}
            money={money}
            tolerance={tolerance}
          />
        </Modal>
      )}

      {spending && shift && (
        <ExpenseModal
          venueId={venue.$id}
          shiftId={shift.$id}
          settings={settings}
          userId={who?.user_id || who?.$id || ''}
          onClose={() => setSpending(false)}
          onDone={(m) => { setSpending(false); onToast(m); }}
        />
      )}
    </>
  );
}

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
function ExpenseModal({
  venueId, shiftId, settings, userId, onClose, onDone,
}: {
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

  useEffect(() => {
    (async () => {
      const [opts, m, ing] = await Promise.all([
        loadPaidToOptions(),
        loadPaymentMethods(venueId),
        loadIngredients(venueId).catch(() => [] as Ingredient[]),
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
  }, [venueId, settings.expense_paid_from]);

  const filledLines = lines.filter((l) => l.ingredientId && Number(l.qtyText) > 0);

  /**
   * Lines add up to the total, so nobody types it twice.
   *
   * Kept editable when there are no lines at all — plenty of spending (a taxi,
   * a gas refill) has nothing to put into stock.
   */
  const linesTotal = filledLines.reduce(
    (sum, l) => sum + Math.round(Number(l.qtyText) * (parseMoney(l.costText, decimals) ?? 0)),
    0,
  );

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
      costText: ing && !lines[index].costText ? toInput(ing.base_unit_cost, decimals) : lines[index].costText,
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
    // total that disagrees with them is a total somebody mistyped.
    const amount = filledLines.length > 0 ? linesTotal : parseMoney(amountText, decimals);
    if (amount === null || amount <= 0) { setError('Enter the amount spent.'); return; }
    if (!methodId) { setError('Choose how it was paid.'); return; }
    if (paidToKind === 'supplier' && !supplierId) { setError('Choose which supplier was paid.'); return; }
    if (paidToKind === 'staff' && !staffId) { setError('Choose which member of staff took the money.'); return; }
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
      // recorded — a missing photo is a nuisance, a missing expense is a hole
      // in the drawer nobody can explain.
      let receiptFileId = '';
      if (receipt) {
        receiptFileId = (await uploadFile(receipt.file, 'receipt', settings).catch(() => null))?.fileId ?? '';
      }

      const expense = await db.createDocument(DB_ID, 'shift_expenses', ID.unique(), {
        venue_id: venueId,
        shift_id: shiftId,
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
        note: noteText.trim(),
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
          and listing them here is what puts them into stock — otherwise
          somebody has to enter the same delivery twice. */}
      <Field
        label="What was bought"
        hint="Leave empty for spending with nothing to stock — transport, gas, repairs."
      >
        <div className="stack" style={{ gap: '0.45rem' }}>
          {lines.map((l, i) => (
            <div className="row" key={i} style={{ gap: '0.35rem', alignItems: 'flex-start' }}>
              <Select
                value={l.ingredientId}
                onChange={(e) => pickIngredient(i, e.target.value)}
                style={{ flex: 2 }}
              >
                <option value="">— item —</option>
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
      </Field>

      {/* Not asked once items are chosen. Each ingredient already carries the
          category it belongs to, set when an admin added it, so asking again
          is asking the same question twice and inviting two answers.
          Still asked for spending with nothing to stock — a taxi, gas, a
          repair — because there is nothing to take the answer from. */}
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
        <Field label={`Amount (${settings.currency_symbol ?? ''})`} hint="Added up from the items above.">
          <Input value={toInput(linesTotal, decimals)} disabled />
        </Field>
      ) : (
        <Field label={`Amount (${settings.currency_symbol ?? ''})`}>
          <Input value={amountText} inputMode="decimal" autoFocus onChange={(e) => setAmountText(e.target.value)} />
        </Field>
      )}
      {/* One option is not a choice. When the restaurant pays for shop runs out
          of the drawer and nothing else — the default — a dropdown with a
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
            <option value="">— choose —</option>
            {suppliers.map((s) => <option key={s.$id} value={s.$id}>{s.name}</option>)}
          </Select>
        </Field>
      )}
      {paidToKind === 'staff' && (
        <Field label="Which member of staff" hint="For money handed to someone to go and buy, or a staff advance.">
          <Select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">— choose —</option>
            {staff.map((s) => <option key={s.$id} value={s.$id}>{s.display_name}</option>)}
          </Select>
        </Field>
      )}
      {(paidToKind === 'open_market' || paidToKind === 'other') && (
        <Field
          label="Name"
          hint={paidToKind === 'open_market'
            ? 'The market or stall, if it is worth recording. Leave blank for just "Open market".'
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
 * Settle a bill from the pass.
 *
 * Records that payment happened; it never takes payment. The guest has already
 * paid in cash, by card machine or by mobile money, and this is a cook saying
 * which of those it was.
 */
export function SettleModal({
  order, venueId, settings, who, onClose, onDone,
}: {
  order: Order;
  venueId: string;
  settings: Settings;
  who: StaffProfile | null;
  onClose: () => void;
  onDone: (message: string, tone?: 'ok' | 'err') => void;
}) {
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [methodId, setMethodId] = useState('');
  const [shift, setShift] = useState<Shift | null>(null);
  const [tipText, setTipText] = useState('');
  const [payText, setPayText] = useState('');
  const [reference, setReference] = useState('');
  const [owed, setOwed] = useState(order.total);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decimals = settings.currency_decimals ?? 2;
  const method = methods.find((m) => m.$id === methodId);
  // A blank box means "all of it" — the overwhelmingly common case, and it
  // should not need typing.
  const paying = payText.trim() === '' ? owed : parseMoney(payText, decimals) ?? 0;
  const leftAfter = Math.max(0, owed - paying);

  useEffect(() => {
    (async () => {
      const [m, s, out] = await Promise.all([
        loadPaymentMethods(venueId),
        loadOpenShift(venueId),
        amountOutstanding(order),
      ]);
      setMethods(m);
      setMethodId(m[0]?.$id ?? '');
      setShift(s);
      setOwed(out);
    })().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId, order.$id]);

  const settle = async () => {
    if (!methodId) { setError('Choose how they paid.'); return; }
    if (!shift) { setError('No shift is open. Open one first, or the money has nothing to be counted against.'); return; }
    if (paying <= 0) { setError('Enter how much they are paying.'); return; }
    if (paying > owed) {
      setError(`That is more than the ${formatMoney(owed, settings)} outstanding. Put the extra in the tip box if it is a tip.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const remaining = await recordPayment({
        venueId,
        order,
        shiftId: shift.$id,
        methodId,
        methodKind: method?.kind ?? 'other',
        amount: paying,
        tip: parseMoney(tipText, decimals) ?? 0,
        // Nothing is handed over on this screen: a cook marking an order
        // collected is recording that it went out, not running a drawer. The
        // box asking what the customer gave was one more thing to type while
        // holding a plate, and the change it worked out was a sum nobody
        // needed — the till still does it where a drawer is actually open.
        changeGiven: 0,
        reference: reference.trim(),
        takenBy: who?.user_id || who?.$id || '',
        // The pass has handed the food over; it has not closed the table.
        orderStatus: 'SERVED',
      });
      if (remaining > 0) {
        // Still owed, so the modal stays open ready for the next person to pay.
        setOwed(remaining);
        setPayText('');
        setTipText('');
        setReference('');
        setBusy(false);
        onDone(`${formatMoney(paying, settings)} taken · ${formatMoney(remaining, settings)} still to pay`, 'ok');
        return;
      }
      onDone(`${order.order_no} collected and paid`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record that payment.');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Collect and settle ${order.order_no}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={settle} loading={busy}>
            {leftAfter > 0 && payText.trim() !== '' ? 'Take part payment' : 'Mark collected and paid'}
          </Button>
        </>
      }
    >
      <FormError message={error} />
      <p style={{ marginTop: 0, fontSize: '1.3rem', fontWeight: 650 }}>{formatMoney(owed, settings)}</p>
      <p className="small dim" style={{ marginTop: '-0.5rem' }}>
        {owed < order.total
          ? `Still to pay, of ${formatMoney(order.total, settings)}. The guest pays you as usual; this records which way.`
          : 'The guest pays you as usual. This records which way they paid.'}
      </p>
      <Field label="How they paid">
        <Select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
          {methods.map((m) => <option key={m.$id} value={m.$id}>{m.name}</option>)}
        </Select>
      </Field>
      {/* Blank means the whole balance. Filled in, it takes part of it and the
          bill stays open for whoever is paying the rest — a table splitting
          the bill should not need one person to front the lot. */}
      <Field
        label={`Amount paid now (${settings.currency_symbol ?? ''})`}
        hint="Leave blank if they are paying all of it."
      >
        <Input
          value={payText}
          inputMode="decimal"
          placeholder={toInput(owed, decimals)}
          onChange={(e) => setPayText(e.target.value)}
        />
      </Field>
      {leftAfter > 0 && payText.trim() !== '' && (
        <p className="small" style={{ margin: '-0.5rem 0 0.9rem', color: 'var(--warn)' }}>
          {formatMoney(leftAfter, settings)} will still be owed after this.
        </p>
      )}
      {method?.requires_reference && (
        <Field
          label="Reference"
          hint="The number from the card machine or the mobile money message. Without it this payment cannot be matched to your statement."
        >
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      )}
      {asksForTip(settings, 'kitchen') && (
        <Field label={`Tip (${settings.currency_symbol ?? ''})`} hint="Optional. Kept separate from sales — it is not yours.">
          <Input value={tipText} inputMode="decimal" onChange={(e) => setTipText(e.target.value)} />
        </Field>
      )}
    </Modal>
  );
}
