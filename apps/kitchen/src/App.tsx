import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Spinner, Modal, Select, Textarea, Field, Notice } from '@snpos/ui';
import { applyTheme } from '@snpos/ui';
import {
  account, db, DB_ID, Query, listAll, loadOpenOrders, subscribeCollection, isCreate,
} from '@snpos/core';
import type { Order, OrderItem, Settings, Venue } from '@snpos/core';
import { unlockAudio, setAlarm, stopAlarm } from './alarm';

const STATIONS = ['all', 'hot', 'cold', 'bar', 'dessert'] as const;
type Station = (typeof STATIONS)[number];

const REJECT_REASONS: { code: string; label: string }[] = [
  { code: 'out_of_stock', label: 'Out of stock' },
  { code: 'too_busy', label: 'Kitchen too busy' },
  { code: 'item_unavailable', label: 'Item unavailable' },
  { code: 'closing_soon', label: 'Closing soon' },
  { code: 'duplicate', label: 'Duplicate order' },
  { code: 'customer_request', label: 'Customer asked to cancel' },
  { code: 'other', label: 'Something else' },
];

const secondsSince = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [venue, setVenue] = useState<Venue | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [items, setItems] = useState<Record<string, OrderItem[]>>({});
  const [station, setStation] = useState<Station>(() => (localStorage.getItem('kds-station') as Station) || 'all');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<Order | null>(null);
  const [rejectCode, setRejectCode] = useState(REJECT_REASONS[0].code);
  const [rejectNote, setRejectNote] = useState('');
  const [, forceTick] = useState(0);

  // Re-render once a second so the age counters climb without a subscription.
  useEffect(() => {
    const t = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  const loadItemsFor = useCallback(async (orderIds: string[]) => {
    if (orderIds.length === 0) return;
    const rows = await listAll<OrderItem>('order_items', [Query.equal('order_id', orderIds.slice(0, 100))]);
    setItems((prev) => {
      const next = { ...prev };
      for (const id of orderIds) next[id] = [];
      for (const r of rows) (next[r.order_id] ??= []).push(r);
      return next;
    });
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await account.get();
      } catch {
        setError('Sign in on this device first, from the terminal app.');
        return;
      }
      try {
        const s = (await db.getDocument(DB_ID, 'settings', 'main')) as unknown as Settings;
        applyTheme(s);
        setSettings(s);
        const venues = await listAll<Venue>('venues', [Query.equal('active', true)]);
        const v = venues[0];
        setVenue(v ?? null);
        if (!v) return;
        const open = await loadOpenOrders(v.$id);
        setOrders(open);
        await loadItemsFor(open.map((o) => o.$id));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load orders.');
      }
    })();
  }, [loadItemsFor]);

  // Live updates. Without this the kitchen is a page someone has to refresh.
  useEffect(() => {
    if (!venue) return;
    const off = subscribeCollection<Order>('orders', (order, events) => {
      if (order.venue_id !== venue.$id) return;
      setOrders((prev) => {
        const live = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY'].includes(order.status);
        const without = prev.filter((o) => o.$id !== order.$id);
        return live ? [...without, order].sort((a, b) => a.$createdAt.localeCompare(b.$createdAt)) : without;
      });
      if (isCreate(events) && order.status === 'PENDING') void loadItemsFor([order.$id]);
    });
    return off;
  }, [venue, loadItemsFor]);

  const visible = useMemo(
    () =>
      orders
        .filter((o) => ['PENDING', 'ACCEPTED', 'PREPARING', 'READY'].includes(o.status))
        .filter((o) => {
          if (station === 'all') return true;
          return (items[o.$id] ?? []).some((i) => i.station === station);
        }),
    [orders, station, items],
  );

  const pending = visible.filter((o) => o.status === 'PENDING');

  /**
   * Escalation is driven by the oldest unacknowledged ticket, not by each one
   * separately — three quiet alarms are less useful than one loud one.
   */
  const sla = settings?.kitchen_ack_sla_seconds ?? 60;
  const worstLevel = useMemo(() => {
    if (!ready || pending.length === 0) return 0;
    const oldest = Math.max(...pending.map((o) => secondsSince(o.$createdAt)));
    return Math.min(Math.floor(oldest / sla) + 1, settings?.kitchen_ping_max_level ?? 4);
  }, [pending, ready, sla, settings]);

  const lastLevel = useRef(0);
  useEffect(() => {
    if (worstLevel !== lastLevel.current) {
      lastLevel.current = worstLevel;
      setAlarm(worstLevel);
    }
    return () => {
      if (worstLevel === 0) stopAlarm();
    };
  }, [worstLevel]);

  const patch = async (order: Order, body: Record<string, unknown>) => {
    // Optimistic: a cook who taps Accept must see it accepted immediately, or
    // they tap again.
    setOrders((prev) => prev.map((o) => (o.$id === order.$id ? { ...o, ...(body as Partial<Order>) } : o)));
    try {
      await db.updateDocument(DB_ID, 'orders', order.$id, body);
    } catch (e) {
      setOrders((prev) => prev.map((o) => (o.$id === order.$id ? order : o)));
      setError(e instanceof Error ? e.message : 'Could not update that order.');
    }
  };

  const accept = (o: Order) =>
    patch(o, { status: 'ACCEPTED', accepted_at: new Date().toISOString(), alert_level: 0 });
  const start = (o: Order) => patch(o, { status: 'PREPARING' });
  const done = (o: Order) => patch(o, { status: 'READY' });

  const reject = async () => {
    if (!rejecting) return;
    if (settings?.require_reject_reason && !rejectCode) return;
    await patch(rejecting, {
      status: 'REJECTED',
      rejected_at: new Date().toISOString(),
      reject_reason_code: rejectCode,
      reject_reason_note: rejectNote,
      alert_level: 0,
    });
    setRejecting(null);
    setRejectNote('');
  };

  if (error && !settings) {
    return (
      <div className="kds-empty">
        <div>
          <h2>Cannot start</h2>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!settings || !venue) {
    return <div className="kds-empty"><Spinner /></div>;
  }

  return (
    <div className="kds">
      {!ready && (
        <div className="audio-gate">
          <div>
            <h1>Kitchen display</h1>
            <p className="dim" style={{ maxWidth: '28rem', marginTop: '0.6rem' }}>
              Tap to start service. Browsers block sound until the screen is touched, so the alarm cannot work before
              you do this.
            </p>
            <Button
              variant="primary"
              className="btn"
              onClick={() => {
                unlockAudio();
                setReady(true);
              }}
            >
              Start service
            </Button>
          </div>
        </div>
      )}

      <div className="kds-top">
        <div>
          <h1>{venue.name}</h1>
        </div>
        <div className="station-tabs">
          {STATIONS.map((s) => (
            <button
              key={s}
              className={station === s ? 'on' : ''}
              onClick={() => {
                setStation(s);
                localStorage.setItem('kds-station', s);
              }}
            >
              {s === 'all' ? 'All' : s}
            </button>
          ))}
        </div>
        <div className="kds-stats">
          <span>New <b>{pending.length}</b></span>
          <span>Cooking <b>{visible.filter((o) => o.status === 'PREPARING').length}</b></span>
          <span>Ready <b>{visible.filter((o) => o.status === 'READY').length}</b></span>
        </div>
      </div>

      {error && <div style={{ padding: '0.6rem 1rem' }}><Notice>{error}</Notice></div>}

      {visible.length === 0 ? (
        <div className="kds-empty">
          <div>
            <h2>Nothing waiting</h2>
            <p>New orders appear here and sound an alarm.</p>
          </div>
        </div>
      ) : (
        <div className="ticket-grid">
          {visible.map((order) => (
            <Ticket
              key={order.$id}
              order={order}
              items={items[order.$id] ?? []}
              sla={sla}
              onAccept={() => accept(order)}
              onStart={() => start(order)}
              onDone={() => done(order)}
              onReject={() => setRejecting(order)}
            />
          ))}
        </div>
      )}

      {rejecting && (
        <Modal
          title={`Reject order ${rejecting.order_no}`}
          onClose={() => setRejecting(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRejecting(null)}>Cancel</Button>
              <Button variant="danger" onClick={reject}>Reject order</Button>
            </>
          }
        >
          <p className="small dim" style={{ marginTop: 0 }}>
            The customer and the front of house both see this, so the reason matters.
          </p>
          <Field label="Reason">
            <Select value={rejectCode} onChange={(e) => setRejectCode(e.target.value)}>
              {REJECT_REASONS.map((r) => (
                <option key={r.code} value={r.code}>{r.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Note" hint="Optional, but useful when the reason is 'something else'.">
            <Textarea value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} />
          </Field>
        </Modal>
      )}
    </div>
  );
}

function Ticket({
  order, items, sla, onAccept, onStart, onDone, onReject,
}: {
  order: Order;
  items: OrderItem[];
  sla: number;
  onAccept: () => void;
  onStart: () => void;
  onDone: () => void;
  onReject: () => void;
}) {
  const age = secondsSince(order.$createdAt);
  const late = order.status === 'PENDING' && age > sla;
  const ageClass = age > sla * 2 ? 'bad' : age > sla ? 'warn' : '';

  return (
    <div className={`ticket ${order.status === 'PENDING' ? 'pending' : ''} ${late ? 'late' : ''}`}>
      <div className="ticket-head">
        <div>
          <div className="no">{order.order_no}</div>
          <div className="where">
            {order.table_id ? 'Table order' : order.fulfilment === 'delivery' ? 'Delivery' : 'Takeaway'}
            {order.guest_count > 1 && ` · ${order.guest_count} guests`}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className={`age ${ageClass}`}>{mmss(age)}</div>
          <div style={{ marginTop: '0.2rem' }}>
            {order.channel === 'qr' && <span className="pill qr">QR</span>}
            {order.is_preorder && <span className="pill preorder">Pre-order</span>}
          </div>
        </div>
      </div>

      <ul className="ticket-items">
        {items.length === 0 && <li className="dim">Loading items…</li>}
        {items.map((i) => {
          const addons: { name: string }[] = i.addons ? JSON.parse(i.addons) : [];
          return (
            <li key={i.$id}>
              <span className="qty">{i.qty}×</span>
              {i.name_snapshot}
              {addons.length > 0 && <div className="addons">{addons.map((a) => a.name).join(', ')}</div>}
              {i.notes && <div className="note">“{i.notes}”</div>}
            </li>
          );
        })}
      </ul>

      <div className="ticket-foot">
        {order.status === 'PENDING' && (
          <>
            <Button variant="ghost" onClick={onReject}>Reject</Button>
            <Button variant="primary" onClick={onAccept}>Accept</Button>
          </>
        )}
        {order.status === 'ACCEPTED' && <Button variant="primary" onClick={onStart}>Start cooking</Button>}
        {order.status === 'PREPARING' && <Button variant="primary" onClick={onDone}>Ready</Button>}
        {order.status === 'READY' && <Button disabled>Waiting for collection</Button>}
      </div>
    </div>
  );
}
