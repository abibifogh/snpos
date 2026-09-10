import { Badge, Notice } from '@snpos/ui';
import { formatMoney, readMakerImport, importMakers, MAKER_COLUMNS, MAKER_HEADINGS, MAKER_TEMPLATE_ROWS, bpWords } from '@snpos/core';
import type { Consignor, Settings, MakerImportResult } from '@snpos/core';
import { ImportDialog } from './ImportDialog';

/**
 * Putting a book of makers in from a spreadsheet.
 *
 * A shop opening its doors already has thirty consignors written down
 * somewhere, and the alternative is thirty forms and four commission rates
 * typed wrongly. That last part is why this exists rather than being a
 * nice-to-have: a wrong rate follows every sale that maker ever makes and is
 * noticed months later, when they query a statement.
 *
 * Nothing is written until the file has been read back and shown, including
 * which rows are corrections to somebody already on file.
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
  const decimals = settings.currency_decimals ?? 2;
  const money = (n: number) => formatMoney(n, settings);

  return (
    <ImportDialog<MakerImportResult>
      title="Upload makers"
      intro={<p style={{ marginTop: 0 }}>
        A spreadsheet saved as CSV. Download the template, fill it in, and put it back — nothing is written until
        you have seen what was understood.
      </p>}
      template={{ name: 'makers-template', headings: MAKER_HEADINGS, rows: MAKER_TEMPLATE_ROWS }}
      columns={MAKER_COLUMNS}
      read={(grid) => readMakerImport(grid, { existing, decimals })}
      problems={(r) => r.problems}
      count={(r) => r.makers.length}
      action={(n) => (n ? `Save ${n}` : 'Save')}
      body={(r) => (
        <>
          <Notice tone="ok">
            <strong>{r.makers.length} maker{r.makers.length === 1 ? '' : 's'} read.</strong>{' '}
            {r.newCount} new
            {r.updateCount > 0 && `, ${r.updateCount} already on file and will be updated`}.
          </Notice>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Code</th><th>Name</th><th>The shop keeps</th><th>Paid by</th><th /></tr>
              </thead>
              <tbody>
                {r.makers.map((m) => (
                  <tr key={m.code}>
                    <td><code>{m.code}</code></td>
                    <td>{m.name}</td>
                    <td>
                      {m.commissionFlat > 0
                        ? `${money(m.commissionFlat)} a piece`
                        : m.commissionBp !== null
                          ? bpWords(m.commissionBp)
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
      write={async (r) => {
        const result = await importMakers({
          venueId,
          makers: r.makers,
          existing,
          defaultCommissionBp: settings.default_commission_bp ?? 3000,
        });
        await onDone(
          `${result.created} maker${result.created === 1 ? '' : 's'} added`
          + (result.updated ? `, ${result.updated} updated` : ''),
        );
        return (
          <>
            <Notice tone={result.failed.length ? 'warn' : 'ok'}>
              <strong>{result.created} maker{result.created === 1 ? '' : 's'} added</strong>
              {result.updated > 0 && `, ${result.updated} updated`}.
            </Notice>
            {result.failed.length > 0 && (
              <>
                {/* Named, not counted. A maker who did not save is one whose pieces
                    cannot be booked in, and the shop needs to know which. */}
                <h3 style={{ margin: '1.1rem 0 0.35rem', fontSize: '0.95rem' }}>These did not save</h3>
                <ul className="small">
                  {result.failed.map((f) => <li key={f.code}><strong>{f.code}</strong> — {f.why}</li>)}
                </ul>
              </>
            )}
          </>
        );
      }}
      onClose={onClose}
    />
  );
}
