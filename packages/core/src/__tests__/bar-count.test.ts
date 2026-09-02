import test from 'node:test';
import assert from 'node:assert/strict';
import {
  byUnit, wasCountedBar, variancesIn, summariseBarCount, readyToClose, unitLabel,
  BAR_VARIANCE_TOLERANCE, type BarCountLine,
  shiftCounted, hasShiftCountChoice, countsAtBothEnds, askForOpeningCount, readyToAccept, countGate,
  countableBy, managerCountOnly, mayCountWithoutShift,
  countable, filedCounts, undoDeltas, undoProblem, soldInShift, soldTotals, newShelfCadence,
  type FiledCheck,
} from '../bar-count.ts';

const bottle = (over: Partial<BarCountLine> = {}): BarCountLine => ({
  ingredientId: 'i1', name: 'Gin', unit: 'bottle', expected: 6, unitCost: 12000, ...over,
});

test('the sheet is grouped in the order a bar is walked', () => {
  /**
   * Not alphabetical. Somebody counts the bottles on the shelf, then the
   * crates in the store, then measures what is open — and a sheet that makes
   * them switch units every third line is one that gets estimated rather than
   * counted.
   */
  const groups = byUnit([
    bottle({ unit: 'ml', name: 'Lime cordial' }),
    bottle({ unit: 'bottle', name: 'Gin' }),
    bottle({ unit: 'case', name: 'Club Beer' }),
    bottle({ unit: 'bottle', name: 'Aperol' }),
  ]);

  assert.deepEqual(groups.map((g) => g.unit), ['bottle', 'case', 'ml']);
  // Alphabetical WITHIN a group, which is how somebody finds a line.
  assert.deepEqual(groups[0].lines.map((l) => l.name), ['Aperol', 'Gin']);
  assert.equal(groups[0].total, 2);
});

test('a unit nobody planned for still gets counted', () => {
  // An ingredient measured in something unexpected is still a thing on a
  // shelf, and leaving it off the sheet is how it stops being counted at all.
  const groups = byUnit([bottle({ unit: 'keg', name: 'Draught' }), bottle()]);
  assert.deepEqual(groups.map((g) => g.unit), ['bottle', 'keg'], 'the unknown one goes last');
  assert.equal(unitLabel('keg'), 'keg');
  assert.equal(unitLabel('bottle'), 'Bottles');
});

test('blank is not nought, at the end of a long night especially', () => {
  /**
   * The count happens when everybody is tired and wants to go home. The last
   * thing anybody should be able to do by walking away is empty the store.
   */
  assert.equal(wasCountedBar(bottle()), false);
  assert.equal(wasCountedBar(bottle({ countedText: '  ' })), false);
  assert.equal(wasCountedBar(bottle({ countedText: 'x' })), false);
  assert.equal(wasCountedBar(bottle({ countedText: '-1' })), false);
  assert.equal(wasCountedBar(bottle({ countedText: '0' })), true, 'nought, typed, means empty');

  assert.deepEqual(variancesIn([bottle()]), [], 'nothing typed writes nothing');
});

test('a variance is measured in units and valued in money', () => {
  const found = variancesIn([bottle({ countedText: '4' })]);
  assert.equal(found[0].delta, -2);
  assert.equal(found[0].value, 24000, 'two bottles at 120.00');

  // Half a bottle is half a bottle: a bar measures in fractions and rounding
  // that to whole units would report every open bottle as a discrepancy.
  const half = variancesIn([bottle({ expected: 6, countedText: '5.5' })]);
  assert.equal(half[0].delta, -0.5);
  assert.equal(half[0].value, 6000);
});

test('a repeating remainder is arithmetic, not a missing drink', () => {
  /**
   * Pour sizes divide badly — a 700ml bottle at 25ml a measure leaves a
   * remainder that recurs in binary — and a variance of a billionth of a bottle
   * would put a red line on a sheet every single night.
   */
  const line = bottle({ expected: 0.1 + 0.2, countedText: '0.3' });
  assert.deepEqual(variancesIn([line]), [], '0.30000000000000004 counted as 0.3 is not a shortage');
});

