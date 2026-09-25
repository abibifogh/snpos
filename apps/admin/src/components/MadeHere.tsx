import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Field, Input, Modal, Notice, Select, useToast } from '@snpos/ui';
import {
  batchSheet, recordBatch, lastBatchOf, openIn, purchaseLocation, levelFor,
  batchQty, batchProblem, shortInputs, usedInputs, batchCost, batchWords, prefillFrom, crossSideValue,
  MODULE_LABELS,
} from '@snpos/core';
import type { BatchInput, Ingredient, Doc, LocationStock, StockLocation, Module } from '@snpos/core';
import { humanError } from '../lib';
import { useMoney } from '../session';

type Item = Ingredient & Doc & { module?: string };

/**
 * DRINKS MADE HERE, received into stock once they are made.
 *
 * Sobolo, ginger beer, a house punch: made in a pot, bottled, and put in the
 * store room or behind the bar. What went into it comes off its shelf in the
 * same step, and the drink arrives carrying what that cost — see
 * batch-rules.ts for why both halves matter.
 *
 * Lives on the page about places because that is the question it answers:
 * where the bottles went. The next batch of the same drink starts from the
 * last one, so a recipe made every week is never typed twice.
 */
export function MadeHere({
  module,
  userId,
  hasPlace,
  onDone,
}: {
  module: Module;
  userId: string;
  /**
   * Whether this side has a store room or a bar to put a batch in, as the page
   * already knows. NOT worked out from this card's own list of places: that
   * list is only read when the button is pressed, so asking it first meant an
   * empty list, a disabled button, and a button that could never be pressed.
   */
  hasPlace: boolean;
  onDone: () => Promise<void> | void;
}) {
  const toast = useToast();
  const money = useMoney();

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [levels, setLevels] = useState<LocationStock[]>([]);
  const [places, setPlaces] = useState<(StockLocation & Doc)[]>([]);

  const [madeId, setMadeId] = useState('');
  const [madeQtyText, setMadeQtyText] = useState('');
  const [intoId, setIntoId] = useState('');
  const [inputs, setInputs] = useState<BatchInput[]>([]);
  const [note, setNote] = useState('');
  /** Whether the inputs have been edited by hand, so they stop following the quantity. */
  const [touched, setTouched] = useState(false);
  /** The last batch of this drink, which the inputs start from. */
  const [last, setLast] = useState<Awaited<ReturnType<typeof lastBatchOf>>>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mine = useMemo(() => openIn(places, module), [places, module]);
  const made = items.find((i) => i.$id === madeId) ?? null;
  const into = mine.find((p) => p.$id === intoId) ?? null;

  const start = async () => {
    setError(null);
    setMadeId('');
    setMadeQtyText('');
    setInputs([]);
    setNote('');
    setTouched(false);
    setLast(null);
    try {
      const sheet = await batchSheet('main');
      setItems(sheet.items as Item[]);
      setLevels(sheet.levels);
      setPlaces(sheet.places as (StockLocation & Doc)[]);
      // A batch is put down in the store room, the same as a delivery.
      setIntoId(purchaseLocation(openIn(sheet.places, module), module)?.$id ?? '');
      setOpen(true);
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  /** Where an ingredient is held, most first — the obvious place to take it from. */
  const placesFor = (item: Item | undefined) => {
    if (!item) return [];
    return openIn(places, item.module ?? 'kitchen')
      .map((p) => ({ place: p, qty: levelFor(levels, item.$id, p.$id) }))
      .sort((a, b) => b.qty - a.qty);
  };

  /** A row for one ingredient, from one place, filled in with what is known about both. */
  const rowFor = (item: Item, locationId?: string, qtyText = ''): BatchInput => {
    const where = locationId ?? placesFor(item)[0]?.place.$id ?? '';
    return {
      ingredientId: item.$id,
      name: item.name,
      unit: item.unit,
      module: item.module ?? 'kitchen',
      locationId: where,
      // A side with no places keeps one figure; that is what is available.
      available: where ? levelFor(levels, item.$id, where) : (item.current_qty ?? 0),
      unitCost: item.base_unit_cost ?? 0,
      qtyText,
    };
  };

  /** Fill the inputs from the last batch, scaled to what is being made now. */
  const fillFrom = (past: typeof last, qty: number | null) => {
    setInputs(prefillFrom(past, qty)
      .map((r) => {
        const item = items.find((i) => i.$id === r.ingredientId);
        // An ingredient archived since is left out rather than guessed at.
        return item ? rowFor(item, r.locationId || undefined, r.qtyText) : null;
      })
      .filter((r): r is BatchInput => r !== null));
  };

  const chooseMade = async (id: string) => {
    setMadeId(id);
    setTouched(false);
    const past = id ? await lastBatchOf(id) : null;
    setLast(past);
    fillFrom(past, batchQty(madeQtyText));
  };

  // Until somebody edits the inputs by hand, they follow the quantity.
  useEffect(() => {
    if (!touched && last) fillFrom(last, batchQty(madeQtyText));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [madeQtyText]);

  const edit = (index: number, change: Partial<BatchInput>) => {
    setTouched(true);
    setInputs((rows) => rows.map((r, i) => {
      if (i !== index) return r;
      const next = { ...r, ...change };
      if (change.locationId !== undefined) {
        const item = items.find((x) => x.$id === next.ingredientId);
        next.available = next.locationId ? levelFor(levels, next.ingredientId, next.locationId) : (item?.current_qty ?? 0);
      }
      return next;
    }));
  };

  const addRow = (id: string) => {
    const item = items.find((i) => i.$id === id);
    if (!item) return;
    setTouched(true);
    setInputs((rows) => [...rows, rowFor(item)]);
  };

  const problem = batchProblem({ madeId, madeQtyText, locationId: intoId, inputs });
  const short = shortInputs(inputs);
  const used = usedInputs(inputs);
  const total = batchCost(inputs);
  const madeQty = batchQty(madeQtyText) ?? 0;
  const crossing = made ? crossSideValue(inputs, made.module ?? module) : [];

  const save = async () => {
    if (problem || !made) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      const out = await recordBatch({
        venueId: 'main', madeId, madeQty, locationId: intoId, inputs, userId, note,
      });
      setOpen(false);
      await onDone();
      // Named, never counted: the line that did not move is the one the next
      // count will find, and whoever reads this needs to know which.
      toast(out.failed.length
        ? `The batch is recorded, but ${out.failed.join(', ')} did not move. The next count will show it.`
        : batchWords({
          madeName: made.name, madeQty, unit: made.unit, placeName: into?.name ?? 'stock',
          total: out.total, inputsCount: used.length, money,
        }), out.failed.length ? 'err' : 'ok');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const drinks = items.filter((i) => (i.module ?? 'kitchen') === module)
    .sort((a, b) => a.name.localeCompare(b.name));
  const others = items.filter((i) => i.$id !== madeId && !inputs.some((r) => r.ingredientId === i.$id))
    .sort((a, b) => (a.module ?? '').localeCompare(b.module ?? '') || a.name.localeCompare(b.name));

  return (
    <>
      <Card title="Made here">
        <p className="small dim" style={{ marginTop: 0 }}>
          For drinks made in the house — sobolo, ginger beer, a punch. Record a batch once it is made and bottled:
          it goes into the store room or the bar, and whatever went into it comes off its own shelf.
        </p>
        <Button onClick={() => void start()} disabled={!hasPlace}>Record a batch</Button>
        {!hasPlace && (
          <p className="small dim" style={{ marginBottom: 0 }}>Add a store room or a bar above first, so it has somewhere to go.</p>
        )}
      </Card>

      {open && (
        <Modal
          wide
          title="Record a batch"
          onClose={() => (busy ? undefined : setOpen(false))}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
              <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!!problem}>
                Receive it
              </Button>
            </>
          }
        >
          {error && <div style={{ marginBottom: '0.8rem' }}><Notice>{error}</Notice></div>}

          <div className="grid-2">
            <Field
              label="What was made"
              hint={drinks.length === 0 ? `Add it under ${MODULE_LABELS[module]} stock first, as something poured from.` : undefined}
            >
              <Select value={madeId} onChange={(e) => void chooseMade(e.target.value)}>
                <option value="">Choose…</option>
                {drinks.map((d) => <option key={d.$id} value={d.$id}>{d.name} ({d.unit})</option>)}
              </Select>
            </Field>
            <Field label={`How much${made ? `, in ${made.unit}` : ''}`}>
              <Input
                type="number" step="any" min="0" inputMode="decimal" placeholder="24"
                value={madeQtyText} onChange={(e) => setMadeQtyText(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Put into">
            <Select value={intoId} onChange={(e) => setIntoId(e.target.value)}>
              {mine.map((p) => <option key={p.$id} value={p.$id}>{p.name}</option>)}
            </Select>
          </Field>

          <h3 style={{ margin: '1rem 0 0.3rem' }}>What went into it</h3>
          <p className="small dim" style={{ marginTop: 0 }}>
            {last
              ? 'Filled in from the last batch, scaled to this one. Change anything that was different this time.'
              : 'Optional. Anything listed comes off its shelf, and the batch costs what they were worth.'}
          </p>

          {inputs.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Ingredient</th><th>Taken from</th><th className="num">There now</th><th style={{ width: '7rem' }}>Used</th><th /></tr>
                </thead>
                <tbody>
                  {inputs.map((r, i) => {
                    const item = items.find((x) => x.$id === r.ingredientId);
                    const choices = placesFor(item);
                    return (
                      <tr key={`${r.ingredientId}-${i}`}>
                        <td style={{ fontWeight: 550 }}>
                          {r.name} <span className="dim small">{r.unit}</span>
                          {(r.module ?? 'kitchen') !== (made?.module ?? module) && (
                            <div className="small dim">{MODULE_LABELS[(r.module ?? 'kitchen') as Module]} stock</div>
                          )}
                        </td>
                        <td>
                          {choices.length === 0 ? (
                            <span className="small dim">Its one figure</span>
                          ) : (
                            <Select value={r.locationId} onChange={(e) => edit(i, { locationId: e.target.value })}>
                              {choices.map((c) => <option key={c.place.$id} value={c.place.$id}>{c.place.name}</option>)}
                            </Select>
                          )}
                        </td>
                        <td className="num dim">{Number(r.available.toFixed(3))}</td>
                        <td>
                          <Input
                            type="number" step="any" min="0" placeholder="—"
                            value={r.qtyText ?? ''} onChange={(e) => edit(i, { qtyText: e.target.value })}
                          />
                        </td>
                        <td className="num">
                          <Button
                            size="sm" variant="ghost"
                            onClick={() => { setTouched(true); setInputs((rows) => rows.filter((_, j) => j !== i)); }}
                          >
                            Remove
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <Field label="Add an ingredient">
            <Select value="" onChange={(e) => addRow(e.target.value)}>
              <option value="">Choose…</option>
              {others.map((o) => (
                <option key={o.$id} value={o.$id}>
                  {o.name} · {MODULE_LABELS[(o.module ?? 'kitchen') as Module]}
                </option>
              ))}
            </Select>
          </Field>

          {/* Warned about, not refused: the person with the sugar in front of
              them is looking at the answer. */}
          {short.length > 0 && (
            <Notice tone="warn">
              More {short.map((s) => s.name).join(', ')} than the book says is there. That is allowed — the shelf
              is the truth — but the next count there will be worth a look.
            </Notice>
          )}

          {made && madeQty > 0 && (
            <Notice tone={total > 0 ? 'info' : 'warn'}>
              {batchWords({
                madeName: made.name, madeQty, unit: made.unit, placeName: into?.name ?? 'stock',
                total, inputsCount: used.length, money,
              })}
              {crossing.length > 0 && (
                <>
                  {' '}{money(crossing.reduce((n, c) => n + c.value, 0))} of it moves from{' '}
                  {crossing.map((c) => MODULE_LABELS[c.module as Module]).join(' and ')} stock to{' '}
                  {MODULE_LABELS[(made.module ?? module) as Module]} stock in the books.
                </>
              )}
            </Notice>
          )}

          <Field label="Note" hint="Optional. Kept with the batch.">
            <Input value={note} placeholder="Thinner than usual, less hibiscus" onChange={(e) => setNote(e.target.value)} />
          </Field>
        </Modal>
      )}
    </>
  );
}
