import { useState } from 'react';
import { Button, Field, Modal, Input, Notice } from '@snpos/ui';
import {
  timesTaken, timeIsTaken, portionsOn, mealMoment, momentProblem, dayInput, timeInput,
  BOOKING_OPENS, BOOKING_CLOSES, mealServiceWords, longDayWords, timeWords,
} from '@snpos/core';
import type { GroupMeal } from '@snpos/core';
import { newMeal } from './GroupSheet';

/** Today, as the date box wants it, so nobody books yesterday. */
const todayInput = () => dayInput(new Date());

/**
 * Which meal of the stay is being ordered for.
 *
 * A party staying four nights eats eight times, and every dish tapped has to
 * belong to one particular sitting. Lunch on the terrace and dinner in the
 * restaurant on the same Tuesday are two of them: cooked hours apart, and one
 * may be packed for an excursion while the other is not. So the same date can
 * appear twice and only the same TIME twice is refused.
 *
 * Written as a list of what has been booked so far, rather than as a row of
 * chips. The chips were compact and read as decoration — the button that adds
 * a meal looked like one more tab, and the way to take a meal off was inside
 * a sheet two taps away. Both are the whole job, so both are ordinary buttons
 * that say what they do, in the place somebody is looking when they want
 * them.
 *
 * Any date, and any time the kitchen could serve: see BOOKING_OPENS. A group
 * booking is an arrangement made in advance, not a slot in today's service.
 */
export function GroupDays({
  meals, setMeals, activeKey, setActiveKey,
}: {
  meals: GroupMeal[];
  setMeals: (fn: (m: GroupMeal[]) => GroupMeal[]) => void;
  activeKey: string | null;
  setActiveKey: (key: string | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [day, setDay] = useState('');
  const [time, setTime] = useState('');

  const taken = timesTaken(meals);
  const picked = mealMoment(day, time);
  // Said before the button is pressed, so nothing is refused after the fact.
  const wrong = picked && timeIsTaken(taken, picked)
    ? 'That day and time is already on your booking. Pick another time for a second sitting.'
    : momentProblem(picked);

  const open = () => {
    /*
      Opens on the next round hour, tomorrow. A group booking is almost never
      for the next twenty minutes, and a box that starts blank is a box that
      has to be filled in twice before anything happens.
    */
    const start = new Date();
    start.setDate(start.getDate() + 1);
    start.setHours(12, 0, 0, 0);
    setDay(dayInput(start));
    setTime(timeInput(start));
    setAdding(true);
  };

  const add = () => {
    if (!picked || wrong) return;
    const meal = newMeal(picked);
    setMeals((all) => [...all, meal]);
    setActiveKey(meal.key);
    setAdding(false);
  };

  const drop = (meal: GroupMeal) => {
    if (portionsOn(meal) > 0
      && !confirm(`Take ${longDayWords(meal.at)}, ${timeWords(meal.at)} off the booking? What is on it will be lost.`)) {
      return;
    }
    setMeals((all) => {
      const left = all.filter((m) => m.key !== meal.key);
      if (activeKey === meal.key) setActiveKey(left[0]?.key ?? null);
      return left;
    });
  };

  const ordered = [...meals].sort((a, b) => a.at.localeCompare(b.at));
  const active = ordered.find((m) => m.key === activeKey);

  return (
    <>
      <div className="group-plan">
        {ordered.length > 0 && <h2 className="group-plan-title">Your booking</h2>}

        {ordered.map((m) => {
          const n = portionsOn(m);
          const on = m.key === activeKey;
          return (
            <div key={m.key} className={`group-meal${on ? ' on' : ''}`}>
              {/* The card itself chooses the meal, so ordering for a different
                  sitting is one tap on the thing you are reading. */}
              <button
                type="button"
                className="group-meal-pick"
                aria-pressed={on}
                onClick={() => setActiveKey(m.key)}
              >
                <span className="group-meal-when">{longDayWords(m.at)}, {timeWords(m.at)}</span>
                <span className="group-meal-what">
                  {n === 0 ? 'Nothing on it yet' : `${n} portion${n === 1 ? '' : 's'}`}
                  {' · '}
                  {mealServiceWords(m).toLowerCase()}
                </span>
              </button>
              {/* Plainly a button, plainly next to the meal it removes. It
                  used to be a faint word inside the booking sheet. */}
              <Button variant="danger" size="sm" onClick={() => drop(m)}>Remove</Button>
            </div>
          );
        })}

        {/* Full width and primary. This is the first thing anybody has to do
            and it used to look like one more tab in a row of tabs. */}
        <Button variant="primary" onClick={open} style={{ width: '100%' }}>
          + Add {ordered.length === 0 ? 'a meal' : 'another meal'}
        </Button>
      </div>

      {meals.length === 0 && (
        <Notice tone="info">
          <strong>Booking for a group.</strong> Add a meal and say when the group will eat it, then choose
          their food from the menu below. Lunch and dinner on the same day are two meals.
        </Notice>
      )}

      {/* Said above the menu, because a dish tapped with no meal chosen has
          nowhere to go and the reason has to be obvious before it happens. */}
      {active && (
        <div className="banner banner-info">
          <strong>Choosing food for {longDayWords(active.at)}, {timeWords(active.at)}.</strong>{' '}
          Tap another meal above to order for that one instead.
        </div>
      )}

      {adding && (
        <Modal
          title="Add a meal"
          onClose={() => setAdding(false)}
          footer={
            <Button variant="primary" onClick={add} disabled={!!wrong} style={{ width: '100%' }}>
              Add this meal
            </Button>
          }
        >
          <Field label="Which day?" hint="Any day from today onwards.">
            <Input
              type="date"
              value={day}
              min={todayInput()}
              onChange={(e) => setDay(e.target.value)}
            />
          </Field>
          <Field
            label="What time?"
            hint={`Any time between ${BOOKING_OPENS} and ${BOOKING_CLOSES}. Add the same day again for a second sitting: lunch and dinner are two meals.`}
          >
            <Input
              type="time"
              value={time}
              min={BOOKING_OPENS}
              max={BOOKING_CLOSES}
              step={300}
              onChange={(e) => setTime(e.target.value)}
            />
          </Field>
          {/* The boxes' own limits are a hint to the widget and are ignored by
              anybody typing into them, so the rule is said here as well. */}
          {wrong && <Notice tone="warn">{wrong}</Notice>}
        </Modal>
      )}
    </>
  );
}
