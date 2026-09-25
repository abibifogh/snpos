/**
 * Drinks made here, received into stock once they are made.
 *
 * Sobolo, ginger beer, a house punch, a pre-batched cocktail: made in a pot
 * rather than bought in a crate, then bottled and put in the store room or
 * behind the bar, and poured from like anything else. The system could only
 * receive stock that was BOUGHT, so a made drink had no honest way onto a
 * shelf — and whatever way it did get there, it arrived costing nothing.
 *
 * MAKING IS A TRANSFORMATION, not an arrival, and both halves matter:
 *
 *   WHAT WENT IN comes off its shelf. Three kilos of sugar used for sobolo
 *   and never recorded leaves the store room's count three kilos short, and
 *   the next count holds that as a difference, alerts an admin, and puts it
 *   on somebody's shift. A shortage that is really a recipe is exactly the
 *   accusation that stops people counting honestly.
 *
 *   WHAT CAME OUT carries what went in. The batch's cost is the ingredients'
 *   cost, spread over the bottles made, and folded into the drink's average
 *   the way a delivery's price is. Otherwise every sobolo sells at a cost of
 *   nothing, the bar's margin reads as a hundred percent, and the sugar's
 *   cost sits in the kitchen for ever.
 *
 * Listing what went in is optional. A drink whose ingredients were bought at
 * the market and never stocked has nothing on any shelf to take off; it is
 * received at no cost, and the words say what that means for its margin
 * rather than inventing a figure.
 *
 * Pure. Nothing here reads or writes.
 */

/** One thing that went into a batch, as the form holds it. */
export interface BatchInput {
  ingredientId: string;
  name: string;
  unit: string;
  /** Which side's stock it came from, for the books. Absent is the kitchen. */
  module?: string;
  /** Which place it was taken from. */
  locationId: string;
  /** What that place holds now, for the warning. */
  available: number;
  /** Its average cost per unit, minor units. */
  unitCost: number;
  qtyText?: string;
}

