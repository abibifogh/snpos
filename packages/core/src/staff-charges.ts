/**
 * Count differences charged to a person, and what is done about them.
 *
 * Some shortages are somebody's to make good: six bottles gone on a shift one
 * person ran. Approving the line corrects the shelf and the business bears the
 * loss; refusing it leaves the shelf wrong. Neither is what happened. So a
 * short line can be CHARGED: the shelf is corrected at once — the next count
 * expects what is really there and does not go looking for the six again —
 * and what they were worth is owed by that person until it is paid in cash,
 * taken from pay, found on the shelf, or written off.
 *
 * Priced at the selling price by default, because that is what the business
 * would have taken for them; cost is offered, and any figure can be typed.
 *
 * On the books a charge is owed by staff against shortages charged; see
 * staffChargeLines and staffSettleLines in books.ts.
 *
 * Pure. Imports nothing at runtime.
 */

export type SettleKind = 'cash' | 'pay' | 'found' | 'written_off' | 'credit';
/** Owed for a shortage, or credited for a surplus. */
export type ChargeDirection = 'owed' | 'credit';
export type PriceBasis = 'selling' | 'cost' | 'custom';

export interface StaffCharge {
  $id: string;
  $createdAt?: string;
  person_id: string;
  person_user_id?: string | null;
  person_name: string;
  source?: 'bar_count' | 'shop_count';
  count_ref?: string;
  module?: string;
  item_name: string;
  ingredient_id?: string | null;
  location_id?: string | null;
  menu_item_id?: string | null;
  variant_id?: string | null;
  qty: number;
  unit_price: number;
  amount: number;
  price_basis?: PriceBasis;
  note?: string | null;
  charged_by?: string | null;
  charged_at: string;
  settled_total: number;
  status: 'open' | 'settled';
  /** Absent on rows from before surpluses could be credited: owed. */
  direction?: ChargeDirection | null;
}

export interface StaffSettlement {
  $id: string;
  charge_id: string;
  person_id?: string;
  kind: SettleKind;
  amount: number;
  qty_found?: number | null;
  shift_id?: string | null;
  method_id?: string | null;
  /** For 'credit': the credit it was set against. */
  credit_id?: string | null;
  note?: string | null;
  recorded_by?: string | null;
  recorded_at: string;
}

export const SETTLE_WORDS: Record<SettleKind, string> = {
  cash: 'Paid in cash',
  pay: 'Taken from pay',
  found: 'Found on the shelf',
  written_off: 'Written off',
  credit: 'Set against a surplus',
};

export const isCredit = (c: Pick<StaffCharge, 'direction'>): boolean => c.direction === 'credit';

/** What is left to put right on one charge. Never below nothing. */
export const chargeLeft = (c: Pick<StaffCharge, 'amount' | 'settled_total'>): number =>
  Math.max(0, (c.amount || 0) - (c.settled_total || 0));

export const chargeAmount = (qty: number, unitPrice: number): number => Math.round(qty * unitPrice);

/* -------------------------------------------------------- the price */

export interface PricedRecipe {
  menu_item_id?: string;
  variant_id?: string;
  addon_option_id?: string;
  ingredient_id: string;
  qty_per_unit?: number;
}

/**
 * What one unit of a shelf item sells for, from the drinks that pour it.
 *
 * A Club · Large bottle is sold as the Large Club: the recipe says one bottle
 * per drink, so the bottle's selling price is the drink's. Where a bottle is
 * poured by measure — five centilitres of a seventy-five centilitre gin — the
 * drink's price is divided by the measure. The recipe closest to one unit per
 * drink wins, because that is the one where "one of these" means one sale.
 *
 * Null when nothing sells it: then there is no selling price to charge, and
 * the screen offers cost instead.
 */
export function sellingPricePerUnit(
  ingredientId: string,
  recipes: PricedRecipe[],
  items: { $id: string; name?: string; price?: number }[],
  variants: { $id: string; label?: string; price?: number }[],
): { price: number; from: string } | null {
  let best: { price: number; from: string; distance: number } | null = null;
  for (const r of recipes) {
    if (r.ingredient_id !== ingredientId || r.addon_option_id) continue;
    const q = Number(r.qty_per_unit ?? 0);
    if (!(q > 0)) continue;
    const item = items.find((i) => i.$id === r.menu_item_id);
    const size = r.variant_id ? variants.find((v) => v.$id === r.variant_id) : undefined;
    const price = size ? size.price : item?.price;
    if (typeof price !== 'number' || !(price > 0)) continue;
    const distance = Math.abs(Math.log(q));
    if (!best || distance < best.distance) {
      best = {
        price: Math.round(price / q),
        from: [item?.name, size?.label].filter(Boolean).join(' · '),
        distance,
      };
    }
  }
  return best ? { price: best.price, from: best.from } : null;
}

