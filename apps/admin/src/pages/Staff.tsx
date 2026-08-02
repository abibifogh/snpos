import { useEffect, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Toggle, Badge, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError, teams } from '../lib';
import type { StaffProfile } from '@snpos/core';
import type { Doc } from '@snpos/core';

interface VenueRow extends Doc { name: string }

const ROLES: StaffProfile['role'][] = ['cook', 'waiter', 'cashier', 'manager', 'admin'];

/** Sensible starting permissions per role — an admin can still adjust each. */
const DEFAULTS: Record<StaffProfile['role'], Partial<StaffProfile>> = {
  cook: { can_open_shift: false, can_close_shift: false, can_void: false, can_discount_up_to_bp: 0, can_mark_paid: false, can_record_waste: true },
  waiter: { can_open_shift: false, can_close_shift: false, can_void: false, can_discount_up_to_bp: 0, can_mark_paid: true, can_record_waste: true },
  cashier: { can_open_shift: true, can_close_shift: true, can_void: false, can_discount_up_to_bp: 500, can_mark_paid: true, can_record_waste: true },
  manager: { can_open_shift: true, can_close_shift: true, can_void: true, can_discount_up_to_bp: 2000, can_mark_paid: true, can_record_waste: true },
  admin: { can_open_shift: true, can_close_shift: true, can_void: true, can_discount_up_to_bp: 10000, can_mark_paid: true, can_record_waste: true },
};

const TEAM_FOR: Record<StaffProfile['role'], string> = {
  cook: 'cooks', waiter: 'waiters', cashier: 'cashiers', manager: 'managers', admin: 'admins',
};

