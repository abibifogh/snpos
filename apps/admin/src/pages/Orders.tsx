import { useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, useToast,
  FilterBar, FilterField, Segmented, PickerMenu, PickerItem, FacetChips, GroupedRows, SortableTh,
} from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import {
  formatMoney, Query, toCsv, downloadCsv, buildReceiptHtml, openPrintable, receiptForOrder,
  settleOrderNumbers, recomputeOrderTotals, cancelOrder, removeOrder, recomputeClosedShift,
  voidPayment, isLivePayment, changePaymentMethod, logPaymentMethodChange,
  groupRows, sortRows, toggleGroup, cycleSort, sortDir, sortPosition, flatten, MODULE_LABELS,
  listByIds, listCreatedBetween, moveOrderToShift, shiftChoices, moveProblem, moveEffects, describeMove,
} from '@snpos/core';
import type {
  Order, OrderItem, StaffProfile, Doc, Venue, Module, GroupChoice, SortChoice, MovableShift,
} from '@snpos/core';
import { useSession } from '../session';
import { SideFilter, onSide, narrowSide, type Side } from '../components/SideFilter';

interface Payment extends Doc {
  order_id: string;
  method_id: string;
  shift_id?: string;
  amount: number;
  tip: number;
  taken_by: string;
  change_given: number;
  /** 'voided' means recorded in error and taken back out. */
  status?: string;
}
/**
 * `kind` is carried because it travels with a payment as
 * `method_kind_snapshot`, and the receipt and the nightly summary both fall
 * back to it when a method has since been renamed or removed. Correcting the
 * method and leaving the kind behind would fix the label on the shift screen
 * and leave a card payment printing as cash on the customer's receipt.
 */
interface PaymentMethod extends Doc { name: string; kind?: string }

