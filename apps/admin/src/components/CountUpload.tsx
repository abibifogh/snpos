import { useState } from 'react';
import { Notice, Toggle } from '@snpos/ui';
import {
  readCountImport, applyCountImport, summariseImport,
  COUNT_COLUMNS, COUNT_HEADINGS, COUNT_TEMPLATE_ROWS, makerCode, formatMoney, bpWords } from '@snpos/core';
import type { CountLine, CountImportResult, Settings } from '@snpos/core';
import { db, DB_ID, ID } from '../lib';
import { ImportDialog } from './ImportDialog';

/**
 * A shelf count arriving as a file.
 *
 * A shop that counts on paper on Sunday and types it up on Monday is not going
 * to retype four hundred lines into a web form; it will estimate, or it will
 * not count. So the sheet they already keep can be uploaded — csv or xlsx,
 * because "save it as csv first" is a step where the wrong tab gets exported.
 *
 * The file FILLS THE COUNT SHEET. It does not write to the shelves. Everything
 * after this is the count screen exactly as it works when somebody types: the
 * totals are shown, the warnings apply, it is confirmed, and an admin approves
 * it. An upload that went straight to stock would move four hundred pieces
 * with nobody having looked, which is the one thing the approval step exists
 * to stop.
 */

/** What was read, and the grid it was read from: creating a missing piece means reading the same file again. */
type Read = CountImportResult & { grid: string[][] };

