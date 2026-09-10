import { Badge, Empty, Notice } from '@snpos/ui';
import { formatMoney, readImport, importStock, IMPORT_COLUMNS, IMPORT_HEADINGS, TEMPLATE_ROWS } from '@snpos/core';
import type { Category, Consignor, VariantType, Settings, ImportResult } from '@snpos/core';
import { ImportDialog } from './ImportDialog';

/**
 * The craft shop's stock from a spreadsheet: pieces, their makers, their
 * sizes and how many of each, booked in as deliveries exactly as if they had
 * arrived at the counter. All of the file or none of it, so the shop never
 * ends up half loaded and guessing which pieces went in.
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
  const decimals = settings.currency_decimals ?? 2;
  const money = (n: number) => formatMoney(n, settings);

  return (
    <ImportDialog<ImportResult>
      title="Upload stock from a spreadsheet"
      intro={<>
        <p style={{ marginTop: 0 }}>
          The template comes with three example rows showing the two shapes: a plain piece, and a piece in two
          sizes sharing a name. Delete the examples, paste your own rows in, and save it as CSV. Check the count
          of pieces against the crate before you press the button; that is the number this is for.
        </p>
        {categories.length === 0 && (
          <Notice>
            There are no craft shop categories yet, and every row has to name one. Add at least one under
            Categories, Shop, first.
          </Notice>
        )}
      </>}
      template={{ name: 'craft-stock-template', headings: IMPORT_HEADINGS, rows: TEMPLATE_ROWS }}
      columns={IMPORT_COLUMNS}
      read={(grid) => readImport(grid, { categories, consignors, variantTypes, decimals })}
      problems={(r) => r.problems}
      count={(r) => r.products.length}
      action={(n) => (n ? `Add ${n} product${n === 1 ? '' : 's'}` : 'Add to the shop')}
      body={(r) => (r.products.length === 0 ? (
        <Empty title="Nothing to add">That file has headings but no rows under them.</Empty>
      ) : (
        <>
          <div className="stat-row">
            <div className="stat"><div className="label">Products</div><div className="value">{r.products.length}</div></div>
            <div className="stat"><div className="label">Pieces</div><div className="value">{r.pieceCount}</div></div>
            <div className="stat">
              <div className="label">Makers</div>
              <div className="value">{new Set(r.products.map((p) => p.consignorId).filter(Boolean)).size}</div>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Piece</th><th>Category</th><th>Maker</th><th className="num">Qty</th><th className="num">Price</th><th>Sizes</th></tr>
              </thead>
              <tbody>
                {r.products.map((p, i) => (
                  <tr key={i}>
                    <td>{p.name}{p.oneOff && <Badge> one off</Badge>}</td>
                    <td className="small">{p.categoryName}</td>
                    <td className="small">{p.consignorName || <span className="dim">the shop</span>}</td>
                    <td className="num">{p.quantity}</td>
                    <td className="num">{p.variants.length ? `${money(Math.min(...p.variants.map((v) => v.price)))}+` : money(p.price)}</td>
                    <td className="small">{p.variants.length ? p.variants.map((v) => `${v.label} (${v.quantity})`).join(', ') : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ))}
      write={async (r) => {
        const result = await importStock({ venueId, products: r.products, consignors, settings, userId });
        await onDone(
          `${result.products} product${result.products === 1 ? '' : 's'} added`
          + (result.intakes.length ? `, in ${result.intakes.length} deliver${result.intakes.length === 1 ? 'y' : 'ies'}` : ''),
        );
        return (
          <>
            <Notice tone="ok">
              <strong>{result.products} product{result.products === 1 ? '' : 's'}</strong>
              {result.variants > 0 && ` and ${result.variants} size${result.variants === 1 ? '' : 's'}`} are on the shop floor.
            </Notice>
            {result.intakes.length > 0 && (
              <>
                <h3 style={{ margin: '1.1rem 0 0.35rem', fontSize: '0.95rem' }}>Deliveries created</h3>
                <p className="small dim" style={{ marginTop: 0 }}>
                  One per maker, exactly as if it had been booked in at the counter. A slip can be printed for any
                  of them from Goods received.
                </p>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Reference</th><th>From</th><th className="num">Pieces</th></tr></thead>
                    <tbody>
                      {result.intakes.map((i) => (
                        <tr key={i.reference}><td><code>{i.reference}</code></td><td>{i.consignorName}</td><td className="num">{i.pieces}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {result.failures.length > 0 && (
              <div style={{ marginTop: '1rem' }}>
                <Notice>
                  <strong>{result.failures.length} did not go in.</strong> Everything else did. Add these by hand, or
                  put them in a file of their own and upload that.
                </Notice>
                <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.2rem' }}>
                  {result.failures.map((f, i) => <li key={i} className="small">{f.name}: {f.reason}</li>)}
                </ul>
              </div>
            )}
          </>
        );
      }}
      onClose={onClose}
    />
  );
}
