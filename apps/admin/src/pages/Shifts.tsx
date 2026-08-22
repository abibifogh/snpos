import { useEffect, useState } from 'react';
import {
  Card, Empty, Notice, Spinner, Badge, Modal, Button, Field, Input, Textarea, useToast,
  FilterBar, FilterField,
} from '@snpos/ui';
import { listAll, humanError, Query } from '../lib';
import {
  formatMoney, byStaff, destinationLabel, fromTakings,
  changeShiftClose, closeTimeProblem, closeTimeEffects, describeCloseChange, hoursBetween, SHIFT_MAX_HOURS,
  changeOpeningFloat, floatProblem, describeFloatChange, parseMoney, toInput,
  requestSummaryResend, resendPending,
  listCreatedBetween, listByIds, setShiftSealed, isSealed, describeSeal, lockedProblem,
  rangeTotals, kindsWorthShowing, KIND_LABELS, canOpen,
} from '@snpos/core';
import type { Module, Doc, CashHandover } from '@snpos/core';
import { useSession } from '../session';
import { SideFilter, onSide, narrowSide, type Side } from '../components/SideFilter';

interface Shift extends Doc {
  venue_id: string;
  code: string;
  module?: Module;
  status: 'open' | 'closing' | 'closed';
  opened_by: string;
  opened_at: string;
  closed_at?: string;
  opening_floats: string;
  /** An admin has asked for the closing report to go again, and it has not yet. */
  summary_resend_at?: string | null;
  expected?: string;
  counted?: string;
  variance?: string;
  variance_note?: string;
  sales_total: number;
  expense_total: number;
  covers: number;
  /** Settled: this night is finished and nothing in it may be changed. */
  locked_at?: string;
  locked_by?: string;
  lock_reason?: string;
}

interface PaymentMethod extends Doc { name: string }
interface Expense extends Doc {
  shift_id?: string;
  amount: number;
  category: string;
  category_key?: string;
  payee?: string;
  note?: string;
  paid_from_method_id?: string;
  from_takings?: boolean;
}

/** One thing bought on a shop run, under the expense that paid for it. */
interface ExpenseItem extends Doc {
  expense_id: string;
  name_snapshot: string;
  qty: number;
  unit_cost: number;
  line_total: number;
  stocked?: boolean;
}

