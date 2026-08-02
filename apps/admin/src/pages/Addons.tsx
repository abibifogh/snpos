import { useEffect, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Spinner, Textarea, Toggle, Badge, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import { formatMoney, parseMoney, toInput, Query } from '@snpos/core';
import type { Doc } from '@snpos/core';
import { useSession } from '../session';

interface AddonGroup extends Doc {
  name: string;
  description?: string;
  min_select: number;
  max_select: number;
  required: boolean;
  sort: number;
}

interface AddonOption extends Doc {
  group_id: string;
  name: string;
  price_delta: number;
  active: boolean;
  sort: number;
  default_selected: boolean;
  max_qty: number;
}

/** A row being edited before it is saved; price is held as typed text. */
interface DraftOption {
  $id?: string;
  name: string;
  priceText: string;
  active: boolean;
  default_selected: boolean;
}

export function AddonsPage() {
  const { settings } = useSession();
  const toast = useToast();
  const decimals = settings?.currency_decimals ?? 2;

  const [groups, setGroups] = useState<AddonGroup[] | null>(null);
  const [options, setOptions] = useState<Record<string, AddonOption[]>>({});
  const [editing, setEditing] = useState<Partial<AddonGroup> | null>(null);
  const [draftOptions, setDraftOptions] = useState<DraftOption[]>([]);
  const [removedOptionIds, setRemovedOptionIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const g = await listAll<AddonGroup>('addon_groups');
    const o = await listAll<AddonOption>('addon_options');
    setGroups(g.sort((a, b) => a.sort - b.sort));
    const grouped: Record<string, AddonOption[]> = {};
    for (const opt of o.sort((a, b) => a.sort - b.sort)) (grouped[opt.group_id] ??= []).push(opt);
    setOptions(grouped);
  };
  useEffect(() => { load().catch((e) => setError(humanError(e))); }, []);

  /**
   * Open the editor. `copy` starts a brand new group from an existing one —
   * every choice comes across, but none of them keep their id, so saving writes
   * a second group instead of overwriting the first.
   */
  const open = (g?: AddonGroup, copy = false) => {
    setEditing(
      g
        ? { ...g, ...(copy ? { $id: undefined, name: `${g.name} (copy)`, sort: (groups?.length ?? 0) + 1 } : {}) }
        : { name: '', description: '', min_select: 0, max_select: 1, required: false, sort: (groups?.length ?? 0) + 1 },
    );
    setDraftOptions(
      g
        ? (options[g.$id] ?? []).map((o) => ({
            $id: copy ? undefined : o.$id,
            name: o.name,
            priceText: toInput(o.price_delta, decimals),
            active: o.active,
            default_selected: o.default_selected,
          }))
        : [{ name: '', priceText: toInput(0, decimals), active: true, default_selected: false }],
    );
    setRemovedOptionIds([]);
    setError(null);
  };

  const save = async () => {
    if (!editing?.name?.trim()) { setError('This group needs a name, for example "Choose your protein".'); return; }
    const filled = draftOptions.filter((o) => o.name.trim());
    if (filled.length === 0) { setError('Add at least one choice.'); return; }
    for (const o of filled) {
      if (parseMoney(o.priceText, decimals) === null) {
        setError(`"${o.name}" does not have a valid price. Use 0 for choices that cost nothing extra.`);
        return;
      }
    }

    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: editing.name.trim(),
        description: editing.description ?? '',
        min_select: Number(editing.min_select ?? 0),
        max_select: Number(editing.max_select ?? 1),
        required: editing.required ?? false,
        sort: Number(editing.sort ?? 0),
      };
      const groupId = editing.$id
        ? ((await db.updateDocument(DB_ID, 'addon_groups', editing.$id, payload)).$id)
        : ((await db.createDocument(DB_ID, 'addon_groups', ID.unique(), payload)).$id);

      for (const id of removedOptionIds) {
        await db.deleteDocument(DB_ID, 'addon_options', id).catch(() => undefined);
      }

      await Promise.all(
        filled.map((o, i) => {
          const body = {
            group_id: groupId,
            name: o.name.trim(),
            price_delta: parseMoney(o.priceText, decimals) as number,
            active: o.active,
            sort: i + 1,
            default_selected: o.default_selected,
            max_qty: 1,
          };
          return o.$id
            ? db.updateDocument(DB_ID, 'addon_options', o.$id, body)
            : db.createDocument(DB_ID, 'addon_options', ID.unique(), body);
        }),
      );

      setEditing(null);
      await load();
      toast('Option group saved');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (g: AddonGroup) => {
    if (!confirm(`Delete "${g.name}" and its choices? Dishes using it will lose that set of options.`)) return;
    try {
      // Remove the links first, then the options, then the group — leaving a
      // dish pointing at a group that no longer exists would break its page.
      const links = await db.listDocuments(DB_ID, 'menu_item_addon_groups', [Query.equal('group_id', g.$id), Query.limit(100)]);
      await Promise.all(links.documents.map((l) => db.deleteDocument(DB_ID, 'menu_item_addon_groups', l.$id)));
      await Promise.all((options[g.$id] ?? []).map((o) => db.deleteDocument(DB_ID, 'addon_options', o.$id)));
      await db.deleteDocument(DB_ID, 'addon_groups', g.$id);
      await load();
      toast('Deleted');
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  const setOption = (i: number, patch: Partial<DraftOption>) =>
    setDraftOptions((d) => d.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));

  return (
    <>
      <div className="spread">
        <h1>Options</h1>
        <Button variant="primary" onClick={() => open()}>Add option group</Button>
      </div>

      <p className="dim small" style={{ marginTop: 0 }}>
        Choices a customer makes when ordering a dish — protein, spice level, size, extras. Build a group once and
        attach it to as many dishes as you like. A choice can add nothing to the price: set it to 0.
      </p>

      {error && !editing && <Notice>{error}</Notice>}

      {!groups ? (
        <Spinner />
      ) : groups.length === 0 ? (
        <Card><Empty title="No option groups yet">For example: “Choose your protein” — Chicken +0, Beef +10, Prawns +25.</Empty></Card>
      ) : (
        <div className="stack">
          {groups.map((g) => (
            <Card
              key={g.$id}
              title={g.name}
              actions={
                <div className="row">
                  <Button size="sm" variant="ghost" onClick={() => open(g)}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => open(g, true)} title="Copy this group and all its choices">
                    Duplicate
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(g)}>Delete</Button>
                </div>
              }
            >
              <div className="row row-wrap" style={{ marginBottom: '0.6rem' }}>
                {g.required ? <Badge tone="warn">Required</Badge> : <Badge>Optional</Badge>}
                <Badge>
                  {g.max_select <= 1 ? 'Pick one' : `Pick up to ${g.max_select}`}
                  {g.min_select > 0 ? `, at least ${g.min_select}` : ''}
                </Badge>
              </div>
              {g.description && <p className="small dim" style={{ marginTop: 0 }}>{g.description}</p>}
              <div className="row row-wrap">
                {(options[g.$id] ?? []).map((o) => (
                  <span key={o.$id} className="badge" style={{ opacity: o.active ? 1 : 0.5 }}>
                    {o.name}
                    {o.price_delta > 0 && settings ? ` +${formatMoney(o.price_delta, settings)}` : ''}
                    {o.default_selected ? ' ·default' : ''}
                  </span>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <Modal
          title={editing.$id ? `Edit ${editing.name}` : 'Add option group'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={save} loading={busy}>Save</Button>
            </>
          }
        >
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

          <Field label="Group name" hint="What the customer sees as the question.">
            <Input
              value={editing.name ?? ''}
              autoFocus
              placeholder="Choose your protein"
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={editing.description ?? ''}
              placeholder="Optional note shown under the question"
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            />
          </Field>

          <div className="grid-2">
            <Field label="Most they can pick" hint="1 means a single choice.">
              <Input
                type="number"
                min={1}
                value={editing.max_select ?? 1}
                onChange={(e) => setEditing({ ...editing, max_select: Number(e.target.value) })}
              />
            </Field>
            <Field label="Fewest they must pick" hint="0 means they can skip it.">
              <Input
                type="number"
                min={0}
                value={editing.min_select ?? 0}
                onChange={(e) => setEditing({ ...editing, min_select: Number(e.target.value) })}
              />
            </Field>
          </div>

          <Field hint="A required group must be answered before the dish can be added to the order.">
            <Toggle
              checked={editing.required ?? false}
              onChange={(v) => setEditing({ ...editing, required: v, min_select: v ? Math.max(1, editing.min_select ?? 1) : editing.min_select })}
              label="Required"
            />
          </Field>

          <h3 style={{ margin: '1.2rem 0 0.6rem' }}>Choices</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th style={{ width: '7.5rem' }}>Extra cost</th>
                  <th style={{ width: '5rem' }}>Default</th>
                  <th style={{ width: '5rem' }} />
                </tr>
              </thead>
              <tbody>
                {draftOptions.map((o, i) => (
                  <tr key={i}>
                    <td>
                      <Input
                        value={o.name}
                        placeholder="Chicken"
                        onChange={(e) => setOption(i, { name: e.target.value })}
                      />
                    </td>
                    <td>
                      <Input
                        value={o.priceText}
                        inputMode="decimal"
                        onChange={(e) => setOption(i, { priceText: e.target.value })}
                      />
                    </td>
                    <td>
                      <Toggle checked={o.default_selected} onChange={(v) => setOption(i, { default_selected: v })} />
                    </td>
                    <td className="num">
                      <Button
                        size="sm"
                        variant="ghost"
                        type="button"
                        title="Duplicate this choice"
                        onClick={() =>
                          setDraftOptions((d) => [
                            ...d.slice(0, i + 1),
                            { ...d[i], $id: undefined, name: `${d[i].name} (copy)` },
                            ...d.slice(i + 1),
                          ])
                        }
                      >
                        ⧉
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        type="button"
                        title="Remove this choice"
                        onClick={() => {
                          if (o.$id) setRemovedOptionIds((r) => [...r, o.$id as string]);
                          setDraftOptions((d) => d.filter((_, idx) => idx !== i));
                        }}
                      >
                        ✕
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button
            size="sm"
            type="button"
            style={{ marginTop: '0.7rem' }}
            onClick={() => setDraftOptions((d) => [...d, { name: '', priceText: toInput(0, decimals), active: true, default_selected: false }])}
          >
            Add choice
          </Button>
          <p className="hint" style={{ marginTop: '0.6rem' }}>
            Extra cost is what this choice adds to the dish price. Leave it at {toInput(0, decimals)} for choices
            included in the price.
          </p>
        </Modal>
      )}
    </>
  );
}
