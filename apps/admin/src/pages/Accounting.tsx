import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Textarea, useToast } from '@snpos/ui';
import { listAll, humanError, saveDropping } from '../lib';
import {
  formatMoney, parseMoney, toInput, Query,
  ledgerLines, loadAccounts, postManualEntry, reverseEntry, loadFixedAssets, postDepreciation,
  profitAndLoss, balanceSheet, totalsByAccount, naturalBalance, entryProblem, within,
  bookValue, monthOf,
} from '@snpos/core';
import type {
  AccountRow, JournalEntry, JournalLine, FixedAsset, LineRow, Doc,
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
type Tab = 'statements' | 'journal' | 'trial' | 'assets' | 'chart';

/** A month back from today, as YYYY-MM-DD, for the default window. */
const monthStart = (d = new Date()) => `${d.toISOString().slice(0, 7)}-01`;
const today = () => new Date().toISOString().slice(0, 10);

interface DraftLine { account_code: string; debitText: string; creditText: string; memo: string }

const BLANK: DraftLine = { account_code: '', debitText: '', creditText: '', memo: '' };

export function AccountingPage() {
  const { settings, user, profile } = useSession();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('statements');
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
          ['chart', 'Chart of accounts'],
        ] as [Tab, string][]).map(([key, label]) => (
          <Button key={key} size="sm" variant={tab === key ? 'primary' : 'default'} onClick={() => setTab(key)}>
            {label}
          </Button>
        ))}
      </div>

      {tab !== 'chart' && tab !== 'assets' && (
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

      {tab === 'statements' && (
        <Statements pl={pl} bs={bs} money={money} from={from} to={to} />
      )}

      {tab === 'trial' && (
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

      {tab === 'journal' && (
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
          onChanged={load}
          toast={toast}
        />
      )}

      {tab === 'assets' && (
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

      {tab === 'chart' && <AccountsManager />}
    </>
  );
}

/* ------------------------------------------------------------- statements */

function Statements({
  pl, bs, money, from, to,
}: {
  pl: ReturnType<typeof profitAndLoss>;
  bs: ReturnType<typeof balanceSheet>;
  money: (n: number) => string;
  from: string;
  to: string;
}) {
  return (
    <>
      <Card title={`Profit and loss · ${from} to ${to}`} pad>
        {pl.revenue.length === 0 && pl.expenses.length === 0 ? (
          <Empty title="Nothing in this period">Close a shift, or widen the dates.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <tbody>
                <tr><td colSpan={2} style={{ fontWeight: 650 }}>Income</td></tr>
                {pl.revenue.map((l) => (
                  <tr key={l.code}><td>{l.name}</td><td className="num">{money(l.amount)}</td></tr>
                ))}
                <tr><td style={{ fontWeight: 600 }}>Total income</td><td className="num" style={{ fontWeight: 600 }}>{money(pl.totalRevenue)}</td></tr>

                <tr><td colSpan={2} style={{ fontWeight: 650, paddingTop: '1rem' }}>Costs</td></tr>
                {pl.expenses.map((l) => (
                  <tr key={l.code}><td>{l.name}</td><td className="num">{money(l.amount)}</td></tr>
                ))}
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
          Profit is not cash. Money can be owed to you and still be earned, and spent without being a cost yet.
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
              {bs.assets.map((l) => (
                <tr key={l.code}><td>{l.name}</td><td className="num">{money(l.amount)}</td></tr>
              ))}
              <tr><td style={{ fontWeight: 600 }}>Total</td><td className="num" style={{ fontWeight: 600 }}>{money(bs.totalAssets)}</td></tr>

              <tr><td colSpan={2} style={{ fontWeight: 650, paddingTop: '1rem' }}>What it owes</td></tr>
              {bs.liabilities.map((l) => (
                <tr key={l.code}><td>{l.name}</td><td className="num">{money(l.amount)}</td></tr>
              ))}
              <tr><td style={{ fontWeight: 600 }}>Total</td><td className="num" style={{ fontWeight: 600 }}>{money(bs.totalLiabilities)}</td></tr>

              <tr><td colSpan={2} style={{ fontWeight: 650, paddingTop: '1rem' }}>The owner&apos;s share</td></tr>
              {bs.equity.map((l) => (
                <tr key={l.code}><td>{l.name}</td><td className="num">{money(l.amount)}</td></tr>
              ))}
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
  entries, lines, accounts, from, to, money, decimals, venueId, userId, onChanged, toast,
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
  onChanged: () => Promise<void>;
  toast: (m: string, t?: 'ok' | 'err') => void;
}) {
  const [writing, setWriting] = useState(false);
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

  const save = async () => {
    const trouble = entryProblem(asLines());
    if (trouble) { setProblem(trouble); return; }
    if (!memo.trim()) { setProblem('Say what this entry is for. In a year it is the only clue.'); return; }
    setBusy(true);
    setProblem(null);
    try {
      await postManualEntry(
        venueId,
        { date: new Date(`${date}T12:00:00`), memo: memo.trim(), postedBy: userId },
        asLines().map((l, i) => ({ ...l, memo: draft[i].memo })),
      );
      setWriting(false);
      setDraft([{ ...BLANK }, { ...BLANK }]);
      setMemo('');
      await onChanged();
      toast('Entry posted');
    } catch (e) {
      setProblem(humanError(e));
    } finally {
      setBusy(false);
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
        actions={<Button size="sm" variant="primary" onClick={() => setWriting(true)}>New entry</Button>}
        pad
      >
        <p className="small dim" style={{ marginTop: 0 }}>
          Every posting, whether the system wrote it or somebody did. Nothing here can be edited: a wrong entry
          is corrected by posting its opposite, so the record of what was thought at the time survives.
        </p>
        {shown.length === 0 ? (
          <Empty title="Nothing in this period">Close a shift, or widen the dates.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Date</th><th>What for</th><th>Source</th><th className="num">Amount</th><th /></tr>
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
                        {e.reversed_by ? (
                          <span className="small dim">reversed</span>
                        ) : e.reversal_of ? (
                          <span className="small dim">a reversal</span>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => void undo(e)}>Reverse</Button>
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

      {writing && (
        <Modal
          title="New journal entry"
          wide
          onClose={() => setWriting(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setWriting(false)}>Cancel</Button>
              <Button variant="primary" loading={busy} disabled={!!liveProblem} onClick={() => void save()}>
                Post it
              </Button>
            </>
          }
        >
          {problem && <Notice>{problem}</Notice>}
          <p className="small dim" style={{ marginTop: 0 }}>
            For anything that never passes a till: rent, a bank charge, money the owner has put in, a correction
            an accountant has asked for. Debits on the left, credits on the right, and the two must come to the
            same figure.
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
                        {accounts.map((a) => (
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
                    {accounts.filter((a) => a.type === type).map((a) => (
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