/** Selling price per unit for each shelf item, where something on the menu sells it. */
export function sellingPrices(
  ingredientIds: string[],
  recipes: PricedRecipe[],
  items: { $id: string; name?: string; price?: number }[],
  variants: { $id: string; label?: string; price?: number }[],
): Record<string, { price: number; from: string }> {
  const out: Record<string, { price: number; from: string }> = {};
  for (const id of new Set(ingredientIds)) {
    const found = sellingPricePerUnit(id, recipes, items, variants);
    if (found) out[id] = found;
  }
  return out;
}

/* -------------------------------------------------------- charging */

/** Why this charge cannot be made as typed, or null. */
export function chargeProblem(input: {
  personId: string;
  qty: number;
  /** How many the line differed by, either way. */
  short: number;
  unitPrice: number;
  direction?: ChargeDirection;
}): string | null {
  const credit = input.direction === 'credit';
  if (!input.personId) return credit ? 'Choose who this is credited to.' : 'Choose who this is charged to.';
  if (!(input.short > 0)) return 'Only a line that differed can be charged or credited to somebody.';
  if (!Number.isFinite(input.qty) || !(input.qty > 0)) return credit ? 'Say how many are being credited.' : 'Say how many are being charged.';
  if (input.qty > input.short + 1e-9) {
    return credit
      ? `Only ${input.short} were over, so no more than that can be credited.`
      : `Only ${input.short} came up short, so no more than that can be charged.`;
  }
  if (!Number.isFinite(input.unitPrice) || !(input.unitPrice > 0)) return 'Give a price for each one.';
  return null;
}

/** Said before the button is pressed. */
export function chargeWords(input: {
  name: string;
  person: string;
  qty: number;
  short: number;
  expected: number;
  counted: number;
  unitPrice: number;
  money: (n: number) => string;
  direction?: ChargeDirection;
}): string[] {
  const amount = chargeAmount(input.qty, input.unitPrice);
  const credit = input.direction === 'credit';
  const out = [
    `The shelf moves from ${input.expected} to ${input.counted} now, so the next count expects ${input.counted}.`,
    credit
      ? `${input.person} is credited ${input.money(amount)} (${input.qty} × ${input.money(input.unitPrice)}). It is set against what they owe, oldest first; anything left over is used up by their next shortage.`
      : `${input.person} owes ${input.money(amount)} (${input.qty} × ${input.money(input.unitPrice)}) until it is paid, found or written off.`,
  ];
  const rest = Number((input.short - input.qty).toFixed(4));
  if (rest > 0) out.push(credit ? `The other ${rest} over are applied as an ordinary gain.` : `The other ${rest} short are applied as an ordinary loss.`);
  return out;
}

/**
 * Which credits go against which shortages, for one person.
 *
 * Oldest credit against oldest shortage, each as far as it goes, so a credit
 * is used up in the order things happened. Nothing is matched across people.
 */
export function creditMatches(rows: StaffCharge[]): { creditId: string; chargeId: string; amount: number }[] {
  const byTime = (a: StaffCharge, b: StaffCharge) => a.charged_at.localeCompare(b.charged_at);
  const credits = rows.filter((r) => isCredit(r) && chargeLeft(r) > 0).sort(byTime).map((r) => ({ id: r.$id, left: chargeLeft(r), person: r.person_id }));
  const owed = rows.filter((r) => !isCredit(r) && chargeLeft(r) > 0).sort(byTime).map((r) => ({ id: r.$id, left: chargeLeft(r), person: r.person_id }));
  const out: { creditId: string; chargeId: string; amount: number }[] = [];
  for (const c of credits) {
    for (const o of owed) {
      if (c.left <= 0) break;
      if (o.left <= 0 || o.person !== c.person) continue;
      const amount = Math.min(c.left, o.left);
      out.push({ creditId: c.id, chargeId: o.id, amount });
      c.left -= amount;
      o.left -= amount;
    }
  }
  return out;
}

/* -------------------------------------------------------- settling */

/** Why this settlement cannot be recorded as typed, or null. */
export function settleProblem(input: {
  kind: SettleKind;
  /** A credit is used up against shortages, never settled by hand. */
  isCredit?: boolean;
  amount: number;
  left: number;
  isAdmin: boolean;
  note: string;
  qtyFound?: number;
  charged?: number;
}): string | null {
  if (input.isCredit) return 'A credit is set against what they owe on its own; there is nothing to settle by hand.';
  if (input.kind === 'credit') return 'Credits are set against shortages on their own.';
  if (input.left <= 0) return 'Nothing is owed on this any more.';
  if (input.kind === 'found') {
    const q = input.qtyFound ?? 0;
    if (!(q > 0)) return 'Say how many turned up.';
    if (input.charged !== undefined && q > input.charged + 1e-9) return `Only ${input.charged} were charged.`;
    return null;
  }
  if (!Number.isFinite(input.amount) || !(input.amount > 0)) return 'Give an amount.';
  if (input.amount > input.left) return 'That is more than is still owed.';
  if (input.kind === 'written_off') {
    if (!input.isAdmin) return 'Only an admin can write this off.';
    if (!input.note.trim()) return 'Say why it is being written off.';
  }
  return null;
}

