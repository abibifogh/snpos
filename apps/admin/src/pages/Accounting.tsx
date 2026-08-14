import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Textarea, useToast } from '@snpos/ui';
import { listAll, humanError, saveDropping } from '../lib';
import {
  formatMoney, parseMoney, toInput, Query,
  ledgerLines, loadAccounts, postManualEntry, reverseEntry, editEntry, deleteEntry, loadFixedAssets, postDepreciation,
  profitAndLoss, balanceSheet, totalsByAccount, naturalBalance, entryProblem, within,
  bookValue, monthOf, reconcile, db, DB_ID, ID,
  matchStatement, readStatement, parseCsv, loadStatementLines, importStatementLines,
  postFromStatement, attachReceipt, downloadUrl, areasOf,
  loadLocks, lockPeriod, openAccounts,
} from '@snpos/core';
import type {
  AccountRow, JournalEntry, JournalLine, FixedAsset, LineRow, Doc, BankStatementLine, Settings,
  PeriodLock,
} from '@snpos/core';
import { useSession } from '../session';
import { AccountsManager } from '../components/AccountsManager';

/**
 * The books.
 *
 * Everything else in this system records what happened — a bill was settled, a
 * shift closed, money left the drawer. This is where those become accounts,
 * and where the things that never pass through a till get in at all: rent, a
 * bank charge, the owner putting money in, a fridge being written down over
 * the years it is used.
 *
 * Deliberately one page with tabs rather than five pages. Somebody doing the
 * books moves between the journal, the trial balance and the statements in one
 * sitting, and each of those is the same figures read a different way; putting
 * them behind separate navigation makes it feel like separate work.
 */
type Tab = 'statements' | 'journal' | 'trial' | 'assets' | 'bank' | 'chart' | 'locks';

/** A month back from today, as YYYY-MM-DD, for the default window. */
const monthStart = (d = new Date()) => `${d.toISOString().slice(0, 7)}-01`;
const today = () => new Date().toISOString().slice(0, 10);

interface DraftLine { account_code: string; debitText: string; creditText: string; memo: string }

const BLANK: DraftLine = { account_code: '', debitText: '', creditText: '', memo: '' };

/**
 * What a dropdown may offer: the accounts still in use, plus the one already
 * chosen.
 *
 * `openAccounts` alone is right for a blank form and wrong for one being
 * edited. An entry posted in March against an account archived in June still
 * names it, and a select whose value is not among its options shows the first
 * option instead — so opening that entry and pressing Save would quietly move
 * the posting to a different account. Keeping the chosen one on the list makes
 * the edit show what is actually there, and leaves changing it a deliberate act.
 */
const choices = (accounts: AccountRow[], chosen?: string): AccountRow[] =>
  accounts.filter((a) => a.active !== false || a.code === chosen);

