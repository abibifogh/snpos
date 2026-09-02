import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Spinner, Modal, Select, Textarea, Field, Notice, Logo, HelpModal, EightySixModal,
  OfflineBar, useOfflineQueue, IdleScreen, ThemeButton,
} from '@snpos/ui';
import { applyTheme } from '@snpos/ui';
import {
  db, DB_ID, Query, listAll, listByIds, loadOpenOrders, subscribeCollection, isCreate,
  verifyPin, loadFeatures, isEnabled, featureConfig, articlesFor, HELP_AREAS, formatMoney, requireStaff,
  loadMenu, markUnavailable, markAvailable, isUnavailable, displayOrderNo, settleOrderNumbers,
  itemsAvailableNow, dueMinutes, ticketLines, linesComplete, isOverdue, minutesOver, seatFor, amountOutstanding,
  onQueueChange, startOfflineSync, flushQueue, loadWithFallback, addonNames, addonsUnreadable,
  formatWait, giveTheMoneyBack, wakesScreen, latestMovement,
  billsToSettle, settleableTotal, billsToSettleLabel,
} from '@snpos/core';
import type {
  Order, OrderItem, Settings, Venue, StaffProfile, StaffSession, HelpRole, MenuItem, Doc, FeatureMap,
} from '@snpos/core';

interface Station extends Doc { venue_id: string; key: string; name: string; colour?: string; sort: number; active: boolean }

/**
 * A table, or a whole area with no table numbers in it.
 *
 * Here only so a ticket can print the answer to "where are you sitting?". An
 * order stores the id it was given, and an id is no use to somebody carrying
 * a plate.
 */
interface TableRow extends Doc { venue_id: string; label: string; zone?: string; kind?: 'table' | 'area' }

