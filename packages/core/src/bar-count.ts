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
export function shiftCounted<T extends { count_each_shift?: boolean }>(rows: T[]): T[] {
  const chosen = rows.filter((r) => r.count_each_shift);
  return chosen.length > 0 ? chosen : rows;
}

/** Has anybody actually chosen, or is this the "count everything" fallback? */
export const hasShiftCountChoice = (rows: { count_each_shift?: boolean }[]): boolean =>
  rows.some((r) => r.count_each_shift);

/**
 * Which sides count their shelves at BOTH ends of a shift.
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
 * A function rather than a comparison spelled out at each call site, because
 * "does this side count at open" is asked from the till, from the close, and
 * from the sheet itself, and three copies of `module === 'bar'` is three places
 * to forget when a fourth trade arrives.
 */
export const countsAtBothEnds = (module?: string): boolean => (module ?? 'kitchen') === 'bar';

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
