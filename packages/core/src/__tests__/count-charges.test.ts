import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerableShift, nettedCount, answerDeadline, timeLeftWords, autoDecision, countStage, stageWords,
  deductedAmount, answerProblem, decisionProblem, countUndoProblem, putbacksDue, hiveRows, hiveCsv, hiveRef,
  suggestHiveMatch, countChargeLines, isFinal,
  type CountCharge,
} from '../count-charges.ts';
import { owedWords } from '../staff-charges.ts';
import * as server from '../../../../functions/notify/src/count-charges.js';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const charge = (over: Partial<CountCharge> = {}): CountCharge => ({
  $id: 'c1', person_id: 'p-regina', person_user_id: 'u-regina', person_name: 'Regina Test',
  item_name: 'Bar count: 2 Club', qty: 1, unit_price: 5_600, amount: 5_600,
  charged_at: '2026-11-03T10:00:00.000Z', settled_total: 0, status: 'open',
  decision: 'pending', answer_by: '2026-11-04T10:00:00.000Z', phase: 'close', ...over,
});

test('a closing count is the closing shift\'s; an opening count is the shift before', () => {
  const tue = { $id: 'tue', opened_by: 'u-regina' };
  const mon = { $id: 'mon', opened_by: 'u-chichi' };
  assert.equal(answerableShift('close', tue, mon)?.opened_by, 'u-regina');
  assert.equal(answerableShift('open', tue, mon)?.opened_by, 'u-chichi');
  // Nobody before: nobody to charge for an opening count.
  assert.equal(answerableShift('open', tue, null), null);
});

test('what is over on a count is set against what is short, at the price given', () => {
  const n = nettedCount([
    { name: 'Club', variance: -2, price: 1_500 },
    { name: 'Gin 25cl', variance: -1, price: 2_600 },
    { name: 'Malt', variance: 1, price: 1_000 },
    { name: 'Water', variance: 0, price: 500 },
  ]);
  assert.equal(n.short, 5_600);
  assert.equal(n.over, 1_000);
  assert.equal(n.owed, 4_600);
  assert.equal(n.lines.length, 3, 'a line that agreed is not part of it');
  assert.equal(n.lines[0]!.name, 'Club', 'short lines first, the biggest first');
});

test('a count that only comes out over charges nobody', () => {
  const n = nettedCount([{ name: 'Malt', variance: 2, price: 1_000 }]);
  assert.equal(n.owed, 0);
  assert.equal(n.over, 2_000);
});

test('the server nets a count exactly as the screens do', () => {
  const diffs = [
    { name: 'Club', variance: -2, price: 1_500 },
    { name: 'Gin', variance: -0.5, price: 2_601 },
    { name: 'Malt', variance: 1, price: 999 },
  ];
  assert.deepEqual(server.nettedCount(diffs), nettedCount(diffs));
});

test('the server and the screens agree on when the clock decides', () => {
  const cases: Partial<CountCharge>[] = [
    {}, { answer: 'accept' }, { answer: 'explain' }, { answer: 'putback' },
    { answer_by: '2026-11-03T11:00:00.000Z' },
    { answer_by: '2026-11-03T11:00:00.000Z', answer: 'accept' },
    { answer_by: '2026-11-03T11:00:00.000Z', answer: 'explain' },
    { answer_by: '2026-11-03T11:00:00.000Z', reopened_by: 'u-boss' },
    { answer_by: '2026-11-03T11:00:00.000Z', decision: 'deduct' },
  ];
  for (const c of cases) {
    assert.equal(server.autoDecision(charge(c), NOW.toISOString()), autoDecision(charge(c), NOW), JSON.stringify(c));
  }
});

test('accepted or unanswered is deducted at the deadline; explained waits for a manager', () => {
  const late = { answer_by: '2026-11-03T11:00:00.000Z' };
  assert.equal(autoDecision(charge(), NOW), null, 'not yet');
  assert.equal(autoDecision(charge(late), NOW), 'deduct');
  assert.equal(autoDecision(charge({ ...late, answer: 'accept' }), NOW), 'deduct');
  assert.equal(autoDecision(charge({ ...late, answer: 'explain' }), NOW), null);
  assert.equal(autoDecision(charge({ ...late, answer: 'putback' }), NOW), null);
  // Taken back by a manager: theirs to decide again, never the clock's.
  assert.equal(autoDecision(charge({ ...late, reopened_by: 'u-boss' }), NOW), null);
});

