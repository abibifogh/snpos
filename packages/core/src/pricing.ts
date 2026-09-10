import type { Settings } from './types';

/**
 * Order maths, in one place.
 *
 * Every app computes totals, and three implementations would drift within a
 * month. Prices are integers in minor units throughout; the only rounding is
 * at the points marked below, and it is always Math.round on a single value
 * rather than accumulated fractions.
 */

export interface CartAddon {
  option_id: string;
  group_id: string;
  name: string;
  price_delta: number;
  qty?: number;
}

export interface CartLine {
  /** Stable within the cart, so quantity edits do not merge distinct lines. */
  key: string;
  menu_item_id: string;
  name: string;
  unit_price: number;
  qty: number;
  addons: CartAddon[];
  notes?: string;
  station?: string;
  station_key?: string;
  prep_minutes?: number;
  seat_no?: number;
  course?: number;
  // ------------------------------------------------------------- craft shop
  // Which size was picked, and whose work it is. Carried from the shelf to the
  // sale line so the ledger can credit the right person at the agreed rate,
  // without the till having to look anything up at the moment of payment.
  variant_id?: string;
  variant_label?: string;
  /**
   * What this line would have cost at the menu price, when somebody with
   * permission changed it at the till. See the schema note on `list_price`:
   * it is both the record of a decision and the flag that stops order-guard
   * repricing the line back a second after the sale.
   */
  list_price?: number;
  price_changed_by?: string;
  consignor_id?: string;
  commission_bp?: number;
  commission_flat?: number;
}

/** Unit price plus every add-on, before quantity. */
export const lineUnitPrice = (line: CartLine): number =>
  line.unit_price + line.addons.reduce((sum, a) => sum + a.price_delta * (a.qty ?? 1), 0);

export const lineTotal = (line: CartLine): number => lineUnitPrice(line) * line.qty;

export interface OrderTotals {
  subtotal: number;
  discount_total: number;
  service_total: number;
  tax_total: number;
  /** What the tax is made of: each levy, then VAT. See levies.ts. */
  tax_parts: TaxPart[];
  delivery_fee: number;
  /** Containers, on an order being taken away. See group-booking.ts. */
  pack_fee: number;
  total: number;
}

export interface TotalsInput {
  lines: CartLine[];
  /** Already-resolved discount amount in minor units. */
  discount?: number;
  deliveryFee?: number;
  /**
   * What the containers cost, on an order being taken away.
   *
   * Worked out by the caller rather than here, because how many containers an
   * order needs is a rule about the order, not about its arithmetic. See
   * packFeeFor in group-booking.ts.
   */
  packFee?: number;
  settings: Pick<Settings, 'tax_rate_bp' | 'tax_inclusive' | 'service_charge_bp'>
    & { levies?: string; vat_charged?: boolean };
}

/**
 * Order of operations matters for what the customer is charged and for what
 * the tax authority is owed:
 *
 *   1. line totals            (item + add-ons) x quantity
 *   2. minus discounts        never below zero
 *   3. plus service charge    on the DISCOUNTED subtotal, not the gross
 *   4. plus delivery
 *   5. tax                    extracted from the total when prices are
 *                             tax-inclusive, added on top when they are not
 *
 * Tips are deliberately absent: they are not sales, are never discounted and
 * are not taxed as revenue, so they are recorded on the payment instead.
 */
