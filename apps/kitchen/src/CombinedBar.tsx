import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Button, Field, FormError, Input, Modal, Notice, Select, ShiftCloseForm,
  ShiftHistory, ExpenseModal, HandoverModal,
} from '@snpos/ui';
import type { BlockerRow, CountRow, StockRow, ShiftFlow } from '@snpos/ui';
import { resolveCounts } from '@snpos/ui';
import {
  db, DB_ID, formatMoney, parseMoney, toInput, stockCheckRows,
  loadPaymentMethods, openShift, loadOpenShift, loadOpenShifts, shiftBlockers, expectedTakings, closeShift, openingFloats,
  recordPayment, amountOutstanding, asksForTip, shiftAgeOf, shiftAgeMessage, SHIFT_MAX_HOURS, shouldWarnLateOrder,
  HANDOVER_ENABLED,
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
  /** Other shifts open on this side. Should be none; occasionally is not. */
  const [alsoOpen, setAlsoOpen] = useState<Shift[]>([]);
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
  /** Orders this shift ran past its limit to take. Named before it closes. */
  const [shelving, setShelving] = useState<{ id: string; label: string }[]>([]);
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
    //
    // All of them, not just the one being worked on. A venue is meant to have
    // one open per side and can end up with more; only ever fetching the first
    // meant the others were invisible, and closing the one on screen simply
    // put the next one there. Every close worked and none of them looked like
    // it had.
    const open = await loadOpenShifts(venue.$id, 'kitchen');
    setShift(open[0] ?? null);
    setAlsoOpen(open.slice(1));
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
      const [m, blocking, everything] = await Promise.all([
        loadPaymentMethods(venue.$id),
        shiftBlockers(venue.$id, undefined, 'kitchen', shift),
        // Shown, not merely done. These leave the shift at the close and
        // somebody is still owed for them; a close that quietly moved them
        // would be a close nobody could explain the next morning.
        shiftBlockers(venue.$id, undefined, 'kitchen', null),
      ]);
      setMethods(m);
      const held = new Set(blocking.map((b) => b.order.$id));
      setShelving(
        everything
          .filter((b) => !held.has(b.order.$id))
          .map((b) => ({ id: b.order.$id, label: `${b.order.order_no} · ${money(b.order.total)}` })),
      );
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
        // What actually left the drawers. Spending somebody covered from their
        // own money is real spending and is shown, but a drawer cannot be
        // short of money it never held.
        out: takings.expensesTotal - takings.ownMoneyTotal,
        ownMoney: takings.ownMoneyTotal,
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
      // Closed is closed, said before asking again. A read that fails after a
      // successful close would otherwise leave the shift, and its overdue
      // warning, sitting on the bar.
      setShift(null);
      await reload();
      setClosing(false);
      if (result.ledgerError) onToast(`Shift closed, but the accounts entry failed: ${result.ledgerError}`, 'err');
      const total = Object.values(result.variance).reduce((a, b) => a + Math.abs(b), 0);
      const base = total === 0 ? 'Shift closed and balanced' : `Shift closed, ${money(total)} out`;
      onToast(result.stockNote ? `${base}. ${result.stockNote}` : base, total > tolerance ? 'err' : 'ok');
      // Said out loud, because those orders are still owed for and the person
      // who opens the next shift needs to be expecting them.
      if (result.shelved.length > 0) {
        onToast(
          `${result.shelved.length} order${result.shelved.length === 1 ? '' : 's'} moved to the next shift. `
          + 'They will be on the pass as soon as one is opened.',
        );
      }
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
            {/* Switched off for now. See HANDOVER_ENABLED. It was available
                whenever a shift was open rather than only at the close,
                because people finish at different times and hand over as they
                leave. */}
            {HANDOVER_ENABLED && (
              <Button size="sm" onClick={() => { setHandingOver(true); setError(null); }}>Hand over cash</Button>
            )}
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
            {shiftAgeMessage(age, SHIFT_MAX_HOURS, 'kitchen')}
            {age.over && !who?.can_close_shift && ' Ask a manager to close it.'}
          </Notice>
        </div>
      )}

      {/* Said out loud, because it is otherwise invisible and looks like a
          close that did not work. Each one is closed on its own; the bar shows
          the newest, and closing it brings the next up. */}
      {alsoOpen.length > 0 && (
        <div style={{ padding: '0.5rem 0.9rem' }}>
          <Notice tone="warn">
            <strong>
              {alsoOpen.length === 1
                ? 'Another shift is also open on this side.'
                : `${alsoOpen.length} other shifts are also open on this side.`}
            </strong>
            <div className="small" style={{ marginTop: '0.3rem' }}>
              There should only ever be one. Close this one and the next will appear here, until none are left.
              Nothing is lost by doing that: each keeps whatever was taken against it.
            </div>
            <div className="small dim" style={{ marginTop: '0.3rem' }}>
              Waiting: {alsoOpen.map((s) => s.code).join(', ')}
            </div>
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
            shelving={shelving}
          />
        </Modal>
      )}

      {handingOver && HANDOVER_ENABLED && (
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
          /* A cook pays out of the cash in front of them and out of nothing
             else, so the question has one answer. See askPaidFrom. */
          askPaidFrom={false}
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
  /**
   * Told what happened, not merely that something did.
   *
   * `settled` is the whole point of this signature. Without it the caller has
   * to guess from a message, and the caller that guessed took the ticket off
   * the pass on a part payment: a customer who had paid half their bill and
   * was still waiting for their food vanished off the kitchen screen.
   */
  onDone: (message: string, outcome?: { tone?: 'ok' | 'err'; settled?: boolean }) => void;
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

  /**
   * Nothing left to pay.
   *
   * A bill fully discounted, or one already settled, comes to nought — and the
   * form asked for an amount anyway and refused every answer, because nought
   * is not a payment. So a staff meal or a comped order could be cooked and
   * could never leave the pass: the only button on the ticket demanded a
   * figure that does not exist.
   *
   * Recording a payment of nothing is not the answer either; it would sit in
   * the takings as a transaction that never happened and be counted at close.
   * The food goes out and the bill is marked settled, which is what actually
   * occurred.
   */
  const nothingOwed = owed <= 0;

  const collectFree = async () => {
    setBusy(true);
    setError(null);
    try {
      await db.updateDocument(DB_ID, 'orders', order.$id, {
        status: 'SERVED',
        served_at: new Date().toISOString(),
        payment_status: 'paid',
        marked_paid_by: who?.user_id || who?.$id || '',
        marked_paid_at: new Date().toISOString(),
      });
      onDone(`${order.order_no} collected, nothing to pay`, { settled: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not mark that collected.');
      setBusy(false);
    }
  };

  const settle = async () => {
    if (nothingOwed) return collectFree();
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
        onDone(
          `${formatMoney(paying, settings)} taken · ${formatMoney(remaining, settings)} still to pay`,
          { tone: 'ok', settled: false },
        );
        return;
      }
      onDone(`${order.order_no} collected and paid`, { settled: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record that payment.');
      setBusy(false);
    }
  };

  const late = shouldWarnLateOrder(order, shift);

  return (
    <Modal
      title={`Collect and settle ${order.order_no}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={settle} loading={busy}>
            {nothingOwed
              ? 'Collect it'
              : leftAfter > 0 && payText.trim() !== ''
                ? 'Take part payment'
                : 'Mark collected and paid'}
          </Button>
        </>
      }
    >
      <FormError message={error} />

      {/* A warning, never a refusal. Money can always be taken; see
          shouldWarnLateOrder for why that is the right way round. */}
      {late && (
        <Notice tone="warn">
          This came in after the shift had already run past a day. Taking the money here records it against
          the shift that is open now, which is the right place for it. If you would rather it went on a fresh
          shift, close this one first and it will be waiting there.
        </Notice>
      )}
      <p style={{ marginTop: 0, fontSize: '1.3rem', fontWeight: 650 }}>
        {nothingOwed ? 'Nothing to pay' : formatMoney(owed, settings)}
      </p>
      <p className="small dim" style={{ marginTop: '-0.5rem' }}>
        {nothingOwed
          ? 'This bill comes to nothing — discounted in full, or already settled. Hand the food over; there is no money to record.'
          : owed < order.total
            ? `Still to pay, of ${formatMoney(order.total, settings)}. The guest pays you as usual; this records which way.`
            : 'The guest pays you as usual. This records which way they paid.'}
      </p>
      {/* Nothing about how they paid is asked when there is nothing to pay.
          Every one of these boxes would be a question with no answer, and a
          form full of those is a form people learn to guess at. */}
      <Field label="How they paid" hidden={nothingOwed}>
        <Select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
          {methods.map((m) => <option key={m.$id} value={m.$id}>{m.name}</option>)}
        </Select>
      </Field>
      {/* Blank means the whole balance. Filled in, it takes part of it and the
          bill stays open for whoever is paying the rest, a table splitting
          the bill should not need one person to front the lot. */}
      <Field
        label={`Amount paid now (${settings.currency_symbol ?? ''})`}
        hidden={nothingOwed}
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
      {!nothingOwed && method?.requires_reference && (
        <Field
          label="Reference"
          hint="The number from the card machine or the mobile money message. Without it this payment cannot be matched to your statement."
        >
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      )}
      {!nothingOwed && asksForTip(settings, 'kitchen') && (
        <Field label={`Tip (${settings.currency_symbol ?? ''})`} hint="Optional. Kept separate from sales; it is not yours.">
          <Input value={tipText} inputMode="decimal" onChange={(e) => setTipText(e.target.value)} />
        </Field>
      )}
    </Modal>
  );
}


