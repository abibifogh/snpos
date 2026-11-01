/**
 * Cleaning routines: what the kitchen and the bar check before they open and
 * after they close, and the longer list on the deep-clean day.
 *
 * Each side has one routine, off until an admin switches it on. Switched on,
 * the opening list stands between the screen and the first ticket (or, if
 * the admin prefers, sits beside it), the closing list comes before the shift
 * can be closed, and on the chosen day the deep clean is added to whichever
 * of the two the admin picked. Every tick is written down with who and when,
 * so there is a record ready for an inspector; a warm fridge or a check
 * skipped with a reason goes to Approvals for a manager to see.
 *
 * Pure. Imports nothing at runtime. The reads and writes are in
 * cleaning-store.ts.
 */

export type CleanSide = 'kitchen' | 'bar';
export const CLEAN_SIDES: CleanSide[] = ['kitchen', 'bar'];
export type CleanKind = 'open' | 'close';

/** A plain tick, a reading in °C that must fall in a range, or a photo. */
export type CleanItemKind = 'tick' | 'temp' | 'photo';

export interface CleanItem {
  /** Stable across edits, so a renamed check keeps its history. */
  id: string;
  /** The heading it sits under: You, Surfaces, Fridges and freezers. */
  area: string;
  text: string;
  /** A line of how, under the check. */
  hint?: string;
  required: boolean;
  kind: CleanItemKind;
  /** For a temperature: the safe range, in °C, both ends included. */
  min?: number;
  max?: number;
}

export interface CleanRoutine {
  side: CleanSide;
  /** Off until an admin switches it on. */
  active: boolean;
  /**
   * What happens before the required checks are done. `hold`: the screen
   * waits, with a way to start anyway that asks for a reason. `show`: the
   * list is there and nothing waits on it.
   */
  hold: 'hold' | 'show';
  /** Day of the deep clean, 1 Monday to 7 Sunday; 0 for none. */
  deepDay: number;
  /** Done before opening on that day, or after closing the night before. */
  deepWhen: 'before' | 'after';
  open: CleanItem[];
  close: CleanItem[];
  deep: CleanItem[];
}

/** One answer on a filed list. */
export interface CleanAnswer {
  id: string;
  text: string;
  area: string;
  required: boolean;
  kind: CleanItemKind;
  /** Ticked, read or photographed. */
  done: boolean;
  /** When, ISO. */
  at?: string;
  /** The reading, for a temperature. */
  value?: number;
  /** The reading was outside the safe range. */
  out?: boolean;
  /** The photo, for a photo check. */
  photoId?: string;
  /** Part of the deep clean. */
  deep?: boolean;
}

const t = (id: string, area: string, text: string, required = true, hint?: string): CleanItem =>
  ({ id, area, text, required, kind: 'tick', ...(hint ? { hint } : {}) });
const temp = (id: string, area: string, text: string, min: number, max: number): CleanItem =>
  ({ id, area, text, required: true, kind: 'temp', min, max, hint: rangeWords(min, max) });
const photo = (id: string, area: string, text: string): CleanItem =>
  ({ id, area, text, required: true, kind: 'photo', hint: 'Take a photo when done' });

/**
 * The lists a business starts with. Suggestions, written for a Ghanaian
 * bistro and bar; every line can be renamed, moved, added or removed.
 */
