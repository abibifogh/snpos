/**
 * What a voucher says, for the job that emails one.
 *
 * A DELIBERATE COPY of packages/core/src/voucher-words.ts. A function is
 * deployed on its own, with no workspace around it, so it cannot import the
 * rules the Admin app uses — and these two must agree exactly. If they drift,
 * a voucher a customer is emailed says something different from the one the
 * same page printed, and the difference is discovered at the counter. A test
 * holds them together; see the core tests.
 */

const percentWords = (bp) => {
  const pc = (Number(bp) || 0) / 100;
  return `${pc % 1 === 0 ? pc.toFixed(0) : pc.toFixed(1)}%`;
};

/** The line across the middle, as big as it will go. */
export function voucherHeadline(v, money) {
  if (v.kind === 'percent' || v.kind === 'item_percent') return `${percentWords(v.value)} OFF`;
  if (v.kind === 'amount') return `${money(v.value ?? 0)} OFF`;
  if (v.kind === 'free_delivery') return 'FREE DELIVERY';
  if (v.kind === 'free_item') return 'A FREE ITEM';
  return 'A DISCOUNT';
}

const DAY_NAMES = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

/** "Mon, Tue and Wed" — or nothing at all, which means every day. */
export function voucherDays(days) {
  const named = (days ?? []).map((d) => DAY_NAMES[String(d).toLowerCase().slice(0, 3)]).filter(Boolean);
  if (named.length === 0 || named.length === 7) return '';
  if (named.length === 1) return named[0];
  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}

/** "12:00 to 15:00", or nothing where it runs all day. */
export const voucherHours = (v) => (v.time_start && v.time_end ? `${v.time_start} to ${v.time_end}` : '');

/** The conditions, each as its own short line. */
export function voucherTerms(v, money) {
  const out = [];

  if ((v.min_order_total ?? 0) > 0) out.push(`Spend at least ${money(v.min_order_total)}.`);
  if ((v.max_discount_amount ?? 0) > 0 && (v.kind === 'percent' || v.kind === 'item_percent')) {
    out.push(`The most it takes off is ${money(v.max_discount_amount)}.`);
  }

  const days = voucherDays(v.days_of_week);
  const hours = voucherHours(v);
  if (days && hours) out.push(`${days} only, between ${hours}.`);
  else if (days) out.push(`${days} only.`);
  else if (hours) out.push(`Between ${hours}.`);

  if (v.first_order_only) out.push('First order only.');
  if ((v.usage_limit_per_customer ?? 0) > 0) {
    const n = v.usage_limit_per_customer;
    out.push(`${n === 1 ? 'Once' : `${n} times`} per customer.`);
  }
  // What is LEFT, not what it started as.
  if ((v.usage_limit_total ?? 0) > 0) {
    const left = Math.max(0, v.usage_limit_total - (v.used_count ?? 0));
    out.push(left === 0 ? 'All of these have now been used.' : `${left} of these left.`);
  }
  if (v.requires_manager) out.push('A manager has to approve it.');

  out.push('One voucher per bill unless we say otherwise. Not exchangeable for cash.');
  return out;
}

/** "Until 9 Sep 2026", or what to say when it never ends. */
export function voucherValidity(v, dateWords) {
  if (v.starts_at && v.ends_at) return `${dateWords(v.starts_at)} — ${dateWords(v.ends_at)}`;
  if (v.ends_at) return `Until ${dateWords(v.ends_at)}`;
  if (v.starts_at) return `From ${dateWords(v.starts_at)}`;
  return 'No end date';
}

/** What to print where the code goes. */
export const voucherCodeWords = (v) =>
  ((v.code ?? '').trim() ? String(v.code).trim().toUpperCase() : 'ASK A MEMBER OF STAFF');

/** Whether that is a real code to type, as opposed to the stand-in above. */
export const voucherHasCode = (v) => !!(v.code ?? '').trim();

/** Why this one should not be sent out, or null. */
export function voucherPrintProblem(v, now = new Date()) {
  if (v.active === false) return 'That voucher is switched off, so it would be refused at the till.';
  if (v.ends_at) {
    const ends = Date.parse(v.ends_at);
    if (Number.isFinite(ends) && ends < now.getTime()) return 'That voucher has already ended.';
  }
  if ((v.usage_limit_total ?? 0) > 0 && (v.used_count ?? 0) >= v.usage_limit_total) {
    return 'That voucher has been used up.';
  }
  return null;
}
