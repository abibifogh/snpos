import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Notice, Select } from '@snpos/ui';
import {
  taxReturn, TAX_ACCOUNTS, postTaxRemitted, yearEndLines, yearStart, openingLines, isClosingEntry,
  closeYear, postOpeningBalances, loadRecurring, saveRecurring, setRecurringActive, deleteRecurring,
  ACCOUNTS, parseMoney, toInput, writeXlsx, XLSX_TYPE, downloadFile, buildReportHtml, openPrintable, humanError,
  entryProblem, openAccounts,
} from '@snpos/core';
import type { AccountRow, JournalEntry, Settings, PostedLine, RecurringEntry } from '@snpos/core';
import type { Lines } from './BookReports';
import { closingEntries } from './BookReports';

type Toast = (m: string, t?: 'ok' | 'err') => void;
const today = () => new Date().toISOString().slice(0, 10);

/* ---------------------------------------------------------------- tax return */

/**
 * A return for the period, from the levy accounts: sales before tax, and for
 * each levy what was collected, what was paid and what is still owed. The
 * figures to copy onto the revenue authority's form. Paying one is recorded
 * here, from the bank.
 */
export function TaxReturnReport({ accounts, lines, entries, from, to, money, settings, venueId, userId, onChanged, toast }: {
  accounts: AccountRow[]; lines: Lines; entries: JournalEntry[]; from: string; to: string;
  money: (n: number) => string; settings: Settings | null; venueId: string; userId: string;
  onChanged: () => Promise<void>; toast: Toast;
}) {
  const decimals = settings?.currency_decimals ?? 2;
  const exclude = useMemo(() => closingEntries(entries), [entries]);
  const r = useMemo(() => taxReturn(accounts, lines as PostedLine[], {
    from, to, taxCodes: TAX_ACCOUNTS.map((t) => t.account_code), exclude,
  }), [accounts, lines, from, to, exclude]);
  const nameOf = (code: string) => TAX_ACCOUNTS.find((t) => t.account_code === code)?.name ?? code;
  const [paying, setPaying] = useState<string | null>(null);
  const [form, setForm] = useState({ amount: '', date: today(), ref: '' });
  const [busy, setBusy] = useState(false);
  const period = `${from} to ${to}`;

  const pay = async (code: string) => {
    const amount = parseMoney(form.amount, decimals) ?? 0;
    if (!(amount > 0)) { toast('Enter the amount paid.', 'err'); return; }
    setBusy(true);
    try {
      await postTaxRemitted(venueId, { amount, account: code, date: new Date(`${form.date}T12:00:00`), reference: form.ref, postedBy: userId });
      setPaying(null);
      await onChanged();
      toast(`${nameOf(code)} payment of ${money(amount)} recorded.`);
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const m = (n: number) => Math.round(n) / 10 ** decimals;
  const sheet = [
    ['Line', 'Collected', 'Paid', 'Still owed'],
    ['Sales before tax', m(r.sales), null, null],
    ...r.rows.map((x) => [nameOf(x.code), m(x.collected), m(x.paid), m(x.owed)]),
    ['Total', m(r.collected), m(r.paid), m(r.owed)],
  ];

  return (
    <Card title={`Tax return · ${period}`} pad
      help={
        <>
          Collected is what the closes credited to each levy over these dates; paid is what was recorded as paid to the
          revenue authority; still owed counts everything up to the last day. Set the dates to the month being filed.
        </>
      }
    >
      <div className="row row-wrap" style={{ gap: '0.5rem', marginBottom: '0.8rem' }}>
        <Button size="sm" onClick={() => downloadFile(`Tax return ${period}.xlsx`, writeXlsx([{ name: 'Tax return', rows: sheet }]).buffer as ArrayBuffer, XLSX_TYPE)}>Excel</Button>
        <Button size="sm" onClick={() => openPrintable(buildReportHtml({
          title: 'Tax return', restaurantName: settings?.restaurant_name ?? '', period,
          stats: [{ label: 'Sales before tax', value: money(r.sales) }, { label: 'Still owed', value: money(r.owed) }],
          tables: [{ title: 'Levies', headers: ['Line', 'Collected', 'Paid', 'Still owed'], rows: r.rows.map((x) => [nameOf(x.code), money(x.collected), money(x.paid), money(x.owed)]), numeric: [1, 2, 3] }],
          brandColor: settings?.primary_color ?? undefined,
        }), `Tax return ${period}`)}>PDF</Button>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Line</th><th className="num">Collected</th><th className="num">Paid</th><th className="num">Still owed</th><th /></tr></thead>
          <tbody>
            <tr><td style={{ fontWeight: 600 }}>Sales before tax</td><td className="num" style={{ fontWeight: 600 }}>{money(r.sales)}</td><td /><td /><td /></tr>
            {r.rows.length === 0 && <tr><td colSpan={5} className="dim">No tax collected or paid in this period.</td></tr>}
            {r.rows.map((x) => [
              <tr key={x.code}>
                <td>{nameOf(x.code)}</td>
                <td className="num">{money(x.collected)}</td>
                <td className="num">{money(x.paid)}</td>
                <td className="num" style={{ fontWeight: 600 }}>{money(x.owed)}</td>
                <td className="num">
                  {x.owed > 0 && (paying === x.code
                    ? <Button size="sm" variant="ghost" onClick={() => setPaying(null)}>Cancel</Button>
                    : <Button size="sm" onClick={() => { setPaying(x.code); setForm({ amount: toInput(x.owed, decimals), date: today(), ref: '' }); }}>Record as paid</Button>)}
                </td>
              </tr>,
              paying === x.code && (
                <tr key={`${x.code}-pay`}>
                  <td colSpan={5}>
                    <div className="row row-wrap" style={{ gap: '0.5rem', alignItems: 'flex-end' }}>
                      <Field label="Amount"><Input value={form.amount} inputMode="decimal" onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
                      <Field label="Paid on"><Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
                      <Field label="Receipt or reference"><Input value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} /></Field>
                      <Button variant="primary" loading={busy} disabled={busy} onClick={() => void pay(x.code)}>Record, from the bank</Button>
                    </div>
                  </td>
                </tr>
              ),
            ])}
            <tr>
              <td style={{ fontWeight: 650 }}>Total</td>
              <td className="num" style={{ fontWeight: 650 }}>{money(r.collected)}</td>
              <td className="num" style={{ fontWeight: 650 }}>{money(r.paid)}</td>
              <td className="num" style={{ fontWeight: 650 }}>{money(r.owed)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------- recurring entries */

interface DraftLine { code: string; debit: string; credit: string }
const blank = (): DraftLine => ({ code: '', debit: '', credit: '' });

/**
 * Entries that post themselves every month: rent, a salary, a loan
 * repayment. The server posts each on its day and catches up any it missed.
 */
export function RecurringEntries({ accounts, money, settings, venueId, userId, toast }: {
  accounts: AccountRow[]; money: (n: number) => string; settings: Settings | null;
  venueId: string; userId: string; toast: Toast;
}) {
  const decimals = settings?.currency_decimals ?? 2;
  const [rows, setRows] = useState<RecurringEntry[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [day, setDay] = useState('1');
  const [start, setStart] = useState(today());
  const [draft, setDraft] = useState<DraftLine[]>([blank(), blank()]);
  const [busy, setBusy] = useState(false);
  const open = openAccounts(accounts);
  const nameOf = (code: string) => accounts.find((a) => a.code === code)?.name ?? code;

  const load = () => loadRecurring(venueId || 'main').then((r) => setRows(r.sort((a, b) => a.next_on.localeCompare(b.next_on)))).catch(() => setRows([]));
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [venueId]);

  const asLines = () => draft.filter((l) => l.code).map((l) => ({
    account_code: l.code, debit: parseMoney(l.debit, decimals) ?? 0, credit: parseMoney(l.credit, decimals) ?? 0,
  }));

  const add = async () => {
    const lines = asLines();
    const why = !name.trim() ? 'Give it a name, like "Rent".' : entryProblem(lines);
    if (why) { toast(why, 'err'); return; }
    setBusy(true);
    try {
      await saveRecurring({ venueId: venueId || 'main', name, lines, dayOfMonth: Number(day) || 1, startOn: start, userId });
      setAdding(false);
      setName('');
      setDraft([blank(), blank()]);
      await load();
      toast(`${name.trim()} will post every month, from ${start}.`);
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const total = (r: RecurringEntry) => {
    try { return (JSON.parse(r.lines) as { debit: number }[]).reduce((n, l) => n + (l.debit || 0), 0); } catch { return 0; }
  };

  return (
    <Card title="Recurring entries" pad
      help={
        <>
          Posted by themselves on their day each month, and caught up if one is missed. A month already closed is skipped.
        </>
      }
    >
      {!adding && <Button variant="primary" onClick={() => setAdding(true)}>Add a recurring entry</Button>}
      {adding && (
        <div style={{ display: 'grid', gap: '0.6rem', margin: '0.6rem 0 1rem' }}>
          <div className="row row-wrap" style={{ gap: '0.5rem', alignItems: 'flex-end' }}>
            <Field label="What it is"><Input value={name} placeholder="Rent" onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Day of the month"><Input value={day} inputMode="numeric" onChange={(e) => setDay(e.target.value)} /></Field>
            <Field label="First one on"><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th><th /></tr></thead>
              <tbody>
                {draft.map((l, i) => (
                  <tr key={i}>
                    <td>
                      <Select value={l.code} onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, code: e.target.value } : d)))}>
                        <option value="">Choose…</option>
                        {open.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                      </Select>
                    </td>
                    <td className="num"><Input value={l.debit} inputMode="decimal" onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, debit: e.target.value } : d)))} /></td>
                    <td className="num"><Input value={l.credit} inputMode="decimal" onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, credit: e.target.value } : d)))} /></td>
                    <td>{draft.length > 2 && <Button size="sm" variant="ghost" onClick={() => setDraft(draft.filter((_, j) => j !== i))}>×</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ gap: '0.5rem' }}>
            <Button size="sm" onClick={() => setDraft([...draft, blank()])}>Add a line</Button>
            <Button variant="primary" loading={busy} disabled={busy} onClick={() => void add()}>Save</Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      )}
      {rows === null ? null : rows.length === 0 ? (
        <Empty title="No recurring entries">Rent and salaries are the usual ones.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>What</th><th>Lines</th><th className="num">Each month</th><th>Next</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => {
                let ls: { account_code: string; debit: number; credit: number }[] = [];
                try { ls = JSON.parse(r.lines); } catch { /* shown as nothing */ }
                return (
                  <tr key={r.$id} className={r.active === false ? 'dim' : undefined}>
                    <td><strong>{r.name}</strong><div className="small dim">on day {r.day_of_month}{r.last_posted_on ? ` · last posted ${r.last_posted_on}` : ''}</div></td>
                    <td className="small">{ls.map((l) => `${l.debit ? 'Dr' : 'Cr'} ${nameOf(l.account_code)}`).join(' · ')}</td>
                    <td className="num">{money(total(r))}</td>
                    <td>{r.active === false ? <Badge>Paused</Badge> : r.next_on}</td>
                    <td className="num">
                      <Button size="sm" variant="ghost" onClick={() => void setRecurringActive(r.$id, r.active === false).then(load)}>{r.active === false ? 'Resume' : 'Pause'}</Button>
                      <Button size="sm" variant="ghost" onClick={() => void deleteRecurring(r.$id).then(load).catch((e) => toast(humanError(e), 'err'))}>Delete</Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------- opening balances */

/**
 * What each account held on the day these books start. One entry, any
 * difference into owner equity. For a business that kept books somewhere
 * else before, from its last balance sheet.
 */
export function OpeningBalances({ accounts, entries, money, settings, venueId, userId, onChanged, toast }: {
  accounts: AccountRow[]; entries: JournalEntry[]; money: (n: number) => string; settings: Settings | null;
  venueId: string; userId: string; onChanged: () => Promise<void>; toast: Toast;
}) {
  const decimals = settings?.currency_decimals ?? 2;
  const done = entries.filter((e) => String(e.source_id ?? '').startsWith('opening:'));
  const [date, setDate] = useState(today());
  const [text, setText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const bsAccounts = openAccounts(accounts).filter((a) => a.type === 'asset' || a.type === 'liability' || a.type === 'equity');
  const amounts = Object.fromEntries(Object.entries(text).map(([k, v]) => [k, parseMoney(v, decimals) ?? 0]));
  // Owner equity, from the seeded chart. Not a system account, so it is named here.
  const plan = openingLines(bsAccounts, amounts, '3000');

  const post = async () => {
    if (plan.lines.length === 0) { toast('Enter at least one balance.', 'err'); return; }
    setBusy(true);
    try {
      await postOpeningBalances(venueId || 'main', { date, userId }, plan.lines);
      setText({});
      await onChanged();
      toast(`Opening balances posted on ${date}.`);
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Opening balances" pad
      help={
        <>
          What each account held on the day these books start, from the last balance sheet kept anywhere else. Enter
          each as it is normally held: what is owned or what is owed, as a plain figure. Anything left over goes to owner
          equity, which keeps the entry balanced.
        </>
      }
    >
      {done.length > 0 && (
        <Notice tone="info">
          Opening balances already posted on {done.map((e) => e.date.slice(0, 10)).join(', ')}. To change them, reverse
          that entry under Journal and post again.
        </Notice>
      )}
      <Field label="Balances as at"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Account</th><th>Type</th><th className="num">Balance</th></tr></thead>
          <tbody>
            {bsAccounts.map((a) => (
              <tr key={a.code}>
                <td>{a.code} {a.name}</td>
                <td className="small dim">{a.type === 'asset' ? 'Owned' : a.type === 'liability' ? 'Owed' : "Owner's"}</td>
                <td className="num"><Input value={text[a.code] ?? ''} inputMode="decimal" onChange={(e) => setText({ ...text, [a.code]: e.target.value })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row row-wrap" style={{ gap: '0.6rem', alignItems: 'center', marginTop: '0.6rem' }}>
        {plan.balancing !== 0 && <span className="small">Owner equity takes {money(Math.abs(plan.balancing))} to balance.</span>}
        <Button variant="primary" loading={busy} disabled={busy || plan.lines.length === 0} onClick={() => void post()}>Post opening balances</Button>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------- year end */

/**
 * Closing a year: income and costs brought to nought, the year's profit into
 * retained earnings, and the books closed through the last day. The profit
 * and loss leaves the closing entry out, so the closed year still reads.
 */
export function YearEnd({ accounts, lines, entries, money, venueId, userId, onChanged, toast }: {
  accounts: AccountRow[]; lines: Lines; entries: JournalEntry[]; money: (n: number) => string;
  venueId: string; userId: string; onChanged: () => Promise<void>; toast: Toast;
}) {
  const from = yearStart(entries, lines as PostedLine[]);
  const lastYear = `${new Date().getFullYear() - 1}-12-31`;
  const [to, setTo] = useState(lastYear);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const exclude = useMemo(() => closingEntries(entries), [entries]);
  const plan = useMemo(() => yearEndLines(accounts, lines as PostedLine[], { from, to, retained: ACCOUNTS.retainedEarnings, exclude }), [accounts, lines, from, to, exclude]);
  const closed = entries.filter(isClosingEntry).map((e) => e.date.slice(0, 10)).sort();

  const run = async () => {
    setBusy(true);
    try {
      await closeYear(venueId || 'main', { date: to, userId }, plan.lines);
      setSure(false);
      await onChanged();
      toast(`The year to ${to} is closed: ${money(Math.abs(plan.profit))} ${plan.profit >= 0 ? 'profit' : 'loss'} moved into retained earnings.`);
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Year end" pad
      help={
        <>
          Moves the year&rsquo;s profit out of the income and cost accounts into retained earnings, and closes the books
          through the last day so nothing more lands in that year. Statements still show the year as it was.
        </>
      }
    >
      {closed.length > 0 && <p className="small">Years already closed: {closed.join(', ')}.</p>}
      {!from ? (
        <Empty title="Nothing to close">Nothing has been posted yet.</Empty>
      ) : (
        <>
          <div className="row row-wrap" style={{ gap: '0.5rem', alignItems: 'flex-end' }}>
            <Field label="From"><Input value={from} disabled /></Field>
            <Field label="Year ends on"><Input type="date" value={to} min={from} onChange={(e) => { setTo(e.target.value); setSure(false); }} /></Field>
          </div>
          <p style={{ margin: '0.6rem 0' }}>
            {plan.lines.length === 0
              ? 'Nothing earned or spent in that year to close.'
              : <>The year made a {plan.profit >= 0 ? 'profit' : 'loss'} of <strong>{money(Math.abs(plan.profit))}</strong>, from {plan.lines.length - 1} income and cost accounts.</>}
          </p>
          {plan.lines.length > 0 && (
            sure ? (
              <div className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                <span className="small">This closes the books through {to}. Reopening takes an owner.</span>
                <Button variant="primary" loading={busy} disabled={busy} onClick={() => void run()}>Close the year</Button>
                <Button variant="ghost" onClick={() => setSure(false)}>Not yet</Button>
              </div>
            ) : <Button variant="primary" onClick={() => setSure(true)}>Close the year to {to}</Button>
          )}
        </>
      )}
    </Card>
  );
}
