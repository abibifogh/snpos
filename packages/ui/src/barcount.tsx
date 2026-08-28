import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Field, Input, Modal, Notice, Spinner } from './components';
import {
  barCountSheet, saveBarCount, byUnit, summariseBarCount, countGate,
  countDraftKey, readCountDraft, saveCountDraft, restoreCount, draftFromCount, clearCountDraft,
  type DraftStore,
  formatMoney, loadLocations, saleLocation,
} from '@snpos/core';
import type { BarCountLine, Settings, StockLocation } from '@snpos/core';

/**
 * The bar's bottles, counted at the till.
 *
 * This screen exists because the count was in the wrong place. It lived under
 * Admin, which is where the person who reads the variances sits — not where
 * the person holding the bottles stands. A count somebody has to leave the
 * till to make is a count that does not get made, and an opening count that
 * does not get made turns every shortage into an argument about which shift
 * it belongs to.
 *
 * So it is put in front of whoever is opening or closing the bar, on the
 * device already in their hand, at the only two moments it means anything.
 */

export interface BarCountModalProps {
  venueId: string;
  shiftId: string;
  phase: 'open' | 'close';
  userId: string;
  /**
   * Whether the person at this till may count the held-back rows.
   *
   * A bartender counts what leaves the bar whole. Spirits wait for a manager,
   * and that is the whole reason they are kept off this sheet.
   */
  isManager?: boolean;
  settings: Settings;
  /** Dismissed without finishing. The count is not saved; nothing is written. */
  /**
   * Leave the sheet.
   *
   * `waived` says whether leaving SATISFIES the count or merely postpones it.
   * True where an admin has allowed counts to be left unfinished, or where
   * there was nothing to count; false where the count is still owed, and the
   * caller must not treat the shift as counted.
   */
  onClose: (waived: boolean) => void;
  /**
   * What walking away is called here.
   *
   * Worth saying plainly rather than "Cancel", because the two ends of a shift
   * mean different things by it: at the start nothing has happened yet, at the
   * end the shift is about to close on a shelf nobody looked at.
   */
  dismissLabel?: string;
  /**
   * There is nothing on this bar to count.
   *
   * Told to the caller so it can stop asking. A bar that has not had its
   * bottles set up yet would otherwise be warned every shift that it skipped a
   * count of nothing, and a warning that cannot be satisfied is one people
   * learn to read past — including on the night it finally means something.
   */
  onEmpty?: () => void;
  onDone: (message: string) => void;
}

/** An empty sheet is not a loading one. Told apart so neither traps anybody. */
type Sheet = { lines: BarCountLine[]; failed: boolean } | null;

