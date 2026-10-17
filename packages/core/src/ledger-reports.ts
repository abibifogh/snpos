/**
 * The reports an accountant asks for, worked out from the postings.
 *
 * The profit and loss in columns (by department, by month), a comparison with
 * another period, the general ledger of one account, and a cash flow
 * statement. Every figure comes from the same journal lines the statements
 * already read, so a report and the balance sheet can never disagree.
 *
 * Pure. Imports nothing at runtime. See ledger-math.ts for the statements.
 */
import type { AccountRow, AccountType, LineRow } from './ledger-math';

/** A journal line with what a report needs: its entry and its date. */
export interface PostedLine extends LineRow {
  entry_id: string;
  date: string;
  memo?: string;
}

/** Whose figure a line is. Overheads belong to the whole business. */
export type Dept = 'kitchen' | 'bar' | 'craft' | 'shared';

/**
 * Sales and cost of sales post to each department's own accounts, so they
 * split exactly. Anything else on the profit and loss is Shared rather than
 * guessed apart: rent by floor space is an accountant's estimate, not a fact.
 */
const DEPT_OF: Record<string, Dept> = {
  '4000': 'kitchen', '5000': 'kitchen',
  '4010': 'bar', '5010': 'bar',
  '4020': 'craft', '5020': 'craft',
};
export const deptOf = (code: string): Dept => DEPT_OF[code] ?? 'shared';

export const DEPT_WORDS: Record<Dept, string> = { kitchen: 'Bistro', bar: 'Bar', craft: 'Shop', shared: 'Shared' };

/* ------------------------------------------------------------------ periods */

const day = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(`${s}T12:00:00Z`);

/** The months a window covers, as YYYY-MM, oldest first. */
export function monthsIn(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    if (out.length > 120) break;
  }
  return out;
}

/** The same number of days, ending the day before this window starts. */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const a = parse(from).getTime();
  const b = parse(to).getTime();
  const len = Math.round((b - a) / 86_400_000);
  const end = new Date(a - 86_400_000);
  const start = new Date(end.getTime() - len * 86_400_000);
  // A whole month compares with the whole month before, not with the same
  // number of days: September is compared with August, all thirty-one days.
  if (from.slice(8) === '01' && day(new Date(b + 86_400_000)).slice(8) === '01') {
    const s = new Date(Date.UTC(parse(from).getUTCFullYear(), parse(from).getUTCMonth() - monthsIn(from, to).length, 1, 12));
    return { from: day(s), to: day(end) };
  }
  return { from: day(start), to: day(end) };
}

/** The same dates a year earlier. */
export function sameLastYear(from: string, to: string): { from: string; to: string } {
  const back = (s: string) => `${Number(s.slice(0, 4)) - 1}${s.slice(4)}`.replace(/-02-29$/, '-02-28');
  return { from: back(from), to: back(to) };
}

const inWindow = (d: string, from?: string, to?: string) => (!from || d >= from) && (!to || d <= `${to}￿`);

/* ----------------------------------------------------------- profit and loss */

export type PlBy = 'single' | 'department' | 'month';

export interface PlRow {
  code: string;
  name: string;
  type: AccountType;
  /** One per column, in the direction the account is normally held. */
  cells: number[];
  total: number;
  /** The comparison period's figure, when there is one. */
  compare?: number;
}

export interface PlTable {
  columns: string[];
  income: PlRow[];
  costs: PlRow[];
  /** Per column, then the total last. */
  incomeTotals: number[];
  costTotals: number[];
  profit: number[];
  compare?: { income: number; costs: number; profit: number };
}

const natural = (type: AccountType, debit: number, credit: number) =>
  type === 'asset' || type === 'expense' ? debit - credit : credit - debit;

/**
 * The profit and loss as a table.
 *
 * `exclude` is the entries a report must not count: the year-end closing
 * entry moves the year's profit into retained earnings, and counted here it
 * would show every closed year as having made nothing.
 */
