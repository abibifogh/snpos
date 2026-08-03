import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Field, FormError, Input, Modal, Notice, Select, Textarea, ShiftCloseForm } from '@snpos/ui';
import type { BlockerRow, CountRow, StockRow } from '@snpos/ui';
import {
  db, DB_ID, ID, formatMoney, parseMoney, toInput, loadIngredients,
  loadPaymentMethods, openShift, loadOpenShift, shiftBlockers, expectedTakings, closeShift,
  recordPayment, PAID_TO_KINDS, payeeLabel, legacyExpenseCategory, loadPaidToOptions,
} from '@snpos/core';
import type {
  PaymentMethod, Shift, Settings, Venue, StaffProfile, FeatureMap, Order,
  PaidToKind, Supplier, ExpenseCategoryDoc,
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
  const [floats, setFloats] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<CountRow[]>([]);
  const [blockers, setBlockers] = useState<BlockerRow[]>([]);
  const [note, setNote] = useState('');
  const [levels, setLevels] = useState<Record<string, 'OK' | 'LOW' | 'OUT'>>({});
  const [stockList, setStockList] = useState<StockRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decimals = settings.currency_decimals ?? 2;
  const tolerance = settings.cash_variance_tolerance ?? 500;
  const money = (n: number) => formatMoney(n, settings);

  const reload = useCallback(async () => {
    setShift(await loadOpenShift(venue.$id));
  }, [venue.$id]);

  useEffect(() => { void reload(); }, [reload]);

  const startOpen = async () => {
    const m = await loadPaymentMethods(venue.$id);
    setMethods(m);
    setFloats(Object.fromEntries(m.map((x) => [x.$id, toInput(0, decimals)])));
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
      const ing = await loadIngredients(venue.$id);
      const list = ing
        .filter((i) => i.active)
        .sort((a, b) => Number(b.critical) - Number(a.critical) || a.name.localeCompare(b.name))
        .map((i) => ({ $id: i.$id, name: i.name, critical: i.critical }));
      setStockList(list);
      setLevels(Object.fromEntries(list.map((i) => [i.$id, 'OK' as const])));
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
        levels,
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
          <Button size="sm" onClick={() => { setSpending(true); setError(null); }}>Record spend</Button>
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
  const [categoryKey, setCategoryKey] = useState('');
  const [methodId, setMethodId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [paidToKind, setPaidToKind] = useState<PaidToKind>('open_market');
  const [supplierId, setSupplierId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [payee, setPayee] = useState('');
  const [noteText, setNoteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decimals = settings.currency_decimals ?? 2;

  useEffect(() => {
    (async () => {
      const [opts, m] = await Promise.all([loadPaidToOptions(), loadPaymentMethods(venueId)]);
      setCategories(opts.categories);
      setSuppliers(opts.suppliers);
      setStaff(opts.staff);
      setCategoryKey(opts.categories[0]?.key ?? 'other');
      setMethods(m);
      setMethodId(m.find((x) => x.kind === 'cash')?.$id ?? m[0]?.$id ?? '');
    })().catch(() => undefined);
  }, [venueId]);

  const save = async () => {
    const amount = parseMoney(amountText, decimals);
    if (amount === null || amount <= 0) { setError('Enter the amount spent.'); return; }
    if (!methodId) { setError('Choose how it was paid.'); return; }
    if (paidToKind === 'supplier' && !supplierId) { setError('Choose which supplier was paid.'); return; }
    if (paidToKind === 'staff' && !staffId) { setError('Choose which member of staff took the money.'); return; }
    setBusy(true);
    setError(null);
    try {
      await db.createDocument(DB_ID, 'shift_expenses', ID.unique(), {
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
        created_by: userId,
        approval_status: 'pending',
      });
      onDone('Spend recorded');
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
        Cash paid out of the drawer now, so the drawer still balances at the end of the night. Attach the receipt later
        from the admin app if there is one.
      </p>
      <Field label="What for">
        <Select value={categoryKey} onChange={(e) => setCategoryKey(e.target.value)}>
          {categories.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
        </Select>
      </Field>
      <Field label={`Amount (${settings.currency_symbol ?? ''})`}>
        <Input value={amountText} inputMode="decimal" autoFocus onChange={(e) => setAmountText(e.target.value)} />
      </Field>
      <Field label="Paid from">
        <Select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
          {methods.map((m) => <option key={m.$id} value={m.$id}>{m.name}</option>)}
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
  const [cashText, setCashText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decimals = settings.currency_decimals ?? 2;
  const method = methods.find((m) => m.$id === methodId);
  // Cash means change, and change is a number somebody has to get right while
  // holding a plate. Working it out here is one fewer thing to do in the head.
  const tendered = parseMoney(cashText, decimals) ?? 0;
  const change = method?.kind === 'cash' ? Math.max(0, tendered - order.total) : 0;

  useEffect(() => {
    (async () => {
      const [m, s] = await Promise.all([loadPaymentMethods(venueId), loadOpenShift(venueId)]);
      setMethods(m);
      setMethodId(m[0]?.$id ?? '');
      setShift(s);
    })().catch(() => undefined);
  }, [venueId]);

  const settle = async () => {
    if (!methodId) { setError('Choose how they paid.'); return; }
    if (!shift) { setError('No shift is open. Open one first, or the money has nothing to be counted against.'); return; }
    setBusy(true);
    setError(null);
    try {
      await recordPayment({
        venueId,
        order,
        shiftId: shift.$id,
        methodId,
        methodKind: method?.kind ?? 'other',
        amount: order.total,
        tip: parseMoney(tipText, decimals) ?? 0,
        changeGiven: change,
        takenBy: who?.user_id || who?.$id || '',
        // The pass has handed the food over; it has not closed the table.
        orderStatus: 'SERVED',
      });
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
          <Button variant="primary" onClick={settle} loading={busy}>Mark collected and paid</Button>
        </>
      }
    >
      {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
      <p style={{ marginTop: 0, fontSize: '1.3rem', fontWeight: 650 }}>{formatMoney(order.total, settings)}</p>
      <p className="small dim" style={{ marginTop: '-0.5rem' }}>
        The guest pays you as usual. This records which way they paid.
      </p>
      <Field label="How they paid">
        <Select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
          {methods.map((m) => <option key={m.$id} value={m.$id}>{m.name}</option>)}
        </Select>
      </Field>
      {method?.kind === 'cash' && (
        <Field label={`Cash handed over (${settings.currency_symbol ?? ''})`} hint="Optional. Fill it in and the change is worked out for you.">
          <Input value={cashText} inputMode="decimal" onChange={(e) => setCashText(e.target.value)} />
        </Field>
      )}
      {change > 0 && (
        <p style={{ margin: '-0.4rem 0 1rem', fontSize: '1.05rem' }}>
          Change to give: <strong>{formatMoney(change, settings)}</strong>
        </p>
      )}
      {settings.tips_enabled !== false && (
        <Field label={`Tip (${settings.currency_symbol ?? ''})`} hint="Optional. Kept separate from sales — it is not yours.">
          <Input value={tipText} inputMode="decimal" onChange={(e) => setTipText(e.target.value)} />
        </Field>
      )}
    </Modal>
  );
}
