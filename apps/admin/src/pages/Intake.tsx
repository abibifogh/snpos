import { useEffect, useMemo, useState } from 'react';
import {
  Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Textarea, Badge, useToast,
} from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import {
  formatMoney, parseMoney, Query,
  loadConsignors, nextReference, moveStock, buildDeliverySlipHtml, openPrintable,
  rateFor, flatFor, dueFor,
} from '@snpos/core';
import type { Consignor, ConsignmentIntake, MenuItem, Category, ProductMove, Settings } from '@snpos/core';
import { useSession } from '../session';

/**
 * The desk where work arrives.
 *
 * A delivery is what both sides remember, "the baskets I brought in March", 
 * so it is a thing with a reference, not a scatter of products that happen to
 * share a date. Without it, a maker asking what happened to that delivery can
 * only be answered piece by piece.
 *
 * Receiving is the moment stock exists. Every piece booked in here writes a
 * movement as well as a product, because the count on a shelf is a convenience
 * and the movement is the record, and the question a shop cannot answer
 * without it is not "how many" but "where did the other one go".
 */
export function IntakePage() {
  const toast = useToast();
  const { settings, user } = useSession();
  const decimals = settings?.currency_decimals ?? 2;
  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));

  const [rows, setRows] = useState<ConsignmentIntake[] | null>(null);
  const [consignors, setConsignors] = useState<Consignor[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [receiving, setReceiving] = useState(false);
  const [viewing, setViewing] = useState<ConsignmentIntake | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [intakes, people, cats] = await Promise.all([
      listAll<ConsignmentIntake>('consignment_intakes'),
      loadConsignors(),
      listAll<Category>('categories'),
    ]);
    setRows(intakes.sort((a, b) => b.received_at.localeCompare(a.received_at)));
    setConsignors(people);
    setCategories(cats.filter((c) => (c.module ?? 'kitchen') === 'craft' && c.active));
  };
  useEffect(() => { load().catch((e) => setError(humanError(e))); }, []);

  const nameOf = useMemo(
    () => Object.fromEntries(consignors.map((c) => [c.$id, `${c.code} · ${c.name}`])),
    [consignors],
  );

  /**
   * The paper that goes back with the maker.
   *
   * Prices come from the pieces as they stand, so a slip reprinted after a
   * price correction shows the corrected price. Quantities do not: they come
   * from the arrival movements, which are the record of what was actually
   * handed over on the day.
   *
   * That distinction is the whole fix. Counting the shelf meant a reprinted
   * slip counted down as things sold, and once anything had gone out twice it
   * printed a negative quantity, which is not something anybody ever brought
   * in. A delivery slip is about a past event and has to read the same in a
   * year as it did on the counter.
   */
  const slipFor = async (intake: ConsignmentIntake) => {
    const consignor = consignors.find((c) => c.$id === intake.consignor_id);
    if (!consignor || !settings) { setError('That delivery has no consignor on file.'); return; }

    const [pieces, moves] = await Promise.all([
      listAll<MenuItem>('menu_items', [Query.equal('intake_id', intake.$id)]).catch(() => [] as MenuItem[]),
      listAll<ProductMove>('product_moves', [
        Query.equal('ref_id', intake.$id), Query.equal('type', 'intake'),
      ]).catch(() => [] as ProductMove[]),
    ]);
    if (pieces.length === 0) { setError('Nothing is recorded against that delivery.'); return; }

    const received = new Map<string, number>();
    for (const m of moves) {
      received.set(m.menu_item_id, (received.get(m.menu_item_id) ?? 0) + Math.abs(m.qty_delta));
    }

    openPrintable(
      buildDeliverySlipHtml({
        intake,
        consignor,
        settings,
        pieces: pieces
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => ({
            name: p.name,
            // The movement when there is one. Deliveries booked in before the
            // movements existed fall back to the shelf, taken as a positive.
            qty: received.get(p.$id) ?? Math.abs(p.on_hand ?? 1) ?? 1,
            price: p.price,
            // What one earns them, at this piece's own terms where it has any.
            due: dueFor(p.price, rateFor(p, consignor, settings), flatFor(p, consignor)),
          })),
      }),
      `Delivery slip ${intake.reference}`,
    );
  };

  if (rows === null) return <Spinner />;

  const noPeople = consignors.filter((c) => c.active).length === 0;
  const noCategories = categories.length === 0;

  return (
    <div>
      <div className="page-head">
        <h1>Goods received</h1>
        <Button variant="primary" onClick={() => setReceiving(true)} disabled={noPeople || noCategories}>
          Receive a delivery
        </Button>
      </div>

      {error && <Notice tone="err">{error}</Notice>}

      {/* Named blockers rather than a disabled button with no explanation. A
          greyed-out control that says nothing is the most common way somebody
          decides a screen is broken. */}
      {(noPeople || noCategories) && (
        <Notice>
          Before you can book anything in you need{' '}
          {noPeople && 'at least one consignor'}
          {noPeople && noCategories && ' and '}
          {noCategories && 'at least one craft shop category'}
          . Add {noPeople ? 'people under Consignors' : 'one under Craft shop → Categories'} first.
        </Notice>
      )}

      <Card>
        {rows.length === 0 ? (
          <Empty title="Nothing received yet">
            Each delivery gets a reference and a list of what came in, so a maker asking about a batch
            months later has one thing to look at.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>From</th>
                  <th>Received</th>
                  <th className="num">Pieces</th>
                  <th className="num">Worth</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.$id}>
                    <td><code>{r.reference}</code></td>
                    <td>{nameOf[r.consignor_id] ?? 'Unknown'}</td>
                    <td className="small">{new Date(r.received_at).toLocaleDateString()}</td>
                    <td className="num">{r.piece_count}</td>
                    <td className="num">{money(r.total_retail)}</td>
                    <td className="row-actions">
                      <Button onClick={() => setViewing(r)}>What came in</Button>
                      <Button onClick={() => void slipFor(r)}>Slip</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {receiving && (
        <ReceiveModal
          consignors={consignors.filter((c) => c.active)}
          categories={categories}
          decimals={decimals}
          symbol={settings?.currency_symbol ?? ''}
          settings={settings}
          userId={user?.$id ?? ''}
          onClose={() => setReceiving(false)}
          onDone={async (m, intake) => {
            await load();
            setReceiving(false);
            toast(m);
            // Straight to the slip, because the maker is still at the counter.
            // Asking them to come back for it tomorrow is how it never happens.
            if (intake) await slipFor(intake);
          }}
        />
      )}

      {viewing && (
        <IntakeContents intake={viewing} money={money} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}

/** A piece being booked in, before it is written. */
interface DraftPiece {
  name: string;
  categoryId: string;
  priceText: string;
  qtyText: string;
  note: string;
}

const blankPiece = (categoryId: string): DraftPiece => ({
  name: '', categoryId, priceText: '', qtyText: '1', note: '',
});

/**
 * Book a delivery in.
 *
 * One row per piece, typed straight down the page. Intake happens with a crate
 * on the counter and somebody waiting, so it is a list you can tab through
 * rather than a form you open and close once per basket.
 */
function ReceiveModal({
  consignors, categories, decimals, symbol, settings, userId, onClose, onDone,
}: {
  consignors: Consignor[];
  categories: Category[];
  decimals: number;
  symbol: string;
  settings: Settings | null;
  userId: string;
  onClose: () => void;
  onDone: (message: string, intake?: ConsignmentIntake) => Promise<void>;
}) {
  const [consignorId, setConsignorId] = useState(consignors[0]?.$id ?? '');
  const [reference, setReference] = useState('');
  const [receivedAt, setReceivedAt] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [pieces, setPieces] = useState<DraftPiece[]>([blankPiece(categories[0]?.$id ?? '')]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    nextReference('consignment_intakes', 'INT').then(setReference).catch(() => setReference('INT-0001'));
  }, []);

  const setPiece = (index: number, patch: Partial<DraftPiece>) =>
    setPieces((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const filled = pieces.filter((p) => p.name.trim() && parseMoney(p.priceText, decimals) !== null);
  const totalRetail = filled.reduce(
    (sum, p) => sum + (parseMoney(p.priceText, decimals) ?? 0) * Math.max(1, Number(p.qtyText || 1)),
    0,
  );
  const totalPieces = filled.reduce((sum, p) => sum + Math.max(1, Number(p.qtyText || 1)), 0);

  /**
   * What this delivery is worth to the maker, at today's agreed terms.
   *
   * Worked out here and stored on the delivery rather than recomputed when a
   * statement is opened, because a rate renegotiated next year must not
   * silently restate what a delivery last March was worth.
   */
  const consignor = consignors.find((c) => c.$id === consignorId) ?? null;
  const totalDue = filled.reduce((sum, p) => {
    const price = parseMoney(p.priceText, decimals) ?? 0;
    const qty = Math.max(1, Number(p.qtyText || 1));
    return sum + dueFor(price, rateFor(null, consignor, settings), flatFor(null, consignor)) * qty;
  }, 0);

  const save = async () => {
    if (!consignorId) { setError('Say whose delivery this is.'); return; }
    if (filled.length === 0) { setError('Add at least one piece, with a name and a price.'); return; }
    const bad = pieces.find((p) => p.name.trim() && parseMoney(p.priceText, decimals) === null);
    if (bad) { setError(`"${bad.name}" needs a price.`); return; }

    setBusy(true);
    setError(null);
    try {
      const at = new Date(receivedAt).toISOString();
      const intake = await db.createDocument(DB_ID, 'consignment_intakes', ID.unique(), {
        venue_id: 'main',
        consignor_id: consignorId,
        reference,
        received_at: at,
        received_by: userId,
        piece_count: totalPieces,
        total_retail: totalRetail,
        total_due: totalDue,
        notes: notes.trim(),
        status: 'open',
      });

      for (const p of filled) {
        const price = parseMoney(p.priceText, decimals) ?? 0;
        const qty = Math.max(1, Number(p.qtyText || 1));
        const item = await db.createDocument(DB_ID, 'menu_items', ID.unique(), {
          category_id: p.categoryId || categories[0]?.$id || '',
          name: p.name.trim(),
          description: '',
          price,
          active: true,
          // Not a dish. The kitchen fields are required by the database and
          // mean nothing here, so they get the quietest values they can.
          prep_minutes: 0,
          station: 'inherit',
          station_key: '',
          sort: 0,
          track_stock: false,
          image_focal_x: 0.5,
          image_focal_y: 0.5,
          module: 'craft',
          consignor_id: consignorId,
          intake_id: intake.$id,
          on_hand: qty,
          is_one_off: qty === 1,
          maker_note: p.note.trim(),
        });

        // The arrival, written down. Not a side effect of the product existing:
        // a product can be edited and a movement cannot, which is what makes
        // the history worth having.
        await moveStock({
          venueId: 'main',
          menuItemId: item.$id,
          consignorId,
          type: 'intake',
          qtyDelta: qty,
          unitPrice: price,
          refType: 'intake',
          refId: intake.$id,
          userId,
          // The count was set on the product as it was created, so this must
          // not add it a second time.
          item: null,
        }).catch(() => undefined);
      }

      await onDone(
        `${reference} received, ${totalPieces} piece${totalPieces === 1 ? '' : 's'}`,
        intake as unknown as ConsignmentIntake,
      );
    } catch (e) {
      setError(humanError(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title="Receive a delivery"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy}>
            Book in {totalPieces || ''} {totalPieces === 1 ? 'piece' : 'pieces'}
          </Button>
        </>
      }
    >
      {error && <Notice tone="err">{error}</Notice>}

      <div className="grid-2">
        <Field label="From">
          <Select value={consignorId} onChange={(e) => setConsignorId(e.target.value)}>
            {consignors.map((c) => <option key={c.$id} value={c.$id}>{c.code} · {c.name}</option>)}
          </Select>
        </Field>
        <Field label="Received on">
          <Input type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
        </Field>
      </div>
      <Field label="Reference" hint="Goes on the paperwork you both keep.">
        <Input value={reference} onChange={(e) => setReference(e.target.value)} />
      </Field>

      <Field label="What came in">
        <div>
          {pieces.map((p, i) => (
            <div key={i} className="variant-row">
              <Input
                placeholder="Woven basket, medium"
                value={p.name}
                onChange={(e) => setPiece(i, { name: e.target.value })}
              />
              <Select value={p.categoryId} onChange={(e) => setPiece(i, { categoryId: e.target.value })}>
                {categories.map((c) => <option key={c.$id} value={c.$id}>{c.name}</option>)}
              </Select>
              <Input
                placeholder={`Price ${symbol}`}
                inputMode="decimal"
                value={p.priceText}
                onChange={(e) => setPiece(i, { priceText: e.target.value })}
              />
              <Input
                type="number"
                min="1"
                placeholder="Qty"
                value={p.qtyText}
                onChange={(e) => setPiece(i, { qtyText: e.target.value })}
              />
              {pieces.length > 1 && (
                <Button onClick={() => setPieces((rows) => rows.filter((_, x) => x !== i))}>×</Button>
              )}
            </div>
          ))}

          {/* Rows are added deliberately.
              A blank row that appeared as soon as you started typing meant the
              list was always one longer than what had actually been received,
              and somebody reading back what they had entered had to ignore the
              last line every time. */}
          <Button onClick={() => setPieces((rows) => [...rows, blankPiece(pieces[0]?.categoryId ?? categories[0]?.$id ?? '')])}>
            Add another piece
          </Button>
          {filled.length > 0 && (
            <p className="small dim" style={{ marginBottom: 0 }}>
              {totalPieces} piece{totalPieces === 1 ? '' : 's'} at {symbol}{(totalRetail / 100).toFixed(2)} on the
              shelf, {symbol}{(totalDue / 100).toFixed(2)} of that theirs.
            </p>
          )}
        </div>
      </Field>

      <Field label="Notes">
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>

      <p className="small dim" style={{ marginBottom: 0 }}>
        Everything booked in here goes straight onto the shop floor at the price you set, credited to this
        maker when it sells. Sizes are added afterwards, from the product itself under Craft shop → Products.
      </p>
    </Modal>
  );
}

/** What actually came in on one delivery, and what has become of it. */
function IntakeContents({
  intake, money, onClose,
}: {
  intake: ConsignmentIntake;
  money: (n: number) => string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<MenuItem[] | null>(null);

  useEffect(() => {
    listAll<MenuItem>('menu_items', [Query.equal('intake_id', intake.$id)])
      .then((r) => setItems(r.sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => setItems([]));
  }, [intake.$id]);

  return (
    <Modal wide title={`${intake.reference} · what came in`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <Empty title="Nothing found">
          The pieces from this delivery may have been deleted since.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Piece</th><th className="num">Price</th><th className="num">Left</th><th>State</th></tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.$id}>
                  <td>{i.name}</td>
                  <td className="num">{money(i.price)}</td>
                  <td className="num">{i.on_hand ?? 0}</td>
                  <td>
                    {!i.active ? <Badge>Withdrawn</Badge>
                      : (i.on_hand ?? 0) <= 0 ? <Badge tone="ok">All sold</Badge>
                        : <Badge tone="warn">On the floor</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {intake.notes && <p className="small dim">{intake.notes}</p>}
    </Modal>
  );
}
