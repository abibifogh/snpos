/**
 * What one person owes, over a period, as a statement.
 *
 * Read the way a bank statement is read: what they owed when the period
 * began, everything that happened in it in the order it happened — each
 * shortage charged, each surplus credited, each payment, deduction from pay,
 * find or write-off — with what they owed after each, and what they owed when
 * it ended. For the owner to hand over, keep on file, or take into a
 * conversation about pay.
 *
 * A credit lowers what they owe on the day the surplus was credited. When it
 * is later set against a shortage nothing more moves, so those matchings are
 * not lines of their own; the figures agree with Staff owing's.
 *
 * Pure. Imports nothing at runtime. Printed through the browser, which saves
 * it as a PDF; see openPrintable.
 */

import type { StaffCharge, StaffSettlement, SettleKind } from './staff-charges';

const SETTLED: Record<Exclude<SettleKind, 'credit'>, string> = {
  cash: 'Paid in cash',
  pay: 'Taken from pay',
  found: 'Found on the shelf',
  written_off: 'Written off',
};

export interface OwingLine {
  at: string;
  kind: 'charged' | 'credited' | Exclude<SettleKind, 'credit'>;
  /** In words: what happened. */
  what: string;
  /** In words: the item, quantity and price, or a note. */
  detail: string;
  /** Added to what they owe: a shortage. */
  owed: number;
  /** Taken off what they owe: a surplus, payment, find or write-off. */
  off: number;
  /** What they owe once this line is counted. Below nothing is credit waiting. */
  balance: number;
}

export interface OwingStatement {
  personId: string;
  name: string;
  /** What they owed when the period began. Below nothing is credit waiting. */
  opening: number;
  lines: OwingLine[];
  closing: number;
  /** The period's own figures. */
  charged: number;
  credited: number;
  putRight: Record<Exclude<SettleKind, 'credit'>, number>;
}

type Event = Omit<OwingLine, 'balance'>;

const basisWords = (c: StaffCharge): string =>
  c.price_basis === 'cost' ? 'cost' : c.price_basis === 'custom' ? 'a price set by hand' : 'selling price';

function eventsFor(personId: string, charges: StaffCharge[], settlements: StaffSettlement[], money: (n: number) => string): Event[] {
  const mine = charges.filter((c) => c.person_id === personId);
  const byId = new Map(mine.map((c) => [c.$id, c]));
  const out: Event[] = [];
  for (const c of mine) {
    const credit = c.direction === 'credit';
    out.push({
      at: c.charged_at,
      kind: credit ? 'credited' : 'charged',
      what: credit ? 'Credited for a surplus' : 'Charged for a shortage',
      detail: `${c.item_name} × ${c.qty} ${credit ? 'over' : 'short'} at ${money(c.unit_price)} (${basisWords(c)})${c.note ? ` · “${c.note}”` : ''}`,
      owed: credit ? 0 : c.amount || 0,
      off: credit ? c.amount || 0 : 0,
    });
  }
  for (const s of settlements) {
    const c = byId.get(s.charge_id);
    // A credit set against a shortage moves nothing: the credit already did.
    if (!c || s.kind === 'credit') continue;
    const bits = [c.item_name];
    if (s.kind === 'found' && s.qty_found) bits.push(`${s.qty_found} turned up`);
    if (s.note) bits.push(`“${s.note}”`);
    out.push({ at: s.recorded_at, kind: s.kind, what: SETTLED[s.kind], detail: bits.join(' · '), owed: 0, off: s.amount || 0 });
  }
  // Oldest first; on the same moment, what was owed before what put it right.
  return out.sort((a, b) => a.at.localeCompare(b.at) || b.owed - a.owed);
}

/**
 * One person's statement from `from` up to and including `to`, both ISO
 * moments. Everything before `from` is the opening figure.
 */
export function owingStatement(opts: {
  personId: string;
  charges: StaffCharge[];
  settlements: StaffSettlement[];
  from: string;
  to: string;
  money: (n: number) => string;
}): OwingStatement {
  const events = eventsFor(opts.personId, opts.charges, opts.settlements, opts.money);
  const name = opts.charges.find((c) => c.person_id === opts.personId)?.person_name ?? '';
  let balance = 0;
  for (const e of events) if (e.at < opts.from) balance += e.owed - e.off;
  const opening = balance;
  const putRight = { cash: 0, pay: 0, found: 0, written_off: 0 };
  let charged = 0;
  let credited = 0;
  const lines: OwingLine[] = [];
  for (const e of events) {
    if (e.at < opts.from || e.at > opts.to) continue;
    balance += e.owed - e.off;
    lines.push({ ...e, balance });
    if (e.kind === 'charged') charged += e.owed;
    else if (e.kind === 'credited') credited += e.off;
    else putRight[e.kind] += e.off;
  }
  return { personId: opts.personId, name, opening, lines, closing: balance, charged, credited, putRight };
}

