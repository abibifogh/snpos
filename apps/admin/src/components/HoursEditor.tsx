import { Input, Toggle } from '@snpos/ui';
import type { DayKey, Windows } from '@snpos/core';

const DAYS: { key: DayKey; label: string }[] = [
  { key: 'mon', label: 'Monday' }, { key: 'tue', label: 'Tuesday' }, { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' }, { key: 'fri', label: 'Friday' }, { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
];

/**
 * Hours as one row per day.
 *
 * The underlying value is JSON, but nobody should have to type JSON to say
 * "we serve lunch from twelve".
 */
export function HoursEditor({
  value,
  onChange,
  emptyMeans = 'Available at all times',
}: {
  value: Windows;
  onChange: (w: Windows) => void;
  emptyMeans?: string;
}) {
  const setDay = (day: DayKey, open: boolean, from = '09:00', to = '22:00') => {
    const next = { ...value };
    if (open) next[day] = [[from, to]];
    else delete next[day];
    onChange(next);
  };

  const anySet = Object.keys(value).length > 0;

  return (
    <div>
      {DAYS.map(({ key, label }) => {
        const range = value[key]?.[0];
        return (
          <div className="row" key={key} style={{ padding: '0.35rem 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ width: '6.5rem', fontSize: '0.88rem' }}>{label}</div>
            <Toggle checked={!!range} onChange={(v) => setDay(key, v)} />
            {range ? (
              <>
                <Input type="time" value={range[0]} style={{ width: '7.5rem' }} onChange={(e) => setDay(key, true, e.target.value, range[1])} />
                <span className="dim">to</span>
                <Input type="time" value={range[1]} style={{ width: '7.5rem' }} onChange={(e) => setDay(key, true, range[0], e.target.value)} />
              </>
            ) : (
              <span className="dim small">{anySet ? 'Not available' : 'Closed'}</span>
            )}
          </div>
        );
      })}
      <p className="hint" style={{ marginTop: '0.7rem' }}>
        {anySet
          ? 'A closing time earlier than the opening time means past midnight — 18:00 to 02:00 is a valid late shift.'
          : `Nothing set: ${emptyMeans}.`}
      </p>
      {anySet && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({})} style={{ marginTop: '0.3rem' }}>
          Clear — make it always available
        </button>
      )}
    </div>
  );
}
