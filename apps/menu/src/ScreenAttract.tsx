import { Button } from '@snpos/ui';

/**
 * What a counter screen shows when nobody is using it.
 *
 * The screen spends almost all of its day like this, so this — not the menu —
 * is what the room actually sees. A menu left sitting there reads as somebody
 * else's half-finished order and gets walked past; there is nothing on it
 * saying it is for you, or that it is for ordering at all.
 *
 * So it says the one thing it needs to, in the largest words on the screen,
 * and points at the way in. Everything here exists to be read from across a
 * room by somebody who was not looking.
 *
 * The whole panel is the button. Somebody walking up will touch the biggest
 * thing in front of them, or the arrow, or the words — and every one of those
 * has to work, because a screen that ignores the first touch has already lost
 * the person.
 */
export function ScreenAttract({
  venueName,
  onStart,
}: {
  venueName: string;
  onStart: () => void;
}) {
  /*
    A div, not a button, and deliberately.

    The panel has to be tappable anywhere AND hold a real button at the end of
    the arrow, and a button inside a button is markup a browser is entitled to
    rearrange. So the panel takes the click, and the control inside it is the
    only actual button.
  */
  return (
    <div
      className="attract"
      role="button"
      tabIndex={0}
      onClick={onStart}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onStart(); }}
    >
      <div className="attract-inner">
        <div className="attract-venue">{venueName}</div>

        {/* The instruction, and the only sentence that matters. "View menu"
            alone gets read as a sign rather than a thing to touch; "order
            here" is what makes it an invitation. */}
        <h1 className="attract-headline">
          VIEW MENU &amp; <strong>ORDER HERE</strong>
        </h1>

        {/*
          Breathing rather than blinking.

          A blink is an alarm and the eye learns to dismiss it within about a
          minute. A slow swell reads as something alive and waiting, which is
          what pulls somebody across a room — and it keeps doing it all day,
          which a blink does not.
        */}
        <div className="attract-arrow" aria-hidden="true">
          <svg viewBox="0 0 48 64" width="72" height="96" fill="none" stroke="currentColor" strokeWidth="5">
            <path d="M24 4 v46" strokeLinecap="round" />
            <path d="M8 36 l16 18 16-18" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        {/* The thing the arrow is pointing at. A real target, not a caption:
            somebody who has followed the arrow down should find something to
            press at the end of it. */}
        <Button variant="primary" className="attract-cta" onClick={onStart}>
          Order something
        </Button>

        <p className="attract-hint">Touch anywhere to begin</p>
      </div>
    </div>
  );
}
