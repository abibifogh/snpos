import { useEffect, useState } from 'react';
import { Button } from '@snpos/ui';
import { customerWait, formatWait } from '@snpos/core';

/**
 * How long the thank-you stays before the menu comes back.
 *
 * Twenty seconds. There is a real order number on this screen now, and ten
 * seconds is not long to read one, take it in and be sure of it while somebody
 * is also being handed change — which is the difference between a number
 * somebody remembers and a number they have to ask for again at the counter.
 *
 * Still short enough that the person behind is not waiting on a screen showing
 * the order of somebody who has already gone, and the way out is on screen the
 * whole time for anybody who is finished sooner.
 */
export const SCREEN_THANKS_MS = 20_000;

/**
 * What a shared ordering screen shows after an order is sent.
 *
 * Not the status page. That page is built for a phone: it follows one order
 * through to collection and stays on it, which is exactly right for the person
 * carrying it and exactly wrong for a tablet on a counter. On a screen the
 * next customer arrives within the minute, and what they must not find is a
 * stranger's order and a member of staff having to reset the thing between
 * every single sale.
 *
 * So this says thank you, gives the wait, counts itself down in the open, and
 * puts the menu back without being asked. The way out is still there for
 * anybody who is done reading before then.
 */
export function ScreenThanks({
  orderNo,
  etaMinutes,
  fromOpening,
  openingWaitMinutes,
  emailed,
  onDone,
}: {
  orderNo: string;
  /** What the kitchen quoted, queue included. Absent when nothing was worked out. */
  etaMinutes?: number;
  /** The wait runs from opening time, because the kitchen was shut. */
  fromOpening?: boolean;
  /** How much of it was the doors, so the kitchen's share can be capped. */
  openingWaitMinutes?: number;
  /**
   * Whether a notice will actually reach this customer.
   *
   * Only true when they gave an address AND the receipts feature is on, which
   * is what decides whether anything is sent at all. Promising an email to
   * somebody who will not get one is worse than promising nothing: they stop
   * watching the counter and wait for a message that is not coming.
   */
  emailed: boolean;
  onDone: () => void;
}) {
  const [left, setLeft] = useState(Math.round(SCREEN_THANKS_MS / 1000));

  useEffect(() => {
    /**
     * One clock, counting real time.
     *
     * Driven by the wall clock rather than by adding up ticks, because a
     * tablet that sleeps or throttles a background tab stops firing them, and
     * a screen that came back showing "22" for ever would need the very
     * intervention this exists to avoid.
     */
    const until = Date.now() + SCREEN_THANKS_MS;
    const tick = window.setInterval(() => {
      const remaining = Math.max(0, Math.round((until - Date.now()) / 1000));
      setLeft(remaining);
      if (remaining === 0) onDone();
    }, 250);
    return () => window.clearInterval(tick);
  }, [onDone]);

  // Not capped when it starts at the doors: see quotedWait. Sixty minutes
  // is the point past which a QUEUE estimate stops being believable, and
  // "we open at one" is not a queue estimate.
  const wait = customerWait({
    eta_minutes: etaMinutes,
    opening_wait_minutes: openingWaitMinutes,
    placed_while_closed: fromOpening,
  });
  const eta = wait.minutes;

  return (
    <div className="centered screen-thanks">
      <div>
        <div className="tick" aria-hidden>✓</div>
        {/* The whole sentence, not the half of it. "Thank you" alone reads as
            the start of something that has not finished loading; naming what
            is being thanked for is what makes it an acknowledgement. */}
        <h1>Thank you for your order</h1>

        {/* The number, in the words it will be called out in. Set apart from
            the heading and from the wait, because it is the one thing on this
            screen somebody has to carry away with them. */}
        <p className="order-no">
          Your order number is <strong>{orderNo}</strong>
        </p>

        {/* The one thing they came to this screen for. Big, on its own, and
            said in words rather than left as a number to interpret. */}
        <p className="eta-big">
          {eta
            ? (
              <>
                It will be ready in about <strong>{formatWait(eta)}</strong>
                {wait.orLater ? ', possibly longer' : ''}.
              </>
            )
            : <>The kitchen has it now.</>}
          {/* Why the number is what it is. Without this, somebody ordering
              before the doors open reads "about 1 hour 20 minutes" and
              assumes the screen is broken. */}
          {eta && fromOpening ? ' That is counted from when the kitchen opens.' : ''}
          {/* Only where a message will genuinely arrive. Somebody told to
              expect an email stops watching the counter. */}
          {emailed && ' You will receive an email when it is ready.'}
        </p>

        {/* Counted down out loud. A screen that changes on its own without
            warning reads as a fault; one that says when it will change reads
            as working. */}
        <p className="dim small" style={{ marginTop: '1.4rem' }}>
          The menu comes back in {left} second{left === 1 ? '' : 's'}.
        </p>

        <Button
          variant="primary"
          onClick={onDone}
          style={{ marginTop: '0.6rem', width: '100%', padding: '1rem', fontSize: '1.05rem' }}
        >
          Order something else
        </Button>
      </div>
    </div>
  );
}
