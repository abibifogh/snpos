import { useEffect, useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Toggle, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import { CATEGORY_SIDES } from '@snpos/core';
import type { Doc } from '@snpos/core';

export interface KeyedRow extends Doc {
  key: string;
  name: string;
  sort?: number;
  active?: boolean;
  /** Only expense categories use this; ignored elsewhere. */
  account_code?: string;
  /** Only pack kinds use this: how many of the counting unit one holds. */
  units?: number;
  /** Which side of the business owns this. Absent is kitchen, or general. */
  module?: string;
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
  (key ? rows?.find((r) => r.key === key)?.name : undefined) ?? key ?? '-';

/**
 * Manage one of the restaurant's own lists, expense categories, ingredient
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
  unitsLabel,
  module,
  sharedValue,
  onChanged,
}: {
  collection: string;
  singular: string;
  hint?: string;
  /** Offer an account to post to. Expense categories only. */
  accounts?: { code: string; name: string }[];
  /**
   * Ask how many one holds. Pack kinds only.
   *
   * A suggestion rather than a rule, which is why it is offered here and still
   * editable on the item: crates come in twelves and twenty-fours, and the
   * number that counts is the one on the thing being bought.
   */
  unitsLabel?: string;
  /**
   * Show only this side's entries, and stamp new ones with it.
   *
   * Sauces, proteins and vegetables are a kitchen's way of walking its larder,
   * and they were turning up on the bar's bottles because the list was shared.
   */
  module?: string;
  /**
   * The value that means "shows on every side", and the default for a row
   * that has none. Set for expense categories, where transport and repairs
   * belong to nobody in particular; left off for groupings that are one
   * trade's by nature.
   */
  sharedValue?: string;
  onChanged?: () => void;
}) {
  const toast = useToast();
  const { rows, reload } = useKeyedList(collection);
  const [editing, setEditing] = useState<Partial<KeyedRow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const save = async () => {
    if (!editing?.name?.trim()) { setError(`Give the ${singular} a name.`); return; }
    const key = editing.key || keyFrom(editing.name);
    if (!key) { setError('That name has no letters or numbers in it, try another.'); return; }
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
      if (unitsLabel) payload.units = Math.max(0, Number(editing.units ?? 0) || 0);
      if (module) payload.module = editing.module ?? (sharedValue ?? module);

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

  /**
   * Stop offering it, without unpicking what is already filed under it.
   *
   * The active flag was already here, buried in the edit form as a toggle, and
   * buried is the problem: retiring a category is a common thing to want and
   * it looked like the only options were keep it or delete it. Deleting is the
   * one that costs something — every expense filed under the key keeps
   * pointing at a name that no longer exists, so a year of "Gas" turns into a
   * year of "gas_refill". Archiving is the same act done safely, so it is on
   * the row where somebody will find it.
   */
  const archive = async (row: KeyedRow, active: boolean) => {
    try {
      await db.updateDocument(DB_ID, collection, row.$id, { active });
      await reload();
      onChanged?.();
      toast(active ? `${row.name} is back in use` : `${row.name} archived`);
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  const remove = async (row: KeyedRow) => {
    if (!confirm(`Delete "${row.name}"? Everything already filed under it loses the name and shows the bare key instead. Archive keeps the name and takes it off the lists.`)) return;
    try {
      await db.deleteDocument(DB_ID, collection, row.$id);
      await reload();
      onChanged?.();
      toast('Deleted');
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  const archivedCount = (rows ?? []).filter((r) => r.active === false).length;
  /*
    Absent means different things to different lists.

    An ingredient grouping written before the other sides existed was the
    kitchen's, because only the kitchen had a larder. An expense category
    written then was used by all three, so narrowing it to the kitchen would
    empty the other two lists overnight — hence sharedValue.
  */
  const mine = (rows ?? []).filter((r) => {
    if (!module) return true;
    const owner = r.module || sharedValue || 'kitchen';
    return owner === module || (!!sharedValue && owner === sharedValue);
  });
  const shown = mine.filter((r) => showArchived || r.active !== false);

  return (
    <>
      <Card
        pad={false}
        actions={
          <div className="row" style={{ gap: '0.5rem' }}>
            {archivedCount > 0 && (
              <Button size="sm" onClick={() => setShowArchived((s) => !s)}>
                {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={() => { setEditing({ name: '', active: true }); setError(null); }}>
              Add {singular}
            </Button>
          </div>
        }
      >
        {hint && <p className="small dim card-pad" style={{ margin: 0 }}>{hint}</p>}
        {!rows ? (
          <div className="card-pad"><Spinner /></div>
        ) : shown.length === 0 ? (
          <Empty title={rows.length === 0 ? `No ${singular} yet` : 'All archived'}>
            {rows.length > 0 ? 'Show archived to bring one back.' : undefined}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  {accounts && <th>Posts to</th>}
                  {unitsLabel && <th className="num">Holds</th>}
                  {sharedValue && <th>Shown on</th>}
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.$id} className={r.active === false ? 'dim' : undefined}>
                    <td style={{ fontWeight: 550 }}>{r.name}</td>
                    {accounts && (
                      <td className="dim small">
                        {accounts.find((a) => a.code === r.account_code)?.name ?? r.account_code ?? '-'}
                      </td>
                    )}
                    {unitsLabel && (
                      <td className="num dim">
                        {r.units ? r.units : <span title="Asked for on each item">—</span>}
                      </td>
                    )}
                    {sharedValue && (
                      <td className="dim small">
                        {CATEGORY_SIDES.find((sd) => sd.value === (r.module || sharedValue))?.label ?? r.module}
                      </td>
                    )}
                    <td>{r.active === false ? <Badge tone="warn">Archived</Badge> : <Badge tone="ok">Active</Badge>}</td>
                    <td className="num">
                      <Button size="sm" variant="ghost" onClick={() => { setEditing(r); setError(null); }}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => archive(r, r.active === false)}>
                        {r.active === false ? 'Use again' : 'Archive'}
                      </Button>
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
          {sharedValue && (
            <Field
              label="Shown on"
              hint="Where this appears when somebody records spending. Everywhere is right for anything that is not one trade's — transport, repairs, petty cash."
            >
              <Select
                value={editing.module || sharedValue}
                onChange={(e) => setEditing({ ...editing, module: e.target.value })}
              >
                {CATEGORY_SIDES.map((sd) => <option key={sd.value} value={sd.value}>{sd.label}</option>)}
              </Select>
            </Field>
          )}
          {accounts && (
            <Field
              label="Posts to"
              hint="Which line of the accounts money spent on this lands on; that is what Reports adds up by. Not sure? Leave it on Other expenses; it can be changed whenever. Nothing here that fits? Add it under the Accounts tab."
            >
              <Select
                value={editing.account_code ?? '6090'}
                onChange={(e) => setEditing({ ...editing, account_code: e.target.value })}
              >
                {accounts.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
                {/* A category already pointed somewhere that is no longer
                    offered keeps pointing there until somebody changes it on
                    purpose. Dropping it from the list would silently re-file
                    the category on the next save of an unrelated field. */}
                {editing.account_code && !accounts.some((a) => a.code === editing.account_code) && (
                  <option value={editing.account_code}>{editing.account_code} (set previously)</option>
                )}
              </Select>
            </Field>
          )}
          {unitsLabel && (
            <Field
              label={unitsLabel}
              hint="A suggestion only, filled in when this is chosen. The number that counts stays on the item — crates come in twelves and twenty-fours, and the one in front of you is the one that matters. Leave it at 0 to be asked every time."
            >
              <Input
                type="number"
                step="any"
                min="0"
                value={editing.units ?? 0}
                onChange={(e) => setEditing({ ...editing, units: Math.max(0, Number(e.target.value) || 0) })}
              />
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
