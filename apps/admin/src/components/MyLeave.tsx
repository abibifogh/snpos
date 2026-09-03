import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Notice, Select, Spinner, useToast } from '@snpos/ui';
import { humanError } from '../lib';
import {
  leaveCap, daysInRange, dayWords, requestProblem, nothingBookedWords, partlyBookedWords,
  requestLeave, withdrawLeave, loadMyLeave,
} from '@snpos/core';
import type { FiledLeave, LeaveKind, Settings, StaffProfile } from '@snpos/core';

const todayStr = () => new Date().toLocaleDateString('en-CA');

/**
 * Asking for time off, on the page that is always yours.
 *
 * The refusal is the point of this component. A rota has a limit on how many
 * people can be off at once, and a screen that answers "no" without saying
 * which day and why sends somebody to find a manager to ask a question it
 * already knew the answer to — which, on a rota, is a question everybody asks.
 *
 * A week where only Friday is full books the other four days rather than
 * refusing the lot, because refusing the lot makes somebody ask again one day
 * at a time until they find the gaps.
 */
export function MyLeave({ profile, settings }: { profile: StaffProfile; settings: Settings | null }) {
  const toast = useToast();

  const [mine, setMine] = useState<FiledLeave[] | null>(null);
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(todayStr());
  const [kind, setKind] = useState<LeaveKind>('leave');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  /** Per day, because that is what somebody has to act on. */
  const [refusals, setRefusals] = useState<string[]>([]);
  const [summary, setSummary] = useState<string | null>(null);

  const cap = leaveCap(settings?.leave_max_per_day);

  const load = async () => {
    setMine(await loadMyLeave('main', profile.$id, todayStr()));
  };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [profile.$id]);

  const days = useMemo(() => daysInRange(from, to), [from, to]);
  const problem = requestProblem({ days, todayDay: todayStr(), maxAheadDays: 365 });

  const ask = async () => {
    setBusy(true);
    setRefusals([]);
    setSummary(null);
    try {
      const result = await requestLeave({
        venueId: 'main',
        staffId: profile.$id,
        staffName: profile.display_name,
        days,
        kind,
        reason: reason.trim(),
        cap,
        /*
          Names are NOT shown to a colleague.

          A manager needs to know who is already off to judge whether to make
          room. Another waiter does not need a list of their colleagues'
          business, and handing them one is how a useful screen becomes one
          people are careful around. See checkLeave.
        */
        showNames: false,
      });
      await load();
      setRefusals(result.refused.map((r) => r.reason));
      setSummary(nothingBookedWords(result) ?? partlyBookedWords(result));
      if (result.booked.length > 0) {
        toast(`Asked for ${result.booked.length} ${result.booked.length === 1 ? 'day' : 'days'}. `
          + 'A manager will answer.');
        setReason('');
      }
      if (result.failed.length > 0) {
        toast(`${result.failed.length} of those could not be saved at all. Try again.`, 'err');
      }
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const drop = async (row: FiledLeave) => {
    setBusy(true);
    try {
      const ok = await withdrawLeave(row.$id, profile.$id);
      await load();
      toast(ok ? `${dayWords(row.day)} taken back` : 'That could not be taken back', ok ? undefined : 'err');
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const live = (mine ?? []).filter((r) => (r.status ?? 'requested') !== 'withdrawn');

  return (
    <Card title="Time off">
      <p className="small dim" style={{ marginTop: 0 }}>
        Ask for a day off, or say you are not available. At most {cap} {cap === 1 ? 'person' : 'people'} can be
        off on the same day — if a day you pick is already taken, this will say so and book the rest.
      </p>

      <div className="row row-wrap" style={{ gap: '0.8rem', alignItems: 'flex-end' }}>
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value); }} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="What">
          <Select value={kind} onChange={(e) => setKind(e.target.value as LeaveKind)}>
            <option value="leave">Leave</option>
            <option value="unavailable">Not available</option>
          </Select>
        </Field>
        <Field label="Why" hint="Optional.">
          <Input value={reason} placeholder="Family thing" onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Button loading={busy} disabled={!!problem} onClick={() => void ask()}>
          {days.length > 1 ? `Ask for ${days.length} days` : 'Ask for the day'}
        </Button>
      </div>

      {/* A different mistake with a different fix. Reporting a date in the
          past as a full rota would send somebody hunting for a free day when
          the day was never the problem. */}
      {problem && <p className="small dim" style={{ marginBottom: 0 }}>{problem}</p>}

      {summary && <Notice tone="warn">{summary}</Notice>}
      {refusals.length > 0 && (
        <Notice tone="warn">
          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {refusals.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </Notice>
      )}

      <h3 style={{ marginBottom: '0.4rem' }}>What you have asked for</h3>
      {mine === null ? <Spinner /> : live.length === 0 ? (
        <Empty title="Nothing yet">Ask for a day above and it will appear here.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <tbody>
              {live.sort((a, b) => a.day.localeCompare(b.day)).map((r) => (
                <tr key={r.$id}>
                  <td>{dayWords(r.day)}</td>
                  <td>{r.kind === 'unavailable' ? 'Not available' : 'Leave'}</td>
                  <td>
                    <Badge tone={r.status === 'approved' ? 'ok' : r.status === 'refused' ? 'danger' : 'warn'}>
                      {r.status === 'approved' ? 'Agreed'
                        : r.status === 'refused' ? 'Refused'
                          : 'Waiting'}
                    </Badge>
                    {/* The reason it was refused, kept where the person who
                        was refused can read it. */}
                    {r.status === 'refused' && r.decided_note && (
                      <div className="small dim">{r.decided_note}</div>
                    )}
                  </td>
                  <td className="num">
                    {(r.status ?? 'requested') === 'requested' && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void drop(r)}>
                        Take it back
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
