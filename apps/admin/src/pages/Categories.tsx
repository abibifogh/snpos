import { useEffect, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Textarea, Toggle, Badge, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import type { Category, Station } from '@snpos/core';

const STATIONS: Station[] = ['hot', 'cold', 'bar', 'dessert'];
const blank = (sort: number): Partial<Category> => ({
  name: '', description: '', sort, active: true, unavailable_display: 'grey', station: 'hot',
});

export function CategoriesPage() {
  const toast = useToast();
  const [rows, setRows] = useState<Category[] | null>(null);
  const [editing, setEditing] = useState<Partial<Category> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => listAll<Category>('categories').then((r) => setRows(r.sort((a, b) => a.sort - b.sort)));
  useEffect(() => { load().catch((e) => setError(humanError(e))); }, []);

  const save = async () => {
    if (!editing?.name?.trim()) { setError('A category needs a name.'); return; }
    setBusy(true);
    setError(null);
    const payload = {
      name: editing.name.trim(),
      description: editing.description ?? '',
      sort: Number(editing.sort ?? 0),
      active: editing.active ?? true,
      unavailable_display: editing.unavailable_display ?? 'grey',
      station: editing.station ?? 'hot',
    };
    try {
      if (editing.$id) await db.updateDocument(DB_ID, 'categories', editing.$id, payload);
      else await db.createDocument(DB_ID, 'categories', ID.unique(), payload);
      setEditing(null);
      await load();
      toast('Category saved');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: Category) => {
    // Deleting a category orphans its dishes, so say so plainly rather than
    // discovering it later on the customer menu.
    if (!confirm(`Delete "${c.name}"? Dishes in it will remain but will have no category and will not appear on the menu.`)) return;
    try {
      await db.deleteDocument(DB_ID, 'categories', c.$id);
      await load();
      toast('Category deleted');
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  return (
    <>
      <div className="spread">
        <h1>Categories</h1>
        <Button variant="primary" onClick={() => setEditing(blank((rows?.length ?? 0) + 1))}>Add category</Button>
      </div>

      {error && !editing && <Notice>{error}</Notice>}

      <Card pad={false}>
        {!rows ? (
          <div className="card-pad"><Spinner /></div>
        ) : rows.length === 0 ? (
          <Empty title="No categories yet">
            Categories group your menu — Starters, Mains, Drinks. Add one to begin.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: '3.5rem' }}>Order</th>
                  <th>Name</th>
                  <th>Station</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.$id}>
                    <td className="num dim">{c.sort}</td>
                    <td>
                      <div style={{ fontWeight: 550 }}>{c.name}</div>
                      {c.description && <div className="small dim">{c.description}</div>}
                    </td>
                    <td className="dim">{c.station}</td>
                    <td>{c.active ? <Badge tone="ok">Active</Badge> : <Badge>Hidden</Badge>}</td>
                    <td className="num">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(c)}>Delete</Button>
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
          title={editing.$id ? 'Edit category' : 'Add category'}
          onClose={() => { setEditing(null); setError(null); }}
          footer={
            <>
              <Button variant="ghost" onClick={() => { setEditing(null); setError(null); }}>Cancel</Button>
              <Button variant="primary" onClick={save} loading={busy}>Save</Button>
            </>
          }
        >
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
          <Field label="Name">
            <Input value={editing.name ?? ''} autoFocus onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </Field>
          <Field label="Description" hint="Optional. Shown under the category heading on the customer menu.">
            <Textarea value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
          </Field>
          <div className="grid-2">
            <Field label="Kitchen station" hint="Where these are prepared. Dishes can override it.">
              <Select value={editing.station ?? 'hot'} onChange={(e) => setEditing({ ...editing, station: e.target.value as Station })}>
                {STATIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
            </Field>
            <Field label="Sort order" hint="Lower numbers appear first.">
              <Input type="number" value={editing.sort ?? 0} onChange={(e) => setEditing({ ...editing, sort: Number(e.target.value) })} />
            </Field>
          </div>
          <Field label="When outside its available hours">
            <Select
              value={editing.unavailable_display ?? 'grey'}
              onChange={(e) => setEditing({ ...editing, unavailable_display: e.target.value as 'grey' | 'hide' })}
            >
              <option value="grey">Show greyed out — customers can see it exists</option>
              <option value="hide">Hide completely</option>
            </Select>
          </Field>
          <Field>
            <Toggle checked={editing.active ?? true} onChange={(v) => setEditing({ ...editing, active: v })} label="Active" />
          </Field>
        </Modal>
      )}
    </>
  );
}