/** Everyone with anything on their statement for the period, or owing going into it, by name. */
export function statementPeople(
  charges: StaffCharge[],
  settlements: StaffSettlement[],
  from: string,
  to: string,
  money: (n: number) => string,
): OwingStatement[] {
  const ids = [...new Set(charges.map((c) => c.person_id))];
  return ids
    .map((personId) => owingStatement({ personId, charges, settlements, from, to, money }))
    .filter((s) => s.lines.length > 0 || s.opening !== 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const esc = (s: string): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** What they owe, or the credit waiting for them, in words. */
export const balanceWords = (n: number, money: (n: number) => string): string =>
  n > 0 ? `${money(n)} owed` : n < 0 ? `${money(-n)} credit` : 'Nothing owed';

export function owingStatementHtml(d: {
  business: string;
  statements: OwingStatement[];
  /** The period as chosen, for the heading: dates, not moments. */
  periodWords: string;
  money: (n: number) => string;
  when: (iso: string) => string;
  madeAt: string;
  madeBy?: string;
}): string {
  const m = d.money;
  const sections = d.statements.map((s) => {
    const rows = s.lines.map((l) => `<tr>
        <td class="when">${esc(d.when(l.at))}</td>
        <td><strong>${esc(l.what)}</strong><div class="sub">${esc(l.detail)}</div></td>
        <td class="num">${l.owed ? esc(m(l.owed)) : ''}</td>
        <td class="num">${l.off ? esc(m(l.off)) : ''}</td>
        <td class="num">${esc(balanceWords(l.balance, m))}</td>
      </tr>`).join('');
    const right = Object.entries(s.putRight).filter(([, v]) => v > 0)
      .map(([k, v]) => `${SETTLED[k as keyof typeof SETTLED]} ${esc(m(v))}`).join(' · ');
    return `<section>
      <div class="person"><h2>${esc(s.name || 'Unnamed')}</h2><div class="period">${esc(d.periodWords)}</div></div>
      <div class="summary">
        <div>At the start<strong>${esc(balanceWords(s.opening, m))}</strong></div>
        <div>Charged<strong>${esc(m(s.charged))}</strong></div>
        <div>Credited<strong>${esc(m(s.credited))}</strong></div>
        <div>Put right<strong>${esc(m(Object.values(s.putRight).reduce((a, b) => a + b, 0)))}</strong></div>
        <div>At the end<strong>${esc(balanceWords(s.closing, m))}</strong></div>
      </div>
      <table>
        <thead><tr><th>When</th><th>What</th><th class="num">Owed</th><th class="num">Taken off</th><th class="num">Balance</th></tr></thead>
        <tbody>
          <tr class="edge"><td></td><td>At the start of the period</td><td></td><td></td><td class="num">${esc(balanceWords(s.opening, m))}</td></tr>
          ${rows || '<tr><td></td><td class="sub">Nothing happened in this period.</td><td></td><td></td><td></td></tr>'}
        </tbody>
        <tfoot><tr><td></td><td>At the end of the period</td><td class="num">${esc(m(s.charged))}</td><td class="num">${esc(m(s.credited + Object.values(s.putRight).reduce((a, b) => a + b, 0)))}</td><td class="num">${esc(balanceWords(s.closing, m))}</td></tr></tfoot>
      </table>
      ${right ? `<p class="note">Put right: ${right}.</p>` : ''}
    </section>`;
  }).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>Staff owing statement</title>
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
  section { margin-bottom: 26px; }
  section + section { page-break-before: always; }
  .person { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
  h2 { font-size: 15px; margin: 0 0 8px; }
  .period { font-size: 11px; color: #555; }
  .summary { display: flex; flex-wrap: wrap; gap: 24px; margin-bottom: 14px; }
  .summary div { font-size: 11px; color: #555; }
  .summary strong { display: block; font-size: 14px; color: #111; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: #666; padding: 0 8px 6px 0; border-bottom: 1px solid #bbb; }
  td { padding: 6px 8px 6px 0; border-bottom: 1px solid #eee; vertical-align: top; }
  td.when { white-space: nowrap; font-size: 11px; color: #444; }
  th.num, td.num { text-align: right; padding-right: 0; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr.edge td { color: #444; font-style: italic; }
  .sub { font-size: 10px; color: #666; }
  tfoot td { border-bottom: none; border-top: 2px solid #111; font-weight: 700; padding-top: 7px; }
  .note { margin-top: 10px; font-size: 10px; color: #555; }
  footer { margin-top: 22px; font-size: 10px; color: #777; text-align: center; }
</style>
</head><body>
<header>
  <div class="shop">${esc(d.business || 'The business')}</div>
  <div class="kind"><h1>Staff owing</h1><div class="when">${esc(d.periodWords)}</div></div>
</header>
<div class="rule"></div>
${sections || '<p>Nobody owed anything, and nothing was charged or put right, in this period.</p>'}
<footer>Made ${esc(d.when(d.madeAt))}${d.madeBy ? ` by ${esc(d.madeBy)}` : ''}. Shortages are charged at the price shown on each line; a credit for a surplus comes off what is owed.</footer>
</body></html>`;
}
