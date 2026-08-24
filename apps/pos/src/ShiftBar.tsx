import { useEffect, useState } from 'react';
import {
  Button, Modal, Field, Input, Notice, Badge, ShiftCloseForm, resolveCounts,
  ShiftHistory, ExpenseModal, HandoverModal, BarCountModal,
} from '@snpos/ui';
import type { BlockerRow, CountRow, StockRow, ShiftFlow } from '@snpos/ui';
import {
  formatMoney, parseMoney, toInput, stockCheckRows,
  loadPaymentMethods, openShift as createShift, shiftBlockers, expectedTakings, closeShift,
  openingFloats, shiftAgeOf, shiftAgeMessage, SHIFT_MAX_HOURS, HANDOVER_ENABLED,
  countsAtBothEnds, hasOpeningCount, ownFigure, floatOrigin, floatMethods,
} from '@snpos/core';
import type { PaymentMethod, Shift, FloatSource } from '@snpos/core';
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
  /** Orders this shift ran past its limit to take. Named before it closes. */
  const [shelving, setShelving] = useState<{ id: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [floatSource, setFloatSource] = useState<FloatSource>('zero');
  const [floatNote, setFloatNote] = useState('');
  /**
   * What the till filled the boxes in with, and where from.
   *
   * Kept so the open can tell whether the figure it is saving is the one the
   * policy produced or one a person typed over it, and so a carried float can
   * name the shift it came out of on the row it creates.
   */
  const [floatFilled, setFloatFilled] = useState<Record<string, number>>({});
  const [floatFrom, setFloatFrom] = useState<{ id: string; code: string } | undefined>(undefined);
  // What this shift has done, and what has been paid out of it. Both are
  // things a cashier is asked about long before the shift ends.
  const [history, setHistory] = useState(false);
  const [spending, setSpending] = useState(false);
  const [handingOver, setHandingOver] = useState(false);
  /**
   * The bar's own count, at both ends of the shift.
   *
   * `counted` is what the shift has already been counted in on. It starts
   * undefined rather than false, because "we have not looked yet" and "nobody
   * counted" would otherwise show the same warning — and a bar would be
   * accused of skipping its count for the second it takes to read.
   */
  const [barCount, setBarCount] = useState<'open' | 'close' | null>(null);
  const [countedIn, setCountedIn] = useState<boolean | undefined>(undefined);
  const [countedOut, setCountedOut] = useState(false);
  /** The opening sheet has already been put in front of somebody this session. */
  const [pushed, setPushed] = useState(false);

  const decimals = ctx.settings.currency_decimals ?? 2;

  /*
    Whether THIS shift has been counted in.

    Asked on the shift rather than on the day. A bar that opened at six and
    handed over at eleven is two shifts and two counts, and reading the
    question against anything wider would let the second one inherit the
    first's answer.
  */
  const countsShelves = countsAtBothEnds(ctx.module);
  const shiftId = ctx.shift?.$id;
  /*
    THE SHEET BELONGS TO THE SIDE THAT COUNTS, AND GOES WITH IT.

    A till that switches sides keeps everything else about itself, and the bar
    count sheet was no exception: opened at the bar and still on screen after
    a switch to the craft counter, over a shop till, pointed at the SHOP's
    shift. Where a count may not be skipped that sheet has no way out of it —
    so the shop counter was simply blocked, by a bar's shelves, with no
    button that would dismiss them.

    Worse than blocked, had anybody found a way to save it: the bar's bottles
    would have been filed against the craft shift.

    Cleared on the way out, along with the note that this shift has already
    been asked once — the next side asks its own questions.
  */
  useEffect(() => {
    setBarCount(null);
    setPushed(false);
    setCountedOut(false);
    /*
      And every other sheet that belongs to a shift, for the same reason.

      All of them are built from the side that was open when they opened. A
      close sheet is the sharp one: it carries the expected cash for that
      drawer, and left on screen through a switch it would count the shop's
      till against the bar's figures — money, not just a nuisance. The
      spending list, the history and the handover are the same shape.
    */
    setClosing(false);
    setOpening(false);
    setSpending(false);
    setHistory(false);
    setHandingOver(false);
    setError(null);
  }, [ctx.module]);

  useEffect(() => {
    if (!countsShelves || !shiftId) { setCountedIn(undefined); return; }
    let live = true;
    void hasOpeningCount(shiftId)
      .then((done) => { if (live) setCountedIn(done); })
      // A read that fails must not invent an accusation. Silence is better
      // than telling a bartender they skipped a count they may well have made.
      .catch(() => { if (live) setCountedIn(true); });
    return () => { live = false; };
  }, [countsShelves, shiftId]);

  /**
   * Whether the count is optional. It is not, unless an admin has said so.
   *
   * See countGate. The sheet itself enforces this — no way out and no way to
   * file a half-finished count — and it is read here as well so the till does
   * not offer routes around the thing the sheet is refusing.
   */
  const mustCount = countsShelves && ctx.settings.bar_count_skippable !== true;

  /*
    A bar shift that is open and was never counted in.

    Put back in front of whoever is standing there rather than left as a
    warning to be worked around. This is the case that made the setting
    necessary: a till reloaded, a browser closed at the wrong moment, a shift
    inherited mid-evening. Without it, "cannot be skipped" would mean only
    "cannot be skipped in the ten seconds after tapping Open shift".
  */
  useEffect(() => {
    if (!mustCount || countedIn !== false || pushed) return;
    /*
      Once, not on a loop.

      The sheet lets somebody out when it could not be loaded, or when there is
      nothing on it to count. Reopening it the instant they leave would put
      them in a door that cannot be walked through and cannot be walked away
      from, which is a bricked till. The warning below stays either way, and
      the next time this screen loads it asks again.
    */
    setPushed(true);
    setBarCount('open');
  }, [mustCount, countedIn, pushed]);

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
  /** What is currently typed into the opening boxes, added up. */
  const carried = Object.values(floats).reduce((a, v) => a + (parseMoney(v, decimals) ?? 0), 0);

  const startOpen = async () => {
    const m = await loadPaymentMethods(ctx.venue.$id);
    setMethods(m);
    // Filled in from whatever the restaurant said its float policy is, rather
    // than always starting at zero and quietly turning yesterday's float into
    // today's takings.
    // The side this till is on, so a carried-over float comes from this
    // side's own last shift and not from whichever drawer closed last.
    const opening = await openingFloats(ctx.venue.$id, ctx.settings, m, ctx.module);
    setFloatSource(opening.source);
    setFloatNote(opening.note);
    setFloatFrom(opening.from);
    setFloatFilled(Object.fromEntries(m.map((x) => [x.$id, opening.floats[x.$id] ?? 0])));
    setFloats(
      Object.fromEntries(
        m.map((x) => [x.$id, opening.policy === 'prompt' ? '' : toInput(opening.floats[x.$id] ?? 0, decimals)]),
      ),
    );
    setOpening(true);
    setError(null);
  };

  const doOpen = async () => {
    setBusy(true);
    setError(null);
    try {
      const entered = Object.fromEntries(
        Object.entries(floats).map(([k, v]) => [k, parseMoney(v, decimals) ?? 0]),
      );
      // Typed over, so it is a person's figure and not the policy's, whatever
      // the policy filled in. See ownFigure.
      const changed = ownFigure(entered, floatFilled);
      await createShift({
        venueId: ctx.venue.$id,
        userId: ctx.userId,
        floats: entered,
        floatSource: changed ? 'manual' : floatSource,
        carriedFrom: !changed && floatSource === 'carried_over' ? floatFrom?.id : undefined,
        // The side this till is on. Without it every shift was opened as the
        // kitchen's, and a craft till then looked for a craft shift, found
        // none, and showed no shift open a moment after somebody opened one.
        module: ctx.module,
      });
      await ctx.reloadShift();
      setOpening(false);
      onToast('Shift opened');
      /*
        Straight into the count, on the side that counts.

        Not a separate button somebody remembers to press. The moment the bar
        is opened is the only moment the opening count is worth anything —
        five drinks later it is a count of a shift already under way, and it
        will be the next person who pays for the difference.
      */
      if (countsShelves) { setCountedIn(false); setBarCount('open'); }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the shift.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * @param countDone the bar has just been counted out, or was waved past.
   *
   * The shelf is counted BEFORE the drawer, on the side that counts a shelf.
   * The other order does not work: once the cash close has been filled in,
   * asking for forty bottles is a wall between somebody and the end of their
   * night, and it gets guessed.
   */
  const startClose = async (countDone = false) => {
    if (!ctx.shift) return;
    if (countsShelves && !countDone && !countedOut) { setBarCount('close'); return; }
    setBusy(true);
    setError(null);
    try {
      const [m, blocking, everything] = await Promise.all([
        loadPaymentMethods(ctx.venue.$id),
        shiftBlockers(ctx.venue.$id, undefined, ctx.module, ctx.shift),
        // The same question without the exception, so the difference between
        // the two is exactly what is about to be moved to the next shift.
        shiftBlockers(ctx.venue.$id, undefined, ctx.module, null),
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
        // Where that figure came from, said next to it. See floatOrigin.
        openingFrom: floatOrigin(
          ctx.shift?.float_source,
          undefined,
          Object.values(takings.openingFloats).reduce((a, b) => a + b, 0),
        ),
        sales: takings.salesTotal,
        tips: takings.tipsTotal,
        // What actually left the drawers. Spending somebody covered from their
        // own money is real spending and is shown, but a drawer cannot be
        // short of money it never held.
        out: takings.expensesTotal - takings.ownMoneyTotal,
        ownMoney: takings.ownMoneyTotal,
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
      /*
        The shop has no larder to count, and the bar has already counted its own.

        The bar's shelf is asked for on its own sheet, a moment ago, measured
        against the same room it was counted into at the start of the shift.
        Asking again here would be the same bottles a second time on a
        different basis — the business total rather than the bar's own — and
        two counts of one shelf that disagree is worse than either alone.
      */
      const list = ctx.module === 'craft' || countsShelves
        ? []
        : await stockCheckRows(ctx.venue.$id, ctx.module);
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

      // Closed is closed. Said first, so the screen is right even if the read
      // that follows fails; a stale open shift here keeps its overdue warning
      // on the bar with nothing to explain it.
      ctx.setShift(null);
      await ctx.reloadShift();
      setClosing(false);

      if (result.ledgerError) {
        onToast(`Shift closed, but the accounts entry failed: ${result.ledgerError}`, 'err');
      }
      const off = Object.values(result.variance).reduce((a, b) => a + Math.abs(b), 0);
      const base = off === 0 ? 'Shift closed and balanced' : `Shift closed, ${money(off)} out`;
      onToast(result.stockNote ? `${base}. ${result.stockNote}` : base, off > tolerance ? 'err' : 'ok');
      // Still owed for, and now somebody else's to collect. Not a footnote.
      if (result.shelved.length > 0) {
        onToast(
          `${result.shelved.length} order${result.shelved.length === 1 ? '' : 's'} moved to the next shift, `
          + 'and will appear as soon as one is opened.',
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
              {/* Switched off for now. See HANDOVER_ENABLED. */}
              {HANDOVER_ENABLED && (
                <Button size="sm" onClick={() => { setHandingOver(true); setError(null); }}>Hand over cash</Button>
              )}
            </>
          )}
          {ctx.shift ? (
            <Button
              size="sm"
              onClick={() => void startClose()}
              loading={busy && !closing}
              disabled={!ctx.profile?.can_close_shift}
            >
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
      {/* Said out loud, because it is otherwise invisible and looks like a
          close that did not work. Each is closed on its own: closing this one
          brings the next up, until none are left. */}
      {ctx.alsoOpen.length > 0 && (
        <div style={{ padding: '0.5rem 1rem 0' }}>
          <Notice tone="warn">
            <strong>
              {ctx.alsoOpen.length === 1
                ? 'Another shift is also open on this side.'
                : `${ctx.alsoOpen.length} other shifts are also open on this side.`}
            </strong>
            <div className="small" style={{ marginTop: '0.3rem' }}>
              There should only ever be one. Close this one and the next will appear here, until none are left.
              Nothing is lost: each keeps whatever was taken against it.
            </div>
            <div className="small dim" style={{ marginTop: '0.3rem' }}>
              Waiting: {ctx.alsoOpen.map((s) => s.code).join(', ')}
            </div>
          </Notice>
        </div>
      )}

      {/* A bar shift running on an uncounted shelf.
          Left on screen rather than shown once and dismissed, because the cost
          of skipping it does not land tonight — it lands on whoever counts out,
          measured against a figure nobody checked. */}
      {ctx.shift && countsShelves && countedIn === false && (
        <div style={{ padding: '0.5rem 1rem 0' }}>
          <Notice tone="warn">
            <strong>The bar has not been counted in.</strong>
            <div className="small" style={{ marginTop: '0.3rem' }}>
              Until it is, tonight&rsquo;s handover is measured against whatever the last shift left rather than
              against what you accepted.
              {mustCount && ' The sheet could not be loaded a moment ago; open it again once you have a connection.'}
            </div>
            <div style={{ marginTop: '0.45rem' }}>
              <Button size="sm" variant="primary" onClick={() => setBarCount('open')}>Count the bar in</Button>
            </div>
          </Notice>
        </div>
      )}

      {ctx.shift && (age.over || age.warning) && (
        <div style={{ padding: '0.5rem 1rem 0' }}>
          <Notice tone={age.over ? 'warn' : 'info'}>
            {shiftAgeMessage(age, SHIFT_MAX_HOURS, ctx.module)}
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

      {handingOver && HANDOVER_ENABLED && (
        <HandoverModal
          venueId={ctx.venue.$id}
          shiftId={ctx.shift?.$id}
          settings={ctx.settings}
          who={ctx.profile}
          onClose={() => setHandingOver(false)}
          onDone={(m) => { setHandingOver(false); onToast(m); }}
        />
      )}

      {/* `countsShelves` as well as the sheet itself, so a side that does not
          count shelves cannot be shown one however this state was reached. */}
      {barCount && countsShelves && ctx.shift && (
        <BarCountModal
          venueId={ctx.venue.$id}
          shiftId={ctx.shift.$id}
          phase={barCount}
          userId={ctx.userId}
          settings={ctx.settings}
          dismissLabel={barCount === 'close' ? 'Close without counting' : 'Not now'}
          // Nothing set up to count, so nothing to be warned about.
          onEmpty={() => { setCountedIn(true); setCountedOut(true); }}
          onClose={(waived) => {
            const wasClosing = barCount === 'close';
            setBarCount(null);
            /*
              LEAVING IS NOT SKIPPING, and only one of them lets a close carry
              on to the drawer.

              `waived` is the sheet's own answer: an admin has made counts
              skippable, or there was nothing on the sheet to count, or it
              would not load. Then leaving satisfies the count and the cash
              close follows, exactly as before.

              Otherwise the count is still owed. The till comes back, the
              warning stays up, the sheet asks again, and the close does not
              proceed — which is the same rule as when there was no way out at
              all, minus the stuck screen.
            */
            if (wasClosing && waived) { void startClose(true); return; }
            if (wasClosing) {
              onToast('The bar has not been counted out, so the shift cannot close yet.', 'err');
            }
          }}
          onDone={(m) => {
            const wasClosing = barCount === 'close';
            setBarCount(null);
            if (wasClosing) { setCountedOut(true); void startClose(true); } else setCountedIn(true);
            onToast(m);
          }}
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
          {/*
            A float that came from somewhere else is said out loud, not left as
            a grey line under a box that is already filled in.

            This is money the person opening the till did not count and may not
            have. If the night's takings were banked and the drawer emptied,
            the figure sitting in that box is money that is not there — and
            nothing goes wrong until midnight, when the same drawer reads short
            by exactly that amount and somebody is asked to account for it. So
            it is stated, with the shift it came out of named, and there is one
            button to say the drawer is empty.
          */}
          {floatSource === 'carried_over' && carried > 0 && (
            <Notice tone="warn">
              <strong>This drawer is starting with {money(carried)}.</strong>
              <div className="small" style={{ marginTop: '0.3rem' }}>
                {floatNote}
              </div>
              <div style={{ marginTop: '0.5rem' }}>
                <Button
                  size="sm"
                  onClick={() => setFloats(Object.fromEntries(methods.map((m) => [m.$id, toInput(0, decimals)])))}
                >
                  The drawer was emptied — start at nothing
                </Button>
              </div>
            </Notice>
          )}
          {floatSource !== 'carried_over' && floatNote && <p className="small dim">{floatNote}</p>}
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
          {/* Cash drawers only. A card terminal holds nothing overnight and
              gives no change, so a "Card float" box is a question with one
              right answer — see floatMethods. */}
          {floatMethods(methods).map((m) => (
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
          {/* Said here, at the last moment it can still be put right, and with
              the way back on it. Once this closes the shelf is signed off. */}
          {countsShelves && !countedOut && (
            <Notice tone="warn">
              <strong>The bar was not counted out.</strong>
              <div className="small" style={{ marginTop: '0.3rem' }}>
                The shift will close on whatever the sales say is left, and nobody will know whether that is what
                is actually there.
              </div>
              <div style={{ marginTop: '0.45rem' }}>
                <Button size="sm" onClick={() => { setClosing(false); setBarCount('close'); }}>
                  Count the bar out first
                </Button>
              </div>
            </Notice>
          )}
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
            shelving={shelving}
          />
        </Modal>
      )}
    </>
  );
}