test('the deadline is a day on by default, and the time left reads plainly', () => {
  assert.equal(answerDeadline('2026-11-03T10:00:00.000Z'), '2026-11-04T10:00:00.000Z');
  assert.equal(answerDeadline('2026-11-03T10:00:00.000Z', 12), '2026-11-03T22:00:00.000Z');
  assert.equal(server.answerDeadline('2026-11-03T10:00:00.000Z', 12), '2026-11-03T22:00:00.000Z');
  assert.equal(timeLeftWords(19 * 3_600_000 + 12 * 60_000), '19 h 12 min');
  assert.equal(timeLeftWords(40 * 60_000), '40 min');
  assert.equal(timeLeftWords(2 * 3_600_000), '2 h');
  assert.equal(timeLeftWords(-1), 'time is up');
});

test('where each one stands', () => {
  assert.equal(countStage(charge(), NOW), 'answering');
  assert.match(stageWords(charge(), NOW).label, /^Not final · 22 h left$/);
  assert.equal(countStage(charge({ answer: 'explain' }), NOW), 'manager');
  assert.equal(countStage(charge({ answer_by: '2026-11-03T11:00:00.000Z' }), NOW), 'due');
  assert.equal(countStage(charge({ decision: 'deduct' }), NOW), 'deducted');
  assert.equal(countStage(charge({ decision: 'deduct', hive_sent_at: NOW.toISOString() }), NOW), 'sent');
  assert.equal(countStage(charge({ decision: 'waived' }), NOW), 'waived');
  assert.equal(countStage(charge({ decision: 'putback' }), NOW), 'putback');
  assert.equal(countStage(charge({ decision: 'putback', status: 'settled' }), NOW), 'paid_back');
  assert.ok(isFinal('sent') && isFinal('waived') && !isFinal('deducted'));
});

test('what is taken from pay', () => {
  assert.equal(deductedAmount(charge()), 0, 'nothing while it is not final');
  assert.equal(deductedAmount(charge({ decision: 'deduct' })), 5_600);
  assert.equal(deductedAmount(charge({ decision: 'part', decided_amount: 3_000 })), 3_000);
  assert.equal(deductedAmount(charge({ decision: 'waived' })), 0);
});

test('an answer and a decision are checked the same on both sides', () => {
  const c = charge();
  assert.equal(answerProblem(c, 'explain', ''), server.answerProblem(c, 'explain', ''));
  assert.match(answerProblem(c, 'explain', '') ?? '', /what happened/);
  assert.equal(answerProblem(c, 'accept', ''), null);
  assert.match(answerProblem(charge({ decision: 'deduct' }), 'accept', '') ?? '', /already decided/);

  for (const [d, amt, note, ans] of [
    ['part', 3_000, '', undefined], ['part', 5_600, 'half', undefined], ['part', 3_000, 'One broke', undefined],
    ['waived', 0, '', undefined], ['waived', 0, 'Found it', undefined], ['putback', 0, '', undefined], ['putback', 0, '', 'putback'],
    ['deduct', 0, '', undefined],
  ] as const) {
    const x = charge({ answer: ans });
    assert.equal(decisionProblem(x, d, amt, note), server.decisionProblem(x, d, amt, note), `${d} ${amt} ${note}`);
  }
  assert.equal(decisionProblem(charge(), 'deduct', 0, ''), null);
  assert.match(decisionProblem(charge(), 'putback', 0, '') ?? '', /offered/);
});

test('a decision can be taken back until HIVE has it, or the money is back', () => {
  for (const c of [
    charge(), charge({ decision: 'deduct' }), charge({ decision: 'deduct', hive_sent_at: NOW.toISOString() }),
    charge({ decision: 'putback' }), charge({ decision: 'putback', putback_shift_id: 's9' }), charge({ decision: 'waived' }),
  ]) {
    assert.equal(countUndoProblem(c), server.undoProblem(c));
  }
  assert.equal(countUndoProblem(charge({ decision: 'deduct' })), null);
  assert.match(countUndoProblem(charge({ decision: 'deduct', hive_sent_at: NOW.toISOString() })) ?? '', /HIVE/);
});

test('a decision closes the charge on the books', () => {
  const c = charge();
  assert.deepEqual(server.decisionSettlements(c, 'deduct', 0), [{ kind: 'pay', amount: 5_600 }]);
  assert.deepEqual(server.decisionSettlements(c, 'part', 3_000), [{ kind: 'pay', amount: 3_000 }, { kind: 'written_off', amount: 2_600 }]);
  assert.deepEqual(server.decisionSettlements(c, 'waived', 0), [{ kind: 'written_off', amount: 5_600 }]);
  assert.deepEqual(server.decisionSettlements(c, 'putback', 0), [], 'nothing until the drawer has it');
});

