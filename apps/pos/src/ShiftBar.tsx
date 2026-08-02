import { useState } from 'react';
import { Button, Modal, Field, Input, Notice, Badge } from '@snpos/ui';
import { db, DB_ID, ID, Query, listAll, formatMoney, parseMoney, toInput } from '@snpos/core';
import type { Doc } from '@snpos/core';
import type { PosContext } from './App';

export interface Shift extends Doc {
  venue_id: string;
  code: string;
  status: 'open' | 'closing' | 'closed';
  opened_by: string;
  opened_at: string;
  opening_floats: string;
  float_source: string;
  sales_total: number;
  expense_total: number;
  covers: number;
}

interface PaymentMethod extends Doc { name: string; kind: string; enabled: boolean; counted_at_close: boolean; venue_id: string }

/**
 * The shift is the boundary that makes cash reconcilable.
 *
 * Nothing can be paid for outside one — otherwise money arrives with no
 * opening float to measure it against, and the day never balances.
 */
export function ShiftBar({ ctx, onToast }: { ctx: PosContext; onToast: (m: string, tone?: 'ok' | 'err') => void }) {
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);
  const [floats, setFloats] = useState<Record<string, string>>({});
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decimals = ctx.settings.currency_decimals ?? 2;

  const loadMethods = async () => {
    const m = (await listAll<PaymentMethod>('payment_methods', [Query.equal('venue_id', ctx.venue.$id)])).filter((x) => x.enabled);
    setMethods(m);
    return m;
  };

  const startOpen = async () => {
    const m = await loadMethods();
    const initial: Record<string, string> = {};
    for (const x of m) initial[x.$id] = toInput(0, decimals);
    setFloats(initial);
    setOpening(true);
    setError(null);
  };

  const openShift = async () => {
    setBusy(true);
    setError(null);
    try {
      const code = `S${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Date.now().toString(36).slice(-4)}`;
      await db.createDocument(DB_ID, 'shifts', ID.unique(), {
        venue_id: ctx.venue.$id,
        code,
        status: 'open',
        opened_by: ctx.userId,
        opened_at: new Date().toISOString(),
        opening_floats: JSON.stringify(
          Object.fromEntries(Object.entries(floats).map(([k, v]) => [k, parseMoney(v, decimals) ?? 0])),
        ),
        float_source: 'zero',
        sales_total: 0, expense_total: 0, tax_total: 0, tip_total: 0, discount_total: 0,
        void_total: 0, refund_total: 0, cogs_total: 0, covers: 0,
        stock_check_status: 'pending', posted_to_ledger: false,
      });
      await ctx.reloadShift();
      setOpening(false);
      onToast('Shift opened');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the shift.');
    } finally {
      setBusy(false);
    }
  };

  const startClose = async () => {
    const m = await loadMethods();
    const initial: Record<string, string> = {};
    for (const x of m.filter((y) => y.counted_at_close)) initial[x.$id] = toInput(0, decimals);
    setCounted(initial);
    setClosing(true);
    setError(null);
  };

  const closeShift = async () => {
    if (!ctx.shift) return;
    setBusy(true);
    setError(null);
    try {
      // Expected = opening float + everything taken through that method.
      const payments = await listAll<{ method_id: string; amount: number; tip: number }>('payments', [
        Query.equal('shift_id', ctx.shift.$id),
      ]);
      const openingFloats: Record<string, number> = JSON.parse(ctx.shift.opening_floats || '{}');
      const expected: Record<string, number> = { ...openingFloats };
      let sales = 0;
      for (const p of payments) {
        expected[p.method_id] = (expected[p.method_id] ?? 0) + p.amount;
        sales += p.amount;
      }

      const countedMinor = Object.fromEntries(
        Object.entries(counted).map(([k, v]) => [k, parseMoney(v, decimals) ?? 0]),
      );
      const variance = Object.fromEntries(
        Object.keys(countedMinor).map((k) => [k, (countedMinor[k] ?? 0) - (expected[k] ?? 0)]),
      );

      await db.updateDocument(DB_ID, 'shifts', ctx.shift.$id, {
        status: 'closed',
        closed_by: ctx.userId,
        closed_at: new Date().toISOString(),
        expected: JSON.stringify(expected),
        counted: JSON.stringify(countedMinor),
        variance: JSON.stringify(variance),
        sales_total: sales,
      });
      await ctx.reloadShift();
      setClosing(false);

      const off = Object.values(variance).reduce((a, b) => a + Math.abs(b), 0);
      onToast(
        off === 0 ? 'Shift closed and balanced' : `Shift closed — ${formatMoney(off, ctx.settings)} out`,
        off > (ctx.settings.cash_variance_tolerance ?? 500) ? 'err' : 'ok',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not close the shift.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        className="pos-top"
        style={{ borderTop: 'none', background: ctx.shift ? 'var(--surface)' : 'var(--warn-bg)' }}
      >
        <div className="row">
          {ctx.shift ? (
            <>
              <Badge tone="ok">Shift open</Badge>
              <span className="small dim">
                {ctx.shift.code} · since {new Date(ctx.shift.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </>
          ) : (
            <span className="small" style={{ color: 'var(--warn)' }}>
              No shift open — orders can be taken, but nothing can be marked paid until one is.
            </span>
          )}
        </div>
        {ctx.shift ? (
          <Button size="sm" onClick={startClose} disabled={ctx.profile?.can_close_shift === false}>Close shift</Button>
        ) : (
          <Button size="sm" variant="primary" onClick={startOpen} disabled={ctx.profile?.can_open_shift === false}>
            Open shift
          </Button>
        )}
      </div>

      {opening && (
        <Modal
          title="Open shift"
          onClose={() => setOpening(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpening(false)}>Cancel</Button>
              <Button variant="primary" onClick={openShift} loading={busy}>Open shift</Button>
            </>
          }
        >
          <p className="small dim" style={{ marginTop: 0 }}>
            Count what is in the drawer now. This is the figure the close will measure against, so a guess here becomes
            a false discrepancy later.
          </p>
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
          {methods.map((m) => (
            <Field key={m.$id} label={`${m.name} float (${ctx.settings.currency_symbol})`}>
              <Input
                value={floats[m.$id] ?? ''}
                inputMode="decimal"
                onChange={(e) => setFloats({ ...floats, [m.$id]: e.target.value })}
              />
            </Field>
          ))}
        </Modal>
      )}

      {closing && (
        <Modal
          title="Close shift"
          onClose={() => setClosing(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setClosing(false)}>Cancel</Button>
              <Button variant="primary" onClick={closeShift} loading={busy}>Close shift</Button>
            </>
          }
        >
          <p className="small dim" style={{ marginTop: 0 }}>
            Count each drawer and enter what is actually there — not what you expect. The difference is the point of
            the exercise.
          </p>
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
          {methods.filter((m) => m.counted_at_close).map((m) => (
            <Field key={m.$id} label={`${m.name} counted (${ctx.settings.currency_symbol})`}>
              <Input
                value={counted[m.$id] ?? ''}
                inputMode="decimal"
                onChange={(e) => setCounted({ ...counted, [m.$id]: e.target.value })}
              />
            </Field>
          ))}
        </Modal>
      )}
    </>
  );
}