test('the summary separates being short from being over', () => {
  const summary = summariseBarCount([
    bottle({ countedText: '4' }),                                        // 2 short
    bottle({ ingredientId: 'i2', name: 'Rum', countedText: '8' }),       // 2 over
    bottle({ ingredientId: 'i3', name: 'Tonic', unit: 'case' }),         // not counted
  ]);
  assert.equal(summary.countedLines, 2);
  assert.equal(summary.uncountedLines, 1);
  assert.equal(summary.shortValue, 24000);
  assert.equal(summary.overValue, 24000);
  // Dearest first, because that is the one an admin is asked about.
  assert.equal(summary.worst[0].value, 24000);
});

test('a half-counted sheet cannot close a shift', () => {
  /**
   * Closing on one would file a night as counted when nobody looked at half
   * the shelf, and the shortage would surface later against whoever was on
   * next — which is how a bar ends up with an argument instead of a figure.
   */
  const check = readyToClose([bottle({ countedText: '6' }), bottle({ ingredientId: 'i2' })]);
  assert.equal(check.clear, false);
  assert.equal(check.missing, 1);
  assert.match(check.reason ?? '', /still to count/);
});

test('a complete count that is badly short goes to an admin first', () => {
  const short = readyToClose([bottle({ countedText: '0' })]);   // 6 bottles, 720.00
  assert.equal(short.clear, false);
  assert.equal(short.missing, 0, 'the sheet is finished; the problem is the figure');
  assert.match(short.reason ?? '', /short by more than expected/);
  assert.match(short.reason ?? '', /Gin/);
});

test('a bar that counts true, or nearly, just closes', () => {
  /**
   * A bar never counts exactly: measures are eyeballed, a bottle drips, a
   * customer is given a taste. A threshold that fires on any difference fires
   * every night, and a warning that fires every night is one people clear
   * without reading.
   */
  assert.equal(readyToClose([bottle({ countedText: '6' })]).clear, true);

  const wobble = bottle({ expected: 6, countedText: '5.9', unitCost: 12000 }); // 1,200 short
  assert.ok(1200 < BAR_VARIANCE_TOLERANCE);
  assert.equal(readyToClose([wobble]).clear, true);

  // Being OVER never blocks a close. Finding more than expected is a
  // bookkeeping question, not money walking out of the building.
  assert.equal(readyToClose([bottle({ countedText: '60' })]).clear, true);
});

/* ------------------------------- which bottles a shift actually counts */

test('a bar that has marked nothing keeps counting everything', () => {
  // The alternative — an opt-in starting empty — silently turns the shift
  // count off for every bar that upgrades.
  const rows: { name: string; count_each_shift?: boolean }[] = [{ name: 'Club' }, { name: 'Havana' }];
  assert.equal(shiftCounted(rows).length, 2);
  assert.equal(hasShiftCountChoice(rows), false);
});

test('once anything is marked, the shift count is only what was marked', () => {
  const rows = [
    { name: 'Club', count_each_shift: true },
    { name: 'Guinness', count_each_shift: true },
    { name: 'Havana Club Bottle' },
    { name: 'Smirnoff Bottle', count_each_shift: false },
  ];
  assert.deepEqual(shiftCounted(rows).map((r) => r.name), ['Club', 'Guinness']);
  assert.equal(hasShiftCountChoice(rows), true);
});

test('an explicit no is not the same as never having said', () => {
  // Everything ticked off deliberately still means "count everything", because
  // a bar with nothing on its shift list has not opted out of counting — it
  // has just cleared the list.
  const rows = [{ name: 'Club', count_each_shift: false }];
  assert.equal(shiftCounted(rows).length, 1);
  assert.equal(hasShiftCountChoice(rows), false);
});

