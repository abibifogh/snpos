import { useEffect, useRef, useState } from 'react';
import {
  clockFace, shouldSleep, msUntilSleep, wakeLabel, IDLE_MINUTES_MIN, downloadUrl,
} from '@snpos/core';
import type { Settings } from '@snpos/core';
import { Logo } from './logo';

/**
 * The clock a till shows when nobody is using it.
 *
 * A counter left on a bright menu all evening burns the panel and tells the
 * room nothing. Between customers what it should show is the time, big enough
 * to read across a room, and one obvious way back in.
 *
 * The half that matters is waking. A till is not idle because the cashier has
 * not touched it, it is idle because NOTHING is happening — so an order
 * arriving wakes it even though nobody touched the glass. A screen that only
 * woke on touch would hide the one thing it exists to show, and a ticket would
 * sit behind a clock until somebody wandered past.
 */
export function IdleScreen({
  settings,
  afterMinutes,
  hasOpenShift,
  module,
  busy,
  wakeSignal,
  onWake,
}: {
  settings?: Settings | null;
  /** Minutes of quiet before it appears. 0 turns it off. */
  afterMinutes: number;
  hasOpenShift: boolean;
  module?: string;
  /** Something is part-way through — a payment sheet, an open bill — so do not cover it. */
  busy?: boolean;
  /**
   * Bumped by the app whenever an order arrives.
   *
   * A number rather than a subscription of its own, because the app already
   * knows when its data changed, and a second subscription here would be a
   * second, slightly different idea of what "an order arrived" means.
   */
  wakeSignal?: number;
  onWake?: () => void;
}) {
  const [asleep, setAsleep] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const lastActive = useRef(Date.now());

  const wake = () => {
    lastActive.current = Date.now();
    setAsleep((was) => {
      if (was) onWake?.();
      return false;
    });
  };

  // Anything a person does counts, listened for on the window rather than on
  // this element: when it is not showing there is nothing here to touch, and
  // the point is to notice activity everywhere else on the screen.
  useEffect(() => {
    if (!(afterMinutes >= IDLE_MINUTES_MIN)) return undefined;
    const seen = () => { lastActive.current = Date.now(); };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, seen, { passive: true });
    return () => { for (const e of events) window.removeEventListener(e, seen); };
  }, [afterMinutes]);

  // An order arriving is activity, whoever caused it.
  useEffect(() => {
    if (wakeSignal === undefined) return;
    wake();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wakeSignal]);

  /*
    One timer, re-armed, rather than a poll every second.

    A till is a device that stays on for fourteen hours. A second-by-second
    check that does nothing 50,000 times is the kind of thing that turns up
    later as a tablet that gets hot and a battery that does not last a shift.
  */
  useEffect(() => {
    if (!(afterMinutes >= IDLE_MINUTES_MIN) || asleep) return undefined;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const state = { lastActiveAt: lastActive.current, afterMinutes, busy };
      if (shouldSleep(state, Date.now())) { setAsleep(true); return; }
      // Being busy has no deadline of its own, so look again shortly rather
      // than sleeping the moment a payment sheet closes an hour from now.
      timer = setTimeout(check, Math.max(1_000, Math.min(msUntilSleep(state, Date.now()), 60_000)));
    };
    timer = setTimeout(check, 1_000);
    return () => clearTimeout(timer);
  }, [afterMinutes, asleep, busy]);

  // The clock only ticks while it is up. Nothing is reading it otherwise.
  useEffect(() => {
    if (!asleep) return undefined;
    const tick = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(tick);
  }, [asleep]);

  if (!asleep) return null;

  const face = clockFace(now, settings?.timezone);

  return (
    <div
      className="idle"
      role="button"
      tabIndex={0}
      aria-label="Screen asleep. Touch anywhere to go back."
      onPointerDown={wake}
      onKeyDown={wake}
    >
      <div className="idle-top">
        <div className="idle-clock">{face.time}</div>
        <div className="idle-date">
          <div>{face.day}</div>
          <div>{face.date}</div>
        </div>
      </div>

      <div className="idle-mark">
        {/* The shop's own mark where it has one, ours where it does not. A
            screen sitting on a wall all evening is the wrong place to
            advertise the software. */}
        {settings?.logo_light_id
          ? <img src={downloadUrl(settings.logo_light_id, 'branding', settings)} alt={settings.restaurant_name ?? ''} />
          : <Logo size={56} />}
      </div>

      <button type="button" className="idle-card" onClick={wake}>
        <svg viewBox="0 0 24 24" width="52" height="52" aria-hidden="true" fill="none"
          stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8h18l-1.6 10.2a2 2 0 0 1-2 1.8H6.6a2 2 0 0 1-2-1.8Z" />
          <path d="M8 8V6a4 4 0 0 1 8 0v2" />
          <path d="M9 12v4M12 12v4M15 12v4" />
        </svg>
        <span>{wakeLabel(hasOpenShift, module)}</span>
      </button>

      <div className="idle-foot">{settings?.restaurant_name ?? ''}</div>
    </div>
  );
}
