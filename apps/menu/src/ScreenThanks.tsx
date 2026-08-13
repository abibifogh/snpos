import { useEffect, useState } from 'react';
import { Button } from '@snpos/ui';
import { shownEta } from '@snpos/core';

/**
 * How long the thank-you stays before the menu comes back.
 *
 * Ten seconds, which is about how long a queue actually gives you: somebody
 * reads their number, reads the wait, and steps away. It was half a minute,
 * and half a minute is a long time to stand behind a screen still showing the
 * order of the person who has already gone.
 *
 * Nothing is lost by cutting it. The number is called out at the counter, and
 * anybody who wants longer simply does not walk away — the countdown is on
 * screen, so they can see what it is about to do.
 */
export const SCREEN_THANKS_MS = 10_000;

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
  emailed,
  onDone,
}: {
  orderNo: string;
  /** What the kitchen quoted, queue included. Absent when nothing was worked out. */
  etaMinutes?: number;
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

  const eta = shownEta(etaMinutes);

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
            ? <>It will be ready in about <strong>{eta} minutes</strong>.</>
            : <>The kitchen has it now.</>}
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
