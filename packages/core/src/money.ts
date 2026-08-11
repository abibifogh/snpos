import type { Settings } from './types';

/**
 * Money is stored as an integer in minor units (pesewas, cents) everywhere.
 *
 * Floating point and money must never meet: 0.1 + 0.2 !== 0.3, and a cash
 * drawer that is out by a thousandth of a pesewa per line still fails to
 * reconcile at close. Convert only at the edges, here for display, and in
 * parseMoney for input.
 */
export function formatMoney(minor: number, s: Pick<Settings, 'currency_symbol' | 'currency_decimals' | 'symbol_position'>): string {
  const decimals = s.currency_decimals ?? 2;
  const value = (minor / 10 ** decimals).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return s.symbol_position === 'after' ? `${value}${s.currency_symbol}` : `${s.currency_symbol}${value}`;
}

/** Parse typed input ("12.50") into minor units. Returns null when unusable. */
export function parseMoney(input: string, decimals = 2): number | null {
  const cleaned = input.replace(/[^0-9.,-]/g, '').replace(',', '.');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10 ** decimals);
}

/** Minor units back to a plain editable string, with no symbol. */
export function toInput(minor: number, decimals = 2): string {
  return (minor / 10 ** decimals).toFixed(decimals);
}

/** Basis points: 1250 = 12.5%. Avoids percentages stored as fractions. */
export function applyBp(minor: number, bp: number): number {
  return Math.round((minor * bp) / 10000);
}

export const bpToPercent = (bp: number): string => (bp / 100).toFixed(2).replace(/\.00$/, '');
export const percentToBp = (pct: string): number => Math.round(Number(pct || 0) * 100);

/**
 * Does this screen ask for a tip?
 *
 * One rule, read by both the till and the kitchen, because the alternative is
 * two `settings.tips_enabled !== false` checks that drift apart, and a tip box
 * that is gone from one screen and still on the other is indistinguishable,
 * from the far side of a kitchen, from a setting that did not save.
 *
 * `tips_enabled: false` wins over everything. It is the older switch, it means
 * "no tips here", and a database that only has that one must still be obeyed.
 */
export function asksForTip(
  settings: { tips_enabled?: boolean; tips_ask_on?: 'both' | 'till' | 'kitchen' | 'none' },
  where: 'till' | 'kitchen',
): boolean {
  if (settings.tips_enabled === false) return false;
  const on = settings.tips_ask_on ?? 'both';
  if (on === 'none') return false;
  return on === 'both' || on === where;
}

/**
 * Money for an axis tick: whole units, thousands separated, no decimals.
 *
 * `formatMoney` is right everywhere a figure is quoted, a bill of GH₵1,000.00
 * is not GH₵1,000. On an axis it is noise: three ticks reading .00 add nothing
 * a reader wanted and crowd out the label they did.
 */
export function axisMoney(minor: number, settings: { currency_symbol: string; currency_decimals?: number; symbol_position?: 'before' | 'after' }): string {
  const whole = Math.round(minor / 10 ** (settings.currency_decimals ?? 2));
  const text = whole.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return settings.symbol_position === 'after' ? `${text}${settings.currency_symbol}` : `${settings.currency_symbol}${text}`;
}
