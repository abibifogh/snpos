import { useEffect, useState } from 'react';
import { Spinner, Empty, Card, Badge } from '@snpos/ui';
import { listAll, Query, subscribeCollection } from '@snpos/core';
import type { PosContext, TableRow } from './App';
import type { Order } from '@snpos/core';

const STATUS_LABEL: Record<TableRow['status'], string> = {
  free: 'Free',
  seated: 'Seated',
  ordered: 'Ordered',
  bill_requested: 'Bill asked',
  dirty: 'Needs clearing',
};

export function TablesView({ ctx, onOpen }: { ctx: PosContext; onOpen: (t: TableRow) => void }) {
  const [tables, setTables] = useState<TableRow[] | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);

  useEffect(() => {
    (async () => {
      const [t, o] = await Promise.all([
        listAll<TableRow>('tables', [Query.equal('venue_id', ctx.venue.$id)]),
        /**
         * Everything still owed on, which is not the same as untouched.
         *
         * This asked for `unpaid` only, so the moment a table paid part of
         * its bill it stopped showing one: the table went quiet, the money
         * still owed disappeared off the floor plan, and the only person who
         * knew was whoever happened to be holding the receipt. Half a bill is
         * exactly the balance that gets forgotten, and this is the screen
         * somebody would have looked at to remember it.
         */
        listAll<Order>('orders', [
          Query.equal('venue_id', ctx.venue.$id),
          Query.equal('payment_status', ['unpaid', 'partial']),
        ]).then((rows) => rows.filter((o) => (o.module ?? 'kitchen') === 'kitchen')),
      ]);
      setTables(t.filter((x) => x.active).sort((a, b) => a.sort - b.sort));
      setOrders(o.filter((x) => !['REJECTED', 'CANCELLED', 'CLOSED'].includes(x.status)));
    })();
  }, [ctx.venue.$id]);

  // Keep the floor plan honest without anyone refreshing.
  useEffect(() => {
    const off = subscribeCollection<Order>('orders', (order) => {
      if (order.venue_id !== ctx.venue.$id) return;
      setOrders((prev) => {
        const without = prev.filter((o) => o.$id !== order.$id);
        // Still owed on, part paid included. See the note on the read above.
        const live = order.payment_status !== 'paid' && !['REJECTED', 'CANCELLED', 'CLOSED'].includes(order.status);
        return live ? [...without, order] : without;
      });
    });
    return off;
  }, [ctx.venue.$id]);

  if (!tables) return <Spinner />;
  if (tables.length === 0) {
    return (
      <Card>
        <Empty title="No tables set up">
          Add tables in the admin app under Setup. Each one gets its own QR code for customers to scan.
        </Empty>
      </Card>
    );
  }

  return (
    <div className="table-grid">
      {tables.map((t) => {
        const open = orders.filter((o) => o.table_id === t.$id);
        const total = open.reduce((s, o) => s + o.total, 0);
        const cls = open.length > 0 ? 'bill' : t.status === 'seated' ? 'seated' : '';
        // Said out loud, because the figure below is the bill and not the
        // balance. This screen knows what was ordered, not what has been
        // handed over; opening the table is where the real remainder lives.
        const part = open.some((o) => o.payment_status === 'partial');
        return (
          <button key={t.$id} className={`table-card ${cls}`} onClick={() => onOpen(t)}>
            <div className="label">{t.label}</div>
            <div className="sub">
              {open.length > 0 ? `${open.length} order${open.length > 1 ? 's' : ''}` : STATUS_LABEL[t.status]}
              {part && ' · part paid'}
            </div>
            {total > 0 && (
              <div style={{ marginTop: '0.4rem' }}>
                <Badge tone="warn">{(total / 10 ** (ctx.settings.currency_decimals ?? 2)).toFixed(2)}</Badge>
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
