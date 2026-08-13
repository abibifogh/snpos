import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cookMinutes, estimateMinutes, queueMinutes, dueMinutes, shownEta,
  cancelWindowLeft, CANCEL_WINDOW_MS, MAX_ETA_MINUTES, ticketLines, LINES_GRACE_MS, isOverdue, minutesOver,
} from '../orders-time.ts';
import { byStaff, totalHandedOver } from '../handover-math.ts';

test('cooking time adds the dishes rather than taking the longest', () => {
  assert.equal(cookMinutes([{ prep_minutes: 10 }, { prep_minutes: 15 }]), 25);
  assert.equal(cookMinutes([{}]), 15, 'a dish with no prep time set is assumed fifteen');
  assert.equal(cookMinutes([]), 1, 'never zero, or nothing would ever be late');
});

test('the quoted wait is never past an hour, however the sums land', () => {
  assert.equal(estimateMinutes([{ prep_minutes: 200 }]), MAX_ETA_MINUTES);
  assert.equal(estimateMinutes([{ prep_minutes: 10 }], 500), MAX_ETA_MINUTES);
  assert.equal(shownEta(95), 60, 'capped again on the way out, for rows written before the cap');
  assert.equal(shownEta(20), 20);
  assert.equal(shownEta(0), null, 'no estimate means print no line, not print zero');
  assert.equal(shownEta(undefined), null);
});

test('the queue counts what is left to cook, not what was quoted', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');

  // Accepted ten minutes ago with twenty minutes of cooking: ten left.
  assert.equal(
    queueMinutes([{ status: 'ACCEPTED', prep_minutes: 20, accepted_at: '2026-06-01T11:50:00.000Z', $createdAt: '' }], now),
    10,
  );

  // Sitting unaccepted for an hour: none of it is done.
  assert.equal(
    queueMinutes([{ status: 'PENDING', prep_minutes: 20, $createdAt: '2026-06-01T11:00:00.000Z' }], now),
    20,
    'nothing comes off a ticket no cook has picked up',
  );

  // Finished cooking, waiting on a person.
  assert.equal(
    queueMinutes([{ status: 'READY', prep_minutes: 20, accepted_at: '2026-06-01T11:00:00.000Z', $createdAt: '' }], now),
    0,
  );

  // Long overdue never counts as negative work.
  assert.equal(
    queueMinutes([{ status: 'PREPARING', prep_minutes: 5, accepted_at: '2026-06-01T09:00:00.000Z', $createdAt: '' }], now),
    0,
  );
});

test('lateness is judged by the cooking time on the order', () => {
  assert.equal(dueMinutes({ prep_minutes: 25, $createdAt: '2026-06-01T12:00:00.000Z' }), 25);

  // Older orders, from before the cooking time was stored.
  assert.equal(dueMinutes({ $createdAt: '2026-06-01T12:00:00.000Z' }, [{ prep_minutes: 10 }, { prep_minutes: 5 }]), 15);
  assert.equal(
    dueMinutes({ $createdAt: '2026-06-01T12:00:00.000Z' }, [{ due_at: '2026-06-01T12:12:00.000Z' }]),
    12,
    'derived from where the line was due',
  );
  assert.equal(dueMinutes({ $createdAt: '2026-06-01T12:00:00.000Z' }, []), 20,
    'a guess that pings beats a blank that never does');
});

test('the cancel window closes on time', () => {
  const placed = '2026-06-01T12:00:00.000Z';
  const at = (s: number) => Date.parse(placed) + s * 1000;
  assert.equal(cancelWindowLeft({ $createdAt: placed }, at(0)), CANCEL_WINDOW_MS);
  assert.equal(cancelWindowLeft({ $createdAt: placed }, at(90)), 30_000);
  assert.equal(cancelWindowLeft({ $createdAt: placed }, at(120)), 0);
  assert.equal(cancelWindowLeft({ $createdAt: placed }, at(999)), 0, 'never goes negative');
  assert.equal(cancelWindowLeft({ $createdAt: 'nonsense' }), 0, 'an unreadable date closes the window');
});

test('a corrected handover stays on the record but out of the total', () => {
  const rows = [
    { staff_id: 'a', staff_name: 'Ama', amount: 5000, status: 'corrected' as const },
    { staff_id: 'a', staff_name: 'Ama', amount: 500, status: 'recorded' as const },
    { staff_id: 'b', staff_name: 'Kofi', amount: 2000, status: 'recorded' as const },
  ];
  const lines = byStaff(rows);
  const ama = lines.find((l) => l.staffId === 'a')!;

  assert.equal(ama.handedOver, 500, 'the mistake does not count');
  assert.equal(ama.entries.length, 2, 'but both entries are still there to look at');
  assert.equal(totalHandedOver(rows), 2500);
  assert.equal(lines[0].staffId, 'b', 'most handed over leads');
});

test('a handover from somebody with no name still reads', () => {
  const [line] = byStaff([{ staff_id: 'x', amount: 100 }]);
  assert.equal(line.name, 'Unknown');
  assert.equal(line.handedOver, 100, 'a row with no status counts');
});

