import { useEffect, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Textarea, Badge, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import { formatMoney } from '@snpos/core';
import type { Ingredient, MenuItem, Doc } from '@snpos/core';
import { useSession } from '../session';

interface WasteRow extends Doc {
  venue_id: string;
  ingredient_id?: string;
  menu_item_id?: string;
  qty: number;
  unit: string;
  reason: string;
  note?: string;
  value: number;
  recorded_by: string;
}

const REASONS = [
  { v: 'spoiled', l: 'Spoiled' }, { v: 'expired', l: 'Expired' }, { v: 'dropped', l: 'Dropped' },
  { v: 'burnt', l: 'Burnt' }, { v: 'prep_error', l: 'Prep error' }, { v: 'customer_return', l: 'Customer returned it' },
  { v: 'staff_meal', l: 'Staff meal' }, { v: 'trim', l: 'Trim' }, { v: 'other', l: 'Other' },
];

export function WastePage() {
  const { settings, user } = useSession();
  const toast = useToast();
  const [rows, setRows] = useState<WasteRow[] | null>(null);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [editing, setEditing] = useState<Partial<WasteRow> | null>(null);
  const [kind, setKind] = useState<'ingredient' | 'dish'>('ingredient');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [w, i, m] = await Promise.all([
      listAll<WasteRow>('waste_log'), listAll<Ingredient>('ingredients'), listAll<MenuItem>('menu_items'),
    ]);
    setRows(w.sort((a, b) => b.$createdAt.localeCompare(a.$createdAt)));
    setIngredients(i.filter((x) => x.active));
    setItems(m.filter((x) => x.active));
  };
  useEffect(() => { load().catch((e) => setError(humanError(e))); }, []);

  const save = async () => {
    if (!editing?.qty || editing.qty <= 0) { setError('Enter how much was wasted.'); return; }
    const ing = ingredients.find((x) => x.$id === editing.ingredient_id);
    if (kind === 'ingredient' && !ing) { setError('Choose the ingredient.'); return; }
    if (kind === 'dish' && !editing.menu_item_id) { setError('Choose the dish.'); return; }

    setBusy(true);
    setError(null);
    try {
      // Valuing waste at cost is what turns "we binned some chicken" into a
      // number that shows up next to the day's profit.
      const value = kind === 'ingredient' && ing ? Math.round(ing.base_unit_cost * editing.qty) : 0;
      await db.createDocument(DB_ID, 'waste_log', ID.unique(), {
        venue_id: 'main',
        ingredient_id: kind === 'ingredient' ? editing.ingredient_id : '',
        menu_item_id: kind === 'dish' ? editing.menu_item_id : '',
        qty: Number(editing.qty),
        unit: kind === 'ingredient' ? (ing?.unit ?? 'each') : 'each',
        reason: editing.reason ?? 'spoiled',
        note: editing.note ?? '',
        value,
        recorded_by: user?.$id ?? '',
      });

      // Waste leaves the building, so the stock figure must follow it down, 
      // otherwise the next count reads as an unexplained loss.
      if (kind === 'ingredient' && ing) {
        await db.createDocument(DB_ID, 'stock_movements', ID.unique(), {
          venue_id: 'main', ingredient_id: ing.$id, type: 'waste',
          qty_delta: -Number(editing.qty), unit_cost: ing.base_unit_cost,
          ref_type: 'waste', created_by: user?.$id ?? '',
        }).catch(() => undefined);
        await db.updateDocument(DB_ID, 'ingredients', ing.$id, {
          current_qty: Number((ing.current_qty - Number(editing.qty)).toFixed(4)),
        }).catch(() => undefined);
      }

      setEditing(null);
      await load();
      toast('Waste recorded');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const total = (rows ?? []).reduce((s, r) => s + r.value, 0);
  const name = (r: WasteRow) =>
    ingredients.find((i) => i.$id === r.ingredient_id)?.name ?? items.find((i) => i.$id === r.menu_item_id)?.name ?? '-';

  return (
    <>
      <div className="spread">
        <h1>Waste</h1>
        <Button variant="primary" onClick={() => { setEditing({ qty: 1, reason: 'spoiled' }); setKind('ingredient'); setError(null); }}>
          Record waste
        </Button>
      </div>

      <p className="dim small" style={{ marginTop: 0 }}>
        Recording waste as it happens is what makes the stock figures trustworthy. Without it, food thrown away and
        food walking out of the door look identical when you count.
      </p>

      {error && !editing && <Notice>{error}</Notice>}

      {rows && rows.length > 0 && (
        <Card>
          <div className="spread">
            <span className="dim">Recorded so far</span>
            <strong style={{ fontSize: '1.3rem' }}>{settings ? formatMoney(total, settings) : total}</strong>
          </div>
        </Card>
      )}

      <Card pad={false}>
        {!rows ? (
          <div className="card-pad"><Spinner /></div>
        ) : rows.length === 0 ? (
          <Empty title="Nothing recorded yet">Good, or nobody is recording. The second is more likely.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Date</th><th>What</th><th className="num">Amount</th><th>Reason</th><th className="num">Cost</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.$id}>
                    <td className="dim small">{new Date(r.$createdAt).toLocaleDateString()}</td>
                    <td>{name(r)}</td>
                    <td className="num">{r.qty} {r.unit}</td>
                    <td><Badge>{REASONS.find((x) => x.v === r.reason)?.l ?? r.reason}</Badge></td>
                    <td className="num">{settings && r.value ? formatMoney(r.value, settings) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <Modal
          title="Record waste"
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={save} loading={busy}>Record</Button>
            </>
          }
        >
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
          <Field label="What was wasted">
            <Select value={kind} onChange={(e) => setKind(e.target.value as 'ingredient' | 'dish')}>
              <option value="ingredient">A raw ingredient</option>
              <option value="dish">A finished dish</option>
            </Select>
          </Field>
          {kind === 'ingredient' ? (
            <Field label="Ingredient">
              <Select value={editing.ingredient_id ?? ''} onChange={(e) => setEditing({ ...editing, ingredient_id: e.target.value })}>
                <option value="">Choose</option>
                {ingredients.map((i) => <option key={i.$id} value={i.$id}>{i.name} ({i.unit})</option>)}
              </Select>
            </Field>
          ) : (
            <Field label="Dish">
              <Select value={editing.menu_item_id ?? ''} onChange={(e) => setEditing({ ...editing, menu_item_id: e.target.value })}>
                <option value="">Choose</option>
                {items.map((i) => <option key={i.$id} value={i.$id}>{i.name}</option>)}
              </Select>
            </Field>
          )}
          <div className="grid-2">
            <Field label="How much">
              <Input type="number" step="any" min="0" value={editing.qty ?? 1} onChange={(e) => setEditing({ ...editing, qty: Number(e.target.value) })} />
            </Field>
            <Field label="Reason">
              <Select value={editing.reason ?? 'spoiled'} onChange={(e) => setEditing({ ...editing, reason: e.target.value })}>
                {REASONS.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Note">
            <Textarea value={editing.note ?? ''} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
          </Field>
        </Modal>
      )}
    </>
  );
}
