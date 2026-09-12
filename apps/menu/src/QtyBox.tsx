import { useEffect, useState } from 'react';
import { readQty, settleQty, QTY_MOST } from '@snpos/core';

/**
 * How many, with a box that can be typed into.
 *
 * Plus and minus are right for a guest ordering two of something and hopeless
 * for a hotel ordering forty: nobody taps a button forty times, and somebody
 * who tries will lose count of where they got to. So the number between the
 * buttons is a field. The buttons stay, because two taps is still the fastest
 * way to get from two to three.
 *
 * One component for all four places a quantity is changed — the dish sheet,
 * the cart, the booking sheet and the basket beside the menu — so a field that
 * behaves one way in one of them cannot behave another way in the next.
 */
export function QtyBox({
  qty, onChange, least = 1, most = QTY_MOST, label,
}: {
  qty: number;
  onChange: (qty: number) => void;
  /** 0 where typing over a quantity should take the line off the order. */
  least?: number;
  most?: number;
  /** What is being counted, so a screen reader says which number this is. */
  label?: string;
}) {
  /*
    What is in the box while the cursor is in it, which is not always a number.

    Typed characters have to appear as they are typed — including the moment
    the box is empty, on the way from 2 to 40 — so the field holds text and the
    order holds the figure. Committing every keystroke straight to the order
    would take the line off it the instant somebody cleared the box to type
    something else, and they would never get to type it.
  */
  const [text, setText] = useState(String(qty));
  const [typing, setTyping] = useState(false);

  // Minus pressed, or the line changed from elsewhere. Not while somebody is
  // in the middle of typing, which would fight them for the cursor.
  useEffect(() => { if (!typing) setText(String(qty)); }, [qty, typing]);

  const settle = () => {
    setTyping(false);
    const n = settleQty(text, { least, most });
    setText(String(n));
    if (n !== qty) onChange(n);
  };

  return (
    <div className="qty">
      <button
        type="button"
        onClick={() => onChange(Math.max(least, qty - 1))}
        aria-label={label ? `One fewer ${label}` : 'One fewer'}
      >
        −
      </button>
      <input
        className="qty-box"
        type="text"
        inputMode="numeric"
        /* Not type="number": its spinners are a second, smaller pair of the
           buttons either side, and on a phone it accepts "e" and "-". */
        pattern="[0-9]*"
        value={text}
        aria-label={label ? `How many ${label}` : 'How many'}
        onFocus={(e) => { setTyping(true); e.currentTarget.select(); }}
        onChange={(e) => {
          setTyping(true);
          const raw = e.target.value;
          // Shown as typed; the order only hears about it once it is a number.
          setText(raw.replace(/[^\d]/g, '').slice(0, 4));
          const n = readQty(raw, most);
          if (n !== null && n >= least && n !== qty) onChange(n);
        }}
        onBlur={settle}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      <button
        type="button"
        onClick={() => onChange(Math.min(most, qty + 1))}
        aria-label={label ? `One more ${label}` : 'One more'}
      >
        +
      </button>
    </div>
  );
}
