import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Empty, Notice, Spinner } from '@snpos/ui';
import {
  loadBooked, bookedItems, releaseBooked, bookedList, bookedStage, inWords, subscribeCollection,
  displayOrderNo, cookNowProblem, humanError, RELEASE_GRACE_MS,
} from '@snpos/core';
import type { Order, OrderItem } from '@snpos/core';
import type { PosContext } from './App';

const hm = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--';

/**
 * Pre-orders on the till: today's and tomorrow's, before and after they go to
 * the kitchen.
 *
 * A pre-order used to be invisible here until the minute it was released, so
 * nobody at the front knew one was coming, and a release that never happened
 * looked exactly like nothing booked. Each one now shows what it is for, who,
 * what, and when the kitchen starts it; turns amber half an hour before; and
 * red if it is past its time and still waiting. Send to kitchen now does it
 * by hand. See preorders.ts.
 */
export interface BookedState {
  orders: Order[] | null;
  items: Record<string, OrderItem[]>;
  now: Date;
  error: string | null;
  reload: () => Promise<void>;
}

/** Booked orders for this venue, kept current: read once, then on every change to one. */
export function useBooked(venueId: string | undefined, on = true): BookedState {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [items, setItems] = useState<Record<string, OrderItem[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  const load = async () => {
    if (!venueId) return;
    try {
      const rows = await loadBooked(venueId);
      setOrders(rows);
      const lines = await bookedItems(rows.map((o) => o.$id));
      const grouped: Record<string, OrderItem[]> = {};
      for (const l of lines) (grouped[l.order_id] ??= []).push(l);
      setItems(grouped);
    } catch (e) {
      setError(humanError(e));
      setOrders([]);
    }
  };

  useEffect(() => {
    if (!venueId || !on) return undefined;
    void load();
    const tick = window.setInterval(() => setNow(new Date()), 30_000);
    // Read again each minute as well: a change the live feed missed, such as a
    // release by another screen, must not leave this list saying "late".
    const again = window.setInterval(() => void load(), 60_000);
    const off = subscribeCollection<Order>('orders', (o) => {
      if (o.venue_id === venueId && (o.is_preorder || o.status === 'SCHEDULED')) void load();
    });
    return () => { window.clearInterval(tick); window.clearInterval(again); off(); };
  }, [venueId, on]); // eslint-disable-line react-hooks/exhaustive-deps

  return { orders, items, now, error, reload: load };
}

export function BookedPanel({ ctx, booked, onToast }: {
  ctx: PosContext;
  booked: BookedState;
  onToast: (m: string, tone?: 'ok' | 'err') => void;
}) {
  const { orders, items, now } = booked;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(booked.error);
  const load = booked.reload;

  const list = useMemo(() => bookedList(orders ?? [], now), [orders, now]);

  const send = async (o: Order) => {
    const why = cookNowProblem(o, ctx.profile);
    if (why) { setError(why); return; }
    setBusy(o.$id);
    setError(null);
    try {
      const sent = await releaseBooked(o.$id, 'till');
      onToast(sent ? `${displayOrderNo(o.order_no)} sent to the kitchen` : `${displayOrderNo(o.order_no)} was already in the kitchen`);
      await load();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  };

  if (!orders) return <Spinner />;
  const late = list.today.filter((o) => bookedStage(o, now.getTime()) === 'late').length;

  const card = (o: Order, tomorrow = false) => {
    const stage = bookedStage(o, now.getTime());
    const lines = items[o.$id] ?? [];
    const start = o.fire_at ? Date.parse(o.fire_at) : NaN;
    const who = o.customer_name || o.group_contact_name || (o.table_id ? 'Table' : 'Pre-order');
    const where = [o.fulfilment === 'takeaway' ? 'Pickup' : o.fulfilment === 'delivery' ? 'Delivery' : null,
      o.group_size ? `${o.group_size} people` : null, o.customer_phone || null].filter(Boolean).join(' · ');
    const blocked = cookNowProblem(o, ctx.profile);
    return (
      <div key={o.$id} className={`booked ${stage === 'soon' ? 'soon' : stage === 'late' ? 'late' : stage === 'sent' ? 'sent' : ''}`}>
        <div className="booked-for"><small>For</small>{hm(o.scheduled_for)}</div>
        <div className="booked-who">
          <b>{who}</b> <span className="small dim">· {displayOrderNo(o.order_no)}{where ? ` · ${where}` : ''}</span>
          <div className="small dim">
            {lines.length ? lines.map((l) => `${l.qty} ${l.name_snapshot}`).join(', ') : '·'}
          </div>
        </div>
        <div className="booked-acts">
          {stage !== 'sent' && (
            <Button
              size="sm"
              variant={stage === 'late' ? 'danger' : stage === 'soon' || stage === 'due' ? 'primary' : 'default'}
              loading={busy === o.$id}
              disabled={!!blocked}
              title={blocked ?? undefined}
              onClick={() => void send(o)}
            >
              {blocked ? 'Manager sends this' : 'Send to kitchen now'}
            </Button>
          )}
        </div>
        <div className="booked-state">
          {stage === 'booked' && (
            <Badge>{tomorrow ? `Kitchen starts it tomorrow at ${hm(o.fire_at)}` : `Kitchen starts it at ${hm(o.fire_at)} · in ${inWords(start - now.getTime())}`}</Badge>
          )}
          {stage === 'soon' && <Badge tone="warn">Kitchen starts it in {inWords(start - now.getTime())}</Badge>}
          {stage === 'due' && <Badge tone="warn">Going to the kitchen now</Badge>}
          {stage === 'late' && (
            <Badge tone="danger">
              Should have gone to the kitchen at {hm(o.fire_at)} · {Math.round((now.getTime() - start) / 60_000)} min late
            </Badge>
          )}
          {stage === 'sent' && (
            <>
              <Badge tone="ok">In the kitchen since {hm(o.fired_at || o.fire_at)}</Badge>
              {o.released_by && o.released_by !== 'server' && (
                <span className="small dim">Sent by the {o.released_by}</span>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <Card
      title="Booked"
      help={(
        <>
          Pre-orders for today and tomorrow. Each goes to the kitchen at its start time: its cooking time before the
          time it is for. If it has not gone {RELEASE_GRACE_MS / 60_000} minutes after that, this till sends it.
          Send to kitchen now sends it early; a group booking needs a manager.
        </>
      )}
    >
      {error && <Notice>{error}</Notice>}
      {late > 0 && <Notice tone="warn">{late} booked order{late === 1 ? ' is' : 's are'} late going to the kitchen.</Notice>}
      {list.today.length === 0 && list.tomorrow.length === 0 ? (
        <Empty title="Nothing booked for today or tomorrow">Pre-orders appear here as soon as they are placed.</Empty>
      ) : (
        <div className="booked-list">
          {list.today.length > 0 && <div className="booked-h">Today</div>}
          {list.today.map((o) => card(o))}
          {list.tomorrow.length > 0 && <div className="booked-h">Tomorrow</div>}
          {list.tomorrow.map((o) => card(o, true))}
        </div>
      )}
    </Card>
  );
}