export const DEFAULT_ROUTINES: Record<CleanSide, CleanRoutine> = {
  kitchen: {
    side: 'kitchen', active: false, hold: 'hold', deepDay: 1, deepWhen: 'before',
    open: [
      t('k-hands', 'You', 'Hands washed with soap, up to the wrists'),
      t('k-dress', 'You', 'Apron, hair net or cap, no jewellery'),
      t('k-well', 'You', 'Feeling well? Nobody cooks with fever, diarrhoea or vomiting', true, 'Tell the manager and go home'),
      t('k-tables', 'Surfaces', 'Prep tables washed and sanitised', true, 'Hot soapy water, then sanitiser, left to air dry'),
      t('k-boards', 'Surfaces', 'Chopping boards sorted by colour', true, 'Red raw meat · blue fish · green veg · white bread'),
      t('k-sinks', 'Surfaces', 'Sinks and taps scrubbed', false),
      temp('k-walkin', 'Fridges and freezers', 'Walk-in fridge', 0, 5),
      temp('k-under', 'Fridges and freezers', 'Under-counter fridge', 0, 5),
      temp('k-freezer', 'Fridges and freezers', 'Chest freezer', -40, -18),
      t('k-labels', 'Fridges and freezers', 'Yesterday’s food labelled, old stock to the front', true, 'Anything past its date goes in the bin'),
      t('k-stove', 'Equipment', 'Stove tops and grill wiped down'),
      t('k-fryer', 'Equipment', 'Fryer oil checked, changed if dark', false),
      t('k-hood', 'Equipment', 'Extractor hood: outside wiped', false),
      t('k-floor', 'Floor and bins', 'Floor swept and mopped'),
      t('k-bins', 'Floor and bins', 'Bins emptied, washed and relined'),
    ],
    close: [
      t('kc-cover', 'Food', 'Food covered, labelled with today’s date and in the fridge', true, 'Cooked food cooled and in the fridge within two hours'),
      t('kc-bin', 'Food', 'Anything left out too long thrown away'),
      temp('kc-walkin', 'Fridges and freezers', 'Walk-in fridge', 0, 5),
      temp('kc-freezer', 'Fridges and freezers', 'Chest freezer', -40, -18),
      t('kc-gas', 'Equipment', 'Stoves, grill and fryer off; gas valves closed'),
      t('kc-fryer', 'Equipment', 'Fryer covered once cool', false),
      t('kc-surfaces', 'Surfaces', 'Prep tables, boards and knives washed and sanitised'),
      t('kc-dishes', 'Surfaces', 'Every pot, pan and dish washed and put away'),
      t('kc-floor', 'Floor and bins', 'Floor swept and mopped'),
      t('kc-bins', 'Floor and bins', 'Bins taken out and relined'),
    ],
    deep: [
      photo('kd-oven', 'Deep clean', 'Oven inside: racks out, degreased'),
      photo('kd-hood', 'Deep clean', 'Hood filters soaked and scrubbed'),
      photo('kd-walkin', 'Deep clean', 'Walk-in fridge emptied, shelves washed'),
      t('kd-behind', 'Deep clean', 'Behind and under the stoves and fridges'),
      t('kd-drains', 'Deep clean', 'Drains cleared and flushed'),
      t('kd-walls', 'Deep clean', 'Walls and tiles around the cooking line', false),
      t('kd-fryer', 'Deep clean', 'Fryer drained, cleaned, fresh oil', false),
    ],
  },
  bar: {
    side: 'bar', active: false, hold: 'hold', deepDay: 1, deepWhen: 'before',
    open: [
      t('b-hands', 'You', 'Hands washed with soap, up to the wrists'),
      t('b-dress', 'You', 'Clean uniform, hair tied back, no rings on the pouring hand', false),
      t('b-top', 'Bar top', 'Bar top and speed rail wiped and sanitised'),
      t('b-mats', 'Bar top', 'Bar mats washed'),
      t('b-ice', 'Ice', 'Ice well clean; scoop kept outside the ice', true, 'Never scoop with a glass'),
      t('b-washer', 'Glasses', 'Glass washer filled, rinse running hot'),
      t('b-glasses', 'Glasses', 'Glasses polished, no chips or lipstick'),
      temp('b-fridge', 'Fridges', 'Bottle fridge', 1, 5),
      t('b-garnish', 'Garnish', 'Garnishes cut fresh today and covered'),
      t('b-floor', 'Floor and bins', 'Floor swept and mopped'),
      t('b-bins', 'Floor and bins', 'Bins emptied and relined'),
    ],
    close: [
      t('bc-glasses', 'Glasses', 'Every glass washed and put away'),
      t('bc-ice', 'Ice', 'Ice well emptied, washed and dried'),
      t('bc-rail', 'Bar top', 'Speed rail and bottles wiped; pourers covered'),
      t('bc-garnish', 'Garnish', 'Garnishes covered and in the fridge, or thrown away'),
      temp('bc-fridge', 'Fridges', 'Bottle fridge', 1, 5),
      t('bc-off', 'Equipment', 'Glass washer drained and off; blender washed'),
      t('bc-floor', 'Floor and bins', 'Floor mopped'),
      t('bc-bins', 'Floor and bins', 'Bins taken out'),
    ],
    deep: [
      photo('bd-ice', 'Deep clean', 'Ice machine emptied and cleaned inside'),
      photo('bd-washer', 'Deep clean', 'Glass washer descaled'),
      t('bd-fridges', 'Deep clean', 'Fridges emptied, shelves and seals washed'),
      t('bd-behind', 'Deep clean', 'Behind and under the fridges and the bar'),
      t('bd-drains', 'Deep clean', 'Drains cleared and flushed'),
      t('bd-shelves', 'Deep clean', 'Back-bar shelves cleared and wiped', false),
    ],
  },
};