export function computeTotals({
  lines, discount = 0, deliveryFee = 0, packFee = 0, settings,
}: TotalsInput): OrderTotals {
  const subtotal = lines.reduce((sum, l) => sum + lineTotal(l), 0);
  const discount_total = Math.min(Math.max(discount, 0), subtotal);
  const discounted = subtotal - discount_total;

  const service_total = Math.round((discounted * (settings.service_charge_bp || 0)) / 10000);
  /*
    Fees are taxed, and are not discounted.

    A pack fee is the price of a container the business bought and is passing
    on, so it is a sale like any other and carries whatever VAT and levies
    sales carry. It sits after the discount deliberately: a party negotiating
    ten per cent off the food has not negotiated ten per cent off the boxes.
  */
  const taxableBase = discounted + service_total + deliveryFee + packFee;

  // VAT and the levies beside it, part by part. See levies.ts: with no
  // levies this is the single rate the system always had, to the rounding.
  const tax = taxBreakdown({
    taxable: taxableBase,
    vatBp: vatBpOf(settings),
    inclusive: !!settings.tax_inclusive,
    levies: parseLevies(settings.levies),
  });
  const tax_total = tax.total;

  return {
    subtotal,
    discount_total,
    service_total,
    tax_total,
    tax_parts: tax.parts,
    delivery_fee: deliveryFee,
    pack_fee: packFee,
    // Inclusive tax is already inside the prices, so adding it again would
    // charge the customer twice.
    total: settings.tax_inclusive ? taxableBase : taxableBase + tax_total,
  };
}

