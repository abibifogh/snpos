import { useEffect, useState } from 'react';
import { myOpenCharges, owedWords, subscribeCollection } from '@snpos/core';
import type { StaffCharge } from '@snpos/core';
import { Notice } from './components';

/**
 * What the person at this till owes from counts charged to them.
 *
 * Only their own: each charge is readable by the person it is about and by
 * managers, nobody else. Says nothing when nothing is owed, and nothing when
 * it could not be read — telling somebody they owe nothing because a read
 * failed would be worse than silence. See staff-charges.ts.
 */
export function OwedNotice({ userId, money }: { userId: string; money: (n: number) => string }) {
  const [mine, setMine] = useState<StaffCharge[] | null>(null);

  useEffect(() => {
    let live = true;
    const read = () => { void myOpenCharges(userId).then((rows) => { if (live) setMine(rows); }); };
    read();
    // Charged or put right while they are working: say so without a reload.
    const off = subscribeCollection<StaffCharge>('staff_charges', (c) => {
      if (c.person_user_id === userId) read();
    });
    return () => { live = false; off(); };
  }, [userId]);

  const words = mine ? owedWords(mine, money) : null;
  if (!words) return null;
  return (
    <div style={{ padding: '0.4rem 1rem 0' }}>
      <Notice tone="warn">{words}</Notice>
    </div>
  );
}
