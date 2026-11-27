import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge, Button, Card, Empty, Field, Input, Modal, Notice, Spinner, Textarea, CountLinesTable, useToast,
} from '@snpos/ui';
import {
  loadCountCharges, decideCountCharge, undoCountCharge, recommendCountCharge, countChargeLines, countStage, stageWords,
  decisionProblem, countUndoProblem, timeLeftWords, msLeft, subscribeCollection, parseMoney, toInput,
  loadFeatures, featureConfig, auditorLimit, decisionRight, decisionRightWords, recommendProblem, recommendationOf,
  recommendationWords, followUpsAbout, addNote, dateTimeWords, deductedAmount,
} from '@snpos/core';
import type { CountCharge, CountDecision, FollowUp } from '@snpos/core';
import { useSession, useMoney } from '../session';
import { humanError } from '../lib';
import { HubTabs, HubTitle } from './Hub';
import { AddFollowUpModal } from '../pages/FollowUps';

type Choice = Exclude<CountDecision, 'pending'>;

const ANSWER_WORDS: Record<string, string> = {
  accept: 'Accepted: take it from my pay',
  putback: 'Offered to put it back at the next shift',
  explain: 'Explained',
};

const when = (iso?: string | null): string =>
  iso ? new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

/** Every count difference, kept current, with the auditor's limit. */
function useCountCharges() {
  const { settings } = useSession();
  const [rows, setRows] = useState<CountCharge[] | null>(null);
  const [limit, setLimit] = useState<number>(() => auditorLimit(null, settings?.currency_decimals ?? 2));
  const load = async () => {
    try {
      setRows(await loadCountCharges('main'));
    } catch {
      // Not provisioned yet, or not allowed: an empty list rather than an error.
      setRows([]);
    }
  };
  useEffect(() => {
    void load();
    loadFeatures().then((f) => setLimit(auditorLimit(
      { auditor_limit: featureConfig<unknown>(f, 'count_charges', 'auditor_limit', undefined) },
      settings?.currency_decimals ?? 2,
    ))).catch(() => undefined);
    const off = subscribeCollection<CountCharge>('staff_charges', () => { void load(); });
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { rows, limit, load };
}

/** Waiting for somebody: undecided, or a put-back still to go into a drawer. */
const isOpenCase = (c: CountCharge) => c.decision === 'pending' || (c.decision === 'putback' && c.status === 'open');

/**
 * Differences › To review: every count difference still open, one at a time.
 *
 * On the left, the list: undecided ones first, then put-backs waiting for a
 * drawer, each with what it is waiting on. On the right, the one chosen: its
 * lines, the person's answer, a timeline of everything said and done about
 * it, and the decision. An admin or a manager decides any amount; an auditor
 * decides up to their limit and recommends above it; nobody decides their
 * own. Notes are kept for good. A follow-up can be added from here, linked to
 * it.
 *
 * Nothing is written to the charge from here: a decision or a recommendation
 * is sent to the server, which checks who sent it and makes it. See
 * functions/notify/src/count-charges.js and auditor.ts.
 */
export function DifferencesReview() {
  const { profile } = useSession();
  const money = useMoney();
  const { rows, limit, load } = useCountCharges();
  const [now, setNow] = useState(() => new Date());
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    const tick = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(tick);
  }, []);

  const open = useMemo(() => (rows ?? []).filter(isOpenCase).sort((a, b) => {
    const rank = (c: CountCharge) => (c.decision === 'pending' ? (recommendationOf(c) ? 0 : countStage(c, now) === 'manager' ? 1 : 2) : 3);
    return rank(a) - rank(b) || a.charged_at.localeCompare(b.charged_at);
  }), [rows, now]);
  const current = open.find((c) => c.$id === picked) ?? open[0] ?? null;

  const tagFor = (c: CountCharge): { label: string; tone: 'warn' | 'danger' | 'default' | 'ok' } => {
    const rec = recommendationOf(c);
    if (rec) return { label: `${rec.by} recommends: ${recommendationWords(c, rec, money)}`, tone: 'warn' };
    const right = decisionRight(c, profile, limit);
    const stage = countStage(c, now);
    if (stage === 'answering') return { label: `Answer due in ${timeLeftWords(msLeft(c, now))}`, tone: 'default' };
    if (stage === 'putback') return { label: 'Put-back due at their next shift', tone: 'default' };
    if (right === 'recommend') return { label: 'Above your limit', tone: 'warn' };
    const days = Math.floor((now.getTime() - Date.parse(c.charged_at)) / 86_400_000);
    return { label: days >= 1 ? `${days} day${days === 1 ? '' : 's'} without a decision` : stageWords(c, now).label, tone: days >= 1 ? 'danger' : 'warn' };
  };

  return (
    <>
      <div className="spread">
        <h1><HubTitle>To review</HubTitle></h1>
      </div>
      <HubTabs />
      {!rows ? <Spinner /> : open.length === 0 ? (
        <Card>
          <Empty title="Nothing to review">
            A count that comes up short puts a difference on somebody&rsquo;s account. Each one waits here until it is
            decided. Decided ones are on the Closed tab.
          </Empty>
        </Card>
      ) : (
        <div className="diff-split">
          <Card pad={false}>
            <div className="diff-list">
              {open.map((c) => {
                const tag = tagFor(c);
                return (
                  <button key={c.$id} type="button" className="diff-row" aria-current={current?.$id === c.$id} onClick={() => setPicked(c.$id)}>
                    <div>
                      <b>{c.person_name} · <span className="danger-text">{money(c.amount)}</span></b>
                      <div className="small dim">
                        {c.phase === 'open' ? 'Start-of-shift count' : c.phase === 'close' ? 'End-of-shift count' : 'Count'}, {when(c.charged_at)}
                        {c.answer ? ` · ${ANSWER_WORDS[c.answer]}` : ''}
                      </div>
                    </div>
                    <div className="tags"><Badge tone={tag.tone}>{tag.label}</Badge></div>
                  </button>
                );
              })}
            </div>
          </Card>
          {current && <DifferenceCase key={current.$id} charge={current} limit={limit} now={now} onChanged={load} />}
        </div>
      )}
    </>
  );
}

