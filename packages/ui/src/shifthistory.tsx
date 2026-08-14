import { useEffect, useState } from 'react';
import { Badge, Button, Empty, Field, FormError, Input, Modal, Spinner } from './components';
import {
  Query, formatMoney, listAll, displayOrderNo, requestReceipt,
  receiptForOrder, buildReceiptHtml, openPrintable, ordersForShift, fromTakings,
  loadPaymentMethods, isLivePayment,
} from '@snpos/core';
import type {
  Order, OrderItem, Settings, Shift, Doc, Venue, StaffProfile, PaidToKind, Module,
  PaymentMethod,
} from '@snpos/core';

/** A payment as this screen needs it: how much, in tips, and by what means. */
interface PaymentRow extends Doc {
  shift_id?: string;
  method_id: string;
  amount: number;
  tip?: number;
  status?: string;
}
import { ExpenseModal } from './till';

interface ExpenseRow extends Doc {
  shift_id?: string;
  amount: number;
  payee?: string;
  note?: string;
  category_key?: string;
  category: string;
  created_by: string;
  paid_to_kind?: PaidToKind;
  supplier_id?: string;
  paid_to_staff_id?: string;
  paid_from_method_id: string;
  from_takings?: boolean;
}

/**
 * What this shift has actually done.
 *
 * Shared by the kitchen screen and the till, because both answer the same
 * question with the same figures and two versions of "what have I sold today"
 * is one version too many.
 *
 * The kitchen screen is deliberately a list of what still needs cooking,
 * anything already dealt with disappears, which is right during service and
 * useless the moment somebody asks "did that order for the poolside ever go
 * out?" or "how much did I say the gas was?". A shop counter has the same gap
 * for a different reason: the sale is rung up and cleared away in one movement,
 * so by mid-afternoon the screen shows nothing a cashier has done all day.
 *
 * Scoped to the shift's own side of the business by `ordersForShift`, so a
 * craft cashier is never shown the restaurant's tickets.
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
  /**
   * What came in, and by what means.
   *
   * Read from the payments rather than added up from the orders. An order
   * total says what a bill came to; a payment says what was actually handed
   * over and in what form, which is the question being asked here — and it is
   * the only one of the two that knows about a bill settled half in cash and
   * half by card, or one that has only been part paid.
   */
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Sending a receipt again, and asking for an address when the order has none.
  const [sending, setSending] = useState<Order | null>(null);
  const [emailText, setEmailText] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * An expense being corrected by the person who recorded it.
   *
   * Here rather than anywhere new, because this is already the screen a cook
   * opens to see what the shift has spent. A mistake nobody can look at is a
   * mistake nobody fixes.
   */
  const [fixing, setFixing] = useState<ExpenseRow | null>(null);

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

  /** Read again after a correction, so the figures on this screen are the
      figures that were just saved rather than the ones that were wrong. */
  const reloadExpenses = () =>
    listAll<ExpenseRow>('shift_expenses', [Query.equal('shift_id', shift.$id)])
      .then((e) => setExpenses(e.sort((a, b) => b.$createdAt.localeCompare(a.$createdAt))))
      .catch(() => undefined);

  useEffect(() => {
    (async () => {
      // By the clock AND by the stamp, see ordersForShift. An order placed
      // before the till was opened and settled during this shift belongs here,
      // and reading only the clock left it out of the very list its money was
      // sitting in.
      const [sorted, e, pays, meths] = await Promise.all([
        ordersForShift(venueId, shift),
        listAll<ExpenseRow>('shift_expenses', [Query.equal('shift_id', shift.$id)]),
        listAll<PaymentRow>('payments', [Query.equal('shift_id', shift.$id)]).catch(() => [] as PaymentRow[]),
        loadPaymentMethods(venueId).catch(() => [] as PaymentMethod[]),
      ]);
      setOrders(sorted);
      setExpenses(e.sort((a, b) => b.$createdAt.localeCompare(a.$createdAt)));
      setPayments(pays);
      setMethods(meths);

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

  /**
   * Money in, split by how it arrived.
   *
   * A cook closing a shift is about to count a drawer, and "four hundred and
   * twenty came in" is no help when three hundred of it went through a card
   * machine. The two figures answer different questions and only one of them
   * is in the till.
   *
   * Voided and refunded payments are left out: money that was taken back was
   * not taken. Tips are counted, because they were physically handed over and
   * are in the drawer to be counted, and shown apart so nobody mistakes them
   * for sales.
   */
  const live = payments.filter(isLivePayment);
  const byMethod = methods
    .map((m) => {
      const mine = live.filter((p) => p.method_id === m.$id);
      return {
        id: m.$id,
        name: m.name,
        amount: mine.reduce((s, p) => s + (p.amount ?? 0), 0),
        tips: mine.reduce((s, p) => s + (p.tip ?? 0), 0),
      };
    })
    .filter((m) => m.amount > 0 || m.tips > 0);

  // Anything paid against a method this venue no longer lists. Rare, and worth
  // showing rather than quietly losing from a total somebody is counting to.
  const known = new Set(methods.map((m) => m.$id));
  const strayAmount = live.filter((p) => !known.has(p.method_id))
    .reduce((s, p) => s + (p.amount ?? 0) + (p.tip ?? 0), 0);

  const takings = live.reduce((s, p) => s + (p.amount ?? 0) + (p.tip ?? 0), 0);
  const tipsTotal = live.reduce((s, p) => s + (p.tip ?? 0), 0);
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

      {/*
        What came in, split by how it arrived.
        
        A cook closing a shift is about to count a drawer, and "four hundred
        and twenty came in" is no help when three hundred of it went through a
        card machine. Every figure here is a payment somebody actually took:
        an order nobody paid for and one the kitchen turned away have no
        payments against them, so neither can appear.
      */}
      {(byMethod.length > 0 || strayAmount > 0) && (
        <div className="cash-split">
          {byMethod.map((m) => (
            <div className="cash-split-item" key={m.id}>
              <div className="label">{m.name}</div>
              <div className="figure">{money(m.amount + m.tips)}</div>
              {m.tips > 0 && <div className="small dim">incl. {money(m.tips)} tips</div>}
            </div>
          ))}
          {strayAmount > 0 && (
            <div className="cash-split-item">
              <div className="label">Other</div>
              <div className="figure">{money(strayAmount)}</div>
              <div className="small dim">a method no longer listed</div>
            </div>
          )}
          <div className="cash-split-item total">
            <div className="label">All money in</div>
            <div className="figure">{money(takings)}</div>
            {tipsTotal > 0 && <div className="small dim">incl. {money(tipsTotal)} tips</div>}
          </div>
        </div>
      )}

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
              <tr>
                <th>Time</th><th>Paid to</th><th>What for</th>
                <th>From</th><th className="num">Amount</th><th />
              </tr>
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
                  {/* Where it came out of, which is two questions: what it was
                      paid with, and whose money that was. The second decides
                      whether the drawer is counted short by it, which is what
                      somebody at the end of the night is working out — so both
                      are a column rather than something found by opening each
                      row one at a time. */}
                  <td className="dim small">
                    {methods.find((m) => m.$id === e.paid_from_method_id)?.name ?? 'Not recorded'}
                    <div>{fromTakings(e) ? 'from this shift' : 'from petty cash'}</div>
                  </td>
                  <td className="num">{money(e.amount)}</td>
                  <td>
                    {/* Only while the shift is open. After it closes the count
                        has already been made against this figure, and changing
                        it then has consequences elsewhere — an admin's call. */}
                    {shift.status === 'open' && (
                      <Button size="sm" variant="ghost" onClick={() => setFixing(e)}>Correct</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {fixing && (
        <ExpenseModal
          module={(shift.module ?? 'kitchen') as Module}
          venueId={venueId}
          shiftId={shift.$id}
          settings={settings}
          userId={who?.user_id || who?.$id || ''}
          expense={fixing}
          onClose={() => setFixing(null)}
          onDone={(m) => {
            setFixing(null);
            void reloadExpenses();
            onToast(m);
          }}
        />
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
