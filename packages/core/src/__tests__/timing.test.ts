import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cookMinutes, estimateMinutes, queueMinutes, dueMinutes, shownEta,
  cancelWindowLeft, CANCEL_WINDOW_MS, MAX_ETA_MINUTES,
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
