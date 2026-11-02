import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Card, Empty, Notice, Select, Spinner, Badge, useToast, ViewTabs, ExpenseModal, Segmented, InfoTip } from '@snpos/ui';
import { db, DB_ID, listAll, humanError } from '../lib';
import {
  formatMoney, downloadUrl, deleteFile, Query,
  isPostableExpenseAccount, expenseMethodsFor, expenseSides,
  defaultExpenseSide, MODULE_LABELS, modulesOf, spendWords, dateWords, logSpendChange, spendSnapshot,
  moneyOutRows, inPeriod, outFilter, outFilters, outTotal, OUT_STATE_WORDS, OUT_FROM_WORDS } from '@snpos/core';
import type {
  Module, Doc, ExpenseCategoryDoc, ImprestFloatDoc, Settings, ShiftExpense,
  OutFilter, OutPeriod, OutPayout, OutRow,
} from '@snpos/core';
import { KeyedListManager, useKeyedList, nameForKey } from '../components/KeyedList';
import { AccountsManager } from '../components/AccountsManager';
import { ExpenseAnalysisTab } from '../components/ExpenseAnalysis';
import { SpendDetailsModal } from '../components/SpendDetails';
import { useSession } from '../session';
import { SideFilter, onSide, narrowSide, type Side } from '../components/SideFilter';

interface Expense extends Doc {
  venue_id: string;
  shift_id?: string;
  category: string;
  category_key?: string;
  payee?: string;
  paid_to_kind?: 'supplier' | 'staff' | 'open_market' | 'other';
  module?: Module;
  supplier_id?: string;
  paid_to_staff_id?: string;
  amount: number;
  paid_from_method_id: string;
  /** Whether the drawer is short by this. See fromTakings in core. */
  from_takings?: boolean;
  /** Which petty cash box paid for it, when a box did. */
  imprest_float_id?: string;
  kind?: string;
  source?: string;
  note?: string;
  receipt_file_id?: string;
  created_by: string;
  approval_status: string;
  pay_later?: boolean;
  paid_at?: string;
}

interface ExpenseItem extends Doc {
  expense_id: string;
  ingredient_id: string;
  name_snapshot: string;
  qty: number;
  unit_cost: number;
  line_total: number;
  stocked: boolean;
}

interface PaymentMethod extends Doc {
  name: string;
  kind: string;
  enabled: boolean;
  venue_id: string;
  /** Money only ever goes out this way — an account, not a drawer. */
  payouts_only?: boolean;
}
interface VenueRow extends Doc { name: string }
interface AccountRow extends Doc { code: string; name: string; type: string; active?: boolean }


/**
 * Money out: every payment that left, in one list.
 *
 * Spends from the drawers, from petty cash boxes and from the bank, stock
 * received and not yet paid for, and maker payouts. Each was its own list on
 * its own page. See money-out.ts. The address is still /expenses.
 */