/** A typed quantity as a number, or null when it is blank or nonsense. */
export function batchQty(text: string | undefined): number | null {
  const t = String(text ?? '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The inputs actually filled in. A blank row is a row nobody used. */
export const usedInputs = (inputs: BatchInput[]): BatchInput[] =>
  inputs.filter((i) => batchQty(i.qtyText) !== null);

/**
 * Why this batch cannot be recorded, or null.
 *
 * What was made, how much, and where it went are required; everything that
 * went in is optional. Using the drink in its own batch is refused — a
 * batch that consumes what it makes is a typo, and recorded it would take
 * the stock out and put it back as if something had happened.
 */
export function batchProblem(opts: {
  madeId?: string;
  madeQtyText?: string;
  locationId?: string;
  inputs: BatchInput[];
}): string | null {
  if (!opts.madeId) return 'Choose what was made.';
  if (batchQty(opts.madeQtyText) === null) return 'Enter how much was made.';
  if (!opts.locationId) return 'Choose where it was put — the store room or the bar.';
  if (usedInputs(opts.inputs).some((i) => i.ingredientId === opts.madeId)) {
    return 'A batch cannot use the drink it makes. Remove it from what went in.';
  }
  const seen = new Set<string>();
  for (const i of usedInputs(opts.inputs)) {
    const key = `${i.ingredientId}|${i.locationId}`;
    if (seen.has(key)) return `${i.name} is listed twice from the same place. Put it on one line.`;
    seen.add(key);
  }
  return null;
}

/**
 * What went in, in quantities the place does not appear to hold.
 *
 * Warned about and not refused, the same rule as moving stock: the shelf is
 * the truth and the book is a claim about it. Somebody who has just made a
 * batch with the sugar in front of them is looking at the answer, and a
 * system that argues is one they route around by not recording the batch.
 */
export const shortInputs = (inputs: BatchInput[]): BatchInput[] =>
  usedInputs(inputs).filter((i) => (batchQty(i.qtyText) ?? 0) > i.available);

/** What the batch cost: everything listed, at what each is worth now. */
export const batchCost = (inputs: BatchInput[]): number =>
  Math.round(usedInputs(inputs).reduce((sum, i) => sum + (batchQty(i.qtyText) ?? 0) * i.unitCost, 0));

/** Per unit made. Nought when nothing was listed or nothing was made. */
export const batchUnitCost = (total: number, madeQty: number): number =>
  (madeQty > 0 && total > 0 ? Math.round(total / madeQty) : 0);

/**
 * The value that crosses from one side's stock to another's, by side.
 *
 * Kitchen sugar made into a bar drink leaves the kitchen's inventory and
 * joins the bar's. The books keep one inventory account per side, so that
 * move has to be posted — or the bar's account is credited, drink by drink
 * as it sells, for value it was never given, and runs below nothing. Inputs
 * from the drink's own side move within one account and need nothing.
 */
export function crossSideValue(
  inputs: BatchInput[],
  madeModule: string,
): { module: string; value: number }[] {
  const by = new Map<string, number>();
  for (const i of usedInputs(inputs)) {
    const side = i.module ?? 'kitchen';
    if (side === madeModule) continue;
    by.set(side, (by.get(side) ?? 0) + (batchQty(i.qtyText) ?? 0) * i.unitCost);
  }
  return [...by.entries()]
    .map(([module, value]) => ({ module, value: Math.round(value) }))
    .filter((v) => v.value > 0);
}

/** A batch as it is stored, enough of it to fill in the next one. */
export interface PastBatch {
  made_qty: number;
  /** JSON, as stored: [{ ingredient_id, name, unit, qty, location_id, module }]. */
  inputs?: string;
}

/**
 * The last batch of this drink, scaled to how much is being made now.
 *
 * A recipe nobody had to type. Sobolo is made the same way every week, so
 * the second batch starts from the first: what went in last time, in
 * proportion to what is being made this time. Everything stays editable —
 * it is a starting point, not a rule — because a batch that came out
 * thinner than usual is exactly the thing somebody should be able to say.
 *
 * Rounded to three places. Scaling 2 kilos to 30 bottles from 24 gives
 * 2.5, not 2.4999999999999996, and a quantity with sixteen decimals in it is
 * a quantity nobody believes.
 */
export function prefillFrom(
  last: PastBatch | null | undefined,
  madeQty: number | null,
): { ingredientId: string; name: string; unit: string; locationId: string; module?: string; qtyText: string }[] {
  if (!last?.inputs) return [];
  let rows: { ingredient_id?: string; name?: string; unit?: string; qty?: number; location_id?: string; module?: string }[];
  try {
    rows = JSON.parse(last.inputs);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const scale = madeQty && last.made_qty > 0 ? madeQty / last.made_qty : 1;
  return rows
    .filter((r) => r.ingredient_id && (r.qty ?? 0) > 0)
    .map((r) => ({
      ingredientId: String(r.ingredient_id),
      name: r.name ?? '',
      unit: r.unit ?? '',
      locationId: r.location_id ?? '',
      module: r.module,
      qtyText: String(Number(((r.qty ?? 0) * scale).toFixed(3))),
    }));
}

/** The inputs as they are stored on the batch, so the next one can start from them. */
export const storedInputs = (inputs: BatchInput[]): string =>
  JSON.stringify(usedInputs(inputs).map((i) => ({
    ingredient_id: i.ingredientId,
    name: i.name,
    unit: i.unit,
    qty: batchQty(i.qtyText),
    location_id: i.locationId,
    module: i.module ?? 'kitchen',
    unit_cost: i.unitCost,
  })));

/**
 * The batch in one sentence, for the confirmation and the toast.
 *
 * Says the cost when there is one, and says plainly what it means when there
 * is not — a drink received at nothing will show a margin of a hundred
 * percent, and somebody reading a report should not have to discover why.
 */
export function batchWords(opts: {
  madeName: string;
  madeQty: number;
  unit: string;
  placeName: string;
  total: number;
  inputsCount: number;
  money: (n: number) => string;
}): string {
  const head = `${opts.madeQty} ${opts.unit} of ${opts.madeName} into ${opts.placeName}`;
  if (opts.inputsCount === 0 || opts.total === 0) {
    return `${head}, at no cost. Nothing that went into it was taken off a shelf, so it sells at a cost of `
      + 'nothing and its margin will read as all profit. List what went in next time to cost it properly.';
  }
  const each = batchUnitCost(opts.total, opts.madeQty);
  return `${head}, costing ${opts.money(opts.total)} (${opts.money(each)} each). `
    + `${opts.inputsCount} ${opts.inputsCount === 1 ? 'ingredient comes' : 'ingredients come'} off the shelf.`;
}