export function AccountingPage() {
  const { settings, user, profile } = useSession();
  const toast = useToast();
  /**
   * Which parts of the books this person has been given.
   *
   * Granted one at a time, because they are not equally consequential: reading
   * a profit and loss is what a manager is for, and posting a journal entry to
   * any account is not. Somebody with the page and no areas sees the page and
   * no tabs, which is the honest result of granting nothing rather than a
   * silent promotion to everything.
   */
  const allowed = useMemo(() => areasOf('accounting', profile, settings), [profile, settings]);
  const can = (area: Tab) => allowed.includes(`accounting_${area}`);
  const [tab, setTab] = useState<Tab>('statements');
  useEffect(() => {
    // Land on something they can see. Opening on a tab they were not given
    // shows an empty page that reads as a fault rather than as a permission.
    if (allowed.length > 0 && !can(tab)) {
      setTab(allowed[0].replace('accounting_', '') as Tab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed]);
  // The books belong to the venue, and every page here reads it the same way.
  const [venueId, setVenueId] = useState('');
  useEffect(() => {
    listAll<Doc>('venues').then((v) => setVenueId(v[0]?.$id ?? '')).catch(() => undefined);
  }, []);

  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [lines, setLines] = useState<(JournalLine & { date: string })[]>([]);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());

  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));
  const decimals = settings?.currency_decimals ?? 2;

  const load = async () => {
    const [a, l, e, f] = await Promise.all([
      loadAccounts(),
      ledgerLines(venueId),
      listAll<JournalEntry>('journal_entries', [Query.equal('venue_id', venueId)]),
      loadFixedAssets(venueId),
    ]);
    setAccounts(a);
    setLines(l);
    setEntries(e.sort((x, y) => (y.date ?? '').localeCompare(x.date ?? '')));
    setAssets(f);
  };

  useEffect(() => {
    if (!venueId) return;
    setLoading(true);
    load()
      .catch((e) => setError(humanError(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId]);

  /**
   * Two windows, on purpose.
   *
   * A profit and loss is about a period: what was earned between these dates.
   * A balance sheet is about a moment: what is owned and owed on that day,
   * counting everything that ever happened up to it. Running both off one
   * filter would make the balance sheet forget every asset bought before the
   * first of the month, which is most of them.
   */
  const periodLines = useMemo(() => within(lines, from, to) as LineRow[], [lines, from, to]);
  const upToLines = useMemo(() => within(lines, undefined, to) as LineRow[], [lines, to]);

  const pl = useMemo(() => profitAndLoss(accounts, periodLines), [accounts, periodLines]);
  const bs = useMemo(() => balanceSheet(accounts, upToLines), [accounts, upToLines]);

  const trial = useMemo(() => {
    const totals = totalsByAccount(periodLines);
    const rows = accounts
      .map((a) => {
        const t = totals.get(a.code) ?? { debit: 0, credit: 0 };
        return { ...a, debit: t.debit, credit: t.credit, balance: naturalBalance(a.type, t.debit, t.credit) };
      })
      .filter((r) => r.debit !== 0 || r.credit !== 0);
    const debit = rows.reduce((s, r) => s + r.debit, 0);
    const credit = rows.reduce((s, r) => s + r.credit, 0);
    return { rows, debit, credit, balanced: debit === credit };
  }, [accounts, periodLines]);

  if (loading) return <Spinner />;
  if (error) return <Notice>{error}</Notice>;

  return (
    <>
      <h1>Accounting</h1>
      <p className="dim small" style={{ marginTop: 0 }}>
        Sales and spending post themselves as shifts close. This is where they add up, and where anything that
        never passes through a till gets in.
      </p>

      <div className="row row-wrap" style={{ gap: '0.4rem', margin: '0.9rem 0' }}>
        {([
          ['statements', 'Profit & loss and balance sheet'],
          ['journal', 'Journal'],
          ['trial', 'Trial balance'],
          ['assets', 'Fixed assets'],
          ['bank', 'Reconcile'],
          ['chart', 'Chart of accounts'],
          ['locks', 'Close a period'],
        ] as [Tab, string][]).filter(([key]) => can(key)).map(([key, label]) => (
          <Button key={key} size="sm" variant={tab === key ? 'primary' : 'default'} onClick={() => setTab(key)}>
            {label}
          </Button>
        ))}
      </div>

      {/* Granted the page and none of its parts. Said plainly rather than shown
          as an empty screen somebody reads as broken. */}
      {allowed.length === 0 && (
        <Notice>
          You can open this page, but no part of the books has been given to you yet. An admin sets that under
          Settings, in who can open what.
        </Notice>
      )}

      {tab !== 'chart' && tab !== 'assets' && tab !== 'bank' && (
        <Card pad>
          <div className="grid-2">
            <Field label="From" hint="The profit and loss covers these dates.">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To" hint="The balance sheet is as at this day, counting everything before it.">
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
        </Card>
      )}

      {tab === 'statements' && can('statements') && (
        <Statements
          pl={pl} bs={bs} money={money} from={from} to={to}
          lines={lines} entries={entries} settings={settings}
        />
      )}

      {tab === 'trial' && can('trial') && (
        <Card title="Trial balance" pad>
          {/* The one check that says whether any of the rest can be believed.
              Every entry is refused unless it balances, so this failing means
              a line was written without its entry, or removed from under one. */}
          {!trial.balanced && (
            <Notice>
              These do not balance: {money(trial.debit)} debited against {money(trial.credit)} credited.
              Every entry is checked as it is posted, so this means a line has gone missing from one.
            </Notice>
          )}
          {trial.rows.length === 0 ? (
            <Empty title="Nothing posted in this period">Widen the dates, or close a shift.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Code</th><th>Account</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr>
                </thead>
                <tbody>
                  {trial.rows.map((r) => (
                    <tr key={r.code}>
                      <td className="dim small">{r.code}</td>
                      <td>{r.name}</td>
                      <td className="num">{r.debit ? money(r.debit) : '-'}</td>
                      <td className="num">{r.credit ? money(r.credit) : '-'}</td>
                      <td className="num" style={{ fontWeight: 600 }}>{money(r.balance)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td /><td style={{ fontWeight: 650 }}>Total</td>
                    <td className="num" style={{ fontWeight: 650 }}>{money(trial.debit)}</td>
                    <td className="num" style={{ fontWeight: 650 }}>{money(trial.credit)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'journal' && can('journal') && (
        <Journal
          entries={entries}
          lines={lines}
          accounts={accounts}
          from={from}
          to={to}
          money={money}
          decimals={decimals}
          venueId={venueId}
          userId={user?.$id ?? ''}
          settings={settings}
          onChanged={load}
          toast={toast}
        />
      )}

      {tab === 'assets' && can('assets') && (
        <Assets
          assets={assets}
          accounts={accounts}
          money={money}
          decimals={decimals}
          venueId={venueId}
          userId={user?.$id ?? ''}
          onChanged={load}
          toast={toast}
          isOwner={profile?.role === 'admin'}
        />
      )}

      {tab === 'bank' && can('bank') && (
        <Reconcile
          accounts={accounts}
          lines={lines}
          money={money}
          decimals={decimals}
          venueId={venueId}
          userId={user?.$id ?? ''}
          onChanged={load}
          toast={toast}
        />
      )}

      {tab === 'chart' && can('chart') && <AccountsManager />}

      {tab === 'locks' && can('locks') && (
        <Locks venueId={venueId} userId={user?.$id ?? ''} onChanged={load} toast={toast} />
      )}
    </>
  );
}

/* ------------------------------------------------------------- statements */

function Statements({
  pl, bs, money, from, to, lines, entries, settings,
}: {
  pl: ReturnType<typeof profitAndLoss>;
  bs: ReturnType<typeof balanceSheet>;
  money: (n: number) => string;
  from: string;
  to: string;
  lines: (JournalLine & { date: string })[];
  entries: JournalEntry[];
  settings: Settings | null;
}) {
  /**
   * The account being looked into, and over what stretch.
   *
   * A figure on a statement is a question, not an answer. Nobody reads
   * "Supplies 4,180" and stops there; they want to know what the four thousand
   * was. Printing a total and leaving somebody to go and find the postings
   * themselves is how a set of accounts becomes something people nod at rather
   * than read.
   *
   * The window travels with the line, because the two statements ask different
   * questions of the same postings: a profit and loss is a period, a balance
   * sheet is everything up to a day. One window for both would open a list
   * that does not add up to the figure that was pressed, which is worse than
   * not opening at all.
   */
  const [open, setOpen] = useState<{ line: ReturnType<typeof profitAndLoss>['revenue'][number]; since?: string } | null>(null);

  const row = (l: ReturnType<typeof profitAndLoss>['revenue'][number], since?: string) => (
    <tr key={l.code} onClick={() => setOpen({ line: l, since })} style={{ cursor: 'pointer' }} title="See the postings behind this">
      <td>{l.name}</td>
      <td className="num">{money(l.amount)}</td>
    </tr>
  );

  return (
    <>
      {open && (
        <AccountDetail
          line={open.line}
          since={open.since}
          until={to}
          lines={lines}
          entries={entries}
          money={money}
          settings={settings}
          onClose={() => setOpen(null)}
        />
      )}

      <Card title={`Profit and loss · ${from} to ${to}`} pad>
        {pl.revenue.length === 0 && pl.expenses.length === 0 ? (
          <Empty title="Nothing in this period">Close a shift, or widen the dates.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <tbody>
                <tr><td colSpan={2} style={{ fontWeight: 650 }}>Income</td></tr>
                {pl.revenue.map((l) => row(l, from))}
                <tr><td style={{ fontWeight: 600 }}>Total income</td><td className="num" style={{ fontWeight: 600 }}>{money(pl.totalRevenue)}</td></tr>

                <tr><td colSpan={2} style={{ fontWeight: 650, paddingTop: '1rem' }}>Costs</td></tr>
                {pl.expenses.map((l) => row(l, from))}
                <tr><td style={{ fontWeight: 600 }}>Total costs</td><td className="num" style={{ fontWeight: 600 }}>{money(pl.totalExpenses)}</td></tr>

                <tr>
                  <td style={{ fontWeight: 700, paddingTop: '1rem' }}>
                    {pl.netProfit < 0 ? 'Loss for the period' : 'Profit for the period'}
                  </td>
                  <td className="num" style={{ fontWeight: 700, paddingTop: '1rem' }}>{money(pl.netProfit)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p className="small dim" style={{ marginBottom: 0 }}>
          Press any line to see the postings behind it. Profit is not cash: money can be owed to you and still be earned, and spent without being a cost yet.
        </p>
      </Card>

      <Card title={`Balance sheet · as at ${to}`} pad>
        {/* Out by anything at all is worth saying loudly. It cannot happen
            through the front door — every entry is refused unless it balances
            — so it means a line was written without its entry or removed from
            under one, and every figure above inherits it. */}
        {!bs.balanced && (
          <Notice>
            This does not balance. It is out by {money(bs.outBy)}, which means a journal line has gone missing
            from its entry. The figures above cannot be relied on until that is found.
          </Notice>
        )}
        <div className="table-wrap">
          <table className="data">
            <tbody>
              <tr><td colSpan={2} style={{ fontWeight: 650 }}>What the business owns</td></tr>
              {bs.assets.map((l) => row(l))}
              <tr><td style={{ fontWeight: 600 }}>Total</td><td className="num" style={{ fontWeight: 600 }}>{money(bs.totalAssets)}</td></tr>

              <tr><td colSpan={2} style={{ fontWeight: 650, paddingTop: '1rem' }}>What it owes</td></tr>
              {bs.liabilities.map((l) => row(l))}
              <tr><td style={{ fontWeight: 600 }}>Total</td><td className="num" style={{ fontWeight: 600 }}>{money(bs.totalLiabilities)}</td></tr>

              <tr><td colSpan={2} style={{ fontWeight: 650, paddingTop: '1rem' }}>The owner&apos;s share</td></tr>
              {bs.equity.map((l) => row(l))}
              {/* Profit that has never been moved into equity, which is every
                  set of books that has not closed a year. Left out, the sheet
                  is short by exactly the trading and looks broken. */}
              <tr><td>Profit kept in the business</td><td className="num">{money(bs.retained)}</td></tr>
              <tr>
                <td style={{ fontWeight: 700 }}>Total owed and owned</td>
                <td className="num" style={{ fontWeight: 700 }}>
                  {money(bs.totalLiabilities + bs.totalEquity + bs.retained)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

/* ---------------------------------------------------------------- journal */

function Journal({
  entries, lines, accounts, from, to, money, decimals, venueId, userId, settings, onChanged, toast,
}: {
  entries: JournalEntry[];
  lines: (JournalLine & { date: string })[];
  accounts: AccountRow[];
  from: string;
  to: string;
  money: (n: number) => string;
  decimals: number;
  venueId: string;
  userId: string;
  settings: Settings | null;
  onChanged: () => Promise<void>;
  toast: (m: string, t?: 'ok' | 'err') => void;
}) {
  const [writing, setWriting] = useState(false);
  /**
   * The evidence, attached to the posting itself.
   *
   * A receipt in a drawer proves nothing a year later, and one attached to an
   * expense is only reachable from the expense — a posting made by hand, which
   * is exactly the kind somebody will be asked to justify, had nowhere to put
   * one at all.
   */
  const [attaching, setAttaching] = useState<string | null>(null);
  const attach = async (entry: JournalEntry, file: File) => {
    if (file.size > 10 * 1024 * 1024) { toast('That file is over 10MB. Take a smaller photo.', 'err'); return; }
    setAttaching(entry.$id);
    try {
      await attachReceipt(entry.$id, file, settings);
      await onChanged();
      toast('Receipt attached');
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setAttaching(null);
    }
  };
  /**
   * The entry being changed, or null when this is a new one.
   *
   * Editing rather than reversing was asked for, and the same form does both:
   * a correction is the same shape as the thing it corrects, and a second form
   * would drift away from the first.
   */
  const [changing, setChanging] = useState<JournalEntry | null>(null);
  const [date, setDate] = useState(today());
  const [memo, setMemo] = useState('');
  const [draft, setDraft] = useState<DraftLine[]>([{ ...BLANK }, { ...BLANK }]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const shown = entries.filter((e) => (e.date ?? '') >= from && (e.date ?? '') <= `${to}￿`);
  const linesOf = (id: string) => lines.filter((l) => l.entry_id === id);

  const asLines = (): LineRow[] =>
    draft.map((d) => ({
      account_code: d.account_code,
      debit: parseMoney(d.debitText, decimals) ?? 0,
      credit: parseMoney(d.creditText, decimals) ?? 0,
    }));

  // Shown as it is typed, not only when Save is pressed. Somebody entering a
  // four-line correction wants to know it is out by two cedis before they have
  // stopped looking at the receipt.
  const liveProblem = entryProblem(asLines());
  const totalDebit = asLines().reduce((s, l) => s + l.debit, 0);
  const totalCredit = asLines().reduce((s, l) => s + l.credit, 0);

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setDraft((rows) => rows.map((r, x) => (x === i ? { ...r, ...patch } : r)));

  /** Load an entry into the form so it can be changed in place. */
  const edit = (entry: JournalEntry) => {
    const own = linesOf(entry.$id);
    setChanging(entry);
    setDate((entry.date ?? today()).slice(0, 10));
    setMemo(entry.memo ?? '');
    setDraft(own.map((l) => ({
      account_code: l.account_code,
      debitText: l.debit ? toInput(l.debit, decimals) : '',
      creditText: l.credit ? toInput(l.credit, decimals) : '',
      memo: l.memo ?? '',
    })));
    setProblem(null);
    setWriting(true);
  };

  const startNew = () => {
    setChanging(null);
    setDate(today());
    setMemo('');
    setDraft([{ ...BLANK }, { ...BLANK }]);
    setProblem(null);
    setWriting(true);
  };

  const save = async () => {
    const trouble = entryProblem(asLines());
    if (trouble) { setProblem(trouble); return; }
    if (!memo.trim()) { setProblem('Say what this entry is for. In a year it is the only clue.'); return; }
    setBusy(true);
    setProblem(null);
    try {
      const withNotes = asLines().map((l, i) => ({ ...l, memo: draft[i].memo }));
      if (changing) {
        await editEntry(
          changing,
          { date: new Date(`${date}T12:00:00`), memo: memo.trim(), lines: withNotes },
          { editedBy: userId },
        );
      } else {
        await postManualEntry(
          venueId,
          { date: new Date(`${date}T12:00:00`), memo: memo.trim(), postedBy: userId },
          withNotes,
        );
      }
      setWriting(false);
      setChanging(null);
      setDraft([{ ...BLANK }, { ...BLANK }]);
      setMemo('');
      await onChanged();
      toast(changing ? 'Entry changed. The old version is in the audit log.' : 'Entry posted');
    } catch (e) {
      setProblem(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Remove an entry outright.
   *
   * Behind a confirmation because there is nothing to undo it with. Reversing
   * keeps both halves and editing keeps the old version; this keeps only the
   * audit log, which is written before anything is taken away.
   */
  const [killing, setKilling] = useState<JournalEntry | null>(null);
  const kill = async () => {
    if (!killing) return;
    try {
      await deleteEntry(killing, { deletedBy: userId });
      setKilling(null);
      await onChanged();
      toast('Deleted. What it said is in the audit log.');
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  const undo = async (entry: JournalEntry) => {
    try {
      await reverseEntry(entry, { postedBy: userId });
      await onChanged();
      toast('Reversed. Both entries stay on the record.');
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  return (
    <>
      <Card
        title="Journal"
        actions={<Button size="sm" variant="primary" onClick={startNew}>New entry</Button>}
        pad
      >
        <p className="small dim" style={{ marginTop: 0 }}>
          Every posting, whether the system wrote it or somebody did. An entry can be changed, and what it said
          before goes into the audit log, which this page cannot reach and erasing records never clears.
          Reversing instead leaves both halves standing, which is the better answer for anything an accountant
          or a bank has already seen.
        </p>
        {shown.length === 0 ? (
          <Empty title="Nothing in this period">Close a shift, or widen the dates.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Date</th><th>What for</th><th>Source</th><th className="num">Amount</th><th>Receipt</th><th /></tr>
              </thead>
              <tbody>
                {shown.map((e) => {
                  const own = linesOf(e.$id);
                  const amount = own.reduce((s, l) => s + l.debit, 0);
                  return (
                    <tr key={e.$id}>
                      <td className="dim small">{(e.date ?? '').slice(0, 10)}</td>
                      <td>
                        {e.memo || e.source}
                        <div className="small dim">
                          {own.map((l) => (
                            <span key={l.$id} style={{ marginRight: '0.6rem' }}>
                              {l.account_code} {l.debit ? `Dr ${money(l.debit)}` : `Cr ${money(l.credit)}`}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="dim small">{e.source.replace('_', ' ')}</td>
                      <td className="num">{money(amount)}</td>
                      <td>
                        {e.receipt_file_id ? (
                          <a
                            href={downloadUrl(e.receipt_file_id, 'receipt', settings)}
                            target="_blank"
                            rel="noreferrer"
                            className="small"
                          >
                            View
                          </a>
                        ) : (
                          <label className="small" style={{ cursor: 'pointer', opacity: attaching === e.$id ? 0.5 : 1 }}>
                            {attaching === e.$id ? 'Attaching…' : 'Attach'}
                            <input
                              type="file"
                              accept="image/*,application/pdf"
                              capture="environment"
                              style={{ display: 'none' }}
                              onChange={(ev) => {
                                const f = ev.target.files?.[0];
                                if (f) void attach(e, f);
                              }}
                            />
                          </label>
                        )}
                      </td>
                      <td>
                        {e.reversed_by ? (
                          <span className="small dim">reversed</span>
                        ) : (
                          <div className="row" style={{ gap: '0.25rem' }}>
                            <Button size="sm" variant="ghost" onClick={() => edit(e)}>Edit</Button>
                            {!e.reversal_of && (
                              <Button size="sm" variant="ghost" onClick={() => void undo(e)}>Reverse</Button>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => setKilling(e)}>Delete</Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {killing && (
        <Modal
          title={`Delete ${killing.memo || killing.source}`}
          onClose={() => setKilling(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setKilling(null)}>Keep it</Button>
              <Button variant="danger" onClick={() => void kill()}>Delete for good</Button>
            </>
          }
        >
          <Notice>
            This removes the entry and its lines. Every figure it was part of moves, on the statements, the trial
            balance and any reconciliation that had ticked it. There is no undo — what it said goes to the audit
            log and nowhere else.
            <div style={{ marginTop: '0.6rem' }}>
              Reversing instead leaves both halves standing and nets to nothing, which is the better answer for
              anything an accountant or a bank has already seen.
            </div>
          </Notice>
        </Modal>
      )}

      {writing && (
        <Modal
          title={changing ? `Change ${changing.memo || changing.source}` : 'New journal entry'}
          wide
          onClose={() => { setWriting(false); setChanging(null); }}
          footer={
            <>
              <Button variant="ghost" onClick={() => { setWriting(false); setChanging(null); }}>Cancel</Button>
              <Button variant="primary" loading={busy} disabled={!!liveProblem} onClick={() => void save()}>
                {changing ? 'Save the change' : 'Post it'}
              </Button>
            </>
          }
        >
          {problem && <Notice>{problem}</Notice>}
          <p className="small dim" style={{ marginTop: 0 }}>
            {changing
              ? 'Change what this says. The version it had before is written to the audit log first, so the old figures survive even though the entry no longer shows them.'
              : 'For anything that never passes a till: rent, a bank charge, money the owner has put in, a correction an accountant has asked for. Debits on the left, credits on the right, and the two must come to the same figure.'}
          </p>

          <div className="grid-2">
            <Field label="Date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="What this is for" hint="In a year, this sentence is the only clue.">
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            </Field>
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th><th>Note</th><th /></tr>
              </thead>
              <tbody>
                {draft.map((d, i) => (
                  <tr key={i}>
                    <td>
                      <Select value={d.account_code} onChange={(e) => setLine(i, { account_code: e.target.value })}>
                        <option value="">Choose</option>
                        {choices(accounts, d.account_code).map((a) => (
                          <option key={a.code} value={a.code}>{a.code} · {a.name}</option>
                        ))}
                      </Select>
                    </td>
                    <td>
                      <Input
                        inputMode="decimal"
                        value={d.debitText}
                        onChange={(e) => setLine(i, { debitText: e.target.value, creditText: '' })}
                      />
                    </td>
                    <td>
                      <Input
                        inputMode="decimal"
                        value={d.creditText}
                        onChange={(e) => setLine(i, { creditText: e.target.value, debitText: '' })}
                      />
                    </td>
                    <td><Input value={d.memo} onChange={(e) => setLine(i, { memo: e.target.value })} /></td>
                    <td>
                      {draft.length > 2 && (
                        <Button size="sm" variant="ghost" onClick={() => setDraft((r) => r.filter((_, x) => x !== i))}>×</Button>
                      )}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td style={{ fontWeight: 650 }}>Total</td>
                  <td className="num" style={{ fontWeight: 650 }}>{money(totalDebit)}</td>
                  <td className="num" style={{ fontWeight: 650 }}>{money(totalCredit)}</td>
                  <td colSpan={2} />
                </tr>
              </tbody>
            </table>
          </div>

          <div className="row" style={{ justifyContent: 'space-between', marginTop: '0.6rem' }}>
            <Button size="sm" onClick={() => setDraft((r) => [...r, { ...BLANK }])}>Add a line</Button>
            {/* Said as it is typed. Somebody entering a four-line correction
                wants to know it is out by two cedis while they are still
                looking at the receipt, not after pressing Post. */}
            <span className="small" style={{ color: liveProblem ? 'var(--danger)' : 'var(--ok)' }}>
              {liveProblem ?? 'Balanced, ready to post'}
            </span>
          </div>
        </Modal>
      )}
    </>
  );
}

/* ----------------------------------------------------------- fixed assets */

function Assets({
  assets, accounts, money, decimals, venueId, userId, onChanged, toast, isOwner,
}: {
  assets: FixedAsset[];
  accounts: AccountRow[];
  money: (n: number) => string;
  decimals: number;
  venueId: string;
  userId: string;
  onChanged: () => Promise<void>;
  toast: (m: string, t?: 'ok' | 'err') => void;
  isOwner: boolean;
}) {
  const [editing, setEditing] = useState<Partial<FixedAsset> | null>(null);
  const [costText, setCostText] = useState('');
  const [salvageText, setSalvageText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [month, setMonth] = useState(monthOf(new Date().toISOString()));
  const [running, setRunning] = useState(false);

  const open = (a?: FixedAsset) => {
    setProblem(null);
    setCostText(a ? toInput(a.cost, decimals) : '');
    setSalvageText(a ? toInput(a.salvage_value ?? 0, decimals) : '');
    setEditing(a ?? {
      name: '', acquired_on: today(), method: 'straight_line', life_months: 48, rate_bp: 2000,
      asset_account_code: '1500', accum_account_code: '1510', expense_account_code: '6060', active: true,
    });
  };

  const save = async () => {
    if (!editing?.name?.trim()) { setProblem('Give it a name.'); return; }
    const cost = parseMoney(costText, decimals);
    if (cost === null || cost <= 0) { setProblem('What did it cost?'); return; }
    const salvage = parseMoney(salvageText, decimals) ?? 0;
    if (salvage >= cost) { setProblem('What it will be worth at the end has to be less than what it cost.'); return; }
    if (editing.method === 'straight_line' && !(editing.life_months && editing.life_months > 0)) {
      setProblem('How many months should it be written off over?');
      return;
    }

    setBusy(true);
    try {
      const { dropped } = await saveDropping('fixed_assets', editing.$id ?? null, {
        venue_id: venueId,
        name: editing.name.trim(),
        category: editing.category ?? '',
        acquired_on: new Date(`${(editing.acquired_on ?? today()).slice(0, 10)}T12:00:00`).toISOString(),
        cost,
        salvage_value: salvage,
        method: editing.method ?? 'straight_line',
        life_months: Number(editing.life_months ?? 48),
        rate_bp: Number(editing.rate_bp ?? 2000),
        asset_account_code: editing.asset_account_code || '1500',
        accum_account_code: editing.accum_account_code || '1510',
        expense_account_code: editing.expense_account_code || '6060',
        disposed_on: editing.disposed_on ? new Date(`${editing.disposed_on.slice(0, 10)}T12:00:00`).toISOString() : undefined,
        note: editing.note ?? '',
        active: editing.active !== false,
      });
      setEditing(null);
      await onChanged();
      toast(
        dropped.length
          ? 'Saved, but the database has no place for this yet. Run "Provision Appwrite" in GitHub Actions.'
          : 'Saved',
        dropped.length ? 'err' : undefined,
      );
    } catch (e) {
      setProblem(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setRunning(true);
    try {
      const { posted, total, skipped } = await postDepreciation(venueId, month, { postedBy: userId });
      await onChanged();
      toast(
        posted === 0 && skipped.length === 0
          ? `Nothing to charge for ${month}.`
          : `${posted} charge${posted === 1 ? '' : 's'} posted, ${money(total)}`
            + (skipped.length ? `. ${skipped.length} already done and left alone.` : ''),
      );
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setRunning(false);
    }
  };

  const asAt = monthOf(new Date().toISOString());

  return (
    <>
      <Card
        title="Fixed assets"
        actions={<Button size="sm" variant="primary" onClick={() => open()}>Add an asset</Button>}
        pad
      >
        <p className="small dim" style={{ marginTop: 0 }}>
          Things the business owns and uses rather than sells: an oven, a fridge, a van, the fit-out of a room.
          They are not a cost on the day they are bought — the money left, but you still have the oven — so the
          cost is charged a month at a time over the years it is used.
        </p>

        {assets.length === 0 ? (
          <Empty title="Nothing on the register">Add the first oven and it starts being written down.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Asset</th><th>Bought</th><th className="num">Cost</th>
                  <th>How</th><th className="num">Worth now</th><th />
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => (
                  <tr key={a.$id}>
                    <td>
                      {a.name}
                      {a.disposed_on && <div className="small dim">gone {a.disposed_on.slice(0, 10)}</div>}
                      {a.category && <div className="small dim">{a.category}</div>}
                    </td>
                    <td className="dim small">{(a.acquired_on ?? '').slice(0, 10)}</td>
                    <td className="num">{money(a.cost)}</td>
                    <td className="dim small">
                      {a.method === 'reducing_balance'
                        ? `${((a.rate_bp ?? 0) / 100).toFixed(0)}% a year, reducing`
                        : `over ${a.life_months} months`}
                    </td>
                    {/* What it is carried at today: the cost less everything
                        charged against it so far. */}
                    <td className="num" style={{ fontWeight: 600 }}>{money(bookValue(a, asAt))}</td>
                    <td><Button size="sm" variant="ghost" onClick={() => open(a)}>Edit</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Charge a month's depreciation" pad>
        {/* Run rather than scheduled. This system may have four background jobs
            in total and all four are doing something that cannot wait;
            depreciation can, because nobody needs last month's charge before
            somebody looks at last month's figures. */}
        <p className="small dim" style={{ marginTop: 0 }}>
          Posts one month of wear against every asset that owes it, dated the last day of that month. Running the
          same month twice is safe: anything already charged is left alone rather than charged again.
        </p>
        <div className="row" style={{ gap: '0.6rem' }}>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ maxWidth: '12rem' }} />
          <Button variant="primary" loading={running} disabled={!isOwner} onClick={() => void run()}>
            Post depreciation
          </Button>
        </div>
        {!isOwner && <p className="small dim">Only the owner can post to the books.</p>}
      </Card>

      {editing && (
        <Modal
          title={editing.$id ? `Edit ${editing.name}` : 'Add an asset'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" loading={busy} onClick={() => void save()}>Save</Button>
            </>
          }
        >
          {problem && <Notice>{problem}</Notice>}
          <Field label="What is it"><Input value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
          <Field label="Kind" hint="Optional. Kitchen equipment, vehicles, furniture.">
            <Input value={editing.category ?? ''} onChange={(e) => setEditing({ ...editing, category: e.target.value })} />
          </Field>
          <div className="grid-2">
            <Field label="Bought on">
              <Input
                type="date"
                value={(editing.acquired_on ?? today()).slice(0, 10)}
                onChange={(e) => setEditing({ ...editing, acquired_on: e.target.value })}
              />
            </Field>
            <Field label="What it cost">
              <Input inputMode="decimal" value={costText} onChange={(e) => setCostText(e.target.value)} />
            </Field>
          </div>
          <Field label="What it will be worth at the end" hint="Usually nothing. It is never written below this.">
            <Input inputMode="decimal" value={salvageText} onChange={(e) => setSalvageText(e.target.value)} />
          </Field>

          <Field
            label="How to write it off"
            hint={editing.method === 'reducing_balance'
              ? 'A share of what is left each year: more early, less later. How tax authorities usually want it.'
              : 'The same amount every month until it is written off. What management accounts want.'}
          >
            <Select
              value={editing.method ?? 'straight_line'}
              onChange={(e) => setEditing({ ...editing, method: e.target.value as FixedAsset['method'] })}
            >
              <option value="straight_line">Evenly, over a number of months</option>
              <option value="reducing_balance">A percentage of what is left, each year</option>
            </Select>
          </Field>

          {editing.method === 'reducing_balance' ? (
            <Field label="Rate a year (%)">
              <Input
                inputMode="decimal"
                value={String((editing.rate_bp ?? 2000) / 100)}
                onChange={(e) => setEditing({ ...editing, rate_bp: Math.round(Number(e.target.value || 0) * 100) })}
              />
            </Field>
          ) : (
            <Field label="Over how many months" hint="Four years is 48.">
              <Input
                inputMode="numeric"
                value={String(editing.life_months ?? 48)}
                onChange={(e) => setEditing({ ...editing, life_months: Number(e.target.value || 0) })}
              />
            </Field>
          )}

          <Field label="Sold or scrapped on" hint="Leave blank while you still have it. Nothing is charged from that month on.">
            <Input
              type="date"
              value={(editing.disposed_on ?? '').slice(0, 10)}
              onChange={(e) => setEditing({ ...editing, disposed_on: e.target.value })}
            />
          </Field>

          <Field label="Note"><Textarea value={editing.note ?? ''} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></Field>

          {/* Only where somebody has made accounts of their own. The defaults
              are the three the system seeds, and most restaurants will never
              need to look at this. */}
          <details>
            <summary className="small dim">Which accounts this posts to</summary>
            <div className="grid-2" style={{ marginTop: '0.6rem' }}>
              {([
                ['asset_account_code', 'Held as', 'asset'],
                ['accum_account_code', 'Written down in', 'asset'],
                ['expense_account_code', 'Charged to', 'expense'],
              ] as const).map(([key, label, type]) => (
                <Field key={key} label={label}>
                  <Select
                    value={(editing[key] as string) ?? ''}
                    onChange={(e) => setEditing({ ...editing, [key]: e.target.value })}
                  >
                    {choices(accounts, editing[key] as string)
                      .filter((a) => a.type === type)
                      .map((a) => (
                        <option key={a.code} value={a.code}>{a.code} · {a.name}</option>
                      ))}
                  </Select>
                </Field>
              ))}
            </div>
          </details>
        </Modal>
      )}
    </>
  );
}

/* ------------------------------------------------------- reconciliation */

interface RecRow extends Doc {
  account_code: string;
  statement_date: string;
  closing_balance: number;
  status: 'open' | 'agreed';
  note?: string;
}

/**
 * Checking an account against what somebody else says is there.
 *
 * The books say what the business believes it holds. A bank statement, or a
 * counted cash box, says what the other side believes. The difference that
 * will not go away is not an error to write off — it is a pointer at the
 * transaction one side has and the other does not, and finding it is the whole
 * exercise.
 */
function Reconcile({
  accounts, lines, money, decimals, venueId, userId, onChanged, toast,
}: {
  accounts: AccountRow[];
  lines: (JournalLine & { date: string })[];
  money: (n: number) => string;
  decimals: number;
  venueId: string;
  userId: string;
  onChanged: () => Promise<void>;
  toast: (m: string, t?: 'ok' | 'err') => void;
}) {
  // Only accounts money actually sits in. Reconciling "Food sales" against a
  // statement is not a thing anybody does, and offering it invites the attempt.
  // Archived ones drop out: a closed bank account is not something to
  // reconcile this month against. Past reconciliations of it are untouched.
  const cashLike = openAccounts(accounts).filter((a) => a.type === 'asset' && a.code < '1200');

  const [code, setCode] = useState(cashLike[0]?.code ?? '1000');
  const [statementDate, setStatementDate] = useState(today());
  const [balanceText, setBalanceText] = useState('');
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<RecRow[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listAll<RecRow>('bank_reconciliations')
      .then((r) => setSaved(r.filter((x) => x.account_code === code).sort((a, b) => b.statement_date.localeCompare(a.statement_date))))
      .catch(() => setSaved([]));
  }, [code, busy]);

  // Everything ticked off on a previous statement is settled and out of the
  // way; leaving it on the list would mean working through a year of postings
  // to reconcile one month.
  const [done, setDone] = useState<Set<string>>(new Set());
  useEffect(() => {
    listAll<{ line_id: string; account_code: string }>('reconciled_lines')
      .then((r) => setDone(new Set(r.filter((x) => x.account_code === code).map((x) => x.line_id))))
      .catch(() => setDone(new Set()));
  }, [code, busy]);

  const rows = useMemo(
    () =>
      lines
        .filter((l) => l.account_code === code)
        .filter((l) => (l.date ?? '') <= `${statementDate}￿`)
        .filter((l) => !done.has(l.$id))
        .map((l) => ({
          line_id: l.$id,
          date: (l.date ?? '').slice(0, 10),
          memo: l.memo ?? '',
          amount: (l.debit ?? 0) - (l.credit ?? 0),
          cleared: cleared.has(l.$id),
        }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    [lines, code, statementDate, cleared, done],
  );

  // What was settled before this statement is part of the opening position,
  // so it counts towards the balance even though it is off the list.
  const broughtForward = useMemo(
    () =>
      lines
        .filter((l) => l.account_code === code && done.has(l.$id))
        .reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0),
    [lines, code, done],
  );

  /* -------------------------------------------------- the bank's own rows */

  const [bank, setBank] = useState<BankStatementLine[]>([]);
  const [importing, setImporting] = useState(false);
  const [importProblems, setImportProblems] = useState<string[]>([]);
  const [creating, setCreating] = useState<BankStatementLine | null>(null);

  const loadBank = () => loadStatementLines(code).then(setBank).catch(() => setBank([]));
  useEffect(() => { void loadBank(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [code, busy]);

  /**
   * What the bank says, paired with what the books say.
   *
   * Amounts have to agree exactly; the date may be a few days out, because a
   * payment written on Friday reaches a bank on Monday. Everything the books
   * have no bank line for stays on the list below to be ticked by hand, and
   * everything the bank has that the books do not is the point of the whole
   * exercise — a charge nobody recorded, interest, a transfer somebody made
   * from their phone.
   */
  const unpaired = bank.filter((b) => !b.matched_line_id);
  const paired = useMemo(
    () => matchStatement(
      unpaired.map((b) => ({
        id: b.$id,
        date: (b.line_date ?? '').slice(0, 10),
        description: b.description ?? '',
        amount: b.amount,
      })),
      rows.map((r) => ({ line_id: r.line_id, date: r.date, amount: r.amount })),
    ),
    [unpaired, rows],
  );

  const takeFile = async (file: File) => {
    setImporting(true);
    setImportProblems([]);
    try {
      const { lines: read, problems } = readStatement(parseCsv(await file.text()));
      setImportProblems(problems);
      if (read.length === 0) return;
      const { added, alreadyThere } = await importStatementLines(venueId, code, statementDate, read);
      await loadBank();
      toast(
        `${added} line${added === 1 ? '' : 's'} imported`
        + (alreadyThere ? `, ${alreadyThere} already there and left alone` : ''),
      );
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setImporting(false);
    }
  };

  /** Tick everything the matcher is confident about, in one go. */
  const acceptMatches = () => {
    setCleared((prev) => {
      const next = new Set(prev);
      for (const m of paired.matches) if (m.bookLineId) next.add(m.bookLineId);
      return next;
    });
    toast(`${paired.matches.filter((m) => m.bookLineId).length} matched and ticked`);
  };

  const [newAccount, setNewAccount] = useState('');
  const [newMemo, setNewMemo] = useState('');

  /** Post what a bank line turned out to be, and tie the two together. */
  const recordIt = async () => {
    if (!creating || !newAccount) return;
    setBusy(true);
    try {
      await postFromStatement(venueId, creating, {
        accountCode: newAccount,
        cashAccountCode: code,
        memo: newMemo.trim(),
        postedBy: userId,
      });
      setCreating(null);
      setNewAccount('');
      setNewMemo('');
      await loadBank();
      await onChanged();
      toast('Posted, and matched to the statement line');
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const perStatement = parseMoney(balanceText, decimals) ?? 0;
  const summary = reconcile(rows, perStatement - broughtForward);

  const agree = async () => {
    setBusy(true);
    try {
      const rec = await db.createDocument(DB_ID, 'bank_reconciliations', ID.unique(), {
        venue_id: venueId,
        account_code: code,
        statement_date: new Date(`${statementDate}T12:00:00`).toISOString(),
        closing_balance: perStatement,
        status: summary.agreed ? 'agreed' : 'open',
        reconciled_by: userId,
        reconciled_at: new Date().toISOString(),
      });
      for (const r of rows.filter((x) => x.cleared)) {
        await db.createDocument(DB_ID, 'reconciled_lines', ID.unique(), {
          venue_id: venueId,
          rec_id: rec.$id,
          line_id: r.line_id,
          account_code: code,
        }).catch(() => undefined);
      }
      setCleared(new Set());
      setBalanceText('');
      toast(summary.agreed ? 'Reconciled and agreed' : 'Saved, still out. The ticked ones are settled.');
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card title="Check an account against a statement" pad>
        <p className="small dim" style={{ marginTop: 0 }}>
          Tick every posting the bank has also seen. What is left over is money you have written down and they
          have not processed yet, which is normal. What must come to nothing is the difference.
        </p>
        <div className="grid-2">
          <Field label="Account">
            <Select value={code} onChange={(e) => { setCode(e.target.value); setCleared(new Set()); }}>
              {cashLike.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
            </Select>
          </Field>
          <Field label="Statement date">
            <Input type="date" value={statementDate} onChange={(e) => setStatementDate(e.target.value)} />
          </Field>
        </div>
        <Field label="What the statement says was there on that day">
          <Input inputMode="decimal" value={balanceText} onChange={(e) => setBalanceText(e.target.value)} />
        </Field>

        <div className="cash-split">
          <div className="cash-split-item">
            <div className="label">Settled before this</div>
            <div className="figure">{money(broughtForward)}</div>
          </div>
          <div className="cash-split-item">
            <div className="label">Ticked off now</div>
            <div className="figure">{money(summary.cleared)}</div>
          </div>
          <div className="cash-split-item">
            <div className="label">Not yet seen by the bank</div>
            <div className="figure">{money(summary.outstanding)}</div>
          </div>
          <div className="cash-split-item total">
            <div className="label">{summary.agreed ? 'Agreed' : 'Still to explain'}</div>
            <div className="figure" style={{ color: summary.agreed ? 'var(--ok)' : 'var(--danger)' }}>
              {money(summary.difference)}
            </div>
          </div>
        </div>

        {!summary.agreed && balanceText.trim() !== '' && (
          <Notice tone="warn">
            {money(Math.abs(summary.difference))} is unexplained. That is not a rounding to write off: it is a
            transaction one side has and the other does not. Look for a payment nobody recorded, or one recorded
            twice.
          </Notice>
        )}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: '0.6rem' }}>
          <Button
            variant="primary"
            loading={busy}
            disabled={rows.filter((r) => r.cleared).length === 0}
            onClick={() => void agree()}
          >
            {summary.agreed ? 'Agree and settle these' : 'Save what is ticked'}
          </Button>
        </div>
      </Card>

      {/*
        The bank's own rows.

        Kept rather than matched and discarded: the useful question afterwards
        is not "did it reconcile" but "which line did not, and what did the
        bank call it".
      */}
      <Card
        title="What the bank says"
        actions={
          <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
            {importing ? 'Reading…' : 'Upload a statement'}
            <input
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void takeFile(f); }}
            />
          </label>
        }
        pad
      >
        <p className="small dim" style={{ marginTop: 0 }}>
          A CSV from the bank. The columns are read by name, so whatever yours calls them — Date, Narration,
          Amount, or Money in and Money out — is fine as long as those names are in the first row. Uploading the
          same file twice adds nothing twice.
        </p>

        {importProblems.length > 0 && (
          <Notice>
            {importProblems.slice(0, 6).map((p) => <div key={p}>{p}</div>)}
            {importProblems.length > 6 && <div>…and {importProblems.length - 6} more.</div>}
          </Notice>
        )}

        {unpaired.length === 0 ? (
          <Empty title="Nothing from the bank yet">Upload a statement and its lines are matched against the postings.</Empty>
        ) : (
          <>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: '0.6rem' }}>
              <span className="small dim">
                {paired.matches.filter((m) => m.bookLineId).length} of {unpaired.length} matched to a posting
              </span>
              <Button
                size="sm"
                disabled={!paired.matches.some((m) => m.bookLineId)}
                onClick={acceptMatches}
              >
                Tick all the matches
              </Button>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Date</th><th>What the bank called it</th><th className="num">Amount</th><th>Matched</th><th /></tr>
                </thead>
                <tbody>
                  {paired.matches.map((m) => (
                    <tr key={m.bank.id}>
                      <td className="dim small">{m.bank.date}</td>
                      <td style={{ overflowWrap: 'anywhere' }}>{m.bank.description || '-'}</td>
                      <td className="num">{money(m.bank.amount)}</td>
                      <td className="small">
                        {m.how === 'exact' && <span style={{ color: 'var(--ok)' }}>same day</span>}
                        {/* Said as what it is, so a person can disagree with it. */}
                        {m.how === 'near' && <span style={{ color: 'var(--warn)' }}>{m.daysApart}d apart</span>}
                        {m.how === 'none' && <span className="dim">nothing in the books</span>}
                      </td>
                      <td>
                        {m.how === 'none' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              const row = bank.find((b) => b.$id === m.bank.id) ?? null;
                              setCreating(row);
                              setNewMemo(row?.description ?? '');
                            }}
                          >
                            Record it
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      {creating && (
        <Modal
          title="Record this from the statement"
          onClose={() => setCreating(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCreating(null)}>Cancel</Button>
              <Button variant="primary" loading={busy} disabled={!newAccount} onClick={() => void recordIt()}>
                Post it
              </Button>
            </>
          }
        >
          {/* The date and the amount are already known, so they are not typed:
              retyping a figure that is on the screen is where it gets typed
              wrongly. All that is missing is what it was for. */}
          <p className="small dim" style={{ marginTop: 0 }}>
            {(creating.line_date ?? '').slice(0, 10)} · <strong>{money(creating.amount)}</strong>
            {creating.description ? ` · ${creating.description}` : ''}
          </p>
          <p className="small dim">
            {creating.amount > 0
              ? 'Money into the account. Where did it come from?'
              : 'Money out of the account. What was it for?'}
          </p>
          <Field label="What this was">
            <Select value={newAccount} onChange={(e) => setNewAccount(e.target.value)}>
              <option value="">Choose an account</option>
              {choices(accounts, newAccount)
                .filter((a) => a.code !== code)
                .map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
            </Select>
          </Field>
          <Field label="Note" hint="What it says on the statement, unless you can do better.">
            <Input value={newMemo} onChange={(e) => setNewMemo(e.target.value)} />
          </Field>
        </Modal>
      )}

      <Card title="Postings on this account" pad>
        {rows.length === 0 ? (
          <Empty title="Nothing left to check">Everything up to that date has been settled already.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th /><th>Date</th><th>What</th><th className="num">In</th><th className="num">Out</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.line_id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={r.cleared}
                        onChange={(e) => setCleared((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(r.line_id); else next.delete(r.line_id);
                          return next;
                        })}
                      />
                    </td>
                    <td className="dim small">{r.date}</td>
                    <td>{r.memo || '-'}</td>
                    <td className="num">{r.amount > 0 ? money(r.amount) : '-'}</td>
                    <td className="num">{r.amount < 0 ? money(-r.amount) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {saved.length > 0 && (
        <Card title="Already reconciled" pad>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>To</th><th className="num">Statement said</th><th>Result</th></tr></thead>
              <tbody>
                {saved.map((r) => (
                  <tr key={r.$id}>
                    <td className="dim small">{r.statement_date.slice(0, 10)}</td>
                    <td className="num">{money(r.closing_balance)}</td>
                    <td>{r.status === 'agreed' ? 'Agreed' : 'Left out'}</td>
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

/* --------------------------------------------------------- closing a period */

/**
 * Drawing a line under a month, and being able to see where it has been.
 *
 * Once a period has been reported on — to an owner, an accountant, a tax
 * authority — anything posted into it afterwards changes a figure somebody has
 * already read and acted upon. Locking is what makes the difference between
 * accounts that can be relied on and accounts that were true on the day they
 * were printed.
 */
function Locks({
  venueId, userId, onChanged, toast,
}: {
  venueId: string;
  userId: string;
  onChanged: () => Promise<void>;
  toast: (m: string, t?: 'ok' | 'err') => void;
}) {
  const [locks, setLocks] = useState<PeriodLock[]>([]);
  const [through, setThrough] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => loadLocks(venueId).then(setLocks).catch(() => setLocks([]));
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [venueId]);

  const current = locks[0]?.locked_through?.slice(0, 10) ?? '';
  // Moving the line backwards is reopening, and is worth saying so before it
  // is done rather than afterwards.
  const reopening = !!current && !!through && through < current;

  const apply = async () => {
    if (!through) return;
    setBusy(true);
    try {
      await lockPeriod(venueId, through, { lockedBy: userId, note: note.trim() });
      setNote('');
      await load();
      await onChanged();
      toast(reopening ? `Reopened back to ${through}. It is on the record.` : `Books closed up to ${through}`);
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card title="Close the books to a date" pad>
        <p className="small dim" style={{ marginTop: 0 }}>
          Nothing can be posted, edited or reversed on or before the date the books are closed to — not by hand,
          not by a shift closing, not by depreciation. It applies to everybody including you.
        </p>

        {current ? (
          <Notice tone="ok">Closed up to <strong>{current}</strong>. Everything after that is open.</Notice>
        ) : (
          <Notice tone="warn">
            Nothing is closed. Any date can still be posted to, including months that have already been reported on.
          </Notice>
        )}

        <div className="grid-2">
          <Field label="Close up to and including" hint="The last day of the month you have finished with.">
            <Input type="date" value={through} onChange={(e) => setThrough(e.target.value)} />
          </Field>
          <Field label="Why" hint="Optional for closing. Worth saying when reopening.">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>

        {reopening && (
          <Notice>
            That is earlier than {current}, so it reopens {current} back to {through}. Anything posted into those
            days afterwards will change figures that have already been reported. This is recorded, with your name
            against it.
          </Notice>
        )}

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant={reopening ? 'danger' : 'primary'} loading={busy} disabled={!through} onClick={() => void apply()}>
            {reopening ? 'Reopen the books' : 'Close the books'}
          </Button>
        </div>
      </Card>

      <Card title="Every time this line has moved" pad>
        {/* Kept rather than overwritten. Somebody reopening January to change
            one figure is exactly the event worth being able to see afterwards,
            and a single field would simply forget it happened. */}
        {locks.length === 0 ? (
          <Empty title="Never closed">The books have been open since the beginning.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>When</th><th>Closed up to</th><th>Why</th></tr></thead>
              <tbody>
                {locks.map((l, i) => {
                  const prev = locks[i + 1]?.locked_through?.slice(0, 10);
                  const back = prev && l.locked_through.slice(0, 10) < prev;
                  return (
                    <tr key={l.$id}>
                      <td className="dim small">{(l.locked_at ?? '').slice(0, 10)}</td>
                      <td>
                        {l.locked_through.slice(0, 10)}
                        {back && <div className="small" style={{ color: 'var(--danger)' }}>reopened from {prev}</div>}
                      </td>
                      <td className="dim small">{l.note || '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

/* ------------------------------------------------ what a figure is made of */

/**
 * The postings behind one line on a statement.
 *
 * Opened by pressing the figure, because that is the moment somebody wants it:
 * "Supplies four thousand one hundred and eighty" is a question, and sending
 * them off to the journal to filter it themselves is how a set of accounts
 * becomes something people nod at rather than read.
 *
 * The running total is the point of the list. Reading down it, the figure at
 * the bottom is the figure that was pressed — which is the proof that this
 * really is what makes it up, rather than a list of things that look related.
 */
function AccountDetail({
  line, since, until, lines, entries, money, settings, onClose,
}: {
  line: { code: string; name: string; type: string; amount: number };
  /** Set for a profit and loss line, absent for a balance sheet one. */
  since?: string;
  until: string;
  lines: (JournalLine & { date: string })[];
  entries: JournalEntry[];
  money: (n: number) => string;
  settings: Settings | null;
  onClose: () => void;
}) {
  const entryOf = new Map(entries.map((e) => [e.$id, e]));
  // The same direction the statement shows it in. An expense of 4,180 reads as
  // 4,180 here too, not as a column of debits somebody has to interpret.
  const debitNormal = line.type === 'asset' || line.type === 'expense';

  const rows = useMemo(() => {
    const mine = lines
      .filter((l) => l.account_code === line.code)
      .filter((l) => (since ? (l.date ?? '') >= since : true))
      .filter((l) => (l.date ?? '') <= `${until}￿`)
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

    let running = 0;
    return mine.map((l) => {
      const amount = debitNormal ? (l.debit ?? 0) - (l.credit ?? 0) : (l.credit ?? 0) - (l.debit ?? 0);
      running += amount;
      return { line: l, entry: entryOf.get(l.entry_id), amount, running };
    });
  }, [lines, line.code, since, until, debitNormal]);

  return (
    <Modal title={`${line.name} · ${money(line.amount)}`} wide onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <p className="small dim" style={{ marginTop: 0 }}>
        {since
          ? `Everything posted to ${line.code} between ${since} and ${until}.`
          : `Everything posted to ${line.code} up to ${until}, from the beginning.`}
      </p>

      {rows.length === 0 ? (
        <Empty title="Nothing posted here">This account has no postings in that window.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Date</th><th>What for</th><th>Source</th>
                <th className="num">Amount</th><th className="num">Running</th><th>Receipt</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ line: l, entry, amount, running }) => (
                <tr key={l.$id}>
                  <td className="dim small">{(l.date ?? '').slice(0, 10)}</td>
                  <td>
                    {entry?.memo || l.memo || '-'}
                    {l.memo && entry?.memo && l.memo !== entry.memo && (
                      <div className="small dim">{l.memo}</div>
                    )}
                  </td>
                  <td className="dim small">{(entry?.source ?? '').replace('_', ' ')}</td>
                  <td className="num">{money(amount)}</td>
                  {/* Reading down, the last figure here is the one that was
                      pressed. That is the proof this is what makes it up. */}
                  <td className="num dim">{money(running)}</td>
                  <td>
                    {entry?.receipt_file_id && (
                      <a
                        href={downloadUrl(entry.receipt_file_id, 'receipt', settings)}
                        target="_blank"
                        rel="noreferrer"
                        className="small"
                      >
                        View
                      </a>
                    )}
                  </td>
                </tr>
              ))}
              <tr>
                <td colSpan={3} style={{ fontWeight: 650 }}>Total</td>
                <td className="num" style={{ fontWeight: 650 }}>{money(line.amount)}</td>
                <td colSpan={2} />
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
