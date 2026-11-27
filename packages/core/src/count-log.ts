/**
 * The count log: every count filed, from every side, in one list.
 *
 * Four kinds of row, from three collections, in one shape:
 *
 *   - Stock counted at the start or end of a shift (shift_stock_checks for the
 *     bar and the kitchen; stock_counts with a shift for the shop).
 *   - A stocktake of a store room or the shop floor, which belongs to no shift.
 *   - The cash drawer, counted when the shift opens (the float) and when it
 *     closes (against what it should hold).
 *   - A count that should have been filed and was not: a shift that opened or
 *     closed without one. Missed counts are rows too, so the gap is as easy to
 *     find as the count.
 *
 * Pure. Reading is in count-log-store.ts. Nothing here imports at runtime, so
 * the rules can be tested on their own.
 */

export type CountLogKind = 'start' | 'end' | 'stocktake';
export type CountLogSide = 'bar' | 'kitchen' | 'craft' | 'cash';
export type CountLogState = 'agrees' | 'differs' | 'waiting' | 'refused' | 'undone' | 'missed' | 'partial';

export interface CountLogLine {
  name: string;
  expected: number;
  counted: number | null;
  /** counted − expected. Negative is short. */
  diff: number;
  /** What the difference is worth, signed like diff. */
  worth: number;
}

export interface CountLogEntry {
  /** Stable for the screen: kind, side and what it is of. */
  id: string;
  kind: CountLogKind;
  side: CountLogSide;
  /** When it was filed, or for a missed one when it should have been. */
  at: string;
  /** A shift code, a room, "Shop floor". */
  place: string;
  shiftId?: string;
  /** Who counted, as an id; the screen turns it into a name. */
  by?: string;
  /** Items counted, of how many on the sheet. Null for cash. */
  counted: number | null;
  of: number | null;
  /** Cash: what the drawer held when counted. */
  amount?: number;
  /** Money short and over, both as positive amounts. */
  short: number;
  over: number;
  state: CountLogState;
  /** A difference raised from it, where there is one. */
  chargeId?: string;
  /** Lines, where they are already in hand. Shop counts load theirs when opened. */
  lines?: CountLogLine[];
  /** A line under the row: who decided, what was missed, what it carried. */
  note?: string;
  /** Shop counts: the stock_counts row, to read its lines from. */
  countId?: string;
}

/* ------------------------------------------------------------ stock rows */

/** A counted line, as shift_stock_checks keeps it. */
export interface CheckRow {
  $id: string;
  $createdAt?: string;
  shift_id?: string | null;
  ingredient_id: string;
  phase?: 'open' | 'close' | null;
  module?: string | null;
  counted_qty?: number | null;
  theoretical_qty?: number | null;
  variance_qty?: number | null;
  variance_value?: number | null;
  checked_by?: string | null;
  applied?: boolean | null;
  approved_by?: string | null;
  rejected_at?: string | null;
  rejected_by?: string | null;
  undone_at?: string | null;
  charge_id?: string | null;
}

export const STORE_PREFIX = 'store:';

export interface Names {
  shift: (id: string) => string;
  room: (locationId: string) => string;
  shelf: (ingredientId: string) => string;
}

/** Where a set of counted lines stands, read from the lines. */
export function checkState(lines: Pick<CheckRow, 'applied' | 'rejected_at' | 'undone_at' | 'variance_qty'>[]): CountLogState {
  if (lines.some((l) => l.undone_at)) return 'undone';
  if (lines.some((l) => l.applied === false && !l.rejected_at)) return 'waiting';
  const differs = lines.some((l) => Number(l.variance_qty ?? 0) !== 0);
  const moved = lines.some((l) => Number(l.variance_qty ?? 0) !== 0 && l.applied !== false && !l.rejected_at);
  if (differs && !moved && lines.some((l) => l.rejected_at)) return 'refused';
  return differs ? 'differs' : 'agrees';
}

/**
 * One row per count: one shift and one end of it, or one store room's count.
 * Lines are grouped by shift and phase, as the count sheet writes them.
 */
