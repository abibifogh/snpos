import { useEffect, useState } from 'react';
import { Button, Card, Empty, Notice, Select, Spinner, Badge, useToast, ViewTabs, ExpenseModal } from '@snpos/ui';
import { db, DB_ID, listAll, humanError } from '../lib';
import {
  formatMoney, downloadUrl, deleteFile, Query,
  isPostableExpenseAccount, expenseMethodsFor, expenseSides,
  defaultExpenseSide, MODULE_LABELS, modulesOf, spendWords, dateWords } from '@snpos/core';
import type {
  Module, Doc, ExpenseCategoryDoc, ImprestFloatDoc, Settings, ShiftExpense,
} from '@snpos/core';
import { KeyedListManager, useKeyedList, nameForKey } from '../components/KeyedList';
import { AccountsManager } from '../components/AccountsManager';
import { ExpenseAnalysisTab } from '../components/ExpenseAnalysis';
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


export function ExpensesPage() {
  const { settings, user, profile } = useSession();
  const toast = useToast();
  const [tab, setTab] = useState<'expenses' | 'analysis' | 'categories' | 'accounts'>('expenses');
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
  };
  useEffect(() => { load().catch((err) => setError(humanError(err))); }, []);


  const open = (row?: Expense) => {
    setError(null);
    setEditing(row ?? 'new');
  };

  const remove = async (row: Expense) => {
    if (!confirm(`Delete this ${settings ? formatMoney(row.amount, settings) : ''} expense? Stock already added from it stays where it is, remove that separately if it was wrong.`)) return;
    try {
      if (row.receipt_file_id) await deleteFile(row.receipt_file_id, 'receipt', settings).catch(() => undefined);
      const items = await listAll<ExpenseItem>('expense_items', [Query.equal('expense_id', row.$id)]).catch(() => []);
      await Promise.all(items.map((i) => db.deleteDocument(DB_ID, 'expense_items', i.$id).catch(() => undefined)));
      await db.deleteDocument(DB_ID, 'shift_expenses', row.$id);
      await load();
      toast('Deleted');
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  const methodName = (id: string) => methods.find((m) => m.$id === id)?.name ?? '-';

  return (
    <>
      <div className="spread">
        <h1>Expenses</h1>
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
              Record expense
            </Button>
          </div>
        )}
      </div>

      <ViewTabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'expenses', label: 'Expenses' },
          { value: 'analysis', label: 'Analysis' },
          { value: 'categories', label: 'Categories' },
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
          <p className="dim small" style={{ marginTop: 0 }}>
            Money paid out, supplies, transport, repairs. Attach the receipt as a photo or PDF; receipts are visible
            to managers and admins only, never to customers or other staff.
          </p>

          {error && !editing && <Notice>{error}</Notice>}

          <Card pad={false}>
            {!rows ? (
              <div className="card-pad"><Spinner /></div>
            ) : rows.length === 0 ? (
              <Empty title="No expenses recorded">Record what you spend and it lands in the accounts and the shift close.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Category</th>
                      <th>Paid to</th>
                      <th>Method</th>
                      <th className="num">Amount</th>
                      <th>Receipt</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.filter((r) => onSide(r, narrowSide(side, profile, settings))).map((r) => (
                      <tr key={r.$id}>
                        <td className="dim small">{dateWords(r.$createdAt)}</td>
                        <td>{nameForKey(categories, r.category_key || r.category)}</td>
                        <td className="dim">
                          {r.payee || '-'}
                          {r.paid_to_kind === 'open_market' && <div className="small dim">Open market</div>}
                          {r.paid_to_kind === 'staff' && <div className="small dim">Staff</div>}
                        </td>
                        {/* Which drawer, and whose money. "Cash" alone does not
                            say whether a shift is short by this or a tin is. */}
                        <td className="dim small">
                          {methodName(r.paid_from_method_id)}
                          {/* Where the money came from, in the words every
                              screen shares. A box is named when one paid. */}
                          <div className="small dim">
                            {r.imprest_float_id
                              ? (boxes.find((b) => b.$id === r.imprest_float_id)?.name ?? 'Petty cash')
                              : spendWords(r, [], methods.find((m) => m.$id === r.paid_from_method_id)?.kind).source}
                          </div>
                        </td>
                        <td className="num">{settings ? formatMoney(r.amount, settings) : r.amount}</td>
                        <td>
                          {r.receipt_file_id ? (
                            <a href={downloadUrl(r.receipt_file_id, 'receipt', settings)} target="_blank" rel="noreferrer">
                              View
                            </a>
                          ) : (
                            <Badge tone="warn">None</Badge>
                          )}
                        </td>
                        <td className="num">
                          <Button size="sm" variant="ghost" onClick={() => void open(r)}>Edit</Button>
                          <Button size="sm" variant="ghost" onClick={() => remove(r)}>Delete</Button>
                        </td>
                      </tr>
                    ))}
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
    </>
  );
}
