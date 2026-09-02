import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Notice, Select, Spinner, useToast } from '@snpos/ui';
import { db, DB_ID, humanError } from '../lib';
import {
  barCountSheet, saveBarCount, hasOpeningCount, byUnit, summariseBarCount, readyToClose,
  formatMoney, listAll, Query, loadOpenShifts, loadLocations, saleLocation, mayCountWithoutShift,
  expenseDraftKey, readExpenseDraft, saveExpenseDraft, clearExpenseDraft,
  filedCounts, undoProblem, undoBarCount, pourMissedSales,
  loadRecipes, pourState, pourLabel, pourWords, unexplainedByWiring, drinksToMoveToBar,
} from '@snpos/core';
import type {
  BarCountLine, Shift, Doc, StockLocation, FiledCheck, FiledCount, PourRow, PourItem, PourState,
} from '@snpos/core';
import { useSession } from '../session';

interface CheckRow extends Doc {
  shift_id: string;
  ingredient_id: string;
  phase?: 'open' | 'close';
  counted_qty?: number;
  theoretical_qty: number;
  variance_qty: number;
  variance_value: number;
}

/**
 * The bar's bottles, counted in and counted out.
 *
 * A kitchen counts once, at close, and nobody signs for the rice. A bar is the
 * other thing: the person coming on accepts what is behind the bar and the
 * person going off hands it over, and the difference between those two counts
 * is what somebody is answerable for.
 *
 * Which is why the opening count is asked for rather than carried over. It
 * usually IS what the last shift left, and the times it is not are exactly the
 * times that matter — an overnight delivery, a bottle taken for a function, a
 * count somebody rushed at midnight. Two minutes at the start is what stops an
 * argument at the end.
 */
