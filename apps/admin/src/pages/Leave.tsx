import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Notice, Select, Spinner, useToast } from '@snpos/ui';
import { humanError, db, DB_ID } from '../lib';
import {
  leaveCap, daysInRange, dayWords, dayLoads, loadWords, overCapDays, capChangeWords,
  requestLeave, decideLeave, loadLeave, listAll, Query,
  LEAVE_CAP_MAX,
} from '@snpos/core';
import type { FiledLeave, LeaveKind, StaffProfile } from '@snpos/core';
import { useSession } from '../session';

const todayStr = () => new Date().toLocaleDateString('en-CA');
const plusDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Who is off, and whether the floor is covered.
 *
 * A rota has one hard constraint and this page exists to hold it: no more than
 * a set number of people off on the same day. Everything else about time off
 * is a conversation between people, and this deliberately does not model it —
 * no entitlements, no accruals, no carry-over. The floor being empty on the
 * fourteenth is the thing software can actually prevent.
 *
 * The rules are in leave.ts, which has no database in it. See there for why a
 * request that nobody has answered still holds its place.
 */
export function LeavePage() {
  const { settings, profile, user, refreshSettings } = useSession();
  const toast = useToast();

  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(plusDays(todayStr(), 27));
  const [rows, setRows] = useState<FiledLeave[] | null>(null);
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** The house's number, and the box an admin types a new one into. */
  const cap = leaveCap(settings?.leave_max_per_day);
  const [capText, setCapText] = useState(String(cap));
  const [capBusy, setCapBusy] = useState(false);
  const isAdmin = profile?.role === 'admin';

  // Booking somebody off, which a manager does for people who do not use a
  // screen. Their own requests come from their own Account page.
  const [forStaff, setForStaff] = useState('');
  const [bookFrom, setBookFrom] = useState(todayStr());
  const [bookTo, setBookTo] = useState(todayStr());
  const [bookKind, setBookKind] = useState<LeaveKind>('leave');
  const [bookReason, setBookReason] = useState('');
  const [refusals, setRefusals] = useState<string[]>([]);

  const load = async () => {
    setError(null);
    try {
      const [leave, people] = await Promise.all([
        loadLeave('main', from, to),
        listAll<StaffProfile>('staff_profiles', [Query.equal('active', true)]).catch(() => []),
      ]);
      setRows(leave);
      setStaff(people);
    } catch (e) {
      setError(humanError(e));
      setRows([]);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [from, to]);
  useEffect(() => { setCapText(String(cap)); }, [cap]);

  const days = useMemo(() => daysInRange(from, to), [from, to]);
  const loads = useMemo(() => dayLoads(rows ?? [], days, cap), [rows, days, cap]);
  const waiting = useMemo(
    () => (rows ?? []).filter((r) => (r.status ?? 'requested') === 'requested')
      .sort((a, b) => a.day.localeCompare(b.day)),
    [rows],
  );

  /**
   * Lowering the cap unbooks nobody.
   *
   * Leave already agreed is somebody's plan — a bus booked, a family thing —
   * and software that quietly cancelled it to satisfy a number an admin typed
   * would be worse than the overbooking it was fixing. The days now over are
   * named and left for a person.
   */
  const wouldBeOver = useMemo(() => {
    const next = leaveCap(Number(capText));
    return next === cap ? [] : overCapDays(rows ?? [], days, next);
  }, [capText, cap, rows, days]);

  const saveCap = async () => {
    if (!settings) return;
    setCapBusy(true);
    try {
      await db.updateDocument(DB_ID, 'settings', settings.$id, {
        leave_max_per_day: leaveCap(Number(capText)),
      });
      await refreshSettings?.();
      const note = capChangeWords(wouldBeOver);
      toast(`At most ${leaveCap(Number(capText))} can now be off on one day`);
      if (note) toast(note, 'err');
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setCapBusy(false);
    }
  };

  const book = async () => {
    const who = staff.find((s) => s.$id === forStaff);
    if (!who) return;
    setBusy(true);
    setRefusals([]);
    try {
      const result = await requestLeave({
        venueId: 'main',
        staffId: who.$id,
        staffName: who.display_name,
        days: daysInRange(bookFrom, bookTo),
        kind: bookKind,
        reason: bookReason.trim(),
        cap,
        // A manager booking somebody off has already decided. Filing it as a
        // request they would then have to approve is a step that exists only
        // to be clicked.
        approvedBy: user?.$id ?? '',
        showNames: true,
      });
      await load();
      setRefusals(result.refused.map((r) => r.reason));
      if (result.booked.length > 0) {
        toast(`${who.display_name} is off for ${result.booked.length} `
          + `${result.booked.length === 1 ? 'day' : 'days'}`);
        setBookReason('');
      } else {
        toast('Nothing was booked — see the reasons below', 'err');
      }
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const decide = async (row: FiledLeave, to2: 'approved' | 'refused') => {
    setBusy(true);
    try {
      const { ok, problem } = await decideLeave({
        venueId: 'main', rowId: row.$id, to: to2, userId: user?.$id ?? '', cap,
      });
      await load();
      toast(
        problem ?? `${row.staff_name ?? 'That'} — ${dayWords(row.day)} ${to2 === 'approved' ? 'agreed' : 'refused'}`,
        ok ? undefined : 'err',
      );
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <h1>Time off</h1>
      {error && <Notice>{error}</Notice>}

      {/*
        THE ONLY RULE THIS PAGE HOLDS, and where the number lives.

        Set by the house because three is right for a bar with nine staff and
        wrong for one with four.
      */}
      <Card title="How many can be off at once">
        <p className="small dim" style={{ marginTop: 0 }}>
          Nobody can book a day that already has this many people off or waiting for an answer, and the screen
          tells them which day and why. A request nobody has answered yet still takes up a place — four people
          expecting to be away on one Saturday is the same problem whether or not anybody has said yes.
        </p>
        <div className="row" style={{ gap: '0.8rem', alignItems: 'flex-end' }}>
          <Field label="People off on one day" hint={`At most ${LEAVE_CAP_MAX}.`}>
            <Input
              value={capText}
              inputMode="numeric"
              style={{ width: '7rem' }}
              disabled={!isAdmin}
              onChange={(e) => setCapText(e.target.value)}
            />
          </Field>
          {isAdmin && (
            <Button
              loading={capBusy}
              disabled={leaveCap(Number(capText)) === cap}
              onClick={() => void saveCap()}
            >
              Save
            </Button>
          )}
        </div>
        {!isAdmin && (
          <p className="small dim" style={{ marginBottom: 0 }}>Only an admin can change this.</p>
        )}
        {/* Said before it is saved, not discovered afterwards. */}
        {wouldBeOver.length > 0 && (
          <Notice tone="warn">{capChangeWords(wouldBeOver)}</Notice>
        )}
      </Card>

      <Card title="Waiting for an answer">
        {rows === null ? <Spinner /> : waiting.length === 0 ? (
          <Empty title="Nothing is waiting">A request appears here the moment somebody asks for a day.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Who</th><th>Day</th><th>What</th><th>Why</th><th /></tr>
              </thead>
              <tbody>
                {waiting.map((r) => (
                  <tr key={r.$id}>
                    <td style={{ fontWeight: 550 }}>{r.staff_name}</td>
                    <td>{dayWords(r.day)}</td>
                    <td>{r.kind === 'unavailable' ? 'Not available' : 'Leave'}</td>
                    <td className="small dim">{r.reason || '—'}</td>
                    <td className="num">
                      <div className="row" style={{ gap: '0.4rem', justifyContent: 'flex-end' }}>
                        <Button size="sm" disabled={busy} onClick={() => void decide(r, 'approved')}>Agree</Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide(r, 'refused')}>
                          Refuse
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Book somebody off">
        <p className="small dim" style={{ marginTop: 0 }}>
          For people who do not use a screen. This counts against the same limit as anybody else&rsquo;s request,
          and is agreed as soon as it is saved.
        </p>
        <div className="row row-wrap" style={{ gap: '0.8rem', alignItems: 'flex-end' }}>
          <Field label="Who">
            <Select value={forStaff} onChange={(e) => setForStaff(e.target.value)}>
              <option value="">Choose…</option>
              {staff.map((s) => <option key={s.$id} value={s.$id}>{s.display_name}</option>)}
            </Select>
          </Field>
          <Field label="From">
            <Input type="date" value={bookFrom} onChange={(e) => setBookFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={bookTo} onChange={(e) => setBookTo(e.target.value)} />
          </Field>
          <Field label="What">
            <Select value={bookKind} onChange={(e) => setBookKind(e.target.value as LeaveKind)}>
              <option value="leave">Leave</option>
              <option value="unavailable">Not available</option>
            </Select>
          </Field>
          <Field label="Why">
            <Input value={bookReason} placeholder="Family thing" onChange={(e) => setBookReason(e.target.value)} />
          </Field>
          <Button loading={busy} disabled={!forStaff} onClick={() => void book()}>Book off</Button>
        </div>
        {/* The reason, per day, because that is what somebody has to act on. */}
        {refusals.length > 0 && (
          <Notice tone="warn">
            <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
              {refusals.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </Notice>
        )}
      </Card>

      <Card title="The rota">
        <div className="row" style={{ gap: '0.8rem', alignItems: 'flex-end', marginBottom: '0.8rem' }}>
          <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        {rows === null ? <Spinner /> : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Day</th><th>Off</th><th>Who</th></tr>
              </thead>
              <tbody>
                {/*
                  Days with nobody off are shown too. A list of only the busy
                  days answers "who is off" and not "can I let somebody off on
                  the fourteenth", and the second is the question an admin
                  opens this page with.
                */}
                {loads.map((l) => (
                  <tr key={l.day} style={l.full ? { background: 'var(--warn-bg, #fff7ed)' } : undefined}>
                    <td style={{ fontWeight: l.taken > 0 ? 550 : 400 }}>{dayWords(l.day)}</td>
                    <td>
                      <Badge tone={l.full ? 'danger' : l.taken > 0 ? 'warn' : undefined}>
                        {l.taken} of {l.cap}
                      </Badge>
                      <div className="small dim">{loadWords(l)}</div>
                    </td>
                    <td className="small">
                      {l.people.length === 0 ? <span className="dim">—</span> : l.people.map((p) => (
                        <div key={`${p.staffId}-${p.status}`}>
                          {p.name}
                          <span className="dim">
                            {' · '}
                            {p.kind === 'unavailable' ? 'not available' : 'leave'}
                            {p.status === 'requested' ? ' · waiting' : ''}
                          </span>
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
