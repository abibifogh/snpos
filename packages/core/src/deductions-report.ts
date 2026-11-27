/**
 * The staff deductions report: what each person has been charged for
 * shortages over a period, including what is not final yet and bar counts
 * nobody has approved.
 *
 * Four kinds of line, always labelled and totalled apart, so nobody reads a
 * pending figure as a deduction:
 *
 *   final     Deducted. Decided by a manager or by the clock, or charged by
 *             hand. Only this is taken from pay.
 *   notfinal  On their account and still open: within their answer time,
 *             waiting for a manager, or agreed to be put back.
 *   approval  A bar count that found a shortage nobody has approved. Not on
 *             anyone's account; shown against whoever ran that shift.
 *   off       Waived, written off, or put back. For the record.
 *
 * A line falls in the period by the date of the count that found it.
 *
 * Pure. Imports nothing at runtime. Printed through the browser, which saves
 * it as a PDF; see openPrintable.
 */
import type { StaffCharge, StaffSettlement } from './staff-charges';

export type DeductionKind = 'final' | 'notfinal' | 'approval' | 'off';

export const DEDUCTION_WORDS: Record<DeductionKind, string> = {
  final: 'Deducted',
  notfinal: 'Not final',
  approval: 'Waiting on Approvals',
  off: 'Waived / put back',
};

export interface DeductionRow {
  personId: string;
  name: string;
  /** When the shortage was found. */
  at: string;
  /** What was short: "2 Club lager, 1 Gin 25cl". */
  items: string;
  /** Which count: "Bar count, closing". */
  where: string;
  kind: DeductionKind;
  /** What the shortage came to. */
  amount: number;
  /** Of that, what is taken from pay. Only ever on a final line. */
  taken: number;
  /** Where it stands, in words. */
  note: string;
}

/** A bar count with a shortage nobody has approved, attributed to whoever ran the shift. */
export interface WaitingCount {
  personId: string;
  name: string;
  at: string;
  phase: 'open' | 'close';
  lines: { name: string; variance: number; price: number }[];
}

interface CountLineJson { name?: string; qty?: number; amount?: number }

type Charge = StaffCharge & {
  phase?: string | null;
  lines?: string | null;
  answer?: string | null;
  answer_by?: string | null;
  decided_by?: string | null;
  decided_name?: string | null;
  decided_note?: string | null;
  decided_amount?: number | null;
  hive_sent_at?: string | null;
};

const countWhere = (phase?: string | null): string =>
  phase === 'open' ? 'Bar count, counted in' : 'Bar count, closing';

function shortItems(c: Charge): string {
  try {
    const rows = JSON.parse(c.lines || '[]') as CountLineJson[];
    const short = rows.filter((l) => (l.amount ?? 0) < 0);
    if (short.length) return short.map((l) => `${Math.abs(l.qty ?? 0)} ${l.name ?? ''}`.trim()).join(', ');
  } catch {
    // Fall through to the charge's own name.
  }
  return c.item_name?.replace(/^Bar count:\s*/, '') || 'A shortage';
}

