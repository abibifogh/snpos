import { useEffect, useState } from 'react';
import { Badge, Button, Empty, Modal, Spinner } from '@snpos/ui';
import { Query, formatMoney, listAll, displayOrderNo } from '@snpos/core';
import type { Order, OrderItem, Settings, Shift, Doc } from '@snpos/core';

interface ExpenseRow extends Doc {
  shift_id?: string;
  amount: number;
  payee?: string;
  note?: string;
  category_key?: string;
  category: string;
  created_by: string;
}

/**
 * What this shift has actually done, from the pass.
 *
 * The kitchen screen is deliberately a list of what still needs cooking —
 * anything already dealt with disappears, which is right during service and
 * useless the moment somebody asks "did that order for the poolside ever go
 * out?" or "how much did I say the gas was?".
 *
 * Read-only on purpose. Correcting an order is an admin's job, with a reason
 * recorded; this is for answering a question without walking to another device.
 */
export function ShiftHistory({
  shift,
  venueId,
  settings,
  onClose,
}: {
  shift: Shift;
  venueId: string;
  settings: Settings;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'orders' | 'spend'>('orders');
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [items, setItems] = useState<Record<string, OrderItem[]>>({});
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const money = (n: number) => formatMoney(n, settings);

  useEffect(() => {
    (async () => {
      // By the shift's clock rather than its id: a customer ordering from a
      // phone has no shift stamped on their order, and those are exactly the
      // ones somebody asks about later.
      const closed = shift.closed_at ?? new Date().toISOString();
      const [o, e] = await Promise.all([
        listAll<Order>('orders', [
          Query.equal('venue_id', venueId),
          Query.greaterThanEqual('$createdAt', shift.opened_at),
          Query.lessThanEqual('$createdAt', closed),
        ]),
        listAll<ExpenseRow>('shift_expenses', [Query.equal('shift_id', shift.$id)]),
      ]);
      const sorted = o.sort((a, b) => b.$createdAt.localeCompare(a.$createdAt));
      setOrders(sorted);
      setExpenses(e.sort((a, b) => b.$createdAt.localeCompare(a.$createdAt)));

      if (sorted.length) {
        const lines = await listAll<OrderItem>('order_items', [
          Query.equal('order_id', sorted.slice(0, 100).map((x) => x.$id)),
        ]).catch(() => [] as OrderItem[]);
        const byOrder: Record<string, OrderItem[]> = {};
        for (const l of lines) (byOrder[l.order_id] ??= []).push(l);
        setItems(byOrder);
      }
    })().catch((e) => setError(e instanceof Error ? e.message : 'Could not load this shift.'));
  }, [shift.$id, shift.opened_at, shift.closed_at, venueId]);

  const takings = (orders ?? [])
    .filter((o) => o.payment_status === 'paid')
    .reduce((s, o) => s + o.total, 0);
  const spent = expenses.reduce((s, e) => s + e.amount, 0);

  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <Modal title={`This shift · ${shift.code}`} wide onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <div className="row" style={{ gap: '0.4rem', marginBottom: '0.9rem' }}>
        <Button size="sm" variant={tab === 'orders' ? 'primary' : 'default'} onClick={() => setTab('orders')}>
          Orders {orders ? `(${orders.length})` : ''}
        </Button>
        <Button size="sm" variant={tab === 'spend' ? 'primary' : 'default'} onClick={() => setTab('spend')}>
          Money out {expenses.length ? `(${expenses.length})` : ''}
        </Button>
        <span style={{ flex: 1 }} />
        <span className="small dim">
          {money(takings)} in · {money(spent)} out
        </span>
      </div>

      {!orders ? (
        <Spinner />
      ) : tab === 'orders' ? (
        orders.length === 0 ? (
          <Empty title="Nothing yet this shift">Orders appear here as they come in.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Time</th><th>Order</th><th>Where</th><th>Status</th><th>Paid</th><th className="num">Total</th></tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <>
                    <tr key={o.$id} onClick={() => setOpenId(openId === o.$id ? null : o.$id)} style={{ cursor: 'pointer' }}>
                      <td className="dim small">{time(o.$createdAt)}</td>
                      <td style={{ fontWeight: 550 }}>{displayOrderNo(o.order_no)}</td>
                      <td className="dim small">{o.placed_by || o.fulfilment}</td>
                      <td>
                        <Badge tone={o.status === 'SERVED' || o.status === 'CLOSED' ? 'ok' : 'default'}>
                          {o.status.toLowerCase()}
                        </Badge>
                      </td>
                      <td>
                        <Badge tone={o.payment_status === 'paid' ? 'ok' : 'warn'}>{o.payment_status}</Badge>
                      </td>
                      <td className="num">{money(o.total)}</td>
                    </tr>
                    {openId === o.$id && (
                      <tr key={`${o.$id}-lines`}>
                        <td colSpan={6} style={{ background: 'var(--surface-2)' }}>
                          <ul style={{ margin: 0, paddingLeft: '1.1rem' }} className="small">
                            {(items[o.$id] ?? []).map((i) => (
                              <li key={i.$id}>
                                {i.qty}× {i.name_snapshot}
                                {i.notes && <span className="dim"> — {i.notes}</span>}
                              </li>
                            ))}
                            {(items[o.$id] ?? []).length === 0 && <li className="dim">No items recorded.</li>}
                          </ul>
                          {o.notes && <p className="small dim" style={{ margin: '0.4rem 0 0' }}>{o.notes}</p>}
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : expenses.length === 0 ? (
        <Empty title="Nothing paid out this shift">Anything you record with “Record spend” shows up here.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Time</th><th>Paid to</th><th>What for</th><th className="num">Amount</th></tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.$id}>
                  <td className="dim small">{time(e.$createdAt)}</td>
                  <td>{e.payee || '—'}</td>
                  <td className="dim small">
                    {e.category_key || e.category}
                    {e.note && <div>{e.note}</div>}
                  </td>
                  <td className="num">{money(e.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