test('the bar and the shop count at both ends of a shift; the kitchen does not', () => {
  /**
   * The kitchen counts once, at the end: nobody accepts the rice at four in
   * the afternoon and nobody signs for it, so an opening count there would be
   * a question with no purpose.
   *
   * A bar's bottles are handed from one person to the next, and a handover
   * with only one count in it is a number the next person is stuck with.
   *
   * THE SHOP IS THE SAME KIND OF PLACE, and was left out. Its counts happened
   * only when somebody chose to, from a screen in the office — so a piece that
   * went missing had a week of shifts to have gone missing on and no way to
   * say whose. A woven basket walks out of a shop more easily than a bottle
   * walks out from behind a bar, and is worth more.
   */
  assert.equal(countsAtBothEnds('bar'), true);
  assert.equal(countsAtBothEnds('craft'), true);
  assert.equal(countsAtBothEnds('kitchen'), false);
  // An older row with no side on it is the kitchen, the same fallback the
  // rest of the system uses. Defaulting the other way would start asking
  // every restaurant for an opening count it never agreed to.
  assert.equal(countsAtBothEnds(undefined), false);
});

test('counting in is held up by blanks and by nothing else', () => {
  /**
   * A shortage found at the START is not this shift's shortage — it is what
   * they are declining to sign for. So however big it is, writing it down is
   * the right outcome, and there is nothing to escalate.
   */
  const huge = [
    bottle({ ingredientId: 'a', name: 'Gin', expected: 40, countedText: '2' }),
    bottle({ ingredientId: 'b', name: 'Rum', expected: 40, countedText: '1' }),
  ];
  const check = readyToAccept(huge);
  assert.equal(check.clear, true, 'a big shortage at the start is a finding, not a refusal');
  assert.equal(check.missing, 0);

  // The same figures at the END do stop the close, which is the difference
  // between the two questions.
  assert.equal(readyToClose(huge).clear, false);
});

test('an opening count with gaps in it is refused', () => {
  // Worse than no count at all, because it looks like one: the lines nobody
  // reached keep last night's figure and quietly become this shift's problem.
  const check = readyToAccept([
    bottle({ ingredientId: 'a', countedText: '5' }),
    bottle({ ingredientId: 'b', name: 'Tonic', countedText: '' }),
    bottle({ ingredientId: 'c', name: 'Club', countedText: '  ' }),
  ]);
  assert.equal(check.clear, false);
  assert.equal(check.missing, 2);
  assert.match(check.reason ?? '', /2 lines still to count/);
});

test('a counted nought is an answer; a blank one is not', () => {
  // The rule the whole file turns on, checked at the opening end too.
  assert.equal(readyToAccept([bottle({ countedText: '0' })]).clear, true);
  assert.equal(readyToAccept([bottle({ countedText: '' })]).clear, false);
});

test('a count cannot be walked away from unless an admin has said so', () => {
  /**
   * The default. A count that can be waved past is waved past on exactly the
   * nights it would have caught something, and a shortage with two shifts to
   * belong to belongs to neither.
   */
  const half = [
    bottle({ ingredientId: 'a', countedText: '5' }),
    bottle({ ingredientId: 'b', name: 'Tonic', countedText: '' }),
  ];
  const shut = countGate({ lines: half, phase: 'open' });
  assert.equal(shut.maySkip, false, 'no way out while lines are blank');
  assert.equal(shut.maySave, false, 'and no way to file a half-finished sheet');
  assert.match(shut.reason ?? '', /1 line still to count/);

  // Answered in full, and the way forward opens.
  const whole = half.map((l) => ({ ...l, countedText: '4' }));
  assert.deepEqual(countGate({ lines: whole, phase: 'open' }), { maySkip: false, maySave: true, reason: undefined });
});