/**
 * Every order, over a range you choose.
 *
 * The Reports page answers "how did we do"; this one answers "what happened to
 * that order", which is the question somebody actually has when a customer
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
  const { settings, profile, user } = useSession();
  const toast = useToast();

  const [from, setFrom] = useState(daysAgoStr(7));
  const [to, setTo] = useState(todayStr());
  const [staffId, setStaffId] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [side, setSide] = useState<Side>('all');
  /*
    Grouping and sorting, both stacked in the order they were chosen.

    "What did we take" is a total. "What did we take, by day, by who was on"
    is the question somebody has when a figure looks wrong, and it needs the
    groupings to nest in a chosen sequence — day inside staff and staff inside
    day are different answers, and both get asked.
  */
  const [groups, setGroups] = useState<GroupChoice[]>([]);
  const [sorts, setSorts] = useState<SortChoice[]>([]);
  const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<'group' | 'sort' | null>(null);

  const [orders, setOrders] = useState<Order[] | null>(null);
  const [items, setItems] = useState<Record<string, OrderItem[]>>({});
  const [payments, setPayments] = useState<Payment[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [open, setOpen] = useState<Order | null>(null);
  const [editing, setEditing] = useState<Order | null>(null);
  const [voiding, setVoiding] = useState<{ payment: Payment; order: Order } | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voidBusy, setVoidBusy] = useState(false);
  /** A payment whose method is being corrected: cash rung up as card, or back. */
  const [repaying, setRepaying] = useState<Payment | null>(null);
  const [repayBusy, setRepayBusy] = useState(false);
  const [newStatus, setNewStatus] = useState('');
  const [newPayment, setNewPayment] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));

  /**
   * For orders whose stored total is already wrong. See recomputeOrderTotals:
   * an order repriced from one line of three kept that figure, and reloading
   * never helped because the stored number itself was the wrong one.
   */
  /**
   * Cancelling and deleting a finished order.
   *
   * An admin's, and nobody else's. The kitchen can reject an order before
   * cooking it and a customer can call one back within two minutes; neither
   * helps with one that ran all the way to the end and should not have — a
   * duplicate, a walkout, a bill rung up against the wrong table.
   */
  const isAdmin = profile?.role === 'admin';
  const [killing, setKilling] = useState<{ order: Order; how: 'cancel' | 'delete' } | null>(null);
  const [killReason, setKillReason] = useState('');
  const [killBusy, setKillBusy] = useState(false);

  /**
   * Moving a real sale onto the shift it belongs to.
   *
   * The shifts are fetched when somebody asks, not with the page. There is one
   * of these for every night this business has ever traded, and reading them
   * all to fill a dropdown nobody opens is exactly the kind of greed that put
   * the tills on the floor. Fetched around the order's own date, because the
   * shift somebody means is always one either side of it.
   */
  const [moving, setMoving] = useState<{ order: Order; shifts: MovableShift[] } | null>(null);
  const [moveTo, setMoveTo] = useState('');
  const [moveReason, setMoveReason] = useState('');
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveLoading, setMoveLoading] = useState(false);
  /** Shifts already seen, so the name can be shown without another read. */
  const [shiftNames, setShiftNames] = useState<Record<string, string>>({});

  const shiftLabel = (id?: string) => {
    if (!id) return 'Not counted under any shift';
    return shiftNames[id] ? `Counted under ${shiftNames[id]}` : 'Counted under a shift';
  };

  /*
    The name of the one shift an open order sits on.

    A single read, only when an admin actually opens an order, so the line
    above reads "Counted under BIST-07" rather than "a shift" — which is the
    difference between somebody who can see what they are about to change and
    somebody guessing. Not fetched for the list: that would be a shift lookup
    per row for a line most people never read.
  */
  useEffect(() => {
    const id = open?.shift_id;
    if (!isAdmin || !id || shiftNames[id]) return;
    let live = true;
    void db.getDocument(DB_ID, 'shifts', id)
      .then((s) => {
        const code = (s as unknown as { code?: string }).code;
        if (live && code) setShiftNames((n) => ({ ...n, [id]: code }));
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [open?.shift_id, isAdmin, shiftNames]);

  /** A week either side. Wide enough for a bill settled after a handover. */
  const MOVE_WINDOW_DAYS = 7;

  const startMove = async (order: Order) => {
    setMoveLoading(true);
    try {
      const at = new Date(order.$createdAt).getTime();
      const span = MOVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      const rows = await listCreatedBetween<MovableShift>(
        'shifts',
        new Date(at - span).toISOString(),
        new Date(at + span).toISOString(),
      );
      /*
        The shift it is on now may be older than the window.

        An order shelved for weeks, or one being moved back off a shift it was
        wrongly adopted onto. Without this the screen would say "a shift" where
        it should name one, which is the difference between an admin who knows
        what they are undoing and one who is guessing.
      */
      const here = order.shift_id && !rows.some((s) => s.$id === order.shift_id)
        ? await db.getDocument(DB_ID, 'shifts', order.shift_id).catch(() => null) as MovableShift | null
        : null;
      const all = here ? [...rows, here] : rows;
      setShiftNames((n) => ({ ...n, ...Object.fromEntries(all.map((s) => [s.$id, s.code])) }));
      setMoveTo('');
      setMoveReason('');
      setMoving({ order, shifts: all });
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setMoveLoading(false);
    }
  };

  const doMove = async () => {
    if (!moving) return;
    const to = moving.shifts.find((s) => s.$id === moveTo);
    if (!to) return;
    setMoveBusy(true);
    try {
      const { payments: moved, stranded } = await moveOrderToShift({
        order: moving.order,
        toShiftId: to.$id,
        userId: user?.$id ?? '',
        reason: moveReason.trim(),
      });
      /*
        Both ends, and in this order.

        A closed shift stored what it took and what it expected at the moment
        it closed, and neither moves on its own — so the shift losing the sale
        would go on reporting money it no longer has, and the one gaining it
        would not expect the money now sitting against it. An open shift works
        itself out from the rows, so this is a no-op there rather than a case
        to special-case.
      */
      const before = moving.order.shift_id;
      if (before) await recomputeClosedShift(before).catch(() => null);
      await recomputeClosedShift(to.$id).catch(() => null);

      setMoving(null);
      setOpen(null);
      await load();
      // A partial move is the one outcome that must never pass quietly: money
      // left on a shift with no sale to explain it reads as theft.
      if (stranded > 0) {
        toast(
          `${moving.order.order_no} moved to ${to.code}, but ${stranded} payment${stranded === 1 ? '' : 's'} `
          + 'would not move. Try again — repeating this is safe.',
          'err',
        );
      } else {
        toast(
          `${moving.order.order_no} now counts under ${to.code}`
          + (moved > 0 ? `, with ${moved} payment${moved === 1 ? '' : 's'}` : ''),
        );
      }
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setMoveBusy(false);
    }
  };

  const doKill = async () => {
    if (!killing) return;
    const { order, how } = killing;
    if (how === 'cancel' && !killReason.trim()) return;
    setKillBusy(true);
    try {
      /*
        Ask the server to unwind the sale BEFORE the order goes.

        Two things hang off an order that this page cannot reach. The pieces
        came off the shelf, and the maker was credited — and the consignor
        ledger has no write permission for anybody at all, deliberately,
        because it is what a maker is paid from. So a browser cannot put
        either right however carefully it tries.

        Without this, cancelling a sale left the shop one bowl short on the
        count and the maker still owed for it, with the order gone and nothing
        left to explain either. The request goes first because it needs the
        order and its lines to still be there to read.

        Erase for a delete, refund for a cancel: a deleted order should leave
        no trace anywhere including the statement, a cancelled one stays on
        the record marked void.
      */
      const request = await db.createDocument(DB_ID, 'order_reversals', ID.unique(), {
        venue_id: order.venue_id,
        order_id: order.$id,
        mode: how === 'delete' ? 'erase' : 'refund',
        requested_at: new Date().toISOString(),
        requested_by: user?.$id ?? '',
        reason: killReason.trim().slice(0, 300),
        status: 'requested',
      }).catch(() => null);

      /*
        Wait for it, because the order has to still be here for the server to
        read its lines. Delete first and the movements can never be found,
        which leaves the shelf short and the maker still owed — the exact
        failure this whole path exists to stop.

        Ten seconds, then carry on regardless: an admin who has decided to
        cancel an order should not be stuck on a screen because a function is
        slow. What was put back is on the reversal row either way.
      */
      let unwound = '';
      if (request) {
        for (let i = 0; i < 20; i += 1) {
          await new Promise((r) => { setTimeout(r, 500); });
          const row = await db.getDocument(DB_ID, 'order_reversals', request.$id).catch(() => null) as
            { status?: string; note?: string } | null;
          if (row?.status === 'done' || row?.status === 'failed') { unwound = row.note ?? ''; break; }
        }
      }

      if (how === 'cancel') {
        await cancelOrder(order, { reason: killReason.trim(), userId: user?.$id ?? '' });
      } else {
        await removeOrder(order, { userId: user?.$id ?? '' });
      }
      /**
       * The shift it belonged to is worked out again.
       *
       * An order taken off a shift takes its money with it. A closed shift
       * stored what it took and what it expected at the moment it closed, and
       * those figures do not recompute themselves, so without this the summary
       * keeps reporting a sale that no longer exists. An open shift works
       * itself out from the rows every time it is looked at.
       */
      if (order.shift_id) await recomputeClosedShift(order.shift_id).catch(() => null);
      setKilling(null);
      setKillReason('');
      setOpen(null);
      await load();
      // What went back matters more than the fact it was cancelled, so it is
      // said rather than left on a row nobody opens.
      const did = how === 'cancel' ? `${order.order_no} cancelled` : `${order.order_no} deleted`;
      toast(unwound ? `${did}. ${unwound}` : did);
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setKillBusy(false);
    }
  };

  const [fixing, setFixing] = useState(false);
  const fixTotals = async (order: Order) => {
    if (!settings) return;
    setFixing(true);
    try {
      const changed = await recomputeOrderTotals(order, settings);
      if (!changed) { toast('That total already matches its items.'); return; }
      toast(`Total corrected from ${money(changed.from)} to ${money(changed.to)}`);
      await load();
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setFixing(false);
    }
  };

  const load = async () => {
    setOrders(null);
    const [o, m, s, v] = await Promise.all([
      listAll<Order>('orders', [
        Query.greaterThanEqual('$createdAt', dayStart(from)),
        Query.lessThanEqual('$createdAt', dayEnd(to)),
      ]),
      listAll<PaymentMethod>('payment_methods'),
      listAll<StaffProfile>('staff_profiles'),
      listAll<Venue>('venues'),
    ]);
    /*
      Only the payments on the orders being shown.

      The orders were already narrowed to the chosen dates and the payments
      were not, so displaying one week meant reading every payment ever taken
      — and a payment carries no date of its own to narrow by, so it has to be
      asked for by the orders it belongs to.
    */
    const p = await listByIds<Payment>('payments', 'order_id', o.map((x) => x.$id));
    setOrders(o.sort((a, b) => b.$createdAt.localeCompare(a.$createdAt)));
    setPayments(p);
    setMethods(m);
    setStaff(s.filter((x) => x.active !== false));
    setVenues(v);

    // Anything still on a placeholder number gets its real one. The server
    // does this the moment an order lands; this is the safety net for the
    // night it did not, and it is the screen most likely to be looking.
    if (settings && o.some((x) => x.order_no?.startsWith('~'))) {
      const venueId = o.find((x) => x.order_no?.startsWith('~'))?.venue_id;
      if (venueId) {
        const fixed = await settleOrderNumbers(venueId, settings).catch(() => 0);
        if (fixed > 0) {
          toast(`${fixed} order${fixed === 1 ? '' : 's'} given their proper number`);
          void load();
        }
      }
    }
  };
  useEffect(() => { load().catch((e) => setError(humanError(e))); /* eslint-disable-next-line */ }, [from, to]);

  /**
   * The order history, as a spreadsheet.
   *
   * One row per order rather than per line: this is the file somebody pivots
   * to answer "how much did we take on Fridays", and an order split across
   * five rows makes every total wrong unless they notice. The items are in a
   * column so nothing is actually lost.
   */
  const exportCsv = async () => {
    // In the order the screen shows them: the grouping and the sort decided
    // it, and a spreadsheet that disagreed with the page would disagree about
    // what "the first twenty" means.
    const rows = flatten(tree, ordered).map((o) => {
      const lines = items[o.$id];
      const paid = payments.filter((p) => p.order_id === o.$id);
      return [
        o.order_no,
        new Date(o.$createdAt).toLocaleDateString(),
        new Date(o.$createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        o.status,
        o.payment_status,
        o.channel,
        o.fulfilment ?? '',
        o.placed_by ?? '',
        o.customer_name ?? '',
        o.guest_count ?? 1,
        // Money as plain decimals, not formatted; a spreadsheet has to be
        // able to add this column up, and "GH₵12.00" is text.
        (o.subtotal / 100).toFixed(2),
        (o.discount_total / 100).toFixed(2),
        (o.service_total / 100).toFixed(2),
        (o.tax_total / 100).toFixed(2),
        (o.tip_total / 100).toFixed(2),
        (o.total / 100).toFixed(2),
        paid.map((p) => methods.find((m) => m.$id === p.method_id)?.name ?? '').filter(Boolean).join(' + '),
        nameOf(o.accepted_by),
        nameOf(o.marked_paid_by),
        lines ? lines.map((i) => `${i.qty}× ${i.name_snapshot}`).join('; ') : '(open the order to include items)',
        o.notes ?? '',
      ];
    });

    downloadCsv(
      `orders-${from}-to-${to}`,
      toCsv(
        [
          'Order', 'Date', 'Time', 'Status', 'Payment', 'Channel', 'Fulfilment', 'Placed by', 'Customer',
          'Guests', 'Subtotal', 'Discount', 'Service', 'Tax', 'Tip', 'Total', 'Paid by',
          'Accepted by', 'Settled by', 'Items', 'Notes',
        ],
        rows,
      ),
    );
    toast(`${rows.length} order${rows.length === 1 ? '' : 's'} exported`);
  };

  /** The same receipt the customer gets, reprinted from here. */
  const printReceipt = async (o: Order) => {
    try {
      const venue = venues.find((v) => v.$id === o.venue_id) ?? null;
      const data = await receiptForOrder({
        order: o,
        settings: settings!,
        venue,
        items: items[o.$id],
        staffName: o.marked_paid_by ? nameOf(o.marked_paid_by) : undefined,
      });
      openPrintable(buildReceiptHtml(data), `Receipt ${o.order_no}`);
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  /** Everyone who touched an order, so the staff filter can mean something. */
  const touchedBy = (o: Order): string[] => {
    const ids = [o.accepted_by, o.marked_paid_by, ...payments.filter((p) => p.order_id === o.$id).map((p) => p.taken_by)];
    return [...new Set(ids.filter(Boolean) as string[])];
  };

  const nameOf = (userId?: string) => {
    if (!userId) return ', ';
    const person = staff.find((s) => s.user_id === userId || s.$id === userId);
    return person?.display_name ?? 'Unknown';
  };

  /*
    Whose orders these are.

    Narrowed by the person as well as the choice: somebody marked as working
    one side has no second side to be shown, and leaving it on "All" handed
    them the other trade's takings with no tab pressed and nothing on screen
    to suggest it.
  */
  const shownSide = narrowSide(side, profile, settings);

  const visible = useMemo(
    () =>
      (orders ?? []).filter((o) => {
        if (!onSide(o, shownSide)) return false;
        if (statusFilter && o.status !== statusFilter) return false;
        if (staffId && !touchedBy(o).includes(staffId)) return false;
        return true;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orders, statusFilter, staffId, payments, shownSide],
  );

  // Only what narrows the list counts. The dates are how much was loaded, not
  // a filter over it, so "Clear" leaving them alone is the honest behaviour —
  // clearing them would silently re-read the database.
  const filtered = !!statusFilter || !!staffId || shownSide !== 'all';

  /** Which quick range the dates currently amount to, if any. */
  const rangeChoice = useMemo(() => {
    if (to !== todayStr()) return 'custom';
    for (const days of [0, 6, 29]) if (from === daysAgoStr(days)) return String(days);
    return 'custom';
  }, [from, to]);


  /**
   * What each grouping shows for a row.
   *
   * Almost nothing groups by its raw value: an order groups by DAY, not by the
   * instant it was placed, or every order is its own group of one.
   */
  const SORTABLE = [
    { key: 'when', label: 'When' },
    { key: 'order_no', label: 'Order number' },
    { key: 'status', label: 'Status' },
    { key: 'payment_status', label: 'Paid' },
    { key: 'who', label: 'Member of staff' },
    { key: 'total', label: 'Total' },
  ];

  const GROUPABLE: GroupChoice[] = [
    { key: 'day', label: 'Day' },
    { key: 'side', label: 'Side of the business' },
    { key: 'status', label: 'Status' },
    { key: 'payment_status', label: 'Paid' },
    { key: 'who', label: 'Member of staff' },
    { key: 'fulfilment', label: 'Where' },
  ];

  const groupValue = (o: Order, key: string): string => {
    if (key === 'day') return new Date(o.$createdAt).toLocaleDateString(undefined, { dateStyle: 'full' });
    if (key === 'side') return MODULE_LABELS[(o.module ?? 'kitchen') as Module] ?? String(o.module);
    if (key === 'who') return touchedBy(o).map(nameOf).join(', ');
    if (key === 'fulfilment') return o.fulfilment ?? '';
    return String((o as unknown as Record<string, unknown>)[key] ?? '');
  };

  const compareOrders = (a: Order, b: Order, key: string): number => {
    if (key === 'total') return a.total - b.total;
    if (key === 'when') return a.$createdAt.localeCompare(b.$createdAt);
    if (key === 'who') return groupValue(a, 'who').localeCompare(groupValue(b, 'who'));
    if (key === 'where') return (a.fulfilment ?? '').localeCompare(b.fulfilment ?? '');
    return String((a as unknown as Record<string, unknown>)[key] ?? '')
      .localeCompare(String((b as unknown as Record<string, unknown>)[key] ?? ''));
  };

  // Sorted first, then grouped: the groups are built from rows that are
  // already in order, so the order holds inside every group.
  const ordered = useMemo(() => sortRows(visible, sorts, compareOrders), [visible, sorts]);
  const tree = useMemo(() => groupRows(ordered, groups, groupValue), [ordered, groups]);

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

  /**
   * Reversing a payment that was never actually received.
   *
   * Admin only. Putting an order's status back is a correction a manager makes
   * at a pass; taking money out of a night's takings is not, because the
   * drawer was counted against it and somebody signed for that count.
   */
  const canVoid = isAdmin;

  const doVoid = async () => {
    if (!voiding) return;
    if (!voidReason.trim()) { setError('Say why. It goes on the record with your name.'); return; }
    setVoidBusy(true);
    setError(null);
    try {
      const { paymentStatus, outstanding } = await voidPayment(voiding.payment, voiding.order);

      await db.createDocument(DB_ID, 'audit_log', ID.unique(), {
        venue_id: voiding.order.venue_id,
        actor_id: profile?.user_id ?? profile?.$id ?? '',
        actor_role: profile?.role ?? '',
        action: 'payment_voided',
        entity_type: 'payments',
        entity_id: voiding.payment.$id,
        before: JSON.stringify({
          order_no: voiding.order.order_no,
          amount: voiding.payment.amount,
          tip: voiding.payment.tip,
          method: methods.find((m) => m.$id === voiding.payment.method_id)?.name ?? voiding.payment.method_id,
          taken_by: nameOf(voiding.payment.taken_by),
          shift_id: voiding.payment.shift_id,
        }),
        after: JSON.stringify({ status: 'voided', order_payment_status: paymentStatus }),
        reason: voidReason.trim(),
      }).catch(() => undefined);

      /*
        The shift's own totals are a snapshot taken when it closed, so they do
        not move on their own. Redone here when the shift is known, because
        leaving them is how the shift summary keeps reporting a sale that no
        longer exists — the same reason cancelling an order redoes them.

        An OPEN shift needs nothing: its figures are worked out live from the
        payment rows every time somebody looks.
      */
      if (voiding.payment.shift_id) {
        await recomputeClosedShift(voiding.payment.shift_id).catch(() => undefined);
      }

      setVoiding(null);
      await load();
      toast(
        outstanding > 0
          ? `Voided. ${voiding.order.order_no} now owes ${money(outstanding)}.`
          : 'Voided.',
      );
    } catch (e) {
      setError(humanError(e));
    } finally {
      setVoidBusy(false);
    }
  };

  /**
   * Moving a payment from one drawer to the other.
   *
   * The amount does not move and the order does not change; only which pile
   * the money is expected to be in. A closed shift's stored expectations are
   * redone afterwards, because that is the whole point — the figure somebody
   * is trying to reconcile is the one on the shift.
   */
  const moveMethod = async (m: PaymentMethod) => {
    if (!repaying) return;
    setRepayBusy(true);
    try {
      const was = methods.find((x) => x.$id === repaying.method_id)?.name ?? repaying.method_id;
      await changePaymentMethod(repaying.$id, { $id: m.$id, kind: m.kind ?? '' });
      await logPaymentMethodChange({
        venueId: open?.venue_id ?? venues[0]?.$id ?? '',
        paymentId: repaying.$id,
        actorId: profile?.user_id ?? profile?.$id ?? '',
        actorRole: profile?.role ?? '',
        from: was,
        to: m.name,
        amount: repaying.amount,
      });
      if (repaying.shift_id) await recomputeClosedShift(repaying.shift_id).catch(() => undefined);
      setRepaying(null);
      await load();
      toast(`Moved to ${m.name}`);
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setRepayBusy(false);
    }
  };

  if (error && !orders && !editing) return <Notice>{error}</Notice>;

  return (
    <>
      <div className="spread">
        <h1>Orders</h1>
        <div className="row" style={{ gap: '0.4rem' }}>
          <Button onClick={() => void exportCsv()} disabled={visible.length === 0}>
            Export to spreadsheet
          </Button>
          <Button onClick={() => load().catch((e) => setError(humanError(e)))}>Refresh</Button>
        </div>
      </div>

      {/*
        How much to load, then how much of it to show.

        Two different questions that were in one card together, which is why
        it read as a form. The dates go to the database; everything below is a
        view over what came back. Separating them is also what lets "Clear
        filters" mean something safe — it never silently re-reads.
      */}
      <div className="filter-bar">
        <div className="filter-bar-controls">
          <FilterField label="From">
            <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </FilterField>
          <FilterField label="To">
            <Input type="date" value={to} min={from} max={todayStr()} onChange={(e) => setTo(e.target.value)} />
          </FilterField>
          {/*
            The chosen range, shown as chosen.

            Worked out from the dates rather than remembered separately, so
            typing a date by hand moves the switch to "Custom" instead of
            leaving "7 days" lit beside a range that is nothing of the kind.
          */}
          <Segmented<string>
            ariaLabel="How far back"
            value={rangeChoice}
            onChange={(v) => {
              if (v === 'custom') return;
              setFrom(daysAgoStr(Number(v)));
              setTo(todayStr());
            }}
            options={[
              { value: '0', label: 'Today' },
              { value: '6', label: '7 days' },
              { value: '29', label: '30 days' },
              ...(rangeChoice === 'custom' ? [{ value: 'custom', label: 'Custom' }] : []),
            ]}
          />
        </div>
      </div>

      <FilterBar
        shown={visible.length}
        total={orders?.length ?? 0}
        noun="orders"
        onClear={filtered ? () => { setStatusFilter(''); setStaffId(''); setSide('all'); } : undefined}
      >
        <SideFilter value={side} onChange={setSide} settings={settings} profile={profile} />
        <FilterField label="Status">
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">Any status</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
          </Select>
        </FilterField>
        <FilterField label="Staff">
          <Select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">Everyone</option>
            {staff.map((s) => (
              <option key={s.$id} value={s.user_id || s.$id}>{s.display_name}</option>
            ))}
          </Select>
        </FilterField>

        {/* Ticking one that is already on moves it to the end of the order
            rather than removing it — the chip has an × for removing, and
            clicking a chosen grouping is nearly always an attempt to reorder. */}
        <PickerMenu label="Group by" count={groups.length} open={menu === 'group'} onOpen={(o) => setMenu(o ? 'group' : null)}>
          {GROUPABLE.map((g) => (
            <PickerItem
              key={g.key}
              label={g.label}
              on={groups.some((c) => c.key === g.key)}
              position={groups.findIndex((c) => c.key === g.key) + 1}
              onClick={() => setGroups(toggleGroup(groups, g))}
            />
          ))}
        </PickerMenu>

        <PickerMenu label="Sort" count={sorts.length} open={menu === 'sort'} onOpen={(o) => setMenu(o ? 'sort' : null)}>
          {SORTABLE.map((s2) => (
            <PickerItem
              key={s2.key}
              label={s2.label}
              on={!!sortDir(sorts, s2.key)}
              dir={sortDir(sorts, s2.key)}
              position={sortPosition(sorts, s2.key)}
              onClick={() => setSorts(cycleSort(sorts, s2.key, s2.label))}
            />
          ))}
        </PickerMenu>
      </FilterBar>

      {/* What is applied, in order. Without this the sequence — the whole
          point of stacking them — is not visible anywhere on the page. */}
      <FacetChips
        facets={[
          ...groups.map((g) => ({ kind: 'Group', label: g.label })),
          ...sorts.map((s2) => ({ kind: 'Sort', label: s2.label, detail: s2.dir === 'asc' ? '↑' : '↓' })),
        ]}
        onRemove={(i) => {
          if (i < groups.length) setGroups(groups.filter((_, n) => n !== i));
          else setSorts(sorts.filter((_, n) => n !== i - groups.length));
        }}
        onClear={() => { setGroups([]); setSorts([]); }}
      />

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
                  {([
                    ['when', 'When', ''], ['order_no', 'Order', ''], ['where', 'Where', ''],
                    ['status', 'Status', ''], ['payment_status', 'Paid', ''], ['who', 'Who', ''],
                    ['total', 'Total', 'num'],
                  ] as [string, string, string][]).map(([key, label, cls]) => (
                    <SortableTh
                      key={key}
                      label={label}
                      className={cls || undefined}
                      dir={sortDir(sorts, key)}
                      position={sortPosition(sorts, key)}
                      onClick={() => setSorts(cycleSort(sorts, key, label))}
                    />
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                <GroupedRows
                  nodes={tree}
                  rows={ordered}
                  columns={8}
                  closed={closedGroups}
                  onToggle={(path) => setClosedGroups((c) => {
                    const next = new Set(c);
                    if (next.has(path)) next.delete(path); else next.add(path);
                    return next;
                  })}
                  rowKey={(o) => o.$id}
                  summary={(rs) => money(rs.reduce((n, o) => n + o.total, 0))}
                  renderRow={(o) => (
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
                    <td className="dim small">{touchedBy(o).map(nameOf).join(', ') || '-'}</td>
                    <td className="num">{money(o.total)}</td>
                    <td className="num">
                      <Button size="sm" variant="ghost" onClick={() => openOrder(o)}>Details</Button>
                      <Button size="sm" variant="ghost" onClick={() => void printReceipt(o)}>Receipt</Button>
                      <Button size="sm" variant="ghost" onClick={() => startEdit(o)}>Change</Button>
                    </td>
                  </tr>
                  )}
                />
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
          {/*
            For orders whose stored total is already wrong.

            The server reprices an order a second after it lands, and it used
            to begin as soon as it saw the first of its lines — so an order
            read a moment too early was priced from one dish of three, and that
            figure was written onto the order and stayed. Reloading changed
            nothing, because the stored figure itself was wrong.

            Fixed at the source, but a wrong number already written stays wrong
            until somebody works it out again. The lines are taken as they
            stand, so this cannot rewrite what a customer was charged; it only
            makes the order agree with its own items.
          */}
          {(items[open.$id] ?? []).length > 0 && (
            <div className="row" style={{ justifyContent: 'space-between', marginTop: '0.6rem' }}>
              <span className="small dim">
                If this total does not match the items above, work it out again from them.
              </span>
              <Button size="sm" loading={fixing} onClick={() => void fixTotals(open)}>
                Recheck total
              </Button>
            </div>
          )}

          {/*
            Undoing an order that ran all the way to the end.

            Whatever state it reached, including paid and closed. Cancelling
            keeps the record and stops it counting; deleting takes it and its
            payments away entirely. Either way it leaves the shift, which is
            the whole point — an order removed from the books but still sitting
            in the shift's list is an order somebody will ask about.
          */}
          {isAdmin && (
            <>
              <h3 style={{ margin: '1.4rem 0 0.4rem' }}>Put this right</h3>
              <p className="small dim" style={{ marginTop: 0 }}>
                For an order that should not have happened: a duplicate, a walkout, a bill rung up against
                the wrong table. Both take it off the shift it belongs to, and the shift's figures are worked
                out again.
              </p>
              <div className="row" style={{ gap: '0.5rem' }}>
                {open.status !== 'CANCELLED' && (
                  <Button size="sm" onClick={() => { setKillReason(''); setKilling({ order: open, how: 'cancel' }); }}>
                    Cancel this order
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => { setKillReason(''); setKilling({ order: open, how: 'delete' }); }}
                >
                  Delete it entirely
                </Button>
              </div>

              {/*
                A real sale on the wrong night.

                Different from everything above it, and worth saying so: nothing
                about this order is wrong except which shift it counts towards.
                A bill started before midnight and settled after the handover, a
                till left open from the afternoon. The alternatives without this
                are cancelling a sale that genuinely happened, or leaving one
                shift permanently over and the next permanently short.
              */}
              <h3 style={{ margin: '1.4rem 0 0.4rem' }}>Which shift it counts under</h3>
              <p className="small dim" style={{ marginTop: 0 }}>
                {shiftLabel(open.shift_id)}. Move it if it was rung up on the wrong one — the payments go with
                it, so the drawer it is counted against moves too.
              </p>
              <Button size="sm" onClick={() => void startMove(open)} loading={moveLoading}>
                Move to another shift
              </Button>
            </>
          )}

          <h3 style={{ margin: '1.2rem 0 0.4rem' }}>Payment</h3>
          {payments.filter((p) => p.order_id === open.$id).length === 0 ? (
            <p className="small dim" style={{ margin: 0 }}>Nothing recorded against this order.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Method</th><th className="num">Amount</th><th className="num">Tip</th><th>Taken by</th><th />
                  </tr>
                </thead>
                <tbody>
                  {payments.filter((p) => p.order_id === open.$id).map((p) => {
                    const voided = !isLivePayment(p);
                    return (
                      <tr key={p.$id} className={voided ? 'dim' : undefined}>
                        <td>
                          {methods.find((m) => m.$id === p.method_id)?.name ?? '-'}
                          {voided && <Badge tone="warn"> voided</Badge>}
                        </td>
                        <td className="num" style={voided ? { textDecoration: 'line-through' } : undefined}>
                          {money(p.amount)}
                        </td>
                        <td className="num dim">{p.tip ? money(p.tip) : '-'}</td>
                        <td className="dim small">{nameOf(p.taken_by)}</td>
                        <td className="num">
                          {/*
                            The "separately" the warning used to point at.

                            It said to fix the payment separately and there was
                            no separately: nothing in the system could reverse
                            one, so an order could be set back to unpaid while
                            the money it never received stayed in the takings.
                          */}
                          {/*
                            The kitchen can fix this while its shift is open;
                            once the night is closed and counted it becomes an
                            admin's, and the kitchen screen says so. It has to
                            actually be here, or that sentence is another door
                            that does not open.
                          */}
                          {canVoid && !voided && methods.length > 1 && (
                            <Button size="sm" variant="ghost" onClick={() => setRepaying(p)}>
                              Change method
                            </Button>
                          )}
                          {canVoid && !voided && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => { setVoidReason(''); setVoiding({ payment: p, order: open }); }}
                            >
                              Void
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}

      {moving && (() => {
        const order = moving.order;
        const choices = shiftChoices(order, moving.shifts);
        const to = choices.find((s) => s.$id === moveTo) ?? null;
        const mine = payments.filter((p) => p.order_id === order.$id && isLivePayment(p));
        const from = moving.shifts.find((s) => s.$id === order.shift_id) ?? null;
        const problem = to ? moveProblem(order, to) : null;
        const effects = to ? moveEffects({ from, to, payments: mine }) : null;
        return (
          <Modal
            title="Which shift should this count under?"
            onClose={() => (moveBusy ? undefined : setMoving(null))}
            footer={
              <>
                <Button variant="ghost" onClick={() => setMoving(null)} disabled={moveBusy}>Cancel</Button>
                <Button
                  variant="primary"
                  onClick={() => void doMove()}
                  loading={moveBusy}
                  disabled={!to || !!problem || !moveReason.trim()}
                >
                  Move it
                </Button>
              </>
            }
          >
            <p style={{ marginTop: 0 }}>
              {order.order_no}, {money(order.total)}
              {mine.length > 0 && `, paid ${money(mine.reduce((a, p) => a + p.amount + (p.tip ?? 0), 0))}`}.
              {' '}Currently {from ? `counted under ${from.code}` : 'not counted under any shift'}.
            </p>

            {choices.length === 0 ? (
              <Notice tone="info">
                No other shift on this side within a week either side of this order. If the one you want is
                further back than that, it cannot be picked here.
              </Notice>
            ) : (
              <>
                <Field
                  label="Count it under"
                  hint="Only shifts on the same side of the business — each side keeps its own takings."
                >
                  <Select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                    <option value="">Pick a shift</option>
                    {choices.map((s) => (
                      <option key={s.$id} value={s.$id}>
                        {s.code} · {new Date(s.opened_at).toLocaleString()}
                        {s.status === 'closed' ? ' · closed' : ' · still open'}
                      </option>
                    ))}
                  </Select>
                </Field>

                {problem && <Notice tone="warn">{problem}</Notice>}

                {to && !problem && (
                  <>
                    <p style={{ marginBottom: '0.4rem' }}>
                      <strong>{describeMove(order, from, to)}</strong>
                    </p>
                    <ul className="small" style={{ marginTop: 0 }}>
                      <li>
                        {effects && effects.payments > 0
                          ? `Its ${effects.payments} payment${effects.payments === 1 ? '' : 's'}, `
                            + `${money(effects.amount)} in all, move with it — so the drawer expected to hold `
                            + `that money moves too.`
                          : 'Nothing has been paid on it, so no drawer figures change.'}
                      </li>
                      <li>The sale itself is untouched: same items, same total, same customer, same receipt.</li>
                    </ul>
                    {/* Every one of these is something an admin would otherwise
                        hear about from an accountant. See moveEffects. */}
                    {effects?.warnings.map((w) => (
                      <Notice key={w} tone="warn">{w}</Notice>
                    ))}
                  </>
                )}

                <Field
                  label="Why"
                  hint="Kept against your name. In a year this is the only thing that says whether it was a correction."
                >
                  <Input
                    value={moveReason}
                    placeholder="Bill started before the handover and settled after"
                    onChange={(e) => setMoveReason(e.target.value)}
                  />
                </Field>
              </>
            )}
          </Modal>
        );
      })()}

      {repaying && (
        <Modal
          title="How was this actually paid?"
          onClose={() => (repayBusy ? undefined : setRepaying(null))}
          footer={<Button variant="ghost" onClick={() => setRepaying(null)} disabled={repayBusy}>Cancel</Button>}
        >
          <p style={{ marginTop: 0 }}>
            {money(repaying.amount)}
            {repaying.tip ? ` and a ${money(repaying.tip)} tip` : ''}, currently recorded as{' '}
            <strong>{methods.find((m) => m.$id === repaying.method_id)?.name ?? 'unknown'}</strong>.
          </p>
          <p className="small dim">
            Only where the money went changes; the amount and the order stay as they are. The shift it belongs to is
            worked out again, so the drawer it is counted against moves with it. Recorded against your name.
          </p>
          <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            {methods
              .filter((m) => m.$id !== repaying.method_id)
              .map((m) => (
                <Button key={m.$id} variant="primary" disabled={repayBusy} onClick={() => void moveMethod(m)}>
                  {m.name}
                </Button>
              ))}
          </div>
        </Modal>
      )}

      {voiding && (
        <Modal
          title="Take this payment back out?"
          onClose={() => (voidBusy ? undefined : setVoiding(null))}
          footer={
            <>
              <Button variant="ghost" onClick={() => setVoiding(null)} disabled={voidBusy}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => void doVoid()}
                loading={voidBusy}
                disabled={!voidReason.trim()}
              >
                Void the payment
              </Button>
            </>
          }
        >
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
          <p style={{ marginTop: 0 }}>
            {money(voiding.payment.amount)}
            {voiding.payment.tip ? ` and a ${money(voiding.payment.tip)} tip` : ''}
            {' '}on {voiding.order.order_no}, recorded by {nameOf(voiding.payment.taken_by)} as{' '}
            {methods.find((m) => m.$id === voiding.payment.method_id)?.name ?? 'a payment'}.
          </p>
          {/*
            What actually happens, in the order somebody will notice it.

            The row is not deleted, and saying so plainly matters: a cashier who
            counted a drawer against these figures needs the history to still
            show that money was recorded and then taken back out, rather than
            finding themselves quietly short with nothing to point at.
          */}
          <Notice tone="warn">
            <strong>For money that was never received.</strong> Not for a refund — a refund is money that came in and
            went back out, and belongs on the books as both.
          </Notice>
          <ul className="small" style={{ marginBottom: 0 }}>
            <li>The payment stays on record, marked voided, with your name and reason against it.</li>
            <li>It stops counting towards the takings, so the drawer for that shift is expected to hold that much less.</li>
            <li>{voiding.order.order_no} goes back to owing what this payment covered.</li>
            <li className="dim">
              Journal entries already posted for that shift are not changed. Correct those under Accounting if the
              shift has been closed and posted.
            </li>
          </ul>
          <Field label="Why" hint="Recorded against your name in the audit log.">
            <Input
              value={voidReason}
              autoFocus
              placeholder="Rung up on the wrong table, the customer never paid"
              onChange={(e) => setVoidReason(e.target.value)}
              disabled={voidBusy}
            />
          </Field>
        </Modal>
      )}

      {killing && (
        <Modal
          title={killing.how === 'cancel'
            ? `Cancel ${killing.order.order_no}`
            : `Delete ${killing.order.order_no}`}
          onClose={() => setKilling(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setKilling(null)}>Leave it</Button>
              <Button
                variant="danger"
                loading={killBusy}
                disabled={killing.how === 'cancel' && !killReason.trim()}
                onClick={() => void doKill()}
              >
                {killing.how === 'cancel' ? 'Cancel the order' : 'Delete for good'}
              </Button>
            </>
          }
        >
          {killing.how === 'cancel' ? (
            <>
              <p className="small dim" style={{ marginTop: 0 }}>
                The record stays and stays readable. It stops counting towards the shift, and it comes off
                the list the kitchen sees under “This shift”.
              </p>
              <Field label="Why" hint="Goes on the order and into the audit log. Somebody will ask.">
                <Input value={killReason} onChange={(e) => setKillReason(e.target.value)} />
              </Field>
            </>
          ) : (
            <Notice>
              This removes the order, its items, and <strong>any payments recorded against it</strong>. The
              money comes off the shift with it — leaving a payment behind would mean the takings still
              counted money for an order nobody can open. There is no undo, and nothing keeps a copy.
              <div style={{ marginTop: '0.6rem' }}>
                Cancelling instead keeps the record and still takes it off the shift.
              </div>
            </Notice>
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
            Putting a status back is sometimes the only honest option, an order marked paid that was not, food marked
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
              placeholder="Marked paid by mistake, customer had not paid"
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          {/*
            The warning that used to be a dead end.

            It said to fix the payment separately, and there was no separately:
            nothing in the system could reverse a payment. So it named a step
            nobody could take, and the honest outcome was an order set back to
            unpaid with money it never received still sitting in the takings.
            Now the step exists, and this says where it is.
          */}
          {newPayment !== 'paid' && editing.payment_status === 'paid' && (
            <Notice tone="warn">
              This order has payment records against it. Changing the status here does not touch them, so the money
              stays in the shift it was taken in.
              {' '}
              {canVoid
                ? 'If it was never received, close this and use Void next to the payment in the order’s details — that is what takes it back out of the takings.'
                : 'If it was never received, an admin needs to void the payment itself; that is what takes it back out of the takings.'}
            </Notice>
          )}
        </Modal>
      )}
    </>
  );
}