export function BarCountsPage() {
  const { settings, profile, user } = useSession();
  const toast = useToast();

  const [shift, setShift] = useState<Shift | null>(null);
  const [phase, setPhase] = useState<'open' | 'close'>('close');
  /**
   * Which room is being walked.
   *
   * The bar is counted every shift and the store room every few weeks, and a
   * store room that could only be counted as part of the bar could not be
   * counted at all — its stock would read as an enormous surplus against what
   * the counter expected.
   */
  const [places, setPlaces] = useState<StockLocation[]>([]);
  const [restored, setRestored] = useState(false);
  const userId = user?.$id ?? '';
  const store = typeof window === 'undefined' ? null : window.localStorage;
  const [placeId, setPlaceId] = useState('');
  const [lines, setLines] = useState<BarCountLine[] | null>(null);
  const [openingDone, setOpeningDone] = useState(false);
  const [history, setHistory] = useState<CheckRow[]>([]);
  /** Which count is being taken back, so only its own button spins. */
  const [undoing, setUndoing] = useState<string | null>(null);
  const [pouring, setPouring] = useState(false);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * A half-finished count survives the tab closing.
   *
   * Counting a store room is not one sitting: somebody gets through the
   * spirits, serves a customer, comes back — and a browser that had thrown
   * away the first twenty minutes makes this a screen people stop starting.
   *
   * Keyed by ROOM as well as by person: switching rooms mid-count must not
   * carry the store's numbers onto the bar's sheet, which would be a count of
   * the wrong shelf saved under the right name.
   *
   * Kept on the device rather than in the database. An unfinished count is not
   * a record, and half of one sitting in the variances would be worse than
   * none.
   */
  const draftKey = (uid: string, place: string) => expenseDraftKey('main', `barcount:${place}`, uid);

  const isAdmin = profile?.role === 'admin';

  /**
   * Which room, and therefore which kind of count.
   *
   * A store room belongs to no shift: nobody pours from it, no shift accepts
   * it and no shift hands it over. It is walked every few weeks because
   * somebody wants to know what is in there, and it must be countable whether
   * or not the bar happens to be trading.
   */
  /** The rooms could not be read at all, which is not the same as having none. */
  const [roomsFailed, setRoomsFailed] = useState(false);
  /**
   * What actually takes each bottle off the shelf when a drink is sold.
   *
   * Read so the sheet can say WHY a line is short. A shortage because nothing
   * is set up to deduct it looks exactly like a shortage from over-pouring or
   * from theft, and the difference is the difference between ten minutes in
   * the admin screen and a conversation with a bartender. See pour-check.
   */
  const [recipes, setRecipes] = useState<PourRow[]>([]);
  const [drinks, setDrinks] = useState<PourItem[]>([]);
  const room = places.find((p2) => p2.$id === placeId) ?? null;
  const isStore = room?.kind === 'store';
  /**
   * A manager may spot-check the bar with no shift open.
   *
   * A bar count is normally a handover — what one person accepted and what
   * they handed over — which is why it belongs to a shift. That holds for a
   * bartender and not for a manager: a check outside service is a stocktake,
   * not a handover. Refusing it meant the only way to look at the bar was to
   * open a shift nobody was going to trade on, which puts a false evening in
   * the books to answer a question about stock.
   *
   * What it is recorded AS still follows the shift, not the person — see
   * saveBarCount, which writes a shift's claim only where there is a shift to
   * make the claim about.
   */
  const isManager = profile?.role === 'admin' || profile?.role === 'manager';
  const canCount = mayCountWithoutShift({ isStore, isManager, hasShift: !!shift });
  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));

  const load = async () => {
    try {
      const open = await loadOpenShifts('main', 'bar').catch(() => [] as Shift[]);
      const current = open[0] ?? null;
      setShift(current);
      /*
        A read that failed is not a bar with no rooms in it.

        Swallowed into an empty list, the two are the same thing to every line
        below — and they need opposite answers. "Nothing could be read, try
        again" and "nobody has set up a store room yet" send somebody to
        completely different places, and offering the second when the first is
        true sends them to build something that already exists.
      */
      const where = await loadLocations('main').catch(() => null);
      setRoomsFailed(where === null);
      const bar = (where ?? []).filter((l) => (l.module ?? 'kitchen') === 'bar' && l.active !== false);
      setPlaces(bar);
      const here = placeId || saleLocation(bar, 'bar')?.$id || '';
      if (!placeId) setPlaceId(here);
      setLines(await barCountSheet('main', here || undefined, isManager));
      // Best effort. A sheet that cannot answer "is this wired up" is still a
      // usable sheet; one that refuses to load over it is not.
      const [rec, items] = await Promise.all([
        loadRecipes().catch(() => [] as PourRow[]),
        listAll<PourItem>('menu_items').catch(() => [] as PourItem[]),
      ]);
      setRecipes(rec as unknown as PourRow[]);
      setDrinks(items);
      if (current) {
        const done = await hasOpeningCount(current.$id);
        setOpeningDone(done);
        // Straight to the count that has not been done yet, rather than making
        // somebody choose between two words at the start of a shift.
        setPhase(done ? 'close' : 'open');
        setHistory(await listAll<CheckRow>('shift_stock_checks', [Query.equal('shift_id', current.$id)]));
      }
    } catch (e) {
      setError(humanError(e));
    }
  };

  useEffect(() => { void load(); }, []);

  // Put back whatever was typed, once the sheet for this room has loaded.
  useEffect(() => {
    if (!lines || restored || !userId || !placeId) return;
    const draft = readExpenseDraft(store, draftKey(userId, placeId));
    const saved = (draft as { lines?: { ingredientId: string; qtyText: string; totalText: string }[] })?.lines;
    if (saved?.length) {
      const byId = new Map(saved.map((l) => [l.ingredientId, l]));
      setLines((rows) => (rows ?? []).map((r) => {
        const hit = byId.get(r.ingredientId);
        return hit ? { ...r, countedText: hit.qtyText, note: hit.totalText } : r;
      }));
    }
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, userId, placeId]);

  /**
   * Written as it is typed, not on the way out.
   *
   * There are more ways off this page than there are buttons on it: a tab
   * closing, a tablet sleeping, a browser reloading a page it has sat on all
   * evening.
   */
  useEffect(() => {
    if (!lines || !userId || !placeId || !restored) return;
    saveExpenseDraft(store, draftKey(userId, placeId), {
      lines: lines
        .filter((l) => (l.countedText ?? '').trim() !== '' || (l.note ?? '').trim() !== '')
        .map((l) => ({ ingredientId: l.ingredientId, qtyText: l.countedText ?? '', totalText: l.note ?? '' })),
      noteText: '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, userId, placeId, restored]);

  // A different room is a different sheet, so its own draft is loaded.
  useEffect(() => { setRestored(false); }, [placeId]);
  // Changing room reloads the sheet: what is expected is that room's level,
  // not the business total.
  useEffect(() => { if (placeId) void load(); /* eslint-disable-next-line */ }, [placeId]);

  const setLine = (id: string, patch: Partial<BarCountLine>) =>
    setLines((rows) => (rows ?? []).map((r) => (r.ingredientId === id ? { ...r, ...patch } : r)));

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (lines ?? []).filter((l) => !q || l.name.toLowerCase().includes(q));
  }, [lines, filter]);

  const groups = useMemo(() => byUnit(shown), [shown]);

  /**
   * Whether a sale ever moves this shelf, worked out once for the whole sheet.
   *
   * Memoised because it is asked for every row on a page that re-renders on
   * every keystroke somebody types into a count box.
   */
  const pourFor = useMemo(() => {
    const cache = new Map<string, PourState>();
    return (ingredientId: string): PourState => {
      const known = cache.get(ingredientId);
      if (known) return known;
      const state = pourState(ingredientId, recipes, drinks);
      cache.set(ingredientId, state);
      return state;
    };
  }, [recipes, drinks]);

  /*
    How much of the shortage is only wiring.

    The number worth putting at the top. A sheet reporting a big shortage is
    alarming; the same sheet saying most of it is drinks nobody finished
    setting up is a job, not an incident.
  */
  const wiring = useMemo(
    () => unexplainedByWiring(lines ?? [], pourFor),
    [lines, pourFor],
  );
  const summary = useMemo(() => summariseBarCount(lines ?? []), [lines]);
  const check = useMemo(() => readyToClose(lines ?? []), [lines]);

  const save = async () => {
    // A store room needs no shift; the bar does.
    if (!isStore && !shift) return;
    setBusy(true);
    setError(null);
    try {
      const { written, shortValue, failed } = await saveBarCount({
        venueId: 'main',
        // Left off for a store room, on purpose: stamping it with whichever
        // shift happened to be open would put a month of drift on one
        // bartender's evening.
        shiftId: isStore ? undefined : shift?.$id,
        locationId: placeId || undefined,
        phase,
        lines: lines ?? [],
        userId: user?.$id ?? '',
      });
      await load();
      setLines((rows) => (rows ?? []).map((r) => ({ ...r, countedText: '', note: '' })));
      // Saved for real, so the unfinished copy has nothing left to protect.
      if (userId && placeId) clearExpenseDraft(store, draftKey(userId, placeId));
      /*
        A count that half saved says which half.

        Every write in a count is allowed to fail without stopping the rest —
        one refused row must not abandon a count of forty bottles part-way —
        and for as long as nothing added those up, a count that changed
        nothing looked exactly like a count that worked. See tryWrite.
      */
      if (failed > 0) {
        setError(
          `${failed} of these did not save. The shelves are part-counted: count again, and if it keeps `
          + 'happening the database is refusing something and an admin should be told.',
        );
      }
      toast(
        isStore
          // A stocktake reports what it found. It is nobody's handover, so
          // "short" would be the wrong word and the wrong accusation.
          ? `${written} line${written === 1 ? '' : 's'} counted in ${room?.name ?? 'the store'}. `
            + 'The shelves now say what you found.'
          : phase === 'open'
            ? `${written} line${written === 1 ? '' : 's'} counted in. The bar is yours.`
            : shortValue > 0
              ? `Counted out. ${money(shortValue)} short — an admin can see it under Variances.`
              : 'Counted out, and it balances.',
        failed > 0 ? 'err' : undefined,
      );
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  /** What the closing count found, for the admin who has to look at it. */
  /*
    The counts filed on this shift, grouped as they were made.

    From the same rows the table below reads, rather than a second query: what
    makes a set of rows one count is only that they name the same shift and the
    same end of it, and that is a grouping rule rather than a fetch. See
    filedCounts.
  */
  const filed = filedCounts(history as unknown as FiledCheck[]);

  /** Put the shelves back the way they were before a count. */
  const takeBack = async (c: FiledCount) => {
    const key = `${c.shiftId}-${c.phase}`;
    setUndoing(key);
    setError(null);
    try {
      const { put_back, failed } = await undoBarCount({
        venueId: 'main',
        shiftId: c.shiftId,
        phase: c.phase,
        userId: user?.$id ?? '',
        locationId: placeId || undefined,
      });
      await load();
      toast(
        `${put_back} shel${put_back === 1 ? 'f' : 'ves'} put back`
        + `${failed > 0 ? `, and ${failed} could not be` : ''}. `
        + 'The count stays on the record, marked as taken back.',
        failed > 0 ? 'err' : undefined,
      );
    } catch (e) {
      setError(humanError(e));
    } finally {
      setUndoing(null);
    }
  };

  /**
   * Put this shift's unaccounted sales through the shelves.
   *
   * Idempotent by the sale line, the same way the server is, so pressing it
   * again moves nothing — which is what makes it safe to offer at all.
   */
  const catchUp = async () => {
    if (!shift) return;
    setPouring(true);
    setError(null);
    try {
      const { poured, lines, failed } = await pourMissedSales({
        venueId: 'main',
        shiftId: shift.$id,
        module: 'bar',
        userId: user?.$id ?? '',
      });
      await load();
      toast(
        lines === 0
          ? 'Nothing was missed — every sale on this shift has already come off a shelf.'
          : `${lines} sale${lines === 1 ? '' : 's'} put through, moving ${poured} shel${poured === 1 ? 'f' : 'ves'}`
            + `${failed > 0 ? `, and ${failed} could not be` : ''}.`,
        failed > 0 ? 'err' : undefined,
      );
    } catch (e) {
      setError(humanError(e));
    } finally {
      setPouring(false);
    }
  };

  const closingVariances = history
    .filter((h) => h.phase === 'close' && h.variance_qty !== 0)
    .sort((a, b) => b.variance_value - a.variance_value);

  const nameOf = (id: string) => (lines ?? []).find((l) => l.ingredientId === id)?.name ?? 'an ingredient';

  return (
    <>
      <div className="spread">
        <h1>Bar counts</h1>
        {canCount && (
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={summary.countedLines === 0}>
            {isStore
              ? `Save the count of ${room?.name ?? 'the store'}`
              : phase === 'open' ? 'Count the bar in' : 'Count the bar out'}
          </Button>
        )}
      </div>

      {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

      {!canCount ? (
        <Card title="Which room">
          {/*
            Shown whenever there is anything to pick, not only when there are
            two. With one room the picker was hidden and the words below still
            said "pick one above", which is a screen asking for something it
            has not put on the page.
          */}
          {places.length > 0 && (
            <Field label="Which room" hint="A store room can be counted at any time. The bar is counted against a shift.">
              <Select value={placeId} onChange={(e) => setPlaceId(e.target.value)}>
                {places.map((l) => <option key={l.$id} value={l.$id}>{l.name}</option>)}
              </Select>
            </Field>
          )}
          {/*
            THREE DIFFERENT SITUATIONS, and they were all showing one message.

            An empty list stood in for a failed read, so a page that could not
            reach the database told somebody there was no shift open and to
            pick a room from a box with nothing in it. Every instruction on it
            was impossible to follow.
          */}
          {roomsFailed ? (
            <Empty title="The rooms could not be read">
              Nothing is wrong with the bar — this page could not reach the database just now, so it has no
              list of rooms to offer. The message above says what to check. Nothing was saved; reload when it
              is back.
            </Empty>
          ) : places.length === 0 ? (
            <Empty title="The bar has no rooms set up">
              A bar keeps stock in two places: behind the counter, and in a store. Set them up under
              {' '}<strong>Bar → Where stock sits</strong>, and deliveries will land in the store and counts
              will know which one they are counting.
            </Empty>
          ) : (
            <Empty title="No bar shift is open">
              Counting the bar is part of a shift — it is what one person accepted and what they handed over.
              Open the bar from the till, then count it in. A store room does not need a shift; pick one above.
              {' '}A manager can also spot-check the bar itself without one, which is recorded as a stocktake
              rather than as anybody&rsquo;s handover.
            </Empty>
          )}
        </Card>
      ) : (
        <>
          <Card title={isStore ? `Stocktake in ${room?.name}` : `Shift ${shift?.code}`}>
            <div className="row row-wrap" style={{ gap: '1.4rem', alignItems: 'flex-end' }}>
              {/* A store room has no start and no end to be at. */}
              {!isStore && (
                <Field label="Which count">
                  <Select value={phase} onChange={(e) => setPhase(e.target.value as 'open' | 'close')}>
                    <option value="open">Counting in, at the start</option>
                    <option value="close">Counting out, at the end</option>
                  </Select>
                </Field>
              )}
              <div>
                <div className="dim small">Counted so far</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 650 }}>
                  {summary.countedLines} of {(lines ?? []).length}
                </div>
              </div>
              {summary.shortValue > 0 && (
                <div>
                  <div className="dim small">Short</div>
                  <div style={{ fontSize: '1.3rem', fontWeight: 650, color: 'var(--warn)' }}>
                    {money(summary.shortValue)}
                  </div>
                </div>
              )}
            </div>

            {/* The opening count is not a formality and the screen says so
                once, where somebody starting a shift will read it. */}
            {phase === 'open' && !openingDone && (
              <Notice tone="info">
                Count what is actually behind the bar before service starts. It is usually what last night left,
                and the times it is not — an overnight delivery, a bottle taken for a function — are the times a
                variance gets argued about at two in the morning.
              </Notice>
            )}
            {phase === 'open' && openingDone && (
              <Notice tone="warn">
                This shift has already been counted in. Counting again replaces what is on the shelf; do it only
                if the first count was wrong.
              </Notice>
            )}
            {phase === 'close' && !openingDone && (
              <Notice tone="warn">
                This shift was never counted in, so the closing figures are measured against whatever the last
                shift left rather than against what this one accepted.
              </Notice>
            )}
            {phase === 'close' && !check.clear && (
              /* Said before the button, not after it. This is what an admin is
                 being asked to look at, and it is a great deal easier to
                 explain now than tomorrow when everybody has gone home. */
              <Notice tone={check.missing > 0 ? 'warn' : 'err'}>{check.reason}</Notice>
            )}
            {/*
              How much of the shortage is only wiring.

              Ahead of any conversation about what happened to the stock,
              because this part did not happen to the stock at all: nothing is
              set up to take these off the shelf, so the sheet is reporting
              everything that was sold as though it had gone missing. Reading
              it as a loss is how a bartender gets asked about a shortage that
              is a setting.
            */}
            {wiring.lines > 0 && (
              <Notice tone="warn">
                {wiring.lines === 1 ? 'One line on this sheet is' : `${wiring.lines} lines on this sheet are`}
                {' '}short {money(wiring.value)} between {wiring.lines === 1 ? 'it' : 'them'}, and nothing on the
                menu is set up to take {wiring.lines === 1 ? 'it' : 'them'} off the shelf when a drink is sold.
                That is not stock going missing — it is every sale of {wiring.lines === 1 ? 'it' : 'them'} being
                reported as a shortage, and it will happen again every night until the drink says how much it
                uses. The lines are marked below.
              </Notice>
            )}
          </Card>

          <Card>
            <Field label="Search">
              <Input value={filter} placeholder="Gin, tonic…" onChange={(e) => setFilter(e.target.value)} />
            </Field>
            {/* Only worth asking when there is more than one room. A bar with
                a single shelf should not be made to choose it. */}
            {places.length > 1 && (
              <Field
                label="Which room"
                hint="What is expected is that room's own level, so each is counted on its own."
              >
                <Select value={placeId} onChange={(e) => setPlaceId(e.target.value)}>
                  {places.map((l) => <option key={l.$id} value={l.$id}>{l.name}</option>)}
                </Select>
              </Field>
            )}
            <p className="small dim" style={{ margin: 0 }}>
              Grouped the way the bar is walked: bottles on the shelf, then crates in the store, then what is
              open and measured. Leave a line blank and nothing is recorded for it — blank is not nought.
              {' '}This sheet is the items an admin marked as counted every shift, under Bottles &amp; mixers;
              with none marked it asks for everything.
            </p>
          </Card>

          {!lines ? (
            <Card><Spinner /></Card>
          ) : groups.length === 0 ? (
            <Card>
              <Empty title="Nothing set up for the bar yet">
                Add your bottles and mixers under Bar, Bottles &amp; mixers, and set each one&rsquo;s unit —
                bottles, cases, or measures. They appear here grouped by it.
              </Empty>
            </Card>
          ) : (
            groups.map((group) => (
              <Card
                key={group.unit}
                title={group.label}
                pad={false}
                actions={
                  <Badge tone={group.counted === group.total ? 'ok' : 'default'}>
                    {group.counted} of {group.total}
                  </Badge>
                }
              >
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>What</th>
                        <th className="num">Should be</th>
                        <th style={{ width: '7rem' }}>Actually</th>
                        <th className="num">Difference</th>
                        <th className="num">Worth</th>
                        <th style={{ width: '12rem' }}>Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.lines.map((l) => {
                        const typed = (l.countedText ?? '').trim();
                        const counted = typed === '' ? null : Number(typed);
                        const delta = counted === null || !Number.isFinite(counted)
                          ? null
                          : Math.round((counted - l.expected) * 1000) / 1000;
                        return (
                          <tr key={l.ingredientId}>
                            <td style={{ fontWeight: 550 }}>
                              {l.name}
                              {/* Said on the row rather than only in the total,
                                  because the person reading it is looking at
                                  one line and asking what happened to it. */}
                              {(() => {
                                const state = pourFor(l.ingredientId);
                                const label = pourLabel(state);
                                if (!label) return null;
                                const toMove = state === 'not-on-the-bar'
                                  ? drinksToMoveToBar(l.ingredientId, recipes, drinks) : [];
                                return (
                                  <div
                                    className="row"
                                    style={{ marginTop: '0.15rem', gap: '0.4rem', alignItems: 'center' }}
                                    title={pourWords(state, l.name) ?? ''}
                                  >
                                    <Badge tone="warn">{label}</Badge>
                                    {/* The fix in one press, where the fault is
                                        shown. Only where the fix is a setting:
                                        a drink with no recipe at all needs a
                                        recipe written, which is a form, not a
                                        button. */}
                                    {toMove.length > 0 && isManager && (
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={async () => {
                                          try {
                                            for (const d of toMove) {
                                              await db.updateDocument(DB_ID, 'menu_items', d.$id, { module: 'bar' });
                                            }
                                            setDrinks((all) => all.map((d) => (
                                              toMove.some((m) => m.$id === d.$id) ? { ...d, module: 'bar' } : d
                                            )));
                                            toast(`${toMove.map((d) => d.name).join(', ')} set to the bar`);
                                          } catch (e) {
                                            setError(humanError(e));
                                          }
                                        }}
                                      >
                                        Set {toMove.length === 1 ? toMove[0].name : `${toMove.length} drinks`} to the bar
                                      </Button>
                                    )}
                                  </div>
                                );
                              })()}
                            </td>
                            <td className="num dim">{l.expected}</td>
                            <td>
                              <Input
                                type="number"
                                step="any"
                                min="0"
                                placeholder="—"
                                value={l.countedText ?? ''}
                                onChange={(e) => setLine(l.ingredientId, { countedText: e.target.value })}
                              />
                            </td>
                            <td className="num">
                              {delta === null || delta === 0
                                ? <span className="dim">—</span>
                                : <Badge tone={delta < 0 ? 'danger' : 'warn'}>{delta > 0 ? `+${delta}` : delta}</Badge>}
                            </td>
                            <td className="num dim">
                              {delta === null || delta === 0 ? '' : money(Math.round(Math.abs(delta) * l.unitCost))}
                            </td>
                            <td>
                              {/* Only where there is something to explain. A
                                  note box on every line is four hundred boxes
                                  nobody fills in. */}
                              {delta !== null && delta !== 0 ? (
                                <Input
                                  value={l.note ?? ''}
                                  placeholder="Breakage, a taste…"
                                  onChange={(e) => setLine(l.ingredientId, { note: e.target.value })}
                                />
                              ) : (
                                <span className="dim small">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            ))
          )}
        </>
      )}

      {/*
        THE COUNTS ALREADY FILED, AND A WAY TO TAKE ONE BACK.

        A count that was wrong moves real stock figures, and nothing could
        move them back: the only way out was to count again, which files a
        second count against the same shift and leaves both standing with
        nothing saying which one to believe.

        Nothing is deleted. The count happened — somebody stood at the shelf
        and wrote a number down — so it stays, marked, and the shelf is
        corrected by an opposite movement. See undoBarCount.
      */}
      {/*
        SALES THAT NEVER CAME OFF A SHELF.

        A bar deducts as each drink is paid for, which needs the drink to have
        a recipe naming a shelf. Until a size was given one, a bottled drink
        had no recipe at all — so it poured nothing, correctly, and the sales
        made before the shelves existed came off nothing.

        No amount of counting reconciles that stretch of the night: the shelf
        says what was counted and the sales say what went, and nothing has ever
        connected the two. This pours what was missed, once, from what each
        line actually sold — a large Club off the large Club's shelf, not off
        the drink it is a size of.
      */}
      {isAdmin && shift && (
        <Card title="Sales that never came off a shelf">
          <p className="small dim" style={{ marginTop: 0 }}>
            Drinks sold before their size had a shelf of its own were never taken off anything. This puts them
            through now, so what the shelves say includes tonight&rsquo;s sales. Safe to press twice — a sale
            already accounted for is left alone.
          </p>
          <Button loading={pouring} onClick={() => void catchUp()}>
            Bring the shelves up to date with this shift
          </Button>
        </Card>
      )}

      {isAdmin && filed.length > 0 && (
        <Card title="Counts filed on this shift">
          <p className="small dim" style={{ marginTop: 0 }}>
            Taking one back puts the shelves where they were before it, by the difference it made rather than by
            the figure it wrote — so anything poured since is left alone. The count itself stays on the record,
            marked as taken back.
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th><th>Which count</th><th className="num">Lines moved</th>
                  <th className="num">Worth</th><th />
                </tr>
              </thead>
              <tbody>
                {filed.map((c) => (
                  <tr key={`${c.shiftId}-${c.phase}`} className={c.undoneAt ? 'dim' : undefined}>
                    <td className="small dim">{c.at ? new Date(c.at).toLocaleString() : '—'}</td>
                    <td>{c.phase === 'open' ? 'Counted in' : 'Counted out'}</td>
                    <td className="num">{c.changed}</td>
                    <td className="num">{money(c.worth)}</td>
                    <td className="num">
                      {c.undoneAt ? (
                        <Badge tone="warn">Taken back</Badge>
                      ) : undoProblem(c) ? (
                        <span className="dim small">Nothing to put back</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={undoing === `${c.shiftId}-${c.phase}`}
                          onClick={() => void takeBack(c)}
                        >
                          Take this count back
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {closingVariances.length > 0 && (
        <Card title="What the last count found">
          {!isAdmin && (
            <p className="small dim" style={{ marginTop: 0 }}>
              An admin sees this too. Anything you can explain is much easier to explain now than tomorrow.
            </p>
          )}
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>What</th><th className="num">Expected</th><th className="num">Counted</th><th className="num">Out by</th><th className="num">Worth</th></tr>
              </thead>
              <tbody>
                {closingVariances.map((h) => (
                  <tr key={h.$id}>
                    <td>{nameOf(h.ingredient_id)}</td>
                    <td className="num dim">{h.theoretical_qty}</td>
                    <td className="num">{h.counted_qty ?? '—'}</td>
                    <td className="num">
                      <Badge tone={h.variance_qty < 0 ? 'danger' : 'warn'}>
                        {h.variance_qty > 0 ? `+${h.variance_qty}` : h.variance_qty}
                      </Badge>
                    </td>
                    <td className="num">{money(h.variance_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