export function plTable(
  accounts: AccountRow[],
  lines: PostedLine[],
  opts: { by: PlBy; from: string; to: string; exclude?: Set<string>; compareLines?: PostedLine[] },
): PlTable {
  const depts: Dept[] = ['kitchen', 'bar', 'craft', 'shared'];
  const months = opts.by === 'month' ? monthsIn(opts.from, opts.to) : [];
  const columns = opts.by === 'department'
    ? depts.map((d) => DEPT_WORDS[d])
    : opts.by === 'month' ? months : ['Amount'];
  const colOf = (l: PostedLine): number => {
    if (opts.by === 'department') return depts.indexOf(deptOf(l.account_code));
    if (opts.by === 'month') return months.indexOf(l.date.slice(0, 7));
    return 0;
  };
  const counted = (ls: PostedLine[] | undefined, from?: string, to?: string) =>
    (ls ?? []).filter((l) => !opts.exclude?.has(l.entry_id) && inWindow(l.date, from, to));

  const byCode = new Map<string, { debit: number[]; credit: number[] }>();
  for (const l of counted(lines, opts.from, opts.to)) {
    const c = colOf(l);
    if (c < 0) continue;
    const row = byCode.get(l.account_code) ?? { debit: columns.map(() => 0), credit: columns.map(() => 0) };
    row.debit[c] += l.debit || 0;
    row.credit[c] += l.credit || 0;
    byCode.set(l.account_code, row);
  }
  const cmp = new Map<string, number>();
  if (opts.compareLines) {
    for (const l of counted(opts.compareLines)) {
      const a = accounts.find((x) => x.code === l.account_code);
      if (!a || (a.type !== 'revenue' && a.type !== 'expense')) continue;
      cmp.set(l.account_code, (cmp.get(l.account_code) ?? 0) + natural(a.type, l.debit || 0, l.credit || 0));
    }
  }

  const rowsOf = (type: AccountType): PlRow[] => accounts
    .filter((a) => a.type === type)
    .map((a) => {
      const t = byCode.get(a.code);
      const cells = columns.map((_, i) => (t ? natural(type, t.debit[i], t.credit[i]) : 0));
      const total = cells.reduce((n, v) => n + v, 0);
      return { code: a.code, name: a.name, type, cells, total, ...(opts.compareLines ? { compare: cmp.get(a.code) ?? 0 } : {}) };
    })
    .filter((r) => r.total !== 0 || (r.compare ?? 0) !== 0)
    .sort((a, b) => a.code.localeCompare(b.code));

  const income = rowsOf('revenue');
  const costs = rowsOf('expense');
  const sum = (rows: PlRow[]) => [...columns.map((_, i) => rows.reduce((n, r) => n + r.cells[i], 0)), rows.reduce((n, r) => n + r.total, 0)];
  const incomeTotals = sum(income);
  const costTotals = sum(costs);
  const profit = incomeTotals.map((v, i) => v - costTotals[i]);
  const table: PlTable = { columns, income, costs, incomeTotals, costTotals, profit };
  if (opts.compareLines) {
    const ci = income.reduce((n, r) => n + (r.compare ?? 0), 0);
    const cc = costs.reduce((n, r) => n + (r.compare ?? 0), 0);
    table.compare = { income: ci, costs: cc, profit: ci - cc };
  }
  return table;
}

/** The change from one figure to another as a share, or null when there was nothing before. */
export const changeShare = (now: number, before: number): number | null =>
  before === 0 ? null : (now - before) / Math.abs(before);

/* ------------------------------------------------------------ general ledger */

export interface LedgerRow {
  date: string;
  entry_id: string;
  memo: string;
  debit: number;
  credit: number;
  /** After this line, in the direction the account is normally held. */
  balance: number;
}

export interface GeneralLedger {
  opening: number;
  rows: LedgerRow[];
  debit: number;
  credit: number;
  closing: number;
}

/**
 * One account, line by line, with a running balance.
 *
 * Opens with what it held before the window (a balance sheet account
 * carries everything since the start; a profit and loss account too, until a
 * year end closes it), so the closing figure is the one the statements show.
 */