export function entriesFromChecks(rows: CheckRow[], names: Names): CountLogEntry[] {
  const groups = new Map<string, CheckRow[]>();
  for (const r of rows) {
    const key = `${r.shift_id ?? ''}|${r.phase ?? 'close'}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: CountLogEntry[] = [];
  for (const [key, lines] of groups) {
    const shiftId = lines[0].shift_id ?? '';
    const phase = lines[0].phase ?? 'close';
    const store = shiftId.startsWith(STORE_PREFIX);
    const side = (lines.find((l) => l.module)?.module ?? 'bar') as CountLogSide;
    const at = lines.map((l) => l.$createdAt ?? '').filter(Boolean).sort()[0] ?? '';
    let short = 0;
    let over = 0;
    for (const l of lines) {
      const q = Number(l.variance_qty ?? 0);
      const v = Math.abs(Number(l.variance_value ?? 0));
      if (q < 0) short += v;
      else if (q > 0) over += v;
    }
    out.push({
      id: `stock|${key}`,
      kind: store ? 'stocktake' : phase === 'open' ? 'start' : 'end',
      side,
      at,
      place: store ? names.room(shiftId.slice(STORE_PREFIX.length)) : names.shift(shiftId),
      shiftId: store ? undefined : shiftId,
      by: lines.find((l) => l.checked_by)?.checked_by ?? undefined,
      counted: lines.filter((l) => typeof l.counted_qty === 'number').length,
      of: lines.length,
      short,
      over,
      state: checkState(lines),
      chargeId: lines.find((l) => l.charge_id)?.charge_id ?? undefined,
      lines: lines.map((l) => ({
        name: names.shelf(l.ingredient_id),
        expected: Number(l.theoretical_qty ?? 0),
        counted: typeof l.counted_qty === 'number' ? l.counted_qty : null,
        diff: Number(l.variance_qty ?? 0),
        worth: Math.sign(Number(l.variance_qty ?? 0)) * Math.abs(Number(l.variance_value ?? 0)),
      })),
    });
  }
  return out;
}

/** A shop count, as stock_counts keeps it. */
export interface LogShopCount {
  $id: string;
  $createdAt?: string;
  counted_by?: string | null;
  counted_at?: string | null;
  status?: 'pending' | 'approved' | 'rejected' | null;
  reviewed_by?: string | null;
  line_count?: number | null;
  missing_pieces?: number | null;
  missing_value?: number | null;
  surplus_pieces?: number | null;
  shift_id?: string | null;
  phase?: 'open' | 'close' | null;
  note?: string | null;
}

export function entriesFromShopCounts(rows: LogShopCount[], shiftName: (id: string) => string): CountLogEntry[] {
  return rows.map((c) => {
    const differs = (c.missing_pieces ?? 0) > 0 || (c.surplus_pieces ?? 0) > 0;
    const state: CountLogState = c.status === 'pending' ? 'waiting'
      : c.status === 'rejected' ? 'refused'
        : differs ? 'differs' : 'agrees';
    const bits = [
      c.missing_pieces ? `${c.missing_pieces} missing` : '',
      c.surplus_pieces ? `${c.surplus_pieces} more than expected` : '',
      c.note ?? '',
    ].filter(Boolean);
    return {
      id: `shop|${c.$id}`,
      kind: c.shift_id && c.phase ? (c.phase === 'open' ? 'start' : 'end') : 'stocktake',
      side: 'craft',
      at: c.counted_at || c.$createdAt || '',
      place: c.shift_id ? shiftName(c.shift_id) : 'Shop floor',
      shiftId: c.shift_id || undefined,
      by: c.counted_by ?? undefined,
      counted: c.line_count ?? 0,
      of: c.line_count ?? 0,
      short: Math.max(0, c.missing_value ?? 0),
      over: 0,
      state,
      note: bits.join(' · ') || undefined,
      countId: c.$id,
    } satisfies CountLogEntry;
  });
}

/* -------------------------------------------------------------- the drawer */

export interface DrawerShift {
  $id: string;
  code?: string | null;
  module?: string | null;
  status?: string | null;
  opened_by?: string | null;
  opened_at?: string | null;
  closed_by?: string | null;
  closed_at?: string | null;
  opening_floats?: string | null;
  float_source?: string | null;
  expected?: string | null;
  counted?: string | null;
  variance?: string | null;
  variance_note?: string | null;
}

const readMap = (json?: string | null): Record<string, number> => {
  try {
    const v = JSON.parse(json || '{}') as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v ?? {})) if (Number.isFinite(Number(n))) out[k] = Number(n);
    return out;
  } catch {
    return {};
  }
};
const total = (m: Record<string, number>): number => Object.values(m).reduce((a, n) => a + n, 0);

/**
 * The drawer counted at each end of each shift.
 *
 * Opening: the float put in the drawer, and whether it was carried over from
 * the shift before. Closing: what was counted against what the drawer should
 * have held; a difference is short or over by that much.
 */
export function drawerEntries(shifts: DrawerShift[], money: (n: number) => string): CountLogEntry[] {
  const out: CountLogEntry[] = [];
  for (const s of shifts) {
    const side = (s.module ?? 'kitchen') as CountLogSide;
    const place = s.code || 'A shift';
    if (s.opened_at) {
      const float = total(readMap(s.opening_floats));
      out.push({
        id: `cash|${s.$id}|open`,
        kind: 'start',
        side: 'cash',
        at: s.opened_at,
        place,
        shiftId: s.$id,
        by: s.opened_by ?? undefined,
        counted: null,
        of: null,
        amount: float,
        short: 0,
        over: 0,
        state: 'agrees',
        note: `${sideName(side)} drawer · float ${money(float)}${s.float_source === 'carried_over' ? ', carried over from the shift before' : ''}`,
      });
    }
    if (s.closed_at && s.status === 'closed') {
      const counted = readMap(s.counted);
      const variance = total(readMap(s.variance));
      const hasCount = Object.keys(counted).length > 0;
      out.push({
        id: `cash|${s.$id}|close`,
        kind: 'end',
        side: 'cash',
        at: s.closed_at,
        place,
        shiftId: s.$id,
        by: s.closed_by ?? undefined,
        counted: null,
        of: null,
        amount: total(counted),
        short: variance < 0 ? -variance : 0,
        over: variance > 0 ? variance : 0,
        state: !hasCount ? 'missed' : variance === 0 ? 'agrees' : 'differs',
        note: [
          `${sideName(side)} drawer · should have held ${money(total(readMap(s.expected)))}`,
          s.variance_note ? `“${s.variance_note}”` : '',
        ].filter(Boolean).join(' · '),
      });
    }
  }
  return out;
}

const sideName = (side: string): string => (side === 'bar' ? 'Bar' : side === 'craft' ? 'Shop' : 'Kitchen');

/* --------------------------------------------------------------- missed */

/**
 * Counts that should have been filed and were not.
 *
 * A shift on a side that counts in at open with no start-of-shift count, once
 * it has been open long enough to have done it; a closed shift on a side
 * that counts out with no end-of-shift count. Which sides count is asked of
 * the caller, from the same rules the till uses.
 */
export function missedCounts(
  shifts: DrawerShift[],
  filed: CountLogEntry[],
  expects: (module: string, phase: 'open' | 'close') => boolean,
  now: Date,
  graceMs = 60 * 60_000,
): CountLogEntry[] {
  const have = new Set(filed.filter((e) => e.side !== 'cash' && e.shiftId).map((e) => `${e.shiftId}|${e.kind}`));
  const out: CountLogEntry[] = [];
  for (const s of shifts) {
    const module = s.module ?? 'kitchen';
    const side = module as CountLogSide;
    if (s.opened_at && expects(module, 'open') && !have.has(`${s.$id}|start`)
      && now.getTime() - Date.parse(s.opened_at) > graceMs) {
      out.push({
        id: `missed|${s.$id}|open`, kind: 'start', side, at: s.opened_at, place: s.code || 'A shift', shiftId: s.$id,
        by: s.opened_by ?? undefined, counted: 0, of: null, short: 0, over: 0, state: 'missed',
        note: 'Opened with no start-of-shift count.',
      });
    }
    if (s.status === 'closed' && s.closed_at && expects(module, 'close') && !have.has(`${s.$id}|end`)) {
      out.push({
        id: `missed|${s.$id}|close`, kind: 'end', side, at: s.closed_at, place: s.code || 'A shift', shiftId: s.$id,
        by: s.closed_by ?? s.opened_by ?? undefined, counted: 0, of: null, short: 0, over: 0, state: 'missed',
        note: 'Closed with no end-of-shift count.',
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------- filtering */

export interface CountLogFilter {
  from: string; // ISO
  to: string; // ISO
  side?: CountLogSide | 'all';
  kind?: CountLogKind | 'all';
  by?: string; // id, '' for anybody
  onlyDifferences?: boolean;
}

export function filterLog(rows: CountLogEntry[], f: CountLogFilter): CountLogEntry[] {
  return rows
    .filter((e) => e.at >= f.from && e.at <= f.to)
    .filter((e) => !f.side || f.side === 'all' || e.side === f.side)
    .filter((e) => !f.kind || f.kind === 'all' || e.kind === f.kind)
    .filter((e) => !f.by || e.by === f.by)
    .filter((e) => !f.onlyDifferences || e.short > 0 || e.over > 0 || e.state === 'missed' || e.state === 'refused')
    .sort((a, b) => b.at.localeCompare(a.at));
}

export interface LogTotals { counts: number; agree: number; missed: number; short: number; over: number; net: number }

export function logTotals(rows: CountLogEntry[]): LogTotals {
  const short = rows.reduce((a, e) => a + e.short, 0);
  const over = rows.reduce((a, e) => a + e.over, 0);
  return {
    counts: rows.filter((e) => e.state !== 'missed').length,
    agree: rows.filter((e) => e.state === 'agrees').length,
    missed: rows.filter((e) => e.state === 'missed').length,
    short,
    over,
    net: over - short,
  };
}

export const LOG_KIND_WORDS: Record<CountLogKind, string> = {
  start: 'Start of shift',
  end: 'End of shift',
  stocktake: 'Stocktake',
};

export const LOG_SIDE_WORDS: Record<CountLogSide, string> = {
  bar: 'Bar', kitchen: 'Kitchen', craft: 'Shop', cash: 'Cash drawer',
};

export const LOG_STATE_WORDS: Record<CountLogState, string> = {
  agrees: 'Agrees',
  differs: 'Differs',
  waiting: 'Waiting on approval',
  refused: 'Refused',
  undone: 'Taken back',
  missed: 'Missed',
  partial: 'Part counted',
};

export const stateTone = (s: CountLogState): 'ok' | 'warn' | 'danger' | 'default' =>
  s === 'agrees' ? 'ok' : s === 'waiting' || s === 'partial' ? 'warn' : s === 'differs' || s === 'missed' ? 'danger' : 'default';

/**
 * The rows as a spreadsheet: one line per count, the way the screen shows
 * them. Quoted, and anything that would start a formula is prefixed so a
 * shelf named "=1+1" stays a name.
 */
export function countLogCsv(
  rows: CountLogEntry[],
  nameOf: (id?: string) => string,
  decimals = 2,
): string {
  const cell = (v: unknown): string => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const amt = (n: number): string => (n / 10 ** decimals).toFixed(decimals);
  const head = ['When', 'Shift or room', 'Side', 'Count', 'By', 'Counted', 'Of', 'Cash counted', 'Short', 'Over', 'State', 'Note'];
  const body = rows.map((e) => [
    e.at, e.place, LOG_SIDE_WORDS[e.side], LOG_KIND_WORDS[e.kind], nameOf(e.by),
    e.counted ?? '', e.of ?? '', e.amount !== undefined ? amt(e.amount) : '',
    amt(e.short), amt(e.over), LOG_STATE_WORDS[e.state], e.note ?? '',
  ]);
  return `﻿${[head, ...body].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