export function ExpensesPage() {
  const { settings, user, profile } = useSession();
  const isAdmin = profile?.role === 'admin';
  /** The spend whose full details are open. See SpendDetailsModal. */
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const toast = useToast();
  // The tab is in the address, so a link or a bookmark opens the same one.
  type OutTab = 'expenses' | 'analysis' | 'categories' | 'accounts';
  const [params, setParams] = useSearchParams();
  const askedTab = params.get('tab');
  const tab: OutTab = askedTab === 'analysis' || askedTab === 'categories' || askedTab === 'accounts' ? askedTab : 'expenses';
  const setTab = (t: OutTab) => setParams({ tab: t }, { replace: true });
  const [rows, setRows] = useState<Expense[] | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [side, setSide] = useState<Side>('all');
  const mods = modulesOf(settings);
  /**
   * The sides an expense may be filed under: every trade the business runs.
   *
   * From one list rather than written out at the dropdown, which is how the
   * bar came to be missing from it entirely.
   */
  const sides = expenseSides(mods, ['kitchen', 'craft', 'bar'] as Module[]);
  const [venues, setVenues] = useState<VenueRow[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const { rows: categories, reload: reloadCategories } = useKeyedList('expense_categories');

  /** The row being corrected, 'new' for a fresh spend, or nothing. The form itself is the till's. */
  const [editing, setEditing] = useState<Expense | 'new' | null>(null);
  /** Which side a new spend is for, when the list is not already narrowed to one. */
  const [recordSide, setRecordSide] = useState<Module | ''>('');
  /**
   * The petty cash boxes, and what is in each.
   *
   * "Petty cash" on this form used to be a label and nothing more: it kept the
   * spend off the shift's drawer, correctly, and then stopped. No box was
   * named, so no box was ever lighter for it — the tin's own record and the
   * money actually in it drifted apart by every expense recorded here, and the
   * reconciliation that exists to catch a shortage was quietly counting those
   * as shortages too.
   */
  const [boxes, setBoxes] = useState<ImprestFloatDoc[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Maker payouts, and the makers' names, for the shop's side of money out. */
  const [payouts, setPayouts] = useState<OutPayout[]>([]);
  const [makers, setMakers] = useState<Record<string, string>>({});
  const [period, setPeriod] = useState<OutPeriod>('month');
  const [filter, setFilter] = useState<OutFilter>('all');

  const load = async () => {
    const [e, m, v, a, tins] = await Promise.all([
      listAll<Expense>('shift_expenses'),
      listAll<PaymentMethod>('payment_methods'),
      listAll<VenueRow>('venues'),
      listAll<AccountRow>('accounts'),
      // Named in the list beside each spend a box paid for.
      listAll<ImprestFloatDoc>('imprest_floats').catch(() => [] as ImprestFloatDoc[]),
    ]);
    setRows(e.sort((a2, b) => b.$createdAt.localeCompare(a2.$createdAt)));
    // Every method, because this is the office: a bank transfer is a real
    // way to pay a supplier. The form applies the same rule. See expenseMethodsFor.
    setMethods(expenseMethodsFor(m.filter((x) => x.enabled), settings ?? undefined, 'office'));
    setVenues(v);
    // Expense lines only, minus the ones the system fills in by itself. See
    // isPostableExpenseAccount. Archived ones drop out too.
    setAccounts(
      a.filter((a2) => isPostableExpenseAccount(a2) && a2.active !== false)
        .sort((a2, b) => a2.code.localeCompare(b.code)),
    );
    setBoxes(tins);
    // Best effort: a business with no shop has no makers to pay.
    if (mods.craft) {
      const [paid, people] = await Promise.all([
        listAll<OutPayout>('consignor_payouts').catch(() => [] as OutPayout[]),
        listAll<{ $id: string; name: string }>('consignors').catch(() => []),
      ]);
      setPayouts(paid);
      setMakers(Object.fromEntries(people.map((c) => [c.$id, c.name])));
    }
  };
  useEffect(() => { load().catch((err) => setError(humanError(err))); }, []);


  const open = (row?: Expense) => {
    setError(null);
    setEditing(row ?? 'new');
  };

  /**
   * Delete a spend. An admin's alone, like the database says.
   *
   * The spend itself goes first. It used to be its lines and receipt first,
   * so a manager pressing Delete lost the shopping list and the photo, and
   * was then refused the spend — which stayed, with nothing left to show
   * what it was for. Its entry in the books is reversed by the server.
   */
  const remove = async (row: Expense) => {
    if (!isAdmin) return;
    if (!confirm(`Delete this ${settings ? formatMoney(row.amount, settings) : ''} expense? Stock already added from it stays where it is, remove that separately if it was wrong. Its entry in the books is reversed.`)) return;
    try {
      const items = await listAll<ExpenseItem>('expense_items', [Query.equal('expense_id', row.$id)]).catch(() => []);
      await db.deleteDocument(DB_ID, 'shift_expenses', row.$id);
      // What was deleted, in full, by whom: the only record left of it.
      void logSpendChange({
        venueId: (row as unknown as { venue_id?: string }).venue_id ?? 'main',
        expenseId: row.$id,
        shiftId: row.shift_id,
        actorId: user?.$id ?? '',
        role: profile?.role ?? '',
        action: 'spend_deleted',
        before: spendSnapshot({
          ...(row as unknown as Record<string, unknown>),
          items: items.map((i) => ({ name: i.name_snapshot, qty: i.qty, line_total: i.line_total })),
        }),
      });
      await Promise.all(items.map((i) => db.deleteDocument(DB_ID, 'expense_items', i.$id).catch(() => undefined)));
      if (row.receipt_file_id) await deleteFile(row.receipt_file_id, 'receipt', settings).catch(() => undefined);
      await load();
      toast('Deleted');
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  const methodName = (id: string) => methods.find((m) => m.$id === id)?.name ?? '-';

  const narrowed = narrowSide(side, profile, settings);
  const allRows = useMemo(() => moneyOutRows(
    (rows ?? []).filter((r) => onSide(r, narrowed)),
    narrowed === 'all' || narrowed === 'craft' ? payouts : [],
    {
      methodKind: (id) => methods.find((m) => m.$id === id)?.kind,
      makerName: (id) => makers[id],
    },
  ), [rows, payouts, methods, makers, narrowed]);
  const periodRows = inPeriod(allRows, period, new Date());
  const shown = outFilter(periodRows, filter);
  const byId = new Map((rows ?? []).map((r) => [r.$id, r]));

  return (
    <>
      <div className="spread">
        <h1>Money out</h1>
        {tab === 'expenses' && <SideFilter value={side} onChange={setSide} settings={settings} profile={profile} />}
        {tab === 'expenses' && (
          <div className="row">
            {/* Which side, when the list is not already narrowed to one. A
                spend recorded from the office belongs to a trade's books. */}
            {narrowSide(side, profile, settings) === 'all' && sides.length > 1 && (
              <Select value={recordSide} onChange={(e) => setRecordSide(e.target.value as Module)} aria-label="Which side">
                {sides.map((m) => <option key={m} value={m}>{MODULE_LABELS[m]}</option>)}
              </Select>
            )}
            <Button variant="primary" onClick={() => open()} disabled={methods.length === 0}>
              Record a spend
            </Button>
          </div>
        )}
      </div>

      <ViewTabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'expenses', label: 'Payments' },
          { value: 'analysis', label: 'Analysis' },
          { value: 'categories', label: 'Spending categories' },
          { value: 'accounts', label: 'Accounts' },
        ]}
      />

      {tab === 'analysis' ? (
        /* The list says what was spent. This says what that means — on what, by
           which trade, whether it is going up, and how much has nothing behind
           it. Its own component because it reads its own two windows and would
           otherwise double the size of this file. */
        <ExpenseAnalysisTab categories={(categories ?? []) as unknown as ExpenseCategoryDoc[]} />
      ) : tab === 'accounts' ? (
        <AccountsManager />
      ) : tab === 'categories' ? (
        <KeyedListManager
          collection="expense_categories"
          singular="category"
          sharedValue="general"
          accounts={accounts.map((a) => ({ code: a.code, name: a.name }))}
          onChanged={reloadCategories}
          hint="Your own list. Each one posts to a line of the accounts, which is what decides where the money shows up in Reports. Nothing there that fits? Add it under the Accounts tab. Rename freely; expenses already filed under a category stay with it."
        />
      ) : (
        <>
          <p className="small dim" style={{ marginTop: 0 }}>
            How this works
            <InfoTip>
              Everything that left: spends from the drawers, petty cash and the bank, stock received and not yet
              paid for, and maker payouts. Receipts are visible to managers and admins only.
            </InfoTip>
          </p>

          {error && !editing && <Notice>{error}</Notice>}

          <div className="row row-wrap" style={{ gap: '0.6rem', alignItems: 'center', marginBottom: '0.8rem' }}>
            <Segmented<OutPeriod>
              value={period}
              onChange={setPeriod}
              ariaLabel="Which period"
              options={[{ value: 'week', label: 'This week' }, { value: 'month', label: 'This month' }, { value: 'all', label: 'All' }]}
            />
            <strong>{settings ? formatMoney(outTotal(shown), settings) : outTotal(shown)}</strong>
            <span className="small dim">{shown.length} {shown.length === 1 ? 'payment' : 'payments'}</span>
          </div>
          <div className="row row-wrap" style={{ gap: '0.4rem', marginBottom: '0.8rem' }}>
            {outFilters(periodRows).map((f) => (
              <Button key={f.value} size="sm" variant={filter === f.value ? 'primary' : 'ghost'} onClick={() => setFilter(f.value)}>
                {f.label} {f.count > 0 && <span className="dim">· {f.count}</span>}
              </Button>
            ))}
          </div>

          <Card pad={false}>
            {!rows ? (
              <div className="card-pad"><Spinner /></div>
            ) : shown.length === 0 ? (
              <Empty title={allRows.length === 0 ? 'Nothing paid out yet' : 'Nothing here for this period'}>
                {allRows.length === 0
                  ? 'Record what you spend and it lands in the accounts and the shift close.'
                  : 'Choose a longer period, or All, to see older payments.'}
              </Empty>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>What</th>
                      <th>Paid to</th>
                      <th>From</th>
                      <th className="num">Amount</th>
                      <th>State</th>
                      <th>Receipt</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((o: OutRow) => {
                      const r = o.kind === 'spend' ? byId.get(o.id) : undefined;
                      const state = OUT_STATE_WORDS[o.state];
                      return (
                        <tr key={`${o.kind}-${o.id}`} className={o.state === 'refused' || o.state === 'reversed' ? 'dim' : undefined}>
                          <td className="dim small">{dateWords(o.at)}</td>
                          <td>{r ? nameForKey(categories, r.category_key || r.category) : 'Maker payout'}</td>
                          <td className="dim">
                            {o.to || '-'}
                            {r?.paid_to_kind === 'open_market' && <div className="small dim">Open market</div>}
                            {r?.paid_to_kind === 'staff' && <div className="small dim">Staff</div>}
                          </td>
                          {/* Which drawer, box or account, in the words every screen shares. */}
                          <td className="dim small">
                            {r ? (
                              <>
                                {o.from === 'box'
                                  ? (boxes.find((b) => b.$id === r.imprest_float_id)?.name ?? 'Petty cash')
                                  : o.from === 'owed' ? 'Owed to the supplier' : methodName(r.paid_from_method_id)}
                                <div className="small dim">
                                  {o.from === 'box' ? OUT_FROM_WORDS.box : spendWords(r, [], methods.find((m) => m.$id === r.paid_from_method_id)?.kind).source}
                                </div>
                              </>
                            ) : OUT_FROM_WORDS.maker}
                          </td>
                          <td className="num">{settings ? formatMoney(o.amount, settings) : o.amount}</td>
                          <td><Badge tone={state.tone}>{state.label}</Badge></td>
                          <td>
                            {!r ? null : r.receipt_file_id ? (
                              <a href={downloadUrl(r.receipt_file_id, 'receipt', settings)} target="_blank" rel="noreferrer">
                                View
                              </a>
                            ) : (
                              <Badge tone="warn">None</Badge>
                            )}
                          </td>
                          <td className="num">
                            {r ? (
                              <>
                                <Button size="sm" variant="ghost" onClick={() => setDetailsFor(r.$id)}>Details</Button>
                                <Button size="sm" variant="ghost" onClick={() => void open(r)}>Edit</Button>
                                {/* Deleting a spend is an admin's alone. */}
                                {isAdmin && <Button size="sm" variant="ghost" onClick={() => remove(r)}>Delete</Button>}
                              </>
                            ) : (
                              <Link className="small" to="/consignors?tab=payouts">Payouts</Link>
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
        </>
      )}

      {/*
        THE TILL'S FORM, not a second one.

        This page carried its own copy of the spend form, written beside the
        till's and drifting from it: no "looks dear" warning, a different
        default for whose money it was, corrections that reached the books
        from one desk and not the other. What the office needs that the till
        does not — paying by transfer, a spend outside any shift — is decided
        by the desk, inside the one form.
      */}
      {editing && (
        <ExpenseModal
          desk="office"
          module={editing === 'new'
            ? (recordSide || defaultExpenseSide(narrowSide(side, profile, settings), sides)) as Module
            : (editing.module ?? 'kitchen')}
          venueId={editing === 'new' ? (venues[0]?.$id ?? 'main') : editing.venue_id}
          shiftId={editing === 'new' ? '' : editing.shift_id ?? ''}
          settings={settings as Settings}
          userId={user?.$id ?? ''}
          expense={editing === 'new' ? null : (editing as unknown as ShiftExpense)}
          onClose={() => setEditing(null)}
          onDone={(m) => {
            setEditing(null);
            toast(m);
            void load();
          }}
        />
      )}
      {detailsFor && (
        <SpendDetailsModal expenseId={detailsFor} settings={settings} onClose={() => setDetailsFor(null)} />
      )}
    </>
  );
}
