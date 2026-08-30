import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Modal, Notice, Spinner, Badge, Input, Field, useToast } from '@snpos/ui';
import { listAll, humanError, db, DB_ID } from '../lib';
import {
  formatMoney, axisMoney, trialBalance, buildReportHtml, openPrintable, downloadUrl,
  toCsv, downloadCsv,
  parseCostAccounts, serialiseCostAccounts, startingCostChoice, hasCostChoice, splitCosts, costCodeFor,
  isLivePayment,
  listCreatedBetween, listByIds, dayStartIso, dayEndIso, windowProblem,
} from '@snpos/core';
import type { Order, OrderItem, Doc, TrialBalanceRow } from '@snpos/core';
import { useSession } from '../session';
import { SideFilter, onSide, narrowSide, type Side } from '../components/SideFilter';
import { Insights } from '../components/Insights';
import { MenuEngineeringPanel } from '../components/MenuEngineering';

interface Payment extends Doc { order_id: string; method_id: string; method_kind_snapshot: string; amount: number; tip: number; shift_id: string; status?: string }
interface PaymentMethod extends Doc { name: string }
interface Expense extends Doc { amount: number; category: string; category_key?: string; module?: 'kitchen' | 'craft' }
interface AccountRow extends Doc { code: string; name: string; type: string; active?: boolean }
interface ExpenseCategoryRow extends Doc { key: string; name: string; account_code?: string }
interface Receipt extends Doc {
  to_email?: string;
  status: 'queued' | 'sent' | 'failed' | 'skipped' | 'bounced';
  last_error?: string;
  sent_at?: string;
}

const SHORTCUTS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 3650, label: 'All time' },
];

/** Local midnight, so "today" means today here rather than in UTC. */
const todayStr = () => new Date().toLocaleDateString('en-CA');
const daysAgoStr = (n: number) => new Date(Date.now() - n * 86400_000).toLocaleDateString('en-CA');

