/**
 * Counting a bar's bottles, at both ends of a shift.
 *
 * A kitchen counts once, at close, and nobody signs for the rice. A bar is
 * different in a way that decides the whole shape of this file: the person
 * coming on shift accepts responsibility for what is behind the bar, and the
 * person going off hands it over. Two counts, two names, and the difference
 * between them is what somebody is answerable for.
 *
 * Which is why the opening count is not simply "what the last shift left". It
 * usually is, and the times it is not are the times that matter — a delivery
 * that arrived overnight, a bottle taken for a function, a count somebody
 * rushed. Asking again at the start costs two minutes and is the only thing
 * that stops a variance being argued about at the end of a long night.
 *
 * Pure. What is expected, what was found, and what that difference is worth
 * can all be checked without a database.
 */

/** How a bar's stock is counted. Bottles first: it is the commonest by far. */
export type BarUnit = 'bottle' | 'case' | 'shot' | 'cl' | 'ml' | 'l' | 'each' | 'pack' | 'g' | 'kg';

/**
 * The order units are walked in.
 *
 * Not alphabetical. Somebody counting a bar counts the bottles on the shelf,
 * then the crates in the store, then measures what is open — and a sheet that
 * makes them switch units every third line is a sheet that gets estimated
 * rather than counted.
 */
export const UNIT_ORDER: BarUnit[] = ['bottle', 'case', 'pack', 'each', 'l', 'ml', 'cl', 'shot', 'kg', 'g'];

export const UNIT_LABELS: Record<string, string> = {
  bottle: 'Bottles', case: 'Cases', pack: 'Packs', each: 'Each',
  l: 'Litres', ml: 'Millilitres', cl: 'Centilitres', shot: 'Measures',
  kg: 'Kilograms', g: 'Grams',
};

export const unitLabel = (unit?: string): string => UNIT_LABELS[unit ?? ''] ?? unit ?? 'Other';

/**
 * Which bottles a bartender counts at the start and end of a shift.
 *
 * Not everything. A bar counts its BOTTLED DRINKS twice a day — the beers and
 * the sodas, the things that leave whole and are quick to see — and its
 * spirits far less often, because a shelf of forty open bottles measured by
 * eye at two in the morning produces numbers nobody believes.
 *
 * Marked per item by an admin, and the rule is deliberately "if nobody has
 * marked anything, count everything". A bar that has not thought about this
 * keeps exactly the behaviour it had; the moment one item is ticked, the shift
 * count narrows to what was ticked. The alternative — an opt-in that starts
 * empty — silently turns the count off for every bar that upgrades.
 */
/**
 * Anything with a shelf to walk.
 *
 * "Never counted" means there is no shelf: the thing is used up in the buying
 * — a bag of ice, a box of straws, a cleaning spray — and asking somebody to
 * find it and count it is asking a question with no answer.
 *
 * Applied BEFORE anything else narrows a sheet, and this is the fix for a real
 * report: a store room's sheet had no cadence filter at all, so everything
 * marked never counted turned up on it; and on the bar's own sheet the
 * "nobody has chosen, so count everything" fallback in shiftCounted swept them
 * straight back in. Two different routes to the same wrong list, which is why
 * the rule now sits on its own rather than inside either of them.
 *
 * Absent means yes, because every row written before the setting existed was
 * counted, and reading a missing value as "never" would empty every sheet in
 * the building at once.
 */
export function countable<T extends { counted_at_close?: boolean }>(rows: T[]): T[] {
  return rows.filter((r) => r.counted_at_close !== false);
}

export function shiftCounted<T extends { count_each_shift?: boolean }>(rows: T[]): T[] {
  const chosen = rows.filter((r) => r.count_each_shift);
  return chosen.length > 0 ? chosen : rows;
}

/** Has anybody actually chosen, or is this the "count everything" fallback? */
export const hasShiftCountChoice = (rows: { count_each_shift?: boolean }[]): boolean =>
  rows.some((r) => r.count_each_shift);

