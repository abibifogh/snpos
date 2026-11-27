import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, Empty, Field, Input, Modal, Notice, Segmented, Select, Spinner, Textarea, useToast } from '@snpos/ui';
import {
  loadFollowUps, addFollowUp, closeFollowUp, reopenFollowUp, followUpProblem, closeProblem, sortFollowUps, dueWords, dueTone,
  whoseWords, isMine, doneLately, dayOf, followUpStage, subscribeCollection, listAll, dateTimeWords,
} from '@snpos/core';
import type { FollowUp, FollowUpFor, FollowUpRef, StaffProfile } from '@snpos/core';
import { HubTabs, HubTitle } from '../components/Hub';
import { useSession } from '../session';
import { humanError } from '../lib';

/** Where a follow-up's "Open" goes, by what it is about. */
const linkFor = (f: FollowUp): string | null =>
  f.ref_kind === 'charge' ? '/differences'
    : f.ref_kind === 'shift' ? (f.auto_key?.startsWith('nocount:') ? '/counts?tab=missed' : '/shifts')
      : f.ref_kind === 'count' ? '/todo?tab=decide'
        : f.ref_kind === 'month' ? '/differences?tab=hive'
          : null;

/**
 * To follow up: everything with a due day, and what was done this week.
 *
 * Most rows are raised by the system each hour (a difference nobody has
 * reviewed, a shift closed with no count, a put-back not returned, deductions
 * not sent to HIVE) and close themselves when the thing is done. Anybody here
 * can add one, and close one by saying what was done. Overdue first; amber on
 * its day, red after. See follow-ups.ts.
 */
export function FollowUpsPage({ view = 'open' }: { view?: 'open' | 'done' }) {
  const { profile } = useSession();
  const toast = useToast();
  const [rows, setRows] = useState<FollowUp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [whose, setWhose] = useState<'mine' | 'all'>('all');
  const [adding, setAdding] = useState(false);
  const [closing, setClosing] = useState<FollowUp | null>(null);
  const today = dayOf(new Date());
  const me = { profileId: profile?.$id ?? '', name: profile?.display_name ?? '' };

  const load = async () => {
    try {
      setRows(await loadFollowUps('main'));
    } catch (e) {
      setError(humanError(e));
      setRows([]);
    }
  };
  useEffect(() => {
    void load();
    const off = subscribeCollection<FollowUp>('follow_ups', () => { void load(); });
    return () => off();
  }, []);

  const open = useMemo(() => sortFollowUps((rows ?? []).filter((f) => f.status === 'open' && (whose === 'all' || isMine(f, profile)))), [rows, whose, profile]);
  const done = useMemo(() => doneLately(rows ?? [], new Date()), [rows]);
  const overdue = open.filter((f) => followUpStage(f, today) === 'overdue').length;

  const reopen = async (f: FollowUp) => {
    try {
      await reopenFollowUp(f.$id);
      toast('Opened again.');
      await load();
    } catch (e) {
      setError(humanError(e));
    }
  };

  return (
    <>
      <div className="spread">
        <h1><HubTitle>{view === 'done' ? 'Done this week' : 'To follow up'}</HubTitle></h1>
        <div className="row row-wrap" style={{ gap: '0.5rem' }}>
          {view === 'open' && (
            <Segmented<'mine' | 'all'>
              value={whose}
              onChange={setWhose}
              ariaLabel="Whose"
              options={[{ value: 'all', label: 'Everybody\'s' }, { value: 'mine', label: 'Mine' }]}
            />
          )}
          <Button variant="primary" onClick={() => setAdding(true)}>Add a follow-up</Button>
        </div>
      </div>
      <HubTabs />
      {error && <Notice>{error}</Notice>}

      {view === 'open' ? (
        <>
          {overdue > 0 && <Notice tone="warn">{overdue} overdue. Each morning whoever it is for gets an email; two days late, the admins do too.</Notice>}
          <Card pad={false}>
            {!rows ? <div className="card-pad"><Spinner /></div> : open.length === 0 ? (
              <Empty title="Nothing to follow up">
                The system adds a follow-up when something is left waiting: a difference nobody has reviewed, a shift
                with no count, a put-back not returned. You can add your own.
              </Empty>
            ) : open.map((f) => {
              const to = linkFor(f);
              return (
                <div key={f.$id} className="follow-row">
                  <div>
                    <b>{f.title}</b>
                    <div className="small dim">{whoseWords(f)}{f.note ? ` · ${f.note}` : ''}</div>
                  </div>
                  <div className="acts">
                    <Badge tone={dueTone(f, today)}>{dueWords(f, today)}</Badge>
                    {to && <Link className="btn btn-sm" to={to}>Open</Link>}
                    <Button size="sm" onClick={() => setClosing(f)}>Done</Button>
                  </div>
                </div>
              );
            })}
          </Card>
        </>
      ) : (
        <Card pad={false}>
          {!rows ? <div className="card-pad"><Spinner /></div> : done.length === 0 ? (
            <Empty title="Nothing closed this week">Follow-ups closed in the last seven days show here, with who closed them and why.</Empty>
          ) : done.map((f) => (
            <div key={f.$id} className="follow-row">
              <div>
                <b>{f.title}</b>
                <div className="small dim">
                  {f.done_name || 'Somebody'}, {f.done_at ? dateTimeWords(f.done_at) : ''}{f.done_note ? ` · “${f.done_note}”` : ''}
                </div>
              </div>
              <div className="acts">
                <Button size="sm" variant="ghost" onClick={() => void reopen(f)}>Open again</Button>
              </div>
            </div>
          ))}
        </Card>
      )}

      {adding && (
        <AddFollowUpModal
          onClose={() => setAdding(false)}
          onAdded={async () => { setAdding(false); toast('Added. It is on To follow up.'); await load(); }}
        />
      )}
      {closing && (
        <CloseModal
          followUp={closing}
          onClose={() => setClosing(null)}
          onSave={async (note) => {
            await closeFollowUp(closing.$id, note, me);
            setClosing(null);
            toast('Done.');
            await load();
          }}
        />
      )}
    </>
  );
}

