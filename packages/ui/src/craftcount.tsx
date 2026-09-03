import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Input, Modal, Notice, Select, Spinner } from './components';
import {
  shelfLines, submitCount, pendingShelfLines, frozenPieces, frozenBy, pieceKey,
  summariseCount, groupLines, COUNT_REASONS, formatMoney,
  countDraftKey, readCountDraft, saveCountDraft, clearCountDraft,
  countRestoredWords, clearAllWarning,
  type DraftStore,
} from '@snpos/core';
import type { CountLine, CountReason, CountGrouping, Settings, WaitingChange } from '@snpos/core';

/**
 * The shop's shelf, counted at the counter.
 *
 * The bar has counted its bottles in and out of every shift for a while, and
 * the shop had nothing of the kind: it counted when somebody chose to, from a
 * screen in the office. Which means a piece that went missing had a week of
 * shifts to have gone missing on and no way to say whose — and a woven basket
 * walks out of a shop far more easily than a bottle walks out from behind a
 * bar, and is worth more.
 *
 * So the shop is asked the same two questions the bar is: what did you accept,
 * and what are you handing over.
 *
 * WHAT IT DOES NOT DO is move the shelf. The shop's counts go to an admin,
 * which is how every other adjustment in this trade already works and is the
 * whole reason the approvals desk exists — an adjustment is the only write in
 * the shop that can make stock disappear with no sale behind it, so the person
 * holding the clipboard is not also the person who signs it off.
 *
 * Which means a shift can close on a count nobody has approved yet, and that
 * is deliberate. Making the close wait for an admin would mean a cashier
 * standing at a locked till at ten at night waiting for somebody to answer
 * their phone.
 */

export interface CraftCountModalProps {
  venueId: string;
  shiftId: string;
  phase: 'open' | 'close';
  userId: string;
  settings: Settings;
  /** `waived` says whether leaving satisfies the count or merely postpones it. */
  onClose: (waived: boolean) => void;
  dismissLabel?: string;
  /** There is nothing in this shop to count, so stop asking. */
  onEmpty?: () => void;
  onDone: (message: string) => void;
}

type Sheet = { lines: CountLine[]; failed: boolean } | null;

