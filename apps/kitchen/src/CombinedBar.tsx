import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Button, Field, FormError, Input, Modal, Notice, Select, ShiftCloseForm,
  ShiftHistory, ExpenseModal, HandoverModal,
} from '@snpos/ui';
import type { BlockerRow, CountRow, StockRow, ShiftFlow } from '@snpos/ui';
import { resolveCounts } from '@snpos/ui';
import {
  formatMoney, parseMoney, toInput, stockCheckRows,
  loadPaymentMethods, openShift, loadOpenShift, shiftBlockers, expectedTakings, closeShift, openingFloats,
  recordPayment, amountOutstanding, asksForTip, shiftAgeOf, shiftAgeMessage, SHIFT_MAX_HOURS,
} from '@snpos/core';
import type {
  PaymentMethod, Shift, Settings, Venue, StaffProfile, FeatureMap, Order,
} from '@snpos/core';

/**
 * The till, on the kitchen screen.
 *
 * Combined mode exists for the shift where there is nobody on the floor: the
 * cook takes the order, cooks it, hands it over and settles the bill. Making
 * them walk to another device to open a shift or record the gas money would
 * defeat the point, so the whole till lives here too, driven by the same code
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
  const [handingOver, setHandingOver] = useState(false);
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
  const [flow, setFlow] = useState<ShiftFlow | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decimals = settings.currency_decimals ?? 2;

  // How long this shift has been open. A day is the limit; past it nothing
  // more may be sold or settled against it.
  const age = shiftAgeOf(shift);

  // Which question the restaurant has chosen to ask, and what the answers come
  // to. Worked out here rather than in the form so the close button and the
  // boxes on screen can never be judging different things.
  const counting = settings.stock_check_mode === 'counts';
  const stockDecimals = settings.stock_count_decimals !== false;
  const resolved = resolveCounts(stockList, stockCounts, stockDecimals);
  const tolerance = settings.cash_variance_tolerance ?? 500;
  const money = (n: number) => formatMoney(n, settings);

  const reload = useCallback(async () => {
    // This screen is the kitchen, so it opens and closes the kitchen's shift.
    // The craft counter has its own, on the till.
    setShift(await loadOpenShift(venue.$id, 'kitchen'));
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
        module: 'kitchen',
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
      const [m, blocking] = await Promise.all([
        loadPaymentMethods(venue.$id),
        shiftBlockers(venue.$id, undefined, 'kitchen'),
      ]);
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
      // What came in and what went out, before the per-drawer arithmetic.
      setFlow({
        opening: Object.values(takings.openingFloats).reduce((a, b) => a + b, 0),
        sales: takings.salesTotal,
        tips: takings.tipsTotal,
        out: takings.expensesTotal,
      });
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
    // not a variance, it is a missing expense, so say that rather than
    // recording an impossible figure.
    if (!settings.allow_negative_cash) {
      const short = rows.find((r) => (parseMoney(r.countedText, decimals) ?? 0) < 0);
      if (short) {
        setError(
          `${short.name} cannot finish below nothing. That almost always means money was paid out and not ` +
          'recorded. Add the expense first, then close.',
        );
        return;
      }
    }
    if (counting && resolved.missing.length > 0) {
      const names = resolved.missing.slice(0, 3).map((i) => i.name).join(', ');
      setError(
        `Still to count: ${names}${resolved.missing.length > 3 ? ` and ${resolved.missing.length - 3} more` : ''}. ` +
        'Type 0 for anything that has run out. A blank row would be saved as if it were fine.',
      );
      return;
    }
    const off = rows.some((r) => (parseMoney(r.countedText, decimals) ?? 0) !== r.expected);
    if (off && !note.trim()) {
      setError('Something is over or short. Say what happened before closing; that answer is gone by tomorrow.');
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
      const base = total === 0 ? 'Shift closed and balanced' : `Shift closed, ${money(total)} out`;
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
            <Badge tone={age.over ? 'danger' : age.warning ? 'warn' : 'ok'}>
              {age.over ? 'Shift overdue' : 'Shift open'}
            </Badge>
            <span className="dim small">{shift.code}</span>
          </>
        ) : (
          <span className="small" style={{ color: 'var(--warn)' }}>
            No shift open; nothing can be marked paid until one is.
          </span>
        )}
        <span style={{ flex: 1 }} />
        {shift && (
          <>
            <Button size="sm" onClick={() => setHistory(true)}>This shift</Button>
            <Button size="sm" onClick={() => { setSpending(true); setError(null); }}>Record spend</Button>
            {/* Available whenever a shift is open, not only at the close.
                People finish at different times and hand over as they leave;
                a button that only appears at the end is a button that misses
                everybody but the last person out. */}
            <Button size="sm" onClick={() => { setHandingOver(true); setError(null); }}>Hand over cash</Button>
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

      {/* A shift left running past a day makes every figure that depends on it
          meaningless: two days of takings in one drawer, measured against a
          float from yesterday morning. So it is said plainly, and at the limit
          the till stops taking money against it rather than quietly carrying
          on. Nothing is closed automatically, because closing invents a cash
          count that nobody made. */}
      {shift && (age.over || age.warning) && (
        <div style={{ padding: '0.5rem 0.9rem' }}>
          <Notice tone={age.over ? 'warn' : 'info'}>
            {shiftAgeMessage(age, SHIFT_MAX_HOURS)}
            {age.over && !who?.can_close_shift && ' Ask a manager to close it.'}
          </Notice>
        </div>
      )}

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
            flow={flow}
          />
        </Modal>
      )}

      {handingOver && (
        <HandoverModal
          venueId={venue.$id}
          shiftId={shift?.$id}
          settings={settings}
          who={who}
          onClose={() => setHandingOver(false)}
          onDone={(m) => { setHandingOver(false); onToast(m); }}
        />
      )}

      {spending && shift && (
        <ExpenseModal
          module={shift.module ?? 'kitchen'}
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
  // A blank box means "all of it", the overwhelmingly common case, and it
  // should not need typing.
  const paying = payText.trim() === '' ? owed : parseMoney(payText, decimals) ?? 0;
  const leftAfter = Math.max(0, owed - paying);

  useEffect(() => {
    (async () => {
      const [m, s, out] = await Promise.all([
        loadPaymentMethods(venueId),
        // Named rather than defaulted. An implicit side is exactly what broke
        // the craft shift, and this screen is the kitchen.
        loadOpenShift(venueId, 'kitchen'),
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
    // Past a day the shift is no longer a night anybody can reconcile, so it
    // stops taking money rather than filing today's cash under yesterday.
    if (shiftAgeOf(shift).over) {
      setError(shiftAgeMessage(shiftAgeOf(shift), SHIFT_MAX_HOURS));
      return;
    }
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
        // needed, the till still does it where a drawer is actually open.
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
          bill stays open for whoever is paying the rest, a table splitting
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
        <Field label={`Tip (${settings.currency_symbol ?? ''})`} hint="Optional. Kept separate from sales; it is not yours.">
          <Input value={tipText} inputMode="decimal" onChange={(e) => setTipText(e.target.value)} />
        </Field>
      )}
    </Modal>
  );
}