export function generalLedger(
  account: Pick<AccountRow, 'code' | 'type'>,
  lines: PostedLine[],
  opts: { from?: string; to?: string; memoOf?: (l: PostedLine) => string } = {},
): GeneralLedger {
  const mine = lines.filter((l) => l.account_code === account.code)
    .sort((a, b) => a.date.localeCompare(b.date) || a.entry_id.localeCompare(b.entry_id));
  let opening = 0;
  const rows: LedgerRow[] = [];
  let debit = 0;
  let credit = 0;
  let balance = 0;
  for (const l of mine) {
    if (opts.from && l.date < opts.from) {
      opening += natural(account.type, l.debit || 0, l.credit || 0);
      continue;
    }
    if (opts.to && l.date > `${opts.to}￿`) continue;
    if (rows.length === 0) balance = opening;
    balance += natural(account.type, l.debit || 0, l.credit || 0);
    debit += l.debit || 0;
    credit += l.credit || 0;
    rows.push({ date: l.date, entry_id: l.entry_id, memo: opts.memoOf?.(l) ?? l.memo ?? '', debit: l.debit || 0, credit: l.credit || 0, balance });
  }
  return { opening, rows, debit, credit, closing: rows.length ? balance : opening };
}

/* ----------------------------------------------------------------- cash flow */

/** The accounts that hold money: the drawers' cash, petty cash, the bank. */
export const CASH_CODES = ['1000', '1030', '1040'];

export type FlowKey =
  | 'sales' | 'customers' | 'settle' | 'stock' | 'wages' | 'overheads' | 'bills' | 'makers'
  | 'tax' | 'tips' | 'staff' | 'equipment' | 'owner' | 'other';

export const FLOW_WORDS: Record<FlowKey, string> = {
  sales: 'Sales',
  customers: 'Customers paying what they owed',
  settle: 'Card and MoMo, taken less still to settle',
  stock: 'Stock bought',
  wages: 'Wages',
  overheads: 'Rent, power and other overheads',
  bills: 'Bills paid',
  makers: 'Makers paid',
  tax: 'Tax, collected less paid',
  tips: 'Tips, collected less handed out',
  staff: 'Staff owing',
  equipment: 'Equipment',
  owner: 'Owner put in or drew',
  other: 'Other',
};

const FLOW_ORDER: FlowKey[] = ['sales', 'customers', 'settle', 'stock', 'wages', 'overheads', 'bills', 'makers', 'tax', 'tips', 'staff', 'equipment', 'owner', 'other'];

/** What a line on the other side of a cash movement says the cash was for. */
export function flowOf(code: string, type: AccountType | undefined): FlowKey {
  if (type === 'revenue') return 'sales';
  if (code === '1010' || code === '1020') return 'settle';
  if (code === '1100') return 'customers';
  if (code === '1300') return 'staff';
  if (code.startsWith('12') || code.startsWith('50')) return 'stock';
  if (code.startsWith('15')) return 'equipment';
  if (code.startsWith('21')) return 'tax';
  if (code === '2200') return 'tips';
  if (code === '2300') return 'bills';
  if (code === '2400') return 'makers';
  if (code === '6100') return 'wages';
  if (type === 'equity') return 'owner';
  if (type === 'expense') return 'overheads';
  return 'other';
}

export interface CashFlow {
  opening: number;
  closing: number;
  /** Money in, then money out, each a group with what it came to. */
  inflows: { key: FlowKey; label: string; amount: number }[];
  outflows: { key: FlowKey; label: string; amount: number }[];
  net: number;
}

/**
 * Where the cash came from and went, over a window.
 *
 * The direct method, from the entries themselves: in each entry that moved
 * money, every other line says what the money was for, by its account. An
 * entry that only moves money between cash accounts (banking the drawer, a
 * transfer) changes nothing here. The groups add up exactly to the change
 * in cash, because a balanced entry's other lines always sum to its cash.
 */