test('an admin can hand back the way out, and a part count with it', () => {
  const half = [
    bottle({ ingredientId: 'a', countedText: '5' }),
    bottle({ ingredientId: 'b', name: 'Tonic', countedText: '' }),
  ];
  const open = countGate({ lines: half, phase: 'open', skippable: true });
  assert.equal(open.maySkip, true);
  // What WAS counted is still worth keeping; the blanks are reported as blanks.
  assert.equal(open.maySave, true);
  assert.match(open.reason ?? '', /still to count/);

  // Nothing counted at all is not a count, whatever the setting says.
  const none = half.map((l) => ({ ...l, countedText: '' }));
  assert.equal(countGate({ lines: none, phase: 'close', skippable: true }).maySave, false);
});

test('a shift that is genuinely short can still file the count that says so', () => {
  /**
   * The value threshold in readyToClose warns; it must never be a bar to
   * saving. Refusing the count would leave typing numbers that balance as the
   * only way off the screen, which is the one outcome worse than no count.
   */
  const short = [bottle({ expected: 40, countedText: '2' })];
  assert.equal(readyToClose(short).clear, false, 'it is well over tolerance');
  assert.equal(countGate({ lines: short, phase: 'close' }).maySave, true);
});

test('nobody is locked out over a count the system cannot describe', () => {
  // A bar whose bottles are not set up yet, and a sheet that would not load.
  // Insisting on either would brick the till with a door that cannot be walked
  // through and cannot be walked away from.
  assert.deepEqual(countGate({ lines: [], phase: 'open' }), { maySkip: true, maySave: false });
  const failed = countGate({ lines: [], phase: 'close', loadFailed: true });
  assert.equal(failed.maySkip, true);
});

test('never counted is off every sheet, whatever else is true of it', () => {
  /*
    "Never counted" means there is no shelf to walk — a bag of ice, a box of
    straws, used up in the buying. Asking somebody to find and count one is a
    question with no answer, and a sheet full of those is a sheet people learn
    to tap through, which costs the count on the things that matter.
  */
  const rows = [
    { $id: 'gin', counted_at_close: true },
    { $id: 'ice', counted_at_close: false },
    { $id: 'rum' },
  ];
  assert.deepEqual(countable(rows).map((r) => r.$id), ['gin', 'rum']);
});

test('a row written before the setting existed is still counted', () => {
  // Reading a missing value as "never" would empty every sheet in the
  // building at once, on the first load after the column appeared.
  assert.equal(countable([{ $id: 'a', counted_at_close: undefined }]).length, 1);
});

test('the count-everything fallback cannot sweep a never-counted item back in', () => {
  /*
    The bug this pair exists for. shiftCounted means "if anybody ticked
    anything, count only what was ticked" — and if nobody has, count
    everything. Run on its own over a list containing never-counted rows, that
    fallback puts them straight back on the sheet.

    Order matters: countable first, then the shift's narrowing.
  */
  const rows = [
    { $id: 'ice', counted_at_close: false, count_each_shift: false },
    { $id: 'rum', counted_at_close: true, count_each_shift: false },
  ];
  // Nobody has ticked anything, so shiftCounted alone returns both.
  assert.equal(shiftCounted(rows).length, 2);
  // Narrowed first, the ice is gone before the fallback ever sees it.
  assert.deepEqual(shiftCounted(countable(rows)).map((r) => r.$id), ['rum']);
});

/* ------------------------------------------------- counts already filed */

const check = (over: Partial<FiledCheck> & { $id: string; ingredient_id: string }): FiledCheck => ({
  theoretical_qty: 0, counted_qty: 0, variance_qty: 0, variance_value: 0, ...over,
});

test('counting in and counting out are two counts, not one', () => {
  /*
    The person coming on accepts the bar; the person going off hands it over.
    Two statements about the same shelf, and merging them would make the
    difference between them — the thing the whole system exists to produce —
    impossible to see.
  */
  const counts = filedCounts([
    check({ $id: 'a', ingredient_id: 'gin', shift_id: 's1', phase: 'open', $createdAt: '2026-08-24T06:00:00Z' }),
    check({ $id: 'b', ingredient_id: 'gin', shift_id: 's1', phase: 'close', $createdAt: '2026-08-24T23:00:00Z' }),
  ]);
  assert.equal(counts.length, 2);
  assert.deepEqual(counts.map((c) => c.phase), ['close', 'open']);
});