test('an empty ticket is ordinary at first and a problem later', () => {
  /**
   * An order and its lines are two writes, and the kitchen is told about the
   * order first. Announcing "nothing is listed" the instant a ticket lands
   * fired on every single order; announcing it never left a cook staring at
   * "Loading items" for a list that was not coming.
   */
  const placed = '2026-08-13T12:00:00.000Z';
  const at = (ms: number) => Date.parse(placed) + ms;
  const order = { $createdAt: placed };

  assert.equal(ticketLines(order, undefined, at(0)), 'loading', 'the moment it arrives');
  assert.equal(ticketLines(order, [], at(2_000)), 'loading', 'two seconds in, still normal');
  assert.equal(ticketLines(order, undefined, at(LINES_GRACE_MS + 1)), 'missing');
  assert.equal(ticketLines(order, [], at(LINES_GRACE_MS + 1)), 'missing');

  // Lines present is always ready, however old the order is.
  assert.equal(ticketLines(order, [{}], at(0)), 'ready');
  assert.equal(ticketLines(order, [{}], at(LINES_GRACE_MS * 10)), 'ready');
});

test('a ticket with an unreadable date never accuses anybody', () => {
  // Being wrong towards "still loading" costs a cook a moment. Being wrong the
  // other way tells them a real order is broken.
  assert.equal(ticketLines({ $createdAt: 'nonsense' }, [], Date.now()), 'loading');
});

test('an order is late the moment it passes the time allowed, not five minutes after', () => {
  /**
   * The rule the owner asked for, and the one the ticket already displayed.
   * A twenty minute order used to run to twenty-five before anything said a
   * word, so the five minutes where a nudge still saves the order were the
   * five minutes with no signal at all.
   */
  const placed = '2026-08-13T12:00:00.000Z';
  const at = (mins: number) => Date.parse(placed) + mins * 60_000;
  const order = { status: 'ACCEPTED', $createdAt: placed, $updatedAt: placed };

  assert.equal(isOverdue(order, 20, at(19)), false, 'a minute to go');
  assert.equal(isOverdue(order, 20, at(20)), false, 'exactly on time is on time');
  assert.equal(isOverdue(order, 20, at(20.01)), true, 'a moment past, and it is late');
  assert.equal(isOverdue(order, 20, at(24)), true, 'no longer waiting for the old cushion');

  // PREPARING is the same question; PENDING has its own alarm and is not it.
  assert.equal(isOverdue({ ...order, status: 'PREPARING' }, 20, at(21)), true);
  assert.equal(isOverdue({ ...order, status: 'PENDING' }, 20, at(99)), false);
  assert.equal(isOverdue({ ...order, status: 'PAID' }, 20, at(99)), false);
});

test('food already cooked keeps its short wait, because somebody has to fetch it', () => {
  const ready = '2026-08-13T12:00:00.000Z';
  const at = (mins: number) => Date.parse(ready) + mins * 60_000;
  const order = { status: 'READY', $createdAt: '2026-08-13T11:00:00.000Z', $updatedAt: ready };

  // Measured from when it was marked ready, not from when it was ordered:
  // otherwise every order is late the instant a cook presses Ready.
  assert.equal(isOverdue(order, 20, at(2)), false);
  assert.equal(isOverdue(order, 20, at(6)), true);
  assert.equal(isOverdue(order, 20, at(6), 10), false, 'and the wait is settable');
});

test('minutes over counts both ways, so one figure covers left and over', () => {
  const placed = '2026-08-13T12:00:00.000Z';
  const at = (mins: number) => Date.parse(placed) + mins * 60_000;
  const order = { $createdAt: placed };

  assert.equal(minutesOver(order, 20, at(8)), -12, 'twelve minutes left');
  assert.equal(minutesOver(order, 20, at(20)), 0, 'due now');
  assert.equal(minutesOver(order, 20, at(23)), 3, 'three minutes over');
  assert.equal(minutesOver({ $createdAt: 'nonsense' }, 20, at(23)), 0, 'never invents a number');
});

test('a late order rings at the same second the ticket says it is due', () => {
  // The two used to be five minutes apart, which taught a kitchen that the
  // countdown on the ticket was not the number that mattered.
  const placed = '2026-08-13T12:00:00.000Z';
  const order = { status: 'ACCEPTED', $createdAt: placed, $updatedAt: placed };

  // Checked every ten seconds across the hand-over, which is the granularity
  // the kitchen screen rebuilds its late list on.
  for (let s = 15 * 60; s < 30 * 60; s += 10) {
    const now = Date.parse(placed) + s * 1000;
    const over = minutesOver(order, 20, now);
    const ringing = isOverdue(order, 20, now);

    // Away from the rounding boundary the two must say the same thing. Within
    // half a minute of due they may differ by that rounding alone: the ticket
    // reads "due now" while the pill has just come on, which is not a
    // contradiction, and a second later it reads "1 min over".
    if (over >= 1) assert.equal(ringing, true, `says ${over} min over but is not ringing`);
    if (over <= -1) assert.equal(ringing, false, `says ${-over} min left but is ringing`);
  }
});
