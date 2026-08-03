import { useEffect, useState } from 'react';
import { Button, Card, Empty, Badge, Spinner, Notice } from '@snpos/ui';
import { db, DB_ID, Query, listAll, loadOpenOrders, subscribeCollection, displayOrderNo } from '@snpos/core';
import type { Order, OrderItem } from '@snpos/core';
import type { PosContext } from './App';

/**
 * Kitchen tickets inside the terminal.
 *
 * For shifts with nobody on the floor: the cook takes the order, cooks it and
 * settles the bill from one screen rather than walking between two devices.
 *
 * Deliberately quieter than the dedicated kitchen display — someone standing
 * at the till does not need an alarm going off in their ear, and an alarm they
 * silence out of irritation is worse than no alarm at all.
 */
export function KitchenPanel({
  ctx,
  onToast,
}: {
  ctx: PosContext;
  onToast: (m: string, tone?: 'ok' | 'err') => void;
}) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [items, setItems] = useState<Record<string, OrderItem[]>>({});
  const [, tick] = useState(0);

  // Refresh the age counters without a subscription per ticket.
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 5000);
    return () => window.clearInterval(t);
  }, []);

  const loadItems = async (ids: string[]) => {
    if (!ids.length) return;
    const rows = await listAll<OrderItem>('order_items', [Query.equal('order_id', ids.slice(0, 100))]);
    const grouped: Record<string, OrderItem[]> = {};
    for (const r of rows) (grouped[r.order_id] ??= []).push(r);
    setItems((prev) => ({ ...prev, ...grouped }));
  };

  useEffect(() => {
    (async () => {
      const open = await loadOpenOrders(ctx.venue.$id);
      setOrders(open);
      await loadItems(open.map((o) => o.$id));
    })();
  }, [ctx.venue.$id]);

  useEffect(() => {
    const off = subscribeCollection<Order>('orders', (order) => {
      if (order.venue_id !== ctx.venue.$id) return;
      setOrders((prev) => {
        const list = prev ?? [];
        const live = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY'].includes(order.status);
        const without = list.filter((o) => o.$id !== order.$id);
        if (live && !list.some((o) => o.$id === order.$id)) void loadItems([order.$id]);
        return live ? [...without, order].sort((a, b) => a.$createdAt.localeCompare(b.$createdAt)) : without;
      });
    });
    return off;
  }, [ctx.venue.$id]);

  const patch = async (order: Order, body: Partial<Order>) => {
    setOrders((prev) => (prev ?? []).map((o) => (o.$id === order.$id ? { ...o, ...body } : o)));
    try {
      await db.updateDocument(DB_ID, 'orders', order.$id, body);
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'Could not update that order.', 'err');
    }
  };

  const minutesSince = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 60000);

  if (!orders) return <Spinner />;
  const live = orders.filter((o) => ['PENDING', 'ACCEPTED', 'PREPARING', 'READY'].includes(o.status));

  return (
    <>
      <Notice tone="warn">
        This is the kitchen queue on the till. The dedicated kitchen screen has the alarm; this one stays quiet, so
        keep an eye on it rather than waiting to be told.
      </Notice>

      {live.length === 0 ? (
        <Card><Empty title="Nothing cooking" /></Card>
      ) : (
        <div className="table-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
          {live.map((o) => {
            const age = minutesSince(o.$createdAt);
            const lines = items[o.$id] ?? [];
            const overdue =
              ['ACCEPTED', 'PREPARING'].includes(o.status) &&
              lines.some((i) => i.due_at && new Date(i.due_at).getTime() < Date.now());
            return (
              <Card key={o.$id} title={displayOrderNo(o.order_no)}>
                <div className="row" style={{ marginBottom: '0.5rem' }}>
                  <Badge tone={o.status === 'PENDING' ? 'warn' : o.status === 'READY' ? 'ok' : 'default'}>
                    {o.status.toLowerCase()}
                  </Badge>
                  <span className="small dim">{age}m ago</span>
                  {overdue && <Badge tone="danger">Late</Badge>}
                </div>
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: '0.9rem' }}>
                  {lines.map((i) => (
                    <li key={i.$id} style={{ padding: '0.2rem 0' }}>
                      <strong>{i.qty}×</strong> {i.name_snapshot}
                      {i.notes && <div className="small" style={{ color: 'var(--warn)' }}>“{i.notes}”</div>}
                    </li>
                  ))}
                </ul>
                <div className="row" style={{ marginTop: '0.7rem' }}>
                  {o.status === 'PENDING' && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() =>
                        patch(o, {
                          status: 'ACCEPTED',
                          accepted_at: new Date().toISOString(),
                          accepted_by: ctx.userId,
                          alert_level: 0,
                        })
                      }
                    >
                      Accept
                    </Button>
                  )}
                  {o.status === 'ACCEPTED' && (
                    <Button size="sm" variant="primary" onClick={() => patch(o, { status: 'PREPARING' })}>
                      Start
                    </Button>
                  )}
                  {o.status === 'PREPARING' && (
                    <Button size="sm" variant="primary" onClick={() => patch(o, { status: 'READY' })}>
                      Ready
                    </Button>
                  )}
                  {o.status === 'READY' && (
                    o.payment_status === 'paid'
                      ? <Badge tone="ok">Paid — waiting to be collected</Badge>
                      : <Badge tone="warn">Not paid yet — settle before it goes out</Badge>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
