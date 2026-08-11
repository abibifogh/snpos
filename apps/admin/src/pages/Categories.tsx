import { useEffect, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Textarea, Toggle, Badge, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import { parseWindows, describeWindows, isAvailable } from '@snpos/core';
import type { Category, Windows } from '@snpos/core';
import { HoursEditor } from '../components/HoursEditor';
import { ImageField } from '../components/ImageField';
import { StationPicker, useStations, legacyStationFor } from '../components/StationPicker';
import { useSession } from '../session';

const blank = (sort: number): Partial<Category> => ({
  name: '', description: '', sort, active: true, unavailable_display: 'grey', station: 'hot',
});

/**
 * Categories, for one side of the business at a time.
 *
 * The same screen serves the kitchen and the craft shop because the job is
 * identical — a name, an order, some opening hours. What must never be shared
 * is the list: a cook scrolling past "Woven baskets" to reach "Starters" is the
 * cost of one table doing two jobs, and it is paid on every visit.
 *
 * Rows written before this existed have no module and are read as kitchen,
 * which is what they were.
 */
export function CategoriesPage({ module = 'kitchen' }: { module?: 'kitchen' | 'craft' }) {
  const { settings } = useSession();
  const toast = useToast();
  const stations = useStations();
  const [hours, setHours] = useState<Windows>({});
  const [rows, setRows] = useState<Category[] | null>(null);
  const [editing, setEditing] = useState<Partial<Category> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    listAll<Category>('categories').then((r) =>
      setRows(r.filter((c) => (c.module ?? 'kitchen') === module).sort((a, b) => a.sort - b.sort)),
    );
  useEffect(() => { load().catch((e) => setError(humanError(e))); }, [module]);

  const nameOfStation = (c: Category) => {
    const key = c.station_key || c.station;
    return stations?.find((s) => s.key === key)?.name ?? key;
  };

  const open = (c?: Category) => {
    const base = c ? { ...c } : blank((rows?.length ?? 0) + 1);
    // An older category has only the built-in `station`; a new one starts at the
    // restaurant's first station rather than at a name they never chose.
    // A craft category has no station, and must not silently inherit the
    // kitchen's first one just because that is what the picker would default to.
    base.station_key = module === 'craft' ? '' : c ? c.station_key || c.station : stations?.[0]?.key ?? '';
    setEditing(base);
    setHours(c ? parseWindows(c.availability) ?? {} : {});
    setError(null);
  };

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
      group_only: module === 'craft' ? false : editing.group_only ?? false,
      // `station` is the old built-in enum and is still required by the
      // database; `station_key` is the one the kitchen actually reads.
      station: legacyStationFor(editing.station_key ?? ''),
      station_key: editing.station_key ?? '',
      availability: Object.keys(hours).length ? JSON.stringify(hours) : '',
      image_id: editing.image_id ?? '',
      // Whichever side of the business this screen is showing. Not a choice on
      // the form: somebody adding a category on the craft page means a craft
      // category, and a dropdown that could contradict the page they are on is
      // a dropdown that will.
      module,
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
        <Button variant="primary" onClick={() => open()}>Add category</Button>
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
                  <th>Available</th>
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
                    <td className="dim">{nameOfStation(c)}</td>
                    <td className="small dim">
                      {(() => {
                        const w = parseWindows(c.availability);
                        if (!w) return 'All day';
                        return isAvailable(w) ? <Badge tone="ok">Now</Badge> : <span>{describeWindows(w)}</span>;
                      })()}
                    </td>
                    <td>{c.active ? <Badge tone="ok">Active</Badge> : <Badge>Hidden</Badge>}</td>
                    <td className="num">
                      <Button size="sm" variant="ghost" onClick={() => open(c)}>Edit</Button>
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
            {/* A shop has no stove. Asking a craft category which station
                prepares it is asking a question with no true answer, and every
                field like that teaches somebody that half the form is noise. */}
            {module === 'kitchen' && (
              <StationPicker
                stations={stations}
                value={editing.station_key ?? ''}
                onChange={(key) => setEditing({ ...editing, station_key: key })}
                hint="Where these are prepared. A dish can override it."
              />
            )}
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
          <ImageField
            fileId={editing.image_id}
            purpose="menu"
            settings={settings}
            onChange={(id) => setEditing({ ...editing, image_id: id ?? '' })}
            label="Category photo"
            hint="Optional. Shown as the category header on the customer menu."
          />

          <Field
            label="Available hours"
            hint="When this section shows on the menu. A dish in several categories appears and disappears with each one — so the same dish can be in Lunch and in Dinner and show at both times."
          />
          <HoursEditor value={hours} onChange={setHours} emptyMeans="this category shows all day, every day" />

          <Field>
            <Toggle checked={editing.active ?? true} onChange={(v) => setEditing({ ...editing, active: v })} label="Active" />
          </Field>
          {/* Group ordering is a hotel booking a party's platters in advance.
              Nobody pre-books a shelf of baskets, so the shop never sees it. */}
          {module === 'kitchen' && (
            <Field hint="Shown only on the group-order menu, and hidden from the ordinary one. For platters and set meals.">
              <Toggle
                checked={editing.group_only ?? false}
                onChange={(v) => setEditing({ ...editing, group_only: v })}
                label="Group orders only"
              />
            </Field>
          )}
        </Modal>
      )}
    </>
  );
}
