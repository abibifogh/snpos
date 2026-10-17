/**
 * What to call things, on a system that serves three trades.
 *
 * A mirror of packages/core/src/words.ts. A Vite bundle and an Appwrite
 * function cannot share a module, so there are two copies, and two copies
 * drift — the parity suite runs both against the same inputs and fails the
 * build the moment they disagree.
 *
 * The bug this exists for: a shop counter was emailed "Off the menu: Luggage
 * strap" and told the kitchen screen would stop showing it.
 */

const KITCHEN = {
  one: 'dish',
  many: 'dishes',
  title: 'Dishes & drinks',
  off: 'off the menu',
  consequence: 'Customers cannot order them and the kitchen screen will not show them.',
  ranOut: 'A dish has run out',
};

const BAR = {
  one: 'drink',
  many: 'drinks',
  title: 'Drinks & cocktails',
  off: 'off the menu',
  consequence: 'Customers cannot order them and they will not show at the bar.',
  ranOut: 'A drink has run out',
};

const CRAFT = {
  one: 'piece',
  many: 'pieces',
  title: 'Products',
  off: 'off the shelf',
  consequence: 'Customers cannot buy them and they will not show at the counter.',
  ranOut: 'A piece has sold out',
};

export function tradeWords(module) {
  if (module === 'craft') return CRAFT;
  if (module === 'bar') return BAR;
  return KITCHEN;
}

export function offCountLine(count, module) {
  const w = tradeWords(module);
  const noun = count === 1 ? `${w.one} is` : `${w.many} are`;
  return `${count} ${noun} ${w.off}.`;
}

export function offSubject(name, module) {
  const w = tradeWords(module);
  return `${w.off.charAt(0).toUpperCase()}${w.off.slice(1)}: ${name}`;
}

/**
 * How packing is named on a bill: what it is, and how many at what each.
 * A copy of packingWords in packages/core/src/pricing.ts; see the parity test.
 *
 * @param {number} packFee
 * @param {number} portions
 * @param {(n: number) => string} money
 * @returns {{ label: string, count?: number, each?: string } | null}
 */
export function packingWords(packFee, portions, money) {
  if (!(packFee > 0)) return null;
  const each = portions > 0 ? packFee / portions : 0;
  return Number.isInteger(each) && each > 0
    ? { label: 'Takeaway packing', count: portions, each: money(each) }
    : { label: 'Takeaway packing' };
}

/**
 * Whether a status email is worth sending for this order.
 *
 * Every order gets "accepted" and "ready". A group's meal time gets only
 * "ready", and only when it is packed to collect: the party already has the
 * booking and its confirmation, and was otherwise being sent two emails per
 * meal time under order numbers they had never seen.
 *
 * @param {string | null} stage
 * @param {{ group_booking_id?: string, group_reference?: string, is_group?: boolean, fulfilment?: string }} order
 */
export function groupStageWanted(stage, order) {
  if (!stage) return false;
  const group = !!(order.group_booking_id || order.is_group);
  if (!group) return true;
  return stage === 'ready' && order.fulfilment === 'takeaway';
}

/**
 * Whether the hourly sweep should remind the team about an unconfirmed booking.
 *
 * Once, in the hour the first meal time comes within a day. The sweep runs on
 * the hour, so the window is that hour and no other: no column records that a
 * reminder went, and none is needed. A booking made inside the last day was
 * announced when it arrived and is not reminded again.
 *
 * @param {{ status?: string, first_at?: string }} booking
 * @param {number} now
 */
export function unconfirmedReminderDue(booking, now) {
  if ((booking.status ?? 'pending') !== 'pending' || !booking.first_at) return false;
  const until = (new Date(booking.first_at).getTime() - now) / 3_600_000;
  return until >= 23 && until < 24;
}
