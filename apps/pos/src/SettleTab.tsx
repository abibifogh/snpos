import { useEffect, useMemo, useState } from 'react';
import { Button, Field, Input, Modal, Notice, Select, Spinner } from '@snpos/ui';
import {
  formatMoney, humanError, loadOpenTabs, ordersOnTab, paidOnOrders, loadPaymentMethods, recordPayment,
  tabOwing, displayOrderNo, MODULE_LABELS,
} from '@snpos/core';
import type { Tab, Order, PaymentMethod, Module } from '@snpos/core';
import type { PosContext } from './App';

/**
 * Settling a whole tab in one go, at the till.
 *
 * Settling was every bill on the tab paid one at a time, because that is what
 * keeps the money honest: each payment lands against its own order and in a
 * shift. That is still exactly what happens here. What changes is that the
 * person at the till does it once — one method, one reference — and this
 * writes the payment for each bill behind them.
 *
 * Eight bills as eight separate payments is the kind of chore that gets
 * skipped, and the way it gets skipped is by marking them paid by hand, which
 * records no method and no shift. That gap was closed on the admin side; this
 * is what stops it being opened in the first place.
 *
 * The tab itself is NOT closed here. A cashier may put orders on a tab and
 * settle it; deciding that an account is finished is management's, on the
 * Tabs page, the same as opening one was.
 */
export function SettleTab({
  ctx,
  onClose,
  onToast,
}: {
  ctx: PosContext;
  onClose: () => void;
  onToast: (m: string, tone?: 'ok' | 'err') => void;
}) {
  const [tabs, setTabs] = useState<Tab[] | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [tabId, setTabId] = useState('');
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [paid, setPaid] = useState<Record<string, number>>({});
  const [methodId, setMethodId] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const money = (n: number) => formatMoney(n, ctx.settings);

  useEffect(() => {
    Promise.all([loadOpenTabs(ctx.venue.$id), loadPaymentMethods(ctx.venue.$id)])
      .then(([t, m]) => {
        setTabs(t);
        setMethods(m);
        setMethodId(m[0]?.$id ?? '');
      })
      .catch((e) => { setError(humanError(e)); setTabs([]); });
  }, [ctx.venue.$id]);

  useEffect(() => {
    if (!tabId) { setOrders(null); return; }
    setOrders(null);
    (async () => {
      const rows = await ordersOnTab(tabId);
      setPaid(await paidOnOrders(rows.map((o) => o.$id)));
      setOrders(rows);
    })().catch((e) => { setError(humanError(e)); setOrders([]); });
  }, [tabId]);

  /** Each bill and what it still owes. The ones owing nothing are shown but not charged. */
  const lines = useMemo(
    () => (orders ?? [])
      .filter((o) => o.status !== 'CANCELLED' && o.status !== 'REJECTED' && o.payment_status !== 'refunded')
      .map((o) => ({ order: o, owing: Math.max(0, o.total - (paid[o.$id] ?? 0)) })),
    [orders, paid],
  );
  const owing = useMemo(() => tabOwing(orders ?? [], (id) => paid[id] ?? 0), [orders, paid]);
  const tab = tabs?.find((t) => t.$id === tabId) ?? null;
  const method = methods.find((m) => m.$id === methodId);

  const settle = async () => {
    if (!ctx.shift) { setError('No shift is open, so the money has nothing to be counted against.'); return; }
    if (!tab) { setError('Choose which tab is being settled.'); return; }
    if (!method) { setError('Choose how they paid.'); return; }
    if (owing <= 0) { setError('Nothing is owed on this tab.'); return; }
    setBusy(true);
    setError(null);
    try {
      let settled = 0;
      /*
        ONE PAYMENT PER BILL, not one payment for the tab.

        The money has to land against the orders it pays for, or the orders go
        on reading unpaid while a lump sits against nothing. Same method, same
        reference, same shift on every one — the person at the till said it
        once, and this repeats it for them.
      */
      for (const { order, owing: due } of lines) {
        if (due <= 0) continue;
        await recordPayment({
          venueId: ctx.venue.$id,
          order,
          shiftId: ctx.shift.$id,
          // Which side's drawer is taking the money. A bar bill settled at the
          // shop counter goes into the shop's drawer without moving the sale.
          shiftModule: ctx.module,
          methodId: method.$id,
          methodKind: method.kind,
          amount: due,
          reference: reference.trim(),
          takenBy: ctx.userId,
          orderStatus: 'CLOSED',
        });
        settled += 1;
      }
      onToast(`${tab.name} settled — ${money(owing)} on ${settled} ${settled === 1 ? 'bill' : 'bills'}`);
      onClose();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Settle a tab"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!tab || owing <= 0 || !ctx.profile?.can_mark_paid}
            onClick={() => void settle()}
          >
            {tab && owing > 0 ? `Take ${money(owing)}` : 'Settle'}
          </Button>
        </>
      }
    >
      {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
      {!ctx.profile?.can_mark_paid && (
        <Notice tone="warn">You are not set to take payment on this till.</Notice>
      )}

      {tabs === null ? <Spinner /> : tabs.length === 0 ? (
        <p className="small dim">No tabs are open.</p>
      ) : (
        <>
          <Field label="Which tab">
            <Select value={tabId} onChange={(e) => { setTabId(e.target.value); setError(null); }}>
              <option value="">Choose an account…</option>
              {tabs.map((t) => (
                <option key={t.$id} value={t.$id}>{t.name}{t.reference ? ` · ${t.reference}` : ''}</option>
              ))}
            </Select>
          </Field>

          {tabId && (orders === null ? <Spinner /> : (
            <>
              {lines.length === 0 ? (
                <p className="small dim">Nothing is on this tab.</p>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr><th>Bill</th><th>Where</th><th className="num">Total</th><th className="num">Owing</th></tr>
                    </thead>
                    <tbody>
                      {lines.map(({ order, owing: due }) => (
                        <tr key={order.$id} style={due === 0 ? { opacity: 0.55 } : undefined}>
                          <td style={{ fontWeight: 550 }}>{displayOrderNo(order.order_no)}</td>
                          <td className="small dim">{MODULE_LABELS[(order.module ?? 'kitchen') as Module]}</td>
                          <td className="num dim">{money(order.total)}</td>
                          <td className="num">{due === 0 ? <span className="dim">paid</span> : money(due)}</td>
                        </tr>
                      ))}
                      <tr>
                        <td colSpan={3} style={{ fontWeight: 650 }}>To take now</td>
                        <td className="num" style={{ fontWeight: 650 }}>{money(owing)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}

              {owing > 0 && (
                <>
                  <Field label="How they paid">
                    <Select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
                      {methods.map((m) => <option key={m.$id} value={m.$id}>{m.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="Reference" hint="The card machine's or mobile money's number, if there is one.">
                    <Input value={reference} onChange={(e) => setReference(e.target.value)} />
                  </Field>
                  {/* Said once, here: this pays the bills, it does not close the
                      account. Deciding an account is finished is management's,
                      the same as opening it was. */}
                  <p className="small dim" style={{ marginBottom: 0 }}>
                    This records a payment against each bill on the tab. The tab itself stays open for an admin to
                    close from the Tabs page.
                  </p>
                </>
              )}
            </>
          ))}
        </>
      )}
    </Modal>
  );
}
