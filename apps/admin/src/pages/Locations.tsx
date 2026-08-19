import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, useToast, Segmented} from '@snpos/ui';
import { db, DB_ID, ID, humanError } from '../lib';
import {
  loadLocations, loadLevels, loadIngredients, transferSheet, transferStock,
  openIn, purchaseLocation, saleLocation, transferProblem, overdrawn, transferQty,
  LOCATION_KINDS, MODULE_LABELS, modulesOf,
} from '@snpos/core';
import type { StockLocation, LocationStock, TransferLine, Module, Doc } from '@snpos/core';
import { useSession } from '../session';
import { LevelUpload } from '../components/LevelUpload';

/**
 * Where stock sits, and moving it between places.
 *
 * A bar buys a case of tonic into a store room and carries bottles out as the
 * night needs them. One number cannot describe that: "forty-two tonics" is
 * true of the business and useless to the person behind the bar, who has nine
 * and is about to run out — and useless to whoever does the ordering, who sees
 * forty-two and buys nothing.
 *
 * A business that never sets a place up keeps working exactly as it did. Every
 * rule resolves to the one location it has, or to the old single-number
 * behaviour when it has none.
 */
export function LocationsPage() {
  const { settings, profile, user } = useSession();
  const toast = useToast();

  const [places, setPlaces] = useState<(StockLocation & Doc)[] | null>(null);
  const [levels, setLevels] = useState<LocationStock[]>([]);
  const [editing, setEditing] = useState<Partial<StockLocation & Doc> | null>(null);
  const [module, setModule] = useState<Module>('bar');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Moving stock
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [lines, setLines] = useState<TransferLine[] | null>(null);
  const [filter, setFilter] = useState('');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [uploading, setUploading] = useState(false);
  /** The room whose contents are being read. */
  const [looking, setLooking] = useState<(StockLocation & Doc) | null>(null);
  const [lookFilter, setLookFilter] = useState('');
  const [stock, setStock] = useState<{ $id: string; name: string; unit: string }[]>([]);

  const mods = modulesOf(settings);
  const isAdmin = profile?.role === 'admin' || profile?.role === 'manager';

  const load = async () => {
    try {
      const p = await loadLocations('main');
      setPlaces(p);
      setLevels(await loadLevels());
      setStock((await loadIngredients('main')).filter((i) => i.active).map((i) => ({
        $id: i.$id, name: i.name, unit: i.unit,
      })));
    } catch (e) {
      setError(humanError(e));
    }
  };
  useEffect(() => { void load(); }, []);

  const mine = useMemo(() => openIn(places ?? [], module) as (StockLocation & Doc)[], [places, module]);

  // Default the two ends to the obvious answer: out of the store, into the bar.
  useEffect(() => {
    if (!fromId) setFromId(purchaseLocation(mine, module)?.$id ?? '');
    if (!toId) setToId(saleLocation(mine, module)?.$id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine.length]);

  useEffect(() => {
    if (!fromId) { setLines(null); return; }
    transferSheet('main', module, fromId).then(setLines).catch(() => setLines([]));
  }, [fromId, module]);

  const from = mine.find((l) => l.$id === fromId) ?? null;
  const to = mine.find((l) => l.$id === toId) ?? null;
  const problem = transferProblem(from, to, lines ?? []);
  const over = overdrawn(lines ?? []);
  const moving = (lines ?? []).filter((l) => transferQty(l) !== null);

  const savePlace = async () => {
    if (!editing?.name?.trim()) { setError('Give the place a name.'); return; }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        venue_id: 'main',
        name: editing.name.trim(),
        kind: editing.kind ?? 'counter',
        module: editing.module ?? module,
        active: editing.active !== false,
        sort: Number(editing.sort ?? (places?.length ?? 0)),
      };
      if (editing.$id) await db.updateDocument(DB_ID, 'stock_locations', editing.$id, payload);
      else await db.createDocument(DB_ID, 'stock_locations', ID.unique(), payload);
      setEditing(null);
      await load();
      toast('Saved');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const move = async () => {
    setBusy(true);
    setError(null);
    try {
      const { moved, failed } = await transferStock({
        venueId: 'main', fromId, toId, lines: lines ?? [], userId: user?.$id ?? '', note,
      });
      setConfirming(false);
      setNote('');
      await load();
      setLines(await transferSheet('main', module, fromId));
      toast(
        failed > 0
          ? `${moved} moved, ${failed} could not be. Those are still where they were.`
          : `${moved} line${moved === 1 ? '' : 's'} moved to ${to?.name}`,
        failed > 0 ? 'err' : 'ok',
      );
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const setLine = (id: string, qtyText: string) =>
    setLines((rows) => (rows ?? []).map((r) => (r.ingredientId === id ? { ...r, qtyText } : r)));

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (lines ?? []).filter((l) => !q || l.name.toLowerCase().includes(q));
  }, [lines, filter]);

  const heldAt = (locationId: string) =>
    levels.filter((l) => l.location_id === locationId).reduce((n, l) => n + (l.qty > 0 ? 1 : 0), 0);

  /**
   * What is actually in one room, rather than how many kinds of thing are.
   *
   * A count on its own answers nothing: "23 things held" is a number nobody
   * can act on, and the question behind clicking it is always "which ones".
   * Sorted by how much is there, most first, because a store room is read to
   * find what it is holding rather than to look one item up.
   */
  const contentsOf = (locationId: string) =>
    levels
      .filter((l) => l.location_id === locationId && l.qty !== 0)
      .map((l) => ({
        ...l,
        item: stock.find((s2) => s2.$id === l.ingredient_id),
      }))
      .filter((l) => l.item)
      .sort((a, b) => b.qty - a.qty || (a.item?.name ?? '').localeCompare(b.item?.name ?? ''));

  if (!isAdmin) {
    return (<><h1>Where stock sits</h1><Notice>Only an admin or a manager can move stock between places.</Notice></>);
  }

  return (
    <>
      <div className="spread">
        <h1>Where stock sits</h1>
        <div className="row" style={{ gap: '0.5rem' }}>
          {/* Counting forty items twice on day one is the kind of task that
              gets done badly or not at all. */}
          {mine.length > 0 && (
            <Button onClick={() => setUploading(true)}>Upload opening levels</Button>
          )}
          <Button variant="primary" onClick={() => setEditing({ name: '', kind: 'counter', module })}>
            Add a place
          </Button>
        </div>
      </div>

      <p className="dim" style={{ maxWidth: '46rem' }}>
        A delivery is put down in a store room, and stock is carried out to a counter as it is needed. What you buy
        lands in the store; what you sell or pour comes off the counter; and the counter is what gets counted at the
        start and end of a shift. Until you set a place up, everything behaves exactly as it did.
      </p>

      {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

      {([ 'kitchen', 'bar', 'craft' ] as Module[]).filter((m) => mods[m]).length > 1 && (
        // Which trade's storerooms, which narrows a list rather than changing
        // the screen — so it is the filter shape, not the tab shape.
        <div style={{ marginBottom: '0.8rem' }}>
          <Segmented<Module>
            ariaLabel="Which side of the business"
            value={module}
            onChange={(m) => { setModule(m); setFromId(''); setToId(''); }}
            options={(['kitchen', 'bar', 'craft'] as Module[])
              .filter((m) => mods[m])
              .map((m) => ({ value: m, label: MODULE_LABELS[m] }))}
          />
        </div>
      )}

      <Card title="Places" pad={false}>
        {!places ? (
          <div className="card-pad"><Spinner /></div>
        ) : mine.length === 0 ? (
          <Empty title="No places set up for this side">
            Add a store room and a counter, and stock starts being tracked in both. One place on its own is fine
            too — it simply takes deliveries and sells from the same shelf, which is what happens today.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Name</th><th>What it is</th><th className="num">Things held</th><th /></tr></thead>
              <tbody>
                {mine.map((l) => (
                  <tr key={l.$id}>
                    <td style={{ fontWeight: 550 }}>
                      {l.name}
                      {purchaseLocation(mine, module)?.$id === l.$id && <Badge tone="ok"> deliveries land here</Badge>}
                      {saleLocation(mine, module)?.$id === l.$id && <Badge tone="warn"> sales come off here</Badge>}
                    </td>
                    <td className="dim small">{LOCATION_KINDS.find((k) => k.value === l.kind)?.label}</td>
                    <td className="num">
                      {/* The number opens what is behind it. A figure nobody
                          can click is a figure somebody has to trust. */}
                      <Button size="sm" variant="ghost" onClick={() => setLooking(l)}>
                        {heldAt(l.$id)}
                      </Button>
                    </td>
                    <td className="num">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(l)}>Edit</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {mine.length > 1 && (
        <>
          <Card title="Move stock">
            <div className="grid-2">
              <Field label="Out of">
                <Select value={fromId} onChange={(e) => setFromId(e.target.value)}>
                  {mine.map((l) => <option key={l.$id} value={l.$id}>{l.name}</option>)}
                </Select>
              </Field>
              <Field label="Into">
                <Select value={toId} onChange={(e) => setToId(e.target.value)}>
                  {mine.map((l) => <option key={l.$id} value={l.$id}>{l.name}</option>)}
                </Select>
              </Field>
            </div>
            <Field label="Search">
              <Input value={filter} placeholder="Tonic, gin…" onChange={(e) => setFilter(e.target.value)} />
            </Field>
            {/* Warned about, never refused. Somebody standing in the store
                holding four cases the system says are three is looking at the
                answer, and a system that argues is one they route around by
                not recording the transfer at all. */}
            {over.length > 0 && (
              <Notice tone="warn">
                {over.length} line{over.length === 1 ? '' : 's'} moving more than {from?.name} is recorded as
                holding: {over.slice(0, 3).map((l) => l.name).join(', ')}
                {over.length > 3 && ` and ${over.length - 3} more`}. That is allowed — the shelf is the truth and
                the book is a claim about it — but it is worth a look.
              </Notice>
            )}
            <div className="row" style={{ gap: '0.5rem', marginTop: '0.6rem', alignItems: 'center' }}>
              <Button
                variant="primary"
                disabled={!!problem}
                onClick={() => setConfirming(true)}
              >
                {moving.length ? `Move ${moving.length} line${moving.length === 1 ? '' : 's'}` : 'Nothing to move yet'}
              </Button>
              {problem && <span className="small dim">{problem}</span>}
            </div>
          </Card>

          <Card pad={false}>
            {!lines ? (
              <div className="card-pad"><Spinner /></div>
            ) : shown.length === 0 ? (
              <Empty title="Nothing here">
                {(lines ?? []).length === 0
                  ? 'Nothing is stocked on this side yet.'
                  : 'Nothing matches that search.'}
              </Empty>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>What</th>
                      <th className="num">In {from?.name ?? 'the source'}</th>
                      <th style={{ width: '7rem' }}>Move</th>
                      <th className="num">Leaves behind</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((l) => {
                      const q = transferQty(l);
                      return (
                        <tr key={l.ingredientId}>
                          <td style={{ fontWeight: 550 }}>{l.name} <span className="dim small">{l.unit}</span></td>
                          <td className="num">{l.available}</td>
                          <td>
                            <Input
                              type="number"
                              step="any"
                              min="0"
                              placeholder="—"
                              value={l.qtyText ?? ''}
                              onChange={(e) => setLine(l.ingredientId, e.target.value)}
                            />
                          </td>
                          <td className="num">
                            {q === null ? <span className="dim">—</span> : (
                              <Badge tone={l.available - q < 0 ? 'danger' : 'default'}>
                                {Number((l.available - q).toFixed(4))}
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
        </>
      )}

      {uploading && (
        <LevelUpload
          ingredients={stock}
          locations={mine}
          userId={user?.$id ?? ''}
          onClose={() => setUploading(false)}
          onDone={async (m) => { await load(); if (fromId) setLines(await transferSheet('main', module, fromId)); toast(m); }}
        />
      )}

      {confirming && (
        <Modal
          title={`Move ${moving.length} line${moving.length === 1 ? '' : 's'} to ${to?.name}?`}
          onClose={() => (busy ? undefined : setConfirming(false))}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</Button>
              <Button variant="primary" onClick={() => void move()} loading={busy}>Move it</Button>
            </>
          }
        >
          {/* Said plainly, because it is the thing people get wrong about a
              transfer: nothing has been bought, sold or lost. */}
          <Notice tone="info">
            Nothing is bought, sold or lost by this — the business owns exactly as much afterwards. It moves from
            one shelf to another, and each end is recorded so the count at either place adds up.
          </Notice>
          <div className="table-wrap" style={{ maxHeight: '34vh', overflowY: 'auto' }}>
            <table className="data">
              <thead><tr><th>What</th><th className="num">Moving</th><th className="num">{from?.name} left with</th></tr></thead>
              <tbody>
                {moving.map((l) => (
                  <tr key={l.ingredientId}>
                    <td>{l.name}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{transferQty(l)} {l.unit}</td>
                    <td className="num dim">{Number((l.available - (transferQty(l) ?? 0)).toFixed(4))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Field label="Note" hint="Goes on both ends of every movement. Optional.">
            <Input value={note} placeholder="Friday restock" onChange={(e) => setNote(e.target.value)} />
          </Field>
        </Modal>
      )}

      {editing && (
        <Modal
          title={editing.$id ? 'Edit place' : 'Add a place'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => void savePlace()} loading={busy}>Save</Button>
            </>
          }
        >
          <Field label="Name">
            <Input
              value={editing.name ?? ''}
              autoFocus
              placeholder="Store room, The bar"
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </Field>
          <Field label="What it is">
            <Select
              value={editing.kind ?? 'counter'}
              onChange={(e) => setEditing({ ...editing, kind: e.target.value as StockLocation['kind'] })}
            >
              {LOCATION_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </Select>
          </Field>
          <p className="small dim">
            {LOCATION_KINDS.find((k) => k.value === (editing.kind ?? 'counter'))?.help}
          </p>
          <Field label="Which side">
            <Select
              value={editing.module ?? module}
              onChange={(e) => setEditing({ ...editing, module: e.target.value as Module })}
            >
              {(['kitchen', 'bar', 'craft'] as Module[]).filter((m) => mods[m]).map((m) => (
                <option key={m} value={m}>{MODULE_LABELS[m]}</option>
              ))}
            </Select>
          </Field>
          {editing.$id && (
            <Field hint="An archived place keeps everything it holds and comes off the lists.">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={editing.active !== false}
                  onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
                />{' '}
                In use
              </label>
            </Field>
          )}
          <p className="small dim" style={{ marginBottom: 0 }}>
            Deliveries land in the first store room and sales come off the first counter. With one place, it does
            both, which is how a business that has never thought about this keeps working unchanged.
          </p>
        </Modal>
      )}

      {looking && (() => {
        const rows = contentsOf(looking.$id)
          .filter((r) => !lookFilter.trim()
            || (r.item?.name ?? '').toLowerCase().includes(lookFilter.trim().toLowerCase()));
        const units = rows.reduce((n, r) => n + r.qty, 0);
        return (
          <Modal
            wide
            title={`What is in ${looking.name}`}
            onClose={() => { setLooking(null); setLookFilter(''); }}
            footer={<Button onClick={() => { setLooking(null); setLookFilter(''); }}>Close</Button>}
          >
            <div className="row row-wrap" style={{ gap: '1.4rem', marginBottom: '0.9rem' }}>
              <div>
                <div className="dim small">Different things</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 650 }}>{rows.length}</div>
              </div>
              <div>
                <div className="dim small">Units in all</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 650 }}>{Number(units.toFixed(2))}</div>
              </div>
            </div>

            <Input
              placeholder="Search this room…"
              value={lookFilter}
              onChange={(e) => setLookFilter(e.target.value)}
            />

            {rows.length === 0 ? (
              <div style={{ marginTop: '0.9rem' }}>
                <Empty title={lookFilter ? 'Nothing here matches that' : 'Nothing is held here yet'}>
                  Move stock in from another place, or set opening levels from a file.
                </Empty>
              </div>
            ) : (
              <div className="table-wrap" style={{ maxHeight: '46vh', overflowY: 'auto', marginTop: '0.9rem' }}>
                <table className="data">
                  <thead><tr><th>What</th><th className="num">How much</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.ingredient_id}>
                        <td style={{ fontWeight: 550 }}>{r.item?.name}</td>
                        <td className="num">
                          {Number(r.qty.toFixed(3))} <span className="dim small">{r.item?.unit}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Modal>
        );
      })()}
    </>
  );
}
