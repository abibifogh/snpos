import { db, DB_ID, listAll, listByIds, Query } from './client';
import { dayStartIso, dayEndIso } from './reading';
import { loadOpenShifts, loadPaymentMethods, expectedTakings } from './shifts';
import type { Shift, PaymentMethod } from './shifts';
import { hasOpeningCount, loadIngredients, levelOf } from './stock';
import type { Ingredient } from './stock';
import { hanging } from './ledger';
import { schemaState } from './schema-status';
import { SCHEMA_VERSION } from './schema-version';
import { modulesOf } from './access';
import { compareDays, takingsOf, byHour, sidesOn } from './today';
import type { TodayOrder, TodayPayment, TodayLine, Takings, TradeSide } from './today';
import type { Settings, StaffProfile } from './types';
import { nameBook } from './staff-words';

export interface OpenShiftFact {
  shift: Shift;
  side: TradeSide;
  openedBy: string;
  takings: number;
  /** For the bar: whether it was counted in. Null when that could not be read. */
  countedIn: boolean | null;
}

export interface ClosedTodayFact {
  side: TradeSide;
  code: string;
  closedAt: string;
  settled: boolean;
}

export interface TodayFacts {
  now: string;
  sides: TradeSide[];
  today: Takings;
  yesterday: Takings;
  lastWeek: Takings;
  hoursToday: number[];
  hoursLastWeek: number[];
  lines: TodayLine[];
  openShifts: OpenShiftFact[];
  closedToday: ClosedTodayFact[];
  lowStock: Ingredient[];
  hanging: { card: number; momo: number };
  schema: 'current' | 'behind' | 'unknown';
  lastHealthRun?: string;
  /** Whether there is anything in the catalogue at all, for the first-day card. */
  catalogueEmpty: boolean;
  names: Map<string, string>;
}

/**
 * The day's facts, read once.
 *
 * Three days of orders and payments — today, yesterday and the same weekday
 * last week — rather than a year filtered in the browser. The rules that turn
 * them into figures are in today.ts.
 */
export async function todayFacts(venueId: string, settings: Settings | null, now: Date = new Date()): Promise<TodayFacts> {
  const days = compareDays(now);
  const dayRows = async (day: string) => {
    const from = dayStartIso(day);
    const to = dayEndIso(day);
    const between = [Query.greaterThanEqual('$createdAt', from), Query.lessThanEqual('$createdAt', to)];
    const [orders, payments] = await Promise.all([
      listAll<TodayOrder & { venue_id?: string }>('orders', [Query.equal('venue_id', venueId), ...between]),
      listAll<TodayPayment>('payments', between),
    ]);
    return { orders, payments };
  };

  const [today, yesterday, lastWeek, methods, staff, kitchen, bar, craft, ingredients, owed, settingsRow, healthRows, anyItem] = await Promise.all([
    dayRows(days.today),
    dayRows(days.yesterday),
    dayRows(days.lastWeek),
    loadPaymentMethods(venueId).catch(() => [] as PaymentMethod[]),
    listAll<StaffProfile>('staff_profiles').catch(() => [] as StaffProfile[]),
    loadOpenShifts(venueId, 'kitchen').catch(() => [] as Shift[]),
    loadOpenShifts(venueId, 'bar').catch(() => [] as Shift[]),
    loadOpenShifts(venueId, 'craft').catch(() => [] as Shift[]),
    loadIngredients(venueId).catch(() => [] as Ingredient[]),
    hanging(venueId).catch(() => ({ card: 0, momo: 0 })),
    db.getDocument(DB_ID, 'settings', 'main').catch(() => null) as Promise<{ schema_version?: string } | null>,
    db.listDocuments(DB_ID, 'summary_reports', [Query.equal('kind', 'health'), Query.orderDesc('$createdAt'), Query.limit(1)])
      .catch(() => ({ documents: [] as { $createdAt: string }[] })),
    db.listDocuments(DB_ID, 'menu_items', [Query.limit(1)]).catch(() => ({ total: 1 })),
  ]);

  const lines = await listByIds<TodayLine>('order_items', 'order_id', today.orders.map((o) => o.$id)).catch(() => [] as TodayLine[]);

  const names = nameBook(staff);

  const all = [...kitchen, ...bar, ...craft];
  const open = [...new Set(all.map((s) => s.$id))].map((id) => all.find((s) => s.$id === id) as Shift).filter((s) => s.status === 'open');
  const openShifts: OpenShiftFact[] = await Promise.all(open.map(async (s) => {
    const side = (s.module ?? 'kitchen') as TradeSide;
    const [t, counted] = await Promise.all([
      expectedTakings(s, methods).catch(() => null),
      side === 'bar' ? hasOpeningCount(s.$id) : Promise.resolve(null),
    ]);
    return { shift: s, side, openedBy: names.get(s.opened_by) ?? '', takings: t?.salesTotal ?? 0, countedIn: counted };
  }));

  // What closed today, so a side with no open shift still reads as a night that happened.
  const closedRows = await listAll<Shift & { locked_at?: string | null }>('shifts', [
    Query.equal('venue_id', venueId), Query.equal('status', 'closed'), Query.greaterThanEqual('closed_at', dayStartIso(days.today)),
  ]).catch(() => [] as (Shift & { locked_at?: string | null })[]);
  const closedToday: ClosedTodayFact[] = closedRows.map((s) => ({
    side: (s.module ?? 'kitchen') as TradeSide, code: s.code, closedAt: s.closed_at ?? '', settled: !!s.locked_at,
  }));

  const lowDefault = settings?.low_stock_default_bp ?? 3000;
  const lowStock = ingredients
    .filter((i) => i.active !== false && levelOf(i, lowDefault) !== 'ok')
    .sort((a, b) => (levelOf(a, lowDefault) === 'out' ? -1 : 1) - (levelOf(b, lowDefault) === 'out' ? -1 : 1) || a.name.localeCompare(b.name));

  const mods = modulesOf(settings);
  return {
    now: now.toISOString(),
    sides: sidesOn(mods),
    today: takingsOf(today.orders, today.payments, methods),
    yesterday: takingsOf(yesterday.orders, yesterday.payments, methods),
    lastWeek: takingsOf(lastWeek.orders, lastWeek.payments, methods),
    hoursToday: byHour(today.payments),
    hoursLastWeek: byHour(lastWeek.payments),
    lines,
    openShifts,
    closedToday,
    lowStock,
    hanging: { card: owed.card, momo: owed.momo },
    schema: schemaState(settingsRow, SCHEMA_VERSION),
    lastHealthRun: (healthRows.documents[0] as { $createdAt: string } | undefined)?.$createdAt,
    catalogueEmpty: (anyItem as { total: number }).total === 0,
    names,
  };
}
