import { useEffect, useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Toggle, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import type { Doc } from '@snpos/core';

export interface KeyedRow extends Doc {
  key: string;
  name: string;
  sort?: number;
  active?: boolean;
  /** Only expense categories use this; ignored elsewhere. */
  account_code?: string;
}

/** Turn a typed name into a key that is safe to store on every record. */
export const keyFrom = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);

/** Load a keyed list once, sorted the way it should be displayed. */
export function useKeyedList(collection: string) {
  const [rows, setRows] = useState<KeyedRow[] | null>(null);

  const reload = () =>
    listAll<KeyedRow>(collection)
      .then((r) => setRows(r.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name))))
      .catch(() => setRows([]));

  useEffect(() => { void reload(); }, [collection]);

  return { rows, reload };
}

/** The display name for a stored key, falling back to the key itself. */
export const nameForKey = (rows: KeyedRow[] | null, key?: string) =>
  (key ? rows?.find((r) => r.key === key)?.name : undefined) ?? key ?? '—';

/**
 * Manage one of the restaurant's own lists — expense categories, ingredient
 * categories, and anything else that is just "a name the restaurant chose".
 *
 * The key is generated from the name the first time and then frozen. Records
 * already filed under a category point at its key, so letting the key change
 * would quietly detach every one of them; the name can be corrected as often
 * as you like.
 */
export function KeyedListManager({
  collection,
  singular,
  hint,
  accounts,
  onChanged,
}: {
  collection: string;
  singular: string;
  hint?: string;
  /** Offer an account to post to. Expense categories only. */
  accounts?: { code: string; name: string }[];
  onChanged?: () => void;
}) {
  const toast = useToast();
  const { rows, reload } = useKeyedList(collection);
  const [editing, setEditing] = useState<Partial<KeyedRow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!editing?.name?.trim()) { setError(`Give the ${singular} a name.`); return; }
    const key = editing.key || keyFrom(editing.name);
    if (!key) { setError('That name has no letters or numbers in it — try another.'); return; }
    if (!editing.$id && rows?.some((r) => r.key === key)) {
      setError(`There is already a ${singular} called "${editing.name.trim()}".`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        key,
        name: editing.name.trim(),
        sort: Number(editing.sort ?? (rows?.length ?? 0) + 1),
        active: editing.active ?? true,
      };
      if (accounts) payload.account_code = editing.account_code || '6090';

      if (editing.$id) await db.updateDocument(DB_ID, collection, editing.$id, payload);
      else await db.createDocument(DB_ID, collection, ID.unique(), payload);
      setEditing(null);
      await reload();
      onChanged?.();
      toast('Saved');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: KeyedRow) => {
    if (!confirm(`Delete "${row.name}"? Anything already filed under it keeps the label but you will not be able to choose it again.`)) return;
    try {
      await db.deleteDocument(DB_ID, collection, row.$id);
      await reload();
      onChanged?.();
      toast('Deleted');
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  return (
    <>
      <Card
        pad={false}
        actions={
          <Button size="sm" variant="primary" onClick={() => { setEditing({ name: '', active: true }); setError(null); }}>
            Add {singular}
          </Button>
        }
      >
        {hint && <p className="small dim card-pad" style={{ margin: 0 }}>{hint}</p>}
        {!rows ? (
          <div className="card-pad"><Spinner /></div>
        ) : rows.length === 0 ? (
          <Empty title={`No ${singular} yet`} />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  {accounts && <th>Posts to</th>}
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.$id}>
                    <td style={{ fontWeight: 550 }}>{r.name}</td>
                    {accounts && (
                      <td className="dim small">
                        {accounts.find((a) => a.code === r.account_code)?.name ?? r.account_code ?? '—'}
                      </td>
                    )}
                    <td>{r.active === false ? <Badge>Off</Badge> : <Badge tone="ok">Active</Badge>}</td>
                    <td className="num">
                      <Button size="sm" variant="ghost" onClick={() => { setEditing(r); setError(null); }}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(r)}>Delete</Button>
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
          title={editing.$id ? `Edit ${editing.name}` : `Add ${singular}`}
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
          {accounts && (
            <Field
              label="Posts to"
              hint="Which line of the accounts this lands on. If you are not sure, leave it on Other expenses — it can be changed later."
            >
              <Select
                value={editing.account_code ?? '6090'}
                onChange={(e) => setEditing({ ...editing, account_code: e.target.value })}
              >
                {accounts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
              </Select>
            </Field>
          )}
          <div className="grid-2">
            <Field label="Sort order" hint="Lower numbers appear first.">
              <Input
                type="number"
                value={editing.sort ?? 0}
                onChange={(e) => setEditing({ ...editing, sort: Number(e.target.value) })}
              />
            </Field>
            <Field>
              <Toggle
                checked={editing.active ?? true}
                onChange={(v) => setEditing({ ...editing, active: v })}
                label="Active"
              />
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}
