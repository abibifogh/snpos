/**
 * What a voucher says, for a customer rather than for a cashier.
 *
 * The admin list describes a voucher to somebody who already knows what the
 * fields mean: "percent · 2000 · max 5000". A person holding a printed voucher
 * knows none of that, and the things they actually need are a headline they
 * can read across a room, and the conditions they will otherwise find out
 * about at the till with a queue behind them.
 *
 * THE CONDITIONS ARE THE POINT. A voucher that says "20% OFF" and nothing else
 * is a complaint waiting at the counter: minimum spend, an end date, the days
 * it runs, a cap on a percentage — every one of those is a reason a customer
 * is turned down in front of other customers, and every one of them belongs on
 * the voucher rather than in a policy nobody was shown.
 *
 * Pure. Nothing here reads or writes.
 */

export interface PrintableVoucher {
  name: string;
  code?: string;
  description?: string;
  kind: string;
  /** Basis points for a percentage, minor units for an amount. */
  value: number;
  min_order_total?: number;
  max_discount_amount?: number;
  starts_at?: string;
  ends_at?: string;
  days_of_week?: string[];
  time_start?: string;
  time_end?: string;
  usage_limit_total?: number;
  usage_limit_per_customer?: number;
  first_order_only?: boolean;
  requires_manager?: boolean;
  used_count?: number;
  active?: boolean;
}

/** Percentages are stored in basis points so half a percent can be said. */
const percentWords = (bp: number): string => {
  const pc = (bp ?? 0) / 100;
  return `${pc % 1 === 0 ? pc.toFixed(0) : pc.toFixed(1)}%`;
};

/**
 * The line across the middle, as big as it will go.
 *
 * `money` is passed in rather than imported so this file stays pure and the
 * figure is formatted in the business's own currency by the one formatter
 * everything else uses.
 */
export function voucherHeadline(v: PrintableVoucher, money: (n: number) => string): string {
  if (v.kind === 'percent' || v.kind === 'item_percent') return `${percentWords(v.value)} OFF`;
  if (v.kind === 'amount') return `${money(v.value ?? 0)} OFF`;
  if (v.kind === 'free_delivery') return 'FREE DELIVERY';
  if (v.kind === 'free_item') return 'A FREE ITEM';
  return 'A DISCOUNT';
}

const DAY_NAMES: Record<string, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

/** "Mon, Tue and Wed" — or nothing at all, which means every day. */
export function voucherDays(days?: string[]): string {
  const named = (days ?? []).map((d) => DAY_NAMES[String(d).toLowerCase().slice(0, 3)]).filter(Boolean);
  if (named.length === 0 || named.length === 7) return '';
  if (named.length === 1) return named[0] as string;
  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}

/** "12:00 to 15:00", or nothing where it runs all day. */
export const voucherHours = (v: PrintableVoucher): string =>
  (v.time_start && v.time_end ? `${v.time_start} to ${v.time_end}` : '');

/**
 * The conditions, each as its own short line.
 *
 * Every one of these is a reason somebody is refused at the counter. They are
 * on the voucher so the refusal, if it comes, is something the customer was
 * told rather than something sprung on them.
 */
export function voucherTerms(v: PrintableVoucher, money: (n: number) => string): string[] {
  const out: string[] = [];

  if ((v.min_order_total ?? 0) > 0) out.push(`Spend at least ${money(v.min_order_total as number)}.`);
  if ((v.max_discount_amount ?? 0) > 0 && (v.kind === 'percent' || v.kind === 'item_percent')) {
    out.push(`The most it takes off is ${money(v.max_discount_amount as number)}.`);
  }

  const days = voucherDays(v.days_of_week);
  const hours = voucherHours(v);
  if (days && hours) out.push(`${days} only, between ${hours}.`);
  else if (days) out.push(`${days} only.`);
  else if (hours) out.push(`Between ${hours}.`);

  if (v.first_order_only) out.push('First order only.');
  if ((v.usage_limit_per_customer ?? 0) > 0) {
    const n = v.usage_limit_per_customer as number;
    out.push(`${n === 1 ? 'Once' : `${n} times`} per customer.`);
  }
  /*
    What is LEFT, not what it started as. A voucher limited to fifty uses with
    forty-eight gone is worth printing as two, and a customer holding one that
    says fifty when there are two is the complaint this avoids.
  */
  if ((v.usage_limit_total ?? 0) > 0) {
    const left = Math.max(0, (v.usage_limit_total as number) - (v.used_count ?? 0));
    out.push(left === 0
      ? 'All of these have now been used.'
      : `${left} of these left.`);
  }
  if (v.requires_manager) out.push('A manager has to approve it.');

  out.push('One voucher per bill unless we say otherwise. Not exchangeable for cash.');
  return out;
}

