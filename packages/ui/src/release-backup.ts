import { useEffect, useRef } from 'react';
import { releaseOverdue } from '@snpos/core';

/**
 * The backup for pre-order release, run by any open till or kitchen screen.
 *
 * Once a minute, and when the screen comes back into view, it releases every
 * pre-order still waiting two minutes past its start time: the server should
 * have, and has not. The order records which screen sent it, and the screen
 * says so. See preorders.ts.
 */
export function useReleaseBackup(venueId: string | undefined, by: string, onReleased: (orderNos: string[]) => void, on = true) {
  const tell = useRef(onReleased);
  tell.current = onReleased;
  useEffect(() => {
    if (!venueId || !on) return undefined;
    let busy = false;
    const look = async () => {
      if (busy || document.visibilityState === 'hidden') return;
      busy = true;
      try {
        const sent = await releaseOverdue(venueId, by);
        if (sent.length) tell.current(sent);
      } catch {
        // Offline, most likely. The next minute tries again.
      } finally {
        busy = false;
      }
    };
    void look();
    const timer = window.setInterval(() => void look(), 60_000);
    const visible = () => void look();
    document.addEventListener('visibilitychange', visible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [venueId, by, on]);
}