export function CraftCountModal({
  venueId, shiftId, phase, userId, settings, onClose, dismissLabel, onEmpty, onDone,
}: CraftCountModalProps) {
  const [sheet, setSheet] = useState<Sheet>(null);
  const lines = sheet?.lines ?? null;
  const [waiting, setWaiting] = useState<WaitingChange[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [groupBy, setGroupBy] = useState<CountGrouping>('maker');
  const [recovered, setRecovered] = useState<string | null>(null);
  const draftKey = countDraftKey(shiftId, phase);

  /**
   * This device's own store, and nothing if it refuses.
   *
   * Private browsing, a full disk, a policy — none of which is a reason to
   * stop somebody counting.
   */
  const draftStore = (): DraftStore | null => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  };

  const money = (n: number) => formatMoney(n, settings);
  const frozen = useMemo(() => frozenPieces(waiting), [waiting]);

  useEffect(() => {
    void (async () => {
      try {
        const [rows, held] = await Promise.all([
          shelfLines(),
          // Pieces with a change already waiting for an admin. Counting one
          // again would put a SECOND pending difference on the same shelf, and
          // approving both takes the pieces off twice.
          pendingShelfLines().catch(() => [] as WaitingChange[]),
        ]);
        setWaiting(held);

        /*
          WHAT WAS ALREADY TYPED, PUT BACK.

          A shop with four hundred pieces is not counted in one sitting;
          somebody is called to the counter half way through. Leaving the sheet
          used to throw away everything typed so far on the bar's version, and
          the fix there is the fix here.

          The SHEET decides what is on it and the draft only what was typed, so
          a piece delivered this morning still appears and one sold is still
          gone.
        */
        const kept = readCountDraft(draftStore(), draftKey);
        setSheet({
          lines: rows.map((r) => {
            const hit = kept?.lines[pieceKey(r.menuItemId, r.variantId)];
            if (!hit) return r;
            // The reason travels in `note`: a shortage explained as breakage
            // yesterday afternoon must not come back as a plain miscount.
            return {
              ...r,
              countedText: hit.countedText ?? r.countedText,
              reason: (hit.note || r.reason || 'counted') as CountReason,
            };
          }),
          failed: false,
        });
        setRecovered(countRestoredWords(kept));
        if (rows.length === 0) onEmpty?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load the count sheet.');
        // Flagged as failed, not as empty. A sheet nobody could read must not
        // hold the till shut over a count it cannot describe.
        setSheet({ lines: [], failed: true });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId, shiftId, phase]);

  const setLine = (index: number, patch: Partial<CountLine>) =>
    setSheet((s) => {
      if (!s) return s;
      const next = s.lines.map((r, i) => (i === index ? { ...r, ...patch } : r));
      /*
        Kept as it is typed, not on the way out.

        A way out that saves is only half the promise: the till reloads, a
        tablet runs out of battery, and none of those go through any button.
        Written to this device, never to the database — a half-finished count
        is not a count, and filing one would put a number against a shelf
        nobody has finished walking.
      */
      saveCountDraft(draftStore(), draftKey, {
        savedAt: Date.now(),
        lines: Object.fromEntries(
          next
            .filter((l) => (l.countedText ?? '').trim() !== '')
            .map((l) => [
              pieceKey(l.menuItemId, l.variantId),
              { countedText: l.countedText, note: l.reason ?? 'counted' },
            ]),
        ),
      });
      return { ...s, lines: next };
    });

  /** How many pieces have a figure typed against them. */
  const typedCount = (lines ?? []).filter((l) => (l.countedText ?? '').trim() !== '').length;

  /**
   * Wipe the sheet and start again.
   *
   * Asked first, and the question says exactly what goes. Typing over a
   * hundred boxes one at a time is what people do instead, and the box that
   * gets missed is the one that files a wrong number against a shelf.
   */
  const clearAll = () => {
    if (typedCount === 0) return;
    if (!window.confirm(clearAllWarning(typedCount))) return;
    clearCountDraft(draftStore(), draftKey);
    setSheet((s) => (s ? { ...s, lines: s.lines.map((l) => ({ ...l, countedText: '' })) } : s));
    setRecovered(null);
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (lines ?? [])
      .map((line, index) => ({ line, index }))
      .filter(({ line }) =>
        !q || `${line.name} ${line.variantLabel ?? ''} ${line.consignorName ?? ''}`.toLowerCase().includes(q));
  }, [lines, filter]);

  const groups = useMemo(() => groupLines(shown, groupBy), [shown, groupBy]);
  const summary = useMemo(() => summariseCount(lines ?? []), [lines]);

  /**
   * How much of the shop has actually been walked.
   *
   * Countable meaning "not already waiting on an admin". A held piece cannot
   * be counted here, so counting it must not be required either — a sheet that
   * can never be finished is one nobody starts.
   */
  const countable = (lines ?? []).filter((l) => !frozenBy(frozen, l.menuItemId, l.variantId));
  const done = countable.filter((l) => (l.countedText ?? '').trim() !== '').length;
  const left = countable.length - done;

  /*
    Whether there is a way out, and whether the count may be filed.

    A blank line is NOT nought — see wasCounted — so a sheet left half done
    would file the half that was walked and say nothing about the rest, which
    is the same as saying the rest was fine. At close that is a lie somebody
    signs. At open it is merely an unanswered question, so the shop is allowed
    to get on with selling and be asked again.
  */
  const maySkip = phase === 'open' || settings.bar_count_skippable === true || sheet?.failed === true;
  const maySave = !!sheet && !sheet.failed && left === 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const { lines: written } = await submitCount({
        venueId,
        userId,
        shiftId,
        phase,
        lines: (lines ?? []).map((l) =>
          // Held pieces are dropped on the way out as well as disabled on the
          // sheet. A draft restored from this device can carry a figure typed
          // before somebody else's change arrived.
          (frozenBy(frozen, l.menuItemId, l.variantId) ? { ...l, countedText: '' } : l)),
        note: phase === 'open' ? 'Counted in at the start of the shift.' : 'Counted out at the end of the shift.',
      });
      clearCountDraft(draftStore(), draftKey);

      /*
        Said as what actually happened, which is not "saved".

        The shelf has NOT moved. Somebody who reads "saved" walks away
        believing the count is on the system, and finds out at the next
        handover that it was waiting for an admin all along.
      */
      if (written === 0) {
        onDone(phase === 'open'
          ? 'Counted in, and everything is where it should be. The shop is yours.'
          : 'Counted out, and it all balances.');
        return;
      }
      onDone(
        `${written} difference${written === 1 ? '' : 's'} found`
        + `${summary.missingValue > 0 ? `, ${money(summary.missingValue)} of it missing` : ''}. `
        + 'The shelf does not change until an admin approves it.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the count.');
    } finally {
      setBusy(false);
    }
  };

  const title = phase === 'open' ? 'Count the shop in' : 'Count the shop out';

  return (
    <Modal
      title={title}
      wide
      onClose={() => onClose(maySkip)}
      /*
        THERE IS ALWAYS A WAY BACK.

        Leaving goes back to the till with the count still owed: the warning
        stays up, the sheet asks again, and a close will not proceed on it. A
        screen with no way out is not a stricter rule, it is a stuck till — and
        the way people get out of a stuck till is by force-closing the browser,
        which loses whatever they had already typed.
      */
      dismissible
      footer={
        <>
          <Button variant="ghost" onClick={() => onClose(maySkip)}>
            {maySkip
              ? (dismissLabel ?? (phase === 'open' ? 'Not now' : 'Cancel'))
              : 'Back — count later'}
          </Button>
          {/* Only where there is something to clear, so it is not a button
              somebody presses to find out what it does. */}
          {typedCount > 0 && <Button variant="ghost" onClick={clearAll}>Clear all</Button>}
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!maySave}>
            {left > 0 ? `${left} still to count` : title}
          </Button>
        </>
      }
    >
      {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

      {/* Numbers already on a sheet that was expected to be blank are either a
          relief or a warning, and which one depends on knowing they are yours
          from earlier rather than somebody else's guess. */}
      {recovered && <Notice tone="info">{recovered}</Notice>}

      {sheet === null ? (
        <Spinner />
      ) : sheet.lines.length === 0 ? (
        <p className="small dim">
          There is nothing in the shop to count yet. Add products, or book a delivery in, and this will
          ask for them.
        </p>
      ) : (
        <>
          <div className="row row-wrap" style={{ gap: '0.5rem', marginBottom: '0.8rem' }}>
            <Input
              placeholder="Find a piece"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ flex: 1, minWidth: '9rem' }}
            />
            {/* A shop counts one maker's shelf at a time, or one kind of thing
                at a time, because that is how the room is laid out. */}
            <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as CountGrouping)}>
              <option value="maker">By maker</option>
              <option value="category">By shelf</option>
              <option value="none">One list</option>
            </Select>
            <Badge tone={left === 0 ? 'ok' : 'default'}>{done} of {countable.length} counted</Badge>
          </div>

          {/* Blank is not nought, and this is the one screen where confusing
              the two writes off a shop. */}
          <p className="small dim" style={{ marginTop: 0 }}>
            Type what is actually there, including <strong>0</strong> for anything that has gone. A blank
            box is not nought — it means nobody looked.
          </p>

          {groups.map((group) => (
            <div key={group.key} style={{ marginBottom: '0.9rem' }}>
              {group.label && (
                <div className="spread" style={{ marginBottom: '0.3rem' }}>
                  <strong className="small">{group.label}</strong>
                  <span className="small dim">{group.counted} of {group.total}</span>
                </div>
              )}
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Piece</th>
                      <th className="num">Should be</th>
                      <th style={{ width: '6.5rem' }}>Actually</th>
                      <th style={{ width: '11rem' }}>If it differs, why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.lines.map(({ line, index }) => {
                      const typed = (line.countedText ?? '').trim();
                      const counted = typed === '' ? null : Number(typed);
                      const delta = counted === null || !Number.isFinite(counted)
                        ? null
                        : counted - line.onHand;
                      const held = frozenBy(frozen, line.menuItemId, line.variantId);
                      return (
                        <tr key={`${line.menuItemId}-${line.variantId ?? ''}`}>
                          <td>
                            <div style={{ fontWeight: 550 }}>{line.name}</div>
                            {line.variantLabel && <div className="small dim">{line.variantLabel}</div>}
                          </td>
                          <td className="num">{line.onHand}</td>
                          <td>
                            <Input
                              type="number"
                              min="0"
                              step="1"
                              inputMode="numeric"
                              placeholder={held ? 'held' : '—'}
                              value={held ? '' : line.countedText ?? ''}
                              onChange={(e) => setLine(index, { countedText: e.target.value })}
                              disabled={!!held}
                            />
                          </td>
                          <td>
                            {held ? (
                              <span className="small" style={{ color: 'var(--warn)' }}>
                                A change to {held.line.counted} is already waiting for an admin.
                              </span>
                            ) : delta !== null && delta < 0 ? (
                              <Select
                                value={line.reason ?? 'counted'}
                                onChange={(e) => setLine(index, { reason: e.target.value as CountReason })}
                              >
                                {COUNT_REASONS.map((r) => (
                                  <option key={r.value} value={r.value}>{r.label}</option>
                                ))}
                              </Select>
                            ) : (
                              <span className="dim small">
                                {delta === null ? '' : delta > 0 ? `${delta} more than expected` : 'Matches'}
                              </span>
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

          {summary.differences.length > 0 && (
            <Notice tone="warn">
              {summary.missingPieces > 0 && (
                <>
                  {summary.missingPieces} piece{summary.missingPieces === 1 ? '' : 's'} missing,
                  worth {money(summary.missingValue)}.{' '}
                </>
              )}
              {summary.surplusPieces > 0 && (
                <>{summary.surplusPieces} more than expected.{' '}</>
              )}
              Nothing on the shelf changes until an admin approves this.
            </Notice>
          )}
        </>
      )}
    </Modal>
  );
}
