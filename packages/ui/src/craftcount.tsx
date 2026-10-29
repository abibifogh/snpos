import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Input, Modal, Notice, Spinner } from './components';
import {
  shelfLines, submitCount, pendingShelfLines, frozenPieces, frozenBy, pieceKey,
  summariseCount, COUNT_REASONS, formatMoney, timeWords,
  countDraftKey, readCountDraft, saveCountDraft, clearCountDraft, clearAllWarning,
  shopCountRules, countParts, partIndexes, typed, resumeWords, FULL_COUNT_DAYS,
  movedThisShift, loadServerDraft, saveServerDraft, clearServerDraft,
  type DraftStore,
} from '@snpos/core';
import type { CountLine, CountReason, Settings, WaitingChange, CountDraftLine } from '@snpos/core';

/**
 * The shop's shelf, counted at the counter.
 *
 * The shop is asked the same two questions the bar is: what did you accept,
 * and what are you handing over. What it does NOT do is move the shelf: the
 * count goes to an admin, because an adjustment is the only write in the shop
 * that can make stock disappear with no sale behind it.
 *
 * SHORT, SAVED AS YOU GO, ONE TAP A PIECE.
 *
 * It used to ask for every piece in the shop, in long tables by maker, kept
 * only on the tablet it was typed on. A sheet that long is scrolled through or
 * abandoned, and one lost to a reload is typed again or not at all. So:
 *
 *   - Tonight's pieces only: sold or moved this shift, the valuable ones, and
 *     one shelf in turn, with the whole shop on the full-count day. See
 *     countParts in shop-count.ts and the admin's choices under Settings.
 *   - Kept on the server on every tap, as well as on the device, so it comes
 *     back on any till saying who counted how far and when.
 *   - A card per piece, one part at a time. A piece that matches is one tap,
 *     All here; the stepper is for the ones that do not.
 *   - Then only what did not match, to check before it goes to an admin.
 *
 * A shift can still close on a count nobody has approved yet, deliberately:
 * making the close wait for an admin would leave a cashier at a locked till.
 */

export interface CraftCountModalProps {
  venueId: string;
  shiftId: string;
  phase: 'open' | 'close';
  userId: string;
  /** Who is counting, for "Esi counted 14 of 38" on the next till. */
  userName?: string;
  settings: Settings;
  /** `waived` says whether leaving satisfies the count or merely postpones it. */
  onClose: (waived: boolean) => void;
  dismissLabel?: string;
  /** There is nothing in this shop to count, so stop asking. */
  onEmpty?: () => void;
  onDone: (message: string) => void;
}

type Sheet = { lines: CountLine[]; failed: boolean } | null;
type Stage = 'start' | 'count' | 'review';
type Saved = { state: 'saving' | 'server' | 'device'; at: number } | null;

/** How long after the last tap the count is sent to the server. */
const SAVE_AFTER_MS = 800;