/** Split a bill evenly, giving any remainder to the earliest shares. */
export function splitEvenly(total: number, ways: number): number[] {
  if (ways < 1) return [total];
  const base = Math.floor(total / ways);
  const remainder = total - base * ways;
  return Array.from({ length: ways }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * What an order comes to once its quantities have been corrected.
 *
 * Here rather than beside the correction screen, and deliberately. A total
 * worked out in two places is two places that disagree the first time somebody
 * changes the service charge — so a corrected bill goes through exactly the
 * same arithmetic as a fresh one, in the same order, with the same rounding.
 *
 * Voided lines stay out, exactly as they were when the order was rung up, so a
 * correction cannot quietly bring a voided dish back into the total. A line
 * corrected to nothing drops out for the same reason it would never have been
 * added: nought of something costs nothing.
 */
export function retotalOrder({
  lines, quantities, discount = 0, deliveryFee = 0, settings,
}: {
  lines: {
    $id: string;
    unit_price: number;
    qty: number;
    /** JSON, exactly as stored on the order line. */
    addons?: string;
    status?: string;
  }[];
  /** New quantity per line id. A line not named here keeps the one it has. */
  quantities: Record<string, number>;
  discount?: number;
  deliveryFee?: number;
  settings: Pick<Settings, 'tax_rate_bp' | 'tax_inclusive' | 'service_charge_bp'> & { levies?: string };
}): OrderTotals {
  const cart: CartLine[] = lines
    .filter((l) => l.status !== 'void')
    .map((l) => ({
      // The identity fields are never read by computeTotals — it prices lines,
      // it does not care which dish they are — and inventing plausible ones
      // here would be a second, quietly wrong copy of the order.
      key: l.$id,
      menu_item_id: '',
      name: '',
      unit_price: l.unit_price,
      qty: quantities[l.$id] ?? l.qty,
      addons: (() => {
        try {
          return JSON.parse(l.addons || '[]') as CartLine['addons'];
        } catch {
          // A line whose add-ons cannot be read is priced on the item alone
          // rather than refusing the whole correction.
          return [];
        }
      })(),
    }));

  return computeTotals({ lines: cart.filter((l) => l.qty > 0), discount, deliveryFee, settings });
}

/* ------------------------------------------------ VAT and the levies beside it */

/*
 * Tax as Ghana actually charges it: VAT, and the levies beside it.
 *
 * The system had one tax rate. A receipt in Accra carries several: the
 * National Health Insurance Levy and the GETFund levy on the price, the
 * tourism levy on the price, and VAT on the price PLUS those levies. Each is
 * declared on its own return to a different body, and a single rate cannot
 * produce any of them.
 *
 * Here rather than in a file of its own because this file imports nothing at
 * runtime and computeTotals needs the arithmetic; a pure module cannot reach
 * a sibling. Mirrored in functions/order-guard/src/money.js, kept the same
 * by the parity test.
 */


export interface Levy {
  /** 'nhil', 'getfund', 'tourism', or anything the business calls its own. */
  key: string;
  /** What the receipt says: 'NHIL', 'GETFund', 'Tourism levy'. */
  name: string;
  /** Basis points: 250 is 2.5%. */
  rate_bp: number;
}

/**
 * The levies a Ghanaian hospitality business is likely to charge, at the
 * rates in force when this was written. Rates are the business's to set;
 * these are only the starting point the settings page offers.
 */
export const GHANA_LEVIES: readonly Levy[] = [
  { key: 'nhil', name: 'NHIL', rate_bp: 250 },
  { key: 'getfund', name: 'GETFund levy', rate_bp: 250 },
  { key: 'tourism', name: 'Tourism levy', rate_bp: 100 },
];

/**
 * Where each levy is owed, by account number.
 *
 * A copy of what accounts.ts holds, because this file imports nothing at
 * runtime; a parity test keeps the two the same. A levy the chart has no
 * account for goes to "Other levies payable" rather than being folded into
 * VAT, which would file it on the wrong return.
 */
/**
 * The VAT rate actually in force, which is nought when the business says it
 * does not charge VAT.
 *
 * A switch rather than "type nought in the rate box", because those are two
 * different statements and only one of them survives somebody tidying up. A
 * business that stops charging VAT wants its rate remembered for the day it
 * registers again, and a rate box left at 15 with a switch turned off is a
 * clearer record than a nought nobody can explain. Every place that works
 * out tax reads the rate through here, so the switch cannot be honoured on
 * the receipt and forgotten at the till.
 *
 * The levies are not affected. Each is its own charge to its own body, and
 * they are turned on and off one at a time in settings.
 */
export const vatBpOf = (settings: { tax_rate_bp?: number; vat_charged?: boolean }): number =>
  (settings.vat_charged === false ? 0 : Math.max(0, Math.round(settings.tax_rate_bp || 0)));

export const LEVY_ACCOUNTS: Record<string, string> = {
  vat: '2100',
  nhil: '2110',
  getfund: '2120',
  tourism: '2130',
};
export const OTHER_LEVIES_ACCOUNT = '2190';
export const levyAccount = (key: string): string => LEVY_ACCOUNTS[key] ?? OTHER_LEVIES_ACCOUNT;

/** Settings keep the list as JSON text. Anything unreadable is no levies. */
export function parseLevies(raw?: string | null): Levy[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((l): l is Levy => !!l && typeof l === 'object' && typeof (l as Levy).key === 'string')
      .map((l) => ({
        key: String(l.key).trim(),
        name: String(l.name ?? l.key).trim(),
        rate_bp: Math.max(0, Math.round(Number(l.rate_bp) || 0)),
      }))
      .filter((l) => l.key !== '' && l.rate_bp > 0);
  } catch {
    return [];
  }
}

export const serialiseLevies = (levies: Levy[]): string =>
  JSON.stringify(levies.filter((l) => l.key.trim() !== '' && l.rate_bp > 0)
    .map((l) => ({ key: l.key.trim(), name: l.name.trim() || l.key.trim(), rate_bp: Math.round(l.rate_bp) })));

export interface TaxPart {
  key: string;
  name: string;
  amount: number;
  account_code: string;
}

export interface TaxBreakdown {
  /** Everything owed onward, minor units. */
  total: number;
  /** The levies in the order given, then VAT last. Only the non-zero ones. */
  parts: TaxPart[];
}

/**
 * The tax on a taxable amount, part by part.
 *
 * ADDED ON TOP: each levy is a share of the taxable amount, rounded; VAT is a
 * share of the taxable amount plus the levies, because that is how Ghana
 * stacks it. INCLUDED IN THE PRICE: the same stack, worked backwards from
 * the price the customer sees; the total is the whole stack, and the parts
 * are the levies rounded from the underlying base with VAT taking the
 * remainder, so the parts always add up to the total.
 *
 * With no levies the result is exactly the single-rate arithmetic the
 * system had, to the rounding, so nothing already priced changes.
 */
export function taxBreakdown(input: {
  taxable: number;
  vatBp: number;
  inclusive: boolean;
  levies: Levy[];
}): TaxBreakdown {
  const taxable = Math.round(input.taxable);
  const vatBp = Math.max(0, Math.round(input.vatBp || 0));
  const levies = input.levies.filter((l) => l.rate_bp > 0);
  const leviesBp = levies.reduce((s, l) => s + l.rate_bp, 0);

  if (taxable === 0 || (vatBp === 0 && leviesBp === 0)) return { total: 0, parts: [] };

  let total: number;
  let base: number;
  if (input.inclusive) {
    // Exactly the old formula when there are no levies: the price less the
    // price divided by one plus the rate.
    base = (taxable * 10000 * 10000) / ((10000 + leviesBp) * (10000 + vatBp));
    total = Math.round(taxable - base);
  } else {
    base = taxable;
    const leviesSum = levies.reduce((s, l) => s + Math.round((base * l.rate_bp) / 10000), 0);
    const vat = Math.round(((base + leviesSum) * vatBp) / 10000);
    total = leviesSum + vat;
  }

  const parts: TaxPart[] = [];
  let given = 0;
  for (const l of levies) {
    const amount = Math.round((base * l.rate_bp) / 10000);
    if (amount > 0) parts.push({ key: l.key, name: l.name, amount, account_code: levyAccount(l.key) });
    given += amount;
  }
  const vat = total - given;
  if (vat > 0 || parts.length === 0) parts.push({ key: 'vat', name: 'VAT', amount: vat, account_code: LEVY_ACCOUNTS.vat });
  return { total, parts };
}

/**
 * A tax total already on an order, taken apart again.
 *
 * Orders store one tax figure, and that is enough: with the rates known the
 * stack is fixed, so the underlying base follows from the total and each
 * part from the base. Used at shift close to credit each levy to its own
 * account, and on a receipt to print the lines. Whether the price included
 * the tax or not makes no difference here — the stack is the same stack.
 */
export function splitTax(taxTotal: number, input: { vatBp: number; levies: Levy[] }): TaxPart[] {
  const total = Math.max(0, Math.round(taxTotal));
  if (total === 0) return [];
  const levies = input.levies.filter((l) => l.rate_bp > 0);
  const leviesBp = levies.reduce((s, l) => s + l.rate_bp, 0);
  const vatBp = Math.max(0, Math.round(input.vatBp || 0));
  // total = base * (L + (1 + L) * V), all in basis points.
  const stack = leviesBp / 10000 + (1 + leviesBp / 10000) * (vatBp / 10000);
  if (stack === 0) return [{ key: 'vat', name: 'VAT', amount: total, account_code: LEVY_ACCOUNTS.vat }];
  const base = total / stack;
  const parts: TaxPart[] = [];
  let given = 0;
  for (const l of levies) {
    const amount = Math.round((base * l.rate_bp) / 10000);
    if (amount > 0) parts.push({ key: l.key, name: l.name, amount, account_code: levyAccount(l.key) });
    given += amount;
  }
  const vat = total - given;
  if (vat > 0 || parts.length === 0) parts.push({ key: 'vat', name: 'VAT', amount: vat, account_code: LEVY_ACCOUNTS.vat });
  return parts;
}

/**
 * What to call the one line, when tax is shown as one line.
 *
 * "VAT and levies" where both are charged, and where VAT is not, the levies
 * are named instead. A receipt that says VAT on a business that does not
 * charge it is the kind of wrong that a customer can take to the revenue
 * authority.
 */
export const taxWords = (levies: Levy[], currencyCode?: string, vatOn = true): string => {
  if (levies.length === 0) return currencyCode === 'GHS' ? 'VAT' : 'Tax';
  if (vatOn) return 'VAT and levies';
  return levies.length === 1 ? levies[0].name : 'Levies';
};

/**
 * Whether a receipt prints each charge on its own line or adds them into one.
 *
 * The business's choice, because both are defensible: a customer wants to
 * see what each body is owed, and a narrow till roll wants one line. One
 * part is one line either way, so the choice only bites where there are
 * several. Read by the browser receipt and by the server's PDF, so a
 * printed copy and an emailed one agree.
 */
export const showsTaxParts = (parts: { amount: number }[], detail?: string): boolean =>
  detail !== 'combined' && parts.length > 1;

/* --------------------------------------------- a group booking, day by day */

/**
 * A group that is staying, not visiting.
 *
 * The group menu was built for one meal: a party arrives, eats platters, goes
 * home. A hotel group stays four nights, and every night is a different
 * decision — Monday they eat in the restaurant, Tuesday they are out on an
 * excursion and want it packed, Wednesday half of them are back late. Asking
 * that booking to be typed as one order, four times, through four separate
 * links, is how a front desk ends up with four unconnected tickets and no
 * idea they belong to the same party.
 *
 * So a booking holds DAYS. Each day carries its own moment, its own choice of
 * eating in or taking away, and its own dishes.
 *
 * ## One order per day, not one order for the booking
 *
 * Sending the booking writes an order per day. That is the whole reason this
 * fits: an order already knows how to be scheduled and to stay silent until
 * its own fire time, and the kitchen already knows how to cook a ticket that
 * arrives on the morning it is wanted. A single order spanning four days
 * would need every one of those behaviours inventing again, and would put
 * Thursday's platters on Monday's pass.
 *
 * They are tied together by the booking's own id and by the reference the
 * hotel gave, so the front desk can find all four.
 *
 * Pure. Imports nothing at runtime, which is what lets the fee rule and the
 * refusals be tested without a browser. The arithmetic that needs
 * computeTotals lives beside it, in pricing.ts.
 */

export type Fulfilment = 'dine_in' | 'takeaway';

export interface GroupDay {
  /** Stable while the sheet is open, so a day can be edited and removed. */
  key: string;
  /** The moment this day's food is wanted, ISO. */
  at: string;
  fulfilment: Fulfilment;
  lines: CartLine[];
}

export const FULFILMENT_WORDS: Record<Fulfilment, string> = {
  dine_in: 'Eating here',
  takeaway: 'Packed to take away',
};

/** How many portions are on a day. Add-ons ride along with their dish and are not packed separately. */
export const portionsOn = (day: { lines: CartLine[] }): number =>
  day.lines.reduce((n, l) => n + Math.max(0, l.qty), 0);

/**
 * What the containers cost for one day.
 *
 * Once per portion, because that is what gets packed: twenty lunches is
 * twenty boxes. Nothing at all on a day the group is eating in the
 * restaurant, where the food goes out on plates the business already owns.
 */
export function packFeeFor(day: { fulfilment: Fulfilment; lines: CartLine[] }, feePerPortion: number): number {
  if (day.fulfilment !== 'takeaway') return 0;
  const fee = Math.max(0, Math.round(feePerPortion || 0));
  return fee === 0 ? 0 : portionsOn(day) * fee;
}

/** The calendar day a moment falls on, for grouping times into days. */
export const dayKeyOf = (at: string | Date): string => {
  const d = at instanceof Date ? at : new Date(at);
  return Number.isFinite(d.getTime())
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : '';
};

/** The times on offer, gathered into the days they belong to, earliest first. */
export function slotsByDay(slots: Date[]): { key: string; label: string; times: Date[] }[] {
  const byDay = new Map<string, Date[]>();
  for (const s of [...slots].sort((a, b) => a.getTime() - b.getTime())) {
    const key = dayKeyOf(s);
    const list = byDay.get(key) ?? [];
    list.push(s);
    byDay.set(key, list);
  }
  return [...byDay.entries()].map(([key, times]) => ({
    key,
    // Spelt out here too, for the reason in longDayWords.
    label: longDayWords(times[0]),
    times,
  }));
}

/** Days already on the booking, so the picker does not offer one twice. */
export const daysTaken = (days: GroupDay[]): Set<string> => new Set(days.map((d) => dayKeyOf(d.at)));

export interface BookingCheck {
  reference: string;
  needReference: boolean;
  referenceLabel: string;
  size: number;
  minSize: number;
  contactName: string;
}

/**
 * What is stopping this booking being sent, in the words of whoever is sending it.
 *
 * One thing at a time and the earliest first, because a list of five faults
 * on a phone is read as "this does not work" rather than as five things to
 * fix. Every one of them is about the booking as a whole; a day that is
 * wrong is caught by dayProblem below and shown against that day.
 */
const LONG_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * "Monday 14 September", spelt out rather than left to the browser.
 *
 * Same reasoning as dates.ts, which is not imported here only because this
 * file deliberately imports nothing at runtime. A phone set to American
 * English would otherwise read "September 14" beside an office reading
 * "14 September", and this string goes in front of a hotel.
 */
export function longDayWords(at: string | Date): string {
  const d = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(d.getTime())) return 'that day';
  return `${LONG_DAYS[d.getDay()]} ${d.getDate()} ${LONG_MONTHS[d.getMonth()]}`;
}

