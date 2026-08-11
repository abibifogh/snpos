import { useEffect, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Spinner, Toggle, Badge, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import type { Doc } from '@snpos/core';

interface Station extends Doc {
  venue_id: string;
  key: string;
  name: string;
  colour?: string;
  sort: number;
  active: boolean;
}

/** What most kitchens start with. Offered, not imposed. */
const SUGGESTED = [
  { key: 'hot', name: 'Hot line', colour: '#d92d20' },
  { key: 'cold', name: 'Cold / salads', colour: '#0ea5e9' },
  { key: 'bar', name: 'Bar', colour: '#7c3aed' },
  { key: 'dessert', name: 'Desserts', colour: '#f59e0b' },
];

export function StationsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<Station[] | null>(null);
  const [editing, setEditing] = useState<Partial<Station> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => listAll<Station>('stations').then((r) => setRows(r.sort((a, b) => a.sort - b.sort)));
  useEffect(() => { load().catch((e) => setError(humanError(e))); }, []);

  const save = async () => {
    if (!editing?.name?.trim()) { setError('Give the station a name.'); return; }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        venue_id: editing.venue_id ?? 'main',
        // The key is what gets written onto every dish and ticket, so it is set
        // once at creation and never edited, renaming a station should not
        // orphan the dishes pointing at it.
        key: editing.key || editing.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
        name: editing.name.trim(),
        colour: editing.colour ?? '',
        sort: Number(editing.sort ?? 0),
        active: editing.active ?? true,
      };
      if (editing.$id) await db.updateDocument(DB_ID, 'stations', editing.$id, payload);
      else await db.createDocument(DB_ID, 'stations', ID.unique(), payload);
      setEditing(null);
      await load();
      toast('Station saved');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const addSuggested = async () => {
    setBusy(true);
    try {
      for (const [i, s] of SUGGESTED.entries()) {
        await db.createDocument(DB_ID, 'stations', ID.unique(), {
          venue_id: 'main', key: s.key, name: s.name, colour: s.colour, sort: i, active: true,
        }).catch(() => undefined);
      }
      await load();
      toast('Added the usual four, rename or remove any of them');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="spread">
        <h1>Stations</h1>
        <Button variant="primary" onClick={() => { setEditing({ name: '', sort: (rows?.length ?? 0), active: true }); setError(null); }}>
          Add station
        </Button>
      </div>

      <p className="dim small" style={{ marginTop: 0 }}>
        A station is <strong>where food is cooked</strong>, hot line, grill, bar, pastry. Each dish is sent to one,
        and the kitchen screen can be filtered to show only that station's tickets.
      </p>

      <Notice tone="warn">
        <strong>Stations are not pickup points.</strong> A station is inside the kitchen; a pickup point is where the
        customer collects. One kitchen with three stations can serve four pickup points, and often does. Pickup points
        live under Venues.
      </Notice>

      {error && !editing && <Notice>{error}</Notice>}

      <Card pad={false}>
        {!rows ? (
          <div className="card-pad"><Spinner /></div>
        ) : rows.length === 0 ? (
          <div className="card-pad">
            <Empty title="No stations yet">
              Dishes fall back to a single default until you define some.
            </Empty>
            <div style={{ textAlign: 'center' }}>
              <Button onClick={addSuggested} loading={busy}>Start with the usual four</Button>
            </div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th /><th>Name</th><th>Key</th><th>Status</th><th /></tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.$id}>
                    <td>
                      <span style={{
                        display: 'inline-block', width: 14, height: 14, borderRadius: 4,
                        background: s.colour || 'var(--border)',
                      }} />
                    </td>
                    <td style={{ fontWeight: 550 }}>{s.name}</td>
                    <td className="dim small"><code>{s.key}</code></td>
                    <td>{s.active ? <Badge tone="ok">Active</Badge> : <Badge>Off</Badge>}</td>
                    <td className="num"><Button size="sm" variant="ghost" onClick={() => setEditing(s)}>Edit</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <Modal
          title={editing.$id ? `Edit ${editing.name}` : 'Add station'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={save} loading={busy}>Save</Button>
            </>
          }
        >
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
          <Field label="Name" hint="What the kitchen calls it.">
            <Input value={editing.name ?? ''} autoFocus placeholder="Grill" onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </Field>
          {editing.$id && (
            <Field label="Key" hint="Fixed once created, dishes point at this. Rename the station freely; the key stays.">
              <Input value={editing.key ?? ''} disabled />
            </Field>
          )}
          <div className="grid-2">
            <Field label="Colour" hint="Used on kitchen tickets so a glance is enough.">
              <div className="color-row">
                <input type="color" value={editing.colour || '#0f766e'} onChange={(e) => setEditing({ ...editing, colour: e.target.value })} />
                <Input value={editing.colour ?? ''} onChange={(e) => setEditing({ ...editing, colour: e.target.value })} />
              </div>
            </Field>
            <Field label="Sort order">
              <Input type="number" value={editing.sort ?? 0} onChange={(e) => setEditing({ ...editing, sort: Number(e.target.value) })} />
            </Field>
          </div>
          <Field hint="Turning a station off hides its tab on the kitchen screen. Dishes assigned to it still cook, they just appear under All.">
            <Toggle checked={editing.active ?? true} onChange={(v) => setEditing({ ...editing, active: v })} label="Active" />
          </Field>
        </Modal>
      )}
    </>
  );
}