export function StaffPage() {
  const toast = useToast();
  const [rows, setRows] = useState<StaffProfile[] | null>(null);
  const [venues, setVenues] = useState<VenueRow[]>([]);
  const [editing, setEditing] = useState<Partial<StaffProfile> | null>(null);
  const [invite, setInvite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [s, v] = await Promise.all([listAll<StaffProfile>('staff_profiles'), listAll<VenueRow>('venues')]);
    setRows(s.sort((a, b) => a.display_name.localeCompare(b.display_name)));
    setVenues(v);
  };
  useEffect(() => { load().catch((e) => setError(humanError(e))); }, []);

  const open = (p?: StaffProfile, asInvite = false) => {
    setEditing(p ?? { display_name: '', email: '', role: 'waiter', active: true, ...DEFAULTS.waiter, venue_ids: [] });
    setInvite(asInvite);
    setError(null);
  };

  const save = async () => {
    if (!editing?.display_name?.trim()) { setError('Enter their name.'); return; }
    if (invite && !editing.email?.trim()) { setError('Enter their email address — the invitation goes there.'); return; }

    setBusy(true);
    setError(null);
    try {
      const role = editing.role ?? 'waiter';
      const payload = {
        user_id: editing.user_id ?? '',
        email: (editing.email ?? '').trim().toLowerCase(),
        display_name: editing.display_name.trim(),
        role,
        active: editing.active ?? true,
        phone: editing.phone ?? '',
        can_open_shift: editing.can_open_shift ?? false,
        can_close_shift: editing.can_close_shift ?? false,
        can_void: editing.can_void ?? false,
        can_discount_up_to_bp: Number(editing.can_discount_up_to_bp ?? 0),
        can_mark_paid: editing.can_mark_paid ?? true,
        can_record_waste: editing.can_record_waste ?? true,
        venue_ids: editing.venue_ids ?? [],
      };

      if (editing.$id) {
        await db.updateDocument(DB_ID, 'staff_profiles', editing.$id, payload);
      } else {
        await db.createDocument(DB_ID, 'staff_profiles', ID.unique(), payload);
        if (invite) {
          // Appwrite emails the invitation and the person sets their own
          // password. Nobody types a colleague's password, and no shared
          // account exists to make "who authorised this" unanswerable.
          await teams.createMembership(
            TEAM_FOR[role],
            ['member'],
            payload.email,
            undefined,
            undefined,
            window.location.origin,
            payload.display_name,
          );
        }
      }

      setEditing(null);
      await load();
      toast(invite ? `Invitation sent to ${payload.email}` : 'Saved');
    } catch (e) {
      const msg = humanError(e);
      setError(
        /already/i.test(msg)
          ? 'That person is already on this team. Edit their existing profile instead.'
          : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: StaffProfile) => {
    if (!confirm(`Remove ${p.display_name}? Their past orders, discounts and shifts stay on record — that history is what makes the audit trail worth having.`)) return;
    try {
      await db.deleteDocument(DB_ID, 'staff_profiles', p.$id);
      await load();
      toast('Removed');
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  return (
    <>
      <div className="spread">
        <h1>Staff</h1>
        <Button variant="primary" onClick={() => open(undefined, true)}>Invite someone</Button>
      </div>

      <p className="dim small" style={{ marginTop: 0 }}>
        Everyone gets their own login. That is what makes “who authorised this discount” an answerable question —
        with a shared account it never is.
      </p>

      {error && !editing && <Notice>{error}</Notice>}

      <Card pad={false}>
        {!rows ? (
          <div className="card-pad"><Spinner /></div>
        ) : rows.length === 0 ? (
          <Empty title="No staff yet">Invite your first team member — they set their own password from the email.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Name</th><th>Role</th><th>Discount limit</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.$id}>
                    <td>
                      <div style={{ fontWeight: 550 }}>{p.display_name}</div>
                      <div className="small dim">{p.email || '—'}</div>
                    </td>
                    <td className="dim">{p.role}</td>
                    <td className="dim small">
                      {p.can_discount_up_to_bp ? `up to ${(p.can_discount_up_to_bp / 100).toFixed(0)}%` : 'none'}
                    </td>
                    <td>
                      {!p.user_id ? (
                        <Badge tone="warn">Invited</Badge>
                      ) : p.active ? (
                        <Badge tone="ok">Active</Badge>
                      ) : (
                        <Badge>Disabled</Badge>
                      )}
                    </td>
                    <td className="num">
                      <Button size="sm" variant="ghost" onClick={() => open(p)}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(p)}>Remove</Button>
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
          title={editing.$id ? `Edit ${editing.display_name}` : 'Invite someone'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={save} loading={busy}>
                {invite ? 'Send invitation' : 'Save'}
              </Button>
            </>
          }
        >
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

          <div className="grid-2">
            <Field label="Name">
              <Input value={editing.display_name ?? ''} autoFocus onChange={(e) => setEditing({ ...editing, display_name: e.target.value })} />
            </Field>
            <Field label="Email" hint={invite ? 'The invitation goes here.' : undefined}>
              <Input type="email" value={editing.email ?? ''} disabled={!!editing.$id} onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
            </Field>
            <Field label="Phone">
              <Input value={editing.phone ?? ''} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} />
            </Field>
            <Field label="Role" hint="Changing this resets the permissions below to that role's defaults.">
              <Select
                value={editing.role ?? 'waiter'}
                onChange={(e) => {
                  const role = e.target.value as StaffProfile['role'];
                  setEditing({ ...editing, role, ...DEFAULTS[role] });
                }}
              >
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </Select>
            </Field>
          </div>

          <h3 style={{ margin: '1.1rem 0 0.5rem' }}>What they can do</h3>
          <Field><Toggle checked={editing.can_open_shift ?? false} onChange={(v) => setEditing({ ...editing, can_open_shift: v })} label="Open a shift" /></Field>
          <Field><Toggle checked={editing.can_close_shift ?? false} onChange={(v) => setEditing({ ...editing, can_close_shift: v })} label="Close a shift and count the drawer" /></Field>
          <Field><Toggle checked={editing.can_mark_paid ?? true} onChange={(v) => setEditing({ ...editing, can_mark_paid: v })} label="Mark a bill as paid" /></Field>
          <Field><Toggle checked={editing.can_void ?? false} onChange={(v) => setEditing({ ...editing, can_void: v })} label="Void an order" /></Field>
          <Field><Toggle checked={editing.can_record_waste ?? true} onChange={(v) => setEditing({ ...editing, can_record_waste: v })} label="Record waste" /></Field>

          <Field label="Discount they can give without a manager (%)" hint="0 means every discount needs approval.">
            <Input
              type="number"
              min={0}
              max={100}
              value={(editing.can_discount_up_to_bp ?? 0) / 100}
              onChange={(e) => setEditing({ ...editing, can_discount_up_to_bp: Math.round(Number(e.target.value) * 100) })}
            />
          </Field>

          {venues.length > 1 && (
            <Field label="Venues" hint="Leave all unticked for access to every venue.">
              <div className="stack" style={{ gap: '0.35rem' }}>
                {venues.map((v) => (
                  <Toggle
                    key={v.$id}
                    checked={(editing.venue_ids ?? []).includes(v.$id)}
                    onChange={(on) =>
                      setEditing({
                        ...editing,
                        venue_ids: on
                          ? [...(editing.venue_ids ?? []), v.$id]
                          : (editing.venue_ids ?? []).filter((x) => x !== v.$id),
                      })
                    }
                    label={v.name}
                  />
                ))}
              </div>
            </Field>
          )}

          {editing.$id && (
            <Field>
              <Toggle checked={editing.active ?? true} onChange={(v) => setEditing({ ...editing, active: v })} label="Active" />
              <span className="hint">
                Turn this off when someone leaves. Better than deleting them — their history stays attributable.
              </span>
            </Field>
          )}
        </Modal>
      )}
    </>
  );
}