/** One charge as a line of the report. Null for a credit, which is not a deduction. */
export function chargeRow(c: Charge, settlements: StaffSettlement[], money: (n: number) => string, when: (iso: string) => string): DeductionRow | null {
  if (c.direction === 'credit') return null;
  const base = { personId: c.person_id, name: c.person_name, at: c.charged_at, amount: c.amount || 0, taken: 0 };

  if (c.decision) {
    const items = shortItems(c);
    const where = countWhere(c.phase);
    // Decided by the clock, its name says how ("No answer by the deadline"); by a person, their name.
    const auto = c.decided_by === 'system' || /^(No answer|Accepted)/.test(c.decided_name ?? '');
    const by = !c.decided_name ? '' : auto ? `: ${c.decided_name.charAt(0).toLowerCase()}${c.decided_name.slice(1)}` : ` by ${c.decided_name}`;
    const hive = c.hive_sent_at ? ` Sent to HIVE ${when(c.hive_sent_at)}.` : '';
    switch (c.decision) {
      case 'pending': {
        const said = c.answer === 'explain' ? 'Explained, waiting for a manager.'
          : c.answer === 'putback' ? 'Offered to put it back, waiting for a manager.'
            : c.answer === 'accept' ? 'Accepted; deducted when the time is up.'
              : c.answer_by ? `No answer yet; time to answer ends ${when(c.answer_by)}.` : 'Waiting for an answer.';
        return { ...base, items, where, kind: 'notfinal', note: said };
      }
      case 'putback':
        return c.status === 'settled'
          ? { ...base, items, where, kind: 'off', note: 'Put back in the drawer at their next shift.' }
          : { ...base, items, where, kind: 'notfinal', note: 'Agreed: to be put back at their next shift.' };
      case 'deduct':
        return { ...base, items, where, kind: 'final', taken: base.amount, note: `Deducted${by}.${hive}` };
      case 'part': {
        const taken = Math.max(0, Math.min(base.amount, c.decided_amount ?? 0));
        return {
          ...base, items, where, kind: 'final', taken,
          note: `Deducted ${money(taken)} of ${money(base.amount)}${by}, the rest waived${c.decided_note ? `: "${c.decided_note}"` : ''}.${hive}`,
        };
      }
      case 'waived':
        return { ...base, items, where, kind: 'off', note: `Waived${by}${c.decided_note ? `: "${c.decided_note}"` : ''}.` };
      default:
        return null;
    }
  }

  // Charged by hand from Approvals: decided when it was made.
  const mine = settlements.filter((s) => s.charge_id === c.$id);
  const off = mine.filter((s) => s.kind === 'written_off').reduce((a, s) => a + s.amount, 0);
  const items = `${c.qty} ${c.item_name}`;
  const where = c.source === 'shop_count' ? 'Shop stocktake' : `${(c.module ?? 'bar').replace(/^./, (x) => x.toUpperCase())} count`;
  if (off >= base.amount && base.amount > 0) return { ...base, items, where, kind: 'off', note: 'Written off.' };
  const left = Math.max(0, base.amount - (c.settled_total || 0));
  const how = [
    mine.some((s) => s.kind === 'pay') ? 'taken from pay' : '',
    mine.some((s) => s.kind === 'cash') ? 'paid in cash' : '',
    mine.some((s) => s.kind === 'found') ? 'part found on the shelf' : '',
  ].filter(Boolean).join(', ');
  return {
    ...base, items, where, kind: 'final', taken: base.amount - off,
    note: `Charged by hand${how ? `; ${how}` : ''}${left > 0 ? `; ${money(left)} still owed` : ''}.`,
  };
}

/** A waiting bar count as a line: what is short less anything over on the same count, at selling price. */
export function waitingRow(w: WaitingCount): DeductionRow | null {
  let short = 0;
  let over = 0;
  const shortNames: string[] = [];
  for (const l of w.lines) {
    const v = Math.round(Math.abs(l.variance) * Math.max(0, l.price));
    if (l.variance < 0) { short += v; shortNames.push(`${Number(Math.abs(l.variance).toFixed(2))} ${l.name}`); } else if (l.variance > 0) over += v;
  }
  const owed = short - over;
  if (owed <= 0) return null;
  return {
    personId: w.personId, name: w.name, at: w.at, items: shortNames.join(', '), where: countWhere(w.phase),
    kind: 'approval', amount: owed, taken: 0,
    note: w.personId
      ? `Not charged yet. Waiting on Approvals; ${w.name.split(' ')[0]} ran that shift.`
      : 'Not charged yet. Waiting on Approvals; nobody is on record for that shift.',
  };
}

export interface DeductionOptions {
  /** ISO, inclusive. */
  from: string;
  to: string;
  /** One person, or everyone when absent. */
  personId?: string;
  notFinal: boolean;
  approval: boolean;
  off: boolean;
}

