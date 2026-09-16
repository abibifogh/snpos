import { useEffect, useState } from 'react';
import { Card, Badge, Button, Notice, Spinner, Input, useToast } from '@snpos/ui';
import { humanError } from '../lib';
import {
  groupBookingsBetween, resendBookingNotice, resendPendingFor,
  formatMoney, dateTimeWords,
} from '@snpos/core';
import type { GroupBookingDoc } from '@snpos/core';
import { useSession } from '../session';

/** The last thirty days, as the date boxes want them. */
const dayInput = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Every group booking, and a way to tell the team about one again.
 *
 * THIS PAGE EXISTS BECAUSE A MESSAGE FAILED AND THERE WAS NOWHERE TO GO.
 *
 * A booking used to be reachable in exactly one place — the Waiting page,
 * while it was still waiting to be agreed to. The moment somebody approved,
 * refused or cancelled it, it existed in the database and on no screen in the
 * system. That is tolerable while the emails work. When one does not, it
 * means a party of forty is in the diary, the guest has a confirmation, and
 * nobody here has heard of it, with nothing to open and nothing to press.
 *
 * So: the list, and one button. "Send to the team again" writes a request on
 * the booking, and the background job sends it — one message per person, so
 * one bad address costs that address and nobody else. See sendToEach.
 */
export function GroupBookingsPage() {
  const toast = useToast();
  const { settings } = useSession();
  const [rows, setRows] = useState<GroupBookingDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [asked, setAsked] = useState<Set<string>>(new Set());

  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return dayInput(d);
  });
  const [to, setTo] = useState(() => dayInput(new Date()));

  const load = async () => {
    setError(null);
    const found = await groupBookingsBetween(
      new Date(`${from}T00:00:00`).toISOString(),
      new Date(`${to}T23:59:59`).toISOString(),
    );
    setRows(found);
  };

  useEffect(() => {
    setRows(null);
    void load().catch((e) => setError(humanError(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  const sendAgain = async (b: GroupBookingDoc) => {
    setBusy(b.$id);
    try {
      await resendBookingNotice(b.$id);
      /*
        Said as a request, because that is what it is. The job does the
        sending a moment later, and promising "sent" for something that has
        not left yet is the kind of reassurance that stops people checking.
      */
      setAsked((s) => new Set(s).add(b.$id));
      toast('Asked for it to go to the team again. It goes out in the next minute.');
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setBusy(null);
    }
  };

  const money = (n?: number) => (settings ? formatMoney(n ?? 0, settings) : String(n ?? 0));

  const tone = (s?: string) => {
    if (s === 'approved') return 'ok' as const;
    if (s === 'refused' || s === 'cancelled') return 'warn' as const;
    return undefined;
  };

  if (error) return <Notice>{error}</Notice>;

  return (
    <>
      <h1>Group bookings</h1>
      <p className="dim" style={{ maxWidth: '60ch' }}>
        Every booking a group has sent, whether or not it has been agreed to. If the team did not hear about
        one, send it again from here — it goes to every admin and manager with an email address, plus anyone
        named under Features, Group ordering.
      </p>

      <div className="row" style={{ gap: '0.6rem', alignItems: 'center', margin: '0.9rem 0' }}>
        <span className="dim small">From</span>
        <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <span className="dim small">To</span>
        <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
      </div>

      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Card pad>
          <p style={{ margin: 0 }}>No group bookings in these dates.</p>
        </Card>
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Booked</th>
                  <th>Who</th>
                  <th>Sittings</th>
                  <th className="num">Total</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.$id}>
                    <td className="small dim">{b.$createdAt ? dateTimeWords(b.$createdAt) : '-'}</td>
                    <td>
                      <strong>{b.contact_name || '-'}</strong>
                      {b.reference && <div className="small dim">{b.reference}</div>}
                      {b.email && <div className="small dim">{b.email}</div>}
                    </td>
                    <td className="small">
                      {b.sittings ?? 0} · {b.portions ?? 0} portions
                      {b.first_at && <div className="dim">{dateTimeWords(b.first_at)}</div>}
                    </td>
                    <td className="num" style={{ fontWeight: 650 }}>{money(b.total)}</td>
                    <td><Badge tone={tone(b.status)}>{b.status ?? 'pending'}</Badge></td>
                    <td>
                      {/* Pending from the moment it is asked for until the job
                          clears it, so pressing twice does not send twice. */}
                      {asked.has(b.$id) || resendPendingFor(b) ? (
                        <span className="small dim">Going out…</span>
                      ) : (
                        <Button
                          size="sm"
                          loading={busy === b.$id}
                          onClick={() => void sendAgain(b)}
                        >
                          Send to the team again
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
