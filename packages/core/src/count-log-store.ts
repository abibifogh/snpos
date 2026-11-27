import { Query, listAll, listByIds } from './client';
import { countsInAtOpen, countsOutAtClose } from './bar-count';
import { entriesFromChecks, entriesFromShopCounts, drawerEntries, missedCounts, STORE_PREFIX } from './count-log';
import type { CheckRow, LogShopCount, DrawerShift, CountLogEntry, CountLogLine } from './count-log';
import type { Settings } from './types';

/**
 * Reading the count log for a window of days. The rules are in count-log.ts.
 *
 * Bounded by the dates asked for, never "everything": a bar counted twice a
 * day writes forty rows a time, and a page that reads a year of that on every
 * open is a page nobody opens twice. Choosing older dates reads older rows;
 * there is no limit on how far back.
 */
export async function loadCountLog(opts: {
  from: string;
  to: string;
  settings: Settings | null;
  money: (n: number) => string;
  now?: Date;
}): Promise<CountLogEntry[]> {
  const { from, to } = opts;
  // A shift opened the day before the window can still close inside it.
  const shiftFrom = new Date(Date.parse(from) - 2 * 86_400_000).toISOString();
  const [checks, shop, shifts] = await Promise.all([
    listAll<CheckRow>('shift_stock_checks', [
      Query.greaterThanEqual('$createdAt', from), Query.lessThanEqual('$createdAt', to),
    ]).catch(() => [] as CheckRow[]),
    listAll<LogShopCount>('stock_counts', [
      Query.greaterThanEqual('$createdAt', from), Query.lessThanEqual('$createdAt', to),
    ]).catch(() => [] as LogShopCount[]),
    listAll<DrawerShift>('shifts', [
      Query.greaterThanEqual('opened_at', shiftFrom), Query.lessThanEqual('opened_at', to),
    ]).catch(() => [] as DrawerShift[]),
  ]);

  // Names for what the rows point at, read once.
  const shiftIds = [...new Set([
    ...checks.map((c) => c.shift_id ?? '').filter((id) => id && !id.startsWith(STORE_PREFIX)),
    ...shop.map((c) => c.shift_id ?? '').filter(Boolean),
  ])].filter((id) => !shifts.some((s) => s.$id === id));
  const roomIds = [...new Set(checks.map((c) => c.shift_id ?? '').filter((id) => id.startsWith(STORE_PREFIX)).map((id) => id.slice(STORE_PREFIX.length)))];
  const shelfIds = [...new Set(checks.map((c) => c.ingredient_id))];
  type Named = { $id: string; name?: string; code?: string };
  const [moreShifts, rooms, shelves] = await Promise.all([
    shiftIds.length ? listByIds<DrawerShift>('shifts', '$id', shiftIds).catch(() => [] as DrawerShift[]) : Promise.resolve([] as DrawerShift[]),
    roomIds.length ? listByIds<Named>('stock_locations', '$id', roomIds).catch(() => [] as Named[]) : Promise.resolve([] as Named[]),
    shelfIds.length ? listByIds<Named>('ingredients', '$id', shelfIds).catch(() => [] as Named[]) : Promise.resolve([] as Named[]),
  ]);
  const allShifts = [...shifts, ...moreShifts];
  const shiftName = (id: string) => allShifts.find((s) => s.$id === id)?.code || 'A shift no longer listed';
  const names = {
    shift: shiftName,
    room: (id: string) => rooms.find((r) => r.$id === id)?.name || 'Store room',
    shelf: (id: string) => shelves.find((r) => r.$id === id)?.name || 'A shelf no longer on the list',
  };

  const stock = [...entriesFromChecks(checks, names), ...entriesFromShopCounts(shop, shiftName)];
  // Only shifts inside the window count towards cash and missed counts.
  const inWindow = shifts.filter((s) => (s.opened_at ?? '') >= from || (s.closed_at ?? '') >= from);
  const cash = drawerEntries(inWindow, opts.money);
  const expects = (module: string, phase: 'open' | 'close') =>
    phase === 'open' ? countsInAtOpen(module, opts.settings) : countsOutAtClose(module, opts.settings);
  const missed = missedCounts(inWindow, stock, expects, opts.now ?? new Date());
  return [...stock, ...cash, ...missed];
}

/** A shop count's lines, read when its row is opened. */
export async function shopCountLines(countId: string): Promise<CountLogLine[]> {
  type Line = { name_snapshot?: string; variant_label?: string; expected?: number; counted?: number; delta?: number; unit_price?: number };
  const rows = await listAll<Line>('stock_count_lines', [Query.equal('count_id', countId)]).catch(() => [] as Line[]);
  return rows.map((l) => {
    const diff = Number(l.delta ?? (Number(l.counted ?? 0) - Number(l.expected ?? 0)));
    return {
      name: [l.name_snapshot || 'A piece', l.variant_label].filter(Boolean).join(' · '),
      expected: Number(l.expected ?? 0),
      counted: typeof l.counted === 'number' ? l.counted : null,
      diff,
      worth: diff * Number(l.unit_price ?? 0),
    };
  });
}