/** Every line of the report for the period and choices, by person then newest first. */
export function deductionRows(
  charges: Charge[],
  settlements: StaffSettlement[],
  waiting: WaitingCount[],
  opts: DeductionOptions,
  money: (n: number) => string,
  when: (iso: string) => string,
): DeductionRow[] {
  const rows = [
    ...charges.map((c) => chargeRow(c, settlements, money, when)),
    ...waiting.map(waitingRow),
  ].filter((r): r is DeductionRow => !!r);
  return rows
    .filter((r) => r.at >= opts.from && r.at <= opts.to)
    .filter((r) => !opts.personId || r.personId === opts.personId)
    .filter((r) => r.kind === 'final' || (r.kind === 'notfinal' && opts.notFinal) || (r.kind === 'approval' && opts.approval) || (r.kind === 'off' && opts.off))
    .sort((a, b) => a.name.localeCompare(b.name) || b.at.localeCompare(a.at));
}

export interface DeductionTotals { deducted: number; notFinal: number; approval: number; off: number }

export function deductionTotals(rows: DeductionRow[]): DeductionTotals {
  const t: DeductionTotals = { deducted: 0, notFinal: 0, approval: 0, off: 0 };
  for (const r of rows) {
    if (r.kind === 'final') t.deducted += r.taken;
    else if (r.kind === 'notfinal') t.notFinal += r.amount;
    else if (r.kind === 'approval') t.approval += r.amount;
    else t.off += r.amount;
  }
  return t;
}

/** Each person, with their own lines and totals, in name order. */
export function deductionPeople(rows: DeductionRow[]): { personId: string; name: string; rows: DeductionRow[]; totals: DeductionTotals }[] {
  const out = new Map<string, { personId: string; name: string; rows: DeductionRow[] }>();
  for (const r of rows) {
    const key = r.personId || `unknown:${r.name}`;
    const p = out.get(key) ?? { personId: r.personId, name: r.name || 'Nobody on record', rows: [] };
    p.rows.push(r);
    out.set(key, p);
  }
  return [...out.values()].map((p) => ({ ...p, totals: deductionTotals(p.rows) }));
}

/** The four quick periods, as whole local days. */
export function deductionPeriod(key: 'week' | 'lastweek' | 'month' | 'lastmonth', now: Date = new Date()): { from: Date; to: Date } {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monday = new Date(day);
  monday.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  if (key === 'week') return { from: monday, to: day };
  if (key === 'lastweek') {
    const from = new Date(monday); from.setDate(monday.getDate() - 7);
    const to = new Date(monday); to.setDate(monday.getDate() - 1);
    return { from, to };
  }
  if (key === 'month') return { from: new Date(day.getFullYear(), day.getMonth(), 1), to: day };
  return { from: new Date(day.getFullYear(), day.getMonth() - 1, 1), to: new Date(day.getFullYear(), day.getMonth(), 0) };
}

const esc = (s: string): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const csvCell = (value: unknown): string => {
  let v = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(v)) v = `\t${v}`;
  return `"${v.replace(/"/g, '""')}"`;
};

/** The same lines as a spreadsheet. Amounts in the currency's major unit. */
export function deductionsCsv(rows: DeductionRow[], decimals = 2, dayOf: (iso: string) => string = (iso) => iso.slice(0, 10)): string {
  const head = ['Date', 'Person', 'What was short', 'Count', 'Where it stands', 'Amount', 'Taken from pay', 'Note'];
  const amt = (n: number) => (n / 10 ** decimals).toFixed(decimals);
  const body = rows.map((r) => [dayOf(r.at), r.name, r.items, r.where, DEDUCTION_WORDS[r.kind], amt(r.amount), amt(r.taken), r.note]);
  return `﻿${[head, ...body].map((r) => r.map(csvCell).join(',')).join('\r\n')}`;
}