export function BarCountModal({
  venueId, shiftId, phase, userId, settings, isManager, onClose, dismissLabel, onEmpty, onDone,
}: BarCountModalProps) {
  const [sheet, setSheet] = useState<Sheet>(null);
  const lines = sheet?.lines ?? null;
  const [places, setPlaces] = useState<StockLocation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  /** Numbers were already on this sheet when it opened. Said, not assumed. */
  const [recovered, setRecovered] = useState(false);
  /** Which room this sheet is for, so two shelves cannot restore each other. */
  const [draftKey, setDraftKey] = useState(() => countDraftKey(shiftId, phase));

  /**
   * This device's own store, and nothing if it refuses.
   *
   * Private browsing, a full disk, a policy — none of which is a reason to
   * stop somebody counting. Every draft call takes null happily.
   */
  const draftStore = (): DraftStore | null => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  };

  const money = (n: number) => formatMoney(n, settings);

  /*
    The bar itself, never the store room.

    A bartender coming on shift accepts what is BEHIND THE BAR. The store room
    is walked every few weeks by somebody with a clipboard, and folding it into
    a handover would have every shift signing for a room they never open. The
    admin page still offers the choice; here there is only one right answer, so
    it is not asked.
  */
  useEffect(() => {
    void (async () => {
      try {
        const where = await loadLocations(venueId).catch(() => [] as StockLocation[]);
        const bar = where.filter((l) => (l.module ?? 'kitchen') === 'bar' && l.active !== false);
        setPlaces(bar);
        /*
          A bartender's sheet, so the manager-only rows are not on it.

          Left off rather than shown greyed: a sheet with rows nobody at this
          till can fill reports itself unfinished for ever and can never be
          sent, which would block every close on the bar.
        */
        const rows = await barCountSheet(venueId, saleLocation(bar, 'bar')?.$id, isManager === true);
        /*
          WHAT WAS ALREADY TYPED, PUT BACK.

          A count of forty bottles is not one sitting: somebody is called to
          the bar half way through it. Leaving the sheet used to throw away
          everything typed so far, which made the way out useless — the only
          safe move was to stand there until it was finished.

          The SHEET decides what is on it and the draft only what was typed,
          so a bottle added this morning still appears and one taken off is
          still gone. See restoreCount.
        */
        const key = countDraftKey(shiftId, phase, saleLocation(bar, 'bar')?.$id);
        setDraftKey(key);
        const kept = readCountDraft(draftStore(), key);
        setSheet({ lines: restoreCount(rows, kept), failed: false });
        if (kept) setRecovered(true);
        if (rows.length === 0) onEmpty?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load the count sheet.');
        // Flagged as failed, not as empty. A sheet nobody could read must not
        // hold the till shut over a count it cannot describe.
        setSheet({ lines: [], failed: true });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId]);

  const setLine = (id: string, patch: Partial<BarCountLine>) =>
    setSheet((s) => {
      if (!s) return s;
      const lines = s.lines.map((r) => (r.ingredientId === id ? { ...r, ...patch } : r));
      /*
        Kept as it is typed, not on the way out.

        A way out that saves is only half the promise: the till reloads, a
        browser is closed, a tablet runs out of battery, and none of those go
        through any button. Written to this device, never to the database — a
        half-finished count is not a count, and filing one would put a number
        against a shelf nobody has finished walking.
      */
      saveCountDraft(draftStore(), draftKey, draftFromCount(lines));
      return { ...s, lines };
    });

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (lines ?? []).filter((l) => !q || l.name.toLowerCase().includes(q));
  }, [lines, filter]);

  const groups = useMemo(() => byUnit(shown), [shown]);
  const summary = useMemo(() => summariseBarCount(lines ?? []), [lines]);
  /*
    Whether there is a way out of here, and whether the count can be filed.

    Both from one place. Two screens deciding separately is how you get a
    button that saves what the other half of the screen says is unfinished.
    While the sheet is still loading the gate is left open: nobody should be
    shut in by a question that has not arrived yet.
  */
  const gate = useMemo(
    () => (sheet
      ? countGate({ lines: sheet.lines, phase, skippable: settings.bar_count_skippable, loadFailed: sheet.failed })
      : { maySkip: true, maySave: false }),
    [sheet, phase, settings.bar_count_skippable],
  );

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const { written, shortValue, failed } = await saveBarCount({
        venueId,
        shiftId,
        locationId: saleLocation(places, 'bar')?.$id,
        phase,
        lines: lines ?? [],
        userId,
      });
      /*
        Stopped here rather than waved through with a cheerful message.

        A count is allowed to lose a line without abandoning the rest — see
        tryWrite — but a bar counted out on a part-saved sheet hands the next
        person a shelf that does not match the room, and the shift closes on
        it. So the sheet stays open and says so, which is the one moment
        somebody can still put it right.
      */
      // Filed, so the half-finished copy has nothing left to protect.
      clearCountDraft(draftStore(), draftKey);
      if (failed > 0) {
        setError(
          `${failed} line${failed === 1 ? '' : 's'} did not save. Nothing else has been touched — try the `
          + 'count again. If it keeps happening, tell an admin before closing the shift.',
        );
        return;
      }
      onDone(
        phase === 'open'
          ? `${written} line${written === 1 ? '' : 's'} counted in. The bar is yours.`
          : shortValue > 0
            ? `Counted out. ${money(shortValue)} short — an admin can see it under Bar counts.`
            : 'Counted out, and it balances.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the count.');
    } finally {
      setBusy(false);
    }
  };

  const counting = phase === 'open' ? 'Count the bar in' : 'Count the bar out';

  return (
    <Modal
      title={phase === 'open' ? 'Count the bar in' : 'Count the bar out'}
      wide
      onClose={() => onClose(gate.maySkip)}
      /*
        THERE IS ALWAYS A WAY BACK.

        There used to be no way out of a count that could not be skipped: no
        ✕, no button, nothing. The reasoning was that an exit which does not
        finish the count is a way to record it as done — and that is true of
        SKIPPING, which is not the same thing as leaving.

        Leaving goes back to the till with the count still owed: the warning
        stays up, the sheet asks again, and a close will not proceed on it. A
        screen with no way out is not a stricter rule, it is a stuck till —
        and the way people get out of a stuck till is by force-closing the
        browser, which loses whatever they had already typed.
      */
      dismissible
      footer={
        <>
          <Button variant="ghost" onClick={() => onClose(gate.maySkip)}>
            {gate.maySkip
              ? (dismissLabel ?? (phase === 'open' ? 'Not now' : 'Cancel'))
              // Says what happens, because it is not what the other label
              // means: the count is still owed on the other side of this.
              : 'Back — count later'}
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            loading={busy}
            disabled={!gate.maySave}
          >
            {counting}
          </Button>
        </>
      }
    >
      {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

      {/* Said, not left to be noticed. Numbers already on a sheet that was
          expected to be blank are either a relief or a warning, and which one
          depends on knowing they are yours from earlier rather than somebody
          else's guess. */}
      {recovered && (
        <Notice tone="info">
          Picking up where this sheet was left. What was already typed is still here — check it still matches
          the shelf before filing the count.
        </Notice>
      )}

      <p className="small dim" style={{ marginTop: 0 }}>
        {phase === 'open'
          ? 'Count what is actually behind the bar before service starts. It is usually what last night left, '
            + 'and the times it is not — a delivery overnight, a bottle taken for a function — are exactly the '
            + 'times a shortage gets argued about later.'
          : 'Count what you are handing over. The difference between this and what the sales say should be left '
            + 'is the figure the whole bar stock system exists to produce.'}
        {/* Says what saving needs AND what leaving means, now that leaving is
            possible. Half of that on its own reads as either a wall or a
            waiver, and it is neither. */}
        {!gate.maySkip && lines && lines.length > 0 && (
          <>
            {' '}<strong>Every line has to be answered to file this count.</strong> You can go back and
            finish it later — the shift will keep asking, and it cannot be closed until it is done. An admin
            can allow counts to be left unfinished under Settings, Stock.
          </>
        )}
      </p>

      {!lines ? (
        <Spinner />
      ) : sheet?.failed ? (
        <Notice tone="warn">
          The count sheet could not be loaded, so the shift is not being held up over it. Try again from Bar
          counts once the connection is back.
        </Notice>
      ) : lines.length === 0 ? (
        <Notice tone="info">
          Nothing is set up for the bar to count yet. An admin adds bottles and mixers under Bar, Bottles &amp;
          mixers, and ticks the ones counted every shift.
        </Notice>
      ) : (
        <>
          <div className="row row-wrap" style={{ gap: '1.4rem', alignItems: 'flex-end' }}>
            <div>
              <div className="dim small">Counted so far</div>
              <div style={{ fontSize: '1.3rem', fontWeight: 650 }}>
                {summary.countedLines} of {lines.length}
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

          {gate.reason && <Notice tone="warn">{gate.reason}</Notice>}

          {/* Only worth a search box on a sheet long enough to scroll. */}
          {lines.length > 12 && (
            <Field label="Search">
              <Input value={filter} placeholder="Club, tonic…" onChange={(e) => setFilter(e.target.value)} />
            </Field>
          )}

          {groups.map((group) => (
            <div key={group.unit} style={{ marginTop: '1rem' }}>
              <div className="spread" style={{ marginBottom: '0.35rem' }}>
                <strong>{group.label}</strong>
                <Badge tone={group.counted === group.total ? 'ok' : 'default'}>
                  {group.counted} of {group.total}
                </Badge>
              </div>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>What</th>
                      <th className="num">Should be</th>
                      <th style={{ width: '7rem' }}>Actually</th>
                      <th className="num">Difference</th>
                      <th style={{ width: '11rem' }}>Note</th>
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
                              : (
                                <Badge tone={delta < 0 ? 'danger' : 'warn'}>
                                  {delta > 0 ? `+${delta}` : delta}
                                </Badge>
                              )}
                          </td>
                          <td>
                            {/* Only where there is something to explain. A note
                                box on every line is forty boxes nobody fills. */}
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
            </div>
          ))}
        </>
      )}
    </Modal>
  );
}
