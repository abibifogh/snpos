import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cookMinutes, estimateMinutes, queueMinutes, dueMinutes, shownEta,
  cancelWindowLeft, CANCEL_WINDOW_MS, MAX_ETA_MINUTES, ticketLines, LINES_GRACE_MS, isOverdue, minutesOver,
  linesComplete, addonNames, addonsUnreadable,
  waitIncludingOpening, quotedWait, formatWait,
} from '../orders-time.ts';
import { minutesUntilOpen, type Windows } from '../availability.ts';
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

test('food that is already up is never late, however long it sits there', () => {
  /**
   * The kitchen was asked to have it ready by a time and it was. Everything
   * after that is the collection, and nobody standing at a pass can act on a
   * customer who has not come for their food. A Late tag left on a finished
   * plate marks the kitchen down for somebody else's delay and crowds out the
   * tag that IS still theirs to act on, which is that it has not been paid for.
   */
  const ready = { status: 'READY', $createdAt: '2026-08-13T11:00:00.000Z' };
  const hoursOn = Date.parse('2026-08-13T20:00:00.000Z');

  assert.equal(isOverdue(ready, 20, hoursOn), false, 'nine hours later, still not late');
  assert.equal(isOverdue({ ...ready, status: 'SERVED' }, 20, hoursOn), false);
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

test('a ticket knows when it is only half of the order', () => {
  /**
   * The failure this exists to catch: an order and its lines are separate
   * writes, and a read landing between them comes back with some of them.
   * Nothing about that answer says it is incomplete — a ticket showing two of
   * three dishes looks exactly like an order for two dishes. The cook makes
   * two, the customer is charged for three, and the only person who finds out
   * is the one still waiting.
   *
   * The order carries the answer already: its subtotal is the sum of the lines,
   * worked out from the whole cart before any of them were written.
   */
  const order = { subtotal: 3000 };
  assert.equal(linesComplete(order, [{ line_total: 1000 }]), false, 'one of three');
  assert.equal(linesComplete(order, [{ line_total: 1000 }, { line_total: 1000 }]), false, 'two of three');
  assert.equal(
    linesComplete(order, [{ line_total: 1000 }, { line_total: 1000 }, { line_total: 1000 }]),
    true,
  );

  assert.equal(linesComplete(order, []), false, 'none at all is not complete either');
  assert.equal(linesComplete(order, undefined), false, 'and neither is not having asked');
});

test('a voided line does not make an order incomplete for ever', () => {
  // Voiding removes the value from the order but leaves the line on the ticket,
  // so the lines can add up to MORE than the subtotal. Insisting on exactly
  // equal would leave that ticket warning until the end of time.
  assert.equal(linesComplete({ subtotal: 1000 }, [{ line_total: 1000 }, { line_total: 500 }]), true);
});

test('an order with nothing to check against is taken at its word', () => {
  // A comped order, or a row from before the subtotal was stored. Being wrong
  // towards "this is fine" costs nothing here; the count-based retries still run.
  assert.equal(linesComplete({ subtotal: 0 }, [{ line_total: 0 }]), true);
  assert.equal(linesComplete({}, [{ line_total: 0 }]), true);
});

test('a half-loaded ticket says so, but only after the lines have had time', () => {
  const placed = '2026-08-13T12:00:00.000Z';
  const at = (ms: number) => Date.parse(placed) + ms;
  const order = { $createdAt: placed, subtotal: 3000 };
  const some = [{ line_total: 1000 }];
  const all = [{ line_total: 3000 }];

  assert.equal(ticketLines(order, some, at(2_000)), 'loading', 'still arriving');
  assert.equal(ticketLines(order, some, at(LINES_GRACE_MS + 1)), 'partial', 'and now a real fault');
  assert.equal(ticketLines(order, all, at(0)), 'ready');
  assert.equal(ticketLines(order, [], at(LINES_GRACE_MS + 1)), 'missing', 'none at all reads differently');
});

test('an order joining a busy pass waits for everything in front of it', () => {
  /**
   * What a customer is quoted is the work still left on the tickets ahead
   * plus the cooking on their own. Told twenty minutes with four orders in
   * front of them, they are being told how long their food takes, not how
   * long until they eat — and that gap is widest exactly when they are
   * deciding whether to wait at all.
   */
  const now = Date.parse('2026-08-13T19:00:00.000Z');
  const ago = (mins: number) => new Date(now - mins * 60_000).toISOString();

  // One accepted eight minutes ago with fifteen to cook: seven left.
  // One nobody has touched, twelve to cook: all twelve.
  const ahead = queueMinutes(
    [
      { status: 'ACCEPTED', prep_minutes: 15, accepted_at: ago(8), $createdAt: ago(9) },
      { status: 'PENDING', prep_minutes: 12, $createdAt: ago(2) },
    ],
    now,
  );
  assert.equal(ahead, 19, 'every ticket in front, not just the first');

  // A new ten minute order behind them is quoted the lot.
  assert.equal(estimateMinutes([{ prep_minutes: 10 }], ahead), 29);

  // And with nothing in front, it is quoted its own cooking and no more.
  assert.equal(estimateMinutes([{ prep_minutes: 10 }], 0), 10);
});

test('a queue only ever grows the quote, never shrinks it', () => {
  // Whatever is ahead, the answer is at least the time this food takes.
  const own = [{ prep_minutes: 18 }];
  for (const ahead of [0, 1, 5, 30, 500]) {
    assert.ok(estimateMinutes(own, ahead) >= Math.min(18, MAX_ETA_MINUTES));
  }
  // And never past the cap, however long the queue is.
  assert.equal(estimateMinutes(own, 500), MAX_ETA_MINUTES);
});

test('a ticket is judged against what the customer was told, queue included', () => {
  /**
   * The clock starts when the order is placed, so what it is measured against
   * has to include the wait before a cook could touch it. Judged against the
   * cooking time alone, an order that queued twenty minutes behind four others
   * went red through no fault of the kitchen — and on a busy night every
   * ticket did, which is exactly when a red ticket needed to mean something.
   */
  const placed = '2026-08-14T19:00:00.000Z';
  const at = (mins: number) => Date.parse(placed) + mins * 60_000;
  // Twenty minutes of cooking, quoted at thirty-four because of the queue.
  const order = { status: 'ACCEPTED', $createdAt: placed, prep_minutes: 20, eta_minutes: 34 };

  assert.equal(dueMinutes(order), 34, 'the promise, not the cooking alone');
  assert.equal(isOverdue(order, dueMinutes(order), at(25)), false, 'still inside what they were told');
  assert.equal(isOverdue(order, dueMinutes(order), at(35)), true, 'and late when the promise breaks');
});

test('an order with no queue is judged by its cooking, as before', () => {
  // A quiet pass: the two figures are the same and nothing changes.
  const order = { prep_minutes: 20, eta_minutes: 20, $createdAt: '2026-08-14T19:00:00.000Z' };
  assert.equal(dueMinutes(order), 20);
});

test('an order from before the wait was stored still has a rule', () => {
  // Nothing is left without an answer: the cooking time, then the lines, then
  // a guess. A guess that pings beats a blank that never does.
  assert.equal(dueMinutes({ prep_minutes: 25, $createdAt: '2026-08-14T19:00:00.000Z' }), 25);
  assert.equal(
    dueMinutes({ $createdAt: '2026-08-14T19:00:00.000Z' }, [{ prep_minutes: 10 }, { prep_minutes: 5 }]),
    15,
  );
  assert.equal(dueMinutes({ $createdAt: '2026-08-14T19:00:00.000Z' }, []), 20);
});

/* ------------------------------------------ what was chosen on a dish */

test('the options on a line are read as words a cook can use', () => {
  assert.deepEqual(
    addonNames(JSON.stringify([{ name: 'No onions' }, { name: 'Extra chicken' }])),
    ['No onions', 'Extra chicken'],
  );
  // Nothing chosen is the ordinary case and is not a fault.
  assert.deepEqual(addonNames(''), []);
  assert.deepEqual(addonNames(undefined), []);
  assert.equal(addonsUnreadable(''), false);
  assert.equal(addonsUnreadable(undefined), false);
});

test('a line whose options cannot be read says so instead of looking plain', () => {
  /**
   * Two failures avoided at once.
   *
   * Every screen used to call JSON.parse inline, inside a render. One row with
   * a value that is not JSON did not blank that ticket, it blanked the whole
   * kitchen screen — a cook watching every order vanish because one of them
   * has a bad field is far worse than a missing option.
   *
   * And returning an empty list quietly is its own trap: silence and "no
   * options" look identical on a ticket, and only one of them is safe to cook.
   */
  assert.deepEqual(addonNames('not json at all'), [], 'no throw');
  assert.equal(addonsUnreadable('not json at all'), true, 'and the ticket is told');

  // Valid JSON of the wrong shape is the same problem wearing a hat.
  assert.deepEqual(addonNames('{"name":"Extra chicken"}'), [], 'an object is not a list');
  assert.equal(addonsUnreadable('{"name":"Extra chicken"}'), true);
  assert.deepEqual(addonNames('[{"noname":1}]'), []);
});

test('options stored as bare strings still read', () => {
  // Older rows, and anything hand-written. Cheap to accept, and the
  // alternative is a ticket that hides a cooking instruction it holds.
  assert.deepEqual(addonNames('["No onions","Mild"]'), ['No onions', 'Mild']);
  // A mixed list keeps what it can rather than throwing all of it away.
  assert.deepEqual(addonNames('["Mild",{"name":"Extra chicken"},{}]'), ['Mild', 'Extra chicken']);
});

/* ----------------------------------------- ordering before the kitchen opens */

/** Open 13:00–22:00 every day. */
const HOURS = {
  mon: [['13:00', '22:00']], tue: [['13:00', '22:00']], wed: [['13:00', '22:00']],
  thu: [['13:00', '22:00']], fri: [['13:00', '22:00']], sat: [['13:00', '22:00']],
  sun: [['13:00', '22:00']],
} as unknown as Windows;

/** Local noon on a Wednesday. Built from parts so it is the venue's noon. */
const noon = () => { const d = new Date(2026, 7, 12, 12, 0, 0, 0); return d; };

test('a wait that starts before opening counts from the door', () => {
  /**
   * The case in the owner's words: order at noon, twenty minutes of cooking, a
   * kitchen that opens at one. The honest answer is an hour and twenty, not
   * twenty — quoting the cooking time alone makes a promise that breaks itself
   * a full hour before anybody starts cooking.
   */
  assert.equal(minutesUntilOpen(HOURS, noon()), 60);
  assert.equal(waitIncludingOpening(20, minutesUntilOpen(HOURS, noon())), 80);
  assert.equal(formatWait(80), '1 hour 20 minutes');
});

test('the hour cap holds the queue back and lets the doors through', () => {
  /**
   * Two different kinds of number sharing one field. Sixty minutes is the
   * point past which a QUEUE estimate stops being something a person believes
   * or plans around. "We open at one, yours is ready about twenty past" is not
   * a guess — it is checkable against the door — so capping it would turn a
   * precise statement into a wrong one.
   */
  // Kitchen part alone is still clamped, however far behind the pass is.
  assert.equal(waitIncludingOpening(500, minutesUntilOpen(null, noon())), MAX_ETA_MINUTES);
  // And clamped inside the total, rather than the total being clamped.
  assert.equal(waitIncludingOpening(500, minutesUntilOpen(HOURS, noon())), 60 + MAX_ETA_MINUTES);
});

test('an open kitchen is unaffected, and a venue with no hours is always open', () => {
  const evening = new Date(2026, 7, 12, 19, 0, 0, 0);
  assert.equal(minutesUntilOpen(HOURS, evening), 0);
  assert.equal(waitIncludingOpening(20, minutesUntilOpen(HOURS, evening)), 20);
  // No rule at all must not read as "closed for ever" — it is the default for
  // a place that has configured nothing, and it means open.
  assert.equal(minutesUntilOpen(null, noon()), 0);
  assert.equal(waitIncludingOpening(20, minutesUntilOpen(null, noon())), 20);
});

test('what the customer is shown is capped only when the kitchen was open', () => {
  // The ordinary order: the cap still applies on the way out.
  assert.equal(quotedWait({ eta_minutes: 95 }), MAX_ETA_MINUTES);
  // The one placed before opening keeps its real figure.
  assert.equal(quotedWait({ eta_minutes: 80, placed_while_closed: true }), 80);
  // Nothing to say is said as nothing, not as a made-up number.
  assert.equal(quotedWait({}), null);
  assert.equal(quotedWait({ eta_minutes: 0, placed_while_closed: true }), null);
});

test('a wait is read once, not worked out', () => {
  assert.equal(formatWait(1), '1 minute');
  assert.equal(formatWait(45), '45 minutes');
  assert.equal(formatWait(60), '1 hour');
  assert.equal(formatWait(61), '1 hour 1 minute');
  assert.equal(formatWait(125), '2 hours 5 minutes');
});

test('a ticket placed before opening is not late until its promise breaks', () => {
  /**
   * The ticket side of the same rule. dueMinutes reads the quoted wait, so an
   * order placed at noon with eighty minutes on it goes late at 13:20 — not at
   * 12:20, which is what timing it by the cooking alone would have done, an
   * hour before the kitchen even opened.
   */
  const order = { eta_minutes: 80, status: 'ACCEPTED', $createdAt: noon().toISOString() };
  assert.equal(dueMinutes(order), 80);

  const at = (mins: number) => noon().getTime() + mins * 60_000;
  assert.equal(isOverdue(order, 80, at(20)), false, 'not late while the kitchen is still shut');
  assert.equal(isOverdue(order, 80, at(79)), false, 'not late a minute before it is due');
  assert.equal(isOverdue(order, 80, at(81)), true, 'late once the promise passes');
});
