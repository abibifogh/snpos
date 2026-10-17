import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingsOnTab, tabCounts, onTab, whenFromNow, BOOKING_TAB_WORDS } from '../booking-tabs.ts';
import { bookingStatusWords, approvalWords } from '../booking-approval.ts';
import { bookingTotals, FULFILMENT_WORDS, SERVICE_WORDS, SERVICE_HINTS, mealServiceWords, packWords } from '../pricing.ts';
import type { GroupMeal, CartLine } from '../pricing.ts';
import { groupStageWanted, unconfirmedReminderDue } from '../../../../functions/notify/src/words.js';

const now = new Date('2026-10-02T12:00:00Z');
const b = (id: string, over: Record<string, string> = {}) => ({
  $id: id, status: 'pending', first_at: '2026-10-11T19:00:00Z', last_at: '2026-10-13T09:00:00Z', ...over,
});

test('the page opens on what needs somebody, and a booking can be on two tabs', () => {
  const rows = [
    b('new'),
    b('soon', { status: 'approved', first_at: '2026-10-05T12:00:00Z', last_at: '2026-10-05T12:00:00Z' }),
    b('later', { status: 'approved', first_at: '2026-11-01T12:00:00Z', last_at: '2026-11-01T12:00:00Z' }),
    b('gone', { status: 'approved', first_at: '2026-09-20T12:00:00Z', last_at: '2026-09-21T12:00:00Z' }),
    b('no', { status: 'refused' }),
  ];
  const asking = new Set(['later']);
  assert.deepEqual(bookingsOnTab(rows, 'decide', now, asking).map((x) => x.$id), ['new']);
  assert.deepEqual(bookingsOnTab(rows, 'changes', now, asking).map((x) => x.$id), ['later']);
  // Soonest first; a declined booking is not coming up.
  assert.deepEqual(bookingsOnTab(rows, 'upcoming', now, asking).map((x) => x.$id), ['soon', 'new', 'later']);
  assert.deepEqual(bookingsOnTab(rows, 'past', now, asking).map((x) => x.$id), ['gone']);
  assert.deepEqual(tabCounts(rows, now, asking), { decide: 1, changes: 1, upcoming: 3, past: 1, all: 5 });
  // A pending booking whose meals are over is no longer a decision anybody can make.
  assert.equal(onTab(b('stale', { first_at: '2026-09-01T12:00:00Z', last_at: '2026-09-01T12:00:00Z' }), 'decide', now, asking), false);
  assert.equal(BOOKING_TAB_WORDS.decide, 'Needs a decision');
  assert.equal(whenFromNow('2026-10-11T19:00:00Z', now), 'in 9 days');
  assert.equal(whenFromNow('2026-10-03T08:00:00Z', now), 'tomorrow');
  assert.equal(whenFromNow('2026-09-30T08:00:00Z', now), '2 days ago');
});

test('a booking says where it stands in the same words as the guest’s emails', () => {
  assert.deepEqual(bookingStatusWords('pending'), { label: 'Waiting to confirm', tone: 'warn' });
  assert.deepEqual(bookingStatusWords(undefined), { label: 'Waiting to confirm', tone: 'warn' });
  assert.equal(bookingStatusWords('approved').label, 'Confirmed');
  assert.equal(bookingStatusWords('refused').label, 'Declined');
  assert.equal(bookingStatusWords('cancelled').label, 'Cancelled');
  // The guest's side of a revision never says "approve", which is the house's word.
  assert.equal(approvalWords('awaiting').label, 'Guest checking changes');
  assert.equal(approvalWords('approved').label, 'Guest agreed');
});

test('one word each for where and how a meal time is eaten', () => {
  assert.equal(FULFILMENT_WORDS.dine_in, 'Eat here');
  assert.equal(FULFILMENT_WORDS.takeaway, 'Packed');
  assert.deepEqual([SERVICE_WORDS.plated, SERVICE_WORDS.buffet], ['Plated', 'Buffet']);
  assert.deepEqual([SERVICE_HINTS.plated, SERVICE_HINTS.buffet], ['One plate per guest', 'Set out to share']);
  assert.equal(mealServiceWords({ fulfilment: 'dine_in', service: 'buffet' }), 'Eat here · Buffet');
  assert.equal(packWords(1_000, (n) => `GH₵${n / 100}`), '+GH₵10 a portion for the boxes');
});

test('packing is counted on the packed meal times only', () => {
  const line = (qty: number): CartLine => ({
    key: `l${qty}`, menu_item_id: 'x', name: 'Rice', qty, unit_price: 8_000, addons: [], notes: '',
  } as unknown as CartLine);
  const meals: GroupMeal[] = [
    { key: 'a', at: '2026-10-11T19:00:00Z', fulfilment: 'dine_in', lines: [line(55)] },
    { key: 'b', at: '2026-10-12T09:00:00Z', fulfilment: 'takeaway', lines: [line(35)] },
  ];
  const t = bookingTotals(meals, { tax_rate_bp: 0, tax_inclusive: true, service_charge_bp: 0 }, 1_000);
  assert.equal(t.portions, 90);
  // The badge used to say 90 here: every portion, not the ones in boxes.
  assert.equal(t.packedPortions, 35);
  assert.equal(t.packFees, 35_000);
});

test('a group guest hears only that packed food is ready, never "accepted"', () => {
  const walkIn = { fulfilment: 'takeaway' };
  const packed = { group_booking_id: 'gb1', fulfilment: 'takeaway' };
  const eatHere = { group_booking_id: 'gb1', fulfilment: 'dine_in' };
  assert.equal(groupStageWanted('accepted', walkIn), true);
  assert.equal(groupStageWanted('ready', walkIn), true);
  assert.equal(groupStageWanted('accepted', packed), false);
  assert.equal(groupStageWanted('ready', packed), true);
  assert.equal(groupStageWanted('ready', eatHere), false);
  assert.equal(groupStageWanted(null, walkIn), false);
});

test('the team is reminded once, in the hour the first meal time comes within a day', () => {
  const t = new Date('2026-10-10T19:00:00Z').getTime();
  const booking = { status: 'pending', first_at: '2026-10-11T18:30:00Z' };
  assert.equal(unconfirmedReminderDue(booking, t), true, '23.5 hours out');
  assert.equal(unconfirmedReminderDue(booking, t - 3_600_000), false, 'the hour before: 24.5 hours out');
  assert.equal(unconfirmedReminderDue(booking, t + 3_600_000), false, 'the hour after: 22.5 hours out');
  assert.equal(unconfirmedReminderDue({ ...booking, status: 'approved' }, t), false, 'already confirmed');
  assert.equal(unconfirmedReminderDue({ status: 'pending' }, t), false, 'no date');
});
