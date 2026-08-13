import { useState } from 'react';
import { Badge, Button, Card, Empty, Modal, Notice, Spinner } from '@snpos/ui';
import {
  parseCsv, toCsv, downloadCsv, formatMoney,
  readImport, importStock, IMPORT_COLUMNS, IMPORT_HEADINGS, TEMPLATE_ROWS,
} from '@snpos/core';
import type {
  Category, Consignor, VariantType, Settings, ImportResult, ImportOutcome,
} from '@snpos/core';
import { humanError } from '../lib';

/**
 * Booking a whole crate in from a spreadsheet.
 *
 * A shop that has just taken ninety pieces is not going to fill in ninety
 * forms, and the alternative to this is somebody typing them into the products
 * page for an afternoon and making four mistakes.
 *
 * Three steps, and the middle one is the point: nothing is written until the
 * file has been read back and shown. A bulk write that goes straight from a
 * file picker to the database is one nobody can check before it happens, and
 * the checking afterwards is ninety rows of scrolling.
 *
 * Everything it creates is what the intake desk would have created: a delivery
 * per maker, the products, their sizes, and a movement behind every count. See
 * importStock.
 */
export function StockUpload({
  venueId, categories, consignors, variantTypes, settings, userId, onClose, onDone,
}: {
  venueId: string;
  categories: Category[];
  consignors: Consignor[];
  variantTypes: VariantType[];
  settings: Settings;
  userId: string;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [read, setRead] = useState<ImportResult | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);

  const decimals = settings.currency_decimals ?? 2;
  const money = (n: number) => formatMoney(n, settings);

  const template = () =>
    downloadCsv('craft-stock-template', toCsv(IMPORT_HEADINGS, TEMPLATE_ROWS));

  const take = async (file: File) => {
    setError(null);
    setRead(null);
    setFileName(file.name);
    try {
      const text = await file.text();
      setRead(readImport(parseCsv(text), { categories, consignors, variantTypes, decimals }));
    } catch (e) {
      setError(humanError(e));
    }
  };

  const write = async () => {
    if (!read || read.problems.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await importStock({
        venueId,
        products: read.products,
        consignors,
        settings,
        userId,
      });
      setOutcome(result);
      await onDone(
        `${result.products} product${result.products === 1 ? '' : 's'} added`
        + (result.intakes.length ? `, in ${result.intakes.length} deliver${result.intakes.length === 1 ? 'y' : 'ies'}` : ''),
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
      <Modal
        wide
        title="Uploaded"
        onClose={onClose}
        footer={<Button variant="primary" onClick={onClose}>Done</Button>}
      >
        <Notice tone="ok">
          <strong>{outcome.products} product{outcome.products === 1 ? '' : 's'}</strong>
          {outcome.variants > 0 && ` and ${outcome.variants} size${outcome.variants === 1 ? '' : 's'}`} are on the
          shop floor.
        </Notice>

        {outcome.intakes.length > 0 && (
          <>
            <h3 style={{ margin: '1.1rem 0 0.35rem', fontSize: '0.95rem' }}>Deliveries created</h3>
            <p className="small dim" style={{ marginTop: 0 }}>
              One per maker, exactly as if it had been booked in at the counter. A slip can be printed for any of
              them from Goods received.
            </p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Reference</th><th>From</th><th className="num">Pieces</th></tr></thead>
                <tbody>
                  {outcome.intakes.map((i) => (
                    <tr key={i.reference}>
                      <td><code>{i.reference}</code></td>
                      <td>{i.consignorName}</td>
                      <td className="num">{i.pieces}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {outcome.failures.length > 0 && (
          <div style={{ marginTop: '1rem' }}>
            <Notice>
              <strong>{outcome.failures.length} did not go in.</strong> Everything else did. Add these by hand, or
              put them in a file of their own and upload that.
            </Notice>
            <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.2rem' }}>
              {outcome.failures.map((f, i) => (
                <li key={i} className="small">{f.name}: {f.reason}</li>
              ))}
            </ul>
          </div>
        )}
      </Modal>
    );
  }

  const ready = read && read.problems.length === 0 && read.products.length > 0;

  return (
    <Modal
      wide
      title="Upload stock from a spreadsheet"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={write} loading={busy} disabled={!ready}>
            {ready
              ? `Add ${read.products.length} product${read.products.length === 1 ? '' : 's'}`
              : 'Add to the shop'}
          </Button>
        </>
      }
    >
      {error && <Notice tone="err">{error}</Notice>}

      {categories.length === 0 && (
        <Notice>
          There are no craft shop categories yet, and every row has to name one. Add at least one under Craft shop,
          Categories, first.
        </Notice>
      )}

      {/* Step one. The template is filled in rather than blank, because the
          first question anybody has is what a row is supposed to look like,
          and an empty grid answers it by making them guess. */}
      <Card title="1. Start from the template">
        <p className="small dim" style={{ marginTop: 0 }}>
          It comes with three example rows showing the two shapes: a plain piece, and a piece in two sizes sharing a
          name. Delete the examples, paste your own rows in, and save it as CSV.
        </p>
        <Button onClick={template}>Download the template</Button>

        <details style={{ marginTop: '0.9rem' }}>
          <summary className="small">What each column means</summary>
          <div className="table-wrap" style={{ marginTop: '0.5rem' }}>
            <table>
              <thead><tr><th>Column</th><th>What to put in it</th></tr></thead>
              <tbody>
                {IMPORT_COLUMNS.map((c) => (
                  <tr key={c.key}>
                    <td><code>{c.heading}</code>{c.required && <Badge tone="warn"> needed</Badge>}</td>
                    <td className="small">{c.help}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </Card>

      <Card title="2. Choose your file">
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void take(file);
          }}
        />
        {fileName && <p className="small dim" style={{ marginBottom: 0 }}>Reading {fileName}</p>}
      </Card>

      {read && (
        <Card title="3. Check it before anything is written">
          {read.problems.length > 0 ? (
            <>
              {/* All or nothing, and said plainly. Importing the good rows and
                  reporting the bad ones leaves a shop half-loaded with no way
                  to tell by looking which pieces made it in. */}
              <Notice>
                <strong>
                  {read.problems.length} thing{read.problems.length === 1 ? '' : 's'} to fix, so nothing has been
                  added.
                </strong>
                <div className="small" style={{ marginTop: '0.3rem' }}>
                  Correct these in the file and choose it again. It is all of the file or none of it, so you never
                  end up half loaded and guessing which pieces went in.
                </div>
              </Notice>
              <div className="table-wrap" style={{ marginTop: '0.7rem' }}>
                <table>
                  <thead><tr><th style={{ width: '5rem' }}>Line</th><th>What is wrong</th></tr></thead>
                  <tbody>
                    {read.problems.map((p, i) => (
                      <tr key={i}>
                        <td className="num">{p.line}</td>
                        <td className="small">{p.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : read.products.length === 0 ? (
            <Empty title="Nothing to add">That file has headings but no rows under them.</Empty>
          ) : (
            <>
              <div className="stat-row">
                <div className="stat">
                  <div className="label">Products</div>
                  <div className="value">{read.products.length}</div>
                </div>
                <div className="stat">
                  <div className="label">Pieces</div>
                  <div className="value">{read.pieceCount}</div>
                </div>
                <div className="stat">
                  <div className="label">Makers</div>
                  <div className="value">
                    {new Set(read.products.map((p) => p.consignorId).filter(Boolean)).size}
                  </div>
                </div>
              </div>

              <p className="small dim">
                Check the count of pieces against the crate before you press the button. That is the number this is
                for.
              </p>

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Piece</th><th>Category</th><th>Maker</th>
                      <th className="num">Qty</th><th className="num">Price</th><th>Sizes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {read.products.map((p, i) => (
                      <tr key={i}>
                        <td>
                          {p.name}
                          {p.oneOff && <Badge> one off</Badge>}
                        </td>
                        <td className="small">{p.categoryName}</td>
                        <td className="small">{p.consignorName || <span className="dim">the shop</span>}</td>
                        <td className="num">{p.quantity}</td>
                        <td className="num">
                          {p.variants.length
                            ? `${money(Math.min(...p.variants.map((v) => v.price)))}+`
                            : money(p.price)}
                        </td>
                        <td className="small">
                          {p.variants.length
                            ? p.variants.map((v) => `${v.label} (${v.quantity})`).join(', ')
                            : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}

      {busy && <Spinner />}
    </Modal>
  );
}
