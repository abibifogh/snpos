import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import { formatMoney, Query } from '@snpos/core';
import type { Order, OrderItem, StaffProfile, Doc } from '@snpos/core';
import { useSession } from '../session';

interface Payment extends Doc {
  order_id: string;
  method_id: string;
  amount: number;
  tip: number;
  taken_by: string;
  change_given: number;
}
interface PaymentMethod extends Doc { name: string }

/**
 * Every order, over a range you choose.
 *
 * The Reports page answers "how did we do"; this one answers "what happened to
 * that order" — which is the question somebody actually has when a customer
 * rings up about last Tuesday.
 *
 * It is also the only place a status can be put back. Mistakes happen at a
 * pass: an order marked paid that was not, food marked collected that is still
 * sitting there. Without a way to undo, the only options are living with a
 * wrong figure or editing the database directly, and one of those is worse
 * than the other.
 */

const STATUSES = ['SCHEDULED', 'PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'CLOSED', 'REJECTED', 'CANCELLED'];
const PAYMENT_STATUSES = ['unpaid', 'partial', 'paid', 'refunded'];

/** Local midnight, so "today" means today here rather than in UTC. */
const dayStart = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999`).toISOString();
const todayStr = () => new Date().toLocaleDateString('en-CA');
const daysAgoStr = (n: number) => new Date(Date.now() - n * 86400_000).toLocaleDateString('en-CA');

export function OrdersPage() {
  const { settings, profile } = useSession();
  const toast = useToast();

  const [from, setFrom] = useState(daysAgoStr(7));
  const [to, setTo] = useState(todayStr());
  const [staffId, setStaffId] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [orders, setOrders] = useState<Order[] | null>(null);
  const [items, setItems] = useState<Record<string, OrderItem[]>>({});
  const [payments, setPayments] = useState<Payment[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [open, setOpen] = useState<Order | null>(null);
  const [editing, setEditing] = useState<Order | null>(null);
  const [newStatus, setNewStatus] = useState('');
  const [newPayment, setNewPayment] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));

  const load = async () => {
    setOrders(null);
    const [o, p, m, s] = await Promise.all([
      listAll<Order>('orders', [
        Query.greaterThanEqual('$createdAt', dayStart(from)),
        Query.lessThanEqual('$createdAt', dayEnd(to)),
      ]),
      listAll<Payment>('payments'),
      listAll<PaymentMethod>('payment_methods'),
      listAll<StaffProfile>('staff_profiles'),
    ]);
    setOrders(o.sort((a, b) => b.$createdAt.localeCompare(a.$createdAt)));
    setPayments(p);
    setMethods(m);
    setStaff(s.filter((x) => x.active !== false));
  };
  useEffect(() => { load().catch((e) => setError(humanError(e))); /* eslint-disable-next-line */ }, [from, to]);

  /** Everyone who touched an order, so the staff filter can mean something. */
  const touchedBy = (o: Order): string[] => {
    const ids = [o.accepted_by, o.marked_paid_by, ...payments.filter((p) => p.order_id === o.$id).map((p) => p.taken_by)];
    return [...new Set(ids.filter(Boolean) as string[])];
  };

  const nameOf = (userId?: string) => {
    if (!userId) return '—';
    const person = staff.find((s) => s.user_id === userId || s.$id === userId);
    return person?.display_name ?? 'Unknown';
  };

  const visible = useMemo(
    () =>
      (orders ?? []).filter((o) => {
        if (statusFilter && o.status !== statusFilter) return false;
        if (staffId && !touchedBy(o).includes(staffId)) return false;
        return true;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orders, statusFilter, staffId, payments],
  );

  const totals = useMemo(() => {
    const paid = visible.filter((o) => o.payment_status === 'paid');
    return {
      count: visible.length,
      paid: paid.length,
      value: paid.reduce((s, o) => s + o.total, 0),
      unpaid: visible.filter((o) => o.payment_status !== 'paid').reduce((s, o) => s + o.total, 0),
    };
  }, [visible]);

  const openOrder = async (o: Order) => {
    setOpen(o);
    if (!items[o.$id]) {
      const rows = await listAll<OrderItem>('order_items', [Query.equal('order_id', o.$id)]).catch(() => []);
      setItems((m) => ({ ...m, [o.$id]: rows }));
    }
  };

  const startEdit = (o: Order) => {
    setEditing(o);
    setNewStatus(o.status);
    setNewPayment(o.payment_status);
    setReason('');
    setError(null);
  };

  const applyEdit = async () => {
    if (!editing) return;
    if (!reason.trim()) {
      setError('Say why you are changing it. This is the only record of the correction.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await db.updateDocument(DB_ID, 'orders', editing.$id, {
        status: newStatus,
        payment_status: newPayment,
      });
      // Written to the audit log rather than silently: an order whose status
      // was changed by hand is exactly the one somebody will ask about.
      await db.createDocument(DB_ID, 'audit_log', ID.unique(), {
        venue_id: editing.venue_id,
        actor_id: profile?.user_id ?? profile?.$id ?? '',
        actor_role: profile?.role ?? '',
        action: 'order_status_reversed',
        entity_type: 'orders',
        entity_id: editing.$id,
        before: JSON.stringify({ status: editing.status, payment_status: editing.payment_status }),
        after: JSON.stringify({ status: newStatus, payment_status: newPayment }),
        reason: reason.trim(),
      });

      setEditing(null);
      await load();
      toast(`${editing.order_no} updated`);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !orders && !editing) return <Notice>{error}</Notice>;

  return (
    <>
      <div className="spread">
        <h1>Orders</h1>
        <Button onClick={() => load().catch((e) => setError(humanError(e)))}>Refresh</Button>
      </div>

      <Card title="Which orders">
        <div className="grid-2">
          <Field label="From">
            <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} min={from} max={todayStr()} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Member of staff" hint="Anyone who accepted, served or took payment for it.">
            <Select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
              <option value="">Everyone</option>
              {staff.map((s) => (
                <option key={s.$id} value={s.user_id || s.$id}>{s.display_name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">Any</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
            </Select>
          </Field>
        </div>
        <div className="row row-wrap" style={{ marginTop: '0.4rem' }}>
          {[['Today', 0], ['Last 7 days', 6], ['Last 30 days', 29]].map(([label, days]) => (
            <Button
              key={label as string}
              size="sm"
              onClick={() => { setFrom(daysAgoStr(days as number)); setTo(todayStr()); }}
            >
              {label as string}
            </Button>
          ))}
        </div>
      </Card>

      {orders && (
        <div className="grid-2">
          <Card title="Orders"><p style={{ margin: 0, fontSize: '1.6rem', fontWeight: 650 }}>{totals.count}</p>
            <span className="dim small">{totals.paid} paid</span></Card>
          <Card title="Taken"><p style={{ margin: 0, fontSize: '1.6rem', fontWeight: 650 }}>{money(totals.value)}</p>
            {totals.unpaid > 0 && <span className="dim small" style={{ color: 'var(--warn)' }}>{money(totals.unpaid)} still unpaid</span>}</Card>
        </div>
      )}

      <Card pad={false}>
        {!orders ? (
          <div className="card-pad"><Spinner /></div>
        ) : visible.length === 0 ? (
          <Empty title="Nothing in that range">Widen the dates, or clear the filters.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th><th>Order</th><th>Where</th><th>Status</th><th>Paid</th>
                  <th>Who</th><th className="num">Total</th><th />
                </tr>
              </thead>
              <tbody>
                {visible.map((o) => (
                  <tr key={o.$id}>
                    <td className="dim small">{new Date(o.$createdAt).toLocaleString()}</td>
                    <td style={{ fontWeight: 550 }}>{o.order_no}</td>
                    <td className="dim small">
                      {o.is_group ? `Group${o.group_reference ? ` · ${o.group_reference}` : ''}` : o.fulfilment}
                      {o.seat_note && <div>{o.seat_note}</div>}
                    </td>
                    <td><Badge tone={o.status === 'CLOSED' || o.status === 'SERVED' ? 'ok' : 'default'}>{o.status.toLowerCase()}</Badge></td>
                    <td>
                      <Badge tone={o.payment_status === 'paid' ? 'ok' : 'warn'}>{o.payment_status}</Badge>
                    </td>
                    <td className="dim small">{touchedBy(o).map(nameOf).join(', ') || '—'}</td>
                    <td className="num">{money(o.total)}</td>
                    <td className="num">
                      <Button size="sm" variant="ghost" onClick={() => openOrder(o)}>Details</Button>
                      <Button size="sm" variant="ghost" onClick={() => startEdit(o)}>Change</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {open && (
        <Modal title={`Order ${open.order_no}`} onClose={() => setOpen(null)} footer={<Button onClick={() => setOpen(null)}>Close</Button>}>
          <div className="table-wrap">
            <table className="data">
              <tbody>
                <tr><td className="dim">Placed</td><td>{new Date(open.$createdAt).toLocaleString()}</td></tr>
                <tr><td className="dim">By</td><td>{open.placed_by}</td></tr>
                {open.seat_note && <tr><td className="dim">Sitting</td><td>{open.seat_note}</td></tr>}
                <tr><td className="dim">Accepted by</td><td>{nameOf(open.accepted_by)}</td></tr>
                <tr><td className="dim">Marked paid by</td><td>{nameOf(open.marked_paid_by)}</td></tr>
                {open.customer_email && <tr><td className="dim">Email</td><td>{open.customer_email}</td></tr>}
              </tbody>
            </table>
          </div>

          <h3 style={{ margin: '1.2rem 0 0.4rem' }}>What was ordered</h3>
          <div className="table-wrap">
            <table className="data">
              <tbody>
                {(items[open.$id] ?? []).map((i) => (
                  <tr key={i.$id}>
                    <td><strong>{i.qty}×</strong> {i.name_snapshot}
                      {i.notes && <div className="small dim">“{i.notes}”</div>}</td>
                    <td className="num">{money(i.line_total)}</td>
                  </tr>
                ))}
                <tr><td style={{ fontWeight: 650 }}>Total</td><td className="num" style={{ fontWeight: 650 }}>{money(open.total)}</td></tr>
              </tbody>
            </table>
          </div>

          <h3 style={{ margin: '1.2rem 0 0.4rem' }}>Payment</h3>
          {payments.filter((p) => p.order_id === open.$id).length === 0 ? (
            <p className="small dim" style={{ margin: 0 }}>Nothing recorded against this order.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Method</th><th className="num">Amount</th><th className="num">Tip</th><th>Taken by</th></tr></thead>
                <tbody>
                  {payments.filter((p) => p.order_id === open.$id).map((p) => (
                    <tr key={p.$id}>
                      <td>{methods.find((m) => m.$id === p.method_id)?.name ?? '—'}</td>
                      <td className="num">{money(p.amount)}</td>
                      <td className="num dim">{p.tip ? money(p.tip) : '—'}</td>
                      <td className="dim small">{nameOf(p.taken_by)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}

      {editing && (
        <Modal
          title={`Change ${editing.order_no}`}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={applyEdit} loading={busy}>Save the change</Button>
            </>
          }
        >
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
          <p className="small dim" style={{ marginTop: 0 }}>
            Putting a status back is sometimes the only honest option — an order marked paid that was not, food marked
            collected that is still on the pass. It changes the figures, so the reason is kept with it.
          </p>
          <div className="grid-2">
            <Field label="Status">
              <Select value={newStatus} onChange={(e) => setNewStatus(e.target.value)}>
                {STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
              </Select>
            </Field>
            <Field label="Payment">
              <Select value={newPayment} onChange={(e) => setNewPayment(e.target.value)}>
                {PAYMENT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Why" hint="Recorded against your name in the audit log.">
            <Input
              value={reason}
              autoFocus
              placeholder="Marked paid by mistake — customer had not paid"
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          {newPayment !== 'paid' && editing.payment_status === 'paid' && (
            <Notice tone="warn">
              This order has payment records against it. Setting it back to unpaid does not delete them — the money is
              still counted in the shift it was taken in. Fix the payment separately if it was never received.
            </Notice>
          )}
        </Modal>
      )}
    </>
  );
}
