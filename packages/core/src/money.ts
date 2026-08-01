import type { Settings } from './types';

/**
 * Money is stored as an integer in minor units (pesewas, cents) everywhere.
 *
 * Floating point and money must never meet: 0.1 + 0.2 !== 0.3, and a cash
 * drawer that is out by a thousandth of a pesewa per line still fails to
 * reconcile at close. Convert only at the edges — here for display, and in
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
