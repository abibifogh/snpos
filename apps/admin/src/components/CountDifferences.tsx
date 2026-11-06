import { useEffect, useState } from 'react';
import { Badge, Button, Card, Field, Input, Modal, Notice, Textarea, CountLinesTable, useToast } from '@snpos/ui';
import {
  loadCountCharges, decideCountCharge, undoCountCharge, countChargeLines, countStage, stageWords, decisionProblem,
  countUndoProblem, timeLeftWords, msLeft, subscribeCollection, parseMoney, toInput,
} from '@snpos/core';
import type { CountCharge, CountDecision } from '@snpos/core';
import { useSession, useMoney } from '../session';
import { humanError } from '../lib';

type Choice = Exclude<CountDecision, 'pending'>;

const ANSWER_WORDS: Record<string, string> = {
  accept: 'Accepted: take it from my pay',
  putback: 'Offered to put it back at the next shift',
  explain: 'Explained',
};

const when = (iso?: string | null): string =>
  iso ? new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

/**
 * Count differences for a manager to decide: one row per person, per count,
 * per amount, with their answer and the time they have left.
 *
 * Deduct all, deduct part, waive, or agree to the put-back they offered. Part
 * and waive ask for a reason, which the person sees. A decision can be taken
 * back until it has gone to HIVE. Decided rows stay here for three days so a
 * mistake can be seen and undone; Staff owing keeps them all.
 *
 * Nothing is written to the charge from here: a decision is sent to the
 * server, which checks it came from an admin or a manager and makes it. See
 * functions/notify/src/count-charges.js.
 */
