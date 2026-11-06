/**
 * Bar count differences that go straight onto somebody's account, not final.
 *
 * Switched on under Features (count_charges). A bar count then takes effect
 * the moment it is saved: there is no approval, the shelf moves to what was
 * counted. Whatever came up short, less anything that came up over on the
 * same count, at selling price, goes onto the account of whoever answers for
 * it — as a deduction that is NOT FINAL:
 *
 *   - The person has a day (answer_hours) to accept it, offer to put it back
 *     at their next shift, or explain.
 *   - A manager decides: deduct it all, deduct part, waive it, or agree to
 *     the put-back. A decision can be taken back until it has gone to HIVE.
 *   - Nobody decides in time: accepted or unanswered is deducted at the
 *     deadline; explained or offered back waits for a manager, who is
 *     reminded each morning.
 *
 * Who answers for it is the shift the count CHECKS. A closing count is the
 * shift that is closing. An opening count that does not agree with what was
 * handed over is the shift before it, because the stock went before this one
 * started.
 *
 * The server (functions/notify/src/count-charges.js) is the only thing that
 * writes these fields; it keeps its own copy of the rules that decide money,
 * and this file is what the screens use to say where each one stands.
 *
 * Pure. Imports nothing at runtime.
 */
import type { StaffCharge } from './staff-charges';

export const COUNT_CHARGES = 'count_charges';
/** How long somebody has to answer, unless the feature says otherwise. */
export const ANSWER_HOURS = 24;

export type CountDecision = 'pending' | 'deduct' | 'part' | 'waived' | 'putback';
export type CountAnswer = 'accept' | 'putback' | 'explain';

/** One line of the count that differed, as it was priced. */
export interface CountChargeLine {
  name: string;
  /** Negative is short, positive is over. */
  qty: number;
  unit_price: number;
  /** Signed like qty: what the line takes off, or puts back on, the total. */
  amount: number;
  basis?: 'selling' | 'cost';
  ingredient_id?: string;
}

export interface CountCharge extends StaffCharge {
  decision?: CountDecision | null;
  shift_id?: string | null;
  phase?: string | null;
  counted_by?: string | null;
  lines?: string | null;
  answer?: CountAnswer | null;
  answer_note?: string | null;
  answered_at?: string | null;
  answered_by?: string | null;
  answer_by?: string | null;
  decided_by?: string | null;
  decided_name?: string | null;
  decided_at?: string | null;
  decided_note?: string | null;
  decided_amount?: number | null;
  hive_staff_id?: string | null;
  hive_sent_at?: string | null;
  putback_shift_id?: string | null;
  reminded_on?: string | null;
  reopened_by?: string | null;
}

/** A charge raised by a count on its own, rather than one an admin made. */
export const isCountCharge = (c: Pick<CountCharge, 'decision'>): boolean => !!c.decision;

/** The lines a count charge was made of. Empty if they could not be read. */
export function countChargeLines(c: Pick<CountCharge, 'lines'>): CountChargeLine[] {
  try {
    const rows = JSON.parse(c.lines || '[]');
    return Array.isArray(rows) ? rows as CountChargeLine[] : [];
  } catch {
    return [];
  }
}

/* -------------------------------------------------------- who answers */

export interface ShiftRunner {
  $id: string;
  opened_by?: string | null;
  opened_at?: string;
}

/**
 * Whose shift a count's differences belong to.
 *
 * Closing: the shift closing. Opening: the one before, because what an
 * opening count finds missing went before this shift started — and if this
 * person's own opening count agreed, anything short at close is theirs.
 * Null where there is no earlier shift to answer for an opening count.
 */
export function answerableShift<S extends ShiftRunner>(
  phase: 'open' | 'close',
  shift: S,
  previous: S | null | undefined,
): S | null {
  if (phase === 'close') return shift;
  return previous ?? null;
}

/* ------------------------------------------------------------ netting */

export interface PricedDifference {
  name: string;
  /** Counted minus expected. */
  variance: number;
  /** Per unit, in minor units. */
  price: number;
  basis?: 'selling' | 'cost';
  ingredientId?: string;
}

