import { useState } from 'react';
import { EXTEND_CHOICES, EXTEND_MAX_HOURS, extendProblem, extendShift, shiftLimit, shiftAgeOf } from '@snpos/core';
import type { Shift } from '@snpos/core';
import { Button, Field, Modal, Notice, Textarea } from './components';

/**
 * Give one open shift more time before it stops taking money.
 *
 * For an admin or a manager, with a reason. Who gave it, when and why go on
 * the shift, so whoever reads it later knows why it ran past a day. Every
 * other shift still stops at a day.
 */
export function ExtendShiftModal({ shift, role, by, byName, onClose, onDone }: {
  shift: Shift;
  role?: string | null;
  by: string;
  byName: string;
  onClose: () => void;
  onDone: (shift: Shift, words: string) => void;
}) {
  const had = Math.max(0, Math.round(Number(shift.extended_hours) || 0));
  const left = EXTEND_MAX_HOURS - had;
  const [hours, setHours] = useState<number>(EXTEND_CHOICES.find((h) => h <= left) ?? 0);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const age = shiftAgeOf(shift);
  const problem = extendProblem({ shift, hours, reason, role });

  const save = async () => {
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      const next = await extendShift({ shiftId: shift.$id, hours, reason, by, byName, role });
      const until = new Date(new Date(shift.opened_at).getTime() + shiftLimit(next) * 3_600_000);
      onDone(next, `${shift.code} can take money until ${until.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Give ${shift.code} more time`}
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={left <= 0 || !hours} onClick={() => void save()}>
            Give {hours} more hours
          </Button>
        </>
      )}
    >
      <p style={{ marginTop: 0 }}>
        Open for {Math.floor(age.hours)} hours. A shift stops taking money after {shiftLimit(shift)} hours
        {had ? `, ${had} of them already given` : ''}. Closing it and opening a new one is usually better: it keeps each
        day&rsquo;s takings in their own drawer.
      </p>
      {left <= 0 ? (
        <Notice tone="warn">This shift has had all the extra time it can have. Close it and open a new one.</Notice>
      ) : (
        <>
          <Field label="How much more time">
            <div className="row row-wrap" role="group" aria-label="How much more time" style={{ gap: '0.4rem' }}>
              {EXTEND_CHOICES.map((h) => (
                <Button
                  key={h}
                  size="sm"
                  variant={hours === h ? 'primary' : 'default'}
                  aria-pressed={hours === h}
                  disabled={h > left}
                  onClick={() => setHours(h)}
                >
                  {h} hours
                </Button>
              ))}
            </div>
          </Field>
          <Field label="Why" hint="Kept on the shift with your name.">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="A private event running late, say." autoFocus />
          </Field>
        </>
      )}
      {error && <Notice>{error}</Notice>}
    </Modal>
  );
}