/**
 * What a shelf the SYSTEM creates should be set to count as.
 *
 * Whatever the rest of that bar already does, and this is not a nicety.
 *
 * `shiftCounted` above means "if anybody has ticked anything, count only what
 * was ticked". A bar that has ticked nothing is counted in full through the
 * fallback — which is how most bars run, because nobody ever visits that
 * setting. Create ONE shelf ticked in a bar like that and the fallback stops
 * applying: the ticked shelf is now the whole sheet, and every bottle the bar
 * has counted for months silently drops off it.
 *
 * That is exactly what happened. Giving each drink size its own shelf created
 * them ticked, and the next closing count asked about the new sizes and
 * nothing else. Nothing failed, nothing was deleted, and the sheet was empty
 * of everything that mattered.
 *
 * So a shelf nobody asked for follows the room it is joining. Pass the
 * ingredients that already exist WITHOUT the ones being created, or the answer
 * is whatever the last run of this decided.
 */
export const newShelfCadence = (existing: { count_each_shift?: boolean }[]): boolean =>
  hasShiftCountChoice(existing);

/**
 * Which sides count their stock at BOTH ends of a shift.
 *
 * The kitchen counts once, at the end. Nobody accepts the rice at four in the
 * afternoon and nobody signs for it, so an opening count there would be a
 * question with no purpose.
 *
 * A bar is the other thing entirely. What is behind the bar is handed from one
 * person to the next, and a handover with only one count in it is not a
 * handover — it is a single number that the next person is stuck with. So the
 * bar is asked twice: what did you accept, and what are you handing over.
 *
 * THE SHOP IS THE SAME KIND OF PLACE. A shelf of pieces is handed over in
 * exactly the way a bar's bottles are, and it is more exposed rather than
 * less: a woven basket walks out of a shop far more easily than a bottle
 * walks out from behind a bar, and it is worth more. The shop counted only
 * when somebody chose to, from a screen in the office, which meant a piece
 * that went missing had a week of shifts to have gone missing on and no way
 * to say whose.
 *
 * What the two sides count is not the same thing — the bar counts bottles by
 * volume off its own shelves, the shop counts whole pieces that belong to
 * makers — so they have their own sheets. This says only that both are asked
 * twice.
 *
 * A function rather than a comparison spelled out at each call site, because
 * "does this side count at open" is asked from the till, from the close, and
 * from the sheet itself, and three copies of `module === 'bar'` is three places
 * to forget when a fourth trade arrives.
 */
export const countsAtBothEnds = (module?: string): boolean =>
  (module ?? 'kitchen') === 'bar' || (module ?? 'kitchen') === 'craft';

/**
 * Should somebody be asked to count this shift IN?
 *
 * Three conditions, and the third is the one that was missing.
 *
 * It has to be a side that counts in at all, and it has to not have been
 * counted already — both obvious. The third is that the shift must still be
 * able to sell something.
 *
 * A shift open past its limit is finished whether or not anybody has closed
 * it: nothing new can be rung up on it, so counting in what it started with
 * measures a handover that is not going to happen. The morning this was
 * written, a craft shift left open overnight put a 168-piece count sheet in
 * front of the first person to touch the till — who was a bartender, whose
 * shift it was not, and whose only useful action was to close it. A task that
 * cannot help is worse than none: it teaches people that the sheet is
 * something to get past.
 *
 * `counted` is deliberately allowed to be undefined, meaning "not looked yet".
 * Reading that as "nobody counted" would accuse somebody for the second it
 * takes to find out.
 */
export function askForOpeningCount(opts: {
  countsIn: boolean;
  counted: boolean | undefined;
  /** Whether the shift can still take new business. See shiftAgeOf. */
  canStillSell: boolean;
}): boolean {
  if (!opts.countsIn) return false;
  if (opts.counted !== false) return false;
  return opts.canStillSell;
}

export interface BarCountLine {
  ingredientId: string;
  name: string;
  unit: string;
  /** What the shelf should hold, before anything is typed. */
  expected: number;
  /** What was typed. Blank means not counted, which is not the same as none. */
  countedText?: string;
  /** What one unit costs, so a variance can be given a value. */
  unitCost: number;
  note?: string;
}

export interface BarCountGroup {
  unit: string;
  label: string;
  lines: BarCountLine[];
  counted: number;
  total: number;
}

/**
 * Grouped by what it is measured in, in the order a bar is walked.
 *
 * Units the list does not know about go last under their own heading rather
 * than being dropped: an ingredient measured in something unexpected is still
 * a thing on a shelf, and leaving it off the sheet is how it stops being
 * counted at all.
 */