/**
 * What a count comes to, with anything over set against what is short.
 *
 * A bottle over on the same count is very often the bottle short on the next
 * line, rung up as the wrong size; so the count is charged as one figure. A
 * count that only comes out over charges nobody, and is never paid out.
 */
export function nettedCount(diffs: PricedDifference[]): {
  lines: CountChargeLine[];
  short: number;
  over: number;
  /** What is owed: short less over, never below nothing. */
  owed: number;
} {
  const lines: CountChargeLine[] = [];
  let short = 0;
  let over = 0;
  for (const d of diffs) {
    const qty = Number((d.variance || 0).toFixed(4));
    if (qty === 0) continue;
    const price = Math.max(0, Math.round(d.price || 0));
    const amount = Math.round(Math.abs(qty) * price) * Math.sign(qty);
    if (amount < 0) short += -amount;
    else over += amount;
    lines.push({
      name: d.name, qty, unit_price: price, amount, basis: d.basis ?? 'selling',
      ...(d.ingredientId ? { ingredient_id: d.ingredientId } : {}),
    });
  }
  // Short lines first: it is what the person is being asked about.
  lines.sort((a, b) => a.amount - b.amount);
  return { lines, short, over, owed: Math.max(0, short - over) };
}

/* ------------------------------------------------------------ the clock */

export const answerDeadline = (chargedAt: string, hours = ANSWER_HOURS): string =>
  new Date(new Date(chargedAt).getTime() + Math.max(1, hours) * 3_600_000).toISOString();