test('a count is filed when it started, not when the loop finished', () => {
  // The rows are written one per bottle in a loop, so the last one is only
  // when the writing ended. A count of forty takes a while.
  const counts = filedCounts([
    check({ $id: 'a', ingredient_id: 'gin', shift_id: 's1', phase: 'close', $createdAt: '2026-08-24T23:00:09Z' }),
    check({ $id: 'b', ingredient_id: 'rum', shift_id: 's1', phase: 'close', $createdAt: '2026-08-24T23:00:01Z' }),
  ]);
  assert.equal(counts[0].at, '2026-08-24T23:00:01Z');
});

test('what a count was worth counts only the lines that moved', () => {
  const counts = filedCounts([
    check({ $id: 'a', ingredient_id: 'gin', shift_id: 's1', phase: 'close', variance_qty: -2, variance_value: 4000 }),
    check({ $id: 'b', ingredient_id: 'rum', shift_id: 's1', phase: 'close', variance_qty: 0, variance_value: 0 }),
    check({ $id: 'c', ingredient_id: 'tonic', shift_id: 's1', phase: 'close', variance_qty: 3, variance_value: 900 }),
  ]);
  assert.equal(counts[0].changed, 2);
  // Absolute: a shelf two short and another three over is not one over.
  assert.equal(counts[0].worth, 4900);
});

test('undoing a count moves the shelf back by the difference, not to the old figure', () => {
  /*
    THE POINT OF THE WHOLE THING.

    Setting the shelf to what it held before the count would be wrong by
    everything poured since — real sales with real movements already recorded.
    An undo that erased those would fix one mistake by making a larger one.
  */
  const [count] = filedCounts([
    check({ $id: 'a', ingredient_id: 'gin', shift_id: 's1', phase: 'close', variance_qty: -2 }),
    check({ $id: 'b', ingredient_id: 'rum', shift_id: 's1', phase: 'close', variance_qty: 0 }),
    check({ $id: 'c', ingredient_id: 'tonic', shift_id: 's1', phase: 'close', variance_qty: 3 }),
  ]);
  assert.deepEqual(undoDeltas(count), [
    { ingredientId: 'gin', delta: 2 },
    { ingredientId: 'tonic', delta: -3 },
  ]);
});

test('a count is only taken back once', () => {
  const [count] = filedCounts([
    check({
      $id: 'a', ingredient_id: 'gin', shift_id: 's1', phase: 'close',
      variance_qty: -2, undone_at: '2026-08-25T09:00:00Z',
    }),
  ]);
  assert.match(undoProblem(count) ?? '', /already been taken back/);
});

test('a count that found what it expected has nothing to put back', () => {
  // Undoing it would write a movement of nought and mark a count as reversed
  // when nothing was ever corrected by it.
  const [count] = filedCounts([
    check({ $id: 'a', ingredient_id: 'gin', shift_id: 's1', phase: 'close', variance_qty: 0 }),
  ]);
  assert.match(undoProblem(count) ?? '', /nothing to put back/);
  assert.equal(undoProblem(null), 'That count could not be found.');
});

test('what sold is counted by the thing, not by the sale', () => {
  /*
    A shift's orders answer "what did each customer buy", which nobody asks.
    The question at the end of a night is "how many Clubs went", and it is the
    other half of a count: a shelf four down and four sold balances, the same
    shelf with two sold is a conversation.
  */
  const sold = soldInShift([
    { name_snapshot: 'Club', qty: 2, line_total: 5000 },
    { name_snapshot: 'Club', qty: 3, line_total: 7500 },
    { name_snapshot: 'Gin', qty: 1, line_total: 3000 },
  ]);
  assert.deepEqual(sold.map((s) => [s.name, s.qty, s.worth]), [
    ['Club', 5, 12500],
    ['Gin', 1, 3000],
  ]);
});