export function CountDifferences() {
  const { profile, settings } = useSession();
  const money = useMoney();
  const toast = useToast();
  const [rows, setRows] = useState<CountCharge[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ charge: CountCharge; choice: 'part' | 'waived' } | null>(null);
  const [now, setNow] = useState(() => new Date());

  const load = async () => {
    try {
      setRows(await loadCountCharges('main'));
    } catch {
      // Not provisioned yet, or not allowed: say nothing rather than an error on Approvals.
      setRows([]);
    }
  };
  useEffect(() => {
    void load();
    const off = subscribeCollection<CountCharge>('staff_charges', () => { void load(); });
    const tick = window.setInterval(() => setNow(new Date()), 60_000);
    return () => { off(); window.clearInterval(tick); };
  }, []);

  const recent = (c: CountCharge) => c.decision === 'pending'
    || (c.decision === 'putback' && c.status === 'open')
    || (!!c.decided_at && now.getTime() - new Date(c.decided_at).getTime() < 3 * 86_400_000);
  const shown = (rows ?? []).filter(recent);
  const open = shown.filter((c) => c.decision === 'pending');
  if (!rows || shown.length === 0) return null;

  const who = { profileId: profile?.$id ?? '', name: profile?.display_name ?? '' };

  const decide = async (c: CountCharge, decision: Choice, amount = 0, note = '') => {
    const problem = decisionProblem(c, decision, amount, note);
    if (problem) { setError(problem); return false; }
    setBusy(c.$id);
    setError(null);
    try {
      const r = await decideCountCharge({ venueId: 'main', chargeId: c.$id, decision, amount, note, ...who });
      if (!r.ok) { setError(r.error ?? 'That did not go through.'); return false; }
      toast({
        deduct: `Deducted ${money(c.amount)} from ${c.person_name}'s pay. It goes to HIVE with this month's deductions.`,
        part: `Deducted ${money(amount)} and waived the rest. ${c.person_name} sees why.`,
        waived: `Waived. Nothing is taken. ${c.person_name} sees your reason.`,
        putback: `Agreed. ${money(c.amount)} is added to ${c.person_name}'s drawer at their next shift.`,
      }[decision]);
      await load();
      return true;
    } catch (e) {
      setError(humanError(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const undo = async (c: CountCharge) => {
    const problem = countUndoProblem(c);
    if (problem) { setError(problem); return; }
    setBusy(c.$id);
    setError(null);
    try {
      const r = await undoCountCharge({ venueId: 'main', chargeId: c.$id, ...who });
      if (!r.ok) { setError(r.error ?? 'That did not go through.'); return; }
      toast('Taken back. It is waiting for a decision again, and the clock will not decide it.');
      await load();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title={`Count differences${open.length ? ` to decide (${open.length})` : ''}`}
      help={(
        <>
          A bar count takes effect when it is saved, and anything short, less anything over on the same count, at
          selling price, goes on the account of whoever answers for it: the closing shift for a closing count, the
          shift before for an opening count. It is not final. They have a day to accept it,
          explain, or offer to put it back. If they accept or say nothing it is deducted at the deadline; if they
          explain or offer it back it waits for you. Final deductions go to HIVE from Staff › Staff owing.
        </>
      )}
    >
      {error && <Notice>{error}</Notice>}
      <div className="count-diffs">
        {shown.map((c) => {
          const stage = countStage(c, now);
          const pill = stageWords(c, now);
          const pending = c.decision === 'pending';
          const lines = countChargeLines(c);
          return (
            <div key={c.$id} className="count-diff">
              <div className="spread" style={{ alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0 }}>{c.person_name} · {money(c.amount)}</h3>
                <Badge tone={pill.tone === 'warn' ? 'warn' : pill.tone === 'ok' ? 'ok' : 'default'}>
                  {pending && stage === 'answering' ? `Not final · ${timeLeftWords(msLeft(c, now))} left` : pill.label}
                </Badge>
              </div>
              <p className="small dim" style={{ margin: '0.2rem 0 0.6rem' }}>
                Bar count, {c.phase === 'open' ? 'counted in' : 'closing'} {when(c.charged_at)}
                {c.phase === 'open' ? ' · charged to the shift before, which handed it over' : ''}
              </p>
              <CountLinesTable lines={lines} total={c.amount} money={money} />
              {(pending || c.answer) && (
                <div className="count-said" style={{ marginTop: '0.6rem' }}>
                  <small>{c.person_name}&rsquo;s answer</small>
                  <b>{c.answer ? ANSWER_WORDS[c.answer] : 'No answer yet'}</b>
                  {c.answer_note && <span>“{c.answer_note}”</span>}
                </div>
              )}
              {!pending && (
                <p className="small" style={{ margin: '0.6rem 0 0' }}>
                  {c.decided_name ? `${c.decided_name}, ${when(c.decided_at)}` : when(c.decided_at)}
                  {c.decided_note ? ` · “${c.decided_note}”` : ''}
                  {c.hive_sent_at ? ` · sent to HIVE ${when(c.hive_sent_at)}` : ''}
                </p>
              )}
              {c.reopened_by && pending && <p className="small dim" style={{ margin: '0.4rem 0 0' }}>A decision was taken back, so this waits for a manager.</p>}
              <div className="row-actions" style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {pending ? (
                  <>
                    {c.answer === 'putback' && (
                      <Button variant="primary" loading={busy === c.$id} onClick={() => void decide(c, 'putback')}>
                        Agree: put back {money(c.amount)} next shift
                      </Button>
                    )}
                    <Button
                      variant={c.answer === 'putback' ? 'default' : 'primary'}
                      loading={busy === c.$id && c.answer !== 'putback'}
                      disabled={busy === c.$id}
                      onClick={() => void decide(c, 'deduct')}
                    >
                      Deduct {money(c.amount)} from pay
                    </Button>
                    <Button disabled={busy === c.$id} onClick={() => setAsking({ charge: c, choice: 'part' })}>Deduct part…</Button>
                    <Button disabled={busy === c.$id} onClick={() => setAsking({ charge: c, choice: 'waived' })}>Waive…</Button>
                  </>
                ) : !countUndoProblem(c) ? (
                  <Button size="sm" loading={busy === c.$id} onClick={() => void undo(c)}>Undo</Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {asking && (
        <ReasonModal
          charge={asking.charge}
          choice={asking.choice}
          money={money}
          decimals={settings?.currency_decimals ?? 2}
          onClose={() => setAsking(null)}
          onSave={async (amount, note) => {
            const ok = await decide(asking.charge, asking.choice, amount, note);
            if (ok) setAsking(null);
          }}
        />
      )}
    </Card>
  );
}

function ReasonModal({ charge, choice, money, decimals, onClose, onSave }: {
  charge: CountCharge;
  choice: 'part' | 'waived';
  money: (n: number) => string;
  decimals: number;
  onClose: () => void;
  onSave: (amount: number, note: string) => Promise<void>;
}) {
  const [amountText, setAmountText] = useState(choice === 'part' ? toInput(Math.round(charge.amount / 2), decimals) : '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const amount = choice === 'part' ? (parseMoney(amountText, decimals) ?? 0) : 0;
  const problem = decisionProblem(charge, choice, amount, note);
  return (
    <Modal
      title={choice === 'part' ? `Deduct part of ${money(charge.amount)}` : `Waive ${money(charge.amount)}`}
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
            {choice === 'part' ? `Deduct ${money(amount)}` : 'Waive it'}
          </Button>
        </>
      )}
    >
      {choice === 'part' && (
        <Field
          label={`How much to take from ${charge.person_name}'s pay`}
          hint={`The rest, ${money(Math.max(0, charge.amount - amount))}, is waived.`}
        >
          <Input inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} autoFocus />
        </Field>
      )}
      <Field label={`Why${choice === 'part' ? ' only part' : ''}? ${charge.person_name} sees this.`}>
        <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} autoFocus={choice === 'waived'} />
      </Field>
      {problem && (amountText || note) && <p className="small dim">{problem}</p>}
    </Modal>
  );
}