/** "19 h 12 min", "40 min", or "time is up". */
export function timeLeftWords(ms: number): string {
  if (!(ms > 0)) return 'time is up';
  const mins = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export const msLeft = (c: Pick<CountCharge, 'answer_by'>, now: Date): number =>
  c.answer_by ? new Date(c.answer_by).getTime() - now.getTime() : 0;

/** Asked a manager to look at it, rather than accepting it. */
export const wantsManager = (c: Pick<CountCharge, 'answer'>): boolean =>
  c.answer === 'explain' || c.answer === 'putback';

/**
 * What happens on its own once the time is up: deducted, if the person
 * accepted it or said nothing. If they explained or offered it back it waits
 * for a manager however long that takes.
 */
export function autoDecision(c: Pick<CountCharge, 'decision' | 'answer' | 'answer_by' | 'reopened_by'>, now: Date): 'deduct' | null {
  if (c.decision !== 'pending' || !c.answer_by) return null;
  // Taken back by a manager: theirs to decide again, not the clock's.
  if (c.reopened_by) return null;
  if (now.getTime() < new Date(c.answer_by).getTime()) return null;
  return wantsManager(c) ? null : 'deduct';
}

/* ------------------------------------------------------- where it stands */

export type CountStage =
  | 'answering' // not final, within their time, no answer or accepted
  | 'manager' // explained or offered it back: a manager's to decide
  | 'due' // time is up, accepted or silent: deducted on the next run
  | 'deducted'
  | 'part'
  | 'waived'
  | 'putback' // agreed, waiting for their next drawer
  | 'paid_back'
  | 'sent'; // deducted and taken by HIVE: final for good

export function countStage(c: CountCharge, now: Date): CountStage {
  switch (c.decision) {
    case 'deduct': return c.hive_sent_at ? 'sent' : 'deducted';
    case 'part': return c.hive_sent_at ? 'sent' : 'part';
    case 'waived': return 'waived';
    case 'putback': return c.status === 'settled' ? 'paid_back' : 'putback';
    default:
      if (wantsManager(c) || c.reopened_by) return 'manager';
      return msLeft(c, now) > 0 ? 'answering' : 'due';
  }
}

export const isFinal = (stage: CountStage): boolean =>
  stage === 'sent' || stage === 'waived' || stage === 'paid_back';

/** What a pill says about a charge, and in which tone. */
export function stageWords(c: CountCharge, now: Date): { label: string; tone: 'warn' | 'ok' | 'brand' | 'neutral' } {
  const stage = countStage(c, now);
  switch (stage) {
    case 'answering': return { label: `Not final · ${timeLeftWords(msLeft(c, now))} left`, tone: 'warn' };
    case 'manager': return {
      label: c.answer === 'putback' ? 'Waiting · offered to put back' : c.answer === 'explain' ? 'Waiting · explained' : 'Waiting for a manager',
      tone: 'warn',
    };
    case 'due': return { label: 'Deducted on the next run', tone: 'warn' };
    case 'deducted': return { label: 'Deducted', tone: 'brand' };
    case 'part': return { label: 'Deducted (part)', tone: 'brand' };
    case 'waived': return { label: 'Waived', tone: 'ok' };
    case 'putback': return { label: 'Put back at next shift', tone: 'neutral' };
    case 'paid_back': return { label: 'Put back', tone: 'ok' };
    case 'sent': return { label: c.decision === 'part' ? 'Deducted (part)' : 'Deducted', tone: 'brand' };
  }
  return { label: 'Not final', tone: 'warn' };
}

/** What is taken from pay. Nothing until a manager or the clock has decided. */
export function deductedAmount(c: Pick<CountCharge, 'decision' | 'amount' | 'decided_amount'>): number {
  if (c.decision === 'deduct') return c.amount || 0;
  if (c.decision === 'part') return Math.max(0, Math.min(c.amount || 0, c.decided_amount || 0));
  return 0;
}

/* --------------------------------------------------------- checks first */

/** Why this answer cannot be sent, or null. */
export function answerProblem(c: Pick<CountCharge, 'decision'>, answer: CountAnswer | null, note: string): string | null {
  if (c.decision !== 'pending') return 'A manager has already decided this one.';
  if (!answer) return 'Choose an answer first.';
  if (answer === 'explain' && note.trim().length < 3) return 'Say what happened, so the manager can decide.';
  return null;
}

/** Why a manager cannot decide this, as asked, or null. */
export function decisionProblem(
  c: Pick<CountCharge, 'decision' | 'amount' | 'answer'>,
  decision: Exclude<CountDecision, 'pending'>,
  amount: number,
  note: string,
): string | null {
  if (c.decision !== 'pending') return 'This has already been decided. Undo that first.';
  if (decision === 'part') {
    if (!Number.isFinite(amount) || !(amount > 0)) return 'Say how much to deduct.';
    if (amount >= (c.amount || 0)) return 'That is all of it. Use Deduct instead.';
    if (note.trim().length < 3) return 'Say why only part is deducted. They will see it.';
  }
  if (decision === 'waived' && note.trim().length < 3) return 'Say why it is waived. They will see it.';
  if (decision === 'putback' && c.answer !== 'putback') return 'Only when they have offered to put it back.';
  return null;
}

/** Why a decision cannot be taken back, or null. */
export function countUndoProblem(c: CountCharge): string | null {
  if (!c.decision || c.decision === 'pending') return 'There is no decision to undo.';
  if (c.hive_sent_at) return 'This has gone to HIVE, so it is final.';
  if (c.decision === 'putback' && (c.putback_shift_id || c.status === 'settled')) return 'It has been put back already.';
  return null;
}

/* -------------------------------------------------------------- put back */

export interface Putback { charge_id: string; amount: number; method_id: string }

/**
 * What this person agreed to put back, to add to the drawer they are about
 * to close. Only theirs, only what a manager agreed to, only what is left.
 */
export function putbacksDue(charges: CountCharge[], person: { userId?: string | null; profileId?: string | null }): CountCharge[] {
  return charges.filter((c) => c.decision === 'putback'
    && c.status === 'open'
    && !c.putback_shift_id
    && (c.amount || 0) - (c.settled_total || 0) > 0
    && ((person.userId && c.person_user_id === person.userId) || (person.profileId && c.person_id === person.profileId)));
}

/* --------------------------------------------------------------- HIVE */

/** The reference HIVE keeps, so it never takes the same deduction twice. */
export const hiveRef = (chargeId: string): string => `POS-${chargeId}`;

export interface HiveRow {
  ref: string;
  chargeId: string;
  personId: string;
  name: string;
  hiveStaffId: string;
  hiveName: string;
  date: string;
  amount: number;
  description: string;
  sentAt: string | null;
}

/** The month a charge was decided in, as YYYY-MM. */
export const decidedMonth = (iso: string): string => (iso || '').slice(0, 7);

/**
 * The final deductions of a month, for HIVE: one row each. A person not
 * matched to HIVE yet is left out and reported, never guessed.
 */
export function hiveRows(
  charges: CountCharge[],
  profiles: { $id: string; display_name?: string; hive_staff_id?: string | null; hive_name?: string | null }[],
  month: string,
): { rows: HiveRow[]; unmatched: { personId: string; name: string; amount: number }[] } {
  const rows: HiveRow[] = [];
  const unmatched = new Map<string, { personId: string; name: string; amount: number }>();
  for (const c of charges) {
    const amount = deductedAmount(c);
    if (!(amount > 0)) continue;
    const when = c.decided_at || c.charged_at;
    if (month && decidedMonth(when) !== month) continue;
    const p = profiles.find((x) => x.$id === c.person_id);
    const hiveStaffId = c.hive_staff_id || p?.hive_staff_id || '';
    if (!hiveStaffId) {
      const u = unmatched.get(c.person_id) ?? { personId: c.person_id, name: c.person_name, amount: 0 };
      u.amount += amount;
      unmatched.set(c.person_id, u);
      continue;
    }
    rows.push({
      ref: hiveRef(c.$id),
      chargeId: c.$id,
      personId: c.person_id,
      name: c.person_name,
      hiveStaffId,
      hiveName: p?.hive_name || '',
      date: when.slice(0, 10),
      amount,
      description: `Bar count difference${c.phase === 'open' ? ' (counted in)' : c.phase === 'close' ? ' (counted out)' : ''}, ${c.charged_at.slice(0, 10)}${c.decision === 'part' ? ', part' : ''}`,
      sentAt: c.hive_sent_at ?? null,
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return { rows, unmatched: [...unmatched.values()] };
}

/** The same quoting as toCsv in csv.ts: a cell starting = + - @ is never read as a formula. */
const csvCell = (value: unknown): string => {
  let v = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(v)) v = `\t${v}`;
  return `"${v.replace(/"/g, '""')}"`;
};
const csvOf = (headers: string[], rows: unknown[][]): string =>
  `\uFEFF${[headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n')}`;

/**
 * The rows as a spreadsheet HIVE can import, one deduction per row, amounts
 * in the currency's major unit. Each row carries its reference, so importing
 * the same month twice cannot take the same deduction twice.
 */
export function hiveCsv(rows: HiveRow[], decimals = 2): string {
  return csvOf(
    ['Reference', 'HIVE staff ID', 'HIVE name', 'Name on the POS', 'Date', 'Amount', 'Description', 'Already sent'],
    rows.map((r) => [
      r.ref, r.hiveStaffId, r.hiveName, r.name, r.date, (r.amount / 10 ** decimals).toFixed(decimals), r.description,
      r.sentAt ? r.sentAt.slice(0, 10) : '',
    ]),
  );
}

/* ------------------------------------------------------------- matching */

export interface HiveStaff { $id: string; hive_id: string; name: string; email?: string | null; active?: boolean | null }

const plain = (s?: string | null): string => (s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Who in HIVE this person probably is: the same email, or else exactly the
 * same name. Offered, never applied: an admin chooses it.
 */
export function suggestHiveMatch(
  profile: { email?: string | null; display_name?: string | null },
  staff: HiveStaff[],
  taken: Set<string> = new Set(),
): HiveStaff | null {
  const free = staff.filter((s) => s.active !== false && !taken.has(s.hive_id));
  const email = plain(profile.email);
  if (email) {
    const byEmail = free.find((s) => plain(s.email) === email);
    if (byEmail) return byEmail;
  }
  const name = plain(profile.display_name);
  if (!name) return null;
  const same = free.filter((s) => plain(s.name) === name);
  return same.length === 1 ? same[0]! : null;
}
