import { useState } from 'react';
import { Button, Field, Modal, Select, Badge } from '@snpos/ui';
import {
  slotsByDay, timesTaken, timeIsTaken, freeTimesOn, portionsOn,
  FULFILMENT_WORDS, longDayWords, timeWords,
} from '@snpos/core';
import type { GroupMeal } from '@snpos/core';
import { newMeal } from './GroupSheet';

/**
 * Which meal of the stay is being ordered for.
 *
 * A strip above the menu, because in group mode every dish tapped has to go
 * somewhere, and "somewhere" is a particular sitting. Without this the group
 * builds one pile of food and is asked at the end to sort it into meals,
 * which is the same work done twice and done worse.
 *
 * MEALS, not days. A party staying four nights eats eight times: lunch on the
 * terrace and dinner in the restaurant on the same Tuesday are two sittings,
 * cooked hours apart, and one may be packed for an excursion while the other
 * is not. So the same date can appear twice, and only the same TIME twice is
 * refused as a duplicate.
 *
 * The times offered are the ones the kitchen can actually serve, taken from
 * the same list the ordinary pre-order picker uses, so a booking can never
 * land when the restaurant is shut.
 */
export function GroupDays({
  meals, setMeals, activeKey, setActiveKey, slots,
}: {
  meals: GroupMeal[];
  setMeals: (fn: (m: GroupMeal[]) => GroupMeal[]) => void;
  activeKey: string | null;
  setActiveKey: (key: string | null) => void;
  /** Every servable moment, across the days ahead. */
  slots: Date[];
}) {
  const [adding, setAdding] = useState(false);
  const [pickedDay, setPickedDay] = useState('');
  const [pickedTime, setPickedTime] = useState('');

  const taken = timesTaken(meals);
  // A day drops off the list only once every one of its times is booked.
  const byDay = slotsByDay(slots)
    .map((d) => ({ ...d, times: freeTimesOn(d.times, taken) }))
    .filter((d) => d.times.length > 0);
  const times = byDay.find((d) => d.key === pickedDay)?.times ?? [];

  /** Midday where the day offers it: a meal not said otherwise is lunch. */
  const middayOf = (list: Date[]) => list.find((t) => t.getHours() >= 12) ?? list[0];

  const open = () => {
    const first = byDay[0];
    setPickedDay(first?.key ?? '');
    setPickedTime(first ? (middayOf(first.times)?.toISOString() ?? '') : '');
    setAdding(true);
  };

  const add = () => {
    if (!pickedTime) return;
    const meal = newMeal(new Date(pickedTime));
    setMeals((all) => [...all, meal]);
    setActiveKey(meal.key);
    setAdding(false);
  };

  const ordered = [...meals].sort((a, b) => a.at.localeCompare(b.at));
  const active = ordered.find((m) => m.key === activeKey);

  return (
    <>
      <div className="cat-nav" style={{ gap: '0.4rem' }}>
        {ordered.map((m, i) => {
          const sameDayBefore = i > 0 && longDayWords(ordered[i - 1].at) === longDayWords(m.at);
          const n = portionsOn(m);
          return (
            <button key={m.key} className={m.key === activeKey ? 'on' : ''} onClick={() => setActiveKey(m.key)}>
              {/* The date once per day. Two sittings on one Tuesday read as
                  "Tuesday 14 · 12:30" then "· 19:00", which is how somebody
                  says it out loud. */}
              {!sameDayBefore && <>{longDayWords(m.at)}{' · '}</>}
              {timeWords(m.at)}
              {n > 0 && <> · {n}</>}
              {m.fulfilment === 'takeaway' && ' · packed'}
            </button>
          );
        })}
        {byDay.length > 0 && (
          <button onClick={open} style={{ fontWeight: 600 }}>+ Add a meal</button>
        )}
      </div>

      {/* Said above the menu, because a dish tapped with no meal chosen has
          nowhere to go and the reason has to be obvious before it happens. */}
      {active && (
        <div className="banner banner-info">
          <strong>Ordering for {longDayWords(active.at)}, {timeWords(active.at)}.</strong>{' '}
          {FULFILMENT_WORDS[active.fulfilment].toLowerCase()}. Tap another meal above to order for it instead.
        </div>
      )}

      {/*
        No times to offer at all.

        The times come from the venue's opening hours, so a venue whose hours
        have never been set can serve nobody and this screen could offer
        nothing. It used to say nothing either: no "add a meal" button, no
        reason, just a heading and a dead end. Said plainly instead, because
        the person reading it can either fix it or ring somebody who can.
      */}
      {slots.length === 0 && (
        <div className="banner banner-info">
          <strong>No times can be offered yet.</strong> This venue&rsquo;s opening hours have not been set, so
          there is nothing to book against. Please order at the counter, or ask the front desk.
        </div>
      )}

      {meals.length === 0 && slots.length > 0 && (
        <div className="banner banner-info">
          <strong>Booking for a group staying with us.</strong> Add a meal, choose what the group will eat at it,
          then add the next. Lunch and dinner on the same day are two meals, and each can be eaten here or
          packed to take away.
        </div>
      )}

      {adding && (
        <Modal
          title="Add a meal"
          onClose={() => setAdding(false)}
          footer={
            <Button variant="primary" onClick={add} disabled={!pickedTime} style={{ width: '100%' }}>
              Add this meal
            </Button>
          }
        >
          {byDay.length === 0 ? (
            <p className="meta">Every time we can serve is already on your booking.</p>
          ) : (
            <>
              <Field label="Which day?">
                <Select
                  value={pickedDay}
                  onChange={(e) => {
                    setPickedDay(e.target.value);
                    const day = byDay.find((d) => d.key === e.target.value);
                    setPickedTime(day ? (middayOf(day.times)?.toISOString() ?? '') : '');
                  }}
                >
                  {byDay.map((d) => (
                    <option key={d.key} value={d.key}>{d.label}</option>
                  ))}
                </Select>
              </Field>
              <Field
                label="What time?"
                hint="Add the same day again for a second sitting: lunch and dinner are two meals."
              >
                <Select value={pickedTime} onChange={(e) => setPickedTime(e.target.value)}>
                  {times.map((t) => (
                    <option key={t.toISOString()} value={t.toISOString()}>{timeWords(t)}</option>
                  ))}
                </Select>
              </Field>
              {/* Only the same moment twice is a duplicate, and the list above
                  already leaves those out; this catches a stale selection. */}
              {pickedTime && timeIsTaken(taken, new Date(pickedTime)) && (
                <Badge tone="warn">That time is already on the booking</Badge>
              )}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