/** "Valid until 9 Sep 2026", or what to say when it never ends. */
export function voucherValidity(v: PrintableVoucher, dateWords: (s: string) => string): string {
  if (v.starts_at && v.ends_at) return `${dateWords(v.starts_at)} — ${dateWords(v.ends_at)}`;
  if (v.ends_at) return `Until ${dateWords(v.ends_at)}`;
  if (v.starts_at) return `From ${dateWords(v.starts_at)}`;
  return 'No end date';
}

/**
 * What to print where the code goes.
 *
 * A voucher with no code is one only staff can apply, and printing an empty
 * box on it would have a customer hunting for something that was never there.
 */
export const voucherCodeWords = (v: PrintableVoucher): string =>
  (v.code ?? '').trim() ? (v.code as string).trim().toUpperCase() : 'ASK A MEMBER OF STAFF';

/** Whether this voucher has a real code to type, as opposed to the stand-in above. */
export const voucherHasCode = (v: PrintableVoucher): boolean => !!(v.code ?? '').trim();

/**
 * Why this one should not be printed and handed out, or null.
 *
 * Printing a voucher that cannot be used is worse than not printing it: the
 * customer finds out at the counter, and somebody here has to explain it.
 */
export function voucherPrintProblem(v: PrintableVoucher, now: Date = new Date()): string | null {
  if (v.active === false) return 'That voucher is switched off, so it would be refused at the till.';
  if (v.ends_at) {
    const ends = Date.parse(v.ends_at);
    if (Number.isFinite(ends) && ends < now.getTime()) return 'That voucher has already ended.';
  }
  if ((v.usage_limit_total ?? 0) > 0 && (v.used_count ?? 0) >= (v.usage_limit_total as number)) {
    return 'That voucher has been used up.';
  }
  return null;
}

/* ------------------------------------------------- sending one to somebody */

/** Enough of a customer to decide whether an offer may go to them. */
export interface Marketable {
  name?: string;
  email?: string;
  marketing_opt_in?: boolean;
}

/**
 * The shape of an address, checked before a row is written rather than after
 * a send has failed.
 *
 * Deliberately loose. This is not trying to decide whether a mailbox exists —
 * nothing can, short of writing to it — only to catch the typed mistakes worth
 * catching before somebody waits an hour for a voucher that went nowhere.
 */
export const looksLikeEmail = (s?: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s ?? '').trim());

/**
 * Several addresses out of one box, however they were separated.
 *
 * People paste lists. Commas, semicolons, spaces and new lines all turn up,
 * and a box that only understood one of them would silently treat the rest as
 * one long broken address.
 */
export const splitAddresses = (text: string): string[] =>
  [...new Set(
    String(text ?? '')
      .split(/[,;\s]+/)
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean),
  )];

/**
 * Why this voucher cannot be emailed to this person, or null.
 *
 * A VOUCHER IS MARKETING, and that is the whole of the second rule. Somebody
 * who gave an address to get a receipt has not asked to be sent offers, and
 * sending them one anyway is the thing that makes a restaurant's mail get
 * marked as spam — after which the receipts stop arriving too. Typing an
 * address by hand is a different act: that is somebody being given a voucher
 * they asked for, and it is not this function's business.
 */
export function voucherEmailProblem(to: Marketable): string | null {
  if (!looksLikeEmail(to.email)) return 'That does not look like an email address.';
  if (to.marketing_opt_in === false) {
    return `${to.name || to.email} has not agreed to be sent offers.`;
  }
  return null;
}

/** Customers an offer may actually be sent to, in name order. */
export const mayBeOffered = <T extends Marketable>(rows: T[]): T[] =>
  rows
    .filter((r) => looksLikeEmail(r.email) && r.marketing_opt_in === true)
    .sort((a, b) => String(a.name ?? a.email).localeCompare(String(b.name ?? b.email)));

/** Where a voucher's send got to, for the row that asked for it. */
export type VoucherSendState = 'queued' | 'sent' | 'failed';

export function voucherSendWords(state: VoucherSendState): { label: string; tone: 'ok' | 'warn' | 'default' } {
  if (state === 'sent') return { label: 'Sent', tone: 'ok' };
  if (state === 'failed') return { label: 'Not sent', tone: 'warn' };
  return { label: 'Sending…', tone: 'default' };
}