export function bookingProblem(days: GroupDay[], check: BookingCheck): string | null {
  if (days.length === 0) return 'Add a day, and what the group would like to eat on it.';
  const empty = [...days].sort((a, b) => a.at.localeCompare(b.at)).find((d) => portionsOn(d) === 0);
  if (empty) {
    return `${longDayWords(empty.at)} has nothing on it. Add something, or take the day off the booking.`;
  }
  if (!check.contactName.trim()) return 'Please give a name for the booking, so the kitchen knows whose it is.';
  if (check.needReference && !check.reference.trim()) return `Please enter the ${check.referenceLabel.toLowerCase()}.`;
  if (check.minSize > 0 && check.size < check.minSize) return `Group bookings are for ${check.minSize} people or more.`;
  return null;
}

/** What a day is worth saying about itself, under its own heading. */
export function dayWords(
  totals: { portions: number; packFee: number; total: number },
  money: (n: number) => string,
): string {
  const portions = totals.portions === 1 ? '1 portion' : `${totals.portions} portions`;
  const fee = totals.packFee > 0 ? `, ${money(totals.packFee)} of that packing` : '';
  return `${portions}, ${money(totals.total)}${fee}.`;
}

/**
 * What the pack fee means, said once and plainly.
 *
 * Shown wherever the choice is made rather than only on the bill, because a
 * charge somebody meets at the end is a charge they argue about at the end.
 */
