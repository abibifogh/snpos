import { useEffect, useState } from 'react';
import { Button, Spinner } from '@snpos/ui';
import {
  db, DB_ID, Query, listAll, formatMoney, subscribeCollection, isProvisionalOrderNo,
  cancelWindowLeft, requestCancellation, humanError, quotedWait, formatWait,
} from '@snpos/core';
import type { Order, OrderItem, Settings, Venue } from '@snpos/core';
import { rememberOrder } from './myOrders';

/**
 * Where a customer's order has got to.
 *
 * The page a guest leaves open on the table. Without it the only honest answer
 * to "is my food coming?" is to find a member of staff and ask them to find a
 * cook, which is two people's time for a question the system already knows the
 * answer to.
 *
 * Live rather than polled, the same subscription the kitchen uses, so it
 * changes the moment a cook taps a button. It falls back to a slow refresh if
 * the live connection cannot be made, because a page that quietly stops
 * updating is worse than one that updates late.
 */

interface Step {
  key: string;
  label: string;
  says: string;
}

/**
 * Deliberately four steps, not nine.
 *
 * A guest does not want the kitchen's workflow, they want to know whether to
 * keep waiting. Rejected and cancelled are handled separately below because
 * they are not a stage of progress, they are the end of it.
 */
const STEPS: Step[] = [
  { key: 'PENDING', label: 'Sent', says: 'Your order has gone through to the kitchen.' },
  { key: 'ACCEPTED', label: 'Accepted', says: 'The kitchen has your order and will start shortly.' },
  { key: 'PREPARING', label: 'Cooking', says: 'Your food is being cooked.' },
  { key: 'READY', label: 'Ready', says: "It's ready, someone is bringing it over." },
];

const REACHED: Record<string, number> = {
  SCHEDULED: 0, PENDING: 0, ACCEPTED: 1, PREPARING: 2, READY: 3, SERVED: 4, CLOSED: 4,
};

