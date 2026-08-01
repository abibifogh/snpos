import { useEffect, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Spinner, Toggle, Badge, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import { parseWindows, describeWindows, isAvailable } from '@snpos/core';
import type { Venue, DayKey, Windows } from '@snpos/core';

const DAYS: { key: DayKey; label: string }[] = [
  { key: 'mon', label: 'Monday' }, { key: 'tue', label: 'Tuesday' }, { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' }, { key: 'fri', label: 'Friday' }, { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
];

/** Editing hours as free JSON is a trap, so drive it from one row per day. */
function HoursEditor({ value, onChange }: { value: Windows; onChange: (w: Windows) => void }) {
  const setDay = (day: DayKey, open: boolean, from = '09:00', to = '22:00') => {
    const next = { ...value };
    if (open) next[day] = [[from, to]];
    else delete next[day];
    onChange(next);
  };

  return (
    <div>
      {DAYS.map(({ key, label }) => {
        const range = value[key]?.[0];
        return (
          <div className="row" key={key} style={{ padding: '0.4rem 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ width: '6.5rem', fontSize: '0.88rem' }}>{label}</div>
            <Toggle checked={!!range} onChange={(v) => setDay(key, v)} />
            {range ? (
              <>
                <Input
                  type="time"
                  value={range[0]}
                  style={{ width: '8rem' }}
                  onChange={(e) => setDay(key, true, e.target.value, range[1])}
                />
                <span className="dim">to</span>
                <Input
                  type="time"
                  value={range[1]}
                  style={{ width: '8rem' }}
                  onChange={(e) => setDay(key, true, range[0], e.target.value)}
                />
              </>
            ) : (
              <span className="dim small">Closed</span>
            )}
          </div>
        );
      })}
      <p className="hint" style={{ marginTop: '0.7rem' }}>
        A closing time earlier than the opening time means past midnight — 18:00 to 02:00 is a valid late shift.
      </p>
    </div>
  );
}

export function VenuesPage() {
  const toast = useToast();
  const [rows, setRows] = useState<Venue[] | null>(null);
  const [editing, setEditing] = useState<Partial<Venue> | null>(null);
  const [hours, setHours] = useState<Windows>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => listAll<Venue>('venues').then((r) => setRows(r.sort((a, b) => a.sort - b.sort)));
  useEffect(() => { load().catch((e) => setError(humanError(e))); }, []);

  const open = (v?: Venue) => {
    setEditing(v ?? { name: '', slug: '', timezone: 'Africa/Accra', active: true, sort: (rows?.length ?? 0) });
    setHours(parseWindows(v?.opening_hours) ?? {});
    setError(null);
  };

  const save = async () => {
    if (!editing?.name?.trim()) { setError('A venue needs a name.'); return; }
    const slug = (editing.slug || editing.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    setBusy(true);
    setError(null);
    const payload = {
      name: editing.name.trim(),
      slug,
      address: editing.address ?? '',
      phone: editing.phone ?? '',
      timezone: editing.timezone || 'Africa/Accra',
      active: editing.active ?? true,
      sort: Number(editing.sort ?? 0),
      shift_float_policy: 'inherit',
      shift_float_default: 0,
      opening_hours: Object.keys(hours).length ? JSON.stringify(hours) : '',
    };
    try {
      if (editing.$id) await db.updateDocument(DB_ID, 'venues', editing.$id, payload);
      else await db.createDocument(DB_ID, 'venues', ID.unique(), payload);
      setEditing(null);
      await load();
      toast('Venue saved');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="spread">
        <h1>Venues</h1>
        <Button variant="primary" onClick={() => open()}>Add venue</Button>
      </div>

      <p className="dim small" style={{ marginTop: 0 }}>
        Opening hours matter beyond looking tidy: without them the system cannot tell customers when you are open, and
        ordering ahead has no times to offer.
      </p>

      {error && !editing && <Notice>{error}</Notice>}

      <Card pad={false}>
        {!rows ? (
          <div className="card-pad"><Spinner /></div>
        ) : rows.length === 0 ? (
          <Empty title="No venues" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Name</th><th>Hours</th><th>Open now</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((v) => {
                  const w = parseWindows(v.opening_hours);
                  return (
                    <tr key={v.$id}>
                      <td>
                        <div style={{ fontWeight: 550 }}>{v.name}</div>
                        {v.address && <div className="small dim">{v.address}</div>}
                      </td>
                      <td className="dim small">{w ? describeWindows(w) : <Badge tone="warn">Not set</Badge>}</td>
                      <td>{isAvailable(w) ? <Badge tone="ok">Open</Badge> : <Badge>Closed</Badge>}</td>
                      <td>{v.active ? <Badge tone="ok">Active</Badge> : <Badge>Inactive</Badge>}</td>
                      <td className="num"><Button size="sm" variant="ghost" onClick={() => open(v)}>Edit</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <Modal
          title={editing.$id ? `Edit ${editing.name}` : 'Add venue'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={save} loading={busy}>Save</Button>
            </>
          }
        >
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
          <Field label="Name">
            <Input value={editing.name ?? ''} autoFocus onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </Field>
          <Field label="Address">
            <Input value={editing.address ?? ''} onChange={(e) => setEditing({ ...editing, address: e.target.value })} />
          </Field>
          <div className="grid-2">
            <Field label="Phone">
              <Input value={editing.phone ?? ''} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} />
            </Field>
            <Field label="Timezone">
              <Input value={editing.timezone ?? ''} onChange={(e) => setEditing({ ...editing, timezone: e.target.value })} />
            </Field>
          </div>
          <Field label="Opening hours" />
          <HoursEditor value={hours} onChange={setHours} />
          <div style={{ marginTop: '1rem' }}>
            <Toggle checked={editing.active ?? true} onChange={(v) => setEditing({ ...editing, active: v })} label="Active" />
          </div>
        </Modal>
      )}
    </>
  );
}