/** Local midnight, so "today" means today here rather than in UTC. */
const dayStart = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999`).toISOString();
const todayStr = () => new Date().toLocaleDateString('en-CA');
const daysAgoStr = (n: number) => new Date(Date.now() - n * 86400_000).toLocaleDateString('en-CA');

const parseMap = (raw?: string): Record<string, number> => {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return {};
  }
};

/** Widening the dates in one tap, since they open on today. */
const RANGES = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
];

export function ShiftsPage() {
  const { settings, profile, user } = useSession();
  const toast = useToast();
  const [rows, setRows] = useState<Shift[] | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);

  /**
   * Where an expense was paid from, which is two questions and not one.
   *
   * What it went out of — cash, mobile money — and whose money that was: the
   * takings this shift had rung up, or petty cash it never held. The second
   * decides whether the drawer is counted short by it, which is the thing
   * somebody is holding the expense up to work out, and it was only ever
   * mentioned in passing when the answer was petty cash.
   */
  const paidFrom = (e: Expense): string => {
    const method = methods.find((m) => m.$id === e.paid_from_method_id)?.name;
    const purse = fromTakings(e) ? 'this shift' : 'petty cash';
    return method ? `${method}, from ${purse}` : `From ${purse}`;
  };
  /**
   * The expense being opened, and what was actually bought with it.
   *
   * "Supplies, four hundred and eighty" is where the question starts, not
   * where it ends: a shop run is a list of things, and the whole point of
   * itemising one at the till was so somebody could read it afterwards. Loaded
   * when it is asked for rather than for every expense on every shift, because
   * most of them are never opened.
   */
  const [openExpense, setOpenExpense] = useState<Expense | null>(null);
  const [expenseItems, setExpenseItems] = useState<ExpenseItem[] | null>(null);

  /**
   * Correcting when a shift ended.
   *
   * An admin's, because it changes which day a night's trading is reported
   * under. Not a dangerous change — no money moves, see shift-times — but not
   * one a cashier should be able to make to a night they were short on.
   */
  const isAdmin = profile?.role === 'admin';
  /**
   * May this person see what a shift paid out?
   *
   * The same permission the Expenses page is behind, asked here too. It was
   * readable from this modal by anybody who could open Shifts, however
   * carefully that page had been withheld — a screen quietly undoing a
   * decision made elsewhere.
   */
  const maySeeExpenses = canOpen('expenses', profile, settings);
  /**
   * Correcting what a shift is recorded as having started with.
   *
   * The float is the one figure in a close that nobody counts twice.
   * Everything else is measured; this is asserted once and then believed for
   * the rest of the night, so a wrong one stays invisible until the drawer
   * comes up short by exactly that amount — at which point it reads as missing
   * money with somebody's name against it.
   */
  const [floatEdit, setFloatEdit] = useState<Shift | null>(null);
  const [floatText, setFloatText] = useState<Record<string, string>>({});
  const [floatReason, setFloatReason] = useState('');
  const [floatBusy, setFloatBusy] = useState(false);
  /** Which shift's closing report is being asked for again. */
  const [resendBusy, setResendBusy] = useState<string | null>(null);
  const [closeEdit, setCloseEdit] = useState<Shift | null>(null);
  const [closeAt, setCloseAt] = useState('');
  const [closeReason, setCloseReason] = useState('');
  const [closeBusy, setCloseBusy] = useState(false);

  /*
    A datetime-local box wants the browser's own local wall clock, with no
    zone and no seconds. Building it from the ISO string directly would show
    UTC, and a bar in Accra correcting a 1am close would be handed midnight.
  */
  const forInput = (iso?: string): string => {
    const at = iso ? new Date(iso) : new Date();
    if (Number.isNaN(at.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
      + `T${pad(at.getHours())}:${pad(at.getMinutes())}`;
  };

  const startCloseEdit = (shift: Shift) => {
    setCloseAt(forInput(shift.closed_at));
    setCloseReason('');
    setCloseEdit(shift);
  };

  /**
   * Ask for a closing report to go out again.
   *
   * The browser does not send it. It writes a request the background job
   * already watches — see requestSummaryResend — because the recipients and
   * the mail provider live on the server, and a second copy of that here would
   * be a second thing to keep in step.
   */
  const resend = async (sh: Shift) => {
    setResendBusy(sh.$id);
    try {
      await requestSummaryResend({ shift: sh, userId: user?.$id ?? '' });
      await load();
      toast(
        `Asked for ${sh.code}'s report to go again. It sends within a moment; `
        + 'Settings, "What actually happened" says whether it did.',
      );
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setResendBusy(null);
    }
  };

  const startFloatEdit = (sh: Shift) => {
    const was = parseMap(sh.opening_floats);
    setFloatEdit(sh);
    // Prefilled with what it says now, so a correction is one box changed
    // rather than every drawer retyped from nothing.
    setFloatText(
      Object.fromEntries(methods.map((m) => [m.$id, toInput(was[m.$id] ?? 0, settings?.currency_decimals ?? 2)])),
    );
    setFloatReason('');
  };

  const saveFloat = async () => {
    if (!floatEdit) return;
    const decimals = settings?.currency_decimals ?? 2;
    const names = Object.fromEntries(methods.map((m) => [m.$id, m.name]));
    const problem = floatProblem(floatText, names);
    if (problem) { toast(problem, 'err'); return; }
    if (!floatReason.trim()) {
      toast('Say why it is being changed. This is the figure a shortage is measured against.', 'err');
      return;
    }
    setFloatBusy(true);
    try {
      const floats = Object.fromEntries(
        Object.entries(floatText).map(([id, v]) => [id, parseMoney(v, decimals) ?? 0]),
      );
      const { note } = await changeOpeningFloat({
        shift: floatEdit, floats, userId: user?.$id ?? '', reason: floatReason.trim(),
      });
      setFloatEdit(null);
      await load();
      toast(note);
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setFloatBusy(false);
    }
  };

  const saveCloseTime = async () => {
    if (!closeEdit || !closeAt) return;
    const iso = new Date(closeAt).toISOString();
    setCloseBusy(true);
    try {
      await changeShiftClose({
        shift: closeEdit,
        closedAt: iso,
        userId: user?.$id ?? '',
        reason: closeReason.trim(),
      });
      setCloseEdit(null);
      setDetail(null);
      await load();
      toast(describeCloseChange(closeEdit, iso));
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setCloseBusy(false);
    }
  };

  const openLines = async (e: Expense) => {
    setOpenExpense(e);
    setExpenseItems(null);
    setExpenseItems(
      await listAll<ExpenseItem>('expense_items', [Query.equal('expense_id', e.$id)]).catch(() => []),
    );
  };
  const [handovers, setHandovers] = useState<CashHandover[]>([]);
  const [detail, setDetail] = useState<Shift | null>(null);
  const [side, setSide] = useState<Side>('all');
  const [error, setError] = useState<string | null>(null);

  /*
    A range, not every shift this business has ever run.

    The page read all of them, and all of their expenses, to draw a list
    nobody scrolls past the first screen of — the same greed that put the
    tills on the floor when the month's allowance ran out. Thirty days
    answers "how did last month go", which is the question; the boxes are
    there for the times it is not.
  */
  // Today, both ends, like every other date range in the admin app.
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(todayStr());

  /** Settling a night, so nothing in it can be changed again. */
  const [sealing, setSealing] = useState<Shift | null>(null);
  const [sealReason, setSealReason] = useState('');
  const [sealBusy, setSealBusy] = useState(false);

  const load = async () => {
    const s = await listCreatedBetween<Shift>('shifts', dayStart(from), dayEnd(to));
    const [m, h] = await Promise.all([
      listAll<PaymentMethod>('payment_methods'),
      listAll<CashHandover>('cash_handovers').catch(() => [] as CashHandover[]),
    ]);
    /*
      The expenses of THESE shifts, fetched by their ids.

      Not every expense ever recorded, and not a date window either: an
      expense belongs to the shift it was recorded against, and one entered
      the morning after a late close belongs to that night rather than to the
      day it was typed.
    */
    const e = await listByIds<Expense>('shift_expenses', 'shift_id', s.map((x) => x.$id)).catch(
      () => [] as Expense[],
    );
    setRows(s.sort((a, b) => b.opened_at.localeCompare(a.opened_at)));
    setMethods(m);
    setExpenses(e);
    setHandovers(h);
  };

  useEffect(() => {
    setRows(null);
    void load().catch((err) => setError(humanError(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  const methodName = (id: string) => methods.find((m) => m.$id === id)?.name ?? id;
  const tolerance = settings?.cash_variance_tolerance ?? 500;

  // Their side, not the whole business's. See narrowSide.
  const mine = narrowSide(side, profile, settings);
  const shown = (rows ?? []).filter((s) => onSide(s, mine));

  const totalVariance = (s: Shift) =>
    Object.values(parseMap(s.variance)).reduce((a, b) => a + b, 0);

  /*
    What this range came to, built from what was COUNTED.

    Not from what was expected. Expected is what the records say should have
    been in the drawer; counted is what somebody's hand found in it. Adding up
    the expected figures produces a week that always balances perfectly, which
    is a comforting number and a useless one. See shift-totals.
  */
  const totals = rangeTotals({ shifts: shown, methods, expenses });
  const kinds = kindsWorthShowing(totals.counted);

  const saveSeal = async (shift: Shift, sealed: boolean) => {
    setSealBusy(true);
    try {
      await setShiftSealed({ shift, sealed, userId: user?.$id ?? '', reason: sealReason.trim() });
      setSealing(null);
      setDetail(null);
      await load();
      toast(describeSeal(shift, sealed));
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setSealBusy(false);
    }
  };

  if (error) return <Notice>{error}</Notice>;

  return (
    <>
      <div className="page-head">
        <h1>Shifts</h1>
        <SideFilter value={side} onChange={setSide} settings={settings} profile={profile} />
      </div>
      <p className="dim small" style={{ marginTop: 0 }}>
        Shifts are opened and closed on the terminal, by whoever is on the till. This is the record of what happened, 
        what was expected in each drawer, what was actually counted, and the difference.
      </p>

      <FilterBar>
        <FilterField label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></FilterField>
        <FilterField label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></FilterField>
        {/* The dates open on today. These widen them in one tap, so a narrow
            default costs nothing to somebody who wanted the month. */}
        {RANGES.map(({ days, label }) => (
          <Button key={days} size="sm" onClick={() => { setFrom(daysAgoStr(days)); setTo(todayStr()); }}>
            {label}
          </Button>
        ))}
      </FilterBar>

      {rows && shown.length > 0 && (
        <Card>
          <div className="row row-wrap" style={{ gap: '1.8rem', alignItems: 'flex-end' }}>
            <div>
              <div className="dim small">Shifts</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{totals.closed}</div>
            </div>
            {kinds.map((k) => (
              <div key={k}>
                <div className="dim small">{KIND_LABELS[k]} counted</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 650 }}>
                  {settings ? formatMoney(totals.counted[k], settings) : totals.counted[k]}
                </div>
              </div>
            ))}
            <div>
              <div className="dim small">Everything counted</div>
              <div style={{ fontSize: '1.3rem', fontWeight: 650 }}>
                {settings ? formatMoney(totals.countedTotal, settings) : totals.countedTotal}
              </div>
            </div>
            <div>
              <div className="dim small">Spent</div>
              <div style={{ fontSize: '1.3rem', fontWeight: 650 }}>
                {settings ? formatMoney(totals.expenses, settings) : totals.expenses}
              </div>
            </div>
            <div>
              <div className="dim small">Over or short</div>
              <div style={{ fontSize: '1.3rem', fontWeight: 650, color: totals.variance === 0 ? undefined : 'var(--warn)' }}>
                {totals.variance > 0 ? '+' : ''}
                {settings ? formatMoney(totals.variance, settings) : totals.variance}
              </div>
            </div>
          </div>

          <p className="small dim" style={{ margin: '0.9rem 0 0' }}>
            These are the amounts <strong>counted</strong> at each close, not what the records expected — adding
            up the expected figures would give a week that always balances, which is a comforting number and a
            useless one.
            {totals.open > 0 && (
              <>
                {' '}
                <strong>{totals.open}</strong> {totals.open === 1 ? 'shift is' : 'shifts are'} still open and
                counted by nobody, so {totals.open === 1 ? 'it adds' : 'they add'} nothing here.
              </>
            )}
          </p>
        </Card>
      )}

      <Card pad={false}>
        {!rows ? (
          <div className="card-pad"><Spinner /></div>
        ) : shown.length === 0 ? (
          <Empty title={rows.length === 0 ? 'No shifts in these dates' : 'No shifts on that side'}>
            {rows.length === 0
              ? 'Widen the dates above, or open the first one from the terminal app when you start trading.'
              : 'Each side of the business opens and closes its own shift. Nothing was opened on this one in these dates.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Shift</th>
                  <th>Opened</th>
                  <th>Closed</th>
                  <th className="num">Sales</th>
                  <th className="num">Difference</th>
                  <th>Status</th>
                  {side === 'all' && <th>Side</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => {
                  const diff = totalVariance(s);
                  return (
                    <tr key={s.$id}>
                      <td style={{ fontWeight: 550 }}>{s.code}</td>
                      <td className="dim small">{new Date(s.opened_at).toLocaleString()}</td>
                      <td className="dim small">{s.closed_at ? new Date(s.closed_at).toLocaleString() : '-'}</td>
                      <td className="num">{settings ? formatMoney(s.sales_total, settings) : s.sales_total}</td>
                      <td className="num">
                        {s.status === 'closed' ? (
                          diff === 0 ? (
                            <Badge tone="ok">Balanced</Badge>
                          ) : (
                            <Badge tone={Math.abs(diff) > tolerance ? 'danger' : 'warn'}>
                              {diff > 0 ? '+' : ''}
                              {settings ? formatMoney(diff, settings) : diff}
                            </Badge>
                          )
                        ) : (
                          ', '
                        )}
                      </td>
                      <td>
                        {s.status === 'open' ? (
                          <Badge tone="ok">Open</Badge>
                        ) : isSealed(s) ? (
                          /* Settled is a stronger statement than closed, and
                             the two were being shown as one word. */
                          <Badge tone="ok">Settled</Badge>
                        ) : (
                          <Badge>Closed</Badge>
                        )}
                      </td>
                      {/* Named only when both are on screen together. A column
                          that always says the same word is a column of noise. */}
                      {side === 'all' && (
                        <td className="dim small">{(s.module ?? 'kitchen') === 'craft' ? 'Craft shop' : 'Kitchen'}</td>
                      )}
                      <td className="num">
                        {/* An admin's, and only once the night has finished
                            happening. See sealProblem. */}
                        {isAdmin && s.status === 'closed' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => { setSealReason(''); setSealing(s); }}
                          >
                            {isSealed(s) ? 'Reopen' : 'Settle'}
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setDetail(s)}>Details</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {sealing && (
        <Modal
          title={isSealed(sealing) ? `Reopen ${sealing.code}` : `Settle ${sealing.code}`}
          onClose={() => setSealing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setSealing(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => void saveSeal(sealing, !isSealed(sealing))}
                loading={sealBusy}
              >
                {isSealed(sealing) ? 'Reopen it' : 'Settle it'}
              </Button>
            </>
          }
        >
          {isSealed(sealing) ? (
            <>
              <p className="small dim" style={{ marginTop: 0 }}>
                This night was settled{sealing.locked_at ? ` on ${new Date(sealing.locked_at).toLocaleDateString()}` : ''}.
                Reopening it lets its close time, its orders, its payments and its spending be changed again.
              </p>
              <Notice tone="warn">
                If this night has already been reported on or handed to an accountant, changing it now changes a
                figure somebody has read and acted on. That is sometimes exactly right — but it is worth saying
                why, below, because in a month nobody will remember.
              </Notice>
            </>
          ) : (
            <>
              <p className="small dim" style={{ marginTop: 0 }}>
                Closing a shift ends it. Settling says it is <strong>finished</strong>: its close time, its
                orders, its payments and its spending can no longer be changed. Use it once a night has been
                checked and reported on, so a figure somebody has acted on cannot quietly become a different one.
              </p>
              <p className="small dim">
                An admin can reopen it, and that is recorded too. Nothing is lost — this is a gate, not a delete.
              </p>
              <Notice tone="info">
                This is a rule the screens keep, not a lock in the database itself. It stops the ordinary
                accidents, which is what accidents are; it is not a defence against somebody determined.
              </Notice>
            </>
          )}

          <Field label="Why" hint="Optional, and worth it. Kept on the record with your name against it.">
            <Textarea rows={2} value={sealReason} onChange={(e) => setSealReason(e.target.value)} />
          </Field>
        </Modal>
      )}

      {detail && (
        <Modal title={`Shift ${detail.code}`} onClose={() => setDetail(null)}>
          <div className="grid-2">
            <div>
              <h3>Opened</h3>
              <p className="small dim">{new Date(detail.opened_at).toLocaleString()}</p>
            </div>
            <div>
              <h3>Closed</h3>
              <p className="small dim" style={{ marginBottom: '0.35rem' }}>
                {detail.closed_at ? new Date(detail.closed_at).toLocaleString() : 'Still open'}
                {detail.closed_at && (
                  <> · {hoursBetween(detail.opened_at, detail.closed_at)} hours</>
                )}
              </p>
              {/*
                The commonest wrong figure in the system, and the least
                sinister: a bar that closed at one and a till nobody touched
                until eleven. Correcting it moves no money — see shift-times —
                which is why it sits here as an ordinary action rather than
                under a heading full of warnings.
              */}
              {isAdmin && detail.status === 'closed' && !isSealed(detail) && (
                <Button size="sm" onClick={() => startCloseEdit(detail)}>Correct the closing time</Button>
              )}
              {/*
                The closing report, again.

                Offered on a sealed shift too, unlike everything else here:
                sending an email a second time changes no figure and settles
                nothing — it is the one action on this screen that only reads.

                Not offered while one is already waiting. Pressing it twice
                would put two identical reports in somebody's inbox and teach
                them to ignore both.
              */}
              {isAdmin && detail.status === 'closed' && (
                resendPending(detail) ? (
                  <span className="small dim">Report queued to send again…</span>
                ) : (
                  <Button
                    size="sm"
                    loading={resendBusy === detail.$id}
                    onClick={() => void resend(detail)}
                  >
                    Send the closing report again
                  </Button>
                )
              )}
              {/* Said rather than simply missing. A button that vanishes is
                  indistinguishable from a screen that is broken. */}
              {isSealed(detail) && (
                <span className="small dim">{lockedProblem(detail, 'anything in this shift')}</span>
              )}
            </div>
          </div>

          <div className="spread" style={{ marginTop: '1rem', alignItems: 'baseline' }}>
            <h3 style={{ margin: 0 }}>Cash reconciliation</h3>
            {/* An admin's, and put beside the figures it moves rather than in a
                menu. A float carried from the wrong drawer is discovered here,
                looking at a shortage that will not add up. */}
            {isAdmin && !isSealed(detail) && (
              <Button size="sm" onClick={() => startFloatEdit(detail)}>Correct the opening float</Button>
            )}
          </div>
          {/*
            What "expected" actually means, said where it is read.

            It is three numbers folded into one — the float it started with,
            what was taken, less what was paid out of it — and none of those
            are on screen. Somebody comparing a figure they do not understand
            against a count they made themselves concludes the system is
            wrong, which is a fair conclusion from what they can see.
          */}
          <p className="small dim" style={{ marginTop: 0 }}>
            <strong>Expected</strong> is the float this drawer opened with, plus everything taken through it,
            less anything paid out of it. <strong>Counted</strong> is what the person closing physically found.
            The difference between them is the only figure here that nobody typed.
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Method</th><th className="num">Float</th><th className="num">Expected</th><th className="num">Counted</th><th className="num">Difference</th></tr>
              </thead>
              <tbody>
                {Object.keys({ ...parseMap(detail.opening_floats), ...parseMap(detail.expected) }).map((id) => {
                  const diff = parseMap(detail.variance)[id] ?? 0;
                  return (
                    <tr key={id}>
                      <td>{methodName(id)}</td>
                      <td className="num dim">{settings ? formatMoney(parseMap(detail.opening_floats)[id] ?? 0, settings) : 0}</td>
                      <td className="num">{settings ? formatMoney(parseMap(detail.expected)[id] ?? 0, settings) : 0}</td>
                      <td className="num">{settings ? formatMoney(parseMap(detail.counted)[id] ?? 0, settings) : 0}</td>
                      <td className="num">
                        {diff === 0 ? (
                          <span className="dim">-</span>
                        ) : (
                          <Badge tone={Math.abs(diff) > tolerance ? 'danger' : 'warn'}>
                            {diff > 0 ? '+' : ''}
                            {settings ? formatMoney(diff, settings) : diff}
                          </Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {Math.abs(totalVariance(detail)) > tolerance && (
            <Notice tone="warn">
              This shift is outside your tolerance of {settings ? formatMoney(tolerance, settings) : tolerance}. One
              bad count is a mistake; the same person repeatedly short is a pattern worth looking at.
            </Notice>
          )}

          {/* Who ended with what.
              The reconciliation above is about the drawer; this is about
              people. A shift is not a person; three can work one, take money
              in turn and leave at different times, so "what did Ama end with?"
              is a question the close cannot answer and this can. */}
          <h3 style={{ marginTop: '1rem' }}>Cash handed over</h3>
          {handovers.filter((h) => h.shift_id === detail.$id).length === 0 ? (
            <p className="small dim">
              Nobody recorded handing cash over on this shift. Staff record it themselves from the till, under
              "Hand over cash".
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Who</th><th className="num">Handed over</th><th>To</th><th>When</th></tr>
                </thead>
                <tbody>
                  {byStaff(handovers.filter((h) => h.shift_id === detail.$id)).map((line) => (
                    <tr key={line.staffId}>
                      <td>{line.name}</td>
                      <td className="num" style={{ fontWeight: 650 }}>
                        {settings ? formatMoney(line.handedOver, settings) : line.handedOver}
                      </td>
                      <td className="small dim">
                        {/* Every trip, not just the total. Two trips to the
                            safe and one trip of twice the size are different
                            evenings, and only one of them is worth a question. */}
                        {line.entries
                          .filter((e) => e.status !== 'corrected')
                          .map((e) => e.received_by_name || destinationLabel(e.destination))
                          .join(', ')}
                      </td>
                      <td className="small dim">
                        {line.entries
                          .filter((e) => e.status !== 'corrected')
                          .map((e) => new Date(e.handed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
                          .join(', ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/*
            Only for somebody allowed to see spending at all.

            What a shift paid out — and to whom — is the same information the
            Expenses page holds, and it was readable here by anybody who could
            open Shifts however carefully that page had been withheld. One
            permission, asked in both places, rather than a screen that quietly
            undoes a decision made elsewhere. An owner sets it under
            Settings, "Who can see what".
          */}
          {maySeeExpenses && <>
          <h3 style={{ marginTop: '1rem' }}>Expenses in this shift</h3>
          {expenses.filter((e) => e.shift_id === detail.$id).length === 0 ? (
            <p className="small dim">None recorded.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <tbody>
                  {expenses
                    .filter((e) => e.shift_id === detail.$id)
                    .map((e) => (
                      <tr key={e.$id}>
                        <td>
                          {e.category_key || e.category}
                          {e.payee && <div className="small dim">{e.payee}</div>}
                          {/* Where it came out of, said on every row rather
                              than only when the answer is unusual. Whether the
                              drawer is short by this is the thing somebody is
                              holding the expense up to work out. */}
                          <div className="small dim">{paidFrom(e)}</div>
                        </td>
                        <td className="num">{settings ? formatMoney(e.amount, settings) : e.amount}</td>
                        <td style={{ width: '1%' }}>
                          <Button size="sm" variant="ghost" onClick={() => void openLines(e)}>Details</Button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
          </>}
        </Modal>
      )}

      {floatEdit && (() => {
        const decimals = settings?.currency_decimals ?? 2;
        const was = parseMap(floatEdit.opening_floats);
        const floats = Object.fromEntries(
          Object.entries(floatText).map(([id, v]) => [id, parseMoney(v, decimals) ?? 0]),
        );
        const change = describeFloatChange(
          { floats, was },
          (n) => (settings ? formatMoney(n, settings) : String(n)),
        );
        return (
          <Modal
            title={`What did ${floatEdit.code} start with?`}
            onClose={() => (floatBusy ? undefined : setFloatEdit(null))}
            footer={
              <>
                <Button variant="ghost" onClick={() => setFloatEdit(null)} disabled={floatBusy}>Cancel</Button>
                <Button variant="primary" onClick={() => void saveFloat()} loading={floatBusy}>
                  Save the float
                </Button>
              </>
            }
          >
            <p className="small dim" style={{ marginTop: 0 }}>
              What was physically in each drawer when this shift opened. It is the one figure in a close nobody
              counts twice — everything else is measured, this is asserted once and then believed all night — so
              a wrong one stays invisible until the drawer comes up short by exactly that amount.
            </p>

            {methods.map((m) => (
              <Field key={m.$id} label={`${m.name} (${settings?.currency_symbol ?? ''})`}>
                <Input
                  value={floatText[m.$id] ?? ''}
                  inputMode="decimal"
                  onChange={(e) => setFloatText({ ...floatText, [m.$id]: e.target.value })}
                />
              </Field>
            ))}

            {change.delta !== 0 && (
              <Notice tone={change.delta > 0 ? 'warn' : 'info'}>{change.text}</Notice>
            )}

            {/* Said before it is done, because the two cases are genuinely
                different and only one of them is quiet. */}
            {floatEdit.status === 'closed' && (
              <Notice tone="warn">
                {floatEdit.code} has already been closed and counted. What was physically counted is not
                touched — that was a person with money in their hands. What changes is what the shift was
                expected to hold, and the over-or-short with it; its accounting entries are posted again from
                the corrected figures.
              </Notice>
            )}

            <Field
              label="Why"
              hint="Kept with the change. In a month this is the only thing that explains why a signed-off night moved."
            >
              <Textarea rows={2} value={floatReason} onChange={(e) => setFloatReason(e.target.value)} />
            </Field>
          </Modal>
        );
      })()}

      {closeEdit && (() => {
        const iso = closeAt ? new Date(closeAt).toISOString() : '';
        const problem = iso ? closeTimeProblem(closeEdit, iso) : 'Say when it actually closed.';
        const effects = iso && !problem
          ? closeTimeEffects({ shift: closeEdit, closedAt: iso, maxHours: SHIFT_MAX_HOURS })
          : null;
        return (
          <Modal
            title={`When did ${closeEdit.code} close?`}
            onClose={() => (closeBusy ? undefined : setCloseEdit(null))}
            footer={
              <>
                <Button variant="ghost" onClick={() => setCloseEdit(null)} disabled={closeBusy}>Cancel</Button>
                <Button
                  variant="primary"
                  onClick={() => void saveCloseTime()}
                  loading={closeBusy}
                  disabled={!!problem || !closeReason.trim()}
                >
                  Save the time
                </Button>
              </>
            }
          >
            <p className="small dim" style={{ marginTop: 0 }}>
              For a till nobody got back to: a bar that stopped serving at one and was closed on the system at
              eleven the next morning. Opened {new Date(closeEdit.opened_at).toLocaleString()}.
            </p>
            {/* Said early and plainly, because it is the question an admin
                actually has and the answer is reassuring. */}
            <Notice tone="info">
              No money moves. The takings are worked out from the payments taken on this shift and the count
              came from a person; neither has any opinion about the clock. What changes is which day this shift
              is reported under, and how long it says it ran.
            </Notice>

            <Field label="Closed at">
              <Input type="datetime-local" value={closeAt} onChange={(e) => setCloseAt(e.target.value)} />
            </Field>

            {problem && <Notice tone="warn">{problem}</Notice>}

            {effects && (
              <>
                <p style={{ marginBottom: '0.3rem' }}>
                  <strong>{describeCloseChange(closeEdit, iso)}</strong>
                </p>
                <p className="small dim" style={{ marginTop: 0 }}>
                  That makes it {effects.hours} hours long.
                </p>
                {effects.warnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}
              </>
            )}

            <Field
              label="Why"
              hint="Kept against your name. A correction and a shift moved off a bad night look identical without it."
            >
              <Input
                value={closeReason}
                placeholder="Nobody closed the till until the morning"
                onChange={(e) => setCloseReason(e.target.value)}
              />
            </Field>
          </Modal>
        );
      })()}

      {/*
        What one expense was actually spent on.
        
        A shop run is a list of things, and itemising it at the till was done so
        somebody could read it back. Until now the only way to see that list was
        the admin expenses page, which meant leaving the shift you were looking
        at and finding the same row again.
      */}
      {openExpense && (
        <Modal
          title={`${openExpense.category_key || openExpense.category} · ${settings ? formatMoney(openExpense.amount, settings) : openExpense.amount}`}
          onClose={() => setOpenExpense(null)}
          footer={<Button onClick={() => setOpenExpense(null)}>Close</Button>}
        >
          <div className="cash-split" style={{ marginTop: 0 }}>
            <div className="cash-split-item">
              <div className="label">Paid from</div>
              <div className="figure" style={{ fontSize: '0.95rem' }}>
                {methods.find((m) => m.$id === openExpense.paid_from_method_id)?.name ?? 'Not recorded'}
              </div>
            </div>
            {/* The question the drawer count turns on, given its own block
                rather than a line of small grey text. */}
            <div className="cash-split-item">
              <div className="label">Whose money</div>
              <div className="figure" style={{ fontSize: '0.95rem' }}>
                {fromTakings(openExpense) ? 'This shift\u2019s takings' : 'Petty cash'}
              </div>
              <div className="small dim">
                {fromTakings(openExpense)
                  ? 'Taken off what the drawer should hold'
                  : 'Not taken off the drawer count'}
              </div>
            </div>
            {openExpense.payee && (
              <div className="cash-split-item">
                <div className="label">Paid to</div>
                <div className="figure" style={{ fontSize: '0.95rem' }}>{openExpense.payee}</div>
              </div>
            )}
          </div>
          {openExpense.note && <p className="small">{openExpense.note}</p>}

          {expenseItems === null ? (
            <Spinner />
          ) : expenseItems.length === 0 ? (
            <p className="small dim">
              Nothing was itemised on this one. Plenty of spending has nothing to list — a taxi, a gas refill, a
              repair — and it was recorded as a single amount.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>What</th><th className="num">How many</th><th className="num">Each</th><th className="num">Paid</th></tr>
                </thead>
                <tbody>
                  {expenseItems.map((i) => (
                    <tr key={i.$id}>
                      <td>
                        {i.name_snapshot}
                        {/* An overhead is used up in the buying and never
                            reached a shelf, which is worth saying beside the
                            things that did. */}
                        {i.stocked === false && <div className="small dim">not stocked, used up in the buying</div>}
                      </td>
                      <td className="num">{i.qty}</td>
                      <td className="num dim">{settings ? formatMoney(i.unit_cost, settings) : i.unit_cost}</td>
                      <td className="num">{settings ? formatMoney(i.line_total, settings) : i.line_total}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3} style={{ fontWeight: 650 }}>Itemised</td>
                    <td className="num" style={{ fontWeight: 650 }}>
                      {settings
                        ? formatMoney(expenseItems.reduce((s2, i) => s2 + i.line_total, 0), settings)
                        : expenseItems.reduce((s2, i) => s2 + i.line_total, 0)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
