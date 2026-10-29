import type { CountLine } from './stocktake';

/**
 * What the shop counts at a shift: a short list, not the whole shop.
 *
 * Every shift used to ask for every piece in the shop — four hundred lines in
 * tables by maker — and a sheet that long is a sheet somebody scrolls through
 * typing whatever the screen expects, or leaves. So a shift now counts three
 * things, each for a reason:
 *
 *   SOLD OR MOVED THIS SHIFT — what left a shelf, or arrived on one, since the
 *   shift opened. A missed sale or the wrong piece handed over shows up here,
 *   on the night it happened, while the person who did it is still there.
 *
 *   WORTH MORE THAN A SET PRICE — looked at every shift, because these cost
 *   the most to lose and are the easiest thing to walk out with.
 *
 *   ONE SHELF, IN TURN — a different shelf each day, so every piece is still
 *   walked regularly without anybody counting them all every night. A day,
 *   not a shift: counting the shop in and out on the same day walks the same
 *   shelf twice, which is what a handover is.
 *
 * And on the full-count day, everything, as before.
 *
 * Plain rules importing nothing at runtime, so they can be tested alone.
 */

export type FullCountDay = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'month' | 'never';

export const FULL_COUNT_DAYS: { value: FullCountDay; label: string }[] = [
  { value: 'sun', label: 'Every Sunday' },
  { value: 'mon', label: 'Every Monday' },
  { value: 'tue', label: 'Every Tuesday' },
  { value: 'wed', label: 'Every Wednesday' },
  { value: 'thu', label: 'Every Thursday' },
  { value: 'fri', label: 'Every Friday' },
  { value: 'sat', label: 'Every Saturday' },
  { value: 'month', label: 'The first day of each month' },
  { value: 'never', label: 'Only when an admin starts one' },
];

export interface ShopCountRules {
  /** Count what was sold or added since the shift opened. */
  sold: boolean;
  /** Count every piece priced at or over this, in minor units. Nought: off. */
  over: number;
  /** Count one shelf a day, in turn. */
  rotate: boolean;
  /** When the whole shop is counted instead. */
  full: FullCountDay;
}

/** GH₵500, in pesewas: the price over which a piece is looked at every shift. */
export const DEFAULT_COUNT_OVER = 50_000;

/**
 * The restaurant's choices, with a missing answer read as the default.
 *
 * Absent means on, for the two switches, and Sunday for the full count: a
 * shop that has never opened this setting gets the short count, not the
 * old four-hundred-line sheet.
 */
export function shopCountRules(s?: {
  shop_count_sold?: boolean | null;
  shop_count_over?: number | null;
  shop_count_rotate?: boolean | null;
  shop_count_full?: string | null;
} | null): ShopCountRules {
  const full = FULL_COUNT_DAYS.some((d) => d.value === s?.shop_count_full) ? s!.shop_count_full as FullCountDay : 'sun';
  const over = typeof s?.shop_count_over === 'number' && s.shop_count_over >= 0 ? s.shop_count_over : DEFAULT_COUNT_OVER;
  return { sold: s?.shop_count_sold !== false, over, rotate: s?.shop_count_rotate !== false, full };
}

const WEEKDAYS: FullCountDay[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Is this the day the whole shop is counted? */
export function isFullCountDay(full: FullCountDay, day: Date): boolean {
  if (full === 'never') return false;
  if (full === 'month') return day.getDate() === 1;
  return WEEKDAYS[day.getDay()] === full;
}

/** A whole-day number for a local date, so the shelf in turn changes at midnight, not at noon UTC. */
export const dayNumber = (day: Date): number =>
  Math.floor(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) / 86_400_000);

export interface Shelf {
  id: string;
  name: string;
}

/** The shelves pieces sit on, in a fixed order. Pieces on no shelf share one called Other. */
export function shelvesOf(lines: CountLine[]): Shelf[] {
  const seen = new Map<string, string>();
  for (const l of lines) seen.set(l.categoryId ?? '', l.categoryName ?? 'Other');
  return [...seen.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => (a.id === '' ? 1 : b.id === '' ? -1 : a.name.localeCompare(b.name)));
}

