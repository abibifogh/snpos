import test from 'node:test';
import assert from 'node:assert/strict';
import {
  byUnit, wasCountedBar, variancesIn, summariseBarCount, readyToClose, unitLabel,
  BAR_VARIANCE_TOLERANCE, type BarCountLine,
  shiftCounted, hasShiftCountChoice, countsAtBothEnds, readyToAccept,
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

test('the bar counts at both ends of a shift; nobody else does', () => {
  // The kitchen counts once, at the end: nobody accepts the rice at four in
  // the afternoon. The shop's stock counts itself through intakes and sales.
  assert.equal(countsAtBothEnds('bar'), true);
  assert.equal(countsAtBothEnds('kitchen'), false);
  assert.equal(countsAtBothEnds('craft'), false);
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
