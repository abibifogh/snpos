import { useEffect, useMemo, useState } from 'react';
import {
  Query, listAll, subscribeCollection, countChargeLines, countStage, msLeft, timeLeftWords, answerProblem,
  answerCountCharge,
} from '@snpos/core';
import type { CountCharge, CountAnswer, CountChargeLine } from '@snpos/core';
import { Badge, Button, Modal, Notice, Textarea } from './components';

/** The lines of a count difference: what was short, what was over, and the total. */
export function CountLinesTable({ lines, total, money }: { lines: CountChargeLine[]; total: number; money: (n: number) => string }) {
  if (lines.length === 0) return null;
  return (
    <div className="table-wrap">
      <table className="data count-lines">
        <thead>
          <tr><th>Item</th><th>How many</th><th className="num">Worth</th></tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={`${l.name}-${i}`}>
              <td>{l.name}{l.basis === 'cost' && <span className="dim small"> at cost, nothing sells it alone</span>}</td>
              <td>{l.qty < 0 ? `${Math.abs(l.qty)} short` : `${l.qty} over`}</td>
              <td className="num">{l.amount < 0 ? money(-l.amount) : `− ${money(l.amount)}`}</td>
            </tr>
          ))}
          <tr className="count-lines-total">
            <td>Total</td><td />
            <td className="num">{money(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const ANSWERS: Record<CountAnswer, [string, string]> = {
  accept: ['Take it from my pay', 'It is right. Deduct it from my salary.'],
  putback: ['I will put it back at my next shift', 'It is added to what my drawer should hold when I next close.'],
  explain: ['I want to explain', 'Tell the manager what happened. They decide.'],
};

const whenWords = (iso?: string | null): string =>
  iso ? new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';

const countName = (c: CountCharge): string => {
  const day = new Date(c.charged_at).toLocaleDateString([], { weekday: 'long' });
  return c.phase === 'open' ? `the bar count when ${day}'s shift counted in` : `${day}'s bar count`;
};

/** Theirs, recently: still open, or decided in the last three days so they see what was decided. */
const RECENT_MS = 3 * 86_400_000;
const worthShowing = (c: CountCharge, now: number): boolean =>
  c.decision === 'pending'
  || (c.decision === 'putback' && c.status === 'open')
  || (!!c.decided_at && now - new Date(c.decided_at).getTime() < RECENT_MS);

/**
 * A bar count difference on the account of whoever is at the till: not final,
 * with the time left to answer it, and the answer itself.
 *
 * Only theirs. Each charge is readable by the person it is about and by the
 * managers. On a shared till signed in by a colleague it cannot be read, so
 * the person is also emailed and can answer from their own phone.
 */
export function CountChargeNotice({ venueId, userId, profileId, name, money }: {
  venueId: string;
  userId: string;
  profileId: string;
  name: string;
  money: (n: number) => string;
}) {
  const [mine, setMine] = useState<CountCharge[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!userId) return undefined;
    let live = true;
    const read = () => {
      void listAll<CountCharge>('staff_charges', [
        Query.equal('person_user_id', userId),
        Query.equal('decision', ['pending', 'deduct', 'part', 'waived', 'putback']),
      ]).then((rows) => { if (live) setMine(rows); }).catch(() => undefined);
    };
    read();
    const off = subscribeCollection<CountCharge>('staff_charges', (c) => { if (c.person_user_id === userId) read(); });
    const tick = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => { live = false; off(); window.clearInterval(tick); };
  }, [userId]);

  const shown = useMemo(
    () => mine.filter((c) => worthShowing(c, now)).sort((a, b) => b.charged_at.localeCompare(a.charged_at)),
    [mine, now],
  );
  const waiting = shown.filter((c) => c.decision === 'pending' && !c.answer);
  const current = shown.find((c) => c.$id === open) ?? null;
  if (shown.length === 0) return null;

  const first = waiting[0] ?? shown[0]!;
  const nowDate = new Date(now);
  return (
    <div style={{ padding: '0.4rem 1rem 0' }}>
      <div className={`count-due ${waiting.length ? 'warn' : ''}`}>
        <div style={{ minWidth: 0 }}>
          <b>
            {waiting.length
              ? `${money(first.amount)} from ${countName(first)} · not final`
              : shown.length === 1 ? `${money(first.amount)} from ${countName(first)}` : `${shown.length} bar count differences`}
          </b>
          <span className="dim small">
            {waiting.length
              ? ` ${timeLeftWords(msLeft(first, nowDate))} left to answer`
              : ' Your answer is in, or a manager has decided.'}
          </span>
        </div>
        <Button size="sm" variant={waiting.length ? 'primary' : 'default'} onClick={() => setOpen(first.$id)}>
          {waiting.length ? 'Answer' : 'See it'}
        </Button>
      </div>
      {current && (
        <CountChargeModal
          charge={current}
          others={shown.filter((c) => c.$id !== current.$id)}
          onPick={setOpen}
          venueId={venueId}
          profileId={profileId}
          name={name}
          money={money}
          now={nowDate}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function decidedWords(c: CountCharge, money: (n: number) => string): string | null {
  switch (c.decision) {
    case 'deduct': return `Deducted ${money(c.amount)} from your pay${c.hive_sent_at ? '. It has gone to HIVE.' : '. It goes to HIVE with this month’s deductions.'}`;
    case 'part': return `Deducted ${money(c.decided_amount ?? 0)} and waived the rest.`;
    case 'waived': return 'Waived. Nothing is taken.';
    case 'putback': return c.status === 'settled'
      ? `Put back. ${money(c.amount)} went into your drawer and it is settled.`
      : `Agreed. ${money(c.amount - (c.settled_total || 0))} is added to what your drawer should hold when you next close.`;
    default: return null;
  }
}

function CountChargeModal({ charge: c, others, onPick, venueId, profileId, name, money, now, onClose }: {
  charge: CountCharge;
  others: CountCharge[];
  onPick: (id: string) => void;
  venueId: string;
  profileId: string;
  name: string;
  money: (n: number) => string;
  now: Date;
  onClose: () => void;
}) {
  const [answer, setAnswer] = useState<CountAnswer | null>(c.answer ?? null);
  const [note, setNote] = useState(c.answer_note ?? '');
  const [editing, setEditing] = useState(!c.answer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => {
    setAnswer(c.answer ?? null); setNote(c.answer_note ?? ''); setEditing(!c.answer); setError(null); setSent(null);
  }, [c.$id]); // eslint-disable-line react-hooks/exhaustive-deps

  const stage = countStage(c, now);
  const pending = c.decision === 'pending';
  const lines = countChargeLines(c);

  const send = async () => {
    const problem = answerProblem(c, answer, note);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await answerCountCharge({ venueId, chargeId: c.$id, answer: answer!, note, profileId, name });
      if (!r.ok) { setError(r.error ?? 'That did not go through.'); return; }
      setSent(answer === 'accept' ? 'Sent. It will be deducted when your time is up, unless a manager decides first.'
        : 'Sent. A manager will decide. Nothing has been taken.');
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`${money(c.amount)} from ${countName(c)}`}
      onClose={onClose}
      footer={pending && editing ? (
        <>
          <Button variant="ghost" onClick={onClose}>Not now</Button>
          <Button variant="primary" loading={busy} disabled={!answer} onClick={() => void send()}>Send my answer</Button>
        </>
      ) : <Button onClick={onClose}>Done</Button>}
    >
      <div className="count-charge">
        <div className="count-charge-head">
          <Badge tone={pending ? 'warn' : c.decision === 'waived' ? 'ok' : 'default'}>{pending ? 'Not final' : 'Decided'}</Badge>
          {pending && (
            <span className="dim small">
              {stage === 'answering' ? `${timeLeftWords(msLeft(c, now))} left to answer · until ${whenWords(c.answer_by)}` : 'Waiting for a manager'}
            </span>
          )}
        </div>

        <CountLinesTable lines={lines} total={c.amount} money={money} />

        {pending && (
          <p className="small dim">
            {c.phase === 'open'
              ? 'The next shift counted in and found less than you handed over.'
              : 'Your count at the close of your shift found less than the till expected.'}
            {' '}Valued at selling price{lines.some((l) => l.amount > 0) ? ', with anything over set against it' : ''}.
            {' '}<b>This is not final.</b> A manager makes the final call.
          </p>
        )}

        {!pending && <Notice tone={c.decision === 'waived' ? 'ok' : 'info'}>{decidedWords(c, money)}{c.decided_note ? ` “${c.decided_note}”` : ''}</Notice>}

        {pending && !editing && (
          <div className="count-said">
            <small>You chose</small>
            <b>{c.answer ? ANSWERS[c.answer][0] : answer ? ANSWERS[answer][0] : ''}</b>
            {(c.answer === 'explain' || answer === 'explain') && note && <span>“{note}”</span>}
            {sent && <Notice tone="ok">{sent}</Notice>}
            <div><Button size="sm" onClick={() => setEditing(true)}>Change my answer</Button></div>
          </div>
        )}

        {pending && editing && (
          <>
            <div className="count-choices" role="group" aria-label="Your answer">
              {(Object.keys(ANSWERS) as CountAnswer[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  className="count-choice"
                  aria-pressed={answer === k}
                  onClick={() => { setAnswer(k); setError(null); }}
                >
                  <span className="dot" aria-hidden="true" />
                  <b>{ANSWERS[k][0]}</b>
                  <small>{k === 'putback' ? `${money(c.amount)} is added to what my drawer should hold when I next close.` : ANSWERS[k][1]}</small>
                </button>
              ))}
            </div>
            {answer === 'explain' && (
              <Textarea
                aria-label="What happened"
                placeholder="What happened? The manager reads this before deciding."
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                autoFocus
              />
            )}
          </>
        )}
        {error && <Notice tone="err">{error}</Notice>}

        {others.length > 0 && (
          <p className="small dim" style={{ marginBottom: 0 }}>
            Also:{' '}
            {others.map((o, i) => (
              <span key={o.$id}>
                {i > 0 && ', '}
                <button type="button" className="linkish" onClick={() => onPick(o.$id)}>{money(o.amount)} from {countName(o)}</button>
              </span>
            ))}
          </p>
        )}
      </div>
    </Modal>
  );
}
