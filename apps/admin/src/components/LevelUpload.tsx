import { useState } from 'react';
import { Button, Modal, Notice } from '@snpos/ui';
import {
  parseCsv, toCsv, downloadCsv,
  readLevelImport, applyLevelImport, levelTotals, LEVEL_TEMPLATE_ROWS,
} from '@snpos/core';
import type { StockLocation, LevelImportResult } from '@snpos/core';
import { humanError } from '../lib';

/**
 * Opening levels for every place, from one file.
 *
 * A bar moving in has stock in a store room and stock behind the bar, and
 * counting forty items twice on day one is the kind of task that gets done
 * badly or not at all. Every system that holds stock per location can export
 * this shape: one row per thing, one column per place.
 *
 * The place columns are matched by NAME against the places already set up
 * rather than being fixed in the code, so a business with a cellar as well
 * gets a third column by naming it, not by anybody editing anything.
 */
export function LevelUpload({
  ingredients, locations, userId, onClose, onDone,
}: {
  ingredients: { $id: string; name: string; unit: string }[];
  locations: StockLocation[];
  userId: string;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [read, setRead] = useState<LevelImportResult | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ set: number; failed: number } | null>(null);

  const template = () =>
    downloadCsv(
      'opening-levels-template',
      // Headed with the places that actually exist, so the file somebody
      // downloads already matches their own rooms.
      toCsv(['name', 'unit', ...locations.map((l) => l.name)], LEVEL_TEMPLATE_ROWS),
    );

  const take = async (f: File) => {
    setError(null);
    setRead(null);
    setFileName(f.name);
    try {
      setRead(readLevelImport(parseCsv(await f.text()), { ingredients, locations }));
    } catch (e) {
      setError(humanError(e));
    }
  };

  const write = async () => {
    if (!read || read.rows.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await applyLevelImport({ venueId: 'main', rows: read.rows, userId });
      setOutcome(result);
      await onDone(`${result.set} level${result.set === 1 ? '' : 's'} set`);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  if (outcome) {
    return (
      <Modal wide title="Levels set" onClose={onClose}
        footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <Notice tone={outcome.failed ? 'warn' : 'ok'}>
          <strong>{outcome.set} level{outcome.set === 1 ? '' : 's'} set.</strong>
          {outcome.failed > 0 && ` ${outcome.failed} could not be — those are unchanged.`}
        </Notice>
        <p className="small dim">
          Each place now holds what the file said, and the total on each item is the sum of its places. A movement
          was written for every difference, so the history explains the jump rather than just showing it.
        </p>
      </Modal>
    );
  }

  const totals = read ? levelTotals(read.rows) : [];

  return (
    <Modal
      wide
      title="Upload opening levels"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void write()}
            loading={busy}
            disabled={!read || read.rows.length === 0}
          >
            {read?.rows.length ? `Set ${read.rows.length} item${read.rows.length === 1 ? '' : 's'}` : 'Set levels'}
          </Button>
        </>
      }
    >
      {error && <div style={{ marginBottom: '0.9rem' }}><Notice>{error}</Notice></div>}

      <p className="small dim" style={{ marginTop: 0 }}>
        One row per thing, one column per place, headed with the place&rsquo;s name. A blank cell leaves that place
        alone; a nought empties it.
      </p>
      {/* The one thing that could go badly wrong, said before the button. */}
      <Notice tone="info">
        This <strong>sets</strong> each level rather than adding to it, so running the same file twice leaves the
        same answer. It is an opening balance, not a delivery.
      </Notice>

      <div className="row" style={{ gap: '0.5rem', margin: '0.9rem 0', flexWrap: 'wrap' }}>
        <Button onClick={template} disabled={locations.length === 0}>Download the template</Button>
        <label className="btn" style={{ cursor: 'pointer' }}>
          Choose a file
          <input
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void take(f); }}
          />
        </label>
        {fileName && <span className="small dim" style={{ alignSelf: 'center' }}>{fileName}</span>}
      </div>

      {locations.length === 0 && (
        <Notice>Set a place up first — there is nowhere for these levels to go.</Notice>
      )}

      {read && (
        <>
          {read.matchedPlaces.length > 0 && (
            <Notice tone="ok">
              <strong>{read.rows.length} item{read.rows.length === 1 ? '' : 's'} read</strong>, filling{' '}
              {read.matchedPlaces.join(' and ')}.
            </Notice>
          )}
          {read.ignoredColumns.length > 0 && (
            /* Named rather than silently skipped: a column somebody meant as a
               place and misspelled looks identical to one they meant as a note. */
            <p className="small dim">
              Columns ignored, because they do not match a place you have set up:{' '}
              {read.ignoredColumns.join(', ')}.
            </p>
          )}

          {totals.length > 0 && (
            <div className="row row-wrap" style={{ gap: '1.4rem', margin: '0.8rem 0' }}>
              {totals.map((t) => (
                <div key={t.place}>
                  <div className="dim small">{t.place}</div>
                  <div style={{ fontSize: '1.3rem', fontWeight: 650 }}>{t.items} items</div>
                  <div className="dim small">{Number(t.units.toFixed(2))} units in all</div>
                </div>
              ))}
            </div>
          )}

          {read.problems.length > 0 && (
            <>
              <Notice tone="warn">
                {/* Warned, not refused. A stock export routinely carries things
                    the bar does not stock, and rejecting the file over one of
                    them would be rejecting the useful part. */}
                <strong>{read.problems.length} row{read.problems.length === 1 ? '' : 's'} will be skipped.</strong>{' '}
                Everything else still goes in.
              </Notice>
              <ul className="small">
                {read.problems.slice(0, 15).map((p, i) => <li key={i}>Line {p.line}: {p.message}</li>)}
                {read.problems.length > 15 && <li className="dim">and {read.problems.length - 15} more</li>}
              </ul>
            </>
          )}

          {read.rows.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: '36vh', overflowY: 'auto' }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>What</th>
                    {read.matchedPlaces.map((p) => <th key={p} className="num">{p}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {read.rows.map((r) => (
                    <tr key={r.ingredientId}>
                      <td style={{ fontWeight: 550 }}>{r.name}</td>
                      {read.matchedPlaces.map((p) => {
                        const at = r.levels.find((l) => l.locationName === p);
                        return (
                          <td key={p} className="num">
                            {at ? at.qty : <span className="dim" title="Left as it is">—</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