export function byUnit(lines: BarCountLine[]): BarCountGroup[] {
  const buckets = new Map<string, BarCountLine[]>();
  for (const l of lines) {
    const at = buckets.get(l.unit);
    if (at) at.push(l);
    else buckets.set(l.unit, [l]);
  }

  return [...buckets.entries()]
    .map(([unit, group]) => ({
      unit,
      label: unitLabel(unit),
      lines: [...group].sort((a, b) => a.name.localeCompare(b.name)),
      counted: group.filter(wasCountedBar).length,
      total: group.length,
    }))
    .sort((a, b) => {
      const ai = UNIT_ORDER.indexOf(a.unit as BarUnit);
      const bi = UNIT_ORDER.indexOf(b.unit as BarUnit);
      // Anything unrecognised sorts after everything known, then by name.
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.label.localeCompare(b.label);
    });
}

/**
 * Was a number actually entered?
 *
 * Blank is not nought, the same rule the shop's count follows and for the same
 * reason: a sheet half worked through would otherwise write off everything
 * nobody reached. A bar makes this worse, not better — the count happens at
 * the end of a long night, and the last thing anybody should be able to do by
 * walking away is empty the store.
 */
export function wasCountedBar(line: BarCountLine): boolean {
  const text = (line.countedText ?? '').trim();
  if (text === '') return false;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0;
}

export interface BarVariance {
  line: BarCountLine;
  counted: number;
  /** Negative when short. Fractional units are real: half a bottle is half. */
  delta: number;
  /** What the difference is worth, always positive. */
  value: number;
}

export function variancesIn(lines: BarCountLine[]): BarVariance[] {
  const out: BarVariance[] = [];
  for (const line of lines) {
    if (!wasCountedBar(line)) continue;
    const counted = Number((line.countedText ?? '').trim());
    // Rounded to three places before comparing. Pour sizes divide badly —
    // a 700ml bottle at 25ml a measure leaves a repeating remainder — and a
    // variance of 0.0000000001 of a bottle is arithmetic, not a missing drink.
    const delta = Math.round((counted - line.expected) * 1000) / 1000;
    if (delta === 0) continue;
    out.push({ line, counted, delta, value: Math.round(Math.abs(delta) * line.unitCost) });
  }
  return out;
}

export interface BarCountSummary {
  countedLines: number;
  uncountedLines: number;
  variances: BarVariance[];
  /** Short, and what being short is worth. */
  shortValue: number;
  overValue: number;
  /** The worst few, for a message an admin reads rather than a table. */
  worst: BarVariance[];
}

export function summariseBarCount(lines: BarCountLine[]): BarCountSummary {
  const variances = variancesIn(lines);
  return {
    countedLines: lines.filter(wasCountedBar).length,
    uncountedLines: lines.filter((l) => !wasCountedBar(l)).length,
    variances,
    shortValue: variances.filter((v) => v.delta < 0).reduce((s, v) => s + v.value, 0),
    overValue: variances.filter((v) => v.delta > 0).reduce((s, v) => s + v.value, 0),
    worst: [...variances].sort((a, b) => b.value - a.value).slice(0, 5),
  };
}

/**
 * How much of a difference is worth stopping a shift for.
 *
 * A bar never counts exactly. Measures are eyeballed, a bottle drips, a
 * customer is given a taste — so a threshold that fires on any difference at
 * all fires every night, and a warning that fires every night is one people
 * clear without reading. This is set high enough that it means something.
 */
export const BAR_VARIANCE_TOLERANCE = 5_000;

export interface CloseCheck {
  /** True when the shift may close without anybody being asked anything. */
  clear: boolean;
  /** Set when the difference is big enough that an admin should see it first. */
  reason?: string;
  /** Lines with nothing typed against them, which stop a close on their own. */
  missing: number;
}

/**
 * Whether a bar shift is ready to close, and what to say when it is not.
 *
 * Two different gates, and only one of them is about money.
 *
 * A count with lines left blank is not a count. Closing on one would file a
 * night as counted when nobody looked at half the shelf, and the shortage
 * would surface later against whoever was on next.
 *
 * A count that IS complete but far out is a different thing: it is finished
 * work that somebody senior should see before the night is signed off, because
 * by tomorrow the person who could explain it has gone home. Not a refusal —
 * see `clear` — but a reason to put it in front of an admin first.
 */
