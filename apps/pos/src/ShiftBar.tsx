import { useState } from 'react';
import {
  Button, Modal, Field, Input, Notice, Badge, ShiftCloseForm, resolveCounts,
  ShiftHistory, ExpenseModal, HandoverModal,
} from '@snpos/ui';
import type { BlockerRow, CountRow, StockRow, ShiftFlow } from '@snpos/ui';
import {
  formatMoney, parseMoney, toInput, stockCheckRows,
  loadPaymentMethods, openShift as createShift, shiftBlockers, expectedTakings, closeShift,
  openingFloats, shiftAgeOf, shiftAgeMessage, SHIFT_MAX_HOURS,
} from '@snpos/core';
import type { PaymentMethod, Shift } from '@snpos/core';
import type { PosContext } from './App';

export type { Shift } from '@snpos/core';

/**
 * The shift is the boundary that makes cash reconcilable.
 *
 * Nothing can be paid for outside one, otherwise money arrives with no
 * opening float to measure it against, and the day never balances.
 */
export function ShiftBar({ ctx, onToast }: { ctx: PosContext; onToast: (m: string, tone?: 'ok' | 'err') => void }) {
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);
  const [floats, setFloats] = useState<Record<string, string>>({});
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
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
  const [floatSource, setFloatSource] = useState('zero');
  const [floatNote, setFloatNote] = useState('');
  // What this shift has done, and what has been paid out of it. Both are
  // things a cashier is asked about long before the shift ends.
  const [history, setHistory] = useState(false);
  const [spending, setSpending] = useState(false);
  const [handingOver, setHandingOver] = useState(false);

  const decimals = ctx.settings.currency_decimals ?? 2;

  // A day is the limit. See shift-rules.
  const age = shiftAgeOf(ctx.shift);
  // Which question the restaurant has chosen to ask, and what the answers come
  // to. Worked out here rather than in the form so the close button and the
  // boxes on screen can never be judging different things.
  const counting = ctx.settings.stock_check_mode === 'counts';
  const stockDecimals = ctx.settings.stock_count_decimals !== false;
  const resolved = resolveCounts(stockList, stockCounts, stockDecimals);

  const tolerance = ctx.settings.cash_variance_tolerance ?? 500;
  const money = (n: number) => formatMoney(n, ctx.settings);

  const startOpen = async () => {
    const m = await loadPaymentMethods(ctx.venue.$id);
    setMethods(m);
    // Filled in from whatever the restaurant said its float policy is, rather
    // than always starting at zero and quietly turning yesterday's float into
    // today's takings.
    const opening = await openingFloats(ctx.venue.$id, ctx.settings, m);
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
      await createShift({
        venueId: ctx.venue.$id,
        userId: ctx.userId,
        floats: Object.fromEntries(Object.entries(floats).map(([k, v]) => [k, parseMoney(v, decimals) ?? 0])),
        floatSource: floatSource,
        // The side this till is on. Without it every shift was opened as the
        // kitchen's, and a craft till then looked for a craft shift, found
        // none, and showed no shift open a moment after somebody opened one.
        module: ctx.module,
      });
      await ctx.reloadShift();
      setOpening(false);
      onToast('Shift opened');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the shift.');
    } finally {
      setBusy(false);
    }
  };

  const startClose = async () => {
    if (!ctx.shift) return;
    setBusy(true);
    setError(null);
    try {
      const [m, blocking] = await Promise.all([
        loadPaymentMethods(ctx.venue.$id),
        shiftBlockers(ctx.venue.$id, undefined, ctx.module),
      ]);
      setMethods(m);
      setBlockers(
        blocking.map((b) => ({
          id: b.order.$id,
          label: `${b.order.order_no} · ${money(b.order.total)}`,
          reason: b.reason,
        })),
      );

      // Expected is worked out from the records, never typed. Staff enter only
      // what is in their hand.
      const takings = await expectedTakings(ctx.shift as Shift, m);
      setRows(
        m
          .filter((x) => x.counted_at_close)
          .map((x) => ({ methodId: x.$id, name: x.name, expected: takings.byMethod[x.$id] ?? 0, countedText: '' })),
      );

      // What came in and what went out, before any drawer is counted.
      setFlow({
        opening: Object.values(takings.openingFloats).reduce((a, b) => a + b, 0),
        sales: takings.salesTotal,
        tips: takings.tipsTotal,
        out: takings.expensesTotal,
      });

      /**
       * The shelf check, and only where there is a shelf.
       *
       * Ingredients are the kitchen's: rice, tomatoes, gas. A craft cashier
       * closing the counter was being asked whether the restaurant had run low
       * on chicken, a question they cannot answer and whose answer goes into
       * the kitchen's overnight report. The shop's own stock moves through
       * consignment intakes and sales, which count themselves.
       */
      const list = ctx.module === 'craft' ? [] : await stockCheckRows(ctx.venue.$id);
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

  const countedMinor = () =>
    Object.fromEntries(rows.map((r) => [r.methodId, parseMoney(r.countedText, decimals) ?? 0]));

  const anythingOff = () =>
    rows.some((r) => (parseMoney(r.countedText, decimals) ?? 0) !== r.expected);

  /**
   * A drawer counted below nothing, when that is not allowed.
   *
   * You cannot hand over less than no money, so a negative count is not a
   * variance; it is a missing record, usually an expense paid out of the till
   * that nobody entered. Blocked by default, with a switch for the places that
   * genuinely need to close short and explain it.
   */
  const negativeDrawer = () => {
    if (ctx.settings.allow_negative_cash) return null;
    const bad = rows.find((r) => (parseMoney(r.countedText, decimals) ?? 0) < 0);
    return bad ? bad.name : null;
  };
  const allCounted = () => rows.every((r) => parseMoney(r.countedText, decimals) !== null);

  const doClose = async () => {
    if (!ctx.shift) return;
    if (blockers.length > 0) return;
    if (!allCounted()) { setError('Enter what you counted for every drawer.'); return; }
    const short = negativeDrawer();
    if (short) {
      setError(
        `${short} cannot finish below nothing. A drawer that counts negative almost always means money was paid ` +
        'out and not recorded. Add the expense first, then close.',
      );
      return;
    }
    if (counting && resolved.missing.length > 0) {
      const names = resolved.missing.slice(0, 3).map((i) => i.name).join(', ');
      setError(
        `Still to count: ${names}${resolved.missing.length > 3 ? ` and ${resolved.missing.length - 3} more` : ''}. ` +
        'Type 0 for anything that has run out. A blank row would be saved as if it were fine.',
      );
      return;
    }
    if (anythingOff() && !note.trim()) {
      setError('Something is over or short. Say what happened before closing; that answer is gone by tomorrow.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await closeShift({
        venueId: ctx.venue.$id,
        shift: ctx.shift as Shift,
        userId: ctx.userId,
        settings: ctx.settings,
        features: ctx.features,
        methods,
        counted: countedMinor(),
        varianceNote: note.trim(),
        levels: counting ? resolved.levels : levels,
        stockCounts: counting ? resolved.counts : undefined,
      });

      await ctx.reloadShift();
      setClosing(false);

      if (result.ledgerError) {
        onToast(`Shift closed, but the accounts entry failed: ${result.ledgerError}`, 'err');
      }
      const off = Object.values(result.variance).reduce((a, b) => a + Math.abs(b), 0);
      const base = off === 0 ? 'Shift closed and balanced' : `Shift closed, ${money(off)} out`;
      onToast(result.stockNote ? `${base}. ${result.stockNote}` : base, off > tolerance ? 'err' : 'ok');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not close the shift.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        className="pos-top"
        style={{ borderTop: 'none', background: ctx.shift ? 'var(--surface)' : 'var(--warn-bg)' }}
      >
        <div className="row">
          {ctx.shift ? (
            <>
              <Badge tone={age.over ? 'danger' : age.warning ? 'warn' : 'ok'}>
                {age.over ? 'Shift overdue' : 'Shift open'}
              </Badge>
              <span className="small dim">
                {ctx.shift.code} · since {new Date(ctx.shift.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </>
          ) : (
            <span className="small" style={{ color: 'var(--warn)' }}>
              {/* A shop has no kitchen to fall back on, so the sentence about
                  carrying on without a shift is only true on one side. */}
              {ctx.module === 'craft'
                ? 'No shift open, so nothing can be sold until one is.'
                : 'No shift open, orders can be taken, but nothing can be marked paid until one is.'}
              {!ctx.profile?.can_open_shift && ' Ask someone who can open one, or have an admin grant you the permission.'}
            </span>
          )}
        </div>
        <div className="row" style={{ gap: '0.35rem', flexWrap: 'wrap' }}>
          {/* What have I sold today, and what have I paid out of the drawer.
              Both were only on the kitchen screen, which a cashier at the shop
              counter never looks at. */}
          {ctx.shift && (
            <>
              <Button size="sm" onClick={() => setHistory(true)}>This shift</Button>
              <Button size="sm" onClick={() => { setSpending(true); setError(null); }}>Record spend</Button>
              <Button size="sm" onClick={() => { setHandingOver(true); setError(null); }}>Hand over cash</Button>
            </>
          )}
          {ctx.shift ? (
            <Button size="sm" onClick={startClose} loading={busy && !closing} disabled={!ctx.profile?.can_close_shift}>
              Close shift
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={startOpen} disabled={!ctx.profile?.can_open_shift}>
              Open shift
            </Button>
          )}
        </div>
      </div>

      {/* Past a day the shift stops being a night anybody can reconcile: two
          days of takings in one drawer, measured against yesterday morning's
          float. So it says so, and at the limit refuses further sales. It is
          never closed automatically, because an automatic close would record a
          cash count that nobody made. */}
      {ctx.shift && (age.over || age.warning) && (
        <div style={{ padding: '0.5rem 1rem 0' }}>
          <Notice tone={age.over ? 'warn' : 'info'}>
            {shiftAgeMessage(age, SHIFT_MAX_HOURS)}
            {age.over && !ctx.profile?.can_close_shift && ' Ask a manager to close it.'}
          </Notice>
        </div>
      )}

      {history && ctx.shift && (
        <ShiftHistory
          shift={ctx.shift}
          venue={ctx.venue}
          settings={ctx.settings}
          who={ctx.profile}
          onClose={() => setHistory(false)}
          onToast={onToast}
        />
      )}

      {spending && ctx.shift && (
        <ExpenseModal
          module={ctx.module}
          venueId={ctx.venue.$id}
          shiftId={ctx.shift.$id}
          settings={ctx.settings}
          userId={ctx.userId}
          onClose={() => setSpending(false)}
          onDone={(m) => { setSpending(false); onToast(m); }}
        />
      )}

      {handingOver && (
        <HandoverModal
          venueId={ctx.venue.$id}
          shiftId={ctx.shift?.$id}
          settings={ctx.settings}
          who={ctx.profile}
          onClose={() => setHandingOver(false)}
          onDone={(m) => { setHandingOver(false); onToast(m); }}
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
            Count what is in the drawer now. This is the figure the close will measure against, so a guess here becomes
            a false discrepancy later.
          </p>
          {floatNote && <p className="small dim">{floatNote}</p>}
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
          {methods.map((m) => (
            <Field key={m.$id} label={`${m.name} float (${ctx.settings.currency_symbol})`}>
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
            symbol={ctx.settings.currency_symbol ?? ''}
            money={money}
            tolerance={tolerance}
            flow={flow}
          />
        </Modal>
      )}
    </>
  );
}