import { unlockAudio, setAlarm, stopAlarm, audioReady, type AlarmKind } from './alarm';
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
  /**
   * Bumped whenever an order lands, so the clock gets out of the way.
   *
   * The kitchen is where this matters most: a ticket appearing behind a
   * screensaver is a ticket nobody cooks until somebody walks past.
   */
  const [wakeSignal, setWakeSignal] = useState(0);
  /**
   * The latest moment any of our orders moved, as far as this screen knows.
   *
   * Only for the polling path — the live connection is told what changed, and
   * a poll has to work it out. A ref rather than state: it is a bookmark, and
   * nothing on screen reads it.
   */
  const seenUpTo = useRef('');
  const [items, setItems] = useState<Record<string, OrderItem[]>>({});
  // Read by the reconcile timer without making it depend on `items`, that
  // dependency would tear down and rebuild the timer every time a ticket
  // loaded, which is most of the reason a timer like this stops firing.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [stations, setStations] = useState<Station[]>([]);
  // Tables by id, so a ticket can say where the food is going.
  const [seating, setSeating] = useState<Record<string, TableRow>>({});
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
    /*
      The whole list in the key, and the whole list in the query.

      The key used to be cut at 120 characters — about six ids — so two
      different batches of tickets shared one slot in the offline cache, and
      on a dead network the second could be handed the first one's lines. The
      query used to stop at a hundred ids with nothing chunking it; listByIds
      splits at the limit the database actually has.
    */
    const ids = [...new Set(orderIds)].sort();
    const rows = await loadWithFallback(`items:${ids.join(',')}`, () =>
      listByIds<OrderItem>('order_items', 'order_id', ids),
    );
    /**
     * Only what was actually found is recorded.
     *
     * Every requested id used to be stamped with an empty list before the rows
     * were filled in, which made "we asked and there were none" indistinguish-
     * able from "we have not asked yet". That mattered because the kitchen is
     * told about an order the instant it exists, which is BEFORE its lines
     * finish being written: the fetch found nothing, wrote an empty list, and
     * the reconciler then skipped that order for ever because it had an answer
     * on file. The ticket stayed blank until somebody reloaded the page.
     *
     * Left undefined, an order with no rows yet is simply still unanswered, so
     * the reconciler picks it up again a minute later and the retry below
     * usually beats it to it.
     */
    setItems((prev) => {
      if (rows.length === 0) return prev;
      const next = { ...prev };
      for (const id of orderIds) if (rows.some((r) => r.order_id === id)) next[id] = [];
      for (const r of rows) (next[r.order_id] ??= []).push(r);
      return next;
    });
  }, []);

  /**
   * Ask again shortly, for the lines that had not been written yet.
   *
   * The gap is normally under a second. Waiting a whole minute for the
   * reconciler would leave a cook looking at a ticket with nothing on it for
   * most of the time the customer is waiting.
   */
  const loadItemsSoon = useCallback(
    async (order: Order) => {
      for (const wait of [0, 700, 2000, 5000]) {
        if (wait) await new Promise((r) => setTimeout(r, wait));
        await loadItemsFor([order.$id]).catch(() => undefined);
        /**
         * Whole, not merely non-empty.
         *
         * This stopped as soon as it had found ANY line. The lines are written
         * together but land one by one, so a first read that caught one of
         * three ended the retries there — and the reconciler then skipped the
         * order for ever, because it had an answer on file. The ticket showed
         * two dishes out of three and looked completely normal: the cook made
         * two, the customer was charged for three, and the only person who
         * found out was the one still waiting.
         */
        if (linesComplete(order, itemsRef.current[order.$id])) return;
      }
    },
    [loadItemsFor],
  );

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

        const [st, ft, sp, tb] = await Promise.all([
          listAll<Station>('stations', [Query.equal('venue_id', v.$id)]),
          loadFeatures(v.$id),
          listAll<StaffProfile>('staff_profiles'),
          // Read once and kept, because a ticket needs to name a table and an
          // order only stores its id. Tables change perhaps twice a year; the
          // list would be reloaded every night anyway when the screen is
          // switched on. Inactive ones are kept: an order placed at a table
          // that was retired an hour ago still has to be delivered to it.
          listAll<TableRow>('tables', [Query.equal('venue_id', v.$id)]).catch(() => [] as TableRow[]),
        ]);
        setSeating(Object.fromEntries(tb.map((t) => [t.$id, t])));
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
      /*
        Decided out here, not inside the updater below.

        It used to be worked out inside setOrders, which is a function React
        may call more than once and expects to have no effect on anything but
        the list it returns. Waking the screen from inside it made the one
        thing this screen exists for depend on an implementation detail of
        somebody else's library.
      */
      const live = wakesScreen(order, { module: 'kitchen', venueId: venue.$id });
      if (live) setWakeSignal((n) => n + 1);
      setOrders((prev) => {
        // A craft counter sale is somebody else's business. Checked here as
        // well as in the initial load, because realtime bypasses that entirely.
        const without = prev.filter((o) => o.$id !== order.$id);
        return live ? [...without, order].sort((a, b) => a.$createdAt.localeCompare(b.$createdAt)) : without;
      });
      if (isCreate(events) && (order.module ?? 'kitchen') === 'kitchen'
          && ['PENDING', 'SCHEDULED'].includes(order.status)) void loadItemsSoon(order);
    });
    return off;
  }, [venue, loadItemsSoon]);

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
        /*
          THE POLL WAKES THE SCREEN TOO.

          This loop exists because the live connection drops without saying so.
          For as long as only the live connection woke the clock, the one case
          this net was built to catch — orders arriving with nothing telling us
          — was also the one case where the ticket landed behind a screensaver
          and stayed there until somebody walked past and touched the glass.

          The high-water mark rather than a diff: one string comparison says
          whether anything moved since the last look, and a list that comes
          back in a different order does not read as news. See latestMovement.
        */
        const moved = latestMovement(fresh.filter((o) => wakesScreen(o, { module: 'kitchen' })));
        if (moved && moved > seenUpTo.current) {
          // Not on the first pass. Everything is new to a screen that has just
          // loaded, and waking for a list that was already there would mean a
          // reload could never settle into the clock at all.
          if (seenUpTo.current) setWakeSignal((n) => n + 1);
          seenUpTo.current = moved;
        }
        setOrders((prev) => {
          // Only touched when it actually differs, so a re-render every minute
          // does not restart animations or fight a cook mid-tap.
          const same =
            prev.length === fresh.length &&
            fresh.every((o) => prev.some((p) => p.$id === o.$id && p.status === o.status && p.$updatedAt === o.$updatedAt));
          return same ? prev : fresh;
        });
        // Not just the ones with nothing: the ones with SOME of their lines
        // too. A half-loaded ticket is the one that gets cooked wrongly,
        // because it is the one that looks finished.
        const missing = fresh
          .filter((o) => !linesComplete(o, itemsRef.current[o.$id]))
          .map((o) => o.$id);
        if (missing.length) void loadItemsFor(missing);
      } catch {
        // Offline, most likely. The next tick tries again.
      }
    };

    /*
      TWENTY SECONDS, not sixty.

      This is the safety net under the live connection, and how long it takes
      to notice is how late a ticket arrives on the nights the live connection
      is not working — which is the failure it exists for. A minute is a long
      time at a pass: an order placed by the pool can be a minute old before a
      cook has seen it, and by then the customer is already wondering.

      It costs one small read every twenty seconds, and nothing at all while
      the tab is hidden — see the guard at the top of reconcile.
    */
    const timer = window.setInterval(reconcile, 20_000);
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
   * Food that has gone out and has not been paid for.
   *
   * The board above stops at READY, so an order is off this screen for good
   * the moment somebody presses Collected — and an order that becomes unpaid
   * AFTERWARDS had nowhere left to appear. A payment recorded against the
   * wrong method and voided so it can be redone, a card declined after the
   * plates went out, a table served course by course and settling at the end:
   * in every one the money is real, owed, and invisible until the till is
   * counted.
   *
   * Deliberately NOT mixed into the lanes above. A cook reading the board
   * wants what is cooking, and a served ticket sitting among them is noise
   * that gets learnt and then ignored. See billsToSettle.
   *
   * Never filtered by station: money is not one station's business, and a
   * pass set to Cold would otherwise hide a bill nobody else is looking for.
   */
  const owing = useMemo(() => billsToSettle(orders), [orders]);

  /**
   * What is still owed on a part-paid order.
   *
   * Kept apart from the order itself because it is not on it: an order records
   * what the bill came to, and what has been taken against it is the payments,
   * added up. Storing a running balance on the order would be a second copy of
   * a figure that is already derivable, and the two would disagree the first
   * time a payment was voided.
   *
   * Read only for the handful of tickets that are part paid, and read again
   * whenever one of them changes, which is what happens when somebody pays a
   * little more. Everything else on this screen never asks.
   */
  const [owed, setOwed] = useState<Record<string, number>>({});
  const owedAsked = useRef<Record<string, string>>({});
  useEffect(() => {
    const part = orders.filter((o) => o.payment_status === 'partial');
    for (const o of part) {
      // Keyed by the order's own version, so a further payment re-asks and a
      // re-render does not.
      if (owedAsked.current[o.$id] === o.$updatedAt) continue;
      owedAsked.current[o.$id] = o.$updatedAt;
      void amountOutstanding(o)
        .then((left) => setOwed((prev) => (prev[o.$id] === left ? prev : { ...prev, [o.$id]: left })))
        // Left unknown rather than shown as zero. A ticket that says nothing is
        // owed when something is would send food out unpaid.
        .catch(() => undefined);
    }
  }, [orders]);

  /**
   * Orders that should have been out by now.
   *
   * This is a different question from the acknowledgement alarm. That one asks
   * "has anybody SEEN this?"; this asks "should this have left the pass?", an
   * order can be accepted promptly and still be forgotten on the shelf.
   */
  const overdueOn = isEnabled(features, 'overdue_alerts');

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

  /**
   * Which of these should have been out by now.
   *
   * The rule itself is in core, so the ticket's own countdown, this list, the
   * Late pill, the header count, the alarm and the queue on the till are all
   * one sentence rather than six that agree until one of them is edited.
   *
   * Measured from when the order was PLACED, not from when the kitchen took
   * it. The clock a customer is watching started when they pressed send, and
   * ten minutes spent waiting to be acknowledged is ten minutes of their wait
   * however it is filed.
   */
  const overdue = useMemo(() => {
    if (!overdueOn) return [];
    void nowSlice; // the clock this depends on
    const now = Date.now();
    return visible.filter((o) => isOverdue(o, promisedMinutes(o), now));
  }, [visible, overdueOn, promisedMinutes, nowSlice]);

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

  /**
   * Whether this screen can actually make a noise, checked rather than assumed.
   *
   * The audio is unlocked once, at the PIN gate, and a browser suspends it
   * again whenever the page is hidden: a tablet sleeping on a counter, a cook
   * switching to something else, a screen left overnight. Nothing noticed. The
   * alarm carried on being "set", oscillators carried on being created, and
   * not one sound came out.
   *
   * Rechecked on the same slow clock the late list uses, and whenever the
   * screen is looked at again, which is the moment it can be put right.
   */
  const [soundOk, setSoundOk] = useState(true);
  useEffect(() => {
    const check = () => setSoundOk(audioReady());
    check();
    const t = window.setInterval(check, 5_000);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);

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
    patch(o, {
      status: 'SERVED',
      served_at: new Date().toISOString(),
      /**
       * A bill that came to nothing is settled by being handed over.
       *
       * Nothing is owed and nothing ever will be, so leaving it marked unpaid
       * makes it look like money still to come — on the shift close, on the
       * reports, and to whoever is asked about it a week later. No payment is
       * recorded, because none happened; only the bill is closed.
       */
      ...((o.total ?? 0) <= 0 ? { payment_status: 'paid' as const } : {}),
    });

  /** Release a booked order to the pass now, ahead of its time. */
  const fireNow = (o: Order) =>
    patch(o, { status: 'PENDING', fired_at: new Date().toISOString() });

  const reject = async () => {
    if (!rejecting) return;
    if (settings?.require_reject_reason && !rejectCode) return;
    const turned = rejecting;
    await patch(turned, {
      status: 'REJECTED',
      rejected_at: new Date().toISOString(),
      reject_reason_code: rejectCode,
      reject_reason_note: rejectNote,
      alert_level: 0,
    });
    /*
      An order turned away at the pass keeps none of its money.

      Most are rejected before anybody has paid, and then this does nothing at
      all. The one that matters is the order paid for at the counter and then
      refused in the kitchen — out of an ingredient, too late in the night. The
      money is handed straight back over the counter, but the payment stayed on
      the shift, so the drawer was expected at midnight to hold cash that had
      already gone back to the customer, and the cashier was asked to explain
      a shortage the till itself had invented.
    */
    const back = await giveTheMoneyBack(turned, {
      reason: rejectNote || rejectCode || 'turned away at the pass',
      userId: who?.$id ?? '',
    }).catch(() => ({ givenBack: 0, payments: 0 }));
    if (back.payments > 0 && settings) {
      setError(
        `${formatMoney(back.givenBack, settings)} was already paid for ${displayOrderNo(turned.order_no)}. `
        + 'It has been taken back out of the shift, so the drawer is not expected to hold it. '
        + 'Hand it back to the customer.',
      );
    }
    setRejecting(null);
    setRejectNote('');
  };

  /**
   * Every ticket with nothing on it, turned away in one go.
   *
   * Seven arrived at once from phones by the pool, each with a price and no
   * dishes — see the note in createOrder about which write lands first. That
   * cause is fixed, but the tickets it left had to be rejected one at a time,
   * each with its own reason dialog, on a pass that had other things to do.
   *
   * Only tickets the screen has already decided are blank, which means the
   * grace period has passed and a retry has been made. A ticket that is still
   * loading is not blank, it is new.
   */
  const blank = visible.filter((o) => ticketLines(o, items[o.$id]) === 'missing');
  const rejectBlank = async () => {
    for (const o of blank) {
      await patch(o, {
        status: 'REJECTED',
        rejected_at: new Date().toISOString(),
        reject_reason_code: 'other',
        reject_reason_note: 'Nothing was listed on the ticket',
        alert_level: 0,
      });
      // Same rule as a single rejection: an order turned away keeps none of
      // its money. Most of these were never paid, and then this does nothing.
      await giveTheMoneyBack(o, { reason: 'blank ticket', userId: who?.$id ?? '' }).catch(() => undefined);
    }
    setToast(`${blank.length} blank ${blank.length === 1 ? 'ticket' : 'tickets'} turned away`);
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
      {/* An order wakes it — see wakeSignal. A pass that only woke on touch
          would hide the one thing it exists to show. */}
      <IdleScreen
        settings={settings}
        afterMinutes={settings?.idle_minutes ?? 0}
        hasOpenShift
        wakeSignal={wakeSignal}
      />
      {/* An alarm nobody can hear is the one failure in a kitchen that must not
          be quiet about itself. Whole width, top of the screen, and it fixes
          itself when pressed, because the fix genuinely is one touch. */}
      {ready && !soundOk && (
        <button
          onClick={() => { unlockAudio(); setSoundOk(audioReady()); }}
          style={{
            width: '100%', padding: '0.85rem 1rem', border: 'none', cursor: 'pointer',
            background: '#7a1d16', color: '#ffd9d4', font: 'inherit', fontWeight: 600,
            fontSize: '1rem', textAlign: 'center',
          }}
        >
          Sound is off on this screen, so late orders will not ring. Tap here to turn it back on.
        </button>
      )}

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

                        const accept = (person: StaffProfile) => {
                          setWho(person);
                          setPinEntry('');
                          setSwitching(false);
                          setReady(true);
                        };

                        for (const person of staff) {
                          if (await verifyPin(pinEntry, person.pin_hash)) return accept(person);
                        }

                        /*
                          NOBODY HERE MATCHED, SO ASK AGAIN BEFORE SAYING NO.

                          The staff list is read when this screen starts, and a
                          pass display stays on the same page for days. A PIN
                          set this afternoon is therefore unknown to it, and
                          the cook standing there is told their PIN is not
                          recognised — while the same PIN works on any device
                          that has loaded the page since.

                          Nothing about that announces itself. It reads as a
                          forgotten PIN, and the answer everybody reaches for
                          is to set a new one, which does not work either.

                          Once, and only on a failure: a wrong PIN should still
                          cost a wrong PIN rather than a round trip per go.
                        */
                        const fresh = await listAll<StaffProfile>('staff_profiles').catch(() => null);
                        if (fresh) {
                          const usable = fresh.filter((p) => p.active && p.pin_hash);
                          setStaff(usable);
                          const known = new Set(staff.map((p) => p.$id));
                          for (const person of usable.filter((p) => !known.has(p.$id))) {
                            if (await verifyPin(pinEntry, person.pin_hash)) return accept(person);
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
                // The dish itself, not a copy of two of its fields. The write
                // has to carry a value it is not changing; see `carried`.
                item: offItems.find((x) => x.$id === i.$id) ?? { $id: i.$id, name: i.name },
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
              await markAvailable({
                item: offItems.find((x) => x.$id === i.$id) ?? { $id: i.$id },
                userId: who?.user_id || who?.$id,
              });
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
          {/* A pass is read across a hot room under strip lights at midday and
              in a half-dark service area at eleven at night. The right answer
              differs at those two moments on the same screen, so it belongs
              here rather than in a settings page on another app. */}
          <ThemeButton />
          <span>New <b>{pending.length}</b></span>
          <span>Cooking <b>{visible.filter((o) => o.status === 'PREPARING').length}</b></span>
          <span>Ready <b>{visible.filter((o) => o.status === 'READY').length}</b></span>
          {overdue.length > 0 && <span style={{ color: '#ff6b5e' }}>Late <b>{overdue.length}</b></span>}
          {/* Only once there is more than one. A single blank ticket has its
              own Reject button and deserves its own reason. */}
          {blank.length > 1 && (
            <button
              className="kds-help"
              style={{ width: 'auto', padding: '0 0.7rem', color: 'var(--warn)' }}
              title="Turn away every ticket that has nothing listed on it"
              onClick={() => void rejectBlank()}
            >
              Reject {blank.length} blank
            </button>
          )}
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

      {/*
        Bills that went out unpaid, in a strip of their own.

        Only where this pass takes payment at all — combined mode — because on
        a screen that cannot settle anything this would be a list of problems
        with no button on it, which is a way of telling a cook off.

        Above the board rather than below it. It is short, it is money, and a
        section under a full grid of tickets is a section nobody scrolls to.
      */}
      {combined && owing.length > 0 && (
        <div className="kds-coming kds-owing">
          <span className="kds-coming-label">
            {billsToSettleLabel(owing.length)}
            {settings ? ` · ${formatMoney(settleableTotal(owing), settings)}` : ''}
          </span>
          {owing.map((o) => (
            <button
              key={o.$id}
              className="kds-coming-item"
              onClick={() => setSettling(o)}
              disabled={!(who?.can_mark_paid ?? false)}
              title={
                (who?.can_mark_paid ?? false)
                  ? 'Record how this one was paid'
                  : 'Only somebody who may take payment can settle this'
              }
            >
              <b>{displayOrderNo(o.order_no)}</b>
              <span>{seatFor(o, seating)}</span>
              <span className="dim">{settings ? formatMoney(o.total, settings) : ''}</span>
              {/* Said plainly, because "partial" on its own reads as done. */}
              <span className="kds-coming-go">
                {o.payment_status === 'partial' ? 'Part paid · settle' : 'Take payment'}
              </span>
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
              seating={seating}
              owed={owed[order.$id]}
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
          /**
           * A ticket comes off the pass when the bill is CLEARED, not when
           * money changes hands.
           *
           * This used to close the box and drop the ticket on any payment at
           * all. So a customer who paid half — a table splitting it, somebody
           * short of cash who went to find more — disappeared off the kitchen
           * screen while still waiting for their food. Nobody was cooking it,
           * nobody could see the rest was owed, and the only way back was to
           * wait for the screen to reconcile itself a minute later.
           *
           * On a part payment the order stays, with its balance updated, and
           * the box stays open for whoever is paying next.
           */
          onDone={(m, outcome) => {
            if (outcome?.settled ?? true) {
              setSettling(null);
              setOrders((prev) => prev.filter((o) => o.$id !== settling.$id));
            } else {
              setOrders((prev) =>
                prev.map((o) => (o.$id === settling.$id ? { ...o, payment_status: 'partial' } : o)),
              );
            }
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
  order, items, seating, owed, sla, overdue, cookMinutes,
  settings, canSettle, onAccept, onStart, onDone, onCollect, onSettle, onReject,
}: {
  order: Order;
  /** Undefined until the lines have arrived. Empty means there are none. */
  items: OrderItem[] | undefined;
  /** Tables by id, so the ticket can name the one the guest chose. */
  seating: Record<string, TableRow>;
  /** What is left to pay on a part-paid bill. Undefined until it is known. */
  owed?: number;
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
   * The kitchen's part is over.
   *
   * Once the food is up, every clock on this ticket stops: no countdown, no
   * climbing timer, no Late tag. The cook was asked to have it ready by a time
   * and it is ready; whatever happens between here and the customer is the
   * collection, and nobody standing at a pass can act on it. A counter still
   * running on a finished plate reads as the kitchen being timed for somebody
   * else's delay, and it crowds out the one thing on a finished ticket that
   * IS still worth acting on, which is whether it has been paid for.
   */
  const finished = order.status === 'READY';

  /**
   * The same sum the alarm does, shown on the ticket.
   *
   * The clock in the corner and this countdown now start at the same instant,
   * the moment the order was placed, and so does the alarm. They used to
   * differ: the clock counted from placing and lateness from accepting, so a
   * cook could read 18:32 on a fifteen minute dish, expect the alarm, and not
   * get it, which teaches people the alarm is unreliable when it is doing
   * exactly what it was told.
   */
  // Still arriving, or genuinely empty. The clock decides, not the absence.
  const lineState = ticketLines(order, items);

  const cooking = order.status === 'ACCEPTED' || order.status === 'PREPARING';
  /**
   * The count a cook watches, and the exact moment it rings.
   *
   * Both from when the customer placed it, because that is when their wait
   * started and when the promise was made. Both from the same figure in core,
   * so "due now" and the Late pill land on the same second: twenty minutes
   * counting down, "due now", then "1 min over" with the alarm already going.
   *
   * A cushion used to sit between them — the count reached zero and nothing
   * happened for another five minutes — which taught a kitchen that the number
   * on the ticket was not the number that mattered.
   */
  const leftMinutes = -minutesOver(order, cookMinutes);

  return (
    <div className={`ticket ${order.status === 'PENDING' ? 'pending' : ''} ${late ? 'late' : ''}`}>
      <div className="ticket-head">
        <div>
          <div className="no">{displayOrderNo(order.order_no)}</div>
          {/*
            Whose food this is.

            A number gets a plate as far as the pass and no further. Calling
            "forty-one" across a room full of people is how the wrong person
            collects, and how the right one keeps waiting. A name is what is
            actually said out loud, so it is set beside the number rather than
            tucked in with the rest of the detail.

            Left out entirely when nobody gave one, which is most table
            orders. An empty line where a name should be reads as missing
            information about the order rather than an order without a name.
          */}
          {order.customer_name && <div className="who">{order.customer_name}</div>}
          {/*
            The answer the guest gave to "where are you sitting?".

            This said "Table order" for every single seated order, whichever
            table it was, because an order stores the table's id and nothing
            here had the list to turn that back into a name. So the one piece
            of information a person carrying a plate actually needs was the one
            piece the ticket would not tell them, and they had to go and ask.
          */}
          <div className="where seat">
            {seatFor(order, seating)}
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
          {finished
            ? <div className="age done">Ready</div>
            : <div className={`age ${ageClass}`}>{mmss(age)}</div>}
          {cooking && (
            <div className="due" style={leftMinutes < 0 ? { color: '#ff9b90' } : undefined}>
              {leftMinutes < 0
                ? `${Math.abs(leftMinutes)} min over`
                : leftMinutes === 0
                  ? 'due now'
                  // Hours once it runs past one, which it now can: an order
                  // placed before the kitchen opened is counted from opening,
                  // so "83 min left" is a sum a cook should not have to do.
                  : leftMinutes >= 60
                    ? `${formatWait(leftMinutes)} left`
                    : `${leftMinutes} min left`}
              {/*
                What the budget is made of, so the countdown does not look
                arbitrary. The figure being counted down is what the customer
                was quoted — cooking plus whatever was on the pass in front of
                them — and the cooking time alone is the part the kitchen
                controls. A cook reading "34 min left · 20 min of cooking"
                can see where the other fourteen went.
              */}
              <span className="dim">
                {' · '}{order.prep_minutes ?? cookMinutes} min of cooking
              </span>
            </div>
          )}
          <div style={{ marginTop: '0.2rem' }}>
            {order.channel === 'qr' && <span className="pill qr">QR</span>}
            {order.is_preorder && <span className="pill preorder">Pre-order</span>}
            {/* Why this ticket has so long on it. Ordered before the doors
                opened, so its countdown starts at opening rather than at the
                moment somebody pressed send — without saying so, a cook reads
                an hour and twenty on a twenty minute dish and distrusts the
                clock on every other ticket too. */}
            {order.placed_while_closed && !order.is_preorder && (
              <span className="pill preorder">Before opening</span>
            )}
            {/*
              Part paid, at the top, at every stage.

              Not only on a finished ticket. A deposit is taken on an order
              that has not been cooked yet, and that is precisely the one that
              gets handed over without anybody asking for the rest.

              What is LEFT, never what the bill came to: the total is the one
              figure on this ticket that is now certainly wrong, and it is the
              figure a tired person would read out. Silent until the answer is
              known, because a balance showing zero while it is still being
              looked up is food going out of the door unpaid.
            */}
            {order.payment_status === 'partial' && (
              <span className="pill" style={{ background: '#3a2d14', color: '#f5c451' }}>
                Part paid{owed !== undefined && settings ? ` · ${formatMoney(owed, settings)} left` : ''}
              </span>
            )}
            {/*
              The tag that replaces Late once the food is up.

              A finished plate cannot be late — the cooking was done on time or
              it was not, and that was settled before this. What can still go
              wrong is that it leaves the pass without being paid for, and that
              is money nobody can chase afterwards: the customer has gone and
              the shift balances as though nothing happened. So the loud tag on
              a ready ticket is the one somebody can still act on.
            */}
            {finished && order.payment_status === 'unpaid' && order.total > 0 && (
              <span className="pill" style={{ background: '#4a1410', color: '#ff9b90' }}>
                Unpaid{settings ? ` · ${formatMoney(order.total, settings)}` : ''}
              </span>
            )}
            {/* Nothing owed is not the same as owing and not having paid. A
                comped ticket tagged Unpaid sends somebody chasing money that
                was never going to arrive. */}
            {order.total <= 0 && (
              <span className="pill">No charge</span>
            )}
            {overdue && <span className="pill" style={{ background: '#3a1714', color: '#ff9b90' }}>Late</span>}
          </div>
        </div>
      </div>

      <ul className="ticket-items">
        {/* An order and its lines are two writes, and the kitchen hears about
            the order first. So an empty ticket is ordinary for a second or two
            and a real fault after that; saying "check with whoever sent it" on
            every order as it lands teaches a kitchen to ignore the one time it
            means something. See ticketLines. */}
        {lineState === 'loading' && <li className="dim">Loading items…</li>}
        {lineState === 'missing' && (
          <li style={{ color: 'var(--warn)' }}>
            Nothing is listed on this ticket. Check with whoever sent it before cooking.
          </li>
        )}
        {/*
          Some of it arrived and some did not, and this is the dangerous case:
          a ticket with two of three dishes on it looks exactly like an order
          for two dishes. Nothing about it is wrong to look at, so the cook
          makes two, the customer is charged for three, and the only person who
          finds out is the one still waiting for the third.

          The order's own subtotal is what gives it away — it is the sum of the
          lines, worked out before any of them were written. See linesComplete.
        */}
        {lineState === 'partial' && (
          <li style={{ color: 'var(--warn)' }}>
            Part of this ticket is missing. What is listed does not add up to
            {settings ? ` ${formatMoney(order.subtotal, settings)}` : ' the order'}.
            Check with whoever sent it before cooking.
          </li>
        )}
        {(items ?? []).map((i) => {
          /*
            What the customer actually asked for, spelled out.

            One line per option rather than a comma-separated run, and in the
            ticket's normal text rather than the dim grey they used to be in.
            "No onions" is not a footnote about the dish, it is part of the
            instruction, and a cook reading a screen from across a kitchen was
            being shown it in the smallest, faintest type on the ticket.

            The size, where there is one, leads — it decides the pan before
            anything else does. Skipped when the line's name already carries
            it, which is what the till writes.
          */
          const options = addonNames(i.addons);
          const size = i.variant_label && !i.name_snapshot.includes(i.variant_label)
            ? i.variant_label
            : '';
          return (
            <li key={i.$id}>
              <span className="qty">{i.qty}×</span>
              {i.name_snapshot}
              {size && <div className="addons">{size}</div>}
              {options.map((name, n) => (
                <div key={n} className="addons">{name}</div>
              ))}
              {/* Something was chosen and could not be read. Saying so is the
                  whole point: silence here looks exactly like a plain dish. */}
              {addonsUnreadable(i.addons) && (
                <div className="addons" style={{ color: 'var(--warn)' }}>
                  Options were chosen but cannot be read here — ask before cooking.
                </div>
              )}
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
            ) : (
              <>
                {/*
                  Part paid is its own state and has to look like one, with the
                  figure that matters on it. Read as simply unpaid, somebody
                  chases the whole bill again; read as paid, the rest is never
                  asked for; read without a number, whoever is standing there
                  has to open a box to find out whether it is five cedis or
                  fifty.

                  What is left, never what the bill came to. The total is the
                  one number on this ticket that is now certainly wrong, and it
                  is the number a tired person would read out.
                */}
                {/* A bill that comes to nothing — discounted in full, or a
                    staff meal — has nothing to take. Offering to take a
                    payment of nought is how a comped order ends up stuck on
                    the pass with the only button on it refusing every answer. */}
                {order.total <= 0 ? (
                  <Button variant="primary" onClick={onCollect}>Collected · nothing to pay</Button>
                ) : canSettle ? (
                  <Button variant="primary" onClick={onSettle}>
                    {order.payment_status === 'partial'
                      ? `Collect & take the rest${owed !== undefined && settings ? ` · ${formatMoney(owed, settings)}` : ''}`
                      : `Collect & take payment${settings ? ` · ${formatMoney(order.total, settings)}` : ''}`}
                  </Button>
                ) : (
                  <span className="small" style={{ opacity: 0.75 }}>
                    {order.payment_status === 'partial'
                      ? `Waiting for the rest${owed !== undefined && settings ? ` · ${formatMoney(owed, settings)}` : ''}`
                      : `Waiting for payment${settings ? ` · ${formatMoney(order.total, settings)}` : ''}`}
                  </span>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