export function readyToClose(lines: BarCountLine[], tolerance = BAR_VARIANCE_TOLERANCE): CloseCheck {
  const summary = summariseBarCount(lines);

  if (summary.uncountedLines > 0) {
    return {
      clear: false,
      missing: summary.uncountedLines,
      reason: `${summary.uncountedLines} line${summary.uncountedLines === 1 ? '' : 's'} `
        + 'still to count. Blank is not nought, so nothing is recorded for those.',
    };
  }

  if (summary.shortValue > tolerance) {
    const worst = summary.worst.filter((v) => v.delta < 0).slice(0, 3);
    return {
      clear: false,
      missing: 0,
      reason: `The bar is short by more than expected: ${worst.map((v) => v.line.name).join(', ')}`
        + `${worst.length < summary.variances.filter((v) => v.delta < 0).length ? ' and others' : ''}. `
        + 'An admin needs to see this before the shift closes.',
    };
  }

  return { clear: true, missing: 0 };
}

/**
 * Whether the bar has been counted IN, and what to say when it has not.
 *
 * One gate here, not two, and the difference from `readyToClose` is the whole
 * point of counting at the start.
 *
 * A shortage found at the beginning of a shift is not this shift's shortage.
 * It is the thing they are declining to sign for — the delivery nobody booked
 * in, the bottle taken for a function, last night's count rushed at two in the
 * morning. So there is no value threshold to breach and nothing to escalate to
 * an admin: whatever the number is, writing it down is the correct outcome,
 * and refusing the count because it is large would leave the bar accepted on
 * figures nobody checked.
 *
 * What does matter is blanks. An opening count with gaps in it is worse than
 * no opening count at all, because it looks like one — the lines nobody
 * reached keep last night's figure and quietly become this shift's problem.
 */
export function readyToAccept(lines: BarCountLine[]): CloseCheck {
  const missing = lines.filter((l) => !wasCountedBar(l)).length;
  if (missing === 0) return { clear: true, missing: 0 };
  return {
    clear: false,
    missing,
    reason: `${missing} line${missing === 1 ? '' : 's'} still to count. Blank is not nought — anything left `
      + 'empty keeps last night\'s figure and becomes yours.',
  };
}

export interface CountGate {
  /** Whether walking away without counting is offered at all. */
  maySkip: boolean;
  /** Whether the count, as it stands, may be filed. */
  maySave: boolean;
  /** What to say to somebody who can do neither yet. */
  reason?: string;
}

/**
 * Whether somebody may leave this count, and whether they may file it.
 *
 * The default is that they may not leave it. A count that can be waved past
 * gets waved past on exactly the nights it would have caught something — the
 * busy ones, the short-handed ones, the ones after a delivery nobody booked
 * in. Every shortage then has two shifts it could belong to and no way to
 * choose between them, which is the same as having no count at all while
 * costing the time of one.
 *
 * An admin can turn skipping back on, and there are real bars that need it: a
 * long list, a shelf that cannot be walked before the doors open, a night with
 * one person on. That is a decision for whoever reads the variances, not for
 * whoever happens to be standing at the till when it is inconvenient.
 *
 * Two things override the setting in the other direction, because insisting on
 * them would trap somebody at a screen they cannot satisfy:
 *
 *   - A sheet with nothing on it. A bar whose bottles have not been set up
 *     cannot count them, and holding the till over an empty list would make
 *     the first evening after switching this on impossible.
 *   - A sheet that failed to load. A count cannot be insisted upon when the
 *     system could not say what there is to count.
 */
export function countGate(opts: {
  lines: BarCountLine[];
  phase: 'open' | 'close';
  /** An admin has allowed counts to be left unfinished. Off unless set. */
  skippable?: boolean;
  /** The sheet could not be read, so there is nothing to insist on. */
  loadFailed?: boolean;
}): CountGate {
  const { lines, phase, skippable = false, loadFailed = false } = opts;

  if (loadFailed || lines.length === 0) return { maySkip: true, maySave: lines.length > 0 };

  const check = phase === 'open' ? readyToAccept(lines) : readyToClose(lines);
  const counted = lines.filter(wasCountedBar).length;

  if (skippable) {
    // Leaving is allowed, so filing a partial count is the lesser evil: what
    // was counted is worth keeping, and the blanks are reported as blanks.
    return { maySkip: true, maySave: counted > 0, reason: check.clear ? undefined : check.reason };
  }

  /*
    Nothing left blank — and nothing else.

    The value threshold inside `readyToClose` is deliberately NOT a bar to
    saving here. A shift that is genuinely short must still be able to file the
    count that says so; refusing it would leave typing numbers that balance as
    the only way off the screen, which is the one outcome worse than no count.
  */
  return {
    maySkip: false,
    maySave: check.missing === 0,
    reason: check.missing === 0 ? undefined : check.reason,
  };
}

