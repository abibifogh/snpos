/**
 * Grouping and sorting by more than one thing, in the order you chose them.
 *
 * A single dropdown that groups by one field answers "what did the bar take".
 * It cannot answer "what did the bar take, by day, by member of staff", which
 * is the question somebody actually has when a figure looks wrong — and the
 * only way to get there was to filter to the bar, then filter to a day, then
 * read one number, then start again for the next day.
 *
 * So groupings stack. Pick day, then staff, and you get days with people
 * inside them; pick them the other way round and you get people with days
 * inside them. Both are useful and they are different questions, which is why
 * the ORDER is kept rather than sorted into something tidy.
 *
 * Sorting works the same way: a list sorted by staff and then by amount is a
 * different list from one sorted by amount and then by staff, and a table that
 * silently keeps only the last column you clicked cannot express either.
 *
 * Pure. Imports nothing at runtime.
 */

export interface GroupChoice {
  /** The field this groups on. */
  key: string;
  /** What to call it on screen: "Day", "Member of staff". */
  label: string;
}

export interface SortChoice {
  key: string;
  label: string;
  dir: 'asc' | 'desc';
}

export interface GroupNode<T> {
  /** Which grouping made this level. */
  key: string;
  label: string;
  /** The shared value, ready to show: "Tuesday 12 August", "Ama". */
  value: string;
  /** Everything under here, including through any nested levels. */
  rows: T[];
  /** The next grouping down, or null when this is the last one. */
  children: GroupNode<T>[] | null;
  /** 0 for the outermost grouping. Decides the indent. */
  depth: number;
  /** Stable across renders, so an open group stays open. */
  path: string;
}

/**
 * What a row shows for a grouping.
 *
 * A function rather than a plain field read, because almost nothing groups by
 * its raw value: orders group by DAY, not by the instant they were placed, and
 * money groups by band rather than by the exact figure. The caller knows how
 * its own rows should be bucketed; this only knows how to stack the buckets.
 */
export type ValueOf<T> = (row: T, key: string) => string;

/** What an empty answer is called, so the group is still findable. */
export const NONE = '—';

/**
 * Stack the rows into nested groups, one level per chosen grouping.
 *
 * Groups come out in the order the values sort, EXCEPT that the empty one goes
 * last wherever it appears. A screen led by "—" looks broken, and the rows
 * with no answer are the least interesting ones on it.
 */
export function groupRows<T>(
  rows: T[],
  choices: GroupChoice[],
  valueOf: ValueOf<T>,
  depth = 0,
  parentPath = '',
): GroupNode<T>[] | null {
  const choice = choices[depth];
  if (!choice) return null;

  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const value = valueOf(row, choice.key) || NONE;
    const list = buckets.get(value);
    if (list) list.push(row);
    else buckets.set(value, [row]);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => {
      if (a === NONE) return 1;
      if (b === NONE) return -1;
      return a.localeCompare(b, undefined, { numeric: true });
    })
    .map(([value, list]) => {
      const path = `${parentPath}/${choice.key}:${value}`;
      return {
        key: choice.key,
        label: choice.label,
        value,
        rows: list,
        children: groupRows(list, choices, valueOf, depth + 1, path),
        depth,
        path,
      };
    });
}

/**
 * Sort by each choice in turn, the first one deciding and the rest breaking
 * ties.
 *
 * `compare` is the caller's, for the same reason `valueOf` is: an amount sorts
 * as a number, a name as text, a date as a date, and a screen that compared
 * everything as strings would put 100 before 20.
 *
 * A copy, never in place. Sorting the array a table is rendering from is how a
 * list reorders itself under somebody mid-scroll.
 */
export function sortRows<T>(
  rows: T[],
  choices: SortChoice[],
  compare: (a: T, b: T, key: string) => number,
): T[] {
  if (choices.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const c of choices) {
      const n = compare(a, b, c.key);
      if (n !== 0) return c.dir === 'asc' ? n : -n;
    }
    return 0;
  });
}

/**
 * Add a grouping, or move it to the end if it is already on.
 *
 * Clicking one that is already chosen is almost never a request to remove it —
 * the chip has an × for that — and is very often somebody trying to change the
 * order. Odoo's own behaviour, and it is right: the alternative is that the
 * only way to reorder is to clear everything and start again.
 */
export function toggleGroup(choices: GroupChoice[], add: GroupChoice): GroupChoice[] {
  const without = choices.filter((c) => c.key !== add.key);
  return without.length === choices.length ? [...choices, add] : without;
}

/**
 * Cycle a sort: off, then ascending, then descending, then off.
 *
 * Three states from one control, which is what a column header has to be. The
 * chosen order is kept: clicking a second column adds it as a tie-breaker
 * rather than replacing what was there.
 */
export function cycleSort(choices: SortChoice[], key: string, label: string): SortChoice[] {
  const at = choices.findIndex((c) => c.key === key);
  if (at === -1) return [...choices, { key, label, dir: 'asc' }];
  if (choices[at].dir === 'asc') {
    const next = [...choices];
    next[at] = { ...next[at], dir: 'desc' };
    return next;
  }
  return choices.filter((c) => c.key !== key);
}

/** Where this column sits in the sort, for the little number on the header. */
export const sortPosition = (choices: SortChoice[], key: string): number =>
  choices.findIndex((c) => c.key === key) + 1;

export const sortDir = (choices: SortChoice[], key: string): 'asc' | 'desc' | null =>
  choices.find((c) => c.key === key)?.dir ?? null;

/**
 * Flatten the tree back into rows, in the order the groups put them.
 *
 * What a spreadsheet export needs: the grouping decided the order and the
 * export should match what is on screen, or the two disagree about what "the
 * first twenty" means.
 */
export function flatten<T>(nodes: GroupNode<T>[] | null, rows: T[]): T[] {
  if (!nodes) return rows;
  return nodes.flatMap((n) => flatten(n.children, n.rows));
}

/** How many groups deep this goes, for the indent and the export header. */
export const depthOf = (choices: GroupChoice[]): number => choices.length;
