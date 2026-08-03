import { useEffect, useState } from 'react';

/**
 * How many writes are waiting to be sent, kept live.
 *
 * Lives in the UI package with the bar that displays it, but takes its
 * functions as arguments so this package still does not depend on core — the
 * app wires the two together.
 */
export function useOfflineQueue(
  onQueueChange: (fn: (n: number) => void) => () => void,
  startSync: () => () => void,
): number {
  const [queued, setQueued] = useState(0);
  useEffect(() => {
    const offCount = onQueueChange(setQueued);
    const stopSync = startSync();
    return () => {
      offCount();
      stopSync();
    };
  }, [onQueueChange, startSync]);
  return queued;
}
