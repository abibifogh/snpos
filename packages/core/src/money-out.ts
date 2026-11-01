/**
 * Money out: every payment that left the business, in one list.
 *
 * It went out from four pages: Record spend at the till, the Spends page,
 * spends inside a petty cash box, and maker payouts. Each kept its own
 * list, so "what did we spend this week" meant opening all four. They are
 * one list here, each row saying where the money came from.
 *
 * Pure. Imports nothing at runtime.
 */

export type OutFrom = 'drawer' | 'box' | 'bank' | 'own' | 'float' | 'owed' | 'maker';
export type OutState = 'waiting' | 'approved' | 'refused' | 'paid' | 'reversed';
export type OutFilter = 'all' | OutFrom | 'waiting';
export type OutPeriod = 'week' | 'month' | 'all';

export const OUT_FROM_WORDS: Record<OutFrom, string> = {
  drawer: 'From drawers',
  box: 'From petty cash',
  bank: 'From the bank',
  own: 'Own money',
  float: 'From floats, in Insight',
  owed: 'Not paid yet',
  maker: 'Maker payouts',
};

export const OUT_STATE_WORDS: Record<OutState, { label: string; tone: 'ok' | 'warn' | 'danger' | 'default' }> = {
  waiting: { label: 'Waiting', tone: 'warn' },
  approved: { label: 'Approved', tone: 'ok' },
  refused: { label: 'Refused', tone: 'danger' },
  paid: { label: 'Paid', tone: 'ok' },
  reversed: { label: 'Reversed', tone: 'default' },
};

export interface OutSpend {
  $id: string;
  $createdAt: string;
  amount: number;
  payee?: string;
  module?: string;
  imprest_float_id?: string;
  from_takings?: boolean;
  source?: string;
  pay_later?: boolean;
  paid_at?: string;
  approval_status?: string;
  paid_from_method_id?: string;
}

export interface OutPayout {
  $id: string;
  consignor_id: string;
  paid_at: string;
  amount: number;
  method: string;
  status?: string;
}

export interface OutRow {
  id: string;
  kind: 'spend' | 'payout';
  at: string;
  amount: number;
  from: OutFrom;
  state: OutState;
  to: string;
  module?: string;
}

/** Where a spend's money came from, old rows and new. */
export function spendFrom(s: OutSpend, methodKind?: string | null): OutFrom {
  if (s.pay_later === true) return 'owed';
  if (s.imprest_float_id) return 'box';
  if (s.source === 'drawer' || s.source === 'box' || s.source === 'bank' || s.source === 'own' || s.source === 'float') return s.source;
  if (methodKind && methodKind !== 'cash') return 'bank';
  return s.from_takings === false ? 'own' : 'drawer';
}

const spendState = (s: OutSpend): OutState =>
  s.approval_status === 'rejected' ? 'refused' : s.approval_status === 'pending' ? 'waiting' : 'approved';

export function moneyOutRows(
  spends: OutSpend[],
  payouts: OutPayout[],
  opts: { methodKind?: (methodId: string) => string | undefined; makerName?: (id: string) => string | undefined } = {},
): OutRow[] {
  const rows: OutRow[] = [
    ...spends.map((s) => ({
      id: s.$id,
      kind: 'spend' as const,
      at: s.$createdAt,
      amount: s.amount,
      from: spendFrom(s, opts.methodKind?.(s.paid_from_method_id ?? '')),
      state: spendState(s),
      to: s.payee ?? '',
      module: s.module,
    })),
    ...payouts.map((p) => ({
      id: p.$id,
      kind: 'payout' as const,
      at: p.paid_at,
      amount: p.amount,
      from: 'maker' as const,
      state: (p.status === 'reversed' ? 'reversed' : 'paid') as OutState,
      to: opts.makerName?.(p.consignor_id) ?? 'A maker',
      module: 'craft',
    })),
  ];
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

/** The start of the period, or null for all time. A week starts on Monday. */
export function periodStart(period: OutPeriod, now: Date): Date | null {
  if (period === 'all') return null;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'month') return new Date(d.getFullYear(), d.getMonth(), 1);
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return d;
}

export const inPeriod = (rows: OutRow[], period: OutPeriod, now: Date): OutRow[] => {
  const from = periodStart(period, now);
  return from ? rows.filter((r) => new Date(r.at).getTime() >= from.getTime()) : rows;
};

export function outFilter(rows: OutRow[], filter: OutFilter): OutRow[] {
  if (filter === 'all') return rows;
  if (filter === 'waiting') return rows.filter((r) => r.state === 'waiting');
  return rows.filter((r) => r.from === filter);
}

/** What left, not counting refused spends or reversed payouts. */
export const outTotal = (rows: OutRow[]): number =>
  rows.filter((r) => r.state !== 'refused' && r.state !== 'reversed').reduce((n, r) => n + r.amount, 0);

/** The filters worth offering: All, each source that has a row, and Waiting when anything is. */
export function outFilters(rows: OutRow[]): { value: OutFilter; label: string; count: number }[] {
  const order: OutFrom[] = ['drawer', 'box', 'bank', 'float', 'owed', 'own', 'maker'];
  const waiting = rows.filter((r) => r.state === 'waiting').length;
  return [
    { value: 'all', label: 'All', count: rows.length },
    ...order
      .map((f) => ({ value: f as OutFilter, label: OUT_FROM_WORDS[f], count: rows.filter((r) => r.from === f).length }))
      .filter((f) => f.count > 0),
    ...(waiting > 0 ? [{ value: 'waiting' as OutFilter, label: 'Waiting to approve', count: waiting }] : []),
  ];
}