test('a size is its own line', () => {
  // A small and a large Club are two different things going out of the door,
  // and adding them together hides the difference somebody is looking for.
  const sold = soldInShift([
    { name_snapshot: 'Club', variant_label: 'Large', qty: 2, line_total: 6000 },
    { name_snapshot: 'Club', variant_label: 'Small', qty: 1, line_total: 2500 },
  ]);
  assert.deepEqual(sold.map((s) => s.name), ['Club · Large', 'Club · Small']);
});

test('a line struck off a bill sold nothing', () => {
  // It is still on the shelf. Counting it would put drinks on this list that
  // never left, and the count would then look short by exactly those.
  const sold = soldInShift([
    { name_snapshot: 'Club', qty: 2, line_total: 5000 },
    { name_snapshot: 'Gin', qty: 1, line_total: 3000, status: 'void' },
  ]);
  assert.deepEqual(sold.map((s) => s.name), ['Club']);
});

test('the busiest drink leads', () => {
  const sold = soldInShift([
    { name_snapshot: 'Gin', qty: 1, line_total: 9000 },
    { name_snapshot: 'Club', qty: 9, line_total: 22500 },
  ]);
  assert.equal(sold[0].name, 'Club');
  assert.deepEqual(soldTotals(sold), { items: 10, worth: 31500 });
});

test('a shelf the system creates does not flip a bar into narrow counting', () => {
  /*
    THE REGRESSION THIS EXISTS TO STOP, AND IT REACHED A LIVE BAR.

    shiftCounted means "if anybody ticked anything, count only what was
    ticked". A bar that has ticked nothing is counted in full through the
    fallback, which is how most bars run because nobody visits that setting.

    Creating one shelf ticked in a bar like that makes it the whole sheet.
    Giving each drink size its own shelf did precisely that, and the next
    closing count asked about the new sizes and nothing else.
  */
  const untouched = [{ count_each_shift: undefined }, { count_each_shift: undefined }];
  assert.equal(newShelfCadence(untouched), false);

  // And with that answer, everything is still on the sheet.
  const after = [...untouched, { count_each_shift: newShelfCadence(untouched) }];
  assert.equal(shiftCounted(after).length, 3);
});

test('a bar that has chosen keeps its choice, and the new shelf joins it', () => {
  // The other half: a house that ticked four bottles means those four, and a
  // size created afterwards belongs with them rather than reopening the sheet.
  const chosen = [{ count_each_shift: true }, { count_each_shift: false }];
  assert.equal(newShelfCadence(chosen), true);

  const after = [...chosen, { count_each_shift: newShelfCadence(chosen) }];
  assert.deepEqual(shiftCounted(after).map((r) => r.count_each_shift), [true, true]);
});

test('a shift that can no longer sell is not asked to count itself in', () => {
  /**
   * The morning this was written, a craft shift left open overnight put a
   * 168-piece count sheet in front of the first person to touch the till — a
   * bartender, whose shift it was not, and whose only useful action was to
   * close it.
   *
   * Counting IN measures what somebody is accepting responsibility for at the
   * start of a handover. A shift past its limit cannot ring anything up, so
   * there is no handover to measure, and the task cannot help. A task that
   * cannot help is worse than none: it teaches people that the sheet is
   * something to get past.
   */
  const asked = { countsIn: true, counted: false as boolean | undefined, canStillSell: true };
  assert.equal(askForOpeningCount(asked), true);
  assert.equal(askForOpeningCount({ ...asked, canStillSell: false }), false);
});

test('nothing is asked of a side that does not count in, or one already counted', () => {
  assert.equal(askForOpeningCount({ countsIn: false, counted: false, canStillSell: true }), false);
  assert.equal(askForOpeningCount({ countsIn: true, counted: true, canStillSell: true }), false);
});

