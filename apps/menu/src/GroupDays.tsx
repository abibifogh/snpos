import { useState } from 'react';
import { Button, Field, Modal, Select, Badge } from '@snpos/ui';
import { slotsByDay, daysTaken, dayKeyOf, portionsOn, FULFILMENT_WORDS, longDayWords, timeWords } from '@snpos/core';
import type { GroupDay } from '@snpos/core';
import { newDay } from './GroupSheet';

/**
 * Which day of the stay is being ordered for.
 *
 * A strip above the menu, because in group mode every dish tapped has to go
 * somewhere, and "somewhere" is a particular day. Without this the group
 * builds one pile of food and is asked at the end to sort it into nights,
 * which is the same work done twice and done worse.
 *
 * The days offered are the times the kitchen can actually serve, taken from
 * the same slot list the ordinary pre-order picker uses, so a booking can
 * never land on a day the restaurant is shut.
 */
export function GroupDays({
  days, setDays, activeKey, setActiveKey, slots,
}: {
  days: GroupDay[];
  setDays: (fn: (d: GroupDay[]) => GroupDay[]) => void;
  activeKey: string | null;
  setActiveKey: (key: string | null) => void;
  /** Every servable moment, across the days ahead. */
  slots: Date[];
}) {
  const [adding, setAdding] = useState(false);
  const [pickedDay, setPickedDay] = useState('');
  const [pickedTime, setPickedTime] = useState('');

  const byDay = slotsByDay(slots);
  const taken = daysTaken(days);
  const free = byDay.filter((d) => !taken.has(d.key));
  const times = byDay.find((d) => d.key === pickedDay)?.times ?? [];

  const open = () => {
    const first = free[0];
    setPickedDay(first?.key ?? '');
    // Midday where the day offers it, because a group booking that is not
    // said otherwise is lunch far more often than it is breakfast.
    const noon = first?.times.find((t) => t.getHours() >= 12) ?? first?.times[0];
    setPickedTime(noon?.toISOString() ?? '');
    setAdding(true);
  };

  const add = () => {
    if (!pickedTime) return;
    const day = newDay(new Date(pickedTime));
    setDays((all) => [...all, day]);
    setActiveKey(day.key);
    setAdding(false);
  };

  const ordered = [...days].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <>
      <div className="cat-nav" style={{ gap: '0.4rem' }}>
        {ordered.map((d) => {
          const on = d.key === activeKey;
          const n = portionsOn(d);
          return (
            <button key={d.key} className={on ? 'on' : ''} onClick={() => setActiveKey(d.key)}>
              {longDayWords(d.at)}
              {' · '}
              {timeWords(d.at)}
              {n > 0 && <> · {n}</>}
              {d.fulfilment === 'takeaway' && ' · packed'}
            </button>
          );
        })}
        {free.length > 0 && (
          <button onClick={open} style={{ fontWeight: 600 }}>+ Add a day</button>
        )}
      </div>

      {/* Said once, above the menu, because a dish tapped with no day chosen
          has nowhere to go and the reason has to be obvious before it happens. */}
      {days.length > 0 && activeKey && (
        <div className="banner banner-info">
          <strong>
            Ordering for {longDayWords(ordered.find((d) => d.key === activeKey)?.at ?? new Date())}.
          </strong>{' '}
          {FULFILMENT_WORDS[ordered.find((d) => d.key === activeKey)?.fulfilment ?? 'dine_in'].toLowerCase()}
          . Tap another day above to order for it instead.
        </div>
      )}

      {days.length === 0 && (
        <div className="banner banner-info">
          <strong>Booking for a group staying with us.</strong> Add a day, choose what the group will eat on it,
          then add the next day. Each day can be eaten here or packed to take away.
        </div>
      )}

      {adding && (
        <Modal
          title="Add a day"
          onClose={() => setAdding(false)}
          footer={
            <Button variant="primary" onClick={add} disabled={!pickedTime} style={{ width: '100%' }}>
              Add this day
            </Button>
          }
        >
          {free.length === 0 ? (
            <p className="meta">Every day we can serve is already on your booking.</p>
          ) : (
            <>
              <Field label="Which day?">
                <Select
                  value={pickedDay}
                  onChange={(e) => {
                    setPickedDay(e.target.value);
                    const day = byDay.find((d) => d.key === e.target.value);
                    const noon = day?.times.find((t) => t.getHours() >= 12) ?? day?.times[0];
                    setPickedTime(noon?.toISOString() ?? '');
                  }}
                >
                  {free.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                </Select>
              </Field>
              <Field label="What time?" hint="When the group would like to eat. The kitchen is told in time to cook it.">
                <Select value={pickedTime} onChange={(e) => setPickedTime(e.target.value)}>
                  {times.map((t) => (
                    <option key={t.toISOString()} value={t.toISOString()}>
                      {timeWords(t)}
                    </option>
                  ))}
                </Select>
              </Field>
              {taken.has(dayKeyOf(pickedTime || new Date())) && (
                <Badge tone="warn">That day is already on the booking</Badge>
              )}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
