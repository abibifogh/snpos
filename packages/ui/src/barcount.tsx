import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Field, Input, Modal, Notice, Spinner } from './components';
import {
  barCountSheet, saveBarCount, byUnit, summariseBarCount, readyToClose, readyToAccept,
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
  settings: Settings;
  /** Dismissed without finishing. The count is not saved; nothing is written. */
  onClose: () => void;
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

export function BarCountModal({
  venueId, shiftId, phase, userId, settings, onClose, dismissLabel, onEmpty, onDone,
}: BarCountModalProps) {
  const [lines, setLines] = useState<BarCountLine[] | null>(null);
  const [places, setPlaces] = useState<StockLocation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

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
        const sheet = await barCountSheet(venueId, saleLocation(bar, 'bar')?.$id);
        setLines(sheet);
        if (sheet.length === 0) onEmpty?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load the count sheet.');
        setLines([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId]);

  const setLine = (id: string, patch: Partial<BarCountLine>) =>
    setLines((rows) => (rows ?? []).map((r) => (r.ingredientId === id ? { ...r, ...patch } : r)));

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (lines ?? []).filter((l) => !q || l.name.toLowerCase().includes(q));
  }, [lines, filter]);

  const groups = useMemo(() => byUnit(shown), [shown]);
  const summary = useMemo(() => summariseBarCount(lines ?? []), [lines]);
  // Two different gates. Counting in has nothing to escalate; counting out
  // does. See readyToAccept and readyToClose.
  const check = useMemo(
    () => (phase === 'open' ? readyToAccept(lines ?? []) : readyToClose(lines ?? [])),
    [lines, phase],
  );

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const { written, shortValue } = await saveBarCount({
        venueId,
        shiftId,
        locationId: saleLocation(places, 'bar')?.$id,
        phase,
        lines: lines ?? [],
        userId,
      });
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
      onClose={onClose}
      footer={
        <>
          {/* Not a refusal. A bar opens when the doors open, and a till that
              would not let somebody start serving until forty bottles had been
              counted is a till they work around. The nag on the shift bar is
              what keeps it honest. */}
          <Button variant="ghost" onClick={onClose}>
            {dismissLabel ?? (phase === 'open' ? 'Not now' : 'Cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            loading={busy}
            disabled={summary.countedLines === 0}
          >
            {counting}
          </Button>
        </>
      }
    >
      {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

      <p className="small dim" style={{ marginTop: 0 }}>
        {phase === 'open'
          ? 'Count what is actually behind the bar before service starts. It is usually what last night left, '
            + 'and the times it is not — a delivery overnight, a bottle taken for a function — are exactly the '
            + 'times a shortage gets argued about later.'
          : 'Count what you are handing over. The difference between this and what the sales say should be left '
            + 'is the figure the whole bar stock system exists to produce.'}
      </p>

      {!lines ? (
        <Spinner />
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

          {!check.clear && <Notice tone="warn">{check.reason}</Notice>}

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