/** Which shelf is today's. */
export function shelfForDay(shelves: Shelf[], day: Date): Shelf | null {
  if (shelves.length === 0) return null;
  return shelves[dayNumber(day) % shelves.length];
}

export type CountPartKey = 'sold' | 'valuable' | 'shelf' | 'all';

export interface CountPart {
  key: CountPartKey;
  title: string;
  why: string;
  /** Indexes into the sheet's lines, so a typed figure has one home whichever part shows it. */
  indexes: number[];
}

const keyOf = (l: CountLine) => `${l.menuItemId}:${l.variantId ?? ''}`;

/**
 * The parts of tonight's count, in the order they are walked.
 *
 * A piece belongs to the first part that claims it, so nothing is counted
 * twice. Held pieces (a change already waiting for an admin) are left off
 * altogether: counting one again would put a second difference on the same
 * shelf. Empty parts are dropped. With every switch off, or on the
 * full-count day, the whole shop is one part.
 */
export function countParts(input: {
  lines: CountLine[];
  rules: ShopCountRules;
  day: Date;
  /** Pieces sold or added since the shift opened, by `menuItemId:variantId`. */
  moved: Set<string>;
  /** Pieces held for an admin, by the same key. */
  held?: Set<string>;
  money?: (minor: number) => string;
}): CountPart[] {
  const { lines, rules, day, moved } = input;
  const held = input.held ?? new Set<string>();
  const open = lines.map((l, i) => ({ l, i })).filter(({ l }) => !held.has(keyOf(l)));

  const everything = (why: string): CountPart[] => (open.length === 0 ? [] : [{
    key: 'all', title: 'The whole shop', why, indexes: open.map(({ i }) => i),
  }]);
  if (isFullCountDay(rules.full, day)) return everything('Today is the full count: every piece in the shop.');
  if (!rules.sold && rules.over <= 0 && !rules.rotate) return everything('Every piece in the shop.');

  const taken = new Set<number>();
  const claim = (keep: (l: CountLine) => boolean) => open
    .filter(({ l, i }) => !taken.has(i) && keep(l))
    .map(({ i }) => { taken.add(i); return i; });

  const parts: CountPart[] = [];
  if (rules.sold) {
    parts.push({
      key: 'sold',
      title: 'Sold or moved this shift',
      why: 'Anything that left a shelf or arrived since the shift opened. A missed sale or a wrong piece shows up here.',
      indexes: claim((l) => moved.has(keyOf(l))),
    });
  }
  if (rules.over > 0) {
    const price = input.money ? input.money(rules.over) : String(rules.over);
    parts.push({
      key: 'valuable',
      title: `Worth ${price} or more`,
      why: 'Looked at every shift, because these cost the most to lose.',
      indexes: claim((l) => l.unitPrice >= rules.over),
    });
  }
  if (rules.rotate) {
    const shelf = shelfForDay(shelvesOf(open.map(({ l }) => l)), day);
    if (shelf) {
      parts.push({
        key: 'shelf',
        title: `Today's shelf: ${shelf.name}`,
        why: 'One shelf a day, in turn, so every piece is still walked regularly.',
        indexes: claim((l) => (l.categoryId ?? '') === shelf.id),
      });
    }
  }
  return parts.filter((p) => p.indexes.length > 0);
}

/** Every line tonight's count asks for, once. */
export const partIndexes = (parts: CountPart[]): number[] => [...new Set(parts.flatMap((p) => p.indexes))];

/** Typed at all? Blank is not nought: it means nobody looked. */
export const typed = (l: CountLine): boolean => (l.countedText ?? '').trim() !== '';

/** "Esi counted 14 of 38 at 2:10 pm." What a resumed count says it is giving back. */
export function resumeWords(opts: { who?: string; done: number; total: number; at?: string | number | null; time: (at: string | number) => string }): string {
  const who = opts.who?.trim() || 'Somebody';
  const when = opts.at ? ` at ${opts.time(opts.at)}` : '';
  return `${who} counted ${opts.done} of ${opts.total}${when}. Everything typed is kept on the system, so it is here on any till.`;
}
