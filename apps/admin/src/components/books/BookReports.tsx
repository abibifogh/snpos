import { useMemo, useState } from 'react';
import { Button, Card, Empty, Field, Input, Segmented, Select } from '@snpos/ui';
import {
  plTable, previousPeriod, sameLastYear, changeShare, generalLedger, cashFlow, CASH_CODES,
  writeXlsx, XLSX_TYPE, downloadFile, buildReportHtml, openPrintable, totalsByAccount, naturalBalance,
  profitAndLoss, balanceSheet, within, isClosingEntry,
} from '@snpos/core';
import type {
  AccountRow, JournalEntry, JournalLine, Settings, PlBy, PlTable, PostedLine, Cell, Sheet, ReportTable,
} from '@snpos/core';

/*
  The reports an accountant asks for, on screen and as files: the profit and
  loss in columns with a comparison, the general ledger of any account, the
  cash flow, and the whole year as one workbook. The arithmetic is in
  packages/core/src/ledger-reports.ts.
*/

export type Lines = (JournalLine & { date: string })[];
type Compare = 'none' | 'previous' | 'lastyear';

/** Entries reports must not count: the year-end close. */
export const closingEntries = (entries: JournalEntry[]): Set<string> =>
  new Set(entries.filter(isClosingEntry).map((e) => e.$id));

/** Money as a spreadsheet number: cedis, not pesewas. */
const major = (n: number, decimals: number) => Math.round(n) / 10 ** decimals;

const pct = (s: number | null) => (s === null ? '' : `${s > 0 ? '+' : ''}${(s * 100).toFixed(1)}%`);

function save(name: string, sheets: Sheet[]) {
  downloadFile(name, writeXlsx(sheets).buffer as ArrayBuffer, XLSX_TYPE);
}

function printable(settings: Settings | null, title: string, period: string, tables: ReportTable[], note?: string) {
  openPrintable(buildReportHtml({
    title,
    restaurantName: settings?.restaurant_name ?? '',
    period,
    stats: [],
    tables,
    note,
    brandColor: settings?.primary_color ?? undefined,
  }), `${title} ${period}`);
}

/* ----------------------------------------------------------- profit and loss */

function plSheet(t: PlTable, decimals: number, compareLabel?: string): Cell[][] {
  const head = ['Code', 'Account', ...(t.columns.length > 1 ? [...t.columns, 'Total'] : ['Amount']), ...(t.compare ? [compareLabel ?? 'Compare', 'Change'] : [])];
  const row = (r: PlTable['income'][number]): Cell[] => [
    r.code, r.name,
    ...(t.columns.length > 1 ? [...r.cells, r.total] : [r.total]).map((v) => major(v, decimals)),
    ...(t.compare ? [major(r.compare ?? 0, decimals), pct(changeShare(r.total, r.compare ?? 0))] : []),
  ];
  const tot = (label: string, vals: number[], cmp?: number): Cell[] => [
    '', label,
    ...(t.columns.length > 1 ? vals : [vals[vals.length - 1]]).map((v) => major(v, decimals)),
    ...(t.compare ? [major(cmp ?? 0, decimals), pct(changeShare(vals[vals.length - 1], cmp ?? 0))] : []),
  ];
  return [
    head,
    ['', 'Income'], ...t.income.map(row), tot('Total income', t.incomeTotals, t.compare?.income),
    ['', 'Costs'], ...t.costs.map(row), tot('Total costs', t.costTotals, t.compare?.costs),
    tot('Profit for the period', t.profit, t.compare?.profit),
  ];
}

/**
 * The profit and loss, in one column, a column per department or per month,
 * with a comparison when asked. Each line still opens its postings.
 */
