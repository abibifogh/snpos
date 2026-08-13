import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Spinner, Modal, Select, Textarea, Field, Notice, Logo, HelpModal, EightySixModal,
  OfflineBar, useOfflineQueue,
} from '@snpos/ui';
import { applyTheme } from '@snpos/ui';
import {
  db, DB_ID, Query, listAll, loadOpenOrders, subscribeCollection, isCreate,
  verifyPin, loadFeatures, isEnabled, featureConfig, articlesFor, HELP_AREAS, formatMoney, requireStaff,
  loadMenu, markUnavailable, markAvailable, isUnavailable, displayOrderNo, settleOrderNumbers,
  itemsAvailableNow, dueMinutes,
  onQueueChange, startOfflineSync, flushQueue, loadWithFallback,
} from '@snpos/core';
import type {
  Order, OrderItem, Settings, Venue, StaffProfile, StaffSession, HelpRole, MenuItem, Doc, FeatureMap,
} from '@snpos/core';

interface Station extends Doc { venue_id: string; key: string; name: string; colour?: string; sort: number; active: boolean }
import { unlockAudio, setAlarm, stopAlarm, type AlarmKind } from './alarm';
import { CombinedBar, SettleModal } from './CombinedBar';



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
  // Read by the reconcile timer without making it depend on `items`, that
  // dependency would tear down and rebuild the timer every time a ticket
  // loaded, which is most of the reason a timer like this stops firing.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [stations, setStations] = useState<Station[]>([]);
  const [station, setStation] = useState<string>(() => localStorage.getItem('kds-station') || 'all');
  const [features, setFeatures] = useState<FeatureMap>({});
  // Who is at the screen. The device holds the session; the PIN says which
  // person is acting, so accepts and rejects have a name against them.
  const [who, setWho] = useState<StaffProfile | null>(null);
  const [session, setSession] = useState<StaffSession | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [offOpen, setOffOpen] = useState(false);
  const [offItems, setOffItems] = useState<MenuItem[]>([]);
  const [offBusy, setOffBusy] = useState<string | null>(null);
  const [settling, setSettling] = useState<Order | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  /**
   * Somebody is handing the screen over.
   *
   * Separate from `ready`, which is about starting service at all. The PIN pad
   * is the same pad either way, but a handover can be thought better of and
   * must be escapable: an accidental tap on a busy pass must not lock the
   * tickets away behind a PIN nobody standing there knows.
   */
  const [switching, setSwitching] = useState(false);
  const [pinEntry, setPinEntry] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<Order | null>(null);
  const [rejectCode, setRejectCode] = useState(REJECT_REASONS[0].code);
  const [rejectNote, setRejectNote] = useState('');
  const [, forceTick] = useState(0);
  const queued = useOfflineQueue(onQueueChange, startOfflineSync);

  // Re-render once a second so the age counters climb without a subscription.
  useEffect(() => {
    const t = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  const loadItemsFor = useCallback(async (orderIds: string[]) => {
    if (orderIds.length === 0) return;
    const rows = await loadWithFallback(`items:${orderIds.slice(0, 100).join(',').slice(0, 120)}`, () =>
      listAll<OrderItem>('order_items', [Query.equal('order_id', orderIds.slice(0, 100))]),
    );
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
        // Not "is there a session?", a customer who scanned a table code has
        // one. This asks whether the session belongs to a member of staff, and
        // Appwrite answers it, not the browser.
        setSession(await requireStaff());
      } catch (e) {
        setError(
          e instanceof Error && e.name === 'NotStaffError'
            ? e.message
            : 'Sign in on this device first, from the terminal app.',
        );
        return;
      }
      try {
        // Every read that the screen cannot start without is remembered, so a
        // kitchen display reloaded during an outage comes back with tonight's
        // tickets rather than an error page.
        const s = await loadWithFallback('settings', async () =>
          (await db.getDocument(DB_ID, 'settings', 'main')) as unknown as Settings,
        );
        applyTheme(s);
        setSettings(s);
        const venues = await loadWithFallback('venues', () =>
          listAll<Venue>('venues', [Query.equal('active', true)]),
        );
        const v = venues[0];
        setVenue(v ?? null);
        if (!v) return;

        const [st, ft, sp] = await Promise.all([
          listAll<Station>('stations', [Query.equal('venue_id', v.$id)]),
          loadFeatures(v.$id),
          listAll<StaffProfile>('staff_profiles'),
        ]);
        setStations(st.filter((x) => x.active !== false).sort((a, b) => a.sort - b.sort));
        setFeatures(ft);
        setStaff(sp.filter((p) => p.active && p.pin_hash));
        // Pre-orders are loaded alongside the live ones. A kitchen that cannot
        // see what is booked cannot prepare for it, and the whole point of
        // taking an order in advance is that somebody can plan around it.
        const [open, booked] = await Promise.all([
          loadWithFallback(`open:${v.$id}`, () => loadOpenOrders(v.$id)),
          loadWithFallback(`booked:${v.$id}`, () =>
            listAll<Order>('orders', [Query.equal('venue_id', v.$id), Query.equal('status', 'SCHEDULED')])
              .then((rows) => rows.filter((o) => (o.module ?? 'kitchen') === 'kitchen')),
          ),
        ]);
        setOrders([...open, ...booked]);
        await loadItemsFor([...open, ...booked].map((o) => o.$id));

        // Heal any order still on a placeholder number. The server normally
        // settles these instantly; this is what saves the pass on the night it
        // does not. Silent, because a cook can do nothing about it either way.
        settleOrderNumbers(v.$id, s)
          .then((n) => {
            if (n > 0) void loadOpenOrders(v.$id).then((fresh) => setOrders((prev) => [
              ...fresh,
              ...prev.filter((o) => o.status === 'SCHEDULED' && !fresh.some((f) => f.$id === o.$id)),
            ]));
          })
          .catch(() => undefined);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load orders.');
      }
    })();
  }, [loadItemsFor]);

  /**
   * Keep settings current while the screen stays open.
   *
   * A kitchen display is opened once and left running for weeks. Without this,
   * an admin switching something off, tips, say, has no effect until somebody
   * thinks to reload a screen nobody ever touches.
   */
  useEffect(() => {
    const t = window.setInterval(() => {
      void db
        .getDocument(DB_ID, 'settings', 'main')
        .then((s2) => setSettings(s2 as unknown as Settings))
        .catch(() => undefined);
    }, 120_000);
    return () => window.clearInterval(t);
  }, []);

  // Live updates. Without this the kitchen is a page someone has to refresh.
  useEffect(() => {
    if (!venue) return;
    const off = subscribeCollection<Order>('orders', (order, events) => {
      if (order.venue_id !== venue.$id) return;
      setOrders((prev) => {
        // A craft counter sale is somebody else's business. Checked here as
        // well as in the initial load, because realtime bypasses that entirely.
        const mine = (order.module ?? 'kitchen') === 'kitchen';
        const live = mine && ['SCHEDULED', 'PENDING', 'ACCEPTED', 'PREPARING', 'READY'].includes(order.status);
        const without = prev.filter((o) => o.$id !== order.$id);
        return live ? [...without, order].sort((a, b) => a.$createdAt.localeCompare(b.$createdAt)) : without;
      });
      if (isCreate(events) && (order.module ?? 'kitchen') === 'kitchen'
          && ['PENDING', 'SCHEDULED'].includes(order.status)) void loadItemsFor([order.$id]);
    });
    return off;
  }, [venue, loadItemsFor]);

  /**
   * A net under the live connection.
   *
   * The live socket drops without saying so, a wifi blip, a router restart, a
   * screen left running for a fortnight, and the page carries on looking
   * exactly as healthy as it did a minute ago. A cook has no way to tell the
   * difference between "no new orders" and "no new orders reaching me", and the
   * first they know of it is a customer asking about food that was ordered
   * twenty minutes ago. Somebody then reloads the page and everything appears.
   *
   * So the list is reconciled from the server on a slow timer regardless, and
   * again the moment the tab is looked at or the network comes back. It costs
   * one small read a minute and removes the only failure in this system that is
   * completely invisible while it is happening.
   */
  useEffect(() => {
    if (!venue) return;
    let alive = true;

    const reconcile = async () => {
      if (!alive || document.hidden) return;
      try {
        const [open, booked] = await Promise.all([
          loadOpenOrders(venue.$id),
          listAll<Order>('orders', [Query.equal('venue_id', venue.$id), Query.equal('status', 'SCHEDULED')])
            .then((rows) => rows.filter((o) => (o.module ?? 'kitchen') === 'kitchen')),
        ]);
        if (!alive) return;
        const fresh = [...open, ...booked];
        setOrders((prev) => {
          // Only touched when it actually differs, so a re-render every minute
          // does not restart animations or fight a cook mid-tap.
          const same =
            prev.length === fresh.length &&
            fresh.every((o) => prev.some((p) => p.$id === o.$id && p.status === o.status && p.$updatedAt === o.$updatedAt));
          return same ? prev : fresh;
        });
        const missing = fresh.filter((o) => !itemsRef.current[o.$id]).map((o) => o.$id);
        if (missing.length) void loadItemsFor(missing);
      } catch {
        // Offline, most likely. The next tick tries again.
      }
    };

    const timer = window.setInterval(reconcile, 60_000);
    const wake = () => void reconcile();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
    };
  }, [venue, loadItemsFor]);

  /**
   * Booked for later, not yet cooking.
   *
   * Shown as a quiet strip rather than as tickets: they must not sound the
   * alarm or crowd the pass, but a cook glancing at the screen at four o'clock
   * should already know about the party at seven.
   */
  const scheduled = useMemo(
    () =>
      orders
        .filter((o) => o.status === 'SCHEDULED')
        .sort((a, b) => (a.fire_at ?? '').localeCompare(b.fire_at ?? '')),
    [orders],
  );

  const visible = useMemo(
    () =>
      orders
        .filter((o) => ['PENDING', 'ACCEPTED', 'PREPARING', 'READY'].includes(o.status))
        .filter((o) => {
          // With the tab strip hidden there is no way back to "all", so a
          // station saved on this device from before must not silently hide
          // every ticket.
          if (station === 'all' || stations.length < 2) return true;
          return (items[o.$id] ?? []).some((i) => (i.station_key || i.station) === station);
        }),
    [orders, station, items, stations],
  );

  const pending = visible.filter((o) => o.status === 'PENDING');

  /**
   * Orders that should have been out by now.
   *
   * This is a different question from the acknowledgement alarm. That one asks
   * "has anybody SEEN this?"; this asks "should this have left the pass?", an
   * order can be accepted promptly and still be forgotten on the shelf.
   */
  const overdueOn = isEnabled(features, 'overdue_alerts');
  const graceMinutes = featureConfig(features, 'overdue_alerts', 'grace_minutes', 5);

  /**
   * A coarse clock, and the reason this list works at all.
   *
   * Being late is a fact about the time, not about the orders, and the orders
   * were the only thing this was memoised on. So the clock inside it froze at
   * whatever moment a ticket last arrived: an order could sail past its time
   * with nothing else happening and never appear here, never show the Late
   * pill, never ring. The alarm only went off if some *other* order turned up
   * and knocked the list loose, which is precisely when it was least needed.
   *
   * Ten-second granularity: often enough that nobody notices the delay, coarse
   * enough that the list is not rebuilt on every one of the ticks that drive
   * the age counters.
   */
  const nowSlice = Math.floor(Date.now() / 10_000);

  /**
   * How long the kitchen had to cook this, in minutes.
   *
   * The prep time set on each dish, added up, not the estimate the customer
   * was given. Those two used to be the same number and are not any more: the
   * customer's wait now includes queueing behind the tickets already on the
   * pass, which is time before a cook touches this one. Judging the kitchen by
   * it would quietly hand them the whole queue as extra minutes on exactly the
   * night when being late matters most.
   *
   * dueMinutes lives in core so the pill on the ticket, the count in the
   * header and the alarm all read one rule. They did already, but only because
   * they happened to call the same local function; a rule worth getting right
   * belongs somewhere a second screen cannot quietly disagree with.
   */
  const promisedMinutes = useCallback((o: Order) => dueMinutes(o, items[o.$id] ?? []), [items]);

  const overdue = useMemo(() => {
    if (!overdueOn) return [];
    void nowSlice; // the clock this depends on
    const now = Date.now();
    const grace = graceMinutes * 60_000;

    return visible.filter((o) => {
      // Two different late moments, both worth a noise.
      //
      // Still cooking, past the time the customer was given. Measured from
      // when the kitchen took it, not from when it was placed, an order that
      // sat unacknowledged for ten minutes is a different failure, and the
      // acknowledgement alarm has already been shouting about that one.
      if (['ACCEPTED', 'PREPARING'].includes(o.status)) {
        const started = new Date(o.accepted_at || o.$createdAt).getTime();
        return now > started + promisedMinutes(o) * 60_000 + grace;
      }

      // Ready, and still sitting there. Food going cold on the pass is the
      // quietest failure in a kitchen: the screen says done, the cook has moved
      // on, and the only person who knows is the customer who is still waiting.
      if (o.status === 'READY') {
        const since = new Date(o.$updatedAt).getTime();
        return now > since + grace;
      }

      return false;
    });
  }, [visible, overdueOn, graceMinutes, promisedMinutes, nowSlice]);

  /**
   * Escalation is driven by the oldest unacknowledged ticket, not by each one
   * separately; three quiet alarms are less useful than one loud one.
   */
  const combined = isEnabled(features, 'combined_mode');
  const sla = settings?.kitchen_ack_sla_seconds ?? 60;

  /**
   * One alarm, and which of the two sounds it should be.
   *
   * A late order and a new order need telling apart from the other side of a
   * kitchen, so they get different sounds rather than different volumes of the
   * same one. Late wins when both are true: an order already cooking and now
   * overdue is the more expensive mistake.
   */
  const alarm = useMemo<{ level: number; kind: AlarmKind }>(() => {
    if (!ready) return { level: 0, kind: 'new' };
    const maxLevel = settings?.kitchen_ping_max_level ?? 4;
    let level = 0;
    if (pending.length > 0) {
      const oldest = Math.max(...pending.map((o) => secondsSince(o.$createdAt)));
      level = Math.min(Math.floor(oldest / sla) + 1, maxLevel);
    }
    if (overdue.length > 0) return { level: Math.max(level, 2), kind: 'late' };
    return { level, kind: 'new' };
  }, [pending, overdue, ready, sla, settings]);

  const lastAlarm = useRef({ level: 0, kind: 'new' as AlarmKind });
  useEffect(() => {
    if (alarm.level !== lastAlarm.current.level || alarm.kind !== lastAlarm.current.kind) {
      lastAlarm.current = alarm;
      setAlarm(alarm.level, alarm.kind);
    }
    return () => {
      if (alarm.level === 0) stopAlarm();
    };
  }, [alarm]);

  // Typed rather than Record<string, unknown>: a field the Order type does not
  // have is then a build error here instead of a rejection at the pass.
  const patch = async (order: Order, body: Partial<Order>) => {
    // Optimistic: a cook who taps Accept must see it accepted immediately, or
    // they tap again.
    setOrders((prev) => prev.map((o) => (o.$id === order.$id ? { ...o, ...body } : o)));
    try {
      await db.updateDocument(DB_ID, 'orders', order.$id, body);
    } catch (e) {
      setOrders((prev) => prev.map((o) => (o.$id === order.$id ? order : o)));
      setError(e instanceof Error ? e.message : 'Could not update that order.');
    }
  };

  const accept = (o: Order) =>
    patch(o, {
      status: 'ACCEPTED',
      accepted_at: new Date().toISOString(),
      accepted_by: who?.$id ?? '',
      alert_level: 0,
    });
  const start = (o: Order) => patch(o, { status: 'PREPARING' });
  const done = (o: Order) => patch(o, { status: 'READY' });

  /**
   * The food has left the pass.
   *
   * Separate from payment on purpose: a table order is collected long before
   * the bill is settled, and conflating the two would make one of them a lie.
   */
  const collect = (o: Order) =>
    patch(o, { status: 'SERVED', served_at: new Date().toISOString() });

  /** Release a booked order to the pass now, ahead of its time. */
  const fireNow = (o: Order) =>
    patch(o, { status: 'PENDING', fired_at: new Date().toISOString() });

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
      {(!ready || switching) && (
        <div className="audio-gate">
          <div style={{ maxWidth: '22rem' }}>
            <h1>{switching ? 'Who is taking over?' : 'Kitchen display'}</h1>
            {staff.length > 0 ? (
              <>
                <p className="dim" style={{ marginTop: '0.6rem' }}>
                  {switching
                    ? `${who?.display_name ?? 'Somebody'} is on this screen now. Enter your PIN to take over; `
                      + 'everything accepted from then on is recorded against you.'
                    : 'Enter your PIN to start. Tapping also lets the alarm sound, browsers keep a page silent '
                      + 'until someone touches it.'}
                </p>
                <div
                  style={{
                    fontSize: '1.8rem', letterSpacing: '0.5rem', margin: '1rem 0',
                    minHeight: '2.2rem', fontFamily: 'monospace',
                  }}
                >
                  {'•'.repeat(pinEntry.length)}
                </div>
                {pinError && <div style={{ color: '#ff6b5e', fontSize: '0.9rem' }}>{pinError}</div>}
                <div className="pin-pad">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'ok'].map((k) => (
                    <button
                      key={k}
                      onClick={async () => {
                        unlockAudio();
                        setPinError(null);
                        if (k === 'clear') return setPinEntry('');
                        if (k !== 'ok') return setPinEntry((p) => (p.length < 6 ? p + k : p));

                        for (const person of staff) {
                          if (await verifyPin(pinEntry, person.pin_hash)) {
                            setWho(person);
                            setPinEntry('');
                            setSwitching(false);
                            setReady(true);
                            return;
                          }
                        }
                        setPinError('PIN not recognised.');
                        setPinEntry('');
                      }}
                    >
                      {k === 'clear' ? '✕' : k === 'ok' ? '→' : k}
                    </button>
                  ))}
                </div>
                {/* Only during a handover. At the start of service there is
                    nothing to go back to, and a way out of the first gate
                    would be a way to cook anonymously. */}
                {switching && (
                  <Button
                    className="btn"
                    style={{ marginTop: '0.9rem' }}
                    onClick={() => { setSwitching(false); setPinEntry(''); setPinError(null); }}
                  >
                    Cancel, {who?.display_name ?? 'stay signed in'} carries on
                  </Button>
                )}
              </>
            ) : (
              <>
                {/* Nobody has a PIN yet. The device is signed in as staff, so
                    work goes against that account rather than against nobody, 
                    every Accept still has a name on it. */}
                <p className="dim" style={{ marginTop: '0.6rem' }}>
                  No cook has a PIN yet, so everything done here will be recorded against{' '}
                  <strong>{session?.name || session?.email || 'this account'}</strong>.
                </p>
                <p className="dim small">
                  Give your cooks PINs in the admin app under Staff, and they can identify themselves here by name
                  instead, which is the only way to tell who accepted what.
                </p>
                <Button variant="primary" className="btn" onClick={() => { unlockAudio(); setReady(true); }}>
                  Start service as {session?.name || 'this account'}
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {offOpen && venue && (
        <EightySixModal
          items={offItems.map((i) => ({
            $id: i.$id,
            name: i.name,
            off: isUnavailable(i),
            offSince: i.unavailable_since,
            reason: i.unavailable_reason,
          }))}
          requireReason={featureConfig(features, 'item_availability', 'require_reason', false)}
          busyId={offBusy}
          onClose={() => setOffOpen(false)}
          onMarkOff={async (i, reason) => {
            setOffBusy(i.$id);
            try {
              await markUnavailable({
                venueId: venue.$id,
                item: { $id: i.$id, name: i.name },
                userId: who?.user_id || who?.$id,
                userName: who?.display_name,
                reason,
              });
              const m = await loadMenu(venue.$id);
              setOffItems(itemsAvailableNow(m, 'kitchen'));
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Could not take that off the menu.');
            } finally {
              setOffBusy(null);
            }
          }}
          onRestore={async (i) => {
            setOffBusy(i.$id);
            try {
              await markAvailable({ item: { $id: i.$id }, userId: who?.user_id || who?.$id });
              const m = await loadMenu(venue.$id);
              setOffItems(itemsAvailableNow(m, 'kitchen'));
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Could not put that back.');
            } finally {
              setOffBusy(null);
            }
          }}
        />
      )}

      {helpOpen && (
        <HelpModal
          articles={articlesFor(
            (who?.role ?? 'cook') as HelpRole,
            featureConfig<Record<string, string[]>>(features, 'help', 'audiences', {}),
          )}
          areas={HELP_AREAS}
          title="How this works"
          onClose={() => setHelpOpen(false)}
        />
      )}

      {/* Loud on purpose. Offline support nobody notices is how a service ends
          up sitting on one iPad that never got put back on the wifi. */}
      <OfflineBar queued={queued} onRetry={() => void flushQueue()} />

      <div className="kds-top">
        <div className="row">
          <Logo size={28} />
          <h1>{venue.name}</h1>
        </div>
        {/* Only worth showing when there is a choice to make. With one station,
            "All" and that station are the same list of tickets, and a tab bar
            that never changes anything is just something else on the screen.

            Not rendered, rather than rendered and hidden. The `hidden`
            attribute only sets display:none in the browser's own stylesheet,
            and .station-tabs sets display:flex, which is an author rule and
            therefore wins. The bar has been on screen this whole time. */}
        {stations.length >= 2 && (
        <div className="station-tabs">
          {['all', ...stations.map((s) => s.key)].map((key) => {
            const st = stations.find((x) => x.key === key);
            return (
              <button
                key={key}
                className={station === key ? 'on' : ''}
                style={st?.colour && station === key ? { background: st.colour, borderColor: st.colour } : undefined}
                onClick={() => {
                  setStation(key);
                  localStorage.setItem('kds-station', key);
                }}
              >
                {key === 'all' ? 'All' : st?.name ?? key}
              </button>
            );
          })}
        </div>
        )}
        <div className="kds-stats">
          {isEnabled(features, 'item_availability') && (
            <button
              className="kds-help kds-86"
              title="Mark a dish as run out"
              onClick={async () => {
                const m = await loadMenu(venue?.$id ?? '');
                setOffItems(itemsAvailableNow(m, 'kitchen'));
                setOffOpen(true);
              }}
            >
              86
            </button>
          )}
          {isEnabled(features, 'help') && (
            <button className="kds-help" onClick={() => setHelpOpen(true)} title="How this works">?</button>
          )}
          <span>New <b>{pending.length}</b></span>
          <span>Cooking <b>{visible.filter((o) => o.status === 'PREPARING').length}</b></span>
          <span>Ready <b>{visible.filter((o) => o.status === 'READY').length}</b></span>
          {overdue.length > 0 && <span style={{ color: '#ff6b5e' }}>Late <b>{overdue.length}</b></span>}
          {/* The name was here already, saying who is answerable for what
              gets accepted. It is now also the way to change that: a cook
              going home had no way to hand the screen over except reloading
              the page, so whatever the next person did was recorded against
              the person who had left. */}
          {who && (
            <button
              className="kds-help"
              style={{ width: 'auto', padding: '0 0.7rem' }}
              title="Hand this screen to somebody else"
              onClick={() => { setSwitching(true); setPinEntry(''); setPinError(null); }}
            >
              {who.display_name} · hand over
            </button>
          )}
        </div>
      </div>

      {combined && venue && settings && (
        <CombinedBar
          venue={venue}
          settings={settings}
          features={features}
          who={who}
          onToast={(m) => { setToast(m); window.setTimeout(() => setToast(null), 4000); }}
        />
      )}

      {error && <div style={{ padding: '0.6rem 1rem' }}><Notice>{error}</Notice></div>}
      {toast && <div style={{ padding: '0.6rem 1rem' }}><Notice tone="ok">{toast}</Notice></div>}

      {scheduled.length > 0 && (
        <div className="kds-coming">
          <span className="kds-coming-label">Booked for later</span>
          {scheduled.map((o) => (
            <button key={o.$id} className="kds-coming-item" onClick={() => fireNow(o)} title="Send to the pass now">
              <b>{o.fire_at ? new Date(o.fire_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'no time'}</b>
              <span>{displayOrderNo(o.order_no)}</span>
              <span className="dim">{(items[o.$id] ?? []).reduce((a, i) => a + i.qty, 0) || '·'} items</span>
              <span className="kds-coming-go">Cook now</span>
            </button>
          ))}
        </div>
      )}

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
              items={items[order.$id]}
              sla={sla}
              overdue={overdue.some((o) => o.$id === order.$id)}
              cookMinutes={promisedMinutes(order)}
              settings={settings}
              canSettle={combined && (who?.can_mark_paid ?? false)}
              onAccept={() => accept(order)}
              onStart={() => start(order)}
              onDone={() => done(order)}
              onCollect={() => collect(order)}
              onSettle={() => setSettling(order)}
              onReject={() => setRejecting(order)}
            />
          ))}
        </div>
      )}

      {settling && venue && settings && (
        <SettleModal
          order={settling}
          venueId={venue.$id}
          settings={settings}
          who={who}
          onClose={() => setSettling(null)}
          onDone={(m) => {
            setSettling(null);
            setOrders((prev) => prev.filter((o) => o.$id !== settling.$id));
            setToast(m);
            window.setTimeout(() => setToast(null), 4000);
          }}
        />
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
  order, items, sla, overdue, cookMinutes,
  settings, canSettle, onAccept, onStart, onDone, onCollect, onSettle, onReject,
}: {
  order: Order;
  /** Undefined until the lines have arrived. Empty means there are none. */
  items: OrderItem[] | undefined;
  sla: number;
  overdue: boolean;
  /** The cooking time this ticket is judged against, the same figure the alarm uses. */
  cookMinutes: number;
  settings: Settings | null;
  /** Combined mode, and this person is allowed to take money. */
  canSettle: boolean;
  onAccept: () => void;
  onStart: () => void;
  onDone: () => void;
  onCollect: () => void;
  onSettle: () => void;
  onReject: () => void;
}) {
  const age = secondsSince(order.$createdAt);
  const late = (order.status === 'PENDING' && age > sla) || overdue;
  const ageClass = age > sla * 2 ? 'bad' : age > sla ? 'warn' : '';

  /**
   * The same sum the alarm does, shown on the ticket.
   *
   * The clock in the corner counts from when the order was PLACED, and lateness
   * is judged from when the kitchen ACCEPTED it. Those differ by however long
   * the ticket sat unacknowledged, so a cook could read 18:32 on a
   * fifteen-minute dish, expect the alarm, and not get it, which teaches
   * people the alarm is unreliable when it is doing exactly what it was told.
   *
   * This says what it is actually counting, in whole minutes, so the ping never
   * arrives as a surprise. The grace period is included: what is shown here is
   * precisely the moment it will ring.
   */
  const cooking = order.status === 'ACCEPTED' || order.status === 'PREPARING';
  const cookedFor = secondsSince(order.accepted_at || order.$createdAt);
  /**
   * Counting down to the dish's own time, not to the moment the alarm rings.
   *
   * The grace period used to be folded in here, so a twenty minute dish said
   * "23 min left" two minutes after it was accepted. Read beside "20 min dish"
   * on the same line, that says the system has quietly handed every order five
   * extra minutes, and a cook working to the bigger number is five minutes
   * later than the customer was told.
   *
   * The grace is still there and still decides when the ping happens. It is
   * tolerance for the alarm, not cooking time, and it belongs to the alarm.
   * What a cook now sees is the promise: twenty minutes counting down, "due
   * now", then "1 min over", "2 min over". The ring at five is no longer a
   * surprise, it is the end of a count they have been watching.
   */
  const leftMinutes = Math.round(cookMinutes - cookedFor / 60);

  return (
    <div className={`ticket ${order.status === 'PENDING' ? 'pending' : ''} ${late ? 'late' : ''}`}>
      <div className="ticket-head">
        <div>
          <div className="no">{displayOrderNo(order.order_no)}</div>
          <div className="where">
            {order.table_id ? 'Table order' : order.fulfilment === 'delivery' ? 'Delivery' : 'Takeaway'}
            {order.guest_count > 1 && ` · ${order.guest_count} guests`}
          </div>
          {/* An area has no number, so where in it they are sitting is the
              only thing that gets the food to the right people. */}
          {order.seat_note && <div className="where" style={{ color: 'var(--warn)' }}>{order.seat_note}</div>}
          {order.is_group && (
            <div className="where">
              <span className="pill">Group{order.group_size ? ` · ${order.group_size}` : ''}</span>
              {order.group_reference && ` ${order.group_reference}`}
            </div>
          )}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className={`age ${ageClass}`}>{mmss(age)}</div>
          {cooking && (
            <div className="due" style={leftMinutes < 0 ? { color: '#ff9b90' } : undefined}>
              {leftMinutes < 0
                ? `${Math.abs(leftMinutes)} min over`
                : leftMinutes === 0
                  ? 'due now'
                  : `${leftMinutes} min left`}
              <span className="dim"> · {cookMinutes} min dish</span>
            </div>
          )}
          <div style={{ marginTop: '0.2rem' }}>
            {order.channel === 'qr' && <span className="pill qr">QR</span>}
            {order.is_preorder && <span className="pill preorder">Pre-order</span>}
            {overdue && <span className="pill" style={{ background: '#3a1714', color: '#ff9b90' }}>Late</span>}
          </div>
        </div>
      </div>

      <ul className="ticket-items">
        {/* Three different things, and they were one message. Undefined is a
            list that has not arrived; empty is one that has, and is empty,
            which means somebody sent a ticket with nothing on it. Saying
            "loading" for the second leaves a cook waiting for a list that is
            never coming. */}
        {items === undefined && <li className="dim">Loading items…</li>}
        {items !== undefined && items.length === 0 && (
          <li style={{ color: 'var(--warn)' }}>
            Nothing is listed on this ticket. Check with whoever sent it before cooking.
          </li>
        )}
        {(items ?? []).map((i) => {
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
        {order.status === 'READY' && (
          <>
            {/* Food does not leave the pass before it is paid for. An order
                marked collected while still owing is money nobody can chase:
                the customer has gone and the shift balances as if nothing
                happened. */}
            {order.payment_status === 'paid' ? (
              <>
                <span className="pill">Paid</span>
                <Button variant="primary" onClick={onCollect}>Collected</Button>
              </>
            ) : canSettle ? (
              <Button variant="primary" onClick={onSettle}>
                Collect &amp; take payment{settings ? ` · ${formatMoney(order.total, settings)}` : ''}
              </Button>
            ) : (
              <span className="small" style={{ opacity: 0.75 }}>
                Waiting for payment{settings ? ` · ${formatMoney(order.total, settings)}` : ''}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
