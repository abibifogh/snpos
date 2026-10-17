import { Button, Notice } from '@snpos/ui';
import { formatMoney, longDayWords, timeWords } from '@snpos/core';
import type { Settings } from '@snpos/core';

/**
 * What a group sees the moment their booking goes in.
 *
 * A party that has just committed several thousand cedis for a Tuesday three
 * weeks out is asking "is that booked, and what happens now". So the page
 * says where it stands and what comes next, in order: sent, waiting for us to
 * confirm, cooked on the day, paid on the day. The email address is repeated
 * back so a typo is caught while they are still sitting there.
 *
 * It does not say "confirmed". It is not, until somebody here confirms it,
 * and the guest is told so by email in the same words.
 */
export function GroupSent({
  booked, contactName, email, reference, portions, total, settings, changeUrl, onDone,
}: {
  booked: { orderNo: string; at: string; how?: string }[];
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
  const times = [...booked].sort((a, b) => a.at.localeCompare(b.at));
  const first = times[0]?.at;
  // Changes close five days before the first meal time; see booking-changes.ts.
  const closes = first ? new Date(new Date(first).getTime() - 5 * 86_400_000) : null;

  return (
    <div className="status-page">
      <h1>Booking sent</h1>

      <ol className="steps">
        <li className="past">
          <span className="dot" aria-hidden="true" />
          <div>
            <div className="label">Sent</div>
            <div className="says">
              {changeUrl
                ? <>A copy is on its way to <strong>{email}</strong>.</>
                : 'Your food is ordered, but the copy could not be emailed. See below.'}
            </div>
          </div>
        </li>
        <li className="now">
          <span className="dot" aria-hidden="true" />
          <div>
            <div className="label">Waiting for us to confirm</div>
            <div className="says">We check every group booking and email you once it is confirmed.</div>
          </div>
        </li>
        <li>
          <span className="dot" aria-hidden="true" />
          <div><div className="label">Cooked on the day</div></div>
        </li>
        <li>
          <span className="dot" aria-hidden="true" />
          <div><div className="label">Paid on the day, a receipt for each meal time</div></div>
        </li>
      </ol>

      <h2 style={{ fontSize: '1.05rem', marginBottom: '0.3rem' }}>Your meal times</h2>
      <p className="meta" style={{ marginTop: 0 }}>
        {contactName}{reference ? ` · ${reference}` : ''} · {portions} portions
      </p>

      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Meal time</th><th>Order</th></tr></thead>
          <tbody>
            {times.map((b) => (
              <tr key={b.orderNo}>
                <td>
                  {longDayWords(b.at)}, {timeWords(b.at)}
                  {b.how && <div className="meta">{b.how}</div>}
                </td>
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
      <p className="meta">Nothing to pay now.</p>

      {/* The way back in, given while they are certainly looking. The same
          link is in the email. */}
      {changeUrl ? (
        <>
          <a className="btn-link" href={changeUrl}>Change or cancel this booking</a>
          {closes && (
            <p className="meta">
              Changes are open until {longDayWords(closes.toISOString())}, 5 days before the first meal time.
            </p>
          )}
        </>
      ) : (
        <Notice tone="warn">
          <strong>We could not email your copy.</strong> Your food IS ordered — the numbers above are real and
          the kitchen has them — but nothing has gone to your inbox and nobody here has been emailed either.
          Please ring the restaurant and read them the order numbers above.
        </Notice>
      )}

      <Button onClick={onDone} style={{ marginTop: '1.2rem' }}>Back to the menu</Button>
    </div>
  );
}
