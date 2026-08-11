import { useEffect, useState } from 'react';
import { Badge, Button, Empty, Field, FormError, Input, Modal, Spinner } from '@snpos/ui';
import {
  Query, formatMoney, listAll, displayOrderNo, requestReceipt,
  receiptForOrder, buildReceiptHtml, openPrintable, ordersForShift,
} from '@snpos/core';
import type { Order, OrderItem, Settings, Shift, Doc, Venue, StaffProfile } from '@snpos/core';

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
 * The kitchen screen is deliberately a list of what still needs cooking, 
 * anything already dealt with disappears, which is right during service and
 * useless the moment somebody asks "did that order for the poolside ever go
 * out?" or "how much did I say the gas was?".
 *
 * Read-only on purpose. Correcting an order is an admin's job, with a reason
 * recorded; this is for answering a question without walking to another device.
 */
export function ShiftHistory({
  shift,
  venue,
  settings,
  who,
  onClose,
  onToast,
}: {
  shift: Shift;
  venue: Venue;
  settings: Settings;
  who: StaffProfile | null;
  onClose: () => void;
  onToast: (message: string, tone?: 'ok' | 'err') => void;
}) {
  const venueId = venue.$id;
  const [tab, setTab] = useState<'orders' | 'spend'>('orders');
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [items, setItems] = useState<Record<string, OrderItem[]>>({});
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Sending a receipt again, and asking for an address when the order has none.
  const [sending, setSending] = useState<Order | null>(null);
  const [emailText, setEmailText] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const startSend = (o: Order) => {
    setSending(o);
    setEmailText(o.customer_email ?? '');
    setSendError(null);
  };

  const send = async () => {
    if (!sending) return;
    setBusy(true);
    setSendError(null);
    try {
      await requestReceipt({
        order: sending,
        email: emailText,
        requestedBy: who?.user_id || who?.$id || '',
      });
      // Kept on the order in memory too, so the row stops offering to collect
      // an address it already has.
      setOrders((prev) =>
        (prev ?? []).map((o) => (o.$id === sending.$id ? { ...o, customer_email: emailText.trim() } : o)),
      );
      setSending(null);
      onToast(`Receipt on its way to ${emailText.trim()}`);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Could not send that receipt.');
    } finally {
      setBusy(false);
    }
  };

  /** A copy to print or hand over, for a customer standing at the counter. */
  const print = async (o: Order) => {
    try {
      const data = await receiptForOrder({
        order: o,
        settings,
        venue,
        items: items[o.$id],
        staffName: who?.display_name,
      });
      openPrintable(buildReceiptHtml(data), `Receipt ${o.order_no}`);
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'Could not open that receipt.', 'err');
    }
  };

  const money = (n: number) => formatMoney(n, settings);

  useEffect(() => {
    (async () => {
      // By the clock AND by the stamp, see ordersForShift. An order placed
      // before the till was opened and settled during this shift belongs here,
      // and reading only the clock left it out of the very list its money was
      // sitting in.
      const [sorted, e] = await Promise.all([
        ordersForShift(venueId, shift),
        listAll<ExpenseRow>('shift_expenses', [Query.equal('shift_id', shift.$id)]),
      ]);
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
                <tr>
                  <th>Time</th><th>Order</th><th>Where</th><th>Status</th><th>Paid</th>
                  <th className="num">Total</th><th>Receipt</th>
                </tr>
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
                      <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                        <Button size="sm" variant="ghost" onClick={() => startSend(o)}>
                          {o.customer_email ? 'Send again' : 'Email it'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void print(o)}>Print</Button>
                      </td>
                    </tr>
                    {openId === o.$id && (
                      <tr key={`${o.$id}-lines`}>
                        <td colSpan={7} style={{ background: 'var(--surface-2)' }}>
                          <ul style={{ margin: 0, paddingLeft: '1.1rem' }} className="small">
                            {(items[o.$id] ?? []).map((i) => (
                              <li key={i.$id}>
                                {i.qty}× {i.name_snapshot}
                                {i.notes && <span className="dim">, {i.notes}</span>}
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
                  <td>{e.payee || '-'}</td>
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
      {sending && (
        <Modal
          title={`Receipt for ${displayOrderNo(sending.order_no)}`}
          onClose={() => setSending(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setSending(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => void send()} loading={busy}>
                {sending.customer_email ? 'Send again' : 'Send receipt'}
              </Button>
            </>
          }
        >
          <FormError message={sendError} />
          <p className="small dim" style={{ marginTop: 0 }}>
            {sending.customer_email
              ? 'Already sent once. Sending again is fine, change the address first if they gave you a different one.'
              : 'This order was placed without an email address. Enter one and the receipt will go out, with the printable copy attached.'}
          </p>
          <Field label="Email address">
            <Input
              type="email"
              value={emailText}
              autoFocus
              placeholder="name@example.com"
              onChange={(e) => setEmailText(e.target.value)}
            />
          </Field>
          {sending.payment_status !== 'paid' && (
            <p className="small" style={{ color: 'var(--warn)' }}>
              This bill has not been settled yet, so the receipt will say so.
            </p>
          )}
        </Modal>
      )}
    </Modal>
  );
}
