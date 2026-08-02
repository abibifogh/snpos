import { useState } from 'react';
import { Button, Modal, Field, Input, Notice, Badge } from '@snpos/ui';
import {
  db, DB_ID, ID, Query, listAll, formatMoney, parseMoney, toInput,
  depleteForShift, loadIngredients, loadRecipes, updateStockAlerts, postShift, isEnabled, featureConfig,
} from '@snpos/core';
import type { Doc, OrderItem, Order } from '@snpos/core';
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
      let stockNote = '';
      const m = await loadMethods();
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

      // --- what the shift sold, so stock can be depleted against it
      const shiftOrders = (await listAll<Order>('orders', [Query.equal('shift_id', ctx.shift.$id)]))
        .filter((o) => o.payment_status === 'paid');
      const soldItems = shiftOrders.length
        ? await listAll<OrderItem>('order_items', [Query.equal('order_id', shiftOrders.map((o) => o.$id))])
        : [];

      let cogs = 0;
      if (isEnabled(ctx.features, 'waste_log') || soldItems.length) {
        const [ingredients, recipes] = await Promise.all([loadIngredients(ctx.venue.$id), loadRecipes()]);
        const usage = await depleteForShift(ctx.venue.$id, ctx.shift.$id, soldItems, recipes, ingredients, ctx.userId);
        // Cost of what was sold, valued at what the ingredients cost us.
        for (const [ingredientId, qty] of Object.entries(usage)) {
          const ing = ingredients.find((i) => i.$id === ingredientId);
          if (ing) cogs += Math.round(qty * ing.base_unit_cost);
        }

        // Re-read after depletion so the alerts reflect the new levels.
        const after = await loadIngredients(ctx.venue.$id);
        const threshold = featureConfig(ctx.features, 'shift_summary', 'persistent_stock_threshold', 3);
        const { fresh, persistent } = await updateStockAlerts(
          after.filter((i) => i.active),
          ctx.settings.low_stock_default_bp ?? 3000,
          threshold,
        );
        if (fresh.length || persistent.length) {
          stockNote =
            `${fresh.length} newly low, ${persistent.length} low for ${threshold}+ shifts` +
            (persistent.length ? `: ${persistent.map((p) => p.ingredient.name).slice(0, 4).join(', ')}` : '');
        }
      }

      const variancePenny = Object.values(variance).reduce((a, b) => a + b, 0);
      const shiftExpenses = await listAll<{ amount: number }>('shift_expenses', [
        Query.equal('shift_id', ctx.shift.$id),
      ]);
      const expenseTotal = shiftExpenses.reduce((a, e) => a + e.amount, 0);

      await db.updateDocument(DB_ID, 'shifts', ctx.shift.$id, {
        status: 'closed',
        closed_by: ctx.userId,
        closed_at: new Date().toISOString(),
        expected: JSON.stringify(expected),
        counted: JSON.stringify(countedMinor),
        variance: JSON.stringify(variance),
        sales_total: sales,
        expense_total: expenseTotal,
        cogs_total: cogs,
        tip_total: payments.reduce((a, p) => a + (p.tip ?? 0), 0),
        tax_total: shiftOrders.reduce((a, o) => a + o.tax_total, 0),
        discount_total: shiftOrders.reduce((a, o) => a + o.discount_total, 0),
        covers: shiftOrders.reduce((a, o) => a + (o.guest_count || 1), 0),
      });

      // --- the ledger. Posted last: if it fails, the shift is still closed and
      // the money is still counted, and the posting can be retried.
      try {
        const byKind = { cash: 0, card: 0, mobile_money: 0, other: 0 };
        for (const p of payments) {
          const method = m.find((x) => x.$id === p.method_id);
          const kind = (method?.kind ?? 'other') as keyof typeof byKind;
          byKind[kind in byKind ? kind : 'other'] += p.amount;
        }
        await postShift({
          venueId: ctx.venue.$id,
          shiftId: ctx.shift.$id,
          postedBy: ctx.userId,
          takings: byKind,
          tips: payments.reduce((a, p) => a + (p.tip ?? 0), 0),
          tax: shiftOrders.reduce((a, o) => a + o.tax_total, 0),
          discounts: shiftOrders.reduce((a, o) => a + o.discount_total, 0),
          cogs,
          cashVariance: variancePenny,
          expenses: shiftExpenses.map((e) => ({ amount: e.amount, accountCode: '6090' })),
        });
        await db.updateDocument(DB_ID, 'shifts', ctx.shift.$id, { posted_to_ledger: true });
      } catch (postErr) {
        onToast(
          `Shift closed, but the accounts entry failed: ${postErr instanceof Error ? postErr.message : 'unknown'}`,
          'err',
        );
      }

      await ctx.reloadShift();
      setClosing(false);

      const off = Object.values(variance).reduce((a, b) => a + Math.abs(b), 0);
      const base = off === 0 ? 'Shift closed and balanced' : `Shift closed — ${formatMoney(off, ctx.settings)} out`;
      onToast(
        stockNote ? `${base}. ${stockNote}` : base,
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
