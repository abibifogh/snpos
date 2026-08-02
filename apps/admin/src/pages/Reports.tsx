import { useEffect, useMemo, useState } from 'react';
import { Card, Empty, Notice, Spinner, Badge, Select, Field } from '@snpos/ui';
import { listAll, humanError } from '../lib';
import { formatMoney, trialBalance } from '@snpos/core';
import type { Order, OrderItem, Doc, TrialBalanceRow } from '@snpos/core';
import { useSession } from '../session';

interface Payment extends Doc { order_id: string; method_id: string; method_kind_snapshot: string; amount: number; tip: number; shift_id: string }
interface PaymentMethod extends Doc { name: string }
interface Expense extends Doc { amount: number; category: string }
interface AccountRow extends Doc { code: string; name: string; type: string }
interface Receipt extends Doc {
  to_email?: string;
  status: 'queued' | 'sent' | 'failed' | 'skipped' | 'bounced';
  last_error?: string;
  sent_at?: string;
}

const RANGES = [
  { v: 7, l: 'Last 7 days' },
  { v: 30, l: 'Last 30 days' },
  { v: 90, l: 'Last 90 days' },
  { v: 3650, l: 'All time' },
];

export function ReportsPage() {
  const { settings } = useSession();
  const [days, setDays] = useState(30);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [tb, setTb] = useState<{ rows: TrialBalanceRow[]; balanced: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [o, i, p, m, e, a, r] = await Promise.all([
        listAll<Order>('orders'),
        listAll<OrderItem>('order_items'),
        listAll<Payment>('payments'),
        listAll<PaymentMethod>('payment_methods'),
        listAll<Expense>('shift_expenses'),
        listAll<AccountRow>('accounts'),
        listAll<Receipt>('receipts'),
      ]);
      setOrders(o); setItems(i); setPayments(p); setMethods(m); setExpenses(e); setAccounts(a);
      setReceipts(r);
      setTb(await trialBalance('main').catch(() => null));
    })().catch((err) => setError(humanError(err)));
  }, []);

  const since = useMemo(() => new Date(Date.now() - days * 86400_000), [days]);

  const paid = useMemo(
    () => (orders ?? []).filter((o) => o.payment_status === 'paid' && new Date(o.$createdAt) >= since),
    [orders, since],
  );
  const periodPayments = useMemo(
    () => payments.filter((p) => new Date(p.$createdAt) >= since),
    [payments, since],
  );

  const sales = paid.reduce((s, o) => s + o.total, 0);
  const discounts = paid.reduce((s, o) => s + o.discount_total, 0);
  const tips = periodPayments.reduce((s, p) => s + (p.tip ?? 0), 0);
  const spend = expenses.filter((e) => new Date(e.$createdAt) >= since).reduce((s, e) => s + e.amount, 0);
  const covers = paid.reduce((s, o) => s + (o.guest_count || 1), 0);

  /** Best sellers by revenue, which is the number that pays the rent. */
  const topItems = useMemo(() => {
    const paidIds = new Set(paid.map((o) => o.$id));
    const acc = new Map<string, { name: string; qty: number; revenue: number }>();
    for (const i of items) {
      if (!paidIds.has(i.order_id) || i.status === 'void') continue;
      const row = acc.get(i.name_snapshot) ?? { name: i.name_snapshot, qty: 0, revenue: 0 };
      row.qty += i.qty;
      row.revenue += i.line_total;
      acc.set(i.name_snapshot, row);
    }
    return [...acc.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  }, [items, paid]);

  const byMethod = useMemo(() => {
    const acc = new Map<string, number>();
    for (const p of periodPayments) acc.set(p.method_id, (acc.get(p.method_id) ?? 0) + p.amount);
    return [...acc.entries()].sort((a, b) => b[1] - a[1]);
  }, [periodPayments]);

  /** Busiest hours, for rostering rather than guesswork. */
  const byHour = useMemo(() => {
    const hours = new Array(24).fill(0) as number[];
    for (const o of paid) hours[new Date(o.$createdAt).getHours()] += o.total;
    const peak = Math.max(...hours, 1);
    return hours.map((v, h) => ({ hour: h, value: v, share: v / peak }));
  }, [paid]);

  const accountName = (code: string) => accounts.find((a) => a.code === code)?.name ?? code;
  const methodName = (id: string) => methods.find((m) => m.$id === id)?.name ?? 'Unknown';
  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));

  if (error) return <Notice>{error}</Notice>;
  if (!orders) return <Spinner />;

  return (
    <>
      <div className="spread">
        <h1>Reports</h1>
        <Field>
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {RANGES.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}
          </Select>
        </Field>
      </div>

      {paid.length === 0 ? (
        <Card><Empty title="No paid orders in this period">Figures appear once bills start being settled on the terminal.</Empty></Card>
      ) : (
        <>
          <div className="grid-2">
            <Card title="Sales"><p style={{ margin: 0, fontSize: '1.7rem', fontWeight: 650 }}>{money(sales)}</p><span className="dim small">{paid.length} orders · {covers} covers</span></Card>
            <Card title="Average order"><p style={{ margin: 0, fontSize: '1.7rem', fontWeight: 650 }}>{money(Math.round(sales / paid.length))}</p><span className="dim small">per bill</span></Card>
            <Card title="Discounts given"><p style={{ margin: 0, fontSize: '1.7rem', fontWeight: 650 }}>{money(discounts)}</p><span className="dim small">{sales ? ((discounts / (sales + discounts)) * 100).toFixed(1) : '0'}% of gross</span></Card>
            <Card title="Expenses"><p style={{ margin: 0, fontSize: '1.7rem', fontWeight: 650 }}>{money(spend)}</p><span className="dim small">recorded in this period</span></Card>
          </div>

          <Card title="Where the money came from">
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Method</th><th className="num">Taken</th><th className="num">Share</th></tr></thead>
                <tbody>
                  {byMethod.map(([id, amount]) => (
                    <tr key={id}>
                      <td>{methodName(id)}</td>
                      <td className="num">{money(amount)}</td>
                      <td className="num dim">{sales ? ((amount / sales) * 100).toFixed(0) : 0}%</td>
                    </tr>
                  ))}
                  {tips > 0 && (
                    <tr><td className="dim">Tips (not sales)</td><td className="num">{money(tips)}</td><td /></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Best sellers">
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Dish</th><th className="num">Sold</th><th className="num">Revenue</th></tr></thead>
                <tbody>
                  {topItems.map((t) => (
                    <tr key={t.name}>
                      <td>{t.name}</td>
                      <td className="num dim">{t.qty}</td>
                      <td className="num">{money(t.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Busiest hours">
            <p className="small dim" style={{ marginTop: 0 }}>Sales by hour of day. Useful for deciding who to roster and when.</p>
            {byHour.filter((h) => h.value > 0).map((h) => (
              <div className="row" key={h.hour} style={{ gap: '0.6rem', padding: '0.15rem 0' }}>
                <span className="small dim" style={{ width: '3rem' }}>{String(h.hour).padStart(2, '0')}:00</span>
                <div style={{ flex: 1, background: 'var(--surface-2)', borderRadius: 4, height: 14 }}>
                  <div style={{ width: `${h.share * 100}%`, background: 'var(--brand)', height: '100%', borderRadius: 4 }} />
                </div>
                <span className="small" style={{ width: '5.5rem', textAlign: 'right' }}>{money(h.value)}</span>
              </div>
            ))}
          </Card>
        </>
      )}

      <Card title="Accounts">
        {!tb ? (
          <Spinner />
        ) : tb.rows.length === 0 ? (
          <p className="small dim" style={{ margin: 0 }}>
            Nothing posted yet. The ledger fills up as shifts are closed on the terminal.
          </p>
        ) : (
          <>
            <div style={{ marginBottom: '0.7rem' }}>
              {tb.balanced ? (
                <Badge tone="ok">Balanced</Badge>
              ) : (
                <Badge tone="danger">Out of balance — tell Claude</Badge>
              )}
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
                <tbody>
                  {tb.rows.map((r) => (
                    <tr key={r.account_code}>
                      <td><span className="dim">{r.account_code}</span> {accountName(r.account_code)}</td>
                      <td className="num">{money(r.debit)}</td>
                      <td className="num">{money(r.credit)}</td>
                      <td className="num">{money(Math.abs(r.balance))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <EmailPanel receipts={receipts} />
    </>
  );
}

/**
 * Whether the emails actually went out.
 *
 * Sending is done by a function you cannot watch, so a receipt that fails would
 * otherwise be invisible — the customer just never gets it. The provider's own
 * rejection message is shown as it came back, because that message is usually
 * the whole answer (an unverified sender address, most often).
 */
function EmailPanel({ receipts }: { receipts: Receipt[] }) {
  const recent = [...receipts].sort((a, b) => b.$createdAt.localeCompare(a.$createdAt)).slice(0, 15);
  const failed = receipts.filter((r) => r.status === 'failed' || r.status === 'bounced').length;

  return (
    <Card title="Emailed receipts">
      {recent.length === 0 ? (
        <Empty title="No receipts sent yet">
          A receipt is created whenever a bill is settled and the customer gave an email address.
        </Empty>
      ) : (
        <>
          {failed > 0 && (
            <div style={{ marginBottom: '0.7rem' }}>
              <Notice>
                {failed} {failed === 1 ? 'receipt has' : 'receipts have'} failed to send. The reason from the email
                provider is in the last column.
              </Notice>
            </div>
          )}
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>When</th><th>To</th><th>Status</th><th>Detail</th></tr></thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.$id}>
                    <td className="dim small">{new Date(r.$createdAt).toLocaleString()}</td>
                    <td className="small">{r.to_email || '—'}</td>
                    <td>
                      <Badge tone={r.status === 'sent' ? 'ok' : r.status === 'failed' || r.status === 'bounced' ? 'danger' : 'warn'}>
                        {r.status}
                      </Badge>
                    </td>
                    <td className="small dim">{r.last_error || (r.status === 'sent' ? 'Delivered to the provider' : '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
