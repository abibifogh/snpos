import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Field, Input, Notice, Select, Spinner, Badge, useToast } from '@snpos/ui';
import { humanError } from '../lib';
import {
  shelfLines, saveCount, summariseCount, countWarnings, COUNT_REASONS, formatMoney,
} from '@snpos/core';
import type { CountLine, CountReason } from '@snpos/core';
import { useSession } from '../session';

/**
 * Counting the shop's shelves.
 *
 * The craft side had no count at all. Pieces went on the shelf when a delivery
 * was booked in and came off when a bill was settled, and nothing else could
 * move the number — so a piece that broke, walked, or went back to its maker
 * left the shelf saying it was still there, for ever. The first anybody knew
 * was a customer asking for something the till believed was in stock.
 *
 * Not the kitchen's count sheet. A kitchen counts quantities of a thing and
 * asks "how much is left"; a shop counts individual pieces and asks "is that
 * one still here", and the answer to a shortage is a reason rather than a
 * number. See stocktake.ts: recording every loss as an adjustment produces a
 * history that cannot tell breakage from theft.
 */
export function StocktakePage() {
  const { settings, profile, user } = useSession();
  const toast = useToast();

  const [lines, setLines] = useState<CountLine[] | null>(null);
  const [filter, setFilter] = useState('');
  const [maker, setMaker] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mayCount = profile?.role === 'admin' || profile?.role === 'manager';

  const load = () =>
    shelfLines()
      .then(setLines)
      .catch((e) => setError(humanError(e)));

  useEffect(() => { void load(); }, []);

  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));

  const setLine = (i: number, patch: Partial<CountLine>) =>
    setLines((rows) => (rows ?? []).map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const makers = useMemo(() => {
    const names = new Set((lines ?? []).map((l) => l.consignorName ?? ''));
    return [...names].filter(Boolean).sort();
  }, [lines]);

  /**
   * Which lines are on screen, and which are merely hidden.
   *
   * Filtering never drops what has been typed: somebody counts the baskets,
   * searches for "bowl", counts those, and both are saved. A filter that
   * discarded the first half would be a filter people learn to fear.
   */
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (lines ?? [])
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => {
        if (maker && (line.consignorName ?? '') !== maker) return false;
        if (!q) return true;
        return `${line.name} ${line.variantLabel ?? ''} ${line.consignorName ?? ''}`.toLowerCase().includes(q);
      });
  }, [lines, filter, maker]);

  const summary = useMemo(() => summariseCount(lines ?? []), [lines]);
  const warnings = useMemo(() => countWarnings(lines ?? []), [lines]);

  const save = async () => {
    if (summary.differences.length === 0) {
      toast('Nothing to record: every line you counted matched.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { written, failed } = await saveCount({
        venueId: 'main',
        lines: lines ?? [],
        userId: user?.$id ?? '',
        note,
      });
      setNote('');
      await load();
      if (failed > 0) {
        // Named rather than folded into a success message. A count is
        // somebody's afternoon on a clipboard and a line that did not save is
        // a line they have to do again.
        setError(
          `${written} recorded, but ${failed} could not be. If this says permission, `
          + 'run "Provision Appwrite" in GitHub Actions and count those lines again.',
        );
        return;
      }
      toast(`${written} difference${written === 1 ? '' : 's'} recorded`);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!mayCount) {
    return (
      <>
        <h1>Count the shelf</h1>
        <Notice>Only an admin or a manager can record a stock count.</Notice>
      </>
    );
  }

  return (
    <>
      <div className="spread">
        <h1>Count the shelf</h1>
        <Button
          variant="primary"
          onClick={() => void save()}
          loading={busy}
          disabled={summary.differences.length === 0}
        >
          {summary.differences.length === 0
            ? 'Nothing to record yet'
            : `Record ${summary.differences.length} difference${summary.differences.length === 1 ? '' : 's'}`}
        </Button>
      </div>

      <p className="dim" style={{ maxWidth: '46rem' }}>
        Walk the shop and type what is actually on the shelf. Leave a line blank and it is left exactly as it is —
        blank is not nought. Where a number differs, say why: a piece that broke, one that went missing and one
        that went back to its maker mean three different things, and only the reason you give here can tell them
        apart later.
      </p>

      {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

      {warnings.map((w) => (
        <div key={w} style={{ marginBottom: '0.6rem' }}>
          <Notice tone="warn">{w}</Notice>
        </div>
      ))}

      {summary.differences.length > 0 && (
        <Card title="What this count says">
          <div className="row row-wrap" style={{ gap: '1.4rem' }}>
            <div>
              <div className="dim small">Missing</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 650 }}>
                {summary.missingPieces} {summary.missingPieces === 1 ? 'piece' : 'pieces'}
              </div>
              <div className="dim small">{money(summary.missingValue)} at retail</div>
            </div>
            {summary.surplusPieces > 0 && (
              <div>
                <div className="dim small">More than expected</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 650 }}>{summary.surplusPieces}</div>
                <div className="dim small">recorded as a miscount</div>
              </div>
            )}
            {summary.byReason.map((r) => (
              <div key={r.reason}>
                <div className="dim small">{COUNT_REASONS.find((x) => x.value === r.reason)?.label}</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 650 }}>{r.pieces}</div>
                <div className="dim small">{money(r.value)}</div>
              </div>
            ))}
          </div>
          <Field label="Note" hint="Goes on every movement this count writes. Optional.">
            <Input
              value={note}
              placeholder="Monthly count, 12 August"
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </Card>
      )}

      <Card title="The shelf">
        <div className="grid-2">
          <Field label="Search">
            <Input value={filter} placeholder="Basket, necklace…" onChange={(e) => setFilter(e.target.value)} />
          </Field>
          <Field label="Maker" hint="Counting one maker's shelf at a time is usually how it is done.">
            <Select value={maker} onChange={(e) => setMaker(e.target.value)}>
              <option value="">Everyone</option>
              {makers.map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
          </Field>
        </div>
        {/* Said plainly, because a filtered list that silently threw away what
            was already typed would be the worst kind of surprise here. */}
        {(filter || maker) && summary.countedLines > 0 && (
          <p className="small dim" style={{ margin: 0 }}>
            {summary.countedLines} line{summary.countedLines === 1 ? '' : 's'} counted so far, including any hidden
            by this filter. Nothing is lost by searching.
          </p>
        )}
      </Card>

      <Card pad={false}>
        {!lines ? (
          <div className="card-pad"><Spinner /></div>
        ) : shown.length === 0 ? (
          <Empty title={lines.length === 0 ? 'Nothing on the shelves yet' : 'Nothing matches that'}>
            {lines.length === 0
              ? 'Pieces appear here once a delivery has been booked in under Goods received.'
              : 'Clear the search or choose a different maker.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Piece</th>
                  <th>Maker</th>
                  <th className="num">Shelf says</th>
                  <th style={{ width: '7rem' }}>Actually there</th>
                  <th style={{ width: '13rem' }}>If it differs, why</th>
                  <th className="num">Difference</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(({ line, index }) => {
                  const typed = (line.countedText ?? '').trim();
                  const counted = typed === '' ? null : Number(typed);
                  const delta = counted === null || !Number.isFinite(counted) ? null : counted - line.onHand;
                  return (
                    <tr key={`${line.menuItemId}-${line.variantId ?? ''}`}>
                      <td>
                        <div style={{ fontWeight: 550 }}>{line.name}</div>
                        {line.variantLabel && <div className="small dim">{line.variantLabel}</div>}
                      </td>
                      <td className="dim small">{line.consignorName ?? 'The shop'}</td>
                      <td className="num">{line.onHand}</td>
                      <td>
                        <Input
                          type="number"
                          min="0"
                          step="1"
                          placeholder="—"
                          value={line.countedText ?? ''}
                          onChange={(e) => setLine(index, { countedText: e.target.value })}
                        />
                      </td>
                      <td>
                        {/* Only once there is a shortage to explain. A dropdown
                            beside every untouched line is four hundred controls
                            nobody needs and one they might change by accident. */}
                        {delta !== null && delta < 0 ? (
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
                            {delta === null ? 'Not counted' : delta > 0 ? 'More than expected' : 'Matches'}
                          </span>
                        )}
                      </td>
                      <td className="num">
                        {delta === null || delta === 0 ? (
                          <span className="dim">—</span>
                        ) : (
                          <Badge tone={delta < 0 ? 'danger' : 'warn'}>
                            {delta > 0 ? `+${delta}` : delta}
                          </Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="What each reason means">
        <ul className="small" style={{ margin: 0, paddingLeft: '1.1rem' }}>
          {COUNT_REASONS.map((r) => (
            <li key={r.value} style={{ marginBottom: '0.3rem' }}>
              <strong>{r.label}.</strong> {r.help}
            </li>
          ))}
        </ul>
        {/* Said once, here, rather than left for somebody to discover from a
            statement that did not change. */}
        <p className="small dim" style={{ marginBottom: 0 }}>
          None of these change what a maker is owed. A consignor is paid when a piece sells, so an unsold piece
          leaving the shelf — however it leaves — settles nothing either way. If you have agreed to pay a maker for
          something that broke in your care, record that as a payout adjustment on their page.
        </p>
      </Card>
    </>
  );
}
