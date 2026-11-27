import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Empty, Notice, Spinner, useToast } from '@snpos/ui';
import {
  loadStaffCharges, loadSettlements, listAll, loadBooked, bookedItems, bookedList, bookedStage, inWords, releaseBooked,
  displayOrderNo, subscribeCollection,
} from '@snpos/core';
import type { StaffCharge, StaffSettlement, StaffProfile, Order, OrderItem } from '@snpos/core';
import { HubTabs, HubTitle } from '../components/Hub';
import { HiveExport } from '../components/HiveExport';
import { HiveMatching } from '../components/HiveMatching';
import { DeductionsReportModal } from '../components/DeductionsReport';
import { useSession, useMoney } from '../session';
import { humanError } from '../lib';

/**
 * Differences › Deductions & HIVE: the deductions report for any days, and
 * the month's final deductions for HIVE. An auditor prepares the file; only
 * an admin marks it as sent, after which nothing in it can be taken back.
 */
export function DeductionsHivePage() {
  const { settings, profile } = useSession();
  const money = useMoney();
  const [charges, setCharges] = useState<StaffCharge[] | null>(null);
  const [settlements, setSettlements] = useState<StaffSettlement[]>([]);
  const [report, setReport] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    try {
      const rows = await loadStaffCharges('main');
      setCharges(rows);
      setSettlements(await loadSettlements(rows.map((c) => c.$id)));
    } catch (e) {
      setError(humanError(e));
      setCharges([]);
    }
  };
  useEffect(() => { void load(); }, []);

  return (
    <>
      <div className="spread">
        <h1><HubTitle>Deductions &amp; HIVE</HubTitle></h1>
        <Button variant="primary" disabled={!charges} onClick={() => setReport(true)}>Deductions report</Button>
      </div>
      <HubTabs />
      {error && <Notice>{error}</Notice>}
      <Card title="Deductions report">
        <p style={{ margin: 0 }}>
          What each person has been charged for shortages over any days you choose, deducted or not yet final, with
          counts nobody has approved kept apart. For one person or everyone, as a PDF or a spreadsheet.
        </p>
      </Card>
      {charges === null ? <Spinner /> : <HiveExport onChanged={() => void load()} />}
      {charges && charges.length === 0 && (
        <Card><Empty title="No deductions yet">Final deductions show here, by month, ready for HIVE.</Empty></Card>
      )}
      {report && charges && (
        <DeductionsReportModal
          charges={charges}
          settlements={settlements}
          personId=""
          business={settings?.restaurant_name ?? ''}
          madeBy={profile ? `${profile.display_name} (${profile.role})` : undefined}
          money={money}
          decimals={settings?.currency_decimals ?? 2}
          onClose={() => setReport(false)}
        />
      )}
    </>
  );
}

/** Staff › HIVE matching: each person matched once to their HIVE record. */
export function HiveMatchingPage() {
  const [rows, setRows] = useState<StaffProfile[] | null>(null);
  const load = async () => setRows(await listAll<StaffProfile>('staff_profiles').catch(() => [] as StaffProfile[]));
  useEffect(() => { void load(); }, []);
  return (
    <>
      <h1><HubTitle>HIVE matching</HubTitle></h1>
      <HubTabs />
      {!rows ? <Spinner /> : rows.length === 0
        ? <Card><Empty title="No staff yet">Add people on the People tab first.</Empty></Card>
        : <HiveMatching rows={rows} onSaved={load} />}
    </>
  );
}

const hm = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--';

/**
 * Bookings › Pre-orders: today's and tomorrow's, with when the kitchen starts
 * each. The same list as the till's Booked tab, so the office sees what is
 * coming without walking to the till. Send to kitchen now is here too, for
 * an order the server has not released.
 */
export function PreordersPage() {
  const money = useMoney();
  const toast = useToast();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [items, setItems] = useState<Record<string, OrderItem[]>>({});
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const rows = await loadBooked('main');
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
    void load();
    const tick = window.setInterval(() => setNow(new Date()), 30_000);
    const again = window.setInterval(() => void load(), 60_000);
    const off = subscribeCollection<Order>('orders', (o) => { if (o.is_preorder || o.status === 'SCHEDULED') void load(); });
    return () => { window.clearInterval(tick); window.clearInterval(again); off(); };
  }, []);

  const list = useMemo(() => bookedList(orders ?? [], now), [orders, now]);

  const send = async (o: Order) => {
    setBusy(o.$id);
    setError(null);
    try {
      const sent = await releaseBooked(o.$id, 'office');
      toast(sent ? `${displayOrderNo(o.order_no)} sent to the kitchen` : `${displayOrderNo(o.order_no)} was already in the kitchen`);
      await load();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  };

  const row = (o: Order, tomorrow = false) => {
    const stage = bookedStage(o, now.getTime());
    const start = o.fire_at ? Date.parse(o.fire_at) : NaN;
    const who = o.customer_name || o.group_contact_name || 'Pre-order';
    const lines = items[o.$id] ?? [];
    return (
      <div key={o.$id} className="follow-row">
        <div>
          <b>For {hm(o.scheduled_for)} · {who}</b>
          <div className="small dim">
            {displayOrderNo(o.order_no)}{o.fulfilment === 'takeaway' ? ' · Pickup' : o.fulfilment === 'delivery' ? ' · Delivery' : ''}
            {typeof o.total === 'number' ? ` · ${money(o.total)}` : ''}
            {lines.length ? ` · ${lines.map((l) => `${l.qty} ${l.name_snapshot}`).join(', ')}` : ''}
          </div>
        </div>
        <div className="acts">
          {stage === 'booked' && <Badge>{tomorrow ? `Kitchen starts it tomorrow at ${hm(o.fire_at)}` : `Kitchen starts it at ${hm(o.fire_at)} · in ${inWords(start - now.getTime())}`}</Badge>}
          {stage === 'soon' && <Badge tone="warn">Kitchen starts it in {inWords(start - now.getTime())}</Badge>}
          {stage === 'due' && <Badge tone="warn">Going to the kitchen now</Badge>}
          {stage === 'late' && <Badge tone="danger">Should have gone at {hm(o.fire_at)}</Badge>}
          {stage === 'sent' && <Badge tone="ok">In the kitchen since {hm(o.fired_at || o.fire_at)}</Badge>}
          {stage !== 'sent' && !o.group_booking_id && (
            <Button size="sm" variant={stage === 'late' ? 'danger' : 'default'} loading={busy === o.$id} onClick={() => void send(o)}>
              Send to kitchen now
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <h1><HubTitle>Pre-orders</HubTitle></h1>
      <HubTabs />
      {error && <Notice>{error}</Notice>}
      <Card pad={false}>
        {!orders ? <div className="card-pad"><Spinner /></div> : list.today.length === 0 && list.tomorrow.length === 0 ? (
          <Empty title="Nothing booked for today or tomorrow">Pre-orders show here as soon as they are placed.</Empty>
        ) : (
          <>
            {list.today.length > 0 && <div className="card-pad small dim" style={{ paddingBottom: 0 }}>TODAY</div>}
            {list.today.map((o) => row(o))}
            {list.tomorrow.length > 0 && <div className="card-pad small dim" style={{ paddingBottom: 0 }}>TOMORROW</div>}
            {list.tomorrow.map((o) => row(o, true))}
          </>
        )}
      </Card>
    </>
  );
}