export function CountUpload({
  lines, owners, categories, settings, venueId, onClose, onApply,
}: {
  lines: CountLine[];
  owners: { $id: string; name: string }[];
  categories: { $id: string; name: string }[];
  settings: Settings | null;
  venueId: string;
  onClose: () => void;
  onApply: (filled: CountLine[], message: string) => void;
}) {
  const [makeOwners, setMakeOwners] = useState(true);
  const [makeProducts, setMakeProducts] = useState(true);

  const decimals = settings?.currency_decimals ?? 2;
  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));

  /**
   * Create what was asked for, then read the file again against the new shelf.
   *
   * Reading twice rather than patching the first result: a piece created here
   * has to become a real count line before it can be counted, and stitching a
   * pretend line into the sheet would be a second version of what a shelf line
   * is. The second read is against the same file, so it agrees by construction.
   */
  const apply = async (read: Read) => {
    const nextOwners = [...owners];
    let madeOwners = 0;
    let madeProducts = 0;

    if (makeOwners) {
      for (const name of read.missingOwners) {
        const created = await db.createDocument(DB_ID, 'consignors', ID.unique(), {
          venue_id: venueId,
          code: makerCode(name).slice(0, 24),
          name,
          phone: '', email: '', address: '',
          // The shop's own default rate. Guessing a different one for a maker
          // nobody has agreed terms with would put a number on a statement
          // that no one ever said out loud.
          commission_bp: settings?.default_commission_bp ?? 3000,
          commission_flat: 0,
          payout_method: 'momo',
          payout_details: '',
          notes: 'Created from a shelf count upload',
          active: true,
        });
        nextOwners.push({ $id: created.$id, name });
        madeOwners += 1;
      }
    }

    const newLines: CountLine[] = [];
    if (makeProducts) {
      for (const p of read.missingProducts) {
        const owner = nextOwners.find(
          (o) => o.name.trim().toLowerCase() === p.ownerName.trim().toLowerCase(),
        );
        const category = categories.find(
          (c) => c.name.trim().toLowerCase() === p.categoryName.trim().toLowerCase(),
        );

        const item = await db.createDocument(DB_ID, 'menu_items', ID.unique(), {
          category_id: category?.$id ?? '',
          name: p.name,
          description: '',
          price: p.price,
          active: true,
          // Not a dish. The kitchen's fields are required and mean nothing
          // here, so they get the quietest values they can.
          prep_minutes: 0,
          station: 'inherit',
          station_key: '',
          sort: 0,
          track_stock: false,
          image_focal_x: 0.5,
          image_focal_y: 0.5,
          module: 'craft',
          consignor_id: owner?.$id ?? '',
          /*
            Nought on the shelf, deliberately.

            The count then finds however many are there, and that surplus
            goes through confirmation and approval like every other
            difference — so the pieces arrive on the books by being counted
            in, with a movement behind them, rather than by an upload
            quietly asserting they exist.
          */
          on_hand: 0,
          is_one_off: false,
          maker_note: '',
        });

        if (category) {
          await db.createDocument(DB_ID, 'menu_item_categories', ID.unique(), {
            menu_item_id: item.$id,
            category_id: category.$id,
            sort: 0,
            active: true,
          }).catch(() => undefined);
        }

        newLines.push({
          menuItemId: item.$id,
          name: p.name,
          variantLabel: p.size || undefined,
          consignorId: owner?.$id,
          consignorName: owner?.name,
          categoryId: category?.$id,
          categoryName: category?.name,
          onHand: 0,
          unitPrice: p.price,
        });
        madeProducts += 1;
      }
    }

    // Second pass, against the shelf as it now stands.
    const shelf = [...lines, ...newLines];
    const again = readCountImport(read.grid, { lines: shelf, owners: nextOwners, categories, decimals });
    const filled = applyCountImport(shelf, again.matched);

    const made = [
      madeOwners ? `${madeOwners} maker${madeOwners === 1 ? '' : 's'}` : '',
      madeProducts ? `${madeProducts} piece${madeProducts === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(' and ');

    onApply(
      filled,
      `${again.matched.length} line${again.matched.length === 1 ? '' : 's'} filled in`
      + (made ? `, ${made} created` : ''),
    );
  };

  return (
    <ImportDialog<Read>
      title="Upload a count"
      intro={<>
        <p style={{ marginTop: 0 }}>
          A spreadsheet or a csv, one row per piece. Only <strong>product</strong> and{' '}
          <strong>counted</strong> have to be there.
        </p>
        <Notice tone="info">
          This fills the sheet below &mdash; it does not touch the shelf. You still see the totals, confirm them,
          and an admin still approves the count.
        </Notice>
      </>}
      template={{ name: 'shelf-count-template', headings: COUNT_HEADINGS, rows: COUNT_TEMPLATE_ROWS }}
      columns={COUNT_COLUMNS.map((c) => ({ key: c.key, heading: c.heading, required: 'required' in c && !!c.required, help: c.help }))}
      xlsx
      read={(grid) => ({ ...readCountImport(grid, { lines, owners, categories, decimals }), grid })}
      problems={(r) => r.problems}
      problemsStop={false}
      count={(r) => r.matched.length + (makeProducts ? r.missingProducts.length : 0)}
      action={() => 'Fill the count sheet'}
      body={(read) => {
        const totals = summariseImport(read);
        return (
          <>
            {totals.willFill > 0 && (
              <Notice tone="ok">
                <strong>{totals.willFill} line{totals.willFill === 1 ? '' : 's'} matched.</strong>{' '}
                {totals.differences === 0
                  ? 'Everything matched what the shelf expected.'
                  : `${totals.differences} differ — ${totals.missing} missing, ${totals.extra} more than expected.`}
              </Notice>
            )}

            {read.untouched > 0 && (
              <p className="small dim">
                {read.untouched} line{read.untouched === 1 ? '' : 's'} on the sheet {read.untouched === 1 ? 'is' : 'are'}{' '}
                not in the file. {read.untouched === 1 ? 'It stays' : 'They stay'} uncounted rather than being
                written off &mdash; blank is not nought.
              </p>
            )}

            {read.duplicates.length > 0 && (
              <Notice tone="warn">
                {/* A copied row is the commonest spreadsheet mistake and the
                    quietest: the second answer would silently replace the first. */}
                <strong>Counted twice:</strong> {read.duplicates.slice(0, 6).join(', ')}
                {read.duplicates.length > 6 && ` and ${read.duplicates.length - 6} more`}. The first answer is the
                one used.
              </Notice>
            )}

            {read.missingOwners.length > 0 && (
              <div style={{ margin: '0.9rem 0' }}>
                <Toggle
                  checked={makeOwners}
                  onChange={setMakeOwners}
                  label={`Create ${read.missingOwners.length} maker${read.missingOwners.length === 1 ? '' : 's'} the shop does not have`}
                />
                <p className="small dim" style={{ margin: '0.35rem 0 0' }}>
                  {read.missingOwners.join(', ')}. They come in on the shop&rsquo;s default commission
                  {settings ? ` of ${bpWords(settings.default_commission_bp ?? 3000)}` : ''}, which you
                  can change afterwards. Left off, their pieces have no maker against them.
                </p>
              </div>
            )}

            {read.missingProducts.length > 0 && (
              <div style={{ margin: '0.9rem 0' }}>
                <Toggle
                  checked={makeProducts}
                  onChange={setMakeProducts}
                  label={`Create ${read.missingProducts.length} piece${read.missingProducts.length === 1 ? '' : 's'} not on the shelf`}
                />
                <p className="small dim" style={{ margin: '0.35rem 0 0' }}>
                  Each starts at none on the shelf, so the count brings them on as a difference you approve like any
                  other. Left off, those rows are skipped.
                </p>
                <div className="table-wrap" style={{ maxHeight: '20vh', overflowY: 'auto', marginTop: '0.5rem' }}>
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Piece</th><th>Size</th><th>Maker</th><th>Shelf</th>
                        <th className="num">Price</th><th className="num">Counted</th>
                      </tr>
                    </thead>
                    <tbody>
                      {read.missingProducts.map((p, i) => (
                        <tr key={i}>
                          <td style={{ fontWeight: 550 }}>{p.name}</td>
                          <td className="dim">{p.size || '—'}</td>
                          <td className={p.ownerName ? undefined : 'dim'}>{p.ownerName || 'The shop'}</td>
                          <td className={p.categoryName ? undefined : 'dim'}>{p.categoryName || '—'}</td>
                          <td className="num">{p.price ? money(p.price) : <span className="dim">not given</span>}</td>
                          <td className="num">{p.counted}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        );
      }}
      // Filling the sheet is the whole outcome; the sheet itself is the done screen.
      write={async (read) => { await apply(read); return undefined; }}
      onClose={onClose}
    />
  );
}