/**
 * Add a follow-up: what, who it is for, and the day it is due. Opened from To
 * do, or from a count difference with `about` set, so it is linked to it.
 */
export function AddFollowUpModal({ about, suggested, onClose, onAdded }: {
  about?: { refKind: FollowUpRef; refId: string; refLabel?: string };
  suggested?: string;
  onClose: () => void;
  onAdded: () => void | Promise<void>;
}) {
  const { profile } = useSession();
  const [title, setTitle] = useState(suggested ?? '');
  const [note, setNote] = useState('');
  const [dueOn, setDueOn] = useState(dayOf(new Date(Date.now() + 86_400_000)));
  const [forRole, setForRole] = useState<FollowUpFor>('auditor');
  const [forId, setForId] = useState('');
  const [people, setPeople] = useState<StaffProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    listAll<StaffProfile>('staff_profiles')
      .then((r) => setPeople(r.filter((p) => p.active !== false).sort((a, b) => a.display_name.localeCompare(b.display_name))))
      .catch(() => undefined);
  }, []);
  const person = people.find((p) => p.$id === forId);
  const problem = followUpProblem({ title, dueOn, forRole, forId }, dayOf(new Date()));

  const save = async () => {
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      await addFollowUp('main', {
        title, note, dueOn, forRole, forId, forName: person?.display_name,
        refKind: about?.refKind, refId: about?.refId, refLabel: about?.refLabel,
      }, { profileId: profile?.$id ?? '', name: profile?.display_name ?? '' });
      await onAdded();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add a follow-up"
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!!problem} onClick={() => void save()}>Add</Button>
        </>
      )}
    >
      {about?.refLabel && <p className="small dim" style={{ marginTop: 0 }}>About {about.refLabel}.</p>}
      <Field label="What needs doing">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="Recount the spirits shelf with Kojo" />
      </Field>
      <div className="grid-2">
        <Field label="Who it is for">
          <Select value={forRole} onChange={(e) => setForRole(e.target.value as FollowUpFor)}>
            <option value="auditor">The auditor</option>
            <option value="manager">A manager</option>
            <option value="admin">An admin</option>
            <option value="person">One person…</option>
          </Select>
        </Field>
        <Field label="Due">
          <Input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
        </Field>
      </div>
      {forRole === 'person' && (
        <Field label="Which person" hint="They get it in the morning email on its day.">
          <Select value={forId} onChange={(e) => setForId(e.target.value)}>
            <option value="">Choose…</option>
            {people.map((p) => <option key={p.$id} value={p.$id}>{p.display_name}</option>)}
          </Select>
        </Field>
      )}
      <Field label="Anything else" hint="Optional.">
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {error && <Notice>{error}</Notice>}
    </Modal>
  );
}

function CloseModal({ followUp, onClose, onSave }: { followUp: FollowUp; onClose: () => void; onSave: (note: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = closeProblem(note);
  return (
    <Modal
      title="Mark as done"
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!!problem}
            onClick={async () => {
              setBusy(true);
              try { await onSave(note); } catch (e) { setError(humanError(e)); } finally { setBusy(false); }
            }}
          >
            Done
          </Button>
        </>
      )}
    >
      <p style={{ marginTop: 0 }}><b>{followUp.title}</b></p>
      <Field label="What was done" hint="One line. It is kept with the follow-up.">
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
      </Field>
      {followUp.auto_key && (
        <p className="small dim">
          The system raised this one. Closing it here keeps it closed; it does not come back on its own.
        </p>
      )}
      {error && <Notice>{error}</Notice>}
    </Modal>
  );
}
