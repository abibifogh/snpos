import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Notice, Select, Spinner, useToast } from '@snpos/ui';
import { humanError } from '../lib';
import {
  barCountSheet, saveBarCount, hasOpeningCount, byUnit, summariseBarCount, readyToClose,
  formatMoney, listAll, Query, loadOpenShifts, loadLocations, saleLocation,
  expenseDraftKey, readExpenseDraft, saveExpenseDraft, clearExpenseDraft,
} from '@snpos/core';
import type { BarCountLine, Shift, Doc, StockLocation } from '@snpos/core';
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
  const room = places.find((p2) => p2.$id === placeId) ?? null;
  const isStore = room?.kind === 'store';
  const canCount = isStore || !!shift;
  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));

  const load = async () => {
    try {
      const open = await loadOpenShifts('main', 'bar').catch(() => [] as Shift[]);
      const current = open[0] ?? null;
      setShift(current);
      const where = await loadLocations('main').catch(() => [] as StockLocation[]);
      const bar = where.filter((l) => (l.module ?? 'kitchen') === 'bar' && l.active !== false);
      setPlaces(bar);
      const here = placeId || saleLocation(bar, 'bar')?.$id || '';
      if (!placeId) setPlaceId(here);
      setLines(await barCountSheet('main', here || undefined));
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
  const summary = useMemo(() => summariseBarCount(lines ?? []), [lines]);
  const check = useMemo(() => readyToClose(lines ?? []), [lines]);

  const save = async () => {
    // A store room needs no shift; the bar does.
    if (!isStore && !shift) return;
    setBusy(true);
    setError(null);
    try {
      const { written, shortValue } = await saveBarCount({
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
      );
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  /** What the closing count found, for the admin who has to look at it. */
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
          {places.length > 1 && (
            <Field label="Which room" hint="A store room can be counted at any time. The bar is counted against a shift.">
              <Select value={placeId} onChange={(e) => setPlaceId(e.target.value)}>
                {places.map((l) => <option key={l.$id} value={l.$id}>{l.name}</option>)}
              </Select>
            </Field>
          )}
          <Empty title="No bar shift is open">
            Counting the bar is part of a shift — it is what one person accepted and what they handed over. Open
            the bar from the till, then count it in. A store room does not need a shift; pick one above.
          </Empty>
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
                            <td style={{ fontWeight: 550 }}>{l.name}</td>
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
