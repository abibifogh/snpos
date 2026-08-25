import { useEffect, useRef, useState } from 'react';
import {
  clockFace, shouldSleep, msUntilSleep, wakeLabel, IDLE_MINUTES_MIN, downloadUrl,
  verifyPin, unlockers, pushDigit, dropDigit, worthChecking, waitAfter, lockMessage,
} from '@snpos/core';
import type { Settings, Unlocker } from '@snpos/core';
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
  locked,
  staff,
  firstUse,
  onUnlock,
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
  /**
   * Locked on purpose, rather than asleep from disuse.
   *
   * The two wear the same face and are entirely different doors. Asleep is a
   * screensaver: it keeps a bright menu off the panel and any touch dismisses
   * it. Locked is somebody stepping away from an open shift with a drawer
   * under it, and getting back in costs a PIN.
   */
  locked?: boolean;
  /** Who could open it again. Anybody with a PIN, not only whoever locked it. */
  staff?: Unlocker[];
  /**
   * Nobody has identified themselves on this device yet.
   *
   * The same pad, and a different sentence. "Enter your PIN to carry on" is
   * right for somebody coming back to a till they locked; on the first screen
   * of the day it reads as though something has gone wrong, when all that has
   * happened is the till asking who is there.
   */
  firstUse?: boolean;
  /**
   * Opened, and BY WHOM.
   *
   * The person who types the PIN is the person now standing at the till, and
   * that used to be thrown away — the door opened and the till carried on as
   * whoever had signed into it that morning. So a bartender letting themselves
   * back in got a screen with the manager's reach on it, which is the opposite
   * of what a PIN is for.
   */
  onUnlock?: (who?: Unlocker) => void;
}) {
  const [asleep, setAsleep] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const lastActive = useRef(Date.now());

  /** What has been typed on the pad, and how it has been going. */
  const [entry, setEntry] = useState('');
  const [wrong, setWrong] = useState(0);
  const [waitUntil, setWaitUntil] = useState(0);
  const [checking, setChecking] = useState(false);

  /*
    Mirrored in a ref so waking can read it without going stale.

    The window listeners below are registered once and would close over
    whatever `asleep` was at the time. The old way round that was to call
    onWake from inside the setState updater — a function React is entitled to
    run more than once and expects to do nothing but return the next value, so
    the one thing this screen exists for was riding on an implementation
    detail.
  */
  const asleepRef = useRef(false);
  useEffect(() => { asleepRef.current = asleep; }, [asleep]);

  const wake = () => {
    lastActive.current = Date.now();
    if (!asleepRef.current) return;
    asleepRef.current = false;
    setAsleep(false);
    onWake?.();
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
    if (!asleep && !locked) return undefined;
    const tick = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(tick);
  }, [asleep, locked]);

  /*
    The pad is cleared when the door closes, not when it opens.

    Leaving half a PIN on screen from last time is both a hint and a
    confusion — somebody types four more digits onto two that are already
    there and is told they got it wrong.
  */
  useEffect(() => {
    if (!locked) { setEntry(''); setWrong(0); setWaitUntil(0); }
  }, [locked]);

  /** Counts down the wait after wrong guesses, so the pad re-enables itself. */
  useEffect(() => {
    if (waitUntil <= Date.now()) return undefined;
    const t = setTimeout(() => setNow(new Date()), waitUntil - Date.now() + 50);
    return () => clearTimeout(t);
  }, [waitUntil, now]);

  const waitingMs = Math.max(0, waitUntil - now.getTime());

  const tryUnlock = async (pin: string) => {
    if (waitingMs > 0 || checking) return;
    setChecking(true);
    try {
      /*
        Against everybody who has a PIN, not against one person.

        A till is a place. Whoever comes back to it is often the next one on,
        and a lock only its locker could open gets worked around by not
        locking it. See unlockers.
      */
      for (const person of unlockers(staff ?? [])) {
        if (await verifyPin(pin, person.pin_hash)) {
          setEntry('');
          setWrong(0);
          onUnlock?.(person);
          return;
        }
      }
      const tries = wrong + 1;
      setWrong(tries);
      setEntry('');
      const wait = waitAfter(tries);
      if (wait > 0) setWaitUntil(Date.now() + wait);
    } finally {
      setChecking(false);
    }
  };

  const type = (digit: string) => {
    if (waitingMs > 0) return;
    const next = pushDigit(entry, digit);
    setEntry(next);
    // Checked as it reaches a length that could match, so a correct PIN opens
    // the till without also needing somebody to find an Enter key.
    if (worthChecking(next)) void tryUnlock(next);
  };

  if (locked) {
    const face = clockFace(now, settings?.timezone);
    const note = lockMessage({ wrongTries: wrong, waitingMs });
    return (
      <div className="idle idle-locked">
        <div className="idle-top">
          <div className="idle-clock">{face.time}</div>
          <div className="idle-date">
            <div>{face.day}</div>
            <div>{face.date}</div>
          </div>
        </div>

        <div className="idle-mark">
          {settings?.logo_light_id
            ? <img src={downloadUrl(settings.logo_light_id, 'branding', settings)} alt={settings.restaurant_name ?? ''} />
            : <Logo size={56} />}
        </div>

        <div className="lock-pad">
          <div className="lock-title">{firstUse ? 'Who is on the till?' : 'Locked'}</div>
          <div className="lock-sub">
            {firstUse
              ? 'Enter your PIN to start. Everything rung up goes under your name until the till is locked again.'
              : 'Enter your PIN to carry on'}
          </div>

          {/* Dots rather than the digits. A till is at chest height on a
              counter with a queue in front of it. */}
          <div className="lock-dots" aria-label={`${entry.length} digits entered`}>
            {Array.from({ length: Math.max(4, entry.length) }, (_, i) => (
              <span key={i} className={i < entry.length ? 'on' : ''} />
            ))}
          </div>

          {note && <div className="lock-note">{note}</div>}

          <div className="lock-keys">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button key={d} type="button" onClick={() => type(d)} disabled={waitingMs > 0}>{d}</button>
            ))}
            <button type="button" onClick={() => setEntry('')} disabled={waitingMs > 0}>Clear</button>
            <button type="button" onClick={() => type('0')} disabled={waitingMs > 0}>0</button>
            <button
              type="button"
              onClick={() => setEntry(dropDigit(entry))}
              disabled={waitingMs > 0}
              aria-label="Delete the last digit"
            >
              ⌫
            </button>
          </div>
        </div>

        <div className="idle-foot">{settings?.restaurant_name ?? ''}</div>
      </div>
    );
  }

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
