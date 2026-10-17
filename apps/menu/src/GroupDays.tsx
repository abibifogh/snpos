import { useState } from 'react';
import { Button, Field, Modal, Input, Notice } from '@snpos/ui';
import {
  timesTaken, timeIsTaken, portionsOn, mealMoment, momentProblem, dayInput, timeInput,
  BOOKING_OPENS, BOOKING_CLOSES, mealServiceWords, longDayWords, timeWords, packWords, formatMoney,
  FULFILMENT_WORDS, SERVICE_WORDS, SERVICE_HINTS,
} from '@snpos/core';
import type { GroupMeal, Fulfilment, ServiceStyle, Settings } from '@snpos/core';
import { newMeal } from './GroupSheet';

/** Today, as the date box wants it, so nobody books yesterday. */
const todayInput = () => dayInput(new Date());

/**
 * The three steps of a group booking, said at the top of every group screen.
 *
 * Add meal times, choose the food, check and send. A party booking four days
 * of meals is doing a job with a shape, and showing the shape is what tells
 * them they are on step two of three rather than somewhere in a long form.
 */
export function GroupSteps({ at }: { at: 1 | 2 | 3 }) {
  const steps = ['Meal times', 'Food', 'Check & send'];
  return (
    <ol className="group-steps" aria-label="Booking steps">
      {steps.map((s, i) => {
        const n = i + 1;
        return (
          <li key={s} className={n === at ? 'on' : n < at ? 'done' : ''} aria-current={n === at ? 'step' : undefined}>
            <span className="group-step-n">{n < at ? '✓' : n}</span> {s}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The meal times on the booking, and the way to add one.
 *
 * A "meal time" everywhere, never a "sitting" and never a bare "meal": the
 * button once said "Add a meal", and the first person outside this office to
 * try it read it as "add a meal from the menu", tapped a dish, and reported
 * the button broken. A meal time is plainly a time.
 *
 * Where they will eat it is asked HERE, with the day and the time, rather
 * than at the end. It is the choice that adds a packing charge and changes
 * the kitchen's work, and asked last it was the one most often left on its
 * default. Plated or buffet comes with it, only for a meal eaten here.
 *
 * A list of cards rather than a row of chips: as chips they read as tabs, and
 * the add button looked like one more tab.
 */
export function GroupDays({
  meals, setMeals, activeKey, setActiveKey, settings, packFee,
}: {
  meals: GroupMeal[];
  setMeals: (fn: (m: GroupMeal[]) => GroupMeal[]) => void;
  activeKey: string | null;
  setActiveKey: (key: string | null) => void;
  settings: Settings;
  /** What packing costs a portion, from Features. Zero when nothing is charged. */
  packFee: number;
}) {
  /** The meal time being changed, or 'new' while one is being added. */
  const [editing, setEditing] = useState<string | null>(null);
  const [day, setDay] = useState('');
  const [time, setTime] = useState('');
  const [where, setWhere] = useState<Fulfilment>('dine_in');
  const [served, setServed] = useState<ServiceStyle>('plated');
  const money = (n: number) => formatMoney(n, settings);

  // Its own time is not a clash when a meal time is being changed.
  const others = meals.filter((m) => m.key !== editing);
  const picked = mealMoment(day, time);
  const wrong = picked && timeIsTaken(timesTaken(others), picked)
    ? 'That day and time is already on your booking. Pick another time.'
    : momentProblem(picked);

  const openNew = () => {
    /*
      Opens on noon tomorrow. A group booking is almost never for the next
      twenty minutes, and a box that starts blank has to be filled in twice.
    */
    const start = new Date();
    start.setDate(start.getDate() + 1);
    start.setHours(12, 0, 0, 0);
    setDay(dayInput(start));
    setTime(timeInput(start));
    setWhere('dine_in');
    setServed('plated');
    setEditing('new');
  };

  const openChange = (m: GroupMeal) => {
    setDay(dayInput(m.at));
    setTime(timeInput(new Date(m.at)));
    setWhere(m.fulfilment);
    setServed(m.service ?? 'plated');
    setEditing(m.key);
  };

  const save = () => {
    if (!picked || wrong) return;
    const service = where === 'dine_in' ? served : undefined;
    if (editing === 'new') {
      const meal = { ...newMeal(picked), fulfilment: where, service };
      setMeals((all) => [...all, meal]);
      setActiveKey(meal.key);
    } else {
      setMeals((all) => all.map((m) => (m.key === editing
        ? { ...m, at: picked.toISOString(), fulfilment: where, service }
        : m)));
    }
    setEditing(null);
  };

  const drop = (meal: GroupMeal) => {
    if (portionsOn(meal) > 0
      && !confirm(`Remove ${longDayWords(meal.at)}, ${timeWords(meal.at)} from the booking? The food on it goes too.`)) {
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
        <GroupSteps at={meals.length === 0 ? 1 : 2} />

        {meals.length === 0 && (
          <Notice tone="info">
            <strong>Booking for a group.</strong> Start with when the group will eat: the day, the time, and
            whether they eat here or take it packed. Then choose their food from the menu below. Lunch and
            dinner on the same day are two meal times.
          </Notice>
        )}

        {ordered.length > 0 && <h2 className="group-plan-title">Your meal times</h2>}

        {ordered.map((m) => {
          const n = portionsOn(m);
          const on = m.key === activeKey;
          return (
            <div key={m.key} className={`group-meal${on ? ' on' : ''}`}>
              {/* The card itself chooses the meal time, so ordering for a
                  different one is one tap on the thing you are reading. */}
              <button
                type="button"
                className="group-meal-pick"
                aria-pressed={on}
                onClick={() => setActiveKey(m.key)}
              >
                <span className="group-meal-when">{longDayWords(m.at)}, {timeWords(m.at)}</span>
                <span className="group-meal-what">
                  {mealServiceWords(m)} · {n === 0 ? 'no food yet' : `${n} portion${n === 1 ? '' : 's'}`}
                </span>
              </button>
              <Button size="sm" variant="ghost" onClick={() => openChange(m)}>Change</Button>
              <Button variant="ghost" size="sm" className="remove-quiet" onClick={() => drop(m)}>Remove</Button>
            </div>
          );
        })}

        <Button variant={meals.length === 0 ? 'primary' : undefined} onClick={openNew} style={{ width: '100%' }}>
          {ordered.length === 0 ? '+ Add a meal time' : '+ Add another meal time'}
        </Button>
      </div>

      {/* Said above the menu, because a dish tapped with nowhere to go is the
          fault this page keeps having, and the reason has to be on screen
          BEFORE it happens rather than in a message afterwards. */}
      {active ? (
        <div className="banner banner-info">
          <strong>Adding food to {longDayWords(active.at)}, {timeWords(active.at)} · {mealServiceWords(active)}.</strong>{' '}
          {ordered.length > 1 ? 'Tap another meal time above to add food to that one.' : ''}
        </div>
      ) : (
        <div className="banner banner-warn">
          <strong>Add a meal time first.</strong> The menu below opens once the booking has one.
        </div>
      )}

      {editing && (
        <Modal
          title={editing === 'new' ? 'Add a meal time' : 'Change this meal time'}
          onClose={() => setEditing(null)}
          footer={
            <Button variant="primary" onClick={save} disabled={!!wrong} style={{ width: '100%' }}>
              {editing === 'new' ? 'Add meal time' : 'Save'}
            </Button>
          }
        >
          <Field label="Day" hint="Any day from today onwards.">
            <Input type="date" value={day} min={todayInput()} onChange={(e) => setDay(e.target.value)} />
          </Field>
          <Field label="Time" hint={`Any time from ${BOOKING_OPENS} to ${BOOKING_CLOSES}.`}>
            <Input
              type="time"
              value={time}
              min={BOOKING_OPENS}
              max={BOOKING_CLOSES}
              step={300}
              onChange={(e) => setTime(e.target.value)}
            />
          </Field>
          {/* The boxes' own limits are ignored by anybody typing, so the rule
              is said here as well. */}
          {wrong && <Notice tone="warn">{wrong}</Notice>}

          <Field label="Where will they eat?">
            <div className="choice-pair" role="radiogroup" aria-label="Where will they eat?">
              <button type="button" role="radio" aria-checked={where === 'dine_in'} className={where === 'dine_in' ? 'on' : ''} onClick={() => setWhere('dine_in')}>
                <strong>{FULFILMENT_WORDS.dine_in}</strong>
                <span>At the restaurant</span>
              </button>
              <button type="button" role="radio" aria-checked={where === 'takeaway'} className={where === 'takeaway' ? 'on' : ''} onClick={() => setWhere('takeaway')}>
                <strong>{FULFILMENT_WORDS.takeaway}</strong>
                <span>{packFee > 0 ? packWords(packFee, money) : 'Boxed to take away'}</span>
              </button>
            </div>
          </Field>

          {/* Plated or buffet is the same food and two different days of work,
              and only a meal eaten here has the question. */}
          {where === 'dine_in' && (
            <Field label="How should it be served?">
              <div className="choice-pair" role="radiogroup" aria-label="How should it be served?">
                {(['plated', 'buffet'] as const).map((s) => (
                  <button key={s} type="button" role="radio" aria-checked={served === s} className={served === s ? 'on' : ''} onClick={() => setServed(s)}>
                    <strong>{SERVICE_WORDS[s]}</strong>
                    <span>{SERVICE_HINTS[s]}</span>
                  </button>
                ))}
              </div>
            </Field>
          )}
          <p className="meta" style={{ margin: 0 }}>Lunch and dinner on the same day are two meal times.</p>
        </Modal>
      )}
    </>
  );
}