export function ReportsPage() {
  const { settings, profile, refreshSettings } = useSession();
  const toast = useToast();
  // A manager may read the reports; what the headline figure is made of is the
  // owner's decision, not something to change from a screen you are reviewing.
  const isAdmin = profile?.role === 'admin';
  // Today, both ends. The quick ranges beside the dates widen it in one tap.
  // See the note in Orders: "what happened today" is the question actually
  // asked, and a month-long default buries it.
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(todayStr());
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [expenseCategories, setExpenseCategories] = useState<ExpenseCategoryRow[]>([]);
  const [pickingCosts, setPickingCosts] = useState(false);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [tb, setTb] = useState<{ rows: TrialBalanceRow[]; balanced: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [side, setSide] = useState<Side>('all');
  // Their side of the business, not the whole of it. See narrowSide.
  const mine = narrowSide(side, profile, settings);

  /*
    Only the window being reported on.

    This page used to read every order ever taken, every line on every one of
    them, every payment, expense and receipt, and then filter to the chosen
    dates in the browser. That is a year of history read to show a week of it,
    read again each time somebody opens the page, growing by every sale for
    ever — and it is what emptied the database's read allowance one morning
    and stopped the tills.

    The window is the same one `inRange` applied afterwards, sent to the
    database instead, so the figures are unchanged. It re-reads when the dates
    change, which is the point: it is now cheap enough to.

    Lines are fetched by their orders' ids rather than by date, because a line
    has no date of its own — and it is exactly equivalent, since the only use
    of them is against orders already in the window.
  */
  useEffect(() => {
    const bad = windowProblem(from, to);
    if (bad) { setError(bad); return; }
    setError(null);
    (async () => {
      const fromIso = dayStartIso(from);
      const toIso = dayEndIso(to);
      const [o, p, m, e, a, r, ec] = await Promise.all([
        listCreatedBetween<Order>('orders', fromIso, toIso),
        listCreatedBetween<Payment>('payments', fromIso, toIso),
        listAll<PaymentMethod>('payment_methods'),
        listCreatedBetween<Expense>('shift_expenses', fromIso, toIso),
        listAll<AccountRow>('accounts'),
        listCreatedBetween<Receipt>('receipts', fromIso, toIso),
        // An expense names a category; the category names the account. Costs
        // are chosen by account, so the middle step has to be here too.
        listAll<ExpenseCategoryRow>('expense_categories').catch(() => [] as ExpenseCategoryRow[]),
      ]);
      const i = await listByIds<OrderItem>('order_items', 'order_id', o.map((x) => x.$id));
      setOrders(o); setItems(i); setPayments(p); setMethods(m); setExpenses(e); setAccounts(a);
      setReceipts(r); setExpenseCategories(ec);
      setTb(await trialBalance('main').catch(() => null));
    })().catch((err) => setError(humanError(err)));
  }, [from, to]);

  // Both ends, both days included. A report that silently stops at midnight
  // yesterday is one somebody quotes a wrong figure from.
  const since = useMemo(() => new Date(`${from}T00:00:00`), [from]);
  const until = useMemo(() => new Date(`${to}T23:59:59.999`), [to]);
  const inRange = (iso: string) => {
    const d = new Date(iso);
    return d >= since && d <= until;
  };

  const paid = useMemo(
    () => (orders ?? []).filter((o) => o.payment_status === 'paid' && inRange(o.$createdAt) && onSide(o, mine)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orders, since, until, side],
  );
  const periodPayments = useMemo(
    () => {
      // Payments carry no side of their own, they belong to an order, and the
      // order knows. Matched through it rather than stamped twice, so the two
      // can never disagree about which books a payment lands in.
      const mine = new Set(paid.map((o) => o.$id));
      // Voided payments are out: money recorded in error and taken back out was
      // never taken, and leaving it in the method breakdown would report card
      // takings the machine's own statement will not agree with.
      return payments
        .filter(isLivePayment)
        .filter((p) => inRange(p.$createdAt) && (side === 'all' || mine.has(p.order_id)));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [payments, since, until, side, paid],
  );

  const sales = paid.reduce((s, o) => s + o.total, 0);
  const discounts = paid.reduce((s, o) => s + o.discount_total, 0);
  const tips = periodPayments.reduce((s, p) => s + (p.tip ?? 0), 0);
  const spend = expenses
    .filter((e) => inRange(e.$createdAt) && onSide(e, mine))
    .reduce((s, e) => s + e.amount, 0);
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

  /**
   * The same lines as `topItems`, kept by menu item id rather than by name.
   *
   * `topItems` groups by `name_snapshot` because it is a best-seller list and
   * a name is what somebody reads. This one cannot: it is joined to recipes,
   * and two dishes that were both once called "Rice" would be costed as one.
   */
  const soldByItem = useMemo(() => {
    const paidIds = new Set(paid.map((o) => o.$id));
    const acc = new Map<string, { menuItemId: string; name: string; qty: number; revenue: number }>();
    for (const i of items) {
      if (!paidIds.has(i.order_id) || i.status === 'void') continue;
      if (!i.menu_item_id) continue;   // a one-off line has nothing to cost against
      const row = acc.get(i.menu_item_id)
        ?? { menuItemId: i.menu_item_id, name: i.name_snapshot, qty: 0, revenue: 0 };
      row.qty += i.qty;
      row.revenue += i.line_total;
      acc.set(i.menu_item_id, row);
    }
    return [...acc.values()];
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

  /**
   * The two series, from rows already in memory.
   *
   * Deliberately NOT filtered to the visible range: the panel compares this
   * period with the one before it, so it needs the days before `since` too.
   * Filtering here would silently make every comparison read "no earlier data".
   */
  const insightRevenue = useMemo(
    () => (orders ?? [])
      .filter((o) => o.payment_status === 'paid')
      .map((o) => ({ at: o.$createdAt, amount: o.total, covers: o.guest_count || 1 })),
    [orders],
  );
  /**
   * Which accounts the house counts as Costs.
   *
   * Nothing chosen means all of them, which is what this figure did before it
   * was a choice. See hasCostChoice.
   */
  const costCodes = useMemo(
    () => parseCostAccounts(settings?.cost_account_codes),
    [settings?.cost_account_codes],
  );

  /** Every expense with the account it lands on, worked out once. */
  const costed = useMemo(
    () => expenses.map((e) => ({ ...e, code: costCodeFor(e, expenseCategories) })),
    [expenses, expenseCategories],
  );

  const insightCost = useMemo(
    () => costed
      .filter((e) => costCodes.length === 0 || costCodes.includes(e.code))
      .map((e) => ({ at: e.$createdAt, amount: e.amount })),
    [costed, costCodes],
  );

  /**
   * What the choice leaves out of the visible period.
   *
   * Shown on the page, not just subtracted. A headline that quietly excludes
   * money is one somebody eventually compares against the bank and cannot
   * explain, and the explanation is a setting three screens away that they may
   * not have made themselves.
   */
  /**
   * Spent per account in the visible period, for the picker.
   *
   * The whole reason the picker lives on this page: "should rent be in cost of
   * sales" is an abstract question, and "should this GH₵2,400 be in the figure
   * I am reading" is one somebody can actually answer.
   */
  const spentByCode = useMemo(() => {
    const acc = new Map<string, number>();
    for (const e of costed) {
      if (!inRange(e.$createdAt) || !onSide(e, mine)) continue;
      acc.set(e.code, (acc.get(e.code) ?? 0) + e.amount);
    }
    return acc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [costed, since, until, mine]);

  const costSplit = useMemo(
    () => splitCosts(
      costed.filter((e) => inRange(e.$createdAt) && onSide(e, mine)),
      costCodes,
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [costed, costCodes, since, until, mine],
  );

  const accountName = (code: string) => accounts.find((a) => a.code === code)?.name ?? code;
  const methodName = (id: string) => methods.find((m) => m.$id === id)?.name ?? 'Unknown';
  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));
  const tickMoney = (n: number) => (settings ? axisMoney(n, settings) : String(n));

  const periodLabel = `${since.toLocaleDateString()} – ${until.toLocaleDateString()}`;

  /**
   * The report as an A4 document, for saving as a PDF.
   *
   * Built from the same figures the page is showing rather than from the page
   * itself, so what comes out is laid out for paper, and so a column that is
   * cut off on a narrow screen is not cut off in the file somebody files.
   */
  const exportPdf = () => {
    if (!settings) return;
    const gross = sales + discounts;
    const html = buildReportHtml({
      title: 'Sales report',
      restaurantName: settings.restaurant_name,
      period: periodLabel,
      generatedBy: profile?.display_name,
      logoUrl: settings.logo_light_id ? downloadUrl(settings.logo_light_id, 'branding', settings) : undefined,
      brandColor: settings.primary_color,
      stats: [
        { label: 'Sales', value: money(sales), note: `${paid.length} orders · ${covers} covers` },
        { label: 'Average order', value: money(Math.round(sales / paid.length)) },
        {
          label: 'Discounts',
          value: money(discounts),
          note: gross ? `${((discounts / gross) * 100).toFixed(1)}% of gross` : undefined,
        },
        { label: 'Tips', value: money(tips) },
        // Both, and named apart. Expenses is every pesewa that left; Costs is
        // the part the house counts against trading. A report showing one
        // figure that is quietly the other is how a printed page and a screen
        // end up disagreeing.
        { label: 'Expenses', value: money(spend), note: 'everything recorded' },
        ...(hasCostChoice(costCodes)
          ? [{
            label: 'Costs',
            value: money(costSplit.counted),
            note: `${costCodes.length} account${costCodes.length === 1 ? '' : 's'} counted`,
          }]
          : []),
      ],
      tables: [
        {
          title: 'Where the money came from',
          headers: ['Method', 'Taken', 'Share'],
          numeric: [1, 2],
          bars: byMethod.map(([, v]) => (sales ? v / sales : 0)),
          rows: byMethod.map(([id, v]) => [
            methodName(id),
            money(v),
            sales ? `${((v / sales) * 100).toFixed(1)}%` : ', ',
          ]),
        },
        {
          title: 'Best sellers',
          headers: ['Item', 'Sold', 'Revenue'],
          numeric: [1, 2],
          bars: topItems.map((t) => (topItems[0]?.revenue ? t.revenue / topItems[0].revenue : 0)),
          rows: topItems.map((t) => [t.name, String(t.qty), money(t.revenue)]),
          footnote: 'By revenue rather than by count; that is the number that pays the rent.',
        },
        {
          title: 'Busiest hours',
          headers: ['Hour', 'Taken'],
          numeric: [1],
          bars: byHour.filter((h) => h.value > 0).map((h) => h.share),
          rows: byHour
            .filter((h) => h.value > 0)
            .map((h) => [`${String(h.hour).padStart(2, '0')}:00`, money(h.value)]),
        },
      ],
      note: 'Figures cover settled bills only.',
    });
    openPrintable(html, `Sales report ${periodLabel}`);
  };

  /** The same figures as rows somebody can pivot. */
  const exportCsv = () => {
    const rows: string[][] = [
      ['Sales', (sales / 100).toFixed(2)],
      ['Orders', String(paid.length)],
      ['Covers', String(covers)],
      ['Discounts', (discounts / 100).toFixed(2)],
      ['Tips', (tips / 100).toFixed(2)],
      ['Expenses', (spend / 100).toFixed(2)],
      ...(hasCostChoice(costCodes) ? [['Costs', (costSplit.counted / 100).toFixed(2)]] : []),
      [],
      ['Payment method', 'Taken'],
      ...byMethod.map(([id, v]) => [methodName(id), (v / 100).toFixed(2)]),
      [],
      ['Item', 'Sold', 'Revenue'],
      ...topItems.map((t) => [t.name, String(t.qty), (t.revenue / 100).toFixed(2)]),
      [],
      ['Hour', 'Taken'],
      ...byHour.filter((h) => h.value > 0).map((h) => [`${String(h.hour).padStart(2, '0')}:00`, (h.value / 100).toFixed(2)]),
    ];
    downloadCsv(`report-${from}-to-${to}`, toCsv(['Sales report', periodLabel], rows));
  };

  if (error) return <Notice>{error}</Notice>;
  if (!orders) return <Spinner />;

  return (
    <>
      <div className="spread">
        <h1>Reports</h1>
        <div className="row" style={{ gap: '0.5rem' }}>
          {/* Two sides under one roof keep two sets of books, so every figure
              below can be read for one or for the whole business. Placed with
              the export buttons because what you are looking at is what you
              will download. */}
          <SideFilter value={side} onChange={setSide} settings={settings} profile={profile} />
          <Button onClick={exportPdf} disabled={paid.length === 0}>Download PDF</Button>
          <Button onClick={exportCsv} disabled={paid.length === 0}>Spreadsheet</Button>
        </div>
      </div>

      <Card title="Which dates">
        <div className="grid-2">
          <Field label="From">
            <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To" hint="Both days included.">
            <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <div className="row row-wrap" style={{ gap: '0.4rem' }}>
          {SHORTCUTS.map(({ days, label }) => (
            <Button
              key={days}
              size="sm"
              onClick={() => { setFrom(daysAgoStr(days)); setTo(todayStr()); }}
            >
              {label}
            </Button>
          ))}
        </div>
      </Card>

      {paid.length === 0 ? (
        <Card><Empty title="No paid orders in this period">Figures appear once bills start being settled on the terminal.</Empty></Card>
      ) : (
        <>
          {/* The comparisons come first. A total on its own gets read as
              whatever mood the reader arrived in; the same total next to last
              period's is the thing you can act on. */}
          <Insights
            revenue={insightRevenue}
            cost={insightCost}
            from={since}
            to={until}
            money={money}
            tickMoney={tickMoney}
          />

          {/*
            Then the menu itself, dish by dish.

            After the trend and before the plumbing: the trend says whether the
            month was good, this says which dishes made it so and which are
            being carried. It is the only thing on this page that names
            something to change rather than something that happened.
          */}
          <MenuEngineeringPanel sold={soldByItem} money={money} side={side} />

          {/*
            What Costs is made of, next to the figure it explains.

            Deliberately not buried in Settings. Somebody querying this number
            is looking at it right now, and the answer to "why is that so low"
            should be within reach of the thing that raised the question.
          */}
          <Card>
            <div className="spread" style={{ alignItems: 'flex-start', gap: '0.8rem' }}>
              <div style={{ minWidth: 0 }}>
                <strong>Costs counts {hasCostChoice(costCodes) ? `${costCodes.length} account${costCodes.length === 1 ? '' : 's'}` : 'every expense'}.</strong>
                <div className="small dim" style={{ marginTop: '0.2rem', maxWidth: '44rem' }}>
                  {hasCostChoice(costCodes)
                    ? costCodes.map(accountName).join(', ')
                    : 'Rent, equipment and the owner’s drawings are in there with the market run. '
                      + 'Choose the accounts that move with how much you sold, and the comparison against last month starts meaning something.'}
                </div>
                {costSplit.excludedCount > 0 && (
                  <div className="small" style={{ marginTop: '0.4rem', color: 'var(--warn)' }}>
                    {money(costSplit.excluded)} of recorded spending is left out of Costs this period
                    {' '}({costSplit.excludedCount} expense{costSplit.excludedCount === 1 ? '' : 's'}):
                    {' '}{costSplit.excludedByCode.slice(0, 4).map((x) => `${accountName(x.code)} ${money(x.amount)}`).join(', ')}
                    {costSplit.excludedByCode.length > 4 && `, and ${costSplit.excludedByCode.length - 4} more`}.
                    {' '}It is still on the profit and loss.
                  </div>
                )}
              </div>
              {isAdmin && <Button onClick={() => setPickingCosts(true)}>Choose accounts</Button>}
            </div>
          </Card>

          <div className="grid-2">
            <Card title="Discounts given"><p style={{ margin: 0, fontSize: '1.7rem', fontWeight: 650 }}>{money(discounts)}</p><span className="dim small">{sales ? ((discounts / (sales + discounts)) * 100).toFixed(1) : '0'}% of gross</span></Card>
            <Card title="Covers"><p style={{ margin: 0, fontSize: '1.7rem', fontWeight: 650 }}>{covers}</p><span className="dim small">{paid.length} bills · {money(paid.length ? Math.round(sales / covers) : 0)} a head</span></Card>
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
                <Badge tone="danger">Out of balance, tell Claude</Badge>
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

      {pickingCosts && (
        <CostAccountPicker
          accounts={accounts}
          chosen={costCodes}
          spentByCode={spentByCode}
          money={money}
          onClose={() => setPickingCosts(false)}
          onSave={async (codes) => {
            if (!settings) return;
            await db.updateDocument(DB_ID, 'settings', settings.$id, {
              cost_account_codes: serialiseCostAccounts(codes),
            });
            // Pulled back through the session rather than left for a reload:
            // the whole point of choosing here is to see the figure change.
            await refreshSettings();
            setPickingCosts(false);
            toast('Saved');
          }}
        />
      )}
    </>
  );
}

/**
 * Choosing what Costs is made of.
 *
 * Every expense account, with what has actually been spent on each in the
 * period being looked at. That column is the point of doing this here rather
 * than in a settings screen: "should rent be in my cost of sales" is an
 * abstract question, and "should this GH₵2,400 be in the figure I am reading"
 * is one somebody can answer.
 *
 * Only expense accounts are offered. Costs is a figure about spending, and
 * offering the cash account as something to add to it is offering a way to
 * produce a number that means nothing.
 */
function CostAccountPicker({
  accounts, chosen, spentByCode, money, onClose, onSave,
}: {
  accounts: AccountRow[];
  chosen: string[];
  spentByCode: Map<string, number>;
  money: (n: number) => string;
  onClose: () => void;
  onSave: (codes: string[]) => Promise<void>;
}) {
  const options = useMemo(
    () => accounts
      .filter((a) => a.type === 'expense')
      .sort((a, b) => a.code.localeCompare(b.code)),
    [accounts],
  );
  const allCodes = useMemo(() => options.map((a) => a.code), [options]);

  // Everything ticked when nobody has chosen yet, because that is what the
  // figure has been showing. An admin who came to remove rent should find rent
  // ticked and untick it, not rebuild their own books from an empty list.
  const [picked, setPicked] = useState<string[]>(() => startingCostChoice(allCodes, chosen));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (code: string) =>
    setPicked((p) => (p.includes(code) ? p.filter((c) => c !== code) : [...p, code]));

  const total = picked.reduce((s, c) => s + (spentByCode.get(c) ?? 0), 0);
  const left = allCodes.filter((c) => !picked.includes(c)).reduce((s, c) => s + (spentByCode.get(c) ?? 0), 0);

  const save = async () => {
    /*
      Everything ticked is stored as no choice at all.

      The two mean the same thing today, and they stop meaning the same thing
      the moment somebody adds an account: a stored list would leave the new
      account silently outside Costs, while "no choice" keeps counting
      everything, which is what the person who ticked every box meant.
    */
    const codes = picked.length === allCodes.length ? [] : picked;
    if (picked.length === 0) {
      setError('Tick at least one account, or Costs would always read zero.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(codes);
    } catch (e) {
      setError(humanError(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="What counts as Costs?"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy}>Save</Button>
        </>
      }
    >
      {error && <div style={{ marginBottom: '0.8rem' }}><Notice>{error}</Notice></div>}

      <p className="small dim" style={{ marginTop: 0 }}>
        Tick the accounts that should add up to the Costs figure. The amounts are what you actually spent on each in
        the dates you are looking at. Everything you leave out stays on the profit and loss; it just stops being part
        of this one headline.
      </p>

      <div className="row" style={{ gap: '0.4rem', marginBottom: '0.6rem' }}>
        <Button size="sm" onClick={() => setPicked(allCodes)}>Tick all</Button>
        <Button size="sm" onClick={() => setPicked([])}>Untick all</Button>
      </div>

      {options.length === 0 ? (
        <Notice>There are no expense accounts yet. Add them under Expenses → Accounts.</Notice>
      ) : (
        <div style={{ maxHeight: '46vh', overflowY: 'auto' }}>
          {options.map((a) => (
            <label
              key={a.code}
              className="check-row"
              style={{
                display: 'flex', justifyContent: 'space-between', gap: '0.6rem',
                padding: '0.45rem 0', borderBottom: '1px solid var(--border)',
              }}
            >
              <span style={{ minWidth: 0 }}>
                <input type="checkbox" checked={picked.includes(a.code)} onChange={() => toggle(a.code)} />{' '}
                {a.name}
                <span className="dim small"> · {a.code}</span>
                {a.active === false && <Badge tone="warn"> archived</Badge>}
              </span>
              <span className={spentByCode.get(a.code) ? undefined : 'dim'}>
                {money(spentByCode.get(a.code) ?? 0)}
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="spread" style={{ marginTop: '0.8rem', fontWeight: 600 }}>
        <span>Costs would read</span>
        <span>{money(total)}</span>
      </div>
      {left > 0 && (
        <div className="spread small dim">
          <span>Left out, still on the profit and loss</span>
          <span>{money(left)}</span>
        </div>
      )}
    </Modal>
  );
}

/**
 * Whether the emails actually went out.
 *
 * Sending is done by a function you cannot watch, so a receipt that fails would
 * otherwise be invisible, the customer just never gets it. The provider's own
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
                    <td className="small">{r.to_email || '-'}</td>
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
