/**
 * Time off, end to end, with an in-memory database.
 *
 * The rules are tested on their own in leave.test.ts. What can only be tested
 * here is the part that has no transaction behind it: two people asking for
 * the last place on a day at the same moment.
 */
import { __seed, __reset, __all } from './core/client.ts';
import { requestLeave, decideLeave, loadLeave } from './core/leave-store.ts';
import { dayLoads, takenOnDay } from './core/leave.ts';

const ok = (label: string, got: unknown, want: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  return pass;
};

const results: [string, boolean][] = [];
const DAY = '2026-09-12';

const ask = (staff: string, days: string[], cap = 3) => requestLeave({
  venueId: 'main', staffId: staff, staffName: staff, days, kind: 'leave', cap,
});

console.log('\n=== A — the fourth person is refused, and told which day and why ===');
{
  __reset();
  __seed('settings', [{ $id: 's1', leave_max_per_day: 3 }]);
  for (const who of ['ama', 'kofi', 'yaw']) await ask(who, [DAY]);

  const fourth = await ask('regina', [DAY]);
  results.push(['A three get the day', ok('taken', takenOnDay(await loadLeave('main', DAY, DAY), DAY), 3)]);
  results.push(['A the fourth gets nothing', ok('booked', fourth.booked.length, 0)]);
  const reason = fourth.refused[0]?.reason ?? '';
  console.log(`   reason: ${reason}`);
  results.push(['A and is told which day, and the limit', ok(
    'reason names the day and the cap',
    [/Saturday 12 September is full/.test(reason), /at most 3 can be off on one day/.test(reason)],
    [true, true],
  )]);
}

console.log('\n=== B — two people asking for the last place at the same moment ===');
{
  /*
    There is no transaction here, so a plain read-then-write cannot promise the
    cap: both read "two off, room for one", both write, and the day ends at
    four. The check runs again after writing, first asked first held, and the
    loser refuses itself with the reason on the row.
  */
  __reset();
  for (const who of ['ama', 'kofi']) await ask(who, [DAY]);

  const [one, two] = await Promise.all([ask('regina', [DAY]), ask('kwame', [DAY])]);
  const held = takenOnDay(await loadLeave('main', DAY, DAY), DAY);
  results.push(['B the day still holds exactly three', ok('taken', held, 3)]);
  results.push(['B one of the two got it, not both', ok(
    'booked', [one.booked.length, two.booked.length].sort(), [0, 1],
  )]);

  const loser = one.booked.length === 0 ? one : two;
  console.log(`   loser told: ${loser.refused[0]?.reason ?? '(nothing)'}`);
  results.push(['B and the loser is told why, in the same words', ok(
    'reason mentions filling up',
    /filled up at the same moment/.test(loser.refused[0]?.reason ?? ''),
    true,
  )]);
  results.push(['B the refusal is on the row, where the person can read it', ok(
    'refused rows carry a note',
    (__all('staff_leave') as any[]).filter((r) => r.status === 'refused' && r.decided_note).length,
    1,
  )]);
}

console.log('\n=== C — a week where only some days are full books the rest ===');
{
  __reset();
  for (const who of ['ama', 'kofi', 'yaw']) await ask(who, ['2026-09-11', '2026-09-13']);

  const regina = await ask('regina', [
    '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14',
  ]);
  results.push(['C the free days went through', ok(
    'booked', regina.booked.map((b) => b.day), ['2026-09-10', '2026-09-12', '2026-09-14'],
  )]);
  results.push(['C the full ones did not', ok(
    'refused', regina.refused.map((r) => r.day), ['2026-09-11', '2026-09-13'],
  )]);
}

console.log('\n=== D — a refusal frees the place, and approving cannot exceed the cap ===');
{
  __reset();
  for (const who of ['ama', 'kofi', 'yaw']) await ask(who, [DAY]);
  const rows = __all('staff_leave') as any[];

  // An admin turns one down. The place comes back.
  await decideLeave({ venueId: 'main', rowId: rows[0].$id, to: 'refused', userId: 'admin', cap: 3 });
  const after = await ask('regina', [DAY]);
  results.push(['D a refusal frees the place', ok('booked', after.booked.length, 1)]);

  /*
    And the refused one cannot simply be approved back in. An admin who raised
    nothing cannot make a fourth place appear by pressing agree, and finding
    that out here is better than finding it out from a rota.
  */
  const back = await decideLeave({
    venueId: 'main', rowId: rows[0].$id, to: 'approved', userId: 'admin', cap: 3,
  });
  console.log(`   approving back in: ${back.problem}`);
  results.push(['D approving past the cap is refused with a reason', ok(
    'blocked and explained',
    [back.ok, /already has 3 of 3 off/.test(back.problem ?? '')],
    [false, true],
  )]);
  results.push(['D and the day is still three', ok(
    'taken', takenOnDay(await loadLeave('main', DAY, DAY), DAY), 3,
  )]);
}

console.log('\n=== E — the admin sees free days as well as full ones ===');
{
  __reset();
  await ask('ama', ['2026-09-11']);
  const rows = await loadLeave('main', '2026-09-10', '2026-09-12');
  const loads = dayLoads(rows, ['2026-09-10', '2026-09-11', '2026-09-12'], 3);
  results.push(['E every day in the range is shown', ok(
    'loads', loads.map((l) => [l.day, l.taken]),
    [['2026-09-10', 0], ['2026-09-11', 1], ['2026-09-12', 0]],
  )]);
}

console.log('\n=== summary ===');
for (const [name, pass] of results) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
if (results.some(([, p]) => !p)) process.exitCode = 1;