/** The report as a printable page, each person starting a new page. */
export function deductionsHtml(d: {
  business: string;
  periodWords: string;
  rows: DeductionRow[];
  include: { notFinal: boolean; approval: boolean; off: boolean };
  money: (n: number) => string;
  day: (iso: string) => string;
  madeAt: string;
  madeBy?: string;
}): string {
  const m = d.money;
  const all = deductionTotals(d.rows);
  const totals = (t: DeductionTotals) => [
    `<div>Deducted<strong>${esc(m(t.deducted))}</strong></div>`,
    d.include.notFinal ? `<div>Not final yet<strong>${esc(m(t.notFinal))}</strong></div>` : '',
    d.include.approval ? `<div>Waiting on Approvals<strong>${esc(m(t.approval))}</strong></div>` : '',
    d.include.off ? `<div>Waived / put back<strong>${esc(m(t.off))}</strong></div>` : '',
  ].join('');
  const people = deductionPeople(d.rows);
  const sections = people.map((p) => `<section>
    <div class="person"><h2>${esc(p.name)}</h2><div class="period">${esc(d.periodWords)}</div></div>
    <div class="summary">${totals(p.totals)}</div>
    <table>
      <thead><tr><th>Date</th><th>What was short</th><th>Where it stands</th><th class="num">Amount</th></tr></thead>
      <tbody>${p.rows.map((r) => `<tr>
        <td class="when">${esc(d.day(r.at))}</td>
        <td>${esc(r.items)}<div class="sub">${esc(r.where)}</div></td>
        <td><span class="st ${r.kind}">${esc(DEDUCTION_WORDS[r.kind])}</span><div class="sub">${esc(r.note)}</div></td>
        <td class="num">${r.kind === 'final' && r.taken !== r.amount ? `${esc(m(r.taken))}<div class="sub">of ${esc(m(r.amount))}</div>` : esc(m(r.amount))}</td>
      </tr>`).join('')}</tbody>
    </table>
  </section>`).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>Staff deductions</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Helvetica Neue", Arial, sans-serif; font-size: 12px; line-height: 1.45; color: #111; background: #fff; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .shop { font-size: 17px; font-weight: 700; }
  .kind { text-align: right; }
  .kind h1 { font-size: 15px; margin: 0; letter-spacing: 0.06em; text-transform: uppercase; }
  .kind .when { font-size: 11px; color: #555; }
  .rule { border-top: 2px solid #111; margin: 12px 0 14px; }
  .summary { display: flex; flex-wrap: wrap; gap: 24px; margin-bottom: 14px; }
  .summary div { font-size: 11px; color: #555; }
  .summary strong { display: block; font-size: 14px; color: #111; }
  section { margin-top: 18px; }
  section + section { page-break-before: always; }
  .person { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
  h2 { font-size: 15px; margin: 0 0 8px; }
  .period { font-size: 11px; color: #555; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: #666; padding: 0 8px 6px 0; border-bottom: 1px solid #bbb; }
  td { padding: 6px 8px 6px 0; border-bottom: 1px solid #eee; vertical-align: top; }
  td.when { white-space: nowrap; font-size: 11px; color: #444; }
  th.num, td.num { text-align: right; padding-right: 0; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sub { font-size: 10px; color: #666; }
  .st { display: inline-block; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; }
  .st.final { background: #e6eaf0; }
  .st.notfinal { background: #ffeddf; color: #8a3508; }
  .st.approval { background: #fff3c9; color: #6b4e00; }
  .st.off { background: #dcf2ea; color: #0b6b53; }
  footer { margin-top: 22px; font-size: 10px; color: #777; }
</style>
</head><body>
<header>
  <div class="shop">${esc(d.business || 'The business')}</div>
  <div class="kind"><h1>Staff deductions</h1><div class="when">${esc(d.periodWords)}</div></div>
</header>
<div class="rule"></div>
${people.length > 1 ? `<div class="summary">${totals(all)}</div>` : ''}
${sections || '<p>No shortages in this period for the people and kinds chosen.</p>'}
<footer>Made ${esc(d.day(d.madeAt))}${d.madeBy ? ` by ${esc(d.madeBy)}` : ''}. Only "Deducted" is taken from pay. "Not final" can still change: the person may answer and a manager decides. "Waiting on Approvals" is not on anyone's account yet. Amounts at selling price, less anything over on the same count.</footer>
</body></html>`;
}