test('only what a manager agreed to put back is added to their drawer', () => {
  const rows = [
    charge({ $id: 'a', decision: 'putback' }),
    charge({ $id: 'b', decision: 'putback', putback_shift_id: 's1' }),
    charge({ $id: 'c', decision: 'pending', answer: 'putback' }),
    charge({ $id: 'd', decision: 'putback', person_user_id: 'u-chichi', person_id: 'p-chichi' }),
  ];
  assert.deepEqual(putbacksDue(rows, { userId: 'u-regina' }).map((c) => c.$id), ['a']);
  assert.deepEqual(putbacksDue(rows, { profileId: 'p-chichi' }).map((c) => c.$id), ['d']);
});

test('the till\'s owed line leaves not-final charges to their own card', () => {
  const money = (n: number) => `GH₵${(n / 100).toFixed(2)}`;
  assert.equal(owedWords([charge()], money), null);
  assert.equal(owedWords([charge({ decision: 'putback' })], money), null);
  assert.match(owedWords([charge({ decision: undefined, qty: 2, item_name: 'Club' })], money) ?? '', /You owe GH₵56\.00/);
});

test('HIVE gets one row per final deduction, matched people only', () => {
  const charges = [
    charge({ $id: 'a', decision: 'deduct', decided_at: '2026-11-04T10:00:00.000Z' }),
    charge({ $id: 'b', decision: 'part', decided_amount: 2_000, decided_at: '2026-11-05T10:00:00.000Z' }),
    charge({ $id: 'c', decision: 'waived', decided_at: '2026-11-05T10:00:00.000Z' }),
    charge({ $id: 'd', decision: 'pending' }),
    charge({ $id: 'e', decision: 'deduct', person_id: 'p-chichi', person_name: 'Chichi Test', decided_at: '2026-11-05T10:00:00.000Z' }),
    charge({ $id: 'f', decision: 'deduct', decided_at: '2026-10-30T10:00:00.000Z' }),
  ];
  const profiles = [
    { $id: 'p-regina', display_name: 'Regina Test', hive_staff_id: 'HV-0142', hive_name: 'Regina T.' },
    { $id: 'p-chichi', display_name: 'Chichi Test' },
  ];
  const { rows, unmatched } = hiveRows(charges, profiles, '2026-11');
  assert.deepEqual(rows.map((r) => [r.ref, r.hiveStaffId, r.amount]), [['POS-a', 'HV-0142', 5_600], ['POS-b', 'HV-0142', 2_000]]);
  assert.deepEqual(unmatched, [{ personId: 'p-chichi', name: 'Chichi Test', amount: 5_600 }]);
  assert.equal(hiveRef('a'), 'POS-a');
  const csv = hiveCsv(rows);
  assert.match(csv, /"Reference","HIVE staff ID"/);
  assert.match(csv, /"POS-a","HV-0142","Regina T\.","Regina Test","2026-11-04","56\.00","Bar count difference \(counted out\), 2026-11-03",""/);
});

test('a HIVE match is suggested by email, or by a name nobody else shares, never assumed', () => {
  const staff = [
    { $id: '1', hive_id: 'HV-0157', name: 'Chichi Obi', email: 'chichi@example.test' },
    { $id: '2', hive_id: 'HV-0160', name: 'Chinedu Okafor' },
    { $id: '3', hive_id: 'HV-0161', name: 'Ama Test' },
    { $id: '4', hive_id: 'HV-0162', name: 'Ama Test' },
  ];
  assert.equal(suggestHiveMatch({ email: 'Chichi@example.test', display_name: 'C' }, staff)?.hive_id, 'HV-0157');
  assert.equal(suggestHiveMatch({ display_name: 'chinedu  okafor' }, staff)?.hive_id, 'HV-0160');
  assert.equal(suggestHiveMatch({ display_name: 'Ama Test' }, staff), null, 'two with that name: no guess');
  assert.equal(suggestHiveMatch({ display_name: 'Chinedu Okafor' }, staff, new Set(['HV-0160'])), null, 'already somebody else\'s');
});

test('a charge\'s lines read back, and bad JSON reads as none', () => {
  assert.deepEqual(countChargeLines({ lines: '[{"name":"Club","qty":-2,"unit_price":1500,"amount":-3000}]' })[0]!.name, 'Club');
  assert.deepEqual(countChargeLines({ lines: 'nope' }), []);
});