/** One difference: its lines, the answer, the timeline and the decision. */
function DifferenceCase({ charge: c, limit, now, onChanged }: {
  charge: CountCharge; limit: number; now: Date; onChanged: () => Promise<void>;
}) {
  const { profile, settings } = useSession();
  const money = useMoney();
  const toast = useToast();
  const [notes, setNotes] = useState<FollowUp[] | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ choice: Choice; recommend: boolean } | null>(null);
  const [following, setFollowing] = useState(false);
  const who = { profileId: profile?.$id ?? '', name: profile?.display_name ?? '' };
  const right = decisionRight(c, profile, limit);
  const rightWords = decisionRightWords(c, profile, limit, money);
  const rec = recommendationOf(c);
  const pending = c.decision === 'pending';
  const lines = countChargeLines(c);

  const loadNotes = async () => setNotes(await followUpsAbout('charge', [c.$id]).catch(() => []));
  useEffect(() => { void loadNotes(); }, [c.$id]); // eslint-disable-line react-hooks/exhaustive-deps

  const decide = async (decision: Choice, amount = 0, why = '') => {
    const problem = decisionProblem(c, decision, amount, why);
    if (problem) { setError(problem); return false; }
    setBusy(decision);
    setError(null);
    try {
      const r = await decideCountCharge({ venueId: 'main', chargeId: c.$id, decision, amount, note: why, ...who });
      if (!r.ok) { setError(r.error ?? 'That did not go through.'); return false; }
      toast({
        deduct: `Deducted ${money(c.amount)} from ${c.person_name}'s pay. It goes to HIVE with this month's deductions.`,
        part: `Deducted ${money(amount)} and waived the rest. ${c.person_name} sees why.`,
        waived: `Waived. Nothing is taken. ${c.person_name} sees your reason.`,
        putback: `Agreed. ${money(c.amount)} is added to ${c.person_name}'s drawer at their next shift.`,
      }[decision]);
      await onChanged();
      return true;
    } catch (e) {
      setError(humanError(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const recommend = async (decision: Choice, amount: number, why: string) => {
    const problem = recommendProblem(c, { decision, amount, note: why });
    if (problem) { setError(problem); return false; }
    setBusy('recommend');
    setError(null);
    try {
      const r = await recommendCountCharge({ venueId: 'main', chargeId: c.$id, decision, amount, note: why, ...who });
      if (!r.ok) { setError(r.error ?? 'That did not go through.'); return false; }
      toast('Recommended. An admin or a manager confirms it; it is on their To do.');
      await onChanged();
      return true;
    } catch (e) {
      setError(humanError(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const undo = async () => {
    const problem = countUndoProblem(c);
    if (problem) { setError(problem); return; }
    setBusy('undo');
    try {
      const r = await undoCountCharge({ venueId: 'main', chargeId: c.$id, ...who });
      if (!r.ok) { setError(r.error ?? 'That did not go through.'); return; }
      toast('Taken back. It is waiting for a decision again, and the clock will not decide it.');
      await onChanged();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  };

  const saveNote = async () => {
    setBusy('note');
    setError(null);
    try {
      await addNote('main', { refKind: 'charge', refId: c.$id, refLabel: `${c.person_name}, ${money(c.amount)}` }, note, who);
      setNote('');
      await loadNotes();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  };

  // Everything said and done about it, oldest first.
  const timeline: { at: string; text: string }[] = [
    { at: c.charged_at, text: `${c.phase === 'open' ? 'Start-of-shift' : 'End-of-shift'} count came up ${money(c.amount)} short. On ${c.person_name}'s account${c.phase === 'open' ? ', who ran the shift before' : ''}.` },
    ...(c.answered_at ? [{ at: c.answered_at, text: `${c.person_name}: ${c.answer ? ANSWER_WORDS[c.answer] : 'answered'}${c.answer_note ? `, “${c.answer_note}”` : ''}` }] : []),
    ...(notes ?? []).map((n) => ({
      at: n.$createdAt ?? n.done_at ?? '',
      text: n.kind === 'note'
        ? `${n.created_name || 'Somebody'}: “${n.note || n.title}”`
        : `Follow-up for ${n.for_name || (n.for_role === 'auditor' ? 'the auditor' : n.for_role === 'manager' ? 'a manager' : n.for_role === 'admin' ? 'an admin' : 'somebody')}: ${n.title}${n.status === 'done' ? ' (done)' : ''}`,
    })),
    ...(c.recommended_at && c.recommended_decision ? [{ at: c.recommended_at, text: `${c.recommended_name || 'The auditor'} recommends: ${recommendationWords(c, { decision: c.recommended_decision, amount: c.recommended_amount ?? 0 }, money)}${c.recommended_note ? `, “${c.recommended_note}”` : ''}` }] : []),
    ...(c.decided_at ? [{ at: c.decided_at, text: `Decided by ${c.decided_name || 'a manager'}: ${stageWords(c, now).label}${c.decided_note ? `, “${c.decided_note}”` : ''}` }] : []),
  ].filter((x) => x.at).sort((a, b) => a.at.localeCompare(b.at));

  const choices: { choice: Choice; label: string; hint: string }[] = [
    ...(c.answer === 'putback' ? [{ choice: 'putback' as const, label: `Let them put back ${money(c.amount)}`, hint: 'Added to their drawer at their next shift' }] : []),
    { choice: 'deduct', label: `Deduct ${money(c.amount)}`, hint: 'Taken from pay, sent to HIVE with the month' },
    { choice: 'part', label: 'Deduct part', hint: 'Choose how much and say why' },
    { choice: 'waived', label: 'Waive', hint: 'Nothing is taken; the reason is kept' },
  ];

  return (
    <Card
      title={`${c.person_name} · ${money(c.amount)}`}
      actions={<Badge tone={pending ? 'warn' : 'default'}>{pending && countStage(c, now) === 'answering' ? `Not final · ${timeLeftWords(msLeft(c, now))} left` : stageWords(c, now).label}</Badge>}
    >
      <div style={{ display: 'grid', gap: '0.9rem' }}>
        <CountLinesTable lines={lines} total={c.amount} money={money} />

        <ol className="timeline">
          {timeline.map((t, i) => <li key={i}><time>{when(t.at)}</time><span>{t.text}</span></li>)}
        </ol>

        {rec && pending && (
          <Notice tone="warn">
            {rec.by} recommends: <b>{recommendationWords(c, rec, money)}</b>{rec.note ? `. “${rec.note}”` : ''}
            {right === 'decide' && (
              <div style={{ marginTop: '0.5rem' }}>
                <Button
                  size="sm"
                  variant="primary"
                  loading={busy === rec.decision}
                  onClick={() => void decide(rec.decision, rec.amount, rec.note || `As ${rec.by} recommended.`)}
                >
                  Confirm it
                </Button>
              </div>
            )}
          </Notice>
        )}

        {pending && (
          <div style={{ display: 'grid', gap: '0.4rem' }}>
            {right !== 'none' && choices.map((x) => (
              <button
                key={x.choice}
                type="button"
                className="choice card-pad"
                style={{ border: '1px solid var(--hair)', borderRadius: 10, padding: '0.6rem 0.8rem', cursor: 'pointer', background: 'var(--surface)' }}
                disabled={!!busy}
                onClick={() => {
                  if (right === 'recommend' || x.choice === 'part' || x.choice === 'waived') setAsking({ choice: x.choice, recommend: right === 'recommend' });
                  else void decide(x.choice);
                }}
              >
                <b>{right === 'recommend' ? `Recommend: ${x.label}` : x.label}</b>
                <div className="small dim">{x.hint}</div>
              </button>
            ))}
            {rightWords && <p className="small dim" style={{ margin: 0 }}>{rightWords}</p>}
            {right === 'decide' && profile?.role === 'auditor' && (
              <p className="small dim" style={{ margin: 0 }}>Within your limit of {money(limit)}: your decision is final.</p>
            )}
          </div>
        )}
        {!pending && !countUndoProblem(c) && right === 'decide' && (
          <div><Button size="sm" loading={busy === 'undo'} onClick={() => void undo()}>Undo the decision</Button></div>
        )}

        <Field label="Add a note" hint="Kept with this difference for good. The person does not see notes.">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Club short for the second time this month. Checking the delivery note." />
        </Field>
        <div className="row row-wrap" style={{ gap: '0.5rem' }}>
          <Button size="sm" disabled={note.trim().length < 3} loading={busy === 'note'} onClick={() => void saveNote()}>Save the note</Button>
          <Button size="sm" onClick={() => setFollowing(true)}>Add a follow-up</Button>
          {c.shift_id && <Link className="btn btn-sm btn-ghost" to="/counts">See the count</Link>}
        </div>
        {error && <Notice>{error}</Notice>}
      </div>

      {asking && (
        <ReasonModal
          charge={c}
          choice={asking.choice}
          recommend={asking.recommend}
          money={money}
          decimals={settings?.currency_decimals ?? 2}
          onClose={() => setAsking(null)}
          onSave={async (amount, why) => {
            const ok = asking.recommend ? await recommend(asking.choice, amount, why) : await decide(asking.choice, amount, why);
            if (ok) setAsking(null);
          }}
        />
      )}
      {following && (
        <AddFollowUpModal
          about={{ refKind: 'charge', refId: c.$id, refLabel: `${c.person_name}'s difference, ${money(c.amount)}` }}
          suggested={`Follow up ${c.person_name}'s difference`}
          onClose={() => setFollowing(false)}
          onAdded={async () => { setFollowing(false); toast('Follow-up added.'); await loadNotes(); }}
        />
      )}
    </Card>
  );
}

function ReasonModal({ charge, choice, recommend, money, decimals, onClose, onSave }: {
  charge: CountCharge;
  choice: Choice;
  recommend: boolean;
  money: (n: number) => string;
  decimals: number;
  onClose: () => void;
  onSave: (amount: number, note: string) => Promise<void>;
}) {
  const [amountText, setAmountText] = useState(choice === 'part' ? toInput(Math.round(charge.amount / 2), decimals) : '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const amount = choice === 'part' ? (parseMoney(amountText, decimals) ?? 0) : 0;
  const problem = recommend
    ? recommendProblem(charge, { decision: choice, amount, note })
    : decisionProblem(charge, choice, amount, note);
  const verb = choice === 'part' ? `Deduct ${money(amount)}` : choice === 'waived' ? 'Waive it' : choice === 'putback' ? 'Let them put it back' : `Deduct ${money(charge.amount)}`;
  return (
    <Modal
      title={recommend ? 'Recommend a decision'
        : choice === 'part' ? `Deduct part of ${money(charge.amount)}` : `Waive ${money(charge.amount)}`}
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!!problem}
            onClick={async () => { setBusy(true); await onSave(amount, note); setBusy(false); }}
          >
            {recommend ? `Recommend: ${verb}` : verb}
          </Button>
        </>
      )}
    >
      {recommend && (
        <p className="small dim" style={{ marginTop: 0 }}>
          This is above your limit, so nothing is decided yet. An admin or a manager sees your recommendation on their
          To do and confirms it or decides otherwise.
        </p>
      )}
      {choice === 'part' && (
        <Field
          label={`How much to take from ${charge.person_name}'s pay`}
          hint={`The rest, ${money(Math.max(0, charge.amount - amount))}, is waived.`}
        >
          <Input inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} autoFocus />
        </Field>
      )}
      <Field label={recommend ? 'Why' : `Why${choice === 'part' ? ' only part' : ''}? ${charge.person_name} sees this.`}>
        <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} autoFocus={choice !== 'part'} />
      </Field>
      {problem && (amountText || note) && <p className="small dim">{problem}</p>}
    </Modal>
  );
}

/**
 * Differences › Closed: every difference that has been decided, with who
 * decided it and why. Searchable by person, newest first.
 */
export function ClosedDifferences() {
  const money = useMoney();
  const { rows } = useCountCharges();
  const [find, setFind] = useState('');
  const [now] = useState(() => new Date());
  const closed = useMemo(() => (rows ?? [])
    .filter((c) => !isOpenCase(c))
    .filter((c) => !find.trim() || c.person_name.toLowerCase().includes(find.trim().toLowerCase()))
    .sort((a, b) => (b.decided_at ?? b.charged_at).localeCompare(a.decided_at ?? a.charged_at)), [rows, find]);
  return (
    <>
      <div className="spread">
        <h1><HubTitle>Closed</HubTitle></h1>
        <Input type="search" placeholder="Find a person" value={find} onChange={(e) => setFind(e.target.value)} style={{ maxWidth: '16rem' }} aria-label="Find a person" />
      </div>
      <HubTabs />
      <Card pad={false}>
        {!rows ? <div className="card-pad"><Spinner /></div> : closed.length === 0 ? (
          <Empty title="Nothing decided yet">Every decided difference shows here, with who decided it and why.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Counted</th><th>Person</th><th className="num">Difference</th><th>Outcome</th><th className="num">Taken</th><th>Decided by</th><th>Why</th></tr>
              </thead>
              <tbody>
                {closed.map((c) => (
                  <tr key={c.$id}>
                    <td className="small">{dateTimeWords(c.charged_at)}</td>
                    <td><b>{c.person_name}</b></td>
                    <td className="num">{money(c.amount)}</td>
                    <td><Badge tone={c.decision === 'waived' ? 'ok' : 'default'}>{stageWords(c, now).label}</Badge>{c.hive_sent_at && <div className="small dim">Sent to HIVE</div>}</td>
                    <td className="num">{money(deductedAmount(c))}</td>
                    <td className="small">{c.decided_name || '—'}{c.decided_at && <div className="dim">{dateTimeWords(c.decided_at)}</div>}</td>
                    <td className="small dim">{c.decided_note || (c.recommended_note ? `Recommended: “${c.recommended_note}”` : '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

/**
 * The line on To do › To decide about count differences: how many wait, and
 * the way to them. They are decided on Differences, where their whole story is.
 */
export function DifferencesWaiting() {
  const { profile } = useSession();
  const money = useMoney();
  const { rows, limit } = useCountCharges();
  const pending = (rows ?? []).filter((c) => c.decision === 'pending');
  const recs = pending.filter((c) => recommendationOf(c) && decisionRight(c, profile, limit) === 'decide');
  const mine = pending.filter((c) => decisionRight(c, profile, limit) !== 'none' && countStage(c, new Date()) !== 'answering');
  if (!rows || pending.length === 0) return null;
  const total = pending.reduce((a, c) => a + c.amount, 0);
  return (
    <Card
      title={`Count differences (${pending.length})`}
      actions={<Link className="btn btn-sm btn-primary" to="/differences">Review on Differences</Link>}
    >
      <p style={{ margin: 0 }}>
        {pending.length} not decided, {money(total)} in all.
        {mine.length > 0 ? ` ${mine.length} waiting on a decision from you.` : ''}
        {recs.length > 0 ? ` ${recs.length} with a recommendation to confirm.` : ''}
      </p>
    </Card>
  );
}