export function OrderStatus({
  orderId,
  settings,
  venue,
  onBack,
}: {
  orderId: string;
  settings: Settings;
  venue: Venue | null;
  onBack: () => void;
}) {
  const [order, setOrder] = useState<Order | null>(null);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [gone, setGone] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelNote, setCancelNote] = useState<string | null>(null);
  /**
   * A coarse clock, so the countdown runs and the button disappears on its own.
   *
   * Ticking every second rather than every hundred milliseconds: this drives a
   * number counting down in whole seconds, and re-rendering ten times for each
   * one it shows is work nobody can see on a phone that is holding the screen
   * awake anyway.
   */
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;

    const read = async () => {
      const fresh = await db.getDocument(DB_ID, 'orders', orderId).catch(() => null);
      if (!alive) return;
      if (!fresh) { setGone(true); return; }
      const live = fresh as unknown as Order;
      setOrder(live);
      // Keep the saved copy's number in step. A guest order is placed with a
      // placeholder and numbered a moment later by the server, so the number
      // stored when it was sent is usually not the one they will be asked for.
      if (!isProvisionalOrderNo(live.order_no)) {
        rememberOrder({ id: live.$id, no: live.order_no, at: live.$createdAt, venueId: live.venue_id });
      }
    };

    void read().then(async () => {
      const lines = await listAll<OrderItem>('order_items', [Query.equal('order_id', orderId)]).catch(() => []);
      if (alive) setItems(lines);
    });

    // Live, with a slow poll behind it. Realtime over patchy mobile data drops
    // without saying so, and a status page frozen on "Cooking" for an hour is
    // how a guest decides the system is lying to them.
    const off = subscribeCollection<Order>('orders', (doc) => {
      if (doc.$id === orderId && alive) setOrder(doc);
    });
    const poll = window.setInterval(() => void read(), 20_000);

    return () => {
      alive = false;
      off();
      window.clearInterval(poll);
    };
  }, [orderId]);

  if (gone) {
    return (
      <div className="centered">
        <div>
          <h2>We can't find that order</h2>
          <p className="dim">Please ask a member of staff.</p>
          <Button style={{ marginTop: '1.2rem' }} onClick={onBack}>Back to the menu</Button>
        </div>
      </div>
    );
  }

  if (!order) {
    return <div className="centered"><Spinner /></div>;
  }

  const stopped = order.status === 'REJECTED' || order.status === 'CANCELLED';
  const at = REACHED[order.status] ?? 0;
  const done = at >= 4;

  /**
   * The window, and the two things that close it early.
   *
   * Offered only while the ticket is still untouched. Once a cook has taken it
   * the food may already be on, and a customer calling that back from a phone
   * is a kitchen finding out by reading a screen. The server refuses it in that
   * case too; this only avoids offering something that would be turned down.
   */
  const leftMs = cancelWindowLeft(order, tick);
  const canCancel =
    leftMs > 0 &&
    order.status === 'PENDING' &&
    !order.accepted_at &&
    order.payment_status !== 'paid' &&
    order.payment_status !== 'partial';
  const secondsLeft = Math.ceil(leftMs / 1000);

  const cancel = async () => {
    setCancelling(true);
    setCancelNote(null);
    try {
      await requestCancellation(order);
      // The server has the last word, and it arrives on the order itself: the
      // status flips to CANCELLED and the page above says so. Saying "asked"
      // rather than "cancelled" here is the honest description of what has
      // happened so far.
      setCancelNote('Asked to cancel, one moment.');
    } catch (e) {
      setCancelNote(humanError(e));
      setCancelling(false);
    }
  };

  return (
    <div className="status-page">
      <header className="menu-header">
        <h1 style={{ margin: 0 }}>
          {isProvisionalOrderNo(order.order_no) ? 'Your order' : `Order ${order.order_no}`}
        </h1>
        <div className="sub">{venue?.name ?? settings.restaurant_name}</div>
      </header>

      {stopped ? (
        <div className="banner banner-info">
          <strong>This order was {order.status === 'REJECTED' ? 'not accepted' : 'cancelled'}.</strong>{' '}
          {order.reject_reason_note || 'Please speak to a member of staff; you have not been charged.'}
        </div>
      ) : order.status === 'SCHEDULED' ? (
        <div className="banner banner-info">
          <strong>Booked for later.</strong>{' '}
          {order.scheduled_for
            ? `We'll start cooking in time for ${new Date(order.scheduled_for).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.`
            : 'We will start it in time for your slot.'}
        </div>
      ) : (
        <>
          {/* Said once, near the top, where somebody who has just pressed
              "send" is looking. A wait nobody has named is a wait that feels
              twice as long, and it is the question a guest otherwise gets up
              and asks a waiter. */}
          {quotedWait(order) && !done && (
            <div className="eta">
              <strong>About {formatWait(quotedWait(order) as number)}</strong>
              <div className="small dim">
                {/* Named, because it is the difference between a number that
                    looks wrong and one that makes sense. Ordering before the
                    kitchen opens means most of this wait is the doors, not
                    the cooking, and a customer told "about an hour and
                    twenty" with no reason assumes something is broken. */}
                {order.placed_while_closed
                  ? 'The kitchen was not open when you ordered, so this counts from when it opens. We will tell you the moment it is ready.'
                  : 'An estimate from what you ordered and how busy the kitchen is. We will tell you the moment it is ready.'}
              </div>
            </div>
          )}

          {/* Sat directly under the wait, because the two are read together:
              somebody who has just been told forty minutes is exactly the
              person deciding whether to keep this order. Gone the moment it
              expires, rather than left there greyed out, an offer that has
              run out reads as a broken button. */}
          {(canCancel || cancelNote) && (
            <div className="cancel-window">
              {cancelNote ? (
                <div className="small">{cancelNote}</div>
              ) : (
                <>
                  <Button onClick={cancel} loading={cancelling} disabled={cancelling}>
                    Cancel this order
                  </Button>
                  <div className="small dim">
                    You can call this back for another{' '}
                    {secondsLeft > 60
                      ? `${Math.ceil(secondsLeft / 60)} minutes`
                      : `${secondsLeft} second${secondsLeft === 1 ? '' : 's'}`}
                    . After that, please ask a member of staff.
                  </div>
                </>
              )}
            </div>
          )}
          <ol className="steps">
          {STEPS.map((step, i) => (
            <li key={step.key} className={i < at ? 'past' : i === at ? 'now' : ''}>
              <span className="dot" aria-hidden="true" />
              <div>
                <div className="label">{step.label}</div>
                {i === at && <div className="says">{step.says}</div>}
              </div>
            </li>
          ))}
          {done && (
            <li className="past">
              <span className="dot" aria-hidden="true" />
              <div><div className="label">With you</div></div>
            </li>
          )}
          </ol>
        </>
      )}

      <div className="status-card">
        <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Your order</h2>
        {items.map((i) => (
          <div className="line" key={i.$id}>
            <span>{i.qty}× {i.name_snapshot}</span>
            <span>{formatMoney(i.line_total, settings)}</span>
          </div>
        ))}
        <div className="line" style={{ fontWeight: 650, borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}>
          <span>Total</span>
          <span>{formatMoney(order.total, settings)}</span>
        </div>
        <p className="small dim" style={{ marginBottom: 0 }}>
          {order.payment_status === 'paid'
            ? 'Paid, thank you.'
            : 'Pay a member of staff when you are done. There is no payment in this app.'}
        </p>
      </div>

      {/* The one thing a guest is most likely to want next, and it was a
          plain grey button below a line of small print, which reads as the way
          out of the page rather than the way to order a second round. Wanting
          another drink is the commonest thing that happens after food arrives,
          and it was the least visible thing on the screen. */}
      <div style={{ textAlign: 'center', marginTop: '1.4rem' }}>
        <Button variant="primary" onClick={onBack} style={{ width: '100%', padding: '0.95rem' }}>
          Order something else
        </Button>
        <p className="small dim" style={{ marginTop: '0.6rem' }}>
          {/* Careful with this sentence: ordering again makes a SECOND order,
              it is not added to this one, and a walk-in has no table to add it
              to either. Both of those would be untrue promises about where
              somebody's food is going. */}
          Anything else comes through as its own order. This page keeps updating by itself, so you can leave it
          open.
        </p>
      </div>
    </div>
  );
}