/* ------------------------------------------------- counts already filed */

export interface FiledCheck {
  $id: string;
  $createdAt?: string;
  shift_id?: string;
  ingredient_id: string;
  phase?: 'open' | 'close';
  counted_qty?: number;
  theoretical_qty?: number;
  variance_qty?: number;
  variance_value?: number;
  checked_by?: string;
  undone_at?: string | null;
  undone_by?: string | null;
  /**
   * Whether this line has moved the shelf. False while it waits for an admin.
   * Absent on rows from before approval existed, which had already moved it.
   */
  applied?: boolean | null;
  approved_by?: string | null;
  approved_at?: string | null;
  rejected_by?: string | null;
  rejected_at?: string | null;
}

/* ------------------------------------------------- held until agreed */

/**
 * Whether a counted line may move the shelf on its own.
 *
 * A count that found exactly what was expected changes nothing, and holding
 * it would be a queue of approvals that approve nothing. A count that found a
 * difference is a claim that stock is missing or has appeared, and that claim
 * moves real figures — so it waits for somebody who can see the whole
 * business to agree with it.
 */
export const movesOnItsOwn = (variance: number): boolean => variance === 0;

/** Still waiting for an admin. */
export const isPending = (line: Pick<FiledCheck, 'applied' | 'rejected_at'>): boolean =>
  line.applied === false && !line.rejected_at;

/** Looked at and refused. The shelf was never moved. */
export const isRejected = (line: Pick<FiledCheck, 'rejected_at'>): boolean => !!line.rejected_at;

/**
 * Has this line actually moved the shelf?
 *
 * Absent is yes: every row written before approval existed moved the shelf
 * the moment it was filed, and reading those as unapplied would offer to
 * apply a year of old counts a second time.
 */
export const hasMoved = (line: Pick<FiledCheck, 'applied' | 'rejected_at'>): boolean =>
  line.applied !== false && !line.rejected_at;

export type CountState = 'pending' | 'applied' | 'rejected' | 'undone' | 'unchanged';

/** A prefix that marks a store-room count, which belongs to no shift. */
export const STORE_COUNT_PREFIX = 'store:';
export const storeCountId = (locationId: string): string => `${STORE_COUNT_PREFIX}${locationId}`;
export const isStoreCount = (shiftId: string): boolean => shiftId.startsWith(STORE_COUNT_PREFIX);

export interface FiledCount {
  /** What identifies this count: one shift, one end of it. */
  shiftId: string;
  phase: 'open' | 'close';
  /** When it was filed, taken from the earliest row in it. */
  at: string;
  lines: FiledCheck[];
  /** What the differences in it are worth, in money. */
  worth: number;
  /** Lines whose number differed from what was expected. */
  changed: number;
  /** Lines still waiting for an admin before they move anything. */
  pending: number;
  undoneAt?: string;
  undoneBy?: string;
  countedBy?: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectedBy?: string;
  rejectedAt?: string;
}

/**
 * Where a count stands, as one word.
 *
 * The order of the checks is the order of what matters: a count taken back
 * was applied first, and a count refused never moved anything, whatever else
 * is on its rows.
 */
export function countState(count: FiledCount): CountState {
  if (count.undoneAt) return 'undone';
  if (count.rejectedAt) return 'rejected';
  if (count.pending > 0) return 'pending';
  if (count.changed === 0) return 'unchanged';
  return 'applied';
}

export const countStateLabel = (state: CountState): string =>
  state === 'pending' ? 'Waiting for approval'
    : state === 'applied' ? 'Applied'
      : state === 'rejected' ? 'Refused'
        : state === 'undone' ? 'Taken back'
          : 'Nothing to apply';

/**
 * The counts already filed, newest first.
 *
 * A count is one shift and one end of it — the person coming on accepting the
 * bar, or the person going off handing it over. Those are two different
 * statements about the same shelf and must never be merged, which is why the
 * phase is half the key rather than a column on the row.
 *
 * Grouped here rather than queried that way because the rows do not carry a
 * count id: they are written one per bottle, in a loop, and what makes them
 * one count is only that they name the same shift and the same end of it.
 */