export const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** "Safe at 0 to 5 °C", or "Safe at −18 °C or colder" for a freezer. */
export function rangeWords(min?: number, max?: number): string {
  const n = (v: number) => (v < 0 ? `−${Math.abs(v)}` : String(v));
  if (min !== undefined && max !== undefined && min <= -30) return `Safe at ${n(max)} °C or colder`;
  if (min !== undefined && max !== undefined) return `Safe at ${n(min)} to ${n(max)} °C`;
  if (max !== undefined) return `Safe at ${n(max)} °C or colder`;
  if (min !== undefined) return `Safe at ${n(min)} °C or warmer`;
  return '';
}

/** A reading as typed, with a comma or a typographic minus forgiven. Null when it is not a number. */
export function readTemp(text: string): number | null {
  const v = Number(String(text).trim().replace(',', '.').replace(/−/g, '-'));
  return text.trim() !== '' && Number.isFinite(v) ? v : null;
}

/** Whether a reading falls outside the check's safe range. */
export function tempOut(item: Pick<CleanItem, 'min' | 'max'>, value: number): boolean {
  return (item.min !== undefined && value < item.min) || (item.max !== undefined && value > item.max);
}

/** Monday 1 to Sunday 7, for a date. */
export const isoDay = (d: Date): number => ((d.getDay() + 6) % 7) + 1;

/** The calendar day a list belongs to, on the reader's clock: 2026-11-02. */
export function cleanDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Whether the deep clean belongs to this list, on this date.
 *
 * Before opening: the opening list on the deep-clean day. After closing the
 * night before: the closing list on the day before it.
 */
export function deepToday(r: Pick<CleanRoutine, 'deepDay' | 'deepWhen'>, kind: CleanKind, d: Date): boolean {
  if (!r.deepDay) return false;
  if (kind === 'open') return r.deepWhen === 'before' && isoDay(d) === r.deepDay;
  return r.deepWhen === 'after' && (isoDay(d) % 7) + 1 === r.deepDay;
}

/** The checks on this list today, deep clean included where it belongs. */
export function listFor(r: CleanRoutine, kind: CleanKind, d: Date): (CleanItem & { deep?: boolean })[] {
  const base = kind === 'open' ? r.open : r.close;
  return deepToday(r, kind, d) ? [...base, ...r.deep.map((i) => ({ ...i, deep: true }))] : base;
}

/** The checks grouped by heading, in the order they first appear. */
export function byArea<T extends { area: string }>(items: T[]): [string, T[]][] {
  const out: [string, T[]][] = [];
  for (const i of items) {
    const g = out.find(([a]) => a === i.area);
    if (g) g[1].push(i); else out.push([i.area, [i]]);
  }
  return out;
}

/** How far a list has got. */
export function cleanProgress(answers: Pick<CleanAnswer, 'done' | 'required' | 'out'>[]): {
  done: number; of: number; requiredLeft: number; outOfRange: number;
} {
  return {
    done: answers.filter((a) => a.done).length,
    of: answers.length,
    requiredLeft: answers.filter((a) => a.required && !a.done).length,
    outOfRange: answers.filter((a) => a.out).length,
  };
}

/**
 * Whether a filed list goes to Approvals: started without its required
 * checks, or with a reading outside the safe range. A clean list does not.
 */
