import { useEffect, useState } from 'react';
import { Button, Card, Empty, Field, FormError, Input, Modal, Notice, Select, Spinner, Textarea, Badge, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import { formatMoney, parseMoney, toInput } from '@snpos/core';
import type { Doc } from '@snpos/core';
import { useSession } from '../session';

interface Voucher extends Doc {
  name: string;
  code?: string;
  description?: string;
  kind: 'percent' | 'amount' | 'free_item' | 'item_percent' | 'free_delivery';
  value: number;
  scope: string;
  min_order_total: number;
  max_discount_amount?: number;
  guest_applicable: boolean;
  staff_applicable: boolean;
  requires_manager: boolean;
  auto_apply: boolean;
  stackable: boolean;
  starts_at?: string;
  ends_at?: string;
  usage_limit_total?: number;
  usage_limit_per_customer?: number;
  first_order_only: boolean;
  used_count: number;
  active: boolean;
  created_by?: string;
}

/** A date the browser's date input understands, from an ISO timestamp. */
const asDate = (iso?: string) => (iso ? iso.slice(0, 10) : '');

/**
 * Vouchers and discount codes.
 *
 * A voucher is money leaving the restaurant, which is why every one of them
 * has a ceiling and an end date on the same screen as the amount. A percentage
 * off with neither is an open tab: "20% off" against a party of thirty is a
 * very different number from what the person who typed it had in mind.
 */
export function VouchersPage() {
  const { settings, user } = useSession();
  const toast = useToast();
  const decimals = settings?.currency_decimals ?? 2;
  const symbol = settings?.currency_symbol ?? '';

  const [rows, setRows] = useState<Voucher[] | null>(null);
  const [editing, setEditing] = useState<Partial<Voucher> | null>(null);
  const [valueText, setValueText] = useState('');
  const [capText, setCapText] = useState('');
  const [minText, setMinText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const v = await listAll<Voucher>('discounts');
    setRows(v.sort((a, b) => b.$createdAt.localeCompare(a.$createdAt)));
  };
  useEffect(() => { load().catch((e) => setError(humanError(e))); }, []);

  const open = (row?: Voucher) => {
    setError(null);
    if (row) {
      setEditing(row);
      setValueText(row.kind === 'percent' ? String((row.value ?? 0) / 100) : toInput(row.value ?? 0, decimals));
      setCapText(row.max_discount_amount ? toInput(row.max_discount_amount, decimals) : '');
      setMinText(row.min_order_total ? toInput(row.min_order_total, decimals) : '');
      return;
    }
    // Ends in a month by default. A voucher with no end date is one somebody
    // finds in a drawer next year and still expects to work.
    const inAMonth = new Date();
    inAMonth.setMonth(inAMonth.getMonth() + 1);
    setEditing({
      name: '',
      code: '',
      kind: 'percent',
      scope: 'order',
      guest_applicable: true,
      staff_applicable: true,
      requires_manager: false,
      auto_apply: false,
      stackable: false,
      first_order_only: false,
      active: true,
      starts_at: new Date().toISOString(),
      ends_at: inAMonth.toISOString(),
    });
    setValueText('');
    setCapText('');
    setMinText('');
  };

  const save = async () => {
    if (!editing) return;
    if (!editing.name?.trim()) { setError('Give it a name, so it is recognisable on a report.'); return; }

    const isPercent = editing.kind === 'percent';
    const raw = Number(valueText);
    if (!valueText.trim() || Number.isNaN(raw) || raw <= 0) {
      setError(isPercent ? 'Enter the percentage off, for example 20.' : 'Enter the amount off.');
      return;
    }
    if (isPercent && raw > 100) { setError('A percentage cannot be more than 100.'); return; }

    const cap = capText.trim() ? parseMoney(capText, decimals) : null;
    if (capText.trim() && cap === null) { setError('That maximum amount is not a number.'); return; }
    const min = minText.trim() ? parseMoney(minText, decimals) : 0;
    if (minText.trim() && min === null) { setError('That minimum order is not a number.'); return; }

    if (editing.starts_at && editing.ends_at && editing.ends_at < editing.starts_at) {
      setError('It cannot end before it starts.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: editing.name.trim(),
        code: (editing.code ?? '').trim().toUpperCase(),
        description: editing.description ?? '',
        // Percent is stored in basis points so a half-percent is expressible
        // without anyone storing a fraction of a pesewa.
        kind: editing.kind ?? 'percent',
        value: isPercent ? Math.round(raw * 100) : (parseMoney(valueText, decimals) ?? 0),
        scope: editing.scope ?? 'order',
        min_order_total: min ?? 0,
        max_discount_amount: cap ?? undefined,
        guest_applicable: !!editing.guest_applicable,
        staff_applicable: !!editing.staff_applicable,
        requires_manager: !!editing.requires_manager,
        auto_apply: !!editing.auto_apply,
        stackable: !!editing.stackable,
        starts_at: editing.starts_at || undefined,
        ends_at: editing.ends_at || undefined,
        usage_limit_total: editing.usage_limit_total || undefined,
        usage_limit_per_customer: editing.usage_limit_per_customer || undefined,
        first_order_only: !!editing.first_order_only,
        active: editing.active !== false,
        created_by: user?.$id ?? '',
      };
      if (editing.$id) await db.updateDocument(DB_ID, 'discounts', editing.$id, payload);
      else await db.createDocument(DB_ID, 'discounts', ID.unique(), { ...payload, used_count: 0 });

      setEditing(null);
      await load();
      toast('Voucher saved');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Count the uses again from the redemption records.
   *
   * The count is kept by the server as vouchers are redeemed, so this normally
   * does nothing. It exists because it did not always work: for a while the
   * check ran before the redemption row had been written, so nothing was
   * counted. This puts the figures right from the records that were kept
   * correctly all along, rather than asking anybody to guess.
   */
  const recount = async () => {
    setBusy(true);
    setError(null);
    try {
      const redemptions = await listAll<{ discount_id: string; status: string }>('discount_redemptions');
      const used = new Map<string, number>();
      for (const r of redemptions) {
        if (r.status !== 'applied') continue;
        used.set(r.discount_id, (used.get(r.discount_id) ?? 0) + 1);
      }

      let changed = 0;
      for (const v of rows ?? []) {
        const real = used.get(v.$id) ?? 0;
        if (real === v.used_count) continue;
        // A voucher already past its limit is switched off at the same time, so
        // the list and the behaviour agree from here on.
        const patch: Record<string, unknown> = { used_count: real };
        if (v.usage_limit_total && real >= v.usage_limit_total) patch.active = false;
        await db.updateDocument(DB_ID, 'discounts', v.$id, patch);
        changed += 1;
      }

      await load();
      toast(changed === 0 ? 'All counts were already right' : `${changed} voucher${changed === 1 ? '' : 's'} corrected`);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: Voucher) => {
    if (row.used_count > 0) {
      // Deleting a used voucher would orphan the redemption records that show
      // where the money went. Switching it off does the same job honestly.
      if (!confirm(`${row.name} has been used ${row.used_count} time(s). It will be switched off rather than deleted, so the records still make sense. Continue?`)) return;
      await db.updateDocument(DB_ID, 'discounts', row.$id, { active: false }).catch(() => undefined);
      await load();
      toast('Voucher switched off');
      return;
    }
    if (!confirm(`Delete "${row.name}"?`)) return;
    try {
      await db.deleteDocument(DB_ID, 'discounts', row.$id);
      await load();
      toast('Deleted');
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  const worth = (v: Voucher) =>
    v.kind === 'percent'
      ? `${(v.value / 100).toFixed(v.value % 100 === 0 ? 0 : 1)}%${v.max_discount_amount ? ` · max ${formatMoney(v.max_discount_amount, settings!)}` : ''}`
      : settings ? formatMoney(v.value, settings) : String(v.value);

  const state = (v: Voucher) => {
    const now = new Date().toISOString();
    // Checked before `active`, because a voucher that hit its limit is
    // switched off automatically — and "Off" would make that look like
    // somebody's decision rather than the limit doing its job.
    if (v.usage_limit_total && v.used_count >= v.usage_limit_total) {
      return { tone: 'danger' as const, label: 'Used up' };
    }
    if (v.ends_at && v.ends_at < now) return { tone: 'danger' as const, label: 'Expired' };
    if (!v.active) return { tone: 'default' as const, label: 'Off' };
    if (v.starts_at && v.starts_at > now) return { tone: 'warn' as const, label: 'Not started' };
    return { tone: 'ok' as const, label: 'Live' };
  };

  if (!rows) return <Spinner />;

  return (
    <>
      <div className="spread">
        <h1>Discount vouchers</h1>
        <div className="row" style={{ gap: '0.4rem' }}>
          <Button onClick={() => void recount()} loading={busy && !editing}>Recount uses</Button>
          <Button variant="primary" onClick={() => open()}>New voucher</Button>
        </div>
      </div>
      <p className="dim" style={{ maxWidth: '46rem' }}>
        A voucher with a code can be typed by a customer while ordering. One without a code is a button staff press.
        Every voucher is money leaving the till, so give each one an end date and — for anything by percentage — a
        maximum amount.
      </p>

      {error && !editing && <Notice>{error}</Notice>}

      {rows.length === 0 ? (
        <Empty title="No vouchers yet">
          Create one when you want to run an offer. Give it an end date so it stops on its own.
        </Empty>
      ) : (
        <Card title={`${rows.length} voucher${rows.length === 1 ? '' : 's'}`}>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th><th>Code</th><th>Worth</th><th>Runs until</th>
                  <th>Used</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => {
                  const s = state(v);
                  return (
                    <tr key={v.$id}>
                      <td style={{ fontWeight: 550 }}>{v.name}</td>
                      <td>{v.code ? <code>{v.code}</code> : <span className="dim small">staff only</span>}</td>
                      <td>{worth(v)}</td>
                      <td>{v.ends_at ? new Date(v.ends_at).toLocaleDateString() : <span className="dim">no end</span>}</td>
                      <td>{v.used_count}{v.usage_limit_total ? ` / ${v.usage_limit_total}` : ''}</td>
                      <td><Badge tone={s.tone}>{s.label}</Badge></td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <Button size="sm" onClick={() => open(v)}>Edit</Button>{' '}
                        <Button size="sm" variant="ghost" onClick={() => void remove(v)}>Delete</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {editing && (
        <Modal
          title={editing.$id ? 'Edit voucher' : 'New voucher'}
          wide
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => void save()} loading={busy}>Save</Button>
            </>
          }
        >
          <FormError message={error} />

          <div className="grid-2">
            <Field label="Name" hint="What it is called on reports.">
              <Input
                value={editing.name ?? ''}
                autoFocus
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Field>
            <Field label="Code" hint="Leave blank for a voucher only staff can apply.">
              <Input
                value={editing.code ?? ''}
                placeholder="OPENING20"
                onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })}
              />
            </Field>
          </div>

          <div className="grid-2">
            <Field label="Kind">
              <Select
                value={editing.kind ?? 'percent'}
                onChange={(e) => setEditing({ ...editing, kind: e.target.value as Voucher['kind'] })}
              >
                <option value="percent">Percentage off</option>
                <option value="amount">Fixed amount off</option>
              </Select>
            </Field>
            <Field label={editing.kind === 'percent' ? 'Percentage off' : `Amount off (${symbol})`}>
              <Input value={valueText} inputMode="decimal" onChange={(e) => setValueText(e.target.value)} />
            </Field>
          </div>

          {editing.kind === 'percent' && (
            <Field
              label={`Maximum amount (${symbol})`}
              hint="The most this voucher can ever take off one bill. Strongly recommended — without it, a large table costs whatever they order."
            >
              <Input value={capText} inputMode="decimal" onChange={(e) => setCapText(e.target.value)} />
            </Field>
          )}

          <Field label={`Minimum order (${symbol})`} hint="Leave blank if it applies to any order.">
            <Input value={minText} inputMode="decimal" onChange={(e) => setMinText(e.target.value)} />
          </Field>

          <div className="grid-2">
            <Field label="Starts">
              <Input
                type="date"
                value={asDate(editing.starts_at)}
                onChange={(e) =>
                  setEditing({ ...editing, starts_at: e.target.value ? new Date(`${e.target.value}T00:00:00`).toISOString() : '' })
                }
              />
            </Field>
            <Field label="Expires" hint="The last day it works. Both days included.">
              <Input
                type="date"
                value={asDate(editing.ends_at)}
                onChange={(e) =>
                  setEditing({ ...editing, ends_at: e.target.value ? new Date(`${e.target.value}T23:59:59`).toISOString() : '' })
                }
              />
            </Field>
          </div>

          <div className="grid-2">
            <Field label="Total times it can be used" hint="Leave blank for no limit.">
              <Input
                type="number"
                min={1}
                value={editing.usage_limit_total ?? ''}
                onChange={(e) => setEditing({ ...editing, usage_limit_total: Number(e.target.value) || undefined })}
              />
            </Field>
            <Field label="Times one customer can use it" hint="Leave blank for no limit.">
              <Input
                type="number"
                min={1}
                value={editing.usage_limit_per_customer ?? ''}
                onChange={(e) => setEditing({ ...editing, usage_limit_per_customer: Number(e.target.value) || undefined })}
              />
            </Field>
          </div>

          <Field label="Description" hint="Optional. Shown to staff.">
            <Textarea
              value={editing.description ?? ''}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            />
          </Field>

          <Card title="Who can use it">
            <label className="check-row">
              <input
                type="checkbox"
                checked={!!editing.guest_applicable}
                onChange={(e) => setEditing({ ...editing, guest_applicable: e.target.checked })}
              />{' '}
              Customers can type the code when ordering
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={editing.staff_applicable !== false}
                onChange={(e) => setEditing({ ...editing, staff_applicable: e.target.checked })}
              />{' '}
              Staff can apply it at the till
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={!!editing.requires_manager}
                onChange={(e) => setEditing({ ...editing, requires_manager: e.target.checked })}
              />{' '}
              A manager has to approve it
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={editing.active !== false}
                onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
              />{' '}
              Switched on
            </label>
          </Card>
        </Modal>
      )}
    </>
  );
}