export function cashFlow(
  accounts: AccountRow[],
  lines: PostedLine[],
  opts: { from: string; to: string; cashCodes?: string[] },
): CashFlow {
  const cash = new Set(opts.cashCodes ?? CASH_CODES);
  const typeOf = new Map(accounts.map((a) => [a.code, a.type]));
  let opening = 0;
  let closing = 0;
  const byEntry = new Map<string, PostedLine[]>();
  for (const l of lines) {
    const moved = (l.debit || 0) - (l.credit || 0);
    if (cash.has(l.account_code)) {
      if (l.date < opts.from) opening += moved;
      if (l.date <= `${opts.to}￿`) closing += moved;
    }
    if (inWindow(l.date, opts.from, opts.to)) byEntry.set(l.entry_id, [...(byEntry.get(l.entry_id) ?? []), l]);
  }
  const sums = new Map<FlowKey, number>();
  for (const ls of byEntry.values()) {
    if (!ls.some((l) => cash.has(l.account_code))) continue;
    for (const l of ls) {
      if (cash.has(l.account_code)) continue;
      const key = flowOf(l.account_code, typeOf.get(l.account_code));
      sums.set(key, (sums.get(key) ?? 0) + (l.credit || 0) - (l.debit || 0));
    }
  }
  const groups = FLOW_ORDER.filter((k) => (sums.get(k) ?? 0) !== 0).map((k) => ({ key: k, label: FLOW_WORDS[k], amount: sums.get(k) as number }));
  return {
    opening,
    closing,
    inflows: groups.filter((g) => g.amount > 0),
    outflows: groups.filter((g) => g.amount < 0),
    net: closing - opening,
  };
}

/* ---------------------------------------------------------------- tax return */

export interface TaxReturnRow {
  code: string;
  name: string;
  /** Credited in the window: collected on sales. */
  collected: number;
  /** Debited in the window: paid to the revenue authority. */
  paid: number;
  /** Still owed at the end of the window, counting everything before it. */
  owed: number;
}

/**
 * A tax return for a period, from the tax accounts.
 *
 * Each levy has its own liability account, credited at every shift close
 * and debited when it is paid. The return is those accounts over the period;
 * sales before tax are the revenue accounts over the same dates.
 */
export function taxReturn(
  accounts: AccountRow[],
  lines: PostedLine[],
  opts: { from: string; to: string; taxCodes: string[]; exclude?: Set<string> },
): { sales: number; rows: TaxReturnRow[]; collected: number; paid: number; owed: number } {
  const codes = new Set(opts.taxCodes);
  const types = new Map(accounts.map((a) => [a.code, a.type]));
  let sales = 0;
  const rows = new Map<string, TaxReturnRow>();
  for (const code of opts.taxCodes) {
    rows.set(code, { code, name: accounts.find((a) => a.code === code)?.name ?? code, collected: 0, paid: 0, owed: 0 });
  }
  for (const l of lines) {
    if (opts.exclude?.has(l.entry_id)) continue;
    const here = inWindow(l.date, opts.from, opts.to);
    if (here && types.get(l.account_code) === 'revenue') sales += (l.credit || 0) - (l.debit || 0);
    if (!codes.has(l.account_code)) continue;
    const r = rows.get(l.account_code) as TaxReturnRow;
    if (l.date <= `${opts.to}￿`) r.owed += (l.credit || 0) - (l.debit || 0);
    if (here) { r.collected += l.credit || 0; r.paid += l.debit || 0; }
  }
  const list = [...rows.values()].filter((r) => r.collected || r.paid || r.owed);
  return {
    sales,
    rows: list,
    collected: list.reduce((n, r) => n + r.collected, 0),
    paid: list.reduce((n, r) => n + r.paid, 0),
    owed: list.reduce((n, r) => n + r.owed, 0),
  };
}

/* ----------------------------------------------------------- what is owed, by age */

export interface AgeBuckets { current: number; d30: number; d60: number; over: number; total: number }

/**
 * Amounts by how overdue they are: not yet due, up to 30 days, 31 to 60,
 * and over 60. An amount with no due date is due on the day it arose.
 */
export function ageBuckets<T extends { amount: number; due: string }>(rows: T[], today: string): AgeBuckets {
  const b: AgeBuckets = { current: 0, d30: 0, d60: 0, over: 0, total: 0 };
  const t = parse(today).getTime();
  for (const r of rows) {
    const late = Math.floor((t - parse(r.due.slice(0, 10)).getTime()) / 86_400_000);
    if (late <= 0) b.current += r.amount;
    else if (late <= 30) b.d30 += r.amount;
    else if (late <= 60) b.d60 += r.amount;
    else b.over += r.amount;
    b.total += r.amount;
  }
  return b;
}

/** Days past due, or 0 when not yet due. */
export const daysLate = (due: string, today: string): number =>
  Math.max(0, Math.floor((parse(today).getTime() - parse(due.slice(0, 10)).getTime()) / 86_400_000));
