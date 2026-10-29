import { useEffect, useState } from 'react';
import { Input } from '@snpos/ui';
import { toInput, parseMoney } from '@snpos/core';

/**
 * A money box that can be typed in.
 *
 * Binding the box straight to the stored number re-formats it on every key:
 * "5" becomes "0.05", a cleared box becomes "0.00" with the cursor after it,
 * and somebody trying to type 500 ends up with 1.00 and no way to type at all.
 * So what is typed is kept as typed while the box has focus, the number is
 * passed up as it changes, and the box is tidied to "500.00" on the way out.
 * A comma is a thousands separator here ("1,000"), never a decimal point.
 */
export function MoneyInput({ value, decimals, onChange, ...rest }: {
  value: number;
  decimals: number;
  onChange: (minor: number) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [text, setText] = useState(() => toInput(value, decimals));
  const [editing, setEditing] = useState(false);
  const read = (t: string) => parseMoney(t.replace(/,/g, ''), decimals) ?? 0;
  // A value changed from outside (a reload, a reset) shows, unless somebody is typing.
  useEffect(() => { if (!editing) setText(toInput(value, decimals)); }, [value, decimals, editing]);
  return (
    <Input
      {...rest}
      inputMode="decimal"
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(e) => {
        const typed = e.target.value.replace(/[^0-9.,]/g, '');
        setText(typed);
        onChange(read(typed));
      }}
      onBlur={() => { setEditing(false); setText(toInput(read(text), decimals)); }}
    />
  );
}