export function filedCounts(rows: FiledCheck[]): FiledCount[] {
  const groups = new Map<string, FiledCount>();

  for (const r of rows) {
    const phase = r.phase ?? 'close';
    const key = `${r.shift_id ?? ''}|${phase}`;
    const at = r.$createdAt ?? '';
    const group = groups.get(key) ?? {
      shiftId: r.shift_id ?? '',
      phase,
      at,
      lines: [],
      worth: 0,
      changed: 0,
      pending: 0,
      undoneAt: r.undone_at ?? undefined,
      countedBy: r.checked_by ?? undefined,
    };
    group.lines.push(r);
    if ((r.variance_qty ?? 0) !== 0) {
      group.changed += 1;
      group.worth += Math.abs(r.variance_value ?? 0);
    }
    if (isPending(r)) group.pending += 1;
    // The earliest row is when the count was filed; they are written in a loop
    // and the last one is only when the loop finished.
    if (at && (!group.at || at < group.at)) group.at = at;
    // One line taken back takes the count with it — they are undone together.
    if (r.undone_at) { group.undoneAt = r.undone_at; group.undoneBy = r.undone_by ?? group.undoneBy; }
    if (r.approved_at) { group.approvedAt = r.approved_at; group.approvedBy = r.approved_by ?? group.approvedBy; }
    if (r.rejected_at) { group.rejectedAt = r.rejected_at; group.rejectedBy = r.rejected_by ?? group.rejectedBy; }
    if (!group.countedBy && r.checked_by) group.countedBy = r.checked_by;
    groups.set(key, group);
  }

  return [...groups.values()].sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * What putting a count back is worth doing to each shelf.
 *
 * THE OPPOSITE DELTA, never the old absolute figure. A count moved the shelf
 * by the difference between what was expected and what was found; undoing it
 * moves the shelf back by that same difference.
 *
 * Setting the shelf to what it held before the count would be wrong by
 * everything that has happened since — the drinks poured in the hours between
 * the count and somebody noticing it was wrong. Those sales are real and their
 * movements are already recorded; an undo that erased them would fix one
 * mistake by making a second, larger one.
 *
 * Lines that found exactly what was expected moved nothing and need nothing.
 */
export function undoDeltas(count: FiledCount): { ingredientId: string; delta: number }[] {
  return count.lines
    // Only what actually moved the shelf. A line still waiting, or one that
    // was refused, moved nothing and there is nothing to put back.
    .filter((l) => (l.variance_qty ?? 0) !== 0 && hasMoved(l))
    .map((l) => ({ ingredientId: l.ingredient_id, delta: -(l.variance_qty ?? 0) }));
}

/**
 * What approving a count does to each shelf.
 *
 * THE DELTA, never the counted figure. The count was taken hours ago and the
 * shelf has been sold from since; setting it to the counted number now would
 * erase every sale in between. Applying the difference the count found leaves
 * those sales exactly where they are. The same reasoning as undoDeltas, in the
 * other direction.
 */
export function approveDeltas(count: FiledCount): { checkId: string; ingredientId: string; delta: number }[] {
  return count.lines
    .filter((l) => isPending(l) && (l.variance_qty ?? 0) !== 0)
    .map((l) => ({ checkId: l.$id, ingredientId: l.ingredient_id, delta: l.variance_qty ?? 0 }));
}

/** What to tell whoever just filed a count that is now waiting. */
export function heldWords(pending: number, format: (n: number) => string, worth: number): string | null {
  if (pending <= 0) return null;
  return `${pending} ${pending === 1 ? 'line' : 'lines'} found a difference (${format(worth)}) and ${pending === 1 ? 'is' : 'are'} `
    + 'waiting for an admin to agree before the stock figures move. Everything that matched has been recorded '
    + 'as counted.';
}

/** Why this count cannot be taken back, or nothing. */
export function undoProblem(count: FiledCount | null | undefined): string | null {
  if (count && count.pending > 0) {
    return 'This count is still waiting for approval, so it has not moved anything yet. Refuse it instead.';
  }
  if (count && count.rejectedAt) return 'This count was refused, so it never moved the shelf.';
  if (!count) return 'That count could not be found.';
  if (count.undoneAt) return 'That count has already been taken back.';
  if (count.changed === 0) return 'That count found exactly what was expected, so there is nothing to put back.';
  return null;
}

/* ------------------------------------------------ what actually sold */

export interface SoldLine {
  name: string;
  qty: number;
  worth: number;
}

/**
 * What went over the counter this shift, by the thing rather than by the sale.
 *
 * A shift's orders answer "what did each customer buy". Nobody asks that. The
 * questions a bar actually has at the end of a night are "how many Clubs went"
 * and "is that enough to explain the shelf", and both need the other cut: one
 * line per drink, added up, biggest first.
 *
 * It is also the other half of a count. A shelf four bottles down and a
 * summary showing four sold is a shelf that balances; the same shelf with two
 * sold is a conversation. Until now the two halves were on different screens
 * with nothing to hold them against each other.
 *
 * Voided lines are left out. A line struck off a bill sold nothing, and
 * counting it would put drinks on this list that are still on the shelf.
 *
 * The size is part of the name where there is one — a small and a large Club
 * are two different things going out of the door, and adding them together
 * would hide exactly the difference somebody is looking for.
 */
export function soldInShift<T extends {
  name_snapshot?: string;
  variant_label?: string;
  qty?: number;
  line_total?: number;
  status?: string;
}>(lines: T[]): SoldLine[] {
  const byName = new Map<string, SoldLine>();

  for (const l of lines) {
    if (l.status === 'void') continue;
    const base = (l.name_snapshot ?? '').trim() || 'Something no longer named';
    const name = l.variant_label?.trim() ? `${base} · ${l.variant_label.trim()}` : base;
    const at = byName.get(name) ?? { name, qty: 0, worth: 0 };
    at.qty += l.qty ?? 0;
    at.worth += l.line_total ?? 0;
    byName.set(name, at);
  }

  return [...byName.values()]
    .filter((l) => l.qty !== 0)
    .sort((a, b) => b.qty - a.qty || b.worth - a.worth || a.name.localeCompare(b.name));
}

/** How many drinks left the counter, and what they came to. */
export const soldTotals = (sold: SoldLine[]): { items: number; worth: number } => ({
  items: sold.reduce((n, l) => n + l.qty, 0),
  worth: sold.reduce((n, l) => n + l.worth, 0),
});

/* ------------------------------------------- who is allowed to count what */

/**
 * Something only a manager may count.
 *
 * The bar's twice-a-shift sheet is a bartender's: bottled drinks leave whole,
 * they are quick to see, and counting them is a handover. Spirits are not that
 * — forty open bottles judged by eye at two in the morning produce numbers
 * nobody believes — so they already sit off that sheet and wait for a proper
 * stocktake.
 *
 * What was missing is WHO does the stocktake. "Off the shift sheet" and "only
 * a manager may touch it" were one setting, so anything kept back from the
 * nightly count was equally open to anybody who opened the stocktake screen.
 * For the expensive end of a bar's stock that is the wrong way round: the
 * whole reason it is counted rarely is that the count is worth trusting, and a
 * count is worth trusting because of who made it.
 *
 * Absent is no. Every bottle on file was countable by whoever was doing the
 * counting, and reading silence as a restriction would empty the stocktake
 * sheet for every manager who is not an admin on the day this shipped.
 */
export const managerCountOnly = (row: { manager_count_only?: boolean }): boolean =>
  row.manager_count_only === true;

/**
 * The lines this person may actually put a number against.
 *
 * Applied after `countable`, never instead of it: "never counted" says there
 * is no shelf at all, which is true whoever is asking.
 *
 * A manager sees everything. Anybody else sees everything that is not held
 * back — and the held-back rows are left OFF their sheet rather than shown
 * greyed, because a sheet with rows nobody can fill is a sheet that reports
 * itself unfinished for ever and can never be sent.
 */
export function countableBy<T extends { manager_count_only?: boolean }>(
  rows: T[],
  isManager: boolean,
): T[] {
  return isManager ? rows : rows.filter((r) => !managerCountOnly(r));
}

/**
 * May this person count the bar itself with no shift open?
 *
 * A bar count is normally a handover — what one person accepted and what they
 * handed over — which is why it belongs to a shift and why the screen asked
 * for one. That reasoning holds for a bartender and not for a manager: a spot
 * check outside service is a stocktake, not a handover, and refusing it meant
 * the only way to check the bar was to open a shift nobody was going to trade
 * on, which puts a false shift in the books to answer a question about stock.
 *
 * A store room never needed a shift and still does not; it belongs to no
 * evening in the first place.
 */
export function mayCountWithoutShift(opts: {
  isStore: boolean;
  isManager: boolean;
  hasShift: boolean;
}): boolean {
  if (opts.isStore) return true;
  if (opts.hasShift) return true;
  return opts.isManager;
}
