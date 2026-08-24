import { useEffect } from 'react';

/**
 * Keep a screen awake.
 *
 * A tablet on a counter dims and then sleeps on its own, and a dark screen is
 * a screen nobody walks up to. Worse than useless: it looks like the thing is
 * broken or switched off, so people go and queue at the counter instead, and
 * the display quietly stops earning its place.
 *
 * Only for a screen the restaurant owns. Holding a customer's phone awake
 * while they read a menu would flatten a battery they need for the rest of
 * their evening, to solve a problem they do not have.
 *
 * The browser drops the lock whenever the tab is hidden — switching apps,
 * locking the tablet by hand, another window coming forward — and does NOT
 * give it back on its own. So it is taken again every time the page becomes
 * visible, which is the difference between a screen that stays awake all day
 * and one that stays awake until somebody first touches the home button.
 *
 * Silent when unsupported. Wake Lock needs a secure origin and a recent
 * browser; where it is missing the screen behaves as it always did, and the
 * counter can fall back to the tablet's own "never sleep" setting.
 */
export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined;

    type Sentinel = {
      release: () => Promise<void>;
      released: boolean;
      addEventListener?: (type: 'release', fn: () => void) => void;
    };
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<Sentinel> };
    };
    if (!nav.wakeLock) return undefined;

    let sentinel: Sentinel | null = null;
    let alive = true;

    const take = async () => {
      // Only when the page can actually see the screen. Asking while hidden
      // is refused, and a refusal here would otherwise look like a fault.
      if (!alive || document.visibilityState !== 'visible') return;
      if (sentinel && !sentinel.released) return;
      try {
        const held = await nav.wakeLock!.request('screen');
        sentinel = held;
        /*
          THE LOCK IS TAKEN BACK WITHOUT THE PAGE BEING HIDDEN.

          A tab going to the background is only one of the ways this ends.
          Battery saver switching on, the panel dimming on a timer the browser
          honours, an OS deciding a foreground tab has been idle too long — all
          of them release the lock with the page still visible, so nothing
          fires visibilitychange and the screen simply goes dark ten minutes
          later. The specification has an event for exactly this; it was not
          being listened to, which is why a display that was awake all morning
          was asleep by lunchtime.
        */
        held.addEventListener?.('release', () => {
          sentinel = null;
          void take();
        });
      } catch {
        // Refused: battery saver, an unsupported build, a policy. Nothing to
        // be done and nothing worth showing a customer.
        sentinel = null;
      }
    };

    const onVisible = () => { if (document.visibilityState === 'visible') void take(); };

    void take();
    document.addEventListener('visibilitychange', onVisible);
    /*
      And a look every half minute regardless.

      A belt to the braces above, because the ways a wake lock can end quietly
      are a moving target across Android builds and browser versions, and the
      cost of being wrong is a dark screen for the rest of the day. Re-taking
      when one is already held costs nothing — see the guard at the top of
      take.
    */
    const retry = window.setInterval(() => void take(), 30_000);

    return () => {
      alive = false;
      window.clearInterval(retry);
      document.removeEventListener('visibilitychange', onVisible);
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => undefined);
    };
  }, [enabled]);
}