export const needsReview = (answers: Pick<CleanAnswer, 'done' | 'required' | 'out'>[], skipped: boolean): boolean => {
  const p = cleanProgress(answers);
  return skipped || p.requiredLeft > 0 || p.outOfRange > 0;
};

/** What a manager reads on Approvals about a filed list. */
export function reviewWords(log: {
  side: string; kind: CleanKind; answers: CleanAnswer[]; skipReason?: string; deep?: boolean;
}): { title: string; detail: string } {
  const side = log.side === 'bar' ? 'Bar' : 'Kitchen';
  const what = `${log.kind === 'open' ? 'opening' : 'closing'} clean${log.deep ? ' and deep clean' : ''}`;
  const p = cleanProgress(log.answers);
  const warm = log.answers.filter((a) => a.out).map((a) => `${a.text} at ${a.value} °C`);
  const parts: string[] = [];
  if (p.requiredLeft > 0) parts.push(`${p.requiredLeft} required check${p.requiredLeft === 1 ? '' : 's'} not done`);
  if (warm.length) parts.push(`outside the safe range: ${warm.join(', ')}`);
  if (log.skipReason) parts.push(`reason given: “${log.skipReason}”`);
  return {
    title: `${side} ${what}: ${p.done} of ${p.of} done`,
    detail: parts.length
      ? `${parts.join('; ').replace(/^./, (c) => c.toUpperCase())}. Marking it seen keeps the record as it is.`
      : 'Every check done. Marking it seen keeps the record as it is.',
  };
}

/* ---------------------------------------------------------- stored form */

const KINDS: CleanItemKind[] = ['tick', 'temp', 'photo'];

/** A stored list, read back. Anything malformed is dropped rather than trusted. */
export function readItems(raw: unknown): CleanItem[] | null {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return null;
    try { v = JSON.parse(raw); } catch { return null; }
  }
  if (!Array.isArray(v)) return null;
  return v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string')
    .map((x, n) => {
      const kind = KINDS.includes(x.kind as CleanItemKind) ? x.kind as CleanItemKind : 'tick';
      const num = (k: string) => (typeof x[k] === 'number' && Number.isFinite(x[k]) ? x[k] as number : undefined);
      return {
        id: typeof x.id === 'string' && x.id ? x.id : `i${n}`,
        area: typeof x.area === 'string' && x.area.trim() ? x.area.trim() : 'Other',
        text: String(x.text).trim(),
        ...(typeof x.hint === 'string' && x.hint.trim() ? { hint: x.hint.trim() } : {}),
        required: x.required !== false,
        kind,
        ...(kind === 'temp' ? { min: num('min'), max: num('max') } : {}),
      };
    })
    .filter((i) => i.text !== '');
}

/** A side's routine from its stored row, with the defaults filling anything missing. */
export function routineFrom(side: CleanSide, row: {
  active?: boolean; hold?: string; deep_day?: number; deep_when?: string;
  open_items?: string; close_items?: string; deep_items?: string;
} | null | undefined): CleanRoutine {
  const d = DEFAULT_ROUTINES[side];
  if (!row) return { ...d };
  return {
    side,
    active: row.active === true,
    hold: row.hold === 'show' ? 'show' : 'hold',
    deepDay: typeof row.deep_day === 'number' && row.deep_day >= 0 && row.deep_day <= 7 ? row.deep_day : d.deepDay,
    deepWhen: row.deep_when === 'after' ? 'after' : 'before',
    open: readItems(row.open_items) ?? d.open,
    close: readItems(row.close_items) ?? d.close,
    deep: readItems(row.deep_items) ?? d.deep,
  };
}

/** A routine in the shape its row stores. */
export function routineRow(r: CleanRoutine) {
  return {
    active: r.active,
    hold: r.hold,
    deep_day: r.deepDay,
    deep_when: r.deepWhen,
    open_items: JSON.stringify(r.open),
    close_items: JSON.stringify(r.close),
    deep_items: JSON.stringify(r.deep),
  };
}

/** A filed list's answers, read back. */
export function readAnswers(raw: unknown): CleanAnswer[] {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v.filter((a) => a && typeof a.text === 'string') as CleanAnswer[] : [];
  } catch {
    return [];
  }
}
