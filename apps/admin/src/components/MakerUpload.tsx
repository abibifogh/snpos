import { useState } from 'react';
import { Badge, Button, Modal, Notice } from '@snpos/ui';
import {
  parseCsv, toCsv, downloadCsv, formatMoney,
  readMakerImport, importMakers, MAKER_COLUMNS, MAKER_HEADINGS, MAKER_TEMPLATE_ROWS,
} from '@snpos/core';
import type { Consignor, Settings, MakerImportResult } from '@snpos/core';
import { humanError } from '../lib';

/**
 * Putting a book of makers in from a spreadsheet.
 *
 * A shop opening its doors already has thirty consignors written down
 * somewhere, and the alternative is thirty forms and four commission rates
 * typed wrongly. That last part is why this exists rather than being a
 * nice-to-have: a wrong rate follows every sale that maker ever makes and is
 * noticed months later, when they query a statement.
 *
 * Three steps, and the middle one is the point. Nothing is written until the
 * file has been read back and shown, including which rows are corrections to
 * somebody already on file — a bulk write that goes straight from a file
 * picker to the database is one nobody can check before it happens.
 */
export function MakerUpload({
  venueId, existing, settings, onClose, onDone,
}: {
  venueId: string;
  existing: Consignor[];
  settings: Settings;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [read, setRead] = useState<MakerImportResult | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ created: number; updated: number; failed: { code: string; why: string }[] } | null>(null);

  const decimals = settings.currency_decimals ?? 2;
  const money = (n: number) => formatMoney(n, settings);

  const template = () => downloadCsv('makers-template', toCsv(MAKER_HEADINGS, MAKER_TEMPLATE_ROWS));

  const take = async (file: File) => {
    setError(null);
    setRead(null);
    setFileName(file.name);
    try {
      const text = await file.text();
      setRead(readMakerImport(parseCsv(text), { existing, decimals }));
    } catch (e) {
      setError(humanError(e));
    }
  };

  const write = async () => {
    if (!read || read.problems.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await importMakers({
        venueId,
        makers: read.makers,
        existing,
        defaultCommissionBp: settings.default_commission_bp ?? 3000,
      });
      setOutcome(result);
      await onDone(
        `${result.created} maker${result.created === 1 ? '' : 's'} added`
        + (result.updated ? `, ${result.updated} updated` : ''),
      );
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------------------------------------- finished */
  if (outcome) {
    return (
      <Modal wide title="Uploaded" onClose={onClose}
        footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <Notice tone={outcome.failed.length ? 'warn' : 'ok'}>
          <strong>{outcome.created} maker{outcome.created === 1 ? '' : 's'} added</strong>
          {outcome.updated > 0 && `, ${outcome.updated} updated`}.
        </Notice>
        {outcome.failed.length > 0 && (
          <>
            {/* Named, not counted. A maker who did not save is one whose pieces
                cannot be booked in, and the shop needs to know which. */}
            <h3 style={{ margin: '1.1rem 0 0.35rem', fontSize: '0.95rem' }}>These did not save</h3>
            <ul className="small">
              {outcome.failed.map((f) => <li key={f.code}><strong>{f.code}</strong> — {f.why}</li>)}
            </ul>
          </>
        )}
      </Modal>
    );
  }

  /* ------------------------------------------------------------ read back */
  const problems = read?.problems ?? [];

  return (
    <Modal
      wide
      title="Upload makers"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void write()}
            loading={busy}
            disabled={!read || problems.length > 0 || read.makers.length === 0}
          >
            {read && problems.length === 0 && read.makers.length > 0
              ? `Save ${read.makers.length}`
              : 'Save'}
          </Button>
        </>
      }
    >
      {error && <div style={{ marginBottom: '0.9rem' }}><Notice>{error}</Notice></div>}

      <p className="small dim" style={{ marginTop: 0 }}>
        A spreadsheet saved as CSV. Download the template, fill it in, and put it back — nothing is written until
        you have seen what was understood.
      </p>

      <div className="row" style={{ gap: '0.5rem', marginBottom: '0.9rem', flexWrap: 'wrap' }}>
        <Button onClick={template}>Download the template</Button>
        <label className="btn" style={{ cursor: 'pointer' }}>
          Choose a file
          <input
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void take(f);
            }}
          />
        </label>
        {fileName && <span className="small dim" style={{ alignSelf: 'center' }}>{fileName}</span>}
      </div>

      {!read && (
        <>
          <h3 style={{ margin: '1.1rem 0 0.35rem', fontSize: '0.95rem' }}>What each column is for</h3>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Column</th><th>What to write in it</th></tr></thead>
              <tbody>
                {MAKER_COLUMNS.map((c) => (
                  <tr key={c.key}>
                    <td><code>{c.heading}</code>{c.required && <Badge tone="warn"> needed</Badge>}</td>
                    <td className="small dim">{c.help}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {problems.length > 0 && (
        <>
          <Notice>
            {/* Nothing is written while anything is wrong. Half a file is worse
                than none: the shop would not know where it stopped. */}
            <strong>{problems.length} thing{problems.length === 1 ? '' : 's'} to fix.</strong> Nothing has been
            saved. Correct these in the file and choose it again.
          </Notice>
          <ul className="small">
            {problems.slice(0, 20).map((p, i) => (
              <li key={i}>Line {p.line}: {p.message}</li>
            ))}
            {problems.length > 20 && <li className="dim">and {problems.length - 20} more</li>}
          </ul>
        </>
      )}

      {read && problems.length === 0 && (
        <>
          <Notice tone="ok">
            <strong>{read.makers.length} maker{read.makers.length === 1 ? '' : 's'} read.</strong>{' '}
            {read.newCount} new
            {read.updateCount > 0 && `, ${read.updateCount} already on file and will be updated`}.
          </Notice>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Code</th><th>Name</th><th>The shop keeps</th><th>Paid by</th><th /></tr>
              </thead>
              <tbody>
                {read.makers.map((m) => (
                  <tr key={m.code}>
                    <td><code>{m.code}</code></td>
                    <td>{m.name}</td>
                    <td>
                      {m.commissionFlat > 0
                        ? `${money(m.commissionFlat)} a piece`
                        : m.commissionBp !== null
                          ? `${(m.commissionBp / 100).toFixed(0)}%`
                          : <span className="dim">unchanged</span>}
                    </td>
                    <td className="dim small">{m.payoutMethod}{m.payoutDetails ? ` · ${m.payoutDetails}` : ''}</td>
                    <td>{m.updates ? <Badge tone="warn">updates</Badge> : <Badge tone="ok">new</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