/** What "found" takes off what is owed: what they were charged each, no more than is left. */
export const foundAmount = (qtyFound: number, unitPrice: number, left: number): number =>
  Math.min(left, chargeAmount(qtyFound, unitPrice));

/** The row once a settlement of this amount is recorded. */
export function afterSettle(c: Pick<StaffCharge, 'amount' | 'settled_total'>, amount: number): {
  settled_total: number;
  status: 'open' | 'settled';
} {
  const settled = Math.min(c.amount, (c.settled_total || 0) + Math.max(0, amount));
  return { settled_total: settled, status: settled >= c.amount ? 'settled' : 'open' };
}

/* -------------------------------------------------------- reading */

export interface PersonOwing {
  personId: string;
  name: string;
  charged: number;
  /** Credited for surpluses, in all. */
  credited: number;
  /** Credit not yet set against anything: waits for their next shortage. */
  creditLeft: number;
  settled: number;
  /** What they owe once credits are set against it. Never below nothing; see creditLeft. */
  left: number;
  open: number;
  settledCount: number;
  /** When the oldest charge still open was made. */
  oldestOpen?: string;
  charges: StaffCharge[];
}

/** One row per person, most owed first. */
export function owingByPerson(charges: StaffCharge[]): PersonOwing[] {
  const by = new Map<string, PersonOwing>();
  for (const c of charges) {
    const p = by.get(c.person_id) ?? {
      personId: c.person_id, name: c.person_name, charged: 0, credited: 0, creditLeft: 0, settled: 0, left: 0, open: 0, settledCount: 0, charges: [],
    };
    p.charges.push(c);
    by.set(c.person_id, p);
    if (isCredit(c)) {
      p.credited += c.amount || 0;
      p.creditLeft += chargeLeft(c);
      continue;
    }
    p.charged += c.amount || 0;
    p.settled += Math.min(c.amount || 0, c.settled_total || 0);
    p.left += chargeLeft(c);
    if (chargeLeft(c) > 0) {
      p.open += 1;
      if (!p.oldestOpen || c.charged_at < p.oldestOpen) p.oldestOpen = c.charged_at;
    } else {
      p.settledCount += 1;
    }
  }
  for (const p of by.values()) {
    p.charges.sort((a, b) => b.charged_at.localeCompare(a.charged_at));
    // Credits are set against shortages as they are made (creditMatches);
    // where that has not happened yet, the figures still net them off.
    const net = p.left - p.creditLeft;
    p.left = Math.max(0, net);
    p.creditLeft = Math.max(0, -net);
  }
  return [...by.values()].sort((a, b) => b.left - a.left || a.name.localeCompare(b.name));
}

/** The three figures at the top of the page. */
export function owingTotals(
  charges: StaffCharge[],
  settlements: StaffSettlement[],
  monthStart: string,
): { owed: number; people: number; putRightThisMonth: number } {
  const owing = owingByPerson(charges).filter((p) => p.left > 0);
  return {
    owed: owing.reduce((s, p) => s + p.left, 0),
    people: owing.length,
    putRightThisMonth: settlements.filter((s) => s.recorded_at >= monthStart).reduce((s, r) => s + (r.amount || 0), 0),
  };
}

/** What the person at the till is told, or null when they owe nothing. */
export function owedWords(mine: StaffCharge[], money: (n: number) => string): string | null {
  const open = mine.filter((c) => !isCredit(c) && chargeLeft(c) > 0);
  if (open.length === 0) return null;
  const credit = mine.filter(isCredit).reduce((s, c) => s + chargeLeft(c), 0);
  const sum = open.reduce((s, c) => s + chargeLeft(c), 0) - credit;
  if (sum <= 0) return null;
  const what = open.length === 1
    ? `${open[0]!.qty} ${open[0]!.item_name} short`
    : `${open.length} count differences`;
  return `You owe ${money(sum)} from ${open.length === 1 ? 'a count' : 'counts'} (${what}). Speak to a manager to put it right.`;
}

/**
 * Cash paid back into a drawer, by payment method, for one shift.
 *
 * Part of what that drawer should hold at close: the money is in it, and a
 * close that did not expect it would read as over by exactly that much.
 */
export function repaidByMethod(settlements: Pick<StaffSettlement, 'kind' | 'amount' | 'method_id'>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of settlements) {
    if (s.kind !== 'cash' || !s.method_id || !(s.amount > 0)) continue;
    out[s.method_id] = (out[s.method_id] ?? 0) + s.amount;
  }
  return out;
}