test('not having looked yet is not an accusation', () => {
  /*
    `counted` starts undefined rather than false. Reading "we have not found
    out" as "nobody counted" would put the warning up, and the sheet in
    somebody's face, for the second it takes to read the answer.
  */
  assert.equal(askForOpeningCount({ countsIn: true, counted: undefined, canStillSell: true }), false);
});


test('spirits held back from the nightly sheet are held back from bartenders too', () => {
  /**
   * "Off the shift sheet" and "only a manager may touch it" were one setting,
   * so the expensive end of a bar's stock was equally open to anybody who
   * opened the stocktake screen. That is the wrong way round: the whole reason
   * a thing is counted rarely is that the count is meant to be worth trusting,
   * and a count is worth trusting because of who made it.
   */
  const rows = [
    { $id: 'club', name: 'Club' },
    { $id: 'gin', name: 'Gin', manager_count_only: true },
  ];
  assert.deepEqual(countableBy(rows, false).map((r) => r.$id), ['club']);
  assert.deepEqual(countableBy(rows, true).map((r) => r.$id), ['club', 'gin']);
});

test('a bottle on file before this existed is countable by anybody', () => {
  /*
    Reading silence as a restriction would empty the sheet for every manager
    who is not an admin — and for every bartender — on the day it shipped.
  */
  assert.equal(managerCountOnly({}), false);
  assert.equal(managerCountOnly({ manager_count_only: false }), false);
  assert.equal(managerCountOnly({ manager_count_only: true }), true);
  assert.deepEqual(countableBy([{ $id: 'a', manager_count_only: undefined }], false).map((r) => r.$id), ['a']);
});

test('a manager may spot-check the bar with no shift open', () => {
  /**
   * A bar count is normally a handover — what one person accepted and what
   * they handed over — which is why it belongs to a shift. That reasoning
   * holds for a bartender and not for a manager: a check outside service is a
   * stocktake, not a handover.
   *
   * Refusing it meant the only way to look at the bar was to open a shift
   * nobody was going to trade on, which puts a false evening in the books to
   * answer a question about stock.
   */
  assert.equal(mayCountWithoutShift({ isStore: false, isManager: true, hasShift: false }), true);
  assert.equal(mayCountWithoutShift({ isStore: false, isManager: false, hasShift: false }), false);

  // With a shift open, anybody counting the bar is doing the handover.
  assert.equal(mayCountWithoutShift({ isStore: false, isManager: false, hasShift: true }), true);

  // A store room belongs to no evening in the first place and never needed one.
  assert.equal(mayCountWithoutShift({ isStore: true, isManager: false, hasShift: false }), true);
});

/* ------------------------------------------- held until agreed */

import {
  movesOnItsOwn, isPending, hasMoved, countState, countStateLabel, approveDeltas, heldWords,
  storeCountId, isStoreCount,
} from '../bar-count.ts';

const line = (over: Record<string, unknown> = {}): FiledCheck => ({
  $id: 'c1', $createdAt: '2026-09-01T20:00:00.000Z', shift_id: 's1', ingredient_id: 'ing1',
  phase: 'close' as const, counted_qty: 5, theoretical_qty: 6, variance_qty: -1, variance_value: 300,
  checked_by: 'u1', ...over,
});

test('a count that matched moves on its own; a difference waits', () => {
  /**
   * The rule the owner asked for. A count that found exactly what was
   * expected changes nothing, and holding it would be a queue of approvals
   * that approve nothing. A difference is a claim that stock is missing or
   * has appeared, and that claim moves real figures — so it waits for somebody
   * who can see the whole business.
   */
  assert.equal(movesOnItsOwn(0), true);
  assert.equal(movesOnItsOwn(-1), false);
  assert.equal(movesOnItsOwn(2), false);
});

