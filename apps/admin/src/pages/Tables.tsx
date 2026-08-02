import { useEffect, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Spinner, Toggle, Badge, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import type { Doc } from '@snpos/core';
import { useSession } from '../session';

interface TableRow extends Doc {
  venue_id: string;
  label: string;
  zone?: string;
  seats: number;
  qr_token: string;
  status: string;
  active: boolean;
  sort: number;
}

interface VenueRow extends Doc { name: string }

/**
 * The QR token is the table's identity to a customer who has scanned nothing
 * but a sticker, so it must be unguessable — a sequential id would let anyone
 * order against any table by editing the URL.
 */
const newToken = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

/** Where the customer menu is served. Set VITE_MENU_URL for production. */
const menuBase = (import.meta.env.VITE_MENU_URL as string | undefined) ?? 'http://localhost:5173';

export function TablesPage() {
  const { settings } = useSession();
  const toast = useToast();
  const [rows, setRows] = useState<TableRow[] | null>(null);
  const [venues, setVenues] = useState<VenueRow[]>([]);
  const [editing, setEditing] = useState<Partial<TableRow> | null>(null);
  const [showQr, setShowQr] = useState<TableRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [t, v] = await Promise.all([listAll<TableRow>('tables'), listAll<VenueRow>('venues')]);
    setRows(t.sort((a, b) => a.sort - b.sort));
    setVenues(v);
  };
  useEffect(() => { load().catch((e) => setError(humanError(e))); }, []);

  const open = (t?: TableRow) => {
    setEditing(
      t ?? {
        venue_id: venues[0]?.$id ?? 'main',
        label: '',
        zone: '',
        seats: 4,
        status: 'free',
        active: true,
        sort: (rows?.length ?? 0) + 1,
      },
    );
    setError(null);
  };

  const save = async () => {
    if (!editing?.label?.trim()) { setError('Give the table a name or number.'); return; }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        venue_id: editing.venue_id ?? 'main',
        label: editing.label.trim(),
        zone: editing.zone ?? '',
        seats: Number(editing.seats ?? 4),
        // Keep the existing token on edit: regenerating it would silently break
        // every QR sticker already printed and stuck to a table.
        qr_token: editing.qr_token ?? newToken(),
        status: editing.status ?? 'free',
        active: editing.active ?? true,
        sort: Number(editing.sort ?? 0),
      };
      if (editing.$id) await db.updateDocument(DB_ID, 'tables', editing.$id, payload);
      else await db.createDocument(DB_ID, 'tables', ID.unique(), payload);
      setEditing(null);
      await load();
      toast('Table saved');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (t: TableRow) => {
    if (!confirm(`Issue a new QR code for ${t.label}? The sticker currently on that table will stop working and must be reprinted.`)) return;
    try {
      await db.updateDocument(DB_ID, 'tables', t.$id, { qr_token: newToken() });
      await load();
      toast('New code issued — reprint the sticker');
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  const remove = async (t: TableRow) => {
    if (!confirm(`Delete ${t.label}? Past orders keep their history.`)) return;
    try {
      await db.deleteDocument(DB_ID, 'tables', t.$id);
      await load();
      toast('Table deleted');
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  const urlFor = (t: TableRow) => `${menuBase}/?t=${t.qr_token}`;

  return (
    <>
      <div className="spread">
        <h1>Tables</h1>
        <Button variant="primary" onClick={() => open()}>Add table</Button>
      </div>

      <p className="dim small" style={{ marginTop: 0 }}>
        Each table gets its own web address. Print it as a QR code and stick it on the table; scanning it opens the
        menu already knowing where the customer is sitting.
      </p>

      {error && !editing && <Notice>{error}</Notice>}

      <Card pad={false}>
        {!rows ? (
          <div className="card-pad"><Spinner /></div>
        ) : rows.length === 0 ? (
          <Empty title="No tables yet">Add one for each table you want customers to be able to order from.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Table</th><th>Zone</th><th className="num">Seats</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.$id}>
                    <td style={{ fontWeight: 550 }}>{t.label}</td>
                    <td className="dim">{t.zone || '—'}</td>
                    <td className="num dim">{t.seats}</td>
                    <td>{t.active ? <Badge tone="ok">Active</Badge> : <Badge>Inactive</Badge>}</td>
                    <td className="num">
                      <Button size="sm" variant="ghost" onClick={() => setShowQr(t)}>QR link</Button>
                      <Button size="sm" variant="ghost" onClick={() => open(t)}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(t)}>Delete</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <Modal
          title={editing.$id ? `Edit ${editing.label}` : 'Add table'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={save} loading={busy}>Save</Button>
            </>
          }
        >
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
          <div className="grid-2">
            <Field label="Name or number" hint="What staff call it: 12, A3, Terrace 2.">
              <Input value={editing.label ?? ''} autoFocus onChange={(e) => setEditing({ ...editing, label: e.target.value })} />
            </Field>
            <Field label="Zone" hint="Optional. Garden, Upstairs, Bar.">
              <Input value={editing.zone ?? ''} onChange={(e) => setEditing({ ...editing, zone: e.target.value })} />
            </Field>
            <Field label="Seats">
              <Input type="number" min={1} value={editing.seats ?? 4} onChange={(e) => setEditing({ ...editing, seats: Number(e.target.value) })} />
            </Field>
            <Field label="Sort order">
              <Input type="number" value={editing.sort ?? 0} onChange={(e) => setEditing({ ...editing, sort: Number(e.target.value) })} />
            </Field>
          </div>
          <Field>
            <Toggle checked={editing.active ?? true} onChange={(v) => setEditing({ ...editing, active: v })} label="Active" />
          </Field>
        </Modal>
      )}

      {showQr && (
        <Modal
          title={`QR link — ${showQr.label}`}
          onClose={() => setShowQr(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => rotate(showQr)}>Issue new code</Button>
              <Button
                variant="primary"
                onClick={() => {
                  navigator.clipboard.writeText(urlFor(showQr));
                  toast('Link copied');
                }}
              >
                Copy link
              </Button>
            </>
          }
        >
          <p className="small dim" style={{ marginTop: 0 }}>
            Turn this address into a QR code with any free generator, print it, and put it on the table.
          </p>
          <Field label="Address">
            <Input readOnly value={urlFor(showQr)} onFocus={(e) => e.currentTarget.select()} />
          </Field>
          <Notice tone="warn">
            Treat this link as the table's key. Anyone who has it can order against this table, so do not post it
            publicly — and issue a new code if a sticker goes missing.
          </Notice>
          <p className="small dim">
            The address points at <code>{menuBase}</code>. Once the customer menu is on a real domain, set{' '}
            <code>VITE_MENU_URL</code> and reprint. {settings?.restaurant_name}
          </p>
        </Modal>
      )}
    </>
  );
}
