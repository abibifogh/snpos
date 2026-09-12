import { Button, Notice } from '@snpos/ui';
import { formatMoney, longDayWords, timeWords } from '@snpos/core';
import type { Settings } from '@snpos/core';

/**
 * What a group sees the moment their booking goes in.
 *
 * A walk-in gets a toast and a status page, because their food is twenty
 * minutes away and they are standing in the room. A party who has just
 * committed several thousand cedis for a Tuesday three weeks out has a
 * different question, and it is not "how long": it is "is that actually
 * booked, and what happens now". A message that slides away after four
 * seconds answers neither.
 *
 * So it says the three things they need. What went in. That it is not
 * confirmed yet and somebody here will look at it. And that they will hear by
 * email either way — which is why the address is required, and is repeated
 * back here so a typo is caught while they are still sitting there.
 */
export function GroupSent({
  booked, contactName, email, reference, portions, total, settings, changeUrl, onDone,
}: {
  booked: { orderNo: string; at: string }[];
  contactName: string;
  email: string;
  reference: string;
  portions: number;
  total: number;
  settings: Settings;
  /** Where they can ask for a change. Absent until the booking is recorded. */
  changeUrl: string | null;
  onDone: () => void;
}) {
  const sittings = [...booked].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <div className="status-page">
      <h1>Your booking is with us</h1>

      <Notice tone="ok">
        <strong>Thank you for your group order.</strong> Our bistro will check your order and revert. As soon as
        it is approved you will be emailed{email ? <> at <strong>{email}</strong></> : ''}.
      </Notice>

      <h2 style={{ fontSize: '1.05rem', marginBottom: '0.3rem' }}>What you have asked for</h2>
      <p className="meta" style={{ marginTop: 0 }}>
        {contactName}{reference ? ` · ${reference}` : ''} · {sittings.length} sitting
        {sittings.length === 1 ? '' : 's'} · {portions} portions
      </p>

      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Sitting</th><th>Order</th></tr></thead>
          <tbody>
            {sittings.map((b) => (
              <tr key={b.orderNo}>
                <td>{longDayWords(b.at)}, {timeWords(b.at)}</td>
                {/* The number the kitchen will call out, so the front desk has
                    something to quote on the day. */}
                <td style={{ fontWeight: 600 }}>{b.orderNo}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="spread" style={{ fontWeight: 650, fontSize: '1.05rem', marginTop: '0.8rem' }}>
        <span>Total</span>
        <span>{formatMoney(total, settings)}</span>
      </div>

      {/*
        The way back in, given while they still have the page.

        The same link is in the confirmation email, but an email can be missed
        and this is the one moment they are certainly looking. Absent when the
        booking record could not be written — see the notice below, which says
        so rather than offering a link that would not open anything.
      */}
      {changeUrl ? (
        <p className="meta">
          Need to change something, or not coming after all?{' '}
          <a href={changeUrl}>Open your booking</a>. Changes close five days before the first meal.
        </p>
      ) : (
        <Notice tone="warn">
          <strong>We could not send your confirmation email.</strong> Your food IS ordered — the numbers above are
          real and the kitchen has them — but nothing has gone to your inbox and nobody here has been emailed
          either. Please ring the restaurant and read them the order numbers above.
        </Notice>
      )}

      <Button onClick={onDone} style={{ marginTop: '1.2rem' }}>Back to the menu</Button>
    </div>
  );
}