test('rows from before approval existed read as already applied', () => {
  /*
    Every one of them moved the shelf the moment it was filed. Reading them as
    unapplied would offer to apply a year of old counts a second time.
  */
  assert.equal(hasMoved(line({ applied: undefined })), true);
  assert.equal(hasMoved(line({ applied: null })), true);
  assert.equal(hasMoved(line({ applied: false })), false);
  assert.equal(isPending(line({ applied: undefined })), false);
  assert.equal(isPending(line({ applied: false })), true);
});

test('a refused line is neither pending nor moved', () => {
  const refused = line({ applied: false, rejected_at: '2026-09-01T21:00:00.000Z' });
  assert.equal(isPending(refused), false);
  assert.equal(hasMoved(refused), false);
});

test('approving applies the difference, never the counted figure', () => {
  /**
   * The count was taken hours ago and the shelf has been sold from since.
   * Setting it to the counted number now would erase every sale in between.
   */
  const [count] = filedCounts([
    line({ $id: 'a', applied: false, variance_qty: -3 }),
    line({ $id: 'b', ingredient_id: 'ing2', applied: false, variance_qty: 0 }),
    line({ $id: 'c', ingredient_id: 'ing3', applied: true, variance_qty: -9 }),
  ]);
  assert.deepEqual(approveDeltas(count), [{ checkId: 'a', ingredientId: 'ing1', delta: -3 }]);
});

test('taking back a count only reverses what actually moved', () => {
  const [count] = filedCounts([
    line({ $id: 'a', applied: true, variance_qty: -3 }),
    line({ $id: 'b', ingredient_id: 'ing2', applied: false, variance_qty: -4 }),
  ]);
  assert.deepEqual(undoDeltas(count), [{ ingredientId: 'ing1', delta: 3 }]);
});

test('a count still waiting cannot be taken back, and says why', () => {
  const [count] = filedCounts([line({ applied: false })]);
  assert.equal(count.pending, 1);
  assert.match(String(undoProblem(count)), /waiting for approval/);
  assert.match(String(undoProblem(count)), /Refuse it instead/);
});

test('each count says where it stands, in one word', () => {
  const state = (rows: ReturnType<typeof line>[]) => countState(filedCounts(rows)[0]);
  assert.equal(state([line({ applied: false })]), 'pending');
  assert.equal(state([line({ applied: true, approved_at: '2026-09-01T21:00:00.000Z' })]), 'applied');
  assert.equal(state([line({ applied: false, rejected_at: '2026-09-01T21:00:00.000Z' })]), 'rejected');
  assert.equal(state([line({ applied: true, undone_at: '2026-09-02T09:00:00.000Z' })]), 'undone');
  assert.equal(state([line({ variance_qty: 0, variance_value: 0 })]), 'unchanged');
  // And every word is different, so a list can be scanned.
  const all = ['pending', 'applied', 'rejected', 'undone', 'unchanged'] as const;
  assert.equal(new Set(all.map(countStateLabel)).size, all.length);
});

test('the count carries who counted, who agreed, who refused, who took it back', () => {
  const [count] = filedCounts([
    line({ checked_by: 'regina', applied: true, approved_by: 'boss', approved_at: '2026-09-01T21:00:00.000Z' }),
  ]);
  assert.equal(count.countedBy, 'regina');
  assert.equal(count.approvedBy, 'boss');
});

test('whoever filed a held count is told what is waiting and what is not', () => {
  const words = String(heldWords(3, (n) => `GH₵${(n / 100).toFixed(2)}`, 4500));
  assert.match(words, /3 lines found a difference \(GH₵45\.00\)/);
  assert.match(words, /waiting for an admin/);
  // The part that stops somebody counting the whole bar again.
  assert.match(words, /Everything that matched has been recorded/);
  assert.equal(heldWords(0, String, 0), null);
});

test('a store room count is named by its room and told apart from a shift', () => {
  assert.equal(storeCountId('room1'), 'store:room1');
  assert.equal(isStoreCount('store:room1'), true);
  assert.equal(isStoreCount('BAR20260901-abcd'), false);
});