export function packWords(feePerPortion: number, money: (n: number) => string): string {
  if (feePerPortion <= 0) return 'Nothing extra either way.';
  return `Packed meals carry ${money(feePerPortion)} a portion for the containers. Eating here carries nothing.`;
}

export interface DayPricing extends OrderTotals {
  packFee: number;
  portions: number;
}

/** One day of a group booking, priced, because one day becomes one order. */
export function dayTotals(
  day: GroupDay,
  settings: TotalsInput['settings'],
  feePerPortion: number,
): DayPricing {
  const packFee = packFeeFor(day, feePerPortion);
  const totals = computeTotals({ lines: day.lines.filter((l) => l.qty > 0), packFee, settings });
  return { ...totals, packFee, portions: portionsOn(day) };
}

export interface BookingTotals {
  /** Every day priced, in the order they will be eaten. */
  days: { day: GroupDay; totals: DayPricing }[];
  subtotal: number;
  packFees: number;
  tax: number;
  service: number;
  total: number;
  portions: number;
}

/**
 * The whole booking.
 *
 * Added up from the days rather than priced as one basket, so what the
 * booking says matches what the orders will each say. Pricing the lot
 * together and dividing would round differently and leave the sum of the
 * tickets a cedi away from the quote the hotel agreed to.
 */
export function bookingTotals(
  days: GroupDay[],
  settings: TotalsInput['settings'],
  feePerPortion: number,
): BookingTotals {
  const priced = [...days]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((day) => ({ day, totals: dayTotals(day, settings, feePerPortion) }));
  const sum = (pick: (t: DayPricing) => number) => priced.reduce((n, p) => n + pick(p.totals), 0);
  return {
    days: priced,
    subtotal: sum((t) => t.subtotal),
    packFees: sum((t) => t.packFee),
    tax: sum((t) => t.tax_total),
    service: sum((t) => t.service_total),
    total: sum((t) => t.total),
    portions: sum((t) => t.portions),
  };
}