export function CraftCountModal({
  venueId, shiftId, phase, userId, userName, settings, onClose, dismissLabel, onEmpty, onDone,
}: CraftCountModalProps) {
  const [sheet, setSheet] = useState<Sheet>(null);
  const lines = sheet?.lines ?? null;
  const [waiting, setWaiting] = useState<WaitingChange[]>([]);
  const [moved, setMoved] = useState<Set<string>>(new Set());
  const [stage, setStage] = useState<Stage>('start');
  const [partAt, setPartAt] = useState(0);
  const [filter, setFilter] = useState('');
  const [resumed, setResumed] = useState<{ who: string; at: string | number; done?: number; total?: number } | null>(null);
  const [saved, setSaved] = useState<Saved>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftKey = countDraftKey(shiftId, phase);
  // Today, fixed for as long as the sheet is open: a count started at 11:58 pm
  // must not change shelves under somebody's fingers at midnight.
  const day = useMemo(() => new Date(), []);
  const pending = useRef<number | undefined>(undefined);
  const flushRef = useRef<(() => void) | null>(null);

  const draftStore = (): DraftStore | null => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  };

  const money = (n: number) => formatMoney(n, settings);
  const rules = shopCountRules(settings);
  const frozen = useMemo(() => frozenPieces(waiting), [waiting]);

  useEffect(() => {
    void (async () => {
      try {
        const [rows, held, wentOut, server] = await Promise.all([
          shelfLines(),
          // Pieces with a change already waiting for an admin are left off:
          // counting one again would put a second difference on the shelf.
          pendingShelfLines().catch(() => [] as WaitingChange[]),
          movedThisShift(shiftId),
          loadServerDraft(shiftId, phase),
        ]);
        setWaiting(held);
        setMoved(wentOut);

        /*
          WHAT WAS ALREADY TYPED, PUT BACK, from whichever copy is newer.

          The server's copy is what another till typed; this device's is what
          was typed here, possibly offline. The SHEET decides what is on it and
          the draft only what was typed, so a piece delivered since still
          appears and one sold is still gone.
        */
        const local = readCountDraft(draftStore(), draftKey);
        const serverAt = server ? Date.parse(server.savedAt) || 0 : 0;
        const useServer = !!server && Object.keys(server.lines).length > 0 && serverAt >= (local?.savedAt ?? 0);
        const kept: Record<string, CountDraftLine> | undefined = useServer ? server!.lines : local?.lines;
        setSheet({
          lines: rows.map((r) => {
            const hit = kept?.[pieceKey(r.menuItemId, r.variantId)];
            if (!hit) return r;
            return {
              ...r,
              countedText: hit.countedText ?? r.countedText,
              reason: (hit.note || r.reason) as CountReason | undefined,
            };
          }),
          failed: false,
        });
        if (useServer) {
          setResumed({ who: server!.savedByName, at: server!.savedAt, done: server!.done, total: server!.total });
        } else if (local && Object.keys(local.lines).length > 0) {
          setResumed({ who: 'You', at: local.savedAt ?? Date.now() });
        }
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

  // Whatever is still waiting to go to the server goes when the sheet closes.
  useEffect(() => () => flushRef.current?.(), []);

  const heldKeys = useMemo(() => new Set((lines ?? [])
    .filter((l) => frozenBy(frozen, l.menuItemId, l.variantId))
    .map((l) => pieceKey(l.menuItemId, l.variantId))), [lines, frozen]);

  const parts = useMemo(
    () => countParts({ lines: lines ?? [], rules, day, moved, held: heldKeys, money }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lines, moved, heldKeys, settings, day],
  );
  const asked = useMemo(() => partIndexes(parts), [parts]);
  const askedSet = useMemo(() => new Set(asked), [asked]);
  const isDone = (i: number) => !!lines && typed(lines[i]);
  const done = asked.filter(isDone).length;
  const left = asked.length - done;
  const partLeft = (p: { indexes: number[] }) => p.indexes.filter((i) => !isDone(i)).length;

  /** What is typed, in the shape both copies keep. */
  const draftOf = (next: CountLine[]): Record<string, CountDraftLine> => Object.fromEntries(
    next
      .filter((l) => typed(l) || !!l.reason)
      .map((l) => [pieceKey(l.menuItemId, l.variantId), { countedText: l.countedText ?? '', note: l.reason ?? '' }]),
  );

  /**
   * Kept as it is typed: on this device at once, and on the server a moment
   * after the last tap. The screen says which, so "saved" is never a guess.
   */
  const keep = (next: CountLine[]) => {
    const map = draftOf(next);
    saveCountDraft(draftStore(), draftKey, { savedAt: Date.now(), lines: map });
    const doneNow = asked.filter((i) => typed(next[i])).length;
    const send = () => {
      pending.current = undefined;
      flushRef.current = null;
      void saveServerDraft({
        venueId, shiftId, phase, lines: map, done: doneNow, total: asked.length, userId, userName,
      }).then((ok) => setSaved({ state: ok ? 'server' : 'device', at: Date.now() }));
    };
    setSaved({ state: 'saving', at: Date.now() });
    window.clearTimeout(pending.current);
    pending.current = window.setTimeout(send, SAVE_AFTER_MS);
    flushRef.current = () => { window.clearTimeout(pending.current); send(); };
  };

  const setLine = (index: number, patch: Partial<CountLine>) =>
    setSheet((s) => {
      if (!s) return s;
      const next = s.lines.map((r, i) => (i === index ? { ...r, ...patch } : r));
      keep(next);
      return { ...s, lines: next };
    });

  const typedCount = (lines ?? []).filter(typed).length;

  /** Wipe the sheet and start again: asked first, saying exactly what goes. */
  const clearAll = () => {
    if (typedCount === 0) return;
    if (!window.confirm(clearAllWarning(typedCount))) return;
    window.clearTimeout(pending.current);
    flushRef.current = null;
    clearCountDraft(draftStore(), draftKey);
    void clearServerDraft(shiftId, phase);
    setSheet((s) => (s ? { ...s, lines: s.lines.map((l) => ({ ...l, countedText: '', reason: undefined })) } : s));
    setResumed(null);
    setSaved(null);
    setStage('start');
  };

  const summary = useMemo(
    () => summariseCount((lines ?? []).filter((_, i) => askedSet.has(i))),
    [lines, askedSet],
  );

  /*
    Whether there is a way out, and whether the count may be filed.

    A blank line is NOT nought, so a sheet left half done would file the half
    that was walked and say nothing about the rest. At close that is a lie
    somebody signs; at open it is an unanswered question, and the shop may get
    on with selling and be asked again.
  */
  const maySkip = phase === 'open' || settings.bar_count_skippable === true || sheet?.failed === true;
  // Nothing asked (every piece is waiting for an admin) still files: the shift answered.
  const maySave = !!sheet && !sheet.failed && left === 0;

  const leave = () => {
    flushRef.current?.();
    onClose(maySkip);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      window.clearTimeout(pending.current);
      flushRef.current = null;
      const { lines: written } = await submitCount({
        venueId,
        userId,
        shiftId,
        phase,
        // Only tonight's pieces, and never a held one: a draft restored from
        // earlier can carry a figure typed before somebody else's change came.
        lines: (lines ?? []).map((l, i) => (!askedSet.has(i) || frozenBy(frozen, l.menuItemId, l.variantId)
          ? { ...l, countedText: '' } : l)),
        note: phase === 'open' ? 'Counted in at the start of the shift.' : 'Counted out at the end of the shift.',
      });
      clearCountDraft(draftStore(), draftKey);
      void clearServerDraft(shiftId, phase);

      // Said as what happened, which is not "saved": the shelf has NOT moved.
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
  const part = parts[Math.min(partAt, Math.max(parts.length - 1, 0))];

  /** Into the count: the first part with something left, or the one asked for. */
  const goCount = (at?: number) => {
    const first = parts.findIndex((p) => partLeft(p) > 0);
    setPartAt(at ?? (first >= 0 ? first : 0));
    setFilter('');
    setStage('count');
  };
  const nextPart = () => {
    const after = parts.findIndex((p, i) => i > partAt && partLeft(p) > 0);
    const any = parts.findIndex((p) => partLeft(p) > 0);
    if (after >= 0) setPartAt(after);
    else if (any >= 0) setPartAt(any);
    else setStage('review');
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!lines) return [];
    if (q) {
      return asked.filter((i) => {
        const l = lines[i];
        return `${l.name} ${l.variantLabel ?? ''} ${l.consignorName ?? ''}`.toLowerCase().includes(q);
      });
    }
    return part?.indexes ?? [];
  }, [filter, lines, asked, part]);

  const savedChip = saved && (
    <span className={`shopcount-saved${saved.state === 'device' ? ' is-local' : ''}`} role="status">
      {saved.state === 'saving' ? 'Saving…'
        : saved.state === 'server' ? `Saved · ${timeWords(saved.at)}`
          : 'Saved on this till only, will try again'}
    </span>
  );

  const fullWords = FULL_COUNT_DAYS.find((d) => d.value === rules.full)?.label ?? '';
  const wholeShop = (lines ?? []).length;
  const isAll = parts.length === 1 && parts[0].key === 'all';

  const footer = stage === 'start' ? (
    <>
      <Button variant="ghost" onClick={leave}>
        {maySkip ? (dismissLabel ?? (phase === 'open' ? 'Not now' : 'Cancel')) : 'Back, count later'}
      </Button>
      {typedCount > 0 && <Button variant="ghost" onClick={clearAll}>Clear all</Button>}
      {left === 0
        ? <Button variant="primary" onClick={() => setStage('review')}>Check and send</Button>
        : <Button variant="primary" onClick={() => goCount()}>{done > 0 ? 'Carry on counting' : 'Start counting'}</Button>}
    </>
  ) : stage === 'count' ? (
    <>
      <Button variant="ghost" onClick={leave}>{maySkip ? (dismissLabel ?? 'Not now') : 'Back, it is saved'}</Button>
      <Button variant="ghost" onClick={() => setStage('start')}>All parts</Button>
      <Button variant="primary" onClick={nextPart}>
        {left === 0 ? 'Check and send' : (part && partLeft(part) > 0 ? `${partLeft(part)} left here · next part` : 'Next part')}
      </Button>
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={() => goCount()}>Back to counting</Button>
      <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!maySave}>
        {left > 0 ? `${left} still to count` : summary.differences.length === 0 ? title : 'Send the count to an admin'}
      </Button>
    </>
  );

  return (
    <Modal title={title} wide onClose={leave} dismissible footer={footer}>
      {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

      {sheet === null ? (
        <Spinner />
      ) : sheet.lines.length === 0 ? (
        <p className="small dim">
          There is nothing in the shop to count yet. Add products, or book a delivery in, and this will ask for them.
        </p>
      ) : stage === 'start' ? (
        <div className="stack" style={{ gap: '1rem' }}>
          {resumed && done > 0 && (
            <Notice tone="info">
              <strong>You were part way through.</strong>{' '}
              {resumeWords({
                who: resumed.who, done: resumed.done ?? done, total: resumed.total ?? asked.length,
                at: resumed.at, time: (at) => timeWords(at),
              })}
            </Notice>
          )}
          <div className="spread" style={{ alignItems: 'baseline' }}>
            <h3 style={{ margin: 0 }}>
              {isAll ? `Today: the whole shop, ${asked.length} pieces` : `Tonight: ${asked.length} pieces`}
              {!isAll && wholeShop > asked.length && <span className="small dim" style={{ fontWeight: 400 }}> · not all {wholeShop} in the shop</span>}
            </h3>
            {savedChip}
          </div>
          <div className="shopcount-parts">
            {parts.map((p, i) => {
              const n = p.indexes.length;
              const leftHere = partLeft(p);
              return (
                <button key={p.key} type="button" className="shopcount-part" onClick={() => goCount(i)}>
                  <span className="spread">
                    <strong>{p.title}</strong>
                    <Badge tone={leftHere === 0 ? 'ok' : n - leftHere > 0 ? 'warn' : 'default'}>
                      {leftHere === 0 ? 'Done' : `${n - leftHere} of ${n}`}
                    </Badge>
                  </span>
                  <span className="small dim">{p.why}</span>
                  <span className="big">{n}</span>
                </button>
              );
            })}
          </div>
          <p className="small dim" style={{ margin: 0 }}>
            {isAll ? 'Every piece today. ' : rules.full === 'never'
              ? 'The whole shop is counted when an admin starts a full count. '
              : `The whole shop is counted ${fullWords.charAt(0).toLowerCase()}${fullWords.slice(1)}. `}
            {heldKeys.size > 0 && `${heldKeys.size} piece${heldKeys.size === 1 ? ' is' : 's are'} waiting for an admin and left off. `}
            Every tap is saved as you go.
          </p>
        </div>
      ) : stage === 'count' ? (
        <div className="stack" style={{ gap: '0.8rem' }}>
          <div className="spread" style={{ gap: '0.8rem' }}>
            <strong>{done} of {asked.length} counted</strong>
            {savedChip}
          </div>
          <div className="shopcount-bar" role="img" aria-label={`${done} of ${asked.length} counted`}>
            <span style={{ width: `${asked.length ? Math.round((done / asked.length) * 100) : 0}%` }} />
          </div>
          <div className="shopcount-layout">
            <nav className="shopcount-rail" aria-label="Parts of tonight's count">
              {parts.map((p, i) => {
                const leftHere = partLeft(p);
                return (
                  <button
                    key={p.key}
                    type="button"
                    className="shopcount-part"
                    aria-current={!filter && i === partAt ? 'true' : undefined}
                    onClick={() => { setPartAt(i); setFilter(''); }}
                  >
                    <strong className="small">{p.title}</strong>
                    <span className="small dim">{leftHere === 0 ? `All ${p.indexes.length} done` : `${p.indexes.length - leftHere} of ${p.indexes.length}`}</span>
                  </button>
                );
              })}
            </nav>
            <div className="shopcount-main">
              <Input placeholder="Find a piece tonight" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <p className="small dim" style={{ margin: 0 }}>
                {filter ? `${shown.length} found.` : part?.why} Tap All here when it matches; use − and + only when it does not.
              </p>
              <div className="shopcount-cards">
                {shown.map((i) => (
                  <PieceCard key={pieceKey(lines![i].menuItemId, lines![i].variantId)} line={lines![i]} onChange={(patch) => setLine(i, patch)} />
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="stack" style={{ gap: '1rem' }}>
          <div className="spread"><h3 style={{ margin: 0 }}>Check what does not match</h3>{savedChip}</div>
          <div className="grid-3" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '0.7rem' }}>
            <div className="shopcount-card"><span className="small dim">Matched</span><strong style={{ fontSize: '1.6rem' }}>{asked.length - summary.differences.length}</strong></div>
            <div className="shopcount-card"><span className="small dim">Do not match</span><strong style={{ fontSize: '1.6rem' }}>{summary.differences.length}</strong></div>
            <div className="shopcount-card"><span className="small dim">Missing, at selling price</span><strong style={{ fontSize: '1.6rem' }}>{money(summary.missingValue)}</strong></div>
          </div>
          {summary.differences.length === 0 ? (
            <Notice tone="ok">Everything matched. Nothing for an admin to decide.</Notice>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Piece</th><th className="num">Should be</th><th className="num">Counted</th><th>Why</th><th /></tr></thead>
                <tbody>
                  {summary.differences.map((d) => {
                    const at = (lines ?? []).indexOf(d.line);
                    const p = parts.findIndex((x) => x.indexes.includes(at));
                    return (
                      <tr key={pieceKey(d.line.menuItemId, d.line.variantId)}>
                        <td><strong>{d.line.name}{d.line.variantLabel ? ` · ${d.line.variantLabel}` : ''}</strong><div className="small dim">{d.line.consignorName ?? ''}</div></td>
                        <td className="num">{d.line.onHand}</td>
                        <td className="num" style={{ fontWeight: 600 }}>{d.counted} · {d.delta < 0 ? `${-d.delta} short` : `${d.delta} more`}</td>
                        <td>{COUNT_REASONS.find((r) => r.value === d.reason)?.label ?? ''}</td>
                        <td className="num"><Button size="sm" onClick={() => goCount(p >= 0 ? p : undefined)}>Recount</Button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="small dim" style={{ margin: 0 }}>
            Only what does not match is listed. Nothing on the shelf changes until an admin approves it.
          </p>
        </div>
      )}
    </Modal>
  );
}

/** One piece: what it should be, one tap if it matches, the stepper if not. */
function PieceCard({ line, onChange }: { line: CountLine; onChange: (patch: Partial<CountLine>) => void }) {
  const text = (line.countedText ?? '').trim();
  const blank = text === '';
  const n = blank ? null : Number(text);
  const diff = n === null || !Number.isFinite(n) ? 0 : n - line.onHand;
  const step = (by: number) => onChange({ countedText: String(Math.max(0, (n ?? line.onHand) + by)) });
  const name = `${line.name}${line.variantLabel ? ` · ${line.variantLabel}` : ''}`;
  return (
    <div className={`shopcount-card${!blank && diff === 0 ? ' is-match' : ''}${!blank && diff !== 0 ? ' is-off' : ''}`}>
      <div className="shopcount-head">
        <div className="what">
          <strong title={name}>{name}</strong>
          {line.consignorName && <span className="small dim">{line.consignorName}</span>}
          <span className="small">Should be <strong>{line.onHand}</strong></span>
        </div>
        <div className="shopcount-step">
          <button type="button" aria-label={`One fewer ${name}`} onClick={() => step(-1)}>−</button>
          <input
            value={line.countedText ?? ''}
            inputMode="numeric"
            placeholder="–"
            aria-label={`How many ${name}`}
            onChange={(e) => onChange({ countedText: e.target.value.replace(/\D/g, '') })}
          />
          <button type="button" aria-label={`One more ${name}`} onClick={() => step(1)}>+</button>
        </div>
      </div>
      {blank ? (
        <Button variant="primary" className="shopcount-all" onClick={() => onChange({ countedText: String(line.onHand) })}>
          {line.onHand === 0 ? 'None here, as expected' : `All ${line.onHand} here`}
        </Button>
      ) : diff === 0 ? (
        <div className="shopcount-state ok">All here</div>
      ) : diff > 0 ? (
        <div className="shopcount-why"><strong className="small">{diff} more than expected. Filed as a miscount.</strong></div>
      ) : (
        <div className="shopcount-why">
          <strong className="small">{-diff} short. Why?</strong>
          <div className="shopcount-chips">
            {COUNT_REASONS.map((r) => (
              <button
                key={r.value}
                type="button"
                title={r.help}
                aria-pressed={line.reason === r.value}
                onClick={() => onChange({ reason: r.value })}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