export function PlReport({
  accounts, lines, entries, from, to, money, settings, onOpen,
}: {
  accounts: AccountRow[];
  lines: Lines;
  entries: JournalEntry[];
  from: string;
  to: string;
  money: (n: number) => string;
  settings: Settings | null;
  onOpen: (l: { code: string; name: string; type: AccountRow['type']; amount: number }) => void;
}) {
  const [by, setBy] = useState<PlBy>('single');
  const [compare, setCompare] = useState<Compare>('none');
  const decimals = settings?.currency_decimals ?? 2;
  const exclude = useMemo(() => closingEntries(entries), [entries]);
  const window2 = compare === 'previous' ? previousPeriod(from, to) : compare === 'lastyear' ? sameLastYear(from, to) : null;
  const t = useMemo(() => plTable(accounts, lines as PostedLine[], {
    by, from, to, exclude,
    compareLines: window2 ? (within(lines, window2.from, window2.to) as PostedLine[]) : undefined,
  }), [accounts, lines, by, from, to, exclude, window2?.from, window2?.to]);
  const multi = t.columns.length > 1;
  const cmpLabel = window2 ? `${window2.from} to ${window2.to}` : '';
  const period = `${from} to ${to}`;

  const cells = (vals: number[], cmp?: number, strong = false) => {
    const total = vals[vals.length - 1];
    const style = strong ? { fontWeight: 650 } : undefined;
    return (
      <>
        {multi && vals.slice(0, -1).map((v, i) => <td key={i} className="num" style={style}>{v ? money(v) : '–'}</td>)}
        <td className="num" style={style}>{money(total)}</td>
        {t.compare && (
          <>
            <td className="num dim" style={style}>{money(cmp ?? 0)}</td>
            <td className="num small dim">{pct(changeShare(total, cmp ?? 0))}</td>
          </>
        )}
      </>
    );
  };
  const span = 1 + (multi ? t.columns.length + 1 : 1) + (t.compare ? 2 : 0);

  return (
    <Card title={`Profit and loss · ${period}`} pad>
      <div className="row row-wrap" style={{ gap: '0.5rem', alignItems: 'center', marginBottom: '0.8rem' }}>
        <Segmented<PlBy>
          value={by}
          onChange={setBy}
          ariaLabel="Columns"
          options={[{ value: 'single', label: 'One column' }, { value: 'department', label: 'By department' }, { value: 'month', label: 'By month' }]}
        />
        <Select value={compare} onChange={(e) => setCompare(e.target.value as Compare)} aria-label="Compare with">
          <option value="none">No comparison</option>
          <option value="previous">Compare: period before</option>
          <option value="lastyear">Compare: same dates last year</option>
        </Select>
        <Button size="sm" onClick={() => save(`Profit and loss ${period}.xlsx`, [{ name: 'Profit and loss', rows: plSheet(t, decimals, cmpLabel) }])}>Excel</Button>
        <Button
          size="sm"
          onClick={() => printable(settings, 'Profit and loss', period, [{
            title: 'Profit and loss',
            headers: plSheet(t, decimals, cmpLabel)[0].slice(1).map(String),
            rows: plSheet(t, decimals, cmpLabel).slice(1).map((r) => r.slice(1).map((v) => (typeof v === 'number' ? money(Math.round(v * 10 ** decimals)) : String(v ?? '')))),
            numeric: plSheet(t, decimals, cmpLabel)[0].slice(2).map((_, i) => i + 1),
          }], by === 'department' ? 'Sales and cost of sales split exactly by department; everything else is Shared.' : undefined)}
        >
          PDF
        </Button>
      </div>
      {t.income.length === 0 && t.costs.length === 0 ? (
        <Empty title="Nothing in this period">Close a shift, or widen the dates.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Account</th>
                {multi && t.columns.map((c) => <th key={c} className="num">{c}</th>)}
                <th className="num">{multi ? 'Total' : 'Amount'}</th>
                {t.compare && <><th className="num">{cmpLabel}</th><th className="num">Change</th></>}
              </tr>
            </thead>
            <tbody>
              <tr><td colSpan={span} style={{ fontWeight: 650 }}>Income</td></tr>
              {t.income.map((r) => (
                <tr key={r.code} onClick={() => onOpen({ code: r.code, name: r.name, type: r.type, amount: r.total })} style={{ cursor: 'pointer' }} title="See the postings behind this">
                  <td>{r.name}</td>{cells([...r.cells, r.total], r.compare)}
                </tr>
              ))}
              <tr><td style={{ fontWeight: 600 }}>Total income</td>{cells(t.incomeTotals, t.compare?.income, true)}</tr>
              <tr><td colSpan={span} style={{ fontWeight: 650, paddingTop: '1rem' }}>Costs</td></tr>
              {t.costs.map((r) => (
                <tr key={r.code} onClick={() => onOpen({ code: r.code, name: r.name, type: r.type, amount: r.total })} style={{ cursor: 'pointer' }} title="See the postings behind this">
                  <td>{r.name}</td>{cells([...r.cells, r.total], r.compare)}
                </tr>
              ))}
              <tr><td style={{ fontWeight: 600 }}>Total costs</td>{cells(t.costTotals, t.compare?.costs, true)}</tr>
              <tr>
                <td style={{ fontWeight: 700, paddingTop: '1rem' }}>{t.profit[t.profit.length - 1] < 0 ? 'Loss for the period' : 'Profit for the period'}</td>
                {cells(t.profit, t.compare?.profit, true)}
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <p className="small dim" style={{ marginBottom: 0 }}>
        {by === 'department'
          ? 'Sales and cost of sales post to each department’s own accounts, so they split exactly. Rent, wages and other overheads belong to the whole business and sit under Shared.'
          : 'Press any line to see the postings behind it. Profit is not cash: see Cash flow for where the money went.'}
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------ general ledger */

const memoOf = (entries: Map<string, JournalEntry>) => (l: PostedLine) => {
  const e = entries.get(l.entry_id);
  return [e?.memo, l.memo && l.memo !== e?.memo ? l.memo : ''].filter(Boolean).join(' · ');
};

function ledgerSheet(accounts: AccountRow[], lines: Lines, entries: JournalEntry[], from: string, to: string, decimals: number, only?: string): Cell[][] {
  const byId = new Map(entries.map((e) => [e.$id, e]));
  const rows: Cell[][] = [['Code', 'Account', 'Date', 'Entry', 'What', 'Debit', 'Credit', 'Balance']];
  for (const a of accounts) {
    if (only && a.code !== only) continue;
    const g = generalLedger(a, lines as PostedLine[], { from, to, memoOf: memoOf(byId) });
    if (g.rows.length === 0 && g.opening === 0) continue;
    rows.push([a.code, a.name, from, '', 'Brought forward', null, null, major(g.opening, decimals)]);
    for (const r of g.rows) {
      rows.push([a.code, a.name, r.date.slice(0, 10), r.entry_id, r.memo, r.debit ? major(r.debit, decimals) : null, r.credit ? major(r.credit, decimals) : null, major(r.balance, decimals)]);
    }
    rows.push([a.code, a.name, to, '', 'Carried forward', major(g.debit, decimals), major(g.credit, decimals), major(g.closing, decimals)]);
  }
  return rows;
}

/** Any account, any dates, with a running balance and what each line was. */
export function LedgerReport({
  accounts, lines, entries, from, to, money, settings,
}: {
  accounts: AccountRow[];
  lines: Lines;
  entries: JournalEntry[];
  from: string;
  to: string;
  money: (n: number) => string;
  settings: Settings | null;
}) {
  const used = useMemo(() => new Set(lines.map((l) => l.account_code)), [lines]);
  const choices = accounts.filter((a) => used.has(a.code));
  const [code, setCode] = useState(() => choices.find((a) => a.code === '1040')?.code ?? choices[0]?.code ?? '');
  const [q, setQ] = useState('');
  const decimals = settings?.currency_decimals ?? 2;
  const account = accounts.find((a) => a.code === code);
  const byId = useMemo(() => new Map(entries.map((e) => [e.$id, e])), [entries]);
  const g = useMemo(
    () => (account ? generalLedger(account, lines as PostedLine[], { from, to, memoOf: memoOf(byId) }) : null),
    [account, lines, from, to, byId],
  );
  const shown = (g?.rows ?? []).filter((r) => !q || r.memo.toLowerCase().includes(q.toLowerCase()));
  const period = `${from} to ${to}`;

  return (
    <Card title="General ledger" pad>
      <div className="row row-wrap" style={{ gap: '0.5rem', alignItems: 'flex-end', marginBottom: '0.8rem' }}>
        <Field label="Account">
          <Select value={code} onChange={(e) => setCode(e.target.value)}>
            {choices.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
          </Select>
        </Field>
        <Field label="Search what it was for">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rent, slip number…" />
        </Field>
        <Button size="sm" disabled={!account} onClick={() => save(`Ledger ${code} ${period}.xlsx`, [{ name: `${code} ${account?.name ?? ''}`, rows: ledgerSheet(accounts, lines, entries, from, to, decimals, code) }])}>Excel</Button>
        <Button size="sm" onClick={() => save(`General ledger ${period}.xlsx`, [{ name: 'General ledger', rows: ledgerSheet(accounts, lines, entries, from, to, decimals) }])}>Every account, Excel</Button>
        <Button
          size="sm"
          disabled={!g}
          onClick={() => g && account && printable(settings, `Ledger · ${account.code} ${account.name}`, period, [{
            title: `${account.code} ${account.name}`,
            headers: ['Date', 'What', 'Debit', 'Credit', 'Balance'],
            rows: [
              [from, 'Brought forward', '', '', money(g.opening)],
              ...g.rows.map((r) => [r.date.slice(0, 10), r.memo, r.debit ? money(r.debit) : '', r.credit ? money(r.credit) : '', money(r.balance)]),
              [to, 'Carried forward', money(g.debit), money(g.credit), money(g.closing)],
            ],
            numeric: [2, 3, 4],
          }])}
        >
          PDF
        </Button>
      </div>
      {!g ? (
        <Empty title="Nothing posted yet">Close a shift, or post an entry.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Date</th><th>What</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
            <tbody>
              <tr><td className="dim small">{from}</td><td style={{ fontWeight: 600 }}>Brought forward</td><td /><td /><td className="num" style={{ fontWeight: 600 }}>{money(g.opening)}</td></tr>
              {shown.map((r, i) => (
                <tr key={`${r.entry_id}-${i}`}>
                  <td className="dim small">{r.date.slice(0, 10)}</td>
                  <td>{r.memo || '-'}</td>
                  <td className="num">{r.debit ? money(r.debit) : ''}</td>
                  <td className="num">{r.credit ? money(r.credit) : ''}</td>
                  <td className="num dim">{money(r.balance)}</td>
                </tr>
              ))}
              <tr>
                <td className="dim small">{to}</td><td style={{ fontWeight: 650 }}>Carried forward</td>
                <td className="num" style={{ fontWeight: 650 }}>{money(g.debit)}</td>
                <td className="num" style={{ fontWeight: 650 }}>{money(g.credit)}</td>
                <td className="num" style={{ fontWeight: 650 }}>{money(g.closing)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {q && <p className="small dim" style={{ marginBottom: 0 }}>Searching shows matching lines only; the balances are still the account&rsquo;s own.</p>}
    </Card>
  );
}

/* ----------------------------------------------------------------- cash flow */

/** Where the cash came from and went, from the entries that moved it. */
export function CashFlowReport({
  accounts, lines, from, to, money, settings, cashCodes = CASH_CODES,
}: {
  accounts: AccountRow[];
  lines: Lines;
  from: string;
  to: string;
  money: (n: number) => string;
  settings: Settings | null;
  cashCodes?: string[];
}) {
  const decimals = settings?.currency_decimals ?? 2;
  const f = useMemo(() => cashFlow(accounts, lines as PostedLine[], { from, to, cashCodes }), [accounts, lines, from, to, cashCodes]);
  const pl = useMemo(() => profitAndLoss(accounts, within(lines, from, to)), [accounts, lines, from, to]);
  const period = `${from} to ${to}`;
  const rows: Cell[][] = [
    ['', 'Amount'],
    [`Cash and bank on ${from}`, major(f.opening, decimals)],
    ['Money in', null], ...f.inflows.map((g) => [g.label, major(g.amount, decimals)]),
    ['Money out', null], ...f.outflows.map((g) => [g.label, major(g.amount, decimals)]),
    [`Cash and bank on ${to}`, major(f.closing, decimals)],
  ];
  const names = cashCodes.map((c) => accounts.find((a) => a.code === c)?.name ?? c).join(', ');

  return (
    <Card title={`Cash flow · ${period}`} pad>
      <div className="row row-wrap" style={{ gap: '0.5rem', marginBottom: '0.8rem' }}>
        <Button size="sm" onClick={() => save(`Cash flow ${period}.xlsx`, [{ name: 'Cash flow', rows }])}>Excel</Button>
        <Button size="sm" onClick={() => printable(settings, 'Cash flow', period, [{
          title: 'Cash flow', headers: ['', 'Amount'],
          rows: rows.slice(1).map((r) => [String(r[0]), typeof r[1] === 'number' ? money(Math.round(r[1] * 10 ** decimals)) : '']),
          numeric: [1],
        }], `Cash means: ${names}.`)}>PDF</Button>
      </div>
      <div className="table-wrap">
        <table className="data">
          <tbody>
            <tr><td style={{ fontWeight: 650 }}>Cash and bank on {from}</td><td className="num" style={{ fontWeight: 650 }}>{money(f.opening)}</td></tr>
            <tr><td colSpan={2} style={{ fontWeight: 650, paddingTop: '1rem' }}>Money in</td></tr>
            {f.inflows.length === 0 && <tr><td className="dim" colSpan={2}>Nothing came in.</td></tr>}
            {f.inflows.map((g) => <tr key={g.key}><td>{g.label}</td><td className="num">{money(g.amount)}</td></tr>)}
            <tr><td colSpan={2} style={{ fontWeight: 650, paddingTop: '1rem' }}>Money out</td></tr>
            {f.outflows.length === 0 && <tr><td className="dim" colSpan={2}>Nothing went out.</td></tr>}
            {f.outflows.map((g) => <tr key={g.key}><td>{g.label}</td><td className="num">{money(g.amount)}</td></tr>)}
            <tr><td style={{ fontWeight: 700, paddingTop: '1rem' }}>Cash and bank on {to}</td><td className="num" style={{ fontWeight: 700, paddingTop: '1rem' }}>{money(f.closing)}</td></tr>
          </tbody>
        </table>
      </div>
      <p className="small dim" style={{ marginBottom: 0 }}>
        Profit for the same dates was {money(pl.netProfit)}; cash {f.net >= 0 ? 'rose' : 'fell'} by {money(Math.abs(f.net))}.
        The difference is what this explains: tax and makers paid later, stock still on the shelf, money owed either way.
        Cash means: {names}.
      </p>
    </Card>
  );
}

/* ----------------------------------------------------------------- year pack */

/**
 * Everything an accountant asks for at the year end, as one workbook: the
 * statements, the trial balance, the cash flow, every account's ledger and
 * the journal.
 */
export function yearPack(input: {
  accounts: AccountRow[];
  lines: Lines;
  entries: JournalEntry[];
  from: string;
  to: string;
  settings: Settings | null;
  cashCodes?: string[];
}): void {
  const { accounts, lines, entries, from, to, settings } = input;
  const decimals = settings?.currency_decimals ?? 2;
  const exclude = closingEntries(entries);
  const counted = lines.filter((l) => !exclude.has(l.entry_id)) as Lines;
  const single = plTable(accounts, counted as PostedLine[], { by: 'single', from, to });
  const months = plTable(accounts, counted as PostedLine[], { by: 'month', from, to });
  const depts = plTable(accounts, counted as PostedLine[], { by: 'department', from, to });
  const bs = balanceSheet(accounts, within(lines, undefined, to));
  const totals = totalsByAccount(within(lines, from, to));
  const f = cashFlow(accounts, lines as PostedLine[], { from, to, cashCodes: input.cashCodes });
  const m = (n: number) => major(n, decimals);

  const bsRows: Cell[][] = [
    ['Code', 'Account', 'Amount'],
    ['', 'What the business owns'], ...bs.assets.map((l) => [l.code, l.name, m(l.amount)]), ['', 'Total', m(bs.totalAssets)],
    ['', 'What it owes'], ...bs.liabilities.map((l) => [l.code, l.name, m(l.amount)]), ['', 'Total', m(bs.totalLiabilities)],
    ['', "The owner's share"], ...bs.equity.map((l) => [l.code, l.name, m(l.amount)]),
    ['', 'Profit kept in the business', m(bs.retained)],
    ['', 'Total owed and owned', m(bs.totalLiabilities + bs.totalEquity + bs.retained)],
  ];
  const tbRows: Cell[][] = [['Code', 'Account', 'Debit', 'Credit', 'Balance'], ...accounts
    .map((a) => ({ a, t: totals.get(a.code) ?? { debit: 0, credit: 0 } }))
    .filter((x) => x.t.debit || x.t.credit)
    .map(({ a, t }) => [a.code, a.name, m(t.debit), m(t.credit), m(naturalBalance(a.type, t.debit, t.credit))])];
  const cfRows: Cell[][] = [
    ['', 'Amount'], [`Cash and bank on ${from}`, m(f.opening)],
    ['Money in'], ...f.inflows.map((g) => [g.label, m(g.amount)]),
    ['Money out'], ...f.outflows.map((g) => [g.label, m(g.amount)]),
    [`Cash and bank on ${to}`, m(f.closing)],
  ];
  const byEntry = new Map<string, Lines>();
  for (const l of within(lines, from, to)) byEntry.set(l.entry_id, [...(byEntry.get(l.entry_id) ?? []), l]);
  const journal: Cell[][] = [['Date', 'Entry', 'Source', 'Memo', 'Code', 'Account', 'Debit', 'Credit']];
  for (const e of [...entries].filter((x) => byEntry.has(x.$id)).sort((a, b) => a.date.localeCompare(b.date))) {
    for (const l of byEntry.get(e.$id) ?? []) {
      journal.push([e.date.slice(0, 10), e.$id, e.source, e.memo ?? '', l.account_code, accounts.find((a) => a.code === l.account_code)?.name ?? '', l.debit ? m(l.debit) : null, l.credit ? m(l.credit) : null]);
    }
  }
  save(`Accounts ${from} to ${to}.xlsx`, [
    { name: 'Profit and loss', rows: plSheet(single, decimals) },
    { name: 'P&L by month', rows: plSheet(months, decimals) },
    { name: 'P&L by department', rows: plSheet(depts, decimals) },
    { name: `Balance sheet ${to}`, rows: bsRows },
    { name: 'Trial balance', rows: tbRows },
    { name: 'Cash flow', rows: cfRows },
    { name: 'General ledger', rows: ledgerSheet(accounts, lines, entries, from, to, decimals) },
    { name: 'Journal', rows: journal },
  ]);
}

/** The balance sheet and trial balance as files. */
export function BalanceExports({ accounts, lines, to, settings }: {
  accounts: AccountRow[]; lines: Lines; to: string; settings: Settings | null;
}) {
  const decimals = settings?.currency_decimals ?? 2;
  const bs = balanceSheet(accounts, within(lines, undefined, to));
  const rows: Cell[][] = [
    ['Code', 'Account', 'Amount'],
    ...bs.assets.map((l) => [l.code, l.name, major(l.amount, decimals)]), ['', 'Total owned', major(bs.totalAssets, decimals)],
    ...bs.liabilities.map((l) => [l.code, l.name, major(l.amount, decimals)]), ['', 'Total owed', major(bs.totalLiabilities, decimals)],
    ...bs.equity.map((l) => [l.code, l.name, major(l.amount, decimals)]),
    ['', 'Profit kept in the business', major(bs.retained, decimals)],
  ];
  return (
    <div className="row" style={{ gap: '0.5rem' }}>
      <Button size="sm" onClick={() => save(`Balance sheet ${to}.xlsx`, [{ name: `Balance sheet ${to}`, rows }])}>Excel</Button>
      <Button size="sm" onClick={() => printable(settings, 'Balance sheet', `as at ${to}`, [{
        title: 'Balance sheet', headers: ['Code', 'Account', 'Amount'],
        rows: rows.slice(1).map((r) => [String(r[0] ?? ''), String(r[1] ?? ''), typeof r[2] === 'number' ? String(r[2].toFixed(decimals)) : '']),
        numeric: [2],
      }])}>PDF</Button>
    </div>
  );
}
